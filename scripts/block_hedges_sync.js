#!/usr/bin/env node
/**
 * 大宗成交的期货 / 永续对冲腿同步 (server/block_hedges.js) + 大宗归档对账。
 *
 * 1. 扫 Deribit 期权逐笔 (history.deribit.com)：给归档里缺 block_trade_leg_count 的腿补上总腿数 / combo_id；
 *    逐笔里有、归档里没有的大宗腿顺手补进归档 (source: 'deribit_history') —— 即每日对账，采集中断也能自动补齐。
 * 2. 总腿数多于期权腿数的 block，按成交时刻找回非期权腿，写入 data/block_hedges_BTC.json。
 * 3. 区间内每个 block 都核查过时推进 coveredThrough。
 * 4. 用含对冲的分析结果迁移聪明钱登记 (按含对冲的净 Delta 重算家族；盯市 / 交割记录不动)。
 *
 * 用法:
 *   node scripts/block_hedges_sync.js --from 2026-01-01 [--to 2026-11-19]   历史回补
 *   node scripts/block_hedges_sync.js --days 3                              日常 (4B 日更调用)
 */

const fs = require('fs');
const { fetchTradesPage } = require('../server/option_flow_ledger');
const archive = require('../server/trade_archive');
const hedges = require('../server/block_hedges');
const BI = require('../server/block_insight');
const { analyzeBlockTrades } = require('../server/analytics_engine');

const DAY_MS = 86400000;
const SETTLE_MS = 60 * 60 * 1000; // 最近 1 小时的成交 history 接口可能还没收录，日常模式不核查
const sleep = ms => new Promise(r => setTimeout(r, ms));

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

/** 扫 [fromTs, toTs) 的期权逐笔，返回其中的大宗腿 (trade_id -> trade) */
async function scanBlockLegs(fromTs, toTs, log) {
  const out = new Map();
  let cursor = fromTs;
  let pages = 0;
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
    for (const t of page.trades) {
      if (t.block_trade_id && t.timestamp >= fromTs && t.timestamp < toTs) out.set(archive.getTradeKey(t), t);
    }
    if (pages % 100 === 0) log(`tape ${pages} pages, at ${new Date(cursor).toISOString().slice(0, 16)}`);
    if (!page.hasMore || !page.trades.length) break;
    const last = Number(page.trades[page.trades.length - 1].timestamp);
    cursor = last > cursor ? last : cursor + 1;
    await sleep(100);
  }
  return { legs: out, pages };
}

async function main() {
  const log = msg => console.log(`[hedges] ${msg}`);
  const now = Date.now();
  const days = argValue('--days');
  const fromTs = days ? now - Number(days) * DAY_MS : Date.parse(`${argValue('--from', '2026-01-01')}T00:00:00Z`);
  const toTs = days ? now - SETTLE_MS : (argValue('--to') ? Date.parse(`${argValue('--to')}T00:00:00Z`) : now - SETTLE_MS);
  if (!(fromTs < toTs)) throw new Error('--from / --to / --days 非法');
  log(`range ${new Date(fromTs).toISOString()} ~ ${new Date(toTs).toISOString()}`);

  // ---- 1. 归档对账 + 总腿数 ----
  let legs = archive.readArchive('BTC', { fromTs, toTs: toTs - 1 });
  const needsCount = legs.filter(t => !(Number(t.block_trade_leg_count) > 0));
  let reconcileOk = true;
  if (needsCount.length || days) {
    // 日常模式总要对账一遍；回补模式只在有缺总腿数的腿时扫 (那一段时间)
    const scanFrom = days ? fromTs : Math.min(...needsCount.map(t => t.timestamp));
    const scanTo = days ? toTs : Math.max(...needsCount.map(t => t.timestamp)) + 1;
    try {
      const tape = await scanBlockLegs(scanFrom, scanTo, log);
      const have = new Map(legs.map(t => [archive.getTradeKey(t), t]));
      const updates = [];
      let added = 0;
      for (const [k, t] of tape.legs) {
        const old = have.get(k);
        if (!old) {
          updates.push({ ...t, source: 'deribit_history' });
          added++;
        } else if (!(Number(old.block_trade_leg_count) > 0)) {
          const patch = { trade_id: old.trade_id, timestamp: old.timestamp, block_trade_leg_count: t.block_trade_leg_count };
          if (t.combo_id) patch.combo_id = t.combo_id;
          updates.push(patch);
        }
      }
      const r = archive.mergeIntoArchive('BTC', updates);
      log(`tape ${tape.pages} pages, ${tape.legs.size} block legs; archive +${r.added} missing legs (${added} found), ${r.updated} legs got leg counts`);
      legs = archive.readArchive('BTC', { fromTs, toTs: toTs - 1 });
    } catch (err) {
      reconcileOk = false;
      console.warn('[hedges] tape scan failed:', err.message);
    }
  }

  // ---- 2. 非期权腿 ----
  const set = hedges.readSet(hedges.COMMITTED_FILE);
  const blocks = new Map();
  for (const t of legs) {
    if (!t.block_trade_id) continue;
    if (!blocks.has(t.block_trade_id)) blocks.set(t.block_trade_id, { ts: t.timestamp, optionLegs: 0, legCount: null });
    const b = blocks.get(t.block_trade_id);
    b.optionLegs++;
    b.ts = Math.min(b.ts, t.timestamp);
    if (Number(t.block_trade_leg_count) > 0) b.legCount = Number(t.block_trade_leg_count);
  }
  let unknown = 0;
  let fetched = 0;
  let failed = 0;
  let found = 0;
  const todo = [...blocks.entries()].filter(([id, b]) => {
    if (b.legCount == null) { unknown++; return false; }
    return b.legCount > b.optionLegs && !(set.blocks[id] && set.blocks[id].complete);
  });
  log(`${blocks.size} blocks in range, ${todo.length} with non-option legs to fetch, ${unknown} without a leg count`);
  for (const [id, b] of todo) {
    try {
      const r = await hedges.fetchBlockLegs(id, b.ts);
      const e = hedges.entryFromLegs(b.ts, r);
      if (e) {
        set.blocks[id] = e;
        found++;
      }
      fetched++;
    } catch (err) {
      failed++;
      console.warn(`[hedges] ${id} failed:`, err.message);
    }
    if (fetched % 100 === 0 && fetched) log(`fetched ${fetched}/${todo.length}`);
    await sleep(80);
  }
  // ---- 3. coveredThrough：区间连续接上、且每个 block 都核查过才推进 ----
  const prevCovered = Number(set.coveredThrough) || 0;
  const contiguous = !days || prevCovered >= fromTs;
  if (reconcileOk && !unknown && !failed && contiguous) set.coveredThrough = Math.max(prevCovered, toTs);
  hedges.writeSet(hedges.COMMITTED_FILE, set);
  const incomplete = Object.values(set.blocks).filter(e => !e.complete).length;
  log(`hedged blocks found ${found} (fetched ${fetched}, failed ${failed}); file has ${Object.keys(set.blocks).length} blocks, ${incomplete} incomplete; coveredThrough ${set.coveredThrough ? new Date(set.coveredThrough).toISOString() : '--'}`);

  // ---- 4. 聪明钱登记迁移 ----
  const regRaw = JSON.parse(fs.readFileSync(BI.SMART_FILE, 'utf8'));
  const registry = BI.readRegistryFile();
  if (registry.length) {
    const firstTs = Math.min(...registry.map(s => s.ts));
    const anFrom = Math.max(fromTs - 3 * DAY_MS, firstTs - 3 * DAY_MS);
    const trades = archive.readArchive('BTC', { fromTs: anFrom, toTs: toTs - 1 });
    if (trades.length) {
      const spot = trades[trades.length - 1].index_price;
      const analysis = analyzeBlockTrades(trades, BI.STRUCTURE_MIN_NOTIONAL, 'all', spot, [], { hedges: set });
      const r = BI.applyHedgesToRegistry(registry, analysis);
      if (r.updated) BI.writeRegistryFile(r.registry, BI.SMART_FILE, regRaw.producerHealth || null);
      log(`registry: ${r.updated} entries updated, ${r.refamilied} re-familied`);
    }
  }
}

main().catch(err => {
  console.error('[hedges] failed:', err.message);
  process.exit(1);
});
