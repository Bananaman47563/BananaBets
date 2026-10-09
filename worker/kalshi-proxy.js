// BananaBets Kalshi proxy (Cloudflare Worker).
// Read-only: it only fetches public Kalshi market prices and passes a tidy copy to the site.
// Kalshi refuses requests that come from a website, so this runs on Cloudflare's servers instead.
// It never places orders and never holds an account or key.

const KALSHI = "https://api.elections.kalshi.com/trade-api/v2/markets";
const SERIES = { nfl: "KXNFLGAME", nba: "KXNBAGAME", mlb: "KXMLBGAME", ufc: "KXUFCFIGHT" };
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const TTL_MS = 60_000;               // shortcut: in-memory cache per league, so repeated visits don't hit Kalshi each time; raise if Kalshi rate-limits
const cache = new Map();
const CORS = {
  "Access-Control-Allow-Origin": "*",          // public, read-only data; tighten to your GitHub Pages address if you like
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "GET") return send({ error: "Only GET is allowed" }, 405);

    const url = new URL(request.url);
    if (url.pathname !== "/markets") return send({ error: "Use /markets?league=nfl|nba|mlb|ufc" }, 404);

    const league = url.searchParams.get("league") || "";
    const series = SERIES[league];
    if (!series) return send({ error: "Unknown league. Use nfl, nba, mlb or ufc." }, 400);

    const hit = cache.get(league);
    if (hit && Date.now() - hit.at < TTL_MS) return send(hit.body, 200);

    let res;
    try {
      res = await fetch(`${KALSHI}?series_ticker=${series}&status=open&limit=200`, {
        headers: { "User-Agent": UA, Accept: "application/json" },
      });
    } catch (e) {
      return send({ error: "Kalshi could not be reached" }, 502);
    }
    if (!res.ok) return send({ error: `Kalshi responded with ${res.status}` }, 502);

    const data = await res.json();
    const body = {
      league,
      series,
      fetched_at: new Date().toISOString(),
      markets: (data.markets || []).map((m) => ({
        ticker: m.ticker,
        event: m.event_ticker,
        outcome: m.yes_sub_title || m.title || "",
        yes_bid: num(m.yes_bid_dollars),
        yes_ask: num(m.yes_ask_dollars),
        last: num(m.last_price_dollars),
        previous: num(m.previous_price_dollars),
        volume: num(m.volume_fp),
        close_time: m.close_time || null,
      })),
    };
    cache.set(league, { at: Date.now(), body });
    return send(body, 200);
  },
};

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function send(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "max-age=30" },
  });
}
