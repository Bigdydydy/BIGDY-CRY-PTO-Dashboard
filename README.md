# BIGDY Crypto Quantitative Intelligence Dashboard
> **数字资产宏观量化、期权波动率表面与微观订单簿流动性全景雷达**

[![Node.js CI](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Architecture: Zero-Dependency](https://img.shields.io/badge/Architecture-Zero--Dependency-blue.svg)]()
[![Tests: node:test](https://img.shields.io/badge/Tests-10%2F10%20Passing-brightgreen.svg)]()

BIGDY Quantitative Dashboard 是一套面向专业对冲基金与量化做市商的数字资产全景投研决策终端。系统以纯原生 Node.js（零外部 npm 运行时依赖）构建，整合了 Deribit 期权曲面、Amberdata 微观结构模型、Coinglass 链上衍生品、St. Louis FRED 宏观流动性以及 Coinbase L2 订单簿深度数据，深度融合 Sheldon Natenberg《期权波动率与定价》与 Colin Bennett《波动率交易》等经典量化工程方法论。

---

## 目录
- [系统核心模块](#系统核心模块)
  - [Module 1: 宏观流动性、美债曲线与 MSTR 成本全景](#module-1-宏观流动性美债曲线与-mstr-成本全景)
  - [Module 2: 期现基差期限结构与期限溢价雷达](#module-2-期现基差期限结构与期限溢价雷达)
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

### Module 2: 期现基差期限结构与期限溢价雷达
- **恒定到期基差曲线 (Constant Maturity Basis)**：拟合 30D / 60D / 90D / 180D 年化年基差（Annualized Basis）。
- **资本成本基准对标**：内置 **8.0% 机构资本机会成本基准线**，精准识别基差溢价扩张（Carry Trade 结构性套利窗口）与深度倒挂（极度避险去杠杆）。
- **多维度利差雷达**：计算近端与远端期限利差（Term Premium），输出制度识别与套利盈亏比评估。

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

### Module 8: 全球宏观暗渠穿透与算力基建重估终端 (AI–BTC Tension & Arbitrage)
- **资产负债表穿透与隔夜暗渠利差**：
  - 引入隔夜融资利差（\(\text{SOFR} - \text{IORB}\)）与纽约联储 10 年期美债期限溢价（ACM Term Premium），实时监测一级交易商资产负债表摩擦。
- **Layer 1: 算力与能源重估指数 (\(I_{\text{Compute}}\))**：
  - 40% 物理电力与 HPC 转型矿企溢价（CORZ/IREN/WULF 相对 MARA/RIOT/CLSK 比价）、25% AI 巨头 Capex/OCF 强度、20% Capex 同比增速、15% 投资级与高收益债信用利差。
- **Layer 2: 加密外生流动性压力指数 (\(I_{\text{Crypto}}\))**：
  - 35% CME 近月基差倒挂风险、25% 基差动量衰减、20% 跨资产波动率冲击（VIX 脉冲）、20% 纯矿企权益挤压（纯矿企相对 BTC 超额回撤）。杜绝循环论证，实现与 BTC 自身价格收益的严格外生解耦。
- **四象限相空间引力与实战配对**：
  - **Q1 共振繁荣**、**Q2 算力分化·配对套利 (Long HPC Miners / Short BTC)**、**Q3 加密内生去杠杆**、**Q4 宏观扩张**。
- **计量经济学检验与可证伪边界**：
  - **HAC 稳健协方差**：Newey-West 5 阶滞后自相关与异方差修正。
  - **严格样本外残差 (OOS Residuals)**：120 日向前一步滚窗无前瞻偏误残差 \(\varepsilon_{\text{BTC},t}\)。
  - **因果与事件窗口**：ADF 差分平稳化后跨期因果检验，以及重大 AI Capex 指引发布前后的 CAR 累计异常收益率分析。

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
| `/api/term-premium` | `GET` | Gzip + ETag (304) | 获取恒定到期基差 (Carry Basis) 与期限溢价全量历史序列 |
| `/api/coinbase-liquidity` | `GET` | Gzip + ETag (304) | 获取 Coinbase 订单簿多层级深度、金字塔倍数与滑点仿真 |
| `/api/macro-chart` | `GET` | Gzip + ETag (304) | 获取美债收益率、FED 净流动性与 MSTR 链上持仓成本数据 |
| `/api/cdri` | `GET` | Gzip + ETag (304) | 获取加密衍生品综合风险指数 (CDRI) 及历史分位 |
| `/api/ssro` | `GET` | Gzip + ETag (304) | 获取稳定币供给比率振荡器 (SSRO) 宏观流动性指标 |
| `/api/gold-correlation` | `GET` | Gzip + ETag (304) | 获取黄金与比特币滚动相关性、比价及四象限体制数据 |
| `/api/ai-btc-tension` | `GET` | Gzip + ETag (304) | 获取全球宏观暗渠、算力基建重估指数、相空间及计量检验全量数据 |
| `/api/refresh` | `POST` | 10s IP 限流 | 触发全量上游数据源强制同步拉取并重算 |
| `/healthz` | `GET / HEAD` | 即时响应 | 云端部署健康检查端点 |

### Python 计量科学计算管线 (Module 8 Pipeline)
系统内置完备的 Python 计量经济学管线（位于 `scripts/ai_btc_tension/`），包含 FRED 宏观暗渠、SEC EDGAR 财报解析、矿企算力篮子、HAC 稳健回归与 OOS 滚窗残差模型：

```bash
# 1. 安装科学计算依赖
pip install -r scripts/ai_btc_tension/requirements.txt

# 2. 全量执行数据拉取、计量拟合与 JSON 导出
python scripts/ai_btc_tension/export_to_json.py
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
- [x] **ETag 协商缓存**：验证 MD5 生成、`If-None-Match` 一致时返回 304 及零响应体。
- [x] **Gzip 传输压缩**：验证大响应体自动压缩与 `Content-Encoding: gzip` 响应头。

---

## 开源协议

本项目采用 [MIT License](LICENSE) 授权开源。
