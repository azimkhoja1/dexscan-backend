// bitget.js
import crypto from "crypto";
import axios from "axios";

const API_BASE = process.env.BITGET_API_BASE || "https://api.bitget.com";
const KEY = process.env.BITGET_API_KEY || "";
const SECRET = process.env.BITGET_API_SECRET || "";
const PASSPHRASE = process.env.BITGET_API_PASSPHRASE || "";
const DEMO = (process.env.BITGET_DEMO === "1");

// Build signature headers for Bitget (v1/v2 attempts with fallback)
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

// get balances - try a couple endpoints and normalize
export async function getSpotBalancesSimple() {
  try {
    // Try v2 accounts endpoint
    const path = "/api/v2/account/accounts";
    const url = API_BASE + path;
    const headers = createBitgetHeaders("GET", path, "");
    const res = await axios.get(url, { headers, timeout: 20000 });
    if (res.data && res.data.data && Array.isArray(res.data.data)) {
      const out = {};
      res.data.data.forEach(acc => {
        if (acc && acc.currency) out[acc.currency.toUpperCase()] = Number(acc.available || acc.balance || 0);
      });
      return { ok: true, data: out };
    }
    // fallback: try /api/spot/v1/account/accounts
    try {
      const path2 = "/api/spot/v1/account/accounts";
      const url2 = API_BASE + path2;
      const headers2 = createBitgetHeaders("GET", path2, "");
      const res2 = await axios.get(url2, { headers: headers2, timeout: 20000 });
      if (res2.data && res2.data.data && Array.isArray(res2.data.data)) {
        const out = {};
        res2.data.data.forEach(acc => {
          if (acc && acc.currency) out[acc.currency.toUpperCase()] = Number(acc.available || acc.balance || 0);
        });
        return { ok: true, data: out };
      }
    } catch(e2) { /* ignore fallback errors */ }
    // final fallback: return raw response
    return { ok: true, data: res.data || {} };
  } catch (e) {
    return { ok: false, error: e.response?.data || e.message || String(e) };
  }
}

// place spot order (tries common endpoints)
export async function placeSpotOrder(symbol, side, size, orderType = "market", price = null) {
  const body = { symbol, side, type: orderType === "market" ? "market" : "limit" };
  if (orderType === "market") body.size = String(size);
  else { body.price = String(price); body.size = String(size); }
  const bodyStr = JSON.stringify(body);

  // Try v1 spot endpoint
  try {
    const path = "/api/spot/v1/trade/orders";
    const url = API_BASE + path;
    const headers = createBitgetHeaders("POST", path, bodyStr);
    const res = await axios.post(url, body, { headers, timeout: 20000 });
    return { ok: true, data: res.data };
  } catch (e1) {
    // fallback to v2 place-order
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

// simple public ticker (fallback)
export async function fetchSymbolTicker(symbol) {
  try {
    const path = `/api/spot/v1/market/ticker?symbol=${symbol}`;
    const url = API_BASE + path;
    const res = await axios.get(url, { timeout: 10000 });
    return { ok: true, data: res.data };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}
