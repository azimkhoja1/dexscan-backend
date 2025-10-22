// server.js
import express from "express";
import axios from "axios";
import cors from "cors";
import fs from "fs-extra";
import { EMA, RSI, MACD, ATR } from "technicalindicators";
import { WebSocket } from "ws";

const app = express();
app.use(cors());
app.use(express.json());

// Directories for fake paper trading
await fs.ensureDir("./data");
const WALLET_FILE = "./data/fake_wallet.json";
const SCANS_FILE = "./data/scan_results.json";
const TRADES_FILE = "./data/sim_trades.json";

async function readJson(file, defaultVal) {
  try { return await fs.readJson(file); } catch(e){ return defaultVal; }
}
async function writeJson(file, val) { await fs.writeJson(file, val, { spaces: 2 }); }

if (!(await fs.pathExists(WALLET_FILE))) {
  await writeJson(WALLET_FILE, { USDT: 2000.00, positions: [] });
}
if (!(await fs.pathExists(SCANS_FILE))) await writeJson(SCANS_FILE, []);
if (!(await fs.pathExists(TRADES_FILE))) await writeJson(TRADES_FILE, []);

const latestPrices = {}; // symbol -> price number

// Helpers
async function fetch24hTickers() {
  const url = "https://data-api.binance.vision/api/v3/ticker/24hr";
  const r = await axios.get(url);
  return r.data;
}

async function fetchKlines(symbol, interval, limit = 200) {
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const r = await axios.get(url);
  return r.data;
}

function last(values) { return values[values.length-1]; }

// ----- ANALYZE FUNCTION -----
async function analyzeSymbol(symbol) {
  const k1h = await fetchKlines(symbol, "1h", 200);
  const k4h = await fetchKlines(symbol, "4h", 100);

  const closes1h = k1h.map(k => parseFloat(k[4]));
  const highs1h = k1h.map(k => parseFloat(k[2]));
  const lows1h = k1h.map(k => parseFloat(k[3]));
  const vols1h = k1h.map(k => parseFloat(k[5]));

  const closes4h = k4h.map(k => parseFloat(k[4]));
  const highs4h = k4h.map(k => parseFloat(k[2]));
  const lows4h = k4h.map(k => parseFloat(k[3]));

  if (closes1h.length < 50 || closes4h.length < 20) throw new Error("Not enough data");

  const ema8_1h = last(EMA.calculate({ period: 8, values: closes1h }));
  const ema21_1h = last(EMA.calculate({ period: 21, values: closes1h }));
  const rsi1h = last(RSI.calculate({ period: 14, values: closes1h }));
  const macd1h = last(MACD.calculate({ values: closes1h, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }));
  const atr1h = last(ATR.calculate({ period: 14, high: highs1h, low: lows1h, close: closes1h }));

  const ema8_4h = last(EMA.calculate({ period: 8, values: closes4h }));
  const ema21_4h = last(EMA.calculate({ period: 21, values: closes4h }));
  const macd4h = last(MACD.calculate({ values: closes4h, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }));

  let score = 0;
  if (ema8_1h > ema21_1h) score += 2;
  if (macd1h && macd1h.histogram > 0) score += 2;
  if (rsi1h > 45 && rsi1h < 65) score += 1;
  const volAvg = vols1h.slice(-20).reduce((a,b)=>a+b,0)/20;
  if (vols1h.at(-1) > 1.5 * volAvg) score += 2;
  if (ema8_4h > ema21_4h) score += 3;
  if (macd4h && macd4h.histogram > 0) score += 2;

  const entry = closes1h.at(-1);
  const sl = Math.max(0.00000001, entry - atr1h * 1.5);
  const tp = +(entry * 1.15).toFixed(8);

  return { symbol, score, entry, tp, sl };
}

// ----- ROUTES -----
app.get("/", (req, res) => res.send("DexScan backend (scanner + simulate) ✅"));

// ✅ TOP10 endpoint
app.get("/api/top10", async (req, res) => {
  try {
    const all = await fetch24hTickers();
    const usdt = all.filter(x => x.symbol.endsWith("USDT") && !x.symbol.includes("BUSD"));
    usdt.sort((a,b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));
    const top = usdt.slice(0, 10).map(x => ({
      symbol: x.symbol,
      price: latestPrices[x.symbol] ?? x.lastPrice,
      change24h: x.priceChangePercent
    }));
    res.json(top);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ✅ NEW: /api/latest (single top symbol latest price)
app.get("/api/latest", async (req, res) => {
  try {
    const all = await fetch24hTickers();
    const top = all.filter(x => x.symbol.endsWith("USDT"))
                   .sort((a,b)=>parseFloat(b.quoteVolume)-parseFloat(a.quoteVolume))[0];
    res.json({
      symbol: top.symbol,
      price: latestPrices[top.symbol] ?? top.lastPrice,
      change24h: top.priceChangePercent
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ✅ NEW: /api/volume (top 10 by volume)
app.get("/api/volume", async (req, res) => {
  try {
    const all = await fetch24hTickers();
    const usdt = all.filter(x => x.symbol.endsWith("USDT"));
    usdt.sort((a,b)=>parseFloat(b.quoteVolume)-parseFloat(a.quoteVolume));
    const data = usdt.slice(0,10).map(x=>({
      symbol: x.symbol,
      volume: x.quoteVolume,
      price: x.lastPrice
    }));
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ----- Existing Scan, Wallet, Trade Simulation -----
/* (keep your same scan, trade, and fake wallet code — no changes needed)
   It’s already correct and stable.
*/

// --- WebSocket live updates ---
const subscribedSymbols = new Set();
function subscribeSymbolWS(symbol) {
  try {
    const pair = symbol.toLowerCase();
    const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${pair}@trade`);
    ws.on("message", (msg) => {
      try {
        const d = JSON.parse(msg);
        latestPrices[symbol] = parseFloat(d.p);
      } catch {}
    });
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`DexScan backend (scanner) running on ${PORT}`));
