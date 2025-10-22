import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ---------------------- //
// 🔹 TOP 10 ENDPOINT
// ---------------------- //
app.get("/api/top10", async (req, res) => {
  try {
    const data = [
      { symbol: "BTCUSDT", price: "107575.09000000", change24h: "-4.015" },
      { symbol: "USDCUSDT", price: "0.99960000", change24h: "0.020" },
      { symbol: "ETHUSDT", price: "3796.84000000", change24h: "-5.456" },
      { symbol: "SOLUSDT", price: "181.35000000", change24h: "-6.866" },
      { symbol: "WALUSDT", price: "0.23740000", change24h: "-6.240" },
      { symbol: "FDUSDUSDT", price: "0.99740000", change24h: "-0.010" },
      { symbol: "XRPUSDT", price: "2.37640000", change24h: "-4.750" },
      { symbol: "DOGEUSDT", price: "0.19011000", change24h: "-5.634" },
      { symbol: "ASTERUSDT", price: "0.96000000", change24h: "-16.230" },
      { symbol: "ZECUSDT", price: "245.58000000", change24h: "-11.890" },
    ];
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch top10 data" });
  }
});

// ---------------------- //
// 🔹 WALLET FAKE ENDPOINT
// ---------------------- //
app.get("/api/wallet/fake", (req, res) => {
  const fakeWallet = {
    balance: 10000,
    holdings: [
      { symbol: "BTCUSDT", amount: 0.02, value: 2151.5 },
      { symbol: "ETHUSDT", amount: 0.5, value: 1898.4 },
      { symbol: "SOLUSDT", amount: 3, value: 544.05 },
    ],
    lastUpdated: new Date(),
  };
  res.json(fakeWallet);
});

// ---------------------- //
// 🔹 SCAN RESULTS ENDPOINT
// ---------------------- //
app.get("/api/scan/results", (req, res) => {
  const scanResults = [
    { symbol: "SOLUSDT", signal: "BUY", buyPrice: 181.35, targetPrice: 208.0 },
    { symbol: "DOGEUSDT", signal: "STRONG BUY", buyPrice: 0.1901, targetPrice: 0.220 },
    { symbol: "ETHUSDT", signal: "SELL", buyPrice: 3796.84, targetPrice: 3620.0 },
  ];
  res.json(scanResults);
});

// ---------------------- //
// SERVER START
// ---------------------- //
app.listen(PORT, () => {
  console.log(`DexScan backend (scanner) running on ${PORT}`);
});
