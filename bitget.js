// bitget.js
// Lightweight Bitget wrapper used by server.js
// DO NOT place secrets here. Use Render environment variables (or .env locally).

import crypto from "crypto";
import axios from "axios";

const API_BASE = process.env.BITGET_BASE || "https://api.bitget.com";
const KEY = process.env.BITGET_API_KEY || "";
const SECRET = process.env.BITGET_API_SECRET || "";
const PASSPHRASE = process.env.BITGET_API_PASSPHRASE || "";
const DEMO = (process.env.BITGET_DEMO === "1");

// Create headers for signed requests (Bitget HMAC SHA256 -> base64).
function createBitgetHeaders(method, path, bodyStr = "") {
  // If no key/secret/pasphrase provided we return empty so non-signed attempts can be tried
  if (!KEY || !SECRET || !PASSPHRASE) return {};
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
    "Content-Type": "application/json"
  };
  if (DEMO) headers["paptrading"] = "1";
  return headers;
}

async function safeGet(path, params = {}) {
  try {
    const url = API_BASE + path;
    const res = await axios.get(url, { params, timeout: 15000 });
    return { ok: true, data: res.data };
  } catch (e) {
    return { ok: false, error: e.response?.data || e.message || String(e) };
  }
}

async function safePost(path, body = {}, signed = false) {
  try {
    const url = API_BASE + path;
    const bodyStr = JSON.stringify(body || {});
    const headers = signed ? createBitgetHeaders("POST", path, bodyStr) : { "Content-Type": "application/json" };
    const res = await axios.post(url, body, { headers, timeout: 20000 });
    return { ok: true, data: res.data };
  } catch (e) {
    return { ok: false, error: e.response?.data || e.message || String(e) };
  }
}

export async function getSpotBalancesSimple() {
  // Bitget has different endpoints depending on account type; this tries a couple of common endpoints.
  if (!KEY || !SECRET || !PASSPHRASE) return { ok: false, error: "No API keys configured" };

  try {
    // Try v2 endpoint
    const path = "/api/v2/account/accounts";
    const headers = createBitgetHeaders("GET", path, "");
    const res = await axios.get(API_BASE + path, { headers, timeout: 10000 });
    if (res.data && Array.isArray(res.data.data)) {
      const out = {};
      res.data.data.forEach(acc => {
        if (acc && acc.currency) out[acc.currency.toUpperCase()] = Number(acc.available || acc.balance || 0);
      });
      return { ok: true, data: out };
    }
  } catch (err) {
    // fallback
  }

  try {
    const path2 = "/api/spot/v1/account/accounts";
    const headers2 = createBitgetHeaders("GET", path2, "");
    const res2 = await axios.get(API_BASE + path2, { headers: headers2, timeout: 10000 });
    if (res2.data && Array.isArray(res2.data.data)) {
      const out2 = {};
      res2.data.data.forEach(acc => {
        if (acc && acc.currency) out2[acc.currency.toUpperCase()] = Number(acc.available || acc.balance || 0);
      });
      return { ok: true, data: out2 };
    }
  } catch (err) {
    // final fallback
  }

  return { ok: false, error: "Unable to fetch balances from Bitget (check credentials/endpoint)" };
}

// Place spot order (market). Returns object {ok,data} or {ok,false,error}
export async function placeSpotOrder(symbol, side, size, orderType = "market", price = null) {
  // If no credentials provided, return an error object to allow server.js to simulate instead of failing.
  if (!KEY || !SECRET || !PASSPHRASE) return { ok: false, error: "No Bitget API keys configured" };

  // Construct body for common bitget spot endpoint (tries a couple of paths)
  const body = {
    symbol,
    side: side.toUpperCase(),
    size: String(size),
    type: orderType === "market" ? "market" : "limit"
  };
  if (orderType !== "market" && price) body.price = String(price);

  // Try v1 spot endpoint
  try {
    const path = "/api/spot/v1/trade/orders";
    const res = await safePost(path, body, true);
    if (res.ok) return res;
  } catch (e) {}

  try {
    // Try alternate endpoint
    const path2 = "/api/v2/spot/trade/place-order";
    const res2 = await safePost(path2, body, true);
    if (res2.ok) return res2;
  } catch (e) {}

  return { ok: false, error: "Order failed to place (check Bitget docs/keys). If demo, set BITGET_DEMO=1 and server will simulate." };
}

// Fetch a ticker quickly
export async function fetchSymbolTicker(symbol) {
  try {
    const path = `/api/spot/v1/market/ticker?symbol=${symbol}`;
    const res = await axios.get(API_BASE + path, { timeout: 10000 });
    return { ok: true, data: res.data };
  } catch (e) {
    return { ok: false, error: e.response?.data || e.message || String(e) };
  }
}
