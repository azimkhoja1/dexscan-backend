import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// ✅ Root route
app.get("/", (req, res) => {
  res.send("DexScan backend is live ✅");
});

// ✅ Binance price fetch using AllOrigins proxy (bypasses regional blocks)
app.get("/price", async (req, res) => {
  try {
    const { symbol } = req.query; // e.g. BTCUSDT
    if (!symbol) return res.status(400).json({ error: "Missing symbol" });

    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(
      `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`
    )}`;

    const response = await axios.get(proxyUrl);
    const parsedData = JSON.parse(response.data.contents);

    res.json(parsedData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ Proxy route (for other APIs)
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
app.listen(PORT, () => console.log(`DexScan API running on ${PORT}`));
