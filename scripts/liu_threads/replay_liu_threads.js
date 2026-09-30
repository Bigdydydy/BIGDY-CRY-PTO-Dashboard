#!/usr/bin/env node
/**
 * 柳玉冬线程 × 真实K线 回放校准
 * -----------------------------------------------------------------------------
 * 对 data/liu_wave_threads.json 中有币安 TradFi 永续映射的标的:
 *   1. 拉取 1h K线 (fapi 分页, 本地临时缓存)
 *   2. 在每篇含监测点的帖子发布时刻, 仅用该时刻之前的K线运行波浪引擎
 *   3. 对比: 引擎输出的关键位 与 柳玉冬监测点 的距离; 两者在 3 日窗口内的方向判断命中率
 *   4. 客观核验柳玉冬监测点: 5 日内是否被触发(跌破/涨破)
 * 输出: data/liu_replay_summary.json (+ 控制台汇总)
 *
 * 用法: node scripts/liu_threads/replay_liu_threads.js [XAU,XAG,CL,CRCL]
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { analyzeWaves } = require('../../server/wave_engine');

const ROOT = path.join(__dirname, '..', '..');
const THREADS = path.join(ROOT, 'data', 'liu_wave_threads.json');
const OUT = path.join(ROOT, 'data', 'liu_replay_summary.json');
const CACHE_DIR = path.join(os.tmpdir(), 'liu_replay_cache');
const H = 3600;
const HORIZON_DIR = 72;   // 方向判断评估窗口: 72 根 1h (约3日)
const HORIZON_MON = 120;  // 监测点触发评估窗口: 120 根 1h (约5日)
const WINDOW = 1000;

async function fetchKlines(symbol, startSec, endSec) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = path.join(CACHE_DIR, `${symbol}_1h_${startSec}_${endSec}.json`);
  if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  const bars = [];
  let cursor = startSec * 1000;
  while (cursor < endSec * 1000) {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=1500&startTime=${cursor}&endTime=${endSec * 1000}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`${symbol} HTTP ${resp.status}`);
    const raw = await resp.json();
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
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time <= ts) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function median(a) { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }
function pct(n, d) { return d ? Math.round(1000 * n / d) / 10 : null; }

function engineBias(res) {
  const ls = res.liuSignals;
  if (!ls) return null;
  const d = ls.direction === 'BULLISH' ? 1 : -1;
  return ls.monitorPoint.status === 'HOLDING' ? d : -d;
}

function engineLevels(res) {
  const out = [];
  const ls = res.liuSignals;
  if (ls) {
    out.push(['监测点(当前段小级别拐点)', ls.monitorPoint.price]);
    out.push(['确认位(最大回撤终点)', ls.monitorPoint.confirmLevel]);
    out.push(['最大回撤阈值', ls.largestCounterMove.thresholdLevel]);
    out.push(['当前段起点O', ls.activeLeg.from.price]);
    ls.eatBack.levels.forEach(l => out.push([`吃掉前段${l.ratio}`, l.price]));
  }
  if (res.pattern) {
    if (res.pattern.monitoringPivot) out.push(['首选计数监测点', res.pattern.monitoringPivot.price]);
    if (res.pattern.secondaryPivot) out.push(['首选计数确认位', res.pattern.secondaryPivot.price]);
  }
  return out.filter(x => isFinite(x[1]));
}

async function replaySymbol(code, thread) {
  const entries = thread.entries.filter(e => e.levels.some(l => l.kind === 'monitor') || e.stance === 'BULL' || e.stance === 'BEAR');
  if (!entries.length) return null;
  const start = entries[0].ts - 70 * 86400, end = entries[entries.length - 1].ts + 8 * 86400;
  const bars = await fetchKlines(thread.binance, start, Math.min(end, Math.floor(Date.now() / 1000)));
  if (bars.length < 300) return { code, skipped: `K线不足(${bars.length})` };

  const rows = [];
  for (const e of entries) {
    const i = idxAtOrBefore(bars, e.ts);
    if (i < 250 || i + HORIZON_DIR >= bars.length) continue;
    const win = bars.slice(Math.max(0, i - WINDOW + 1), i + 1);
    let res;
    try { res = analyzeWaves(win, code, { timeframe: '1h' }); } catch (err) { continue; }
    const px = bars[i].close;
    const fwd = bars[i + HORIZON_DIR].close;
    const move = Math.sign(fwd - px);
    const liuDir = e.stance === 'BULL' ? 1 : e.stance === 'BEAR' ? -1 : 0;
    const engDir = engineBias(res) || 0;

    const mon = e.levels.find(l => l.kind === 'monitor');
    let monRow = null;
    if (mon && mon.price > px * 0.7 && mon.price < px * 1.3) {
      const side = mon.side || (mon.price < px ? 'below' : 'above');
      let triggeredAt = null;
      for (let k = i + 1; k <= Math.min(bars.length - 1, i + HORIZON_MON); k++) {
        if (side === 'below' ? bars[k].low < mon.price : bars[k].high > mon.price) { triggeredAt = k; break; }
      }
      const lv = engineLevels(res).map(([name, p]) => ({ name, p, dist: Math.abs(p - mon.price) / mon.price }));
      lv.sort((a, b) => a.dist - b.dist);
      monRow = {
        price: mon.price, side,
        triggered: triggeredAt !== null, triggeredAfterBars: triggeredAt === null ? null : triggeredAt - i,
        nearestEngine: lv[0] ? { name: lv[0].name, price: +lv[0].p.toFixed(4), distPct: +(100 * lv[0].dist).toFixed(2) } : null,
        engineMonitorDistPct: res.liuSignals ? +(100 * Math.abs(res.liuSignals.monitorPoint.price - mon.price) / mon.price).toFixed(2) : null
      };
    }
    rows.push({
      date: e.date, postId: e.id, close: px, liuStance: e.stance, engineBias: engDir, move3d: move,
      liuHit: liuDir ? liuDir === move : null, engineHit: engDir ? engDir === move : null,
      agree: liuDir && engDir ? liuDir === engDir : null,
      engineTop: res.pattern ? res.pattern.name : null,
      engineLines: res.liuSignals ? res.liuSignals.lines.slice(0, 2) : [],
      monitor: monRow
    });
  }

  const dirRows = rows.filter(r => r.liuHit !== null);
  const both = rows.filter(r => r.liuHit !== null && r.engineHit !== null);
  const monRows = rows.filter(r => r.monitor);
  const near = monRows.map(r => r.monitor.nearestEngine ? r.monitor.nearestEngine.distPct : null).filter(x => x !== null);
  const nearNames = {};
  monRows.forEach(r => { if (r.monitor.nearestEngine && r.monitor.nearestEngine.distPct <= 1) nearNames[r.monitor.nearestEngine.name] = (nearNames[r.monitor.nearestEngine.name] || 0) + 1; });
  return {
    code, binance: thread.binance, bars: bars.length, evaluated: rows.length,
    direction3d: {
      liuCalls: dirRows.length, liuHitPct: pct(dirRows.filter(r => r.liuHit).length, dirRows.length),
      engineCalls: rows.filter(r => r.engineHit !== null).length,
      engineHitPct: pct(rows.filter(r => r.engineHit).length, rows.filter(r => r.engineHit !== null).length),
      agreementPct: pct(both.filter(r => r.agree).length, both.length),
      engineHitWhenAgree: pct(both.filter(r => r.agree && r.engineHit).length, both.filter(r => r.agree).length)
    },
    monitors: {
      count: monRows.length,
      triggeredWithin5dPct: pct(monRows.filter(r => r.monitor.triggered).length, monRows.length),
      nearestEngineLevelMedianDistPct: median(near),
      within0_5Pct: pct(near.filter(x => x <= 0.5).length, near.length),
      within1Pct: pct(near.filter(x => x <= 1).length, near.length),
      engineMonitorMedianDistPct: median(monRows.map(r => r.monitor.engineMonitorDistPct).filter(x => x !== null)),
      closestEngineLevelKinds: nearNames
    },
    rows
  };
}

async function main() {
  const want = (process.argv[2] || 'XAU,XAG,CL,CRCL').split(',');
  const data = JSON.parse(fs.readFileSync(THREADS, 'utf8'));
  const out = { generatedAt: new Date().toISOString(), interval: '1h', horizonDirBars: HORIZON_DIR, horizonMonitorBars: HORIZON_MON, symbols: {} };
  for (const code of want) {
    const th = data.symbols[code];
    if (!th || !th.binance) { console.log(`${code}: 无币安映射，跳过`); continue; }
    try {
      const r = await replaySymbol(code, th);
      if (!r) continue;
      out.symbols[code] = r;
      if (r.skipped) { console.log(`${code}: ${r.skipped}`); continue; }
      const d = r.direction3d, m = r.monitors;
      console.log(`${code.padEnd(5)} 评估${String(r.evaluated).padStart(3)}帖 | 3日方向: 柳${d.liuHitPct}%(${d.liuCalls}) 引擎${d.engineHitPct}%(${d.engineCalls}) 一致率${d.agreementPct}% 一致时引擎${d.engineHitWhenAgree}% | 监测点${m.count}: 5日内触发${m.triggeredWithin5dPct}% 最近引擎位中位距${m.nearestEngineLevelMedianDistPct}% ≤1%占${m.within1Pct}% 引擎监测点中位距${m.engineMonitorMedianDistPct}%`);
    } catch (err) {
      console.log(`${code}: 失败 ${err.message}`);
    }
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(`→ ${OUT}`);
}

if (require.main === module) main();
