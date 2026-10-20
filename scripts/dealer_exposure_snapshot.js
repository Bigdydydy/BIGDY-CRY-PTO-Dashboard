#!/usr/bin/env node
/**
 * 做市商敞口日度快照：用 Deribit 全链快照 + 全成交台账 + 30 天大宗成交库计算当日敞口，
 * 写入 data/dealer_exposure_history_BTC.json (同日覆盖)。
 * 由 .github/workflows/option_flow_daily.yml 在台账同步之后调用；偏度与盘口深度不参与日度记录。
 *
 * 用法: node scripts/dealer_exposure_snapshot.js
 */

const path = require('path');
const fs = require('fs');
const { fetchBookSummaryRows, compactBookSummary } = require('../server/option_marks');
const { fetchDvolHistoricalStats } = require('../server/data_fetcher');
const { analyzeDealerExposure } = require('../server/dealer_engine');
const flow = require('../server/option_flow_ledger');
const history = require('../server/dealer_history');

function readBlockTrades() {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'block_trades_BTC.json'), 'utf8'));
    return Array.isArray(json.trades) ? json.trades : [];
  } catch (err) {
    return [];
  }
}

async function main() {
  const now = Date.now();
  const [rows, dvol] = await Promise.all([fetchBookSummaryRows('BTC'), fetchDvolHistoricalStats('BTC')]);
  const snapshot = { timestamp: now, ...compactBookSummary(rows) };
  const result = analyzeDealerExposure(snapshot, {
    now,
    flowLedger: flow.readLedger(flow.LEDGER_FILE),
    blockTrades: readBlockTrades(),
    recent24h: dvol?.recent24h || null
  });
  const record = history.recordFromAnalysis(result, now);
  if (!record) throw new Error(result.summaryText || '做市商敞口不可用');
  const records = history.upsertRecord(history.readHistory(history.HISTORY_FILE), record);
  history.writeHistory(history.HISTORY_FILE, records);
  console.log(`[dealer-history] ${record.day}: GEX ${(record.conv.gexUsd / 1e6).toFixed(1)}M (惯例)${record.flow ? ` / ${(record.flow.gexUsd / 1e6).toFixed(1)}M (全成交校正)` : ''}，共 ${records.length} 天`);
}

main().catch(err => {
  console.error('[dealer-history] failed:', err.message);
  process.exit(1);
});
