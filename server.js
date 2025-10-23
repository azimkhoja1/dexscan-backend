// server.js (final Bitget-enabled backend with caching & retry)
import express from "express";
import axios from "axios";
import cors from "cors";
import fs from "fs-extra";
import { EMA, RSI, MACD, ATR } from "technicalindicators";
import { getSpotBalancesSimple, placeSpotOrder, fetchSymbolTicker } from "./bitget.js";

const app = express();
app.use(cors());
app.use(express.json());

// ensure data dir
await fs.ensureDir("./data");
const SCANS_FILE = "./data/scan_results.json";
const TRADES_FILE = "./data/trades.json";
const LOG_FILE = "./data/logs.txt";

async function readJsonSafe(f,d=[]) { try { return await fs.readJson(f); } catch(e) { return d; } }
async function writeJsonSafe(f,v){ await fs.writeJson(f, v, { spaces: 2 }); }
async function appendLog(line){ try { await fs.appendFile(LOG_FILE, new Date().toISOString() + " " + line + "\n"); } catch(e) {} }

// ENV
const PERCENT_PER_TRADE = Number(process.env.PERCENT_PER_TRADE || 2);
const TP_PERCENT = Number(process.env.TP_PERCENT || 10);
const BITGET_DEMO = (process.env.BITGET_DEMO === "1");

// in-memory cache for coin gecko
let _cg_top_cache = { ts: 0, data: null };
const CG_TOP_TTL_MS = 30 * 1000;
const CG_TOP_REFRESH_INTERVAL = 20 * 1000;

// fetchWithRetry (handles 429 backoff)
async function fetchWithRetry(url, opts = {}, maxRetries = 4, baseDelay = 600) {
  let attempt = 0;
  while (true) {
    try {
      const res = await axios.get(url, { ...opts, timeout: 20000 });
      if (res.status === 429) throw { is429:true, response: res };
      return res;
    } catch (err) {
      attempt++;
      const is429 = (err.response && err.response.status === 429) || err.is429;
      const isNetwork = !err.response;
      if (attempt > maxRetries || (!is429 && !isNetwork)) throw err;
      const delay = Math.floor(baseDelay * Math.pow(2, attempt - 1) + Math.random() * baseDelay);
      console.warn(`fetchWithRetry retry ${attempt} ${url} waiting ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// fetch and cache top coins from CoinGecko
async function fetchTopCoinGecko(limit = 200) {
  const now = Date.now();
  if (_cg_top_cache.data && (now - _cg_top_cache.ts) < CG_TOP_TTL_MS) return _cg_top_cache.data;
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${limit}&page=1&sparkline=false`;
  const res = await fetchWithRetry(url, {}, 4, 600);
  _cg_top_cache = { ts: Date.now(), data: res.data };
  return res.data;
}
async function startCoinGeckoBackgroundRefresh(){
  try { await fetchTopCoinGecko(200).catch(()=>{}); } catch(e){}
  setInterval(async ()=>{ try{ await fetchTopCoinGecko(200);}catch(e){console.warn("CG refresh err", e.message);} }, CG_TOP_REFRESH_INTERVAL);
}
startCoinGeckoBackgroundRefresh();

// helper last
function last(arr){ return arr[arr.length-1]; }

// fetch klines from Binance mirror (used for indicators)
async function fetchKlines(symbol, interval="1h", limit=200) {
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const r = await fetchWithRetry(url, {}, 3, 500);
  return r.data;
}

// analyze single symbol
async function analyzeSymbol(symbol) {
  try {
    const k1h = await fetchKlines(symbol, "1h", 200);
    const k4h = await fetchKlines(symbol, "4h", 100);
    const closes1h = k1h.map(k => parseFloat(k[4]));
    const highs1h = k1h.map(k => parseFloat(k[2]));
    const lows1h = k1h.map(k => parseFloat(k[3]));
    const vols1h = k1h.map(k => parseFloat(k[5]));
    const closes4h = k4h.map(k => parseFloat(k[4]));
    if (closes1h.length < 50 || closes4h.length < 20) throw new Error("not enough candles");

    const ema8_1h = last(EMA.calculate({ period:8, values: closes1h }));
    const ema21_1h = last(EMA.calculate({ period:21, values: closes1h }));
    const rsi1h = last(RSI.calculate({ period:14, values: closes1h }));
    const macd1h = last(MACD.calculate({ values: closes1h, fastPeriod:12, slowPeriod:26, signalPeriod:9 }));
    const atr1h = last(ATR.calculate({ period:14, high: highs1h, low: lows1h, close: closes1h }));
    const ema8_4h = last(EMA.calculate({ period:8, values: closes4h }));
    const ema21_4h = last(EMA.calculate({ period:21, values: closes4h }));
    const macd4h = last(MACD.calculate({ values: closes4h, fastPeriod:12, slowPeriod:26, signalPeriod:9 }));

    let score = 0;
    if (ema8_1h > ema21_1h) score += 2;
    if (macd1h && macd1h.histogram > 0) score += 2;
    if (rsi1h > 45 && rsi1h < 65) score += 1;
    const volAvg = vols1h.slice(-20).reduce((a,b)=>a+b,0)/20;
    if (vols1h[vols1h.length-1] > 1.5 * volAvg) score += 1;
    if (ema8_4h > ema21_4h) score += 3;
    if (macd4h && macd4h.histogram > 0) score += 2;

    const entry = closes1h.at(-1);
    const tp = +(entry * (1 + TP_PERCENT/100)).toFixed(8);
    const sl = Math.max(0.00000001, entry - (atr1h * 1.5));

    return { ok:true, symbol, score, entry, tp, sl, indicators: { ema8_1h, ema21_1h, rsi1h, macd1h: macd1h?macd1h.histogram:null, atr1h, ema8_4h, ema21_4h, macd4h: macd4h?macd4h.histogram:null } };
  } catch (e) { return { ok:false, symbol, error: String(e) }; }
}

// Routes
app.get("/", (_req,res) => res.send("DexScan (Bitget) backend ✅"));

app.get("/api/top10", async (_req,res) => {
  try {
    const coins = await fetchTopCoinGecko(50);
    const top = (coins || []).slice(0,10).map(c => ({ id:c.id, symbol: (c.symbol||"").toUpperCase()+"USDT", name:c.name, price:c.current_price, change24h:c.price_change_percentage_24h }));
    res.json(top);
  } catch (err) {
    console.error("top10 error:", err.response?.status || err.message || String(err));
    if (err.response && err.response.status === 429) res.status(429).json({ error: "Rate limited by upstream API (429)." });
    else res.status(500).json({ error: String(err.message || err) });
  }
});

app.post("/api/scan/run", async (_req,res) => {
  try {
    await appendLog("Scan run started");
    const coins = await fetchTopCoinGecko(200);
    const universe = coins.map(c => (c.symbol||"").toUpperCase()+"USDT").filter(s=>s);
    const results = [];
    for (const s of universe) {
      try {
        const r = await analyzeSymbol(s);
        if (r.ok && r.score >= 7) { results.push(r); await appendLog(`Signal: ${s} score ${r.score}`); }
      } catch (e) {}
    }
    results.sort((a,b)=>b.score - a.score);
    const topN = results.slice(0, 30);
    await writeJsonSafe(SCANS_FILE, topN);
    await appendLog(`Scan finished: ${topN.length}`);
    res.json(topN);
  } catch (e) { await appendLog("scan error: "+ (e.message||e)); res.status(500).json({ error: String(e.message||e) }); }
});

app.get("/api/scan/results", async (_req,res) => { const scans = await readJsonSafe(SCANS_FILE, []); res.json(scans); });

app.get("/api/bitget/balance", async (_req,res) => {
  try {
    const bal = await getSpotBalancesSimple();
    if (!bal.ok) return res.status(500).json(bal);
    res.json(bal.data);
  } catch (e) { res.status(500).json({ error: e.message || String(e) }); }
});

app.post("/api/bitget/order", async (req,res) => {
  try {
    const { symbol, side, percent } = req.body;
    if (!symbol || !side) return res.status(400).json({ error: "symbol and side required" });
    const balResp = await getSpotBalancesSimple();
    if (!balResp.ok) return res.status(500).json(balResp);
    const balances = balResp.data || {};
    const usdtBal = Number(balances["USDT"] || balances["usdt"] || 0);
    if (!usdtBal || usdtBal <= 0) return res.status(400).json({ error: "Insufficient USDT" });
    const pct = Number(percent || PERCENT_PER_TRADE);
    const sizeUsd = +(usdtBal * (pct/100));
    // get price: try Bitget ticker then fallback to coin gecko cached price
    let price = null;
    const t = await fetchSymbolTicker(symbol);
    if (t.ok && t.data) {
      price = Number(t.data?.data?.last || t.data?.last || t.data?.price || 0);
    }
    if (!price) {
      // fallback to CoinGecko cached top
      const cg = await fetchTopCoinGecko(200);
      const id = (cg.find(c => ((c.symbol||"").toUpperCase()+"USDT") === symbol) || {}).id;
      price = id ? Number((cg.find(x=>x.id===id)||{}).current_price || 0) : 0;
    }
    if (!price || price <= 0) return res.status(500).json({ error: "price unavailable for "+symbol });
    const qty = +(sizeUsd / price).toFixed(8);
    const orderResp = await placeSpotOrder(symbol, side.toLowerCase(), qty, "market", null);
    if (!orderResp.ok) return res.status(500).json({ error: orderResp.error });
    const trades = await readJsonSafe(TRADES_FILE, []);
    const trade = { id: "live_"+Date.now(), symbol, side, qty, price, placed_at: new Date().toISOString(), demo: BITGET_DEMO, orderResult: orderResp.data };
    trades.push(trade);
    await writeJsonSafe(TRADES_FILE, trades);
    await appendLog(`Order placed: ${symbol} ${side} qty ${qty} demo=${BITGET_DEMO}`);
    const tpPrice = +(price * (1 + TP_PERCENT/100)).toFixed(8);
    res.json({ ok:true, trade, tpPrice });
  } catch (e) { await appendLog("order error: "+(e.message||e)); res.status(500).json({ error: e.message || String(e) }); }
});

app.get("/api/trades", async (_req,res) => { const t = await readJsonSafe(TRADES_FILE, []); res.json(t); });

app.post("/api/auto/set", async (req,res) => {
  try {
    const { enabled } = req.body;
    const cfg = await readJsonSafe("./data/runtime_cfg.json", {});
    cfg.auto = !!enabled;
    await writeJsonSafe("./data/runtime_cfg.json", cfg);
    res.json({ ok:true, auto: cfg.auto });
  } catch (e) { res.status(500).json({ error: e.message || String(e) }); }
});
app.get("/api/auto/status", async (_req,res) => { const cfg = await readJsonSafe("./data/runtime_cfg.json", { auto:false }); res.json(cfg); });

// worker (light) - logs signals when auto is enabled (does not auto-place by default)
let workerRunning = false;
async function workerLoop() {
  try {
    if (workerRunning) return;
    workerRunning = true;
    const cfg = await readJsonSafe("./data/runtime_cfg.json", { auto:false });
    if (cfg.auto) {
      const coins = await fetchTopCoinGecko(50);
      const universe = coins.map(c => ((c.symbol||"").toUpperCase()+"USDT")).slice(0,50);
      for (const s of universe) {
        try {
          const r = await analyzeSymbol(s);
          if (r.ok && r.score >= 7) {
            await appendLog(`Auto-signal: ${s} score ${r.score}`);
            // Optional: placeSpotOrder(...) here to auto-execute (not enabled by default)
          }
        } catch(e){}
      }
    }
  } catch(e){ await appendLog("worker error: "+(e.message||e)); }
  finally { workerRunning = false; }
}
setInterval(workerLoop, 60 * 1000);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`DexScan backend (Bitget) running on ${PORT}`));
