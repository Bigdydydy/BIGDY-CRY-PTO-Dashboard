"""
Unit tests for the DailyCloseStore and close-to-close breadth basis.
Run: python test_close_basis.py
"""

import sys
import tempfile
import unittest
from pathlib import Path

import pandas as pd

ROOT_DIR = Path(__file__).resolve().parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from src.collectors.daily_close_store import (
    DailyCloseStore,
    effective_pct_change,
    BASIS_CLOSE_TO_CLOSE,
    BASIS_ROLLING_24H,
)


class TestEffectivePctChange(unittest.TestCase):
    def test_prefers_close_to_close(self):
        pct, basis = effective_pct_change(110.0, 100.0, 5.0)
        self.assertAlmostEqual(pct, 10.0)
        self.assertEqual(basis, BASIS_CLOSE_TO_CLOSE)

    def test_falls_back_to_rolling_when_no_prev_close(self):
        pct, basis = effective_pct_change(110.0, None, -5.0)
        self.assertEqual(pct, -5.0)
        self.assertEqual(basis, BASIS_ROLLING_24H)

    def test_falls_back_when_prev_close_invalid(self):
        for bad in (0.0, -3.0, float("nan")):
            pct, basis = effective_pct_change(110.0, bad, 2.0)
            self.assertEqual(pct, 2.0)
            self.assertEqual(basis, BASIS_ROLLING_24H)

    def test_falls_back_when_current_price_invalid(self):
        pct, basis = effective_pct_change(0.0, 100.0, 3.0)
        self.assertEqual(pct, 3.0)
        self.assertEqual(basis, BASIS_ROLLING_24H)


class TestDailyCloseStore(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = DailyCloseStore(cache_dir=self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_record_and_previous_close(self):
        self.store.record("core", "BTC", "2026-09-28", 100.0)
        self.store.record("core", "BTC", "2026-09-29", 110.0)
        self.assertEqual(self.store.previous_close("core", "BTC", "2026-09-30"), 110.0)

    def test_previous_close_is_strictly_earlier(self):
        self.store.record("core", "BTC", "2026-09-30", 105.0)
        # Same-date row must not be treated as the previous close
        self.assertIsNone(self.store.previous_close("core", "BTC", "2026-09-30"))
        self.assertEqual(self.store.previous_close("core", "BTC", "2026-10-01"), 105.0)

    def test_record_upserts_same_date(self):
        self.store.record("core", "BTC", "2026-09-30", 100.0)
        self.store.record("core", "BTC", "2026-09-30", 120.0)
        self.assertEqual(self.store.previous_close("core", "BTC", "2026-10-01"), 120.0)
        self.assertEqual(len(self.store.frame), 1)

    def test_tracks_are_isolated(self):
        self.store.record("core", "DOGE", "2026-09-29", 1.0)
        self.assertIsNone(self.store.previous_close("frontier", "DOGE", "2026-09-30"))

    def test_rejects_invalid_prices(self):
        for bad in (0.0, -1.0, float("nan"), None):
            self.store.record("core", "BTC", "2026-09-29", bad)
        self.assertEqual(len(self.store.frame), 0)

    def test_persistence_roundtrip(self):
        self.store.record("frontier", "solana_PEPE", "2026-09-29", 0.5)
        self.store.save()
        reloaded = DailyCloseStore(cache_dir=self.tmp.name)
        self.assertEqual(reloaded.previous_close("frontier", "solana_PEPE", "2026-09-30"), 0.5)

    def test_upsert_frame_bulk_overwrites(self):
        self.store.record("core", "ETH", "2026-09-28", 100.0)
        bulk = pd.DataFrame([
            {"date": "2026-09-28", "track": "core", "key": "ETH", "close_usd": 150.0},
            {"date": "2026-09-29", "track": "core", "key": "ETH", "close_usd": 160.0},
            {"date": "2026-09-29", "track": "core", "key": "SOL", "close_usd": 5.0},
        ])
        self.store.upsert_frame(bulk)
        self.assertEqual(self.store.previous_close("core", "ETH", "2026-09-30"), 160.0)
        self.assertEqual(self.store.previous_close("core", "SOL", "2026-09-30"), 5.0)
        self.assertEqual(len(self.store.frame), 3)


if __name__ == "__main__":
    unittest.main()
