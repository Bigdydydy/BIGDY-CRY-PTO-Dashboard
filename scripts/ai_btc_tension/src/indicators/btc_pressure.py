"""
Layer 2: BTC Liquidity & Monetization Pressure Index (P_BTC)
Strictly Exogenous Formulation:
  P_BTC = 0.35 * Z(-CME Basis / Inversion)
        + 0.25 * Z(-Basis Momentum Deceleration)
        + 0.20 * Z(Cross-Asset Volatility Shock)
        + 0.20 * Z(-Miner Equities vs QQQ Tech Performance)
Contains 0% BTC price return or BTC realized volatility terms to ensure complete econometric exogeneity.
"""

import pandas as pd
import numpy as np
import config
from .ai_pressure import rolling_zscore

class BTCPressureEngine:
    def __init__(self, weights=config.P_BTC_WEIGHTS):
        self.weights = weights

    def compute_p_btc(self, market_factors_df: pd.DataFrame) -> pd.DataFrame:
        """
        Derives exogenous market liquidity and institutional funding pressure.
        Completely excludes BTC spot price returns or downside volatility.
        """
        df = market_factors_df.copy()
        res = pd.DataFrame(index=df.index)

        # 1. Basis Inversion / Compression:
        if "basis" in df and not df["basis"].isna().all():
            basis_clean = df["basis"].fillna(0.05)
            z_basis_inversion = -rolling_zscore(basis_clean)
        else:
            z_basis_inversion = pd.Series(0.0, index=df.index)

        # 2. CME Basis Deceleration / Momentum Drain:
        basis_mean_30d = df["basis"].rolling(30, min_periods=5).mean().fillna(0.05)
        basis_accel = df["basis"] - basis_mean_30d
        z_basis_momentum = -rolling_zscore(basis_accel.fillna(0.0))

        # 3. Cross-Market Volatility Shock (VIX level + delta):
        vix = df.get("vix_level", pd.Series(20.0, index=df.index)).fillna(20.0)
        vix_d = df.get("vix_delta", pd.Series(0.0, index=df.index)).fillna(0.0)
        z_vol_stress = 0.5 * rolling_zscore(vix) + 0.5 * rolling_zscore(vix_d)

        # 4. Miner Basket Relative Performance vs Tech Benchmark (QQQ):
        if "miner_basket_ret" in df and "qqq_ret" in df:
            miner_vs_qqq = (df["miner_basket_ret"] - df["qqq_ret"]).rolling(30, min_periods=5).sum().fillna(0.0)
            z_miner_stress = -rolling_zscore(miner_vs_qqq)
        else:
            z_miner_stress = pd.Series(0.0, index=df.index)

        # Composite P_BTC
        w = self.weights
        p_btc = (
            w["basis_inversion_risk"] * z_basis_inversion +
            w["basis_momentum_drain"] * z_basis_momentum +
            w["cross_vol_shock"] * z_vol_stress +
            w["miner_equity_squeeze"] * z_miner_stress
        )

        res["p_btc"] = p_btc
        res["i_crypto"] = p_btc
        res["z_basis_inversion"] = z_basis_inversion
        res["z_basis_momentum"] = z_basis_momentum
        res["z_vol_stress"] = z_vol_stress
        res["z_miner_stress"] = z_miner_stress
        res["raw_basis"] = df.get("basis", pd.Series(0.05, index=df.index)).fillna(0.05)
        res["raw_basis_momentum"] = basis_accel.fillna(0.0)
        res["raw_vix"] = vix.fillna(20.0)

        print(f"[P_BTC / I_Crypto] Computed Layer 2 Exogenous Liquidity Pressure ({len(res)} days, 0% BTC price feedback)")
        return res