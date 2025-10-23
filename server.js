// server.js — COMPLETE file (replace your existing server.js with this)
// DexScan backend: Bitget integration, scanner (CoinGecko + Binance klines), auto-trader (demo & live), settings persistence

import express from "express";
import axios from "axios";
import cors from "cors";
import fs from "fs-extra";
import { EMA, RSI, MACD, ATR } from "technicalindicators";
import { getSpotBalancesSimple, placeSpotOrder, fetchSymbolTicker } from "./bitget.js";

const app = express();
app.use(cors());
app.use(express.json());

// ----------------- persistent files & helpers -----------------
await fs.ensureDir("./data");
const SCANS_FILE = "./data/scan_results.json";
const TRADES_FILE = "./data/trades.json";
const WALLET_FILE = "./data/fake_wallet.json"; // fallback
const CFG_FILE = "./data/runtime_cfg.json";
const LOG_FILE = "./data/logs.txt";

async function readJsonSafe(path, def = null) {
  try { return await fs.readJson(path); } catch (e) { return def; }
}
async function writeJsonSafe(path, val) {
  try { await fs.writeJson(path, val, { spaces: 2 }); } catch (e) { console.error("writeJsonSafe error", e.message); }
}
async function appendLog(line) {
  try { await fs.appendFile(LOG_FILE, new Date().toISOString() + " " + line + "\n"); } catch (e) { console.warn("log append failed", e.message); }
}

// initialize files if missing
if (!(await fs.pathExists(WALLET_FILE))) await writeJsonSafe(WALLET_FILE, { USDT: 10000 });
if (!(await fs.pathExists(SCANS_FILE))) await writeJsonSafe(SCANS_FILE, []);
if (!(await fs.pathExists(TRADES_FILE))) await writeJsonSafe(TRADES_FILE, []);
if (!(await fs.pathExists(CFG_FILE))) await writeJsonSafe(CFG_FILE, { auto:false, settings: { tp:10, sl:100, invest:5, count:10, autosell:true } });

// ----------------- config from ENV -----------------
const DEFAULT_PERCENT = Number(process.env.PERCENT_PER_TRADE || 2); // percent of wallet per trade
const TP_PERCENT = Number(process.env.TP_PERCENT || 10);
const BITGET_DEMO = (process.env.BITGET_DEMO === "1");
const FEE_PERCENT = Number(process.env.FEE_PERCENT || 0.2);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 10);
const PORT = process.env.PORT || 10000;

// stable coins to ignore as base tokens
const STABLE_BASES = ["USDT","USDC","BUSD","DAI","TUSD","USDP","USTC","FRAX","USDD","FDUSD"];

// ----------------- fetchWithRetry -----------------
async function fetchWithRetry(url, opts = {}, maxRetries = 4, baseDelay = 600) {
  let attempt = 0;
  while (true) {
    try {
      const r = await axios.get(url, { ...opts, timeout: 20000 });
      if (r.status === 429) throw { is429:true, response: r };
      return r;
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

// ----------------- CoinGecko caching -----------------
let _cg_cache = { ts: 0, data: null };
const CG_TTL = 5 * 60 * 1000;
async function fetchTopCoinGecko(limit = 200) {
  const now = Date.now();
  if (_cg_cache.data && (now - _cg_cache.ts) < CG_TTL) return _cg_cache.data;
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${limit}&page=1&sparkline=false`;
  try {
    const res = await fetchWithRetry(url, {}, 4, 800);
    _cg_cache = { ts: Date.now(), data: res.data };
    return res.data;
  } catch (err) {
    console.warn("CoinGecko fetch failed:", err.response?.status || err.message || String(err));
    if (_cg_cache.data) return _cg_cache.data;
    return [];
  }
}
setInterval(() => fetchTopCoinGecko(200).catch(()=>{}), 4 * 60 * 1000);
await fetchTopCoinGecko(200).catch(()=>{});

// ----------------- Binance klines helper -----------------
async function fetchKlines(symbol, interval="1h", limit=200) {
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const r = await fetchWithRetry(url, {}, 3, 500);
  return r.data;
}
function last(arr){ return arr[arr.length - 1]; }

// ----------------- analysis engine -----------------
async function analyzeSymbol(symbol) {
  try {
    if (!symbol || !symbol.endsWith("USDT")) return { ok:false, symbol, reason:"not USDT pair" };
    const base = symbol.replace("USDT","");
    if (STABLE_BASES.includes(base)) return { ok:false, symbol, reason:"stable base skipped" };

    const k1 = await fetchKlines(symbol,"1h",200);
    const k4 = await fetchKlines(symbol,"4h",100);
    const closes1 = k1.map(k => parseFloat(k[4]));
    const highs1 = k1.map(k => parseFloat(k[2]));
    const lows1 = k1.map(k => parseFloat(k[3]));
    const vols1 = k1.map(k => parseFloat(k[5]));
    const closes4 = k4.map(k => parseFloat(k[4]));

    if (closes1.length < 50 || closes4.length < 20) return { ok:false, symbol, reason:"not enough candles" };

    const ema8_1h = last(EMA.calculate({ period:8, values: closes1 }));
    const ema21_1h = last(EMA.calculate({ period:21, values: closes1 }));
    const rsi1h = last(RSI.calculate({ period:14, values: closes1 }));
    const macd1h = last(MACD.calculate({ values: closes1, fastPeriod:12, slowPeriod:26, signalPeriod:9 }));
    const atr1h = last(ATR.calculate({ period:14, high: highs1, low: lows1, close: closes1 }));

    const ema8_4h = last(EMA.calculate({ period:8, values: closes4 }));
    const ema21_4h = last(EMA.calculate({ period:21, values: closes4 }));
    const macd4h = last(MACD.calculate({ values: closes4, fastPeriod:12, slowPeriod:26, signalPeriod:9 }));

    let score = 0;
    const reasons = [];

    if (ema8_4h > ema21_4h) { score += 3; reasons.push("4H EMA8>21"); }
    if (macd4h && macd4h.histogram > 0) { score += 2; reasons.push("4H MACD>0"); }
    if (ema8_1h > ema21_1h) { score += 2; reasons.push("1H EMA8>21"); }
    if (macd1h && macd1h.histogram > 0) { score += 1; reasons.push("1H MACD>0"); }
    if (rsi1h > 45 && rsi1h < 65) { score += 1; reasons.push("RSI neutral"); }

    const volAvg = vols1.slice(-20).reduce((a,b)=>a+b,0)/20;
    if (vols1[vols1.length-1] > 1.5 * volAvg) { score += 1; reasons.push("Volume spike"); }

    const entry = +closes1.at(-1);
    const tp = +(entry * (1 + TP_PERCENT/100)).toFixed(8);
    const sl = Math.max(0.00000001, entry - (atr1h * 1.5));

    return { ok:true, symbol, score, entry, tp, sl, indicators: { ema8_1h, ema21_1h, rsi1h, macd1h: macd1h?macd1h.histogram:null, atr1h, ema8_4h, ema21_4h, macd4h: macd4h?macd4h.histogram:null }, reasons };
  } catch (e) {
    return { ok:false, symbol, error: String(e) };
  }
}

// ----------------- endpoints -----------------

// root health
app.get("/", (_req,res) => res.send("DexScan backend (Bitget) ✅"));

// top10 but only BTC/ETH/BNB for frontend top bar (consistent)
app.get("/api/top10", async (_req,res) => {
  try {
    const cg = await fetchTopCoinGecko(200);
    const pick = ["bitcoin","ethereum","binancecoin"];
    const out = [];
    for (const id of pick) {
      const c = (cg || []).find(x => x.id === id);
      if (c) out.push({ symbol: (c.symbol||"").toUpperCase()+"USDT", price: c.current_price, change24h: c.price_change_percentage_24h });
      else out.push({ symbol: id.toUpperCase(), price: null, change24h: null });
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message || String(e) }); }
});

// top scan run - heavy scan -> up to configured count (default 10)
app.post("/api/scan/run", async (_req,res) => {
  try {
    await appendLog("Scan run started");
    const cfg = await readJsonSafe(CFG_FILE, {});
    const desired = (cfg.settings && cfg.settings.count) ? Number(cfg.settings.count) : 10;

    const coins = await fetchTopCoinGecko(200);
    const universe = coins.map(c => (c.symbol||"").toUpperCase()+"USDT").filter(s => s);
    const results = [];
    for (let i=0;i<universe.length;i++){
      const s = universe[i];
      try {
        const r = await analyzeSymbol(s);
        if (r.ok && r.score >= 6) results.push(r);
      } catch(e){}
      if (results.length >= Math.max(10, desired)) break;
    }
    results.sort((a,b)=>b.score - a.score);
    const top = results.slice(0, desired);
    await writeJsonSafe(SCANS_FILE, top);
    await appendLog(`Scan finished: ${top.length}`);
    res.json(top);
  } catch (e) {
    await appendLog("scan error: " + (e.message || e));
    res.status(500).json({ error: e.message || String(e) });
  }
});

// return last scan results
app.get("/api/scan/results", async (_req,res) => {
  const scans = await readJsonSafe(SCANS_FILE, []);
  res.json(scans);
});

// balance (try Bitget first, fallback to local wallet)
app.get("/api/bitget/balance", async (_req,res) => {
  try {
    const b = await getSpotBalancesSimple();
    if (b.ok) return res.json(b.data);
    const local = await readJsonSafe(WALLET_FILE, { USDT: 10000 });
    return res.json(local);
  } catch (e) { res.status(500).json({ error: e.message || String(e) }); }
});

// manual buy/order endpoint - calculates qty from percent of USDT and records trade
app.post("/api/bitget/order", async (req,res) => {
  try {
    const { symbol, side = "buy", percent } = req.body;
    if (!symbol || !side) return res.status(400).json({ error: "symbol and side required" });

    // get USDT balance
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

    // price resolution: try bitget ticker then coingecko fallback
    let price = null;
    try {
      const t = await fetchSymbolTicker(symbol);
      if (t.ok) {
        // bitget ticker shape varies, attempt to extract
        const p = t.data?.data?.last || t.data?.last || t.data?.price || null;
        price = p ? Number(p) : null;
      }
    } catch(e){}
    if (!price) {
      const cg = await fetchTopCoinGecko(200);
      const id = (cg.find(c => ((c.symbol||"").toUpperCase()+"USDT") === symbol) || {}).id;
      price = id ? Number((cg.find(x => x.id === id) || {}).current_price || 0) : 0;
    }
    if (!price || price <= 0) return res.status(500).json({ error: "price unavailable" });

    const qty = +(sizeUsd / price).toFixed(8);

    // try place order via bitget (may return error in demo or if creds invalid)
    const orderResp = await placeSpotOrder(symbol, side.toLowerCase(), qty, "market", null);

    // if order failed, still record a simulated trade but with order_error
    const trades = await readJsonSafe(TRADES_FILE, []);
    if (!orderResp.ok) {
      const sim = { id: "sim_" + Date.now(), symbol, side: side.toUpperCase(), qty, entry_price: price, invested: sizeUsd, buy_fee: +(sizeUsd * (FEE_PERCENT/100)), tp_price: +(price * (1 + TP_PERCENT/100)), status: "OPEN", demo: BITGET_DEMO, order_error: orderResp.error, created_at: new Date().toISOString() };
      trades.push(sim);
      await writeJsonSafe(TRADES_FILE, trades);
      await appendLog("order simulated (error): " + JSON.stringify(sim));
      return res.status(500).json({ ok:false, error: orderResp.error, trade: sim });
    }

    // success: store official trade
    const trade = { id: "t_" + Date.now(), symbol, side: side.toUpperCase(), qty, entry_price: price, invested: sizeUsd, buy_fee: +(sizeUsd * (FEE_PERCENT/100)), tp_price: +(price * (1 + TP_PERCENT/100)), status: "OPEN", demo: BITGET_DEMO, order_result: orderResp.data, created_at: new Date().toISOString(), autoSell: true };
    trades.push(trade);
    await writeJsonSafe(TRADES_FILE, trades);
    await appendLog("order placed: " + trade.id + " " + symbol);
    return res.json({ ok:true, trade });
  } catch (e) {
    await appendLog("bitget/order error: " + (e.message || e));
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

    // determine exit price
    let price = exit_price ? Number(exit_price) : null;
    if (!price) {
      const tk = await fetchSymbolTicker(t.symbol).catch(()=>({ok:false}));
      if (tk && tk.data) price = Number(tk.data?.data?.last || tk.data?.last || tk.data?.price || 0);
      if (!price) {
        const cg = await fetchTopCoinGecko(200);
        const id = (cg.find(c => ((c.symbol||"").toUpperCase()+"USDT") === t.symbol) || {}).id;
        price = id ? Number((cg.find(x => x.id === id) || {}).current_price || 0) : 0;
      }
    }
    if (!price || price <= 0) return res.status(500).json({ error: "price unavailable" });

    const gross = +(t.qty * price);
    const sellFee = +(gross * (FEE_PERCENT/100));
    const net = +(gross - sellFee);
    const pnl = +(net - t.invested);

    // attempt actual sell via Bitget
    const orderResp = await placeSpotOrder(t.symbol, "sell", t.qty, "market", null);

    t.status = "CLOSED";
    t.exit_price = price;
    t.sell_fee = sellFee;
    t.gross_proceeds = gross;
    t.net_proceeds = net;
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

// list trades (with estimated unrealized PnL)
app.get("/api/trades", async (_req,res) => {
  try {
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
  } catch (e) { res.status(500).json({ error: e.message || String(e) }); }
});

// auto toggles
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

// settings GET/POST (persist)
app.get("/api/settings", async (_req,res) => {
  try {
    const cfg = await readJsonSafe(CFG_FILE, {});
    const defaults = { tp:10, sl:100, invest:5, count:10, autosell:true, max_concurrent: MAX_CONCURRENT };
    const out = { ...(defaults), ...(cfg.settings || {}) };
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message || String(e) }); }
});
app.post("/api/settings", async (req,res) => {
  try {
    const body = req.body || {};
    const cfg = await readJsonSafe(CFG_FILE, {});
    cfg.settings = { ...(cfg.settings||{}), ...body };
    await writeJsonSafe(CFG_FILE, cfg);
    res.json({ ok:true, settings: cfg.settings });
  } catch (e) { res.status(500).json({ error: e.message || String(e) }); }
});

// toggle per-trade autoSell flag
app.post("/api/trade/toggle_autosell", async (req,res) => {
  try {
    const { trade_id, auto } = req.body;
    if (!trade_id) return res.status(400).json({ error: 'trade_id required' });
    const trades = await readJsonSafe(TRADES_FILE, []);
    const t = trades.find(x => x.id === trade_id);
    if (!t) return res.status(404).json({ error:'trade not found' });
    t.autoSell = !!auto;
    await writeJsonSafe(TRADES_FILE, trades);
    res.json({ ok:true, trade: t });
  } catch (e) { res.status(500).json({ error: e.message || String(e) }); }
});

// ----------------- Auto worker (buy & monitor) -----------------
let workerBusy = false;

async function autoWorker() {
  try {
    if (workerBusy) return;
    workerBusy = true;
    const cfg = await readJsonSafe(CFG_FILE, { auto:false, settings: {} });
    if (!cfg.auto) return;

    // count open positions
    const trades = await readJsonSafe(TRADES_FILE, []);
    const openCount = (trades || []).filter(t => t.status === "OPEN").length;
    const maxCon = Number((cfg.settings && cfg.settings.count) ? cfg.settings.count : MAX_CONCURRENT);

    if (openCount >= maxCon) {
      await appendLog(`AutoWorker: open ${openCount} >= max ${maxCon}`);
      return;
    }

    // quick scan universe (top N), analyze and pick high scoring symbols
    const coins = await fetchTopCoinGecko(200);
    const universe = coins.map(c => (c.symbol||"").toUpperCase()+"USDT").slice(0, 50);
    const signals = [];
    for (const s of universe) {
      try {
        const r = await analyzeSymbol(s);
        if (r.ok && r.score >= 6) signals.push(r);
      } catch(e){}
      if (signals.length >= 30) break;
    }
    signals.sort((a,b)=>b.score - a.score);

    for (const sig of signals) {
      const tradesNow = await readJsonSafe(TRADES_FILE, []);
      const openNow = (tradesNow || []).filter(t => t.status === "OPEN").length;
      if (openNow >= maxCon) break;
      // skip if already have open trade for symbol
      if ((tradesNow || []).some(t => t.symbol === sig.symbol && t.status === "OPEN")) continue;
      // call internal buy endpoint to standardize recording
      try {
        await axios.post(`http://localhost:${PORT}/api/bitget/order`, { symbol: sig.symbol, side: "buy", percent: cfg.settings?.percent || DEFAULT_PERCENT }, { timeout: 60000 });
        await appendLog(`Auto buy requested for ${sig.symbol}`);
      } catch (e) {
        await appendLog(`Auto buy failed for ${sig.symbol}: ${e?.message||String(e)}`);
      }
    }

  } catch (e) {
    await appendLog("autoWorker error: " + (e.message || e));
  } finally {
    workerBusy = false;
  }
}
setInterval(autoWorker, 30 * 1000);

// ----------------- monitor open trades for TP hit (and auto-sell) -----------------
async function monitorTradesLoop() {
  try {
    const trades = await readJsonSafe(TRADES_FILE, []);
    const cg = await fetchTopCoinGecko(200);
    const prices = {};
    (cg || []).forEach(c => prices[(c.symbol||"").toUpperCase()+"USDT"] = c.current_price);

    let changed = false;
    for (const t of trades.filter(x => x.status === "OPEN")) {
      const latest = prices[t.symbol] || null;
      if (!latest) continue;
      // TP check
      if (latest >= (t.tp || t.tp_price || t.tp_price || t.tp_price) || latest >= (t.tp_price || t.tp || (t.entry_price * (1 + TP_PERCENT/100)))) {
        // auto-sell if autoSell enabled
        if (t.autoSell !== false) {
          try {
            await axios.post(`http://localhost:${PORT}/api/trade/close`, { trade_id: t.id, exit_price: latest }, { timeout: 60000 });
            await appendLog(`Auto-sell triggered for ${t.id} at ${latest}`);
            changed = true;
          } catch (e) {
            await appendLog(`Auto-sell failed for ${t.id}: ${e?.message||String(e)}`);
          }
        }
      }
    }
    if (changed) {
      // no-op; monitorTradesLoop will persist changes via close endpoint
    }
  } catch (e) {
    console.warn("monitorTradesLoop error", e.message || e);
  }
}
setInterval(monitorTradesLoop, 5000);

// ----------------- start server -----------------
app.listen(PORT, () => console.log(`DexScan backend (Bitget) running on ${PORT}`));
