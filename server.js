// server.js (complete - Bitget + CoinGecko + enhanced PnL / indicators info)
import express from "express";
import axios from "axios";
import cors from "cors";
import fs from "fs-extra";
import { EMA, RSI, MACD, ATR } from "technicalindicators";
import { getSpotBalancesSimple, placeSpotOrder, fetchSymbolTicker } from "./bitget.js";

const app = express();
app.use(cors());
app.use(express.json());

// persistent data dir
await fs.ensureDir("./data");
const SCANS_FILE = "./data/scan_results.json";
const TRADES_FILE = "./data/trades.json";
const LOG_FILE = "./data/logs.txt";
const CFG_FILE = "./data/runtime_cfg.json";

async function readJsonSafe(f, d = []) { try { return await fs.readJson(f); } catch (e) { return d; } }
async function writeJsonSafe(f, v) { await fs.writeJson(f, v, { spaces: 2 }); }
async function appendLog(line) { try { await fs.appendFile(LOG_FILE, new Date().toISOString() + " " + line + "\n"); } catch (e) { } }

// env/config
const DEFAULT_PERCENT = Number(process.env.PERCENT_PER_TRADE || 2);
const TP_PERCENT = Number(process.env.TP_PERCENT || 10);
const BITGET_DEMO = (process.env.BITGET_DEMO === "1");
const FEE_PERCENT = Number(process.env.FEE_PERCENT || 0.2); // trading fee percent (default 0.2%)

// stablecoins to ignore as base (so we don't scan them)
const STABLE_BASES = ["USDT","USDC","BUSD","DAI","TUSD","USDP","USTC","FRAX","USDD","FDUSD"];

// ---------------- fetchWithRetry ----------------
async function fetchWithRetry(url, opts = {}, maxRetries = 4, baseDelay = 600) {
  let attempt = 0;
  while (true) {
    try {
      const res = await axios.get(url, { ...opts, timeout: 20000 });
      if (res.status === 429) throw { is429: true, response: res };
      return res;
    } catch (err) {
      attempt++;
      const is429 = (err.response && err.response.status === 429) || err.is429;
      const isNetwork = !err.response;
      if (attempt > maxRetries || (!is429 && !isNetwork)) throw err;
      const delay = Math.floor(baseDelay * Math.pow(2, attempt - 1) + Math.random() * baseDelay);
      console.warn(`fetchWithRetry retry ${attempt} ${url} waiting ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ---------------- CoinGecko cache ----------------
let _cg_top_cache = { ts: 0, data: null };
const CG_TOP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CG_TOP_REFRESH_INTERVAL = 4 * 60 * 1000;
const CG_FETCH_LIMIT = 50;

async function fetchTopCoinGecko(limit = CG_FETCH_LIMIT) {
  const now = Date.now();
  if (_cg_top_cache.data && (now - _cg_top_cache.ts) < CG_TOP_TTL_MS) return _cg_top_cache.data;
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${limit}&page=1&sparkline=false`;
  try {
    const res = await fetchWithRetry(url, {}, 4, 800);
    _cg_top_cache = { ts: Date.now(), data: res.data };
    return res.data;
  } catch (err) {
    console.warn("CoinGecko fetch failed:", err.response?.status || err.message || String(err));
    if (_cg_top_cache.data) {
      console.warn("Returning stale CoinGecko cache (age ms):", Date.now() - _cg_top_cache.ts);
      return _cg_top_cache.data;
    }
    return [];
  }
}
async function startCoinGeckoBackgroundRefresh() {
  try { await fetchTopCoinGecko(CG_FETCH_LIMIT).catch(() => { }); } catch (e) { }
  setInterval(async () => { try { await fetchTopCoinGecko(CG_FETCH_LIMIT); console.log("CoinGecko refreshed"); } catch (e) { console.warn("CG refresh err", e.message || e); } }, CG_TOP_REFRESH_INTERVAL);
}
startCoinGeckoBackgroundRefresh();

// ---------------- indicators & klines ----------------
function last(arr) { return arr[arr.length - 1]; }

async function fetchKlines(symbol, interval = "1h", limit = 200) {
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const r = await fetchWithRetry(url, {}, 3, 500);
  return r.data;
}

async function analyzeSymbol(symbol) {
  // symbol like BTCUSDT
  try {
    const base = symbol.replace("USDT", "");
    if (STABLE_BASES.includes(base)) return { ok: false, symbol, reason: "stablecoin base - skipped" };

    const k1h = await fetchKlines(symbol, "1h", 200);
    const k4h = await fetchKlines(symbol, "4h", 100);
    const closes1h = k1h.map(k => parseFloat(k[4]));
    const highs1h = k1h.map(k => parseFloat(k[2]));
    const lows1h = k1h.map(k => parseFloat(k[3]));
    const vols1h = k1h.map(k => parseFloat(k[5]));
    const closes4h = k4h.map(k => parseFloat(k[4]));

    if (closes1h.length < 50 || closes4h.length < 20) return { ok: false, symbol, reason: "not enough candles" };

    const ema8_1h = last(EMA.calculate({ period: 8, values: closes1h }));
    const ema21_1h = last(EMA.calculate({ period: 21, values: closes1h }));
    const rsi1h = last(RSI.calculate({ period: 14, values: closes1h }));
    const macd1h = last(MACD.calculate({ values: closes1h, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }));
    const atr1h = last(ATR.calculate({ period: 14, high: highs1h, low: lows1h, close: closes1h }));

    const ema8_4h = last(EMA.calculate({ period: 8, values: closes4h }));
    const ema21_4h = last(EMA.calculate({ period: 21, values: closes4h }));
    const macd4h = last(MACD.calculate({ values: closes4h, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }));

    // scoring & reason breakdown
    let score = 0;
    const reasons = [];

    if (ema8_4h > ema21_4h) { score += 3; reasons.push("4H EMA8>EMA21"); }
    if (macd4h && macd4h.histogram > 0) { score += 2; reasons.push("4H MACD hist > 0"); }
    if (ema8_1h > ema21_1h) { score += 2; reasons.push("1H EMA8>EMA21"); }
    if (macd1h && macd1h.histogram > 0) { score += 1; reasons.push("1H MACD hist > 0"); }
    if (rsi1h > 45 && rsi1h < 65) { score += 1; reasons.push("RSI 1H neutral (45-65)"); }

    const volAvg = vols1h.slice(-20).reduce((a, b) => a + b, 0) / 20;
    if (vols1h[vols1h.length - 1] > 1.5 * volAvg) { score += 1; reasons.push("Volume spike 1H"); }

    const entry = closes1h.at(-1);
    const tp = +(entry * (1 + TP_PERCENT / 100)).toFixed(8);
    const sl = Math.max(0.00000001, entry - (atr1h * 1.5));

    return {
      ok: true,
      symbol, score, entry, tp, sl,
      indicators: {
        ema8_1h, ema21_1h, rsi1h, macd1h: macd1h ? macd1h.histogram : null, atr1h,
        ema8_4h, ema21_4h, macd4h: macd4h ? macd4h.histogram : null
      },
      reasons
    };
  } catch (e) {
    return { ok: false, symbol, error: String(e) };
  }
}

// ---------------- API endpoints ----------------
app.get("/", (_req, res) => res.send("DexScan (Bitget) backend ✅"));

// top10 from CoinGecko cache (fast)
app.get("/api/top10", async (_req, res) => {
  try {
    const coins = await fetchTopCoinGecko(50);
    const top = (coins || []).slice(0, 10).map(c => ({
      id: c.id,
      symbol: (c.symbol || "").toUpperCase() + "USDT",
      name: c.name,
      price: c.current_price,
      change24h: c.price_change_percentage_24h
    }));
    res.json(top);
  } catch (err) {
    console.error("top10 error:", err.response?.status || err.message || String(err));
    if (err.response && err.response.status === 429) res.status(429).json({ error: "Rate limited by upstream API (429)." });
    else res.status(500).json({ error: String(err.message || err) });
  }
});

// Run heavy scan (analyze many symbols). Returns array of objects with indicators + reasons.
app.post("/api/scan/run", async (_req, res) => {
  try {
    await appendLog("Scan run started");
    const coins = await fetchTopCoinGecko(200);
    const universe = coins.map(c => (c.symbol || "").toUpperCase() + "USDT").filter(s => s);
    const results = [];
    for (const s of universe) {
      try {
        const r = await analyzeSymbol(s);
        if (r.ok && r.score >= 7) results.push(r);
      } catch (e) { }
    }
    results.sort((a, b) => b.score - a.score);
    const topN = results.slice(0, 30);
    await writeJsonSafe(SCANS_FILE, topN);
    await appendLog(`Scan finished: ${topN.length}`);
    res.json(topN);
  } catch (e) {
    await appendLog("scan error: " + (e.message || e));
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/scan/results", async (_req, res) => {
  const scans = await readJsonSafe(SCANS_FILE, []);
  res.json(scans);
});

// get balance via Bitget helper
app.get("/api/bitget/balance", async (_req, res) => {
  try {
    const bal = await getSpotBalancesSimple();
    if (!bal.ok) return res.status(500).json(bal);
    // compute USD total roughly by using USDT balance as main reference
    res.json(bal.data);
  } catch (e) { res.status(500).json({ error: e.message || String(e) }); }
});

// Place manual buy (uses PERCENT_PER_TRADE or percent param). Deducts fees and logs trade.
app.post("/api/bitget/order", async (req, res) => {
  try {
    const { symbol, side, percent } = req.body;
    if (!symbol || !side) return res.status(400).json({ error: "symbol and side required" });

    const balResp = await getSpotBalancesSimple();
    if (!balResp.ok) return res.status(500).json(balResp);
    const balances = balResp.data || {};
    const usdtBal = Number(balances["USDT"] || balances["usdt"] || 0);
    if (!usdtBal || usdtBal <= 0) return res.status(400).json({ error: "Insufficient USDT balance" });

    const pct = Number(percent || DEFAULT_PERCENT);
    const sizeUsd = +(usdtBal * (pct / 100));
    // get price from Bitget ticker then fallback to CoinGecko cache
    let price = null;
    try {
      const t = await fetchSymbolTicker(symbol);
      if (t.ok && t.data) price = Number(t.data?.data?.last || t.data?.last || t.data?.price || 0);
    } catch (e) { }
    if (!price) {
      const cg = await fetchTopCoinGecko(200);
      const id = (cg.find(c => ((c.symbol || "").toUpperCase() + "USDT") === symbol) || {}).id;
      price = id ? Number((cg.find(x => x.id === id) || {}).current_price || 0) : 0;
    }
    if (!price || price <= 0) return res.status(500).json({ error: "price unavailable for " + symbol });

    const qty = +(sizeUsd / price).toFixed(8);

    // Place order via Bitget (will use demo if BITGET_DEMO=1)
    const orderResp = await placeSpotOrder(symbol, side.toLowerCase(), qty, "market", null);
    if (!orderResp.ok) {
      // non-fatal: still create a simulated trade entry (but mark failed)
      await appendLog("order failed - " + JSON.stringify(orderResp.error));
      return res.status(500).json({ error: orderResp.error });
    }

    // compute fees (buy fee deducted from USDT)
    const buyFee = +(sizeUsd * (FEE_PERCENT / 100));
    const invested = +(sizeUsd);
    // record trade -> we DO NOT trust Bitget order shape (varies), store our metadata
    const trades = await readJsonSafe(TRADES_FILE, []);
    const trade = {
      id: "t_" + Date.now(),
      symbol,
      side: side.toUpperCase(),
      qty,
      entry_price: price,
      invested,
      buy_fee: buyFee,
      tp_price: +(price * (1 + TP_PERCENT / 100)).toFixed(8),
      status: "OPEN",
      created_at: new Date().toISOString(),
      order_result: orderResp.data,
      demo: BITGET_DEMO,
      indicators_snapshot: null // optional: you can store analysis snapshot
    };
    trades.push(trade);
    await writeJsonSafe(TRADES_FILE, trades);

    // Note: We do not modify Bitget balance locally; we rely on real Bitget balances for truth.
    // For quick UI, compute approx remaining USDT (simulated)
    const approx_remaining = +(usdtBal - invested - buyFee).toFixed(8);

    await appendLog(`Order placed ${trade.id} ${symbol} qty:${qty} price:${price} demo:${BITGET_DEMO}`);
    res.json({ ok: true, trade, approx_remaining });
  } catch (e) {
    await appendLog("order error: " + (e.message || e));
    res.status(500).json({ error: e.message || String(e) });
  }
});

// Close (sell) a trade: places market sell, computes fees and pnl, updates trade record and returns result
app.post("/api/trade/close", async (req, res) => {
  try {
    const { trade_id, exit_price } = req.body;
    if (!trade_id) return res.status(400).json({ error: "trade_id required" });
    const trades = await readJsonSafe(TRADES_FILE, []);
    const t = trades.find(x => x.id === trade_id);
    if (!t) return res.status(404).json({ error: "trade not found" });
    if (t.status !== "OPEN") return res.status(400).json({ error: "trade not open" });

    // if exit_price not provided, fetch latest price
    let price = exit_price ? Number(exit_price) : null;
    if (!price) {
      // try fetch from bitget or coingecko
      const ticker = await fetchSymbolTicker(t.symbol);
      if (ticker.ok && ticker.data) price = Number(ticker.data?.data?.last || ticker.data?.last || ticker.data?.price || 0);
      if (!price) {
        const cg = await fetchTopCoinGecko(200);
        const id = (cg.find(c => ((c.symbol || "").toUpperCase() + "USDT") === t.symbol) || {}).id;
        price = id ? Number((cg.find(x => x.id === id) || {}).current_price || 0) : 0;
      }
    }
    if (!price || price <= 0) return res.status(500).json({ error: "price unavailable for symbol" });

    // compute proceeds and fees
    const gross_proceeds = +(t.qty * price);
    const sell_fee = +(gross_proceeds * (FEE_PERCENT / 100));
    const net_proceeds = +(gross_proceeds - sell_fee);
    const pnl = +(net_proceeds - t.invested);

    // place market sell via Bitget (if desired)
    const orderResp = await placeSpotOrder(t.symbol, "sell", t.qty, "market", null);
    // update trade record
    t.status = "CLOSED";
    t.exit_price = price;
    t.sell_fee = sell_fee;
    t.gross_proceeds = gross_proceeds;
    t.net_proceeds = net_proceeds;
    t.pnl = pnl;
    t.closed_at = new Date().toISOString();
    t.order_sell_result = orderResp.ok ? orderResp.data : { error: orderResp.error };

    await writeJsonSafe(TRADES_FILE, trades);
    await appendLog(`Trade closed ${trade_id} pnl:${pnl}`);
    res.json({ ok: true, trade: t, orderResp });
  } catch (e) {
    await appendLog("close error: " + (e.message || e));
    res.status(500).json({ error: e.message || String(e) });
  }
});

// list trades with on-the-fly unrealized pnl using latest prices
app.get("/api/trades", async (_req, res) => {
  const trades = await readJsonSafe(TRADES_FILE, []);
  // augment with latest market price and unrealized pnl
  const cg = await fetchTopCoinGecko(200);
  const mapPrices = {};
  (cg || []).forEach(c => mapPrices[(c.symbol || "").toUpperCase() + "USDT"] = c.current_price);
  const out = trades.map(t => {
    if (t.status === "OPEN") {
      const latest = mapPrices[t.symbol] || null;
      const grossVal = latest ? +(t.qty * latest) : null;
      const estSellFee = grossVal ? +(grossVal * (FEE_PERCENT / 100)) : null;
      const estNet = (grossVal && estSellFee !== null) ? +(grossVal - estSellFee) : null;
      const unrealPnl = (estNet !== null) ? +(estNet - t.invested) : null;
      return { ...t, latest_price: latest, est_net: estNet, unreal_pnl: unrealPnl };
    } else return t;
  });
  res.json(out);
});

// runtime auto toggle endpoints (persisted to file)
app.post("/api/auto/set", async (req, res) => {
  try {
    const { enabled } = req.body;
    const cfg = await readJsonSafe(CFG_FILE, {});
    cfg.auto = !!enabled;
    await writeJsonSafe(CFG_FILE, cfg);
    res.json({ ok: true, auto: cfg.auto });
  } catch (e) { res.status(500).json({ error: e.message || String(e) }); }
});
app.get("/api/auto/status", async (_req, res) => {
  const cfg = await readJsonSafe(CFG_FILE, { auto: false });
  res.json(cfg);
});

// worker: logs signals when auto enabled (no auto-exec unless enabled explicitly)
let workerRunning = false;
async function workerLoop() {
  try {
    if (workerRunning) return;
    workerRunning = true;
    const cfg = await readJsonSafe(CFG_FILE, { auto: false });
    if (cfg.auto) {
      const coins = await fetchTopCoinGecko(50);
      const universe = coins.map(c => ((c.symbol || "").toUpperCase() + "USDT")).slice(0, 50);
      for (const s of universe) {
        try {
          const r = await analyzeSymbol(s);
          if (r.ok && r.score >= 7) {
            await appendLog(`Auto-signal: ${s} score ${r.score}`);
            // optional: auto-execute here (disabled by default)
          }
        } catch (e) { }
      }
    }
  } catch (e) { await appendLog("worker error: " + (e.message || e)); }
  finally { workerRunning = false; }
}
setInterval(workerLoop, 60 * 1000);

// start
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`DexScan backend (Bitget) running on ${PORT}`));
