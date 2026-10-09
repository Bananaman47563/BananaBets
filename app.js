/* BananaBets: single-page site.
   DATA section: every outside call lives here (ESPN, the Kalshi proxy and the history files), so it's easy to fix if one changes. */
"use strict";

/* ---------- DATA: ESPN public (unofficial) site API ---------- */
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/";
const LEAGUES = {
  nfl: { path: "football/nfl", name: "NFL", kind: "team", period: 15, length: 60, periods: 4 },
  nba: { path: "basketball/nba", name: "NBA", kind: "team", period: 12, length: 48, periods: 4 },
  mlb: { path: "baseball/mlb", name: "MLB", kind: "team" },
  ufc: { path: "mma/ufc", name: "UFC", kind: "fight" },
};
const NATIONAL_NETWORKS = ["ESPN", "ABC", "NBC", "FOX", "CBS", "Prime", "NFL Network", "TNT", "truTV", "NBA TV", "MLBN", "Netflix"];
const TZ = "America/Chicago";
const SETTINGS_KEY = "bananabets.settings";
// edgeThreshold: flag when the model and the sportsbook differ by this many points. 10 is what the backtest supports (see scripts/backtest_nfl.py).
const DEFAULTS = { edgeThreshold: 10, kalshiProxy: "" };   // kalshiProxy: address of your Cloudflare Worker (worker/SETUP.md)

const cache = new Map();                                    // url -> { at, data }; avoids duplicate requests
async function getJSON(url, { maxAgeMs = 10000 } = {}) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.data;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`responded ${r.status}`);
    const data = await r.json();
    cache.set(url, { at: Date.now(), data });
    return data;
  } finally { clearTimeout(timer); }
}

const ymd = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d).replaceAll("-", "");
const dayKey = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const centralHour = (iso) => Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(new Date(iso)));

// ESPN's date-range form no longer works, so the week view asks for each of the next 8 days and merges them.
async function scoreboard(key, { week = false } = {}) {
  const days = week ? Array.from({ length: 8 }, (_, i) => ymd(new Date(Date.now() + i * 86400000))) : [null];
  const pages = await Promise.all(days.map((d) => getJSON(ESPN + LEAGUES[key].path + "/scoreboard" + (d ? `?dates=${d}` : ""))));
  const seen = new Map();
  for (const raw of pages) for (const e of raw.events || []) if (!seen.has(e.id)) seen.set(e.id, normalizeEvent(key, e));
  return [...seen.values()];
}
async function summary(key, id) {
  return getJSON(`${ESPN}${LEAGUES[key].path}/summary?event=${encodeURIComponent(id)}`, { maxAgeMs: 120000 });
}

function normalizeEvent(key, e) {
  const comp = (e.competitions || [])[0] || {};
  const st = e.status || {};
  const type = st.type || {};
  const base = {
    league: key, id: e.id, name: e.name || e.shortName || "", date: e.date,
    state: type.state || "pre", completed: !!type.completed,
    detail: type.shortDetail || type.detail || "", period: st.period || 0, clock: st.displayClock || "",
    playoff: !!e.season && e.season.type === 3,
    preseason: !!e.season && e.season.type === 1,
    week: e.week ? e.week.number : null,
    broadcasts: (comp.broadcasts || []).flatMap((b) => b.names || []),
    headline: (comp.notes || []).map((n) => n.headline).filter(Boolean)[0] || "",
  };
  if (LEAGUES[key].kind === "fight") {
    // ESPN lists the card with the main event last, so the last bout is the main event.
    return { ...base, name: e.name, fights: (e.competitions || []).map(normalizeFight) };
  }
  const sides = comp.competitors || [];
  const home = sides.find((c) => c.homeAway === "home") || {};
  const away = sides.find((c) => c.homeAway === "away") || {};
  const o = (comp.odds || [])[0] || null;
  return {
    ...base,
    away: normalizeTeam(away), home: normalizeTeam(home),
    odds: o && {
      provider: (o.provider && o.provider.name) || "",
      spread: o.spread ?? null,                    // home team's spread (NFL, NBA); MLB uses the run line below
      total: o.overUnder ?? null,
      homeML: priceOf(o.moneyline && o.moneyline.home), awayML: priceOf(o.moneyline && o.moneyline.away),
      openHomeML: priceOf(o.moneyline && o.moneyline.home, "open"), openAwayML: priceOf(o.moneyline && o.moneyline.away, "open"),
      homeSpreadPrice: priceOf(o.pointSpread && o.pointSpread.home), awaySpreadPrice: priceOf(o.pointSpread && o.pointSpread.away),
      openSpread: lineOf(o.pointSpread && o.pointSpread.home, "open"), openHomeSpreadPrice: priceOf(o.pointSpread && o.pointSpread.home, "open"),
      overPrice: priceOf(o.total && o.total.over), underPrice: priceOf(o.total && o.total.under),
      openTotal: lineOf(o.total && o.total.over, "open"), openOverPrice: priceOf(o.total && o.total.over, "open"),
      runline: key === "mlb" ? { homeLine: lineOf(o.pointSpread && o.pointSpread.home, "close") } : null,
    },
  };
}
// ESPN gives prices as text such as "-395" under moneyline.home.close.odds (or .open). EVEN means +100.
function priceOf(side, which = "close") {
  if (!side) return null;
  const node = which === "open" ? side.open : (side.current || side.close);
  const raw = node && node.odds;
  if (raw == null) return null;
  if (String(raw).toUpperCase() === "EVEN") return 100;
  const n = Number(String(raw).replace("+", ""));
  return Number.isFinite(n) && Math.abs(n) >= 100 ? n : null;
}
function lineOf(side, which = "close") {
  if (!side) return null;
  const node = which === "open" ? side.open : (side.current || side.close);
  const n = node && node.line != null ? Number(String(node.line).replace(/^[ou]/i, "")) : null;
  return Number.isFinite(n) ? n : null;
}
function normalizeTeam(c) {
  const t = c.team || {};
  return {
    name: t.displayName || t.shortDisplayName || "TBD", abbr: t.abbreviation || "",
    logo: t.logo || (t.logos && t.logos[0] && t.logos[0].href) || "", logoAlt: t.logoDark || "",
    score: c.score ?? null, record: (c.records || [])[0]?.summary || "", winner: !!c.winner,
  };
}
function normalizeFight(c) {
  const side = (x) => ({ name: x.athlete?.displayName || "TBD", logo: x.athlete?.headshot?.href || "", winner: !!x.winner, record: (x.records || [])[0]?.summary || "" });
  const f = c.competitors || [];
  return { id: c.id, a: side(f[0] || {}), b: side(f[1] || {}), state: c.status?.type?.state || "pre", detail: c.status?.type?.shortDetail || "", method: c.status?.type?.description || "", weight: c.type?.text || "" };
}

/* History files, calibration numbers and the Kalshi proxy (all read-only) */
const modelCache = {};
async function loadHistory(key) {
  if (!modelCache[key]) {
    modelCache[key] = fetch(`data/${key}.json`).then((r) => {
      if (!r.ok) throw new Error(`history file data/${key}.json is missing`);
      return r.json();
    }).then((d) => ({ ...d, rows: d.games.map((g) => ({ date: g[0], home: g[1], away: g[2], hs: g[3], as: g[4], type: g[5], season: g[6] })) }));
  }
  return modelCache[key];
}
let calibrationCache = null;
async function loadCalibration() {
  if (!calibrationCache) calibrationCache = fetch("data/calibration.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return calibrationCache;
}
const kalshiProxy = () => (settings().kalshiProxy || "").trim().replace(/\/+$/, "");
async function kalshiMarkets(key) {
  return getJSON(`${kalshiProxy()}/markets?league=${key}`, { maxAgeMs: 30000 });
}
async function kalshiHistory(ticker, days = 7) {
  return getJSON(`${kalshiProxy()}/history?ticker=${encodeURIComponent(ticker)}&days=${days}`, { maxAgeMs: 120000 });
}

/* ---------- helpers ---------- */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtTime = (iso) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(iso));
const fmtDay = (iso) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long", month: "short", day: "numeric" }).format(new Date(iso));
const todayKey = () => dayKey(new Date());
const signedNum = (n) => (n == null ? "—" : (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n));
const american = (n) => (n == null ? "—" : (n > 0 ? "+" : "") + n);
const pctTxt = (p) => (p == null ? "—" : Math.round(p * 100) + "%");
function settings() { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") }; } catch (e) { return { ...DEFAULTS }; } }
function saveSettings(s) { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* private mode: keep going */ } }
function daysBetween(a, b) { return (Date.parse(b) - Date.parse(a)) / 86400000; }
function erf(x) {                                   // Abramowitz and Stegun 7.1.26
  const s = Math.sign(x), t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
const phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
function impliedFromAmerican(a) { return a > 0 ? 100 / (a + 100) : -a / (-a + 100); }
// Sportsbook probabilities with the bookmaker margin removed.
function noVig2(a, b) {
  if (a == null || b == null) return null;
  const p = impliedFromAmerican(a), q = impliedFromAmerican(b), t = p + q;
  return { first: p / t, second: q / t };
}

function isLive(ev) { return ev.state === "in"; }
function isCloseLate(ev) {
  if (!isLive(ev) || !ev.home || ev.home.score == null) return false;
  const diff = Math.abs(Number(ev.home.score) - Number(ev.away.score));
  if (ev.league === "mlb") return ev.period >= 9 && diff <= 1;
  if (ev.league === "nfl" || ev.league === "nba") return ev.period >= 4 && diff <= 8;
  return false;
}
function statusChip(ev) {
  if (isLive(ev)) return `<span class="chip live">LIVE · ${esc(ev.detail)}</span>`;
  if (ev.completed) return `<span class="chip final">Final</span>`;
  return `<span class="chip">${esc(fmtTime(ev.date))}</span>`;
}
// Logos: if one fails to load, the error handler swaps in the team's abbreviation (after trying the dark-mode logo).
function logoHtml(team) {
  if (!team.logo) return `<span class="badge">${esc(team.abbr || "?")}</span>`;
  return `<img class="logo" src="${esc(team.logo)}" data-alt="${esc(team.logoAlt || "")}" data-abbr="${esc(team.abbr || "?")}" alt="" loading="lazy">`;
}
document.addEventListener("error", (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.classList.contains("logo")) return;
  if (img.dataset.alt && img.src !== img.dataset.alt) { img.src = img.dataset.alt; return; }
  const b = document.createElement("span");
  b.className = "badge";
  b.textContent = img.dataset.abbr || "?";
  img.replaceWith(b);
}, true);

/* ---------- cards ---------- */
function teamCard(ev) {
  const h = ev.home, a = ev.away;
  const row = (t) => `<div class="team ${t.winner ? "winner" : (ev.completed && !t.winner ? "loser" : "")}">
      ${logoHtml(t)}
      <div><div class="name">${esc(t.name)}</div>${t.record ? `<div class="muted">${esc(t.record)}</div>` : ""}</div>
      <div class="score">${t.score == null || ev.state === "pre" ? "" : esc(t.score)}</div></div>`;
  const o = ev.odds;
  let lines = `<div class="muted" style="margin-top:8px">No pregame odds listed</div>`;
  if (o) {
    const spread = ev.league === "mlb" && o.runline
      ? `Run line <b>${esc(h.abbr)} ${signedNum(o.runline.homeLine)}</b>`
      : `Spread <b>${esc(h.abbr)} ${signedNum(o.spread)}</b>`;
    lines = `<div class="lines"><span>${spread}</span><span>Total <b>${esc(o.total ?? "—")}</b></span>
      <span>ML <b>${esc(american(o.awayML))} / ${esc(american(o.homeML))}</b></span><span class="muted">${esc(o.provider)}</span></div>`;
  }
  const big = (ev.playoff || isCloseLate(ev)) && !ev.preseason;
  return `<a class="card game ${isLive(ev) ? "live" : ""} ${big ? "big" : ""}" href="#/game/${ev.league}/${esc(ev.id)}">
    <div class="kicker"><span>${esc(LEAGUES[ev.league].name)}${ev.playoff ? " · Playoffs" : ""}${ev.preseason ? " · Preseason" : ""}</span>${statusChip(ev)}</div>
    ${ev.headline ? `<div class="muted">${esc(ev.headline)}</div>` : ""}
    <div class="teams">${row(a)}${row(h)}</div>${lines}</a>`;
}
function fightCard(ev) {
  const fights = ev.fights || [];
  const main = fights[fights.length - 1];                // last bout on ESPN's card is the main event
  return `<div class="card ${isLive(ev) ? "live" : ""}">
    <div class="kicker"><span>UFC · ${esc(ev.name)}</span>${isLive(ev) ? `<span class="chip live">LIVE</span>` : ""}</div>
    ${main ? `<div class="muted">Main event</div>${fightRow(main)}` : `<div class="muted">No fights listed.</div>`}
    <div class="muted" style="margin-top:8px">${esc(fmtTime(ev.date))} · ${fights.length} bouts · ${ev.completed ? "event complete" : "upcoming"}</div></div>`;
}
function fightRow(f) {
  const side = (x) => `<div class="team ${x.winner ? "winner" : (f.state === "post" && !x.winner ? "loser" : "")}">
    ${x.logo ? `<img class="logo" src="${esc(x.logo)}" alt="" loading="lazy">` : `<span class="badge">UFC</span>`}<div><div class="name">${esc(x.name)}</div><div class="muted">${esc(x.record)}</div></div><span></span></div>`;
  return `<div class="teams">${side(f.a)}${side(f.b)}</div><div class="muted" style="margin-top:6px">${esc(f.weight)}${f.method ? ` · ${esc(f.method)}` : ""} ${f.detail ? `· ${esc(f.detail)}` : ""}</div>`;
}

/* ---------- pages: Home, leagues, game ---------- */
async function pageHome() {
  const all = (await Promise.all(Object.keys(LEAGUES).map((k) => scoreboard(k).catch(() => [])))).flat();
  const teamEvents = all.filter((e) => LEAGUES[e.league].kind === "team");
  const playoffs = teamEvents.filter((e) => e.playoff);
  const primetime = teamEvents.filter((e) => !e.playoff && !e.preseason && !e.completed
    && e.broadcasts.some((b) => NATIONAL_NETWORKS.some((n) => b.includes(n))) && centralHour(e.date) >= 18);
  const close = teamEvents.filter(isCloseLate);
  const ufc = all.filter((e) => e.league === "ufc").slice(0, 1);
  const section = (title, items, render) => items.length ? `<h2>${title}</h2><div class="grid two">${items.map(render).join("")}</div>` : "";
  const html = [
    section("Live and close late", close, teamCard),
    section("Playoffs", playoffs, teamCard),
    section("Primetime national TV", primetime.slice(0, 6), teamCard),
    section("UFC main event", ufc, fightCard),
  ].join("");
  return `<h1>Big games</h1><p class="muted">Playoffs, primetime national TV (regular season only), the UFC main event, and live games close late. The primetime test uses a list of national networks and an evening Central start; it's approximate.</p>
    ${html || `<div class="empty">Nothing big right now. Check the league tabs for today's games.</div>`}`;
}

async function pageLeague(key) {
  const meta = LEAGUES[key];
  const events = await scoreboard(key, { week: true });
  if (meta.kind === "fight") {
    if (!events.length) return `<h1>UFC</h1><div class="empty">No UFC events listed by ESPN right now.</div>`;
    return `<h1>UFC</h1><p class="muted">Cards from ESPN. Win odds for fights aren't in ESPN's public feed yet.</p><div class="grid">${events.map(fightCard).join("")}</div>`;
  }
  if (!events.length) return `<h1>${meta.name}</h1><div class="empty">No ${meta.name} games listed for the next 7 days.</div>`;
  const byDay = {};
  for (const e of events) (byDay[dayKey(new Date(e.date))] ||= []).push(e);
  return `<h1>${meta.name}</h1><p class="muted">Today and the next 7 days, Central time.</p>
    ${Object.keys(byDay).sort().map((d) => {
      const list = byDay[d];
      const label = d === todayKey() ? "Today" : fmtDay(list[0].date);
      return `<h2>${esc(label)}</h2><div class="grid two">${list.map(teamCard).join("")}</div>`;
    }).join("")}`;
}

async function pageGame(key, id) {
  const meta = LEAGUES[key];
  if (meta.kind === "fight") return `<h1>UFC bout</h1><p class="muted">Bout details (rounds, method, strikes) aren't wired up yet. See the event card on the UFC tab.</p>`;
  const s = await summary(key, id);
  const header = (s.header?.competitions || [])[0] || {};
  const comps = header.competitors || [];
  const home = comps.find((c) => c.homeAway === "home") || {}, away = comps.find((c) => c.homeAway === "away") || {};
  const st = header.status?.type || {};
  const wp = (s.winprobability || []).map((p) => p.homeWinPercentage).filter((v) => v != null);
  const wpLast = wp.length ? wp[wp.length - 1] : null;

  const leaders = (s.leaders || []).map((t) => `<div class="card"><h3>${esc(t.team?.displayName || "")}</h3>
      ${(t.leaders || []).map((cat) => { const l = (cat.leaders || [])[0] || {}; return `<div class="lines"><span>${esc(cat.displayName || cat.name || "")}</span><b>${esc(l.athlete?.displayName || "")}</b><span>${esc(l.displayValue || "")}</span></div>`; }).join("")}
      </div>`).join("");
  const groups = (s.boxscore?.players || []).map((team) => (team.statistics || []).map((grp) => {
    const labels = grp.labels || grp.keys || [];
    const rows = (grp.athletes || []).map((a) => `<tr><td>${esc(a.athlete?.displayName || "")}</td>${(a.stats || []).map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`).join("");
    return `<h3>${esc(team.team?.displayName || "")} · ${esc(grp.name || grp.displayName || "")}</h3><div class="scroll"><table class="stat-table"><thead><tr><th>Player</th>${labels.map((l) => `<th>${esc(l)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }).join("")).join("");
  const teamStats = (s.boxscore?.teams || []).map((t) => `<div class="card"><h3>${esc(t.team?.displayName || "")}</h3>${(t.statistics || []).map((x) => `<div class="lines"><span>${esc(x.label)}</span><b>${esc(x.displayValue)}</b></div>`).join("")}</div>`).join("");
  const inj = (s.injuries || []).map((t) => `<div class="card"><h3>${esc(t.displayName || t.team?.displayName || "")}</h3>${(t.injuries || []).map((i) => `<div class="lines"><span>${esc(i.athlete?.displayName || "")}</span><b>${esc(i.status || i.type?.description || "")}</b></div>`).join("") || `<span class="muted">No injuries listed</span>`}</div>`).join("");
  const chart = wp.length > 1 ? winChart(wp) : `<div class="empty">Win probability history appears once the game has started.</div>`;
  return `<a href="#/${key}">← ${meta.name}</a>
    <h1>${esc(away.team?.displayName || "")} at ${esc(home.team?.displayName || "")}</h1>
    <p class="muted">${esc(st.shortDetail || st.detail || "")}${header.date ? ` · ${esc(fmtTime(header.date))}` : ""}</p>
    <div class="card"><div class="teams">
      <div class="team"><span class="badge">${esc(away.team?.abbreviation || "A")}</span><div class="name">${esc(away.team?.displayName || "")}</div><div class="score">${esc(away.score ?? "")}</div></div>
      <div class="team"><span class="badge">${esc(home.team?.abbreviation || "H")}</span><div class="name">${esc(home.team?.displayName || "")}</div><div class="score">${esc(home.score ?? "")}</div></div>
    </div>
    ${wpLast != null ? `<div class="wpbar"><i class="a" style="width:${((1 - wpLast) * 100).toFixed(1)}%"></i><i class="h" style="width:${(wpLast * 100).toFixed(1)}%"></i></div>
    <div class="wplabel"><span>${esc(away.team?.abbreviation || "Away")} ${((1 - wpLast) * 100).toFixed(0)}%</span><span>${esc(home.team?.abbreviation || "Home")} ${(wpLast * 100).toFixed(0)}%</span></div>
    <p class="muted" style="margin:6px 0 0">ESPN's live win probability.</p>` : `<p class="muted">Win probability not available for this game.</p>`}
    </div>
    <h2>Win probability over time</h2>${chart}
    <h2>Key leaders</h2><div class="grid two">${leaders || `<div class="empty">Leaders appear once games start.</div>`}</div>
    <div style="margin-top:14px"><button class="toggle" id="showall" type="button" aria-expanded="false">Show all stats</button></div>
    <div id="allstats" hidden>
      <h2>Team stats</h2><div class="grid two">${teamStats}</div>
      <h2>Box score</h2>${groups || `<div class="empty">Box score appears once the game starts.</div>`}
    </div>
    <h2>Injuries</h2><div class="grid two">${inj || `<div class="empty">No injury report from ESPN for this game.</div>`}</div>`;
}
function winChart(vals) {
  const w = 640, h = 220, pad = 30;
  const x = (i) => pad + (i / (vals.length - 1)) * (w - pad * 2);
  const y = (v) => pad + (1 - v) * (h - pad * 2);
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return `<svg class="wp" viewBox="0 0 ${w} ${h}" role="img" aria-label="Home team win probability over the game">
    <line x1="${pad}" y1="${y(0.5)}" x2="${w - pad}" y2="${y(0.5)}" stroke="#d9c86b" stroke-dasharray="4 4"/>
    <text x="${pad}" y="${pad - 8}">Home win %</text><text x="${w - pad}" y="${h - 8}" text-anchor="end">Start → end</text>
    <text x="4" y="${y(1) + 4}">100%</text><text x="4" y="${y(0) + 4}">0%</text>
    <polyline points="${pts}" fill="none" stroke="#c79a00" stroke-width="2.5"/></svg>`;
}

/* ---------- Predictions: power ratings from history, injuries, confidence, live update ---------- */
// NFL settings come from scripts/backtest_nfl.py (walk-forward, tested on 2023-2025 seasons the grid never saw).
// NBA settings are NOT calibrated yet (no historical odds to test against); they are placeholders.
const MODEL = {
  nfl: { halfLife: 180, shrink: 4, sigma: 11.5, totalSigma: 13.5, qbEffect: -2.9, minGames: [4, 8], calibrated: true },
  nba: { halfLife: 120, shrink: 12, sigma: 12.5, totalSigma: 15, qbEffect: 0, minGames: [12, 30], calibrated: false },
};
// Weighted points-for and points-against per team (recent games count more), turned into offense and defense ratings.
function buildRatings(key, hist) {
  const cfg = MODEL[key];
  const asOf = todayKey();
  const current = Math.max(...hist.rows.map((r) => r.season));
  const teams = {};
  const T = (t) => (teams[t] ||= { w: 0, pf: 0, pa: 0, gp: 0 });
  let sw = 0, sm = 0, hfaSum = 0, n = 0, seasonStart = null;
  for (const g of hist.rows) {
    if (g.date > asOf) continue;
    const w = Math.pow(0.5, daysBetween(g.date, asOf) / cfg.halfLife);
    const h = T(g.home), a = T(g.away);
    h.w += w; a.w += w; h.pf += w * g.hs; h.pa += w * g.as; a.pf += w * g.as; a.pa += w * g.hs;
    if (g.season === current) { h.gp++; a.gp++; if (!seasonStart || g.date < seasonStart) seasonStart = g.date; }
    sw += w; sm += w * (g.hs + g.as) / 2; hfaSum += w * (g.hs - g.as); n++;
  }
  const mu = sw ? sm / sw : 0, hfa = sw ? hfaSum / sw : 0;
  for (const t of Object.values(teams)) {
    t.off = (t.pf - t.w * mu) / (t.w + cfg.shrink);
    t.def = (t.pa - t.w * mu) / (t.w + cfg.shrink);
  }
  return { mu, hfa, teams, current, cfg, games: n, seasonStart: seasonStart || asOf, weeksIntoSeason: seasonStart ? daysBetween(seasonStart, asOf) / 7 : 0 };
}
function h2hRows(hist, current, a, b) {
  return hist.rows.filter((g) => g.season >= current - 2 && ((g.home === a && g.away === b) || (g.home === b && g.away === a)));
}
// Injury status for each team's starting quarterback, from ESPN's current injury report.
// Returns { [teamAbbr]: "out" | "questionable" } for QBs Out/Doubtful (out) or Questionable (questionable).
async function qbStatuses(key, id) {
  const s = await summary(key, id).catch(() => null);
  const out = {};
  for (const block of (s && s.injuries) || []) {
    const abbr = (block.team && block.team.abbreviation) || "";
    for (const i of block.injuries || []) {
      const pos = i.athlete && i.athlete.position && i.athlete.position.abbreviation;
      if (pos !== "QB") continue;
      const st = String(i.status || "").toLowerCase();
      if (st === "out" || st === "doubtful" || st === "injured reserve") out[abbr] = "out";
      else if (st === "questionable" && out[abbr] !== "out") out[abbr] = "questionable";
    }
  }
  return out;
}
// Pregame prediction for one upcoming game. Margin is from the home team's side.
function predictGame(key, ratings, hist, ev, qb) {
  const cfg = ratings.cfg;
  const H = ratings.teams[ev.home.abbr] || { off: 0, def: 0, gp: 0 };
  const A = ratings.teams[ev.away.abbr] || { off: 0, def: 0, gp: 0 };
  const eh = ratings.mu + H.off + A.def + ratings.hfa / 2;
  const ea = ratings.mu + A.off + H.def - ratings.hfa / 2;
  const base = eh - ea;
  // Starting quarterback: an Out/Doubtful starter moves the margin by the backtested amount.
  const qbOut = (qb && qb[ev.home.abbr] === "out" ? 1 : 0) - (qb && qb[ev.away.abbr] === "out" ? 1 : 0);
  const qbShift = cfg.qbEffect * qbOut;
  // Head-to-head: counts, but lightly (at most 2 points either way).
  const meets = h2hRows(hist, ratings.current, ev.home.abbr, ev.away.abbr);
  const h2hMargin = meets.length ? meets.reduce((s, g) => s + (g.home === ev.home.abbr ? g.hs - g.as : g.as - g.hs), 0) / meets.length : null;
  const h2hAdj = h2hMargin == null ? 0 : Math.max(-2, Math.min(2, 0.15 * (h2hMargin - base)));
  const margin = base + qbShift + h2hAdj;
  const sigma = cfg.sigma;
  const gp = Math.min(H.gp, A.gp);
  const [lo, hi] = cfg.minGames;
  const pct = phi(margin / sigma);
  const book = bookHome(ev);
  const gapPts = book == null ? null : Math.abs(pct - book) * 100;
  const confidence = confidenceFor({ gp, lo, hi, qb: qb || {}, home: ev.home.abbr, away: ev.away.abbr, weeksIntoSeason: ratings.weeksIntoSeason, calibrated: cfg.calibrated, gapPts });
  return {
    pct, margin, spreadHome: Math.round(-margin * 2) / 2, total: eh + ea,
    eh, ea, H, A, h2hMargin, h2hAdj, meets: meets.length, gp, confidence, sigma, hfa: ratings.hfa,
    qbShift, qbStatus: { home: (qb || {})[ev.home.abbr] || null, away: (qb || {})[ev.away.abbr] || null },
    earlySeason: gp < lo, calibrated: cfg.calibrated,
  };
}
// Confidence is a score built from things we can measure. Each point of uncertainty adds to it.
//  +2 / +1   games played this season for the less-played team (under the low / middle cut-off)
//  +1        early in the season (first 4 weeks)
//  +1        a starting QB is Out/Doubtful, or Questionable (who plays is unknown)
//  +1        the model disagrees with the sportsbook by 10 points or more
//  +1        the model is not calibrated for this league (NBA for now)
// 0 High, 1-2 Medium, 3+ Low. Reasons are returned for the Why panel.
function confidenceFor({ gp, lo, hi, qb, home, away, weeksIntoSeason, calibrated, gapPts }) {
  const reasons = [];
  let score = 0;
  const short = Math.min(3, Math.ceil((hi - gp) / 2));   // how far the less-played team is from a full sample: 0 when full, up to 3
  if (short > 0) { score += short; reasons.push(`${gp} games this season for the less-played team (a full sample is ${hi})`); }
  if (weeksIntoSeason < 4) { score += 1; reasons.push("early in the season, when ratings rest on less data"); }
  const q = [home, away].filter((t) => qb[t]);
  if (q.length) { score += 1; reasons.push(`QB status uncertain: ${q.map((t) => `${t} ${qb[t] === "out" ? "out/doubtful" : "questionable"}`).join(", ")}`); }
  if (gapPts != null && gapPts >= 10) { score += 1; reasons.push(`${Math.round(gapPts)} points away from the sportsbook`); }
  if (!calibrated) { score += 1; reasons.push("not backtested against sportsbook prices yet"); }
  const label = score === 0 ? "High" : score <= 2 ? "Medium" : "Low";
  return { label, score, reasons };
}
// Live update: remaining game share scales the pregame margin, and the score so far counts fully.
function minutesLeftFraction(ev) {
  const L = LEAGUES[ev.league];
  if (!L.length || ev.period < 1) return null;
  const parts = String(ev.clock || "").split(":").map(Number);
  if (parts.length !== 2 || parts.some((x) => !Number.isFinite(x))) return null;
  const clockMin = parts[0] + parts[1] / 60;
  const left = ev.period <= L.periods ? (L.periods - ev.period) * L.period + clockMin : clockMin;
  return Math.max(0, Math.min(1, left / L.length));
}
function liveWinPct(pred, ev) {
  const f = minutesLeftFraction(ev);
  if (f == null || !isLive(ev) || ev.home.score == null) return null;
  const d = Number(ev.home.score) - Number(ev.away.score);
  if (f === 0) return d > 0 ? 1 : d < 0 ? 0 : 0.5;
  return phi((d + pred.margin * f) / (pred.sigma * Math.sqrt(f)));
}
const bookHome = (ev) => (ev.odds ? (noVig2(ev.odds.awayML, ev.odds.homeML) || {}).second ?? null : null);

// Predictions for NFL and NBA only in this version. Returns { [eventId]: prediction }.
async function predictionsFor(events) {
  const out = {};
  for (const key of ["nfl", "nba"]) {
    const mine = events.filter((e) => e.league === key && !e.completed && !e.preseason);
    if (!mine.length) continue;
    const hist = await loadHistory(key);
    const ratings = buildRatings(key, hist);
    for (const ev of mine) {
      const qb = key === "nfl" ? await qbStatuses(key, ev.id) : {};
      const p = predictGame(key, ratings, hist, ev, qb);
      out[ev.id] = { ...p, live: liveWinPct(p, ev), league: key };
    }
  }
  return out;
}

async function pagePredictions() {
  const threshold = settings().edgeThreshold;
  const events = (await Promise.all(["nfl", "nba"].map((k) => scoreboard(k, { week: true }).catch(() => [])))).flat();
  const preds = await predictionsFor(events);
  const list = events.filter((e) => preds[e.id]);
  const cal = await loadCalibration();
  if (!list.length) return `<h1>Predictions</h1><div class="empty">No upcoming NFL or NBA games in the next 7 days.</div>`;
  const sections = ["nfl", "nba"].map((k) => {
    const games = list.filter((e) => e.league === k).sort((a, b) => a.date.localeCompare(b.date));
    if (!games.length) return "";
    const note = MODEL[k].calibrated ? "" : ` <span class="chip">Not yet calibrated</span>`;
    return `<h2>${LEAGUES[k].name}${note}</h2>
      <p class="muted">Each % is the chance the home team wins. Tap "Why" for the reasons and the injury check.</p>
      <div class="grid two">${games.map((e) => predictionCard(e, preds[e.id], threshold)).join("")}</div>`;
  }).join("");
  return `<h1>Predictions</h1>
    <p class="muted">Statistical estimates from each team's recent points scored and allowed, the starting QB, and home-field advantage. Live games update from the score.</p>
    ${calibrationNote(cal)}
    ${sections}`;
}
function calibrationNote(cal) {
  if (!cal) return `<div class="note warn">Calibration results aren't loaded (data/calibration.json).</div>`;
  const t = cal.test, b = cal.test_blended;
  return `<div class="note"><b>How good is the NFL model?</b> Tested on the 2023–2025 seasons, which were not used to set it (${cal.test.n} games).
    Lower log loss is better. BananaBets: <b>${t.model_logloss.toFixed(3)}</b>. The sportsbook's closing moneyline (vig removed): <b>${t.market_logloss.toFixed(3)}</b>.
    On this test the sportsbook was more accurate than the model, so flagged games are more often wrong than right.
    The best blend found used ${Math.round(cal.model_weight_in_blend * 100)}% model, so this model adds no information beyond the sportsbook yet.</div>`;
}
function predictionCard(ev, p, threshold) {
  const homeNow = p.live != null ? p.live : p.pct;
  const book = bookHome(ev);
  const gap = book == null ? null : Math.round((p.pct - book) * 100);
  const flag = gap != null && Math.abs(gap) >= threshold
    ? `<span class="chip tag-medium">Differs from sportsbook by ${Math.abs(gap)} pts</span>` : "";
  const conf = `<span class="chip tag-${p.confidence.label.toLowerCase()}">${p.confidence.label} confidence</span>`;
  const id = `why-${ev.id}`;
  return `<div class="card ${isLive(ev) ? "live" : ""}">
    <div class="kicker"><span>${esc(LEAGUES[ev.league].name)}${ev.playoff ? " · Playoffs" : ""}</span>${statusChip(ev)}</div>
    <div class="teams">
      <div class="team">${logoHtml(ev.away)}<div><div class="name">${esc(ev.away.name)}</div></div><span></span></div>
      <div class="team">${logoHtml(ev.home)}<div><div class="name">${esc(ev.home.name)}</div></div><span></span></div>
    </div>
    <div class="wpbar"><i class="a" style="width:${((1 - homeNow) * 100).toFixed(1)}%"></i><i class="h" style="width:${(homeNow * 100).toFixed(1)}%"></i></div>
    <div class="wplabel"><span>${esc(ev.away.abbr)} ${((1 - homeNow) * 100).toFixed(0)}%</span><span>${esc(ev.home.abbr)} ${(homeNow * 100).toFixed(0)}%${p.live != null ? " (live)" : ""}</span></div>
    <div class="lines"><span>Projected spread <b>${esc(ev.home.abbr)} ${signedNum(p.spreadHome)}</b></span><span>Projected total <b>${p.total.toFixed(1)}</b></span></div>
    <div class="row" style="margin-top:8px">${conf} ${flag}</div>
    <button class="toggle" style="margin-top:8px" data-why="${id}" type="button" aria-expanded="false">Why</button>
    <div id="${id}" class="note" hidden>${whyHtml(ev, p)}</div>
  </div>`;
}
function whyHtml(ev, p) {
  const f = (x) => (x >= 0 ? "+" : "") + x.toFixed(1);
  const book = bookHome(ev);
  const qbLine = p.qbShift
    ? `<div><b>Starting QB</b>: ${esc(p.qbStatus.home === "out" ? ev.home.abbr : ev.away.abbr)} starter Out/Doubtful, adjusting the margin by ${f(p.qbShift)} points (backtested effect of a starter change)</div>`
    : `<div><b>Starting QB</b>: no Out/Doubtful starter in ESPN's report${p.qbStatus.home || p.qbStatus.away ? " (a Questionable QB adds uncertainty only)" : ""}</div>`;
  return `<div><b>Expected points</b>: ${esc(ev.home.abbr)} ${p.eh.toFixed(1)}, ${esc(ev.away.abbr)} ${p.ea.toFixed(1)}</div>
    <div><b>Home-field advantage</b>: about ${p.hfa.toFixed(1)} points (league average home margin)</div>
    <div><b>${esc(ev.home.abbr)} offense / defense</b>: ${f(p.H.off)} / ${f(-p.H.def)} points vs league average (defense shown as points saved)</div>
    <div><b>${esc(ev.away.abbr)} offense / defense</b>: ${f(p.A.off)} / ${f(-p.A.def)} points vs league average</div>
    ${qbLine}
    <div><b>Head to head</b>: ${p.meets ? `${p.meets} recent meeting(s), average home margin ${p.h2hMargin.toFixed(1)}; adjusted by ${f(p.h2hAdj)} points` : "no recent meetings in the history"}</div>
    <div><b>Sportsbook (no vig)</b>: ${book == null ? "not listed" : pctTxt(book) + " home"}</div>
    <div><b>Confidence</b>: ${p.confidence.label}. ${p.confidence.reasons.length ? esc(p.confidence.reasons.join("; ")) + "." : "Plenty of games and a current QB report."}</div>
    <div><b>Live</b>: ${p.live != null ? `${pctTxt(p.live)} home, from the current score and time left` : "starts when the game does"}</div>
    <div class="muted" style="margin-top:6px">Not included yet: injuries other than the starting QB, weather, and rest. ${p.calibrated ? "" : "This league's model is not yet calibrated against sportsbook prices."}</div>`;
}

/* ---------- Markets: game-by-game Yes/No rows, with Kalshi when connected ---------- */
const KALSHI_LEAGUES = ["nfl", "nba", "mlb"];
function nameMatch(outcome, teamName) {
  return !!outcome && teamName.toLowerCase().includes(outcome.toLowerCase());
}
function cityOf(name) { return name.split(" ").slice(0, -1).join(" ").toLowerCase(); }
// Which team an outcome refers to. Spread titles start with the city ("Seattle wins by over 7.5 points").
function sideOf(outcome, game) {
  if (!game) return null;
  const exact = [nameMatch(outcome, game.home.name), nameMatch(outcome, game.away.name)];
  if (exact[0] !== exact[1]) return exact[0] ? "home" : "away";
  const o = outcome.toLowerCase();
  const city = [cityOf(game.home.name), cityOf(game.away.name)].map((c) => c && o.startsWith(c));
  if (city[0] !== city[1]) return city[0] ? "home" : "away";
  return null;
}
function kalshiGroupKey(m) { return (m.event || "").split("-").slice(1).join("-"); }
// A Kalshi event group belongs to an ESPN game when both teams appear in its winner outcomes and the dates are close.
function findGame(league, wins, teams) {
  const closeT = wins.map((m) => m.close_time).find(Boolean);
  const names = wins.map((m) => m.outcome);
  return teams.find((e) => e.league === league
    && names.some((n) => nameMatch(n, e.away.name)) && names.some((n) => nameMatch(n, e.home.name))
    && (!closeT || Math.abs(new Date(e.date) - new Date(closeT)) < 6 * 86400000));
}
function yesPrice(m) {
  if (m.last != null) return m.last;
  if (m.yes_bid != null && m.yes_ask != null) return (m.yes_bid + m.yes_ask) / 2;
  return null;
}
const cents = (x) => (x == null ? "—" : Math.round(x * 100) + "¢");
const pct = (x) => (x == null ? "—" : Math.round(x * 100) + "%");
// Map each ESPN game id to its Kalshi markets (grouped), for the games in the list.
async function kalshiByGame(events) {
  const map = {};
  const meta = { ok: false, fetched_at: null, errors: [] };
  if (!kalshiProxy()) return { map, meta };
  for (const key of KALSHI_LEAGUES) {
    let data;
    try { data = await kalshiMarkets(key); } catch (e) { meta.errors.push(`${LEAGUES[key].name}: ${e.message}`); continue; }
    meta.ok = true; meta.fetched_at = data.fetched_at;
    const groups = {};
    for (const m of data.markets || []) (groups[kalshiGroupKey(m)] ||= []).push(m);
    for (const ms of Object.values(groups)) {
      const wins = ms.filter((m) => m.kind === "win");
      const game = wins.length ? findGame(key, wins, events.filter((e) => e.league === key)) : null;
      if (game) map[game.id] = ms;
    }
  }
  return { map, meta };
}
// Kalshi market nearest a line, for the same side (spread or total).
function nearestKalshi(markets, kind, line, side, game) {
  const cands = markets.filter((m) => m.kind === kind).map((m) => {
    const n = Number((m.outcome.match(/over ([\d.]+)/i) || m.outcome.match(/([\d.]+)/) || [])[1]);
    const s = kind === "spread" ? sideOf(m.outcome, game) : null;
    return { m, n, s };
  }).filter((c) => Number.isFinite(c.n) && (kind !== "spread" || c.s === side));
  if (!cands.length || line == null) return null;
  cands.sort((a, b) => Math.abs(a.n - Math.abs(line)) - Math.abs(b.n - Math.abs(line)));
  return cands[0].m;
}
// A row shows: the outcome, Yes/No prices, and each source side by side. Trend uses Kalshi history when connected,
// or the sportsbook line movement (open -> latest) otherwise.
function marketRow({ label, sub, kalshi, book, bb, mv, trendTicker }) {
  const rowId = `r-${Math.random().toString(36).slice(2, 9)}`;
  const kYes = kalshi ? yesPrice(kalshi) : null;
  // Yes/No shows Kalshi when it's connected for this market, otherwise the sportsbook (labelled either way).
  const primary = kYes != null ? kYes : book;
  const from = kYes != null ? "Kalshi" : "Sportsbook";
  const trend = trendTicker
    ? `<button class="ghost small" data-trend="${esc(trendTicker)}" data-target="${rowId}" type="button">Trend</button>`
    : "";
  return `<div class="mrow">
    <div class="mname"><b>${esc(label)}</b>${sub ? ` <span class="muted">${esc(sub)}</span>` : ""}</div>
    <div class="yesno"><span class="yes">Yes ${primary == null ? "—" : pct(primary)}</span><span class="no">No ${primary == null ? "—" : pct(1 - primary)}</span><span class="muted from">${from}</span></div>
    <div class="src">
      <span>Kalshi <b>${kYes == null ? "—" : cents(kYes)}</b></span>
      <span>Sportsbook <b>${pct(book)}</b></span>
      <span>BananaBets <b>${pct(bb)}</b></span>
    </div>
    ${trend}
    ${mv ? `<div class="move" id="${rowId}">${mv}</div>` : `<div class="move" id="${rowId}" hidden></div>`}
  </div>`;
}
// Opening vs latest, drawn as a two-point line.
function movementChart(open, latest, fmt) {
  if (open == null || latest == null) return "";
  const w = 320, h = 44, x0 = 14, x1 = w - 14;
  const lo = Math.min(open, latest), hi = Math.max(open, latest);
  const y = (v) => (hi === lo ? h / 2 : h - 10 - ((v - lo) / (hi - lo)) * (h - 20));
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" role="img" aria-label="Opening ${fmt(open)} to latest ${fmt(latest)}">
    <polyline points="${x0},${y(open).toFixed(1)} ${x1},${y(latest).toFixed(1)}" fill="none" stroke="#c79a00" stroke-width="2.5"/>
    <circle cx="${x0}" cy="${y(open).toFixed(1)}" r="3.5" fill="#8f6b00"/><circle cx="${x1}" cy="${y(latest).toFixed(1)}" r="3.5" fill="#c79a00"/>
    <text x="${x0}" y="${h - 1}">open ${fmt(open)}</text><text x="${x1}" y="${h - 1}" text-anchor="end">now ${fmt(latest)}</text></svg>
    <div class="muted">Line movement: opened ${fmt(open)}, now ${fmt(latest)}</div>`;
}
function sparkline(points) {
  if (!points || points.length < 2) return `<div class="muted">Not enough trade history yet.</div>`;
  const w = 320, h = 60;
  const xs = points.map((_, i) => (i / (points.length - 1)) * (w - 4) + 2);
  const ys = points.map((p) => h - 4 - p.p * (h - 8));
  const pts = points.map((_, i) => `${xs[i].toFixed(1)},${ys[i].toFixed(1)}`).join(" ");
  const first = points[0].p, last = points[points.length - 1].p;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" role="img" aria-label="Yes price trend, from ${Math.round(first * 100)} to ${Math.round(last * 100)} cents">
    <polyline points="${pts}" fill="none" stroke="#c79a00" stroke-width="2"/></svg>
    <div class="muted">Kalshi Yes ${Math.round(first * 100)}¢ → ${Math.round(last * 100)}¢ over the last week</div>`;
}
function gameMarkets(ev, p, kalshiMs) {
  const o = ev.odds;
  const kWin = kalshiMs ? kalshiMs.filter((m) => m.kind === "win") : [];
  const kSpread = kalshiMs || [], kTotal = kalshiMs || [];
  const hb = bookHome(ev), ab = hb == null ? null : 1 - hb;
  const home = ev.home.name, away = ev.away.name;
  const kFor = (side) => kWin.find((m) => sideOf(m.outcome, ev) === side) || null;
  const rows = [];
  // Winner
  rows.push(marketRow({
    label: `${home} win`, sub: ev.home.abbr, kalshi: kFor("home"), book: hb,
    bb: p ? p.pct : null, trendTicker: kFor("home") && kFor("home").ticker,
  }));
  rows.push(marketRow({
    label: `${away} win`, sub: ev.away.abbr, kalshi: kFor("away"), book: ab,
    bb: p ? 1 - p.pct : null, trendTicker: kFor("away") && kFor("away").ticker,
  }));
  // Spread (home line; MLB uses the run line)
  const L = ev.league === "mlb" && o && o.runline ? o.runline.homeLine : (o ? o.spread : null);
  if (L != null && o) {
    const sp = noVig2(o.homeSpreadPrice, o.awaySpreadPrice);
    const homeCover = p ? phi((p.margin + L) / p.sigma) : (ev.league === "mlb" ? null : null);
    const kh = nearestKalshi(kSpread, "spread", L, "home", ev);
    const ka = nearestKalshi(kSpread, "spread", -L, "away", ev);
    const mvOpen = o.openSpread;
    const mv = mvOpen != null && L != null && mvOpen !== L ? movementChart(mvOpen, L, (x) => signedNum(x)) : "";
    rows.push(marketRow({
      label: `${home} ${signedNum(L)}`, sub: "spread", kalshi: kh, book: sp ? sp.first : null,
      bb: homeCover, mv, trendTicker: kh ? kh.ticker : null,
    }));
    rows.push(marketRow({
      label: `${away} ${signedNum(-L)}`, sub: "spread", kalshi: ka, book: sp ? sp.second : null,
      bb: homeCover == null ? null : 1 - homeCover, mv: "", trendTicker: ka ? ka.ticker : null,
    }));
  }
  // Total
  if (o && o.total != null) {
    const T = o.total;
    const tp = noVig2(o.overPrice, o.underPrice);
    const over = p ? phi((p.total - T) / MODEL[ev.league].totalSigma) : null;
    const kt = nearestKalshi(kTotal, "total", T, null, ev);
    const mv = o.openTotal != null && o.openTotal !== T ? movementChart(o.openTotal, T, (x) => x.toFixed(1)) : "";
    rows.push(marketRow({
      label: `Over ${T}`, sub: "total", kalshi: kt, book: tp ? tp.first : null,
      bb: over, mv, trendTicker: kt ? kt.ticker : null,
    }));
    rows.push(marketRow({
      label: `Under ${T}`, sub: "total", kalshi: null, book: tp ? tp.second : null,
      bb: over == null ? null : 1 - over, mv: "", trendTicker: null,
    }));
  }
  return rows.join("");
}
async function pageMarkets() {
  const events = (await Promise.all(["nfl", "nba", "mlb"].map((k) => scoreboard(k, { week: true }).catch(() => [])))).flat()
    .filter((e) => !e.completed && !e.preseason && e.odds);
  const preds = await predictionsFor(events);
  const { map: kmap, meta } = await kalshiByGame(events);
  const kalshiNote = !kalshiProxy()
    ? `<div class="note warn">Kalshi prices aren't connected yet. Follow worker/SETUP.md, then paste your proxy address in Settings. Sportsbook and BananaBets numbers are shown below either way.</div>`
    : meta.errors.length
      ? `<div class="note warn">Kalshi: ${esc(meta.errors.join("; "))}</div>`
      : `<p class="muted">Kalshi data from ${esc(fmtTime(meta.fetched_at))}. Yes prices are in cents, so 30¢ is a 30% chance.</p>`;
  const byLeague = ["nfl", "nba", "mlb"].map((k) => {
    const list = events.filter((e) => e.league === k).sort((a, b) => a.date.localeCompare(b.date));
    if (!list.length) return "";
    return `<h2>${LEAGUES[k].name}</h2><div class="grid two">${list.map((e) => `
      <div class="card ${isLive(e) ? "live" : ""}">
        <div class="kicker"><span>${esc(e.away.abbr)} @ ${esc(e.home.abbr)}</span>${statusChip(e)}</div>
        ${gameMarkets(e, preds[e.id], kmap[e.id])}
        ${kmap[e.id] && isLive(e) ? liveCover(e) : ""}
      </div>`).join("")}</div>`;
  }).join("");
  return `<h1>Markets</h1>
    <p class="muted">Yes/No prices for each game: winner, spread and total. Sportsbook prices have the vig removed. BananaBets uses the model where it covers the league (NFL and NBA; MLB is not modelled yet).</p>
    ${kalshiNote}
    ${byLeague || `<div class="empty">No upcoming games with odds in the next 7 days.</div>`}`;
}
function liveCover(game) {
  const f = minutesLeftFraction(game);
  const d = Number(game.home.score) - Number(game.away.score);
  const parts = [];
  if (game.odds && game.odds.spread != null) {
    const covering = d + game.odds.spread > 0 ? game.home.abbr : d + game.odds.spread < 0 ? game.away.abbr : "push";
    parts.push(`<span>Spread: <b>${esc(covering)} ${covering === "push" ? "" : "covering"}</b> (${esc(game.home.abbr)} ${signedNum(game.odds.spread)})</span>`);
  }
  if (game.odds && game.odds.total != null && f != null && f < 1) {
    const elapsed = 1 - f;
    const total = Number(game.home.score) + Number(game.away.score);
    if (elapsed > 0) {
      const pace = total / elapsed;
      parts.push(`<span>Total pace: <b>${pace.toFixed(1)}</b> vs line ${esc(game.odds.total)} → <b>${pace > game.odds.total ? "over" : "under"} pace</b></span>`);
    }
  }
  return `<div class="lines" style="margin-top:8px">${parts.join("") || `<span class="muted">Live spread and total tracking needs odds.</span>`}</div>`;
}

/* ---------- Record, Settings ---------- */
function pageRecord() {
  return `<h1>Track record</h1><div class="empty">Nothing logged yet. Predictions and saved picks will be graded here once the track record is built (next phase).</div>`;
}
function pageSettings() {
  const s = settings();
  return `<h1>Settings</h1>
    <label class="field"><span>Flag gaps of at least (points)</span><input id="edge" type="number" min="1" max="30" step="0.5" value="${esc(s.edgeThreshold)}"></label>
    <p class="muted">Used on Predictions and Markets. Default is 10, because the backtest shows smaller gaps are mostly noise. Set it to 5 to see more flags.</p>
    <label class="field"><span>Kalshi proxy address</span><input id="kproxy" type="text" placeholder="https://bananabets-kalshi.YOUR-NAME.workers.dev" value="${esc(s.kalshiProxy)}" style="width:min(320px,60vw)"></label>
    <p class="muted">Paste the Cloudflare Worker address from worker/SETUP.md. Leave blank to skip Kalshi.</p>
    <h2>Data sources</h2>
    <div class="card"><b>ESPN public site API</b><div class="muted">Scores, schedules, stats, odds, win probability, injuries. Unofficial; may change without notice.</div></div>
    <div class="card" style="margin-top:10px"><b>Kalshi</b><div class="muted">Read-only prices through your Cloudflare Worker.</div></div>
    <div class="card" style="margin-top:10px"><b>Game history and calibration</b><div class="muted">data/nfl.json, data/nba.json (rebuilt weekly from ESPN) and data/calibration.json (from scripts/backtest_nfl.py).</div></div>
    <div class="card" style="margin-top:10px"><b>Underdog</b><div class="muted">No public data. Lines would be typed in by hand.</div></div>
    <h2>Refresh</h2><p class="muted">Every 20 seconds while a game is live; every 5 minutes otherwise. The Refresh button updates now.</p>`;
}

/* ---------- router and refresh ---------- */
const ROUTES = {
  home: () => pageHome(),
  nfl: () => pageLeague("nfl"), nba: () => pageLeague("nba"), mlb: () => pageLeague("mlb"), ufc: () => pageLeague("ufc"),
  markets: () => pageMarkets(), predictions: () => pagePredictions(), record: () => pageRecord(), settings: () => pageSettings(),
};
function currentRoute() { return (location.hash.replace(/^#\/?/, "") || "").split("/").filter(Boolean); }
async function render({ keepScroll = false } = {}) {
  const parts = currentRoute();
  const view = $("#view");
  const top = window.scrollY;
  const key = parts[0] || "home";
  document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("active", a.dataset.tab === key));
  try {
    let html;
    if (key === "game" && parts[1] && parts[2]) html = await pageGame(parts[1], parts[2]);
    else if (ROUTES[key]) html = await ROUTES[key]();
    else html = `<h1>Not found</h1><p class="muted">Pick a tab above.</p>`;
    view.innerHTML = html;
    wireView();
    if (keepScroll) window.scrollTo(0, top); else window.scrollTo(0, 0);
    setUpdated(new Date());
  } catch (e) {
    view.innerHTML = `<div class="note warn"><b>Couldn't load this data.</b> ${esc(e.message)}. Check your connection, then press Refresh.</div>`;
    setUpdated(null);
  }
  scheduleNext();
}
function wireView() {
  const btn = $("#showall");
  if (btn) btn.onclick = () => { const box = $("#allstats"); box.hidden = !box.hidden; btn.textContent = box.hidden ? "Show all stats" : "Hide stats"; btn.setAttribute("aria-expanded", String(!box.hidden)); };
  document.querySelectorAll("[data-why]").forEach((b) => b.onclick = () => {
    const box = document.getElementById(b.dataset.why); box.hidden = !box.hidden; b.setAttribute("aria-expanded", String(!box.hidden));
  });
  document.querySelectorAll("[data-trend]").forEach((b) => b.onclick = async () => {
    const box = document.getElementById(b.dataset.target);
    if (!box.hidden && box.dataset.loaded) { box.hidden = true; return; }
    box.hidden = false;
    if (box.dataset.loaded) return;
    box.innerHTML = `<span class="muted">Loading trend…</span>`;
    try {
      const h = await kalshiHistory(b.dataset.trend, 7);
      box.innerHTML = sparkline(h.points);
      box.dataset.loaded = "1";
    } catch (e) { box.innerHTML = `<span class="muted">Trend unavailable: ${esc(e.message)}</span>`; }
  });
  const edge = $("#edge");
  if (edge) edge.onchange = () => { const v = Math.max(1, Math.min(30, Number(edge.value) || 5)); saveSettings({ ...settings(), edgeThreshold: v }); edge.value = v; };
  const kp = $("#kproxy");
  if (kp) kp.onchange = () => saveSettings({ ...settings(), kalshiProxy: kp.value.trim() });
}
function setUpdated(d) {
  $("#updated").textContent = d ? `Last updated ${new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" }).format(d)}` : "Update failed";
}
let timer = null;
function scheduleNext() {
  clearTimeout(timer);
  const live = !!document.querySelector(".card.live, .game.live");
  timer = setTimeout(() => render({ keepScroll: true }), live ? 20000 : 300000);
}
$("#refresh").addEventListener("click", async (ev) => {
  const b = ev.currentTarget; b.disabled = true; cache.clear();
  try { await render({ keepScroll: true }); } finally { b.disabled = false; }
});
window.addEventListener("hashchange", () => { cache.clear(); render(); });
render();
