import fetch from "node-fetch";

const BITGET_BASE = process.env.BITGET_BASE || "https://api.bitget.com";

export async function getBitgetTicker(symbol = "BTCUSDT") {
  try {
    const r = await fetch(`${BITGET_BASE}/api/v2/spot/market/ticker?symbol=${symbol}`);
    const j = await r.json();
    return parseFloat(j?.data?.close || 0);
  } catch (e) {
    console.error("Ticker fetch failed:", e);
    return 0;
  }
}

export async function getTopMarkets(limit = 20) {
  try {
    const r = await fetch(`${BITGET_BASE}/api/v2/spot/market/tickers`);
    const j = await r.json();
    return j.data
      .filter(x => x.symbol.endsWith("USDT") && !x.symbol.includes("USD"))
      .sort((a, b) => b.changePct24h - a.changePct24h)
      .slice(0, limit)
      .map(x => ({
        symbol: x.symbol,
        price: parseFloat(x.close),
        vol: parseFloat(x.baseVol)
      }));
  } catch (e) {
    console.error("TopMarkets fetch failed:", e);
    return [];
  }
}
