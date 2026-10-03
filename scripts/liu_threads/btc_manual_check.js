#!/usr/bin/env node
/**
 * 柳玉冬 BTC 人工标注案例 × 真实K线核对 (data/liu_manual_cases.json)
 * -----------------------------------------------------------------------------
 *   1. 结构: 案例里带 count 的计数交给引擎评估 (只用发帖前的K线)
 *   2. 条件: 「涨破 / 跌破 X 则…」在发帖后是否兑现、何时兑现、之后怎么走
 *   3. 对照: 同一时刻引擎给出的监测点
 * 用法: node scripts/liu_threads/btc_manual_check.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('../../server/wave_engine');

const ROOT = path.join(__dirname, '..', '..');
const CASES = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'liu_manual_cases.json'), 'utf8'));
const CACHE_DIR = path.join(os.tmpdir(), 'liu_replay_cache');
const TF_SEC = { '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };

async function klines(sym, tf, startSec, endSec) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `${sym}_${tf}_${startSec}_${endSec}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = [];
  let cur = startSec * 1000;
  while (cur < endSec * 1000) {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${tf}&limit=1500&startTime=${cur}&endTime=${endSec * 1000}`;
    let rows = null;
    for (let t = 0; t < 4 && !rows; t++) {
      try { const r = await fetch(url, { signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); rows = await r.json(); }
      catch (e) { if (t === 3) throw e; await new Promise(z => setTimeout(z, 1500)); }
    }
    if (!rows.length) break;
    rows.forEach(b => out.push({ time: b[0] / 1000, open: +b[1], high: +b[2], low: +b[3], close: +b[4], volume: +b[5] }));
    const next = rows[rows.length - 1][0] + TF_SEC[tf] * 1000;
    if (next <= cur) break;
    cur = next;
  }
  fs.writeFileSync(file, JSON.stringify(out));
  return out;
}

const D = s => Math.floor(Date.parse(s.length <= 10 ? s + 'T00:00:00Z' : s) / 1000);
const fmt = t => new Date(t * 1000).toISOString().slice(0, 10);
const fmtH = t => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ');
const num = v => Math.round(v).toLocaleString('en-US');

function ext(bars, w, type) {
  let best = null;
  for (const b of bars) {
    if (b.time < D(w[0]) || b.time >= D(w[1]) + 86400) continue;
    if (!best || (type === 'high' ? b.high > best.high : b.low < best.low)) best = b;
  }
  return best && { time: best.time, price: type === 'high' ? best.high : best.low, type };
}

/** 发帖后首次越过 price 的时刻 (side: above / below) */
function firstCross(bars, fromSec, price, side, untilSec) {
  for (const b of bars) {
    if (b.time <= fromSec) continue;
    if (untilSec && b.time > untilSec) break;
    if (side === 'above' ? b.high > price : b.low < price) return b;
  }
  return null;
}
const after = (bars, t, days) => bars.filter(b => b.time > t && b.time <= t + days * 86400);
const maxH = bs => bs.reduce((m, b) => (b.high > m.price ? { price: b.high, time: b.time } : m), { price: -Infinity, time: null });
const minL = bs => bs.reduce((m, b) => (b.low < m.price ? { price: b.low, time: b.time } : m), { price: Infinity, time: null });

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const d1 = await klines('BTCUSDT', '1d', D('2021-06-01'), now);
  const h4 = await klines('BTCUSDT', '4h', D('2025-01-01'), now);
  const h1 = await klines('BTCUSDT', '1h', D('2026-01-01'), now);
  const byId = Object.fromEntries(CASES.cases.map(c => [c.id, c]));
  const lines = [];
  const log = s => { lines.push(s); console.log(s); };

  for (const c of CASES.cases) {
    const t = D(c.time);
    log(`\n■ ${c.id}（${c.timeframe}）`);

    // 1. 结构
    if (c.count && c.pivots) {
      const main = c.timeframe === '1d' ? d1 : h4;
      const pts = c.pivots.map(p => ext(main, p.window, p.type));
      if (pts.some(p => !p)) { log('  结构：拐点定位失败'); }
      else {
        log('  拐点：' + c.pivots.map((p, i) => `${p.label} ${num(pts[i].price)}(${fmt(pts[i].time)})`).join(' → '));
        const before = main.filter(b => b.time <= t);
        const sub = c.timeframe === '1d' ? { '4h': h4.filter(b => b.time <= t) } : { '1h': h1.filter(b => b.time <= t) };
        try {
          const r = E.evaluateUserCount(before, 'BTC', { tool: c.count.tool, points: pts.map(p => ({ time: p.time, price: p.price })), timeframe: c.timeframe, subBars: sub });
          log(`  引擎评估柳玉冬的计数：${r.primary.name} → ${r.verdictLabel}`);
          r.primary.legs.forEach(L => { if (L.status !== 'PASS') log(`    ${L.name} ${L.status}：${L.text}`); });
          r.reasons.forEach(x => log('    ✗ ' + x));
          if (r.doubts.length) log('    存疑：' + r.doubts.slice(0, 2).join('；'));
          (r.interpretations || []).forEach(it => log(`    解读「${it.name}」：铁律违规 ${it.hardFails}，子浪证伪 ${it.strong}，存疑 ${it.medium}`));
        } catch (e) { log('  引擎评估失败：' + e.message); }
      }
    }

    // 2. 条件兑现
    const bars = c.timeframe === '1d' && t < D('2025-01-01') ? d1 : (t >= D('2026-01-01') ? h1 : h4.length && t >= h4[0].time ? h4 : d1);
    const px = (bars.filter(b => b.time <= t).pop() || {}).close;
    if (px) log(`  发帖时价格 ${num(px)}`);
    for (const k of c.calls || []) {
      if (k.kind === 'level_break' || k.kind === 'level_hold') {
        // 回顾类判断 (said) 从提出日起算，否则从发帖起算
        const t0 = k.said ? D(k.said) : t;
        const src = k.said ? d1 : bars;
        const hit = firstCross(src, t0, k.price, k.side, t0 + 200 * 86400);
        const opp = k.side === 'above' ? minL(after(src, t0, hit ? (hit.time - t0) / 86400 : 30)) : maxH(after(src, t0, hit ? (hit.time - t0) / 86400 : 30));
        if (hit) {
          const fwd = after(src, hit.time, 14);
          const f = k.side === 'above' ? maxH(fwd) : minL(fwd);
          log(`  「${k.claim}」${num(k.price)}：${fmtH(hit.time)} ${k.side === 'above' ? '涨破' : '跌破'}（${k.said ? '提出' : '发帖'}后 ${Math.round((hit.time - t0) / 86400)} 天；此前${k.side === 'above' ? '最低' : '最高'} ${num(opp.price)}）；破位后 14 天${k.side === 'above' ? '最高' : '最低'} ${num(f.price)}`);
        } else log(`  「${k.claim}」${num(k.price)}：200 天内未${k.side === 'above' ? '涨破' : '跌破'}（期间${k.side === 'above' ? '最高' : '最低'} ${num(k.side === 'above' ? maxH(after(src, t0, 200)).price : minL(after(src, t0, 200)).price)}）`);
      } else if (k.kind === 'trendline_break') {
        // 蓝点到发帖日的趋势线, 按日线收盘连续两天低于趋势线确认
        const p0 = ext(d1, c.pivots.find(p => p.label === '蓝点').window, 'low');
        const slope = (k.monitor - p0.price) / ((t - p0.time) / 86400);
        let below = 0, conf = null;
        for (const b of d1) {
          if (b.time <= t) continue;
          const line = p0.price + slope * ((b.time - p0.time) / 86400);
          below = b.close < line ? below + 1 : 0;
          if (below === 2) { conf = { time: b.time, close: b.close, line }; break; }
        }
        if (conf) {
          const f = minL(after(d1, conf.time, 45));
          log(`  趋势线监测点 ${num(k.monitor)}（日涨 ${num(slope)}）：${fmt(conf.time)} 连续两天收在线下（收 ${num(conf.close)}，线 ${num(conf.line)}）；之后 45 天最低 ${num(f.price)}（${fmt(f.time)}）`);
        } else log(`  趋势线监测点 ${num(k.monitor)}：未出现连续两天收在线下`);
      } else if (k.kind === 'end_confirm_drop') {
        let top = { price: -Infinity, time: null }, conf = null;
        for (const b of bars.filter(b => b.time > D('2026-05-01'))) {
          if (b.high > top.price) top = { price: b.high, time: b.time };
          if (top.price - b.low >= k.drop) { conf = { time: b.time, top }; break; }
        }
        if (conf) {
          const f = minL(after(bars, conf.time, 60));
          log(`  「从最高点下跌 ${num(k.drop)} 确认结束」：最高 ${num(conf.top.price)}（${fmtH(conf.top.time)}），${fmtH(conf.time)} 跌满 ${num(k.drop)}；之后 60 天最低 ${num(f.price)}（${fmt(f.time)}）`);
        }
      } else if (k.kind === 'target_move' && k.from) {
        const s = D(k.from);
        const low = minL(d1.filter(b => b.time >= s && b.time < s + 86400));
        const f = maxH(after(d1, s, 200));
        log(`  「${k.claim}」：${k.from} 当天最低 ${num(low.price)}，之后 200 天最高 ${num(f.price)}（${fmt(f.time)}），涨幅 ${num(f.price - low.price)}`);
      } else if (k.kind === 'time_window') {
        log(`  时间窗口 ${k.from} ~ ${k.to}：${D(k.from) > now ? '尚未到达' : '已到达'}`);
      }
    }
    if (c.scenarios && c.id === 'btc-2023-06-13') {
      const until = minL(d1.filter(b => b.time > t && b.time <= D('2023-06-23') + 86400));
      const below15476 = firstCross(d1, t, 15476, 'below', t + 400 * 86400);
      const hi = maxH(after(d1, t, 120)), hi2 = maxH(after(d1, t, 300));
      log(`  方案(1)：6-13～6-23 最低 ${num(until.price)}（${until.price < 25250 ? '跌破 25250，按其条件被否定' : '守住 25250'}）`);
      log(`  方案(3)：${below15476 ? '400 天内跌破 15476' : '400 天内未跌破 15476，被否定'}；之后 120 天最高 ${num(hi.price)}（${fmt(hi.time)}），300 天最高 ${num(hi2.price)}（${fmt(hi2.time)}）`);
    }

    // 3. 引擎监测点对照 (2026 年案例, 1h)
    if (t >= D('2026-01-10')) {
      const win = h1.filter(b => b.time <= t).slice(-1000);
      try {
        const a = E.analyzeWaves(win, 'BTC', { timeframe: '1h' });
        const ls = a.liuSignals;
        if (ls) log(`  引擎（1h）：当前段 ${num(ls.activeLeg.from.price)} → ${num(ls.activeLeg.extreme.price)}，监测点 ${num(ls.monitorPoint.price)}（${ls.monitorPoint.status}），首选计数「${a.pattern ? a.pattern.name : '-'}」`);
      } catch (e) { log('  引擎对照失败：' + e.message); }
    }
  }

  log('\n■ 改判');
  for (const r of CASES.revisions) log(`  ${r.from} → ${r.to}：${r.what}`);
  const out = path.join(ROOT, 'data', 'liu_manual_check.txt');
  fs.writeFileSync(out, lines.join('\n'));
  console.log(`\n→ ${out}`);
}

if (require.main === module) main();
