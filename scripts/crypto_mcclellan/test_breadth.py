"""
Unit tests for the McClellan breadth computations.
Run: python test_breadth.py
"""

import sys
import unittest
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

import config
from src import breadth


class TestRatioAdjusted(unittest.TestCase):
    def test_bounds_and_sign(self):
        self.assertEqual(breadth.ratio_adjusted(10, 0), 1000.0)
        self.assertEqual(breadth.ratio_adjusted(0, 10), -1000.0)
        self.assertEqual(breadth.ratio_adjusted(30, 10), 500.0)
        self.assertEqual(breadth.ratio_adjusted(0, 0), 0.0)


class TestMcClellan(unittest.TestCase):
    def test_warmup_and_summation(self):
        ramo = [100.0] * 10 + [-100.0] * 50
        osc, summ = breadth.mcclellan(ramo, warmup=5)
        self.assertTrue(all(v is None for v in osc[:4]))
        self.assertIsNotNone(osc[4])
        self.assertAlmostEqual(osc[4], 0.0)          # constant input: fast == slow
        self.assertLess(osc[20], 0)                  # turn negative after the flip
        running = 0.0
        for o, s in zip(osc[4:], summ[4:]):
            running += o
            self.assertAlmostEqual(s, running)

    def test_oscillator_is_ema_difference(self):
        ramo = [float(i % 7 - 3) * 100 for i in range(80)]
        osc, _ = breadth.mcclellan(ramo, warmup=1)
        fast = breadth.ema(ramo, config.EMA_FAST)
        slow = breadth.ema(ramo, config.EMA_SLOW)
        self.assertAlmostEqual(osc[-1], fast[-1] - slow[-1])


class TestCoreBreadth(unittest.TestCase):
    def test_ex_ante_top_n_membership(self):
        by_date = {
            "2026-01-01": {"a": (10.0, 300), "b": (10.0, 200), "c": (10.0, 100)},
            # c pumps into the top 2 on day 2, but membership comes from day 1
            "2026-01-02": {"a": (11.0, 330), "b": (9.0, 180), "c": (40.0, 400)},
            "2026-01-03": {"a": (10.0, 300), "b": (9.5, 190), "c": (44.0, 440)},
        }
        rows = breadth.core_breadth(by_date, excluded=set(), top_n=2)
        self.assertEqual([r["date"] for r in rows], ["2026-01-02", "2026-01-03"])
        self.assertEqual((rows[0]["adv"], rows[0]["dec"]), (1, 1))   # a up, b down; c ignored
        self.assertEqual({cid for cid, _ in rows[1]["members"]}, {"c", "a"})
        self.assertEqual((rows[1]["adv"], rows[1]["dec"]), (1, 1))   # c up, a down

    def test_gap_breaks_the_chain(self):
        by_date = {"2026-01-01": {"a": (1.0, 1)}, "2026-01-10": {"a": (2.0, 1)}}
        self.assertEqual(breadth.core_breadth(by_date, set()), [])

    def test_stable_and_peg_exclusion(self):
        by_date = {}
        btc = 100.0
        for i in range(30):
            d = f"2026-02-{i + 1:02d}" if i < 28 else f"2026-03-{i - 27:02d}"
            btc *= 1.03 if i % 2 else 0.98
            by_date[d] = {
                "bitcoin": (btc, 1000),
                "wrapped-thing": (btc * 1.0001, 50),      # tracks BTC
                "usd-thing": (1.0 + (i % 2) * 0.0005, 40),  # stable
                "alt": (10.0 + (i % 5), 30),
            }
        meta = {"bitcoin": ("BTC", "Bitcoin"), "wrapped-thing": ("XBT", "Thing"),
                "usd-thing": ("UUU", "Thing Dollar"), "alt": ("ALT", "Alt"),
                "lst": ("STETH", "Lido Staked Ether")}
        ex = breadth.core_exclusions(by_date, meta)
        self.assertEqual(ex.get("wrapped-thing"), "peg:bitcoin")
        self.assertEqual(ex.get("usd-thing"), "stable")
        self.assertEqual(ex.get("lst"), "symbol")
        self.assertNotIn("alt", ex)
        self.assertNotIn("bitcoin", ex)


class TestFrontierBreadth(unittest.TestCase):
    def test_entry_day_not_counted_and_expiring_token_measured(self):
        snap = {
            "2026-03-01": {
                "x": {"chain": "solana", "price": 1.0, "tracked": True},
                "z": {"chain": "robinhood", "price": 2.0, "tracked": True},
            },
            "2026-03-02": {
                "x": {"chain": "solana", "price": 0.5, "tracked": False},   # retention ended today
                "y": {"chain": "bsc", "price": 3.0, "tracked": True},       # new today: not counted
                "z": {"chain": "robinhood", "price": 0.0, "tracked": False, "dead": True},  # rugged
            },
            "2026-03-03": {
                "x": {"chain": "solana", "price": 0.4, "tracked": False},
                "y": {"chain": "bsc", "price": 3.3, "tracked": True},
            },
        }
        for day in snap.values():
            for row in day.values():
                row.setdefault("dead", False)
                row.setdefault("first_qualified", "2026-03-01")
        rows = breadth.frontier_breadth(snap)
        self.assertEqual((rows[0]["adv"], rows[0]["dec"], rows[0]["n"]), (0, 2, 2))
        self.assertEqual(rows[0]["dead"], 1)                      # rug counted, not dropped
        self.assertEqual((rows[0]["entries"], rows[0]["exits"]), (1, 2))
        self.assertEqual((rows[1]["adv"], rows[1]["dec"], rows[1]["n"]), (1, 0, 1))
        self.assertEqual(rows[1]["chains"], {"bsc": {"adv": 1, "dec": 0, "n": 1}})


class TestChainEqualWeight(unittest.TestCase):
    def test_small_chain_cannot_dominate(self):
        prev, cur = {}, {}
        # Solana: 3 members all up; Robinhood: 30 members all down
        for i in range(3):
            prev[f"s{i}"] = {"chain": "solana", "price": 1.0, "tracked": True, "dead": False, "first_qualified": "2026-03-01"}
            cur[f"s{i}"] = {"chain": "solana", "price": 1.1, "tracked": True, "dead": False, "first_qualified": "2026-03-01"}
        for i in range(30):
            prev[f"r{i}"] = {"chain": "robinhood", "price": 1.0, "tracked": True, "dead": False, "first_qualified": "2026-03-01"}
            cur[f"r{i}"] = {"chain": "robinhood", "price": 0.9, "tracked": True, "dead": False, "first_qualified": "2026-03-01"}
        cur["lone"] = {"chain": "bsc", "price": 2.0, "tracked": True, "dead": False, "first_qualified": "2026-03-01"}
        prev["lone"] = {"chain": "bsc", "price": 1.0, "tracked": True, "dead": False, "first_qualified": "2026-03-01"}
        row = breadth.frontier_breadth({"2026-03-01": prev, "2026-03-02": cur})[0]
        self.assertEqual(row["ramo"], 0.0)                      # (+1000 + -1000) / 2; bsc sits out
        self.assertAlmostEqual(row["ramo_pooled"], (4 - 30) / 34 * 1000)  # pooled: dominated by robinhood


class TestAnchor(unittest.TestCase):
    def test_momentum_and_late_chain(self):
        from src import anchor
        rows = []
        for i in range(40):
            d = f"2026-01-{i + 1:02d}" if i < 31 else f"2026-02-{i - 30:02d}"
            rows.append({"date": d, "chain": "solana", "volume_usd": "100"})
            if i >= 30:  # a chain launching late must not move the momentum yet
                rows.append({"date": d, "chain": "robinhood", "volume_usd": "900"})
        mom = anchor.momentum(rows)
        self.assertIsNone(mom["2026-01-27"]["momentum"])
        self.assertAlmostEqual(mom["2026-02-09"]["momentum"], 0.0)
        self.assertEqual(mom["2026-02-09"]["volume"], 1000.0)
        self.assertAlmostEqual(anchor.pearson([1, 2, 3, 4], [2, 4, 6, 8]), 1.0)


class TestTradeDate(unittest.TestCase):
    def test_delayed_cron_runs_land_on_the_same_close(self):
        from datetime import datetime, timezone
        from export_to_json import trade_date_now
        label = lambda h, m, day=6: trade_date_now(datetime(2026, 10, day, h, m, tzinfo=timezone.utc))
        # 00:15 schedule, observed GitHub delays of 2-3.5h, and an on-time run
        for h, m in [(0, 15), (2, 13), (2, 48), (3, 11), (11, 59)]:
            self.assertEqual(label(h, m), "2026-10-05")
        self.assertEqual(label(23, 30, day=5), "2026-10-05")
        # an off-schedule afternoon run labels the current day (overwritten after the close)
        self.assertEqual(label(14, 0), "2026-10-06")


class TestFinalSnapshot(unittest.TestCase):
    def test_only_post_close_complete_runs_are_final(self):
        from export_to_json import is_final
        self.assertTrue(is_final({"collected_at": "2026-10-07T03:21:00Z", "failed": []}, "2026-10-06"))
        self.assertFalse(is_final({"collected_at": "2026-10-06T14:00:00Z", "failed": []}, "2026-10-06"))
        self.assertFalse(is_final({"collected_at": "2026-10-07T03:21:00Z", "failed": ["frontier"]}, "2026-10-06"))
        self.assertFalse(is_final(None, "2026-10-06"))


if __name__ == "__main__":
    unittest.main()
