#!/usr/bin/env node
/**
 * Deribit BTC 期权未平仓量日快照 (由 .github/workflows/block_insight_daily.yml 在 UTC 08:00 交割后调用)
 *
 * 把每个期权合约的 open_interest / 24h volume 并入 data/option_oi_history_BTC.json，
 * 供大宗成交的开平仓判定使用 (见 server/option_oi_history.js)。
 * 本地运行服务器时不要手动执行本脚本：服务器自己的补采写在 .local.json，避免与 Actions 的提交冲突。
 *
 * --skip-if-done：当前 OI 日 (UTC 08:00 起算) 已有快照时直接退出、不改文件，
 * 这样工作流一天排多个时段时只有第一次成功的运行会产生提交。
 *
 * 用法: node scripts/option_oi_snapshot.js [--skip-if-done]
 */

const { fetchBookSummaryRows } = require('../server/option_marks');
const oi = require('../server/option_oi_history');

async function main() {
  const now = Date.now();
  const existing = oi.readHistoryFile(oi.COMMITTED_FILE);
  if (process.argv.includes('--skip-if-done') && oi.hasSnapshotForDay(existing, now)) {
    console.log(`[option-oi] snapshot for ${oi.dayKey(now)} already recorded; skipping`);
    return;
  }

  const snap = oi.snapshotFromBookSummary(await fetchBookSummaryRows('BTC'), Date.now());
  if (!snap) throw new Error('empty book summary');

  const merged = oi.pruneHistory(oi.mergeSnapshotSets(existing, [snap]), snap.ts);
  oi.writeHistoryFile(oi.COMMITTED_FILE, merged);
  console.log(`[option-oi] ${oi.dayKey(snap.ts)}: ${Object.keys(snap.oi).length} instruments, ${merged.length} days kept`);
}

main().catch(err => {
  console.error('[option-oi] snapshot failed:', err.message);
  process.exit(1);
});
