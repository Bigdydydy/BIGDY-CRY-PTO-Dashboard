#!/usr/bin/env node
/**
 * 波浪引擎计数的历史命中率回放 (记账)
 * -----------------------------------------------------------------------------
 * 在 BTCUSDT / ETHUSDT 永续 4H 历史上，每隔 STEP 根K线只用当时之前的 WINDOW 根运行引擎，
 * 取前 TOP 名候选的标准化预测 (buildForecast)，用之后的K线结算:
 *   先到目标位 → 命中；先破失效位 (同一根K线两者都触及按失败) → 失败；到期都未发生 → 过期
 * 同一计数 (浪型 + 拐点时间 + 目标 + 失效位) 在连续回放中只记第一次，避免重复计数。
 * 按「浪型 | 阶段」汇总: 命中数、随机游走期望命中数 (失效距离 / (失效距离 + 目标距离))。
 *
 * 按时间前 TRAIN_FRAC 生成表，后段检验: 校准前后首选计数的「命中 / 期望」。
 * 最后把用全部数据生成的表写进 server/wave_engine.js 的 <TRACK_RECORD> 区块。
 *
 * 用法: node scripts/wave_track_record.js [--no-write]
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'server', 'wave_engine.js');
const OUT = path.join(ROOT, 'data', 'wave_track_record.json');
const CACHE_DIR = path.join(os.tmpdir(), 'liu_replay_cache');
const SYMBOLS = ['BTCUSDT', 'ETHUSDT'];
const WINDOW = 1000;
const STEP = 18;
const TOP = 3;
const TRAIN_FRAC = 0.7;

async function klines(sym, tf, total) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(CACHE_DIR, `track_${sym}_${tf}_${total}_${day}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = [];
  let end = null;
  while (rows.length < total) {
    const lim = Math.min(1500, total - rows.length);
    let page = null;
    for (let t = 0; t < 4 && !page; t++) {
      try {
        const r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${tf}&limit=${lim}${end ? `&endTime=${end}` : ''}`, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        page = await r.json();
      } catch (e) { if (t === 3) throw e; await new Promise(z => setTimeout(z, 1500)); }
    }
    if (!page.length) break;
    rows.unshift(...page);
    end = page[0][0] - 1;
    if (page.length < lim) break;
  }
  const bars = rows.map(b => ({ time: b[0] / 1000, open: +b[1], high: +b[2], low: +b[3], close: +b[4], volume: +b[5] }));
  fs.writeFileSync(file, JSON.stringify(bars));
  return bars;
}

function lowerBound(bars, t) {
  let lo = 0, hi = bars.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].time < t) lo = m + 1; else hi = m; }
  return lo;
}

/** 结算一条预测 */
function resolve(bars, i, f) {
  const up = f.direction === 'UP';
  for (let k = i + 1; k < bars.length && bars[k].time <= f.deadline; k++) {
    const b = bars[k];
    const hitInv = up ? b.low <= f.invalidation.price : b.high >= f.invalidation.price;
    const hitTgt = up ? b.high >= f.target.price : b.low <= f.target.price;
    if (hitInv) return { outcome: 'miss', bars: k - i };
    if (hitTgt) return { outcome: 'hit', bars: k - i };
  }
  if (bars[bars.length - 1].time < f.deadline) return { outcome: 'open' };
  return { outcome: 'expired' };
}

function tally(rows) {
  const keys = {};
  for (const r of rows) {
    if (r.outcome === 'open') continue;
    const k = keys[r.key] = keys[r.key] || { resolved: 0, hits: 0, misses: 0, expired: 0, expected: 0 };
    if (r.outcome === 'expired') { k.expired++; continue; }
    k.resolved++;
    k.expected += r.randomWalk;
    if (r.outcome === 'hit') k.hits++; else k.misses++;
  }
  for (const k of Object.values(keys)) k.expected = +k.expected.toFixed(2);
  return keys;
}

function edgeOf(rows) {
  const res = rows.filter(r => r.outcome === 'hit' || r.outcome === 'miss');
  const hits = res.filter(r => r.outcome === 'hit').length;
  const exp = res.reduce((s, r) => s + r.randomWalk, 0);
  return { n: res.length, hits, expected: +exp.toFixed(1), ratio: exp ? +(hits / exp).toFixed(3) : null, hitPct: res.length ? Math.round(100 * hits / res.length) : null };
}

function writeTable(table) {
  const src = fs.readFileSync(ENGINE, 'utf8');
  const nl = src.includes('\r\n') ? '\r\n' : '\n';
  const a = src.indexOf('// <TRACK_RECORD>'), b = src.indexOf('// </TRACK_RECORD>');
  if (a < 0 || b < 0) throw new Error('engine has no <TRACK_RECORD> block');
  const lineStart = src.lastIndexOf('\n', a) + 1;
  const indent = src.slice(lineStart, a);
  const body = `// <TRACK_RECORD> 由 scripts/wave_track_record.js 生成，勿手改${nl}${indent}const TRACK_RECORD = ${JSON.stringify(table)};${nl}${indent}`;
  fs.writeFileSync(ENGINE, src.slice(0, a) + body + src.slice(b));
}

async function main() {
  const noWrite = process.argv.includes('--no-write');
  const E = require(ENGINE);
  const all = [];
  for (const sym of SYMBOLS) {
    const h4 = await klines(sym, '4h', 10000);
    const h1 = await klines(sym, '1h', 1500 * 27);
    console.log(`${sym}: 4H ${h4.length} 根，1H ${h1.length} 根`);
    const seen = new Set();
    let runs = 0;
    const t0 = Date.now();
    for (let i = WINDOW; i < h4.length - 1; i += STEP) {
      const win = h4.slice(i - WINDOW + 1, i + 1);
      const subFrom = lowerBound(h1, win[0].time), subTo = lowerBound(h1, h4[i].time + 14400);
      let a;
      try { a = E.analyzeWaves(win, sym, { timeframe: '4h', subBars: { '1h': h1.slice(subFrom, subTo) }, calibrate: false }); } catch (e) { continue; }
      runs++;
      (a.candidates || []).slice(0, TOP).forEach((c, rank) => {
        const f = c.forecast;
        if (!f) return;
        const sig = `${c.type}|${c.pivots.map(p => p.time).join(',')}|${f.target.price}|${f.invalidation.price}`;
        if (seen.has(sig)) return;
        seen.add(sig);
        const r = resolve(h4, i, f);
        all.push({ sym, time: h4[i].time, rank, key: f.key, name: c.name, probability: c.probability, randomWalk: f.randomWalkPct / 100, outcome: r.outcome, bars: r.bars || null });
      });
      if (runs % 100 === 0) console.log(`  ${runs} 次回放，${Math.round((Date.now() - t0) / 1000)}s`);
    }
  }
  all.sort((x, y) => x.time - y.time);
  const cut = all[Math.floor(all.length * TRAIN_FRAC)].time;
  const train = all.filter(r => r.time < cut), test = all.filter(r => r.time >= cut);

  // 检验: 用训练段的表重新给检验段每次回放的候选排序，比较校准前后「首选」的命中/期望
  const trainKeys = tally(train);
  const K = 15;
  const factorOf = key => { const r = trainKeys[key]; return r && r.resolved ? Math.max(0.6, Math.min(1.5, (r.hits + K) / (r.expected + K))) : 1; };
  const byRun = {};
  test.forEach(r => { (byRun[`${r.sym}|${r.time}`] = byRun[`${r.sym}|${r.time}`] || []).push(r); });
  const rawTop = [], calTop = [];
  for (const list of Object.values(byRun)) {
    const resolved = list.filter(r => r.outcome === 'hit' || r.outcome === 'miss');
    if (!resolved.length) continue;
    rawTop.push(resolved.slice().sort((a, b) => a.rank - b.rank)[0]);
    calTop.push(resolved.slice().sort((a, b) => (b.probability * factorOf(b.key)) - (a.probability * factorOf(a.key)))[0]);
  }

  const fullKeys = tally(all);
  const table = { generatedAt: new Date().toISOString().slice(0, 10), source: `${SYMBOLS.join('/')} 4H，每 ${STEP} 根回放，前 ${TOP} 名候选，去重后 ${all.length} 条预测`, keys: fullKeys };
  const report = {
    generatedAt: new Date().toISOString(), symbols: SYMBOLS, window: WINDOW, step: STEP, top: TOP, trainCut: new Date(cut * 1000).toISOString().slice(0, 10),
    overall: edgeOf(all), train: edgeOf(train), test: edgeOf(test),
    testTopRaw: edgeOf(rawTop), testTopCalibrated: edgeOf(calTop),
    keys: Object.entries(fullKeys).map(([k, v]) => Object.assign({ key: k }, v, { ratio: v.expected ? +(v.hits / v.expected).toFixed(2) : null })).sort((a, b) => b.resolved - a.resolved),
    forecasts: all
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1));

  console.log(`\n全部 ${all.length} 条预测（训练/检验分界 ${report.trainCut}）`);
  console.log(`  总体：命中 ${report.overall.hits}/${report.overall.n}（${report.overall.hitPct}%），随机游走期望 ${report.overall.expected}，命中/期望 ${report.overall.ratio}`);
  console.log(`  过期：${all.filter(r => r.outcome === 'expired').length} 条，未到期：${all.filter(r => r.outcome === 'open').length} 条`);
  console.log('\n按浪型 | 阶段（全部数据）：');
  report.keys.forEach(k => console.log(`  ${k.key.padEnd(30)} 已结算 ${String(k.resolved).padStart(4)}  命中 ${String(k.hits).padStart(4)}  期望 ${String(k.expected).padStart(7)}  命中/期望 ${k.ratio}  过期 ${k.expired}`));
  console.log(`\n检验段（${report.trainCut} 之后）首选计数：`);
  console.log(`  校准前 命中 ${report.testTopRaw.hits}/${report.testTopRaw.n}，期望 ${report.testTopRaw.expected}，命中/期望 ${report.testTopRaw.ratio}`);
  console.log(`  校准后 命中 ${report.testTopCalibrated.hits}/${report.testTopCalibrated.n}，期望 ${report.testTopCalibrated.expected}，命中/期望 ${report.testTopCalibrated.ratio}`);
  if (!noWrite) { writeTable(table); console.log(`\n→ 已写入 ${ENGINE} 的 <TRACK_RECORD>`); }
  console.log(`→ ${OUT}`);
}

if (require.main === module) main();
module.exports = { writeTable };
