// server.js (final)
import express from "express";
import axios from "axios";
import cors from "cors";
import fs from "fs-extra";
import { EMA, RSI, MACD, ATR } from "technicalindicators";
import { WebSocket } from "ws";

const app = express();
app.use(cors());
app.use(express.json());

// Ensure data folder and files
await fs.ensureDir("./data");
const WALLET_FILE = "./data/fake_wallet.json";
const SCANS_FILE = "./data/scan_results.json";
const TRADES_FILE = "./data/sim_trades.json";

async function readJson(file, defaultVal) {
  try { return await fs.readJson(file); } catch (e) { return defaultVal; }
}
async function writeJson(file, val) { await fs.writeJson(file, val, { spaces: 2 }); }

if (!(await fs.pathExists(WALLET_FILE))) {
  await writeJson(WALLET_FILE, { USDT: 2000.00, positions: [] });
}
if (!(await fs.pathExists(SCANS_FILE))) await writeJson(SCANS_FILE, []);
if (!(await fs.pathExists(TRADES_FILE))) await writeJson(TRADES_FILE, []);

// In-memory latest prices cache
const latestPrices = {}; // symbol -> number

// ======= Utilities to fetch data from Binance public mirrors =======
async function fetch24hTickers() {
  // stable public mirror
  const url = "https://data-api.binance.vision/api/v3/ticker/24hr";
  const r = await axios.get(url, { timeout: 15000 });
  return r.data;
}

async function fetchKlines(symbol, interval, limit = 200) {
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const r = await axios.get(url, { timeout: 20000 });
  return r.data;
}

function last(arr) { return arr[arr.length - 1]; }

// ======= Analysis/scanner function (1h + 4h indicators) =======
async function analyzeSymbol(symbol) {
  // fetch klines
  const k1h = await fetchKlines(symbol, "1h", 200);
  const k4h = await fetchKlines(symbol, "4h", 100);

  const closes1h = k1h.map(k => parseFloat(k[4]));
  const highs1h = k1h.map(k => parseFloat(k[2]));
  const lows1h = k1h.map(k => parseFloat(k[3]));
  const vols1h = k1h.map(k => parseFloat(k[5]));

  const closes4h = k4h.map(k => parseFloat(k[4]));

  if (closes1h.length < 50 || closes4h.length < 20) throw new Error("not enough data");

  const ema8_1h = last(EMA.calculate({ period: 8, values: closes1h }));
  const ema21_1h = last(EMA.calculate({ period: 21, values: closes1h }));
  const rsi1h = last(RSI.calculate({ period: 14, values: closes1h }));
  const macd1h = last(MACD.calculate({ values: closes1h, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }));
  const atr1h = last(ATR.calculate({ period: 14, high: highs1h, low: lows1h, close: closes1h }));

  const ema8_4h = last(EMA.calculate({ period: 8, values: closes4h }));
  const ema21_4h = last(EMA.calculate({ period: 21, values: closes4h }));
  const macd4h = last(MACD.calculate({ values: closes4h, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }));

  // scoring
  let score = 0;
  if (ema8_1h > ema21_1h) score += 2;
  if (macd1h && macd1h.histogram > 0) score += 2;
  if (rsi1h > 45 && rsi1h < 65) score += 1;
  const volAvg = vols1h.slice(-20).reduce((a,b)=>a+b,0)/20;
  if (vols1h[vols1h.length-1] > 1.5 * volAvg) score += 2;
  if (ema8_4h > ema21_4h) score += 3;
  if (macd4h && macd4h.histogram > 0) score += 2;

  const entry = closes1h.at(-1);
  const sl = Math.max(0.00000001, entry - atr1h * 1.5);
  const tp = +(entry * 1.15).toFixed(8); // default 15%

  return {
    symbol, score, entry, tp, sl,
    indicators: { ema8_1h, ema21_1h, rsi1h, macd1h: macd1h ? macd1h.histogram : null, atr1h, ema8_4h, ema21_4h, macd4h: macd4h ? macd4h.histogram : null }
  };
}

// ======= Routes =======

// Root health
app.get("/", (_req, res) => res.send("DexScan backend running ✅"));

// Top 10 by volume (uses latestPrices if available)
app.get("/api/top10", async (_req, res) => {
  try {
    const all = await fetch24hTickers();
    const usdt = all.filter(x => x.symbol.endsWith("USDT") && !x.symbol.includes("BUSD"));
    usdt.sort((a,b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));
    const top = usdt.slice(0, 10).map(x => ({ symbol: x.symbol, price: latestPrices[x.symbol] ?? x.lastPrice, change24h: x.priceChangePercent }));
    res.json(top);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Latest (single highest-volume symbol)
app.get("/api/latest", async (_req, res) => {
  try {
    const all = await fetch24hTickers();
    const top = all.filter(x => x.symbol.endsWith("USDT")).sort((a,b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))[0];
    res.json({ symbol: top.symbol, price: latestPrices[top.symbol] ?? top.lastPrice, change24h: top.priceChangePercent });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Top volumes
app.get("/api/volume", async (_req, res) => {
  try {
    const all = await fetch24hTickers();
    const usdt = all.filter(x => x.symbol.endsWith("USDT"));
    usdt.sort((a,b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));
    const data = usdt.slice(0, 10).map(x => ({ symbol: x.symbol, volume: x.quoteVolume, price: latestPrices[x.symbol] ?? x.lastPrice }));
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Scan run (heavy) — analyzes top 200 USDT pairs and saves top signals
app.post("/api/scan/run", async (_req, res) => {
  try {
    const all = await fetch24hTickers();
    const usdt = all.filter(x => x.symbol.endsWith("USDT") && !x.symbol.includes("BUSD")).sort((a,b)=>parseFloat(b.quoteVolume)-parseFloat(a.quoteVolume));
    const universe = usdt.slice(0, 200).map(x => x.symbol);

    const results = [];
    for (const s of universe) {
      try {
        const r = await analyzeSymbol(s);
        if (r.score >= 7) results.push(r);
      } catch (e) { /* skip symbol on error */ }
    }
    results.sort((a,b) => b.score - a.score);
    const top = results.slice(0, 15);
    await writeJson(SCANS_FILE, top);
    res.json(top);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get last scan results
app.get("/api/scan/results", async (_req, res) => {
  const scans = await readJson(SCANS_FILE, []);
  res.json(scans);
});

// Fake wallet + trades (persisted to data/*.json)
app.get("/api/wallet/fake", async (_req, res) => {
  const w = await readJson(WALLET_FILE, { USDT: 2000.00, positions: [] });
  const trades = await readJson(TRADES_FILE, []);
  res.json({ balance: w.USDT, positions: w.positions || [], trades });
});

// Simulate buy
app.post("/api/trade/simulate", async (req, res) => {
  try {
    const { user_id, symbol, side, size_usd, entry_price } = req.body;
    if (!symbol || !size_usd || !entry_price) return res.status(400).json({ error: "symbol,size_usd,entry_price required" });

    const wallet = await readJson(WALLET_FILE, { USDT: 2000.00, positions: [] });
    if (wallet.USDT < size_usd) return res.status(400).json({ error: "Insufficient USDT in fake wallet" });

    const qty = +(size_usd / entry_price).toFixed(8);
    wallet.USDT = +(wallet.USDT - size_usd).toFixed(8);

    const trade = {
      id: "sim_" + Date.now(),
      user_id: user_id || 1,
      symbol, side: side || "BUY",
      entry_price, qty,
      tp: +(entry_price * 1.15).toFixed(8),
      sl: +(entry_price - 1.5).toFixed(8),
      status: "OPEN",
      created_at: new Date().toISOString()
    };

    const trades = await readJson(TRADES_FILE, []);
    trades.push(trade);
    wallet.positions = wallet.positions || [];
    wallet.positions.push({ trade_id: trade.id, symbol, qty, entry_price });

    await writeJson(TRADES_FILE, trades);
    await writeJson(WALLET_FILE, wallet);
    res.json({ ok: true, trade });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Simulate sell (manual)
app.post("/api/trade/sell/simulate", async (req, res) => {
  try {
    const { trade_id, exit_price } = req.body;
    if (!trade_id || !exit_price) return res.status(400).json({ error: "trade_id and exit_price required" });

    const trades = await readJson(TRADES_FILE, []);
    const trade = trades.find(t => t.id === trade_id);
    if (!trade) return res.status(404).json({ error: "Trade not found" });
    if (trade.status !== "OPEN") return res.status(400).json({ error: "Trade not open" });

    const pnl = (exit_price - trade.entry_price) * trade.qty;
    const wallet = await readJson(WALLET_FILE, { USDT: 2000.00, positions: [] });
    wallet.USDT = +(wallet.USDT + pnl + (trade.entry_price * trade.qty)).toFixed(8);
    wallet.positions = (wallet.positions || []).filter(p => p.trade_id !== trade.id);

    trade.status = "CLOSED";
    trade.exit_price = exit_price;
    trade.closed_at = new Date().toISOString();
    trade.pnl = pnl;

    await writeJson(TRADES_FILE, trades);
    await writeJson(WALLET_FILE, wallet);
    res.json({ ok: true, trade });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Auto-simulate buy for top results (percent of wallet)
app.post("/api/trade/auto-sim", async (req, res) => {
  try {
    const { symbol, percent } = req.body;
    const wallet = await readJson(WALLET_FILE, { USDT: 2000.00, positions: [] });
    const pct = percent || 2;
    const size_usd = +(wallet.USDT * (pct/100)).toFixed(8);
    const price = latestPrices[symbol] || (await fetchKlines(symbol,"1h",2))[0][4];
    if (!price) return res.status(500).json({ error: "Price unavailable" });

    const body = { user_id:1, symbol, side:"BUY", size_usd, entry_price: +price };
    const resp = await axios.post(`http://localhost:${process.env.PORT || 10000}/api/trade/simulate`, body).catch(e => ({ data: { error: e.message }}));
    res.json(resp.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Monitor open trades and close at TP/SL
async function monitorTradesLoop() {
  try {
    const trades = await readJson(TRADES_FILE, []);
    const wallet = await readJson(WALLET_FILE, { USDT: 2000.00, positions: [] });
    let changed = false;

    for (const t of trades.filter(x => x.status === "OPEN")) {
      const price = latestPrices[t.symbol];
      if (!price) continue;
      if (price >= t.tp) {
        const pnl = (t.tp - t.entry_price) * t.qty;
        wallet.USDT = +(wallet.USDT + pnl + (t.entry_price * t.qty)).toFixed(8);
        wallet.positions = (wallet.positions || []).filter(p => p.trade_id !== t.id);
        t.status = "CLOSED"; t.exit_price = t.tp; t.closed_at = new Date().toISOString(); t.pnl = pnl;
        changed = true;
      } else if (price <= t.sl) {
        const pnl = (t.sl - t.entry_price) * t.qty;
        wallet.USDT = +(wallet.USDT + pnl + (t.entry_price * t.qty)).toFixed(8);
        wallet.positions = (wallet.positions || []).filter(p => p.trade_id !== t.id);
        t.status = "CLOSED"; t.exit_price = t.sl; t.closed_at = new Date().toISOString(); t.pnl = pnl;
        changed = true;
      }
    }
    if (changed) { await writeJson(TRADES_FILE, trades); await writeJson(WALLET_FILE, wallet); }
  } catch (e) {
    console.error("monitor error", e.message);
  }
}
setInterval(monitorTradesLoop, 5000);

// WebSocket subscriptions for top symbols (best-effort)
const subscribedSymbols = new Set();
function subscribeSymbolWS(symbol) {
  try {
    const pair = symbol.toLowerCase();
    const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${pair}@trade`);
    ws.on("message", (msg) => {
      try {
        const d = JSON.parse(msg);
        latestPrices[symbol] = parseFloat(d.p);
      } catch (e) {}
    });
    ws.on("open", () => console.log("WS open for", symbol));
    ws.on("error", (e) => console.warn("WS error for", symbol, e.message));
  } catch (e) {
    console.warn("subscribe failed", e.message);
  }
}

async function refreshTopSubscriptions() {
  try {
    const all = await fetch24hTickers();
    const usdt = all.filter(x => x.symbol.endsWith("USDT") && !x.symbol.includes("BUSD"));
    usdt.sort((a,b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));
    const top = usdt.slice(0, 15).map(x => x.symbol);
    for (const s of top) if (!subscribedSymbols.has(s)) {
      subscribedSymbols.add(s);
      subscribeSymbolWS(s);
    }
  } catch (e) {
    console.error("refresh subs error", e.message);
  }
}
refreshTopSubscriptions();
setInterval(refreshTopSubscriptions, 60 * 1000);

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`DexScan backend (scanner) running on ${PORT}`));
