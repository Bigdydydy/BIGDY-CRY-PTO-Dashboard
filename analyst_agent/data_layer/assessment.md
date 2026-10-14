# 数据层评估：OpenMarket MCP 是否可行

> 评估日期：2026-10-03。所有结论来自当天对各接口的实测调用。

## 结论

**OpenMarket 做不了主数据层，只能当辅助层。**

Esther 方法论里最核心的三类输入，OpenMarket 不提供或提供不了：

- 宏观数据（CPI/PCE/非农/失业率等）
- 联储与财政的"管道"数据（TGA/RRP/准备金/拍卖/期限溢价）
- 足够长的历史（200 日均线、相关性、同比都需要）

主数据层改用免费公开源：**FRED CSV + Yahoo chart 接口 + 美国财政部 FiscalData API**。三者当天都实测可用，不需要 API key。OpenMarket 保留两个用途：Polymarket 上的美联储利率概率，以及周末/盘后的 7×24 实时价格。

## OpenMarket 实测结果

### 能提供的

| 能力 | 实测情况 | 对应方法论 |
|---|---|---|
| **Polymarket 美联储利率概率** | 有 10 月/12 月/明年 1 月议息结果、2026 年加息次数、反对票人数等事件，带最新成交概率和 24h 变化 | 替代 CME FedWatch，用于"市场定价 vs 美联储指引"的预期差分析（核心） |
| **美债利率永续合约** | Hyperliquid HIP-3 上有 `para:2Y` / `para:10Y` / `para:30Y` | 7×24 跟踪曲线；周末事件后先看方向 |
| **TradFi 指数/商品/外汇永续** | `xyz:SP500`（≈标普 500，实测 7730 vs 现货 7722.7）、`xyz:XYZ100`（≈纳指 100，30808 vs 30807.9）、`xyz:CL`/`xyz:BRENTOIL`/`xyz:HO`（取暖油≈柴油）、`xyz:GOLD`/`xyz:SILVER`/`xyz:COPPER`、`xyz:JPY`（≈USD/JPY）、`xyz:JP225`、`xyz:KR200`、`xyz:SMH`、`xyz:XLE`、`mkts:SMALL2000`、`xyz:TLT`，以及 NVDA/MU/SK 海力士等个股 | 跨资产相关性、油价-利率联动、日元 |
| **加密衍生品全套** | 资金费率、未平仓量、爆仓、CVD、Deribit 隐含波动率/偏度、订单簿深度 | 比特币作为风险偏好风向标；也是 bold-euclid 本来的主业 |
| **服务端指标计算** | `metric_get` 能算 RSI/MACD/SMA/EMA/布林带/ATR/z-score | 技术位（受历史长度限制，见下） |

### 不能提供或不可靠的

| 问题 | 实测情况 | 影响 |
|---|---|---|
| **Free 档历史只有 167 小时（约 7 天）** | `points` 请求 364 天直接报 `tier_forbidden`；`sma(200, DAY)` 报错，日线最长只能算 `sma(6)` | **致命**：200 日均线、50 周均线、3 个月滚动相关性、历史分位都算不了。Plus 档是 364 天，够算 200 日线，但仍不够做长周期类比 |
| **没有宏观数据** | 没有 CPI/PCE/非农/ISM/GDPNow | 致命：经济数据在语料里覆盖 214/291 篇 |
| **没有联储/财政管道数据** | 没有 TGA/RRP/WALCL/准备金/拍卖/ACM 期限溢价 | 致命：Esther 2025–2026 年的核心分析维度 |
| **没有 VIX / MOVE / 美元指数** | 搜 `VIX` 只搜到一个同名 meme 币，`DXY` 无结果；`mkts:BVIV` 是比特币波动率 | 情绪和流动性的关键指标缺失 |
| **没有实际利率/通胀预期/信用利差** | 无 TIPS、盈亏平衡通胀、高收益 OAS | 利率拆解做不了 |
| **永续合约 ≠ 现货** | 7×24 交易、有资金费率基差，`para:10Y` 24h 成交额只有约 250 万美元；10/3（周六）日内高点 5.4868 vs 当日收盘 5.3178，长影线明显 | 只能看方向，不能当官方收盘价，也不能作为止损和证伪的依据 |

## 主数据层：免费源实测清单

以下序列 2026-10-03 均实测返回了最新数据（序列 ID 见 [indicators.json](../methodology/indicators.json)）：

- **FRED**（`https://fred.stlouisfed.org/graph/fredgraph.csv?id=<ID>`，无需 key；bold-euclid 的 `server/macro_fetcher.js` 已在用同一接口）
  - 利率：DGS2、DGS10、DGS30、DFII10（实际利率）、T10YIE（盈亏平衡通胀）、T5YIFR、T10Y2Y、T10Y3M、DFF、SOFR
  - 期限溢价：THREEFYTP10（Kim-Wright 模型；Esther 用的 ACM 模型需另从纽约联储下载）
  - 流动性：WALCL、WTREGEN（TGA）、RRPONTSYD、WRESBAL
  - 信用和美元：BAMLH0A0HYM2、BAMLC0A0CM、DTWEXBGS
  - 通胀：CPIAUCSL、CPILFESL、PCEPILFE、MEDCPIM158SFRBCLE（克利夫兰中位数）、PCETRIM12M159SFRBDAL（达拉斯截尾均值）、MICH（密歇根 1 年通胀预期）
  - 就业和增长：PAYEMS、UNRATE、ICSA、JTSJOL、SAHMREALTIME、GDPNOW、GACDFSA066MSFRBPHI（费城联储）、GACDISA066MSFRBNY（纽约 Empire）
  - 其他：VIXCLS、DCOILWTICO
- **Yahoo chart 接口**（`https://query1.finance.yahoo.com/v8/finance/chart/<TICKER>`，需要浏览器 UA；标普日线可拉 10 年共 2514 根）
  - ^MOVE、^VIX、^VVIX、DX-Y.NYB、^GSPC、^NDX、^RUT、^SOX、^TNX、^TYX、SPY、QQQ、RSP、IWM、KRE、XLE、JPY=X、CL=F、BZ=F、HO=F、GC=F、HG=F、BTC-USD
  - SI=F 这次请求失败了（返回非 JSON，疑似限流），需要重试确认
  - 注意：这是非官方接口，有限流和改版风险，要做缓存和失败降级
- **美国财政部 FiscalData API**：`auctions_query` 实测可用（拍卖日期、期限、中标利率、投标倍数）

## 仍然缺的（需要手工输入或付费源）

| 数据 | 语料中的用途 | 建议 |
|---|---|---|
| 纽约联储 ACM 期限溢价 | 10 年期利率拆解 | 纽约联储官网有免费 xlsx，单独写下载器 |
| 美银基金经理调查、CTA 仓位、私行现金比例 | 情绪和仓位 | 无免费源，在周报里作为人工输入字段 |
| AAII 牛熊调查、CNN 恐惧贪婪指数 | 情绪极值 | AAII 官网有每周 xls；CNN 有非官方 JSON，可选 |
| 标普 200 日线以上成分股比例（市场宽度） | 抄底清单第 6 条 | 先用 RSP/SPY 比值作代理；以后可以用成分股自己算 |
| 远期 EPS、远期市盈率 | E vs PE 分析 | 无可靠免费源，人工输入 |
| CFTC 持仓报告 | 投机仓位 | publicreporting.cftc.gov 免费，二期再接 |
| 拍卖"尾巴"（中标利率 − 发行前 WI 利率） | 美债需求 | WI 利率要付费；先用投标倍数和间接投标比例代替 |

## 分层设计

```
主数据层（历史 + 收盘值，判断和证伪都以它为准）
  FRED  ─┐
  Yahoo ─┼─→ 本地缓存（每日）─→ 指标计算（变化、z-score、均线、相关性）
  财政部 ─┘
辅助层（实时 / 7×24 / 概率）
  OpenMarket：Polymarket 美联储概率、HIP-3 永续价格、加密衍生品
人工输入层
  基金经理调查、EPS、CTA 仓位等
```

如果以后升级到 OpenMarket Plus（364 天历史），可以把 200 日均线这类技术指标交给 `metric_get` 算；宏观和管道数据仍然要靠 FRED。

**实现状态（2026-10-03）**：主数据层已实现为 `fetch_snapshot.js`，85 个指标中 80 个自动获取（1 个需要运行时读 OpenMarket，4 个需要人工输入），首次拉取约 20 秒，之后走缓存。加入 Brooks 视角后，又增加了外汇（Yahoo 14 个货币对）、海外 10 年期利率（FRED 上的 OECD 月均值，有 1–2 个月滞后，日频没有免费源）和 BIS 实际有效汇率（美、中、日、韩，台湾和欧元区在 FRED 上没有）。
