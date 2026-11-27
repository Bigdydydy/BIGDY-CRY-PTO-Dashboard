import tempfile
import unittest
import json
import csv
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch

import research as r


def trade(i, us, price, size, side="buy"):
    return (i, us, str(price), str(size), side, "{}")


def thresholds(**changes):
    return Namespace(**(dict(min_volume=10, min_wick_usd=20,
        min_wick_bps=3, min_ratio=.5, min_multiple=0) | changes))


class ResearchTests(unittest.TestCase):
    def test_beijing_naive_time(self):
        self.assertEqual(r.timestamp("2026-11-18T18:39:00"),
                         r.timestamp("2026-11-18T10:39:00Z"))

    def test_volume_and_wick_both_required(self):
        bars = r.build_bars([
            trade(1, 0, 64000, 1), trade(2, 1, 63950, 10), trade(3, 2, 64000, 1, "sell"),
            trade(4, 1_000_000, 64000, 1), trade(5, 1_000_001, 63950, 1), trade(6, 1_000_002, 64000, 1),
            trade(7, 2_000_000, 64000, 15)])
        events = r.select_events(bars, thresholds())
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["volume_btc"], 12)
        self.assertEqual(events[0]["lower_usd"], 50)
        self.assertEqual(events[0]["lower_wick_volume_btc"], 10)
        self.assertEqual(events[0]["aggressive_sell_btc"], 11)
        self.assertEqual(events[0]["aggressive_buy_btc"], 1)
        self.assertEqual(events[0]["max_print_btc"], 10)

    def test_upper_wick_and_empty_seconds(self):
        bars = r.build_bars([trade(1, 0, 64000, 1), trade(2, 1, 64050, 10),
                             trade(3, 2, 64000, 1), trade(4, 3_000_000, 64000, 1)])
        self.assertEqual([b["second"] for b in bars], [0, 3])
        self.assertEqual(r.select_events(bars, thresholds())[0]["direction"], "upper")

    def test_bearish_lower_and_bullish_upper_are_both_detected(self):
        bars = r.build_bars([
            trade(1, 0, 64000, 1), trade(2, 1, 63950, 10), trade(3, 2, 63990, 1),
            trade(4, 1_000_000, 64000, 1), trade(5, 1_000_001, 64060, 10), trade(6, 1_000_002, 64010, 1)])
        events = r.select_events(bars, thresholds())
        self.assertEqual([(e["candle_color"], e["direction"]) for e in events],
                         [("阴", "lower"), ("阳", "upper")])

    def test_current_event_excluded_from_baseline(self):
        bars = r.build_bars([trade(1, 0, 64000, 1), trade(2, 1, 64001, 1),
            trade(3, 1_000_000, 64000, 1), trade(4, 1_000_001, 63950, 10),
            trade(5, 1_000_002, 64000, 1)])
        e = r.select_events(bars, thresholds(min_multiple=10))[0]
        self.assertEqual(e["prior_range_median_usd"], 1)
        self.assertEqual(e["wick_multiple"], 50)

    def test_duplicate_storage_and_trade_id_order(self):
        with tempfile.TemporaryDirectory() as folder:
            db = r.connect(Path(folder) / "trades.sqlite")
            rows = [trade(2, 0, 63950, 10), trade(1, 0, 64000, 1), trade(3, 0, 64000, 1)]
            db.executemany("INSERT OR IGNORE INTO trades VALUES (?,?,?,?,?,?)", rows * 2)
            bars = r.build_bars(db.execute("SELECT * FROM trades ORDER BY us,id"))
            db.close()
            self.assertEqual(bars[0]["trades"], 3)
            self.assertEqual(bars[0]["lower_usd"], 50)

    def test_partial_backfill_cannot_be_analyzed(self):
        with tempfile.TemporaryDirectory() as folder:
            args = Namespace(db=Path(folder) / "trades.sqlite", start="2026-11-18T18:00:00",
                             end="2026-11-18T19:00:00")
            with self.assertRaisesRegex(ValueError, "No .*complete backfill"):
                r.analyze(args)

    def test_seek_finds_end_boundary(self):
        client = r.Client()
        def fake_get(**params):
            i = params.get("after", 11) - 1
            return [dict(trade_id=i, time=r.iso(i * 1_000_000))], str(i)
        with patch.object(client, "get", side_effect=fake_get):
            self.assertEqual(client.seek(5_500_000), 6)

    def test_context_and_forward_marks_respect_coverage(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            db = r.connect(path / "trades.sqlite")
            db.execute("INSERT INTO runs(payload) VALUES (?)", (json.dumps(dict(
                status="complete", start_utc=r.iso(0), end_utc=r.iso(8_000_000))),))
            db.executemany("INSERT INTO trades VALUES (?,?,?,?,?,?)", [
                trade(1, 0, 64000, 1), trade(2, 1, 64001, 1),
                trade(3, 1_000_000, 64000, 1), trade(4, 1_000_001, 63950, 10),
                trade(5, 1_000_002, 64000, 1), trade(6, 6_000_000, 64064, 1)])
            db.commit()
            db.close()
            args = thresholds()
            args.db, args.output = path / "trades.sqlite", path / "output"
            args.start, args.end = r.iso(1_000_000), r.iso(2_000_000)
            r.analyze(args)
            with (args.output / "events.csv").open(encoding="utf-8-sig", newline="") as f:
                e = list(csv.DictReader(f))[0]
            self.assertEqual(float(e["prior_range_median_usd"]), 1)
            self.assertAlmostEqual(float(e["return_5s_bps"]), 10)
            self.assertEqual(e["return_30s_bps"], "")

    def test_backfill_resumes_an_existing_contiguous_suffix(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "trades.sqlite"
            db = r.connect(path)
            db.executemany("INSERT INTO trades VALUES (?,?,?,?,?,?)",
                           [trade(i, i, 64000, 1) for i in range(2, 7)])
            db.commit()
            db.close()
            seen = {}
            def fake_segment(client, lo, hi, max_pages, messages, resume=None):
                seen.update(lo=lo, hi=hi, resume=resume)
                messages.put(("done", (lo, hi)))
                return dict(lo=lo, hi=hi, count=5, pages=0,
                            newest_us=1, oldest_us=5, resumed=True)
            with patch.object(r.Client, "seek", side_effect=[2, 7]), \
                 patch.object(r, "_fetch_segment", side_effect=fake_segment):
                r.backfill(Namespace(db=path, start=r.iso(0), end=r.iso(2_000_000),
                                     max_pages=1, workers=1))
            self.assertEqual(seen["resume"][0], 2)
            db = r.connect(path)
            run = json.loads(db.execute("SELECT payload FROM runs").fetchone()[0])
            db.close()
            self.assertEqual(run["status"], "complete")
            self.assertEqual(run["resumed_existing"], 5)

    def test_adjacent_complete_runs_form_continuous_coverage(self):
        runs = [dict(status="complete", start_utc=r.iso(0), end_utc=r.iso(5_000_000)),
                dict(status="complete", start_utc=r.iso(5_000_000), end_utc=r.iso(8_000_000)),
                dict(status="partial", start_utc=r.iso(8_000_000), end_utc=r.iso(9_000_000))]
        self.assertEqual(r._coverage_bounds(runs), [(0, 8_000_000)])

    def test_pagination_gap_marks_run_partial(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "trades.sqlite"
            rows = [dict(trade_id=i, time=r.iso(i * 1_000_000),
                         price="64000", size="1", side="buy") for i in (3, 1)]
            with patch.object(r.Client, "seek", side_effect=[2, 4]), \
                 patch.object(r.Client, "get", return_value=(rows, "1")):
                with self.assertRaisesRegex(ValueError, "gap"):
                    r.backfill(Namespace(db=path, start=r.iso(0), end=r.iso(2_000_000),
                                         max_pages=1, workers=1))
            db = r.connect(path)
            status = json.loads(db.execute("SELECT payload FROM runs").fetchone()[0])["status"]
            db.close()
            self.assertEqual(status, "partial")


if __name__ == "__main__":
    unittest.main()
