#!/usr/bin/env node
/**
 * 用 Deribit 逐笔成交历史 (history.deribit.com) 回补大宗成交永久归档 (server/trade_archive.js)。
 *
 * 日常采集来自 Greeks.live 的 block_trade 接口，只能看到最近约 72 小时；更早的 / 采集漏掉的大宗，
 * 从 Deribit 全量期权成交里筛出带 block_trade_id 的腿补进来。实测 2026-09-15 两边 283 笔逐笔一致
 * (trade_id、方向、数量、合约)。Deribit 的记录没有 Greeks.live 附带的 delta / mark_iv，另带
 * combo_id / block_trade_leg_count 等字段；补进来的成交标记 source: 'deribit_history'。
 *
 * 只追加归档里没有的成交，已有的 (Greeks.live 版本，字段更全) 不改动。按月分段抓取、分段落盘，中断后重跑即可续上。
 *
 * 用法: node scripts/block_trades_archive_deribit.js --from 2026-01-01 [--to 2026-11-18] [--currency BTC]
 */

const { fetchTradesPage } = require('../server/option_flow_ledger');
const archive = require('../server/trade_archive');

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchBlockLegs(currency, fromTs, toTs, onPage) {
  const legs = new Map();
  let cursor = fromTs;
  let pages = 0;
  let scanned = 0;
  for (;;) {
    let page;
    for (let attempt = 1; ; attempt++) {
      try {
        page = await fetchTradesPage(currency, cursor, toTs - 1);
        break;
      } catch (err) {
        // history 接口偶发 400 / 5xx：指数退避，最多约 4 分钟
        if (attempt >= 8) throw err;
        await sleep(Math.min(60000, 1500 * 2 ** attempt));
      }
    }
    pages++;
    for (const t of page.trades) {
      if (t.timestamp < fromTs || t.timestamp >= toTs) continue;
      scanned++;
      if (t.block_trade_id) legs.set(archive.getTradeKey(t), { ...t, source: 'deribit_history' });
    }
    if (onPage && pages % 50 === 0) onPage(pages, cursor);
    if (!page.hasMore || !page.trades.length) break;
    const lastTs = Number(page.trades[page.trades.length - 1].timestamp);
    cursor = lastTs > cursor ? lastTs : cursor + 1;
    await sleep(100);
  }
  return { legs: [...legs.values()], pages, scanned };
}

async function main() {
  const cur = String(argValue('--currency', 'BTC')).toUpperCase();
  const from = Date.parse(`${argValue('--from', '2026-01-01')}T00:00:00Z`);
  const to = argValue('--to') ? Date.parse(`${argValue('--to')}T00:00:00Z`) : Date.now();
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error('--from / --to 非法');

  let totalAdded = 0;
  for (let start = from; start < to;) {
    const d = new Date(start);
    const monthEnd = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    const end = Math.min(monthEnd, to);
    const month = archive.monthOf(start);
    const t0 = Date.now();
    const r = await fetchBlockLegs(cur, start, end, (p, c) => console.log(`[deribit-archive] ${month}: ${p} pages, at ${new Date(c).toISOString().slice(0, 16)}`));
    const known = new Set(archive.readMonth(archive.monthFile(cur, month)).map(archive.getTradeKey));
    const missing = r.legs.filter(t => !known.has(archive.getTradeKey(t)));
    const m = archive.mergeIntoArchive(cur, missing);
    totalAdded += m.added;
    const blocks = new Set(missing.map(t => t.block_trade_id)).size;
    console.log(`[deribit-archive] ${month}: scanned ${r.scanned} option trades / ${r.pages} pages, block legs ${r.legs.length}, already archived ${r.legs.length - missing.length}, added ${m.added} legs (${blocks} blocks) in ${Math.round((Date.now() - t0) / 1000)}s`);
    start = end;
  }
  const s = archive.archiveSummary(cur);
  const day = ts => (ts ? new Date(ts).toISOString().slice(0, 10) : '--');
  console.log(`[deribit-archive] done: +${totalAdded} legs; archive ${s.totalTrades} trades, ${day(s.earliestTs)} ~ ${day(s.latestTs)}, ${s.months} month file(s)`);
}

main().catch(err => {
  console.error('[deribit-archive] failed:', err.message);
  process.exit(1);
});
