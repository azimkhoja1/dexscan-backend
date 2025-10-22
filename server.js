import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// ✅ Health check route
app.get("/", (req, res) => {
  res.send("DexScan backend running ✅");
});

// ✅ Binance Mirror Price Route (bypasses Binance restrictions)
app.get("/price", async (req, res) => {
  try {
    const { symbol } = req.query; // e.g., BTCUSDT
    if (!symbol) return res.status(400).json({ error: "Missing symbol" });

    // Binance mirror API hosted on crypto proxy
    const mirrors = [
      `https://api.binance.us/api/v3/ticker/price?symbol=${symbol}`, // Binance US
      `https://api-gcp.binance.com/api/v3/ticker/price?symbol=${symbol}`, // Google-hosted mirror
      `https://data-api.binance.vision/api/v3/ticker/price?symbol=${symbol}` // Binance Vision (educational mirror)
    ];

    let data = null;
    for (const url of mirrors) {
      try {
        const response = await axios.get(url);
        data = response.data;
        if (data && data.symbol) break;
      } catch (err) {
        console.log(`Mirror failed: ${url}`);
      }
    }

    if (!data) return res.status(500).json({ error: "All mirrors failed" });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ Proxy route (for other API calls)
app.get("/proxy", async (req, res) => {
  try {
    const url = req.query.url;
    const response = await axios.get(url);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`DexScan backend running on ${PORT}`));
