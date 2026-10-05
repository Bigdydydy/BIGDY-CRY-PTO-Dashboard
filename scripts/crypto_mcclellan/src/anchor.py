"""
External heat anchor for the Frontier track: DefiLlama DEX volume on the same
chains. It is independent of our basket selection and has full history, so it
can test whether the meme oscillator follows real on-chain activity.

dex_volume.csv (long format): date, chain, volume_usd
"""

import csv
import math
from datetime import date, datetime, timedelta, timezone

import config
from src.http_client import get_json

FIELDS = ["date", "chain", "volume_usd"]


def fetch_volumes(trade_date: str):
    """
    Daily DEX volume per chain. The last ANCHOR_LAG_DAYS days before trade_date
    are still being filled in by DefiLlama and are dropped; the full history is
    re-fetched every run, so they come back once settled.
    """
    cutoff = (date.fromisoformat(trade_date) - timedelta(days=config.ANCHOR_LAG_DAYS - 1)).isoformat()
    rows = []
    for chain, llama_id in config.DEFILLAMA_CHAINS.items():
        data = get_json(config.DEFILLAMA_DEX_URL.format(chain=llama_id), backoff_sec=10.0)
        for ts, vol in data.get("totalDataChart") or []:
            d = datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime("%Y-%m-%d")
            if d < cutoff and vol:
                rows.append({"date": d, "chain": chain, "volume_usd": str(int(vol))})
    return rows


def load_volumes(path=config.DEX_VOLUME_FILE):
    if not path.exists():
        return []
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def save_volumes(rows, path=config.DEX_VOLUME_FILE):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(sorted(rows, key=lambda r: (r["date"], r["chain"])))


def momentum(rows):
    """
    {date: {"volume": total USD, "momentum": mean over chains of ln(MA7 / MA28)}}.
    A chain contributes only once it has ANCHOR_SLOW days of history, so a
    newly launched chain (Robinhood) does not create a jump in the series.
    """
    by_chain = {}
    for r in rows:
        by_chain.setdefault(r["chain"], {})[r["date"]] = float(r["volume_usd"])

    per_date = {}
    for chain, series in by_chain.items():
        dates = sorted(series)
        vals = [series[d] for d in dates]
        for i, d in enumerate(dates):
            entry = per_date.setdefault(d, {"volume": 0.0, "moms": []})
            entry["volume"] += vals[i]
            if i + 1 < config.ANCHOR_SLOW:
                continue
            fast = sum(vals[i + 1 - config.ANCHOR_FAST:i + 1]) / config.ANCHOR_FAST
            slow = sum(vals[i + 1 - config.ANCHOR_SLOW:i + 1]) / config.ANCHOR_SLOW
            if fast > 0 and slow > 0:
                entry["moms"].append(math.log(fast / slow))

    return {d: {"volume": e["volume"],
                "momentum": sum(e["moms"]) / len(e["moms"]) if e["moms"] else None}
            for d, e in per_date.items()}


def pearson(xs, ys):
    n = len(xs)
    if n < 3:
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    return sxy / math.sqrt(sxx * syy) if sxx > 0 and syy > 0 else None
