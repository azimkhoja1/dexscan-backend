// server.js — DexScan Backend (Login + Bitget + CMC hybrid)
// Full file — replace existing server.js with this exact content

import express from "express";
import axios from "axios";
import cors from "cors";
import fs from "fs-extra";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { EMA, RSI, MACD, ATR } from "technicalindicators";

const app = express();
app.use(cors());
app.use(express.json());

// ---------- ENV / CONFIG ----------
const PORT = process.env.PORT || 10000;

const BITGET_API_KEY = process.env.BITGET_API_KEY || "";
const BITGET_API_SECRET = process.env.BITGET_API_SECRET || "";
const BITGET_API_PASSPHRASE = process.env.BITGET_API_PASSPHRASE || "";
const BITGET_BASE = process.env.BITGET_BASE || "https://api.bitget.com";
const BITGET_DEMO = (process.env.BITGET_DEMO === "1");

const CMC_KEY = process.env.CMC_KEY || "";
const JWT_SECRET = process.env.JWT_SECRET || "please_change_this_secret";

const TP_PERCENT = Number(process.env.TP_PERCENT || 10);
const DEFAULT_PERCENT = Number(process.env.PERCENT_PER_TRADE || 2);
const FEE_PERCENT = Number(process.env.FEE_PERCENT || 0.2);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 10);

// ---------- File/Storage ----------
await fs.ensureDir("./data");
const TRADES_FILE = "./data/trades.json";
const CFG_FILE = "./data/config.json";
const USERS_FILE = "./users.json"; // in repo root (seeded)
if (!(await fs.pathExists(TRADES_FILE))) await fs.writeJson(TRADES_FILE, []);
if (!(await fs.pathExists(CFG_FILE))) await fs.writeJson(CFG_FILE, { auto: false, settings: { tp: TP_PERCENT, percent: DEFAULT_PERCENT, count: 10, autosell: true } });

// ---------- Helpers ----------
async function readSafe(path, def = null) {
  try { return await fs.readJson(path); } catch(e) { return def; }
}
async function writeSafe(path, val) {
  try { await fs.writeJson(path, val, { spaces: 2 }); } catch(e) { console.error("writeSafe error", e.message); }
}
function signJwt(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "12h" });
}
function verifyJwtToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch(e) { return null; }
}
function authMiddleware(req, res, next) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
  const token = h.slice(7);
  const decoded = verifyJwtToken(token);
  if (!decoded) return res.status(401).json({ error: "Invalid token" });
  req.user = decoded;
  next();
}

// ---------- Bitget lightweight wrapper ----------
function bitgetHeaders(method, path, bodyStr = "") {
  if (!BITGET_API_KEY || !BITGET_API_SECRET || !BITGET_API_PASSPHRASE) return {};
  const timestamp = Date.now().toString();
  const prehash = timestamp + method.toUpperCase() + path + (bodyStr || "");
  const hmac = crypto.createHmac("sha256", BITGET_API_SECRET);
  hmac.update(prehash);
  const signature = hmac.digest("base64");
  return {
    "ACCESS-KEY": BITGET_API_KEY,
    "ACCESS-SIGN": signature,
    "ACCESS-TIMESTAMP": timestamp,
    "ACCESS-PASSPHRASE": BITGET_API_PASSPHRASE,
    "Content-Type": "application/json"
  };
}
async function tryBitgetBalances() {
  if (!BITGET_API_KEY) return { ok: false, error: "no keys" };
  try {
    const path = "/api/v2/account/accounts";
    const res = await axios.get(BITGET_BASE + path, { headers: bitgetHeaders("GET", path), timeout: 10000 });
    const out = {};
    (res.data.data || []).forEach(a => { out[a.currency.toUpperCase()] = Number(a.available || a.balance || 0); });
    return { ok: true, data: out };
  } catch (e) {
    return { ok: false, error: e.response?.data || e.message || String(e) };
  }
}
async function tryPlaceSpot(symbol, side, size) {
  if (!BITGET_API_KEY) return { ok: false, error: "no keys" };
  const path = "/api/spot/v1/trade/orders";
  const body = { symbol, side: side.toUpperCase(), size: String(size), type: "market" };
  try {
    const res = await axios.post(BITGET_BASE + path, body, { headers: bitgetHeaders("POST", path, JSON.stringify(body)), timeout: 20000 });
    return { ok: true, data: res.data };
  } catch (e) {
    return { ok: false, error: e.response?.data || e.message || String(e) };
  }
}
async function tryBitgetTickersMap() {
  try {
    const res = await axios.get("https://api.bitget.com/api/spot/v1/market/tickers", { timeout: 10000 });
    const map = {};
    (res.data.data || []).forEach(t => map[t.symbol] = Number(t.last));
    return map;
  } catch (e) {
    return {};
  }
}

// ---------- CoinMarketCap provider ----------
let cmcCache = { ts: 0, data: [] };
async function fetchTopCMC(limit = 200) {
  const now = Date.now();
  if (cmcCache.data.length && (now - cmcCache.ts) < 5 * 60 * 1000) return cmcCache.data;
  if (!CMC_KEY) throw new Error("CMC_KEY missing");
  const res = await axios.get("https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest", {
    headers: { "X-CMC_PRO_API_KEY": CMC_KEY },
    params: { start: 1, limit, convert: "USD" },
    timeout: 15000
  });
  const arr = (res.data.data || []).map(c => ({
    id: c.id,
    symbol: (c.symbol || "").toUpperCase() + "USDT",
    price: c.quote?.USD?.price || 0,
    volume: c.quote?.USD?.volume_24h || 0,
    marketCap: c.quote?.USD?.market_cap || 0
  }));
  cmcCache = { ts: now, data: arr };
  return arr;
}

// ---------- Klines + indicators ----------
async function fetchKlinesBinance(symbol, interval = "1h", limit = 200) {
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const r = await axios.get(url, { timeout: 15000 });
  return r.data; // raw klines
}
function last(arr) { return arr[arr.length - 1]; }

async function analyzeSymbol(symbol) {
  try {
    if (!symbol.endsWith("USDT")) return { ok: false, symbol, reason: "not-usdt" };
    const base = symbol.replace("USDT", "");
    const stableBases = ["USDC","BUSD","DAI","TUSD","USDP","USTC","FRAX","USDD","FDUSD"];
    if (stableBases.includes(base)) return { ok: false, symbol, reason: "stable" };

    const k1 = await fetchKlinesBinance(symbol, "1h", 200);
    const k4 = await fetchKlinesBinance(symbol, "4h", 100);

    const closes1 = k1.map(k => Number(k[4]));
    const highs1 = k1.map(k => Number(k[2]));
    const lows1 = k1.map(k => Number(k[3]));
    const vols1 = k1.map(k => Number(k[5]));
    const closes4 = k4.map(k => Number(k[4]));

    if (closes1.length < 50 || closes4.length < 20) return { ok: false, symbol, reason: "insufficient" };

    const ema8_1 = last(EMA.calculate({ period: 8, values: closes1 }));
    const ema21_1 = last(EMA.calculate({ period: 21, values: closes1 }));
    const rsi1 = last(RSI.calculate({ period: 14, values: closes1 }));
    const macd1 = last(MACD.calculate({ values: closes1, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }));
    const atr1 = last(ATR.calculate({ period: 14, high: highs1, low: lows1, close: closes1 }));

    const ema8_4 = last(EMA.calculate({ period: 8, values: closes4 }));
    const ema21_4 = last(EMA.calculate({ period: 21, values: closes4 }));
    const macd4 = last(MACD.calculate({ values: closes4, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }));

    let score = 0;
    const reasons = [];
    if (ema8_4 > ema21_4) { score += 3; reasons.push("4H EMA8>21"); }
    if (macd4 && macd4.histogram > 0) { score += 2; reasons.push("4H MACD+"); }
    if (ema8_1 > ema21_1) { score += 2; reasons.push("1H EMA8>21"); }
    if (macd1 && macd1.histogram > 0) { score += 1; reasons.push("1H MACD+"); }
    if (rsi1 > 45 && rsi1 < 65) { score += 1; reasons.push("RSI neutral"); }
    const volAvg = vols1.slice(-20).reduce((a,b) => a + b, 0) / 20;
    if (vols1[vols1.length - 1] > 1.5 * volAvg) { score += 1; reasons.push("Vol spike"); }

    const entry = +closes1.at(-1);
    const tp = +(entry * (1 + TP_PERCENT / 100)).toFixed(8);
    const sl = Math.max(0.00000001, entry - (atr1 * 1.5));

    return { ok: true, symbol, score, entry, tp, sl, indicators: { ema8_1, ema21_1, rsi1, macd1: macd1 ? macd1.histogram : null, atr1, ema8_4, ema21_4, macd4: macd4 ? macd4.histogram : null }, reasons };
  } catch (e) {
    return { ok: false, symbol, error: String(e) };
  }
}

// ---------- AUTH endpoints ----------
app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "username/password required" });
    const users = await readSafe(USERS_FILE, []);
    const u = (users || []).find(x => x.username === username && x.password === password);
    if (!u) return res.status(401).json({ error: "Invalid credentials" });
    const token = signJwt({ id: u.id, username: u.username, role: u.role || "user" });
    return res.json({ ok: true, token, user: { id: u.id, username: u.username, role: u.role || "user" } });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

// ---------- Public info ----------
app.get("/", (_req, res) => res.send("DexScan (Auth + Bitget + CMC) ✅"));

app.get("/api/header", authMiddleware, async (_req, res) => {
  try {
    const tick = await tryBitgetTickersMap();
    res.json([{ symbol: "BTCUSDT", price: tick.BTCUSDT }, { symbol: "ETHUSDT", price: tick.ETHUSDT }, { symbol: "BNBUSDT", price: tick.BNBUSDT }]);
  } catch (e) { res.json([]); }
});

app.get("/api/coins", authMiddleware, async (_req, res) => {
  try {
    const arr = await fetchTopCMC(100);
    const filtered = arr.filter(c => c.marketCap > 10_000_000 && c.volume > 50_000).slice(0, 10);
    res.json(filtered);
  } catch (e) {
    // fallback to bitget tickers
    const map = await tryBitgetTickersMap();
    const list = Object.keys(map).slice(0, 10).map(s => ({ symbol: s, price: map[s] }));
    res.json(list);
  }
});

// ---------- Scan endpoints ----------
app.post("/api/scan/run", authMiddleware, async (req, res) => {
  try {
    const cfg = await readSafe(CFG_FILE, {});
    const count = cfg.settings?.count || 10;
    const universeArr = await (CMC_KEY ? fetchTopCMC(200) : Promise.resolve([]));
    const universe = (universeArr.length ? universeArr.map(c => c.symbol) : Object.keys(await tryBitgetTickersMap()).slice(0, 200)).slice(0, 120);
    const results = [];
    for (const s of universe) {
      try {
        const r = await analyzeSymbol(s);
        if (r.ok && r.score >= 6) results.push(r);
      } catch (e) { }
      if (results.length >= count) break;
    }
    results.sort((a,b) => b.score - a.score);
    await writeSafe("./data/scan_results.json", results);
    res.json(results);
  } catch (e) {
    console.error("scan/run err", e.message);
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.get("/api/scan/results", authMiddleware, async (_req, res) => {
  const s = await readSafe("./data/scan_results.json", []);
  res.json(s);
});

// ---------- Balance / Trades ----------
app.get("/api/balance", authMiddleware, async (_req, res) => {
  try {
    const b = await tryBitgetBalances();
    if (b.ok) return res.json({ ok: true, demo: BITGET_DEMO, balance: b.data });
    // fallback demo wallet
    const trades = await readSafe(TRADES_FILE, []);
    const used = trades.filter(t => t.status === "OPEN").reduce((a,t)=>a + (t.invested || 0), 0);
    return res.json({ ok: true, demo: true, balance: { USDT: 10000 - used } });
  } catch (e) { res.status(500).json({ error: e.message || String(e) }); }
});

app.get("/api/trades", authMiddleware, async (_req, res) => {
  try {
    const trades = await readSafe(TRADES_FILE, []);
    let priceMap = {};
    try {
      const top = await (CMC_KEY ? fetchTopCMC(200) : Promise.resolve([]));
      if (Array.isArray(top) && top.length) top.forEach(c => priceMap[c.symbol] = c.price);
      if (!Object.keys(priceMap).length) {
        priceMap = await tryBitgetTickersMap();
      }
    } catch (e) {
      priceMap = await tryBitgetTickersMap();
    }

    const out = (trades || []).map(t => {
      if (t.status === "OPEN") {
        const latest = priceMap[t.symbol] || t.entry_price || 0;
        const gross = +(t.qty * latest);
        const fee = +(gross * (FEE_PERCENT / 100));
        const net = +(gross - fee);
        const unreal = net - (t.invested || 0);
        return { ...t, latest_price: latest, est_net: net, unreal_pnl: unreal };
      } else return t;
    });
    res.json(out);
  } catch (e) {
    console.error("trades err", e.message);
    res.json([]);
  }
});

// ---------- Trade actions ----------
app.post("/api/trade/buy", authMiddleware, async (req, res) => {
  try {
    const { symbol, percent } = req.body;
    if (!symbol) return res.status(400).json({ error: "symbol required" });
    const cfg = await readSafe(CFG_FILE, {});
    const pct = Number(percent || cfg.settings?.percent || DEFAULT_PERCENT);

    let usdtBal = 10000;
    const b = await tryBitgetBalances();
    if (b.ok) usdtBal = Number(b.data["USDT"] || 0);

    if (usdtBal <= 0) return res.status(400).json({ error: "Insufficient USDT" });

    const sizeUsd = +(usdtBal * (pct / 100));
    // price from CMC or bitget
    let price = 0;
    try {
      const top = await (CMC_KEY ? fetchTopCMC(200) : Promise.resolve([]));
      const found = (top || []).find(c => c.symbol === symbol);
      if (found) price = found.price;
    } catch (e) {}
    if (!price) {
      const tick = await tryBitgetTickersMap();
      price = tick[symbol] || 0;
    }
    if (!price || price <= 0) return res.status(500).json({ error: "Price unavailable" });

    const qty = +(sizeUsd / price).toFixed(8);
    // place real order if keys present and not demo
    const placed = BITGET_DEMO ? { ok: false, error: "Demo mode" } : await tryPlaceSpot(symbol, "buy", qty);

    const trades = await readSafe(TRADES_FILE, []);
    if (!placed.ok || BITGET_DEMO) {
      const sim = {
        id: "sim_" + Date.now(),
        symbol, qty,
        entry_price: price,
        invested: sizeUsd,
        buy_fee: +(sizeUsd * (FEE_PERCENT / 100)),
        tp_price: +(price * (1 + TP_PERCENT / 100)),
        status: "OPEN",
        created_at: new Date().toISOString(),
        autoSell: cfg.settings?.autosell ?? true,
        demo: true
      };
      trades.push(sim);
      await writeSafe(TRADES_FILE, trades);
      return res.json({ ok: true, trade: sim, simulated: true });
    }

    const trade = {
      id: "t_" + Date.now(),
      symbol, qty,
      entry_price: price,
      invested: sizeUsd,
      buy_fee: +(sizeUsd * (FEE_PERCENT / 100)),
      tp_price: +(price * (1 + TP_PERCENT / 100)),
      status: "OPEN",
      created_at: new Date().toISOString(),
      autoSell: cfg.settings?.autosell ?? true,
      demo: false,
      order_result: placed.data || placed
    };
    trades.push(trade);
    await writeSafe(TRADES_FILE, trades);
    return res.json({ ok: true, trade });
  } catch (e) {
    console.error("trade/buy err", e.message);
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.post("/api/trade/sell", authMiddleware, async (req, res) => {
  try {
    const { trade_id, exit_price } = req.body;
    if (!trade_id) return res.status(400).json({ error: "trade_id required" });

    const trades = await readSafe(TRADES_FILE, []);
    const t = (trades || []).find(x => x.id === trade_id);
    if (!t) return res.status(404).json({ error: "Trade not found" });
    if (t.status !== "OPEN") return res.status(400).json({ error: "Trade not open" });

    let price = exit_price || 0;
    if (!price) {
      try {
        const top = await (CMC_KEY ? fetchTopCMC(200) : Promise.resolve([]));
        const found = (top || []).find(c => c.symbol === t.symbol);
        price = found ? found.price : 0;
      } catch (e) {}
    }
    if (!price) {
      const tick = await tryBitgetTickersMap();
      price = tick[t.symbol] || 0;
    }
    if (!price || price <= 0) return res.status(500).json({ error: "Price unavailable" });

    const gross = +(t.qty * price);
    const sellFee = +(gross * (FEE_PERCENT / 100));
    const net = +(gross - sellFee);
    const pnl = +(net - t.invested);

    // if live, place order
    if (!BITGET_DEMO) {
      await tryPlaceSpot(t.symbol, "sell", t.qty);
    }

    t.status = "CLOSED";
    t.exit_price = price;
    t.sell_fee = sellFee;
    t.gross_proceeds = gross;
    t.net_proceeds = net;
    t.pnl = pnl;
    t.closed_at = new Date().toISOString();

    await writeSafe(TRADES_FILE, trades);
    return res.json({ ok: true, trade: t });
  } catch (e) {
    console.error("trade/sell err", e.message);
    res.status(500).json({ error: e.message || String(e) });
  }
});

// ---------- Mode / settings ----------
app.get("/api/mode", authMiddleware, async (_req, res) => {
  res.json({ demo: BITGET_DEMO });
});
app.post("/api/mode", authMiddleware, async (req, res) => {
  const cfg = await readSafe(CFG_FILE, {});
  cfg.demo = !!req.body.demo;
  await writeSafe(CFG_FILE, cfg);
  res.json({ ok: true, demo: cfg.demo });
});
app.get("/api/settings", authMiddleware, async (_req, res) => {
  const cfg = await readSafe(CFG_FILE, {});
  res.json(cfg.settings || {});
});
app.post("/api/settings", authMiddleware, async (req, res) => {
  const body = req.body || {};
  const cfg = await readSafe(CFG_FILE, {});
  cfg.settings = { ...(cfg.settings || {}), ...body };
  await writeSafe(CFG_FILE, cfg);
  res.json({ ok: true, settings: cfg.settings });
});
app.post("/api/auto", authMiddleware, async (req, res) => {
  const { enabled } = req.body;
  const cfg = await readSafe(CFG_FILE, {});
  cfg.auto = !!enabled;
  await writeSafe(CFG_FILE, cfg);
  res.json({ ok: true, auto: cfg.auto });
});
app.get("/api/auto", authMiddleware, async (_req, res) => {
  const cfg = await readSafe(CFG_FILE, {});
  res.json({ auto: !!cfg.auto });
});

// ---------- Workers ----------
let autoBusy = false;
async function autoWorker() {
  try {
    if (autoBusy) return;
    autoBusy = true;
    const cfg = await readSafe(CFG_FILE, {});
    if (!cfg.auto) return;
    const settings = cfg.settings || {};
    const trades = await readSafe(TRADES_FILE, []);
    const openCount = (trades || []).filter(t => t.status === "OPEN").length;
    if (openCount >= (settings.count || MAX_CONCURRENT)) return;

    // scan cached scan_results
    const scanResults = await readSafe("./data/scan_results.json", []);
    for (const p of scanResults) {
      const freshTrades = await readSafe(TRADES_FILE, []);
      const openNow = (freshTrades || []).filter(t => t.status === "OPEN").length;
      if (openNow >= (settings.count || MAX_CONCURRENT)) break;
      if ((freshTrades || []).some(t => t.symbol === p.symbol && t.status === "OPEN")) continue;
      try {
        await axios.post(`http://localhost:${PORT}/api/trade/buy`, { symbol: p.symbol, percent: settings.percent || DEFAULT_PERCENT }, { timeout: 120000 });
      } catch (e) { }
    }
  } catch (e) {
    console.error("autoWorker err", e.message || e);
  } finally { autoBusy = false; }
}
setInterval(autoWorker, 30 * 1000);

// monitor for TP auto-sell
async function monitorLoop() {
  try {
    const trades = await readSafe(TRADES_FILE, []);
    if (!trades || !trades.length) return;
    let priceMap = {};
    try {
      const top = await (CMC_KEY ? fetchTopCMC(200) : Promise.resolve([]));
      (top || []).forEach(c => priceMap[c.symbol] = c.price);
      if (!Object.keys(priceMap).length) priceMap = await tryBitgetTickersMap();
    } catch (e) { priceMap = await tryBitgetTickersMap(); }
    for (const t of trades.filter(x => x.status === "OPEN")) {
      const latest = priceMap[t.symbol] || 0;
      const tp = t.tp_price || (t.entry_price * (1 + TP_PERCENT / 100));
      if (latest && latest >= tp && (t.autoSell !== false)) {
        try {
          await axios.post(`http://localhost:${PORT}/api/trade/sell`, { trade_id: t.id, exit_price: latest }, { timeout: 120000 });
        } catch (e) { console.error("auto-sell failed", e.message || e); }
      }
    }
  } catch (e) { }
}
setInterval(monitorLoop, 5 * 1000);

// ---------- Start ----------
app.listen(PORT, () => console.log(`✅ DexScan backend running on ${PORT}`));
