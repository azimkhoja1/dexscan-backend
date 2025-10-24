// server.js — DexScan V3 (Bitget + CMC Hybrid) — Full Stable Build
import express from "express";
import axios from "axios";
import cors from "cors";
import fs from "fs-extra";
import crypto from "crypto";
import { EMA, RSI, MACD, ATR } from "technicalindicators";

const app = express();
app.use(cors());
app.use(express.json());

// -------- CONFIG --------
const PORT = process.env.PORT || 10000;

const BITGET_API_KEY = process.env.BITGET_API_KEY || "";
const BITGET_API_SECRET = process.env.BITGET_API_SECRET || "";
const BITGET_API_PASSPHRASE = process.env.BITGET_API_PASSPHRASE || "";
const BITGET_BASE = process.env.BITGET_BASE || "https://api.bitget.com";
const BITGET_DEMO = process.env.BITGET_DEMO === "1";
const CMC_KEY = process.env.CMC_KEY || "";

const TP_PERCENT = Number(process.env.TP_PERCENT || 10);
const DEFAULT_PERCENT = Number(process.env.PERCENT_PER_TRADE || 2);
const FEE_PERCENT = Number(process.env.FEE_PERCENT || 0.2);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 10);

// -------- STORAGE --------
await fs.ensureDir("./data");
const TRADES_FILE = "./data/trades.json";
const CFG_FILE = "./data/config.json";
if (!(await fs.pathExists(TRADES_FILE))) await fs.writeJson(TRADES_FILE, []);
if (!(await fs.pathExists(CFG_FILE))) await fs.writeJson(CFG_FILE, { auto: false });

async function readSafe(path, def) {
  try { return await fs.readJson(path); } catch { return def; }
}
async function writeSafe(path, data) {
  try { await fs.writeJson(path, data, { spaces: 2 }); } catch {}
}

// -------- BITGET AUTH --------
function bitgetHeaders(method, path, body = "") {
  const timestamp = Date.now().toString();
  const prehash = timestamp + method.toUpperCase() + path + body;
  const sign = crypto.createHmac("sha256", BITGET_API_SECRET).update(prehash).digest("base64");
  return {
    "ACCESS-KEY": BITGET_API_KEY,
    "ACCESS-SIGN": sign,
    "ACCESS-TIMESTAMP": timestamp,
    "ACCESS-PASSPHRASE": BITGET_API_PASSPHRASE,
    "Content-Type": "application/json"
  };
}
async function bitgetBalance() {
  try {
    const res = await axios.get(`${BITGET_BASE}/api/v2/account/accounts`, { headers: bitgetHeaders("GET", "/api/v2/account/accounts") });
    const map = {};
    res.data.data.forEach(acc => { map[acc.currency.toUpperCase()] = +acc.available; });
    return map;
  } catch { return { USDT: 10000 }; }
}
async function placeOrder(symbol, side, size) {
  if (BITGET_DEMO) return { ok: true, simulated: true };
  const path = "/api/spot/v1/trade/orders";
  const body = { symbol, side: side.toUpperCase(), size: String(size), type: "market" };
  const res = await axios.post(BITGET_BASE + path, body, { headers: bitgetHeaders("POST", path, JSON.stringify(body)) });
  return res.data;
}

// -------- DATA SOURCES --------
let cmcCache = { ts: 0, data: [] };
async function fetchCMC(limit = 200) {
  const now = Date.now();
  if (cmcCache.data.length && now - cmcCache.ts < 5 * 60 * 1000) return cmcCache.data;
  const res = await axios.get("https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest", {
    headers: { "X-CMC_PRO_API_KEY": CMC_KEY },
    params: { start: 1, limit, convert: "USD" }
  });
  const arr = res.data.data.map(c => ({
    symbol: (c.symbol || "").toUpperCase() + "USDT",
    price: c.quote.USD.price,
    volume: c.quote.USD.volume_24h,
    marketCap: c.quote.USD.market_cap
  }));
  cmcCache = { ts: now, data: arr };
  return arr;
}
async function fetchBitgetTickers() {
  const res = await axios.get("https://api.bitget.com/api/spot/v1/market/tickers");
  const map = {};
  for (const t of res.data.data) map[t.symbol] = +t.last;
  return map;
}
async function fetchPriceMap() {
  try {
    const cmc = await fetchCMC(200);
    const map = {};
    cmc.forEach(c => map[c.symbol] = c.price);
    return map;
  } catch {
    console.log("⚠️ Using Bitget fallback for prices");
    return await fetchBitgetTickers();
  }
}

// -------- TECHNICALS --------
async function klines(symbol) {
  try {
    const r = await axios.get(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=1h&limit=200`);
    return r.data.map(k => +k[4]);
  } catch { return []; }
}
function analyze(vals) {
  if (vals.length < 30) return { score: 0 };
  const ema8 = EMA.calculate({ period: 8, values: vals }).pop();
  const ema21 = EMA.calculate({ period: 21, values: vals }).pop();
  const rsi = RSI.calculate({ period: 14, values: vals }).pop();
  const macd = MACD.calculate({ values: vals, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }).pop();
  let score = 0; const reasons = [];
  if (ema8 > ema21) { score += 3; reasons.push("EMA↑"); }
  if (macd.histogram > 0) { score += 2; reasons.push("MACD+"); }
  if (rsi > 45 && rsi < 65) { score += 1; reasons.push("RSI mid"); }
  return { score, reasons };
}

// -------- ROUTES --------
app.get("/", (req, res) => res.send("DexScan V3 (Bitget + CMC) ✅"));
app.get("/api/header", async (req, res) => {
  try {
    const map = await fetchBitgetTickers();
    res.json([{ symbol: "BTCUSDT", price: map.BTCUSDT }, { symbol: "ETHUSDT", price: map.ETHUSDT }, { symbol: "BNBUSDT", price: map.BNBUSDT }]);
  } catch { res.json([]); }
});
app.post("/api/scan/run", async (req, res) => {
  try {
    const list = await fetchCMC(50);
    const good = [];
    for (const c of list) {
      if (c.marketCap < 10_000_000 || c.volume < 1_000_000) continue;
      const vals = await klines(c.symbol);
      const { score, reasons } = analyze(vals);
      if (score >= 5) good.push({ symbol: c.symbol, entry: c.price, score, reasons });
      if (good.length >= 10) break;
    }
    await writeSafe("./data/scan_results.json", good);
    res.json(good);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get("/api/scan/results", async (req, res) => res.json(await readSafe("./data/scan_results.json", [])));
app.get("/api/balance", async (req, res) => {
  const b = await bitgetBalance();
  res.json({ ok: true, demo: BITGET_DEMO, balance: b });
});
app.get("/api/trades", async (req, res) => {
  try {
    const trades = await readSafe(TRADES_FILE, []);
    const map = await fetchPriceMap();
    const out = trades.map(t => {
      if (t.status === "OPEN") {
        const latest = map[t.symbol] || t.entry_price;
        const gross = t.qty * latest;
        const fee = gross * (FEE_PERCENT / 100);
        const net = gross - fee;
        const unreal = net - t.invested;
        return { ...t, latest_price: latest, est_net: net, unreal_pnl: unreal };
      }
      return t;
    });
    res.json(out);
  } catch (e) {
    console.log("Trade err", e.message);
    res.json([]);
  }
});
app.post("/api/trade/buy", async (req, res) => {
  const { symbol, percent = DEFAULT_PERCENT } = req.body;
  const bal = await bitgetBalance();
  const usdt = bal.USDT || 10000;
  const sizeUsd = usdt * (percent / 100);
  const map = await fetchPriceMap();
  const price = map[symbol] || 0;
  const qty = +(sizeUsd / price).toFixed(8);
  await placeOrder(symbol, "buy", qty);
  const trades = await readSafe(TRADES_FILE, []);
  trades.push({ id: Date.now().toString(), symbol, entry_price: price, qty, invested: sizeUsd, status: "OPEN" });
  await writeSafe(TRADES_FILE, trades);
  res.json({ ok: true });
});
app.post("/api/trade/sell", async (req, res) => {
  const { trade_id } = req.body;
  const trades = await readSafe(TRADES_FILE, []);
  const t = trades.find(x => x.id === trade_id);
  if (!t) return res.status(404).json({ error: "Not found" });
  const map = await fetchPriceMap();
  const price = map[t.symbol] || t.entry_price;
  const gross = t.qty * price;
  const fee = gross * (FEE_PERCENT / 100);
  const net = gross - fee;
  t.status = "CLOSED";
  t.exit_price = price;
  t.pnl = net - t.invested;
  await writeSafe(TRADES_FILE, trades);
  res.json({ ok: true, trade: t });
});
app.post("/api/auto", async (req, res) => {
  const cfg = await readSafe(CFG_FILE, {});
  cfg.auto = !!req.body.enabled;
  await writeSafe(CFG_FILE, cfg);
  res.json({ ok: true });
});
app.get("/api/auto", async (req, res) => {
  const cfg = await readSafe(CFG_FILE, {});
  res.json({ auto: !!cfg.auto });
});

setInterval(async () => {
  const cfg = await readSafe(CFG_FILE, {});
  if (!cfg.auto) return;
  const trades = await readSafe(TRADES_FILE, []);
  if (trades.filter(t => t.status === "OPEN").length >= MAX_CONCURRENT) return;
  const list = await readSafe("./data/scan_results.json", []);
  if (list.length) {
    const pick = list[0];
    await axios.post(`http://localhost:${PORT}/api/trade/buy`, { symbol: pick.symbol });
    console.log("Auto-buy:", pick.symbol);
  }
}, 30_000);

// -------- START --------
app.listen(PORT, () => console.log(`✅ DexScan backend running on ${PORT}`));
