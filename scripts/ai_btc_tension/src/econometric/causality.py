"""
Layer 3: Causality and Lead-Lag Cross-Correlation Engine
Tests whether AI Financing Pressure leads BTC Residual Returns (or vice-versa)
using Granger Causality and Rolling Cross-Correlation.
Enforces Augmented Dickey-Fuller (ADF) stationarity testing and first-differencing
to prevent spurious Granger regressions.
"""

import pandas as pd
import numpy as np
from statsmodels.tsa.stattools import grangercausalitytests, adfuller

class CausalityEngine:
    def __init__(self, max_lag: int = 20):
        self.max_lag = max_lag

    def ensure_stationary(self, s: pd.Series, name: str = "series") -> tuple:
        """
        Runs ADF unit-root test; if non-stationary (p >= 0.05), applies first-differencing.
        Returns (stationary_series, adf_p_value, is_differenced).
        """
        clean = s.dropna()
        try:
            adf_stat, p_val, _, _, _, _ = adfuller(clean, autolag="AIC")
            if p_val >= 0.05:
                diff_s = clean.diff().dropna()
                print(f"[ADF Test] {name} is non-stationary (p={p_val:.4f}). Applying 1st difference (I(1) -> I(0)).")
                return diff_s, float(p_val), True
            else:
                print(f"[ADF Test] {name} is stationary (p={p_val:.4f}).")
                return clean, float(p_val), False
        except Exception as e:
            print(f"[ADF Warning] {name} ADF test failed: {e}. Defaulting to 1st difference.")
            return clean.diff().dropna(), 1.0, True

    def compute_cross_correlation(self, s1: pd.Series, s2: pd.Series, max_lags: int = 30) -> pd.DataFrame:
        aligned = pd.concat([s1, s2], axis=1).dropna()
        x1 = aligned.iloc[:, 0]
        x2 = aligned.iloc[:, 1]

        lags = list(range(-max_lags, max_lags + 1))
        corrs = []
        for k in lags:
            if k < 0:
                c = x1.iloc[-k:].corr(x2.iloc[:k])
            elif k > 0:
                c = x1.iloc[:-k].corr(x2.iloc[k:])
            else:
                c = x1.corr(x2)
            corrs.append(c)

        df_cc = pd.DataFrame({"lag_days": lags, "correlation": corrs})
        return df_cc

    def run_granger_causality(self, p_ai_series: pd.Series, residual_series: pd.Series) -> dict:
        # 1. Enforce stationarity on both series
        p_ai_stat, p_ai_adf_p, p_ai_diff = self.ensure_stationary(p_ai_series, "P_AI")
        res_stat, res_adf_p, res_diff = self.ensure_stationary(residual_series, "BTC_Residual")

        df = pd.concat([res_stat, p_ai_stat], axis=1).dropna()
        df.columns = ["residual", "p_ai"]

        results = {
            "p_ai_causes_residual": {},
            "residual_causes_p_ai": {},
            "adf_tests": {
                "p_ai": {"adf_p_value": p_ai_adf_p, "differenced": p_ai_diff},
                "residual": {"adf_p_value": res_adf_p, "differenced": res_diff}
            }
        }
        lags = [1, 2, 5, 10]

        # Direction 1: residual ~ p_ai
        try:
            gc1 = grangercausalitytests(df[["residual", "p_ai"]], maxlag=max(lags))
            for l in lags:
                if l in gc1:
                    test_stat = gc1[l][0]["ssr_ftest"]
                    results["p_ai_causes_residual"][f"lag_{l}"] = {
                        "f_stat": round(float(test_stat[0]), 3),
                        "p_value": round(float(test_stat[1]), 4),
                        "significant_5pct": bool(test_stat[1] < 0.05)
                    }
        except Exception as e:
            print(f"[Causality Warning] GC direction 1 failed: {e}")

        # Direction 2: p_ai ~ residual
        try:
            gc2 = grangercausalitytests(df[["p_ai", "residual"]], maxlag=max(lags))
            for l in lags:
                if l in gc2:
                    test_stat = gc2[l][0]["ssr_ftest"]
                    results["residual_causes_p_ai"][f"lag_{l}"] = {
                        "f_stat": round(float(test_stat[0]), 3),
                        "p_value": round(float(test_stat[1]), 4),
                        "significant_5pct": bool(test_stat[1] < 0.05)
                    }
        except Exception as e:
            print(f"[Causality Warning] GC direction 2 failed: {e}")

        # Dynamic findings generation based on real empirical significance
        findings = []
        sig_p_ai = [l for l, v in results["p_ai_causes_residual"].items() if v.get("significant_5pct")]
        sig_res = [l for l, v in results["residual_causes_p_ai"].items() if v.get("significant_5pct")]

        if p_ai_diff:
            findings.append("经 ADF 检验发现 P_AI 具有显著自相关与单位根，已通过一阶差分 ΔP_AI 消除伪回归偏误。")

        if sig_p_ai:
            findings.append(f"在滞后 {', '.join(sig_p_ai)} 窗口，ΔP_AI 对 BTC 宏观残差呈现统计显著的 Granger 引导作用 (p < 0.05)。")
        else:
            findings.append("在 1~10 日窗口内，ΔP_AI 对 BTC 正交残差未展现统计显著的单向 Granger 领先 (p > 0.05)。")

        if sig_res:
            findings.append(f"在滞后 {', '.join(sig_res)} 窗口，BTC 残差对 ΔP_AI 呈现反向统计显著反馈 (p < 0.05)，显示两类市场微观流动性存在动态纠缠。")
        else:
            findings.append("未发现 BTC 残差对 AI 外部融资压力的显著反向因果反馈。")

        results["findings"] = findings
        return results