"""Render a compact Markdown report from research.py analyze output."""
import csv
import json
import sys
from pathlib import Path


def fmt(value, digits=2):
    return "—" if value in (None, "") else f"{float(value):,.{digits}f}"


def main():
    folder = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("output")
    summary = json.loads((folder / "summary.json").read_text(encoding="utf-8"))
    with (folder / "events.csv").open(encoding="utf-8-sig", newline="") as handle:
        events = list(csv.DictReader(handle))
    lines = [
        "# Coinbase 现货秒级插针历史研究", "",
        f"区间：{summary['start_bj']} 至 {summary['end_bj']}（UTC+8，终点不含）。",
        f"完整覆盖：{summary['coverage']}；有成交秒：{summary['active_seconds']:,}；无成交秒：{summary['empty_seconds']:,}。", "",
        "## 阳线与阴线样本覆盖", "",
        "| K 线颜色 | 全部有成交秒 | 成交量 ≥ 阈值 |",
        "|---|---:|---:|",
    ]
    all_mix, volume_mix = summary.get("bars_by_candle", {}), summary.get("volume_candidates_by_candle", {})
    for color in ("阳", "阴", "平"):
        if color in all_mix or color in volume_mix:
            lines.append(f"| {color} | {all_mix.get(color, 0):,} | {volume_mix.get(color, 0):,} |")
    lines += ["", "## 双维度事件分组", "",
              "筛选同时要求整秒成交量、影线绝对长度与影线 bps；影线占振幅比例默认不设下限。", "",
              "| 影线方向 × K线颜色 | 事件数 | 成交量中位数 BTC | 影线中位数 USD | 5秒中位变化 bps | 30秒 | 60秒 | 300秒 | 900秒 |",
              "|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for key, stats in summary.get("event_group_stats", {}).items():
        horizon = [f"{fmt(stats.get(f'return_{seconds}s_median_bps'))} ({stats.get(f'return_{seconds}s_n', 0)})"
                   for seconds in (5, 30, 60, 300, 900)]
        label = key.replace("lower", "下影线").replace("upper", "上影线")
        lines.append(f"| {label} | {stats['count']} | {fmt(stats['median_volume_btc'], 4)} | "
                     f"{fmt(stats['median_wick_usd'])} | " + " | ".join(horizon) + " |")
    if not summary.get("event_group_stats"):
        lines.append("| 无事件 | 0 | — | — | — | — | — | — | — |")
    lines += ["", "## 成交量最大的事件", "",
              "| 北京时间 | K线颜色 | 影线方向 | 成交量 BTC | 影线 USD | 影线 bps |",
              "|---|---|---|---:|---:|---:|"]
    ranked = sorted(events, key=lambda row: float(row["volume_btc"]), reverse=True)[:20]
    for row in ranked:
        side = row["direction"]
        label = "下影线" if side == "lower" else "上影线"
        lines.append(f"| {row['time_bj']} | {row['candle_color']} | {label} | {fmt(row['volume_btc'], 6)} | "
                     f"{fmt(row[side + '_usd'])} | {fmt(row[side + '_bps'])} |")
    if not ranked:
        lines.append("| 无事件 | — | — | — | — | — |")
    lines += ["", "事后变化为描述性研究标记，不是可执行交易损益；没有假设可在针尖成交。", ""]
    (folder / "report.md").write_text("\n".join(lines), encoding="utf-8")
    print(folder / "report.md")


if __name__ == "__main__":
    main()
