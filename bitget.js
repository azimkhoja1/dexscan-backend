// bitget.js
import crypto from "crypto";
import axios from "axios";

const API_BASE = process.env.BITGET_API_BASE || "https://api.bitget.com";
const KEY = process.env.BITGET_API_KEY || "";
const SECRET = process.env.BITGET_API_SECRET || "";
const PASSPHRASE = process.env.BITGET_API_PASSPHRASE || "";
const DEMO = (process.env.BITGET_DEMO === "1");

// Build headers for Bitget (spot v2 endpoints)
function createBitgetHeaders(method, path, bodyStr = "") {
  const timestamp = Date.now().toString();
  // Bitget signature prehash: timestamp + method + path + body
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

// fetch account balances (spot)
export async function getSpotAccounts() {
  const path = "/api/v1/account/accounts";
  const url = API_BASE + path;
  const headers = createBitgetHeaders("GET", path, "");
  const res = await axios.get(url, { headers, timeout: 20000 });
  return res.data;
}

// get balance simplified (map symbol->available)
export async function getSpotBalancesSimple() {
  try {
    // Some Bitget deployments may use different endpoints; try common ones
    const path = "/api/spot/v1/account/accounts"; // fallback
    const url = API_BASE + "/api/spot/v1/account/accounts";
    const headers = createBitgetHeaders("GET", "/api/spot/v1/account/accounts", "");
    const res = await axios.get(url, { headers, timeout: 20000 });
    // response structure may differ; try to normalize
    if (res.data && Array.isArray(res.data.data)) {
      const data = res.data.data;
      const result = {};
      data.forEach(acc => {
        if (acc && acc.currency) {
          result[acc.currency] = acc.available || acc.balance || 0;
        }
      });
      return { ok: true, data: result };
    }
    return { ok: true, raw: res.data };
  } catch (e) {
    // final fallback to /api/v2/account/accounts (older)
    try {
      const path = "/api/v2/account/accounts";
      const url = API_BASE + path;
      const headers = createBitgetHeaders("GET", path, "");
      const res = await axios.get(url, { headers, timeout: 20000 });
      if (res.data && res.data.data) {
        const result = {};
        res.data.data.forEach(acc => {
          if (acc && acc.currency) result[acc.currency] = acc.available || acc.balance || 0;
        });
        return { ok: true, data: result };
      }
      return { ok: false, error: "unexpected balance response", raw: res.data };
    } catch (err2) {
      return { ok: false, error: err2.message || String(err2) };
    }
  }
}

// place a spot order (market or limit)
// body: {symbol: "BTCUSDT", side: "buy"|"sell", size: <float> (base amount), orderType: "market"|"limit", price?: <price>}
export async function placeSpotOrder(symbol, side, size, orderType = "market", price = null) {
  // Using /api/spot/v1/trade/orders (some Bitget docs differ per version)
  // We'll try v1 endpoint then fallback.
  const body = {
    symbol,
    side,
    type: orderType === "market" ? "market" : "limit",
  };
  // bitget expects "size" or "quantity"; we'll pass "size"
  if (orderType === "market") body.size = String(size);
  else {
    body.price = String(price);
    body.size = String(size);
  }
  const bodyStr = JSON.stringify(body);

  // prefer v1 endpoint
  try {
    const path = "/api/spot/v1/trade/orders";
    const url = API_BASE + path;
    const headers = createBitgetHeaders("POST", path, bodyStr);
    const res = await axios.post(url, body, { headers, timeout: 20000 });
    return { ok: true, data: res.data };
  } catch (e1) {
    // fallback to v2
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

// market price fetch (public) via Bitget (if available)
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
