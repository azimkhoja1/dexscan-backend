// ============================================
// DexScan PRO Backend — Render-safe build
// Bitget + CoinMarketCap + Inline Indicators
// ============================================

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

// -----------------------------
// ENV CONFIG
// -----------------------------
const PORT = process.env.PORT || 10000;
const BITGET_BASE = process.env.BITGET_BASE || "https://api.bitget.com";
const BITGET_DEMO = process.env.BITGET_DEMO === "1";
const CMC_KEY = process.env.CMC_KEY || "";
const DEBUG = process.env.DEBUG_LOGS === "1";

// -----------------------------
// BASIC EXPRESS APP
// -----------------------------
const app = express();
app.use(cors());
app.use(express.json());

// -----------------------------
// INLINE INDICATOR HELPERS
// -----------------------------
function EMA(values, period) {
  const k = 2 / (period + 1);
  let emaArray = [];
  let ema = values.slice(0, period).reduce((a, b) => a + b) / period;
  emaArray.push(ema);
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    emaArray.push(ema);
  }
  return emaArray;
}

function RSI(values, period = 14) {
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let rs = gains / (losses || 1);
  let rsi = [100 - 100 / (1 + rs)];
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) {
      gains = (gains * (period - 1) + diff) / period;
      losses = (losses * (period - 1)) / period;
    } else {
      gains = (gains * (period - 1)) / period;
      losses = (losses * (period - 1) - diff) / period;
    }
    rs = gains / (losses || 1);
    rsi.push(100 - 100 / (1 + rs));
  }
  return rsi;
}

function MACD(values, shortPeriod = 12, longPeriod = 26, signalPeriod = 9) {
  const shortEma = EMA(values, shortPeriod);
  const longEma = EMA(values, longPeriod);
  const macdLine = shortEma.slice(longEma.length * -1).map((v, i) => v - longEma[i]);
  const signalLine = EMA(macdLine, signalPeriod);
  const histogram = macdLine.map((v, i) => v - (signalLine[i] || 0));
  return { macdLine, signalLine, histogram };
}

// -----------------------------
// FETCH BITGET / CMC DATA
// -----------------------------
async function fetchMarketPrices() {
  try {
    const res = await axios.get(`${BITGET_BASE}/api/spot/v1/market/tickers`);
    return res.data.data || [];
  } catch (e) {
    if (DEBUG) console.error("Bitget fetch failed:", e.message);
    return [];
  }
}

async function fetchTopGainersCMC(limit = 10) {
  try {
    const res = await axios.get(
      `https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest`,
      {
        headers: { "X-CMC_PRO_API_KEY": CMC_KEY },
        params: { sort: "percent_change_24h", limit },
      }
    );
    return res.data.data || [];
  } catch (e) {
    if (DEBUG) console.error("CMC fetch failed:", e.message);
    return [];
  }
}

// -----------------------------
// ANALYZE MARKETS
// -----------------------------
async function scanMarkets() {
  const markets = await fetchMarketPrices();
  const gainers = await fetchTopGainersCMC(15);

  let results = [];
  for (const m of gainers) {
    const id = m.symbol + "USDT";
    const match = markets.find((x) => x.symbol === id);
    if (!match) continue;

    const prices = Array.from({ length: 50 }, () => parseFloat(match.last || m.quote.USD.price));
    const ema21 = EMA(prices, 21).slice(-1)[0];
    const ema8 = EMA(prices, 8).slice(-1)[0];
    const rsi14 = RSI(prices, 14).slice(-1)[0];
    const macd = MACD(prices);
    const macdHist = macd.histogram.slice(-1)[0];

    let score = 0;
    let reason = [];

    if (ema8 > ema21) {
      score += 3;
      reason.push("EMA8>EMA21");
    }
    if (macdHist > 0) {
      score += 2;
      reason.push("MACD+");
    }
    if (rsi14 > 55 && rsi14 < 70) {
      score += 2;
      reason.push("RSI Bullish");
    }

    const entry = parseFloat(match.last || m.quote.USD.price);
    const tp1 = entry * 1.02;
    const tp2 = entry * 1.05;
    const tp3 = entry * 1.10;
    const potential = ((tp3 - entry) / entry * 100).toFixed(2);

    results.push({
      symbol: id,
      entry,
      tp1,
      tp2,
      tp3,
      potential: potential + "%",
      score,
      reason: reason.join(", "),
      hours: Math.round(Math.random() * 24),
    });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, 10);
}

// -----------------------------
// ROUTES
// -----------------------------
app.get("/", (req, res) => {
  res.send("✅ DexScan PRO backend running");
});

app.get("/api/header", async (req, res) => {
  try {
    const data = await fetchMarketPrices();
    const btc = data.find((x) => x.symbol === "BTCUSDT");
    const eth = data.find((x) => x.symbol === "ETHUSDT");
    const bnb = data.find((x) => x.symbol === "BNBUSDT");
    res.json({
      btc: btc ? parseFloat(btc.last) : null,
      eth: eth ? parseFloat(eth.last) : null,
      bnb: bnb ? parseFloat(bnb.last) : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/coins", async (req, res) => {
  try {
    const results = await scanMarkets();
    res.json(results);
  } catch (e) {
    console.error("Scan error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Placeholder demo routes
app.get("/api/balance", (req, res) => {
  res.json({ ok: true, demo: BITGET_DEMO, balance: { USDT: 10000 } });
});

app.get("/api/trades", (req, res) => {
  res.json([]);
});

// -----------------------------
// START SERVER
// -----------------------------
app.listen(PORT, () => {
  console.log(`🚀 DexScan PRO backend running on port ${PORT}`);
});
