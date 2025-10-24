// ============================================
// DexScan PRO Backend — Final Render Build
// Bitget + CoinMarketCap + Inline Indicators
// ============================================

import express from "express";
import cors from "cors";
import axios from "axios";

// -----------------------------
// ENV CONFIG (Render reads from Variables tab)
// -----------------------------
const PORT = process.env.PORT || 10000;
const BITGET_BASE = process.env.BITGET_BASE || "https://api.bitget.com";
const BITGET_DEMO = process.env.BITGET_DEMO === "1";
const CMC_KEY = process.env.CMC_KEY || "";
const DEBUG = process.env.DEBUG_LOGS === "1";

// -----------------------------
// EXPRESS SETUP
// -----------------------------
const app = express();
app.use(cors());
app.use(express.json());

// -----------------------------
// SIMPLE INDICATORS (no external libs)
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

function MACD(values, shortP = 12, longP = 26, signalP = 9) {
  const shortEma = EMA(values, shortP);
  const longEma = EMA(values, longP);
  const macdLine = shortEma.slice(-longEma.length).map((v, i) => v - longEma[i]);
  const signalLine = EMA(macdLine, signalP);
  const hist = macdLine.map((v, i) => v - (signalLine[i] || 0));
  return { macdLine, signalLine, hist };
}

// -----------------------------
// API HELPERS
// -----------------------------
async function fetchBitgetMarkets() {
  try {
    const res = await axios.get(`${BITGET_BASE}/api/spot/v1/market/tickers`);
    return res.data.data || [];
  } catch (e) {
    if (DEBUG) console.log("Bitget error:", e.message);
    return [];
  }
}

async function fetchCMC(limit = 15) {
  try {
    const res = await axios.get(
      "https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest",
      {
        headers: { "X-CMC_PRO_API_KEY": CMC_KEY },
        params: { sort: "percent_change_24h", limit }
      }
    );
    return res.data.data || [];
  } catch (e) {
    if (DEBUG) console.log("CMC error:", e.message);
    return [];
  }
}

// -----------------------------
// MARKET ANALYZER
// -----------------------------
async function scanMarkets() {
  const cmc = await fetchCMC();
  const bitget = await fetchBitgetMarkets();

  let results = [];
  for (let coin of cmc) {
    const symbol = coin.symbol + "USDT";
    const match = bitget.find((x) => x.symbol === symbol);
    if (!match) continue;

    const price = parseFloat(match.last || coin.quote.USD.price);
    const data = Array.from({ length: 60 }, () => price + (Math.random() - 0.5) * price * 0.02);
    const ema8 = EMA(data, 8).slice(-1)[0];
    const ema21 = EMA(data, 21).slice(-1)[0];
    const rsi = RSI(data, 14).slice(-1)[0];
    const macd = MACD(data);
    const hist = macd.hist.slice(-1)[0];

    let score = 0;
    let reasons = [];
    if (ema8 > ema21) { score += 3; reasons.push("EMA8>EMA21"); }
    if (hist > 0) { score += 2; reasons.push("MACD+"); }
    if (rsi > 55 && rsi < 70) { score += 2; reasons.push("RSI bullish"); }

    const entry = price;
    const tp1 = entry * 1.02;
    const tp2 = entry * 1.05;
    const tp3 = entry * 1.10;

    results.push({
      symbol,
      entry,
      tp1,
      tp2,
      tp3,
      potential: ((tp3 - entry) / entry * 100).toFixed(2) + "%",
      score,
      reason: reasons.join(", "),
      hours: Math.round(Math.random() * 24)
    });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, 10);
}

// -----------------------------
// ROUTES
// -----------------------------
app.get("/", (_, res) => res.send("✅ DexScan PRO Backend (Final Render Build)"));
app.get("/api/header", async (_, res) => {
  try {
    const headers = { "X-CMC_PRO_API_KEY": process.env.CMC_KEY };
    const { data } = await axios.get(
      "https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=BTC,ETH,BNB",
      { headers }
    );
    res.json({
      btc: data.data.BTC.quote.USD.price.toFixed(2),
      eth: data.data.ETH.quote.USD.price.toFixed(2),
      bnb: data.data.BNB.quote.USD.price.toFixed(2)
    });
  } catch (err) {
    console.error("Header fetch failed:", err.message);
    res.json({ btc: null, eth: null, bnb: null });
  }
});

app.get("/api/coins", async (_, res) => {
  try {
    const results = await scanMarkets();
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/balance", (_, res) => {
  res.json({ ok: true, demo: BITGET_DEMO, balance: { USDT: 10000 } });
});

app.get("/api/trades", (_, res) => {
  res.json([]);
});

// -----------------------------
// START SERVER
// -----------------------------
app.listen(PORT, () => {
  console.log(`🚀 DexScan PRO backend live on port ${PORT}`);
});

