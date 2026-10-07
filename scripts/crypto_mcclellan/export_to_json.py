"""
Crypto McClellan Oscillator pipeline (Module 1-B).

  1. Append today's Core snapshot (CoinGecko Top 300 candidates)
  2. Run the Frontier meme discovery / gatekeeper / pricing for today
  3. Recompute both breadth series from the stores and export
     data/crypto_mcclellan.json for the dashboard

Run: python export_to_json.py            (collect + compute)
     python export_to_json.py --offline  (recompute from stored data only)
"""

import argparse
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

import config
from src import anchor, breadth, core_track, frontier_track


def trade_date_now(now: datetime = None) -> str:
    """UTC close a run belongs to: the date of (run time - TRADE_DATE_LAG_HOURS)."""
    now = now or datetime.now(timezone.utc)
    return (now - timedelta(hours=config.TRADE_DATE_LAG_HOURS)).strftime("%Y-%m-%d")


def load_collection_log():
    if config.COLLECTION_LOG_FILE.exists():
        return json.loads(config.COLLECTION_LOG_FILE.read_text(encoding="utf-8"))
    return {}


def is_final(entry, trade_date: str) -> bool:
    """
    A trade date is final once Core and Frontier were both collected after
    that day's UTC close. Intraday snapshots (a daytime manual refresh) are not
    final and get replaced by the next post-close run.
    """
    if not entry or entry.get("failed"):
        return False
    close = (datetime.fromisoformat(trade_date) + timedelta(days=1)).replace(tzinfo=timezone.utc)
    return datetime.fromisoformat(entry["collected_at"].replace("Z", "+00:00")) >= close


def record_collection(trade_date: str, failed, now: datetime = None):
    log = load_collection_log()
    now = now or datetime.now(timezone.utc)
    log[trade_date] = {"collected_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
                       "failed": [f for f in failed if f in ("core", "frontier")]}
    config.COLLECTION_LOG_FILE.write_text(json.dumps(log, indent=1, sort_keys=True), encoding="utf-8")


def _r(x, nd=2):
    return None if x is None else round(x, nd)


def _with_retry(label: str, fn, attempts: int = 2, pause_sec: float = 60.0):
    """Run fn, retrying once after a pause; returns its result or None on failure."""
    for i in range(attempts):
        try:
            return fn()
        except Exception as e:
            print(f"[{label}] attempt {i + 1}/{attempts} failed: {e}")
            if i + 1 < attempts:
                time.sleep(pause_sec)
    return None


def collect(trade_date: str):
    """
    Collect all three sources for trade_date. Returns the names of the sources
    that failed; whatever did succeed is still saved so the day is not lost.
    """
    print(f"[Collect] trade date {trade_date}")
    failed = []

    snapshot = _with_retry("Core", lambda: core_track.fetch_live_snapshot(trade_date))
    if snapshot:
        core_track.save_store(core_track.upsert(core_track.load_store(), snapshot))
    else:
        failed.append("core")

    frontier_rows = frontier_track.load_store()
    result = _with_retry("Frontier", lambda: frontier_track.update(trade_date, frontier_rows))
    if result and result[0]:
        new_rows, registry = result
        frontier_track.save_store(frontier_track.upsert(frontier_rows, new_rows))
        frontier_track.save_registry(registry)
    else:
        failed.append("frontier")

    volumes = _with_retry("Anchor", lambda: anchor.fetch_volumes(trade_date))
    if volumes:
        anchor.save_volumes(volumes)
    else:
        failed.append("anchor")
    return failed


def track_summary(rows, warmup: int):
    """Oscillator / summation series plus the latest reading for one track."""
    # Frontier rows carry a chain-equal-weighted RAMO; Core uses plain counts
    ramo = [b.get("ramo", breadth.ratio_adjusted(b["adv"], b["dec"])) for b in rows]
    osc, summ = breadth.mcclellan(ramo, warmup)
    published = [o for o in osc if o is not None]

    bands = None
    if len(published) >= config.BAND_MIN_OBS:
        bands = {"low": _r(breadth.quantile(published, config.BAND_LOW_PCT / 100)),
                 "high": _r(breadth.quantile(published, config.BAND_HIGH_PCT / 100))}

    current = {"ready": bool(published), "breadth_days": len(rows), "warmup_days": warmup}
    if rows:
        last = rows[-1]
        current.update({
            "date": last["date"],
            "advances": last["adv"],
            "declines": last["dec"],
            "unchanged": last["unch"],
            "constituents": last["n"],
            "ramo": _r(ramo[-1], 1),
            "oscillator": _r(osc[-1]),
            "summation": _r(summ[-1], 1),
            "summation_change_10d": (_r(summ[-1] - summ[-11], 1)
                                     if len(summ) > 10 and summ[-11] is not None else None),
            "percentile": (_r(breadth.percentile_rank(published, osc[-1]), 0)
                           if osc[-1] is not None else None),
        })
    by_date = {b["date"]: (b, ramo[i], osc[i], summ[i]) for i, b in enumerate(rows)}
    return by_date, current, bands


def build_payload():
    core_by_date, core_meta = core_track.index_store(core_track.load_store())
    excluded = breadth.core_exclusions(core_by_date, core_meta)
    core_rows = breadth.core_breadth(core_by_date, excluded)

    frontier_store = frontier_track.load_store()
    frontier_rows = breadth.frontier_breadth(frontier_track.index_store(frontier_store))

    core_series, core_cur, core_bands = track_summary(core_rows, config.WARMUP_DAYS)
    fr_series, fr_cur, fr_bands = track_summary(frontier_rows, config.WARMUP_DAYS)

    snapshot_dates = sorted({r["date"] for r in frontier_store})
    fr_cur["started"] = snapshot_dates[0] if snapshot_dates else None
    if snapshot_dates:
        latest = [r for r in frontier_store if r["date"] == snapshot_dates[-1] and r["tracked"] == "1"]
        fr_cur["tracked_today"] = len(latest)
        fr_cur["tracked_by_chain"] = {c: sum(1 for r in latest if r["chain"] == c) for c in config.MEME_CHAINS}
    if frontier_rows:
        last = frontier_rows[-1]
        fr_cur.update({
            "chains": last["chains"],
            "dead": last["dead"],
            "entries": last["entries"],
            "exits": last["exits"],
            "age_median": _r(last["age_median"], 1),
            "low_sample": last["n"] < config.MEME_MIN_CONSTITUENTS,
            "ramo_pooled": _r(last["ramo_pooled"], 1),
        })

    # External anchor: correlation of the published Frontier oscillator with
    # DEX volume momentum on the same chains
    dex = anchor.momentum(anchor.load_volumes())
    pairs = [(osc, dex[d]["momentum"]) for d, (_b, _r0, osc, _s) in fr_series.items()
             if osc is not None and dex.get(d, {}).get("momentum") is not None]
    fr_cur["anchor_corr_days"] = len(pairs)
    fr_cur["anchor_corr"] = (_r(anchor.pearson(*zip(*pairs)))
                             if len(pairs) >= config.ANCHOR_MIN_CORR_DAYS else None)

    def btc(d):
        return (core_by_date.get(d) or {}).get("bitcoin", (None,))[0]

    series = []
    for d in sorted(set(core_series) | set(fr_series)):
        dx = dex.get(d) or {}
        point = {
            "date": d,
            "btc_close": _r(btc(d)),
            "dex_volume": _r(dx["volume"] / 1e9, 3) if dx else None,           # USD bn
            "dex_momentum": _r(dx["momentum"] * 100, 1) if dx.get("momentum") is not None else None,
        }
        for prefix, src in (("core", core_series), ("frontier", fr_series)):
            b, ramo, osc, summ = src.get(d, (None, None, None, None))
            point.update({
                f"{prefix}_adv": b["adv"] if b else None,
                f"{prefix}_dec": b["dec"] if b else None,
                f"{prefix}_n": b["n"] if b else None,
                f"{prefix}_ramo": _r(ramo, 1),
                f"{prefix}_oscillator": _r(osc),
                f"{prefix}_summation": _r(summ, 1),
            })
        b = fr_series.get(d, (None,))[0]
        if b:
            point.update({
                "frontier_dead": b["dead"],
                "frontier_entries": b["entries"],
                "frontier_exits": b["exits"],
                "frontier_age_median": _r(b["age_median"], 1),
                "frontier_low_sample": b["n"] < config.MEME_MIN_CONSTITUENTS,
                "frontier_ramo_pooled": _r(b["ramo_pooled"], 1),
            })
        series.append(point)

    latest_date = series[-1]["date"] if series else None
    return {
        "metadata": {
            "title": "加密麦克莱伦市场宽度振荡器",
            "subtitle": "Core Top 100 (按当日市值) vs 链上 Meme (Solana · BSC · Robinhood) · 比率调整 McClellan",
            "version": "2.0.0",
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "benchmark_date": latest_date,
            "total_days": len(series),
            "parameters": {
                "ema_fast": config.EMA_FAST,
                "ema_slow": config.EMA_SLOW,
                "ratio_scale": config.RATIO_SCALE,
                "warmup_days": config.WARMUP_DAYS,
                "band_percentiles": [config.BAND_LOW_PCT, config.BAND_HIGH_PCT],
                "adv_dec_basis": "utc_close_to_close_ex_ante_universe",
            },
            "core": {
                "top_n": config.CORE_TOP_N,
                "candidate_n": config.CORE_CANDIDATE_N,
                "source": "CoinGecko",
                "history_start": core_rows[0]["date"] if core_rows else None,
                "excluded_count": len(excluded),
            },
            "frontier": {
                "chains": list(config.MEME_CHAINS),
                "gatekeeper": config.MEME_GATEKEEPER,
                "retention_days": config.MEME_RETENTION_DAYS,
                "dead_liquidity_usd": config.MEME_DEAD_LIQUIDITY_USD,
                "min_constituents": config.MEME_MIN_CONSTITUENTS,
                "ramo_weighting": "chain_equal_weight",
                "chain_min_members": config.MEME_CHAIN_MIN_MEMBERS,
                "anchor": "DefiLlama DEX volume momentum ln(MA7/MA28), chain equal-weighted",
                "source": "GeckoTerminal (discovery) + DexScreener (pricing)",
            },
        },
        "bands": {"core": core_bands, "frontier": fr_bands},
        "current": {
            "date": latest_date,
            "btc_close": _r(btc(latest_date)) if latest_date else None,
            "core": core_cur,
            "frontier": fr_cur,
        },
        "series": series,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--offline", action="store_true", help="skip data collection")
    parser.add_argument("--skip-if-final", action="store_true",
                        help="only recompute when today's trade date already has a post-close snapshot")
    args = parser.parse_args()

    failed = []
    trade_date = trade_date_now()
    if args.offline:
        pass
    elif args.skip_if_final and is_final(load_collection_log().get(trade_date), trade_date):
        print(f"[Collect] {trade_date} already has a final post-close snapshot; recompute only")
    else:
        failed = collect(trade_date)
        record_collection(trade_date, failed)

    payload = build_payload()
    config.OUTPUT_JSON_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(config.OUTPUT_JSON_FILE, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)

    cur = payload["current"]
    print(f"[Export] {config.OUTPUT_JSON_FILE} | {payload['metadata']['total_days']} days | "
          f"core osc {cur['core'].get('oscillator')} | frontier osc {cur['frontier'].get('oscillator')} "
          f"({cur['frontier'].get('breadth_days', 0)}/{config.WARMUP_DAYS} breadth days)")

    # Non-zero exit marks the scheduled run red (GitHub emails the owner) after
    # everything that was collected has been written
    if failed:
        print(f"[Export] collection failed for: {', '.join(failed)}")
        sys.exit(1)


if __name__ == "__main__":
    main()
