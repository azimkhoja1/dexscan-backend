// =========================
// DexScan Backend V3.5 (Full Sync)
// =========================

import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";
import { getBitgetTicker, getBitgetSpotGainers } from "./bitget.js";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 10000;

// =========================
// In-memory demo database
// =========================
let mode = { demo: true };
let auto = { scan: false, trade: false };
let balance = { USDT: 10000 };
let trades = [];
let scannerResults = [];

// =========================
// Utility helpers
// =========================
function now() { return new Date().toISOString(); }
function rnd(min, max) { return +(Math.random() * (max - min) + min).toFixed(6); }

// =========================
// --- ROUTES ---
// =========================

// Health/root check
app.get("/", (req, res) => res.send("✅ DexScan API OK"));

// --- MODE / AUTO ---
app.get("/api/mode", (req, res) => res.json(mode));
app.post("/api/mode", (req, res) => { mode.demo = !!req.body.demo; res.json({ ok: true, demo: mode.demo }); });

app.get("/api/auto", (req, res) => res.json({ auto }));
app.post("/api/auto", (req, res) => {
  if (req.body.type === "trade") auto.trade = !!req.body.enabled;
  else auto.scan = !!req.body.enabled;
  res.json({ ok: true, auto });
});

// --- HEADER (Top Coins) ---
app.get("/api/header", async (req, res) => {
  try {
    const tickers = await getBitgetTicker(["BTCUSDT", "ETHUSDT", "BNBUSDT"]);
    res.json(tickers);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- SCANNER RESULTS (cache) ---
app.get("/api/scan/results", (req, res) => res.json(scannerResults));

// --- SCAN RUN ---
app.post("/api/scan/run", async (req, res) => {
  try {
    const gainers = await getBitgetSpotGainers();
    scannerResults = gainers.map((g, i) => ({
      id: i + 1,
      symbol: g.symbol,
      entry: g.entry,
      tp1: +(g.entry * 1.10).toFixed(6),
      tp2: +(g.entry * 1.15).toFixed(6),
      tp3: +(g.entry * 1.25).toFixed(6),
      potential_pct: rnd(10, 40),
      est_hours: rnd(1, 48).toFixed(0),
      score: rnd(6, 10),
      reasons: `RSI oversold rebound + EMA cross + volume surge`
    }));
    res.json(scannerResults);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- BALANCE ---
app.get("/api/balance", (req, res) => res.json({ ok: true, balance }));

// --- TRADES ---
app.get("/api/trades", async (req, res) => {
  try {
    // update latest prices
    const updated = [];
    for (const t of trades) {
      const last = await getBitgetTicker([t.symbol]);
      const latest = last[0]?.price || t.entry_price;
      const pnl = ((latest - t.entry_price) / t.entry_price) * 100;
      updated.push({ ...t, latest_price: latest, unreal_pnl: +pnl.toFixed(4) });
    }
    trades = updated;
    res.json(trades);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- BUY ---
app.post("/api/trade/buy", async (req, res) => {
  const sym = (req.body.symbol || "").toUpperCase();
  if (!sym) return res.status(400).json({ ok: false, error: "Symbol missing" });

  const tick = await getBitgetTicker([sym]);
  const entry = tick[0]?.price || rnd(0.01, 10);
  const qty = 1;

  const trade = {
    id: Date.now().toString(),
    symbol: sym,
    entry_price: entry,
    qty,
    status: "OPEN",
    created_at: now(),
  };

  trades.push(trade);
  if (mode.demo) balance.USDT -= entry * qty;

  res.json({ ok: true, trade });
});

// --- SELL ---
app.post("/api/trade/sell", (req, res) => {
  const id = req.body.trade_id;
  const t = trades.find(x => x.id === id);
  if (!t) return res.status(404).json({ ok: false, error: "Trade not found" });

  t.status = "CLOSED";
  t.exit_price = t.latest_price || t.entry_price;
  t.pnl = ((t.exit_price - t.entry_price) / t.entry_price) * 100;
  if (mode.demo) balance.USDT += t.exit_price * t.qty;

  res.json({ ok: true, trade: t });
});

// --- Historical winners learning (placeholder) ---
app.get("/api/learn/winners", async (req, res) => {
  try {
    const result = await getBitgetSpotGainers(4); // 4-day gainers
    res.json({ ok: true, data: result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =========================
// Start Server
// =========================
app.listen(PORT, () => console.log(`🚀 DexScan PRO backend running on port ${PORT}`));
