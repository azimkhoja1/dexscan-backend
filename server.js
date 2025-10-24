// server.js — DexScan PRO (Binance-based universe, persistent demo wallet, live prices, auto-scan/auto-buy)
import express from "express";
import axios from "axios";
import cors from "cors";
import fs from "fs-extra";
import { EMA, RSI, MACD, ATR } from "technicalindicators";
import { getSpotBalancesSimple, placeSpotOrder, fetchSymbolTicker } from "./bitget.js";

const app = express();
app.use(cors());
app.use(express.json());

// --- storage paths (use /tmp for Render free)
const DATA_DIR = "/tmp/dexscan";
await fs.ensureDir(DATA_DIR);
const TRADES_FILE = `${DATA_DIR}/trades.json`;
const SCANS_FILE  = `${DATA_DIR}/scan_results.json`;
const CONFIG_FILE = `${DATA_DIR}/config.json`;
const WALLET_FILE = `${DATA_DIR}/wallet.json`;

if (!(await fs.pathExists(TRADES_FILE))) await fs.writeJson(TRADES_FILE, []);
if (!(await fs.pathExists(SCANS_FILE))) await fs.writeJson(SCANS_FILE, []);
if (!(await fs.pathExists(CONFIG_FILE))) await fs.writeJson(CONFIG_FILE, { demo: true, autoScan: false, percent: 2, tpPercent: 10, maxConcurrent: 10 });
if (!(await fs.pathExists(WALLET_FILE))) await fs.writeJson(WALLET_FILE, { USDT: 10000, positions: [] });

const PORT = process.env.PORT || 10000;
const DEFAULT_PERCENT = Number(process.env.PERCENT_PER_TRADE || 2);
const FEE_PERCENT = Number(process.env.FEE_PERCENT || 0.2);

// helper: safe read/write
async function readJson(p, def = null) { try { return await fs.readJson(p); } catch { return def; } }
async function writeJson(p, v) { try { return await fs.writeJson(p, v, { spaces: 2 }); } catch(e){ console.error("writeJson", e.message); } }

function last(a){ return a[a.length-1]; }

// --- Get full 24hr tickers from Binance public API (no API key required)
async function fetchBinance24h() {
  const url = "https://api.binance.com/api/v3/ticker/24hr";
  const res = await axios.get(url, { timeout: 15000 });
  return res.data; // array of { symbol, lastPrice, quoteVolume, ... }
}

// get latest prices for a set of symbols via single 24h call
async function getLatestPricesMap() {
  try {
    const all = await fetchBinance24h();
    const map = {};
    for (const t of all) map[t.symbol] = parseFloat(t.lastPrice);
    return map;
  } catch (e) {
    console.warn("binance 24h fetch failed", e.message);
    return {};
  }
}

// --- Klines helper (binance mirror)
async function fetchKlines(symbol, interval = "1h", limit = 200) {
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const r = await axios.get(url, { timeout: 15000 });
  return r.data;
}

// ANALYZE single symbol
async function analyzeSymbol(symbol) {
  try {
    if (!symbol || !symbol.endsWith("USDT")) return { ok:false, reason: "not-usdt" };
    const k1 = await fetchKlines(symbol,"1h",200);
    const k4 = await fetchKlines(symbol,"4h",100);
    const closes1 = k1.map(k=>parseFloat(k[4]));
    const highs1 = k1.map(k=>parseFloat(k[2]));
    const lows1 = k1.map(k=>parseFloat(k[3]));
    const vols1 = k1.map(k=>parseFloat(k[5]));
    const closes4 = k4.map(k=>parseFloat(k[4]));
    if (closes1.length < 50 || closes4.length < 20) return { ok:false, reason:"not-enough-data" };

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
    if (ema8_4h > ema21_4h) { score += 3; reasons.push("4H EMA>21"); }
    if (macd4h && macd4h.histogram > 0) { score += 2; reasons.push("4H MACD+"); }
    if (ema8_1h > ema21_1h) { score += 2; reasons.push("1H EMA>21"); }
    if (macd1h && macd1h.histogram > 0) { score += 1; reasons.push("1H MACD+"); }
    if (rsi1h > 45 && rsi1h < 65) { score += 1; reasons.push("RSI neutral"); }
    const volAvg = vols1.slice(-20).reduce((a,b)=>a+b,0)/20;
    if (vols1.at(-1) > 1.5 * volAvg) { score += 1; reasons.push("Vol spike"); }

    const entry = closes1.at(-1);
    const tp = +(entry * (1 + (await getConfig()).tpPercent/100)).toFixed(8);
    const sl = Math.max(0.00000001, entry - atr1h * 1.5);

    return { ok:true, symbol, score, entry, tp, sl, reasons, indicators: { ema8_1h, ema21_1h, rsi1h, macd1h: macd1h?.histogram ?? null, atr1h, ema8_4h, ema21_4h, macd4h: macd4h?.histogram ?? null } };
  } catch (e) {
    return { ok:false, symbol, error: String(e) };
  }
}

// config helpers
async function getConfig(){ return await readJson(CONFIG_FILE, { demo:true, autoScan:false, percent: DEFAULT_PERCENT, tpPercent: 10, maxConcurrent: 10 }); }
async function setConfig(cfg){ await writeJson(CONFIG_FILE, cfg); }

// WALLET helpers (demo mode)
async function getWallet(){ return await readJson(WALLET_FILE, { USDT:10000, positions: [] }); }
async function saveWallet(w){ await writeJson(WALLET_FILE, w); }

// --- API Routes ---
app.get("/", (_req, res) => res.send("DexScan PRO Backend ✅"));

app.get("/api/config", async (_req, res) => {
  const cfg = await getConfig();
  res.json(cfg);
});

// mode toggle endpoints
app.get("/api/mode", async (_req, res) => {
  const cfg = await getConfig();
  res.json({ demo: !!cfg.demo });
});
app.post("/api/mode", async (req, res) => {
  const cfg = await getConfig();
  cfg.demo = !!req.body.demo;
  await setConfig(cfg);
  res.json({ ok:true, demo: cfg.demo });
});

// coins list using Binance 24h (top volume -> returns unique USDT pairs)
app.get("/api/coins", async (_req, res) => {
  try {
    const all = await fetchBinance24h();
    const usdt = all.filter(t => t.symbol.endsWith("USDT") && !t.symbol.includes("BUSD") && !t.symbol.includes("UP") && !t.symbol.includes("DOWN"));
    usdt.sort((a,b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));
    const top = usdt.slice(0, 50).map(x => ({ symbol: x.symbol, price: parseFloat(x.lastPrice), change24h: x.priceChangePercent }));
    res.json(top);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// run heavy scan (POST) -> writes SCANS_FILE
app.post("/api/scan/run", async (_req, res) => {
  try {
    const all = await fetchBinance24h();
    const usdt = all.filter(t => t.symbol.endsWith("USDT") && !t.symbol.includes("BUSD") && !t.symbol.includes("UP") && !t.symbol.includes("DOWN"));
    usdt.sort((a,b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));
    const universe = usdt.slice(0, 150).map(x => x.symbol);
    const results = [];
    for (const s of universe) {
      try {
        const r = await analyzeSymbol(s);
        if (r.ok && r.score >= 3) results.push(r);
      } catch (e) {}
      if (results.length >= 20) break;
    }
    await writeJson(SCANS_FILE, results);
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/scan/results", async (_req, res) => {
  res.json(await readJson(SCANS_FILE, []));
});

// wallet & balance
app.get("/api/balance", async (_req, res) => {
  try {
    const cfg = await getConfig();
    if (cfg.demo) {
      const w = await getWallet();
      return res.json({ ok:true, demo:true, balance: { USDT: w.USDT }, wallet: w });
    }
    // live: try bitget
    const b = await getSpotBalancesSimple();
    if (b.ok) return res.json({ ok:true, demo:false, balance: b.data });
    return res.status(500).json({ ok:false, error: b.error || "Unable to fetch live balance" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// trades
app.get("/api/trades", async (_req, res) => {
  const trades = await readJson(TRADES_FILE, []);
  // augment with latest price & pnl
  const prices = await getLatestPricesMap();
  const out = (trades || []).map(t => {
    if (t.status === "OPEN") {
      const latest = prices[t.symbol] ?? null;
      const invested = t.invested ?? (t.entry_price * t.qty);
      const gross = latest ? +(t.qty * latest) : null;
      const fee = gross ? +(gross * (FEE_PERCENT/100)) : null;
      const net = gross && fee !== null ? +(gross - fee) : null;
      const pnl = net !== null ? +(net - invested) : null;
      return { ...t, latest_price: latest, pnl };
    }
    return t;
  });
  res.json(out);
});

// manual buy (demo or live)
app.post("/api/trade/buy", async (req, res) => {
  try {
    const { symbol, percent } = req.body;
    if (!symbol) return res.status(400).json({ error: "symbol required" });
    const cfg = await getConfig();
    const pct = Number(percent || cfg.percent || DEFAULT_PERCENT);

    if (cfg.demo) {
      // demo buy: deduct from wallet
      const w = await getWallet();
      const prices = await getLatestPricesMap();
      const price = prices[symbol];
      if (!price) return res.status(500).json({ error: "price unavailable" });
      const sizeUsd = +(w.USDT * (pct/100));
      if (sizeUsd <= 0) return res.status(400).json({ error: "insufficient balance" });
      const qty = +(sizeUsd / price).toFixed(8);
      w.USDT = +(w.USDT - sizeUsd).toFixed(8);
      const trade = { id: "sim_"+Date.now(), symbol, qty, entry_price: price, invested: sizeUsd, status: "OPEN", created_at: new Date().toISOString(), demo:true };
      const trades = await readJson(TRADES_FILE, []);
      trades.push(trade);
      await writeJson(TRADES_FILE, trades);
      await saveWallet(w);
      return res.json({ ok:true, trade, wallet: w });
    } else {
      // live attempt via bitget wrapper (wrapper should handle signed requests)
      const prices = await getLatestPricesMap();
      const price = prices[symbol] || null;
      const sizeUsd = 0; // for live we expect user to manage amount via settings; simple impl: use percent of USDT
      const fb = await getSpotBalancesSimple();
      const usdt = fb.ok ? (fb.data.USDT || fb.data.usdt || 0) : 0;
      const use = +(usdt * (pct/100));
      const qty = price ? +(use / price).toFixed(8) : 0;
      const order = await placeSpotOrder(symbol, "buy", qty, "market", null);
      if (!order.ok) return res.status(500).json({ ok:false, error: order.error });
      // record trade
      const trades = await readJson(TRADES_FILE, []);
      const trade = { id: "t_"+Date.now(), symbol, qty, entry_price: price, invested: use, status: "OPEN", created_at: new Date().toISOString(), demo:false, order_result: order.data };
      trades.push(trade);
      await writeJson(TRADES_FILE, trades);
      return res.json({ ok:true, trade });
    }
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// manual sell
app.post("/api/trade/sell", async (req, res) => {
  try {
    const { trade_id } = req.body;
    if (!trade_id) return res.status(400).json({ error: "trade_id required" });
    const trades = await readJson(TRADES_FILE, []);
    const t = trades.find(x => x.id == trade_id || x.id === trade_id);
    if (!t) return res.status(404).json({ error: "trade not found" });
    if (t.status !== "OPEN") return res.status(400).json({ error: "trade not open" });

    const prices = await getLatestPricesMap();
    const exitPrice = prices[t.symbol] ?? t.entry_price;
    const gross = +(t.qty * exitPrice);
    const sellFee = +(gross * (FEE_PERCENT/100));
    const net = +(gross - sellFee);
    const pnl = +(net - (t.invested || (t.entry_price * t.qty)));

    if (t.demo) {
      // return proceeds to demo wallet
      const w = await getWallet();
      w.USDT = +( (w.USDT || 0) + net ).toFixed(8);
      t.status = "CLOSED";
      t.exit_price = exitPrice;
      t.sell_fee = sellFee;
      t.net_proceeds = net;
      t.pnl = pnl;
      t.closed_at = new Date().toISOString();
      await writeJson(TRADES_FILE, trades);
      await saveWallet(w);
      return res.json({ ok:true, trade: t, wallet: w });
    } else {
      // live sell via bitget
      const order = await placeSpotOrder(t.symbol, "sell", t.qty, "market", null);
      t.status = "CLOSED";
      t.exit_price = exitPrice;
      t.sell_fee = sellFee;
      t.net_proceeds = net;
      t.pnl = pnl;
      t.order_sell = order.ok ? order.data : order.error;
      t.closed_at = new Date().toISOString();
      await writeJson(TRADES_FILE, trades);
      return res.json({ ok:true, trade: t });
    }
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// auto-scan worker (background)
let autoBusy = false;
async function autoWorker() {
  try {
    if (autoBusy) return;
    autoBusy = true;
    const cfg = await getConfig();
    if (!cfg.autoScan) return;
    const trades = await readJson(TRADES_FILE, []);
    const openCount = (trades || []).filter(t => t.status === "OPEN").length;
    const maxConcurrent = cfg.maxConcurrent || 10;
    if (openCount >= maxConcurrent) return;

    // scan universe and buy top signals
    const all = await fetchBinance24h();
    const usdt = all.filter(t => t.symbol.endsWith("USDT") && !t.symbol.includes("BUSD") && !t.symbol.includes("UP") && !t.symbol.includes("DOWN"));
    usdt.sort((a,b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));
    const universe = usdt.slice(0, 120).map(x => x.symbol);

    for (const s of universe) {
      if ((await readJson(TRADES_FILE,[])).filter(t=>t.status==="OPEN").length >= maxConcurrent) break;
      const hasOpen = (await readJson(TRADES_FILE,[])).some(t => t.symbol === s && t.status === "OPEN");
      if (hasOpen) continue;
      try {
        const res = await analyzeSymbol(s);
        if (res.ok && res.score >= 4) {
          // place buy via internal API
          try {
            await axios.post(`http://localhost:${PORT}/api/trade/buy`, { symbol: s, percent: cfg.percent || DEFAULT_PERCENT }, { timeout: 120000 });
            console.log("Auto buy requested", s);
          } catch (e) { console.warn("auto buy error", s, e.message); }
        }
      } catch (e) {}
    }
  } catch (e) {
    console.error("autoWorker err", e.message);
  } finally { autoBusy = false; }
}
setInterval(autoWorker, 30 * 1000); // run every 30s

// ensure auto scan persists (read config)
app.post("/api/scan/auto/toggle", async (req, res) => {
  const { enabled } = req.body;
  const cfg = await getConfig();
  cfg.autoScan = !!enabled;
  await setConfig(cfg);
  res.json({ ok:true, autoScan: cfg.autoScan });
});

app.listen(PORT, () => console.log(`✅ DexScan backend running on ${PORT}`));
