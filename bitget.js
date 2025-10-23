// bitget.js
import crypto from "crypto";
import axios from "axios";

const API_BASE = process.env.BITGET_API_BASE || "https://api.bitget.com";
const KEY = process.env.BITGET_API_KEY || "";
const SECRET = process.env.BITGET_API_SECRET || "";
const PASSPHRASE = process.env.BITGET_API_PASSPHRASE || "";
const DEMO = (process.env.BITGET_DEMO === "1");

// signature helper (generic)
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

// Generic GET helper with timeout
async function getUrl(path, headers = {}) {
  const url = API_BASE + path;
  return await axios.get(url, { headers, timeout: 20000 });
}

// Get spot balances (tries couple endpoints and falls back)
export async function getSpotBalancesSimple() {
  try {
    // try v2 accounts if present
    try {
      const path = "/api/v2/account/accounts";
      const headers = createBitgetHeaders("GET", path, "");
      const res = await getUrl(path, headers);
      if (res.data && Array.isArray(res.data.data)) {
        const out = {};
        res.data.data.forEach(acc => { if (acc && acc.currency) out[acc.currency.toUpperCase()] = Number(acc.available || acc.balance || 0); });
        return { ok: true, data: out };
      }
    } catch (e) {
      // continue to fallback
    }

    // fallback: try spot v1 accounts
    try {
      const path2 = "/api/spot/v1/account/accounts";
      const headers2 = createBitgetHeaders("GET", path2, "");
      const res2 = await getUrl(path2, headers2);
      if (res2.data && Array.isArray(res2.data.data)) {
        const out2 = {};
        res2.data.data.forEach(acc => { if (acc && acc.currency) out2[acc.currency.toUpperCase()] = Number(acc.available || acc.balance || 0); });
        return { ok: true, data: out2 };
      }
    } catch (e2) {
      // continue
    }

    // final fallback: try /api/spot/v1/wallet or a public balance path (best-effort)
    // If nothing works, return error to caller so backend can fallback to local wallet.
    return { ok: false, error: "No matching Bitget account endpoint found or request failed" };
  } catch (err) {
    return { ok: false, error: err.response?.data || err.message || String(err) };
  }
}

// Place spot order (market) - tries v1/v2 endpoints and returns unified response
export async function placeSpotOrder(symbol, side, size, orderType = "market", price = null) {
  const body = { symbol, side, type: orderType === "market" ? "market" : "limit" };
  if (orderType === "market") body.size = String(size);
  else { body.price = String(price); body.size = String(size); }
  const bodyStr = JSON.stringify(body);

  // try v1 endpoint
  try {
    const path = "/api/spot/v1/trade/orders";
    const headers = createBitgetHeaders("POST", path, bodyStr);
    const res = await axios.post(API_BASE + path, body, { headers, timeout: 20000 });
    return { ok: true, data: res.data };
  } catch (e1) {
    // try v2
    try {
      const path2 = "/api/v2/spot/trade/place-order";
      const headers2 = createBitgetHeaders("POST", path2, bodyStr);
      const res2 = await axios.post(API_BASE + path2, body, { headers: headers2, timeout: 20000 });
      return { ok: true, data: res2.data };
    } catch (e2) {
      return { ok: false, error: e2.response?.data || e2.message || String(e2) };
    }
  }
}

// Public ticker fallback (simple)
export async function fetchSymbolTicker(symbol) {
  try {
    const path = `/api/spot/v1/market/ticker?symbol=${symbol}`;
    const res = await axios.get(API_BASE + path, { timeout: 10000 });
    return { ok: true, data: res.data };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}
