// server.js (BITGET-enabled final backend)
import express from "express";
import axios from "axios";
import cors from "cors";
import fs from "fs-extra";
import { EMA, RSI, MACD, ATR } from "technicalindicators";
import { placeSpotOrder, getSpotBalancesSimple, fetchSymbolTicker } from "./bitget.js";

const app = express();
app.use(cors());
app.use(express.json());

// Data dir
await fs.ensureDir("./data");
const SCANS_FILE = "./data/scan_results.json";
const TRADES_FILE = "./data/trades.json";
const LOG_FILE = "./data/logs.txt";

async function readJsonSafe(f, d=[]) { try { return await fs.readJson(f); } catch(e){ return d; } }
async function writeJsonSafe(f, v){ await fs.writeJson(f, v, { spaces: 2 }); }
async function appendLog(line){ try { await fs.appendFile(LOG_FILE, new Date().toISOString() + " " + line + "\n"); } catch(e){} }

// Env config
const AUTO_TRADING_ENABLED = (process.env.AUTO_TRADING_ENABLED === "1" || process.env.AUTO_TRADING_ENABLED === "true") ? true : false;
const PERCENT_PER_TRADE = Number(process.env.PERCENT_PER_TRADE || 2);
const TP_PERCENT = Number(process.env.TP_PERCENT || 10);
const BITGET_DEMO = (process.env.BITGET_DEMO === "1");

// In-memory cache
const latestPrices = {}; // symbol -> price

// ---- Utilities ----

// CoinGecko markets (top N)
async function fetchTopCoinGecko(limit = 200) {
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${limit}&page=1&sparkline=false`;
  const r = await axios.get(url, { timeout: 20000 });
  return r.data; // array of coins with fields: id, symbol, name, market_cap, total_volume
}

// Binance public klines for indicators (fast & reliable). If you want to remove Binance dependency later, we can switch to Bitget market data.
async function fetchKlines(symbol, interval="1h", limit=200) {
  // symbol expected like BTCUSDT
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const r = await axios.get(url, { timeout: 20000 });
  return r.data;
}

// CoinGecko trending endpoint (optional bonus score)
async function fetchCoinGeckoTrending() {
  try {
    const url = "https://api.coingecko.com/api/v3/search/trending";
    const r = await axios.get(url, { timeout: 10000 });
    return r.data;
  } catch (e) { return null; }
}

// Last element helper
function last(arr){ return arr[arr.length - 1]; }

// Indicator analysis
async function analyzeSymbol(symbol) {
  // symbol like BTCUSDT
  try {
    const k1h = await fetchKlines(symbol, "1h", 200);
    const k4h = await fetchKlines(symbol, "4h", 100);

    const closes1h = k1h.map(k => parseFloat(k[4]));
    const highs1h = k1h.map(k => parseFloat(k[2]));
    const lows1h = k1h.map(k => parseFloat(k[3]));
    const vols1h = k1h.map(k => parseFloat(k[5]));
    const closes4h = k4h.map(k => parseFloat(k[4]));

    if (closes1h.length < 50 || closes4h.length < 20) throw new Error("not enough candlesticks");

    const ema8_1h = last(EMA.calculate({ period:8, values: closes1h }));
    const ema21_1h = last(EMA.calculate({ period:21, values: closes1h }));
    const rsi1h = last(RSI.calculate({ period:14, values: closes1h }));
    const macd1h = last(MACD.calculate({ values: closes1h, fastPeriod:12, slowPeriod:26, signalPeriod:9 }));
    const atr1h = last(ATR.calculate({ period:14, high: highs1h, low: lows1h, close: closes1h }));

    const ema8_4h = last(EMA.calculate({ period:8, values: closes4h }));
    const ema21_4h = last(EMA.calculate({ period:21, values: closes4h }));
    const macd4h = last(MACD.calculate({ values: closes4h, fastPeriod:12, slowPeriod:26, signalPeriod:9 }));

    // scoring rules (adjustable)
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

    return {
      ok: true,
      symbol, score, entry, tp, sl,
      indicators: { ema8_1h, ema21_1h, rsi1h, macd1h: macd1h?macd1h.histogram:null, atr1h, ema8_4h, ema21_4h, macd4h: macd4h?macd4h.histogram:null }
    };
  } catch (e) {
    return { ok: false, error: String(e), symbol };
  }
}

// ---- ROUTES ----
app.get("/", (_req, res) => res.send("DexScan (Bitget) backend ✅"));

app.get("/api/top10", async (_req, res) => {
  try {
    // Use CoinGecko top coins; then map to price using Bitget ticker fallback or Binace lastPrice
    const ck = await fetchTopCoinGecko(50);
    const top = ck.slice(0, 10).map(c => ({
      id: c.id,
      symbol: (c.symbol || "").toUpperCase() + "USDT",
      name: c.name,
      price: c.current_price,
      change24h: c.price_change_percentage_24h
    }));
    res.json(top);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// scan/run - heavy operation
app.post("/api/scan/run", async (_req, res) => {
  try {
    await appendLog("Scan run started");
    // Create universe from CoinGecko top 200 -> map to SYMBOLUSDT
    const coins = await fetchTopCoinGecko(200);
    const universe = coins.map(c => ((c.symbol||"").toUpperCase() + "USDT")).filter(s=>s);

    const results = [];
    for (const s of universe) {
      // check min volume filter using CoinGecko data
      try {
        const r = await analyzeSymbol(s);
        if (r.ok && r.score >= 7) {
          results.push(r);
          await appendLog(`Signal: ${s} score ${r.score}`);
        }
      } catch(e){}
    }
    results.sort((a,b)=>b.score - a.score);
    const topN = results.slice(0, 30);
    await writeJsonSafe(SCANS_FILE, topN);
    await appendLog(`Scan run finished. ${topN.length} signals`);
    res.json(topN);
  } catch (err) {
    await appendLog("scan error: " + err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/scan/results", async (_req, res) => {
  const scans = await readJsonSafe(SCANS_FILE, []);
  res.json(scans);
});

// Get balance (calls Bitget)
app.get("/api/bitget/balance", async (_req, res) => {
  try {
    const bal = await getSpotBalancesSimple();
    if (!bal.ok) return res.status(500).json(bal);
    res.json(bal.data);
  } catch (e) { res.status(500).json({ error: e.message || String(e) }); }
});

// Manual place order (from frontend) -> uses PERCENT_PER_TRADE or size param
app.post("/api/bitget/order", async (req, res) => {
  try {
    const { symbol, side, percent } = req.body;
    if (!symbol || !side) return res.status(400).json({ error: "symbol and side required" });

    // get balances
    const balResp = await getSpotBalancesSimple();
    if (!balResp.ok) return res.status(500).json(balResp);
    const balances = balResp.data || {};
    const usdtBal = Number(balances["USDT"] || balances["usdt"] || 0);
    if (!usdtBal || usdtBal <= 0) return res.status(400).json({ error: "Insufficient USDT balance" });

    const pct = Number(percent || PERCENT_PER_TRADE);
    const sizeUsd = +(usdtBal * (pct / 100));
    // fetch current price (try bitget ticker)
    const t = await fetchSymbolTicker(symbol);
    let price;
    if (t.ok && t.data) {
      // some responses have data.ticker.last etc - be defensive
      const p = t.data?.data?.last || t.data?.data?.ticker?.last || t.data?.last || t.data?.price || null;
      price = p ? Number(p) : null;
    }
    // fallback: use CoinGecko approximate price by symbol
    if (!price) {
      // extract id from symbol crude: BTCUSDT -> bitcoin
      price = 0;
    }

    // compute base asset qty = sizeUsd / price
    if (!price || price <= 0) return res.status(500).json({ error: "price unavailable for symbol " + symbol });

    const qty = +(sizeUsd / price).toFixed(8);

    // place market buy/sell via Bitget
    const orderResp = await placeSpotOrder(symbol, side.toLowerCase(), qty, "market", null);
    if (!orderResp.ok) return res.status(500).json({ error: orderResp.error });
    // store trade record (basic)
    const trades = await readJsonSafe(TRADES_FILE, []);
    const trade = {
      id: "live_" + Date.now(),
      symbol, side, qty, price, placed_at: new Date().toISOString(), live: !BITGET_DEMO, orderResult: orderResp.data
    };
    trades.push(trade);
    await writeJsonSafe(TRADES_FILE, trades);
    await appendLog(`Order placed: ${symbol} ${side} qty ${qty} price ${price} demo=${BITGET_DEMO}`);
    // create TP sell order at +TP_PERCENT (optional: implement OCO later)
    const tpPrice = +(price * (1 + TP_PERCENT/100)).toFixed(8);
    // We leave TP creation to a different endpoint because Bitget v1/v2 endpoints vary - frontend can call /api/bitget/place-tp later.
    res.json({ ok: true, trade, tpPrice });
  } catch (e) {
    await appendLog("order error: " + (e.message || String(e)));
    res.status(500).json({ error: e.message || String(e) });
  }
});

// list trades
app.get("/api/trades", async (_req, res) => {
  const t = await readJsonSafe(TRADES_FILE, []);
  res.json(t);
});

// toggle auto-trading (this just updates env-like behavior via file — safer than env)
app.post("/api/auto/set", async (req, res) => {
  try {
    const { enabled } = req.body;
    // Note: real env var change requires Render UI; here we persist in file for runtime toggle
    const cfg = await readJsonSafe("./data/runtime_cfg.json", {});
    cfg.auto = !!enabled;
    await writeJsonSafe("./data/runtime_cfg.json", cfg);
    res.json({ ok: true, auto: cfg.auto });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// get runtime cfg
app.get("/api/auto/status", async (_req, res) => {
  const cfg = await readJsonSafe("./data/runtime_cfg.json", { auto: false });
  res.json(cfg);
});

// Worker: periodic scan + auto-trade if enabled (lightweight)
let workerRunning = false;
async function workerLoop() {
  try {
    if (workerRunning) return;
    workerRunning = true;
    const cfg = await readJsonSafe("./data/runtime_cfg.json", { auto: false });
    if (cfg.auto) {
      // run a quick scan (top 50) and auto-place trades
      const coins = await fetchTopCoinGecko(50);
      const universe = coins.map(c => ((c.symbol||"").toUpperCase() + "USDT")).slice(0, 50);
      for (const s of universe) {
        try {
          const r = await analyzeSymbol(s);
          if (r.ok && r.score >= 7) {
            // place trade if allowed
            if (!BITGET_DEMO) {
              // caution: live orders
            }
            // call placeSpotOrder via helper if you want instant auto-execution (we keep manual for safety)
            await appendLog(`Auto-signal: ${s} score ${r.score}`);
          }
        } catch (e) {}
      }
    }
  } catch(e){
    await appendLog("worker error: " + e.message);
  } finally { workerRunning = false; }
}
setInterval(workerLoop, 60 * 1000); // every minute (safe default)

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`DexScan backend (Bitget) running on ${PORT}`));
