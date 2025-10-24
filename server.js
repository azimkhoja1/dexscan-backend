import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { getBitgetTicker, getTopMarkets } from "./bitget.js";
import { RSI, MACD, EMA } from "technicalindicators";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const DEMO = process.env.BITGET_DEMO === "1";
const CMC_KEY = process.env.CMC_KEY;
let trades = [];
let balance = { USDT: 10000 };

// === AI GAINER ANALYZER ===
async function fetchRecentGainers() {
  try {
    const url = `https://pro-api.coinmarketcap.com/v1/cryptocurrency/trending/gainers-losers?limit=50`;
    const res = await fetch(url, { headers: { "X-CMC_PRO_API_KEY": CMC_KEY }});
    const json = await res.json();
    return json?.data?.gainers || [];
  } catch (e) {
    console.error("CMC gainers failed:", e);
    return [];
  }
}

function scoreCoin(ohlcv) {
  try {
    const closes = ohlcv.map(c => c.close);
    const ema = EMA.calculate({ period: 20, values: closes });
    const macd = MACD.calculate({
      values: closes,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9
    });
    const rsi = RSI.calculate({ values: closes, period: 14 });

    const lastEma = ema.at(-1) || 0;
    const lastMacd = macd.at(-1)?.MACD || 0;
    const lastRsi = rsi.at(-1) || 50;

    let score = 0;
    if (lastEma < closes.at(-1)) score += 3;
    if (lastMacd > 0) score += 3;
    if (lastRsi > 55 && lastRsi < 75) score += 4;
    return score;
  } catch {
    return 0;
  }
}

async function analyzeMarkets() {
  const gainers = await fetchRecentGainers();
  const top = await getTopMarkets(25);
  const merged = [...new Set([...gainers.map(g => g.symbol), ...top.map(t => t.symbol)])];
  const results = [];

  for (const symbol of merged) {
    const price = await getBitgetTicker(symbol);
    if (!price || isNaN(price)) continue;

    // Fake OHLCV for indicators (demo mode)
    const ohlcv = Array.from({ length: 60 }, (_, i) => ({
      close: price * (1 + (Math.random() - 0.5) * 0.02)
    }));

    const score = scoreCoin(ohlcv);
    if (score < 6) continue;

    const tp1 = price * 1.05;
    const tp2 = price * 1.10;
    const tp3 = price * 1.20;
    const potential = ((tp3 - price) / price * 100).toFixed(2);
    const estHours = (Math.random() * 24).toFixed(0);

    results.push({ symbol, entry: price, tp1, tp2, tp3, potential_pct: potential, est_hours: estHours, score });
  }
  return results.slice(0, 10);
}

// === ROUTES ===
app.get("/api/header", async (req, res) => {
  try {
    const coins = ["BTCUSDT", "ETHUSDT", "BNBUSDT"];
    const data = await Promise.all(coins.map(async s => ({
      symbol: s,
      price: await getBitgetTicker(s)
    })));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/scan/run", async (req, res) => {
  const result = await analyzeMarkets();
  res.json(result);
});

app.get("/api/balance", (req, res) => {
  res.json({ ok: true, demo: DEMO, balance });
});

app.get("/api/trades", (req, res) => {
  const now = Date.now();
  const enriched = trades.map(t => ({
    ...t,
    latest_price: t.entry_price * (1 + (Math.random() - 0.5) * 0.02),
    unreal_pnl: ((Math.random() - 0.5) * 5).toFixed(2),
    updated: now
  }));
  res.json(enriched);
});

app.post("/api/trade/buy", (req, res) => {
  const { symbol } = req.body;
  const entry_price = Math.random() * 100 + 1;
  trades.push({ id: Date.now().toString(), symbol, entry_price, status: "OPEN" });
  res.json({ ok: true });
});

app.post("/api/trade/sell", (req, res) => {
  const { trade_id } = req.body;
  trades = trades.map(t => (t.id === trade_id ? { ...t, status: "CLOSED" } : t));
  res.json({ ok: true });
});

app.post("/api/mode", (req, res) => {
  const { demo } = req.body;
  process.env.BITGET_DEMO = demo ? "1" : "0";
  res.json({ ok: true, demo });
});

app.listen(PORT, () => {
  console.log(`🚀 DexScan PRO backend running on port ${PORT}`);
});
