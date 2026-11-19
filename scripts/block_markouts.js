#!/usr/bin/env node
/**
 * 给聪明钱登记表里的结构补算 markout (server/block_markouts.js)，写回 data/smart_money_BTC.json。
 * 依赖每日 mark 快照 (data/option_marks_daily，scripts/option_marks_history.js 生成) 与 Deribit 交割价。
 * 已算过的期限不重算；--recompute 全部重算 (估值口径调整后使用)。
 *
 * 用法: node scripts/block_markouts.js [--recompute]
 */

const fs = require('fs');
const BI = require('../server/block_insight');
const marksHistory = require('../server/option_marks_history');
const markouts = require('../server/block_markouts');

async function main() {
  const raw = JSON.parse(fs.readFileSync(BI.SMART_FILE, 'utf8'));
  const registry = BI.readRegistryFile();
  if (!registry.length) {
    console.log('[markouts] empty registry');
    return;
  }
  const firstDay = new Date(Math.min(...registry.map(s => s.ts))).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const history = marksHistory.loadRange('BTC', firstDay, today);
  const days = Object.keys(history).sort();
  if (!days.length) throw new Error('没有每日 mark 快照 (先运行 scripts/option_marks_history.js)');
  const delivery = await BI.fetchDeliveryPrices(1000);
  const r = markouts.computeMarkouts(registry, history, delivery, { recompute: process.argv.includes('--recompute') });
  if (r.computed) BI.writeRegistryFile(r.registry, BI.SMART_FILE, raw.producerHealth || null);
  const d1 = r.registry.filter(s => s.markouts?.d1).length;
  const d7 = r.registry.filter(s => s.markouts?.d7).length;
  console.log(`[markouts] marks ${days[0]} ~ ${days[days.length - 1]}; computed ${r.computed}; coverage d1 ${d1}/${registry.length}, d7 ${d7}/${registry.length}`);
}

main().catch(err => {
  console.error('[markouts] failed:', err.message);
  process.exit(1);
});
