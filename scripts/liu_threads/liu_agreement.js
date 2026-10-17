#!/usr/bin/env node
/**
 * 引擎与柳玉冬的一致率，以及分歧时谁对
 * -----------------------------------------------------------------------------
 * 语料 data/liu_wave_threads.json 中有币安合约映射的帖子，在发帖时刻只用之前的K线运行引擎 (analyzeWaves):
 *   1h 帖用 1h 评估；日线及以上的帖用 4H 评估 (这些合约上市时间短，日线样本不足)。
 * 比较:
 *   浪型 — 柳玉冬帖中提到的浪型 (patterns) 是否是引擎首选计数 / 前三名的浪型
 *          (patterns 是帖中提到的浪型，不一定是当前计数，例如「调整完成后预期驱动浪上涨」也记推动浪，所以要对照基准)
 *   方向 — 柳玉冬看多 / 看空 (stance) 与引擎首选计数的可检验预测方向
 *   结局 — 发帖后 3 日 (72 根 1h) 收盘价方向；分歧时谁对 (符号检验)
 * 基准: 把引擎结果在帖子之间随机打乱 (PERM 次)，得到「碰巧一致」的水平与单侧 p 值。
 *
 * 用法: node scripts/liu_threads/liu_agreement.js
 * 输出: data/liu_agreement_summary.json
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { analyzeWaves } = require('../../server/wave_engine');
const { fetchKlines, idxAtOrBefore } = require('./replay_liu_threads');

const ROOT = path.join(__dirname, '..', '..');
const THREADS = path.join(ROOT, 'data', 'liu_wave_threads.json');
const OUT = path.join(ROOT, 'data', 'liu_agreement_summary.json');
const H = 3600;
const HORIZON = 72;       // 结局: 72 根 1h ≈ 3 日
const WINDOW = 1000;
const MIN_BARS = 200;
const PERM = 2000;

// 柳玉冬的浪型名 → 引擎浪型
const LIU_TYPES = {
  推动浪: ['IMPULSE'], 引导楔形: ['DIAGONAL'], 终结楔形: ['DIAGONAL'],
  单锯齿: ['ZIGZAG'], 平台形: ['FLAT'], 三角形: ['TRIANGLE', 'EXPANDING_TRIANGLE'],
  双锯齿: ['DOUBLE_ZIGZAG'], 三锯齿: ['TRIPLE_ZIGZAG'], 联合形: ['COMBINATION', 'TRIPLE_COMBINATION']
};
const MOTIVE = new Set(['IMPULSE', 'DIAGONAL']);
const familyOf = t => MOTIVE.has(t) ? 'M' : 'C';

/** 1h → 4h (UTC 0/4/8/... 点对齐) */
function to4h(h1) {
  const out = [];
  for (const b of h1) {
    const t = b.time - (b.time % (4 * H));
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, b.high); last.low = Math.min(last.low, b.low); last.close = b.close; last.volume += b.volume || 0;
    } else out.push({ time: t, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 });
  }
  return out;
}

// 可复现的伪随机 (mulberry32)
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function permTest(rows, stat, rand) {
  const obs = stat(rows.map(r => r.eng));
  const engs = rows.map(r => r.eng);
  let ge = 0, sum = 0;
  for (let k = 0; k < PERM; k++) {
    const sh = engs.slice();
    for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [sh[i], sh[j]] = [sh[j], sh[i]]; }
    const v = stat(sh);
    sum += v; if (v >= obs - 1e-12) ge++;
  }
  return { observed: obs, chance: sum / PERM, p: (ge + 1) / (PERM + 1) };
}
/** 符号检验 (双侧，正态近似 + 连续性校正) */
function signTest(a, b) {
  const n = a + b;
  if (!n) return null;
  const z = (Math.abs(a - b) - 1) / Math.sqrt(n);
  const p = Math.min(1, 2 * (1 - normCdf(Math.max(0, z))));
  return { n, z: +z.toFixed(2), p: +p.toFixed(3) };
}
function normCdf(x) { const t = 1 / (1 + 0.2316419 * x); const d = 0.3989423 * Math.exp(-x * x / 2); return 1 - d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); }
const pct = (n, d) => d ? +(100 * n / d).toFixed(1) : null;

async function main() {
  const data = JSON.parse(fs.readFileSync(THREADS, 'utf8'));
  const rows = [];
  const perSymbol = {};
  for (const [code, th] of Object.entries(data.symbols)) {
    if (!th.binance) continue;
    const entries = th.entries.filter(e => e.ts && e.timeframe !== '5m');
    if (!entries.length) continue;
    const start = entries[0].ts - 200 * 86400, end = Math.min(entries[entries.length - 1].ts + 6 * 86400, Math.floor(Date.now() / 1000));
    let h1;
    try { h1 = await fetchKlines(th.binance, start, end); } catch (e) { perSymbol[code] = { skipped: e.message }; continue; }
    if (h1.length < MIN_BARS) { perSymbol[code] = { skipped: `K线不足 ${h1.length}` }; continue; }
    const h4 = to4h(h1);
    let n = 0;
    for (const e of entries) {
      const useH4 = e.timeframe !== '1h';
      const bars = useH4 ? h4 : h1;
      const i = idxAtOrBefore(bars, e.ts - (useH4 ? 4 * H : H)); // 只用发帖前已收盘的K线
      const j = idxAtOrBefore(h1, e.ts - H);
      if (i < MIN_BARS || j < 0 || j + HORIZON >= h1.length) continue;
      const win = bars.slice(Math.max(0, i - WINDOW + 1), i + 1);
      const opts = { timeframe: useH4 ? '4h' : '1h' };
      if (useH4) opts.subBars = { '1h': h1.slice(idxAtOrBefore(h1, win[0].time) + 1, j + 1) };
      let res;
      try { res = analyzeWaves(win, code, opts); } catch (err) { continue; }
      const cands = (res.candidates || []).slice(0, 3);
      if (!cands.length) continue;
      const top = cands[0];
      const liuTypes = Array.from(new Set((e.patterns || []).flatMap(p => LIU_TYPES[p] || [])));
      const liuFamilies = Array.from(new Set(liuTypes.map(familyOf)));
      const engDir = top.forecast ? (top.forecast.direction === 'UP' ? 1 : -1) : 0;
      const liuDir = e.stance === 'BULL' ? 1 : e.stance === 'BEAR' ? -1 : 0;
      const move = Math.sign(h1[j + HORIZON].close - h1[j].close);
      rows.push({
        code, date: e.date, postId: e.id, tf: e.timeframe, evalTf: opts.timeframe,
        liuPatterns: e.patterns || [], liuTypes, liuFamilies, liuDir, move,
        eng: { top: top.baseType, top3: cands.map(c => c.baseType), dir: engDir, name: top.name }
      });
      n++;
    }
    perSymbol[code] = { binance: th.binance, evaluated: n };
    console.log(`${code.padEnd(7)} ${th.binance.padEnd(12)} 评估 ${n} 帖`);
  }

  const rand = rng(20261017);
  // 浪型: 柳提到浪型的帖
  const typed = rows.filter(r => r.liuTypes.length);
  const typeTop1 = permTest(typed, engs => typed.reduce((s, r, k) => s + (r.liuTypes.includes(engs[k].top) ? 1 : 0), 0) / typed.length, rand);
  const typeTop3 = permTest(typed, engs => typed.reduce((s, r, k) => s + (engs[k].top3.some(t => r.liuTypes.includes(t)) ? 1 : 0), 0) / typed.length, rand);
  // 驱动 / 调整大类: 只取柳只提到一个大类的帖
  const fam = rows.filter(r => r.liuFamilies.length === 1);
  const famTop1 = permTest(fam, engs => fam.reduce((s, r, k) => s + (familyOf(engs[k].top) === r.liuFamilies[0] ? 1 : 0), 0) / fam.length, rand);
  // 方向
  const dir = rows.filter(r => r.liuDir && r.eng.dir);
  const dirAgree = permTest(dir, engs => dir.reduce((s, r, k) => s + (engs[k].dir === r.liuDir ? 1 : 0), 0) / dir.length, rand);
  const moved = dir.filter(r => r.move);
  const liuHits = moved.filter(r => r.liuDir === r.move).length, engHits = moved.filter(r => r.eng.dir === r.move).length;
  const disagree = moved.filter(r => r.liuDir !== r.eng.dir);
  const liuRight = disagree.filter(r => r.liuDir === r.move).length, engRight = disagree.length - liuRight;
  const agreeRows = moved.filter(r => r.liuDir === r.eng.dir);
  const upPct = pct(moved.filter(r => r.move > 0).length, moved.length);

  const r3 = x => ({ observedPct: +(100 * x.observed).toFixed(1), chancePct: +(100 * x.chance).toFixed(1), p: +x.p.toFixed(4) });
  const summary = {
    generatedAt: new Date().toISOString(), horizonBars1h: HORIZON, permutations: PERM,
    evaluated: rows.length, bySymbol: perSymbol,
    pattern: {
      posts: typed.length,
      top1: r3(typeTop1), top3: r3(typeTop3),
      family: Object.assign({ posts: fam.length }, r3(famTop1)),
      engineTopTypes: rows.reduce((m, r) => (m[r.eng.top] = (m[r.eng.top] || 0) + 1, m), {}),
      liuMentions: typed.reduce((m, r) => (r.liuPatterns.forEach(p => m[p] = (m[p] || 0) + 1), m), {})
    },
    direction: {
      posts: dir.length, agreement: r3(dirAgree),
      resolved: moved.length, upPct,
      liuHitPct: pct(liuHits, moved.length), engineHitPct: pct(engHits, moved.length),
      whenAgreeHitPct: pct(agreeRows.filter(r => r.liuDir === r.move).length, agreeRows.length), agreeN: agreeRows.length,
      disagree: { n: disagree.length, liuRight, engineRight: engRight, signTest: signTest(liuRight, engRight) }
    },
    rows
  };
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 1));

  const P = summary.pattern, D = summary.direction;
  console.log(`\n共评估 ${rows.length} 帖`);
  console.log(`浪型（${P.posts} 帖提到浪型）：首选一致 ${P.top1.observedPct}%（打乱基准 ${P.top1.chancePct}%，p=${P.top1.p}）；前三名含 ${P.top3.observedPct}%（基准 ${P.top3.chancePct}%，p=${P.top3.p}）`);
  console.log(`驱动 / 调整大类（${P.family.posts} 帖）：一致 ${P.family.observedPct}%（基准 ${P.family.chancePct}%，p=${P.family.p}）`);
  console.log(`方向（${D.posts} 帖双方都有方向）：一致 ${D.agreement.observedPct}%（基准 ${D.agreement.chancePct}%，p=${D.agreement.p}）`);
  console.log(`3 日结局（${D.resolved} 帖，期间上涨占 ${D.upPct}%）：柳 ${D.liuHitPct}%，引擎 ${D.engineHitPct}%；一致时 ${D.whenAgreeHitPct}%（${D.agreeN} 帖）`);
  console.log(`分歧 ${D.disagree.n} 帖：柳对 ${D.disagree.liuRight}，引擎对 ${D.disagree.engineRight}（符号检验 p=${D.disagree.signTest && D.disagree.signTest.p}）`);
  console.log(`引擎首选浪型分布：${JSON.stringify(P.engineTopTypes)}`);
  console.log(`→ ${OUT}`);
}

if (require.main === module) main();
module.exports = { to4h, LIU_TYPES };
