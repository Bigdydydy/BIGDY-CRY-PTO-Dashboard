# Module 2 数据获取检查

检查时间：2026-11-14 16:16–16:22（北京时间）。线上实例：https://bigdy-cry-pto-dashboard-3.onrender.com 。检查线上响应、直接上游响应、本地获取与转发路径，以及相关计算和回归测试；未部署。

## 当前结果

- `/api/term-premium`：HTTP 200，健康状态 OK；实时基差和日历史到 11 月 14 日，3M 美债到 11 月 12 日。历史与实时合计 1049 行。
- `/api/term-curve`：HTTP 200，当日实时曲线有 6 个期限点；1 周、1 月、3 月前的对比曲线各有 6 点。发现 OI 单位错误，见修复说明。
- `/api/etf-linkage`：HTTP 200；ETF 流量到 11 月 13 日，COT 到 11 月 3 日，OI 到 11 月 14 日，构建时的基差历史到 11 月 13 日。147 个已对齐周（2024-01-16 至 2026-11-03）、1047 条 OI 日记录；最近 10 条 Binance/Deribit/离岸 OI 币数量字段均为有限数。最近 4 个完整 COT 周各含 5 个 ETF 流量日。
- `/api/leverage-norm`：HTTP 200，健康状态 OK，ETF 子源无报错；OI 到 11 月 14 日，已结算资金费日记录到 11 月 13 日，ETF 流量及成交额到 11 月 13 日。

## ETF × 套利资金联动的重点发现

1. **COT 没有漏更。** CFTC 官方 2026 日历将 11 月 13 日发布顺延至美国日期 11 月 16 日；发布时间为美国东部时间 15:30，即北京时间 11 月 17 日 04:30。11 月 10 日持仓仍应等待发布，当前可用 11 月 3 日数据合理。待确认的 ETF 流量已进入 pendingWeeks，未混入回归和累计拆分。
2. **线上 DEGRADED 是无关实时源触发。** ETF/COT/OI 三个必需源均 OK；六小时缓存携带的 basis_live 时钟超过 15 分钟就会触发降级，而周度计算仅使用 basis_history。
3. **本机直连 CFTC 被拒绝。** 实测 publicreporting.cftc.gov 返回 HTTP 403；线上响应记录其最近成功获取且无错误。本机强制构建失败后已成功采用线上镜像，ETF/COT/OI 日期与线上一致。该网络限制仍存在，本次未尝试绕过。
4. 页面把所有 COT 待发布日期写成“周五”，并把这次日期算成 11 月 13 日，属于发布日历提示错误。

## 本地修复

- `server/etf_linkage_engine.js`：移除未参与周度计算的 basis_live 健康依赖；保留 basis_history。按官方日历补充 2026 年六次假期顺延，普通周仍按周五计算。该例外表只覆盖官方已核实的 2026 年，未来日历需维护。
- `public/app.js`：发布提示明确为美国日期，并去掉固定“周五”。
- `server/term_curve.js`：Deribit BTC 反向期货的 open_interest 本来就是 USD，移除重复乘 BTC 指数。实测 BTC-25DEC26 上游为 $265,446,350，本地修复后保持该金额；线上旧逻辑会放大约 6.7 万倍。该修复影响期限曲线 OI 字段，不改变 CoinGlass 联动 OI 或基差 APR。
- `test/analytics.test.js`、`test/source_payloads.test.js`：纠正原有错误单位夹具，覆盖假期发布、普通发布周和实时曲线过期不影响周度联动；同时修正镜像测试可能生成未来日期的问题。

验证：相关测试 130/130，通过；全量 `npm test` 680/680，通过。已有工作区其他改动保留。线上仍运行修复前代码，缓存的日期提示也需在重新构建后更新。

## 来源与证据

- CFTC 官方发布日历：https://www.cftc.gov/MarketReports/CommitmentsofTraders/ReleaseSchedule/index.htm
- Deribit 官方接口说明（反向期货 OI 单位 USD）：https://docs.deribit.com/api-reference/market-data/public-get_book_summary_by_currency
- 直接核对 CoinGlass `/api/etf/flow` 与 Deribit `/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=future`。
- 原始接口响应保存在本机临时目录 `module2-check-20261114`；它们是本次检查快照，不代表未来状态。

本次验证数据传输、时效、字段和计算实现；不把相关性或空头匹配量解释成已识别的机构套利实际资金。
