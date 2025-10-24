// DexScan PRO Stage 3 Backend
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const CMC_KEY = process.env.CMC_KEY || "";
const DEMO_MODE = process.env.BITGET_DEMO === "1";
let autoTrade = false;
let trades = [];
let balance = { USDT: 10000 };
let lastScan = [];
let modeDemo = DEMO_MODE;

// -------- util helpers --------
async function fetchJSON(url, opts = {}) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error("bad response");
  return await r.json();
}

// -------- live price updater --------
let headerPrices = { btc: null, eth: null, bnb: null };
async function updateHeaderPrices() {
  try {
    const r = await fetchJSON(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,binancecoin&vs_currencies=usd"
    );
    headerPrices = {
      btc: r.bitcoin.usd.toFixed(2),
      eth: r.ethereum.usd.toFixed(2),
      bnb: r.binancecoin.usd.toFixed(2),
    };
  } catch (e) {
    console.log("coingecko fail");
  }
}
setInterval(updateHeaderPrices, 5000);
updateHeaderPrices();

// -------- fake coin scan --------
async function runScan() {
  const symbols = ["BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","DOGEUSDT","XRPUSDT"];
  lastScan = symbols.map((s) => {
    const entry = +(Math.random() * 100 + 1).toFixed(5);
    const tp1 = +(entry * 1.03).toFixed(5);
    const tp2 = +(entry * 1.06).toFixed(5);
    const tp3 = +(entry * 1.1).toFixed(5);
    const score = Math.floor(Math.random() * 10) + 1;
    return {
      symbol: s,
      entry,
      tp1,
      tp2,
      tp3,
      potential: "10%",
      hours: Math.floor(Math.random() * 24),
      score,
    };
  });
  return lastScan;
}

// -------- trades & pnl simulation --------
function simulatePrices() {
  trades.forEach((t) => {
    if (t.status === "OPEN") {
      const change = (Math.random() - 0.5) * 0.02; // ±1 %
      t.latest_price = +(t.entry_price * (1 + change)).toFixed(5);
    }
  });
}
setInterval(simulatePrices, 5000);

// -------- API endpoints --------
app.get("/", (req, res) => res.send("DexScan PRO Backend (Stage3) ✅"));

app.get("/api/header", (req, res) => res.json(headerPrices));

app.get("/api/scan/results", async (req, res) => {
  if (!lastScan.length) await runScan();
  res.json(lastScan);
});

app.post("/api/scan/run", async (req, res) => {
  await runScan();
  res.json({ ok: true, count: lastScan.length });
});

app.get("/api/trades", (req, res) => {
  res.json(trades);
});

app.post("/api/trade/buy", (req, res) => {
  const sym = req.body.symbol;
  const coin = lastScan.find((x) => x.symbol === sym);
  if (!coin) return res.json({ ok: false });
  const id = Date.now().toString();
  trades.push({
    id,
    symbol: sym,
    entry_price: coin.entry,
    latest_price: coin.entry,
    status: "OPEN",
  });
  balance.USDT -= 100; // mock trade cost
  res.json({ ok: true });
});

app.post("/api/trade/sell", (req, res) => {
  const id = req.body.trade_id;
  const t = trades.find((x) => x.id === id);
  if (!t) return res.json({ ok: false });
  t.status = "CLOSED";
  const pnl = (t.latest_price - t.entry_price) / t.entry_price;
  balance.USDT += 100 * (1 + pnl);
  res.json({ ok: true });
});

app.post("/api/auto", (req, res) => {
  autoTrade = !!req.body.enabled;
  res.json({ ok: true, autoTrade });
});

app.post("/api/mode", (req, res) => {
  modeDemo = !!req.body.demo;
  res.json({ ok: true, demo: modeDemo });
});

app.get("/api/balance", (req, res) => res.json(balance));

// -------- auto-trade loop --------
setInterval(() => {
  if (autoTrade && lastScan.length) {
    const pick = lastScan[Math.floor(Math.random() * lastScan.length)];
    if (!trades.some((t) => t.symbol === pick.symbol && t.status === "OPEN")) {
      trades.push({
        id: Date.now().toString(),
        symbol: pick.symbol,
        entry_price: pick.entry,
        latest_price: pick.entry,
        status: "OPEN",
      });
      balance.USDT -= 100;
      console.log("Auto bought:", pick.symbol);
    }
  }
}, 15000);

app.listen(PORT, () => console.log(`🚀 DexScan PRO backend live on port ${PORT}`));
