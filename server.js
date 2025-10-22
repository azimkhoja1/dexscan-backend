import express from "express";
import { WebSocket } from "ws";
import cors from "cors";

const app = express();
app.use(cors());

let latestPrice = null;

// Binance WebSocket (BTCUSDT stream)
const ws = new WebSocket("wss://stream.binance.com:9443/ws/btcusdt@trade");

ws.on("message", (data) => {
  const trade = JSON.parse(data);
  latestPrice = parseFloat(trade.p);
});

// Endpoint to get latest price
app.get("/price", (req, res) => {
  res.json({ symbol: "BTCUSDT", price: latestPrice });
});

app.listen(10000, () => console.log("Server running on port 10000"));
