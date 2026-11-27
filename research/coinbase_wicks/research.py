"""Coinbase BTC-USD trade backfill and one-second wick event study. Stdlib only."""
import argparse
import csv
import http.client
import json
import math
import random
import sqlite3
import statistics
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, deque
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from queue import Queue

ROOT = Path(__file__).resolve().parent
BJ = timezone(timedelta(hours=8))
UTC = timezone.utc


def timestamp(value):
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=BJ)
    return round(dt.timestamp() * 1_000_000)


def iso(us, tz=UTC):
    return datetime.fromtimestamp(us / 1_000_000, tz).isoformat()


def connect(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.executescript("""
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY, us INTEGER NOT NULL, price TEXT NOT NULL,
        size TEXT NOT NULL, maker_side TEXT NOT NULL, raw TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS trade_time ON trades(us, id);
      CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
    """)
    return db


class RateLimiter:
    """Keep aggregate threads under Coinbase's public 10 requests/second limit."""
    def __init__(self, interval=.2):
        self.interval = interval
        self.lock = threading.Lock()
        self.last = 0.0

    def wait(self):
        with self.lock:
            delay = self.interval - (time.monotonic() - self.last)
            if delay > 0:
                time.sleep(delay)
            self.last = time.monotonic()


class Client:
    limiter = RateLimiter()

    def __init__(self, limiter=None):
        self.limiter = limiter or Client.limiter
        self.connection = None

    def _reset(self):
        if self.connection is not None:
            self.connection.close()
            self.connection = None

    def get(self, **params):
        path = "/products/BTC-USD/trades?" + urllib.parse.urlencode(params)
        url = "https://api.exchange.coinbase.com" + path
        for attempt in range(8):
            self.limiter.wait()
            try:
                if self.connection is None:
                    self.connection = http.client.HTTPSConnection(
                        "api.exchange.coinbase.com", timeout=10)
                self.connection.request("GET", path, headers={
                    "User-Agent": "CoinbaseWickResearch/0.1", "Accept": "application/json",
                    "Connection": "keep-alive"})
                response = self.connection.getresponse()
                body = response.read()
                if response.status != 200:
                    self._reset()
                    raise urllib.error.HTTPError(url, response.status, response.reason,
                                                  response.headers, None)
                rows = json.loads(body)
                cursor = response.headers.get("CB-AFTER")
                if response.getheader("Connection", "").lower() == "close":
                    self._reset()
                if not isinstance(rows, list):
                    raise ValueError("API did not return a trade list")
                return rows, cursor
            except (urllib.error.URLError, OSError, TimeoutError,
                    http.client.HTTPException, json.JSONDecodeError) as exc:
                self._reset()
                if isinstance(exc, urllib.error.HTTPError) and exc.code not in (429, 500, 502, 503, 504):
                    raise
                print(f"retry={attempt + 1} params={params} error={exc}", flush=True)
                if attempt == 7:
                    raise
                time.sleep(min(60, 2 ** attempt + random.random()))

    def seek(self, end):
        latest, _ = self.get(limit=1)
        if not latest or timestamp(latest[0]["time"]) < end:
            raise ValueError("End time must precede latest available trade")
        lo, hi = 1, int(latest[0]["trade_id"])
        # Locate first ID with time >= end; assumes BTC-USD IDs/time are ordered.
        # Fetch phase checks ordering and both coverage boundaries independently.
        while lo < hi:
            mid = (lo + hi) // 2
            rows, _ = self.get(limit=1, after=mid + 1)
            if not rows:
                raise ValueError("Historical seek unavailable at trade ID " + str(mid))
            if timestamp(rows[0]["time"]) < end:
                lo = mid + 1
            else:
                hi = mid
        return lo


def _normalise_rows(rows):
    records = []
    for row in rows:
        p, v = Decimal(row["price"]), Decimal(row["size"])
        if not p.is_finite() or not v.is_finite() or p <= 0 or v <= 0 or row["side"] not in ("buy", "sell"):
            raise ValueError("Invalid trade values")
        records.append((int(row["trade_id"]), timestamp(row["time"]),
                        row["price"], row["size"], row["side"], ""))
    ids = [r[0] for r in records]
    times = [r[1] for r in records]
    if any(a <= b for a, b in zip(ids, ids[1:])) or any(a < b for a, b in zip(times, times[1:])):
        raise ValueError("Unexpected API order")
    if any(a - b != 1 for a, b in zip(ids, ids[1:])):
        raise ValueError("Trade ID gap within page; completeness unverified")
    return records


def _fetch_segment(client, lo, hi, max_pages, messages, resume=None):
    if resume:
        cursor, resume_us = resume
        previous_oldest = (cursor, resume_us)
        records_emitted = hi - cursor + 1
    else:
        cursor, previous_oldest, records_emitted = hi + 1, None, 0
    newest_us = oldest_us = None
    pages = 0
    try:
        for page in range(max_pages):
            rows, next_cursor = client.get(limit=1000, after=cursor)
            if not rows:
                raise ValueError(f"History ended before segment {lo}-{hi}")
            records = _normalise_rows(rows)
            if previous_oldest is not None and (records[0][0] != previous_oldest[0] - 1 or
                                                records[0][1] > previous_oldest[1]):
                raise ValueError("Trade ID gap or non-monotone time across pages")
            selected = [r for r in records if lo <= r[0] <= hi]
            if selected:
                records_emitted += len(selected)
                newest_us = selected[0][1] if newest_us is None else newest_us
                oldest_us = selected[-1][1]
                messages.put(("page", selected))
            pages += 1
            previous_oldest = (records[-1][0], records[-1][1])
            if records[-1][0] <= lo:
                if records_emitted != hi - lo + 1:
                    raise ValueError(f"Segment has missing IDs: {records_emitted}/{hi-lo+1}")
                return dict(lo=lo, hi=hi, count=records_emitted, pages=pages,
                            newest_us=newest_us, oldest_us=oldest_us, resumed=bool(resume))
            if not next_cursor or int(next_cursor) >= int(cursor):
                raise ValueError("Pagination stalled")
            cursor = int(next_cursor)
        raise ValueError(f"Page budget exhausted for segment {lo}-{hi}")
    except Exception as exc:
        messages.put(("error", exc))
        raise
    finally:
        messages.put(("done", (lo, hi)))


def _segments(start_cursor, end_cursor, workers):
    count = end_cursor - start_cursor
    if count <= 0:
        raise ValueError("No trades in requested interval")
    workers = min(workers, count)
    return [
        (start_cursor + count * i // workers,
         start_cursor + count * (i + 1) // workers - 1)
        for i in range(workers)
    ]


def backfill(args):
    start, end = timestamp(args.start), timestamp(args.end)
    if start >= end:
        raise ValueError("start must precede end")
    if args.workers < 1 or args.max_pages < 1:
        raise ValueError("workers and max-pages must be positive")
    db = connect(args.db)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=NORMAL")
    # Time index is rebuilt only after the complete ID range is inserted.
    db.execute("DROP INDEX IF EXISTS trade_time")
    client = Client()
    meta = dict(product="BTC-USD", source="Coinbase Exchange REST trades",
                start_utc=iso(start), end_utc=iso(end), status="partial", pages=0,
                requested_at=iso(time.time_ns() // 1000), workers=args.workers,
                raw_payload_retained=False)
    db.execute("INSERT INTO runs(payload) VALUES (?)", (json.dumps(meta),))
    run_id = db.execute("SELECT last_insert_rowid()").fetchone()[0]
    db.commit()
    try:
        start_cursor, end_cursor = client.seek(start), client.seek(end)
        segments = _segments(start_cursor, end_cursor, args.workers)
        meta.update(start_trade_id=start_cursor, end_trade_id=end_cursor - 1,
                    segments=len(segments), expected_trades=end_cursor - start_cursor)
        resumes = {}
        for lo, hi in segments:
            count, existing_lo, existing_hi = db.execute(
                "SELECT count(*), min(id), max(id) FROM trades WHERE id BETWEEN ? AND ?", (lo, hi)).fetchone()
            if count:
                if existing_hi != hi or count != existing_hi - existing_lo + 1:
                    raise ValueError(f"Existing segment is not a contiguous suffix: {lo}-{hi}")
                existing_us = db.execute("SELECT min(us) FROM trades WHERE id=?", (existing_lo,)).fetchone()[0]
                resumes[lo] = (existing_lo, existing_us)
        meta["resumed_existing"] = sum(hi - resumes[lo][0] + 1 for lo, hi in segments if lo in resumes)
        messages, results, failures = Queue(maxsize=args.workers * 2), {}, []
        with ThreadPoolExecutor(max_workers=len(segments)) as pool:
            futures = {pool.submit(_fetch_segment, Client(client.limiter), lo, hi,
                                   args.max_pages, messages, resumes.get(lo)): (lo, hi) for lo, hi in segments}
            while futures:
                kind, payload = messages.get(timeout=60)
                if kind == "page":
                    db.executemany("INSERT OR IGNORE INTO trades VALUES (?,?,?,?,?,?)", payload)
                    meta["rows_seen"] = meta.get("rows_seen", 0) + len(payload)
                    if meta["rows_seen"] % 20_000 < len(payload):
                        db.commit()
                        print(f"stored={meta['rows_seen']}/{meta['expected_trades']}", flush=True)
                elif kind == "error":
                    failures.append(str(payload))
                for future in tuple(futures):
                    if future.done():
                        exc = future.exception()
                        if exc:
                            raise exc
                        result = future.result()
                        results[result["lo"]] = result
                        del futures[future]
        db.commit()
        if failures:
            raise ValueError("; ".join(failures))
        if sorted(results) != [x[0] for x in segments]:
            raise ValueError("Not all ID segments completed")
        ordered = [results[x[0]] for x in segments]
        for result in ordered:
            if result["count"] != result["hi"] - result["lo"] + 1:
                raise ValueError("Segment count mismatch")
        stored, observed_start, observed_end = db.execute(
            "SELECT count(*), min(us), max(us) FROM trades WHERE id>=? AND id<?",
            (start_cursor, end_cursor)).fetchone()
        if stored != end_cursor - start_cursor:
            raise ValueError(f"Stored ID coverage mismatch: {stored}/{end_cursor-start_cursor}")
        if observed_start < start or observed_end >= end:
            raise ValueError("Requested time boundaries not covered")
        db.execute("CREATE INDEX IF NOT EXISTS trade_time ON trades(us, id)")
        meta.update(status="complete", pages=sum(r["pages"] for r in ordered),
                    oldest_utc=iso(observed_start), newest_utc=iso(observed_end),
                    rows_seen=stored)
    except Exception as exc:
        meta["error"] = str(exc)
        raise
    finally:
        db.execute("UPDATE runs SET payload=? WHERE id=?", (json.dumps(meta), run_id))
        db.commit()
        db.close()
        print(json.dumps(meta, ensure_ascii=False), flush=True)

def iter_bars(rows):
    """Yield ordered bars from rows without inventing trades in empty seconds."""
    group, current = [], None
    def finish():
        if not group:
            return
        prices = [Decimal(r[2]) for r in group]
        sizes = [Decimal(r[3]) for r in group]
        o, c, h, l = prices[0], prices[-1], max(prices), min(prices)
        lower, upper = min(o, c) - l, h - max(o, c)
        span = h - l
        return dict(second=current, time_bj=iso(current * 1_000_000, BJ),
            open=float(o), high=float(h), low=float(l), close=float(c),
            volume_btc=float(sum(sizes)), trades=len(group),
            max_print_btc=float(max(sizes)),
            candle_color="阳" if c > o else ("阴" if c < o else "平"),
            aggressive_sell_btc=float(sum((v for v, r in zip(sizes, group) if r[4] == "buy"), Decimal(0))),
            aggressive_buy_btc=float(sum((v for v, r in zip(sizes, group) if r[4] == "sell"), Decimal(0))),
            lower_usd=float(lower), upper_usd=float(upper), range_usd=float(span),
            lower_bps=float(lower / c * 10000), upper_bps=float(upper / c * 10000),
            lower_ratio=float(lower / span) if span else 0,
            upper_ratio=float(upper / span) if span else 0,
            lower_wick_volume_btc=float(sum((v for p, v in zip(prices, sizes) if p < min(o, c)), Decimal(0))),
            upper_wick_volume_btc=float(sum((v for p, v in zip(prices, sizes) if p > max(o, c)), Decimal(0))))
    for row in rows:
        sec = row[1] // 1_000_000
        if sec != current:
            if group:
                yield finish()
            group, current = [], sec
        group.append(row)
    if group:
        yield finish()


def build_bars(rows):
    return list(iter_bars(rows))


def select_events(bars, args, on_bar=None):
    events, history = [], deque()
    for bar in bars:
        sec = bar["second"]
        while history and history[0][0] < sec - 600:
            history.popleft()
        nonzero = [x[1] for x in history if x[1] > 0]
        baseline = statistics.median(nonzero) if nonzero else None
        for side in ("lower", "upper"):
            wick = bar[side + "_usd"]
            multiple = wick / baseline if baseline else None
            if (bar["volume_btc"] >= args.min_volume and wick > 0 and
                wick >= args.min_wick_usd and bar[side + "_bps"] >= args.min_wick_bps and
                bar[side + "_ratio"] >= args.min_ratio and
                (args.min_multiple == 0 or (multiple is not None and multiple >= args.min_multiple))):
                events.append(dict(bar, direction=side, prior_range_median_usd=baseline,
                                   prior_nonzero_range_seconds=len(nonzero), wick_multiple=multiple))
        if on_bar is not None:
            on_bar(bar)
        history.append((sec, bar["range_usd"]))
    return events


def write_csv(path, rows):
    if not rows:
        path.write_text("", encoding="utf-8-sig")
        return
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def _coverage_bounds(runs):
    intervals = sorted((timestamp(r["start_utc"]), timestamp(r["end_utc"]))
                       for r in runs if r.get("status") == "complete")
    merged = []
    for lo, hi in intervals:
        if merged and lo <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], hi))
        else:
            merged.append((lo, hi))
    return merged


def _closest_bar(db, target, earliest):
    rows = db.execute("SELECT * FROM trades WHERE us>=? AND us<? ORDER BY us,id",
                      (earliest * 1_000_000, (target + 1) * 1_000_000))
    found = {bar["second"]: bar for bar in iter_bars(rows)}
    return next((found[t] for t in range(target, earliest - 1, -1) if t in found), None)


def analyze(args):
    start, end = timestamp(args.start), timestamp(args.end)
    if start >= end or start % 1_000_000 or end % 1_000_000:
        raise ValueError("Use ascending whole-second boundaries")
    with closing(connect(args.db)) as db:
        runs = [json.loads(r[0]) for r in db.execute("SELECT payload FROM runs")]
        covering = next(((lo, hi) for lo, hi in _coverage_bounds(runs)
                         if lo <= start and end <= hi), None)
        if covering is None:
            raise ValueError("No continuous complete backfill covers analysis interval")
        covered_start, covered_end = covering
        context_start = max(start - 600_000_000, covered_start)
        context_end = min(end + 900_000_000, covered_end)
        rows = db.execute("SELECT * FROM trades WHERE us>=? AND us<? ORDER BY us,id",
                          (context_start, context_end))
        args.output.mkdir(parents=True, exist_ok=True)
        bars_file = (args.output / "bars_1s.csv").open("w", encoding="utf-8-sig", newline="")
        candidates_file = (args.output / "volume_candidates.csv").open("w", encoding="utf-8-sig", newline="")
        bars_writer = candidates_writer = None
        active_seconds = scanned_seconds = 0
        candidate_mix = Counter()
        bar_mix = Counter()
        def on_bar(bar):
            nonlocal active_seconds, scanned_seconds, bars_writer, candidates_writer
            scanned_seconds += 1
            if not (start <= bar["second"] * 1_000_000 < end):
                return
            active_seconds += 1
            bar_mix[bar["candle_color"]] += 1
            if bars_writer is None:
                bars_writer = csv.DictWriter(bars_file, fieldnames=list(bar))
                bars_writer.writeheader()
                candidates_writer = csv.DictWriter(candidates_file, fieldnames=list(bar))
                candidates_writer.writeheader()
            bars_writer.writerow(bar)
            if bar["volume_btc"] >= args.min_volume:
                candidates_writer.writerow(bar)
                candidate_mix[bar["candle_color"]] += 1
            if scanned_seconds % 100_000 == 0:
                print(f"scanned_seconds={scanned_seconds}", flush=True)
        try:
            all_events = select_events(iter_bars(rows), args, on_bar=on_bar)
        finally:
            bars_file.close()
            candidates_file.close()
        events = [e for e in all_events if start <= e["second"] * 1_000_000 < end]
        start_sec, end_sec = context_start // 1_000_000, context_end // 1_000_000
        for e in events:
            for horizon in (5, 30, 60, 300, 900):
                target = e["second"] + horizon
                earliest = max(start_sec, target - 5)
                mark = _closest_bar(db, target, earliest) if target < end_sec else None
                valid = mark is not None
                e[f"return_{horizon}s_bps"] = (mark["close"] / e["close"] - 1) * 10000 if valid else None
                e[f"mark_age_{horizon}s"] = target - mark["second"] if valid else None
    write_csv(args.output / "events.csv", events)
    event_mix = Counter((e["direction"], e["candle_color"]) for e in events)
    event_groups = {}
    for (side, candle), count in sorted(event_mix.items()):
        group = [e for e in events if e["direction"] == side and e["candle_color"] == candle]
        stats = dict(count=count,
                     median_volume_btc=statistics.median(e["volume_btc"] for e in group),
                     median_wick_usd=statistics.median(e[side + "_usd"] for e in group))
        for horizon in (5, 30, 60, 300, 900):
            values = [e[f"return_{horizon}s_bps"] for e in group
                      if e[f"return_{horizon}s_bps"] is not None]
            stats[f"return_{horizon}s_n"] = len(values)
            stats[f"return_{horizon}s_median_bps"] = statistics.median(values) if values else None
        event_groups[f"{side}_{candle}"] = stats
    summary = dict(product="BTC-USD", start_bj=iso(start, BJ), end_bj=iso(end, BJ),
                   context_start_bj=iso(context_start, BJ), context_end_bj=iso(context_end, BJ),
                   coverage="complete", active_seconds=active_seconds,
                   empty_seconds=(end - start) // 1_000_000 - active_seconds,
                   event_count=len(events), unique_event_seconds=len({e["second"] for e in events}),
                   bars_by_candle=dict(sorted(bar_mix.items())),
                   events_by_wick_candle={f"{side}_{candle}": count for (side, candle), count in sorted(event_mix.items())},
                   event_group_stats=event_groups,
                   volume_candidates_by_candle=dict(sorted(candidate_mix.items())),
                   thresholds={k: getattr(args, k) for k in
                       ("min_volume", "min_wick_usd", "min_wick_bps", "min_ratio", "min_multiple")},
                   note="Forward returns are descriptive marks, not executable backtest P&L. Empty seconds omitted; mark age <=5 seconds.")
    (args.output / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))
    for e in events:
        print(e["time_bj"], e["candle_color"], e["direction"], f'volume={e["volume_btc"]:.8f}',
              f'wick_usd={e[e["direction"] + "_usd"]:.2f}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=ROOT / "data" / "trades.sqlite")
    sub = parser.add_subparsers(dest="command", required=True)
    fetch = sub.add_parser("backfill")
    fetch.add_argument("--max-pages", type=int, default=5000)
    fetch.add_argument("--workers", type=int, default=24)
    scan = sub.add_parser("analyze")
    scan.add_argument("--output", type=Path, default=ROOT / "output")
    scan.add_argument("--min-volume", type=float, default=10)
    scan.add_argument("--min-wick-usd", type=float, default=20)
    scan.add_argument("--min-wick-bps", type=float, default=3)
    scan.add_argument("--min-ratio", type=float, default=0)
    scan.add_argument("--min-multiple", type=float, default=0)
    for p in (fetch, scan):
        p.add_argument("--start", required=True, help="ISO datetime; naive means Beijing UTC+8")
        p.add_argument("--end", required=True, help="Exclusive ISO datetime; naive means Beijing UTC+8")
    args = parser.parse_args()
    if args.command == "analyze":
        for name in ("min_volume", "min_wick_usd", "min_wick_bps", "min_ratio", "min_multiple"):
            if not math.isfinite(getattr(args, name)) or getattr(args, name) < 0:
                parser.error("Thresholds must be finite and nonnegative")
        if args.min_ratio > 1:
            parser.error("min-ratio must be <=1")
    try:
        (backfill if args.command == "backfill" else analyze)(args)
    except (ValueError, urllib.error.URLError, TimeoutError) as exc:
        parser.exit(1, str(exc) + "\n")


if __name__ == "__main__":
    main()
