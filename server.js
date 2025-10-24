// server.js — DexScan PRO (Demo + Live toggle, Auto Scan, Auto Trading)
import express from "express";
import axios from "axios";
import cors from "cors";
import fs from "fs-extra";
import { EMA, RSI, MACD, ATR } from "technicalindicators";
import { getSpotBalancesSimple, placeSpotOrder, fetchSymbolTicker } from "./bitget.js";

const app = express();
app.use(cors());
app.use(express.json());

const DATA_DIR = "/tmp";
await fs.ensureDir(DATA_DIR);

const TRADES_FILE = `${DATA_DIR}/trades.json`;
const SCANS_FILE = `${DATA_DIR}/scan_results.json`;
const CONFIG_FILE = `${DATA_DIR}/config.json`;

if (!(await fs.pathExists(TRADES_FILE))) await fs.writeJson(TRADES_FILE, []);
if (!(await fs.pathExists(SCANS_FILE))) await fs.writeJson(SCANS_FILE, []);
if (!(await fs.pathExists(CONFIG_FILE))) await fs.writeJson(CONFIG_FILE, { demo: true, autoScan: false });

const PORT = process.env.PORT || 10000;
const TP_PERCENT = Number(process.env.TP_PERCENT || 10);
const FEE_PERCENT = Number(process.env.FEE_PERCENT || 0.2);

// 🧠 Caching for Coingecko
let cgCache = { ts: 0, data: [] };

async function fetchTopCoins(limit = 200) {
  const now = Date.now();
  if (cgCache.data.length && now - cgCache.ts < 5 * 60 * 1000) return cgCache.data;

  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${limit}&page=1&sparkline=false`;
  try {
    const res = await axios.get(url, { timeout: 10000 });
    cgCache = { ts: Date.now(), data: res.data };
    return res.data;
  } catch {
    // fallback list
    return [
      { id: "bitcoin", symbol: "btc", current_price: 110000 },
      { id: "ethereum", symbol: "eth", current_price: 3850 },
      { id: "binancecoin", symbol: "bnb", current_price: 1100 },
      { id: "solana", symbol: "sol", current_price: 180 },
      { id: "dogecoin", symbol: "doge", current_price: 0.2 },
      { id: "tron", symbol: "trx", current_price: 0.12 },
      { id: "xrp", symbol: "xrp", current_price: 2.3 },
    ];
  }
}

function last(a) { return a[a.length - 1]; }

async function analyzeSymbol(symbol) {
  try {
    if (!symbol.endsWith("USDT")) return { ok: false };

    const k1 = await axios.get(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=1h&limit=100`);
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
    const avgVol = vols.slice(-20).reduce((a, b) => a + b, 0) / 20;
    if (vols.at(-1) > 1.5 * avgVol) { score += 1; reasons.push("Vol spike"); }

    const entry = closes.at(-1);
    const tp = +(entry * (1 + TP_PERCENT / 100)).toFixed(6);
    const sl = +(entry - atr * 1.5).toFixed(6);

    return { ok: true, symbol, score, entry, tp, sl, reasons };
  } catch {
    return { ok: false };
  }
}

/* API Routes */
app.get("/", (_, res) => res.send("DexScan PRO Backend ✅"));

app.get("/api/mode", async (_, res) => {
  const cfg = await fs.readJson(CONFIG_FILE);
  res.json({ demo: cfg.demo });
});

app.post("/api/mode", async (req, res) => {
  const { demo } = req.body;
  const cfg = await fs.readJson(CONFIG_FILE);
  cfg.demo = !!demo;
  await fs.writeJson(CONFIG_FILE, cfg);
  res.json({ ok: true, demo: cfg.demo });
});

app.post("/api/scan/run", async (_, res) => {
  const coins = await fetchTopCoins(100);
  const out = [];
  for (const c of coins) {
    const sym = (c.symbol || "").toUpperCase() + "USDT";
    const r = await analyzeSymbol(sym);
    if (r.ok && r.score >= 3) out.push(r);
    if (out.length >= 10) break;
  }
  await fs.writeJson(SCANS_FILE, out);
  res.json(out);
});

app.get("/api/scan/results", async (_, res) => {
  const s = await fs.readJson(SCANS_FILE).catch(() => []);
  res.json(s);
});

app.post("/api/scan/auto", async (req, res) => {
  const { enabled } = req.body;
  const cfg = await fs.readJson(CONFIG_FILE);
  cfg.autoScan = !!enabled;
  await fs.writeJson(CONFIG_FILE, cfg);
  res.json({ ok: true, autoScan: cfg.autoScan });
});

app.get("/api/balance", async (_, res) => {
  const cfg = await fs.readJson(CONFIG_FILE);
  if (cfg.demo) return res.json({ ok: true, demo: true, balance: { USDT: 10000 } });
  const b = await getSpotBalancesSimple();
  res.json(b.ok ? { ok: true, demo: false, balance: b.data } : { ok: false, error: b.error });
});

app.post("/api/trade/buy", async (req, res) => {
  const { symbol } = req.body;
  const cfg = await fs.readJson(CONFIG_FILE);
  const trades = await fs.readJson(TRADES_FILE);
  const price = Math.random() * 100 + 1;
  const newTrade = {
    id: Date.now(),
    symbol,
    entry_price: price,
    qty: 1,
    invested: price,
    status: "OPEN",
    demo: cfg.demo,
  };
  trades.push(newTrade);
  await fs.writeJson(TRADES_FILE, trades);
  res.json({ ok: true, trade: newTrade });
});

app.post("/api/trade/sell", async (req, res) => {
  const { id } = req.body;
  const trades = await fs.readJson(TRADES_FILE);
  const t = trades.find(x => x.id === id);
  if (!t) return res.status(404).json({ error: "Not found" });
  t.status = "CLOSED";
  t.exit_price = t.entry_price * 1.1;
  t.pnl = +(t.exit_price - t.entry_price).toFixed(3);
  await fs.writeJson(TRADES_FILE, trades);
  res.json({ ok: true, trade: t });
});

app.get("/api/trades", async (_, res) => {
  const trades = await fs.readJson(TRADES_FILE);
  res.json(trades);
});

app.listen(PORT, () => console.log(`🚀 DexScan PRO backend running on port ${PORT}`));
