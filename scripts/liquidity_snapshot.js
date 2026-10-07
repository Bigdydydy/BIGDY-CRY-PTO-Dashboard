#!/usr/bin/env node
/**
 * Coinbase BTC-USD 深度小时采样 (由 .github/workflows/liquidity_hourly.yml 每小时调用)
 *
 * 间隔数秒连取几次 L2 订单簿，并入当前 UTC 小时的桶 (桶内均值)，
 * 写回 data/coinbase_liquidity_history.json。本地运行服务器时不要手动执行本脚本，
 * 服务器自己的快照写在 .local.json，避免与 Actions 的提交冲突。
 *
 * 用法: node scripts/liquidity_snapshot.js [--shots 3] [--gap 15]
 */

const {
  fetchCoinbaseOrderBook,
  fetchCoinbaseTickerAndStats,
  processCoinbaseData
} = require('../server/coinbase_fetcher');
const history = require('../server/liquidity_history');

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const SHOTS = argValue('--shots', 3);
const GAP_SEC = argValue('--gap', 15);

const wait = ms => new Promise(r => setTimeout(r, ms));

async function takeSnapshot() {
  const [book, tickerStats] = await Promise.all([
    fetchCoinbaseOrderBook(),
    fetchCoinbaseTickerAndStats()
  ]);
  const result = processCoinbaseData(book, [], tickerStats);
  return history.snapshotFromLiquidity(result);
}

async function main() {
  let samples = history.readHistoryFile(history.COMMITTED_FILE);
  let ok = 0;

  for (let i = 0; i < SHOTS; i++) {
    if (i > 0) await wait(GAP_SEC * 1000);
    try {
      const snap = await takeSnapshot();
      if (!snap) throw new Error('empty snapshot');
      samples = history.mergeSnapshot(samples, snap, Date.now());
      ok++;
      console.log(`[liquidity] shot ${i + 1}/${SHOTS}: 10bps $${snap.d10.toFixed(2)}M · 100bps $${snap.d100.toFixed(2)}M · 24h vol $${(snap.vol24 || 0).toFixed(0)}M`);
    } catch (err) {
      console.warn(`[liquidity] shot ${i + 1}/${SHOTS} failed: ${err.message}`);
    }
  }

  if (!ok) {
    console.error('[liquidity] all snapshots failed; history unchanged');
    process.exit(1);
  }

  history.writeHistoryFile(history.COMMITTED_FILE, samples);
  console.log(`[liquidity] saved ${samples.length} hourly samples`);
}

main().catch(err => {
  console.error('[liquidity] fatal:', err);
  process.exit(1);
});
