#!/usr/bin/env node
/**
 * 研究脚本：BTC 25Δ 偏斜是否领先 DVOL 跳升？(美股 "SKEW 先行 → VIX 飙升" 叙事在加密的检验)
 *
 * 输入：scripts/research/skew_dvol_fetch.js 的产物 (research/skew_dvol/*)
 * 输出：research/skew_dvol/series.json、research/skew_dvol/results.json，并打印摘要
 *
 * 口径：
 *   - 每日 04:00–08:00 UTC 成交 IV (合约中位数)，取 14–60 天到期、虚值一侧，按 Call Delta x 拟合
 *     iv = a + b(x−0.5) + c(x−0.5)²，权重偏向 30 天。RR = iv(0.25) − iv(0.75) (Call − Put，负 = Put 贵)，
 *     ATM = a，RRn = RR / ATM (无量纲，类比 CBOE SKEW 的"标准化偏度")。
 *   - 远期近似为指数价 (忽略基差)，Delta 用 Black-76、r = 0、不做溢价调整。
 *   - DVOL 跳升事件：5 日变化 ≥ 全样本 95 分位，且前 30 天内无事件 (去簇)。
 *   - 偏斜"贵贱"用因果分位：只与 t 之前 365 天比较 (至少 120 个观测)。
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'research', 'skew_dvol');
const DAY = 86400000;
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

function parseInst(name) {
  const m = /^BTC-(\d{1,2})([A-Z]{3})(\d{2})-(\d+)-([CP])$/.exec(name);
  if (!m) return null;
  return { expiry: Date.UTC(2000 + Number(m[3]), MONTHS[m[2]], Number(m[1]), 8), strike: Number(m[4]), type: m[5] };
}

/** 加权最小二乘拟合二次式，返回 [a,b,c] */
function wls(pts) {
  const S = Array.from({ length: 3 }, () => [0, 0, 0]);
  const v = [0, 0, 0];
  for (const { u, y, w } of pts) {
    const f = [1, u, u * u];
    for (let i = 0; i < 3; i++) { v[i] += w * f[i] * y; for (let j = 0; j < 3; j++) S[i][j] += w * f[i] * f[j]; }
  }
  // 高斯消元
  const A = S.map((r, i) => [...r, v[i]]);
  for (let i = 0; i < 3; i++) {
    let p = i;
    for (let r = i + 1; r < 3; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]];
    if (Math.abs(A[i][i]) < 1e-12) return null;
    for (let r = 0; r < 3; r++) {
      if (r === i) continue;
      const f = A[r][i] / A[i][i];
      for (let c = i; c < 4; c++) A[r][c] -= f * A[i][c];
    }
  }
  return A.map((r, i) => r[3] / r[i]);
}

function fitDay(rec) {
  const t0 = Date.parse(`${rec.day}T08:00:00Z`);
  const F = rec.index;
  if (!Number.isFinite(F)) return null;
  const pts = [];
  for (const [name, [iv, n]] of Object.entries(rec.insts)) {
    const p = parseInst(name);
    if (!p) continue;
    const days = (p.expiry - t0) / DAY;
    if (days < 14 || days > 60) continue;
    if (p.type === 'C' ? p.strike < F : p.strike > F) continue; // 只用虚值一侧
    const T = days / 365;
    const s = iv / 100;
    const x = normCdf((Math.log(F / p.strike) + 0.5 * s * s * T) / (s * Math.sqrt(T)));
    if (x < 0.08 || x > 0.92) continue;
    pts.push({ u: x - 0.5, y: iv, w: Math.sqrt(n) / (1 + Math.abs(days - 30) / 15), x });
  }
  const enough = ps => ps.filter(p => p.x >= 0.10 && p.x <= 0.40).length >= 3 && ps.filter(p => p.x >= 0.60 && p.x <= 0.90).length >= 3;
  if (!enough(pts)) return null;
  let coef = wls(pts);
  if (!coef) return null;
  const res = pts.map(p => p.y - (coef[0] + coef[1] * p.u + coef[2] * p.u * p.u));
  const absr = res.map(Math.abs).sort((a, b) => a - b);
  const mad = absr[absr.length >> 1] * 1.4826;
  const keep = pts.filter((p, i) => Math.abs(res[i]) <= Math.max(2, 3 * mad));
  if (!enough(keep)) return null;
  coef = wls(keep);
  if (!coef) return null;
  const [a, b, c] = coef;
  const rr = -0.5 * b;
  return { atm: a, rr, rrn: rr / a, bf: c * 0.0625, n: keep.length };
}

function pctRank(arr, v) {
  let below = 0;
  for (const a of arr) if (a < v) below++; else if (a === v) below += 0.5;
  return (below / arr.length) * 100;
}

function quantile(xs, q) {
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo);
}

const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;

function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function main() {
  const dvol = JSON.parse(fs.readFileSync(path.join(DIR, 'dvol.json'), 'utf8')).data;
  const dvolBy = new Map(dvol.map(r => [r.day, r.close]));
  const lines = fs.readdirSync(DIR).filter(f => /^daily_insts.*\.jsonl$/.test(f))
    .flatMap(f => fs.readFileSync(path.join(DIR, f), 'utf8').split('\n').filter(Boolean));
  const byDay = new Map();
  for (const l of lines) {
    try { const r = JSON.parse(l); byDay.set(r.day, r); } catch (_) { /* 中断留下的半行忽略 */ }
  }

  // 连续日历序列
  const days = [...byDay.keys()].sort();
  const series = [];
  for (let ts = Date.parse(days[0]); ts <= Date.parse(days[days.length - 1]); ts += DAY) {
    const day = new Date(ts).toISOString().slice(0, 10);
    const rec = byDay.get(day);
    const fit = rec ? fitDay(rec) : null;
    series.push({ day, spot: rec?.index ?? null, dvol: dvolBy.get(day) ?? null, ...(fit || { atm: null, rr: null, rrn: null, bf: null, n: 0 }) });
  }
  const N = series.length;
  const fitted = series.filter(s => s.rr !== null).length;

  // 单日成交重建的 RR 噪声约 ±1.5 点 (与线上 RR30 相关 0.85)：用因果 3 日中位数平滑
  const med3 = (i, k) => {
    const xs = series.slice(Math.max(0, i - 2), i + 1).map(r => r[k]).filter(v => v !== null).sort((a, b) => a - b);
    return xs.length >= 2 ? (xs.length % 2 ? xs[xs.length >> 1] : (xs[0] + xs[1]) / 2) : null;
  };
  const sm = series.map((_, i) => ({ rr: med3(i, 'rr'), rrn: med3(i, 'rrn'), atm: med3(i, 'atm') }));
  series.forEach((s, i) => {
    s.rrRaw = s.rr; s.rrnRaw = s.rrn; s.atmRaw = s.atm;
    s.rr = sm[i].rr; s.rrn = sm[i].rrn; s.atm = sm[i].atm;
  });

  // 派生量
  for (let i = 0; i < N; i++) {
    const s = series[i];
    const p5 = series[i - 5];
    s.dDvol5 = p5 && s.dvol !== null && p5.dvol !== null ? s.dvol - p5.dvol : null;
    s.ret5 = p5 && s.spot && p5.spot ? Math.log(s.spot / p5.spot) : null;
    const hist = k => series.slice(Math.max(0, i - 365), i).map(r => r[k]).filter(v => v !== null);
    for (const k of ['rr', 'rrn', 'dvol']) {
      const h = hist(k);
      s[`${k}Pct`] = s[k] !== null && h.length >= 120 ? pctRank(h, s[k]) : null;
    }
  }

  // 事件
  const d5 = series.map(s => s.dDvol5).filter(v => v !== null);
  const thr = quantile(d5, 0.95);
  const events = [];
  let last = -Infinity;
  for (let i = 0; i < N; i++) {
    const s = series[i];
    if (s.dDvol5 !== null && s.dDvol5 >= thr && i - last > 30) {
      events.push({ i, day: s.day, dDvol5: s.dDvol5, dvol: s.dvol, ret5: s.ret5, dir: s.ret5 === null ? '?' : (s.ret5 < 0 ? 'down' : 'up') });
      last = i;
    }
    if (s.dDvol5 !== null && s.dDvol5 >= thr) last = Math.max(last, i); // 簇内持续的天数也顺延冷却期
  }

  const winMean = (i, k, a, b) => {
    const xs = series.slice(Math.max(0, i - a), Math.max(0, i - b + 1)).map(r => r[k]).filter(v => v !== null);
    return xs.length >= Math.ceil((a - b + 1) / 2) ? mean(xs) : null;
  };
  const at = (i, k) => series[i]?.[k] ?? null;
  for (const e of events) {
    e.rrPctPre = winMean(e.i, 'rrPct', 28, 7);
    e.rrPctPreNear = winMean(e.i, 'rrPct', 7, 1);
    e.rrnPctPre = winMean(e.i, 'rrnPct', 28, 7);
    e.dvolPctPre = winMean(e.i, 'dvolPct', 28, 7);
    e.rrPre = winMean(e.i, 'rr', 28, 7);
    // 同期变化用原始值：事件日前后 [t−1, t+1] 均值 − 跳升前 [t−8, t−5] 均值 (平滑会把跳升本身磨掉)
    const rawMean = (k, a, b) => {
      const xs = series.slice(Math.max(0, e.i + a), Math.min(N, e.i + b + 1)).map(r => r[k]).filter(v => v !== null);
      return xs.length ? mean(xs) : null;
    };
    const dRaw = k => { const post = rawMean(k, -1, 1); const pre0 = rawMean(k, -8, -5); return post !== null && pre0 !== null ? post - pre0 : null; };
    e.dRr = dRaw('rrRaw');
    e.dRrn = dRaw('rrnRaw');
    e.dAtm = dRaw('atmRaw');
    e.rrAt = at(e.i, 'rr');
    e.rrPctAt = at(e.i, 'rrPct');
  }

  // 安慰剂：随机抽同样数量的日子，统计同一窗口均值的分布
  const placebo = (k, a, b, evs) => {
    const valid = [];
    for (let i = 0; i < N; i++) { const v = winMean(i, k, a, b); if (v !== null) valid.push(v); }
    const obs = evs.map(e => winMean(e.i, k, a, b)).filter(v => v !== null);
    if (!obs.length) return null;
    const m = mean(obs);
    const rnd = seeded(42);
    let le = 0;
    const R = 20000;
    for (let r = 0; r < R; r++) {
      let s = 0;
      for (let j = 0; j < obs.length; j++) s += valid[Math.floor(rnd() * valid.length)];
      if (s / obs.length <= m) le++;
    }
    return { n: obs.length, eventMean: m, uncondMean: mean(valid), pLow: le / R };
  };

  const groups = { all: events, down: events.filter(e => e.dir === 'down'), up: events.filter(e => e.dir === 'up') };
  const pre = {};
  for (const [g, evs] of Object.entries(groups)) {
    pre[g] = {
      rrPct_28to7: placebo('rrPct', 28, 7, evs),
      rrPct_7to1: placebo('rrPct', 7, 1, evs),
      rrnPct_28to7: placebo('rrnPct', 28, 7, evs),
      dvolPct_28to7: placebo('dvolPct', 28, 7, evs)
    };
  }

  // 反向：信号日之后 28 天内出现跳升 (Δ5 ≥ 阈值) 的概率 vs 基准
  const spikeAhead = (i, dirFilter) => {
    for (let j = i + 1; j <= Math.min(N - 1, i + 28); j++) {
      const s = series[j];
      if (s.dDvol5 !== null && s.dDvol5 >= thr && (!dirFilter || (s.ret5 !== null && (dirFilter === 'down' ? s.ret5 < 0 : s.ret5 >= 0)))) return true;
    }
    return false;
  };
  const eligible = [];
  for (let i = 0; i < N - 28; i++) if (series[i].rrPct !== null && series[i].dvolPct !== null) eligible.push(i);
  const signals = {
    'RR 分位 ≤ 10 (Put 最贵的一成)': i => series[i].rrPct <= 10,
    'RR 分位 ≤ 20 且 DVOL 分位 ≤ 30 (美股式：偏斜贵、波动低)': i => series[i].rrPct <= 20 && series[i].dvolPct <= 30,
    'RRn 分位 ≤ 10 (标准化偏斜)': i => series[i].rrnPct !== null && series[i].rrnPct <= 10,
    'RR 分位 ≥ 90 (Call 最贵的一成)': i => series[i].rrPct >= 90,
    // 仪表盘 Card 05 的贵贱阈值 (≤20 / ≥80) 对应的基准率
    'RR 分位 ≤ 20 (卡片阈值：Put 偏贵)': i => series[i].rrPct <= 20,
    'RR 分位 ≥ 80 (卡片阈值：Call 偏贵)': i => series[i].rrPct >= 80,
    'RR 分位 20–80 (卡片：常态)': i => series[i].rrPct > 20 && series[i].rrPct < 80,
    '对照：DVOL 分位 ≤ 10 (只看波动低位，不看偏斜)': i => series[i].dvolPct <= 10,
    '对照：DVOL 分位 ≤ 30 (组合信号去掉偏斜条件)': i => series[i].dvolPct <= 30,
    '对照：DVOL 分位 ≤ 30 且 RR 分位 > 20 (波动低但偏斜不贵)': i => series[i].dvolPct <= 30 && series[i].rrPct > 20
  };
  const rate = (idx, dir) => idx.length ? idx.filter(i => spikeAhead(i, dir)).length / idx.length : null;
  const episodes = idx => idx.filter((i, k) => k === 0 || i - idx[k - 1] > 1).length;
  const reverse = { base: { n: eligible.length, any: rate(eligible), down: rate(eligible, 'down'), up: rate(eligible, 'up') } };
  for (const [name, f] of Object.entries(signals)) {
    const idx = eligible.filter(f);
    reverse[name] = { n: idx.length, episodes: episodes(idx), any: rate(idx), down: rate(idx, 'down'), up: rate(idx, 'up') };
  }

  // 分层：RR 与近期收益高度相关，偏斜"预测方向"可能只是趋势延续 → 按事前 28 日涨跌分层再比
  const ret28 = i => (series[i].spot && series[i - 28]?.spot ? Math.log(series[i].spot / series[i - 28].spot) : null);
  const strata = {};
  for (const [label, cond] of [['事前28日下跌', i => ret28(i) !== null && ret28(i) < 0], ['事前28日上涨', i => ret28(i) !== null && ret28(i) >= 0]]) {
    const base = eligible.filter(cond);
    strata[label] = {
      base: { n: base.length, down: rate(base, 'down'), up: rate(base, 'up') },
      putRich: (idx => ({ n: idx.length, down: rate(idx, 'down'), up: rate(idx, 'up') }))(base.filter(i => series[i].rrPct <= 20)),
      callRich: (idx => ({ n: idx.length, down: rate(idx, 'down'), up: rate(idx, 'up') }))(base.filter(i => series[i].rrPct >= 80))
    };
  }

  // 同期：跳升期间偏斜怎么变
  const contemp = {};
  for (const [g, evs] of Object.entries(groups)) {
    const v = k => evs.map(e => e[k]).filter(x => x !== null);
    contemp[g] = {
      n: evs.length,
      dAtmMean: mean(v('dAtm')),
      dRrMean: mean(v('dRr')),
      dRrMedian: quantile(v('dRr'), 0.5),
      shareRrMoreNegative: v('dRr').filter(x => x < 0).length / v('dRr').length,
      dRrnMean: mean(v('dRrn')),
      shareRrnMoreNegative: v('dRrn').filter(x => x < 0).length / v('dRrn').length
    };
  }

  // 全样本同期相关：DVOL 5 日变化 vs RR 5 日变化
  const pairs = [];
  for (let i = 5; i < N; i++) {
    const s = series[i]; const p = series[i - 5];
    if (s.dDvol5 !== null && s.rr !== null && p.rr !== null && s.ret5 !== null) pairs.push([s.dDvol5, s.rr - p.rr, s.ret5]);
  }
  const corr = (xs, ys) => {
    const mx = mean(xs), my = mean(ys);
    let sxy = 0, sxx = 0, syy = 0;
    for (let k = 0; k < xs.length; k++) { sxy += (xs[k] - mx) * (ys[k] - my); sxx += (xs[k] - mx) ** 2; syy += (ys[k] - my) ** 2; }
    return sxy / Math.sqrt(sxx * syy);
  };
  const corrs = {
    'Δ5 DVOL vs Δ5 RR': corr(pairs.map(p => p[0]), pairs.map(p => p[1])),
    'Δ5 RR vs 5日收益': corr(pairs.map(p => p[1]), pairs.map(p => p[2])),
    'Δ5 DVOL vs 5日收益': corr(pairs.map(p => p[0]), pairs.map(p => p[2]))
  };

  const results = {
    generatedAt: new Date().toISOString(),
    coverage: { from: series[0].day, to: series[N - 1].day, calendarDays: N, fittedDays: fitted },
    threshold: { dDvol5_p95: thr },
    events: events.map(({ i, ...e }) => e),
    preEvent: pre,
    reverse,
    reverseByPriorTrend: strata,
    contemporaneous: contemp,
    correlations: corrs,
    rrSummary: { mean: mean(series.filter(s => s.rr !== null).map(s => s.rr)), shareNegative: series.filter(s => s.rr !== null && s.rr < 0).length / fitted }
  };
  fs.writeFileSync(path.join(DIR, 'series.json'), JSON.stringify(series.map(s => ({ day: s.day, spot: s.spot, dvol: s.dvol, atm: s.atm, rr: s.rr, rrn: s.rrn, n: s.n }))));
  fs.writeFileSync(path.join(DIR, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, (k, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v), 2));
}

main();
