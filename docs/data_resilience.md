# 数据源韧性与健康监测说明

本文档说明各视图的数据来源、健康判定口径、缓存回退行为以及生产级监测方案。目标是：**任何模块都不能把过期的、备用源的或未核验的数据伪装成新鲜数据呈现给用户**。

## 1. 健康状态机

每个数据源（source id）的健康由 `server/data_health.js` 登记、`server/data_health_policy.js` 的时间窗判定：

| 状态 | 含义 |
|---|---|
| `OK` | 本次有真实成功回执，且数据日期与回执都在策略窗口内 |
| `FALLBACK` | 数据可用，但来自磁盘种子（`source:'disk'`）、备用源或带告警的成功 |
| `STALE` | 超出警告窗口但未过阻断窗时可带提示使用；超过阻断窗后只可浏览历史 |
| `UNAVAILABLE` | 有记录的失败且无可验证数据 |
| `UNKNOWN` | 从未核验过：没有有效回执。新部署的冷启动模块都从这里开始 |

聚合状态：`OK` → `DEGRADED` → `UNAVAILABLE` / `UNKNOWN`。**required 源任一不可用即 `analysisAllowed=false`**，该模块的实时结论被锁定（API 返回 `data_unavailable`，UI 隐藏当前结论并显示暂停原因），历史曲线仍可浏览。

## 2. 时钟口径（重要）

- `lastSuccessAt`：一次**真实成功回执**的时刻（fetch 成功 + schema 校验通过），不是 GET 请求时刻。
- `dataAsOf`：数据内容自身的日期（最后一根 K 线的开盘时刻、最后一个交易日等），**不是读取时刻**，也不泛指 `generated_at`——McClellan 的 `dataAsOf` 是 track `date`，`generated_at` 只作为产物回执。
- `asOfKind`：`'source'` 表示 dataAsOf 来自真实观测日（如 GitHub 归档中确有观测数据）；`'received'` 只表示一个真实接收/检查时刻（如事件归档的 producer check 回执），不作为数据内容日期的证明。
- `FALLBACK` 的判定依据是 `source:'disk'` 的种子来源标记，不是 `asOfKind`。Greeks ATM/trades/smile 等没有 provider 时钟的来源只要回执与数据新鲜照常可以是 `OK`。
- 失败只推进 `lastAttemptAt`/`lastError`，**不推进** `lastSuccessAt`/`dataAsOf`。5 分钟未来时钟偏差上限适用于所有显式时间戳。

## 3. 各视图数据源与回退

HTTP 公共默认值：`fetchWithTimeout` 为 **10s 超时 / retries 1**（总计最多 2 次 attempt）；各模块在此基础上按源收紧。

| 视图 | 必需源 (required) | 超时/重试 | 缓存回退 |
|---|---|---|---|
| ATM IV / 偏度 | `greeks_atm`, `greeks_iv_history`, `deribit_dvol` | 默认 10s/1 | 有效窗内带告警可用；超阻断窗或未核验时锁定当前结论 |
| GEX | `greeks_gex` | 默认 10s/1 | 同上 |
| 大宗成交 | `greeks_trades`, `greeks_gex` | 默认 10s/1 | 同上 |
| 25Δ Skew | `greeks_skew`, `greeks_atm`, `greeks_iv_history`, `deribit_dvol` | 默认 10s/1 | 同上 |
| IV Smile | `greeks_smile`, `greeks_gex` | 默认 10s/1 | 同上 |
| 期限溢价 | `basis_live`, `basis_history`, `fred:DGS3MO` | Deribit 20s/1（带 429 队列） | bare-array 历史保留，sidecar 回执核验 |
| 波浪 K 线 | 主周期 + 每个画图周期 | 8s / retries 0（单源预算内） | Binance→Bybit→OKX 备用源标记 `FALLBACK` |
| 宏观图 | `macro`, `fred:*`, `macro_btc`, `yahoo:MSTR` | 各 leaf 默认 10s/1 | 快照回退，缺源 UNKNOWN |
| 优先股 | `preferreds`, `yahoo:STR*`, `fred:DGS1MO` | 各 leaf 默认 10s/1 | 任一脚失败 → 完整 payload 回退，文件字节不变 |
| McClellan 宽度 | `mcclellan_core`, `mcclellan_frontier` | Python 管线（CI） | 磁盘快照 + track `date` 时钟 |
| CDRI / SSRO / 黄金 | `cdri`, `ssro`, `ssro_stable`, `ssro_quote`, `gold` | SSRO 12s/1，现货日线 `spot_daily` 12s/1，其余默认 | 单飞 + last-good 缓存 |
| ETF 联动 | `etf`, `cot`, `etf_oi` | CFTC 20s/1，其余默认 10s/1 | 同上 |
| Coinbase 深度/成交流 | `coinbase`, `flow:*`, `liquidity_history` | Coinbase REST 默认 10s/1；GitHub raw 归档 8s/0 | 同上 |
| Option marks / OI 历史 | `option_marks`, `oi_history` | marks 8s/1；raw 归档 8s/0 | 同上 |
| Block Insight | `block_flow`, `smart_money`（GitHub 归档） | raw 归档 8s/0；交割价 8s/1 | producer 回执核验 |

### 阈值表（冻结自 `data_health_policy.js` / `getSourcePolicy`）

| 源 | 回执 warn / block | 数据 warn / block |
|---|---|---|
| Greeks live（`greeks_atm`/`greeks_trades`/`greeks_gex`/`greeks_smile`/`basis_live`/`ssro_quote`） | 3min / 15min | 3min / 15min |
| `greeks_iv_history`, `greeks_skew` | 3min / 15min | 3d / 7d |
| `coinbase`, `option_marks` | 1min / 5min | 1min / 5min |
| `deribit_dvol` | 30min / 6h | 3d / 7d |
| `cdri`, `ssro`, `gold`, `macro_btc`, `ssro_stable`, `coinbase_candles`（DAILY_LIVE） | 30min / 6h | 3d / 7d |
| `fred:*`（日频，含 `DGS1/DGS10/DGS1MO/DGS3MO/RRPONTSYD`）、`yahoo:MSTR` | 30min / 6h | 5d / 14d |
| `fred:WALCL`, `fred:WTREGEN`（周频）、`macro` 聚合 | 30min / 6h | 10d / 30d |
| `preferreds`, `yahoo:STRC/STRF/STRD` | 30min / 6h | 5d / 14d |
| `basis_history`, `oi_history`（ARCHIVE） | 2h / 1d | 3d / 7d |
| `liquidity_history` | 30min / 6h | 3h / 1d |
| `etf`（COT `cot`） / `etf_oi` | 12h / 3d | 5d/14d（COT 12d/21d；`etf_oi` 3d/7d） |
| `mcclellan_core`, `mcclellan_frontier`, `mcclellan_anchor` | 2d / 7d | 2d / 7d |
| `block_flow`, `smart_money`（producer check） | 2h / 1d | 36h / 3d |
| `mstr_cost`, `mstr_treasury` | 30min / 6h | 30min / 6h |
| `wave:<symbol>:<tf>:<tier>` | 3min / max(15min, 3×warn) | `<tf 步长>+3min` / `2×步长+15min` |
| `flow:<...>:<tf>` | `FLOW_FETCH_WARN_MS[tf]`（15m:3min，1h:5min，4h:10min，1d:20min，1w:30min） / max(15min, 3×warn) | 同 wave 公式 |

Producer job 窗口（`JOB_POLICIES`）：`macro_snapshot` 8h/1d；`liquidity_hourly` 3h/1d；`block_insight_daily` 36h/3d；`mcclellan_daily` 36h/3d。

### 周期宽限

- 日级数据（McClellan、每日归档）：窗口以「日」计，收盘/交割节奏内不算过期。
- 周频 FRED（WALCL/WTREGEN）等有更长的数据窗口。**不声明按交易日历自动排除假期**——实际是窗口本身给出的自然时间宽限；长假超出数据窗口即如实变 STALE。
- 缓存**不是一见就禁**：仅当 required 源 `usable`（未过 block 窗、有有效回执）时仍允许当前分析（过期警告会标注）；`UNKNOWN`（无回执）或超阻断窗才禁用实时结论，历史数据仍可浏览。

## 4. 监测覆盖

`server/data_health_monitor.js` + `data_health_monitor_policy.js`（纯求值，无 IO）：

- **19 个 live 模块**（`MONITOR_LIVE_MODULES`）——与 `/api/system/audit` 返回的模块 id 一致。
- **4 个 producer job**（`MONITOR_JOBS`）：`macro_snapshot`、`liquidity_hourly`、`block_insight_daily`、`mcclellan_daily`，各写 `data/job_health_<id>.json` 心跳。
- **8 类归档检查**（`SNAPSHOT_CHECKS`）：
  - `source_metadata`：归档 JSON 内嵌 `dataHealth.sources[*]` 的实际回执/数据日期。
  - `sample_times`：样本数组最新 `ts`。
  - `breadth_track`：McClellan 每 track 的 `date`/`ready`/`*_n` 源行。
  - `event_archive`：用 **producer step 回执**判定（事件空窗合法，不是停更）。

监测合约：未来时钟偏差上限 5min；live 检查 15s 超时 / 0 重试；webhook 10s / 0 重试；调度 `49 * * * *`（每小时）；缺心跳或缺 live URL → `UNKNOWN`；warn → `DEGRADED`；超 block → `CRITICAL`。

## 5. producer 心跳语义

`server/pipeline_health.js`（纯遥测，原子写）：

- `beginJob`：保留旧 `lastSuccessAt`，推进 `lastAttemptAt`。
- `recordStep`：成功/verifiedSkip 推进 step 回执；失败沿用上一 run 的 step 回执。
- `finishJob`：全部 expected step ok → `ok`（job 回执推进）；≥1 ok → `partial`；0 → `failed`（保留旧回执）。心跳写失败返回 null，调用方必须按非零退出处理。
- 失败 run 仍写心跳（包含 `lastError`），档案数据字节不变。

心跳检查在固定步骤上：`macro_snapshot: [macro, preferreds]`、`liquidity_hourly: [samples]`、`block_insight_daily: [option_oi, block_trades, marks]`、`mcclellan_daily: [pipeline]`。

**`block_flow`/`smart_money` 归档**额外在文件顶层嵌 `producerHealth`（`lastAttemptAt`/`lastSuccessAt`/`lastError`/`status`）：这是 producer check 的回执，**不是最后成交日**。服务器读 GitHub raw 归档时以它作 `dataAsOf`（`asOfKind:'received'`，`source:'github-archive/producer-check'`）；无 `producerHealth` 的 legacy 归档永远 UNKNOWN，不能拿下载时间或 last trade 伪绿。真实最后成交/盯市日期仍在 payload 原字段展示。

## 6. 部署与运行方式

- **每小时** `data_health.yml`：checkout main → `node scripts/data_health_check.js --output $RUNNER_TEMP/data-health-report.json` → 上传 artifact → 失败时可选 webhook。要启用定时运行，schedule 必须出现在 **default branch** 上且 Actions 已启用。
- **`DASHBOARD_HEALTH_URL`**（vars）：设为线上完整路径 `https://<host>/api/system/health`（`/api/system/audit` 同样可作为检查目标）；仅 https（测试允许 loopback http），不允许内嵌凭证。未设置时 `live_dashboard` 为 `UNKNOWN`，**不宣称线上健康**。检查本身是只读 GET，不主动拉取全部外部来源。
- **`DATA_HEALTH_WEBHOOK_URL`**（secrets）：可选；未设置脚本打印 `webhook not configured` 退出 0，不假装告警已启用。已配置但发送失败时退出 1。GitHub 自身的失败邮件通知取决于账户通知设置，与本 webhook 无关。
- **`GET /api/system/health`**：只读 `/api/system/audit` 同源汇总 + `scope:'live-source-observations'`；UNKNOWN/CRITICAL → 503，其余 200（DEGRADED 不报 HEALTHY）。不探针、不刷新、不唤醒 idle 刷新器。**按需访问的模块未被核验时是 UNKNOWN——健康检查本身不会热启动行情**，运行时延迟内的模块仍如实 UNKNOWN。cron CLI 独立读最新归档核实 jobs；server 路由不把部署时的旧 job 副本当实时任务状态。
- **副作用文件**：`data/term_premium_history.health.json`（sidecar 回执）、`data/job_health_*.json`（workflow 提交）、`*.local.json`（本地补采）已在 `.gitignore`/workflow `git add` 中明确区分。

## 7. 停更检测口径与限制

- 实时源：按 `dataAsOf`（真实数据日期），不是文件 mtime。
- 采样归档（深度/OI）：按数组最新 `ts`。
- 事件归档：按 producer step 回执（空窗合法）。
- 宽度数据：按 track `date` 与 `*_n` 源行；旧 artifact 改 `generated_at` 不会变绿（数据日期不动）。
- **无心跳的旧文件是 UNKNOWN，不是故障**——明确「未核验」与「确认失败」的区别。
- **已知限制**：对完全没有 provider 时钟、也不产生归档回执的来源，「静默停更」只能识别到「最后已知数据日期不再前进」这一层面；无法 100% 区分「来源真停发」与「行情无变化」，健康结论如实反映可核验的部分。

## 8. Troubleshooting: live_dashboard UNKNOWN (English)

If the Data Source Health Monitor report shows every local job and artifact
HEALTHY but `live_dashboard` UNKNOWN with reason
`Live dashboard audit URL not configured`, live monitoring is not configured.
This is a configuration gap, not a confirmed upstream outage. Other UNKNOWN
reasons, such as an invalid audit response, require different investigation.
Fail-closed is preserved on purpose: the check exits non-zero until live
coverage is actually verified, so the gate keeps failing until then.

To configure it:

1. In this repository, open Settings > Secrets and variables > Actions >
   Variables and create `DASHBOARD_HEALTH_URL` with the full deployed audit
   endpoint, for example `https://<deployed-host>/api/system/health`.
   An Actions secret of the same name is also supported; the variable takes
   precedence when both exist.
2. Repository variables are not environment variables automatically — the
   workflow maps this name into the check step's env, so the name must match
   exactly.
3. Use the public deployment's API endpoint. Do not use `/healthz`, a GitHub
   Pages URL, or a localhost address on your own PC. Do not infer a
   `*.onrender.com` hostname from the service name in render.yaml — use the
   real deployed URL.
4. Re-run the Data Source Health Monitor workflow manually after setting it;
   missing live coverage continues to fail the health gate until the endpoint
   responds with a valid audit report.

Notes:

- Node 20 action deprecation warnings and `ubuntu-latest` migration notices
  are unrelated to this failure. This monitor workflow uses Node 24 actions
  and runtime on `ubuntu-24.04`; other workflows are untouched.
- The monitoring health URL performs a read-only GET. It does not refresh or
  wake idle modules, so `live_dashboard` may remain UNKNOWN until the audited
  deployment holds genuine source observations.
- This change documents the configuration only — it does not set GitHub
  variables or secrets and does not verify any deployment.
