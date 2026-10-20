"""
Unit tests for the McClellan breadth computations.
Run: python test_breadth.py
"""

import contextlib
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

ROOT_DIR = Path(__file__).resolve().parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

import config
from src import breadth, core_track, frontier_track


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

    def test_unquoted_prev_member_stays_in_expected_denominator(self):
        # A tracked member whose prior price is missing (price=0, not dead)
        # cannot be measured, but it still belongs to the ex-ante basket:
        # expected_n counts it, coverage drops, the day is incomplete.
        prev = {
            "a": {"chain": "solana", "price": 1.0, "tracked": True, "dead": False, "first_qualified": "2026-03-01"},
            "b": {"chain": "solana", "price": 0.0, "tracked": True, "dead": False, "first_qualified": "2026-03-01"},
        }
        cur = {
            "a": {"chain": "solana", "price": 1.1, "tracked": True, "dead": False, "first_qualified": "2026-03-01"},
            "b": {"chain": "solana", "price": 0.0, "tracked": True, "dead": False, "first_qualified": "2026-03-01"},
        }
        row = breadth.frontier_breadth({"2026-03-01": prev, "2026-03-02": cur})[0]
        self.assertEqual(row["expected_n"], 2)
        self.assertEqual(row["n"], 1)
        self.assertEqual(row["coverage_pct"], 50.0)
        self.assertFalse(row["complete"])


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
    def test_labels_are_the_actual_utc_sampling_date(self):
        from export_to_json import trade_date_now
        label = lambda h, m: trade_date_now(datetime(2026, 10, 6, h, m, tzinfo=timezone.utc))
        # No close-alignment lag: whatever UTC time the job runs is its date.
        for h, m in [(0, 15), (11, 59), (23, 30)]:
            self.assertEqual(label(h, m), "2026-10-06")
        # aware non-UTC input is converted, not truncated
        from datetime import timedelta
        self.assertEqual(trade_date_now(datetime(2026, 10, 6, 1, 0,
                                                 tzinfo=timezone(timedelta(hours=2)))),
                         "2026-10-05")


class TestFinalSnapshot(unittest.TestCase):
    def test_only_verified_utc_snapshot_runs_are_final(self):
        from export_to_json import is_final
        good = {"collected_at": "2026-10-06T00:15:00Z",
                "sampling_basis": "utc_snapshot", "failed": []}
        self.assertTrue(is_final(good, "2026-10-06"))
        self.assertTrue(is_final({"collected_at": "2026-10-06T23:55:00Z",
                                  "sampling_basis": "utc_snapshot"}, "2026-10-06"))
        # legacy records never carry sampling_basis -> never final
        self.assertFalse(is_final({"collected_at": "2026-10-06T00:15:00Z", "failed": []},
                                  "2026-10-06"))
        # wrong day / failures / garbage
        self.assertFalse(is_final({**good, "collected_at": "2026-10-07T00:05:00Z"}, "2026-10-06"))
        self.assertFalse(is_final({**good, "failed": ["core"]}, "2026-10-06"))
        self.assertFalse(is_final({**good, "failed": ["frontier"]}, "2026-10-06"))
        self.assertFalse(is_final({**good, "sampling_basis": "utc_close"}, "2026-10-06"))
        self.assertFalse(is_final({**good, "collected_at": "not-a-date"}, "2026-10-06"))
        self.assertFalse(is_final(None, "2026-10-06"))


class TestCausalExclusions(unittest.TestCase):
    def test_future_append_cannot_change_past_exclusions(self):
        """core_exclusions_by_date freezes each day on data available then."""
        meta_by_date = {}
        by_date = {}
        base = datetime(2026, 1, 1, tzinfo=timezone.utc)
        for i in range(30):
            d = base.fromordinal(base.toordinal() + i).strftime("%Y-%m-%d")
            by_date[d] = {"coin-a": (100.0 + i, 300), "coin-b": (50.0, 100)}
            meta_by_date[d] = {"coin-a": ("AAA", "Coin A"), "coin-b": ("BBB", "Coin B")}
        first = breadth.core_exclusions_by_date(by_date, meta_by_date)
        # Append a future where a third (stable-like) coin appears and 'a' dies.
        for i in range(30, 60):
            d = base.fromordinal(base.toordinal() + i).strftime("%Y-%m-%d")
            by_date[d] = {"coin-a": (1.0, 300), "coin-b": (50.0, 100),
                          "stable-c": (1.0, 50)}
            meta_by_date[d] = {**meta_by_date["2026-01-01"],
                               "stable-c": ("STC", "Stable C")}
        second = breadth.core_exclusions_by_date(by_date, meta_by_date)
        for d in first:
            self.assertEqual(second[d], first[d], f"future data rewrote {d}")


class TestTrackSummaryBands(unittest.TestCase):
    def test_future_append_preserves_past_band_fields(self):
        """Each date's P10/P90 band uses only PRIOR published oscillators."""
        from export_to_json import track_summary
        rows = []
        base = datetime(2026, 1, 1, tzinfo=timezone.utc)
        for i in range(150):
            d = base.fromordinal(base.toordinal() + i).strftime("%Y-%m-%d")
            adv, dec = (7, 3) if i % 3 else (3, 7)
            rows.append({"date": d, "adv": adv, "dec": dec, "unch": 0, "n": 10,
                         "complete": True})
        cut = 110
        by_prefix, _c1, _b1 = track_summary(rows[:cut], warmup=5)
        by_full, _c2, _b2 = track_summary(rows, warmup=5)
        self.assertEqual(set(by_prefix) <= set(by_full), True)
        seen_band = False
        for d, (b_old, *_rest) in by_prefix.items():
            b_new = by_full[d][0]
            self.assertEqual(b_new["band_low"], b_old["band_low"], f"band_low moved at {d}")
            self.assertEqual(b_new["band_high"], b_old["band_high"], f"band_high moved at {d}")
            seen_band = seen_band or b_old["band_low"] is not None
        self.assertTrue(seen_band, "test produced no populated bands to compare")


class TestSamplingProvenance(unittest.TestCase):
    def test_make_row_defaults_are_legacy(self):
        r = core_track.make_row("2026-10-06", "bitcoin", "btc", "Bitcoin", 100, 300, 10)
        self.assertEqual(r["observed_at"], "")
        self.assertEqual(r["price_basis"], "legacy_unverified")

    def test_load_store_labels_legacy_rows_without_inventing_times(self):
        legacy_header = "date,coin_id,symbol,name,close,market_cap,volume\n"
        legacy_row = "2026-01-01,bitcoin,BTC,Bitcoin,100,300,10\n"
        new_header = ("date,coin_id,symbol,name,close,market_cap,volume,"
                      "observed_at,price_basis\n")
        new_row = ("2026-01-02,bitcoin,BTC,Bitcoin,101,310,11,"
                   "2026-01-02T00:15:00Z,snapshot\n")
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "store.csv"
            p.write_text(legacy_header + legacy_row, encoding="utf-8")
            rows = core_track.load_store(p)
            self.assertEqual(rows[0]["observed_at"], "")
            self.assertEqual(rows[0]["price_basis"], "legacy_unverified")
            p.write_text(new_header + new_row, encoding="utf-8")
            rows = core_track.load_store(p)
            self.assertEqual(rows[0]["observed_at"], "2026-01-02T00:15:00Z")
            self.assertEqual(rows[0]["price_basis"], "snapshot")

    def test_index_store_drops_nonfinite_closes_and_caps(self):
        rows = [
            {"date": "2026-01-01", "coin_id": "nan", "symbol": "N", "name": "N",
             "close": "nan", "market_cap": "100", "volume": "0"},
            {"date": "2026-01-01", "coin_id": "inf", "symbol": "I", "name": "I",
             "close": "inf", "market_cap": "100", "volume": "0"},
            {"date": "2026-01-01", "coin_id": "ok-nan-cap", "symbol": "O", "name": "O",
             "close": "10", "market_cap": "nan", "volume": "0"},
            {"date": "2026-01-01", "coin_id": "ok-neg-cap", "symbol": "G", "name": "G",
             "close": "10", "market_cap": "-50", "volume": "0"},
        ]
        by_date, meta = core_track.index_store(rows)
        self.assertNotIn("nan", by_date["2026-01-01"])
        self.assertNotIn("inf", by_date["2026-01-01"])
        self.assertEqual(by_date["2026-01-01"]["ok-nan-cap"], (10.0, 0.0))
        self.assertEqual(by_date["2026-01-01"]["ok-neg-cap"], (10.0, 0.0))
        self.assertIn("ok-nan-cap", meta)

    def test_replace_snapshot_replaces_whole_dates(self):
        old = [{"date": "2026-01-01", "coin_id": "a"},
               {"date": "2026-01-02", "coin_id": "a"}]
        new = [{"date": "2026-01-02", "coin_id": "b"}]
        merged = core_track.replace_snapshot(old, new)
        self.assertEqual([(r["date"], r["coin_id"]) for r in merged],
                         [("2026-01-01", "a"), ("2026-01-02", "b")])

    def test_core_snapshot_raises_when_utc_date_rolls_over(self):
        coins = [{"id": "bitcoin", "symbol": "btc", "name": "Bitcoin",
                  "current_price": 100.0, "market_cap": 300, "total_volume": 10}]
        with mock.patch.object(core_track, "fetch_candidates", return_value=coins), \
             mock.patch.object(core_track, "_utcnow",
                               return_value=datetime(2026, 10, 7, 0, 5,
                                                     tzinfo=timezone.utc)):
            with self.assertRaises(ValueError):
                core_track.fetch_live_snapshot("2026-10-06")

    def test_core_snapshot_stamps_retrieval_time(self):
        coins = [{"id": "bitcoin", "symbol": "btc", "name": "Bitcoin",
                  "current_price": 100.0, "market_cap": 300, "total_volume": 10}]
        with mock.patch.object(core_track, "fetch_candidates", return_value=coins), \
             mock.patch.object(core_track, "_utcnow",
                               return_value=datetime(2026, 10, 6, 23, 30,
                                                     tzinfo=timezone.utc)):
            rows = core_track.fetch_live_snapshot("2026-10-06")
        self.assertEqual(rows[0]["observed_at"], "2026-10-06T23:30:00Z")
        self.assertEqual(rows[0]["price_basis"], "snapshot")
        self.assertEqual(rows[0]["date"], "2026-10-06")

    def _frontier_env(self, utcnow):
        quote = {"price": 1.0, "liquidity_usd": 100_000.0,
                 "volume_24h_usd": 2_000_000.0, "fdv_usd": 5_000_000.0,
                 "symbol": "TOK"}
        stack = contextlib.ExitStack()
        for patcher in (
                mock.patch.object(frontier_track, "load_registry", return_value={}),
                mock.patch.object(frontier_track, "discover", return_value={}),
                mock.patch.object(frontier_track, "quote_tokens",
                                  return_value=({"tok": quote}, set())),
                mock.patch.object(frontier_track, "gt_quote_tokens",
                                  return_value=({}, set())),
                mock.patch.object(frontier_track, "_utcnow", return_value=utcnow)):
            stack.enter_context(patcher)
        return stack

    _STORE = [{"date": "2026-10-05", "key": "solana:tok", "chain": "solana",
               "symbol": "TOK", "address": "tok", "price": "1.0",
               "liquidity_usd": "100000", "volume_24h_usd": "2000000",
               "fdv_usd": "5000000", "qualified": "1", "tracked": "1",
               "first_qualified": "2026-10-05", "status": "ok",
               "observed_at": "", "price_basis": "legacy_unverified"}]

    def test_frontier_raises_when_pricing_rolls_over(self):
        with self._frontier_env(datetime(2026, 10, 7, 0, 5, tzinfo=timezone.utc)):
            with self.assertRaises(ValueError):
                frontier_track.update("2026-10-06", self._STORE)

    def test_frontier_rows_carry_snapshot_provenance(self):
        with self._frontier_env(datetime(2026, 10, 6, 23, 30, tzinfo=timezone.utc)):
            rows, _reg = frontier_track.update("2026-10-06", self._STORE)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["observed_at"], "2026-10-06T23:30:00Z")
        self.assertEqual(rows[0]["price_basis"], "snapshot")

    def test_seeder_labels_known_utc_close(self):
        import seed_core_history
        ts = 1767312000000                                # 2026-01-02T00:00:00Z
        data = {"prices": [[ts, 100.0], [ts + 3_600_000, 50.0]],
                "market_caps": [[ts, 300.0]],
                "total_volumes": [[ts, 10.0]]}
        rows = seed_core_history.history_rows({"id": "bitcoin", "symbol": "btc",
                                             "name": "Bitcoin"}, data)
        self.assertEqual(len(rows), 1)                    # non-midnight point dropped
        self.assertEqual(rows[0]["date"], "2026-01-01")   # stamp D = close of D-1
        self.assertEqual(rows[0]["observed_at"], "2026-01-02T00:00:00Z")
        self.assertEqual(rows[0]["price_basis"], "utc_close")


if __name__ == "__main__":
    unittest.main()
