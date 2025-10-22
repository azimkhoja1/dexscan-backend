import express from "express";
import axios from "axios";

const app = express();
const PORT = process.env.PORT || 10000;

// Root check
app.get("/", (req, res) => {
  res.send("✅ DexScan backend is running!");
});

// Top 10 coins by volume (Binance)
app.get("/api/top10", async (req, res) => {
  try {
    const { data } = await axios.get("https://api.binance.com/api/v3/ticker/24hr");
    const sorted = data
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, 10)
      .map((coin) => ({
        symbol: coin.symbol,
        lastPrice: coin.lastPrice,
        priceChangePercent: coin.priceChangePercent,
      }));
    res.json(sorted);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch data", details: err.message });
  }
});

app.listen(PORT, () => console.log(`DexScan backend (scanner) running on ${PORT}`));
