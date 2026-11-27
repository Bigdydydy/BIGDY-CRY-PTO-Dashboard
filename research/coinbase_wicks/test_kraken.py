import unittest

from kraken import Venue, classify, compare_one, excursion

S = 1_000


def tape(points):
    """points: (second offset in ms from S*1000ms, price, taker_sell)."""
    return Venue([((S * 1000 + ms) * 1000, str(p), "1", sell) for ms, p, sell in points])


class KrakenCompareTest(unittest.TestCase):
    def test_excursion_lower_measured_from_anchor_before_window(self):
        v = tape([(-5000, 100.0, False), (-500, 99.0, True), (200, 98.0, True), (900, 99.5, False)])
        e = excursion(v, S, "lower")
        self.assertEqual(e["anchor"], 100.0)
        self.assertEqual(e["extreme"], 98.0)
        self.assertAlmostEqual(e["exc_bps"], 200.0)
        self.assertEqual(e["trades"], 3)
        self.assertEqual(e["wick_side_volume"], 2.0)

    def test_excursion_upper_sign(self):
        v = tape([(-3000, 100.0, True), (100, 101.0, False)])
        self.assertAlmostEqual(excursion(v, S, "upper")["exc_bps"], 100.0)

    def test_solo_when_reference_flat(self):
        cb = tape([(-3000, 100.0, False), (100, 99.0, True)])
        kr = tape([(-3000, 100.0, False)] + [(ms, 100.0, False) for ms in range(0, 1000, 100)])
        r = compare_one(cb, kr, S, "lower")
        self.assertEqual(r["ratio"], 0.0)
        self.assertEqual(r["relation"], "CB独有")

    def test_sync_and_lag(self):
        cb = tape([(-3000, 100.0, False), (100, 99.0, True)])
        kr = tape([(-3000, 100.0, False)] + [(ms, 99.9, True) for ms in range(0, 400, 50)] + [(400, 99.05, True)])
        r = compare_one(cb, kr, S, "lower")
        self.assertEqual(r["relation"], "同步")
        self.assertEqual(r["lag_ms"], 300)

    def test_sparse_reference(self):
        self.assertEqual(classify(0.0, 1), "参照稀疏")
        self.assertEqual(classify(None, 0), "无参照")
        self.assertEqual(classify(0.5, 10), "部分同步")


if __name__ == "__main__":
    unittest.main()
