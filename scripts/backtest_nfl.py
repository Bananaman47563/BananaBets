"""Walk-forward backtest and calibration of the NFL model.

For every week from 2016 on, the model is refit using only games played before that week (no peeking),
then each game in the week is predicted. Results are compared with:
  * the sportsbook closing moneyline (vig removed), from nflverse's games file, and
  * the actual results (Brier score, log loss, and a reliability table).

Calibration: a small grid of settings is scored on seasons 2016-2022 and the best one is tested on
2023-2025, which the grid never saw. The chosen values go into app.js (MODEL.nfl) and are written
to data/calibration.json, along with the starting-quarterback effect estimate.

Run:  python scripts/backtest_nfl.py
Needs: numpy (pip install numpy). Downloads nflverse's games.csv.
"""
from __future__ import annotations

import csv
import io
import itertools
import json
import math
import sys
import urllib.request
from datetime import date
from pathlib import Path

import numpy as np

GAMES_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv"
ROOT = Path(__file__).resolve().parents[1]
TEAM_FIX = {"LA": "LAR", "WAS": "WSH"}       # nflverse -> ESPN abbreviations
TRAIN = range(2016, 2023)
TEST = range(2023, 2026)


def phi(z: np.ndarray) -> np.ndarray:
    return 0.5 * (1 + np.vectorize(math.erf)(z / math.sqrt(2)))


def load() -> list[dict]:
    raw = urllib.request.urlopen(GAMES_URL, timeout=60).read().decode("utf-8")
    rows = []
    for r in csv.DictReader(io.StringIO(raw)):
        if r["game_type"] not in ("REG", "WC", "DIV", "CON", "SB"):
            continue
        if r["home_score"] in ("", "NA") or r["away_score"] in ("", "NA"):
            continue
        season = int(r["season"])
        if season < 2010:
            continue
        ml_h, ml_a = r["home_moneyline"], r["away_moneyline"]
        mkt = None
        if ml_h not in ("", "NA") and ml_a not in ("", "NA"):
            ph, pa = implied(float(ml_h)), implied(float(ml_a))
            mkt = ph / (ph + pa)
        rows.append({
            "date": date.fromisoformat(r["gameday"]), "season": season, "week": int(r["week"]),
            "playoff": r["game_type"] != "REG",
            "home": TEAM_FIX.get(r["home_team"], r["home_team"]), "away": TEAM_FIX.get(r["away_team"], r["away_team"]),
            "hs": int(float(r["home_score"])), "as": int(float(r["away_score"])),
            "mkt": mkt, "total_line": float(r["total_line"]) if r["total_line"] not in ("", "NA") else None,
            "qb_h": r["home_qb_name"], "qb_a": r["away_qb_name"],
        })
    rows.sort(key=lambda g: (g["date"], g["home"]))
    last: dict[str, str] = {}
    for g in rows:                                   # did each team's starting QB change from its previous game?
        g["ch_h"] = int(last.get(g["home"], g["qb_h"]) != g["qb_h"])
        g["ch_a"] = int(last.get(g["away"], g["qb_a"]) != g["qb_a"])
        last[g["home"]], last[g["away"]] = g["qb_h"], g["qb_a"]
    return rows


def implied(american: float) -> float:
    return 100 / (american + 100) if american > 0 else -american / (-american + 100)


class Ratings:
    """Weighted offense and defense ratings as of a date. Mirrors buildRatings() in app.js."""

    def __init__(self, games: list[dict], teams: dict[str, int]):
        self.games = games
        self.teams = teams
        self.d = np.array([g["date"].toordinal() for g in games], dtype=float)
        self.h = np.array([teams[g["home"]] for g in games])
        self.a = np.array([teams[g["away"]] for g in games])
        self.hs = np.array([g["hs"] for g in games], dtype=float)
        self.as_ = np.array([g["as"] for g in games], dtype=float)

    def at(self, asof: date, half_life: float, shrink: float, prior: tuple | None = None, prior_weight: float = 0.0):
        n = len(self.teams)
        mask = self.d < asof.toordinal()
        w = np.where(mask, 0.5 ** ((asof.toordinal() - self.d) / half_life), 0.0)
        W = np.bincount(self.h, w, n) + np.bincount(self.a, w, n)
        PF = np.bincount(self.h, w * self.hs, n) + np.bincount(self.a, w * self.as_, n)
        PA = np.bincount(self.h, w * self.as_, n) + np.bincount(self.a, w * self.hs, n)
        sw = w.sum()
        mu = (w * (self.hs + self.as_) / 2).sum() / sw if sw else 0.0
        hfa = (w * (self.hs - self.as_)).sum() / sw if sw else 0.0
        off = (PF - W * mu) / (W + shrink)
        dfn = (PA - W * mu) / (W + shrink)
        if prior is not None and prior_weight > 0:
            off = (PF - W * mu + prior_weight * prior[0]) / (W + shrink + prior_weight)
            dfn = (PA - W * mu + prior_weight * prior[1]) / (W + shrink + prior_weight)
        return {"mu": mu, "hfa": hfa, "off": off, "def": dfn}


def predict_margin(rt: dict, h: int, a: int) -> float:
    eh = rt["mu"] + rt["off"][h] + rt["def"][a] + rt["hfa"] / 2
    ea = rt["mu"] + rt["off"][a] + rt["def"][h] - rt["hfa"] / 2
    return eh - ea


def run(games: list[dict], params: dict, seasons: range, collect: bool = False):
    teams = {t: i for i, t in enumerate(sorted({g["home"] for g in games} | {g["away"] for g in games}))}
    R = Ratings(games, teams)
    out = []
    prior_cache: dict[int, tuple] = {}
    for season in seasons:
        season_games = [g for g in games if g["season"] == season]
        if not season_games:
            continue
        start = min(g["date"] for g in season_games)
        if season - 1 not in prior_cache and season - 1 in {g["season"] for g in games}:
            rt0 = R.at(start, params["half_life"], params["shrink"])
            prior_cache[season] = (rt0["off"], rt0["def"])
        prior = prior_cache.get(season)
        for g in season_games:
            rt = R.at(g["date"], params["half_life"], params["shrink"], prior, params["prior"])
            m = predict_margin(rt, teams[g["home"]], teams[g["away"]])
            m += params.get("qb", 0.0) * (g["ch_h"] - g["ch_a"])     # starter change adjustment (0 = off)
            out.append({**g, "margin_pred": m, "p": float(phi(np.array([m / params["sigma"]]))[0])})
    return out


def metrics(rows: list[dict]) -> dict:
    y = np.array([1.0 if g["hs"] > g["as"] else 0.0 for g in rows])
    p = np.clip(np.array([g["p"] for g in rows]), 1e-4, 1 - 1e-4)
    m = np.array([g["mkt"] if g["mkt"] is not None else np.nan for g in rows])
    has = ~np.isnan(m)
    res = {
        "n": len(rows),
        "model_brier": float(np.mean((p - y) ** 2)),
        "model_logloss": float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p))),
        "base_rate_brier": float(np.mean((y.mean() - y) ** 2)),
    }
    if has.any():
        mm = np.clip(m[has], 1e-4, 1 - 1e-4)
        res.update({
            "n_with_market": int(has.sum()),
            "market_brier": float(np.mean((mm - y[has]) ** 2)),
            "market_logloss": float(-np.mean(y[has] * np.log(mm) + (1 - y[has]) * np.log(1 - mm))),
            "model_brier_on_market_games": float(np.mean((p[has] - y[has]) ** 2)),
        })
    return res


def reliability(rows: list[dict]) -> list[dict]:
    bins = []
    p = np.array([g["p"] for g in rows]); y = np.array([1.0 if g["hs"] > g["as"] else 0.0 for g in rows])
    for lo in np.arange(0, 1, 0.1):
        k = (p >= lo) & (p < lo + 0.1)
        if k.sum():
            bins.append({"bin": f"{int(lo * 100)}-{int(lo * 100) + 10}%", "n": int(k.sum()),
                         "predicted": round(float(p[k].mean()), 3), "observed": round(float(y[k].mean()), 3)})
    return bins


def flags(rows: list[dict], threshold: float) -> dict:
    """Games where the model differs from the sportsbook by at least `threshold`.
    For each flagged game we record whether the model's favourite won and whether the market's favourite won."""
    total = model_won = market_won = 0
    weeks = set()
    for g in rows:
        if g["mkt"] is None:
            continue
        weeks.add((g["season"], g["week"]))
        if abs(g["p"] - g["mkt"]) < threshold:
            continue
        total += 1
        home_won = g["hs"] > g["as"]
        model_won += (g["p"] > 0.5) == home_won
        market_won += (g["mkt"] > 0.5) == home_won
    return {"threshold_pts": round(threshold * 100), "flags": total,
            "flags_per_week": round(total / max(len(weeks), 1), 2),
            "model_favourite_won_pct": round(100 * model_won / total, 1) if total else None,
            "market_favourite_won_pct": round(100 * market_won / total, 1) if total else None}


def best_blend(rows: list[dict]) -> float:
    """Weight on the model (rest on the sportsbook, vig removed) that minimises log loss on these games."""
    rows = [g for g in rows if g["mkt"] is not None]
    y = np.array([1.0 if g["hs"] > g["as"] else 0.0 for g in rows])
    p = np.clip(np.array([g["p"] for g in rows]), 1e-4, 1 - 1e-4)
    mk = np.clip(np.array([g["mkt"] for g in rows]), 1e-4, 1 - 1e-4)
    best_w, best_ll = 0.0, 9.0
    for w in np.arange(0, 1.01, 0.05):
        q = np.clip(w * p + (1 - w) * mk, 1e-4, 1 - 1e-4)
        ll = float(-np.mean(y * np.log(q) + (1 - y) * np.log(1 - q)))
        if ll < best_ll:
            best_w, best_ll = float(w), ll
    return round(best_w, 2)


def blended(rows: list[dict], w: float) -> list[dict]:
    return [{**g, "p": w * g["p"] + (1 - w) * g["mkt"]} if g["mkt"] is not None else g for g in rows]


def qb_effect(rows: list[dict]) -> dict:
    """Points the margin shifts when a team's starting QB changes from its previous game (regression on residuals)."""
    last: dict[str, str] = {}
    xs, ys = [], []
    for g in rows:
        ch_h = int(last.get(g["home"], g["qb_h"]) != g["qb_h"])
        ch_a = int(last.get(g["away"], g["qb_a"]) != g["qb_a"])
        last[g["home"]] = g["qb_h"]; last[g["away"]] = g["qb_a"]
        if ch_h or ch_a:
            xs.append([ch_h - ch_a, 1.0]); ys.append((g["hs"] - g["as"]) - g["margin_pred"])
    if len(xs) < 20:
        return {"points_per_qb_change": None, "samples": len(xs)}
    X, y = np.array(xs), np.array(ys)
    b = np.linalg.lstsq(X, y, rcond=None)[0][0]
    return {"points_per_qb_change": round(float(b), 2), "samples": len(xs),
            "note": "Negative means the team with the new starter does worse than the model expects."}


def main() -> None:
    games = load()
    print(f"games loaded: {len(games)}")
    grid = {
        "half_life": [90, 180, 365],
        "shrink": [4, 8, 16],
        "prior": [0, 4, 8],
        "sigma": [9.5, 10.5, 11.5, 12.5, 13.5, 14.5, 15.5],
    }
    best = None
    scores = []
    # Ratings depend on half_life/shrink/prior, sigma only rescales the margin: run once per (hl, shrink, prior).
    for hl, sh, pr in itertools.product(grid["half_life"], grid["shrink"], grid["prior"]):
        base = {"half_life": hl, "shrink": sh, "prior": pr, "sigma": 13.5}
        rows = run(games, base, range(2016, 2023))
        for sg in grid["sigma"]:
            cand = [{**g, "p": float(phi(np.array([g["margin_pred"] / sg]))[0])} for g in rows]
            m = metrics(cand)
            scores.append({"half_life": hl, "shrink": sh, "prior": pr, "sigma": sg, "logloss": m["model_logloss"]})
            if best is None or m["model_logloss"] < best["logloss"]:
                best = {"half_life": hl, "shrink": sh, "prior": pr, "sigma": sg, "logloss": m["model_logloss"]}
    print("best on training seasons 2016-2022:", best)

    final_rows = run(games, {**best}, range(2016, 2026))
    train_rows = [g for g in final_rows if g["season"] in TRAIN]
    test_rows = [g for g in final_rows if g["season"] in TEST]
    w_blend = best_blend(train_rows)               # chosen on training seasons only

    # Variant: add the starter-change adjustment (-2.9 points, estimated on the training seasons below).
    qb_rows = run(games, {**best, "qb": -2.9}, range(2016, 2026))
    qb_test = [g for g in qb_rows if g["season"] in TEST]
    qb_report = {"test": metrics(qb_test), "best_blend_weight_on_train": best_blend([g for g in qb_rows if g["season"] in TRAIN]),
                 "flags_test": {f"{t}pts": flags(qb_test, t / 100) for t in (5, 8, 10)}}
    blend_test = blended(test_rows, w_blend)
    report = {
        "generated_for": "NFL",
        "chosen": {k: best[k] for k in ("half_life", "shrink", "prior", "sigma")},
        "model_weight_in_blend": w_blend,
        "training_seasons": "2016-2022", "test_seasons": "2023-2025 (not used to choose settings)",
        "train": metrics(train_rows), "test": metrics(test_rows),
        "test_blended": metrics(blend_test),
        "reliability_test": reliability(test_rows),
        "flags_test_model_only": {f"{t}pts": flags(test_rows, t / 100) for t in (5, 8, 10)},
        "flags_test_blended": {f"{t}pts": flags(blend_test, t / 100) for t in (5, 8, 10)},
        "starting_qb_effect": qb_effect(final_rows),
        "variant_with_starter_change_adjustment": qb_report,
        "home_field_points_recent": round(float(np.mean([g["hs"] - g["as"] for g in test_rows])), 2),
    }
    print(json.dumps(report, indent=2))
    out = ROOT / "data" / "calibration.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {out}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
