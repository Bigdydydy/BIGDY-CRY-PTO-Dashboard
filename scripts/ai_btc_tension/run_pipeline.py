"""
Master Execution Pipeline for AI-BTC Financing Tension Index & Transmission Analysis Engine
Executes end-to-end:
  1. Macro Data Ingestion (FRED & Market Data & SEC EDGAR)
  2. Indicator Construction (Layer 1 P_AI & Layer 2 P_BTC)
  3. Regime Classification (4-Quadrant State Machine)
  4. Econometric Identification (Orthogonal Residual OLS & Event Study & Causality)
  5. Interactive Institutional Dashboard Output
"""

import sys
import os
from pathlib import Path
import pandas as pd
import numpy as np

# Ensure root is in path
ROOT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT_DIR))

import config
from src.collectors.fred_collector import FREDCollector
from src.collectors.sec_collector import SECEdgarCollector
from src.collectors.market_collector import MarketDataCollector
from src.indicators.ai_pressure import AIPressureEngine
from src.indicators.btc_pressure import BTCPressureEngine
from src.indicators.tension_matrix import TensionMatrixEngine
from src.econometric.macro_residual import MacroResidualEngine
from src.econometric.event_study import EventStudyEngine
from src.econometric.causality import CausalityEngine
from src.visualization.dashboard_generator import DashboardGenerator

def main():
    print("================================================================================")
    print("  AI-BTC FINANCING TENSION INDEX & TRANSMISSION ANALYSIS ENGINE (V1.0)")
    print("  Testing Hypothesis: Does BTC Provide Liquidity & Financing for AI Capex?")
    print("================================================================================\n")

    # 1. Data Collection
    print(">>> STEP 1: Collecting Macro, Market, and Fundamental Feeds...")
    fred_col = FREDCollector()
    fred_df = fred_col.fetch_all()

    market_col = MarketDataCollector()
    market_prices = market_col.fetch_tickers(start_date="2022-01-01")
    market_factors = market_col.compute_returns_and_factors(market_prices)

    sec_col = SECEdgarCollector()
    sec_agg_df = sec_col.collect_ai_universe()

    # 2. Indicator Calculation (Layer 1 & Layer 2)
    print("\n>>> STEP 2: Computing Layer 1 (P_AI) & Layer 2 (P_BTC)...")
    ai_engine = AIPressureEngine()
    p_ai_df = ai_engine.compute_p_ai(sec_agg_df, fred_df, market_factors)

    btc_engine = BTCPressureEngine()
    p_btc_df = btc_engine.compute_p_btc(market_factors)

    # 3. Core State Machine: Tension Matrix
    print("\n>>> STEP 3: Evaluating 4-Quadrant Tension Matrix & Regime Shift...")
    matrix_engine = TensionMatrixEngine()
    tension_df = matrix_engine.evaluate_regimes(p_ai_df, p_btc_df)

    latest = tension_df.iloc[-1]
    print(f"\n[*] Current Date: {tension_df.index.max().strftime('%Y-%m-%d')}")
    print(f"[*] Current Regime: {latest['regime_code']} - {latest['regime_name']}")
    print(f"[*] AI Financing Pressure (P_AI): {latest['p_ai']:+.2f} Z-Score")
    print(f"[*] BTC Monetization Pressure (P_BTC): {latest['p_btc']:+.2f} Z-Score")
    print(f"[*] Tension Intensity (r): {latest['tension_intensity']:.2f}")

    # 4. Layer 3: Econometric Identification & Falsification
    print("\n>>> STEP 4: Running Macro-Orthogonal Residual Regression...")
    residual_engine = MacroResidualEngine()
    reg_dataset = residual_engine.prepare_regression_dataset(market_factors, fred_df)
    model, reg_results, summary_dict = residual_engine.fit_full_sample_ols(reg_dataset)

    # Test Q2 Hypothesis
    q2_hypo_test = residual_engine.test_regime_residual_hypothesis(tension_df, reg_results["btc_residual"])

    # Event Study
    print("\n>>> STEP 5: Running Event Study CAR Analysis...")
    event_engine = EventStudyEngine()
    event_df = event_engine.evaluate_events(reg_results["btc_residual"], reg_results["btc_ret"])

    # Causality
    print("\n>>> STEP 6: Testing Granger Causality & Lead-Lag Cross-Correlation...")
    causality_engine = CausalityEngine()
    causality_results = causality_engine.run_granger_causality(tension_df["p_ai"], reg_results["btc_residual"])

    # 5. Visual Dashboard Generation
    print("\n>>> STEP 7: Generating Interactive Visual Dashboard...")
    dash_gen = DashboardGenerator()
    html_path = dash_gen.generate_dashboard(
        tension_df=tension_df,
        market_factors_df=market_factors,
        regression_summary=summary_dict,
        reg_df=reg_results,
        event_study_df=event_df,
        causality_dict=causality_results
    )

    print("\n================================================================================")
    print("  PIPELINE EXECUTION COMPLETE!")
    print(f"  Interactive Dashboard Generated: {html_path.resolve()}")
    print("================================================================================")

if __name__ == "__main__":
    main()