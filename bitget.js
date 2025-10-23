// bitget.js
import crypto from "crypto";
import axios from "axios";

const API_BASE = process.env.BITGET_API_BASE || "https://api.bitget.com";
const KEY = process.env.BITGET_API_KEY || "";
const SECRET = process.env.BITGET_API_SECRET || "";
const PASSPHRASE = process.env.BITGET_API_PASSPHRASE || "";
const DEMO = (process.env.BITGET_DEMO === "1");

// Build signature headers
function createBitgetHeaders(method, path, bodyStr = "") {
  const timestamp = Date.now().toString();
  const prehash = timestamp + method.toUpperCase() + path + (bodyStr || "");
  const hmac = crypto.createHmac("sha256", SECRET || "");
  hmac.update(prehash);
  const signature = hmac.digest("base64");

  const headers = {
    "ACCESS-KEY": KEY,
    "ACCESS-SIGN": signature,
    "ACCESS-TIMESTAMP": timestamp,
    "ACCESS-PASSPHRASE": PASSPHRASE,
    "Content-Type": "application/json",
  };
  if (DEMO) headers["paptrading"] = "1";
  return headers;
}

// Try common account endpoints & normalize balances
export async function getSpotBalancesSimple() {
  try {
    // try v1 common endpoint
    const path = "/api/v2/account/accounts";
    const url = API_BASE + path;
    const headers = createBitgetHeaders("GET", path, "");
    const res = await axios.get(url, { headers, timeout: 20000 });
    if (res.data && res.data.data) {
      const out = {};
      res.data.data.forEach(acc => {
        if (acc && acc.currency) out[acc.currency.toUpperCase()] = Number(acc.available || acc.balance || 0);
      });
      return { ok: true, data: out };
    }
    // fallback - some deployments differ
    return { ok: true, data: res.data };
  } catch (e) {
    return { ok: false, error: e.response?.data || e.message || String(e) };
  }
}

// Place a spot order (market preferred)
export async function placeSpotOrder(symbol, side, size, orderType = "market", price = null) {
  const body = { symbol, side, type: orderType === "market" ? "market" : "limit" };
  if (orderType === "market") body.size = String(size);
  else { body.price = String(price); body.size = String(size); }
  const bodyStr = JSON.stringify(body);

  // try v1 spot endpoint
  try {
    const path = "/api/spot/v1/trade/orders";
    const url = API_BASE + path;
    const headers = createBitgetHeaders("POST", path, bodyStr);
    const res = await axios.post(url, body, { headers, timeout: 20000 });
    return { ok: true, data: res.data };
  } catch (e1) {
    // fallback: v2 place-order
    try {
      const path = "/api/v2/spot/trade/place-order";
      const url = API_BASE + path;
      const headers = createBitgetHeaders("POST", path, bodyStr);
      const res = await axios.post(url, body, { headers, timeout: 20000 });
      return { ok: true, data: res.data };
    } catch (e2) {
      return { ok: false, error: e2.response?.data || e2.message || String(e2) };
    }
  }
}

// Public ticker (fallback)
export async function fetchSymbolTicker(symbol) {
  try {
    const path = `/api/spot/v1/market/ticker?symbol=${symbol}`;
    const url = API_BASE + path;
    const res = await axios.get(url, { timeout: 10000 });
    return { ok: true, data: res.data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
