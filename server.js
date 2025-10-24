// server.js — DexScan stable backend (with CoinGecko fallback + relaxed filter)
import express from "express";
import axios from "axios";
import cors from "cors";
import fs from "fs-extra";
import { EMA, RSI, MACD, ATR } from "technicalindicators";
import { getSpotBalancesSimple, placeSpotOrder, fetchSymbolTicker } from "./bitget.js";

const app = express();
app.use(cors());
app.use(express.json());

const TRADES_FILE = "/tmp/trades.json";
const SCANS_FILE = "/tmp/scan_results.json";
await fs.ensureDir("/tmp");
if (!(await fs.pathExists(TRADES_FILE))) await fs.writeJson(TRADES_FILE, []);
if (!(await fs.pathExists(SCANS_FILE))) await fs.writeJson(SCANS_FILE, []);

const PORT = process.env.PORT || 10000;
const TP_PERCENT = Number(process.env.TP_PERCENT || 10);
const DEFAULT_PERCENT = Number(process.env.PERCENT_PER_TRADE || 2);
const FEE_PERCENT = Number(process.env.FEE_PERCENT || 0.2);

let cgCache = { ts: 0, data: [] };

async function fetchTopCoinGecko(limit = 200) {
  const now = Date.now();
  if (cgCache.data.length && (now - cgCache.ts) < 5 * 60 * 1000) return cgCache.data;
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${limit}&page=1&sparkline=false`;
  try {
    const res = await axios.get(url, { timeout: 15000 });
    cgCache = { ts: Date.now(), data: res.data };
    return res.data;
  } catch (e) {
    console.warn("⚠️ CoinGecko failed, using static fallback...");
    // fallback if API rate-limits or fails
    const fallback = [
      { id:"bitcoin", symbol:"btc", current_price:110000 },
      { id:"ethereum", symbol:"eth", current_price:3800 },
      { id:"binancecoin", symbol:"bnb", current_price:1100 },
      { id:"solana", symbol:"sol", current_price:180 },
      { id:"dogecoin", symbol:"doge", current_price:0.2 },
      { id:"tron", symbol:"trx", current_price:0.12 },
      { id:"xrp", symbol:"xrp", current_price:2.3 },
      { id:"cardano", symbol:"ada", current_price:0.55 },
      { id:"avalanche-2", symbol:"avax", current_price:29 },
      { id:"chainlink", symbol:"link", current_price:14 }
    ];
    cgCache = { ts: Date.now(), data: fallback };
    return fallback;
  }
}

function last(a){ return a[a.length-1]; }

async function analyzeSymbol(symbol) {
  try {
    if (!symbol.endsWith("USDT")) return { ok:false };
    const k1 = await axios.get(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=1h&limit=150`);
    const closes = k1.data.map(x => +x[4]);
    const highs = k1.data.map(x => +x[2]);
    const lows = k1.data.map(x => +x[3]);
    const vols = k1.data.map(x => +x[5]);

    const ema8 = last(EMA.calculate({ period: 8, values: closes }));
    const ema21 = last(EMA.calculate({ period: 21, values: closes }));
    const macd = last(MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }));
    const rsi = last(RSI.calculate({ period: 14, values: closes }));
    const atr = last(ATR.calculate({ period: 14, high: highs, low: lows, close: closes }));

    let score = 0, reasons = [];
    if (ema8 > ema21) { score += 3; reasons.push("EMA crossover"); }
    if (macd?.histogram > 0) { score += 2; reasons.push("MACD bullish"); }
    if (rsi > 45 && rsi < 65) { score += 1; reasons.push("RSI neutral"); }
    const avgVol = vols.slice(-20).reduce((a,b)=>a+b,0)/20;
    if (vols.at(-1) > 1.3 * avgVol) { score += 1; reasons.push("Vol spike"); }

    const entry = closes.at(-1);
    const tp = +(entry * (1 + TP_PERCENT / 100)).toFixed(6);
    const sl = +(entry - atr * 1.5).toFixed(6);

    return { ok:true, symbol, score, entry, tp, sl, reasons };
  } catch {
    return { ok:false };
  }
}

/* Routes */
app.get("/", (_,res)=>res.send("DexScan V2 (Bitget) ✅"));

app.post("/api/scan/run", async (_,res)=>{
  try {
    const cg = await fetchTopCoinGecko(100);
    const arr = [];
    for (const c of cg) {
      const sym = (c.symbol || "").toUpperCase() + "USDT";
      if (["USDTUSDT","BUSDUSDT","FDUSDUSDT"].includes(sym)) continue;
      const r = await analyzeSymbol(sym);
      if (r.ok && r.score >= 3) arr.push(r);
      if (arr.length >= 10) break;
    }
    await fs.writeJson(SCANS_FILE, arr, { spaces:2 });
    res.json(arr);
  } catch(e){ res.status(500).json({ error:e.message }); }
});

app.get("/api/scan/results", async(_,res)=>{
  const data = await fs.readJson(SCANS_FILE).catch(()=>[]);
  res.json(data);
});

app.get("/api/balance", (_,res)=>res.json({ ok:true, demo:true, balance:{ USDT:10000 } }));

app.get("/api/trades", async(_,res)=>{
  const data = await fs.readJson(TRADES_FILE).catch(()=>[]);
  res.json(data);
});

app.listen(PORT,()=>console.log(`✅ DexScan backend running on ${PORT}`));
