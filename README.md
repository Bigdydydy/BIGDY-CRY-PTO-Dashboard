# BIGDY Crypto Quantitative Intelligence Dashboard
> **数字资产宏观量化、期权波动率表面、做市商敞口与微观订单簿流动性全景雷达**

[![Node.js CI](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Architecture: Zero-Dependency](https://img.shields.io/badge/Architecture-Zero--Dependency-blue.svg)]()
[![Tests: node:test](https://img.shields.io/badge/Tests-630%20Passing-brightgreen.svg)]()

BIGDY Quantitative Dashboard 是一套面向专业对冲基金与量化做市商的数字资产全景投研决策终端。系统以纯原生 Node.js（零外部 npm 运行时依赖）构建，整合了 Deribit 期权曲面、CoinGlass 衍生品、St. Louis FRED 宏观流动性、Coinbase L2 订单簿、Strategy (MSTR) 官方披露与 SEC EDGAR 申报，深度融合 Sheldon Natenberg《期权波动率与定价》与 Colin Bennett《波动率交易》等经典量化工程方法论。

**线上实例**：[https://bigdy-cry-pto-dashboard-3.onrender.com](https://bigdy-cry-pto-dashboard-3.onrender.com)

---

## 目录
- [系统核心模块](#系统核心模块)
  - [宏观与风控总览 (Macro · MSTR · Preferreds)](#宏观与风控总览-macro--mstr--preferreds)
  - [MSTR 官方披露账本与 SEC 8-K 回退链路](#mstr-官方披露账本与-sec-8-k-回退链路)
  - [加密麦克莱伦市场宽度振荡器 (Module 1-B)](#加密麦克莱伦市场宽度振荡器-module-1-b)
  - [期现基差期限结构与 ETF × 套利资金联动 (Module 2)](#期现基差期限结构与-etf--套利资金联动-module-2)
  - [期权套件：ATM IV · Smile · 25Δ Skew (Cards 01/04/05)](#期权套件atm-iv--smile--25δ-skew-cards-010405)
  - [GEX 钉盘与做市商全链敞口 (Cards 02/02B)](#gex-钉盘与做市商全链敞口-cards-0202b)
  - [大宗交易与机构冰山拆单 (Card 03)](#大宗交易与机构冰山拆单-card-03)
  - [大宗资金深度研判 (Module 4B)](#大宗资金深度研判-module-4b)
  - [BTC 主导力量雷达与稳定币流动性 (Module 05/05B)](#btc-主导力量雷达与稳定币流动性-module-0505b)
  - [Coinbase 订单簿微观流动性](#coinbase-订单簿微观流动性)
  - [黄金与比特币跨资产联动](#黄金与比特币跨资产联动)
  - [艾略特波浪与柳玉冬研判引擎 (Module 8)](#艾略特波浪与柳玉冬研判引擎-module-8)
- [数据韧性与健康监测](#数据韧性与健康监测)
- [定时数据管线 (GitHub Actions)](#定时数据管线-github-actions)
- [关键工程架构与安全特性](#关键工程架构与安全特性)
- [项目目录结构](#项目目录结构)
- [快速开始与部署指南](#快速开始与部署指南)
- [API 接口规范](#api-接口规范)
- [自动化单元测试](#自动化单元测试)
- [关联组件：本地宏观评论 Agent](#关联组件本地宏观评论-agent)
- [开源协议](#开源协议)

---

## 系统核心模块

### 宏观与风控总览 (Macro · MSTR · Preferreds)
- **FED 净流动性监测 (WALCL − TGA − RRP)**：实时同步美联储资产负债表、财政部一般账户与隔夜逆回购，计算真实金融净流动性及均线/斜率走势。
- **美债曲线体制识别**：US10Y/US02Y 利差与曲线形态分类（牛陡/牛平/熊陡/熊平/扭曲/平坦化），多窗口（5D/20D）变化与图表时间窗联动。
- **MicroStrategy (MSTR) 持仓与资本全景**：BTC 持仓量、累计成本、均价与市场极端去杠杆"机构硬支撑线"；EV/BTC 市值旧口径参考。
- **优先股模块 (STRC/STRF/STRK/STRD/STRE)**：各期股息率、派息日与二级市场定价；STRC 月度股息率历史自动归档（`data/strc_rate_history.json`）。

### MSTR 官方披露账本与 SEC 8-K 回退链路
> 详见 [`docs/mstr_disclosures.md`](docs/mstr_disclosures.md)。

- **五源官方披露采集**（`server/mstr_disclosures.js`）：strategy.com `/ledger`（BTC 买卖事件账本）、`/shares`（千股单位已归一）、`/debt`（资本结构：可转债明细、mstrStats 现金/债务/优先股、五只优先股条款）、`/press`（公告标题级分类发现）+ SEC EDGAR 申报索引。每条事实保留证据 SHA-256、修订历史与发行方日期（与接收时间戳严格分离）。
- **SEC 8-K 回退路径**（`server/mstr_sec_model.js`）：当官网对部署环境返回 403 时自动切换——从 weekly 8-K 解析持仓三元组（持仓/累计成本/均价，覆盖表格、卖出、双期间、行文四种版式）、USD Reserve/Cash、ATM 增发与回购流水、STRC 股息率公告（含半月计息与有条件生效标记）；`data/mstr_capital_reference.json` 提供静态条款基线，XBRL 作总债务/期权交叉核对。
- **官方口径 mNAV（版本化方法论）**：按 2026-07-23 官方公式计算——`mNAV = MSTR价 / Net BPS`，`Net BTC($) = BTC持仓×BTC价 − 价外可转债名义 − 优先股名义(剔除价内STRK，STRE按汇率折算) + USD Assets`，`FDSO = 基本股数 + 期权 + RSU/PSU + 价内转股`。明确标注为基于披露输入的**推算值**，新旧口径不可比、不混编历史序列。
- **完整性保障**：请求/解析/合并/持久化任一环节失败均不覆盖有效缓存；重复活跃修订、未来时间戳、无效 accession、不完整历史一律拒绝；官网更新时优先官网路径，被拦截时 SEC 为必需源、官网源降为展示性可选源。

### 加密麦克莱伦市场宽度振荡器 (Module 1-B)
- **RAMO 风险调整动量振荡算法**：修正传统股票等权腾落线在加密生态被垃圾代币扭曲的问题，引入对数收益、换手率因子与流动池惩罚：
  $$RAMO_i = \text{sign}(R_i) \cdot \ln(1 + |R_i|) \cdot \frac{\text{Vol}_{i}}{\text{Median}(\text{Vol})} \cdot \min\left(1, \frac{\text{LP}_i}{\$300\text{k}}\right)$$
- **DEX 投机前沿 Meme 动态池 4 重门禁**：LP ≥ $300k、24h 交易量 ≥ $1.5M、FDV ≥ $10M 以及 7 天留存滞后缓冲带。
- **四象限宏观体制识别**：Q1 全域共振繁荣 / Q2 Meme 流动性抽血（利差 ≥40 触发逃顶预警）/ Q3 核心价值蓄势 / Q4 流动性严冬深冻。
- **核心总和指数 (Core MSI)** 与 1083 天历史时序全景回测；Core 结构宽度（描述性、非预测）。

### 期现基差期限结构与 ETF × 套利资金联动 (Module 2)
- **真实期限点曲线**：只用实际交易的期限——0D 全市场永续资金费率（CoinGlass 按持仓量加权；Deribit 永续有抑制机制仅作对照）、Deribit 当季/次季季度合约；当季距交割 <7 天剔除，90D/180D 恒定期限仅在相邻真实点间线性插值不做外推。每日 08:00 UTC 快照归档，最新点为实时盘口。
- **期限利差与套利评分**：期限斜率、短端利差、跨期斜率；FRED 3M 美债对齐，机构门槛 = 美债 + 3.5%；评分 0-100（60% 套利夏普 + 25% 期限结构 + 15% 基差动量）。
- **ETF × 套利资金联动验证**（CoinGlass ETF 流量 + CFTC TFF + OI，按 COT 周二对齐）：ΔCME 杠杆基金净空头对 ETF 周流入的 β（全样本+12 周滚动）、高低基差分组回归、领先滞后相关、平仓事件与流入拆分；附 Binance 期货 + Deribit 期权离岸对冲持仓。

### 期权套件：ATM IV · Smile · 25Δ Skew (Cards 01/04/05)
- **ATM IV 期限结构与历史分位**：365 日历年化的时间平方根法则（日 σ/√365、周 σ/√52）；DVOL 730 日滚动分位；隐含 vs 已实现 VRP；Bennett 跳空波动率拆分的事件溢价。
- **IV Smile 两翼非对称拆解（Card 04）**：固定 Delta（25Δ/10Δ）与固定远期对数虚实值（x=ln(K/F)，x−=ln0.75、x+=ln1.25）双口径翼溢价——`putWingPremium`（防崩盘左翼）与 `callWingPremium`（上行凸度）；自动 `wingRegime` 分类（防崩盘左翼陡峭/加密原生上行凸度/双向肥尾高凸度/两翼均衡）；极端尾部触达（Kmin/F、Kmax/F 及翼界 IV）。
- **25Δ Skew 期限结构（Card 05）**：按 √T 比较各期限 RR/σ；Bennett 四种偏度实现机制由 90 日 ΔDVOL 对 Δln S 回归 β 判定；与日度档案（`data/vol_surface_history_BTC.local.json`，含 putWing25/callWing25，满 30 天启用）比较历史分位。

### GEX 钉盘与做市商全链敞口 (Cards 02/02B)
- **Card 02 各交割期钉盘分布**（Greeks.live 参照口径）：主力交割期 Call/Put 磁吸墙、近端 10 天与全链净 GEX、零 Gamma 翻转位；正负号沿用 Call 记正、Put 记负惯例。
- **Card 02B 做市商敞口 · 全链自算**（`server/dealer_engine.js`）：Deribit `get_book_summary_by_currency` 全链快照逐合约 Black-76（r=0）计算 DEX/GEX(+1%现货)/VEX(+1pt IV)/CEX(+1天)；现货 ±20% 滑动全链重估求零 Gamma 翻转位；币本位会计 Δ*（Δ−V/F）与合成远期多头假设占比标注。
- **5 档期限结构矩阵**：<2周 / 2–6周 / 6–10周 / 10–16周 / >16周 各档 Call OI、Put OI、OI 占比、Call:Put 比与分档净 GEX；全链 Call:Put、>16w 结构性长端占比、深度尾部 OI（Put K≤0.75F / Call K≥1.50F）。
- **交割断崖模拟**：剔除近端 ≤10D 或下一个月度/季度交割后重估残余 GEX 与体制符号；临近 ≤7D 且导致变号或缓冲缩水 ≥50% 时触发预警。
- **全成交累计净额台账**（`server/option_flow_ledger.js`）：回补每个现存合约上市以来全部逐笔成交，屏幕/大宗/强平分开记账；CI 每日增量同步（`option_flow_daily.yml`），线上从 GitHub raw 读取。台账可用时为主口径，惯例口径并列对照。
- **持仓符号敏感性**：惯例/虚值 Call 客户买入/全成交校正三口径并列，屏幕成交折扣五档敏感性与 OI 封顶自检；口径不同号标"结论不稳健"，并给翻号阈值。
- **已触发对冲流与深度对比**：按 24h 现货/波动率变化重估做市商被动对冲量（拆 Gamma/Vanna/Charm），与 Coinbase ±2% 盘口深度对比量级；日度历史档案（`dealer_history.js`）。

### 大宗交易与机构冰山拆单 (Card 03)
- **本地持久化 30 天成交流水**：突破交易所 72 小时限制，滚动聚合长周期机构足迹。
- **冰山拆单聚类**：15 分钟滑窗、同合约同方向大单切片聚合。
- **Black-76 远期定价 Greeks**：大宗交易按**到期远期价 F**（`buildForwardsMap` 汇总 ATM 与 option marks 各到期远期）而非现货 S 计算 Greeks，消除远月 Δ 偏移。
- **Smile 联动评级**：注入 smileContext（25Δ 偏度、BF、两翼溢价）激活 smileAlphaRating——偏度套利/逆势高抛/顺势追买评级。
- **交易时段归类**：按美东时间（自动适配 EDT/EST）划分 美股 ETF 同频（工作日 09:30–16:00 ET）/ 亚欧非美时段 / 周末独立定价，顶部汇总名义额占比。
- **黑盒穿透模态框**：单笔穿透希腊字母敞口、策略意图（Collar/Straddle/Risk Reversal）与到期损益边界。

### 大宗资金深度研判 (Module 4B)
- **期限资金流向**：分期限大单净流向与 OI 开平仓验证。
- **行权价热力图**：目标区间与价位墙。
- **聪明钱命中率与信号加权**（`server/block_insight.js`）：历史大单家族分类（修正：纯买入深虚值 Put/Call 归入 bear/bull，不再误归 Delta 中性 long-vol）。
- 由 `.github/workflows/block_insight_daily.yml` 每日产出 `block_flow`/`smart_money` 归档。

### BTC 主导力量雷达与稳定币流动性 (Module 05/05B)
- **Flow Force 主导力量指标**（`server/flow_force.js`）：2×2 场域矩阵——期货/现货 × 亚太/欧美（币安+OKX 亚太侧、Hyperliquid 欧美期货、Coinbase 欧美现货）；BVC 批量成交量分类（Easley-López de Prado-O'Hara 2012）估计主动买卖净额；已收盘 K 线"先写入者为准"定稿、不可篡改，缺场标记 missing 等待补齐；币安在云主机常被 418 拦截，经备用源链获取。
- **SSRO 稳定币供应比率振荡器**：稳定币总市值对 BTC 市值的相对强弱与宏观流动性传导。

### Coinbase 订单簿微观流动性
- **多层级阶梯深度切片**：±5/10/20/50/100/200 bps 买卖双向名义价值与 Bid Depth %。
- **金字塔结构检验**：100bps/10bps 深度扩张倍数（理论中枢 3.1x）。
- **机构吃单滑点仿真**：$250K ~ $20M 市价单穿透冲击（bps）。
- **虚假繁荣与微观背离**：90 天滚动价量分位识别高位缩量、价差走阔、流动性断层。逐时深度档案由 `liquidity_hourly.yml` 维护。

### 黄金与比特币跨资产联动
- Pearson 30D/90D/180D 滚动相关性（PAXG/XAU）与金/BTC 比价矩阵。
- 四象限机制：抗通胀避险共振 / 流动性分化背离 / 美元主导无差别挤压 / 独立加密 Alpha 周期。

### 艾略特波浪与柳玉冬研判引擎 (Module 8)
- **三大铁律严格核验**：浪2不破浪1起点（多空双向对偶）、浪3非最短驱动浪、推动浪浪4不入浪1领地。
- **《波浪理论详解》手稿全量规则库**：驱动浪、斐波那契比率、单锯齿、平台形、收缩三角形、双重/三重锯齿与联合形；严格区分规则/比率/时间/软性打分。
- **v3 柳氏实战信号层**（`docs/module8_wave_v3.md`）：监测点战法、最大回撤判据、0.618/0.7 吃掉判据、出身检验、级别阶梯嵌套计数、交替原则子形态识别。
- **用户画浪评估**：`POST /api/wave/evaluate` 对用户手绘浪型做铁律校验与多级别证伪。
- 语料仅作离线强化（`data/liu_wave_threads.json`），界面只研判 BTC/ETH；K 线经 Binance→Bybit→OKX 备用源链获取。

---

## 数据韧性与健康监测
> 详见 [`docs/data_resilience.md`](docs/data_resilience.md)。核心目标：**任何模块都不能把过期的、备用源的或未核验的数据伪装成新鲜数据**。

- **每源健康登记**（`server/data_health.js` + `data_health_policy.js`）：每个数据源记录尝试/成功回执/数据日期（`dataAsOf`，非接收时刻）/错误/备用来源/连续失败；状态机 `OK → FALLBACK → STALE → UNAVAILABLE / UNKNOWN`。
- **时钟口径**：`lastSuccessAt` 仅被真实成功回执推进（fetch 成功 + schema 校验通过）；失败只推进 `lastAttemptAt`/`lastError`，**绝不推进成功时钟**。
- **载荷校验**：各源对上游响应做 schema/递增日期/未来时间戳/有限正值校验，畸形载荷在覆盖缓存前被拒绝；持久化写盘走原子写。
- **结论锁定**：required 源任一不可用即 `analysisAllowed=false`，实时结论被锁定（API 返回 `data_unavailable`，UI 显示暂停原因），历史曲线仍可浏览。
- **统一健康面**：`GET /api/system/health` 汇总全部模块与生产者任务状态；`.github/workflows/data_health.yml` 每小时巡检线上健康端点（`DASHBOARD_HEALTH_URL`），异常时可经 `DATA_HEALTH_WEBHOOK_URL` 告警。
- **单飞锁与备用源**：上游调用经 `fetchWithTimeout`（10s 超时/有限重试）+ 单飞 Promise 锁合并并发刷新；K 线/宏观数据有多源回退链并标记 `FALLBACK` 来源。

---

## 定时数据管线 (GitHub Actions)

| 工作流 | 频率 | 产出 |
|:---|:---|:---|
| `macro_snapshot.yml` | 每 6 小时 | 宏观图、MSTR 披露账本+证据 artifact（14 天）、优先股/STRC 股息率 |
| `mcclellan_daily.yml` | 每日 ×4 | McClellan 双轨宽度全量历史 |
| `liquidity_hourly.yml` | 每小时 ×4 | Coinbase 深度快照档案 |
| `block_insight_daily.yml` | 每日多次 | Module 4B 大宗流向、聪明钱、OI 历史 |
| `option_flow_daily.yml` | 每日 | 期权全成交净额台账 + 做市商敞口历史 |
| `data_health.yml` | 每小时 | 线上 `/api/system/health` 巡检与告警 |

**仓库变量/密钥**：`SEC_USER_AGENT`（SEC 要求的申报方身份串，含联系邮箱，非密钥）、`DASHBOARD_HEALTH_URL`（健康端点）、`DATA_HEALTH_WEBHOOK_URL`（可选告警 webhook）。

---

## 关键工程架构与安全特性

```
                     ┌───────────────────────────────┐
                     │   Browser Client (Web UI)     │
                     │  ECharts + Dark Terminal CSS  │
                     └───────────────┬───────────────┘
                                     │ HTTP (Gzip/Deflate + ETag/304)
                                     ▼
                     ┌───────────────────────────────┐
                     │     Node.js Native Server     │
                     │  (HTTP / Zlib / Crypto Engine)│
                     └───────┬───────────────┬───────┘
                             │               │
            ┌────────────────┴───┐       ┌───┴────────────────┐
            │ Single-Flight Lock │       │ 10s IP Rate Limit  │
            │ & In-Memory Cache  │       │ (429 Anti-Abuse)   │
            └────────┬───────────┘       └────────────────────┘
                     │ Resilient HTTP Client (10s Timeout + Backoff)
                     │ Per-Source Health Registry + Schema Validation
                     ▼
  ┌─────────────────────────────────────────────────────────────┐
  │ Upstream Data Pipelines:                                    │
  │ • Greeks.live DataLab (X-Sign Authentication)               │
  │ • Deribit Public API v2 (DVOL / Futures / Book Summary)     │
  │ • history.deribit.com (全成交台账回补)                       │
  │ • Coinbase Exchange L2 REST API                             │
  │ • Binance → Bybit → OKX K线备用源链                          │
  │ • FRED API (WALCL / TGA / RRP / DGS 系列)                   │
  │ • CoinGlass (CDRI / 资金费率 / ETF 流量)                     │
  │ • strategy.com 官方披露 + SEC EDGAR (8-K/XBRL)              │
  │ • TradingView Global Scanner / Hyperliquid                  │
  └─────────────────────────────────────────────────────────────┘
```

1. **零外部依赖**：生产环境仅 Node.js 原生模块（`http`、`fs`、`path`、`zlib`、`crypto`、`url`），无 npm 运行时包。
2. **带宽优化与协商缓存**：MD5 Strong ETag + `304 Not Modified`；Gzip/Deflate 压缩（约 1.5MB 数据集压至 130KB 以下）。
3. **并发防击穿**：Single-Flight 合并并发刷新；`/api/refresh` 单 IP 每 10 秒限 1 次。
4. **端到端 XSS 防护**：全部动态插入点经 `escapeHtml` 转义。
5. **离线降级诚实**：上游不可用时按源健康状态如实降级（FALLBACK/STALE/UNAVAILABLE），不用缓存伪装实时数据；Python 管线缺失时以 `pipelineUnavailable` 载入经核验的基准快照。

---

## 项目目录结构

```
├── server/                  # 后端引擎与数据采集（原生 Node.js，零依赖）
│   ├── index.js             #   HTTP 路由与单飞刷新编排
│   ├── analytics_engine.js  #   期权分析：Black-76 Greeks、Smile 两翼、25Δ Skew、时段归类
│   ├── dealer_engine.js     #   做市商敞口全链重估、5档期限矩阵、交割断崖模拟
│   ├── block_insight.js     #   Module 4B 大宗资金深度研判与家族分类
│   ├── mstr_disclosures.js  #   MSTR 五源披露采集（证据哈希+修订历史+路径感知健康）
│   ├── mstr_sec_model.js    #   SEC 8-K 正文解析与资本结构滚动推导
│   ├── mstr_mnav.js         #   官方口径 mNAV（2026-07-23 版本化方法论）
│   ├── data_health*.js      #   数据源健康登记、策略窗口、监控评估
│   ├── audit_engine.js      #   统一审计/健康路径
│   └── …                    #   各源 fetcher / term_curve / wave_engine / flow_force 等
├── public/                  # 前端 SPA（ECharts + 暗色终端/画廊双主题）
│   ├── index.html / app.js  #   主视图与渲染
│   ├── mstr_disclosures_ui.js / data_health_ui.js / wave_ui.js …
├── data/                    # 运行时数据与 CI 归档快照（由定时管线产出）
├── scripts/                 # 定时任务入口与工具（macro_snapshot、option_flow_ledger…）
│   ├── crypto_mcclellan/    #   McClellan Python 计量管线
│   └── run_tests.js         #   测试运行器（沙箱副本，不写污染仓库）
├── test/                    # 63 个测试文件 / 630 个用例（node:test，离线运行）
├── .github/workflows/       # 6 条定时数据管线 + 健康巡检
├── docs/                    # data_resilience / mstr_disclosures / module8_wave_v3 / crypto_breadth
├── analyst_agent/           # 本地自用宏观评论 Agent（双视角方法论，不对外部署）
├── tradingview/ tools/      # TradingView 抓取与工具脚本
└── render.yaml              # Render 一键部署描述
```

---

## 快速开始与部署指南

### 环境要求
- **Node.js**: >= 18.0.0 (推荐 20.x 或 22.x LTS)

### 本地启动
```bash
git clone https://github.com/Bigdydydy/BIGDY-CRY-PTO-Dashboard.git
cd BIGDY-CRY-PTO-Dashboard
npm start          # 默认端口 3000 → http://localhost:3000
```

### 环境变量
| 变量名 | 默认值 | 说明 |
|:---|:---|:---|
| `PORT` | `3000` | Web 监听端口 |
| `SEC_USER_AGENT` | — | SEC EDGAR 申报方身份串（含联系邮箱）；缺失时 SEC 源如实记录失败不发请求 |
| `DATA_HEALTH_WEBHOOK_URL` | — | 可选：健康巡检告警 webhook |

### 云平台部署
项目内置 `render.yaml`（Render 一键部署）；健康检查端点 `GET /healthz`、`GET /api/health` 均返回 `200 OK`，监听 `0.0.0.0:${PORT}`。

---

## API 接口规范

| 接口路径 | 方法 | 缓存/压缩 | 说明 |
|:---|:---|:---|:---|
| `/api/market-data` | `GET` | Gzip + ETag | ATM IV、GEX、Smile、25Δ Skew、大宗拆单全量曲面 |
| `/api/option-marks` | `GET` | Gzip + ETag | Deribit 全链 mark 快照（含远期价） |
| `/api/block-insight` | `GET` | Gzip + ETag | Module 4B 资金流向、行权价热力、聪明钱 |
| `/api/term-curve` | `GET` | Gzip + ETag | Deribit 期货期限曲线（真实合约点） |
| `/api/term-premium` | `GET` | Gzip + ETag | 基差期限结构、利差与套利评分历史 |
| `/api/etf-linkage` | `GET` | Gzip + ETag，`?force=1` | ETF 资金 × CME 空头 × 基差联动验证 |
| `/api/mstr-preferreds` | `GET` | Gzip + ETag | STRC/STRF/STRK/STRD/STRE 优先股定价与股息率 |
| `/api/mstr-disclosures` | `GET` | Gzip + ETag | MSTR 官方披露账本、资本结构、官方 mNAV |
| `/api/macro-chart` | `GET` | Gzip + ETag | 美债收益率、FED 净流动性、MSTR 成本 |
| `/api/cdri` | `GET` | Gzip + ETag | 加密衍生品综合风险指数及分位 |
| `/api/ssro` | `GET` | Gzip + ETag | 稳定币供给比率振荡器 |
| `/api/flow-force` | `GET` | Gzip + ETag | BTC 主导力量 2×2 场域矩阵 |
| `/api/coinbase-liquidity` | `GET` | Gzip + ETag | 多层级深度、金字塔倍数、滑点仿真 |
| `/api/coinbase-liquidity-history` | `GET` | Gzip + ETag | 逐时深度档案 |
| `/api/gold-correlation` | `GET` | Gzip + ETag | 金/BTC 滚动相关性与四象限 |
| `/api/crypto-mcclellan` | `GET` | Gzip + ETag | 双轨宽度振荡器、背离利差、体制 |
| `/api/system/health` | `GET` | 即时 | 全模块+生产者统一健康面（OK/DEGRADED/UNAVAILABLE） |
| `/api/refresh` | `POST` | 10s IP 限流 | 触发全量上游同步重算 |
| `/api/wave/klines` | `GET` | 20 req/min | K 线代理（Binance→Bybit→OKX 备用链） |
| `/api/wave/analysis` | `GET/POST` | 20 req/min | 波浪理论智能研判与候选集引擎 |
| `/api/wave/evaluate` | `POST` | 20 req/min | 用户画浪铁律校验与证伪 |
| `/healthz` `/api/health` | `GET/HEAD` | 即时 | 部署健康检查 |

### Python 计量科学计算管线
```bash
pip install -r scripts/crypto_mcclellan/requirements.txt
python scripts/crypto_mcclellan/export_to_json.py
```
> 无 Python 环境时服务端自动以 `pipelineUnavailable` 诚实降级，载入经核验的基准快照。

---

## 自动化单元测试

基于 Node.js 原生 `node:test` + `node:assert/strict`，无需 Jest/Mocha，完全离线运行。

```bash
npm test    # 63 个测试文件 / 630 个用例（test/ 复制到沙箱执行，不写污染仓库）
```

覆盖：Black-76 Greeks 与远期定价、Smile 两翼与 wingRegime 分类、期限矩阵与交割断崖、时段归类、冰山聚合、GEX/做市商敞口三口径敏感性、MSTR 披露账本（修订合并/证据哈希/SEC 回退/官方 mNAV）、RAMO 与四象限体制、数据源健康状态机与时钟口径、ETag/Gzip 协商缓存、波浪规则引擎等。

---

## 关联组件：本地宏观评论 Agent

`analyst_agent/` 是一套**本地自用**的双视角宏观策略评论 agent（Esther × Robin Brooks 方法论合成），含 FRED/Yahoo/财政部 85 指标快照层、观点台账与回测框架，由 Claude Code 会话按 `analyst_agent/AGENT.md` 运行，不对外部署、与 Dashboard 服务相互独立。

---

## 开源协议

本项目采用 [MIT License](LICENSE) 授权开源。
