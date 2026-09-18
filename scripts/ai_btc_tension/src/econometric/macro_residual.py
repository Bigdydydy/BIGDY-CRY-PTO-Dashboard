"""
Layer 3: Macro-Orthogonal Residual Regression Engine
Estimates:
  R_BTC,t = alpha + beta_1*R_QQQ + beta_2*Delta_DXY + beta_3*Delta_TIPS + beta_4*Delta_VIX + beta_5*Delta_FedNetLiq + epsilon_BTC,t
Isolates the purely orthogonal BTC residual return epsilon_BTC to test whether
AI financing stress exerts statistically significant liquidity drain beyond macro variables.
"""

import pandas as pd
import numpy as np
import statsmodels.api as sm
from scipy import stats

class MacroResidualEngine:
    def __init__(self, rolling_window: int = 120, min_burnin: int = 60):
        self.rolling_window = rolling_window
        self.min_burnin = min_burnin

    def prepare_regression_dataset(self, market_factors_df: pd.DataFrame, fred_df: pd.DataFrame) -> pd.DataFrame:
        """
        Merge and align market variables and Fed Net Liquidity.
        """
        df = market_factors_df.copy()

        # Align FRED variables
        if not fred_df.empty:
            fred_aligned = fred_df.reindex(fred_df.index.union(df.index)).sort_index().ffill().loc[df.index]
            if "Fed_Net_Liquidity_B" in fred_aligned:
                liq = fred_aligned["Fed_Net_Liquidity_B"]
                df["delta_fed_net_liq"] = np.log(liq / liq.shift(1)).fillna(0.0)
            else:
                df["delta_fed_net_liq"] = 0.0

            if "DFII10" in fred_aligned:
                df["delta_real_yield"] = fred_aligned["DFII10"] - fred_aligned["DFII10"].shift(1)
            else:
                df["delta_real_yield"] = 0.0
            if "repo_spread" in fred_aligned:
                df["repo_spread"] = fred_aligned["repo_spread"].fillna(0.0)
            else:
                df["repo_spread"] = 0.0

            if "delta_term_premium" in fred_aligned:
                df["delta_term_premium"] = fred_aligned["delta_term_premium"].fillna(0.0)
            elif "term_premium" in fred_aligned:
                df["delta_term_premium"] = fred_aligned["term_premium"].diff().fillna(0.0)
            else:
                df["delta_term_premium"] = 0.0
        else:
            df["delta_fed_net_liq"] = 0.0
            df["delta_real_yield"] = 0.0
            df["repo_spread"] = 0.0
            df["delta_term_premium"] = 0.0

        # Target and Explanatory variables (including Macro Plumbing: Term Premium & Repo Spread)
        self.feature_cols = ["qqq_ret", "dxy_ret", "delta_real_yield", "vix_delta", "delta_fed_net_liq", "delta_term_premium", "repo_spread"]
        cols = ["btc_ret"] + self.feature_cols
        reg_df = df[cols].replace([np.inf, -np.inf], np.nan).dropna()
        return reg_df

    def fit_full_sample_ols(self, reg_df: pd.DataFrame) -> tuple:
        """
        Fit full sample OLS regression with Newey-West HAC robust standard errors.
        """
        feature_cols = getattr(self, "feature_cols", [c for c in reg_df.columns if c not in ["btc_ret", "btc_predicted", "btc_residual"]])
        Y = reg_df["btc_ret"]
        X = reg_df[feature_cols]
        X_const = sm.add_constant(X)

        model = sm.OLS(Y, X_const).fit()
        # Compute HAC robust covariance (Newey-West, 5 lags)
        model_hac = model.get_robustcov_results(cov_type="HAC", maxlags=5)

        reg_df["btc_predicted"] = model.fittedvalues
        reg_df["btc_residual"] = model.resid  # epsilon_BTC

        cols = list(X_const.columns)
        params_dict = {c: float(v) for c, v in zip(cols, model_hac.params)}
        tvalues_dict = {c: float(v) for c, v in zip(cols, model_hac.tvalues)}
        pvalues_dict = {c: float(v) for c, v in zip(cols, model_hac.pvalues)}
        bse_dict = {c: float(v) for c, v in zip(cols, model_hac.bse)}

        summary_dict = {
            "r_squared": float(model.rsquared),
            "adj_r_squared": float(model.rsquared_adj),
            "f_pvalue": float(model_hac.f_pvalue) if hasattr(model_hac, "f_pvalue") else float(model.f_pvalue),
            "params": params_dict,
            "tvalues": tvalues_dict,
            "pvalues": pvalues_dict,
            "bse": bse_dict
        }

        print(f"[Regression] Full Sample OLS Fitted (HAC Newey-West). R^2 = {model.rsquared:.4f}, Adj R^2 = {model.rsquared_adj:.4f}")
        for var in cols:
            print(f"  {var:20s}: Beta = {params_dict[var]:8.4f} (HAC t = {tvalues_dict[var]:6.2f}, p = {pvalues_dict[var]:.4f})")

        return model, reg_df, summary_dict

    def fit_rolling_ols(self, reg_df: pd.DataFrame) -> pd.Series:
        """
        Fit rolling/expanding window OLS to calculate strictly Out-of-Sample (OOS) residuals.
        For each date t, model is estimated on [t-w, t-1] and predicts R_BTC,t strictly with prior information.
        """
        feature_cols = getattr(self, "feature_cols", [c for c in reg_df.columns if c not in ["btc_ret", "btc_predicted", "btc_residual"]])
        residuals = pd.Series(np.nan, index=reg_df.index)
        Y = reg_df["btc_ret"]
        X = sm.add_constant(reg_df[feature_cols])

        w = self.rolling_window
        min_b = self.min_burnin
        n = len(reg_df)

        # Baseline model from initial burn-in window
        initial_mod = None
        if n >= min_b:
            try:
                initial_mod = sm.OLS(Y.iloc[:min_b], X.iloc[:min_b]).fit()
                for i in range(min_b):
                    pred = initial_mod.predict(X.iloc[i:i+1]).values[0]
                    residuals.iloc[i] = Y.iloc[i] - pred
            except Exception:
                pass

        # Rolling OOS estimation from min_burnin to end
        for i in range(min_b, n):
            start_idx = max(0, i - w)
            window_Y = Y.iloc[start_idx:i]
            window_X = X.iloc[start_idx:i]
            try:
                mod = sm.OLS(window_Y, window_X).fit()
                # Strict Out-of-Sample prediction for current observation i
                pred = mod.predict(X.iloc[i:i+1]).values[0]
                residuals.iloc[i] = Y.iloc[i] - pred
            except Exception:
                residuals.iloc[i] = residuals.iloc[i-1] if i > 0 else 0.0

        print(f"[Rolling OLS] Computed {len(residuals.dropna())} Out-of-Sample (OOS) daily residuals (window={w}).")
        return residuals

    def test_regime_residual_hypothesis(self, tension_df: pd.DataFrame, residual_series: pd.Series) -> dict:
        """
        Test whether BTC Residual (epsilon_BTC) is statistically significantly negative during Q2 (Cannibalization).
        Performs a rigorous ONE-SIDED Welch's t-test (H1: Q2_mean < Non_Q2_mean) and calculates Cohen's d effect size.
        """
        aligned = pd.DataFrame({
            "regime": tension_df["regime_code"],
            "residual": residual_series
        }).dropna()

        q2_resid = aligned[aligned["regime"] == "Q2"]["residual"]
        non_q2_resid = aligned[aligned["regime"] != "Q2"]["residual"]

        if len(q2_resid) < 3 or len(non_q2_resid) < 3:
            return {
                "q2_avg_residual_daily_pct": 0.0,
                "non_q2_avg_residual_daily_pct": 0.0,
                "t_stat": 0.0,
                "p_value": 1.0,
                "cohen_d": 0.0,
                "q2_count": len(q2_resid),
                "non_q2_count": len(non_q2_resid),
                "is_significant_5pct": False,
                "is_significant_10pct": False
            }

        # One-sided Welch's t-test (alternative='less' tests whether Q2 mean is strictly less than non-Q2 mean)
        t_stat, p_val_less = stats.ttest_ind(q2_resid, non_q2_resid, equal_var=False, alternative="less", nan_policy="omit")
        q2_mean = float(q2_resid.mean() * 100.0) # daily %
        non_q2_mean = float(non_q2_resid.mean() * 100.0)

        # Cohen's d effect size
        s_pooled = np.sqrt((q2_resid.var(ddof=1) + non_q2_resid.var(ddof=1)) / 2.0)
        cohen_d = float((q2_resid.mean() - non_q2_resid.mean()) / s_pooled) if s_pooled > 0 else 0.0

        result = {
            "q2_avg_residual_daily_pct": q2_mean,
            "non_q2_avg_residual_daily_pct": non_q2_mean,
            "t_stat": float(t_stat),
            "p_value": float(p_val_less),
            "cohen_d": cohen_d,
            "q2_count": len(q2_resid),
            "non_q2_count": len(non_q2_resid),
            "is_significant_5pct": bool(q2_mean < non_q2_mean and p_val_less < 0.05),
            "is_significant_10pct": bool(q2_mean < non_q2_mean and p_val_less < 0.10)
        }

        print(f"[Hypothesis Test] Q2 Residual: {q2_mean:.3f}% vs Non-Q2: {non_q2_mean:.3f}% (1-sided Welch t={t_stat:.2f}, p={p_val_less:.4f}, d={cohen_d:.2f})")
        return result