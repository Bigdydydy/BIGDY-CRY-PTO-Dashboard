"""
Interactive HTML Dashboard Generator for Crypto Dual-Track McClellan Oscillator
Produces a standalone, dark-themed institutional dashboard featuring:
  1. Real-time KPI and Liquidity Regime Status
  2. Dual-Track Oscillator Curves (Core vs Frontier Meme) with Overbought/Oversold Bands
  3. Liquidity Divergence Spread (Frontier - Core) with Danger Zone Highlighting
  4. McClellan Summation Index (MSI) vs Bitcoin Spot Price
  5. Constituent Deep-Dive: Core Top 100 vs On-chain Qualified Meme Pools
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
        spread_df: pd.DataFrame,
        core_stats: dict,
        frontier_stats: dict,
        btc_price_series: pd.Series = None
    ) -> Path:
        latest_date = spread_df.index.max().strftime("%Y-%m-%d")
        latest_row = spread_df.iloc[-1]

        cur_regime = latest_row["regime_code"]
        cur_regime_name = latest_row["regime_name"]
        cur_regime_desc = latest_row["regime_desc"]

        cur_core_osc = latest_row["core_oscillator"]
        cur_frontier_osc = latest_row["frontier_oscillator"]
        cur_spread = latest_row["spread"]
        cur_core_msi = latest_row["core_summation"]
        cur_frontier_msi = latest_row["frontier_summation"]

        # -------------------------------------------------------------
        # 1. Chart 1: Dual-Track McClellan Oscillator
        # -------------------------------------------------------------
        recent_df = spread_df.tail(240) # Past 240 days

        fig_osc = go.Figure()
        # Overbought / Oversold Bands
        fig_osc.add_hline(y=50, line_dash="dash", line_color="rgba(239, 68, 68, 0.6)", annotation_text="极端超买 (+50)")
        fig_osc.add_hline(y=-50, line_dash="dash", line_color="rgba(16, 185, 129, 0.6)", annotation_text="极端超卖 (-50)")
        fig_osc.add_hline(y=0, line_color="rgba(148, 163, 184, 0.4)", line_width=1)

        # Core Oscillator
        fig_osc.add_trace(go.Scatter(
            x=recent_df.index,
            y=recent_df["core_oscillator"],
            name="基石轨 (Core Top 100)",
            line=dict(color="#38bdf8", width=2.5),
            hovertemplate="%{x}<br>Core: %{y:.2f}"
        ))

        # Frontier Meme Oscillator
        fig_osc.add_trace(go.Scatter(
            x=recent_df.index,
            y=recent_df["frontier_oscillator"],
            name="前沿轨 (Frontier Meme)",
            line=dict(color="#c084fc", width=2, dash="solid"),
            hovertemplate="%{x}<br>Frontier Meme: %{y:.2f}"
        ))

        fig_osc.update_layout(
            title="<b>加密双轨麦克莱伦振荡器 (Crypto Dual-Track McClellan Oscillator)</b>",
            yaxis=dict(title="振荡指数 (Oscillator, EMA19 - EMA39)", zeroline=False),
            template="plotly_dark",
            paper_bgcolor="#0f172a",
            plot_bgcolor="#1e293b",
            height=480,
            hovermode="x unified",
            margin=dict(l=50, r=50, t=60, b=50)
        )

        # -------------------------------------------------------------
        # 2. Chart 2: Liquidity Divergence Spread & MSI vs BTC
        # -------------------------------------------------------------
        fig_lower = make_subplots(
            rows=2, cols=1, shared_xaxes=True, vertical_spacing=0.10,
            subplot_titles=("<b>流动性剪刀差 (Frontier Meme - Core Spread)</b>", "<b>麦克莱伦累加指数 (MSI) vs 比特币走势</b>")
        )

        # Spread Area
        spread_colors = ["#ef4444" if s >= 35 else "#10b981" if s <= -20 else "#64748b" for s in recent_df["spread"]]
        fig_lower.add_trace(go.Bar(
            x=recent_df.index,
            y=recent_df["spread"],
            name="剪刀差 (Spread)",
            marker_color=spread_colors,
            opacity=0.85
        ), row=1, col=1)

        fig_lower.add_trace(go.Scatter(
            x=recent_df.index,
            y=recent_df["spread_30d_ma"],
            name="剪刀差 30D 均线",
            line=dict(color="#f59e0b", width=1.5)
        ), row=1, col=1)

        # Danger thresholds
        fig_lower.add_hline(y=40, line_dash="dot", line_color="#ef4444", row=1, col=1, annotation_text="末日轮动警戒线 (+40)")

        # MSI and BTC
        fig_lower.add_trace(go.Scatter(
            x=recent_df.index,
            y=recent_df["core_summation"],
            name="基石累加指数 (Core MSI)",
            line=dict(color="#38bdf8", width=2)
        ), row=2, col=1)

        fig_lower.add_trace(go.Scatter(
            x=recent_df.index,
            y=recent_df["frontier_summation"],
            name="前沿累加指数 (Meme MSI)",
            line=dict(color="#c084fc", width=1.5, dash="dot")
        ), row=2, col=1)

        if btc_price_series is not None:
            aligned_btc = btc_price_series.loc[recent_df.index]
            fig_lower.add_trace(go.Scatter(
                x=aligned_btc.index,
                y=aligned_btc,
                name="BTC 价格 ($)",
                yaxis="y4",
                line=dict(color="#f59e0b", width=1.5, dash="dash")
            ), row=2, col=1)

        fig_lower.update_layout(
            template="plotly_dark",
            paper_bgcolor="#0f172a",
            plot_bgcolor="#1e293b",
            height=650,
            hovermode="x unified",
            margin=dict(l=50, r=50, t=60, b=50),
            yaxis=dict(title="剪刀差点数"),
            yaxis2=dict(title="MSI 累加值"),
            yaxis4=dict(title="BTC 现货 ($)", overlaying="y2", side="right")
        )

        osc_html = fig_osc.to_html(full_html=False, include_plotlyjs="cdn")
        lower_html = fig_lower.to_html(full_html=False, include_plotlyjs=False)

        # Build Gainers/Losers Rows
        core_gainers_html = "".join([f"<li><b>{g['symbol']}</b>: <span style='color: #10b981;'>+{g['price_change_24h']:.2f}%</span></li>" for g in core_stats.get("top_gainers", [])])
        core_losers_html = "".join([f"<li><b>{l['symbol']}</b>: <span style='color: #ef4444;'>{l['price_change_24h']:.2f}%</span></li>" for l in core_stats.get("top_losers", [])])

        frontier_gainers_html = "".join([f"<li><b>{g['symbol']}</b> ({g['chain']}): <span style='color: #10b981;'>+{g['price_change_24h']:.2f}%</span></li>" for g in frontier_stats.get("top_gainers", [])])
        frontier_losers_html = "".join([f"<li><b>{l['symbol']}</b> ({l['chain']}): <span style='color: #ef4444;'>{l['price_change_24h']:.2f}%</span></li>" for l in frontier_stats.get("top_losers", [])])

        badge_class = "tag-q1" if cur_regime == "CO_EXPANSION" else "tag-q2" if cur_regime == "MEME_SIPHON" else "tag-q3" if cur_regime == "QUALITY_ACCUMULATION" else "tag-q4"

        html_content = f"""
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>加密双轨麦克莱伦振荡器系统 (Crypto Dual-Track McClellan Platform)</title>
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
        .tag-q1 {{ background: rgba(59, 130, 246, 0.25); color: #60a5fa; padding: 4px 10px; border-radius: 6px; font-weight: 600; }}
        .tag-q2 {{ background: rgba(239, 68, 68, 0.25); color: #f87171; padding: 4px 10px; border-radius: 6px; font-weight: 600; animation: pulse 2s infinite; }}
        .tag-q3 {{ background: rgba(245, 158, 11, 0.25); color: #fbbf24; padding: 4px 10px; border-radius: 6px; font-weight: 600; }}
        .tag-q4 {{ background: rgba(16, 185, 129, 0.25); color: #34d399; padding: 4px 10px; border-radius: 6px; font-weight: 600; }}
        @keyframes pulse {{
            0%, 100% {{ opacity: 1; }}
            50% {{ opacity: 0.6; }}
        }}
        ul {{ list-style-type: none; padding-left: 0; margin: 6px 0; font-size: 13px; }}
        li {{ padding: 3px 0; }}
    </style>
</head>
<body>
    <div class="header">
        <div>
            <h1 style="margin: 0 0 6px 0; font-size: 26px;">加密双轨麦克莱伦振荡器系统 (Crypto Dual-Track McClellan Platform)</h1>
            <div style="color: #64748b; font-size: 14px;">机构基石轨 (CMC Top 100) vs 链上投机前沿轨 (Solana/Base/BSC Meme) · 比例调整算法 (RAMO)</div>
        </div>
        <div style="text-align: right;">
            <div style="font-size: 13px; color: #94a3b8;">评估基准时间</div>
            <div style="font-size: 18px; font-weight: 600; color: #38bdf8;">{latest_date} (UTC)</div>
        </div>
    </div>

    <!-- KPI Grid -->
    <div class="kpi-grid">
        <div class="kpi-card">
            <div class="kpi-label">当前流动性机制状态</div>
            <div class="kpi-value"><span class="{badge_class}">{cur_regime_name}</span></div>
            <div class="kpi-desc">{cur_regime_desc}</div>
        </div>
        <div class="kpi-card">
            <div class="kpi-label">基石轨麦克莱伦 (Core)</div>
            <div class="kpi-value" style="color: {'#10b981' if cur_core_osc > 0 else '#ef4444'};">{cur_core_osc:+.2f}</div>
            <div class="kpi-desc">Adv: {core_stats.get('advances')} | Dec: {core_stats.get('declines')} (RAMO: {core_stats.get('ramo'):+.1f})</div>
        </div>
        <div class="kpi-card">
            <div class="kpi-label">前沿 Meme 轨 (Frontier)</div>
            <div class="kpi-value" style="color: {'#c084fc' if cur_frontier_osc > 0 else '#94a3b8'};">{cur_frontier_osc:+.2f}</div>
            <div class="kpi-desc">Adv: {frontier_stats.get('advances')} | Dec: {frontier_stats.get('declines')} (RAMO: {frontier_stats.get('ramo'):+.1f})</div>
        </div>
        <div class="kpi-card">
            <div class="kpi-label">流动性剪刀差 (Spread)</div>
            <div class="kpi-value" style="color: {'#ef4444' if cur_spread >= 35 else '#f59e0b' if cur_spread > 0 else '#10b981'};">{cur_spread:+.2f}</div>
            <div class="kpi-desc">Frontier - Core 差值 (警戒阈值: ≥+40)</div>
        </div>
        <div class="kpi-card">
            <div class="kpi-label">基石累加指数 (Core MSI)</div>
            <div class="kpi-value" style="color: #38bdf8;">{cur_core_msi:.1f}</div>
            <div class="kpi-desc">跨周期山寨广度中枢累加</div>
        </div>
    </div>

    <!-- Main Chart 1 -->
    <div class="chart-box">
        {osc_html}
    </div>

    <!-- Main Chart 2 -->
    <div class="chart-box">
        {lower_html}
    </div>

    <!-- Constituent Deep Dive -->
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 24px;">
        <div class="chart-box" style="margin-bottom: 0;">
            <h3 style="margin-top: 0; color: #38bdf8;">基石轨 (Top 100 现货) 极值样本穿透</h3>
            <p style="font-size: 12px; color: #94a3b8;">已严格过滤所有稳定币、流动性质押 LST 与封装资产</p>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                <div>
                    <div style="color: #10b981; font-weight: 600; font-size: 13px;">领涨标的 (Top Advances)</div>
                    <ul>{core_gainers_html}</ul>
                </div>
                <div>
                    <div style="color: #ef4444; font-weight: 600; font-size: 13px;">领跌标的 (Top Declines)</div>
                    <ul>{core_losers_html}</ul>
                </div>
            </div>
        </div>
        <div class="chart-box" style="margin-bottom: 0;">
            <h3 style="margin-top: 0; color: #c084fc;">链上 Meme 前沿轨 (合格跨链池) 样本穿透</h3>
            <p style="font-size: 12px; color: #94a3b8;">门槛：LP ≥ $300K, 24h Vol ≥ $1.5M, FDV ≥ $10M, 7天留存去幸存者偏差</p>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                <div>
                    <div style="color: #10b981; font-weight: 600; font-size: 13px;">领涨标的 (Top Advances)</div>
                    <ul>{frontier_gainers_html}</ul>
                </div>
                <div>
                    <div style="color: #ef4444; font-weight: 600; font-size: 13px;">领跌标的 (Top Declines)</div>
                    <ul>{frontier_losers_html}</ul>
                </div>
            </div>
        </div>
    </div>

    <div style="text-align: center; color: #475569; font-size: 12px; margin-top: 24px;">
        Generated by Crypto Dual-Track McClellan Engine · Ratio-Adjusted Market Breadth Architecture
    </div>
</body>
</html>
"""
        out_file = self.output_dir / "crypto_mcclellan_dashboard.html"
        with open(out_file, "w", encoding="utf-8") as f:
            f.write(html_content)

        print(f"[Dashboard] Standalone HTML dashboard successfully created at: {out_file}")
        return out_file