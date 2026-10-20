#!/usr/bin/env node
/**
 * Deribit BTC 期权全成交累计净额台账 (server/option_flow_ledger.js) 的回补与增量更新
 *
 * 默认增量：从台账游标同步到当前时刻；台账不存在时自动全量回补。
 * --backfill：忽略现有台账，从现存合约中最早的上市时间重新回补 (约 300 天、约 3000 页，接近 1 小时)。
 * 每 200 页写一次检查点；中途失败后不带 --backfill 重跑即从游标续上。
 * --max-pages N：本次最多请求 N 页 (每页 1000 笔)，未完成时保存游标，下次继续。
 *
 * 由 .github/workflows/option_flow_daily.yml 每日调用并提交 data/option_flow_ledger_BTC.json。
 *
 * 用法: node scripts/option_flow_ledger.js [--backfill] [--max-pages N]
 */

const flow = require('../server/option_flow_ledger');

const CHECKPOINT_PAGES = 200;

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function main() {
  const now = Date.now();
  const maxPages = Number(argValue('--max-pages')) || Infinity;
  const { names, earliestCreation } = await flow.fetchLiveInstruments('BTC');
  if (!names.size || !earliestCreation) throw new Error('无法取得现存期权合约名单');

  let ledger = process.argv.includes('--backfill') ? null : flow.readLedger(flow.LEDGER_FILE);
  if (!ledger) {
    ledger = flow.emptyLedger('BTC');
    ledger.startTs = earliestCreation;
    console.log(`[option-flow] 全量回补：自 ${new Date(earliestCreation).toISOString()} 起，${names.size} 个现存合约`);
  } else {
    console.log(`[option-flow] 增量：自 ${new Date(ledger.lastTradeTs ?? ledger.startTs).toISOString()} 起`);
  }

  let lastLog = 0;
  const result = await flow.syncLedger(ledger, {
    currency: 'BTC',
    endTs: now,
    liveSet: names,
    maxPages,
    onPage: ({ pages, applied, lastTradeTs }) => {
      // 检查点：中途失败时重跑会从游标续上；未完成前 syncedThrough 不前进，服务器会把台账标为过期
      if (pages % CHECKPOINT_PAGES === 0) flow.writeLedger(flow.LEDGER_FILE, ledger);
      if (Date.now() - lastLog > 15000) {
        lastLog = Date.now();
        console.log(`[option-flow] ${pages} 页，入账 ${applied} 笔，游标 ${lastTradeTs ? new Date(lastTradeTs).toISOString() : '--'}`);
      }
    }
  });

  flow.pruneExpired(ledger, now);
  flow.writeLedger(flow.LEDGER_FILE, ledger);
  console.log(`[option-flow] ${result.complete ? '完成' : '未完成 (达到页数上限)'}：${result.pages} 页，入账 ${result.applied} 笔，台账 ${Object.keys(ledger.instruments).length} 个合约`);
}

main().catch(err => {
  console.error('[option-flow] failed:', err.message);
  process.exit(1);
});
