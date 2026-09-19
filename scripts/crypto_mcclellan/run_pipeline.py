"""
Master Execution Pipeline for Crypto Dual-Track McClellan Oscillator
Executes end-to-end:
  1. Ingests Core Track (CoinGecko Top 100 Spot, negative-filtered)
  2. Ingests Frontier Meme Track (DexScreener/GeckoTerminal on-chain gatekept)
  3. Aligns with Historical Breadth Series (1000+ days)
  4. Calculates Ratio-Adjusted McClellan Oscillators & Summation Indices (EMA19, EMA39)
  5. Computes Liquidity Divergence Spread & Evaluates 4-Regime States
  6. Renders Standalone Institutional Plotly HTML Dashboard
"""

import sys
from pathlib import Path
import pandas as pd
import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import config
from src.collectors.core_collector import CoreTrackCollector
from src.collectors.frontier_meme_collector import FrontierMemeCollector
from src.collectors.historical_seeder import HistoricalBreadthSeeder
from src.indicators.mcclellan_engine import McClellanEngine
from src.indicators.dual_track_spread import DualTrackSpreadEngine
from src.visualization.dashboard_generator import DashboardGenerator

def main():
    print("================================================================================")
    print("  CRYPTO DUAL-TRACK MCCLELLAN OSCILLATOR SYSTEM (V1.0)")
    print("  Core Track (Top 100 Spot) vs Frontier Meme Track (Solana / Base / BSC)")
    print("================================================================================\n")

    # 1. Ingest Core Track
    print(">>> STEP 1: Collecting Core Track (CEX / CoinGecko Top 100 Spot)...")
    core_col = CoreTrackCollector()
    core_df = core_col.collect_and_clean()
    core_stats = core_col.compute_breadth_stats(core_df)
    print(f"[*] Core Constituents: {core_stats['total_constituents']} | Adv: {core_stats['advances']} | Dec: {core_stats['declines']} | RAMO: {core_stats['ramo']:+.1f}")

    # 2. Ingest Frontier Meme Track
    print("\n>>> STEP 2: Collecting Frontier Meme Track (On-Chain Gatekeeper & 7-Day Buffer)...")
    meme_col = FrontierMemeCollector()
    meme_df = meme_col.collect_and_gatekeep()
    meme_stats = meme_col.compute_breadth_stats(meme_df)
    print(f"[*] Frontier Meme Qualified Tokens: {meme_stats['total_constituents']} | Adv: {meme_stats['advances']} | Dec: {meme_stats['declines']} | RAMO: {meme_stats['ramo']:+.1f}")

    # 3. Load & Update Historical Breadth Series
    print("\n>>> STEP 3: Loading & Synchronizing Multi-Year Historical Breadth Series...")
    seeder = HistoricalBreadthSeeder()
    hist_df = seeder.generate_historical_breadth()

    # Append or update today's live reading into the historical time series
    today_dt = pd.Timestamp.now(tz="UTC").normalize().tz_localize(None)
    hist_df.loc[today_dt, "core_adv"] = core_stats["advances"]
    hist_df.loc[today_dt, "core_dec"] = core_stats["declines"]
    hist_df.loc[today_dt, "core_ramo"] = core_stats["ramo"]

    hist_df.loc[today_dt, "frontier_adv"] = meme_stats["advances"]
    hist_df.loc[today_dt, "frontier_dec"] = meme_stats["declines"]
    hist_df.loc[today_dt, "frontier_ramo"] = meme_stats["ramo"]

    hist_df = hist_df.sort_index()

    # 4. Calculate Dual McClellan Oscillators
    print("\n>>> STEP 4: Computing Dual Ratio-Adjusted McClellan Oscillators (EMA19 - EMA39)...")
    engine = McClellanEngine()
    core_osc_df = engine.process_breadth_dataframe(hist_df, prefix="core")
    frontier_osc_df = engine.process_breadth_dataframe(hist_df, prefix="frontier")

    # 5. Compute Divergence Spread & Classify Regimes
    print("\n>>> STEP 5: Computing Liquidity Divergence Spread & Regime Classification...")
    spread_engine = DualTrackSpreadEngine()
    spread_df = spread_engine.evaluate_spread(core_osc_df, frontier_osc_df)

    latest_row = spread_df.iloc[-1]
    print(f"\n==================== CURRENT MARKET BREADTH DIAGNOSTIC ====================")
    print(f"  Benchmark Date          : {spread_df.index.max().strftime('%Y-%m-%d')}")
    print(f"  Current Regime          : {latest_row['regime_name']}")
    print(f"  Core McClellan (Top 100): {latest_row['core_oscillator']:+.2f}")
    print(f"  Frontier Meme McClellan : {latest_row['frontier_oscillator']:+.2f}")
    print(f"  Liquidity Spread (F - C): {latest_row['spread']:+.2f}")
    print(f"  Core MSI (Summation)    : {latest_row['core_summation']:.1f}")
    print(f"  Description             : {latest_row['regime_desc']}")
    print(f"===========================================================================\n")

    # 6. Generate Standalone Visual Dashboard
    print(">>> STEP 6: Generating Standalone Interactive HTML Dashboard...")
    dash_gen = DashboardGenerator()
    btc_series = hist_df["btc_close"] if "btc_close" in hist_df else None
    out_html = dash_gen.generate_dashboard(
        spread_df=spread_df,
        core_stats=core_stats,
        frontier_stats=meme_stats,
        btc_price_series=btc_series
    )

    print(f"\n[DONE] Pipeline execution finished successfully!")
    print(f"[>] Interactive Dashboard: {out_html.resolve()}")

if __name__ == "__main__":
    main()