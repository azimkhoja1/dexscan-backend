// server.js — COMPLETE
// DexScan V2: Bitget live + demo backend, scanner + auto-trader
import express from "express";
import axios from "axios";
import cors from "cors";
import fs from "fs-extra";
import { EMA, RSI, MACD, ATR } from "technicalindicators";
import { getSpotBalancesSimple, placeSpotOrder, fetchSymbolTicker } from "./bitget.js";

const app = express();
app.use(cors());
app.use(express.json());

// ---------------- persistent storage ----------------
await fs.ensureDir("./data");
const TRADES_FILE = "./data/trades.json";
const CFG_FILE = "./data/config.json";
const LOG_FILE = "./data/logs.txt";
if (!(await fs.pathExists(TRADES_FILE))) await fs.writeJson(TRADES_FILE, []);
if (!(await fs.pathExists(CFG_FILE))) await fs.writeJson(CFG_FILE, { auto: false, settings: { tp: 10, sl: 100, invest: 5, count: 10, percent: 2, autosell: true } });

async function readJsonSafe(p, def = null) { try { return await fs.readJson(p); } catch (e) { return def; } }
async function writeJsonSafe(p, v) { try { await fs.writeJson(p, v, { spaces: 2 }); } catch (e) { console.error("writeJsonSafe", e.message); } }
async function appendLog(line) { try { await fs.appendFile(LOG_FILE, new Date().toISOString() + " " + line + "\n"); } catch (e) {} }

// --------------- config from env -----------------
const PORT = process.env.PORT || 10000;
const TP_PERCENT = Number(process.env.TP_PERCENT || 10);
const DEFAULT_PERCENT = Number(process.env.PERCENT_PER_TRADE || 2);
const FEE_PERCENT = Number(process.env.FEE_PERCENT || 0.2);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 10);
const BITGET_DEMO = (process.env.BITGET_DEMO === "1");

// --------------- utilities -----------------
async function fetchWithRetry(url, maxRetries = 3, delay = 700) {
  let attempt = 0;
  while (true) {
    try {
      const r = await axios.get(url, { timeout: 15000 });
      return r.data;
    } catch (e) {
      attempt++;
      if (attempt > maxRetries) throw e;
      await new Promise(r => setTimeout(r, delay * attempt));
    }
  }
}

let cgCache = { ts: 0, data: null };
const CG_TTL = 4 * 60 * 1000;
async function fetchTopCoinGecko(limit = 200) {
  const now = Date.now();
  if (cgCache.data && (now - cgCache.ts) < CG_TTL) return cgCache.data;
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${limit}&page=1&sparkline=false`;
  const data = await fetchWithRetry(url, 4, 800);
  cgCache = { ts: Date.now(), data };
  return data;
}

// Binance klines via public mirror
async function fetchKlines(symbol, interval = "1h", limit = 200) {
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const d = await fetchWithRetry(url, 3, 700);
  return d;
}
function last(arr) { return arr[arr.length - 1]; }

const STABLE_BASES = ["USDT","USDC","BUSD","DAI","TUSD","USDP","USTC","FRAX","USDD","FDUSD"];

// --------------- analyze one symbol ----------------
async function analyzeSymbol(symbol) {
  try {
    if (!symbol || !symbol.endsWith("USDT")) return { ok: false, symbol, reason: "not USDT" };
    const base = symbol.replace("USDT", "");
    if (STABLE_BASES.includes(base)) return { ok: false, symbol, reason: "stable skipped" };

    const k1 = await fetchKlines(symbol, "1h", 200);
    const k4 = await fetchKlines(symbol, "4h", 100);
    const closes1 = k1.map(x => parseFloat(x[4]));
    const highs1 = k1.map(x => parseFloat(x[2]));
    const lows1 = k1.map(x => parseFloat(x[3]));
    const vols1 = k1.map(x => parseFloat(x[5]));
    const closes4 = k4.map(x => parseFloat(x[4]));

    if (closes1.length < 50 || closes4.length < 20) return { ok: false, symbol, reason: "not enough data" };

    const ema8_1h = last(EMA.calculate({ period: 8, values: closes1 }));
    const ema21_1h = last(EMA.calculate({ period: 21, values: closes1 }));
    const rsi1h = last(RSI.calculate({ period: 14, values: closes1 }));
    const macd1h = last(MACD.calculate({ values: closes1, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }));
    const atr1h = last(ATR.calculate({ period: 14, high: highs1, low: lows1, close: closes1 }));

    const ema8_4h = last(EMA.calculate({ period: 8, values: closes4 }));
    const ema21_4h = last(EMA.calculate({ period: 21, values: closes4 }));
    const macd4h = last(MACD.calculate({ values: closes4, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }));

    let score = 0;
    const reasons = [];
    if (ema8_4h > ema21_4h) { score += 3; reasons.push("4H EMA8>21"); }
    if (macd4h && macd4h.histogram > 0) { score += 2; reasons.push("4H MACD+"); }
    if (ema8_1h > ema21_1h) { score += 2; reasons.push("1H EMA8>21"); }
    if (macd1h && macd1h.histogram > 0) { score += 1; reasons.push("1H MACD+"); }
    if (rsi1h > 45 && rsi1h < 65) { score += 1; reasons.push("RSI neutral"); }
    const volAvg = vols1.slice(-20).reduce((a,b) => a + b, 0) / 20;
    if (vols1[vols1.length-1] > 1.5 * volAvg) { score += 1; reasons.push("Vol spike"); }

    const entry = +closes1.at(-1);
    const tp = +(entry * (1 + TP_PERCENT/100)).toFixed(8);
    const sl = Math.max(0.00000001, entry - (atr1h * 1.5));

    return { ok: true, symbol, score, entry, tp, sl, indicators: { ema8_1h, ema21_1h, rsi1h, macd1h: macd1h ? macd1h.histogram : null, atr1h, ema8_4h, ema21_4h, macd4h: macd4h ? macd4h.histogram : null }, reasons };
  } catch (e) {
    return { ok: false, symbol, error: String(e) };
  }
}

// --------------- endpoints ----------------
app.get("/", (_req, res) => res.send("DexScan V2 (Bitget) ✅"));

// Get top header coins BTC/ETH/BNB
app.get("/api/header", async (_req, res) => {
  try {
    const cg = await fetchTopCoinGecko(200);
    const pick = ["bitcoin","ethereum","binancecoin"];
    const out = pick.map(id => {
      const c = (cg || []).find(x => x.id === id);
      return c ? { id, symbol: (c.symbol||"").toUpperCase()+"USDT", price: c.current_price } : { id, symbol: id.toUpperCase() };
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message || String(e) }); }
});

// Get 10 coins (scan snapshot quick)
app.get("/api/coins", async (_req, res) => {
  try {
    const cg = await fetchTopCoinGecko(100);
    // filter to USDT-able symbols (coingecko symbol -> symbolUSDT)
    const arr = cg.map(c => ({ symbol: (c.symbol||"").toUpperCase()+"USDT", price: c.current_price, change24h: c.price_change_percentage_24h }));
    res.json(arr.slice(0, 10));
  } catch (e) { res.status(500).json({ error: e.message || String(e) }); }
});

// Run a heavy scan (auto analyze top market coins)
app.post("/api/scan/run", async (_req, res) => {
  try {
    const conf = await readJsonSafe(CFG_FILE, {});
    const count = conf.settings?.count ?? 10;
    const coins = await fetchTopCoinGecko(200);
    const universe = coins.map(c => (c.symbol||"").toUpperCase()+"USDT").slice(0, 120);
    const results = [];
    for (let s of universe) {
      try {
        const r = await analyzeSymbol(s);
        if (r.ok && r.score >= 6) results.push(r);
      } catch (e) {}
      if (results.length >= count) break;
    }
    results.sort((a,b) => b.score - a.score);
    await writeJsonSafe("./data/scan_results.json", results);
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.get("/api/scan/results", async (_req, res) => {
  const s = await readJsonSafe("./data/scan_results.json", []);
  res.json(s);
});

// get balance (try bitget, fallback simulated)
app.get("/api/balance", async (_req, res) => {
  try {
    const b = await getSpotBalancesSimple();
    if (b.ok) return res.json({ ok: true, demo: BITGET_DEMO, balance: b.data });
    // fallback: simulated wallet
    const trades = await readJsonSafe(TRADES_FILE, []);
    const usdt = 10000 - (trades.filter(t => t.status === "OPEN").reduce((a,b) => a + (b.invested || 0), 0));
    return res.json({ ok: true, demo: true, balance: { USDT: usdt } });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// List trades (open + closed)
app.get("/api/trades", async (_req, res) => {
  try {
    const trades = await readJsonSafe(TRADES_FILE, []);
    // augment with latest price from coingecko
    const cg = await fetchTopCoinGecko(200);
    const prices = {};
    (cg || []).forEach(c => prices[(c.symbol||"").toUpperCase()+"USDT"] = c.current_price);
    const out = trades.map(t => {
      if (t.status === "OPEN") {
        const latest = prices[t.symbol] || null;
        const gross = latest ? +(t.qty * latest) : null;
        const est_fee = gross ? +(gross * (FEE_PERCENT/100)) : null;
        const est_net = (gross && est_fee !== null) ? +(gross - est_fee) : null;
        const unreal = est_net !== null ? +(est_net - t.invested) : null;
        return { ...t, latest_price: latest, est_net: est_net, unreal_pnl: unreal };
      } else return t;
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// Place buy (manual or used by worker). Body: { symbol, percent } percent of wallet to use
app.post("/api/trade/buy", async (req, res) => {
  try {
    const { symbol, percent } = req.body;
    if (!symbol) return res.status(400).json({ error: "symbol required" });
    const conf = await readJsonSafe(CFG_FILE, {});
    const pct = Number(percent || conf.settings?.percent || DEFAULT_PERCENT);

    // fetch balance
    let usdtBal = 0;
    const b = await getSpotBalancesSimple();
    if (b.ok) usdtBal = Number(b.data["USDT"] || b.data["usdt"] || 0);
    else usdtBal = 10000; // fallback demo wallet

    if (usdtBal <= 0) return res.status(400).json({ error: "Insufficient USDT" });

    const sizeUsd = +(usdtBal * (pct / 100));
    // price via bitget ticker or coingecko fallback
    let price = null;
    try {
      const tk = await fetchSymbolTicker(symbol);
      if (tk.ok) price = Number(tk.data?.data?.last || tk.data?.last || (tk.data && tk.data[0]?.last) || 0);
    } catch (e) { }
    if (!price) {
      const cg = await fetchTopCoinGecko(200);
      const cs = (cg || []).find(c => ((c.symbol||"").toUpperCase()+"USDT") === symbol);
      price = cs ? Number(cs.current_price || 0) : 0;
    }
    if (!price || price <= 0) return res.status(500).json({ error: "Price unavailable" });

    const qty = +(sizeUsd / price).toFixed(8);
    // Place order via bitget wrapper (if keys present) otherwise simulate
    const orderResp = await placeSpotOrder(symbol, "buy", qty, "market", null);

    const trades = await readJsonSafe(TRADES_FILE, []);
    if (!orderResp.ok || process.env.BITGET_DEMO === "1") {
      const sim = {
        id: "sim_" + Date.now(),
        symbol,
        qty,
        entry_price: price,
        invested: sizeUsd,
        buy_fee: +(sizeUsd * (FEE_PERCENT / 100)),
        tp_price: +(price * (1 + TP_PERCENT / 100)),
        status: "OPEN",
        created_at: new Date().toISOString(),
        autoSell: conf.settings?.autosell ?? true,
        demo: true
      };
      trades.push(sim);
      await writeJsonSafe(TRADES_FILE, trades);
      await appendLog("Sim buy " + sim.id + " " + symbol);
      return res.json({ ok: true, trade: sim, simulated: true });
    }

    // actual order success
    const trade = {
      id: "t_" + Date.now(),
      symbol,
      qty,
      entry_price: price,
      invested: sizeUsd,
      buy_fee: +(sizeUsd * (FEE_PERCENT / 100)),
      tp_price: +(price * (1 + TP_PERCENT / 100)),
      status: "OPEN",
      created_at: new Date().toISOString(),
      autoSell: conf.settings?.autosell ?? true,
      demo: false,
      order_result: orderResp.data
    };
    trades.push(trade);
    await writeJsonSafe(TRADES_FILE, trades);
    await appendLog("Placed buy " + trade.id + " " + symbol);
    res.json({ ok: true, trade });
  } catch (e) {
    await appendLog("trade/buy err: " + (e.message || e));
    res.status(500).json({ error: e.message || String(e) });
  }
});

// Close / sell a trade: body { trade_id, exit_price(optional) }
app.post("/api/trade/sell", async (req, res) => {
  try {
    const { trade_id, exit_price } = req.body;
    if (!trade_id) return res.status(400).json({ error: "trade_id required" });
    const trades = await readJsonSafe(TRADES_FILE, []);
    const t = trades.find(x => x.id === trade_id);
    if (!t) return res.status(404).json({ error: "trade not found" });
    if (t.status !== "OPEN") return res.status(400).json({ error: "trade not open" });

    // determine exit price
    let price = exit_price || null;
    if (!price) {
      // try bitget ticker then coinGecko
      try {
        const tk = await fetchSymbolTicker(t.symbol);
        if (tk.ok) price = Number(tk.data?.data?.last || tk.data?.last || 0);
      } catch (e) {}
      if (!price) {
        const cg = await fetchTopCoinGecko(200);
        const cs = (cg || []).find(c => ((c.symbol||"").toUpperCase()+"USDT") === t.symbol);
        price = cs ? Number(cs.current_price || 0) : 0;
      }
    }
    if (!price || price <= 0) return res.status(500).json({ error: "price unavailable" });

    const gross = +(t.qty * price);
    const sellFee = +(gross * (FEE_PERCENT / 100));
    const net = +(gross - sellFee);
    const pnl = +(net - t.invested);

    // place market sell via bitget wrapper if keys present and not in demo
    let orderResp = null;
    if (process.env.BITGET_DEMO !== "1") {
      orderResp = await placeSpotOrder(t.symbol, "sell", t.qty, "market", null);
    }

    t.status = "CLOSED";
    t.exit_price = price;
    t.sell_fee = sellFee;
    t.gross_proceeds = gross;
    t.net_proceeds = net;
    t.pnl = pnl;
    t.closed_at = new Date().toISOString();
    t.order_sell_result = orderResp ? (orderResp.ok ? orderResp.data : orderResp.error) : null;

    await writeJsonSafe(TRADES_FILE, trades);
    await appendLog("Closed trade " + t.id + " pnl:" + pnl);
    res.json({ ok: true, trade: t });
  } catch (e) {
    await appendLog("trade/sell err: " + (e.message || e));
    res.status(500).json({ error: e.message || String(e) });
  }
});

// Toggle per-trade autosell (body { trade_id, auto })
app.post("/api/trade/toggle_autosell", async (req, res) => {
  try {
    const { trade_id, auto } = req.body;
    if (!trade_id) return res.status(400).json({ error: "trade_id required" });
    const trades = await readJsonSafe(TRADES_FILE, []);
    const t = trades.find(x => x.id === trade_id);
    if (!t) return res.status(404).json({ error: "trade not found" });
    t.autoSell = !!auto;
    await writeJsonSafe(TRADES_FILE, trades);
    res.json({ ok: true, trade: t });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// Mode endpoints (toggle demo/live)
app.get("/api/mode", async (_req, res) => {
  res.json({ demo: process.env.BITGET_DEMO === "1" });
});
app.post("/api/mode", async (req, res) => {
  // This endpoint does not change environment variables — instructs the server to flip internal config file
  const { demo } = req.body;
  const cfg = await readJsonSafe(CFG_FILE, {});
  cfg.demo = !!demo;
  await writeJsonSafe(CFG_FILE, cfg);
  await appendLog("Mode set demo=" + !!demo);
  res.json({ ok: true, demo: !!demo });
});

// Get settings and update settings
app.get("/api/settings", async (_req, res) => {
  const cfg = await readJsonSafe(CFG_FILE, {});
  res.json(cfg.settings || {});
});
app.post("/api/settings", async (req, res) => {
  const body = req.body || {};
  const cfg = await readJsonSafe(CFG_FILE, {});
  cfg.settings = { ...(cfg.settings || {}), ...body };
  await writeJsonSafe(CFG_FILE, cfg);
  res.json({ ok: true, settings: cfg.settings });
});

// Auto control: enable/disable auto worker
app.post("/api/auto", async (req, res) => {
  const { enabled } = req.body;
  const cfg = await readJsonSafe(CFG_FILE, {});
  cfg.auto = !!enabled;
  await writeJsonSafe(CFG_FILE, cfg);
  res.json({ ok: true, auto: cfg.auto });
});
app.get("/api/auto", async (_req, res) => {
  const cfg = await readJsonSafe(CFG_FILE, {});
  res.json({ auto: cfg.auto });
});

// --------------- workers ----------------
// Auto worker: when enabled, scan and auto-buy top signals until concurrent limit
let autoBusy = false;
async function autoWorker() {
  try {
    if (autoBusy) return;
    autoBusy = true;
    const cfg = await readJsonSafe(CFG_FILE, {});
    if (!cfg.auto) return;
    const settings = cfg.settings || {};
    const maxConcurrent = settings.count || MAX_CONCURRENT;
    const trades = await readJsonSafe(TRADES_FILE, []);
    const openCount = (trades || []).filter(t => t.status === "OPEN").length;
    if (openCount >= maxConcurrent) return;

    // scan top 120 coins and analyze; pick high score
    const cg = await fetchTopCoinGecko(200);
    const universe = cg.map(c => (c.symbol||"").toUpperCase()+"USDT").slice(0, 120);
    const picks = [];
    for (const s of universe) {
      try {
        const r = await analyzeSymbol(s);
        if (r.ok && r.score >= 6) picks.push(r);
      } catch (e) {}
      if (picks.length >= 30) break;
    }
    picks.sort((a,b) => b.score - a.score);
    for (const p of picks) {
      const tradesNow = await readJsonSafe(TRADES_FILE, []);
      const openNow = (tradesNow || []).filter(t => t.status === "OPEN").length;
      if (openNow >= maxConcurrent) break;
      if ((tradesNow || []).some(t => t.symbol === p.symbol && t.status === "OPEN")) continue;
      // place buy via internal endpoint
      try {
        await axios.post(`http://localhost:${PORT}/api/trade/buy`, { symbol: p.symbol, percent: settings.percent || DEFAULT_PERCENT }, { timeout: 120000 });
        await appendLog("Auto buy requested " + p.symbol);
      } catch (e) {
        await appendLog("Auto buy error " + p.symbol + " " + (e.message || String(e)));
      }
    }
  } catch (e) {
    await appendLog("autoWorker err " + (e.message || String(e)));
  } finally {
    autoBusy = false;
  }
}
setInterval(autoWorker, 30 * 1000);

// Monitor open trades for TP hit
async function monitorLoop() {
  try {
    const trades = await readJsonSafe(TRADES_FILE, []);
    if (!trades || !trades.length) return;
    const cg = await fetchTopCoinGecko(200);
    const priceMap = {};
    (cg || []).forEach(c => priceMap[(c.symbol||"").toUpperCase()+"USDT"] = c.current_price);
    for (const t of trades.filter(x => x.status === "OPEN")) {
      const latest = priceMap[t.symbol] || null;
      if (!latest) continue;
      const tp = t.tp_price || t.tp || (t.entry_price * (1 + TP_PERCENT/100));
      if (latest >= tp && (t.autoSell !== false)) {
        // auto sell
        try {
          await axios.post(`http://localhost:${PORT}/api/trade/sell`, { trade_id: t.id, exit_price: latest }, { timeout: 120000 });
          await appendLog("Auto-sold " + t.id + " at " + latest);
        } catch (e) {
          await appendLog("Auto-sell failed " + t.id + " " + (e.message || String(e)));
        }
      }
    }
  } catch (e) {
    // silent
  }
}
setInterval(monitorLoop, 5000);

// start
app.listen(PORT, () => console.log(`DexScan backend running on ${PORT}`));
