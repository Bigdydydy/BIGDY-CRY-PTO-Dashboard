#!/usr/bin/env node
'use strict';
/**
 * Weekly topic screener: ranks this week's moves across every archived metric against their own
 * history, proposes research angles and lists the coming events. The editor picks the topic.
 *
 * Usage:
 *   node scripts/weekly_screener.js                    → docs/screener/screener-<cutoff>.{md,json}
 *   node scripts/weekly_screener.js --date 2026-11-16  → as of another day (only data up to it)
 *   node scripts/weekly_screener.js --no-write         → summary to stdout only
 *
 * Optional inputs:
 *   data/event_calendar.json  hand-kept events [{date, title, tags}] (FOMC, CPI, …)
 *   data/weekly_topics.json   topics already published [{date, issue, angle}] → recency penalty
 *
 * Metrics marked license "red" come from sources the licensing ledger (docs/data_licensing.md)
 * flags as unlicensed: they can steer the choice of topic but are not to be published as such.
 */

const fs = require('fs');
const path = require('path');
const S = require('../server/weekly_screener');
const { decodeDaily } = require('../server/block_insight');
const { decodeHistory } = require('../server/option_oi_history');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const DAY_MS = 86400000;
const isoDay = ms => new Date(ms).toISOString().slice(0, 10);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * The committed archive or its .local sidecar, whichever reaches the later date; on a tie the
 * more recently written file (sources revise recent values, e.g. FRED)
 */
function loadNewest(name, lastOf) {
  const cands = [name, name.replace(/\.json$/, '.local.json')]
    .map(f => {
      const p = path.join(DATA, f);
      return { d: readJson(p), mtime: fs.existsSync(p) ? fs.statSync(p).mtimeMs : 0 };
    })
    .filter(x => x.d);
  if (!cands.length) return null;
  const key = x => { try { return String(lastOf(x.d) || ''); } catch { return ''; } };
  return cands.sort((a, b) => key(b).localeCompare(key(a)) || b.mtime - a.mtime)[0].d;
}
const lastDateOf = arr => (Array.isArray(arr) && arr.length ? arr[arr.length - 1].date : '');

function median(xs) {
  const a = [...xs].sort((p, q) => p - q);
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
}

/** Strategy 8-K holdings by week end (a filing that reports two periods keeps the later one) */
function secHoldings(disc) {
  const byDoc = Object.values((disc && disc.secDocs) || {}).filter(x => (x.holdings || []).length);
  const rows = byDoc.map(x => {
    const h = [...x.holdings].sort((a, b) => a.asOf.localeCompare(b.asOf)).pop();
    const atm = (x.flows || []).filter(f => f.kind === 'atm').reduce((s, f) => s + (f.shares.MSTR || 0), 0);
    const rep = (x.flows || []).filter(f => f.kind === 'repurchase').reduce((s, f) => s + (f.shares.STRC || 0), 0);
    return { date: h.asOf, btc: h.holdingsBtc, avg: h.averageCostUsd, atm, rep };
  });
  const uniq = new Map(rows.map(r => [r.date, r]));
  return [...uniq.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function loadArchives() {
  const a = {};
  a.tp = loadNewest('term_premium_history.json', lastDateOf) || [];
  a.macro = (loadNewest('macro_chart.json', d => lastDateOf(d.points)) || {}).points || [];
  a.gold = (loadNewest('gold_correlation.json', d => lastDateOf(d.series)) || {}).series || [];
  a.mc = loadNewest('crypto_mcclellan.json', d => lastDateOf(d.series)) || { series: [], structure: { series: [] } };
  a.vol = (loadNewest('vol_surface_history_BTC.json', d => d.records[d.records.length - 1].day) || {}).records || [];
  a.dealer = (loadNewest('dealer_exposure_history_BTC.json', d => d.records[d.records.length - 1].day) || {}).records || [];
  const bf = loadNewest('block_flow_daily_BTC.json', d => Object.keys(d.days).sort().pop());
  a.blocks = bf ? decodeDaily(bf) : {};
  a.cb = (loadNewest('coinbase_liquidity_history.json', d => String(d.samples[d.samples.length - 1].ts)) || {}).samples || [];
  const oi = loadNewest('option_oi_history_BTC.json', d => String(d.snapshots[d.snapshots.length - 1].ts));
  a.optOi = oi ? decodeHistory(oi) : [];
  a.sec = secHoldings(loadNewest('mstr_disclosures.json', d => Object.values(d.secDocs || {}).map(x => x.filedOn).sort().pop()));
  a.lev = loadNewest('leverage_norm.json', d => d.freshness.oiLatest) || { oi: [], funding: [], etf: { rows: [] } };
  a.ssro = (loadNewest('ssro_chart.json', d => lastDateOf(d.points)) || {}).points || [];
  a.pref = (loadNewest('mstr_preferreds_cache.json', d => lastDateOf(d.points)) || {}).points || [];
  a.calendar = readJson(path.join(DATA, 'event_calendar.json')) || { events: [] };
  a.topics = readJson(path.join(DATA, 'weekly_topics.json')) || [];
  return a;
}

const pts = (rows, dateKey, fn) => rows.map(r => ({ date: r[dateKey], value: fn(r) })).filter(p => p.value != null && Number.isFinite(p.value));

/** Every metric the screener knows: definition plus its daily (or weekly) series */
function buildMetrics(a) {
  const M = [];
  const add = (def, series) => M.push({ def, series });

  // Price and basis — Deribit 08:00 UTC
  add({ id: 'btc_ret', label: 'BTC 价格', group: '价格', unit: '美元', mode: 'pct' }, pts(a.tp, 'date', r => r.btcPrice));
  add({ id: 'cq_basis', label: '当季年化基差', group: '基差', unit: '%', mode: 'diff' }, pts(a.tp, 'date', r => r.cqApr));
  add({ id: 'nq_excess', label: '次季基差减 3M 美债', group: '基差', unit: '百分点', mode: 'diff' }, pts(a.tp, 'date', r => (r.nqApr == null ? null : r.nqApr - r.tbill)));
  add({ id: 'funding_deribit', label: 'Deribit 永续资金费（7 日年化）', group: '基差', unit: '%', mode: 'diff' }, pts(a.tp, 'date', r => r.deribitFundingApr));
  add({ id: 'tbill', label: '3M 美债', group: '宏观', unit: '%', mode: 'diff' }, pts(a.tp, 'date', r => r.tbill));

  // Macro — FRED
  add({ id: 'net_liq', label: '净流动性 WALCL−TGA−RRP', group: '宏观', unit: '万亿美元', mode: 'diff' }, pts(a.macro, 'date', r => r.fedNetLiquidity));
  add({ id: 'yield_spread', label: '10Y−1Y 利差', group: '宏观', unit: '%', mode: 'diff' }, pts(a.macro, 'date', r => r.yieldSpread));
  add({ id: 'us1y', label: '1 年期美债', group: '宏观', unit: '%', mode: 'diff' }, pts(a.macro, 'date', r => r.us1y));
  add({ id: 'us10y', label: '10 年期美债', group: '宏观', unit: '%', mode: 'diff' }, pts(a.macro, 'date', r => r.us10y));

  // Gold — Binance PAXG
  add({ id: 'gold_corr', label: 'BTC 与黄金 30 日相关', group: '跨资产', unit: '', mode: 'diff' }, pts(a.gold, 'date', r => r.rollingCorr30d));
  add({ id: 'btc_gold_ratio', label: 'BTC/黄金比价', group: '跨资产', unit: '盎司', mode: 'pct' }, pts(a.gold, 'date', r => r.btcGoldRatio));

  // Breadth — CoinGecko core 100
  const st = (a.mc.structure && a.mc.structure.series) || [];
  add({ id: 'pct_above_200', label: 'Top 100 站上 200 日线比例', group: '宽度', unit: '%', mode: 'diff' }, pts(st, 'date', r => r.pct_above_sma200));
  add({ id: 'med_dd', label: '成分 52 周回撤中位数', group: '宽度', unit: '%', mode: 'diff' }, pts(st, 'date', r => r.median_constituent_drawdown_52w));
  const ramo = (a.mc.series || []).filter(r => r.core_ramo != null);
  const ramo7 = ramo.map((r, i) => {
    const w = ramo.slice(Math.max(0, i - 6), i + 1);
    return { date: r.date, value: w.length === 7 ? w.reduce((s, x) => s + x.core_ramo, 0) / 7 : null };
  }).filter(p => p.value != null);
  add({ id: 'ramo7', label: '涨跌比 RAMO 7 日均值', group: '宽度', unit: '', mode: 'level' }, ramo7);

  // Options surface — Deribit (history since 2026-10)
  add({ id: 'iv1m', label: '1 个月 ATM 隐含波动率', group: '期权', unit: '%', mode: 'diff' }, pts(a.vol, 'day', r => r.iv1m));
  add({ id: 'dvol', label: 'DVOL', group: '期权', unit: '', mode: 'diff' }, pts(a.vol, 'day', r => r.dvol));
  add({ id: 'rr7', label: '7 天 25Δ 风险逆转', group: '期权', unit: 'vol', mode: 'diff' }, pts(a.vol, 'day', r => r.rr7));
  add({ id: 'rr30', label: '30 天 25Δ 风险逆转', group: '期权', unit: 'vol', mode: 'diff' }, pts(a.vol, 'day', r => r.rr30));
  add({ id: 'bf25', label: '25Δ 蝶式', group: '期权', unit: 'vol', mode: 'diff' }, pts(a.vol, 'day', r => r.bf25));
  add({ id: 'opt_oi_btc', label: '期权未平仓（BTC）', group: '期权', unit: 'BTC', mode: 'pct' },
    a.optOi.map(s => ({ date: isoDay(s.ts), value: Object.values(s.oi).reduce((t, v) => t + v[0], 0) })));

  // Dealer model
  add({ id: 'gex', label: '做市商净 Gamma（惯例口径）', group: '做市商', unit: '百万美元/1%', mode: 'diff' }, pts(a.dealer, 'day', r => r.conv.gexUsd / 1e6));
  add({ id: 'flip_gap', label: '价格相对 Gamma 翻转位', group: '做市商', unit: '%', mode: 'diff' }, pts(a.dealer, 'day', r => (r.conv.flip ? (r.spot / r.conv.flip - 1) * 100 : null)));

  // Block trades — Deribit, complete OI days only
  const days = Object.keys(a.blocks).sort().filter(k => a.blocks[k].complete);
  const dayAgg = days.map(k => a.blocks[k].rows.reduce((s, r) => {
    s.gross += r.grossUSD; s.delta += r.netDeltaUSD; if (!r.isCall) s.put += r.grossUSD;
    return s;
  }, { date: k, gross: 0, delta: 0, put: 0 }));
  add({ id: 'blk_gross7', label: '期权大宗成交额（周合计）', group: '大宗', unit: '百万美元', mode: 'sum' }, dayAgg.map(d => ({ date: d.date, value: d.gross / 1e6 })));
  add({ id: 'blk_net_delta7', label: '大宗主动方净 Delta（周合计）', group: '大宗', unit: '百万美元', mode: 'sum' }, dayAgg.map(d => ({ date: d.date, value: d.delta / 1e6 })));
  add({ id: 'blk_put_share', label: '大宗中看跌成交占比（7 日）', group: '大宗', unit: '%', mode: 'diff' }, dayAgg.map((d, i) => {
    const w = dayAgg.slice(Math.max(0, i - 6), i + 1);
    const g = w.reduce((s, x) => s + x.gross, 0);
    return { date: d.date, value: w.length === 7 && g > 0 ? w.reduce((s, x) => s + x.put, 0) / g * 100 : null };
  }).filter(p => p.value != null));

  // Coinbase book — hourly samples → daily medians (days with ≥ 12 samples)
  const byDay = new Map();
  for (const s of a.cb) {
    const k = isoDay(s.ts);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(s);
  }
  const cbDays = [...byDay.entries()].filter(([, xs]) => xs.length >= 12).sort((x, y) => x[0].localeCompare(y[0]));
  const cbm = f => cbDays.map(([date, xs]) => ({ date, value: median(xs.map(f)) }));
  add({ id: 'cb_d10', label: 'Coinbase ±10 bp 挂单（BTC）', group: '盘口', unit: 'BTC', mode: 'pct' }, cbm(x => x.d10 * 1e6 / x.mid));
  add({ id: 'cb_d50', label: 'Coinbase ±50 bp 挂单', group: '盘口', unit: '百万美元', mode: 'pct' }, cbm(x => x.d50));
  add({ id: 'cb_vol', label: 'Coinbase 24 小时成交额', group: '盘口', unit: '百万美元', mode: 'pct' }, cbm(x => x.vol24));
  add({ id: 'cb_spread', label: 'Coinbase 买卖价差', group: '盘口', unit: 'bp', mode: 'diff' }, cbm(x => x.spr));

  // Strategy — SEC 8-K, one point per week
  const sec = a.sec.map((r, i) => ({ ...r, added: i ? r.btc - a.sec[i - 1].btc : null }));
  add({ id: 'mstr_added', label: 'Strategy 每周新增 BTC', group: 'Strategy', unit: 'BTC', mode: 'level', maxAgeDays: 9 }, pts(sec.filter(r => r.added != null), 'date', r => r.added));
  add({ id: 'mstr_atm', label: 'Strategy 每周 ATM 卖出 MSTR', group: 'Strategy', unit: '股', mode: 'level', maxAgeDays: 9 }, pts(sec, 'date', r => r.atm));
  add({ id: 'strc_rep', label: 'Strategy 每周回购 STRC', group: 'Strategy', unit: '股', mode: 'level', maxAgeDays: 9 }, pts(sec, 'date', r => r.rep));
  const costAt = d => { let c = null; for (const r of a.sec) if (r.date <= d) c = r.avg; return c; };
  add({ id: 'btc_vs_cost', label: 'BTC 相对 Strategy 持仓均价', group: 'Strategy', unit: '%', mode: 'diff' },
    pts(a.tp, 'date', r => { const c = costAt(r.date); return c ? (r.btcPrice / c - 1) * 100 : null; }));

  // Red-license sources (CoinGlass site API, Yahoo, TradingView): topic signals only
  add({ id: 'oi_fut_btc', label: '期货未平仓（按币计）', group: '杠杆', unit: 'BTC', mode: 'pct', license: 'red' }, pts(a.lev.oi, 'date', r => r.futOiBtc));
  add({ id: 'opt_fut_ratio', label: '期权 ÷ 期货未平仓', group: '杠杆', unit: '', mode: 'diff', license: 'red' }, pts(a.lev.oi, 'date', r => r.optFutRatio));
  add({ id: 'cme_share', label: 'CME 期货未平仓份额', group: '杠杆', unit: '%', mode: 'diff', license: 'red' }, pts(a.lev.oi, 'date', r => (r.cmeShare == null ? null : r.cmeShare * 100)));
  add({ id: 'funding_premium30d', label: '30 日资金溢价', group: '杠杆', unit: '百万美元', mode: 'diff', license: 'red' }, pts(a.lev.funding, 'date', r => (r.premium30dUsd == null ? null : r.premium30dUsd / 1e6)));
  add({ id: 'etf_flow20', label: 'ETF 20 日净流入', group: '机构', unit: '百万美元', mode: 'level', license: 'red', maxAgeDays: 4 }, pts(a.lev.etf.rows || [], 'date', r => (r.flow20Usd == null ? null : r.flow20Usd / 1e6)));
  add({ id: 'stable_cap', label: '稳定币总市值', group: '稳定币', unit: '十亿美元', mode: 'pct', license: 'red' }, pts(a.ssro, 'date', r => (r.stableCap == null ? null : r.stableCap / 1e9)));
  add({ id: 'ssr', label: '稳定币供给比率 SSR', group: '稳定币', unit: '', mode: 'diff', license: 'red' }, pts(a.ssro, 'date', r => r.ssr));
  add({ id: 'strc_close', label: 'STRC 收盘价', group: 'Strategy', unit: '美元', mode: 'diff', license: 'red', maxAgeDays: 4 }, pts(a.pref, 'date', r => r.strcClose));
  add({ id: 'junior_spread', label: '优先股次级利差', group: 'Strategy', unit: '百分点', mode: 'diff', license: 'red', maxAgeDays: 4 }, pts(a.pref, 'date', r => r.juniorSpread));
  return M;
}

/** Deribit "27NOV26" → "2026-11-27" */
function expiryDate(code) {
  const m = /^(\d{1,2})([A-Z]{3})(\d{2})$/.exec(code || '');
  const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  if (!m || MONTHS.indexOf(m[2]) < 0) return null;
  return isoDay(Date.UTC(2000 + +m[3], MONTHS.indexOf(m[2]), +m[1]));
}

function screen(a, cutoff) {
  const metrics = buildMetrics(a);
  const results = metrics.map(m => S.analyzeMetric(m.def, m.series, cutoff));
  const dl = a.dealer.filter(r => r.day <= cutoff).pop();
  const expiryShares = {};
  if (dl && dl.nextMajor) { const d = expiryDate(dl.nextMajor.expiry); if (d) expiryShares[d] = dl.nextMajor.oiShare; }
  const events = S.buildCalendar(cutoff, 14, a.calendar.events, { expiryShares });
  const angles = S.scoreAngles(results, S.ANGLES, events, a.topics, cutoff);
  return { cutoff, results, events, angles };
}

// ── Report

function fmt(v, unit) {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  const dp = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }) + (unit === '%' ? '%' : '');
}
function fmtChange(r) {
  if (r.change == null) return '—';
  const s = (r.change > 0 ? '+' : '') + fmt(r.change, null);
  if (r.mode === 'pct') return `${s}%`;
  // A move in a rate or a share is in percentage points, not percent
  return r.unit === '%' || r.unit === '百分点' ? `${s} pp` : s;
}
const pctTxt = p => (p == null ? '—' : `${Math.round(p)}%`);
function tag(r) {
  const t = [];
  if (r.changePct != null && r.changePct <= 5) t.push('罕见下降');
  else if (r.changePct != null && r.changePct >= 95) t.push('罕见上升');
  if (r.levelPct != null && (r.levelPct <= 3 || r.levelPct >= 97)) t.push('水平极端');
  if (r.short) t.push(`历史仅 ${r.n} 个周度变化`);
  if (r.license === 'red') t.push('红色来源');
  return t.join('；');
}
function driverLine(r) {
  const unit = r.unit && r.unit !== '%' ? ` ${r.unit}` : '';
  const head = r.mode === 'level'
    ? `当前 ${fmt(r.value, r.unit)}${unit}，处在历史 ${pctTxt(r.levelPct)} 分位`
    : `本周 ${fmtChange(r)}${r.mode !== 'pct' && r.unit !== '百分点' ? unit : ''}，变化处在历史 ${pctTxt(r.changePct)} 分位；当前 ${fmt(r.value, r.unit)}${unit}，水平分位 ${pctTxt(r.levelPct)}`;
  const t = tag(r);
  return `**${r.label}**：${head}${t ? `（${t}）` : ''}`;
}

function buildReport(out) {
  const { cutoff, results, events, angles } = out;
  const usable = results.filter(r => !r.missing && !r.stale && r.score != null);
  const ranked = [...usable].sort((a, b) => b.score - a.score);
  const calm = usable.filter(r => !r.short && r.mode !== 'level').sort((a, b) => a.score - b.score).slice(0, 6);
  const L = [];
  L.push(`# 周报选题扫描 · ${cutoff}`, '');
  L.push(`> 数据截至 ${cutoff}；共 ${results.length} 个指标，可用 ${usable.length} 个。每个指标的本周变化与它自己过去的周度变化比较，分位越靠两端越反常。`);
  L.push('> 这是选题建议，由编辑决定写哪个。标"红色来源"的指标只能帮助选题，不能直接写进刊物（见 docs/data_licensing.md）。', '');

  L.push('## 候选主题', '');
  angles.slice(0, 3).forEach((a, i) => {
    L.push(`### ${i + 1}. ${a.title}`, '');
    L.push(`得分 ${a.score.toFixed(0)}（指标 ${a.base.toFixed(0)}${a.bonus ? ` + 事件 ${a.bonus}` : ''}${a.recentUse ? ` − 近期用过 ${S.RECENCY_PENALTY}` : ''}）`, '');
    L.push('**为什么是这周**', '');
    for (const d of a.drivers) L.push(`- ${driverLine(d)}`);
    const c = a.calm.find(m => m.score < 30 && !a.drivers.includes(m));
    if (c) L.push(`- 反差：${driverLine(c)}`);
    if (a.events.length) {
      L.push('', '**相关事件**', '');
      for (const e of a.events) L.push(`- ${e.date}：${e.title}`);
    }
    L.push('', `**方法**：${a.method}`);
    const notes = [];
    if (a.recentUse) notes.push(`${a.recentUse} 用过这个角度`);
    if (a.redLicense.length) notes.push(`${a.redLicense.join('、')} 来自红色来源，发表前要换数据`);
    if (a.unusable.length) notes.push(`${a.unusable.join('、')} 缺数据或已过期`);
    if (notes.length) L.push('', `**注意**：${notes.join('；')}。`);
    L.push('');
  });
  if (angles.length > 3) {
    L.push('其余角度：' + angles.slice(3).map(a => `${a.title}（${a.score.toFixed(0)}）`).join('；'), '');
  }

  L.push('## 最反常的指标', '');
  L.push('| 指标 | 板块 | 当前值 | 本周变化 | 变化分位 | 水平分位 | 得分 | 备注 |', '|---|---|---:|---:|---:|---:|---:|---|');
  for (const r of ranked.slice(0, 12)) {
    L.push(`| ${r.label} | ${r.group} | ${fmt(r.value, r.unit)} ${r.unit === '%' ? '' : r.unit} | ${fmtChange(r)} | ${pctTxt(r.changePct)} | ${pctTxt(r.levelPct)} | ${r.score.toFixed(0)} | ${tag(r)} |`);
  }
  L.push('');
  L.push('## 最平静的指标（反差线索）', '');
  L.push('大家都在动的一周里，没动的指标往往就是故事的另一半。', '');
  for (const r of calm) L.push(`- ${driverLine(r)}`);
  L.push('');

  L.push('## 未来 14 天', '');
  if (events.length) for (const e of events) L.push(`- ${e.date}：${e.title}`);
  else L.push('- 无已知事件。在 data/event_calendar.json 补充宏观日程。');
  L.push('');

  const problems = results.filter(r => r.missing || r.stale);
  const shortOnes = results.filter(r => !r.missing && !r.stale && r.short);
  L.push('## 数据问题', '');
  if (problems.length) for (const r of problems) L.push(`- ${r.label}：${r.missing ? '没有数据' : `最后一个数据点 ${r.lastDate}，已过期`}`);
  if (shortOnes.length) L.push(`- 历史不足 ${S.MIN_HISTORY} 个周度变化、得分已减半：${shortOnes.map(r => r.label).join('、')}`);
  if (!problems.length && !shortOnes.length) L.push('- 无');
  L.push('');
  L.push('## 记录选题', '');
  L.push('定稿后把本期选用的角度追加到 `data/weekly_topics.json`，例如 `{"date": "' + cutoff + '", "issue": 48, "angle": "' + (angles[0] ? angles[0].id : 'forced_flow') + '"}`。' +
    `${S.RECENCY_DAYS} 天内用过的角度会被扣分，避免连续几期写同一件事。`);
  return L.join('\n') + '\n';
}

function main() {
  const a = loadArchives();
  const cutoff = opt('--date') || (a.tp.length ? a.tp[a.tp.length - 1].date : isoDay(Date.now() - DAY_MS));
  const out = screen(a, cutoff);
  const usable = out.results.filter(r => !r.missing && !r.stale && r.score != null).sort((x, y) => y.score - x.score);
  console.log(`[weekly_screener] cutoff ${cutoff}: ${out.results.length} metrics, ${usable.length} usable`);
  for (const r of usable.slice(0, 10)) console.log(`  ${r.score.toFixed(0).padStart(3)}  ${r.label}  ${fmtChange(r)}  (变化分位 ${pctTxt(r.changePct)}, 水平分位 ${pctTxt(r.levelPct)})${r.short ? ' [短历史]' : ''}${r.license === 'red' ? ' [红]' : ''}`);
  console.log('  angles: ' + out.angles.slice(0, 5).map(x => `${x.id} ${x.score.toFixed(0)}`).join(' | '));
  if (args.includes('--no-write')) return;
  const dir = path.join(ROOT, 'docs', 'screener');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `screener-${cutoff}`);
  fs.writeFileSync(base + '.md', buildReport(out));
  fs.writeFileSync(base + '.json', JSON.stringify({
    generatedAt: new Date().toISOString(), cutoff,
    angles: out.angles.map(x => ({ ...x, drivers: x.drivers.map(d => d.id), calm: x.calm.map(d => d.id) })),
    metrics: out.results, events: out.events
  }, null, 2));
  console.log(`[weekly_screener] wrote ${path.relative(ROOT, base)}.md / .json`);
}

if (require.main === module) main();
module.exports = { buildMetrics, screen, buildReport, expiryDate, secHoldings };
