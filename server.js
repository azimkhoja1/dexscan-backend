// server.js — DexScan Backend (Bitget) — FIXED
import express from "express";
import axios from "axios";
import cors from "cors";
import fs from "fs-extra";
import { EMA, RSI, MACD, ATR } from "technicalindicators";
import { getSpotBalancesSimple, placeSpotOrder, fetchSymbolTicker } from "./bitget.js";

const app = express();
app.use(cors());
app.use(express.json());

// ✅ Store files in /tmp for free Render plan
const TRADES_FILE = "/tmp/trades.json";
const CFG_FILE = "/tmp/config.json";
if (!(await fs.pathExists(TRADES_FILE))) await fs.writeJson(TRADES_FILE, []);
if (!(await fs.pathExists(CFG_FILE))) await fs.writeJson(CFG_FILE, { auto: false });

const PORT = process.env.PORT || 10000;
const TP_PERCENT = Number(process.env.TP_PERCENT || 10);
const FEE_PERCENT = Number(process.env.FEE_PERCENT || 0.2);
const DEFAULT_PERCENT = Number(process.env.PERCENT_PER_TRADE || 2);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 10);

async function readJsonSafe(p, def = null) { try { return await fs.readJson(p); } catch { return def; } }
async function writeJsonSafe(p, v) { try { await fs.writeJson(p, v, { spaces: 2 }); } catch(e) { console.error("writeJsonSafe", e); } }

/* CoinGecko caching fix (prevents 429) */
let cgCache = { ts: 0, data: [] };
async function fetchTopCoinGecko(limit = 200) {
  const now = Date.now();
  if (cgCache.data.length && (now - cgCache.ts) < 5*60*1000) return cgCache.data;
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${limit}&page=1&sparkline=false`;
  try {
    const res = await axios.get(url, { timeout: 15000 });
    cgCache = { ts: Date.now(), data: res.data };
    return res.data;
  } catch(e) {
    console.warn("CoinGecko failed, using cache");
    return cgCache.data;
  }
}

function last(arr){return arr[arr.length-1];}

/* Quick indicator analysis */
async function analyzeSymbol(symbol){
  try{
    if(!symbol.endsWith("USDT"))return{ok:false};
    const k1 = await axios.get(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=1h&limit=200`);
    const k4 = await axios.get(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=4h&limit=100`);
    const c1=k1.data.map(x=>+x[4]),h1=k1.data.map(x=>+x[2]),l1=k1.data.map(x=>+x[3]),v1=k1.data.map(x=>+x[5]);
    const c4=k4.data.map(x=>+x[4]);
    const ema8_1h=last(EMA.calculate({period:8,values:c1})),ema21_1h=last(EMA.calculate({period:21,values:c1}));
    const rsi1h=last(RSI.calculate({period:14,values:c1}));
    const macd1h=last(MACD.calculate({values:c1,fastPeriod:12,slowPeriod:26,signalPeriod:9}));
    const ema8_4h=last(EMA.calculate({period:8,values:c4})),ema21_4h=last(EMA.calculate({period:21,values:c4}));
    const macd4h=last(MACD.calculate({values:c4,fastPeriod:12,slowPeriod:26,signalPeriod:9}));
    let score=0,reasons=[];
    if(ema8_4h>ema21_4h){score+=3;reasons.push("4H EMA+");}
    if(macd4h?.histogram>0){score+=2;reasons.push("4H MACD+");}
    if(ema8_1h>ema21_1h){score+=2;reasons.push("1H EMA+");}
    if(macd1h?.histogram>0){score+=1;reasons.push("1H MACD+");}
    if(rsi1h>45&&rsi1h<65){score+=1;reasons.push("RSI neutral");}
    const entry=last(c1);
    return{ok:true,symbol,score,entry,reasons};
  }catch(e){return{ok:false,error:e.message}}
}

/* --- Routes --- */
app.get("/",(req,res)=>res.send("DexScan V2 (Bitget) ✅"));

app.get("/api/header",async(req,res)=>{
  try{
    const cg=await fetchTopCoinGecko(200);
    const pick=["bitcoin","ethereum","binancecoin"];
    res.json(pick.map(id=>{
      const c=cg.find(x=>x.id===id);
      return c?{id,symbol:(c.symbol||"").toUpperCase()+"USDT",price:c.current_price}:null;
    }).filter(Boolean));
  }catch(e){res.status(500).json({error:e.message})}
});

app.get("/api/coins",async(req,res)=>{
  try{
    const cg=await fetchTopCoinGecko(100);
    const arr=cg.map(c=>({symbol:(c.symbol||"").toUpperCase()+"USDT",price:c.current_price}));
    res.json(arr.slice(0,10));
  }catch(e){res.status(500).json({error:e.message})}
});

app.post("/api/scan/run",async(req,res)=>{
  try{
    const cg=await fetchTopCoinGecko(120);
    const arr=[];
    for(const c of cg){
      const sym=(c.symbol||"").toUpperCase()+"USDT";
      const a=await analyzeSymbol(sym);
      if(a.ok&&a.score>=5)arr.push(a);
      if(arr.length>=10)break;
    }
    await writeJsonSafe("/tmp/scan_results.json",arr);
    res.json(arr);
  }catch(e){res.status(500).json({error:e.message})}
});

app.get("/api/scan/results",async(req,res)=>{
  res.json(await readJsonSafe("/tmp/scan_results.json",[]));
});

app.get("/api/balance",async(req,res)=>{
  res.json({ok:true,balance:{USDT:10000}});
});

app.get("/api/trades",async(req,res)=>{
  res.json(await readJsonSafe(TRADES_FILE,[]));
});

app.listen(PORT,()=>console.log(`✅ DexScan backend running on ${PORT}`));
