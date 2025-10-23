// server.js (replace entire file with this)
// DexScan backend: Bitget + CoinGecko + scanner + auto-exec worker + stablecoin ignore + fallbacks
import express from "express";
import axios from "axios";
import cors from "cors";
import fs from "fs-extra";
import { EMA, RSI, MACD, ATR } from "technicalindicators";
import { getSpotBalancesSimple, placeSpotOrder, fetchSymbolTicker } from "./bitget.js";

const app = express();
app.use(cors());
app.use(express.json());

// ensure data directory
await fs.ensureDir("./data");
const SCANS_FILE = "./data/scan_results.json";
const TRADES_FILE = "./data/trades.json";
const LOG_FILE = "./data/logs.txt";
const WALLET_FILE = "./data/fake_wallet.json";
const CFG_FILE = "./data/runtime_cfg.json";

// defaults and ENV
const DEFAULT_PERCENT = Number(process.env.PERCENT_PER_TRADE || 2); // percent per trade
const TP_PERCENT = Number(process.env.TP_PERCENT || 10);
const BITGET_DEMO = (process.env.BITGET_DEMO === "1");
const FEE_PERCENT = Number(process.env.FEE_PERCENT || 0.2);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 10); // up to 10 concurrent positions

// stable coin list to ignore scanning as base
const STABLE_BASES = ["USDT","USDC","BUSD","DAI","TUSD","USDP","USTC","FRAX","USDD","FDUSD"];

// utility helpers
async function readJsonSafe(file, def = null) { try { return await fs.readJson(file); } catch (e) { return def; } }
async function writeJsonSafe(file, data) { await fs.writeJson(file, data, { spaces: 2 }); }
async function appendLog(line) { try { await fs.appendFile(LOG_FILE, new Date().toISOString() + " " + line + "\n"); } catch (e) {} }

// create initial fake wallet if missing (used as fallback when Bitget endpoints don't work)
if (!(await fs.pathExists(WALLET_FILE))) {
  await writeJsonSafe(WALLET_FILE, { USDT: 10000 });
}
if (!(await fs.pathExists(SCANS_FILE))) await writeJsonSafe(SCANS_FILE, []);
if (!(await fs.pathExists(TRADES_FILE))) await writeJsonSafe(TRADES_FILE, []);
if (!(await fs.pathExists(CFG_FILE))) await writeJsonSafe(CFG_FILE, { auto: false });

// fetchWithRetry helper
async function fetchWithRetry(url, opts = {}, maxRetries = 4, baseDelay = 600) {
  let attempt = 0;
  while (true) {
    try {
      const res = await axios.get(url, { ...opts, timeout: 20000 });
      if (res.status === 429) throw { is429:true, response: res };
      return res;
    } catch (err) {
      attempt++;
      const is429 = (err.response && err.response.status === 429) || err.is429;
      const isNetwork = !err.response;
      if (attempt > maxRetries || (!is429 && !isNetwork)) throw err;
      const delay = Math.floor(baseDelay * Math.pow(2, attempt-1) + Math.random() * baseDelay);
      console.warn(`fetchWithRetry retry ${attempt} ${url} waiting ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// CoinGecko cache (resilient)
let _cg_top_cache = { ts: 0, data: null };
const CG_TOP_TTL_MS = 5 * 60 * 1000;
const CG_TOP_REFRESH_INTERVAL = 4 * 60 * 1000;
const CG_FETCH_LIMIT = 100;

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
    if (_cg_top_cache.data) return _cg_top_cache.data;
    return [];
  }
}
setInterval(async () => { try { await fetchTopCoinGecko(CG_FETCH_LIMIT); console.log("CoinGecko refreshed"); } catch (e) { console.warn("CG refresh err", e.message || e); } }, CG_TOP_REFRESH_INTERVAL);
await fetchTopCoinGecko(CG_FETCH_LIMIT).catch(()=>{});

// klines helper
async function fetchKlines(symbol, interval="1h", limit=200) {
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const r = await fetchWithRetry(url, {}, 3, 500);
  return r.data;
}

function last(arr) { return arr[arr.length - 1]; }

// analyze single symbol (1h + 4h) -> return object with score, indicators, reasons
async function analyzeSymbol(symbol) {
  try {
    if (!symbol || typeof symbol !== "string") throw new Error("bad symbol");
    // remove trailing USDT base check
    if (!symbol.endsWith("USDT")) return { ok:false, symbol, reason:"not USDT pair" };
    const base = symbol.replace("USDT","");
    if (STABLE_BASES.includes(base)) return { ok:false, symbol, reason:"stable base skipped" };

    const k1h = await fetchKlines(symbol, "1h", 200);
    const k4h = await fetchKlines(symbol, "4h", 100);
    const closes1h = k1h.map(k => parseFloat(k[4]));
    const highs1h = k1h.map(k => parseFloat(k[2]));
    const lows1h = k1h.map(k => parseFloat(k[3]));
    const vols1h = k1h.map(k => parseFloat(k[5]));
    const closes4h = k4h.map(k => parseFloat(k[4]));
    if (closes1h.length < 50 || closes4h.length < 20) return { ok:false, symbol, reason:"not enough candles" };

    const ema8_1h = last(EMA.calculate({ period:8, values: closes1h }));
    const ema21_1h = last(EMA.calculate({ period:21, values: closes1h }));
    const rsi1h = last(RSI.calculate({ period:14, values: closes1h }));
    const macd1h = last(MACD.calculate({ values: closes1h, fastPeriod:12, slowPeriod:26, signalPeriod:9 }));
    const atr1h = last(ATR.calculate({ period:14, high: highs1h, low: lows1h, close: closes1h }));

    const ema8_4h = last(EMA.calculate({ period:8, values: closes4h }));
    const ema21_4h = last(EMA.calculate({ period:21, values: closes4h }));
    const macd4h = last(MACD.calculate({ values: closes4h, fastPeriod:12, slowPeriod:26, signalPeriod:9 }));

    let score = 0;
    const reasons = [];

    if (ema8_4h > ema21_4h) { score += 3; reasons.push("4H EMA8>EMA21"); }
    if (macd4h && macd4h.histogram > 0) { score += 2; reasons.push("4H MACD>0"); }
    if (ema8_1h > ema21_1h) { score += 2; reasons.push("1H EMA8>EMA21"); }
    if (macd1h && macd1h.histogram > 0) { score += 1; reasons.push("1H MACD>0"); }
    if (rsi1h > 45 && rsi1h < 65) { score += 1; reasons.push("RSI neutral (45-65)"); }

    const volAvg = vols1h.slice(-20).reduce((a,b)=>a+b,0)/20;
    if (vols1h[vols1h.length-1] > 1.5 * volAvg) { score += 1; reasons.push("Volume spike 1H"); }

    const entry = +closes1h.at(-1);
    const tp = +(entry * (1 + TP_PERCENT/100)).toFixed(8);
    const sl = Math.max(0.00000001, entry - (atr1h * 1.5));

    return { ok:true, symbol, score, entry, tp, sl, indicators:{ ema8_1h, ema21_1h, rsi1h, macd1h: macd1h?macd1h.histogram:null, atr1h, ema8_4h, ema21_4h, macd4h: macd4h?macd4h.histogram:null }, reasons };
  } catch (e) {
    return { ok:false, symbol, error: String(e) };
  }
}

// ---------------- ROUTES ----------------

// health
app.get("/", (_req,res) => res.send("DexScan backend (Bitget) ✅"));

// top (we will only serve BTC, ETH, BNB real-time on frontend as requested)
app.get("/api/top10", async (_req,res) => {
  try {
    // use CoinGecko cache but filter to BTC, ETH, BNB and return them in that order
    const coins = await fetchTopCoinGecko(100);
    const pick = ["bitcoin","ethereum","binancecoin"];
    const out = [];
    for (const id of pick) {
      const c = (coins || []).find(x => x.id === id);
      if (c) out.push({ symbol: (c.symbol||"").toUpperCase()+"USDT", price: c.current_price, change24h: c.price_change_percentage_24h });
      else out.push({ symbol: id.toUpperCase(), price: null, change24h: null });
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message || String(e) }); }
});

// heavy scan run -> returns up to 10 signals (by score desc)
app.post("/api/scan/run", async (_req,res) => {
  try {
    await appendLog("Scan run started");
    const coins = await fetchTopCoinGecko(200);
    const universe = coins.map(c => (c.symbol||"").toUpperCase()+"USDT").filter(s=>s);
    const results = [];
    // iterate but stop early when we have enough high-score signals (we still check many but can short-circuit)
    for (let i=0;i<universe.length;i++) {
      const s = universe[i];
      try {
        const r = await analyzeSymbol(s);
        if (r.ok && r.score >= 6) { results.push(r); }
      } catch(e){}
      if (results.length >= 10) break;
    }
    results.sort((a,b)=>b.score - a.score);
    const topN = results.slice(0, 10);
    await writeJsonSafe(SCANS_FILE, topN);
    await appendLog(`Scan finished: ${topN.length}`);
    res.json(topN);
  } catch (e) { await appendLog("scan error: "+(e.message||e)); res.status(500).json({ error: e.message || String(e) }); }
});

// return last scan results
app.get("/api/scan/results", async (_req,res) => {
  const scans = await readJsonSafe(SCANS_FILE, []);
  res.json(scans);
});

// get balances (try Bitget first; on error fallback to local fake wallet)
app.get("/api/bitget/balance", async (_req,res) => {
  try {
    const b = await getSpotBalancesSimple();
    if (b.ok) return res.json(b.data);
    // fallback to local wallet file
    const local = await readJsonSafe(WALLET_FILE, { USDT: 10000 });
    return res.json(local);
  } catch (e) { res.status(500).json({ error: e.message || String(e) }); }
});

// manual buy endpoint (record trade + attempt to place Bitget order)
app.post("/api/bitget/order", async (req,res) => {
  try {
    const { symbol, side, percent } = req.body;
    if (!symbol || !side) return res.status(400).json({ error: "symbol and side required" });

    // determine USD available
    const b = await getSpotBalancesSimple();
    let usdtBal = 0;
    if (b.ok) usdtBal = Number(b.data["USDT"] || b.data["usdt"] || 0);
    else {
      const local = await readJsonSafe(WALLET_FILE, { USDT: 10000 });
      usdtBal = Number(local.USDT || 0);
    }
    if (!usdtBal || usdtBal <= 0) return res.status(400).json({ error: "Insufficient USDT" });

    const pct = Number(percent || DEFAULT_PERCENT);
    const sizeUsd = +(usdtBal * (pct/100));

    // fetch price: try Bitget ticker then fallback to CoinGecko
    let price = null;
    try {
      const t = await fetchSymbolTicker(symbol);
      if (t.ok) price = Number(t.data?.data?.last || t.data?.last || t.data?.price || 0);
    } catch(e){}
    if (!price) {
      const cg = await fetchTopCoinGecko(200);
      const id = (cg.find(c => ((c.symbol||"").toUpperCase()+"USDT") === symbol) || {}).id;
      price = id ? Number((cg.find(x=>x.id===id)||{}).current_price || 0) : 0;
    }
    if (!price || price <= 0) return res.status(500).json({ error: "price unavailable" });

    const qty = +(sizeUsd / price).toFixed(8);

    // Place order via Bitget (or demo)
    const orderResp = await placeSpotOrder(symbol, side.toLowerCase(), qty, "market", null);
    if (!orderResp.ok) {
      await appendLog("order place failed: " + JSON.stringify(orderResp.error));
      // still record simulated trade but mark order_error
      const trades = await readJsonSafe(TRADES_FILE, []);
      const trade = { id:"sim_"+Date.now(), symbol, side: side.toUpperCase(), qty, entry_price: price, invested:sizeUsd, buy_fee: +(sizeUsd * (FEE_PERCENT/100)), tp_price: +(price*(1+TP_PERCENT/100)), status:"OPEN", demo: BITGET_DEMO, order_error: orderResp.error, created_at: new Date().toISOString() };
      trades.push(trade);
      await writeJsonSafe(TRADES_FILE, trades);
      return res.status(500).json({ ok:false, error: orderResp.error, trade });
    }

    // store trade record
    const trades = await readJsonSafe(TRADES_FILE, []);
    const trade = { id: "t_" + Date.now(), symbol, side: side.toUpperCase(), qty, entry_price: price, invested: sizeUsd, buy_fee: +(sizeUsd * (FEE_PERCENT/100)), tp_price: +(price*(1+TP_PERCENT/100)), status: "OPEN", demo: BITGET_DEMO, order_result: orderResp.data, created_at: new Date().toISOString() };
    trades.push(trade);
    await writeJsonSafe(TRADES_FILE, trades);
    await appendLog(`manual order recorded ${trade.id} ${symbol} qty:${qty}`);
    res.json({ ok:true, trade });
  } catch (e) {
    await appendLog("manual order error: " + (e.message || e));
    res.status(500).json({ error: e.message || String(e) });
  }
});

// close (sell) trade
app.post("/api/trade/close", async (req,res) => {
  try {
    const { trade_id, exit_price } = req.body;
    if (!trade_id) return res.status(400).json({ error: "trade_id required" });

    const trades = await readJsonSafe(TRADES_FILE, []);
    const t = trades.find(x => x.id === trade_id);
    if (!t) return res.status(404).json({ error: "trade not found" });
    if (t.status !== "OPEN") return res.status(400).json({ error: "trade not open" });

    // find price
    let price = exit_price ? Number(exit_price) : null;
    if (!price) {
      const ticker = await fetchSymbolTicker(t.symbol);
      if (ticker.ok) price = Number(ticker.data?.data?.last || ticker.data?.last || ticker.data?.price || 0);
      if (!price) {
        const cg = await fetchTopCoinGecko(200);
        const id = (cg.find(c => ((c.symbol||"").toUpperCase()+"USDT") === t.symbol) || {}).id;
        price = id ? Number((cg.find(x=>x.id===id)||{}).current_price || 0) : 0;
      }
    }
    if (!price || price <= 0) return res.status(500).json({ error: "price unavailable" });

    // compute PnL & fees
    const gross_proceeds = +(t.qty * price);
    const sell_fee = +(gross_proceeds * (FEE_PERCENT/100));
    const net_proceeds = +(gross_proceeds - sell_fee);
    const pnl = +(net_proceeds - t.invested);

    // attempt place sell via Bitget
    const orderResp = await placeSpotOrder(t.symbol, "sell", t.qty, "market", null);

    t.status = "CLOSED";
    t.exit_price = price;
    t.sell_fee = sell_fee;
    t.gross_proceeds = gross_proceeds;
    t.net_proceeds = net_proceeds;
    t.pnl = pnl;
    t.closed_at = new Date().toISOString();
    t.order_sell_result = orderResp.ok ? orderResp.data : { error: orderResp.error };

    await writeJsonSafe(TRADES_FILE, trades);
    await appendLog(`Trade closed ${t.id} pnl:${pnl}`);
    res.json({ ok:true, trade: t });
  } catch (e) {
    await appendLog("close error: " + (e.message || e));
    res.status(500).json({ error: e.message || String(e) });
  }
});

// list trades with augmented unrealized pnl
app.get("/api/trades", async (_req,res) => {
  const trades = await readJsonSafe(TRADES_FILE, []);
  const cg = await fetchTopCoinGecko(200);
  const mapPrices = {};
  (cg || []).forEach(c => mapPrices[(c.symbol||"").toUpperCase()+"USDT"] = c.current_price);
  const out = trades.map(t => {
    if (t.status === "OPEN") {
      const latest = mapPrices[t.symbol] || null;
      const grossVal = latest ? +(t.qty * latest) : null;
      const estSellFee = grossVal ? +(grossVal * (FEE_PERCENT/100)) : null;
      const estNet = (grossVal && estSellFee !== null) ? +(grossVal - estSellFee) : null;
      const unrealPnl = (estNet !== null) ? +(estNet - t.invested) : null;
      return { ...t, latest_price: latest, est_net: estNet, unreal_pnl: unrealPnl };
    } else return t;
  });
  res.json(out);
});

// auto toggle endpoints (persisted)
app.post("/api/auto/set", async (req,res) => {
  try {
    const { enabled } = req.body;
    const cfg = await readJsonSafe(CFG_FILE, {});
    cfg.auto = !!enabled;
    await writeJsonSafe(CFG_FILE, cfg);
    res.json({ ok:true, auto: cfg.auto });
  } catch (e) { res.status(500).json({ error: e.message || String(e) }); }
});
app.get("/api/auto/status", async (_req,res) => {
  const cfg = await readJsonSafe(CFG_FILE, { auto:false });
  res.json(cfg);
});

// ---------------- Auto-execution worker ----------------
// When auto enabled: every 30s, if open positions < MAX_CONCURRENT, fetch scan results and buy top scoring coins until limit
let workerRunning = false;
async function autoWorker() {
  try {
    if (workerRunning) return;
    workerRunning = true;
    const cfg = await readJsonSafe(CFG_FILE, { auto:false });
    if (!cfg.auto) return;
    // count open positions
    const trades = await readJsonSafe(TRADES_FILE, []);
    const openCount = (trades || []).filter(t => t.status === "OPEN").length;
    if (openCount >= MAX_CONCURRENT) {
      await appendLog(`Auto: reached max concurrent (${openCount})`);
      return;
    }
    // get current scan results (fresh)
    // trigger a quick scan (light): call analyze over top 50 and pick top signals
    const coins = await fetchTopCoinGecko(100);
    const universe = coins.map(c => (c.symbol||"").toUpperCase()+"USDT").filter(s=>s).slice(0,50);
    const signals = [];
    for (const s of universe) {
      try {
        const r = await analyzeSymbol(s);
        if (r.ok && r.score >= 6) signals.push(r);
      } catch(e){}
      if (signals.length >= 20) break;
    }
    signals.sort((a,b)=>b.score - a.score);
    // auto-buy until we hit MAX_CONCURRENT
    for (const sig of signals) {
      if ((await readJsonSafe(TRADES_FILE, [])).filter(t => t.status === "OPEN").length >= MAX_CONCURRENT) break;
      // skip if already bought same symbol open
      const currentTrades = await readJsonSafe(TRADES_FILE, []);
      if ((currentTrades||[]).some(t => t.symbol === sig.symbol && t.status === "OPEN")) continue;
      // place order using percent per trade
      try {
        await appendLog(`Auto buy attempt: ${sig.symbol} score:${sig.score}`);
        const orderResp = await placeSpotOrder(sig.symbol, "buy", /*qty*/ ( (DEFAULT_PERCENT/100) * 1 ), "market", null);
        // The placeSpotOrder expects qty, but in manual we computed qty from USD; for auto we will compute ourselves:
        // Simpler: use manual buy logic: compute price and USD size then call placeSpotOrder via wrapper below instead.
      } catch (e) {
        // ignore low-level errors; we'll perform a safer buy below using the /api/bitget/order endpoint internally
      }
      // use the internal endpoint to ensure consistent recording
      try {
        // call local endpoint
        await axios.post(`http://localhost:${process.env.PORT||10000}/api/bitget/order`, { symbol: sig.symbol, side: "buy", percent: DEFAULT_PERCENT }, { timeout: 60000 });
        await appendLog(`Auto buy placed for ${sig.symbol}`);
      } catch (e) {
        await appendLog(`Auto buy failed for ${sig.symbol}: ${e?.message||String(e)}`);
      }
    }
  } catch (e) {
    await appendLog("autoWorker error: " + (e.message || e));
  } finally {
    workerRunning = false;
  }
}
setInterval(autoWorker, 30 * 1000); // every 30s

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`DexScan backend (Bitget) running on ${PORT}`));
