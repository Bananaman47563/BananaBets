# BananaBets

A personal sports dashboard: scores, stats, odds, Kalshi prices and statistical estimates for NFL, NBA, MLB and UFC.
Research only. It does not connect to any sportsbook and does not place bets.

## Run it on your computer

Open a terminal in this folder and run:

    python -m http.server 8090

Then open http://localhost:8090 in your browser.

## What's where

- `index.html`, `style.css`, `app.js`: the site. All outside calls are in the DATA section of `app.js`.
- `data/nfl.json`, `data/nba.json`: game history for the Predictions tab. Rebuilt by `scripts/build_history.py`.
- `.github/workflows/refresh-history.yml`: runs the history rebuild every Monday, and can be run by hand from the Actions tab.
- `worker/kalshi-proxy.js`: the Cloudflare Worker that reads Kalshi prices. Setup steps are in `worker/SETUP.md`.

## Rebuild the history by hand

    python scripts/build_history.py

## Data sources

- ESPN's public site API (unofficial): scores, schedules, stats, odds, win probability, injuries.
- Kalshi public market data, read through your Cloudflare Worker.
- Game history from ESPN's daily scoreboards.
- Underdog: not connected (no public data).

## Predictions (Phase 1)

NFL and NBA only. Each team's points scored and allowed are weighted toward recent games, with a half-life of
about 6 months for the NFL and 4 months for the NBA. Expected points give the margin, the win chance, a projected
spread, and a projected total. Live games update from the score and time left. Injuries, weather and rest are not
in the numbers yet.

## Publish

The site is a static site served by GitHub Pages from the `main` branch root.
