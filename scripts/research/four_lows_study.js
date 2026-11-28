#!/usr/bin/env node
/**
 * 研究脚本：「四低」(低成交量 / 低波动 / 低情绪 / 低持仓) 同时出现后，BTC 是否
 *   (a) 迎来大行情 (幅度)，(b) 偏向上涨 (方向)，(c) 处在底部附近 (未来回撤小)？
 *
 * 输入：research/four_lows/raw.json (four_lows_fetch.js)、data/leverage_norm.json (期货 OI 按币计)、
 *       research/skew_dvol/dvol.json (DVOL 日线，可选)
 * 输出：research/four_lows/results.json，并打印摘要
 *
 * 口径：
 *   - 价格/ATR/HV/成交量：Coinbase BTC-USD 日线 (UTC)。ATR% = Wilder RMA(14) 的真实波幅 ÷ 收盘价。
 *   - 每个腿先做 30 日均值 (ATR%、DVOL 本身已平滑，不再平均)，再算因果分位：
 *     与 t 之前 365 天 (不含 t) 比较，至少 300 个观测，pct = 过去值中严格小于当前值的占比。
 *   - 腿：
 *       vol    ATR% 分位 (主口径)；变体 DVOL 分位、HV30 分位
 *       volume Coinbase 30 日均成交量 (按 BTC 计) 分位
 *       sent   维基 "Bitcoin" 30 日均浏览量分位；B 档再与 Binance 30 日均资金费分位取均值
 *       oi     全市场期货 OI (按 BTC 计，CoinGlass 链式拼接) 分位
 *     分位 ≤ θ (默认 20) 记为点亮。
 *   - A 档 (2016-07 起)：vol + volume + sent(维基) 三腿；B 档 (2021-02 起)：四腿全齐。
 *   - 事件去簇：信号日之间间隔 > 30 天 (--gap=N 可改，180 用作按周期聚类的稳健性检验) 才算新事件，取事件首日为入场日。
 *   - 显著性：从同一可用样本 (同样的熊市过滤、前向窗口完整) 随机抽同等数量的日子 20000 次。
 *   - 熊市过滤：收盘价较此前历史最高收盘回撤 ≥ 40% (2015-07 之前的高点用 Bitstamp 补)。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(ROOT, 'research', 'four_lows');
const DAY = 86400000;
const HORIZONS = [30, 90, 180];
const N_PLACEBO = 20000;
const GAP = Number((process.argv.find(a => a.startsWith('--gap=')) || '--gap=30').split('=')[1]);
const THETA = Number((process.argv.find(a => a.startsWith('--theta=')) || '--theta=20').split('=')[1]);

// ---------- 工具 ----------
const dayMs = d => Date.parse(`${d}T00:00:00Z`);
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const median = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const quantile = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const r1 = v => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const pct100 = v => r1(v * 100);

// 简单可复现的随机数 (mulberry32)
function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function rolling(arr, n, fn) {
  return arr.map((_, i) => {
    if (i + 1 < n) return null;
    const w = arr.slice(i + 1 - n, i + 1);
    if (w.some(v => v === null || !Number.isFinite(v))) return null;
    return fn(w);
  });
}

/** 因果分位：与 t 之前 365 天 (不含 t) 的有效值比较 */
function causalPct(days, vals, lookback = 365, minObs = 300) {
  const out = new Array(vals.length).fill(null);
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (v === null || !Number.isFinite(v)) continue;
    const t = dayMs(days[i]);
    const past = [];
    for (let j = i - 1; j >= 0; j--) {
      if (t - dayMs(days[j]) > lookback * DAY) break;
      if (vals[j] !== null && Number.isFinite(vals[j])) past.push(vals[j]);
    }
    if (past.length < minObs) continue;
    out[i] = 100 * past.filter(x => x < v).length / past.length;
  }
  return out;
}

// ---------- 载入与对齐 ----------
const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'raw.json'), 'utf8'));
const cb = raw.coinbase;
const days = cb.map(r => r.day);
const idx = new Map(days.map((d, i) => [d, i]));
const align = (rows, field) => { const a = new Array(days.length).fill(null); for (const r of rows) { const i = idx.get(r.day || r.date); if (i !== undefined && Number.isFinite(r[field])) a[i] = r[field]; } return a; };

// 坏价清洗：Coinbase 2017-04-15 有一根 0.06 美元的错价下影 (min(O,C) 的 50% 以下视为坏价，按实体截断)
const badWicks = [];
for (const r of cb) {
  if (r.low < 0.5 * Math.min(r.open, r.close)) { badWicks.push(`${r.day} low ${r.low}`); r.low = Math.min(r.open, r.close); }
  if (r.high > 2 * Math.max(r.open, r.close)) { badWicks.push(`${r.day} high ${r.high}`); r.high = Math.max(r.open, r.close); }
}
const close = cb.map(r => r.close), high = cb.map(r => r.high), low = cb.map(r => r.low), volume = cb.map(r => r.volume);

// 日期连续性检查
const gaps = [];
for (let i = 1; i < days.length; i++) { const g = (dayMs(days[i]) - dayMs(days[i - 1])) / DAY; if (g !== 1) gaps.push(`${days[i - 1]}→${days[i]} (${g}d)`); }

// ATR% (Wilder RMA 14)
const tr = cb.map((r, i) => i === 0 ? r.high - r.low : Math.max(r.high - r.low, Math.abs(r.high - cb[i - 1].close), Math.abs(r.low - cb[i - 1].close)));
const atr = new Array(days.length).fill(null);
{ let a = null; for (let i = 0; i < tr.length; i++) { if (i < 13) continue; if (a === null) a = mean(tr.slice(0, 14)); else a = (a * 13 + tr[i]) / 14; atr[i] = a; } }
const atrPct = atr.map((a, i) => a === null ? null : 100 * a / close[i]);

// HV30
const lr = close.map((c, i) => i === 0 ? null : Math.log(c / close[i - 1]));
const hv30 = rolling(lr, 30, w => { const m = mean(w); return 100 * Math.sqrt(w.reduce((s, v) => s + (v - m) ** 2, 0) / (w.length - 1) * 365); });

const vol30 = rolling(volume, 30, mean);
const wiki30 = rolling(align(raw.wiki, 'views'), 30, mean);
const fund30 = rolling(align(raw.funding, 'rate'), 30, mean);

const lev = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'leverage_norm.json'), 'utf8'));
const oiBtc = align(lev.oi, 'futOiBtc');

let dvol = new Array(days.length).fill(null);
const dvolFile = path.join(ROOT, 'research', 'skew_dvol', 'dvol.json');
if (fs.existsSync(dvolFile)) dvol = align(JSON.parse(fs.readFileSync(dvolFile, 'utf8')).data, 'close');

// 历史最高收盘 (含 Bitstamp 2011–2015) 与回撤
let athPrior = -Infinity, athDay = null;
for (const r of raw.bitstamp) if (r.close > athPrior) { athPrior = r.close; athDay = r.day; }
const sinceAth = new Array(days.length).fill(null);
const drawdown = close.map((c, i) => { if (c >= athPrior) { athPrior = c; athDay = days[i]; } sinceAth[i] = (dayMs(days[i]) - dayMs(athDay)) / DAY; return c / athPrior - 1; });

// ---------- 分位与腿 ----------
const P = {
  atr: causalPct(days, atrPct),
  hv: causalPct(days, hv30),
  dvol: causalPct(days, dvol),
  volume: causalPct(days, vol30),
  wiki: causalPct(days, wiki30),
  fund: causalPct(days, fund30),
  oi: causalPct(days, oiBtc)
};
const sentB = P.wiki.map((w, i) => (w === null || P.fund[i] === null) ? null : (w + P.fund[i]) / 2);

// ---------- 前向结果 ----------
const N = days.length;
function forward(i, h) {
  if (i + h >= N) return null;
  let mx = -Infinity, mn = Infinity;
  for (let j = i + 1; j <= i + h; j++) { mx = Math.max(mx, high[j]); mn = Math.min(mn, low[j]); }
  const ret = Math.log(close[i + h] / close[i]);
  return { ret, absRet: Math.abs(ret), range: Math.log(mx / mn), mdd: Math.log(mn / close[i]), mup: Math.log(mx / close[i]) };
}
const FWD = {};
for (const h of HORIZONS) FWD[h] = days.map((_, i) => forward(i, h));
// 「底部附近」：t 收盘距未来 365 天 (含 t) 最低价不超过 15%
const nearBottom = days.map((_, i) => { if (i + 365 >= N) return null; let mn = Infinity; for (let j = i; j <= i + 365; j++) mn = Math.min(mn, low[j]); return close[i] / mn - 1 <= 0.15 ? 1 : 0; });
// 大行情阈值：全样本 range 的 75 分位
const BIG = {}; for (const h of HORIZONS) BIG[h] = quantile(FWD[h].filter(Boolean).map(f => f.range), 0.75);

// ---------- 事件研究 ----------
function episodes(signalIdx, gap = 30) {
  const eps = [];
  let last = -Infinity;
  for (const i of signalIdx) {
    if (i - last > gap) eps.push({ start: i, days: [i] }); else eps[eps.length - 1].days.push(i);
    last = i;
  }
  return eps;
}

function stats(ix, h) {
  const f = ix.map(i => FWD[h][i]).filter(Boolean);
  if (!f.length) return null;
  return {
    n: f.length,
    meanAbs: mean(f.map(x => x.absRet)),
    meanRange: mean(f.map(x => x.range)),
    pBig: mean(f.map(x => x.range >= BIG[h] ? 1 : 0)),
    meanRet: mean(f.map(x => x.ret)),
    medRet: median(f.map(x => x.ret)),
    pUp: mean(f.map(x => x.ret > 0 ? 1 : 0)),
    meanMdd: mean(f.map(x => x.mdd)),
    worstMdd: Math.min(...f.map(x => x.mdd))
  };
}

function placebo(entryIx, pool, h, metric, seed) {
  const vals = entryIx.map(i => FWD[h][i]).filter(Boolean).map(metric);
  const pp = pool.filter(i => FWD[h][i]);
  if (!vals.length || pp.length < vals.length * 3) return null;
  const obs = mean(vals);
  const R = rng(seed);
  let ge = 0, le = 0;
  const draws = [];
  for (let k = 0; k < N_PLACEBO; k++) {
    let s = 0;
    for (let m = 0; m < vals.length; m++) s += metric(FWD[h][pp[Math.floor(R() * pp.length)]]);
    const d = s / vals.length;
    draws.push(d);
    if (d >= obs) ge++;
    if (d <= obs) le++;
  }
  return { obs, base: mean(pp.map(i => metric(FWD[h][i]))), pHigh: ge / N_PLACEBO, pLow: le / N_PLACEBO };
}

const METRICS = {
  absRet: f => f.absRet,
  range: f => f.range,
  ret: f => f.ret,
  up: f => (f.ret > 0 ? 1 : 0),
  mdd: f => f.mdd
};

function runStudy(name, legFns, { bearOnly = false, cycleOnly = false, minLit = null } = {}) {
  const k = legFns.length;
  const need = minLit === null ? k : minLit;
  const eligible = [];
  const signal = [];
  for (let i = 0; i < N; i++) {
    const p = legFns.map(fn => fn(i));
    if (p.some(v => v === null)) continue;
    if (bearOnly && drawdown[i] > -0.40) continue;
    if (cycleOnly && (drawdown[i] > -0.40 || sinceAth[i] < 365)) continue;
    eligible.push(i);
    if (p.filter(v => v <= THETA).length >= need) signal.push(i);
  }
  const eps = episodes(signal, GAP);
  const entries = eps.map(e => e.start);
  const out = {
    name, bearOnly, cycleOnly, legs: k, minLit: need, theta: THETA,
    sample: eligible.length ? `${days[eligible[0]]} → ${days[eligible[eligible.length - 1]]}` : null,
    eligibleDays: eligible.length, signalDays: signal.length,
    signalRate: eligible.length ? signal.length / eligible.length : null,
    episodes: eps.map(e => ({ start: days[e.start], end: days[e.days[e.days.length - 1]], nDays: e.days.length, close: close[e.start], drawdown: drawdown[e.start], sinceAth: sinceAth[e.start],
      ret90: FWD[90][e.start] ? FWD[90][e.start].ret : null, range90: FWD[90][e.start] ? FWD[90][e.start].range : null,
      ret180: FWD[180][e.start] ? FWD[180][e.start].ret : null, mdd180: FWD[180][e.start] ? FWD[180][e.start].mdd : null,
      nearBottom: nearBottom[e.start] })),
    byHorizon: {}
  };
  for (const h of HORIZONS) {
    out.byHorizon[h] = {
      entries: stats(entries, h),
      allSignalDays: stats(signal, h),
      baseline: stats(eligible, h),
      placebo: Object.fromEntries(Object.entries(METRICS).map(([m, fn], j) => [m, placebo(entries, eligible, h, fn, 1000 * h + j + name.length)]))
    };
  }
  const nb = entries.map(i => nearBottom[i]).filter(v => v !== null);
  const nbBase = eligible.map(i => nearBottom[i]).filter(v => v !== null);
  out.nearBottom = { entries: nb.length ? mean(nb) : null, n: nb.length, baseline: nbBase.length ? mean(nbBase) : null };
  return out;
}

const LEG = {
  vol: i => P.atr[i], volDvol: i => P.dvol[i], volHv: i => P.hv[i],
  volume: i => P.volume[i], sentA: i => P.wiki[i], sentB: i => sentB[i], fund: i => P.fund[i], oi: i => P.oi[i]
};

const studies = [
  // 单腿
  ['单腿·ATR%', [LEG.vol]], ['单腿·HV30', [LEG.volHv]], ['单腿·DVOL', [LEG.volDvol]], ['单腿·成交量', [LEG.volume]],
  ['单腿·维基浏览', [LEG.sentA]], ['单腿·资金费', [LEG.fund]], ['单腿·期货OI', [LEG.oi]],
  // A 档三低
  ['A档三低(ATR+量+维基)', [LEG.vol, LEG.volume, LEG.sentA]],
  // B 档四低
  ['B档四低(ATR+量+情绪+OI)', [LEG.vol, LEG.volume, LEG.sentB, LEG.oi]],
  ['B档四低中≥3', [LEG.vol, LEG.volume, LEG.sentB, LEG.oi], { minLit: 3 }],
  ['B档四低(DVOL口径)', [LEG.volDvol, LEG.volume, LEG.sentB, LEG.oi]],
  // 波动+量 (作者最先看的两项)
  ['波动+量', [LEG.vol, LEG.volume]]
];

const results = [];
for (const [name, legs, opt = {}] of studies) {
  results.push(runStudy(name, legs, opt));
  results.push(runStudy(`${name}｜熊市`, legs, { ...opt, bearOnly: true }));
  results.push(runStudy(`${name}｜熊市且距ATH≥1年`, legs, { ...opt, cycleOnly: true }));
}

// 当前读数
const last = N - 1;
const lastOf = a => { for (let i = a.length - 1; i >= 0; i--) if (a[i] !== null) return { day: days[i], v: a[i] }; return null; };
const currentLast = Object.fromEntries(Object.entries(P).map(([k, a]) => [k, lastOf(a)]));
const current = { sinceAth: sinceAth[last], lastNonNull: currentLast,
  day: days[last], close: close[last], drawdown: drawdown[last],
  atrPct: atrPct[last], pctAtr: P.atr[last], hv30: hv30[last], pctHv: P.hv[last],
  dvol: dvol[last] ?? dvol.filter(v => v !== null).slice(-1)[0], pctDvol: P.dvol[last] ?? P.dvol.filter(v => v !== null).slice(-1)[0],
  vol30: vol30[last], pctVolume: P.volume[last],
  pctWiki: P.wiki[last] ?? P.wiki.filter(v => v !== null).slice(-1)[0], pctFund: P.fund[last], pctOi: P.oi[last],
  oiBtc: oiBtc[last]
};

// 周期底附近四腿读数
const bottoms = ['2015-08-24', '2018-12-15', '2020-03-12', '2022-06-18', '2022-11-21', '2026-11-21'];
const atBottoms = bottoms.map(d => { const i = idx.get(d); if (i === undefined) return { day: d }; return { day: d, close: close[i], drawdown: drawdown[i], atr: P.atr[i], volume: P.volume[i], wiki: P.wiki[i], fund: P.fund[i], oi: P.oi[i], dvol: P.dvol[i] }; });

// 各腿基础点亮率
const litRate = Object.fromEntries(Object.entries(P).map(([k, a]) => { const v = a.filter(x => x !== null); return [k, { n: v.length, rate: v.filter(x => x <= THETA).length / v.length }]; }));

const out = { theta: THETA, horizons: HORIZONS, bigMoveThreshold: BIG, gaps, litRate, current, atBottoms, results,
  series: days.map((d, i) => ({ day: d, close: close[i], dd: drawdown[i], atr: atrPct[i], pAtr: P.atr[i], pHv: P.hv[i], pDvol: P.dvol[i], pVolume: P.volume[i], pWiki: P.wiki[i], pFund: P.fund[i], pOi: P.oi[i] })) };
fs.writeFileSync(path.join(DIR, `results.theta${THETA}${GAP === 30 ? '' : `.gap${GAP}`}.json`), JSON.stringify(out));

// ---------- 打印 ----------
const f2 = v => (v === null || v === undefined ? '  —  ' : (v * 100).toFixed(1).padStart(6));
console.log(`θ = ${THETA}  大行情阈值(range 75分位): ${HORIZONS.map(h => `${h}d ${pct100(BIG[h])}%`).join('  ')}`);
console.log('日期缺口:', gaps.length ? gaps.join(', ') : '无', ' 坏价清洗:', badWicks.join(', ') || '无');
console.log('各腿点亮率:', Object.entries(litRate).map(([k, v]) => `${k} ${pct100(v.rate)}% (n=${v.n})`).join('  '));
for (const r of results) {
  console.log(`\n■ ${r.name}  样本 ${r.sample}  可用 ${r.eligibleDays} 天  信号日 ${r.signalDays} (${pct100(r.signalRate)}%)  事件 ${r.episodes.length}`);
  for (const h of HORIZONS) {
    const b = r.byHorizon[h];
    if (!b.entries) continue;
    const pl = b.placebo;
    console.log(`  ${String(h).padStart(3)}d n=${String(b.entries.n).padStart(2)} |ret| ${f2(b.entries.meanAbs)} vs ${f2(b.baseline.meanAbs)} p↑${pl.absRet ? pl.absRet.pHigh.toFixed(3) : ' — '}` +
      `  range ${f2(b.entries.meanRange)} vs ${f2(b.baseline.meanRange)} p↑${pl.range ? pl.range.pHigh.toFixed(3) : ' — '}` +
      `  ret ${f2(b.entries.meanRet)} vs ${f2(b.baseline.meanRet)} p↑${pl.ret ? pl.ret.pHigh.toFixed(3) : ' — '}` +
      `  上涨率 ${f2(b.entries.pUp)} vs ${f2(b.baseline.pUp)}  mdd ${f2(b.entries.meanMdd)} vs ${f2(b.baseline.meanMdd)} p↓${pl.mdd ? pl.mdd.pLow.toFixed(3) : ' — '}`);
  }
  console.log(`  距未来一年低点≤15%: ${f2(r.nearBottom.entries)} (n=${r.nearBottom.n}) vs 基准 ${f2(r.nearBottom.baseline)}`);
  console.log('  事件:', r.episodes.map(e => `${e.start}(${e.nDays}d, dd${pct100(e.drawdown)}%, 90d ${pct100(e.ret90)}%, 180d ${pct100(e.ret180)}%)`).join('; '));
}
console.log('\n当前读数:', JSON.stringify(current, (k, v) => typeof v === 'number' ? Math.round(v * 100) / 100 : v));
console.log('周期底附近:', JSON.stringify(atBottoms, (k, v) => typeof v === 'number' ? Math.round(v * 100) / 100 : v));
