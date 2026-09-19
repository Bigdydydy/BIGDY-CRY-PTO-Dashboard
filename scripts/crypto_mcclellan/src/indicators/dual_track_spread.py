"""
Dual-Track McClellan Spread & Regime Classifier
Computes:
  1. Liquidity Divergence Spread = Frontier_Meme_Oscillator - Core_Oscillator
  2. Regime State Classification:
     - Regime 1: Dual-Track Co-Expansion (全域共振繁荣)
     - Regime 2: End-Stage Siphon / Speculative Fever (末日轮动·流动性抽血) ⚠️
     - Regime 3: Quality Capital Accumulation (优质资产吸筹·前沿去杠杆)
     - Regime 4: Deep-Freeze / Maximum Oversold (全域冰点出清)
"""

import pandas as pd
import numpy as np
import config

class DualTrackSpreadEngine:
    REGIMES = {
        "CO_EXPANSION": {
            "name": "全域共振繁荣 (Co-Expansion)",
            "desc": "机构基石与链上 Meme 双双位于零轴上方，风险偏好全面扩张，全市场流动性充裕。",
            "color": "#3b82f6", # Blue
            "badge": "tag-q1"
        },
        "MEME_SIPHON": {
            "name": "末日轮动·流动性抽血 (Meme Siphon) ⚠️",
            "desc": "最危险状态！链上 Meme 极度亢奋超买，而主流现货却在失血阴跌，存量博弈见顶信号！",
            "color": "#ef4444", # Red Alert
            "badge": "tag-q2"
        },
        "QUALITY_ACCUMULATION": {
            "name": "优质资产吸筹·前沿去杠杆 (Quality Flow)",
            "desc": "Meme 泡沫快速挤压出清，而主流现货广度率先拐头向上，资金回流至具备造血能力的资产。",
            "color": "#f59e0b", # Orange
            "badge": "tag-q3"
        },
        "DEEP_FREEZE": {
            "name": "全域冰点出清·极度超卖 (Deep Freeze)",
            "desc": "基石与前沿双双跌破 -25 冰点区，情绪极度恐慌，历史上属于非对称高盈亏比建仓窗口。",
            "color": "#10b981", # Green
            "badge": "tag-q4"
        }
    }

    def evaluate_spread(self, core_osc_df: pd.DataFrame, frontier_osc_df: pd.DataFrame) -> pd.DataFrame:
        """
        Merge core and frontier oscillator dataframes and evaluate spread & states.
        """
        combined = pd.DataFrame(index=core_osc_df.index)
        combined["core_oscillator"] = core_osc_df["core_oscillator"]
        combined["core_summation"] = core_osc_df["core_summation_index"]
        combined["core_ramo"] = core_osc_df["core_ramo"]

        combined["frontier_oscillator"] = frontier_osc_df["frontier_oscillator"]
        combined["frontier_summation"] = frontier_osc_df["frontier_summation_index"]
        combined["frontier_ramo"] = frontier_osc_df["frontier_ramo"]

        # 1. Divergence Spread = Frontier (Speculation) - Core (Base)
        combined["spread"] = combined["frontier_oscillator"] - combined["core_oscillator"]
        combined["spread_30d_ma"] = combined["spread"].rolling(30, min_periods=5).mean()

        # 2. Regime State Machine
        def classify_row(r):
            c_osc = r["core_oscillator"]
            f_osc = r["frontier_oscillator"]
            sp = r["spread"]

            # Regime 2: Meme Siphon Alert
            if (f_osc >= 20.0 and c_osc <= 0.0) or (sp >= config.SPREAD_DIVERGENCE_ALERT):
                return "MEME_SIPHON"
            # Regime 4: Deep Freeze Oversold
            elif c_osc < -25.0 and f_osc < -25.0:
                return "DEEP_FREEZE"
            # Regime 3: Quality Accumulation
            elif c_osc > 0.0 and f_osc <= -15.0:
                return "QUALITY_ACCUMULATION"
            # Regime 1: Co-Expansion
            elif c_osc >= 0.0 and f_osc >= 0.0:
                return "CO_EXPANSION"
            else:
                # Moderate states default to directional leaning
                return "CO_EXPANSION" if sp > 0 else "QUALITY_ACCUMULATION"

        combined["regime_code"] = combined.apply(classify_row, axis=1)
        combined["regime_name"] = combined["regime_code"].map(lambda x: self.REGIMES[x]["name"])
        combined["regime_desc"] = combined["regime_code"].map(lambda x: self.REGIMES[x]["desc"])

        print(f"[SpreadEngine] Processed {len(combined)} daily records. Latest Spread: {combined['spread'].iloc[-1]:.2f}")
        return combined