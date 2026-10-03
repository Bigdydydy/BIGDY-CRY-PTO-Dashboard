#!/usr/bin/env node
/**
 * 「重新定性」在柳玉冬 2026-08 案例上的验证
 * -----------------------------------------------------------------------------
 * 柳玉冬 08-04 / 08-14 / 08-17 把 2026-07-01 (57759) 起的上涨看作 xx 浪 / b 浪，等待 z 浪下跌；
 * 实际五浪涨到 87k，10-02 改判为五浪推动。
 * 这里在各个时点把这段上涨按调整浪 (abc: 0=07-01 低点, a=07-21 高点, b=08-01 低点, c=至当时的最高点) 交给引擎，
 * 看引擎从哪一天开始提出「更可能是新趋势」。
 * 用法: node scripts/liu_threads/reclassify_check.js
 */
'use strict';

const E = require('../../server/wave_engine');

const D = s => Math.floor(Date.parse(s.length <= 10 ? s + 'T00:00:00Z' : s) / 1000);
async function kl(tf, start, end) {
  const out = [];
  let cur = D(start) * 1000;
  const e = D(end) * 1000;
  while (cur < e) {
    let rows = null;
    for (let t = 0; t < 4 && !rows; t++) {
      try { rows = await (await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=${tf}&limit=1500&startTime=${cur}&endTime=${e}`)).json(); }
      catch (x) { await new Promise(z => setTimeout(z, 1500)); }
    }
    if (!rows || !rows.length) break;
    rows.forEach(b => out.push({ time: b[0] / 1000, open: +b[1], high: +b[2], low: +b[3], close: +b[4] }));
    cur = rows[rows.length - 1][0] + 1;
    if (rows.length < 1500) break;
  }
  return out;
}
const ext = (bars, a, b, type) => bars.filter(x => x.time >= D(a) && x.time < D(b) + 86400)
  .reduce((m, x) => (!m || (type === 'high' ? x.high > m.price : x.low < m.price) ? { time: x.time, price: type === 'high' ? x.high : x.low } : m), null);

(async () => {
  const h4 = await kl('4h', '2025-12-01', '2026-10-01');
  const h1 = await kl('1h', '2026-05-01', '2026-10-01');
  const m15 = await kl('15m', '2026-06-25', '2026-10-01');
  const p0 = ext(h4, '2026-06-28', '2026-07-03', 'low'), pa = ext(h4, '2026-07-15', '2026-07-25', 'high'), pb = ext(h4, '2026-07-28', '2026-08-05', 'low');
  console.log(`abc 画法: 0 ${p0.price} → a ${pa.price} → b ${pb.price} → c = 截至当时的最高点`);
  for (const day of ['2026-08-04', '2026-08-14', '2026-08-17', '2026-08-21', '2026-08-25', '2026-08-29', '2026-09-03', '2026-09-21']) {
    const t = D(day + 'T12:00:00Z');
    const before = h4.filter(b => b.time <= t);
    const pc = ext(before, '2026-08-02', day, 'high');
    const pts = [p0, pa, pb, pc].map(p => ({ time: p.time, price: p.price }));
    let r;
    try {
      r = E.evaluateUserCount(before, 'BTC', { tool: 'ABC', points: pts, timeframe: '4h', subBars: { '15m': m15.filter(b => b.time <= t), '1h': h1.filter(b => b.time <= t) } });
    } catch (e) { console.log(`${day}: ${e.message}`); continue; }
    console.log(`${day}  c=${pc.price}  ${r.primary.name} → ${r.verdictLabel}${r.reclassify ? `  ★重新定性(${r.reclassify.basis})：${r.reclassify.text}` : ''}`);
  }
})();
