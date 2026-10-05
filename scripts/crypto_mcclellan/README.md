# 加密麦克莱伦市场宽度振荡器 (Module 1-B)

两条宽度轨道，同一套经典比率调整 McClellan 公式：

| 轨道 | 成分池 | 数据源 | 历史 |
| --- | --- | --- | --- |
| **Core** | 每天按前一日收盘市值重排的 Top 100（剔除稳定币、包装/质押衍生品、代币化 RWA） | CoinGecko | 回填 365 天，之后每日追加 |
| **Frontier Meme** | Solana / BSC / Robinhood 链上热门池，按链分别设门禁，入选后留存 7 天 | GeckoTerminal（发现）+ DexScreener（报价） | 只向前累积（链上热度无法回填） |

## 计算

```
RAMO        = (Adv − Dec) / (Adv + Dec) × 1000
Oscillator  = EMA19(RAMO) − EMA39(RAMO)
Summation   = Σ Oscillator（从首个发布日起，基数 0）
```

- 前 40 个宽度日为 EMA 预热期，不发布读数。
- 涨跌按 UTC 收盘对收盘计算；**成分名单事先确定**：第 t 天只统计第 t−1 天就已在池中的成分，避免"因为暴涨才入选"的偏差。
- 超买超卖不用固定阈值，改用各轨道振荡器历史读数的 10% / 90% 分位（发布满 60 天后才绘制）。

## 防失真规则

**Core**
- 静态名单：剔除稳定币、包装币、LST/LRT、代币化黄金和国债（`config.EXCLUDED_SYMBOLS` / `EXCLUDED_NAME_KEYWORDS`）。
- 自动识别：日收益绝对值的中位数低于 0.15% 视为稳定币；与 BTC/ETH/SOL/BNB/黄金的日收益差中位数低于 0.25% 视为锚定衍生品。
- 残余偏差：历史候选池取当前 Top 300，一年内跌出 Top 300 的币缺失。

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
| `src/breadth.py` | 纯计算：RAMO、EMA、成分池、排除规则 |
| `src/core_track.py` / `src/frontier_track.py` | 两条轨道的采集与存储 |
| `data/core_daily.csv` | Core 候选池每日收盘与市值（长表） |
| `data/frontier_snapshots.csv` / `frontier_registry.json` | Meme 每日快照与入选登记 |
| `data/dex_volume.csv` | DefiLlama 各链每日 DEX 成交额（外部锚，每次运行全量刷新） |
| `src/anchor.py` | 外部锚：成交额动量与相关系数 |

## 运行

只依赖 Python 标准库。

```bash
python seed_core_history.py        # 首次部署时运行一次
python export_to_json.py           # 每日采集并导出（GitHub Actions 每天 UTC 23:30 运行）
python export_to_json.py --offline # 只用已存数据重算
python test_breadth.py             # 单元测试
```
