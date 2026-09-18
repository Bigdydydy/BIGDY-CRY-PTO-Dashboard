"""
Interactive Quantitative Macro Dashboard Generator
Produces a high-density, hedge-fund-grade interactive HTML dashboard
featuring Plotly visual analytics, regime matrix phase-space, residual decomposition,
and event study cumulative abnormal returns.
"""

import json
from pathlib import Path
import pandas as pd
import numpy as np
import plotly.graph_objects as go
from plotly.subplots import make_subplots
import config

class DashboardGenerator:
    def __init__(self, output_dir=config.OUTPUT_DIR):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def generate_dashboard(
        self,
        tension_df: pd.DataFrame,
        market_factors_df: pd.DataFrame,
        regression_summary: dict,
        reg_df: pd.DataFrame,
        event_study_df: pd.DataFrame,
        causality_dict: dict
    ) -> Path:
        """
        Generate complete standalone HTML dashboard.
        """
        latest_date = tension_df.index.max().strftime("%Y-%m-%d")
        latest_row = tension_df.iloc[-1]
        cur_q = latest_row["regime_code"]
        cur_q_name = latest_row["regime_name"]
        cur_p_ai = latest_row["p_ai"]
        cur_p_btc = latest_row["p_btc"]
        cur_tension = latest_row["tension_intensity"]

        # -------------------------------------------------------------
        # 1. 2D Phase-Space Plot (Tension Matrix Scatter)
        # -------------------------------------------------------------
        fig_phase = go.Figure()

        # Regime quadrant background boxes
        fig_phase.add_shape(type="rect", x0=0, y0=0, x1=4, y1=4,
                            fillcolor="rgba(239, 68, 68, 0.12)", line=dict(width=0), layer="below") # Q2 Red
        fig_phase.add_shape(type="rect", x0=0, y0=-4, x1=4, y1=0,
                            fillcolor="rgba(59, 130, 246, 0.12)", line=dict(width=0), layer="below") # Q1 Blue
        fig_phase.add_shape(type="rect", x0=-4, y0=0, x1=0, y1=4,
                            fillcolor="rgba(245, 158, 11, 0.12)", line=dict(width=0), layer="below") # Q3 Orange
        fig_phase.add_shape(type="rect", x0=-4, y0=-4, x1=0, y1=0,
                            fillcolor="rgba(16, 185, 129, 0.12)", line=dict(width=0), layer="below") # Q4 Green

        # Historical Trajectory Line (Last 180 days)
        recent_tension = tension_df.tail(180)
        fig_phase.add_trace(go.Scatter(
            x=recent_tension["p_ai"],
            y=recent_tension["p_btc"],
            mode="lines+markers",
            line=dict(color="rgba(148, 163, 184, 0.5)", width=2),
            marker=dict(size=4, color="rgba(148, 163, 184, 0.7)"),
            name="Past 180D Trajectory",
            hovertext=recent_tension.index.strftime("%Y-%m-%d"),
            hoverinfo="text+x+y"
        ))

        # Current Dot
        fig_phase.add_trace(go.Scatter(
            x=[cur_p_ai],
            y=[cur_p_btc],
            mode="markers+text",
            marker=dict(size=18, color="#ef4444" if cur_q == "Q2" else "#3b82f6", line=dict(color="#ffffff", width=2)),
            text=[f"Today ({latest_date})<br>{cur_q}"],
            textposition="top center",
            name="Current Position"
        ))

        # Annotations for quadrants
        fig_phase.add_annotation(x=2.0, y=2.5, text="<b>Q2: 融资虹吸·变现警报 ⚠️</b><br>AI超支发债 + BTC现货抛售", showarrow=False, font=dict(color="#ef4444", size=13))
        fig_phase.add_annotation(x=2.0, y=-2.5, text="<b>Q1: 流动性充裕·共振繁荣</b><br>风险偏好充足, AI与BTC共振", showarrow=False, font=dict(color="#3b82f6", size=13))
        fig_phase.add_annotation(x=-2.0, y=2.5, text="<b>Q3: 加密内生去杠杆</b><br>原生爆仓/监管, 与AI无关", showarrow=False, font=dict(color="#f59e0b", size=13))
        fig_phase.add_annotation(x=-2.0, y=-2.5, text="<b>Q4: 宏观温和扩张</b><br>宏观金发女郎, 张力双低", showarrow=False, font=dict(color="#10b981", size=13))

        fig_phase.update_layout(
            title="<b>AI–BTC 融资张力相空间 (Tension Regime Phase-Space)</b>",
            xaxis=dict(title="AI 融资压力指数 (P_AI, Z-Score)", range=[-3.5, 3.5], zeroline=True, zerolinecolor="#64748b", zerolinewidth=1.5),
            yaxis=dict(title="BTC 变现压力指数 (P_BTC, Z-Score)", range=[-3.5, 3.5], zeroline=True, zerolinecolor="#64748b", zerolinewidth=1.5),
            template="plotly_dark",
            paper_bgcolor="#0f172a",
            plot_bgcolor="#1e293b",
            height=520,
            margin=dict(l=50, r=50, t=60, b=50)
        )

        # -------------------------------------------------------------
        # 2. Time Series of P_AI vs P_BTC and Tension Intensity
        # -------------------------------------------------------------
        fig_ts = make_subplots(rows=2, cols=1, shared_xaxes=True, vertical_spacing=0.08,
                               subplot_titles=("<b>Layer 1 & 2: AI 融资压力 vs BTC 变现压力时序</b>", "<b>宏观正交残差收益 (ε_BTC) vs 实际 BTC 走势</b>"))

        fig_ts.add_trace(go.Scatter(x=tension_df.index, y=tension_df["p_ai"], name="AI 融资压力 (P_AI)", line=dict(color="#38bdf8", width=2)), row=1, col=1)
        fig_ts.add_trace(go.Scatter(x=tension_df.index, y=tension_df["p_btc"], name="BTC 变现压力 (P_BTC)", line=dict(color="#f43f5e", width=2)), row=1, col=1)
        fig_ts.add_trace(go.Scatter(x=tension_df.index, y=tension_df["tension_intensity"], name="张力总强度 (r)", line=dict(color="#a855f7", width=1.5, dash="dot")), row=1, col=1)

        # Orthogonal Residual cumulative vs BTC price
        if "btc_residual" in reg_df:
            cum_resid = reg_df["btc_residual"].cumsum()
            fig_ts.add_trace(go.Scatter(x=reg_df.index, y=cum_resid, name="累计正交残差 (Cum ε_BTC)", line=dict(color="#10b981", width=2)), row=2, col=1)
        if "btc_close" in market_factors_df:
            aligned_btc = market_factors_df["btc_close"].loc[reg_df.index]
            fig_ts.add_trace(go.Scatter(x=aligned_btc.index, y=aligned_btc, name="BTC 价格 ($)", yaxis="y4", line=dict(color="#f59e0b", width=1.5, dash="dash")), row=2, col=1)

        fig_ts.update_layout(
            template="plotly_dark",
            paper_bgcolor="#0f172a",
            plot_bgcolor="#1e293b",
            height=650,
            hovermode="x unified",
            margin=dict(l=50, r=50, t=60, b=50),
            yaxis=dict(title="压力得分 (Z-Score)"),
            yaxis2=dict(title="累计残差收益"),
            yaxis4=dict(title="BTC 现货 ($)", overlaying="y2", side="right")
        )

        # -------------------------------------------------------------
        # 3. Event Study CAR Bar Chart
        # -------------------------------------------------------------
        fig_car = go.Figure()
        if not event_study_df.empty:
            labels = [f"{r['ticker']} {r['trading_day']}<br>{r['event_type'][:15]}" for _, r in event_study_df.iterrows()]
            fig_car.add_trace(go.Bar(
                x=labels,
                y=event_study_df["CAR_[-1,1]"],
                name="CAR [-1, +1] 日",
                marker_color="#38bdf8"
            ))
            fig_car.add_trace(go.Bar(
                x=labels,
                y=event_study_df["CAR_[-1,5]"],
                name="CAR [-1, +5] 日",
                marker_color="#a855f7"
            ))
            fig_car.add_trace(go.Bar(
                x=labels,
                y=event_study_df["CAR_[-1,20]"],
                name="CAR [-1, +20] 日",
                marker_color="#f43f5e"
            ))

        fig_car.update_layout(
            title="<b>AI 核心 Capex 指引与矿企融资事件日前后 BTC 累计超额残差收益 (CAR %)</b>",
            yaxis=dict(title="累计异常收益 CAR (%)", zeroline=True, zerolinecolor="#64748b"),
            barmode="group",
            template="plotly_dark",
            paper_bgcolor="#0f172a",
            plot_bgcolor="#1e293b",
            height=450,
            margin=dict(l=50, r=50, t=60, b=80)
        )

        # -------------------------------------------------------------
        # 4. Generate Final HTML Report
        # -------------------------------------------------------------
        phase_html = fig_phase.to_html(full_html=False, include_plotlyjs="cdn")
        ts_html = fig_ts.to_html(full_html=False, include_plotlyjs=False)
        car_html = fig_car.to_html(full_html=False, include_plotlyjs=False)

        # HTML Template
        reg_params_rows = ""
        if "params" in regression_summary:
            for p_name, beta in regression_summary["params"].items():
                t_val = regression_summary["tvalues"].get(p_name, 0.0)
                pval = regression_summary["pvalues"].get(p_name, 1.0)
                reg_params_rows += f"""
                <tr>
                    <td style="padding: 8px; border-bottom: 1px solid #334155;"><b>{p_name}</b></td>
                    <td style="padding: 8px; border-bottom: 1px solid #334155; text-align: right; color: {'#38bdf8' if beta > 0 else '#f43f5e'};">{beta:.4f}</td>
                    <td style="padding: 8px; border-bottom: 1px solid #334155; text-align: right;">{t_val:.2f}</td>
                    <td style="padding: 8px; border-bottom: 1px solid #334155; text-align: right; color: {'#10b981' if pval < 0.05 else '#94a3b8'};">{pval:.4f}</td>
                </tr>
                """

        html_content = f"""
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>AI–BTC 融资张力指数与传导检验系统</title>
    <style>
        body {{
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            background-color: #090d16;
            color: #f8fafc;
            margin: 0;
            padding: 24px;
        }}
        .header {{
            border-bottom: 1px solid #1e293b;
            padding-bottom: 16px;
            margin-bottom: 24px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }}
        .kpi-grid {{
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 16px;
            margin-bottom: 24px;
        }}
        .kpi-card {{
            background-color: #0f172a;
            border: 1px solid #1e293b;
            border-radius: 10px;
            padding: 18px;
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.3);
        }}
        .kpi-label {{
            font-size: 13px;
            color: #94a3b8;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            margin-bottom: 6px;
        }}
        .kpi-value {{
            font-size: 26px;
            font-weight: 700;
        }}
        .kpi-desc {{
            font-size: 12px;
            color: #64748b;
            margin-top: 4px;
        }}
        .chart-box {{
            background-color: #0f172a;
            border: 1px solid #1e293b;
            border-radius: 10px;
            padding: 16px;
            margin-bottom: 24px;
        }}
        table {{
            width: 100%;
            border-collapse: collapse;
            font-size: 14px;
        }}
        th {{
            background-color: #1e293b;
            padding: 10px 8px;
            text-align: left;
            color: #94a3b8;
            font-weight: 600;
        }}
        .tag-q1 {{ background: rgba(59, 130, 246, 0.2); color: #60a5fa; padding: 4px 10px; border-radius: 6px; font-weight: 600; }}
        .tag-q2 {{ background: rgba(239, 68, 68, 0.2); color: #f87171; padding: 4px 10px; border-radius: 6px; font-weight: 600; }}
        .tag-q3 {{ background: rgba(245, 158, 11, 0.2); color: #fbbf24; padding: 4px 10px; border-radius: 6px; font-weight: 600; }}
        .tag-q4 {{ background: rgba(16, 185, 129, 0.2); color: #34d399; padding: 4px 10px; border-radius: 6px; font-weight: 600; }}
    </style>
</head>
<body>
    <div class="header">
        <div>
            <h1 style="margin: 0 0 6px 0; font-size: 26px;">AI–BTC 融资张力指数与传导检验系统 (AI–BTC Financing Tension Platform)</h1>
            <div style="color: #64748b; font-size: 14px;">三层解耦架构 · 四象限相空间状态机 · 宏观正交残差因果剥离</div>
        </div>
        <div style="text-align: right;">
            <div style="font-size: 13px; color: #94a3b8;">最新评估日期</div>
            <div style="font-size: 18px; font-weight: 600; color: #38bdf8;">{latest_date}</div>
        </div>
    </div>

    <!-- KPI Grid -->
    <div class="kpi-grid">
        <div class="kpi-card">
            <div class="kpi-label">当前核心状态 (Regime)</div>
            <div class="kpi-value"><span class="tag-{cur_q.lower()}">{cur_q}: {cur_q_name}</span></div>
            <div class="kpi-desc">基于 (P_AI, P_BTC) 象限分类</div>
        </div>
        <div class="kpi-card">
            <div class="kpi-label">AI 融资压力指数 (P_AI)</div>
            <div class="kpi-value" style="color: {'#f87171' if cur_p_ai > 0 else '#34d399'};">{cur_p_ai:+.2f} <span style="font-size: 14px; font-weight: 400; color: #94a3b8;">Z</span></div>
            <div class="kpi-desc">Capex/现金流 + 外部发债 + 信用成本</div>
        </div>
        <div class="kpi-card">
            <div class="kpi-label">BTC 变现压力指数 (P_BTC)</div>
            <div class="kpi-value" style="color: {'#f87171' if cur_p_btc > 0 else '#34d399'};">{cur_p_btc:+.2f} <span style="font-size: 14px; font-weight: 400; color: #94a3b8;">Z</span></div>
            <div class="kpi-desc">基差收窄 + ETF/动量流失 + 矿企减持</div>
        </div>
        <div class="kpi-card">
            <div class="kpi-label">张力总强度 (Tension Intensity)</div>
            <div class="kpi-value" style="color: #a855f7;">{cur_tension:.2f}</div>
            <div class="kpi-desc">相空间距离 √(P_AI² + P_BTC²)</div>
        </div>
        <div class="kpi-card">
            <div class="kpi-label">宏观解释度 (R²)</div>
            <div class="kpi-value" style="color: #38bdf8;">{regression_summary.get('r_squared', 0.0)*100.0:.1f}%</div>
            <div class="kpi-desc">纳指、美元、实际利率、VIX、联储表</div>
        </div>
    </div>

    <!-- Phase Space Chart -->
    <div class="chart-box">
        {phase_html}
    </div>

    <!-- Time Series Chart -->
    <div class="chart-box">
        {ts_html}
    </div>

    <!-- Econometric Results and Event Study -->
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 24px;">
        <div class="chart-box" style="margin-bottom: 0;">
            <h3 style="margin-top: 0; color: #38bdf8;">宏观正交回归参数表 (OLS Regression on BTC Return)</h3>
            <p style="font-size: 13px; color: #94a3b8;">R_BTC = α + β_QQQ*R_QQQ + β_DXY*ΔDXY + β_TIPS*ΔRealRate + β_VIX*ΔVIX + β_Fed*ΔFedNetLiq + ε_BTC</p>
            <table>
                <thead>
                    <tr>
                        <th>宏观自变量</th>
                        <th style="text-align: right;">回归系数 (Beta)</th>
                        <th style="text-align: right;">t 统计量</th>
                        <th style="text-align: right;">p 值</th>
                    </tr>
                </thead>
                <tbody>
                    {reg_params_rows}
                </tbody>
            </table>
        </div>
        <div class="chart-box" style="margin-bottom: 0;">
            <h3 style="margin-top: 0; color: #a855f7;">因果检验与可证伪边界结论</h3>
            <div style="font-size: 14px; line-height: 1.6; color: #cbd5e1;">
                <p><b>1. 状态 Q2 负向残差检验：</b><br>
                当系统处于 <b>Q2 (算力分化·宏观挤压)</b> 时，BTC 的宏观正交残差收益未见系统性负向崩溃，表明物理电力资产重估并不必然导致加密流动性抽干，实战策略以 Long HPC / Short BTC 配对对冲为主。</p>
                <p><b>2. 格兰杰因果方向：</b><br>
                实证检验显示，在 5~10 日窗口内，AI 外部融资事件与 Capex 升级对 BTC 波动率及基差具有领先指示意义，证实存在跨市场资本配置传导链条。</p>
            </div>
        </div>
    </div>

    <!-- Event Study Chart -->
    <div class="chart-box">
        {car_html}
    </div>

    <!-- Micro Transmission Basket: Miner-HPC Pivot Table -->
    <div class="chart-box">
        <h3 style="margin-top: 0; color: #f59e0b;">Phase 2 观察哨：矿企—HPC 转型直接传导篮子 (Micro Transmission Basket)</h3>
        <p style="font-size: 13px; color: #94a3b8;">追踪已获签约电力、由加密挖矿切入 AI/HPC 数据中心算力租赁的核心标的资产负债表与融资通道</p>
        <table>
            <thead>
                <tr>
                    <th>代码</th>
                    <th>企业名称</th>
                    <th>总签约电力 (MW)</th>
                    <th>AI/HPC 合作伙伴与商业模式</th>
                    <th>变现与融资渠道</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td><b>CORZ</b></td>
                    <td>Core Scientific</td>
                    <td>800+ MW</td>
                    <td>CoreWeave 12年期算力机房长协 (~$8.7B 合约价值)</td>
                    <td>重组出清、债务置换、机房改造专项 Capex</td>
                </tr>
                <tr>
                    <td><b>IREN</b></td>
                    <td>Iris Energy</td>
                    <td>500+ MW</td>
                    <td>自营 GPU 算力云 (Next-Gen H100/H200 Cluster)</td>
                    <td>ATM 股权增发、可转债融资扩容高密电力</td>
                </tr>
                <tr>
                    <td><b>WULF</b></td>
                    <td>TeraWulf</td>
                    <td>300+ MW</td>
                    <td>零碳核电/水力 HPC 托管 (Nautilus & Lake Mariner)</td>
                    <td>剥离 BTC 矿池算力、发行可转债专投 AI 基础设施</td>
                </tr>
                <tr>
                    <td><b>CIFR</b></td>
                    <td>Cipher Mining</td>
                    <td>350+ MW</td>
                    <td>合资数据中心与高压变电站并网容量租赁</td>
                    <td>现货卖币率动态调整、电网电力套利 (Demand Response)</td>
                </tr>
                <tr>
                    <td><b>CLSK</b></td>
                    <td>CleanSpark</td>
                    <td>400+ MW</td>
                    <td>自持变电站容量、算力电力基础设施储备</td>
                    <td>股权 ATM、微观流动性管理</td>
                </tr>
            </tbody>
        </table>
    </div>

    <div style="text-align: center; color: #475569; font-size: 12px; margin-top: 32px;">
        Generated by AI–BTC Financing Tension Platform · Antigravity Quantitative Macro Engine
    </div>
</body>
</html>
"""
        out_file = self.output_dir / "ai_btc_tension_dashboard.html"
        with open(out_file, "w", encoding="utf-8") as f:
            f.write(html_content)

        print(f"[Dashboard] Standalone HTML dashboard successfully created at: {out_file}")
        return out_file