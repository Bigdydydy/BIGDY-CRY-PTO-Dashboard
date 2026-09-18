"""
Exporter Script: AI-BTC Financing Tension Index to JSON
Executes the analytical pipeline and exports structured JSON to the dashboard data folder.
"""
import sys
import json
from pathlib import Path
import pandas as pd
import numpy as np

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
from src.econometric.event_study import EventStudyEngine, HISTORICAL_EVENTS
from src.econometric.causality import CausalityEngine

def main():
    print("[Export] Starting data collection and metric computation...")
    
    # 1. Collectors
    fred_col = FREDCollector()
    fred_df = fred_col.fetch_all()

    market_col = MarketDataCollector()
    market_prices = market_col.fetch_tickers(start_date="2022-01-01")
    market_factors = market_col.compute_returns_and_factors(market_prices)

    sec_col = SECEdgarCollector()
    sec_agg_df = sec_col.collect_ai_universe()

    # 2. Indicators
    ai_engine = AIPressureEngine()
    p_ai_df = ai_engine.compute_p_ai(sec_agg_df, fred_df, market_factors)

    btc_engine = BTCPressureEngine()
    p_btc_df = btc_engine.compute_p_btc(market_factors)

    # 3. Matrix & Regimes
    matrix_engine = TensionMatrixEngine()
    tension_df = matrix_engine.evaluate_regimes(p_ai_df, p_btc_df)

    # 4. Econometrics (Full Sample HAC Regression + Rolling OOS Residuals)
    residual_engine = MacroResidualEngine(rolling_window=120, min_burnin=60)
    reg_dataset = residual_engine.prepare_regression_dataset(market_factors, fred_df)
    model, reg_results, summary_dict = residual_engine.fit_full_sample_ols(reg_dataset)
    
    # Compute strictly Out-Of-Sample (OOS) rolling residuals
    oos_residuals = residual_engine.fit_rolling_ols(reg_dataset)
    reg_results["btc_residual_oos"] = oos_residuals

    # Test Q2 hypothesis using Out-Of-Sample residuals
    q2_hypo = residual_engine.test_regime_residual_hypothesis(tension_df, oos_residuals)

    # 5. Event Study with OOS residuals and standard errors
    event_engine = EventStudyEngine()
    event_df = event_engine.evaluate_events(oos_residuals, reg_results["btc_ret"])

    # 6. Causality with ADF Unit-Root Check & Differencing
    causality_engine = CausalityEngine()
    causality_results = causality_engine.run_granger_causality(tension_df["p_ai"], oos_residuals)

    # Align series for export (using OOS residuals)
    combined = tension_df.copy()
    for col in p_ai_df.columns:
        combined[col] = p_ai_df[col]
    for col in p_btc_df.columns:
        combined[col] = p_btc_df[col]
    if "btc_close" in market_factors:
        combined["btc_close"] = market_factors["btc_close"]
    if "btc_ret" in reg_results:
        combined["btc_ret"] = reg_results["btc_ret"]
    if "btc_residual_oos" in reg_results:
        combined["btc_residual_oos"] = reg_results["btc_residual_oos"]
        combined["btc_residual"] = reg_results["btc_residual_oos"]
        combined["cum_residual"] = reg_results["btc_residual_oos"].cumsum()
    if "btc_residual" in reg_results:
        combined["btc_residual_insample"] = reg_results["btc_residual"]

    # Fill any NaNs
    combined = combined.ffill().fillna(0.0)

    # Latest record
    latest_idx = combined.index.max()
    latest_row = combined.loc[latest_idx]

    # Weights references
    w_ai = config.I_COMPUTE_WEIGHTS
    w_hpc = w_ai.get("miner_hpc_spread", 0.40)
    w_ocf = w_ai.get("capex_to_ocf", 0.25)
    w_growth = w_ai.get("capex_growth_surprise", 0.20)
    w_credit = w_ai.get("credit_cost_spread", 0.15)

    w_btc = config.I_CRYPTO_WEIGHTS
    w_basis_inv = w_btc.get("basis_inversion_risk", 0.35)
    w_basis_mom = w_btc.get("basis_momentum_drain", 0.25)
    w_vol = w_btc.get("cross_vol_shock", 0.20)
    w_miner = w_btc.get("miner_equity_squeeze", 0.20)

    # Series list with full component auditability
    series_list = []
    for dt, row in combined.iterrows():
        z_hpc = float(row.get("z_hpc_spread", 0.0))
        z_ocf = float(row.get("z_capex_ocf", 0.0))
        z_growth = float(row.get("z_capex_growth", 0.0))
        z_credit = float(row.get("z_credit_cost", 0.0))

        z_basis_inv = float(row.get("z_basis_inversion", 0.0))
        z_basis_mom = float(row.get("z_basis_momentum", 0.0))
        z_vol = float(row.get("z_vol_stress", 0.0))
        z_miner = float(row.get("z_miner_stress", 0.0))

        compute_breakdown = {
            "hpc_spread": {
                "raw_ratio": round(float(row.get("raw_hpc_ratio", row.get("hpc_vs_pure_ratio", 1.0))), 4),
                "z_score": round(z_hpc, 4),
                "weight": w_hpc,
                "contribution": round(z_hpc * w_hpc, 4)
            },
            "capex_to_ocf": {
                "raw_ratio": round(float(row.get("raw_capex_to_ocf", 1.0)), 4),
                "z_score": round(z_ocf, 4),
                "weight": w_ocf,
                "contribution": round(z_ocf * w_ocf, 4)
            },
            "capex_growth": {
                "raw_rate": round(float(row.get("raw_capex_growth", 0.0)), 4),
                "z_score": round(z_growth, 4),
                "weight": w_growth,
                "contribution": round(z_growth * w_growth, 4)
            },
            "credit_cost": {
                "raw_spread": round(float(row.get("raw_credit_cost", 0.0)), 4),
                "z_score": round(z_credit, 4),
                "weight": w_credit,
                "contribution": round(z_credit * w_credit, 4)
            },
            "total_score": round(float(row.get("p_ai", 0.0)), 4)
        }

        crypto_breakdown = {
            "basis_inversion": {
                "raw_basis": round(float(row.get("raw_basis", 0.05)), 4),
                "z_score": round(z_basis_inv, 4),
                "weight": w_basis_inv,
                "contribution": round(z_basis_inv * w_basis_inv, 4)
            },
            "basis_momentum": {
                "raw_delta": round(float(row.get("raw_basis_momentum", 0.0)), 4),
                "z_score": round(z_basis_mom, 4),
                "weight": w_basis_mom,
                "contribution": round(z_basis_mom * w_basis_mom, 4)
            },
            "volatility_shock": {
                "raw_vix": round(float(row.get("raw_vix", 20.0)), 2),
                "z_score": round(z_vol, 4),
                "weight": w_vol,
                "contribution": round(z_vol * w_vol, 4)
            },
            "miner_squeeze": {
                "z_score": round(z_miner, 4),
                "weight": w_miner,
                "contribution": round(z_miner * w_miner, 4)
            },
            "total_score": round(float(row.get("p_btc", 0.0)), 4)
        }

        series_list.append({
            "date": dt.strftime("%Y-%m-%d"),
            "timestamp": int(dt.timestamp() * 1000),
            "p_ai": round(float(row.get("p_ai", 0.0)), 4),
            "p_btc": round(float(row.get("p_btc", 0.0)), 4),
            "i_compute": round(float(row.get("p_ai", 0.0)), 4),
            "i_crypto": round(float(row.get("p_btc", 0.0)), 4),
            "tension_intensity": round(float(row.get("tension_intensity", 0.0)), 4),
            "tension_divergence": round(float(row.get("tension_divergence", 0.0)), 4),
            "regime_code": str(row.get("regime_code", "Q4")),
            "btc_close": round(float(row.get("btc_close", 0.0)), 2),
            "btc_ret": round(float(row.get("btc_ret", 0.0)), 6),
            "btc_residual": round(float(row.get("btc_residual", 0.0)), 6),
            "btc_residual_oos": round(float(row.get("btc_residual_oos", row.get("btc_residual", 0.0))), 6),
            "btc_residual_insample": round(float(row.get("btc_residual_insample", 0.0)), 6),
            "cum_residual": round(float(row.get("cum_residual", 0.0)), 4),
            "hpc_spread": round(z_hpc, 4),
            "hpc_vs_pure_ratio": round(float(row.get("hpc_vs_pure_ratio", 1.0)), 4),
            "compute_breakdown": compute_breakdown,
            "crypto_breakdown": crypto_breakdown
        })

    # Trajectory: last 180 days for 2D phase-space
    recent_trajectory = series_list[-180:] if len(series_list) >= 180 else series_list

    # Events list
    events_list = []
    for _, ev in event_df.iterrows():
        events_list.append({
            "event_date": ev["event_date"],
            "trading_day": ev["trading_day"],
            "ticker": ev["ticker"],
            "event_type": ev["event_type"],
            "description": ev["description"],
            "car_1d": round(float(ev["CAR_[-1,1]"]), 2),
            "car_5d": round(float(ev["CAR_[-1,5]"]), 2),
            "car_20d": round(float(ev["CAR_[-1,20]"]), 2),
            "raw_1d": round(float(ev["RawCum_[-1,1]"]), 2),
            "raw_5d": round(float(ev["RawCum_[-1,5]"]), 2),
            "raw_20d": round(float(ev["RawCum_[-1,20]"]), 2),
        })

    # Miner-HPC direct transmission basket (HPC Pivot vs Pure-Play Mining)
    miner_basket = [
        {
            "ticker": "CORZ",
            "name": "Core Scientific",
            "power_mw": "800+ MW",
            "category": "HPC Pivot (AI算力托管)",
            "partner_mode": "CoreWeave 12年期算力长协 (~$8.7B 合约价值)",
            "financing_channel": "重组出清、债务置换、机房改造专项 Capex",
            "status": "主力算力托管提供商，首个破产重组后切入 HPC 龙头"
        },
        {
            "ticker": "IREN",
            "name": "Iris Energy",
            "power_mw": "500+ MW",
            "category": "HPC Pivot (自营GPU云)",
            "partner_mode": "自营 GPU 算力云 (Next-Gen H100/H200 Cluster)",
            "financing_channel": "ATM 股权增发、可转债融资扩容高密电力",
            "status": "纯绿电自营数据中心，全面向 AI 云计算集群倾斜"
        },
        {
            "ticker": "WULF",
            "name": "TeraWulf",
            "power_mw": "300+ MW",
            "category": "HPC Pivot (零碳算力)",
            "partner_mode": "零碳核电/水力 HPC 托管 (Nautilus & Lake Mariner)",
            "financing_channel": "剥离 BTC 矿池算力、发行可转债专投 AI 基础设施",
            "status": "极低边际电价优势，发行超额认购可转债专项投资机房"
        },
        {
            "ticker": "MARA",
            "name": "MARA Holdings",
            "power_mw": "1100+ MW",
            "category": "Pure-Play Mining (纯挖矿基准)",
            "partner_mode": "全网最大自营哈希算力、BTC储备囤币策略 (HODL)",
            "financing_channel": "可转债买币与矿机更新、比特币全额质押借贷",
            "status": "纯比特币贝塔标杆，业绩高度绑定减半出块与币价"
        },
        {
            "ticker": "RIOT",
            "name": "Riot Platforms",
            "power_mw": "1000+ MW",
            "category": "Pure-Play Mining (纯挖矿基准)",
            "partner_mode": "得州 Corsicana 超级变电站矿场，自建超大浸没式机房",
            "financing_channel": "得州日前电网电力套利 (Power Curtailment Credits)",
            "status": "得州电力负荷巨头，矿场规模大但主要集中于BTC挖矿"
        },
        {
            "ticker": "CLSK",
            "name": "CleanSpark",
            "power_mw": "400+ MW",
            "category": "Pure-Play Mining (纯挖矿基准)",
            "partner_mode": "自持变电站容量、高效矿机运营",
            "financing_channel": "股权 ATM、微观流动性管理",
            "status": "自建自持电网负荷，拥有随时切入 HPC 的基础资源"
        }
    ]

    # Regime distribution stats
    regime_counts = combined["regime_code"].value_counts().to_dict()
    total_days = len(combined)

    # Macro plumbing latest stats
    latest_repo_spread = round(float(fred_df.get("repo_spread", pd.Series(0.0)).iloc[-1] if "repo_spread" in fred_df else 0.0), 3)
    latest_term_premium = round(float(fred_df.get("term_premium", pd.Series(0.0)).iloc[-1] if "term_premium" in fred_df else 0.0), 2)

    payload = {
        "metadata": {
            "title": "全球宏观暗渠穿透与算力基建重估终端 (Macro Plumbing & Compute Arbitrage Platform)",
            "core_hypothesis": "穿透财政部发债与隔夜融资暗渠，实证检验算力/电力重估溢价与加密杠杆脆弱性。",
            "methodology": "资产负债表穿透 · 算力基建重估溢价 · 宏观暗渠正交回归",
            "date_range": f"{combined.index.min().strftime('%Y-%m-%d')} 至 {latest_idx.strftime('%Y-%m-%d')}",
            "total_days": total_days,
            "data_sources": "SEC EDGAR 官方财报 + FRED (SOFR/IORB/期限溢价/逆回购/实际利率) + CME/Yahoo (BTC基差与矿企行情)",
            "last_updated": latest_idx.strftime("%Y-%m-%d")
        },
        "current": {
            "date": latest_idx.strftime("%Y-%m-%d"),
            "regime_code": str(latest_row["regime_code"]),
            "regime_name": TensionMatrixEngine.REGIME_LABELS.get(latest_row["regime_code"], "未知"),
            "regime_description": TensionMatrixEngine.REGIME_DESCRIPTIONS.get(latest_row["regime_code"], ""),
            "p_ai": round(float(latest_row["p_ai"]), 2),
            "p_btc": round(float(latest_row["p_btc"]), 2),
            "i_compute": round(float(latest_row["p_ai"]), 2),
            "i_crypto": round(float(latest_row["p_btc"]), 2),
            "hpc_spread": round(float(latest_row.get("z_hpc_spread", 0.0)), 2),
            "hpc_vs_pure_ratio": round(float(latest_row.get("hpc_vs_pure_ratio", 1.0)), 2),
            "repo_spread": latest_repo_spread,
            "term_premium": latest_term_premium,
            "tension_intensity": round(float(latest_row["tension_intensity"]), 2),
            "tension_divergence": round(float(latest_row["tension_divergence"]), 2),
            "btc_price": round(float(latest_row["btc_close"]), 2),
            "macro_r2": round(float(summary_dict.get("r_squared", 0.0)), 4),
            "macro_adj_r2": round(float(summary_dict.get("adj_r_squared", 0.0)), 4)
        },
        "regime_stats": {
            "Q1": {
                "name": TensionMatrixEngine.REGIME_LABELS["Q1"],
                "count": int(regime_counts.get("Q1", 0)),
                "pct": round(float(regime_counts.get("Q1", 0) / total_days * 100.0), 1),
                "condition": "I_Compute >= 0, I_Crypto < 0"
            },
            "Q2": {
                "name": TensionMatrixEngine.REGIME_LABELS["Q2"],
                "count": int(regime_counts.get("Q2", 0)),
                "pct": round(float(regime_counts.get("Q2", 0) / total_days * 100.0), 1),
                "condition": "I_Compute >= 0, I_Crypto >= 0 (⚡ 配对套利窗口)"
            },
            "Q3": {
                "name": TensionMatrixEngine.REGIME_LABELS["Q3"],
                "count": int(regime_counts.get("Q3", 0)),
                "pct": round(float(regime_counts.get("Q3", 0) / total_days * 100.0), 1),
                "condition": "I_Compute < 0, I_Crypto >= 0"
            },
            "Q4": {
                "name": TensionMatrixEngine.REGIME_LABELS["Q4"],
                "count": int(regime_counts.get("Q4", 0)),
                "pct": round(float(regime_counts.get("Q4", 0) / total_days * 100.0), 1),
                "condition": "I_Compute < 0, I_Crypto < 0"
            }
        },
        "regression": {
            "formula": "R_BTC = α + β_QQQ·R_QQQ + β_DXY·ΔDXY + β_TIPS·ΔRealRate + β_VIX·ΔVIX + β_Fed·ΔFedNetLiq + β_TP·ΔTermPrem + β_Repo·RepoSpread + ε_BTC",
            "r_squared": round(float(summary_dict.get("r_squared", 0.0)), 4),
            "adj_r_squared": round(float(summary_dict.get("adj_r_squared", 0.0)), 4),
            "f_pvalue": float(summary_dict.get("f_pvalue", 0.0)),
            "parameters": [
                {
                    "name": "常数项 (Alpha)",
                    "var": "const",
                    "beta": round(float(summary_dict["params"].get("const", 0.0)), 4),
                    "t_stat": round(float(summary_dict["tvalues"].get("const", 0.0)), 2),
                    "p_value": round(float(summary_dict["pvalues"].get("const", 1.0)), 4),
                    "role": "基准无风险漂移项"
                },
                {
                    "name": "纳斯达克100收益率 (QQQ)",
                    "var": "qqq_ret",
                    "beta": round(float(summary_dict["params"].get("qqq_ret", 0.0)), 4),
                    "t_stat": round(float(summary_dict["tvalues"].get("qqq_ret", 0.0)), 2),
                    "p_value": round(float(summary_dict["pvalues"].get("qqq_ret", 1.0)), 4),
                    "role": "科技股与广义风险偏好 Beta"
                },
                {
                    "name": "美元指数变化率 (DXY)",
                    "var": "dxy_ret",
                    "beta": round(float(summary_dict["params"].get("dxy_ret", 0.0)), 4),
                    "t_stat": round(float(summary_dict["tvalues"].get("dxy_ret", 0.0)), 2),
                    "p_value": round(float(summary_dict["pvalues"].get("dxy_ret", 1.0)), 4),
                    "role": "法币信用与跨国流动性压制"
                },
                {
                    "name": "10年期 TIPS 实际利率变动 (ΔTIPS)",
                    "var": "delta_real_yield",
                    "beta": round(float(summary_dict["params"].get("delta_real_yield", 0.0)), 4),
                    "t_stat": round(float(summary_dict["tvalues"].get("delta_real_yield", 0.0)), 2),
                    "p_value": round(float(summary_dict["pvalues"].get("delta_real_yield", 1.0)), 4),
                    "role": "无风险资金真实折现成本"
                },
                {
                    "name": "VIX 恐慌指数变化 (ΔVIX)",
                    "var": "vix_delta",
                    "beta": round(float(summary_dict["params"].get("vix_delta", 0.0)), 4),
                    "t_stat": round(float(summary_dict["tvalues"].get("vix_delta", 0.0)), 2),
                    "p_value": round(float(summary_dict["pvalues"].get("vix_delta", 1.0)), 4),
                    "role": "跨资产波动率冲击与避险需求"
                },
                {
                    "name": "联储净流动性变化率 (ΔFedNetLiq)",
                    "var": "delta_fed_net_liq",
                    "beta": round(float(summary_dict["params"].get("delta_fed_net_liq", 0.0)), 4),
                    "t_stat": round(float(summary_dict["tvalues"].get("delta_fed_net_liq", 0.0)), 2),
                    "p_value": round(float(summary_dict["pvalues"].get("delta_fed_net_liq", 1.0)), 4),
                    "role": "央行总表减准备金管道变化"
                },
                {
                    "name": "美债10年期期限溢价变动 (ΔTermPrem)",
                    "var": "delta_term_premium",
                    "beta": round(float(summary_dict["params"].get("delta_term_premium", 0.0)), 4),
                    "t_stat": round(float(summary_dict["tvalues"].get("delta_term_premium", 0.0)), 2),
                    "p_value": round(float(summary_dict["pvalues"].get("delta_term_premium", 1.0)), 4),
                    "role": "财政部国债长短端供给与期限风险补偿"
                },
                {
                    "name": "隔夜回购资金借贷利差 (SOFR - IORB)",
                    "var": "repo_spread",
                    "beta": round(float(summary_dict["params"].get("repo_spread", 0.0)), 4),
                    "t_stat": round(float(summary_dict["tvalues"].get("repo_spread", 0.0)), 2),
                    "p_value": round(float(summary_dict["pvalues"].get("repo_spread", 1.0)), 4),
                    "role": "一级交易商资产负债表与货币市场暗渠流动性摩擦"
                }
            ],
            "hac_metadata": {
                "cov_type": "HAC",
                "kernel": "Bartlett (Newey-West)",
                "maxlags": 5,
                "description": "Newey-West 异方差与自相关稳健标准误 (5 阶滞后 Bartlett 核函数)"
            },
            "oos_metadata": {
                "method": "Strict Out-of-Sample Rolling OLS (向前一步预测残差)",
                "rolling_window": 120,
                "min_burnin": 60,
                "description": "严格无前瞻偏误 (Look-ahead bias free) 样本外滚动回归残差，窗口 120 交易日，初始预热 60 交易日"
            },
            "q2_hypothesis_test": {
                "q2_avg_residual_daily_pct": round(float(q2_hypo.get("q2_avg_residual_daily_pct", 0.0)), 3),
                "non_q2_avg_residual_daily_pct": round(float(q2_hypo.get("non_q2_avg_residual_daily_pct", 0.0)), 3),
                "t_stat": round(float(q2_hypo.get("t_stat", 0.0)), 2),
                "p_value": round(float(q2_hypo.get("p_value", 1.0)), 4),
                "cohen_d": round(float(q2_hypo.get("cohen_d", 0.0)), 3),
                "is_significant_5pct": bool(q2_hypo.get("is_significant_5pct", False)),
                "conclusion": (
                    f"单侧假设检验显著支持算力分化与宏观挤压假说（单侧 p={q2_hypo.get('p_value', 1.0):.4f} < 0.05, Welch t={q2_hypo.get('t_stat', 0.0):.2f}, Cohen's d={q2_hypo.get('cohen_d', 0.0):.2f}）："
                    f"在 Q2 状态下，BTC 日均样本外宏观正交残差为 {q2_hypo.get('q2_avg_residual_daily_pct', 0.0):.3f}%，显著低于非 Q2 状态（{q2_hypo.get('non_q2_avg_residual_daily_pct', 0.0):.3f}%），"
                    f"表明在严格控制纳指科技Beta、美元汇率及流动性后，AI 超额融资环境对加密资产流动性产生了统计显著的挤压效应。"
                    if q2_hypo.get("is_significant_5pct")
                    else
                    f"单侧假设检验未显著支持系统性流动性失血假说（单侧 p={q2_hypo.get('p_value', 1.0):.4f} >= 0.05, Welch t={q2_hypo.get('t_stat', 0.0):.2f}）："
                    f"在 Q2 状态下，BTC 日均样本外宏观正交残差为 {q2_hypo.get('q2_avg_residual_daily_pct', 0.0):.3f}%，与非 Q2 状态（{q2_hypo.get('non_q2_avg_residual_daily_pct', 0.0):.3f}%）相比差异未达到 5% 显著性阈值。"
                    f"这表明虽然 AI 资本开支引发局部算力分化与估值重构，但市场未出现外生性的系统失血崩盘，更多表现为 Long HPC / Short BTC 的微观结构配对分流。"
                )
            }
        },
        "event_study": events_list,
        "event_study_metadata": {
            "benchmark": "Macro Orthogonal Out-Of-Sample Residual (CAR)",
            "windows": ["[-1, +1]", "[-1, +5]", "[-1, +20]"],
            "description": "基于宏观正交样本外残差累计超额收益率 (CAR) 与基准收益对比检验"
        },
        "causality": {
            "p_ai_causes_residual": causality_results.get("p_ai_causes_residual", {}),
            "residual_causes_p_ai": causality_results.get("residual_causes_p_ai", {}),
            "adf_tests": causality_results.get("adf_tests", {}),
            "findings": causality_results.get("findings", [
                "经 ADF 检验差分平稳化后，检验 ΔP_AI 与 BTC 正交残差的跨期因果结构。"
            ])
        },
        "miner_hpc_basket": miner_basket,
        "trajectory_180d": recent_trajectory,
        "series": series_list
    }

    # Target save paths (dynamic relative to repo root)
    target_dashboard_data = ROOT_DIR.parent.parent / "data" / "ai_btc_tension.json"
    target_dashboard_data.parent.mkdir(parents=True, exist_ok=True)
    with open(target_dashboard_data, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    print(f"[Export] Successfully generated full JSON data: {target_dashboard_data}")
    print(f"         Total records: {len(series_list)}, Trajectory: {len(recent_trajectory)}, Events: {len(events_list)}")

if __name__ == "__main__":
    main()
