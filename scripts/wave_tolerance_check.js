#!/usr/bin/env node
/**
 * 容差带与时间窗口的回测校准
 * -----------------------------------------------------------------------------
 * 在 BTCUSDT / ETHUSDT 4H 历史上按 wave_track_record.js 的方式回放 (容差带放宽到 WIDE)，取前 TOP 名候选的标准化预测并结算，
 * 每条预测附带:
 *   - 接近阈值违规的最大幅度 (nearMax，0 = 无违规)
 *   - 时间指引的符合情况，当前浪相对常见时间窗口的位置 (早于 / 窗口内 / 已超出)
 * 输出:
 *   1. 按违规幅度分组的命中/随机游走期望；不同带宽下每次回放首选计数的命中/期望
 *   2. 按时间指引、时间窗口位置分组的命中/期望
 * 用法: node scripts/wave_tolerance_check.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { klines, resolve, lowerBound } = require('./wave_track_record');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'wave_tolerance_check.json');
const SYMBOLS = ['BTCUSDT', 'ETHUSDT'];
const WINDOW = 1000, STEP = 18, TOP = 5, WIDE = 0.2;
const BANDS = [0, 0.05, 0.1, 0.15, 0.2];

function edge(rows) {
  const res = rows.filter(r => r.outcome === 'hit' || r.outcome === 'miss');
  const hits = res.filter(r => r.outcome === 'hit').length;
  const exp = res.reduce((s, r) => s + r.randomWalk, 0);
  return { n: res.length, hits, expected: +exp.toFixed(1), ratio: exp ? +(hits / exp).toFixed(3) : null, expired: rows.filter(r => r.outcome === 'expired').length };
}
const fmt = e => `n=${String(e.n).padStart(4)}  命中/期望 ${e.ratio}（${e.hits}/${e.expected}）  过期 ${e.expired}`;

async function main() {
  const E = require('../server/wave_engine');
  const all = [];
  for (const sym of SYMBOLS) {
    const h4 = await klines(sym, '4h', 10000);
    const h1 = await klines(sym, '1h', 1500 * 27);
    const seen = new Set();
    let runs = 0;
    const t0 = Date.now();
    for (let i = WINDOW; i < h4.length - 1; i += STEP) {
      const win = h4.slice(i - WINDOW + 1, i + 1);
      const sub = h1.slice(lowerBound(h1, win[0].time), lowerBound(h1, h4[i].time + 14400));
      let a;
      try { a = E.analyzeWaves(win, sym, { timeframe: '4h', subBars: { '1h': sub }, calibrate: false, tolerance: WIDE }); } catch (e) { continue; }
      runs++;
      (a.candidates || []).slice(0, TOP).forEach((c, rank) => {
        const f = c.forecast;
        if (!f) return;
        const sig = `${c.type}|${c.pivots.map(p => p.time).join(',')}|${f.target.price}|${f.invalidation.price}`;
        const r = seen.has(sig) ? null : resolve(h4, i, f);
        seen.add(sig);
        const tg = (c.ruleChecks || []).filter(x => x.category === '时间指引' && !x.pending);
        const typ = (c.timeWindows || []).find(w => w.kind === 'typical');
        const lastT = win[win.length - 1].time;
        all.push({
          sym, run: `${sym}|${i}`, time: h4[i].time, rank, fresh: !!r, key: f.key, randomWalk: f.randomWalkPct / 100,
          outcome: r ? r.outcome : null,
          nearMax: Math.max(0, ...(c.nearFails || []).map(x => x.margin)), nearIds: (c.nearFails || []).map(x => x.id),
          timePass: tg.filter(x => x.pass).length, timeFail: tg.filter(x => !x.pass).length,
          typical: typ ? (lastT < typ.from ? 'before' : typ.overdue ? 'overdue' : 'in') : null
        });
      });
      if (runs % 100 === 0) console.log(`  ${sym} ${runs} 次回放，${Math.round((Date.now() - t0) / 1000)}s`);
    }
  }
  // 只用首次出现的计数结算 (之后同一计数在更晚的价位重复出现，结局不能沿用)
  const fresh = all.filter(r => r.fresh);

  console.log(`\n${fresh.length} 条去重预测`);
  console.log('\n1. 按接近阈值违规幅度分组（去重预测）');
  const buckets = [['无违规', r => r.nearMax === 0], ['≤5%', r => r.nearMax > 0 && r.nearMax <= 0.05], ['5~10%', r => r.nearMax > 0.05 && r.nearMax <= 0.1], ['10~20%', r => r.nearMax > 0.1]];
  const report = { generatedAt: new Date().toISOString(), wide: WIDE, top: TOP, near: {}, bands: {}, time: {} };
  for (const [name, fn] of buckets) { const e = edge(fresh.filter(fn)); report.near[name] = e; console.log(`  ${name.padEnd(6)} ${fmt(e)}`); }
  const ruleCount = {};
  fresh.filter(r => r.nearMax > 0).forEach(r => r.nearIds.forEach(id => { ruleCount[id] = (ruleCount[id] || 0) + 1; }));
  console.log(`  涉及规则：${Object.entries(ruleCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(' ')}`);

  console.log('\n   各带宽下每次回放的首选计数（容差外的候选视为不存在）');
  const runs = {};
  all.forEach(r => { (runs[r.run] = runs[r.run] || []).push(r); });
  for (const b of BANDS) {
    const tops = [];
    for (const list of Object.values(runs)) {
      const top = list.filter(r => r.nearMax <= b + 1e-9).sort((x, y) => x.rank - y.rank)[0];
      if (top && top.fresh) tops.push(top);
    }
    const e = edge(tops);
    report.bands[b] = e;
    console.log(`  带宽 ${String(Math.round(b * 100)).padStart(2)}%  ${fmt(e)}`);
  }

  console.log('\n2. 时间指引与时间窗口（去重预测）');
  const tb = [
    ['时间指引全部符合', r => r.timePass > 0 && r.timeFail === 0], ['时间指引有不符', r => r.timeFail > 0], ['无时间指引', r => r.timePass + r.timeFail === 0],
    ['当前浪早于常见窗口', r => r.typical === 'before'], ['当前浪在常见窗口内', r => r.typical === 'in'], ['当前浪已超出常见窗口', r => r.typical === 'overdue']
  ];
  for (const [name, fn] of tb) { const e = edge(fresh.filter(fn)); report.time[name] = e; console.log(`  ${name.padEnd(12, '　')} ${fmt(e)}`); }
  report.rows = all;
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log(`\n→ ${OUT}`);
}

main();
