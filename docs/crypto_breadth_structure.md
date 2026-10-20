# Core 结构宽度（Module 1-B `structure` 块）

`scripts/crypto_mcclellan/src/structure.py` 在导出的 `data/crypto_mcclellan.json`
中追加 `structure = {methodology, current, series}`。全部为**描述性统计**：
不是资金流指标，不是市场崩盘预测，未做任何预测力回测，也没有固定危险阈值。

## 精确语义

每天取 Core 轨道**前一日成分名单**（与宽度振荡器同一宇宙，事前确定）：

- **EW 指数**：成分日收益等权平均（日再平衡）复利累积，每段从 100 起算。
- **CW 指数**：同一收益按**前一日**市值加权复利累积。当天的市值变化不影响当日收益，
  只决定明天的权重——指数变动永远是收益，不是总市值变动。
- **52 周回撤**：各自相对完整 52 周日历窗口（364 天 + 当日）内指数高点的回撤深度，
  0–100，正数表示低于高点。窗口不满 364 天不发布（`ready=false`, `status=warming_up`）。
- **EW−CW 回撤差**（`drawdown_gap_pp`，百分点）：回撤之差。
  正差值表示同一成分池的等权价格指数距自身高点更远，不等于逐个成分都比头部跌得深。
  差值收窄可能来自权重补跌、等权修复或旧高点退出滚动窗口，不能单独判断风险解除或下跌集中在头部。
- **`gap_percentile`**：当前差值在**严格先于当日**的已就绪差值读数中的分位，
  满 60 个先验读数才发布（`null` 表示样本不足，不是 0）。
- **`median_constituent_drawdown_52w` / `drawdown_eligible`**：成分各自 52 周回撤的
  中位数与可评估家数（每个成分需自己连续 364+1 天报价，缺一天即重计窗口）。
- **`pct_above_sma200` / `sma200_eligible`**：成分中最新采样价格高于自身 200 日采样均线的占比；
  只统计各自满 200 个连续报价的成分，不拿缺历史的币凑分母。
- **`realized_vol_30d`**：Core EW 日收益 30 日样本标准差 × √365（年化百分比）。
- **`alt_btc_corr_30d`**：Core 除 BTC 成分等权日收益与 BTC 日收益的 30 日配对相关。
- **`constituents` / `expected_constituents` / `coverage_pct`**：当日实际计价成分、
  应有成分与覆盖率；`status` 为 `ready` / `warming_up` / `incomplete_quotes`。

## 重置规则

- 任一成分报价缺失（缺失、非正、非有限）→ 当日整篮观测作废，`incomplete_quotes`，
  指数段与 30 日窗口清零；恢复完整报价后从 100 重建新段。
- 观测日不连续（日历缺口 >1 天）同样重置；`consecutive_days` 记录当前段长度。
- `ready` 只反映**最新**连续段状态，不代表历史上曾发布过任何读数。

## 限制（`metadata.quality` 同步声明）

- **历史验证只能向前做**：`gap_percentile` 与振荡器分位带均为因果口径，
  事后追加数据不得改写历史值——这一点有回归测试固定。
- 早期行无 `observed_at`（`legacy_unverified`），采样时刻不可考；
  历史回填取的是播种日 Top 300 候选池与当期元数据，存在幸存者偏差。
- 覆盖不足或样本不足时读数不稳定；所有不可用的数值一律 `null`，绝不填 0。
- 本块不构成任何买卖依据；前端另附相同声明。
