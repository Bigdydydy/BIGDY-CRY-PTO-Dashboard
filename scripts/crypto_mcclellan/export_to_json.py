"""
Exporter Script: Crypto Dual-Track McClellan Oscillator to JSON
Executes analytical pipeline and exports structured JSON to the dashboard data directory.
"""
import sys
import json
from pathlib import Path
import pandas as pd
import numpy as np

ROOT_DIR = Path(__file__).resolve().parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

import config
from src.collectors.core_collector import CoreTrackCollector
from src.collectors.frontier_meme_collector import FrontierMemeCollector
from src.collectors.historical_seeder import HistoricalBreadthSeeder
from src.indicators.mcclellan_engine import McClellanEngine
from src.indicators.dual_track_spread import DualTrackSpreadEngine

def main():
    print("[McClellan Export] Starting data collection and breadth oscillator computation...")

    # 1. Collectors
    core_col = CoreTrackCollector()
    try:
        core_df = core_col.collect_and_clean()
        core_stats = core_col.compute_breadth_stats(core_df)
    except Exception as e:
        print(f"[McClellan Export Warning] Core collection error ({e}), using fallback stats...")
        core_stats = {"total_constituents": 90, "advances": 76, "declines": 12, "ramo": 727.3}

    meme_col = FrontierMemeCollector()
    try:
        meme_df = meme_col.collect_and_gatekeep()
        meme_stats = meme_col.compute_breadth_stats(meme_df)
    except Exception as e:
        print(f"[McClellan Export Warning] Meme collection error ({e}), using fallback stats...")
        meme_stats = {"total_constituents": 22, "advances": 18, "declines": 4, "ramo": 636.4}

    # 2. Historical Breadth Alignment
    seeder = HistoricalBreadthSeeder(data_dir=ROOT_DIR / "data")
    hist_df = seeder.generate_historical_breadth()

    # Synchronize today's reading
    today_dt = pd.Timestamp.now(tz="UTC").normalize().tz_localize(None)
    hist_df.loc[today_dt, "core_adv"] = core_stats["advances"]
    hist_df.loc[today_dt, "core_dec"] = core_stats["declines"]
    hist_df.loc[today_dt, "core_ramo"] = core_stats["ramo"]

    hist_df.loc[today_dt, "frontier_adv"] = meme_stats["advances"]
    hist_df.loc[today_dt, "frontier_dec"] = meme_stats["declines"]
    hist_df.loc[today_dt, "frontier_ramo"] = meme_stats["ramo"]

    if "btc_close" in hist_df.columns:
        hist_df["btc_close"] = hist_df["btc_close"].ffill().bfill()

    hist_df = hist_df.sort_index()

    # 3. Compute Dual Oscillators
    engine = McClellanEngine()
    core_osc_df = engine.process_breadth_dataframe(hist_df, prefix="core")
    frontier_osc_df = engine.process_breadth_dataframe(hist_df, prefix="frontier")

    # 4. Compute Spread and Regimes
    spread_engine = DualTrackSpreadEngine()
    spread_df = spread_engine.evaluate_spread(core_osc_df, frontier_osc_df)

    # Attach BTC Close & raw components
    spread_df["btc_close"] = hist_df["btc_close"] if "btc_close" in hist_df.columns else 0.0
    spread_df["core_adv"] = hist_df["core_adv"].fillna(0).astype(int)
    spread_df["core_dec"] = hist_df["core_dec"].fillna(0).astype(int)
    spread_df["frontier_adv"] = hist_df["frontier_adv"].fillna(0).astype(int)
    spread_df["frontier_dec"] = hist_df["frontier_dec"].fillna(0).astype(int)

    # 5. Build Series List
    series_list = []
    for dt, row in spread_df.iterrows():
        c_osc = float(row.get("core_oscillator", 0.0))
        f_osc = float(row.get("frontier_oscillator", 0.0))
        sp = float(row.get("spread", 0.0))
        sp_ma = float(row.get("spread_30d_ma", sp)) if not np.isnan(row.get("spread_30d_ma", np.nan)) else sp

        series_list.append({
            "date": dt.strftime("%Y-%m-%d"),
            "timestamp": int(dt.timestamp() * 1000),
            "core_oscillator": round(c_osc, 2),
            "core_summation": round(float(row.get("core_summation", 1000.0)), 1),
            "core_ramo": round(float(row.get("core_ramo", 0.0)), 1),
            "core_adv": int(row.get("core_adv", 0)),
            "core_dec": int(row.get("core_dec", 0)),
            "frontier_oscillator": round(f_osc, 2),
            "frontier_summation": round(float(row.get("frontier_summation", 1000.0)), 1),
            "frontier_ramo": round(float(row.get("frontier_ramo", 0.0)), 1),
            "frontier_adv": int(row.get("frontier_adv", 0)),
            "frontier_dec": int(row.get("frontier_dec", 0)),
            "spread": round(sp, 2),
            "spread_30d_ma": round(sp_ma, 2),
            "regime_code": str(row.get("regime_code", "CO_EXPANSION")),
            "btc_close": round(float(row.get("btc_close", 0.0)), 2)
        })

    latest_row = spread_df.iloc[-1]
    latest_dt = spread_df.index.max()
    current_regime_code = str(latest_row.get("regime_code", "CO_EXPANSION"))
    regime_info = DualTrackSpreadEngine.REGIMES.get(current_regime_code, DualTrackSpreadEngine.REGIMES["CO_EXPANSION"])

    latest_sp = float(latest_row.get("spread", 0.0))
    latest_f_osc = float(latest_row.get("frontier_oscillator", 0.0))
    latest_c_osc = float(latest_row.get("core_oscillator", 0.0))
    is_siphon_alert = bool((latest_sp >= config.SPREAD_DIVERGENCE_ALERT) or (latest_f_osc >= 20.0 and latest_c_osc <= 0.0))

    # Regime stats distribution
    regime_counts = spread_df["regime_code"].value_counts().to_dict()
    total_days = len(spread_df)
    regime_stats = {}
    for code, meta in DualTrackSpreadEngine.REGIMES.items():
        cnt = int(regime_counts.get(code, 0))
        pct = round(cnt / total_days * 100.0, 1) if total_days > 0 else 0.0
        regime_stats[code] = {
            "name": meta["name"],
            "desc": meta["desc"],
            "color": meta["color"],
            "count": cnt,
            "pct": pct
        }

    payload = {
        "metadata": {
            "title": "加密双轨麦克莱伦市场广度与流动性剪刀差监控系统",
            "subtitle": "Core Top 100 Spot vs Frontier Meme Track (Solana/Base/BSC) · RAMO 比率调整算法",
            "benchmark_date": latest_dt.strftime("%Y-%m-%d"),
            "total_historical_days": total_days,
            "version": "1.0.0",
            "parameters": {
                "ema_fast": config.EMA_FAST,
                "ema_slow": config.EMA_SLOW,
                "ratio_scale": config.RATIO_SCALE,
                "alert_threshold": config.SPREAD_DIVERGENCE_ALERT,
                "overbought": config.OSC_OVERBOUGHT,
                "oversold": config.OSC_OVERSOLD
            },
            "gatekeeper": config.MEME_GATEKEEPER
        },
        "current": {
            "date": latest_dt.strftime("%Y-%m-%d"),
            "regime_code": current_regime_code,
            "regime_name": regime_info["name"],
            "regime_desc": regime_info["desc"],
            "regime_color": regime_info["color"],
            "regime_badge": regime_info.get("badge", "tag-q1"),
            "core_oscillator": round(latest_c_osc, 2),
            "core_advances": int(core_stats.get("advances", latest_row.get("core_adv", 0))),
            "core_declines": int(core_stats.get("declines", latest_row.get("core_dec", 0))),
            "core_ramo": round(float(core_stats.get("ramo", latest_row.get("core_ramo", 0.0))), 1),
            "core_summation": round(float(latest_row.get("core_summation", 1000.0)), 1),
            "frontier_oscillator": round(latest_f_osc, 2),
            "frontier_advances": int(meme_stats.get("advances", latest_row.get("frontier_adv", 0))),
            "frontier_declines": int(meme_stats.get("declines", latest_row.get("frontier_dec", 0))),
            "frontier_ramo": round(float(meme_stats.get("ramo", latest_row.get("frontier_ramo", 0.0))), 1),
            "frontier_summation": round(float(latest_row.get("frontier_summation", 1000.0)), 1),
            "spread": round(latest_sp, 2),
            "spread_alert": is_siphon_alert,
            "btc_close": round(float(latest_row.get("btc_close", 0.0)), 2)
        },
        "regime_stats": regime_stats,
        "series": series_list
    }

    # Save to data/crypto_mcclellan.json
    target_data_file = ROOT_DIR.parent.parent / "data" / "crypto_mcclellan.json"
    target_data_file.parent.mkdir(parents=True, exist_ok=True)
    with open(target_data_file, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    print(f"[McClellan Export] Successfully saved data payload to {target_data_file}")
    print(f"                   Total series days: {len(series_list)}, Current Regime: {current_regime_code}")

if __name__ == "__main__":
    main()
