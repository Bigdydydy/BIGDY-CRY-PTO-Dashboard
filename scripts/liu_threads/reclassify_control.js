#!/usr/bin/env node
/**
 * 「重新定性」的对照检验 (误报率)
 * -----------------------------------------------------------------------------
 * 在 BTCUSDT 4H 历史上用 ZZ_PCT 的之字转折找出所有 0-a-b-c 三段 (b 回撤 a 的 30%~90%)，
 * 在 c 之后 LAG 根K线把它按 ABC 交给引擎，记录是否触发「重新定性」。
 * 结局: 之后先突破起点以来的极值 (延续 = 新趋势) 还是先回到起点 (调整)。
 * 需要先运行 scripts/wave_track_record.js 生成K线缓存。
 * 用法: node scripts/liu_threads/reclassify_control.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('../../server/wave_engine');

const ZZ_PCT = +(process.env.ZZ || 0.05), LAG = 3, HORIZON = 360;
const SYM = process.env.SYM || 'BTCUSDT';
const dir = path.join(os.tmpdir(), 'liu_replay_cache');
const pick = re => JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir).filter(f => re.test(f)).sort().pop()), 'utf8'));
const h4 = pick(new RegExp(`^track_${SYM}_4h_`)), h1 = pick(new RegExp(`^track_${SYM}_1h_`));

function zigzag(bars) {
  const piv = [];
  let dirn = 0, ext = { idx: 0, price: bars[0].close };
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    if (dirn > 0) {
      if (b.high > ext.price) ext = { idx: i, price: b.high };
      else if (b.low < ext.price * (1 - ZZ_PCT)) { piv.push({ ...ext, type: 'high' }); dirn = -1; ext = { idx: i, price: b.low }; }
    } else if (dirn < 0) {
      if (b.low < ext.price) ext = { idx: i, price: b.low };
      else if (b.high > ext.price * (1 + ZZ_PCT)) { piv.push({ ...ext, type: 'low' }); dirn = 1; ext = { idx: i, price: b.high }; }
    } else {
      if (b.high > ext.price * (1 + ZZ_PCT)) { piv.push({ idx: 0, price: bars[0].low, type: 'low' }); dirn = 1; ext = { idx: i, price: b.high }; }
      else if (b.low < ext.price * (1 - ZZ_PCT)) { piv.push({ idx: 0, price: bars[0].high, type: 'high' }); dirn = -1; ext = { idx: i, price: b.low }; }
    }
  }
  return piv;
}
const lb = (arr, t) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].time < t) lo = m + 1; else hi = m; } return lo; };

const piv = zigzag(h4);
const rows = [];
const t0 = Date.now();
for (let j = 0; j + 3 < piv.length; j++) {
  const [p0, pa, pb, pc] = piv.slice(j, j + 4);
  const up = pa.price > p0.price;
  const ret = Math.abs(pa.price - pb.price) / Math.abs(pa.price - p0.price);
  if (ret < 0.3 || ret > 0.9) continue;
  if (up ? pc.price <= pb.price : pc.price >= pb.price) continue;
  const at = pc.idx + LAG;
  if (at >= h4.length - 20 || p0.idx < 300) continue;
  const win = h4.slice(Math.max(0, at - 999), at + 1);
  const sub = h1.slice(lb(h1, win[0].time), lb(h1, h4[at].time + 14400));
  if (sub.length < 200) continue;
  let r;
  try {
    r = E.evaluateUserCount(win, 'BTC', { tool: 'ABC', points: [p0, pa, pb, pc].map(p => ({ time: h4[p.idx].time, price: p.price })), timeframe: '4h', subBars: { '1h': sub } });
  } catch (e) { continue; }
  let extP = up ? -Infinity : Infinity;
  for (let k = p0.idx; k <= at; k++) extP = up ? Math.max(extP, h4[k].high) : Math.min(extP, h4[k].low);
  let outcome = 'open';
  for (let k = at + 1; k < Math.min(h4.length, at + HORIZON); k++) {
    const b = h4[k];
    if (up ? b.low <= p0.price : b.high >= p0.price) { outcome = 'back'; break; }
    if (up ? b.high > extP : b.low < extP) { outcome = 'cont'; break; }
  }
  rows.push({ time: h4[at].time, up, fired: r.reclassify ? r.reclassify.basis : null, rc: r.reclassify, outcome });
}
const sum = f => { const s = rows.filter(f).filter(r => r.outcome !== 'open'); const c = s.filter(r => r.outcome === 'cont').length; return `${c}/${s.length} 延续（${s.length ? Math.round(100 * c / s.length) : '-'}%）`; };
console.log(`${rows.length} 个 0-a-b-c 样本，${Math.round((Date.now() - t0) / 1000)}s`);
console.log(`  全部                 ${sum(() => true)}`);
console.log(`  触发 FIVE            ${sum(r => r.fired === 'FIVE')}`);
console.log(`  触发 PREFIX          ${sum(r => r.fired === 'PREFIX')}`);
console.log(`  未触发               ${sum(r => !r.fired)}`);
console.log(`  触发率 ${Math.round(100 * rows.filter(r => r.fired).length / rows.length)}%`);
console.log(`  FIVE·strict5         ${sum(r => r.fired === 'FIVE' && r.rc.strict5)}`);
console.log(`  FIVE·粗分即五浪       ${sum(r => r.fired === 'FIVE' && r.rc.coarse === '5')}`);
for (const m of [5, 7, 9, 13]) console.log(`  FIVE·swings≤${String(m).padEnd(3)}      ${sum(r => r.fired === 'FIVE' && r.rc.swings <= m)}`);
console.log(`  FIVE·swings>9        ${sum(r => r.fired === 'FIVE' && r.rc.swings > 9)}`);
