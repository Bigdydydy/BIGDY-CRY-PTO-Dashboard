"""Lossless gzip archive for the trade databases (Coinbase and Kraken). Stdlib only.

Format: line 1 is '#' + JSON metadata (schema, decimals, counts, runs table).
Each following line is one trade ordered by id:
    d_id,d_us,d_price,size,side[,ord_type]
with id/us/price delta-encoded against the previous row and price/size stored as
fixed-point integers. `verify` streams the archive against the source database and
compares every field as the original strings.
"""
import argparse
import gzip
import json
import sqlite3
from contextlib import closing
from pathlib import Path

SPECS = {
    "coinbase": dict(columns=["id", "us", "price", "size", "maker_side", "raw"],
                     side="maker_side", extra=None, schema="""
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY, us INTEGER NOT NULL, price TEXT NOT NULL,
        size TEXT NOT NULL, maker_side TEXT NOT NULL, raw TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);"""),
    "kraken": dict(columns=["id", "us", "price", "size", "taker_side", "ord_type"],
                   side="taker_side", extra="ord_type", schema="""
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY, us INTEGER NOT NULL, price TEXT NOT NULL,
        size TEXT NOT NULL, taker_side TEXT NOT NULL, ord_type TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);"""),
}
INDEX = "CREATE INDEX IF NOT EXISTS trade_time ON trades(us, id);"


def to_int(text, dec):
    whole, _, frac = text.partition(".")
    if len(frac) != dec or not (whole + frac).isdigit():
        raise ValueError(f"Unexpected number format {text!r} (expected {dec} decimals)")
    return int(whole + frac)


def to_text(n, dec):
    s = str(n).rjust(dec + 1, "0")
    return s[:-dec] + "." + s[-dec:]


def detect(db):
    cols = [r[1] for r in db.execute("PRAGMA table_info(trades)")]
    venue = next((v for v, s in SPECS.items() if s["columns"] == cols), None)
    if venue is None:
        raise ValueError(f"Unknown trades schema {cols}")
    return venue


def decimals(db):
    out = []
    for col in ("price", "size"):
        lo, hi = db.execute(f"SELECT min(length({col})-instr({col},'.')), "
                            f"max(length({col})-instr({col},'.')) FROM trades").fetchone()
        if lo != hi:
            raise ValueError(f"{col} has mixed decimal places {lo}..{hi}; fixed-point encoding not lossless")
        out.append(lo)
    return out


def source_rows(db, spec):
    return db.execute(f"SELECT {','.join(spec['columns'])} FROM trades ORDER BY id")


def pack(args):
    with closing(sqlite3.connect(args.db)) as db:
        _pack(args, db)


def _pack(args, db):
    venue = detect(db)
    spec = SPECS[venue]
    pdec, sdec = decimals(db)
    count, lo, hi = db.execute("SELECT count(*), min(id), max(id) FROM trades").fetchone()
    if venue == "coinbase" and db.execute("SELECT count(*) FROM trades WHERE raw != ''").fetchone()[0]:
        raise ValueError("raw column is not empty; this archive format does not store it")
    runs = [p for (p,) in db.execute("SELECT payload FROM runs ORDER BY id")]
    meta = dict(venue=venue, columns=spec["columns"], price_decimals=pdec, size_decimals=sdec,
                count=count, first_id=lo, last_id=hi, ids_contiguous=(hi - lo + 1 == count),
                runs=runs, source=Path(args.db).name)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    pid = pus = pp = 0
    with gzip.open(args.out, "wt", encoding="ascii", compresslevel=6, newline="\n") as f:
        f.write("#" + json.dumps(meta) + "\n")
        for row in source_rows(db, spec):
            tid, us, price, size, side = row[:5]
            p = to_int(price, pdec)
            line = f"{tid - pid},{us - pus},{p - pp},{to_int(size, sdec)},{side}"
            if spec["extra"]:
                line += "," + row[5]
            f.write(line + "\n")
            pid, pus, pp = tid, us, p
    print(json.dumps(dict(meta, runs=len(runs), archive=str(args.out),
                          archive_mb=round(args.out.stat().st_size / 1e6, 1))))


def read_archive(path):
    f = gzip.open(path, "rt", encoding="ascii", newline="\n")
    meta = json.loads(f.readline()[1:])
    spec = SPECS[meta["venue"]]
    pdec, sdec = meta["price_decimals"], meta["size_decimals"]

    def rows():
        pid = pus = pp = 0
        with f:
            for line in f:
                parts = line.rstrip("\n").split(",")
                pid += int(parts[0])
                pus += int(parts[1])
                pp += int(parts[2])
                row = (pid, pus, to_text(pp, pdec), to_text(int(parts[3]), sdec), parts[4])
                yield row + ((parts[5],) if spec["extra"] else ("",))
    return meta, rows()


def verify(args):
    with closing(sqlite3.connect(args.db)) as db:
        _verify(args, db)


def _verify(args, db):
    meta, rows = read_archive(args.archive)
    src = source_rows(db, SPECS[meta["venue"]])
    n = 0
    for a, b in zip(rows, src, strict=True):
        if tuple(a) != tuple(b):
            raise SystemExit(f"MISMATCH at row {n}: archive={a} db={b}")
        n += 1
    runs = [p for (p,) in db.execute("SELECT payload FROM runs ORDER BY id")]
    if n != meta["count"] or runs != meta["runs"]:
        raise SystemExit(f"MISMATCH count/runs: rows={n} meta={meta['count']}")
    print(f"OK {args.archive.name}: {n} rows identical, runs={len(runs)} identical")


def unpack(args):
    meta, rows = read_archive(args.archive)
    if args.db.exists():
        raise SystemExit(f"{args.db} already exists; choose a new path")
    with closing(sqlite3.connect(args.db)) as db:
        _unpack(args, db, meta, rows)


def _unpack(args, db, meta, rows):
    db.executescript(SPECS[meta["venue"]]["schema"])
    db.executemany(f"INSERT INTO trades VALUES ({','.join('?' * 6)})", rows)
    db.executemany("INSERT INTO runs(payload) VALUES (?)", [(p,) for p in meta["runs"]])
    db.execute(INDEX)
    db.commit()
    n = db.execute("SELECT count(*) FROM trades").fetchone()[0]
    if n != meta["count"]:
        raise SystemExit(f"Restored {n} rows, expected {meta['count']}")
    print(f"Restored {n} rows to {args.db}")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("pack"); a.add_argument("--db", type=Path, required=True); a.add_argument("--out", type=Path, required=True)
    b = sub.add_parser("verify"); b.add_argument("--archive", type=Path, required=True); b.add_argument("--db", type=Path, required=True)
    c = sub.add_parser("unpack"); c.add_argument("--archive", type=Path, required=True); c.add_argument("--db", type=Path, required=True)
    args = p.parse_args()
    dict(pack=pack, verify=verify, unpack=unpack)[args.cmd](args)


if __name__ == "__main__":
    main()
