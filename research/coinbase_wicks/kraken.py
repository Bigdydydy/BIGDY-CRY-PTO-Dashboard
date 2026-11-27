"""Kraken XBT/USD reference check for Coinbase wick events. Stdlib only.

Kraken is only a reference: we iterate Coinbase events and ask whether Kraken moved
too. Wicks that happen only on Kraken are ignored by design.
"""
import argparse
import bisect
import csv
import gzip
import json
import math
import random
import sqlite3
import statistics
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from research import BJ, ROOT, iso, timestamp

API = "https://api.kraken.com/0/public/Trades"
MARGIN_US = 120 * 1_000_000          # extra Kraken data on both sides of the window
WINDOW = (-1, 2)                     # compare seconds [s-1, s+2) to absorb clock offset / lag
SOLO, SYNC = 0.2, 0.7                # provisional ratio cut-offs, to be calibrated by controls
MAX_ANCHOR_AGE_S = 30
MIN_REF_TRADES = 5                   # fewer Kraken prints in the window -> too sparse to judge


def connect(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.executescript("""
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY, us INTEGER NOT NULL, price TEXT NOT NULL,
        size TEXT NOT NULL, taker_side TEXT NOT NULL, ord_type TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS trade_time ON trades(us, id);
      CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
    """)
    return db


def fetch(since_ns):
    url = API + "?" + urllib.parse.urlencode(dict(pair="XBTUSD", since=since_ns, count=1000))
    for attempt in range(8):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "wick-research/0.1"})
            body = json.load(urllib.request.urlopen(req, timeout=20))
            if body.get("error"):
                raise RuntimeError(";".join(body["error"]))
            result = body["result"]
            rows = next(v for k, v in result.items() if k != "last")
            return rows, int(result["last"])
        except (urllib.error.URLError, OSError, TimeoutError, RuntimeError, ValueError) as exc:
            print(f"retry={attempt + 1} since={since_ns} error={exc}", flush=True)
            if attempt == 7:
                raise
            time.sleep(min(60, 2 ** attempt + random.random()))


def backfill(args):
    start, end = timestamp(args.start) - MARGIN_US, timestamp(args.end) + MARGIN_US
    db = connect(args.kraken_db)
    since, prev_id, pages, count = start * 1000, None, 0, 0
    while True:
        rows, last = fetch(since)
        pages += 1
        if not rows:
            raise ValueError("Kraken returned no trades before the end of the window")
        records = []
        for price, size, t, side, ord_type, _misc, tid in rows:
            tid = int(tid)
            if prev_id is not None and tid <= prev_id:
                continue                                  # overlap between pages
            if prev_id is not None and tid != prev_id + 1:
                raise ValueError(f"Kraken trade ID gap {prev_id} -> {tid}")
            if side not in ("b", "s"):
                raise ValueError("Unexpected side " + side)
            records.append((tid, round(float(t) * 1_000_000), price, size, side, ord_type))
            prev_id = tid
        db.executemany("INSERT OR IGNORE INTO trades VALUES (?,?,?,?,?,?)", records)
        db.commit()
        count += len(records)
        newest = records[-1][1] if records else start
        if pages % 20 == 0:
            print(f"pages={pages} trades={count} at={iso(newest, BJ)}", flush=True)
        if newest >= end:
            break
        if last <= since:
            raise ValueError("Kraken pagination stalled")
        since = last
        time.sleep(1.1)                                   # public limit ~1 req/s
    first = db.execute("SELECT min(us) FROM trades WHERE us >= ?", (start,)).fetchone()[0]
    payload = dict(start_us=start, end_us=end, pages=pages, trades=count, first_trade_us=first)
    db.execute("INSERT INTO runs(payload) VALUES (?)", (json.dumps(payload),))
    db.commit()
    print(json.dumps(payload | dict(start=iso(start, BJ), end=iso(end, BJ)), ensure_ascii=False))


class Venue:
    """In-memory trade tape: sorted (us, price, size, taker_sell)."""

    def __init__(self, rows):
        self.us = [r[0] for r in rows]
        self.price = [float(r[1]) for r in rows]
        self.size = [float(r[2]) for r in rows]
        self.sell = [r[3] for r in rows]

    def last_before(self, us):
        i = bisect.bisect_left(self.us, us) - 1
        return (self.price[i], self.us[i]) if i >= 0 else (None, None)

    def slice(self, a, b):
        return range(bisect.bisect_left(self.us, a), bisect.bisect_left(self.us, b))

    def closes(self, s0, s1):
        """Last price for every second in [s0, s1), forward-filled."""
        out, j = [], bisect.bisect_left(self.us, s0 * 1_000_000) - 1
        for s in range(s0, s1):
            end = (s + 1) * 1_000_000
            while j + 1 < len(self.us) and self.us[j + 1] < end:
                j += 1
            out.append(self.price[j] if j >= 0 else None)
        return out


def load_cb(db_path, a, b):
    db = sqlite3.connect(db_path)
    rows = db.execute("SELECT us, price, size, maker_side FROM trades "
                      "WHERE us >= ? AND us < ? ORDER BY us, id", (a, b)).fetchall()
    return Venue([(u, p, v, m == "buy") for u, p, v, m in rows])


def load_kraken(db_path, a, b):
    db = sqlite3.connect(db_path)
    rows = db.execute("SELECT us, price, size, taker_side FROM trades "
                      "WHERE us >= ? AND us < ? ORDER BY us, id", (a, b)).fetchall()
    return Venue([(u, p, v, t == "s") for u, p, v, t in rows])


def excursion(venue, s, direction):
    """Anchor = last trade before the window; extreme within the window, in bps toward the wick."""
    a, b = (s + WINDOW[0]) * 1_000_000, (s + WINDOW[1]) * 1_000_000
    anchor, anchor_us = venue.last_before(a)
    idx = venue.slice(a, b)
    if anchor is None or not idx:
        return None
    i = min(idx, key=lambda k: venue.price[k]) if direction == "lower" else max(idx, key=lambda k: venue.price[k])
    sign = 1 if direction == "lower" else -1
    with_wick = [k for k in idx if venue.sell[k] == (direction == "lower")]
    return dict(anchor=anchor, anchor_age_s=(a - anchor_us) / 1e6, extreme=venue.price[i],
                extreme_us=venue.us[i], exc_bps=sign * (anchor - venue.price[i]) / anchor * 1e4,
                volume=sum(venue.size[k] for k in idx), trades=len(idx),
                wick_side_volume=sum(venue.size[k] for k in with_wick))


def classify(ratio, ref_trades=MIN_REF_TRADES):
    if ratio is None:
        return "无参照"
    if ref_trades < MIN_REF_TRADES:
        return "参照稀疏"
    return "CB独有" if ratio < SOLO else ("部分同步" if ratio < SYNC else "同步")


def compare_one(cb, kr, s, direction):
    c, k = excursion(cb, s, direction), excursion(kr, s, direction)
    if not c or c["exc_bps"] <= 0:
        return None
    usable = k is not None and k["anchor_age_s"] <= MAX_ANCHOR_AGE_S
    ratio = max(0.0, k["exc_bps"]) / c["exc_bps"] if usable else None
    return dict(
        cb_anchor=c["anchor"], cb_extreme=c["extreme"], cb_exc_bps=round(c["exc_bps"], 3),
        kr_anchor=k and k["anchor"], kr_anchor_age_s=k and round(k["anchor_age_s"], 3),
        kr_extreme=k and k["extreme"], kr_exc_bps=k and round(k["exc_bps"], 3),
        ratio=None if ratio is None else round(ratio, 3), relation=classify(ratio, k["trades"] if usable else 0),
        lag_ms=round((k["extreme_us"] - c["extreme_us"]) / 1000) if usable else None,
        kr_volume_btc=k and round(k["volume"], 6), kr_trades=k and k["trades"],
        kr_wick_side_btc=k and round(k["wick_side_volume"], 6))


def alignment(cb, kr, s0, s1, lags=range(-3, 4)):
    """Correlation of 1s log returns, Kraken shifted by lag seconds (positive = Kraken later)."""
    pc, pk = cb.closes(s0, s1), kr.closes(s0, s1)
    rc = [math.log(b / a) if a and b else 0.0 for a, b in zip(pc, pc[1:])]
    rk = [math.log(b / a) if a and b else 0.0 for a, b in zip(pk, pk[1:])]
    out = {}
    for lag in lags:
        x = rc[max(0, -lag): len(rc) - max(0, lag)]
        y = rk[max(0, lag): len(rk) - max(0, -lag)]
        out[lag] = round(statistics.correlation(x, y), 4)
    return out


def control_seconds(bars_csv, s0, s1, args):
    """CB seconds in the window with the same wick filter but volume below the threshold."""
    rows = []
    opener = gzip.open if str(bars_csv).endswith(".gz") else open
    with opener(bars_csv, "rt", encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            s = int(r["second"])
            if s < s0:
                continue
            if s >= s1:
                break
            if float(r["volume_btc"]) >= args.min_volume:
                continue
            for d in ("lower", "upper"):
                if float(r[f"{d}_usd"]) >= args.min_wick_usd and float(r[f"{d}_bps"]) >= args.min_wick_bps:
                    rows.append((s, d))
    return rows


def summarise(rows):
    by = {}
    for r in rows:
        by.setdefault(r["relation"], []).append(r)
    ratios = [r["ratio"] for r in rows if r["ratio"] is not None]
    lags = [r["lag_ms"] for r in rows if r["lag_ms"] is not None and r["ratio"] and r["ratio"] >= SOLO]
    return dict(
        n=len(rows), relation_counts={k: len(v) for k, v in sorted(by.items())},
        ratio_median=round(statistics.median(ratios), 3) if ratios else None,
        ratio_quartiles=[round(q, 3) for q in statistics.quantiles(ratios, n=4)] if len(ratios) > 3 else None,
        lag_ms_median_when_moved=statistics.median(lags) if lags else None)


def compare(args):
    s0, s1 = timestamp(args.start) // 1_000_000, timestamp(args.end) // 1_000_000
    a, b = s0 * 1_000_000 - MARGIN_US, s1 * 1_000_000 + MARGIN_US
    cb, kr = load_cb(args.cb_db, a, b), load_kraken(args.kraken_db, a, b)
    if not kr.us or kr.us[0] > s0 * 1_000_000 - 60_000_000 or kr.us[-1] < s1 * 1_000_000:
        raise ValueError("Kraken data does not cover the window; run backfill first")
    print(f"CB trades={len(cb.us)} Kraken trades={len(kr.us)}", flush=True)

    events = []
    with open(args.events, encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            s = int(r["second"])
            if s0 <= s < s1:
                cmp = compare_one(cb, kr, s, r["direction"])
                events.append(dict(second=s, time_bj=r["time_bj"], direction=r["direction"],
                                   candle_color=r["candle_color"], volume_btc=r["volume_btc"],
                                   wick_usd=r[f"{r['direction']}_usd"],
                                   return_60s_bps=r["return_60s_bps"],
                                   return_300s_bps=r["return_300s_bps"], **(cmp or {})))
    events = [e for e in events if "relation" in e]

    controls = []
    for s, d in control_seconds(args.bars, s0, s1, args):
        cmp = compare_one(cb, kr, s, d)
        if cmp:
            controls.append(dict(second=s, direction=d, **cmp))

    out = args.output
    out.mkdir(parents=True, exist_ok=True)
    for name, rows in (("events_kraken.csv", events), ("controls_low_volume_kraken.csv", controls)):
        if rows:
            with open(out / name, "w", encoding="utf-8-sig", newline="") as f:
                w = csv.DictWriter(f, fieldnames=list(rows[0]))
                w.writeheader()
                w.writerows(rows)
    summary = dict(
        window=[iso(s0 * 1_000_000, BJ), iso(s1 * 1_000_000, BJ)],
        thresholds=dict(window_seconds=WINDOW, solo_below=SOLO, sync_from=SYNC,
                        max_anchor_age_s=MAX_ANCHOR_AGE_S),
        cb_trades=len(cb.us), kraken_trades=len(kr.us),
        return_correlation_by_lag_s=alignment(cb, kr, s0, s1),
        events=summarise(events), controls_low_volume_same_wick=summarise(controls))
    (out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--kraken-db", type=Path, default=ROOT / "data" / "kraken_xbtusd.sqlite")
    sub = p.add_subparsers(dest="cmd", required=True)
    fetch_p = sub.add_parser("backfill")
    cmp_p = sub.add_parser("compare")
    cmp_p.add_argument("--cb-db", type=Path, required=True)
    cmp_p.add_argument("--events", type=Path, required=True)
    cmp_p.add_argument("--bars", type=Path, required=True, help="bars_1s.csv for the control group")
    cmp_p.add_argument("--output", type=Path, required=True)
    cmp_p.add_argument("--min-volume", type=float, default=10)
    cmp_p.add_argument("--min-wick-usd", type=float, default=20)
    cmp_p.add_argument("--min-wick-bps", type=float, default=3)
    for q in (fetch_p, cmp_p):
        q.add_argument("--start", required=True, help="ISO datetime; naive means Beijing UTC+8")
        q.add_argument("--end", required=True, help="Exclusive ISO datetime; naive means Beijing UTC+8")
    args = p.parse_args()
    (backfill if args.cmd == "backfill" else compare)(args)


if __name__ == "__main__":
    main()
