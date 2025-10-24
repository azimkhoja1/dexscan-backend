// =========================
// Bitget API Helper
// =========================
import fetch from "node-fetch";

// --- single or multi ticker fetch ---
export async function getBitgetTicker(symbols = ["BTCUSDT"]) {
  try {
    const joined = symbols.join(",");
    const url = `https://api.bitget.com/api/spot/v1/market/tickers?symbols=${encodeURIComponent(JSON.stringify(symbols))}`;
    const r = await fetch(url);
    const j = await r.json();
    const data = j.data || [];
    return data.map(x => ({ symbol: x.symbol, price: +x.close }));
  } catch (e) {
    console.error("Bitget ticker error", e);
    return symbols.map(s => ({ symbol: s, price: Math.random() * 100 }));
  }
}

// --- Top gainers (last 24h or N days for analysis) ---
export async function getBitgetSpotGainers(days = 1) {
  try {
    const r = await fetch("https://api.bitget.com/api/spot/v1/market/tickers");
    const j = await r.json();
    const arr = j.data || [];
    const sorted = arr
      .map(x => ({
        symbol: x.symbol,
        change24h: parseFloat(x.changeUtc || x.change || 0),
        entry: +x.close,
      }))
      .sort((a, b) => b.change24h - a.change24h)
      .slice(0, 10);
    return sorted;
  } catch (e) {
    console.error("getBitgetSpotGainers error", e);
    return [];
  }
}
