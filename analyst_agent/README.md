# 双视角宏观策略评论 agent

把两位作者的研究方法论合并成一个 agent，接入公开数据源，生成每周宏观评论和带证伪条件的交易观点。**本地自用**：由 Claude Code 会话按 [AGENT.md](AGENT.md) 扮演 agent（文章点评、周报、单点问答、复盘），不对外部署。

- **视角 A**：Esther Substack（2024–2026，291 篇，中文）。美国宏观 → 利率 → 风险资产 → 执行。
- **视角 B**：Robin Brooks Substack（2026，288 篇，英文）。全球宏观 → 外汇 → 主权债务。

## 分层与进度

| 层 | 内容 | 状态 |
|---|---|---|
| 1. 方法论层 | 两个视角的框架、合成规则、输出规范、系统提示词 | ✅ v0.2（双视角） |
| 2. 数据层 | FRED + Yahoo + 美国财政部 → 85 个指标的快照；OpenMarket 运行时补充；人工输入 | ✅ v0.1（80/85 自动获取） |
| 3. 检索层 | 两份语料按日期、资产、维度打标签，用于"相似情形"参考 | 未开始 |
| 4. 评估层 | 观点台账抽取 → 回测两位作者 → 按时间顺序考 agent | 台账已建（`ledger/views.jsonl`，agent 每次给观点时追加）；回测未开始 |
| 5. 运行方式 | Claude Code 会话按 AGENT.md 运行 | ✅ |

## 文件

- [AGENT.md](AGENT.md)：运行手册（数据准备、四种模式、观点台账、硬性规则）
- `ledger/views.jsonl`：观点台账

**方法论** `methodology/`
- [framework.md](methodology/framework.md)：视角 A，10 步分析流程、决策权重、宏观体制 R1–R4、清单、资产规则
- [brooks_lens.md](methodology/brooks_lens.md)：视角 B，利差模型、主权债务、油价弹性模型、EM 分化、贬值交易
- [comparison.md](methodology/comparison.md)：两人方法论的异同，以及 2026 年的直接分歧案例
- [synthesis.md](methodology/synthesis.md)：合并后的分析流程、按问题类型的主次分工、裁决规则
- [output_spec.md](methodology/output_spec.md)：评论结构、交叉检验表、交易观点 YAML 格式
- [indicators.json](methodology/indicators.json)：85 个指标（视角 A 35、视角 B 31、共用 19），每个都有数据源、计算方式和解读规则

**提示词** `prompts/`
- [system_prompt.md](prompts/system_prompt.md)：合并版系统提示词

**数据层** `data_layer/`
- [assessment.md](data_layer/assessment.md)：OpenMarket 评估和数据源实测
- `fetch_snapshot.js`：命令行入口
- `lib/providers.js`：FRED / Yahoo / 财政部拉取，带磁盘缓存
- `lib/transforms.js`：变化量、均线、分位数、同比、相关性、曲线形态、远期利率、油价隐含中断等纯函数
- `lib/snapshot.js`：按注册表拉数据、按 asof 截断、计算变换、标记过期数据
- `analysis_params.json`：关键位（防线）和油价模型参数，每期评论后人工复核
- 测试：`test/analyst_snapshot.test.js`（16 个用例，`npm test` 一起跑）

## 生成快照

```bash
node analyst_agent/data_layer/fetch_snapshot.js
```

```bash
node analyst_agent/data_layer/fetch_snapshot.js --asof 2026-09-25 --event 2026-02-27
```

- `--asof`：历史日期，所有序列都在这天截断，没有前视偏差（但 FRED 是当前版本数据，就业等会修订的序列含事后修订）
- `--event`：计算"自某事件以来"的变化（比如战争开始、议息会议）
- `--lens esther` / `--lens brooks`：只拉某个视角的指标
- 输出 `data_layer/snapshots/<日期>.json`（完整）和 `.md`（给提示词用的紧凑表格）；`cache/` 和 `snapshots/` 已加入 .gitignore

**数据校验**：拿 2026-09-25 的快照和 Esther 9/27 那篇文章核对，下面几项都对得上：

- 10 年期 5.17%；
- 自 2/27 以来涨幅约九成来自实际利率；
- MOVE 在 9/22–9/24 两天涨了 33%；
- 5 年期拍卖美联储接了约 15%。

实际利率水平比她文中低约 15bp（FRED 的 DFII10 与她的数据源口径不同）。

## 下一步

1. 端到端试跑：用 2026-09-25 的快照 + 系统提示词写一篇评论，和两位作者同周的原文对比
2. 观点台账：从两份语料里抽取所有可识别的观点（尤其是 comparison.md 里的分歧案例），作为评估集
3. 检索层：把语料切块、打标签，供 agent 查"相似情形"
4. 补数据缺口：纽约联储 ACM 期限溢价、2y2y 远期利差、市场宽度（200 日线以上成分股比例）

## 注意

- 两份语料的付费内容只用于本地个人研究。
- agent 借鉴的是分析方法和写作结构，不冒充任何真实作者。
