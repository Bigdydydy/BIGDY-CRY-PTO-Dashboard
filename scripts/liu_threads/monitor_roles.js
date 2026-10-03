#!/usr/bin/env node
/**
 * 柳玉冬监测点的「结构角色」统计 (柳玉冬语料 × 真实K线)
 * -----------------------------------------------------------------------------
 * 对每个监测点，在发帖前的 1h K线上按多个级别 (2/4/8/16×ATR) 取拐点，
 * 找出与监测点最接近的「级别 × 往前第几个同向拐点」(同向: 监测点在现价下方取低点，上方取高点)。
 * 训练段统计最常见的角色作为规则，检验段比较: 规则选出的价位 / 引擎现行监测点 与柳玉冬监测点的距离。
 *
 * 用法: node scripts/liu_threads/monitor_roles.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('../../server/wave_engine');

const ROOT = path.join(__dirname, '..', '..');
const TUNING = path.join(ROOT, 'data', 'liu_monitor_tuning.json');
const OUT = path.join(ROOT, 'data', 'liu_monitor_roles.json');
const CACHE_DIR = path.join(os.tmpdir(), 'liu_replay_cache');
const DEGREES = [2, 4, 8, 16];
const MAX_RANK = 4;
const WINDOW = 1000;
const MATCH_PCT = 0.5;

const median = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (n, d) => (d ? Math.round(1000 * n / d) / 10 : null);

function loadBars(sym) {
  // 复用 tune_monitor.js 写下的缓存 (同一标的取覆盖最长的一份)
  const files = fs.readdirSync(CACHE_DIR).filter(f => f.startsWith(sym + '_1h_'));
  let best = null;
  for (const f of files) { const b = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf8')); if (!best || b.length > best.length) best = b; }
  return best;
}

function idxAtOrBefore(bars, ts) {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (bars[mid].time <= ts) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}

/** 各级别、各名次的同向拐点价位: roles['8x#2'] = 价位 */
function rolesAt(win, px, side) {
  const atr = win.slice(-200).reduce((s, b) => s + b.high - b.low, 0) / Math.min(200, win.length);
  const out = {};
  for (const m of DEGREES) {
    const piv = E._internal.zigzagPivots(win, atr * m)
      .filter(p => p.type === side && (side === 'low' ? p.price < px : p.price > px))
      .sort((a, b) => b.idx - a.idx);
    piv.slice(0, MAX_RANK).forEach((p, k) => { out[`${m}x#${k + 1}`] = p.price; });
  }
  return out;
}

function main() {
  const tuning = JSON.parse(fs.readFileSync(TUNING, 'utf8'));
  const symOf = {};
  const threads = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'liu_wave_threads.json'), 'utf8'));
  Object.entries(threads.symbols).forEach(([code, th]) => { if (th.binance) symOf[code] = th.binance; });
  symOf.BTC = 'BTCUSDT';
  const tsOf = r => Date.parse(r.date + 'T00:00:00Z') / 1000;

  const items = [];
  for (const r of tuning.rows) {
    const bars = loadBars(symOf[r.code]);
    if (!bars) continue;
    const thread = threads.symbols[r.code];
    const entry = thread && thread.entries.find(e => e.id === r.id);
    const ts = entry ? entry.ts : (r.source === 'manual' ? Date.parse('2026-10-02T12:00:00Z') / 1000 : tsOf(r));
    const i = idxAtOrBefore(bars, ts);
    if (i < 250) continue;
    const win = bars.slice(Math.max(0, i - WINDOW + 1), i + 1);
    const px = bars[i].close;
    for (const m of r.liu) {
      if (!(m > px * 0.7 && m < px * 1.3)) continue;
      const side = m < px ? 'low' : 'high';
      const roles = rolesAt(win, px, side);
      let best = null;
      for (const [k, p] of Object.entries(roles)) {
        const d = 100 * Math.abs(p - m) / m;
        if (!best || d < best.dist) best = { role: k, dist: d };
      }
      items.push({ bars, i, code: r.code, date: r.date, source: r.source, liu: m, side, px, roles, best, engineNow: r.engineNow,
        engineDist: 100 * Math.abs(r.engineNow - m) / m, natural: r.variants.natural.level });
    }
  }
  items.sort((a, b) => a.date.localeCompare(b.date));
  const corpus = items.filter(x => x.source === 'corpus');
  const cut = Math.floor(corpus.length * 0.6);
  const train = corpus.slice(0, cut), test = corpus.slice(cut).concat(items.filter(x => x.source === 'manual'));

  // 训练段: 角色频次 (仅统计匹配到 ≤0.5% 的)
  const freq = {};
  train.filter(x => x.best && x.best.dist <= MATCH_PCT).forEach(x => { freq[x.best.role] = (freq[x.best.role] || 0) + 1; });
  const ranked = Object.entries(freq).sort((a, b) => b[1] - a[1]);
  console.log(`训练段 ${train.length} 个监测点，其中 ${train.filter(x => x.best && x.best.dist <= MATCH_PCT).length} 个与某一级拐点相差 ≤${MATCH_PCT}%`);
  console.log('  最常见的角色（级别×ATR #往前第几个同向拐点）：' + ranked.slice(0, 8).map(([k, n]) => `${k}:${n}`).join('  '));
  const byDeg = {}, byRank = {};
  ranked.forEach(([k, n]) => { const [d, rk] = k.split('#'); byDeg[d] = (byDeg[d] || 0) + n; byRank['#' + rk] = (byRank['#' + rk] || 0) + n; });
  console.log('  按级别：' + JSON.stringify(byDeg) + '  按名次：' + JSON.stringify(byRank));

  // 规则: 训练段最常见的角色；检验段比较距离
  const rule = ranked.length ? ranked[0][0] : '4x#1';
  // 零模型基线: 不看结构，按训练段的中位偏离把监测点放在现价下方 / 上方固定百分比处
  const offset = {};
  for (const side of ['low', 'high']) offset[side] = median(train.filter(x => x.side === side).map(x => Math.abs(x.liu - x.px) / x.px)) || 0.02;
  const baseOf = x => (x.side === 'low' ? x.px * (1 - offset.low) : x.px * (1 + offset.high));
  console.log(`  零模型：现价下方 ${(100 * offset.low).toFixed(2)}% / 上方 ${(100 * offset.high).toFixed(2)}%`);
  const evalSet = (set, label) => {
    const bd = set.map(x => 100 * Math.abs(baseOf(x) - x.liu) / x.liu);
    const rd = set.map(x => (x.roles[rule] ? 100 * Math.abs(x.roles[rule] - x.liu) / x.liu : null)).filter(v => v !== null);
    const ed = set.map(x => x.engineDist);
    const nd = set.map(x => 100 * Math.abs(x.natural - x.liu) / x.liu);
    const anyd = set.map(x => (x.best ? x.best.dist : null)).filter(v => v !== null);
    console.log(`\n${label}（${set.length} 个监测点）`);
    console.log(`  引擎现行监测点     中位距离 ${median(ed).toFixed(2)}%  ≤1% ${pct(ed.filter(v => v <= 1).length, ed.length)}%  ≤2% ${pct(ed.filter(v => v <= 2).length, ed.length)}%`);
    console.log(`  段内自然子级别     中位距离 ${median(nd).toFixed(2)}%  ≤1% ${pct(nd.filter(v => v <= 1).length, nd.length)}%  ≤2% ${pct(nd.filter(v => v <= 2).length, nd.length)}%`);
    console.log(`  规则 ${rule.padEnd(6)}       中位距离 ${median(rd).toFixed(2)}%  ≤1% ${pct(rd.filter(v => v <= 1).length, rd.length)}%  ≤2% ${pct(rd.filter(v => v <= 2).length, rd.length)}%（${rd.length} 个有该角色）`);
    console.log(`  零模型(固定百分比) 中位距离 ${median(bd).toFixed(2)}%  ≤1% ${pct(bd.filter(v => v <= 1).length, bd.length)}%  ≤2% ${pct(bd.filter(v => v <= 2).length, bd.length)}%`);
    console.log(`  事后最优角色(上限) 中位距离 ${median(anyd).toFixed(2)}%  ≤0.5% ${pct(anyd.filter(v => v <= 0.5).length, anyd.length)}%`);
  };
  evalSet(train, '训练段');
  evalSet(test, '检验段');

  // 结局指标: 监测点事后是否有用 (不看与柳玉冬是否接近)
  //   5 日内被破且此后 3 日继续向破位方向 → 真破位；未被破且 5 日后沿原方向 → 守住；其余 → 失败
  const outcome = (x, level) => {
    const bars = x.bars, i = x.i, sup = x.side === 'low';
    if (i + 120 + 72 >= bars.length) return null;
    for (let k = i + 1; k <= i + 120; k++) {
      if (sup ? bars[k].low < level : bars[k].high > level) {
        const after = bars[Math.min(bars.length - 1, k + 72)].close;
        return (sup ? after < level : after > level) ? 'trueBreak' : 'falseBreak';
      }
    }
    const end = bars[i + 120].close;
    return (sup ? end > x.px : end < x.px) ? 'held' : 'drift';
  };
  const scoreOf = (set, levelOf) => {
    const r = set.map(x => outcome(x, levelOf(x))).filter(Boolean);
    const c = k => r.filter(v => v === k).length;
    return { n: r.length, useful: pct(c('trueBreak') + c('held'), r.length), trueBreak: c('trueBreak'), falseBreak: c('falseBreak'), held: c('held'), drift: c('drift'),
      breakPrecision: pct(c('trueBreak'), c('trueBreak') + c('falseBreak')) };
  };
  for (const [label, set] of [['训练段', train], ['检验段', test]]) {
    console.log(`\n结局（${label}）：有用=真破位或守住；破位准确率=真破位/(真破位+假破位)`);
    for (const [name, f] of [['柳玉冬', x => x.liu], ['引擎现行', x => x.engineNow], ['段内自然子级别', x => x.natural], ['零模型', baseOf]]) {
      const s = scoreOf(set, f);
      console.log(`  ${name.padEnd(8)} 有用 ${String(s.useful).padEnd(5)}%（${s.n}）  真破 ${s.trueBreak} 假破 ${s.falseBreak} 守住 ${s.held} 漂移 ${s.drift}  破位准确率 ${s.breakPrecision}%`);
    }
  }
  items.filter(x => x.source === 'manual').forEach(x => console.log(`\n人工案例 ${x.code}: 柳玉冬 ${x.liu}，最接近 ${x.best.role}=${x.roles[x.best.role]}（${x.best.dist.toFixed(2)}%）；规则 ${rule}=${x.roles[rule]}；引擎现行 ${x.engineNow}`));
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), rule, freq: ranked, items: items.map(({ bars, i, ...rest }) => rest) }, null, 1));
  console.log(`→ ${OUT}`);
}

if (require.main === module) main();
