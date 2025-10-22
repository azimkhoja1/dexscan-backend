// server.js
import express from "express";
import axios from "axios";
import cors from "cors";
import fs from "fs-extra";
import { EMA, RSI, MACD, ATR } from "technicalindicators";
import { WebSocket } from "ws";

const app = express();
app.use(cors());
app.use(express.json());

/*
  Simple persistent storage (JSON files) for demo/paper:
  - data/fake_wallet.json
  - data/scan_results.json
  - data/sim_trades.json
*/
await fs.ensureDir("./data");
const WALLET_FILE = "./data/fake_wallet.json";
const SCANS_FILE = "./data/scan_results.json";
const TRADES_FILE = "./data/sim_trades.json";

async function readJson(file, defaultVal) {
  try { return await fs.readJson(file); } catch(e){ return defaultVal; }
}
async function writeJson(file, val) { await fs.writeJson(file, val, { spaces: 2 }); }

// initialize if missing
if (!(await fs.pathExists(WALLET_FILE))) {
  await writeJson(WALLET_FILE, { USDT: 2000.00, positions: [] }); // starting fake balance
}
if (!(await fs.pathExists(SCANS_FILE))) await writeJson(SCANS_FILE, []);
if (!(await fs.pathExists(TRADES_FILE))) await writeJson(TRADES_FILE, []);

// In-memory cache for latest tick prices (updated from WebSocket where possible)
const latestPrices = {}; // symbol -> price as number

// Utility: fetch 24hr ticker list from Binance mirror
async function fetch24hTickers() {
  const url = "https://data-api.binance.vision/api/v3/ticker/24hr";
  const r = await axios.get(url);
  return r.data;
}

// Utility: fetch klines from public mirror
async function fetchKlines(symbol, interval, limit = 200) {
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const r = await axios.get(url);
  return r.data; // array of arrays
}

// Indicator helpers using technicalindicators
function last(values) { return values[values.length-1]; }

// ANALYZE single symbol (1h + 4h) -> returns score and suggested entry/TP/SL
async function analyzeSymbol(symbol) {
  // fetch 1h & 4h klines
  const k1h = await fetchKlines(symbol, "1h", 200);
  const k4h = await fetchKlines(symbol, "4h", 100);

  const closes1h = k1h.map(k => parseFloat(k[4]));
  const highs1h = k1h.map(k => parseFloat(k[2]));
  const lows1h = k1h.map(k => parseFloat(k[3]));
  const vols1h = k1h.map(k => parseFloat(k[5]));

  const closes4h = k4h.map(k => parseFloat(k[4]));
  const highs4h = k4h.map(k => parseFloat(k[2]));
  const lows4h = k4h.map(k => parseFloat(k[3]));

  // require enough candles
  if (closes1h.length < 50 || closes4h.length < 20) {
    throw new Error("Not enough data");
  }

  // compute indicators
  const ema8_1h = last(EMA.calculate({ period: 8, values: closes1h }));
  const ema21_1h = last(EMA.calculate({ period: 21, values: closes1h }));
  const rsi1h = last(RSI.calculate({ period: 14, values: closes1h }));
  const macd1h = last(MACD.calculate({ values: closes1h, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }));
  const atr1h = last(ATR.calculate({ period: 14, high: highs1h, low: lows1h, close: closes1h }));

  const ema8_4h = last(EMA.calculate({ period: 8, values: closes4h }));
  const ema21_4h = last(EMA.calculate({ period: 21, values: closes4h }));
  const macd4h = last(MACD.calculate({ values: closes4h, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }));

  // scoring
  let score = 0;
  if (ema8_1h > ema21_1h) score += 2;
  if (macd1h && macd1h.histogram > 0) score += 2;
  if (rsi1h > 45 && rsi1h < 65) score += 1;
  const volAvg = vols1h.slice(-20).reduce((a,b)=>a+b,0)/20;
  if (vols1h[vols1h.length-1] > 1.5 * volAvg) score += 2;
  if (ema8_4h > ema21_4h) score += 3;
  if (macd4h && macd4h.histogram > 0) score += 2;

  // compute entry/TP/SL
  const entry = closes1h[closes1h.length - 1];
  const sl = Math.max(0.00000001, entry - atr1h * 1.5);
  const tp = +(entry * 1.15).toFixed(8); // 15% default target

  return {
    symbol, score,
    entry, tp, sl,
    indicators: {
      ema8_1h, ema21_1h, rsi1h, macd1h: macd1h?macd1h.histogram:null, atr1h,
      ema8_4h, ema21_4h, macd4h: macd4h?macd4h.histogram:null
    }
  };
}

// Endpoint: health
app.get("/", (req, res) => res.send("DexScan backend (scanner + simulate) ✅"));

// Endpoint: top10 by volume snapshot
app.get("/api/top10", async (req, res) => {
  try {
    const all = await fetch24hTickers();
    const usdt = all.filter(x => x.symbol.endsWith("USDT") && !x.symbol.includes("BUSD"));
    usdt.sort((a,b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));
    const top = usdt.slice(0, 10).map(x => ({
      symbol: x.symbol,
      price: latestPrices[x.symbol] ?? x.lastPrice,
      change24h: x.priceChangePercent
    }));
    res.json(top);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SCAN endpoints
app.post("/api/scan/run", async (req, res) => {
  try {
    // default universe: top 200 USDT pairs
    const all = await fetch24hTickers();
    const usdt = all.filter(x => x.symbol.endsWith("USDT") && !x.symbol.includes("BUSD"));
    usdt.sort((a,b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));
    const universe = usdt.slice(0, 200).map(x => x.symbol);

    const results = [];
    for (const s of universe) {
      try {
        const r = await analyzeSymbol(s);
        if (r.score >= 7) results.push(r);
      } catch (e) {
        // skip
      }
    }
    // sort by score desc
    results.sort((a,b) => b.score - a.score);
    const topN = results.slice(0, 15);
    await writeJson(SCANS_FILE, topN);
    res.json(topN);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/scan/results", async (req, res) => {
  const scans = await readJson(SCANS_FILE, []);
  res.json(scans);
});

// Fake wallet + trades
app.get("/api/wallet/fake", async (req, res) => {
  const w = await readJson(WALLET_FILE, { USDT: 0, positions: [] });
  const trades = await readJson(TRADES_FILE, []);
  res.json({ wallet: w, trades });
});

// Simulate Buy
app.post("/api/trade/simulate", async (req, res) => {
  try {
    const { user_id, symbol, side, size_usd, entry_price } = req.body;
    if (!symbol || !size_usd || !entry_price) return res.status(400).json({ error: "symbol,size_usd,entry_price required" });

    const wallet = await readJson(WALLET_FILE, { USDT: 0, positions: [] });
    if (wallet.USDT < size_usd) return res.status(400).json({ error: "Insufficient USDT in fake wallet" });

    // compute qty
    const qty = +(size_usd / entry_price).toFixed(8);

    // deduct USDT and create trade
    wallet.USDT = +(wallet.USDT - size_usd).toFixed(8);
    const trade = {
      id: "sim_" + Date.now(),
      user_id: user_id || 1,
      symbol,
      side: side || "BUY",
      entry_price,
      qty,
      tp: +(entry_price * 1.15).toFixed(8),
      sl: +(entry_price - 1.5).toFixed(8), // fallback if no ATR, will be overridden by request ideally
      status: "OPEN",
      created_at: new Date().toISOString()
    };
    // push to trades and wallet positions
    const trades = await readJson(TRADES_FILE, []);
    trades.push(trade);
    wallet.positions = wallet.positions || [];
    wallet.positions.push({ trade_id: trade.id, symbol, qty, entry_price: trade.entry_price });

    await writeJson(TRADES_FILE, trades);
    await writeJson(WALLET_FILE, wallet);
    res.json({ ok: true, trade });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Simulate Sell (manual)
app.post("/api/trade/sell/simulate", async (req, res) => {
  try {
    const { trade_id, exit_price } = req.body;
    if (!trade_id || !exit_price) return res.status(400).json({ error: "trade_id and exit_price required" });

    const trades = await readJson(TRADES_FILE, []);
    const trade = trades.find(t => t.id === trade_id);
    if (!trade) return res.status(404).json({ error: "Trade not found" });
    if (trade.status !== "OPEN") return res.status(400).json({ error: "Trade not open" });

    // compute pnl
    const pnl = (exit_price - trade.entry_price) * trade.qty;
    const wallet = await readJson(WALLET_FILE, { USDT: 0, positions: [] });
    wallet.USDT = +(wallet.USDT + pnl + (trade.entry_price * trade.qty)).toFixed(8); // return principal + pnl
    // remove position
    wallet.positions = (wallet.positions || []).filter(p => p.trade_id !== trade.id);

    trade.status = "CLOSED";
    trade.exit_price = exit_price;
    trade.closed_at = new Date().toISOString();
    trade.pnl = pnl;

    await writeJson(TRADES_FILE, trades);
    await writeJson(WALLET_FILE, wallet);
    res.json({ ok: true, trade });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Auto-simulate buy for top results (percent of wallet)
app.post("/api/trade/auto-sim", async (req, res) => {
  try {
    const { symbol, percent } = req.body; // percent of wallet to use, e.g., 2
    const wallet = await readJson(WALLET_FILE, { USDT: 0, positions: [] });
    const pct = percent || 2;
    const size_usd = +(wallet.USDT * (pct/100)).toFixed(8);
    // determine entry price via latestPrices cache or klines
    const price = latestPrices[symbol] || (await fetchKlines(symbol,"1h",2))[0][4];
    if (!price) return res.status(500).json({ error: "Price unavailable" });
    // call simulate endpoint internal
    const body = { user_id:1, symbol, side:"BUY", size_usd, entry_price: +price };
    // reuse logic
    const resp = await axios.post(`http://localhost:${process.env.PORT||10000}/api/trade/simulate`, body).catch(e => ({ data: { error: e.message }}));
    res.json(resp.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Worker: monitor latestPrices and close trades when TP/SL hit
async function monitorTradesLoop() {
  try {
    const trades = await readJson(TRADES_FILE, []);
    const wallet = await readJson(WALLET_FILE, { USDT: 0, positions: [] });
    let changed = false;

    for (const t of trades.filter(x => x.status === "OPEN")) {
      const symbol = t.symbol;
      const price = latestPrices[symbol];
      if (!price) continue;
      // TP hit
      if (price >= t.tp) {
        const pnl = (t.tp - t.entry_price) * t.qty;
        wallet.USDT = +(wallet.USDT + pnl + (t.entry_price * t.qty)).toFixed(8);
        wallet.positions = (wallet.positions || []).filter(p => p.trade_id !== t.id);
        t.status = "CLOSED"; t.exit_price = t.tp; t.closed_at = new Date().toISOString(); t.pnl = pnl;
        changed = true;
      } else if (price <= t.sl) {
        const pnl = (t.sl - t.entry_price) * t.qty;
        wallet.USDT = +(wallet.USDT + pnl + (t.entry_price * t.qty)).toFixed(8);
        wallet.positions = (wallet.positions || []).filter(p => p.trade_id !== t.id);
        t.status = "CLOSED"; t.exit_price = t.sl; t.closed_at = new Date().toISOString(); t.pnl = pnl;
        changed = true;
      }
    }
    if (changed) { await writeJson(TRADES_FILE, trades); await writeJson(WALLET_FILE, wallet); }
  } catch (e) {
    console.error("monitor error", e.message);
  }
}

// run monitor every 5 seconds
setInterval(monitorTradesLoop, 5000);

// --- Live price subscriptions: maintain latestPrices cache for many top symbols ---
// We'll get top10 every 60s and subscribe their trade streams (or keep fetching if ws blocked)
let subscribedSymbols = new Set();

// helper: subscribe to a single symbol via ws trade stream
function subscribeSymbolWS(symbol) {
  try {
    const pair = symbol.toLowerCase();
    const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${pair}@trade`);
    ws.on("message", (msg) => {
      try {
        const d = JSON.parse(msg);
        latestPrices[symbol] = parseFloat(d.p);
      } catch (e) {}
    });
    ws.on("open", () => console.log("WS open for", symbol));
    ws.on("error", (e) => console.warn("WS error for", symbol, e.message));
    // keep reference? for simplicity we don't close and keep multiple connections.
  } catch (e) {
    console.warn("subscribe failed", e.message);
  }
}

// Periodically refresh top symbols and ensure subscriptions
async function refreshTopSubscriptions() {
  try {
    const all = await fetch24hTickers();
    const usdt = all.filter(x => x.symbol.endsWith("USDT") && !x.symbol.includes("BUSD"));
    usdt.sort((a,b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));
    const top = usdt.slice(0, 15).map(x => x.symbol); // top 15
    for (const s of top) {
      if (!subscribedSymbols.has(s)) {
        subscribedSymbols.add(s);
        subscribeSymbolWS(s);
      }
    }
  } catch (e) {
    console.error("refresh subs error", e.message);
  }
}
refreshTopSubscriptions();
setInterval(refreshTopSubscriptions, 60 * 1000);

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`DexScan backend (scanner) running on ${PORT}`));
