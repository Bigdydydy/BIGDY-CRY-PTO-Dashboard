#!/usr/bin/env node
'use strict';
/**
 * Cash-and-carry backtest report over the archived Deribit term structure.
 *
 * Usage:
 *   node scripts/carry_backtest.js                 → writes docs/reports/carry-backtest-<last date>.{md,json}
 *   node scripts/carry_backtest.js --no-write      → summary to stdout only
 *   node scripts/carry_backtest.js --input <file>  → explicit history file
 *
 * Without --input the newer of data/term_premium_history.json and its .local.json sidecar is used
 * (the sidecar is refreshed by a running server, the committed file by CI).
 */

const fs = require('fs');
const path = require('path');
const bt = require('../server/carry_backtest');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

function loadHistory() {
  const explicit = opt('--input');
  const files = explicit ? [explicit] : ['data/term_premium_history.json', 'data/term_premium_history.local.json'];
  let best = null;
  for (const f of files) {
    const p = path.resolve(ROOT, f);
    if (!fs.existsSync(p)) continue;
    const rows = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(rows) || !rows.length) continue;
    if (!best || rows[rows.length - 1].timestamp > best.rows[best.rows.length - 1].timestamp) best = { file: f, rows };
  }
  if (!best) throw new Error('no term_premium_history file found');
  const rows = best.rows.filter(r => r.btcPrice > 0 && r.tbill != null).sort((a, b) => a.timestamp - b.timestamp);
  return { file: best.file, rows };
}

const COSTS = {
  low: { spotFeeBps: 5, futFeeBps: 2, perpFeeBps: 2, slipBps: 1, settleBps: 2.5 },
  base: bt.DEFAULT_COSTS,
  high: { spotFeeBps: 20, futFeeBps: 5, perpFeeBps: 5, slipBps: 5, settleBps: 2.5 }
};

// Hypotheses under test. Each rule is fixed in advance; the grid below shows how fragile the
// thresholds are rather than picking the best one.
const STRATEGIES = [
  { id: 'cash', label: '只持有 3M 美债', run: rows => bt.runCash(rows) },
  { id: 'q_always', label: '季度基差·常驻（到期滚动）', run: (rows, o) => bt.runQuarterly(rows, bt.ALWAYS_QUARTERLY, o) },
  { id: 'q_hurdle', label: '季度·净基差 ≥ 美债+3.5% 入场，持有到期', run: (rows, o) => bt.runQuarterly(rows, bt.hurdleRule(3.5, null), o) },
  { id: 'q_hurdle_exit', label: '季度·同上，剩余基差 < 美债 提前平仓', run: (rows, o) => bt.runQuarterly(rows, bt.hurdleRule(3.5, 0), o) },
  { id: 'q_tbill', label: '季度·净基差 ≥ 美债 入场，< 美债 平仓', run: (rows, o) => bt.runQuarterly(rows, bt.hurdleRule(0, 0), o) },
  { id: 'q_score', label: '季度·看板套利评分 ≥45 入场 / <30 平仓', run: (rows, o) => bt.runQuarterly(rows, bt.scoreRule(45, 30), o) },
  { id: 'p_always', label: '永续资金费·常驻', run: (rows, o) => bt.runPerp(rows, bt.ALWAYS_PERP, o) },
  { id: 'p_hurdle', label: '永续·7日资金费 ≥ 美债+3.5% 入场，< 美债 平仓', run: (rows, o) => bt.runPerp(rows, bt.perpRule(3.5, 0), o) }
];

const f = (v, d = 2) => (v == null || !isFinite(v) ? '—' : v.toFixed(d));
const pc = (v, d = 2) => (v == null || !isFinite(v) ? '—' : v.toFixed(d) + '%');
const sgn = (v, d = 2) => (v == null || !isFinite(v) ? '—' : (v > 0 ? '+' : '') + v.toFixed(d));

function runAll(rows, opts) {
  return STRATEGIES.map(s => {
    const res = s.run(rows, opts);
    return { id: s.id, label: s.label, res, m: bt.metrics(res), years: bt.yearlyReturns(res) };
  });
}

function mainTable(results) {
  const lines = [
    '| 策略 | 年化 | 超额(对美债) | 超额夏普 | 最大回撤 | 最差持仓内回撤 | 在场时间 | 笔数 | 平均持有(天) |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|'
  ];
  for (const r of results) {
    const m = r.m;
    lines.push(`| ${r.label} | ${pc(m.cagrPct)} | ${sgn(m.excessCagrPct)}% | ${f(m.sharpe)} | ${pc(m.maxDrawdownPct)} | ${pc(m.worstTradeDdPct)} | ${pc(m.exposurePct, 0)} | ${m.trades} | ${f(m.avgHoldDays, 0)} |`);
  }
  return lines.join('\n');
}

function yearTable(results) {
  const years = results[0].years.map(y => y.year + (y.partial ? '*' : ''));
  const lines = [`| 策略 | ${years.join(' | ')} |`, `|---|${years.map(() => '---:').join('|')}|`];
  for (const r of results) lines.push(`| ${r.label} | ${r.years.map(y => f(y.returnPct) + '%').join(' | ')} |`);
  return lines.join('\n');
}

function gridTable(rows) {
  const entries = [0, 2, 3.5, 5, 7.5];
  const exits = [{ v: null, label: '持有到期' }, { v: 0, label: '剩余 < 美债 平仓' }];
  const lines = ['| 入场门槛 (美债 + x%) | ' + exits.map(e => e.label + '：超额 / 在场').join(' | ') + ' |', '|---:|' + exits.map(() => '---:').join('|') + '|'];
  const grid = [];
  for (const en of entries) {
    const cells = exits.map(ex => {
      const m = bt.metrics(bt.runQuarterly(rows, bt.hurdleRule(en, ex.v)));
      grid.push({ entrySpread: en, exitSpread: ex.v, ...m });
      return `${sgn(m.excessCagrPct)}% / ${f(m.exposurePct, 0)}%`;
    });
    lines.push(`| ${en} | ${cells.join(' | ')} |`);
  }
  return { md: lines.join('\n'), grid };
}

function robustnessTable(rows) {
  const ids = ['q_always', 'q_hurdle', 'q_hurdle_exit', 'q_score', 'p_hurdle'];
  const scen = [
    { k: 'low', lag: 1, label: '低成本' },
    { k: 'base', lag: 1, label: '基准成本' },
    { k: 'high', lag: 1, label: '高成本' },
    { k: 'base', lag: 0, label: '基准·当日成交(无滞后)' }
  ];
  const lines = ['| 策略 | ' + scen.map(s => s.label).join(' | ') + ' |', '|---|' + scen.map(() => '---:').join('|') + '|'];
  for (const id of ids) {
    const s = STRATEGIES.find(x => x.id === id);
    const cells = scen.map(sc => sgn(bt.metrics(s.run(rows, { costs: COSTS[sc.k], lag: sc.lag })).excessCagrPct) + '%');
    lines.push(`| ${s.label} | ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}

function tradeTable(trades) {
  const lines = ['| 入场 | 出场 | 合约 | 入场年化基差 | 净年化 | 持有天数 | 收益 | 持仓内最大回撤 |', '|---|---|---|---:|---:|---:|---:|---:|'];
  for (const t of trades) {
    lines.push(`| ${t.entryDate} | ${t.exitDate}${t.open ? '（持仓中）' : ''} | ${t.contracts.join(' → ')} | ${f(t.entryApr)}% | ${f(t.entryNetApr)}% | ${t.holdDays} | ${sgn(t.returnPct)}% | ${f(t.ddPct)}% |`);
  }
  return lines.join('\n');
}

function avg(rows, key, pred = () => true) {
  const xs = rows.filter(r => r[key] != null && pred(r)).map(r => r[key]);
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
}

function regimeTable(rows) {
  const years = [...new Set(rows.map(r => r.date.slice(0, 4)))];
  const lines = ['| 年份 | 天数 | 当季年化基差 | 次季年化基差 | 永续资金费(7日) | 3M 美债 | 次季净超额 > 3.5% 的天数占比 |', '|---|---:|---:|---:|---:|---:|---:|'];
  for (const y of years) {
    const ry = rows.filter(r => r.date.startsWith(y));
    const qual = ry.filter(r => r.nqApr != null && r.nqApr - r.tbill >= 3.5).length / ry.length * 100;
    lines.push(`| ${y} | ${ry.length} | ${f(avg(ry, 'cqApr'))}% | ${f(avg(ry, 'nqApr'))}% | ${f(avg(ry, 'fundingApr'))}% | ${f(avg(ry, 'tbill'))}% | ${f(qual, 0)}% |`);
  }
  return lines.join('\n');
}

function buildReport({ file, rows }) {
  const first = rows[0].date;
  const last = rows[rows.length - 1].date;
  const results = runAll(rows, {});
  const grid = gridTable(rows);
  const main = results.find(r => r.id === 'q_hurdle');
  const c = bt.DEFAULT_COSTS;

  const md = `# 基差套利回测（BTC 期现 / 永续资金费）

> 数据：\`${file}\`，${first} → ${last}，${rows.length} 个 08:00 UTC 日快照（Deribit 季度期货 + 指数，CoinGlass/Deribit 资金费，FRED DGS3MO）。
> 代码：[server/carry_backtest.js](../../server/carry_backtest.js)（纯函数）· [scripts/carry_backtest.js](../../scripts/carry_backtest.js)（本报告）。复现：\`node scripts/carry_backtest.js\`。
> 这是研究记录，不是交易建议。

## 结论先行

${conclusions(results, rows)}

## 交易怎么建模

- **季度期现**：买现货 BTC + 卖等量 Deribit 季度期货。每对冲 1 BTC 的盈亏 = 美元基差 (F − S) 的变化，到期基差收敛为 0。展期只换期货腿，现货不动。按线性合约建模，币本位合约的凸性在对冲仓位里是二阶量，忽略。
- **永续资金费**：买现货 + 卖永续，每天收当天实际结算的 24h 资金费。存档里的资金费多数时段是 CoinGlass 全市场持仓加权值，只能近似单一交易所的真实现金流。
- **空仓时**资金按 3M 美债计息；**在场时**资金压在 BTC 上，不再有美债收益——这是套利真正的机会成本。
- **成本（每边、按名义本金）**：现货 ${c.spotFeeBps} bp，期货 ${c.futFeeBps} bp，永续 ${c.perpFeeBps} bp，滑点 ${c.slipBps} bp/腿，交割 ${c.settleBps} bp。量级参照常见吃单费率，实盘前须按实际费率表核对。
- **杠杆 1 倍**：币本位合约用现货 BTC 本身做保证金。"最差持仓内回撤"给出加杠杆前需要预留的缓冲。

## 防止前视偏差

1. 第 d 天 08:00 的快照只决定第 **d+1** 天 08:00 的成交（默认滞后 1 天）。
2. 决策用的美债利率取前一天的值：FRED 公布某日的 DGS3MO 要到美国次日下午，晚于当天的 08:00 UTC 快照。
3. 合约盯市价由存档的年化基差还原：基差$ = S × APR × 天数 / 365。合约进入最后一周后存档不再给出盯市价，持仓按不盯市处理，到期时一次结清（基差此时为 0）。最后一周内不开新仓。
4. 每个规则事先固定，下文的门槛网格只用来看结果对参数有多敏感，**不从中挑最优**。

## 市场环境：carry 在逐年收缩

${regimeTable(rows)}

## 主结果（基准成本，滞后 1 天）

${mainTable(results)}

"超额"指年化收益减去同期只持美债的年化收益；"超额夏普"用日超额收益计算。期现对冲后日波动很小，夏普数值会偏高，不要直接和方向性策略的夏普比较。

## 分年收益

${yearTable(results)}

\\* 不完整年度。

## 门槛敏感性（季度期现）

${grid.md}

## 稳健性：成本与成交滞后（年化超额）

${robustnessTable(rows)}

## 交易明细：${main.label}

${tradeTable(main.res.trades)}

## 局限与下一步

- **样本短**：约 ${(rows.length / 365).toFixed(1)} 年，约 ${Math.round(rows.length / 91)} 个季度周期，且集中在一轮 ETF 驱动的牛市和随后的降温期。任何门槛在这个样本上的"最优"都不可信。
- **只用日收盘**：存档是每天一个点。真实的入场机会往往在盘中基差冲高时出现（期限结构飙升通常只持续几小时），日频回测会低估机动交易的收益，也看不到盘中保证金压力。
- **单一场所**：期货腿只用 Deribit。CME、Binance、OKX 的季度合约基差不同，选最好的场所是 carry 的主要来源之一，需要多场所基差档案。
- **未建模**：交易所对手方风险（FTX 型事件）、资金在交易所之间划转的时间和费用、以 USDT/USDC 作保证金的收益、税。
- **下一步**：①开始归档 Deribit / Binance / OKX / CME 季度合约的小时级基差（这部分历史只能从今天开始积累）；②把本回测的规则接成模拟盘，每天把"信号 → 计划成交 → 实际可成交价"写进账本；③跑满两个季度的模拟盘之后，再讨论小额实盘。
`;

  const json = {
    generatedAt: new Date().toISOString(),
    input: file,
    range: { first, last, days: rows.length },
    costs: COSTS,
    strategies: results.map(r => ({ id: r.id, label: r.label, metrics: r.m, years: r.years, trades: r.res.trades.map(({ peakEquity, entryEquity, entryTs, ...t }) => t) })),
    grid: grid.grid
  };
  return { md, json, results, last };
}

function conclusions(results, rows) {
  const by = id => results.find(r => r.id === id).m;
  const cash = by('cash');
  const qa = by('q_always');
  const qh = by('q_hurdle');
  const qhe = by('q_hurdle_exit');
  const qs = by('q_score');
  const ph = by('p_hurdle');
  const pa = by('p_always');
  const out = [];
  out.push(`- 同期只持 3M 美债年化 **${f(cash.cagrPct)}%**。季度期现常驻年化 **${f(qa.cagrPct)}%**（超额 ${sgn(qa.excessCagrPct)}%），永续常驻年化 **${f(pa.cagrPct)}%**（超额 ${sgn(pa.excessCagrPct)}%）。`);
  out.push(`- 加"净基差 ≥ 美债 + 3.5%"入场门槛并持有到期：年化 **${f(qh.cagrPct)}%**，超额 ${sgn(qh.excessCagrPct)}%，在场时间 ${f(qh.exposurePct, 0)}%，最大回撤 ${f(qh.maxDrawdownPct)}%。再加"剩余基差低于美债就提前平仓"：超额 ${sgn(qhe.excessCagrPct)}%。`);
  out.push(`- 看板现有的套利评分当作开关：超额 ${sgn(qs.excessCagrPct)}%。永续资金费门槛版：超额 ${sgn(ph.excessCagrPct)}%，${ph.trades} 笔。`);
  const ys = results.find(r => r.id === 'q_always').years;
  const lastY = ys[ys.length - 1];
  out.push(`- 收益高度集中在早期：季度常驻在 ${ys.map(y => `${y.year} 年 ${f(y.returnPct)}%（美债 ${f(y.cashPct)}%）`).join('，')}。${lastY.returnPct < lastY.cashPct ? `${lastY.year} 年至今 carry 已跑输美债，门槛的作用主要是让资金这段时间留在美债里。` : ''}`);
  const qIds = ['q_always', 'q_hurdle', 'q_hurdle_exit', 'q_tbill', 'q_score'];
  const ex = qIds.map(id => by(id).excessCagrPct);
  const nTrades = qIds.filter(id => id !== 'q_always').map(id => by(id).trades);
  out.push(`- **规则之间分不出高下**：五个季度版本的年化超额在 ${f(Math.min(...ex))}%–${f(Math.max(...ex))}% 之间，每个只有 ${Math.min(...nTrades)}–${Math.max(...nTrades)} 笔交易；门槛网格里结果随参数上下跳动，没有单调关系。站得住的结论只有两条：2024–2025 年 carry 明显高于美债；2026 年以来不高于美债。看板评分也没有表现出比简单门槛更好的择时能力。`);
  return out.join('\n');
}

function main() {
  const hist = loadHistory();
  const { md, json, results, last } = buildReport(hist);
  console.log(`[carry_backtest] ${hist.file}: ${hist.rows[0].date} → ${last}, ${hist.rows.length} rows`);
  for (const r of results) {
    console.log(`  ${r.id.padEnd(14)} CAGR ${f(r.m.cagrPct).padStart(6)}%  excess ${sgn(r.m.excessCagrPct).padStart(6)}%  sharpe ${f(r.m.sharpe).padStart(6)}  maxDD ${f(r.m.maxDrawdownPct).padStart(6)}%  in-mkt ${f(r.m.exposurePct, 0).padStart(3)}%  trades ${r.m.trades}`);
  }
  if (flag('--no-write')) return;
  const dir = path.join(ROOT, 'docs', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `carry-backtest-${last}`);
  fs.writeFileSync(base + '.md', md);
  fs.writeFileSync(base + '.json', JSON.stringify(json, null, 2));
  console.log(`[carry_backtest] wrote ${path.relative(ROOT, base)}.md / .json`);
}

if (require.main === module) main();
module.exports = { buildReport, loadHistory, STRATEGIES, COSTS };
