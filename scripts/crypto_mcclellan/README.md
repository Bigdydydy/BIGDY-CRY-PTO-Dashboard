# 加密麦克莱伦市场宽度振荡器 (Module 1-B)

两条宽度轨道，同一套经典比率调整 McClellan 公式：

| 轨道 | 成分池 | 数据源 | 历史 |
| --- | --- | --- | --- |
| **Core** | 每天按前一日市值重排的 Top 100（剔除稳定币、包装/质押衍生品、代币化 RWA） | CoinGecko | 回填 365 天，之后每日追加 |
| **Frontier Meme** | Solana / BSC / Robinhood 链上热门池，按链分别设门禁，入选后留存 7 天 | GeckoTerminal（发现）+ DexScreener（报价） | 只向前累积（链上热度无法回填） |

## 采样与日期（v3 起）

- 每日定时任务采集的是**实时报价快照**，不是固定时点的 UTC 收盘：每条记录带自己的
  UTC 采集时刻 `observed_at`（采集时刻，不保证等于最后成交时刻），日期按**实际 UTC
  采集日**标注（不再做收盘对齐滞后）。
- `price_basis` 标注每行口径：`snapshot`（实时报价）/ `utc_close`（回填的日线收盘）
  / `legacy_unverified`（早期行无记录，**不事后发明采样时刻**，`observed_at` 留空）。
- 若采集跨过 UTC 零点，采样时刻与请求日期不一致时直接报错重写，不把两天报价混进同一篮子。
- 同日重复运行用 `replace_snapshot` 整天替换；`--skip-if-final` 只在**同一 UTC 日**
  已有完整 `utc_snapshot` 记录（无 core/frontier 失败）时跳过。
- 非有限/非正报价与市值在入库索引时被剔除或归零，NaN/Infinity 不会进入计算。

## 计算

```
RAMO        = (Adv − Dec) / (Adv + Dec) × 1000
Oscillator  = EMA19(RAMO) − EMA39(RAMO)
Summation   = Σ Oscillator（从首个发布日起，基数 0）
```

- 前 40 个**有效**宽度日为预热期，不发布读数；报价不完整或日历缺口（>1 天）重置 streak，
  `valid_streak_days` 是当前连续段长度。
- 涨跌按相邻观测日计算；**成分名单事先确定**：第 t 天只统计第 t−1 天就已在池中的成分，避免"因为暴涨才入选"的偏差。
- 超买超卖不用固定阈值，改用各轨道振荡器历史读数的 10% / 90% 分位：**逐日因果**——
  每一天的 `*_band_low` / `*_band_high` 只用该日**之前**的已发布读数（满 60 个先验读数才开始绘制），
  事后追加数据不会改写历史分位。
- 排除名单同样是因果的（`core_exclusions_by_date`）：每日只用当时已知的价格与元数据判定，
  未来数据不会把某币"追封"为稳定币/锚定品而改写历史宽度。
- Summation 的零点是任意基线：它是振荡的积分形态，不代表资金流入流出。

## 防失真规则

**Core**
- 静态名单：剔除稳定币、包装币、LST/LRT、代币化黄金和国债（`config.EXCLUDED_SYMBOLS` / `EXCLUDED_NAME_KEYWORDS`）。
- 自动识别：日收益绝对值的中位数低于 0.15% 视为稳定币；与 BTC/ETH/SOL/BNB/黄金的日收益差中位数低于 0.25% 视为锚定衍生品。
- 残余偏差：历史候选池取当前 Top 300，一年内跌出 Top 300 的币缺失（幸存者偏差，见 `metadata.quality`）。
- 同一套前一日成分上另算 **Core 结构宽度**（`src/structure.py`，导出在 `structure` 块）：
  等权（日再平衡）与前市值加权两条基期 100 指数、各自完整 52 周日历窗口回撤、
  EW−CW 回撤差及其历史分位（≥60 个先验读数）、成分回撤中位数、SMA200 上占比、
  EW 30 日已实现波动与 Alt/BTC 30 日相关。**描述性指标，未做任何预测力验证，
  无固定危险阈值**；任一成分报价缺失或日历缺口使当日观测作废并重置指数段。
  详见 `docs/crypto_breadth_structure.md`。

**Meme**
- 入选当天不计入，从次日开始统计。
- 7 天留存，崩盘的币照样计入下跌；留存到期当天仍报价一次。
- 被跟踪的币如果池子消失或流动性跌破 $5k，计为下跌后移出。报价 API 请求失败不算撤池。
- **按链等权**：Solana / BSC / Robinhood 各自算 RAMO 后取平均（成分少于 3 个的链不参与），`ramo_pooled` 保留合并计数作诊断。
- **外部热度锚**：DefiLlama 三条链的 DEX 成交额动量 `ln(MA7 / MA28)`，按链等权（新上线的链满 28 天才计入，避免跳变；最近 2 天数据尚未结算，丢弃）。振荡器发布满 30 天后输出 `anchor_corr`（与锚的相关系数）。
- 每日诊断字段：`frontier_dead`（撤池数）、`frontier_entries` / `frontier_exits`（换手）、`frontier_age_median`（成分年龄中位数）、`frontier_low_sample`（成分少于 20 个）。

## 文件

| 路径 | 内容 |
| --- | --- |
| `export_to_json.py` | 每日入口：采集 → 计算 → 输出 `data/crypto_mcclellan.json` |
| `seed_core_history.py` | 一次性回填 Core 一年历史（公共接口限流，约 1 小时，可断点续跑） |
| `src/breadth.py` | 纯计算：RAMO、EMA、成分池、因果排除规则 |
| `src/structure.py` | Core 结构宽度：EW/CW 指数、52 周回撤、宽度诊断 |
| `src/core_track.py` / `src/frontier_track.py` | 两条轨道的采集、存储与采样溯源 |
| `data/core_daily.csv` | Core 候选池每日价格与市值（长表，含 observed_at / price_basis） |
| `data/frontier_snapshots.csv` / `frontier_registry.json` | Meme 每日快照（含溯源列）与入选登记 |
| `data/dex_volume.csv` | DefiLlama 各链每日 DEX 成交额（外部锚，每次运行全量刷新） |
| `src/anchor.py` | 外部锚：成交额动量与相关系数 |

## 运行

只依赖 Python 标准库。

```bash
python seed_core_history.py        # 首次部署时运行一次
python export_to_json.py           # 每日采集并导出（GitHub Actions 每日 00:37/03:37/06:37/09:37 UTC，首个成功采集即定稿）
python export_to_json.py --offline # 只用已存数据重算
python test_breadth.py             # 宽度 / 采样溯源 / 因果性单元测试
python test_structure.py           # 结构宽度单元测试
```
