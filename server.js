import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// ✅ Root route test
app.get("/", (req, res) => {
  res.send("DexScan backend is working ✅");
});

// ✅ Proxy route to bypass region restrictions
app.get("/proxy", async (req, res) => {
  try {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: "Missing URL param" });
    const response = await axios.get(targetUrl);
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ Simple Binance price check test
app.get("/price", async (req, res) => {
  try {
    const { symbol } = req.query; // e.g. BTCUSDT
    const response = await axios.get(
      `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`
    );
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`DexScan API running on ${PORT}`));
