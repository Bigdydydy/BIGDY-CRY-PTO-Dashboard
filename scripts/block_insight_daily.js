#!/usr/bin/env node
/**
 * Module 4B 日更 (由 .github/workflows/block_insight_daily.yml 在 UTC 08:00 交割后调用)
 *
 *  1. 拉取 Greeks.live 近 72h 大宗成交，把其中已完整覆盖的 OI 日压成日聚合，并入
 *     data/block_flow_daily_BTC.json (长期保留)；
 *  2. 把其中 ≥ $30M 的冰山组 / 独立大单登记进 data/smart_money_BTC.json；
 *  3. 用 Deribit 标记价给未结算的结构记当天的盯市点，已全部交割的按交割价结算。
 * 每一步都是幂等的，一天多次运行只会补齐缺失的部分；某一步失败不影响其它步骤，全部失败才以非零退出。
 * 本地运行服务器时不要手动执行本脚本：服务器的补采写在 .local.json，避免与 Actions 的提交冲突。
 *
 * 用法: node scripts/block_insight_daily.js
 */

const BI = require('../server/block_insight');
const { fetchBlockTrades } = require('../server/data_fetcher');
const { fetchBookSummaryRows } = require('../server/option_marks');
const { analyzeBlockTrades } = require('../server/analytics_engine');
const oi = require('../server/option_oi_history');

async function main() {
  const now = Date.now();
  let daily = BI.readDailyFile();
  let registry = BI.readRegistryFile();
  const oiSnapshots = oi.readHistoryFile(oi.COMMITTED_FILE);
  let ok = 0;

  try {
    const trades = await fetchBlockTrades('BTC');
    if (!trades.length) throw new Error('no block trades returned');
    const coverage = Math.min(...trades.map(t => t.timestamp));
    const fresh = BI.aggregateTrades(trades, coverage, now);
    const complete = Object.fromEntries(Object.entries(fresh).filter(([, d]) => d.complete));
    daily = BI.mergeDaily(daily, complete);
    console.log(`[4B] daily aggregates: +${Object.keys(complete).length} complete days in window, ${Object.keys(daily).length} kept`);

    const spot = trades.reduce((a, t) => (t.timestamp > a.timestamp ? t : a)).index_price;
    const analysis = analyzeBlockTrades(trades, BI.STRUCTURE_MIN_NOTIONAL, 'all', spot, oiSnapshots);
    const res = BI.registerStructures(registry, analysis);
    registry = res.registry;
    console.log(`[4B] structures: +${res.added}, ${registry.length} tracked`);
    ok++;
  } catch (err) {
    console.error('[4B] block trades step failed:', err.message);
  }

  try {
    const [rows, deliveryByDate] = await Promise.all([fetchBookSummaryRows('BTC'), BI.fetchDeliveryPrices()]);
    const { markByInstrument, spot } = BI.marksFromBookSummary(rows);
    const res = BI.markStructures(registry, { markByInstrument, spot, deliveryByDate, nowMs: Date.now() });
    registry = res.registry;
    console.log(`[4B] marked ${res.marked}, settled ${res.settled}`);
    ok++;
  } catch (err) {
    console.error('[4B] mark-to-market step failed:', err.message);
  }

  if (!ok) process.exit(1);
  BI.writeDailyFile(daily);
  BI.writeRegistryFile(registry);
}

main().catch(err => {
  console.error('[4B] failed:', err.message);
  process.exit(1);
});
