#!/usr/bin/env node
/**
 * Deribit BTC 期权未平仓量日快照 (由 .github/workflows/block_insight_daily.yml 在 UTC 08:00 交割后调用)
 *
 * 1. 把每个期权合约的 open_interest / 24h volume 并入 data/option_oi_history_BTC.json，
 *    供大宗成交的开平仓判定使用 (见 server/option_oi_history.js)。
 * 2. 给缺少「窗口精确成交量」的快照补算：用逐笔成交 (history.deribit.com) 汇总相邻两次快照之间每个合约的成交量。
 *    快照至少落地 2 小时后才补 (逐笔接口可能滞后)，所以当天的快照通常由当天稍晚一次运行补齐。
 * 本地运行服务器时不要手动执行本脚本写入仓库文件：服务器自己的补采写在 .local.json，避免与 Actions 的提交冲突；
 * 需要本地试跑时用 --file 指向临时文件。
 *
 * --skip-if-done：当前 OI 日 (UTC 08:00 起算) 已有快照时跳过采样 (仍会补算精确窗口成交量)，
 * 这样工作流一天排多个时段时只有第一次成功的运行会采样，后面的运行负责补齐。
 * --backfill N：本次最多补算 N 个窗口 (默认 40，足以一次补齐 45 天保留期；0 关闭)。
 *
 * 用法: node scripts/option_oi_snapshot.js [--skip-if-done] [--backfill 10] [--file path]
 */

const { fetchBookSummaryRows } = require('../server/option_marks');
const { fetchTradesPage } = require('../server/option_flow_ledger');
const oi = require('../server/option_oi_history');

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const now = Date.now();
  const file = argValue('--file') || oi.COMMITTED_FILE;
  let snapshots = oi.readHistoryFile(file);
  let changed = false;

  if (process.argv.includes('--skip-if-done') && oi.hasSnapshotForDay(snapshots, now)) {
    console.log(`[option-oi] snapshot for ${oi.dayKey(now)} already recorded; skipping sampling`);
  } else {
    const snap = oi.snapshotFromBookSummary(await fetchBookSummaryRows('BTC'), Date.now());
    if (!snap) throw new Error('empty book summary');
    snapshots = oi.pruneHistory(oi.mergeSnapshotSets(snapshots, [snap]), snap.ts);
    changed = true;
    console.log(`[option-oi] ${oi.dayKey(snap.ts)}: ${Object.keys(snap.oi).length} instruments, ${snapshots.length} days kept`);
  }

  // 精确窗口成交量补算失败不影响当天采样的提交 (下次运行再补)
  const maxWindows = Number(argValue('--backfill') ?? 40);
  if (maxWindows > 0) {
    try {
      const r = await oi.backfillWindowVolumes(snapshots, {
        fetchPage: fetchTradesPage,
        now: Date.now(),
        maxWindows,
        log: msg => console.log(`[option-oi] window volume ${msg}`)
      });
      if (r.filled) changed = true;
      for (const e of r.errors) console.warn(`[option-oi] window volume failed ${e}`);
      console.log(`[option-oi] window volume backfilled ${r.filled} window(s)`);
    } catch (err) {
      console.warn('[option-oi] window volume backfill skipped:', err.message);
    }
  }

  if (changed) oi.writeHistoryFile(file, snapshots);
}

main().catch(err => {
  console.error('[option-oi] snapshot failed:', err.message);
  process.exit(1);
});
