#!/usr/bin/env node
/**
 * 监测点级别调参 (柳玉冬语料 × 真实K线, 按时间滚动检验)
 * -----------------------------------------------------------------------------
 * 引擎的监测点 = 当前段 (主级别 O→X) 内最近一个与起点同向的子浪拐点。
 * 子浪级别由阈值决定: 现行为本段幅度的 6%。本脚本比较多种级别:
 *   f=0.06 / 0.10 / 0.15 / 0.20 / 0.30 (阈值 = max(0.8×ATR, f×本段幅度))
 *   natural = 由粗到细第一个能分出 ≥3 段的级别 (与子浪探测的「自然子级别」一致)
 * 每篇带监测点的帖子只用发帖前的 1h K线。指标:
 *   1. 与柳玉冬监测点的距离 (取帖子里最近的一个监测点)
 *   2. 据此监测点的 3 日方向命中率 (未破=沿本段方向, 已破=反向)
 * 按日期前 60% 训练选级别, 后 40% 检验; 另含人工标注案例 (data/liu_manual_cases.json)。
 *
 * 用法: node scripts/liu_threads/tune_monitor.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('../../server/wave_engine');

const ROOT = path.join(__dirname, '..', '..');
const THREADS = path.join(ROOT, 'data', 'liu_wave_threads.json');
const MANUAL = path.join(ROOT, 'data', 'liu_manual_cases.json');
const OUT = path.join(ROOT, 'data', 'liu_monitor_tuning.json');
const CACHE_DIR = path.join(os.tmpdir(), 'liu_replay_cache');
const H = 3600;
const WINDOW = 1000;
const HORIZON_DIR = 72;
const TRAIN_FRAC = 0.6;
const VARIANTS = ['f0.06', 'f0.10', 'f0.15', 'f0.20', 'f0.30', 'natural'];
const NATURAL_MULTS = [0.30, 0.236, 0.18, 0.14, 0.10, 0.07, 0.05];

async function fetchKlines(symbol, startSec, endSec) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = path.join(CACHE_DIR, `${symbol}_1h_${startSec}_${endSec}.json`);
  if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  const bars = [];
  let cursor = startSec * 1000;
  while (cursor < endSec * 1000) {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=1500&startTime=${cursor}&endTime=${endSec * 1000}`;
    let raw = null;
    for (let t = 0; t < 4 && !raw; t++) {
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!resp.ok) throw new Error(`${symbol} HTTP ${resp.status}`);
        raw = await resp.json();
      } catch (e) { if (t === 3) throw e; await new Promise(z => setTimeout(z, 1500)); }
    }
    if (!Array.isArray(raw) || !raw.length) break;
    for (const b of raw) bars.push({ time: Math.floor(b[0] / 1000), open: +b[1], high: +b[2], low: +b[3], close: +b[4], volume: +b[5] });
    const next = raw[raw.length - 1][0] + H * 1000;
    if (next <= cursor) break;
    cursor = next;
  }
  fs.writeFileSync(cacheFile, JSON.stringify(bars));
  return bars;
}

function idxAtOrBefore(bars, ts) {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (bars[mid].time <= ts) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}
const median = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (n, d) => (d ? Math.round(1000 * n / d) / 10 : null);
const avgTR = bars => bars.reduce((s, b) => s + b.high - b.low, 0) / Math.max(1, bars.length);

/** 当前段 O→X 内, 给定阈值下最近一个与 O 同向的子浪拐点 (无则取 O) */
function monitorAt(seg, O, X, thr) {
  const piv = E._internal.zigzagPivots(seg, thr);
  const type = X.price > O.price ? 'low' : 'high';
  let best = null;
  for (const p of piv) {
    if (p.type !== type || p.idx <= 0 || p.idx >= seg.length - 1) continue;
    if (type === 'low' ? p.price <= O.price : p.price >= O.price) continue; // 须在起点之内
    if (!best || p.idx > best.idx) best = p;
  }
  return { price: best ? best.price : O.price, swings: piv.length - 1 };
}

function variantMonitors(win, ls) {
  const O = ls.activeLeg.from, X = ls.activeLeg.extreme;
  const iO = idxAtOrBefore(win, O.time), iX = idxAtOrBefore(win, X.time);
  const seg = win.slice(iO, iX + 1);
  const S = Math.abs(X.price - O.price);
  const out = {};
  if (seg.length < 4 || !(S > 0)) return null;
  const atr = avgTR(seg);
  for (const v of VARIANTS) {
    if (v === 'natural') {
      let m = null;
      for (const f of NATURAL_MULTS) {
        const r = monitorAt(seg, O, X, Math.max(0.8 * atr, f * S));
        if (r.swings >= 3) { m = r; break; }
      }
      out[v] = (m || { price: O.price }).price;
    } else {
      out[v] = monitorAt(seg, O, X, Math.max(0.8 * atr, parseFloat(v.slice(1)) * S)).price;
    }
  }
  return { levels: out, d: X.price > O.price ? 1 : -1, iX };
}

/** 据监测点的方向判断: 发帖时已破 → 反向, 未破 → 沿本段方向 */
function biasFor(win, iX, d, level) {
  for (let k = iX + 1; k < win.length; k++) {
    if (d > 0 ? win[k].low < level : win[k].high > level) return -d;
  }
  return d;
}

async function collectCases() {
  const data = JSON.parse(fs.readFileSync(THREADS, 'utf8'));
  const cases = [];
  for (const [code, th] of Object.entries(data.symbols)) {
    if (!th.binance) continue;
    for (const e of th.entries) {
      const mons = e.levels.filter(l => l.kind === 'monitor').map(l => l.price);
      if (!mons.length) continue;
      cases.push({ code, binance: th.binance, ts: e.ts, date: e.date, id: e.id, monitors: mons, stance: e.stance || null, source: 'corpus' });
    }
  }
  if (fs.existsSync(MANUAL)) {
    for (const c of JSON.parse(fs.readFileSync(MANUAL, 'utf8')).cases.filter(x => Array.isArray(x.monitors) && x.monitors.length)) {
      cases.push(Object.assign({ source: 'manual' }, c, { ts: Math.floor(Date.parse(c.time) / 1000), date: c.time.slice(0, 10) }));
    }
  }
  return cases.sort((a, b) => a.ts - b.ts);
}

async function main() {
  const cases = await collectCases();
  const bySym = {};
  cases.forEach(c => { (bySym[c.binance] = bySym[c.binance] || []).push(c); });
  const rows = [];
  for (const [sym, list] of Object.entries(bySym)) {
    const start = list[0].ts - 70 * 86400;
    const end = Math.min(list[list.length - 1].ts + 8 * 86400, Math.floor(Date.now() / 1000));
    let bars;
    try { bars = await fetchKlines(sym, start, end); } catch (e) { console.log(`${sym}: K线失败 ${e.message}`); continue; }
    for (const c of list) {
      const i = idxAtOrBefore(bars, c.ts);
      if (i < 250) continue;
      const win = bars.slice(Math.max(0, i - WINDOW + 1), i + 1);
      let res;
      try { res = E.analyzeWaves(win, c.code, { timeframe: '1h' }); } catch (e) { continue; }
      const ls = res.liuSignals;
      if (!ls) continue;
      const vm = variantMonitors(win, ls);
      if (!vm) continue;
      const px = bars[i].close;
      const move = i + HORIZON_DIR < bars.length ? Math.sign(bars[i + HORIZON_DIR].close - px) : null;
      const row = { code: c.code, date: c.date, id: c.id, source: c.source, close: px, liu: c.monitors, stance: c.stance, move3d: move, engineNow: ls.monitorPoint.price, variants: {} };
      for (const v of VARIANTS) {
        const lvl = vm.levels[v];
        const dist = Math.min(...c.monitors.map(m => Math.abs(lvl - m) / m));
        const bias = biasFor(win, vm.iX, vm.d, lvl);
        row.variants[v] = { level: +lvl.toFixed(4), distPct: +(100 * dist).toFixed(2), hit: move ? bias === move : null };
      }
      row.liuHit = move && c.stance ? (c.stance === 'BULL' ? 1 : c.stance === 'BEAR' ? -1 : 0) === move : null;
      rows.push(row);
    }
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  const corpusRows = rows.filter(r => r.source === 'corpus');
  const cut = Math.floor(corpusRows.length * TRAIN_FRAC);
  const train = corpusRows.slice(0, cut), test = corpusRows.slice(cut).concat(rows.filter(r => r.source === 'manual'));

  const summarize = set => {
    const o = {};
    for (const v of VARIANTS) {
      const d = set.map(r => r.variants[v].distPct);
      const h = set.filter(r => r.variants[v].hit !== null);
      o[v] = { n: set.length, medianDistPct: median(d), within1Pct: pct(d.filter(x => x <= 1).length, d.length), within2Pct: pct(d.filter(x => x <= 2).length, d.length), dirHitPct: pct(h.filter(r => r.variants[v].hit).length, h.length) };
    }
    const lh = set.filter(r => r.liuHit !== null);
    o.liuStanceHitPct = pct(lh.filter(r => r.liuHit).length, lh.length);
    return o;
  };
  const trainSum = summarize(train), testSum = summarize(test);
  // 训练段上按中位距离选级别 (同距离时取方向命中率高者)
  const best = VARIANTS.slice().sort((a, b) => (trainSum[a].medianDistPct - trainSum[b].medianDistPct) || (trainSum[b].dirHitPct - trainSum[a].dirHitPct))[0];

  const show = (title, s) => {
    console.log(`\n${title}（${s[VARIANTS[0]].n} 例，柳玉冬立场 3 日命中 ${s.liuStanceHitPct}%）`);
    console.log('  级别      中位距离  ≤1%    ≤2%    3日方向命中');
    VARIANTS.forEach(v => console.log(`  ${v.padEnd(8)}  ${String(s[v].medianDistPct).padEnd(8)}  ${String(s[v].within1Pct).padEnd(5)}  ${String(s[v].within2Pct).padEnd(5)}  ${s[v].dirHitPct}`));
  };
  show(`训练段 ${train[0] && train[0].date} ~ ${train[train.length - 1] && train[train.length - 1].date}`, trainSum);
  show(`检验段 ${test[0] && test[0].date} ~ ${test[test.length - 1] && test[test.length - 1].date}`, testSum);
  console.log(`\n训练段选出的级别: ${best}（现行 f0.06）`);
  rows.filter(r => r.source === 'manual').forEach(r => {
    console.log(`人工案例 ${r.code} ${r.date}: 柳玉冬 ${r.liu.join('/')}；` + VARIANTS.map(v => `${v}=${r.variants[v].level}(${r.variants[v].distPct}%)`).join(' '));
  });
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), trainFrac: TRAIN_FRAC, variants: VARIANTS, best, train: trainSum, test: testSum, rows }, null, 1));
  console.log(`→ ${OUT}`);
}

if (require.main === module) main();
