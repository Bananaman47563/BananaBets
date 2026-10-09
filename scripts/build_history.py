"""Rebuild the game-history files the Predictions tab uses.

Source: ESPN's public (unofficial) daily scoreboards, the same source the site uses for live scores.
Output: data/nfl.json and data/nba.json, one compact row per completed regular-season or playoff game.

Run locally:   python scripts/build_history.py
Run weekly:    .github/workflows/refresh-history.yml does this automatically.

Only the Python standard library is used, so nothing needs installing.
"""
from __future__ import annotations

import json
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ESPN = "https://site.api.espn.com/apis/site/v2/sports/{path}/scoreboard?dates={day}"
LEAGUES = {
    # league key: (ESPN path, season labels to keep, first season start year to scan, scan window (month, day) start and end)
    # ESPN labels NBA seasons by the year they END (2023-24 = 2024), and NFL seasons by the year they START.
    "nfl": ("football/nfl", [2024, 2025, 2026], [2024, 2025, 2026], ((8, 1), (3, 1))),
    "nba": ("basketball/nba", [2024, 2025, 2026], [2023, 2024, 2025], ((10, 1), (6, 30))),
}
TEAMS = {
    # ESPN abbreviations for the real teams in each league (the scoreboard also lists All-Star and Pro Bowl teams)
    "nba": set("ATL BKN BOS CHA CHI CLE DAL DEN DET GS HOU IND LAC LAL MEM MIA MIL MIN NO NY OKC ORL PHI PHX POR SA SAC TOR UTAH WSH".split()),
    "nfl": set("ARI ATL BAL BUF CAR CHI CIN CLE DAL DEN DET GB HOU IND JAX KC LAC LAR LV MIA MIN NE NO NYG NYJ PHI PIT SEA SF TB TEN WSH".split()),
}
ROOT = Path(__file__).resolve().parents[1]
UA = "BananaBets history builder (personal research site)"


def fetch_day(path: str, day: date) -> list[dict]:
    url = ESPN.format(path=path, day=day.strftime("%Y%m%d"))
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.load(r).get("events", [])
        except Exception:
            time.sleep(1 + attempt)
    print(f"  giving up on {day}", file=sys.stderr)
    return []


def season_days(year: int, start: tuple[int, int], end: tuple[int, int], today: date) -> list[date]:
    first = date(year, start[0], start[1])
    last_year = year + 1 if end[0] < start[0] else year
    last = min(date(last_year, end[0], end[1]), today)
    days = []
    d = first
    while d <= last:
        days.append(d)
        d += timedelta(days=1)
    return days


def parse(events: list[dict], keep_years: set[int], real_teams: set[str]) -> dict[str, list]:
    out: dict[str, list] = {}
    for e in events:
        season = e.get("season", {})
        stype = season.get("type")
        if stype not in (2, 3):                       # 1 = preseason (excluded), 2 = regular, 3 = postseason
            continue
        if season.get("year") not in keep_years:
            continue
        comp = (e.get("competitions") or [{}])[0]
        if not (e.get("status", {}).get("type", {}).get("completed")):
            continue
        sides = {c.get("homeAway"): c for c in comp.get("competitors", [])}
        home, away = sides.get("home"), sides.get("away")
        if not home or not away:
            continue
        if home["team"].get("abbreviation") not in real_teams or away["team"].get("abbreviation") not in real_teams:
            continue                                     # All-Star and Pro Bowl teams are not real teams
        try:
            row = [
                e["date"][:10],                                  # game date (UTC day from ESPN)
                home["team"]["abbreviation"], away["team"]["abbreviation"],
                int(float(home["score"])), int(float(away["score"])),
                stype, season["year"],
            ]
        except (KeyError, ValueError, TypeError):
            continue
        out[e["id"]] = row
    return out


def build(league: str, today: date) -> dict:
    path, keep, scan_years, (start, end) = LEAGUES[league]
    years = keep
    jobs = []
    for y in scan_years:
        for day in season_days(y, start, end, today):
            jobs.append(day)
    print(f"{league}: fetching {len(jobs)} days")
    games: dict[str, list] = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        for events in pool.map(lambda d: fetch_day(path, d), jobs):
            games.update(parse(events, set(years), TEAMS[league]))
    rows = sorted(games.values(), key=lambda r: (r[0], r[1]))
    return {
        "league": league,
        "source": "ESPN public scoreboard (unofficial)",
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "columns": ["date", "home", "away", "home_score", "away_score", "season_type", "season"],
        "seasons": years,
        "games": rows,
    }


def main() -> None:
    today = datetime.now(timezone.utc).date()
    out_dir = ROOT / "data"
    out_dir.mkdir(exist_ok=True)
    for league in LEAGUES:
        data = build(league, today)
        (out_dir / f"{league}.json").write_text(json.dumps(data, separators=(",", ":")) + "\n", encoding="utf-8")
        print(f"{league}: wrote {len(data['games'])} games")


if __name__ == "__main__":
    main()
