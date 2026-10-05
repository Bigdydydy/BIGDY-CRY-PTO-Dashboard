"""
One-off Core history backfill (CoinGecko public API, last 365 days).

For each of today's Top 300 candidates it downloads daily price / market cap
/ volume and writes them into core_daily.csv, so the Top 100 can be ranked by
the market cap each coin actually had on each day.

Known residual bias: coins that dropped out of the Top 300 during the year are
absent from the candidate pool. Ranking the Top 100 from a 300-deep pool keeps
that effect small.

Downloads are cached under data/raw_cache/ so an interrupted run resumes.
Run: python seed_core_history.py
"""

import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

import config
from src import core_track
from src.breadth import static_excluded
from src.http_client import get_json

REQUEST_SPACING_SEC = 12.0   # public API allows only a handful of calls per minute
DAY_MS = 86_400_000


def fetch_history(coin_id: str):
    cache_file = config.RAW_CACHE_DIR / f"{coin_id}.json"
    if cache_file.exists():
        return json.loads(cache_file.read_text(encoding="utf-8")), False
    url = (f"{config.COINGECKO_BASE}/coins/{coin_id}/market_chart?vs_currency=usd"
           f"&days={config.COINGECKO_HISTORY_DAYS}&interval=daily")
    data = get_json(url, retries=6, backoff_sec=60.0)
    cache_file.write_text(json.dumps(data), encoding="utf-8")
    return data, True


def history_rows(coin: dict, data: dict):
    """
    CoinGecko's daily point stamped 00:00 UTC on day D is the close of D-1.
    The trailing intraday point (not on a midnight boundary) is dropped.
    """
    caps = {int(ts): v for ts, v in data.get("market_caps", [])}
    vols = {int(ts): v for ts, v in data.get("total_volumes", [])}
    rows = []
    for ts, price in data.get("prices", []):
        ts = int(ts)
        if ts % DAY_MS != 0 or not price:
            continue
        close_date = datetime.fromtimestamp((ts - DAY_MS) / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
        rows.append(core_track.make_row(close_date, coin["id"], coin.get("symbol"), coin.get("name"),
                                        price, caps.get(ts) or 0, vols.get(ts) or 0))
    return rows


def main():
    config.RAW_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    candidates = core_track.fetch_candidates()
    print(f"[Seeder] {len(candidates)} candidates")

    new_rows = []
    for i, coin in enumerate(candidates, 1):
        # Statically excluded coins never enter the universe; skip their download
        # unless the peg detector needs them as a reference series
        if (static_excluded(coin.get("symbol"), coin.get("name"))
                and coin["id"] not in config.PEG_REFERENCE_IDS):
            print(f"[Seeder] {i:3d}/{len(candidates)} {coin['id']}: skipped (excluded)")
            continue
        try:
            data, fetched = fetch_history(coin["id"])
        except Exception as e:
            print(f"[Seeder] {i:3d}/{len(candidates)} {coin['id']}: FAILED ({e})")
            continue
        rows = history_rows(coin, data)
        new_rows.extend(rows)
        print(f"[Seeder] {i:3d}/{len(candidates)} {coin['id']}: {len(rows)} days")
        if fetched:
            time.sleep(REQUEST_SPACING_SEC)

    store = core_track.upsert(core_track.load_store(), new_rows)
    core_track.save_store(store)
    print(f"[Seeder] Saved {len(store)} rows to {config.CORE_STORE_FILE}")


if __name__ == "__main__":
    main()
