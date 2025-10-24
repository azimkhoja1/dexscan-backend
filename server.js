// server.js — DexScan stable backend (replace entire file)
import express from "express";
import axios from "axios";
import cors from "cors";
import fs from "fs-extra";
import { EMA, RSI, MACD, ATR } from "technicalindicators";
import { getSpotBalancesSimple, placeSpotOrder, fetchSymbolTicker } from "./bitget.js";

const app = express();
app.use(cors());
app.use(express.json());

// store files under /tmp for Render free plan
const TRADES_FILE = "/tmp/trades.json";
const SCANS_FILE  = "/tmp/scan_results.json";
const CFG_FILE    = "/tmp/config.json";

await fs.ensureDir("/tmp");
if (!(await fs.pathExists(TRADES_FILE))) await fs.writeJson(TRADES_FILE, []);
if (!(await fs.pathExists(SCANS_FILE)))  await fs.writeJson(SCANS_FILE, []);
if (!(await fs.pathExists(CFG_FILE)))    await fs.writeJson(CFG_FILE, { auto: false, settings: { tp: 10, percent: 2, count: 10, autosell: true } });

function last(arr){ return arr[arr.length - 1]; }

const PORT = process.env.PORT || 10000;
const TP_PERCENT = Number(process.env.TP_PERCENT || 10);
const DEFAULT_PERCENT = Number(process.env.PERCENT_PER_TRADE || 2);
const FEE_PERCENT = Number(process.env.FEE_PERCENT || 0.2);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 10);
const BITGET_DEMO = (process.env.BITGET_DEMO === "1");

// --- CoinGecko caching to avoid 429 ---
let cgCache = { ts: 0, data: [] };
async function fetchTopCoinGecko(limit = 200) {
  const now = Date.now();
  if (cgCache.data.length && (now - cgCache.ts) < (4 * 60 * 1000)) return cgCache.data;
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${limit}&page=1&sparkline=false`;
  try {
    const r = await axios.get(url, { timeout: 15000 });
    cgCache = { ts: Date.now(), data: r.data };
    return r.data;
  } catch (e) {
    console.warn("CoinGecko failed, returning cached data if available");
    return cgCache.data || [];
  }
}

// quick kline fetch helper (public mirror)
async function fetchKlines(symbol, interval="1h", limit=200) {
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const r = await axios.get(url, { timeout: 15000 });
  return r.data;
}

// analyze
async function analyzeSymbol(symbol) {
  try {
    if (!symbol || !symbol.endsWith("USDT")) return { ok:false, symbol, reason:"not-usdt" };
    const k1 = await fetchKlines(symbol,"1h",200);
    const k4 = await fetchKlines(symbol,"4h",100);
    const closes1 = k1.map(k=>parseFloat(k[4]));
    const highs1 = k1.map(k=>parseFloat(k[2]));
    const lows1 = k1.map(k=>parseFloat(k[3]));
    const vols1 = k1.map(k=>parseFloat(k[5]));
    const closes4 = k4.map(k=>parseFloat(k[4]));
    if (closes1.length < 50 || closes4.length < 20) return { ok:false, symbol, reason:"not-enough-data" };

    const ema8_1h = last(EMA.calculate({ period: 8, values: closes1 }));
    const ema21_1h = last(EMA.calculate({ period: 21, values: closes1 }));
    const rsi1h = last(RSI.calculate({ period: 14, values: closes1 }));
    const macd1h = last(MACD.calculate({ values: closes1, fastPeriod:12, slowPeriod:26, signalPeriod:9 }));
    const atr1h = last(ATR.calculate({ period: 14, high: highs1, low: lows1, close: closes1 }));

    const ema8_4h = last(EMA.calculate({ period:8, values: closes4 }));
    const ema21_4h = last(EMA.calculate({ period:21, values: closes4 }));
    const macd4h = last(MACD.calculate({ values: closes4, fastPeriod:12, slowPeriod:26, signalPeriod:9 }));

    let score = 0; const reasons = [];
    if (ema8_4h > ema21_4h) { score += 3; reasons.push("4H EMA+"); }
    if (macd4h && macd4h.histogram > 0) { score += 2; reasons.push("4H MACD+"); }
    if (ema8_1h > ema21_1h) { score += 2; reasons.push("1H EMA+"); }
    if (macd1h && macd1h.histogram > 0) { score += 1; reasons.push("1H MACD+"); }
    if (rsi1h > 45 && rsi1h < 65) { score += 1; reasons.push("RSI neutral"); }
    const volAvg = vols1.slice(-20).reduce((a,b)=>a+b,0)/20;
    if (vols1[vols1.length-1] > 1.5 * volAvg) { score += 1; reasons.push("Vol spike"); }

    const entry = closes1[closes1.length - 1];
    const tp = +(entry * (1 + TP_PERCENT/100)).toFixed(8);
    const sl = Math.max(0.00000001, entry - (atr1h * 1.5));

    return { ok:true, symbol, score, entry, tp, sl, reasons, indicators: { ema8_1h, ema21_1h, rsi1h, macd1h: macd1h?.histogram ?? null, atr1h, ema8_4h, ema21_4h, macd4h: macd4h?.histogram ?? null } };
  } catch (e) {
    return { ok:false, symbol, error: String(e) };
  }
}

/* --- Routes --- */
app.get("/", (_req, res) => res.send("DexScan V2 (Bitget) ✅"));

app.get("/api/header", async (_req, res) => {
  try {
    const cg = await fetchTopCoinGecko(200);
    const pick = ["bitcoin","ethereum","binancecoin"];
    const out = pick.map(id => {
      const c = (cg || []).find(x => x.id === id);
      return c ? { id, symbol: (c.symbol||"").toUpperCase()+"USDT", price: c.current_price } : { id };
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/coins", async (_req, res) => {
  try {
    const cg = await fetchTopCoinGecko(100);
    const arr = (cg || []).map(c => ({ symbol: (c.symbol||"").toUpperCase()+"USDT", price: c.current_price, change24h: c.price_change_percentage_24h }));
    res.json(arr.slice(0, 10));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/scan/run", async (_req, res) => {
  try {
    const cg = await fetchTopCoinGecko(200);
    const universe = (cg || []).map(c => (c.symbol||"").toUpperCase()+"USDT").slice(0, 120);
    const results = [];
    for (const s of universe) {
      try {
        const r = await analyzeSymbol(s);
        if (r.ok && r.score >= 5) results.push(r);
      } catch (e) {}
      if (results.length >= 10) break;
    }
    await fs.writeJson(SCANS_FILE, results, { spaces: 2 });
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/scan/results", async (_req, res) => {
  const out = await fs.readJson(SCANS_FILE).catch(()=>[]);
  res.json(out);
});

app.get("/api/balance", async (_req, res) => {
  // try bitget balances; fallback to simulated
  try {
    const b = await getSpotBalancesSimple();
    if (b.ok) return res.json({ ok:true, demo: BITGET_DEMO, balance: b.data });
  } catch (e) {}
  // fallback demo
  const trades = await fs.readJson(TRADES_FILE).catch(()=>[]);
  const invested = (trades || []).filter(t => t.status === "OPEN").reduce((a,b)=>a+(b.invested||0),0);
  return res.json({ ok:true, demo:true, balance: { USDT: 10000 - invested } });
});

app.get("/api/trades", async (_req, res) => {
  const trades = await fs.readJson(TRADES_FILE).catch(()=>[]);
  res.json(trades);
});

/* simple buy simulate (or real if bitget keys present) */
app.post("/api/trade/buy", async (req, res) => {
  try {
    const { symbol, percent } = req.body;
    if (!symbol) return res.status(400).json({ error: "symbol required" });
    const pct = Number(percent || DEFAULT_PERCENT);
    const b = await getSpotBalancesSimple().catch(()=>({ ok:false }));
    const usdtBal = (b.ok && b.data && b.data.USDT) ? Number(b.data.USDT) : 10000;
    if (usdtBal <= 0) return res.status(400).json({ error:"insufficient USDT" });
    const sizeUsd = +(usdtBal * (pct/100));
    // price via bitget ticker fallback to coingecko
    let price = null;
    try {
      const tk = await fetchSymbolTicker(symbol);
      if (tk.ok) price = Number(tk.data?.data?.last || tk.data?.last || 0);
    } catch(e){}
    if (!price) {
      const cg = await fetchTopCoinGecko(200);
      const cs = (cg || []).find(c => ((c.symbol||"").toUpperCase()+"USDT") === symbol);
      price = cs ? Number(cs.current_price || 0) : 0;
    }
    if (!price || price <= 0) return res.status(500).json({ error:"price unavailable" });
    const qty = +(sizeUsd / price).toFixed(8);

    // attempt to place via bitget wrapper; if fails or demo -> simulate
    const orderResp = await placeSpotOrder(symbol, "buy", qty, "market", null).catch(()=>({ ok:false }));
    const trades = await fs.readJson(TRADES_FILE).catch(()=>[]);
    if (!orderResp.ok || process.env.BITGET_DEMO === "1") {
      const sim = {
        id: "sim_" + Date.now(),
        symbol,
        qty,
        entry_price: price,
        invested: sizeUsd,
        buy_fee: +(sizeUsd * (FEE_PERCENT/100)),
        tp_price: +(price * (1 + TP_PERCENT/100)),
        status: "OPEN",
        created_at: new Date().toISOString(),
        demo: true
      };
      trades.push(sim);
      await fs.writeJson(TRADES_FILE, trades, { spaces: 2 });
      return res.json({ ok:true, trade: sim, simulated:true });
    }

    // real trade recorded
    const trade = {
      id: "t_" + Date.now(),
      symbol, qty, entry_price: price, invested: sizeUsd,
      buy_fee: +(sizeUsd * (FEE_PERCENT/100)),
      tp_price: +(price * (1 + TP_PERCENT/100)),
      status: "OPEN",
      created_at: new Date().toISOString(),
      demo:false,
      order_result: orderResp.data
    };
    trades.push(trade);
    await fs.writeJson(TRADES_FILE, trades, { spaces: 2 });
    return res.json({ ok:true, trade });
  } catch (e) { return res.status(500).json({ error: e.message || String(e) }); }
});

/* simple sell */
app.post("/api/trade/sell", async (req, res) => {
  try {
    const { trade_id, exit_price } = req.body;
    if (!trade_id) return res.status(400).json({ error: "trade_id required" });
    const trades = await fs.readJson(TRADES_FILE).catch(()=>[]);
    const t = trades.find(x => x.id === trade_id);
    if (!t) return res.status(404).json({ error: "trade not found" });
    if (t.status !== "OPEN") return res.status(400).json({ error: "trade not open" });

    let price = exit_price || null;
    if (!price) {
      try {
        const tk = await fetchSymbolTicker(t.symbol);
        if (tk.ok) price = Number(tk.data?.data?.last || tk.data?.last || 0);
      } catch(e){}
      if (!price) {
        const cg = await fetchTopCoinGecko(200);
        const cs = (cg || []).find(c => ((c.symbol||"").toUpperCase()+"USDT") === t.symbol);
        price = cs ? Number(cs.current_price || 0) : 0;
      }
    }
    if (!price || price <= 0) return res.status(500).json({ error:"price unavailable" });

    const gross = +(t.qty * price);
    const sellFee = +(gross * (FEE_PERCENT/100));
    const net = +(gross - sellFee);
    const pnl = +(net - t.invested);

    // attempt real sell if not demo
    if (process.env.BITGET_DEMO !== "1") {
      await placeSpotOrder(t.symbol, "sell", t.qty, "market", null).catch(()=>null);
    }

    t.status = "CLOSED";
    t.exit_price = price;
    t.sell_fee = sellFee;
    t.gross_proceeds = gross;
    t.net_proceeds = net;
    t.pnl = pnl;
    t.closed_at = new Date().toISOString();
    await fs.writeJson(TRADES_FILE, trades, { spaces: 2 });
    return res.json({ ok:true, trade: t });
  } catch (e) { return res.status(500).json({ error: e.message || String(e) }); }
});

app.listen(PORT, () => console.log(`✅ DexScan backend running on ${PORT}`));
