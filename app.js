/* BananaBets: single-page site. All ESPN calls live in the DATA section so they are easy to fix if ESPN changes. */
"use strict";

/* ---------- DATA: ESPN public (unofficial) site API. Keep every endpoint here. ---------- */
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/";
const LEAGUES = {
  nfl: { path: "football/nfl", name: "NFL", kind: "team" },
  nba: { path: "basketball/nba", name: "NBA", kind: "team" },
  mlb: { path: "baseball/mlb", name: "MLB", kind: "team" },
  ufc: { path: "mma/ufc", name: "UFC", kind: "fight" },
};
const NATIONAL_NETWORKS = ["ESPN", "ABC", "NBC", "FOX", "CBS", "Prime", "NFL Network", "TNT", "truTV", "NBA TV", "MLBN", "Netflix"];
const TZ = "America/Chicago";
const SETTINGS_KEY = "bananabets.settings";
const DEFAULTS = { edgeThreshold: 5 };

const cache = new Map();                      // url -> { at, data }; avoids duplicate requests within 10 s
async function getJSON(url, { maxAgeMs = 10000 } = {}) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.data;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`ESPN responded ${r.status}`);
    const data = await r.json();
    cache.set(url, { at: Date.now(), data });
    return data;
  } finally { clearTimeout(timer); }
}

const ymd = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d).replaceAll("-", "");
const centralDayKey = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const centralHour = (iso) => Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(new Date(iso)));

// Scoreboard for a league, optionally a date range (today to +7 days for the week-ahead list).
async function scoreboard(key, { week = false } = {}) {
  const today = new Date();
  const ahead = new Date(Date.now() + 7 * 86400000);
  const url = ESPN + LEAGUES[key].path + "/scoreboard" + (week ? `?dates=${ymd(today)}-${ymd(ahead)}&limit=300` : "");
  const raw = await getJSON(url);
  return (raw.events || []).map((e) => normalizeEvent(key, e));
}

async function summary(key, id) {
  return getJSON(`${ESPN}${LEAGUES[key].path}/summary?event=${encodeURIComponent(id)}`, { maxAgeMs: 8000 });
}

function normalizeEvent(key, e) {
  const comp = (e.competitions || [])[0] || {};
  const st = e.status || {};
  const type = st.type || {};
  const base = {
    league: key, id: e.id, name: e.name || e.shortName || "", date: e.date,
    state: type.state || "pre",                       // pre | in | post
    completed: !!type.completed,
    detail: type.shortDetail || type.detail || "",
    period: st.period || 0, clock: st.displayClock || "",
    playoff: e.season && e.season.type === 3,
    broadcasts: (comp.broadcasts || []).flatMap((b) => b.names || []),
    headline: (comp.notes || []).map((n) => n.headline).filter(Boolean)[0] || "",
  };
  if (LEAGUES[key].kind === "fight") {
    return { ...base, name: e.name, fights: (e.competitions || []).map(normalizeFight) };
  }
  const competitors = comp.competitors || [];
  const home = competitors.find((c) => c.homeAway === "home") || {};
  const away = competitors.find((c) => c.homeAway === "away") || {};
  const o = (comp.odds || [])[0] || null;
  return {
    ...base,
    away: normalizeTeam(away), home: normalizeTeam(home),
    odds: o && {
      provider: (o.provider && o.provider.name) || "",
      details: o.details || "", spread: o.spread ?? null, total: o.overUnder ?? null,
      homeML: o.homeTeamOdds && o.homeTeamOdds.moneyLine != null ? o.homeTeamOdds.moneyLine : null,
      awayML: o.awayTeamOdds && o.awayTeamOdds.moneyLine != null ? o.awayTeamOdds.moneyLine : null,
    },
  };
}
function normalizeTeam(c) {
  const t = c.team || {};
  return {
    name: t.displayName || t.shortDisplayName || "TBD", abbr: t.abbreviation || "",
    logo: t.logo || "", score: c.score ?? null, record: (c.records || [])[0]?.summary || "", winner: !!c.winner,
  };
}
function normalizeFight(c) {
  const side = (x) => ({ name: x.athlete?.displayName || "TBD", logo: x.athlete?.headshot?.href || "", winner: !!x.winner, record: (x.records || [])[0]?.summary || "" });
  const f = c.competitors || [];
  return { id: c.id, a: side(f[0] || {}), b: side(f[1] || {}), state: c.status?.type?.state || "pre", detail: c.status?.type?.shortDetail || "", method: c.status?.type?.description || "", weight: c.type?.text || "" };
}

/* ---------- helpers ---------- */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtTime = (iso) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(iso));
const fmtDay = (iso) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long", month: "short", day: "numeric" }).format(new Date(iso));
const fmtClock = (t) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(t));
const american = (n) => (n == null ? "—" : (n > 0 ? "+" : "") + n);
function settings() { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") }; } catch (e) { return { ...DEFAULTS }; } }
function saveSettings(s) { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* private mode: keep going with defaults */ } }

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

/* ---------- cards ---------- */
function teamCard(ev) {
  const h = ev.home, a = ev.away;
  const row = (t) => `<div class="team ${t.winner ? "winner" : (ev.completed && !t.winner ? "loser" : "")}">
      ${t.logo ? `<img src="${esc(t.logo)}" alt="" loading="lazy">` : `<span></span>`}
      <div><div class="name">${esc(t.name)}</div>${t.record ? `<div class="muted">${esc(t.record)}</div>` : ""}</div>
      <div class="score">${t.score == null ? "" : esc(t.score)}</div></div>`;
  const o = ev.odds;
  const lines = o ? `<div class="lines">
      <span>Spread <b>${esc(o.details || "—")}</b></span>
      <span>Total <b>${esc(o.total ?? "—")}</b></span>
      <span>ML <b>${esc(american(o.awayML))} / ${esc(american(o.homeML))}</b></span>
      <span class="muted">${esc(o.provider)}</span></div>` : `<div class="muted" style="margin-top:8px">No pregame odds listed</div>`;
  const big = ev.playoff || isCloseLate(ev);
  return `<a class="card game ${isLive(ev) ? "live" : ""} ${big ? "big" : ""}" href="#/game/${ev.league}/${esc(ev.id)}">
    <div class="kicker"><span>${esc(LEAGUES[ev.league].name)}${ev.playoff ? " · Playoffs" : ""}</span>${statusChip(ev)}</div>
    ${ev.headline ? `<div class="muted">${esc(ev.headline)}</div>` : ""}
    <div class="teams">${row(a)}${row(h)}</div>${lines}</a>`;
}
function fightCard(ev) {
  const fights = ev.fights || [];
  const main = fights[0];
  return `<div class="card ${isLive(ev) ? "live" : ""}">
    <div class="kicker"><span>UFC · ${esc(ev.name)}</span>${isLive(ev) ? `<span class="chip live">LIVE</span>` : ""}</div>
    ${main ? fightRow(main) : `<div class="muted">No fights listed.</div>`}
    <div class="muted" style="margin-top:8px">${esc(fmtTime(ev.date))} · ${fights.length} bouts · ${ev.completed ? "event complete" : "upcoming"}</div></div>`;
}
function fightRow(f) {
  const side = (x) => `<div class="team ${x.winner ? "winner" : (f.state === "post" && !x.winner ? "loser" : "")}">
    ${x.logo ? `<img src="${esc(x.logo)}" alt="" loading="lazy">` : `<span></span>`}<div><div class="name">${esc(x.name)}</div><div class="muted">${esc(x.record)}</div></div><span></span></div>`;
  return `<div class="teams">${side(f.a)}${side(f.b)}</div><div class="muted" style="margin-top:6px">${esc(f.weight)}${f.method ? ` · ${esc(f.method)}` : ""} ${f.detail ? `· ${esc(f.detail)}` : ""}</div>`;
}

/* ---------- pages ---------- */
async function pageHome() {
  const all = (await Promise.all(Object.keys(LEAGUES).map((k) => scoreboard(k).catch(() => [])))).flat();
  const teamEvents = all.filter((e) => LEAGUES[e.league].kind === "team");
  const playoffs = teamEvents.filter((e) => e.playoff);
  const primetime = teamEvents.filter((e) => !e.playoff && e.broadcasts.some((b) => NATIONAL_NETWORKS.some((n) => b.includes(n))) && centralHour(e.date) >= 18 && !e.completed);
  const close = teamEvents.filter(isCloseLate);
  const ufc = all.filter((e) => e.league === "ufc").slice(0, 1);
  const section = (title, items, render) => items.length ? `<h2>${title}</h2><div class="grid two">${items.map(render).join("")}</div>` : "";
  const html = [
    section("Live and close late", close, teamCard),
    section("Playoffs", playoffs, teamCard),
    section("Primetime national TV", primetime.slice(0, 6), teamCard),
    section("UFC featured", ufc, fightCard),
  ].join("");
  return `<h1>Big games</h1><p class="muted">Playoffs, primetime national TV, UFC featured fight, and live games that are close late. Primetime uses the national network list and an evening Central start time; it's approximate.</p>
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
  for (const e of events) (byDay[centralDayKey(e.date)] ||= []).push(e);
  const days = Object.keys(byDay).sort();
  const todayKey = centralDayKey(new Date().toISOString());
  return `<h1>${meta.name}</h1><p class="muted">Today and the next 7 days, Central time.</p>
    ${days.map((d) => {
      const list = byDay[d];
      const label = d === todayKey ? "Today" : fmtDay(list[0].date);
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
      <div class="team"><span></span><div class="name">${esc(away.team?.displayName || "")}</div><div class="score">${esc(away.score ?? "")}</div></div>
      <div class="team"><span></span><div class="name">${esc(home.team?.displayName || "")}</div><div class="score">${esc(home.score ?? "")}</div></div>
    </div>
    ${wpLast != null ? `<div class="wpbar"><i class="a" style="width:${((1 - wpLast) * 100).toFixed(1)}%"></i><i class="h" style="width:${(wpLast * 100).toFixed(1)}%"></i></div>
    <div class="wplabel"><span>${esc(away.team?.abbreviation || "Away")} ${((1 - wpLast) * 100).toFixed(0)}%</span><span>${esc(home.team?.abbreviation || "Home")} ${(wpLast * 100).toFixed(0)}%</span></div>
    <p class="muted" style="margin:6px 0 0">ESPN's live win probability. Tap a chart point below for the history.</p>` : `<p class="muted">Win probability not available for this game.</p>`}
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

async function pageMarkets() {
  const all = (await Promise.all(["nfl", "nba", "mlb"].map((k) => scoreboard(k).catch(() => [])))).flat();
  const rows = all.filter((e) => e.odds && e.odds.homeML != null && e.odds.awayML != null && !e.completed).slice(0, 40).map((e) => {
    const fair = noVig(e.odds.awayML, e.odds.homeML);
    return `<tr><td>${esc(LEAGUES[e.league].name)}</td><td>${esc(e.away.abbr)} @ ${esc(e.home.abbr)}</td><td>${esc(fmtTime(e.date))}</td>
      <td>${esc(american(e.odds.awayML))} / ${esc(american(e.odds.homeML))}</td><td>${(fair.away * 100).toFixed(1)}% / ${(fair.home * 100).toFixed(1)}%</td></tr>`;
  });
  return `<h1>Markets</h1>
    <p class="muted">Sportsbook moneylines from ESPN, with the vig (bookmaker margin) removed. These are odds comparisons, not recommendations.</p>
    <div class="note warn">Kalshi prices are not connected yet. They need a free Cloudflare Worker, because Kalshi blocks requests from websites. Next step.</div>
    ${rows.length ? `<div class="scroll"><table class="stat-table"><thead><tr><th>League</th><th>Game</th><th>Start</th><th>ML (away / home)</th><th>No-vig % (away / home)</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>` : `<div class="empty">No moneylines listed for upcoming games right now.</div>`}`;
}
// Remove the bookmaker margin: convert both American prices to implied probability, then scale so they sum to 1.
function impliedFromAmerican(a) { return a > 0 ? 100 / (a + 100) : -a / (-a + 100); }
function noVig(awayML, homeML) {
  const p = impliedFromAmerican(awayML), q = impliedFromAmerican(homeML), t = p + q;
  return { away: p / t, home: q / t };
}

function pagePredictions() {
  return `<h1>Predictions</h1><div class="empty">Predictions aren't built yet. This is the next Phase 1 step: NFL and NBA power ratings, with the win %, projected spread and total, and a confidence tag.</div>`;
}
function pageRecord() {
  return `<h1>Track record</h1><div class="empty">Nothing logged yet. Predictions and saved picks will be graded here once the prediction model is in place.</div>`;
}
function pageSettings() {
  const s = settings();
  return `<h1>Settings</h1>
    <label class="field"><span>Flag gaps of at least (points)</span><input id="edge" type="number" min="1" max="30" step="0.5" value="${esc(s.edgeThreshold)}"></label>
    <p class="muted">Used by the Markets and Predictions tabs once they're built. Default is 5.</p>
    <h2>Data sources</h2>
    <div class="card"><b>ESPN public site API</b><div class="muted">Scores, schedules, stats, odds, win probability, injuries. Unofficial; may change without notice.</div></div>
    <div class="card" style="margin-top:10px"><b>Kalshi</b><div class="muted">Not connected yet.</div></div>
    <div class="card" style="margin-top:10px"><b>Underdog</b><div class="muted">No public data. Lines would be typed in by hand.</div></div>
    <h2>Refresh</h2><p class="muted">Every 20 seconds while a game is live; every 5 minutes otherwise. The Refresh button updates now.</p>`;
}

/* ---------- router and refresh ---------- */
const ROUTES = {
  "": () => pageHome(),
  home: () => pageHome(),
  nfl: () => pageLeague("nfl"), nba: () => pageLeague("nba"), mlb: () => pageLeague("mlb"), ufc: () => pageLeague("ufc"),
  markets: () => pageMarkets(), predictions: () => pagePredictions(), record: () => pageRecord(), settings: () => pageSettings(),
};
let lastRoute = null;
function currentRoute() {
  const parts = (location.hash.replace(/^#\/?/, "") || "").split("/").filter(Boolean);
  return parts;
}
async function render({ keepScroll = false } = {}) {
  const parts = currentRoute();
  const view = $("#view");
  const top = window.scrollY;
  document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("active", a.dataset.tab === (parts[0] || "home")));
  try {
    const key = parts[0] || "home";
    let html;
    if (key === "game" && parts[1] && parts[2]) html = await pageGame(parts[1], parts[2]);
    else if (ROUTES[key]) html = await ROUTES[key]();
    else html = `<h1>Not found</h1><p class="muted">Pick a tab above.</p>`;
    view.innerHTML = html;
    const btn = $("#showall");
    if (btn) btn.onclick = () => { const box = $("#allstats"); box.hidden = !box.hidden; btn.textContent = box.hidden ? "Show all stats" : "Hide stats"; btn.setAttribute("aria-expanded", String(!box.hidden)); };
    const edge = $("#edge");
    if (edge) edge.onchange = () => { const v = Math.max(1, Math.min(30, Number(edge.value) || 5)); saveSettings({ ...settings(), edgeThreshold: v }); edge.value = v; };
    if (keepScroll) window.scrollTo(0, top);
    else window.scrollTo(0, 0);
    setUpdated(new Date());
    lastRoute = parts.join("/");
  } catch (e) {
    view.innerHTML = `<div class="note warn"><b>Couldn't load this data.</b> ${esc(e.message)}. Check your connection, then press Refresh.</div>`;
    setUpdated(null);
  }
  scheduleNext();
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
