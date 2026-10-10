# BIGDY Crypto Quantitative Intelligence Dashboard
> **数字资产宏观量化、期权波动率表面与微观订单簿流动性全景雷达**

[![Node.js CI](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Architecture: Zero-Dependency](https://img.shields.io/badge/Architecture-Zero--Dependency-blue.svg)]()
[![Tests: node:test](https://img.shields.io/badge/Tests-11%2F11%20Passing-brightgreen.svg)]()

BIGDY Quantitative Dashboard 是一套面向专业对冲基金与量化做市商的数字资产全景投研决策终端。系统以纯原生 Node.js（零外部 npm 运行时依赖）构建，整合了 Deribit 期权曲面、Amberdata 微观结构模型、Coinglass 链上衍生品、St. Louis FRED 宏观流动性以及 Coinbase L2 订单簿深度数据，深度融合 Sheldon Natenberg《期权波动率与定价》与 Colin Bennett《波动率交易》等经典量化工程方法论。

---

## 目录
- [系统核心模块](#系统核心模块)
  - [Module 1: 宏观流动性、美债曲线与 MSTR 成本全景](#module-1-宏观流动性美债曲线与-mstr-成本全景)
  - [Module 1-B: 双轨加密麦克莱伦市场宽度振荡器与流动性背离利差](#module-1-b-双轨加密麦克莱伦市场宽度振荡器与流动性背离利差)
  - [Module 2: 期现基差期限结构、套利评分与 ETF × 套利资金联动](#module-2-期现基差期限结构套利评分与-etf--套利资金联动)
  - [Module 3: 大宗交易穿透与 30 天机构拆单聚合 (Iceberg)](#module-3-大宗交易穿透与-30-天机构拆单聚合-iceberg)
  - [Module 4: ATM IV 期限结构与历史分位评估](#module-4-atm-iv-期限结构与历史分位评估)
  - [Module 5: 动态 Gamma 敞口 (GEX) 与做市商钉扎效应](#module-5-动态-gamma-敞口-gex-与做市商钉扎效应)
  - [Module 6: Coinbase BTC 订单簿微观流动性与金字塔穿透](#module-6-coinbase-btc-订单簿微观流动性与金字塔穿透)
- [关键工程架构与安全特性](#关键工程架构与安全特性)
- [快速开始与部署指南](#快速开始与部署指南)
- [API 接口规范](#api-接口规范)
- [自动化单元测试](#自动化单元测试)
- [开源协议](#开源协议)

---

## 系统核心模块

### Module 1: 宏观流动性、美债曲线与 MSTR 成本全景
- **FED 净流动性监测 (WALCL - TGA - RRP)**：实时同步美联储资产负债表（WALCL）、财政部一般账户（WTREGEN / TGA）与隔夜逆回购（RRPONTSYD），计算真实金融净流动性及其 20 日均线与斜率走势。
- **MicroStrategy (MSTR) 持仓成本底线**：追踪 MicroStrategy 比特币持仓均价、累计持仓量与持仓市值，构建市场极端去杠杆周期的“机构硬支撑线”。
- **美债基准利差 (US10Y / US02Y)**：比对无风险利率对加密资产贴现率与资本机会成本的传导效应。

### Module 1-B: 双轨加密麦克莱伦市场宽度振荡器与流动性背离利差
- **RAMO 风险调整动量振荡算法**：修正传统股票等权腾落线在加密生态被 99% 垃圾代币扭曲的问题，引入对数收益、换手率因子与流动池惩罚：
  $$RAMO_i = \text{sign}(R_i) \cdot \ln(1 + |R_i|) \cdot \frac{\text{Vol}_{i}}{\text{Median}(\text{Vol})} \cdot \min\left(1, \frac{\text{LP}_i}{\$300\text{k}}\right)$$
- **DEX 投机前沿 Meme 动态池 4 重门禁**：LP $\ge \$300\text{k}$、24h 交易量 $\ge \$1.5\text{M}$、FDV $\ge \$10\text{M}$ 以及 7 天留存滞后缓冲带，杜绝低摩擦抽毯与假性抖动。
- **四象限宏观体制识别**：
  - **Q1 全域共振繁荣 (Co-Expansion)**：Core > 0 & Frontier > 0，增量入场，蓝筹与投机共舞。
  - **Q2 Meme 流动性抽血 (Meme Siphon)**：Core $\le$ 0 & Frontier > 0，存量内卷，利差 $\ge 40$ 触发逃顶预警。
  - **Q3 核心价值蓄势 (Quality Accumulation)**：Core > 0 & Frontier $\le$ 0，机构吸筹优质资产，垃圾代币去泡沫。
  - **Q4 流动性严冬深冻 (Deep Freeze)**：Core $\le$ 0 & Frontier $\le$ 0，全域出清，左侧周期见底。
- **核心总和指数 (Core MSI)** 与 1083 天历史时序全景回测。

### Module 2: 期现基差期限结构、套利评分与 ETF × 套利资金联动
- **真实期限点曲线**：只用 Deribit 实际交易的期限——0D 永续资金费率（实际逐小时资金费率，7 日均值年化）、当季、次季季度合约；当季距交割 <7 天时剔除，90D 恒定期限仅在相邻真实点之间线性插值，不做外推。历史 2024.01 至今，每日 08:00 UTC（北京时间 16:00，与 Deribit 日 K 线收盘和交割时点一致）快照，最新点为 Deribit 实时盘口（同一交易所、同一公式）。币安会以 HTTP 418 拒绝部署环境（Render 共享出口 IP），因此不使用币安。
- **真实期限利差**：期限斜率 (90D − 资金费率)、短端利差 (当季 − 资金费率)、跨期斜率 (次季 − 当季)。
- **动态资本成本**：FRED 3M 美债 (DGS3MO) 逐日对齐，机构门槛 = 美债 + 3.5%。
- **套利评分 0-100**：60% 套利夏普（(90D − 美债) / 基差盯市年化波动）+ 25% 期限结构 + 15% 30 日基差动量；≥65 优质 / 45-65 合格 / 30-45 边际 / <30 回避。
- **ETF 期现套利净年化**：90D 基差 − 3M 美债 − 管理费 0.25%/年 − 申赎与滑点 0.25% 按 90 天摊销。
- **ETF × 套利资金联动验证**（CoinGlass ETF 流量 + CFTC TFF + CoinGlass OI，按 COT 周二对齐）：① ΔCME 杠杆基金净空头对 ETF 周流入的对冲比例 β（全样本 + 12 周滚动）；② 高/低基差分组 β 与交互项回归；③ 基差变化与资金流的领先滞后相关；④ 基差低于美债的平仓事件；⑤ ETF 累计流入拆分为 CME 空头匹配（套利）与方向性；另附 Binance 期货 OI + Deribit 期权 OI 离岸对冲持仓走势。

### Module 3: 大宗交易穿透与 30 天机构拆单聚合 (Iceberg)
- **本地持久化 30 天成交流水沉淀**：突破官方交易所 72 小时流水限制，滚动聚合长周期机构建仓足迹。
- **冰山拆单聚类算法 (Iceberg Split Detection)**：基于 15 分钟时间滑动窗口、同合约、同方向的大单切片聚合，识别机构算法交易与大宗隐藏订单。
- **黑盒穿透模态框**：点击任意大单即可穿透 Black-76 希腊字母（Delta、Gamma、Vega、Theta）敞口、策略意图分析（Collar、Straddle、Risk Reversal 等）与到期损益边界。

### Module 4: ATM IV 期限结构与历史分位评估
- **时间平方根法则 (Square Root of Time Rule)**：基于 Natenberg 定价模型，将 1M 隐含波动率精确折算为日预期振幅（\(\sigma / 16\)）与周预期振幅（\(\sigma / 7.2\)）。
- **DVOL 730 日滚动历史分位数**：严格判定波动率所处的分位区间（极端低估 \(\le 5\%\)、偏低压缩 \(\le 20\%\)、中性合理、偏高溢价 \(\ge 75\%\)、极端泡沫 \(\ge 90\%\)），针对极值底部（如 0.0% 分位）提供 Long Gamma 保护策略指导。

### Module 5: 动态 Gamma 敞口 (GEX) 与做市商钉扎效应
- **到期日动态滚动筛选**：自动匹配当月月底、季度主交割期（3月、6月、9月、12月）以及年度最终交割期。
- **做市商对冲钉扎效应 (Pinning Effect)**：计算各行权价的净 Gamma 敞口分布，标出主要 Call Wall（最强阻力位）与 Put Wall（关键防守位）。

### Module 6: Coinbase BTC 订单簿微观流动性与金字塔穿透
- **Amberdata 微观流动性研究框架实证**：
  - **多层级阶梯深度切片**：计算 \(\pm 5\text{bps}\)、\(\pm 10\text{bps}\)、\(\pm 20\text{bps}\)、\(\pm 50\text{bps}\)、\(\pm 100\text{bps}\)、\(\pm 200\text{bps}\) 的买卖双向挂单名义价值与买盘深度占比（Bid Depth %）。
  - **订单簿金字塔结构检验**：计算 100bps / 10bps 深度扩张倍数（理论中枢 3.1x），实时诊断“近端薄弱、防线下移”或“近端充盈、吸收力强劲”。
  - **机构吃单滑点仿真 (Order Book Walking Simulation)**：模拟 \$250K ~ \$20M 瞬间市价吃单穿透的真实冲击滑点（bps）。
  - **虚假繁荣与微观背离诊断**：结合 90 天滚动价格与成交量百分位数，识别高位缩量价差走阔、流动性断层危机。

### Module 7: 黄金与比特币跨资产联动与宏观比价 (Gold & BTC Correlation)
- **Pearson 滚动相关性曲面**：追踪 BTC 与黄金（PAXG/XAU）的 30D / 90D / 180D 滚动相关系数。
- **跨资产四象限机制判定**：量化识别“抗通胀避险共振”、“流动性分化背离”、“美元主导无差别挤压”与“独立加密 Alpha 周期”。

### Module 8: 柳玉冬波浪理论智能研判系统 (Elliott Wave Theory & Liu Yudong Radar)
- **三大铁律严格核验**：
  - 浪2回撤绝不能跌破浪1起点（多头与空头双向对偶核验）。
  - 浪3不能是最短的驱动浪。
  - 推动浪中浪4底绝不能进入浪1顶领地（无重叠硬规则）。
- **《波浪理论详解》手稿全量规则库**：
  - 覆盖驱动浪基础、斐波那契系统比率、单锯齿、平台形、收缩三角形、双重与三重锯齿及联合形横向整理。
  - 严格区分浪型规则、比率规则、时间规则与软性打分指引，杜绝规则与指引混淆。
- **“出身决定命运”微观穿透**：
  - 15m / 1h / 4h 多级别时间框架切片与子浪验证，向左延伸大级别前序脉络。
- **艾略特通道与关键监测点**：
  - 辅助通道动态投影，结合手稿斐波那契目标位与失效反转临界点。
  - 决断度与概率权重的多重候选浪型智能排序输出。
- **v3 柳氏实战信号层**（依据柳玉冬 2026 年微博研判按标的时间串联提炼，见 `docs/module8_wave_v3.md`）：
  - 监测点战法（当前段小级别拐点 + 确认位）、最大回撤判据（回撤量超过段内最大回撤 → 小级别见顶/底）。
  - 吃掉前段 0.618 / 0.7 判据与调整分部投射（三角形 b≈0.618、平台/联合形 b/x≥0.7、双锯齿 x 不必到 0.618）。
  - 出身检验：当前段非五浪 → 不作新趋势起点，列出引导楔形成立条件。
  - 级别阶梯：高一级别 → 本级别 → 当前段小级别嵌套计数。
- **交替原则与子形态识别**：在浪2/浪4内部的低级别拐点上，用同一套手稿规则匹配单锯齿/平台形/收缩三角形/双重三重锯齿/联合形，判定「一陡一横、一简一繁」；浪3运行中预判浪4形态，浪4运行中列出仍成立的形态；联合形/双锯齿识别 w、y、z 组成部分（三角形只能作最后一部分）。
- **柳玉冬语料仅作离线强化**：Module 8 只研判 BTC/ETH。`data/liu_wave_threads.json` 把柳玉冬对黄金、白银、原油、个股的研判按标的时间串联，用于提炼规则与回放校准，不在界面上提供这些标的。
  - 重新生成：`node scripts/liu_threads/build_liu_threads.js [语料目录]`
  - 真实 K 线回放校准：`node scripts/liu_threads/replay_liu_threads.js XAU,XAG,CL,CRCL`

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
                     │ Resilient HTTP Client (10s AbortTimeout + Exponential Backoff)
                     ▼
  ┌─────────────────────────────────────────────────────────────┐
  │ Upstream Data Pipelines:                                    │
  │ • Greeks.live DataLab (X-Sign Authentication)               │
  │ • Deribit Public API v2 (DVOL & Futures Book)               │
  │ • Coinbase Exchange L2 REST API (Book & Candles)            │
  │ • FRED API (WALCL / TGA / RRP CSV Ingestion)                │
  │ • Coinglass Encrypted Channels (CDRI & MSTR AES-128 Decrypt)│
  │ • TradingView Global Scanner                                │
  └─────────────────────────────────────────────────────────────┘
```

1. **零外部依赖 (Zero Dependency)**：
   - 生产环境除 Node.js 原生模块（`http`、`fs`、`path`、`zlib`、`crypto`、`url`）外，无需安装任何第三方 npm 运行时包。
2. **带宽优化与协商缓存 (ETag & Gzip)**：
   - 全接口响应体采用 MD5 Strong ETag 校验，当前端数据未发生变化时返回 `304 Not Modified`，0 响应体节省带宽。
   - 启用动态 Gzip / Deflate 压缩传输，单次大数据集（约 1.5MB）体积压缩至 130KB 以下，传输性能提升 85%+。
3. **并发防击穿与防护墙**：
   - **Single-Flight 单例 Promise 锁**：合并并发刷新请求，防止上游交易所 API 因击穿而触发限频。
   - **滑动窗口 IP 限流 (Rate Limiter)**：`/api/refresh` 接口限制单 IP 每 10 秒最多触发 1 次，防止外部恶意重放。
4. **端到端 XSS 防护**：
   - 前端全部动态插入点均通过 `escapeHtml` 严格转义，杜绝上游脏数据注入与 Cross-Site Scripting 风险。

---

## 快速开始与部署指南

### 环境要求
- **Node.js**: >= 18.0.0 (推荐 20.x 或 22.x LTS)
- **npm**: >= 9.0.0

### 1. 本地启动
```bash
# 1. 克隆代码仓库
git clone https://github.com/Bigdydydy/BIGDY-CRY-PTO-Dashboard.git
cd BIGDY-CRY-PTO-Dashboard

# 2. 启动服务 (默认端口 3000)
npm start

# 3. 打开浏览器访问
http://localhost:3000
```

### 2. 环境变量支持
| 变量名 | 默认值 | 作用说明 |
|:---|:---|:---|
| `PORT` | `3000` | Web 服务器监听端口 |

例如自定义端口运行：
```bash
PORT=8080 npm start
```

### 3. 云平台一键部署 (Render / Railway / Docker)
项目已内置通用健康检查接口：
- `GET /healthz` -> 返回 `200 OK`
- `GET /api/health` -> 返回 `200 OK`
- 监听地址默认绑定至 `0.0.0.0:${PORT}`，支持 Render 等容器云平台的无缝就绪探针（Readiness & Liveness Probe）。

---

## API 接口规范

| 接口路径 | 方法 | 缓存/压缩 | 作用说明 |
|:---|:---|:---|:---|
| `/api/market-data` | `GET` | Gzip + ETag (304) | 获取期权 ATM IV、GEX 敞口、大宗拆单等核心曲面数据 |
| `/api/term-premium` | `GET` | Gzip + ETag (304) | 获取真实期限点基差、期限利差与套利评分全量历史序列 |
| `/api/etf-linkage` | `GET` | Gzip + ETag (304)，6h 缓存，`?force=1` 强制刷新 | ETF 资金 × CME 杠杆基金空头 × 基差联动验证结果与离岸对冲 OI |
| `/api/coinbase-liquidity` | `GET` | Gzip + ETag (304) | 获取 Coinbase 订单簿多层级深度、金字塔倍数与滑点仿真 |
| `/api/macro-chart` | `GET` | Gzip + ETag (304) | 获取美债收益率、FED 净流动性与 MSTR 链上持仓成本数据 |
| `/api/crypto-mcclellan` | `GET` | Gzip + ETag (304) | 获取双轨加密麦克莱伦市场宽度振荡器、背离利差与宏观体制全量数据 |
| `/api/cdri` | `GET` | Gzip + ETag (304) | 获取加密衍生品综合风险指数 (CDRI) 及历史分位 |
| `/api/ssro` | `GET` | Gzip + ETag (304) | 获取稳定币供给比率振荡器 (SSRO) 宏观流动性指标 |
| `/api/gold-correlation` | `GET` | Gzip + ETag (304) | 获取黄金与比特币滚动相关性、比价及四象限体制数据 |
| `/api/wave/klines` | `GET` | 20 req/min IP 限流 | 币安合约/现货 K 线行情代理与缓存 (15m/1h/4h，最多 10000 根，按 endTime 分页拼接) |
| `/api/wave/analysis` | `GET / POST` | 20 req/min IP 限流 | 柳玉冬波浪理论全量智能研判、铁律校验与候选集引擎 |
| `/api/refresh` | `POST` | 10s IP 限流 | 触发全量上游数据源强制同步拉取并重算 |
| `/healthz` | `GET / HEAD` | 即时响应 | 云端部署健康检查端点 |

### Python 计量科学计算管线 (Quantitative Pipelines)
系统内置完备的 Python 科学计算与计量分析管线（位于 `scripts/`）：

1. **双轨加密麦克莱伦市场宽度管线 (`scripts/crypto_mcclellan/`)**：
```bash
pip install -r scripts/crypto_mcclellan/requirements.txt
python scripts/crypto_mcclellan/export_to_json.py
```
> **注**：在无 Python 运行时环境（如轻量级 Node.js 容器）中，服务端将自动以 `pipelineUnavailable` 机制诚实响应，无缝载入经过核验的基准全量快照，不产生虚假解算反馈。

---

## 自动化单元测试

测试套件基于 Node.js 原生测试运行器 `node:test` 与严格断言 `node:assert/strict` 编写，无需安装 Jest 或 Mocha，完全离线运行。

```bash
npm test
```

### 测试用例覆盖
- [x] **ATM IV 极限分位数测试**：验证 `percentile === 0.0%` 时类型转换无缺陷，杜绝 `undefined%` 字符串污染。
- [x] **DVOL 数据缺失降级测试**：验证历史统计数据缺失时，平滑降级至绝对波动率常模。
- [x] **动态 GEX 算法验证**：验证 Call Wall（阻力位）、Put Wall（支撑位）以及到期日动态推进。
- [x] **大宗拆单聚合聚类验证**：验证时间窗口内的冰山订单聚合与多腿组合拆解。
- [x] **Black-76 希腊字母算法**：验证 Delta、Gamma、Vega、Theta 解析数学准确度。
- [x] **RAMO 风险调整动量算法与惩罚项验证**：验证 LP 惩罚项、换手率缩放与零收益边界。
- [x] **麦克莱伦双轨振荡器与四象限宏观体制**：验证 EMA19-EMA39 差值放大、背离利差与象限状态机。
- [x] **ETag 协商缓存**：验证 MD5 生成、`If-None-Match` 一致时返回 304 及零响应体。
- [x] **Gzip 传输压缩**：验证大响应体自动压缩与 `Content-Encoding: gzip` 响应头。

---

## 开源协议

本项目采用 [MIT License](LICENSE) 授权开源。
