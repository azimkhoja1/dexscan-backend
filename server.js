import express from "express";
import axios from "axios";
import crypto from "crypto";
import cors from "cors";

const app = express();
app.use(express.json());
app.use(cors());

const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;
const BASE_URL = "https://api.binance.com";

function signQuery(qs) {
  return crypto.createHmac("sha256", API_SECRET).update(qs).digest("hex");
}

app.get("/api/prices", async (req, res) => {
  try {
    const { data } = await axios.get(`${BASE_URL}/api/v3/ticker/price`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/wallet", async (req, res) => {
  try {
    const ts = Date.now();
    const qs = `timestamp=${ts}`;
    const sig = signQuery(qs);
    const { data } = await axios.get(`${BASE_URL}/api/v3/account?${qs}&signature=${sig}`, {
      headers: { "X-MBX-APIKEY": API_KEY },
    });
    res.json(data.balances.filter(b => parseFloat(b.free) > 0));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ DexScan API running on ${port}`));
