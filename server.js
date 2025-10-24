// server.js — FULL
import express from "express";
import axios from "axios";
import cors from "cors";
import fs from "fs-extra";
import { EMA, RSI, MACD, ATR } from "technicalindicators";
import crypto from "crypto";

const app = express();
app.use(cors());
app.use(express.json());

// ------------ config + env ------------
const PORT = process.env.PORT || 10000;

const BITGET_API_KEY = process.env.BITGET_API_KEY || "";
const BITGET_API_SECRET = process.env.BITGET_API_SECRET || "";
const BITGET_API_PASSPHRASE = process.env.BITGET_API_PASSPHRASE || "";
const BITGET_BASE = process.env.BITGET_BASE || "https://api.bitget.com";
const BITGET_DEMO = (process.env.BITGET_DEMO === "1");

const CMC_KEY = process.env.CMC_KEY || "";
const TP_PERCENT = Number(process.env.TP_PERCENT || 10);
const DEFAULT_PERCENT = Number(process.env.PERCENT_PER_TRADE || 2);
const FEE_PERCENT = Number(process.env.FEE_PERCENT || 0.2);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 10);

// ------------ persistent storage ------------
await fs.ensureDir("./data");
const TRADES_FILE = "./data/trades.json";
const CFG_FILE = "./data/config.json";
const LOG_FILE = "./data/logs.txt";

if (!(await fs.pathExists(TRADES_FILE))) await fs.writeJson(TRADES_FILE, []);
if (!(await fs.pathExists(CFG_FILE))) await fs.writeJson(CFG_FILE, { auto: false, settings: { tp: TP_PERCENT, sl: 100, invest: DEFAULT_PERCENT, count: 10, percent: DEFAULT_PERCENT, autosell: true } });

async function readJsonSafe(path, def) {
  try { return await fs.readJson(path); }
  catch(e) { return def; }
}
async function writeJsonSafe(path, val) {
  try { await fs.writeJson(path, val, { spaces:2 }); }
  catch(e) { console.error("writeJsonSafe error:", e.message); }
}
async function appendLog(line) {
  try { await fs.appendFile(LOG_FILE, new Date().toISOString() + " " + line + "\n"); }
  catch(e) {}
}

// ------------ Bitget wrapper ------------
function createBitgetHeaders(method, path, bodyStr="") {
  if (!BITGET_API_KEY || !BITGET_API_SECRET || !BITGET_API_PASSPHRASE) return {};
  const timestamp = Date.now().toString();
  const prehash = timestamp + method.toUpperCase() + path + bodyStr;
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
async function safeGetBitget(path, params={}) {
  try {
    const url = BITGET_BASE + path;
    const res = await axios.get(url, { params, timeout:15000, headers: createBitgetHeaders("GET", path, "") });
    return { ok:true, data: res.data };
  } catch(e) {
    return { ok:false, error: e.response?.data || e.message || String(e) };
  }
}
async function safePostBitget(path, body={}, signed=false) {
  try {
    const url = BITGET_BASE + path;
    const bodyStr = JSON.stringify(body);
    const headers = signed ? createBitgetHeaders("POST", path, bodyStr) : { "Content-Type":"application/json" };
    const res = await axios.post(url, body, { headers, timeout:20000 });
    return { ok:true, data: res.data };
  } catch(e) {
    return { ok:false, error: e.response?.data || e.message || String(e) };
  }
}
export async function getSpotBalancesSimple() {
  if (!BITGET_API_KEY || !BITGET_API_SECRET || !BITGET_API_PASSPHRASE) {
    return { ok:false, error:"No Bitget API keys configured" };
  }
  // Example endpoint v2
  const path = "/api/v2/account/accounts";
  const headers = createBitgetHeaders("GET", path, "");
  try {
    const res = await axios.get(BITGET_BASE + path, { headers, timeout:10000 });
    const out = {};
    res.data.data.forEach(acc => {
      if (acc.currency) out[acc.currency.toUpperCase()] = Number(acc.available || acc.balance || 0);
    });
    return { ok:true, data: out };
  } catch(e) {
    return { ok:false, error:"Unable to fetch balances" };
  }
}
export async function placeSpotOrder(symbol, side, size, orderType="market", price=null) {
  if (!BITGET_API_KEY || !BITGET_API_SECRET || !BITGET_API_PASSPHRASE) {
    return { ok:false, error:"No Bitget API keys configured" };
  }
  const body = { symbol, side: side.toUpperCase(), size: String(size), type: orderType === "market" ? "market" : "limit" };
  if (orderType !== "market" && price) body.price = String(price);
  const path = "/api/spot/v1/trade/orders";
  const resp = await safePostBitget(path, body, true);
  if (resp.ok) return resp;
  // fallback
  return { ok:false, error:"Order failed to place" };
}
export async function fetchSymbolTicker(symbol) {
  try {
    const path = `/api/spot/v1/market/ticker?symbol=${symbol}`;
    const res = await axios.get(BITGET_BASE + path, { timeout:10000 });
    return { ok:true, data: res.data };
  } catch(e) {
    return { ok:false, error:e.response?.data || e.message || String(e) };
  }
}

// ------------ Data sources & scanning ------------
async function fetchWithRetry(url, maxRetries=3, delay=700) {
  let attempt = 0;
  while(true) {
    try {
      const r = await axios.get(url, { timeout:15000 });
      return r.data;
    } catch(e) {
      attempt++;
      if (attempt > maxRetries) throw e;
      await new Promise(r => setTimeout(r, delay * attempt));
    }
  }
}

let cmcCache = { ts:0, data:null };
const CMC_TTL = 5 * 60 * 1000;

async function fetchTopCoinsCMC(limit=200) {
  const now = Date.now();
  if (cmcCache.data && (now - cmcCache.ts) < CMC_TTL) return cmcCache.data;
  const url = `https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?limit=${limit}&convert=USD`;
  const res = await axios.get(url, { headers: { "X-CMC_PRO_API_KEY": CMC_KEY }, params: { start:1, limit, convert:"USD" } , timeout:15000 });
  const arr = res.data.data.map(c => ({
    id: c.id,
    symbol: (c.symbol||"").toUpperCase()+"USDT",
    name: c.name,
    price: c.quote?.USD?.price || 0,
    volume24h: c.quote?.USD?.volume_24h || 0,
    marketCap: c.quote?.USD?.market_cap || 0
  }));
  cmcCache = { ts: now, data: arr };
  return arr;
}

async function fetchKlines(symbol, interval="1h", limit=200) {
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  return await fetchWithRetry(url, 3, 700);
}
function last(arr) { return arr[arr.length-1]; }

const STABLE_BASES = ["USDT","USDC","BUSD","DAI","TUSD","USDP","USTC","FRAX","USDD","FDUSD"];

async function analyzeSymbol(symbol) {
  if (!symbol.endsWith("USDT")) return { ok:false, symbol, reason:"not USDT" };
  const base = symbol.replace("USDT","");
  if (STABLE_BASES.includes(base)) return { ok:false, symbol, reason:"stable skipped" };
  const k1 = await fetchKlines(symbol,"1h",200);
  const k4 = await fetchKlines(symbol,"4h",100);
  const closes1 = k1.map(x=>parseFloat(x[4]));
  const highs1 = k1.map(x=>parseFloat(x[2]));
  const lows1 = k1.map(x=>parseFloat(x[3]));
  const vols1 = k1.map(x=>parseFloat(x[5]));
  const closes4 = k4.map(x=>parseFloat(x[4]));
  if (closes1.length < 50 || closes4.length < 20) return { ok:false, symbol, reason:"insufficient data" };
  const ema8_1 = last(EMA.calculate({ period:8, values: closes1 }));
  const ema21_1 = last(EMA.calculate({ period:21, values: closes1 }));
  const rsi1 = last(RSI.calculate({ period:14, values: closes1 }));
  const macd1 = last(MACD.calculate({ values: closes1, fastPeriod:12, slowPeriod:26, signalPeriod:9 }));
  const atr1 = last(ATR.calculate({ period:14, high:highs1, low:lows1, close:closes1 }));
  const ema8_4 = last(EMA.calculate({ period:8, values: closes4 }));
  const ema21_4 = last(EMA.calculate({ period:21, values: closes4 }));
  const macd4 = last(MACD.calculate({ values: closes4, fastPeriod:12, slowPeriod:26, signalPeriod:9 }));
  let score=0;
  const reasons=[];
  if (ema8_4 > ema21_4) { score+=3; reasons.push("4H EMA8>21"); }
  if (macd4 && macd4.histogram > 0) { score+=2; reasons.push("4H MACD+"); }
  if (ema8_1 > ema21_1) { score+=2; reasons.push("1H EMA8>21"); }
  if (macd1 && macd1.histogram > 0) { score+=1; reasons.push("1H MACD+"); }
  if (rsi1 > 45 && rsi1 < 65) { score+=1; reasons.push("RSI mid"); }
  const volAvg = vols1.slice(-20).reduce((a,b)=>a + b,0) / 20;
  if (vols1[vols1.length-1] > 1.5 * volAvg) { score+=1; reasons.push("Vol spike"); }
  const entry = +closes1.at(-1);
  const tp = +(entry * (1 + TP_PERCENT/100)).toFixed(8);
  const sl = Math.max(0.00000001, entry - (atr1 * 1.5));
  return { ok:true, symbol, score, entry, tp, sl, indicators:{ ema8_1, ema21_1, rsi1, macd1:macd1?macd1.histogram:null, atr1, ema8_4, ema21_4, macd4:macd4?macd4.histogram:null }, reasons };
}

// ------------ endpoints ------------
app.get("/", (_req,res) => res.send("DexScan V2 (Bitget) ✅"));
app.get("/api/header", async (_req, res) => {
  try {
    const arr = await fetchTopCoinsCMC(50);
    const pick = ["bitcoin","ethereum","binancecoin"].map(id => null);
    const result = arr.filter(c => ["bitcoin","ethereum","binancecoin"].includes(c.name.toLowerCase())).map(c => ({ symbol: c.symbol, price: c.price }));
    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});
app.get("/api/coins", async (_req,res) => {
  try {
    const arr = await fetchTopCoinsCMC(100);
    const filtered = arr.filter(c => c.volume24h > 1_000_000 && c.marketCap > 10_000_000).slice(0,10);
    res.json(filtered.map(c => ({ symbol: c.symbol, price: c.price, change24h: (c.price?((c.price - (c.price*(1 - (c.volume24h/c.marketCap))))):0) })));
  } catch(e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});
app.post("/api/scan/run", async (_req, res) => {
  try {
    const cfg = await readJsonSafe(CFG_FILE, {});
    const count = cfg.settings?.count || 10;
    const universeArr = await fetchTopCoinsCMC(200);
    const universe = universeArr.map(c => c.symbol).slice(0,120);
    const results = [];
    for (const s of universe) {
      try {
        const r = await analyzeSymbol(s);
        if (r.ok && r.score >= 6) results.push(r);
      } catch(e) {}
      if (results.length >= count) break;
    }
    results.sort((a,b)=>b.score - a.score);
    await writeJsonSafe("./data/scan_results.json", results);
    res.json(results);
  } catch(e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});
app.get("/api/scan/results", async (_req, res) => {
  const s = await readJsonSafe("./data/scan_results.json", []);
  res.json(s);
});
app.get("/api/balance", async (_req, res) => {
  try {
    const b = await getSpotBalancesSimple();
    if (b.ok) return res.json({ ok:true, demo: BITGET_DEMO, balance: b.data });
    // fallback demo
    const trades = await readJsonSafe(TRADES_FILE, []);
    const inv = trades.filter(t => t.status==="OPEN").reduce((a,t)=>a + (t.invested || 0),0);
    const usdt = 10000 - inv;
    return res.json({ ok:true, demo:true, balance: { USDT: usdt } });
  } catch(e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});
app.get("/api/trades", async (_req, res) => {
  try {
    const tradesArr = await readJsonSafe(TRADES_FILE, []);
    const pricesArr = await fetchTopCoinsCMC(200);
    const priceMap = {};
    pricesArr.forEach(c => priceMap[c.symbol] = c.price);
    const out = tradesArr.map(t => {
      if (t.status==="OPEN") {
        const latest = priceMap[t.symbol] || null;
        const gross = latest ? +(t.qty * latest) : null;
        const fee = gross ? +(gross * (FEE_PERCENT/100)) : null;
        const net = (gross && fee!==null) ? +(gross - fee) : null;
        const unreal = net!==null ? +(net - t.invested) : null;
        return { ...t, latest_price: latest, est_net: net, unreal_pnl: unreal };
      } else {
        return t;
      }
    });
    res.json(out);
  } catch(e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});
app.post("/api/trade/buy", async (req, res) => {
  try {
    const { symbol, percent } = req.body;
    if (!symbol) return res.status(400).json({ error:"symbol required" });
    const cfg = await readJsonSafe(CFG_FILE, {});
    const pct = Number(percent || cfg.settings?.percent || DEFAULT_PERCENT);

    const balResp = await getSpotBalancesSimple();
    let usdtBal = balResp.ok ? Number(balResp.data["USDT"]||0) : 10000;
    if (usdtBal <= 0) return res.status(400).json({ error:"Insufficient USDT" });

    const sizeUsd = +(usdtBal * (pct/100));
    let price = null;
    const tk = await fetchSymbolTicker(symbol);
    if (tk.ok && tk.data) price = Number(tk.data.data?.last || tk.data.last);
    if (!price) {
      const coins = await fetchTopCoinsCMC(50);
      const c = coins.find(c=>c.symbol===symbol);
      price = c?.price || 0;
    }
    if (!price || price <= 0) return res.status(500).json({ error:"Price unavailable" });

    const qty = +(sizeUsd / price).toFixed(8);
    const orderResp = await placeSpotOrder(symbol,"buy",qty,"market",null);

    const tradesArr = await readJsonSafe(TRADES_FILE, []);
    if (!orderResp.ok || BITGET_DEMO) {
      const sim = {
        id: "sim_"+Date.now(),
        symbol, qty,
        entry_price: price,
        invested: sizeUsd,
        buy_fee: +(sizeUsd * (FEE_PERCENT/100)),
        tp_price: +(price * (1 + TP_PERCENT/100)),
        status:"OPEN",
        created_at: new Date().toISOString(),
        autoSell: cfg.settings?.autosell ?? true,
        demo: true
      };
      tradesArr.push(sim);
      await writeJsonSafe(TRADES_FILE, tradesArr);
      await appendLog("Sim buy "+sim.id+" "+symbol);
      return res.json({ ok:true, trade:sim, simulated:true });
    }

    const trade = {
      id:"t_"+Date.now(),
      symbol, qty,
      entry_price: price,
      invested:sizeUsd,
      buy_fee: +(sizeUsd*(FEE_PERCENT/100)),
      tp_price: +(price * (1 + TP_PERCENT/100)),
      status:"OPEN",
      created_at: new Date().toISOString(),
      autoSell: cfg.settings?.autosell ?? true,
      demo:false,
      order_result: orderResp.data
    };
    tradesArr.push(trade);
    await writeJsonSafe(TRADES_FILE, tradesArr);
    await appendLog("Placed buy "+trade.id+" "+symbol);
    return res.json({ ok:true, trade });
  } catch(e) {
    await appendLog("trade/buy err: "+(e.message||String(e)));
    res.status(500).json({ error:e.message||String(e) });
  }
});
app.post("/api/trade/sell", async (req, res) => {
  try {
    const { trade_id, exit_price } = req.body;
    if (!trade_id) return res.status(400).json({ error:"trade_id required" });
    const tradesArr = await readJsonSafe(TRADES_FILE, []);
    const t = tradesArr.find(x=>x.id===trade_id);
    if (!t) return res.status(404).json({ error:"trade not found" });
    if (t.status !== "OPEN") return res.status(400).json({ error:"trade not open" });

    let price = exit_price || null;
    if (!price) {
      const tk = await fetchSymbolTicker(t.symbol);
      if (tk.ok && tk.data) price = Number(tk.data.data?.last || tk.data.last);
    }
    if (!price || price <= 0) {
      const coins = await fetchTopCoinsCMC(50);
      const c = coins.find(c=>c.symbol===t.symbol);
      price = c?.price || 0;
    }
    if (!price || price <= 0) return res.status(500).json({ error:"Price unavailable" });
    const gross = +(t.qty * price);
    const sellFee = +(gross * (FEE_PERCENT/100));
    const net = +(gross - sellFee);
    const pnl = +(net - t.invested);
    let orderResp = null;
    if (!BITGET_DEMO) orderResp = await placeSpotOrder(t.symbol, "sell", t.qty, "market", null);

    t.status="CLOSED";
    t.exit_price=price;
    t.sell_fee=sellFee;
    t.gross_proceeds=gross;
    t.net_proceeds=net;
    t.pnl=pnl;
    t.closed_at=new Date().toISOString();
    t.order_sell_result=orderResp ? (orderResp.ok ? orderResp.data : orderResp.error) : null;

    await writeJsonSafe(TRADES_FILE, tradesArr);
    await appendLog("Closed trade "+t.id+" pnl:"+pnl);
    return res.json({ ok:true, trade:t });
  } catch(e) {
    await appendLog("trade/sell err: "+(e.message||String(e)));
    res.status(500).json({ error:e.message||String(e) });
  }
});
app.post("/api/auto", async (req,res) => {
  const { enabled } = req.body;
  const cfg = await readJsonSafe(CFG_FILE, {});
  cfg.auto = !!enabled;
  await writeJsonSafe(CFG_FILE, cfg);
  await appendLog("Auto mode set:"+enabled);
  res.json({ ok:true, auto:cfg.auto });
});
app.get("/api/auto", async (_req,res) => {
  const cfg = await readJsonSafe(CFG_FILE, {});
  res.json({ auto: cfg.auto });
});
app.get("/api/settings", async (_req,res) => {
  const cfg = await readJsonSafe(CFG_FILE, {});
  res.json(cfg.settings || {});
});
app.post("/api/settings", async (req,res) => {
  const body = req.body || {};
  const cfg = await readJsonSafe(CFG_FILE, {});
  cfg.settings = { ...(cfg.settings || {}), ...body };
  await writeJsonSafe(CFG_FILE, cfg);
  res.json({ ok:true, settings: cfg.settings });
});

// ------------ workers ------------
let autoBusy = false;
async function autoWorker(){
  try {
    if (autoBusy) return;
    autoBusy = true;
    const cfg = await readJsonSafe(CFG_FILE, {});
    if (!cfg.auto) return;
    const settings = cfg.settings || {};
    const tradesArr = await readJsonSafe(TRADES_FILE, []);
    const openCount = (tradesArr.filter(t=>t.status==="OPEN")).length;
    if (openCount >= (settings.count || MAX_CONCURRENT)) return;

    const universeArr = await fetchTopCoinsCMC(200);
    const universe = universeArr.map(c=>c.symbol).slice(0,120);
    for (const s of universe) {
      try {
        const r = await analyzeSymbol(s);
        if (r.ok && r.score >= 6) {
          // map to endpoint
          await axios.post(`http://localhost:${PORT}/api/trade/buy`, { symbol:s, percent: settings.percent || DEFAULT_PERCENT }, { timeout:120000 });
          await appendLog("Auto buy requested "+s);
        }
      } catch(e){}
      const tradesNow = await readJsonSafe(TRADES_FILE, []);
      const openNow = (tradesNow.filter(t=>t.status==="OPEN")).length;
      if (openNow >= (settings.count || MAX_CONCURRENT)) break;
    }
  } catch(e) {
    await appendLog("autoWorker err:"+ (e.message||String(e)));
  } finally {
    autoBusy = false;
  }
}
setInterval(autoWorker, 30 * 1000);

async function monitorLoop(){
  try {
    const tradesArr = await readJsonSafe(TRADES_FILE, []);
    if (!tradesArr.length) return;
    const coinsArr = await fetchTopCoinsCMC(200);
    const priceMap = {};
    coinsArr.forEach(c => priceMap[c.symbol] = c.price);
    for (const t of tradesArr.filter(x=>x.status==="OPEN")) {
      const latest = priceMap[t.symbol] || null;
      if (!latest) continue;
      const tp = t.tp_price || (t.entry_price * (1 + TP_PERCENT/100));
      if (latest >= tp && t.autoSell !== false) {
        try {
          await axios.post(`http://localhost:${PORT}/api/trade/sell`, { trade_id:t.id, exit_price: latest }, { timeout:120000 });
          await appendLog("Auto-sold "+t.id+" at "+latest);
        } catch(e) {
          await appendLog("Auto-sell failed "+t.id+" "+ (e.message||String(e)));
        }
      }
    }
  } catch(e){}
}
setInterval(monitorLoop, 5000);

// ------------ start server ------------
app.listen(PORT, () => {
  console.log(`✅ DexScan backend running on ${PORT}`);
});
