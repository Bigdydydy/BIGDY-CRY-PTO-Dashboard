# 数据源许可台账

> 核对日期：2026-11-18。下次复核：2027-02-18（每季度一次，或新增数据源时）。
> 范围：`server/`、`scripts/`、`public/`、`analyst_agent/`、`openmarket/` 里实际请求的全部外部来源（约 25 个主机）。
> **这不是法律意见。** 条款摘要来自公开页面和搜索结果，有几处只拿到片段（标"待核"）。要开始收费之前，至少请律师看一遍标红和标橙的来源。

---

## 一页结论

1. **有 3 个来源是逆向或非公开接口，收费之前必须移除**：Greeks.live（签名请求）、CoinGlass 网站内部接口（AES 解密）、TradingView 内部 WebSocket 和 scanner。签名和解密逻辑现在就在**公开仓库**里。
2. **核心行情来源（Deribit、Coinbase、Binance Vision）的条款都不允许免费转售**：Deribit 写明"仅限个人使用"，Coinbase 的再分发要走授权伙伴，Binance Vision 写明商用需要企业授权。这些数据拿来自营交易没有问题，但不能作为数据卖给别人。
3. **现在已经存在三条事实上的再分发渠道**，和商业化无关，现在就要处理：
   - 公开 GitHub 仓库里提交了 8 个原始数据档案，任何人都能从 `raw.githubusercontent.com` 直接下载；
   - 线上站点的 `/api/*` 带 `Access-Control-Allow-Origin: *`，任何网站都能直接调用；
   - README 声明"MIT 授权"，但仓库里没有 `LICENSE` 文件，也没写明 `data/` 下的第三方数据不在 MIT 授权范围内。
4. 政府和公共数据（FRED 公共领域系列、SEC EDGAR、CFTC、美国财政部）可以放心用，署名即可。SEC 要求的声明式 User-Agent，代码里已经强制带上了。

---

## 等级定义

| 等级 | 含义 | 处理原则 |
|---|---|---|
| 🔴 红 | 逆向或非公开接口，或条款明确禁止自动采集 | 收费前必须移除，最好现在就开始替换 |
| 🟠 橙 | 官方公开接口，但条款限个人或非商用，再分发需要授权 | 自营可以用；面向付费用户展示前，要买授权或改从授权数据商采购 |
| 🟡 黄 | 允许商用，但有条件（署名、付费档、不得做竞品） | 补署名、升级套餐 |
| 🟢 绿 | 政府或公共领域数据 | 署名并注明来源 |
| ⚪ 待核 | 没取到条款原文 | 商业化前补齐 |

使用场景的标记：✓ 可以，△ 灰色或有条件，✗ 不可以。

---

## 台账

### 🔴 逆向 / 非公开接口

| 来源 | 用在哪里 | 接入方式 | 条款要点 | 自营 | 免费公开看板 | 收费产品 | 动作 |
|---|---|---|---|:-:|:-:|:-:|---|
| **Greeks.live** DataLab | 期权 ATM IV、GEX、IV 历史、Skew、Smile，大宗流水（[data_fetcher.js](../server/data_fetcher.js)、[crypto_signer.js](../server/crypto_signer.js)） | 非公开接口，用 `X-Sign` 签名，伪造 Origin/Referer | 没有公开 API 授权；签名逻辑是逆向出来的 | △ | ✗ | ✗ | 经验总结 2.6 已定下方向：用 Deribit 公开数据自算 ATM IV、Smile、Skew、GEX、大宗，Greeks.live 降级为交叉核对，最终移除。签名代码移出公开仓库 |
| **CoinGlass** `capi.coinglass.com` | CDRI、宏观面板、全市场 OI 加权资金费（基差的 0D 期限点）（[cdri_fetcher.js](../server/cdri_fetcher.js)、[macro_fetcher.js](../server/macro_fetcher.js)） | 网站内部接口，AES-ECB 解密响应 | 官方 API 的低价档仅限个人使用，商用要更高档的套餐；内部接口不在任何授权范围内 | △ | ✗ | ✗ | 二选一：①改用官方 API 的商用档（每月几百美元，以官网为准）；②用各交易所的公开资金费和 OI 自己算加权值（Binance、OKX、Bybit、Deribit、Hyperliquid 已经接了一部分） |
| **TradingView** 内部 WebSocket 和 `scanner.tradingview.com` | K 线（[tradingview_feed.js](../server/tradingview_feed.js)）、稳定币市值 STABLE.C（[ssro_fetcher.js](../server/ssro_fetcher.js)） | 非公开 WebSocket，伪造 Origin | 官方支持文章明确禁止脚本、API、抓取等一切自动化采集 | ✗ | ✗ | ✗ | K 线直接用交易所 API；稳定币市值用 DefiLlama 或 CoinGecko。注意：`lightweight-charts` 库本身是 Apache-2.0 开源，可以继续用，但要保留它的署名要求 |
| **Yahoo Finance** `query1` | ETF 成交额、MSTR 和优先股价格、宏观（[leverage_norm.js](../server/leverage_norm.js)、[macro_fetcher.js](../server/macro_fetcher.js)、`mstr_*`、`analyst_agent`） | 非官方内部接口，官方公开 API 已在多年前停掉 | Yahoo 条款：未经书面许可不得用 API 牟利或做商业用途；接口随时可能被封 | △ | △ | ✗ | 收费前换成付费数据源，或改用券商 API（如 IBKR）的行情。个人研究可以继续用，但要接受随时断供 |

### 🟠 官方接口，但限个人使用或需授权才能再分发

| 来源 | 用在哪里 | 接入方式 | 条款要点 | 自营 | 免费公开看板 | 收费产品 | 动作 |
|---|---|---|---|:-:|:-:|:-:|---|
| **Deribit** | 基差期限结构、期权链、OI 历史、大宗与聪明钱账本、做市商敞口、交割价（[basis_fetcher.js](../server/basis_fetcher.js)、`option_*`、[block_insight.js](../server/block_insight.js) 等） | 官方公开 REST | 会员条款第 2.10 条写明，市场数据和衍生数据仅限个人使用；没找到公开的商用或再分发授权渠道 | ✓ | △ | ✗ | 收费产品只展示结论，不展示原始或逐笔数据；或向 Deribit 书面申请，或改从有授权的数据商采购（Tardis、Amberdata 等）。**这是期权和基差两条主线的核心数据源，影响最大** |
| **Coinbase Exchange** | L2 盘口深度和小时历史、现货日线、Flow Force（[coinbase_fetcher.js](../server/coinbase_fetcher.js)、[liquidity_history.js](../server/liquidity_history.js)、[spot_daily.js](../server/spot_daily.js)） | 官方公开 REST | 市场数据条款保留一切未明确授予的权利，并限制把行情做成基准指数；再分发要通过授权伙伴（如 Amberdata）；旧版条款明确禁止向第三方分发基于行情的图表和分析 | ✓ | △ | ✗ | 盘口历史不对外提供；收费产品只用作内部指标，比如"美国现货流动性状况"；需要展示时，从授权伙伴采购 |
| **Binance**：`api`、`fapi`、`data-api.binance.vision`、`data.binance.vision` | K 线、资金费、波浪引擎、Flow Force、现货日线备用 | 官方公开 REST，加 Vision 历史数据包 | Vision 条款写明商用一律排除，必须另签企业数据授权；公开 REST 没有成文的商用政策（只有论坛里的非正式说法） | ✓ | △ | ✗ | 收费产品不用 Vision 数据包；公开 REST 的数据只用于内部计算 |
| **DefiLlama**：`stablecoins.llama.fi`、`api.llama.fi` | 稳定币供给（SSRO）、McClellan 配置 | 官方免费 API | 站点许可是"个人、非商业"；商用要走 Pro API | ✓ | △ | ✗ | 收费前升级 Pro API |
| **strategy.com** | MSTR 持仓账本、股本、债务、优先股、公告（[mstr_disclosures.js](../server/mstr_disclosures.js)） | 网页和内部 JSON 抓取，已经遇到 Akamai 403 | 条款保留监控、终止访问和追责的权利；没找到明确的爬虫条款（待核） | ✓ | △ | △ | 披露里的事实（持仓数量、股数）本身不受版权保护，但要从干净的渠道取：**优先走 SEC 8-K 路径**（已实现），官网降为可选 |
| **bitcointreasuries.net** | Strategy 持仓快照（[macro_fetcher.js](../server/macro_fetcher.js)） | 网页抓取 | 服务条款里没查到数据或 API 授权条款（待核） | ✓ | △ | ✗ | 已有 SEC 和官网的数据，这个来源可以去掉 |
| **OKX** | 现货日线备用、Flow Force | 官方公开 REST | API 协议适用于不需要 Key 的公开行情，其中第 9 节对市场数据有专门限制（原文待核） | ✓ | △ | ⚪ | 读完第 9 节原文再定 |
| **Bybit** | K 线备用（`index.js`） | 官方公开 REST | 待核 | ✓ | △ | ⚪ | 待核 |

### 🟡 允许商用，但有条件

| 来源 | 用在哪里 | 条款要点 | 自营 | 免费公开看板 | 收费产品 | 动作 |
|---|---|---|:-:|:-:|:-:|---|
| **CoinGecko**（免费的 keyless 或 Demo 档） | McClellan Core 轨成分池和市值（`scripts/crypto_mcclellan`） | 免费档要求署名；付费档才有商用授权（可以拿数据做收费产品），但所有档位都不得转售或再分发 API 访问本身 | ✓ | ✓ 需署名 | △ 需付费档 | 页面加上"Powered by CoinGecko"；收费前升级到付费档 |
| **GeckoTerminal** | McClellan 链上 Meme 轨 | 免费 API，展示时要求署名；生产和商用场景官方建议改用付费档 | ✓ | ✓ 需署名 | △ 需付费档 | 同上，署名"Powered by GeckoTerminal" |
| **DexScreener** | McClellan 配置 | 官方条款允许商用和非商用，但授权有限、可撤销；第三方说条款禁止拿它做竞品（待核） | ✓ | ✓ | △ | 读完限制条款原文 |
| **Hyperliquid** 公开 Info API | OI、资金费（[flow_force.js](../server/flow_force.js)、[leverage_norm.js](../server/leverage_norm.js)） | 没找到官方 API 使用条款（待核） | ✓ | △ | ⚪ | 待核 |

### 🟢 政府 / 公共领域 / 开源

| 来源 | 用在哪里 | 条款要点 | 动作 |
|---|---|---|---|
| **FRED** | DGS3MO、DGS10、DGS1、WALCL、TGA、RRP | 版权按系列区分：公共领域系列可以商用和展示，注明 FRED 和原始来源即可；标了 Copyright 的系列，个人使用以外都要找原所有者授权 | 逐个系列打开页面看版权标注；美债收益率一般是美国政府作品，但要以系列页面的标注为准 |
| **SEC EDGAR** | Strategy 8-K、XBRL | 公共数据；公平访问规则：所有机器合计不超过 10 次/秒，必须声明带联系方式的 User-Agent | ✓ 代码已强制 `SEC_USER_AGENT` 包含邮箱 |
| **CFTC** 公开报告 | TFF 持仓（[etf_linkage_engine.js](../server/etf_linkage_engine.js)） | 美国政府数据，一般属于公共领域 | 注明来源 |
| **美国财政部 Fiscal Data** | analyst_agent 数据层 | 美国政府数据 | 注明来源 |
| **馆藏图片**：Met、Barnes、Wikimedia（Google Art Project） | 艺术图（[atelier.js](../public/atelier.js)） | Met 开放获取的公共领域图片可以任意使用，包括商用；Barnes 的公共领域作品开放下载；Wikimedia 的同类文件一般标为 PD-Art | 逐件打开对应页面，核对权利声明 |
| **前端库和字体**：Chart.js（MIT）、lightweight-charts（Apache-2.0）、Google Fonts（多为 OFL） | 前端 | 开源许可 | 保留各自的许可声明；lightweight-charts 有署名要求 |
| newhedge.io | 只作为外部链接 | 不取数据 | — |

`openmarket/*.ts` 是挂在第三方图表平台上的指标脚本，数据由那个平台提供，受该平台自己的许可约束，不在本台账范围内。

---

## 当前的暴露面（与商业化无关，现在就存在）

### 1. 公开 GitHub 仓库（`Bigdydydy/BIGDY-CRY-PTO-Dashboard`，PUBLIC）

已提交的第三方原始或衍生数据档案。服务端会从 `raw.githubusercontent.com` 回读这些文件，所以任何人也都能直接下载：

| 文件 | 来源 | 等级 |
|---|---|---|
| `data/coinbase_liquidity.json`、`data/coinbase_liquidity_history.json` | Coinbase L2 | 🟠 |
| `data/block_trades_BTC.json`、`data/smart_money_BTC.json`、`data/option_flow_ledger_BTC.json` | Deribit 大宗（部分来自 Greeks.live） | 🟠/🔴 |
| `data/option_oi_history_BTC.json`、`data/dealer_exposure_history_BTC.json` | Deribit | 🟠 |
| `data/cdri_data.json` | CoinGlass 内部接口 | 🔴 |

已提交的逆向代码：[crypto_signer.js](../server/crypto_signer.js)（Greeks.live 签名）、[cdri_fetcher.js](../server/cdri_fetcher.js)（CoinGlass 解密）。

### 2. 线上站点的 API

`server/index.js` 给所有 JSON 响应都加了 `Access-Control-Allow-Origin: *`。对外开放的路径包括 `/api/market-data`（Greeks.live）、`/api/cdri`（CoinGlass）、`/api/coinbase-liquidity-history`、`/api/term-premium`（Deribit）、`/api/block-insight`、`/api/option-marks` 等。任何第三方网站都能在浏览器里直接调用，等于免费替这些数据做了再分发。

### 3. 许可声明

README 写着"本项目采用 MIT License"并链接到 `LICENSE`，但这个文件不存在。即使补上，MIT 也只能覆盖你自己写的代码，不能覆盖 `data/` 下的第三方数据；不写清楚，反而容易让人误以为这些数据可以自由使用。

---

## 行动清单

### P0：现在做（不论是否商业化）

- [ ] 补 `LICENSE`（MIT，仅限代码），在 README 写明：`data/` 和 API 输出包含第三方行情数据，各自受原始来源条款约束，**不在 MIT 授权范围内**。
- [ ] 把 `/api/*` 的跨域改为只允许同源，或者白名单，去掉 `*`。
- [ ] 决定仓库要不要转私有。转私有能阻止新增暴露，但已经被克隆、被镜像的历史版本收不回来。如果保持公开，至少把 🔴 档案和逆向代码移到私有仓库或私有存储。
- [ ] 给 CoinGecko 和 GeckoTerminal 的数据加上署名。

### P1：替换红色来源（自营也受益：减少断供风险）

- [ ] Greeks.live → 用 Deribit 公开数据自算（经验总结 2.6 已经在推进）。
- [ ] CoinGlass 内部接口 → 官方 API 付费档，或者用多家交易所的公开数据自算 OI 加权资金费。
- [ ] TradingView WebSocket 和 scanner → 交易所 API，稳定币市值改用 DefiLlama。
- [ ] Yahoo `query1` → 准备一个付费或券商替代源。

### P2：开始收费之前

- [ ] 收费产品只展示**结论和信号**（比如"carry 低于美债，空仓"），不展示原始行情、盘口历史、逐笔大宗。
- [ ] 确实需要展示行情的地方，从有授权的数据商采购（Deribit、Coinbase、OKX 都有授权数据商覆盖），或向交易所书面申请。
- [ ] 把所有 ⚪ 待核项补齐：OKX 第 9 节、Bybit、Hyperliquid、DexScreener 的限制条款、strategy.com、bitcointreasuries。
- [ ] 请律师审阅 🔴、🟠 来源的条款原文，以及你所在地区对收费投资内容的牌照要求。

---

## 来源

- [Deribit Exchange Membership Terms](https://support.deribit.com/hc/en-us/articles/25944532191645-Deribit-Exchange-Membership-Terms-Deribit-FZE) · [Deribit 2021 条款更新](https://insights.deribit.com/exchange-updates/deribit-updates-terms-of-service-as-of-29-january-2021/) · [Deribit API usage policy](https://docs.deribit.com/articles/api-usage-policy)
- [Coinbase Market Data Terms](https://Www.coinbase.com/legal/market_data) · [Coinbase Pro 旧版条款（tosdr）](https://edit.tosdr.org/documents/1404) · [Amberdata × Coinbase 授权再分发](https://blog.amberdata.io/amberdata-announces-authorized-redistribution-partnership-with-coinbase) · [Coinbase Institutional Market Data](https://www.coinbase.com/institutional/market-data)
- [Binance Vision Terms of Use](https://data.binance.vision/Binance_Vision-Terms_of_Use.pdf) · [Binance 开发者论坛：公开 API 商用](https://dev.binance.vision/t/public-rest-api-for-commercial-use-case/23067)
- [OKX API Agreement](https://www.okx.com/en-us/help/okx-api-agreement)
- [CoinGlass API Plans](https://coinglass.com/pricing) · [CoinGlass API review 2026](https://dev.to/great-time-flies/coinglass-api-review-2026-is-it-worth-it-for-crypto-quant-traders-2bcf)
- [TradingView：因可疑活动封号说明](https://www.tradingview.com/support/solutions/43000674726-why-is-my-account-banned-due-to-suspicious-activity/) · [TradingView Policies](https://in.tradingview.com/policies)
- [Yahoo Terms of Service](https://legal.yahoo.com/xw/en/yahoo/terms/otos/index.html) · [Yahoo Developer Network Guidelines](https://legal.yahoo.com/us/en/yahoo/guidelines/ydn/index.html) · [yfinance README](https://cdn.jsdelivr.net/gh/ranaroussi/yfinance@main/README.md)
- [CoinGecko API Pricing](https://www.coingecko.com/en/api/pricing) · [CoinGecko API Terms](https://Coingecko.com/en/api_terms) · [CoinGecko keyless API](https://docs.coingecko.com/docs/keyless-public-api) · [CoinGecko 署名指南](https://brand.coingecko.com/resources/attribution-guide) · [GeckoTerminal API Guide](https://apiguide.geckoterminal.com/)
- [DexScreener API Terms](https://docs.dexscreener.com/api/api-terms-and-conditions) · [CoinGecko 对 DexScreener API 的比较](https://www.coingecko.com/learn/coingecko-api-vs-dexscreener-api)
- [DefiLlama Terms](https://defillama.com/terms) · [DefiLlama llms-full](https://defillama.com/llms-full.txt)
- [FRED Legal / Terms](https://fred.stlouisfed.org/legal) · [FRED API Terms of Use](https://fred.stlouisfed.org/docs/api/terms_of_use.html)
- [SEC：Accessing EDGAR Data](https://www.sec.gov/os/accessing-edgar-data) · [SEC 访问频率限制公告](https://www.sec.gov/oit/announcement/new-rate-control-limits)
- [Strategy Terms of Use](https://www.strategy.com/legal/terms-of-use) · [BitcoinTreasuries Terms](https://bitcointreasuries.net/terms-of-service)
- [Barnes：Open access and copyright](https://barnesfoundation.org/collection/open-access-and-copyright) · [Barnes 开放获取报道（Artnet）](https://news.artnet.com/art-world/barnes-foundation-open-access-1134467)
- [Chainstack：Hyperliquid legalCheck](https://docs.chainstack.com/reference/hyperliquid-info-legal-check)
