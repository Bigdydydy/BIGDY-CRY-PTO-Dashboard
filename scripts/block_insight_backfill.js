#!/usr/bin/env node
/**
 * 用永久归档 (data/block_trades_archive) 把 4B 往前延伸：
 *  1. 日聚合 (block_flow_daily)：归档重建的完整日并入 (已有的日保持不动 —— 09-09 之后两者已核对一致)；
 *  2. 聪明钱登记：按月分析归档 (含期货对冲腿)，登记最早已登记结构之前的 ≥ $30M 结构；
 *     blockId 已被现有结构覆盖的跳过，同一笔 block 不会被重复登记；
 *  3. 已到期的按 Deribit 交割价结算，并计算 +1 / +7 天 markout。
 *
 * 用法: node scripts/block_insight_backfill.js [--from 2026-01-01]
 */

const fs = require('fs');
const BI = require('../server/block_insight');
const archive = require('../server/trade_archive');
const hedges = require('../server/block_hedges');
const marksHistory = require('../server/option_marks_history');
const markouts = require('../server/block_markouts');
const { analyzeBlockTrades } = require('../server/analytics_engine');

const DAY_MS = 86400000;

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function producerHealthOf(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).producerHealth || null;
  } catch (err) {
    return null;
  }
}

async function main() {
  const now = Date.now();
  const fromTs = Date.parse(`${argValue('--from', '2026-01-01')}T00:00:00Z`);
  const trades = archive.readArchive('BTC', { fromTs, toTs: now });
  if (!trades.length) throw new Error('归档为空');
  console.log(`[backfill] archive ${trades.length} legs from ${new Date(trades[0].timestamp).toISOString().slice(0, 10)}`);

  // ---- 1. 日聚合 ----
  const daily = BI.readDailyFile();
  const before = Object.keys(daily).length;
  const fresh = BI.aggregateTrades(trades, trades[0].timestamp, now);
  const add = Object.fromEntries(Object.entries(fresh).filter(([k, d]) => d.complete && !daily[k]));
  const merged = BI.mergeDaily(daily, add);
  BI.writeDailyFile(merged, BI.DAILY_FILE, producerHealthOf(BI.DAILY_FILE));
  const keys = Object.keys(merged).sort();
  console.log(`[backfill] daily aggregates: ${before} -> ${keys.length} days (${keys[0]} ~ ${keys[keys.length - 1]}), +${Object.keys(add).length}`);

  // ---- 2. 结构登记 ----
  const hedgeSet = hedges.readSet(hedges.COMMITTED_FILE);
  let registry = BI.readRegistryFile();
  const firstTs = registry.length ? Math.min(...registry.map(s => s.ts)) : now;
  const covered = new Set(registry.flatMap(s => s.blockIds || []));
  const existingIds = new Set(registry.map(s => s.id));
  let added = 0;
  let skippedOverlap = 0;
  for (let start = fromTs; start < firstTs;) {
    const d = new Date(start);
    const end = Math.min(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1), firstTs);
    // 前后各多取 1 天，跨月边界的冰山组也能完整聚合；登记时只认起点落在本段内的结构
    const window = trades.filter(t => t.timestamp >= start - DAY_MS && t.timestamp < end + DAY_MS);
    if (window.length) {
      const spot = window[window.length - 1].index_price;
      const analysis = analyzeBlockTrades(window, BI.STRUCTURE_MIN_NOTIONAL, 'all', spot, [], { hedges: hedgeSet });
      const keep = it => {
        const ts = it.startTimestamp ?? it.timestamp;
        if (!(ts >= start && ts < end)) return false;
        const ids = it.blockIds || [it.blockId];
        if (ids.some(id => covered.has(id))) {
          skippedOverlap++;
          return false;
        }
        return true;
      };
      const filtered = {
        icebergClusters: (analysis.icebergClusters || []).filter(keep),
        whaleBlocks: (analysis.whaleBlocks || []).filter(keep)
      };
      const res = BI.registerStructures(registry, filtered);
      for (const s of res.registry) {
        if (existingIds.has(s.id)) continue;
        existingIds.add(s.id);
        (s.blockIds || []).forEach(id => covered.add(id));
        added++;
      }
      registry = res.registry;
    }
    start = end;
  }
  console.log(`[backfill] registry: +${added} structures before ${new Date(firstTs).toISOString().slice(0, 10)} (${skippedOverlap} skipped as already covered), ${registry.length} total`);

  // ---- 3. 交割结算 + markout ----
  const delivery = await BI.fetchDeliveryPrices(1000);
  const settled = BI.markStructures(registry, { markByInstrument: {}, spot: null, deliveryByDate: delivery, nowMs: now });
  registry = settled.registry;
  const firstDay = new Date(Math.min(...registry.map(s => s.ts))).toISOString().slice(0, 10);
  const history = marksHistory.loadRange('BTC', firstDay, new Date(now).toISOString().slice(0, 10));
  const mk = markouts.computeMarkouts(registry, history, delivery);
  registry = mk.registry;
  BI.writeRegistryFile(registry, BI.SMART_FILE, producerHealthOf(BI.SMART_FILE));
  console.log(`[backfill] settled ${settled.settled}, markouts computed ${mk.computed}; finals ${registry.filter(s => s.final).length}, d7 ${registry.filter(s => s.markouts?.d7).length} / ${registry.length}`);
}

main().catch(err => {
  console.error('[backfill] failed:', err.message);
  process.exit(1);
});
