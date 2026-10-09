// BananaBets Kalshi proxy (Cloudflare Worker).
// Read-only: it only fetches public Kalshi market prices and price history, and passes tidy copies to the site.
// Kalshi refuses requests that come from a website, so this runs on Cloudflare's servers instead.
// It never places orders and never holds an account or key.
//
// Routes:
//   /markets?league=nfl|nba|mlb|ufc   open markets: game winners, spreads and totals
//   /history?ticker=TICKER&days=N      price history for one market (for the trend chart)

const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";
const SERIES = {
  nfl: ["KXNFLGAME", "KXNFLSPREAD", "KXNFLTOTAL"],
  nba: ["KXNBAGAME", "KXNBASPREAD", "KXNBATOTAL"],
  mlb: ["KXMLBGAME", "KXMLBSPREAD", "KXMLBTOTAL"],
  ufc: ["KXUFCFIGHT"],
};
const KIND = { GAME: "win", FIGHT: "win", SPREAD: "spread", TOTAL: "total" };
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const MARKETS_TTL_MS = 60_000;  // shortcut: in-memory cache for market lists, so visits don't hit Kalshi each time; raise if Kalshi rate-limits
const HISTORY_TTL_MS = 300_000; // shortcut: history changes slowly, so 5 minutes is fine
const cache = new Map();
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
  const key = "markets:" + league;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < MARKETS_TTL_MS) return send(hit.body, 200);

  const lists = await Promise.all(series.map((s) => kalshiGet(`${KALSHI}/markets?series_ticker=${s}&status=open&limit=200`)));
  if (lists.some((r) => r.error)) return send({ error: lists.find((r) => r.error).error }, 502);

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
  cache.set(key, { at: Date.now(), body });
  return send(body, 200);
}

async function history(ticker, days) {
  if (!/^[A-Z0-9][A-Z0-9-]{3,80}$/.test(ticker)) return send({ error: "Bad ticker" }, 400);
  const series = ticker.split("-")[0];
  const window = Math.min(Math.max(days, 1), 30);
  const key = `history:${ticker}:${window}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < HISTORY_TTL_MS) return send(hit.body, 200);

  const end = Math.floor(Date.now() / 1000);
  const start = end - window * 86400;
  const interval = window <= 7 ? 60 : 1440;                         // Kalshi accepts only 1, 60 or 1440 minutes between points
  const r = await kalshiGet(`${KALSHI}/series/${series}/markets/${ticker}/candlesticks?start_ts=${start}&end_ts=${end}&period_interval=${interval}`);
  if (r.error) return send({ error: r.error }, 502);

  const points = (r.data.candlesticks || []).map((c) => {
    const trade = num(c.price && c.price.close_dollars);
    const bid = num(c.yes_bid && c.yes_bid.close_dollars), ask = num(c.yes_ask && c.yes_ask.close_dollars);
    const p = trade ?? (bid != null && ask != null ? (bid + ask) / 2 : null);
    return { t: c.end_period_ts, p };
  }).filter((x) => x.p != null);
  const body = { ticker, days: window, points };
  cache.set(key, { at: Date.now(), body });
  return send(body, 200);
}

async function kalshiGet(url) {
  let res;
  try {
    res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  } catch (e) {
    return { error: "Kalshi could not be reached" };
  }
  if (!res.ok) return { error: `Kalshi responded with ${res.status}` };
  return { data: await res.json() };
}

function num(v) {
  const n = Number(v);
  return v == null || v === "" || !Number.isFinite(n) ? null : n;
}
function send(body, status) {
  return new Response(body == null ? null : JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "max-age=30" },
  });
}
