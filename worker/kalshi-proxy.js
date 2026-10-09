// BananaBets Kalshi proxy (Cloudflare Worker).
// Read-only: it only fetches public Kalshi market prices and price history, and passes tidy copies to the site.
// Kalshi refuses requests that come from a website, so this runs on Cloudflare's servers instead.
// It never places orders and never holds an account or key.
//
// Routes:
//   /markets?league=nfl|nba|mlb|ufc   open markets: game winners, spreads and totals
//   /history?ticker=TICKER&days=N      price history for one market (for the trend chart)
//
// Rate limits: answers are cached in Cloudflare's cache (markets 60 s, history 10 min). If Kalshi answers 429
// (rate limited), the Worker serves the last good copy, marked "rate_limited", and waits before asking Kalshi again.

const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";
const SERIES = {
  nfl: ["KXNFLGAME", "KXNFLSPREAD", "KXNFLTOTAL"],
  nba: ["KXNBAGAME", "KXNBASPREAD", "KXNBATOTAL"],
  mlb: ["KXMLBGAME", "KXMLBSPREAD", "KXMLBTOTAL"],
  ufc: ["KXUFCFIGHT"],
};
const KIND = { GAME: "win", FIGHT: "win", SPREAD: "spread", TOTAL: "total" };
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const MARKETS_FRESH_S = 60;        // how long a market list is served without asking Kalshi again
const HISTORY_FRESH_S = 600;       // history changes slowly
const STALE_KEEP_S = 86400;        // last good copy kept for a day, for rate-limit fallback
const BACKOFF_S = 120;             // after a 429, wait this long before asking Kalshi again (or Retry-After, if larger)
const backoffUntil = new Map();    // league or ticker -> time (ms) before which we don't call Kalshi
const CORS = {
  "Access-Control-Allow-Origin": "*",          // public, read-only data
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return send(null, 204);
    if (request.method !== "GET") return send({ error: "Only GET is allowed" }, 405);

    const url = new URL(request.url);
    if (url.pathname === "/markets") return markets(url.searchParams.get("league") || "");
    if (url.pathname === "/history") return history(url.searchParams.get("ticker") || "", Number(url.searchParams.get("days")) || 7);
    return send({ error: "Use /markets?league=nfl|nba|mlb|ufc or /history?ticker=..." }, 404);
  },
};

async function markets(league) {
  const series = SERIES[league];
  if (!series) return send({ error: "Unknown league. Use nfl, nba, mlb or ufc." }, 400);
  const freshKey = `https://cache.bananabets/markets/${league}`;
  const staleKey = `https://cache.bananabets/markets-stale/${league}`;

  const fresh = await cacheGet(freshKey);
  if (fresh) return fresh;
  const stale = await cacheGet(staleKey);
  if (Date.now() < (backoffUntil.get(league) || 0)) return fallback(stale, "Kalshi rate-limited, showing last prices");

  const lists = await Promise.all(series.map((s) => kalshiGet(`${KALSHI}/markets?series_ticker=${s}&status=open&limit=200`)));
  const failed = lists.find((r) => r.error);
  if (failed) {
    if (failed.status === 429) backoffUntil.set(league, Date.now() + Math.max(BACKOFF_S, failed.retryAfter || 0) * 1000);
    return fallback(stale, failed.status === 429 ? "Kalshi rate-limited, showing last prices" : failed.error);
  }

  const markets = [];
  lists.forEach((r, i) => {
    const kind = KIND[series[i].replace(/^KX[A-Z]+?(GAME|SPREAD|TOTAL|FIGHT)$/, "$1")] || "win";
    for (const m of r.data.markets || []) {
      markets.push({
        kind,
        ticker: m.ticker,
        event: m.event_ticker,
        title: m.title || "",
        outcome: m.yes_sub_title || m.title || "",
        yes_bid: num(m.yes_bid_dollars),
        yes_ask: num(m.yes_ask_dollars),
        last: num(m.last_price_dollars),
        previous: num(m.previous_price_dollars),
        volume: num(m.volume_fp),
        close_time: m.close_time || null,
      });
    }
  });
  const body = { league, fetched_at: new Date().toISOString(), markets };
  const response = await store(freshKey, body, MARKETS_FRESH_S);
  await store(staleKey, body, STALE_KEEP_S);
  return response;
}

async function history(ticker, days) {
  if (!/^[A-Z0-9][A-Z0-9-]{3,80}$/.test(ticker)) return send({ error: "Bad ticker" }, 400);
  const series = ticker.split("-")[0];
  const window = Math.min(Math.max(days, 1), 30);
  const freshKey = `https://cache.bananabets/history/${ticker}/${window}`;
  const staleKey = `https://cache.bananabets/history-stale/${ticker}/${window}`;

  const fresh = await cacheGet(freshKey);
  if (fresh) return fresh;
  const stale = await cacheGet(staleKey);
  if (Date.now() < (backoffUntil.get(ticker) || 0)) return fallback(stale, "Kalshi rate-limited, showing last prices");

  const end = Math.floor(Date.now() / 1000);
  const start = end - window * 86400;
  const interval = window <= 7 ? 60 : 1440;                         // Kalshi accepts only 1, 60 or 1440 minutes between points
  const r = await kalshiGet(`${KALSHI}/series/${series}/markets/${ticker}/candlesticks?start_ts=${start}&end_ts=${end}&period_interval=${interval}`);
  if (r.error) {
    if (r.status === 429) backoffUntil.set(ticker, Date.now() + Math.max(BACKOFF_S, r.retryAfter || 0) * 1000);
    return fallback(stale, r.status === 429 ? "Kalshi rate-limited, showing last prices" : r.error);
  }

  const points = (r.data.candlesticks || []).map((c) => {
    const trade = num(c.price && c.price.close_dollars);
    const bid = num(c.yes_bid && c.yes_bid.close_dollars), ask = num(c.yes_ask && c.yes_ask.close_dollars);
    const p = trade ?? (bid != null && ask != null ? (bid + ask) / 2 : null);
    return { t: c.end_period_ts, p };
  }).filter((x) => x.p != null);
  const body = { ticker, days: window, fetched_at: new Date().toISOString(), points };
  const response = await store(freshKey, body, HISTORY_FRESH_S);
  await store(staleKey, body, STALE_KEEP_S);
  return response;
}

// Serve the last good copy with a flag, or an error if there is none yet.
function fallback(stale, message) {
  if (stale) return stale.json().then((b) => send({ ...b, stale: true, rate_limited: true, message }, 200));
  const none = message.includes("rate-limited") ? "Kalshi rate-limited, no prices cached yet. Try again in a minute." : message;
  return send({ error: none, rate_limited: true }, 503);
}

async function kalshiGet(url) {
  let res;
  try {
    res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  } catch (e) {
    return { error: "Kalshi could not be reached", status: 0 };
  }
  if (!res.ok) {
    const retry = Number(res.headers.get("Retry-After")) || 0;
    return { error: res.status === 429 ? "Kalshi rate-limited" : `Kalshi responded with ${res.status}`, status: res.status, retryAfter: retry };
  }
  return { data: await res.json() };
}

// Cloudflare's Cache API. When the Worker runs outside Cloudflare (for example in tests), there is no cache and we skip it.
const edgeCache = () => (typeof caches !== "undefined" && caches.default) || null;
async function cacheGet(key) {
  const c = edgeCache();
  if (!c) return null;
  const hit = await c.match(key);
  return hit ? withHeader(hit, "X-Cache", "HIT") : null;
}
async function store(key, body, seconds) {
  const response = send(body, 200, seconds);
  const c = edgeCache();
  if (c) await c.put(key, response.clone());
  return response;
}

function withHeader(response, name, value) {
  const copy = new Response(response.body, response);
  copy.headers.set(name, value);
  return copy;
}
function num(v) {
  const n = Number(v);
  return v == null || v === "" || !Number.isFinite(n) ? null : n;
}
function send(body, status, maxAge = 30) {
  return new Response(body == null ? null : JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": `max-age=${maxAge}` },
  });
}
