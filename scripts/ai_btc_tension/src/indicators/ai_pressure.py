"""
Layer 1: AI Financing Pressure Index (P_AI)
Calculates:
  P_AI = 0.35 * Z(Capex/OCF)
       + 0.25 * Z(Capex_Growth_Surprise)
       + 0.20 * Z(External_Financing)
       + 0.20 * Z(Credit_Cost_Spread)
"""

import pandas as pd
import numpy as np
import config

def rolling_zscore(series: pd.Series, window: int = config.ROLLING_WINDOW_ZSCORE) -> pd.Series:
    mean = series.rolling(window, min_periods=max(20, window // 4)).mean()
    std = series.rolling(window, min_periods=max(20, window // 4)).std()
    z = (series - mean) / std.replace(0, np.nan)
    return z.fillna(0.0)

class AIPressureEngine:
    def __init__(self, weights=config.P_AI_WEIGHTS):
        self.weights = weights

    def compute_p_ai(self, sec_agg_df: pd.DataFrame, fred_df: pd.DataFrame, market_df: pd.DataFrame) -> pd.DataFrame:
        """
        Integrates SEC quarterly fundamentals and FRED daily credit/rate data.
        Aligns to daily market trading days.
        """
        # Daily index from market data
        daily_idx = market_df.index.sort_values()
        res = pd.DataFrame(index=daily_idx)

        # 1. Forward-fill SEC quarterly ratios to daily
        if not sec_agg_df.empty:
            sec_daily = sec_agg_df.reindex(sec_agg_df.index.union(daily_idx)).sort_index()
            sec_daily = sec_daily.ffill().loc[daily_idx]

            capex_to_ocf = sec_daily["aggregate_capex_to_ocf"]
            fcf_gap = sec_daily["aggregate_fcf_gap"]
            debt_issuance = sec_daily["total_debt_issuance"]

            # Capex YoY Growth
            capex_growth = sec_daily["total_capex"].pct_change(252, fill_method=None)
        else:
            capex_to_ocf = pd.Series(1.0, index=daily_idx)
            capex_growth = pd.Series(0.0, index=daily_idx)
            debt_issuance = pd.Series(0.0, index=daily_idx)

        # 2. Credit Costs from FRED (High Yield OAS Spread + 10Y TIPS Real Rate)
        if "BAMLH0A0HYM2" in fred_df and "DFII10" in fred_df:
            fred_daily = fred_df.reindex(fred_df.index.union(daily_idx)).sort_index().ffill().loc[daily_idx]
            hy_spread = fred_daily["BAMLH0A0HYM2"]
            real_rate = fred_daily["DFII10"]
            credit_cost = 0.5 * rolling_zscore(hy_spread) + 0.5 * rolling_zscore(real_rate)
        else:
            credit_cost = pd.Series(0.0, index=daily_idx)

        # 3. Miner HPC Re-rating Spread from market pricing
        if "miner_hpc_log_spread" in market_df:
            z_hpc_spread = rolling_zscore(market_df["miner_hpc_log_spread"])
            hpc_ratio = market_df.get("hpc_vs_pure_ratio", pd.Series(1.0, index=daily_idx))
        else:
            z_hpc_spread = pd.Series(0.0, index=daily_idx)
            hpc_ratio = pd.Series(1.0, index=daily_idx)

        # Calculate Component Z-Scores
        z_capex_ocf = rolling_zscore(capex_to_ocf)
        z_capex_growth = rolling_zscore(capex_growth)
        z_debt = rolling_zscore(debt_issuance)
        z_credit = rolling_zscore(credit_cost)

        # Composite Compute & Power Infrastructure Re-rating Index (I_Compute / P_AI)
        w = self.weights
        p_ai = (
            w.get("miner_hpc_spread", 0.40) * z_hpc_spread +
            w.get("capex_to_ocf", 0.25) * z_capex_ocf +
            w.get("capex_growth_surprise", 0.20) * z_capex_growth +
            w.get("credit_cost_spread", 0.15) * z_credit
        )

        res["p_ai"] = p_ai
        res["i_compute"] = p_ai
        res["z_hpc_spread"] = z_hpc_spread
        res["hpc_vs_pure_ratio"] = hpc_ratio
        res["raw_hpc_ratio"] = hpc_ratio
        res["raw_capex_to_ocf"] = capex_to_ocf
        res["raw_capex_growth"] = capex_growth
        res["raw_credit_cost"] = credit_cost
        res["z_capex_ocf"] = z_capex_ocf
        res["z_capex_growth"] = z_capex_growth
        res["z_debt_issuance"] = z_debt
        res["z_credit_cost"] = z_credit

        print(f"[P_AI / I_Compute] Computed Layer 1 Compute & Power Re-rating Index ({len(res)} days, HPC spread weight={w.get('miner_hpc_spread', 0.40)})")
        return res