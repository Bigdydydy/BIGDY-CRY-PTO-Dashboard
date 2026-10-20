"""
Unit tests for src/structure.build_structure (Core structural breadth).

Contract under test: build_structure(rows, by_date) ->
{methodology, current, series}; each series point carries index / 52-week
drawdown / breadth-diagnostic fields with nulls for unavailable values.
Run: python test_structure.py
"""

import sys
import unittest
from datetime import date, timedelta
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

import config
from src import breadth, structure


BASE = date(2026, 1, 1)


def _mk_by_date(days):
    """days: list of {coin_id: (price, market_cap)} for consecutive days."""
    return {(BASE + timedelta(days=i)).isoformat(): day for i, day in enumerate(days)}


def _run(by_date, top_n=2):
    rows = breadth.core_breadth(by_date, set(), top_n=top_n)
    return structure.build_structure(rows, by_date)


def _daily(days):
    """Consecutive days of two coins: 'a' drifts -1%/day, 'b' is flat."""
    return [{"a": (100.0 * 0.99 ** i, 300), "b": (100.0, 100)} for i in range(days)]


class TestIndexConstruction(unittest.TestCase):
    def test_ew_and_cw_returns_base_100(self):
        """prev prices=100 caps=300/100 -> prices=110/90: EW +0%, CW +5%."""
        by_date = _mk_by_date([
            {"a": (100.0, 300), "b": (100.0, 100)},
            {"a": (110.0, 330), "b": (90.0, 90)},
        ])
        res = _run(by_date)
        self.assertIn("methodology", res)
        self.assertEqual(res["current"], res["series"][-1])
        p = res["series"][0]
        self.assertTrue(p["index_ready"])
        self.assertFalse(p["ready"])                  # far short of 52 weeks
        self.assertEqual(p["status"], "warming_up")
        self.assertAlmostEqual(p["ew_index"], 100.0)  # (+10% + -10%) / 2
        self.assertAlmostEqual(p["cw_index"], 105.0)  # .75*+10% + .25*-10%
        self.assertEqual(p["consecutive_days"], 1)
        self.assertIsNone(p["ew_drawdown_52w"])
        self.assertIsNone(p["drawdown_gap_pp"])
        self.assertIsNone(p["gap_percentile"])

    def test_same_day_caps_do_not_change_returns(self):
        """Weights come from the previous day; today's caps are irrelevant."""
        by_date = _mk_by_date([
            {"a": (100.0, 300), "b": (100.0, 100)},
            {"a": (110.0, 99999), "b": (90.0, 1)},
        ])
        p = _run(by_date)["series"][0]
        self.assertAlmostEqual(p["ew_index"], 100.0)
        self.assertAlmostEqual(p["cw_index"], 105.0)


class TestSegmentIntegrity(unittest.TestCase):
    def test_missing_quote_invalidates_then_restarts(self):
        by_date = _mk_by_date([
            {"a": (100.0, 300), "b": (100.0, 100), "c": (50.0, 10)},
            {"a": (110.0, 330), "b": (90.0, 90), "c": (55.0, 11)},
            {"a": (121.0, 360), "c": (50.0, 12)},                    # b unquoted
            {"a": (133.1, 400), "b": (80.0, 70), "c": (45.0, 9)},
        ])
        series = _run(by_date)["series"]
        broken = series[1]                                # 2026-01-03 row
        self.assertFalse(broken["index_ready"])
        self.assertEqual(broken["status"], "incomplete_quotes")
        self.assertIsNone(broken["ew_index"])
        self.assertIsNone(broken["ew_drawdown_52w"])
        fresh = series[2]                                 # 2026-01-04 row
        self.assertTrue(fresh["index_ready"])
        self.assertEqual(fresh["consecutive_days"], 1)    # new segment at 01-03
        self.assertAlmostEqual(fresh["ew_index"], 100.0)  # a +10% / c -10%
        self.assertAlmostEqual(fresh["cw_index"], 100 * (1 + (360 / 372) * 0.10
                                                         - (12 / 372) * 0.10), places=3)

    def test_calendar_gap_resets_segment(self):
        # 5 consecutive price days; relabel the last two so 01-04 is missing,
        # making the observed dates jump 01-03 -> 01-05.
        days = _daily(5)
        moved = {}
        for i, (_d, v) in enumerate(sorted(_mk_by_date(days).items())):
            moved[(BASE + timedelta(days=i if i < 3 else i + 1)).isoformat()] = v
        series = _run(moved)["series"]
        self.assertEqual([p["date"] for p in series],
                         ["2026-01-02", "2026-01-03", "2026-01-06"])
        after = series[-1]                                # 01-06, p = 01-05
        self.assertTrue(after["index_ready"])
        self.assertEqual(after["consecutive_days"], 1)    # segment restarted at 01-05
        # Rebased to 100: a kept falling -1%/day so EW = 100 * (1 - 0.005).
        self.assertAlmostEqual(after["ew_index"], 99.5, places=3)
        self.assertEqual(after["status"], "warming_up")

    def test_drawdown_waits_for_full_52_week_window(self):
        by_date = _mk_by_date(_daily(365))
        series = _run(by_date)["series"]
        short = series[362]                               # day 364: window not full
        self.assertFalse(short["ready"])
        self.assertIsNone(short["ew_drawdown_52w"])
        self.assertIsNone(short["gap_percentile"])
        full = series[363]                                # day 365: exactly 364d span
        self.assertTrue(full["ready"])
        self.assertEqual(full["status"], "ready")
        self.assertEqual(full["consecutive_days"], 364)
        for dd in (full["ew_drawdown_52w"], full["cw_drawdown_52w"]):
            self.assertIsNotNone(dd)
            self.assertGreaterEqual(dd, 0.0)
            self.assertLessEqual(dd, 100.0)
        # 'a' (75% weight) falls faster than 'b': CW drawdown deeper -> gap < 0
        self.assertAlmostEqual(full["drawdown_gap_pp"],
                               full["ew_drawdown_52w"] - full["cw_drawdown_52w"], places=3)
        self.assertLess(full["drawdown_gap_pp"], 0.0)
        self.assertIsNone(full["gap_percentile"])         # no prior ready obs


class TestDiagnostics(unittest.TestCase):
    def test_gap_percentile_needs_60_prior_ready_observations(self):
        by_date = _mk_by_date(_daily(430))
        series = _run(by_date)["series"]
        ready_pts = [p for p in series if p["ready"]]
        self.assertGreaterEqual(len(ready_pts), 61)
        self.assertIsNone(ready_pts[0]["gap_percentile"])
        self.assertIsNone(ready_pts[59]["gap_percentile"])   # 59 priors
        self.assertIsNotNone(ready_pts[60]["gap_percentile"])  # 60th prior onwards
        self.assertGreaterEqual(ready_pts[60]["gap_percentile"], 0.0)
        self.assertLessEqual(ready_pts[60]["gap_percentile"], 100.0)

    def test_sma200_counts_only_eligible_constituents(self):
        """'b' joins late: eligible is 1/2, pct reflects 'a' alone."""
        days = [{"a": (100.0 + i, 300), "c": (50.0, 100)} for i in range(206)]
        days[204]["b"] = (100.0, 500)                     # enters top-2 by cap
        days[205]["b"] = (110.0, 550)
        series = _run(_mk_by_date(days))["series"]
        last = series[-1]
        self.assertEqual(last["constituents"], 2)         # universe = {b, a}
        self.assertEqual(last["sma200_eligible"], 1)      # only 'a' has 200 days
        self.assertEqual(last["pct_above_sma200"], 100.0)  # 'a' rose every day
        early = series[100]
        self.assertEqual(early["sma200_eligible"], 0)     # neither 'a' nor 'c' at 200d
        self.assertIsNone(early["pct_above_sma200"])

    def test_vol_and_corr_publish_after_30_paired_days(self):
        days = []
        for i in range(35):
            wobble = 1.02 if i % 2 else 0.98
            days.append({
                "a": (100.0 * wobble ** i, 300),
                "b": (100.0 * (1.01 ** (i % 4)), 100),
                "bitcoin": (50000.0 * (1.01 ** i), 50),   # low cap: outside top-2
            })
        by_date = _mk_by_date(days)
        series = _run(by_date)["series"]
        self.assertIsNone(series[28]["realized_vol_30d"])   # 29 observations
        self.assertIsNotNone(series[29]["realized_vol_30d"])  # 30th publishes
        self.assertGreater(series[29]["realized_vol_30d"], 0.0)
        self.assertIsNotNone(series[29]["alt_btc_corr_30d"])
        self.assertEqual(series[29]["volatility_observations"], 30)


class TestMethodologyBlock(unittest.TestCase):
    def test_shape_and_no_predictive_claims(self):
        res = _run(_mk_by_date(_daily(3)))
        meta = res["methodology"]
        self.assertEqual(meta["index_base"], 100)
        self.assertIsNone(meta["fixed_danger_threshold"])
        self.assertEqual(meta["predictive_validation"], "not_performed")


if __name__ == "__main__":
    unittest.main()
