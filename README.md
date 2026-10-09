# BananaBets

A personal sports dashboard: scores, stats, odds and (later) statistical estimates for NFL, NBA, MLB and UFC.
Research only. It does not connect to any sportsbook and does not place bets.

## Run it on your computer

Open a terminal in this folder and run:

    python -m http.server 8090

Then open http://localhost:8090 in your browser.

## Where the data comes from

- ESPN's public site API (unofficial). All ESPN calls are in the DATA section of `app.js`.
- Kalshi and Underdog are not connected yet.

## Publish

The site is a static site served by GitHub Pages from the `main` branch root.
