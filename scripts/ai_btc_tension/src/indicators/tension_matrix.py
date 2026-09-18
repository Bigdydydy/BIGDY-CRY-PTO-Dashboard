"""
Core State Machine: AI-BTC Financing Tension Matrix (四象限状态机)
Classifies current market state into 4 regimes based on (P_AI, P_BTC):
  Q1: Speculative Co-Boom / Liquidity Abundance (流动性充裕·共振繁荣) [P_AI >= 0, P_BTC < 0]
  Q2: Divergent Arbitrage / Squeeze (算力分化·宏观挤压)           [P_AI >= 0, P_BTC >= 0]
  Q3: Crypto Idiosyncratic Deleveraging (加密内生去杠杆)         [P_AI < 0, P_BTC >= 0]
  Q4: Macro Goldilocks / Risk-On (宏观温和扩张)                 [P_AI < 0, P_BTC < 0]
"""

import pandas as pd
import numpy as np

class TensionMatrixEngine:
    REGIME_LABELS = {
        "Q1": "基建重估·杠杆健康 (Infrastructure Boom)",
        "Q2": "算力分化·宏观挤压 (Divergent Arbitrage)",
        "Q3": "内生去杠杆·避险收缩 (Crypto Deleveraging)",
        "Q4": "无风带静止期 (Macro Goldilocks)",
    }

    REGIME_DESCRIPTIONS = {
        "Q1": "物理算力重估提升，加密衍生品杠杆适度，呈现跨资产共振扩张。",
        "Q2": "实战配对交易窗口：物理电力资产强劲重估，而加密衍生杠杆承压。建议策略：Long HPC矿企 (CORZ/IREN) + Short BTC 衍生品对冲。",
        "Q3": "加密原生杠杆出清或监管冲击，基建算力溢价回落，呈现内生防御态势。",
        "Q4": "宏观暗渠利差平稳，算力与加密波动收敛，等待新一轮财政部再融资计划（QRA）指引。",
    }

    def evaluate_regimes(self, p_ai_df: pd.DataFrame, p_btc_df: pd.DataFrame) -> pd.DataFrame:
        """
        Combine P_AI and P_BTC to classify daily regimes and calculate tension dynamics.
        """
        combined = pd.DataFrame(index=p_ai_df.index)
        combined["p_ai"] = p_ai_df["p_ai"]
        combined["p_btc"] = p_btc_df["p_btc"]

        # 4-Quadrant Classification
        def classify_row(r):
            ai_val = r["p_ai"]
            btc_val = r["p_btc"]
            if ai_val >= 0 and btc_val < 0:
                return "Q1"
            elif ai_val >= 0 and btc_val >= 0:
                return "Q2"
            elif ai_val < 0 and btc_val >= 0:
                return "Q3"
            else:
                return "Q4"

        combined["regime_code"] = combined.apply(classify_row, axis=1)
        combined["regime_name"] = combined["regime_code"].map(self.REGIME_LABELS)

        # Tension Magnitude (Euclidean distance from equilibrium origin (0,0))
        combined["tension_intensity"] = np.sqrt(combined["p_ai"]**2 + combined["p_btc"]**2)

        # Divergence / Asymmetry
        combined["tension_divergence"] = combined["p_ai"] - combined["p_btc"]

        # Regime shift flags (entering Q2)
        combined["entered_q2"] = (combined["regime_code"] == "Q2") & (combined["regime_code"].shift(1) != "Q2")

        print(f"[TensionMatrix] Evaluated {len(combined)} daily regime states.")
        return combined