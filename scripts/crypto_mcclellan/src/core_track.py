"""
Core track store: daily sampled price + market cap for the CoinGecko Top 300
candidates, so the Top 100 can be re-ranked point-in-time every day.

core_daily.csv (long format, one row per coin per labeled UTC date):
    date, coin_id, symbol, name, close, market_cap, volume,
    observed_at, price_basis

observed_at is the UTC retrieval timestamp of the row's quotes — when the
snapshot was taken, not a guaranteed last-trade time (blank on rows written
before provenance was tracked; never invented afterwards).
price_basis is "snapshot" (live quote), "utc_close" (seeded daily close)
or "legacy_unverified" (rows without a recorded basis).
"""

import csv
import math
import time
from datetime import datetime, timezone
from pathlib import Path

import config
from src.http_client import get_json

FIELDS = ["date", "coin_id", "symbol", "name", "close", "market_cap", "volume",
          "observed_at", "price_basis"]


def _utcnow():
    """Sampling clock, isolated so tests can stub a fixed retrieval time."""
    return datetime.now(timezone.utc)


def _fmt(x: float) -> str:
    return f"{x:.8g}"


def load_store(path: Path = config.CORE_STORE_FILE):
    if not path.exists():
        return []
    with open(path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    for r in rows:
        # Legacy rows predate the provenance columns: keep observed_at empty
        # (never invent a sampling time) and label the basis unverified.
        r["observed_at"] = r.get("observed_at") or ""
        r["price_basis"] = r.get("price_basis") or "legacy_unverified"
    return rows


def save_store(rows, path: Path = config.CORE_STORE_FILE):
    rows = sorted(rows, key=lambda r: (r["date"], -float(r["market_cap"] or 0), r["coin_id"]))
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)


def upsert(rows, new_rows):
    """Incoming rows replace existing ones with the same (date, coin_id)."""
    merged = {(r["date"], r["coin_id"]): r for r in rows}
    for r in new_rows:
        merged[(r["date"], r["coin_id"])] = r
    return list(merged.values())


def replace_snapshot(rows, new_rows):
    """Drop every stored row of the dates present in new_rows (whole-day replace)."""
    dates = {r["date"] for r in new_rows}
    return [r for r in rows if r["date"] not in dates] + list(new_rows)


def index_store(rows):
    """
    by_date: {date: {coin_id: (close, market_cap)}}
    meta:    {coin_id: (symbol, name)} from the latest row of each coin
    """
    by_date, meta = {}, {}
    for r in sorted(rows, key=lambda r: r["date"]):
        close = float(r["close"] or 0)
        if not math.isfinite(close) or close <= 0:
            continue
        cap = float(r["market_cap"] or 0)
        if not math.isfinite(cap) or cap < 0:
            cap = 0.0
        by_date.setdefault(r["date"], {})[r["coin_id"]] = (close, cap)
        meta[r["coin_id"]] = (r["symbol"], r["name"])
    return by_date, meta


def make_row(date: str, coin_id: str, symbol: str, name: str, close, market_cap, volume,
             *, observed_at: str = "", price_basis: str = "legacy_unverified"):
    return {
        "date": date,
        "coin_id": coin_id,
        "symbol": (symbol or "").upper(),
        "name": name or "",
        "close": _fmt(float(close)),
        "market_cap": str(int(float(market_cap or 0))),
        "volume": str(int(float(volume or 0))),
        "observed_at": observed_at,
        "price_basis": price_basis,
    }


def fetch_markets(per_page: int, page: int):
    url = (f"{config.COINGECKO_BASE}/coins/markets?vs_currency=usd&order=market_cap_desc"
           f"&per_page={per_page}&page={page}&sparkline=false")
    data = get_json(url)
    return data if isinstance(data, list) else []


def fetch_candidates(n: int = config.CORE_CANDIDATE_N):
    """Top-n coins by market cap (CoinGecko caps per_page at 250)."""
    coins = fetch_markets(250, 1)
    if n > 250:
        time.sleep(2.0)
        extra = n - 250
        # page k of size `extra` starts at rank (k-1)*extra + 1; pick the page
        # that begins right after rank 250 when it divides evenly
        if 250 % extra == 0:
            coins += fetch_markets(extra, 250 // extra + 1)
        else:
            coins += fetch_markets(250, 2)[:extra]
    return coins[:n]


def fetch_live_snapshot(trade_date: str):
    """Live quote snapshot for the Top-300 candidates, dated to its own UTC day."""
    coins = fetch_candidates()
    retrieved = _utcnow()
    observed_at = retrieved.strftime("%Y-%m-%dT%H:%M:%SZ")
    if retrieved.strftime("%Y-%m-%d") != trade_date:
        raise ValueError(
            f"[Core] sample crossed midnight: retrieved {observed_at} does not "
            f"match requested trade_date {trade_date}")
    rows = []
    for c in coins:
        price, mcap = c.get("current_price"), c.get("market_cap")
        if not price or not mcap:
            continue
        rows.append(make_row(trade_date, c["id"], c.get("symbol"), c.get("name"),
                             price, mcap, c.get("total_volume"),
                             observed_at=observed_at, price_basis="snapshot"))
    print(f"[Core] Live snapshot {trade_date} @ {observed_at}: {len(rows)} candidates")
    return rows
