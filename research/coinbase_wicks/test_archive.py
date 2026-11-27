import argparse
import sqlite3
import tempfile
import unittest
from pathlib import Path

import archive


def make_db(path, venue, rows, runs=("{\"a\": 1}",)):
    db = sqlite3.connect(path)
    db.executescript(archive.SPECS[venue]["schema"])
    db.executemany("INSERT INTO trades VALUES (?,?,?,?,?,?)", rows)
    db.executemany("INSERT INTO runs(payload) VALUES (?)", [(r,) for r in runs])
    db.commit()
    db.close()


class ArchiveTest(unittest.TestCase):
    def roundtrip(self, venue, rows):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            make_db(d / "src.sqlite", venue, rows)
            gz, out = d / "a.csv.gz", d / "out.sqlite"
            archive.pack(argparse.Namespace(db=d / "src.sqlite", out=gz))
            archive.verify(argparse.Namespace(archive=gz, db=d / "src.sqlite"))
            archive.unpack(argparse.Namespace(archive=gz, db=out))
            con = sqlite3.connect(out)
            got = con.execute("SELECT * FROM trades ORDER BY id").fetchall()
            runs = con.execute("SELECT payload FROM runs").fetchall()
            con.close()
            self.assertEqual(got, sorted(rows))
            self.assertEqual(runs, [("{\"a\": 1}",)])

    def test_coinbase_roundtrip_with_price_moves_both_ways(self):
        self.roundtrip("coinbase", [
            (10, 1_000_000, "62462.60000000", "0.00039622", "sell", ""),
            (11, 1_000_005, "62462.59000000", "12.10588455", "buy", ""),
            (12, 1_000_005, "62500.00000000", "0.00000001", "buy", ""),
        ])

    def test_kraken_roundtrip(self):
        self.roundtrip("kraken", [
            (5, 2_000_000, "64148.80000", "0.00010000", "s", "l"),
            (6, 2_000_100, "64147.30000", "1.00000000", "b", "m"),
        ])

    def test_rejects_mixed_decimals(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "s.sqlite"
            make_db(p, "kraken", [(1, 1, "1.0", "1.00000000", "b", "l"), (2, 2, "1.00", "1.00000000", "b", "l")])
            with self.assertRaises(ValueError):
                archive.pack(argparse.Namespace(db=p, out=Path(d) / "a.gz"))

    def test_fixed_point_text(self):
        self.assertEqual(archive.to_text(archive.to_int("0.00039622", 8), 8), "0.00039622")
        self.assertEqual(archive.to_text(archive.to_int("64148.80000", 5), 5), "64148.80000")


if __name__ == "__main__":
    unittest.main()
