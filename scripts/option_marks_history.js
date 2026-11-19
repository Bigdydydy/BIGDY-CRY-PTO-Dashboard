#!/usr/bin/env node
/**
 * 从 Deribit 期权逐笔 (history.deribit.com) 生成每日 08:00 UTC mark 快照 (server/option_marks_history.js)。
 *
 * 用法:
 *   node scripts/option_marks_history.js --from 2026-01-01 [--to 2026-11-19]   回补 (按月分段扫描、分段落盘)
 *   node scripts/option_marks_history.js --days 3                              日常 (4B 日更调用)
 * 幂等：同一天同一合约只保留观测更晚的一笔，重跑 / 区间重叠都安全。
 */

const { fetchTradesPage } = require('../server/option_flow_ledger');
const marks = require('../server/option_marks_history');

const DAY_MS = 86400000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

/** 合并两份按日快照 (内存中)，同一合约保留更晚的观测 */
function foldInto(acc, snaps) {
  for (const [day, s] of Object.entries(snaps)) {
    const d = acc[day] || (acc[day] = { closeTs: s.closeTs, index: null, indexTs: 0, marks: {} });
    for (const [inst, m] of Object.entries(s.marks)) {
      const prev = d.marks[inst];
      if (!prev || m[1] >= prev[1]) d.marks[inst] = m;
    }
    if (s.index && s.indexTs >= d.indexTs) {
      d.index = s.index;
      d.indexTs = s.indexTs;
    }
  }
}

async function scan(fromTs, toTs, label) {
  const acc = {};
  let cursor = fromTs;
  let pages = 0;
  let trades = 0;
  for (;;) {
    let page;
    for (let attempt = 1; ; attempt++) {
      try {
        page = await fetchTradesPage('BTC', cursor, toTs - 1);
        break;
      } catch (err) {
        // history 接口偶发 400 / 5xx：指数退避，最多约 4 分钟
        if (attempt >= 8) throw err;
        await sleep(Math.min(60000, 1500 * 2 ** attempt));
      }
    }
    pages++;
    const inRange = page.trades.filter(t => t.timestamp >= fromTs && t.timestamp < toTs);
    trades += inRange.length;
    foldInto(acc, marks.snapshotsFromTrades(inRange));
    if (pages % 100 === 0) console.log(`[marks] ${label}: ${pages} pages, at ${new Date(cursor).toISOString().slice(0, 16)}`);
    if (!page.hasMore || !page.trades.length) break;
    const last = Number(page.trades[page.trades.length - 1].timestamp);
    cursor = last > cursor ? last : cursor + 1;
    await sleep(100);
  }
  return { acc, pages, trades };
}

async function main() {
  const now = Date.now();
  const days = argValue('--days');
  // 快照日从 08:00 UTC 起算：区间对齐到 08:00，保证首日快照完整
  const align = ts => Date.parse(`${new Date(ts).toISOString().slice(0, 10)}T08:00:00Z`);
  const fromTs = days ? align(now - (Number(days) + 1) * DAY_MS) : align(Date.parse(`${argValue('--from', '2026-01-01')}T00:00:00Z`) - DAY_MS);
  const toTs = argValue('--to') ? Date.parse(`${argValue('--to')}T08:00:00Z`) + 1 : now;
  if (!(fromTs < toTs)) throw new Error('--from / --to / --days 非法');

  for (let start = fromTs; start < toTs;) {
    // 按月分段 (段尾对齐到下个月 1 日 08:00，快照日不会被拆开)
    const d = new Date(start);
    const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 8, 0, 0) + 1;
    const end = Math.min(next, toTs);
    const t0 = Date.now();
    const label = new Date(start).toISOString().slice(0, 7);
    const r = await scan(start, end, label);
    const m = marks.mergeSnapshots('BTC', r.acc);
    const dayKeys = Object.keys(r.acc).sort();
    const avg = dayKeys.length ? Math.round(dayKeys.reduce((s, k) => s + Object.keys(r.acc[k].marks).length, 0) / dayKeys.length) : 0;
    console.log(`[marks] ${label}: ${r.trades} trades / ${r.pages} pages -> ${dayKeys.length} days (${dayKeys[0] || '-'} ~ ${dayKeys[dayKeys.length - 1] || '-'}), ~${avg} instruments/day; wrote ${m.months.join(', ') || 'nothing'} in ${Math.round((Date.now() - t0) / 1000)}s`);
    start = end;
  }
}

main().catch(err => {
  console.error('[marks] failed:', err.message);
  process.exit(1);
});
