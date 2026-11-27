#!/usr/bin/env node
/**
 * 维护 data/skew_history_BTC.json (见 server/skew_history.js)。
 *
 * 用法：
 *   node scripts/skew_history.js                         日常：补齐最近 7 天内缺失或拟合失败的日子 (当天 08:00 UTC 之后才算当天)
 *   node scripts/skew_history.js --days 30               补齐最近 30 天
 *   node scripts/skew_history.js --rebuild research/skew_dvol   从研究抓取的 daily_insts*.jsonl 全量重建
 */
const fs = require('fs');
const path = require('path');
const S = require('../server/skew_history');

const DAY = 86400000;
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };

function rebuild(dir) {
  const files = fs.readdirSync(dir).filter(f => /^daily_insts.*\.jsonl$/.test(f));
  const byDay = new Map();
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); byDay.set(r.day, r); } catch (_) { /* 中断留下的半行 */ }
    }
  }
  const records = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).map(S.recordFromInsts);
  S.writeHistory(S.HISTORY_FILE, records);
  const fitted = records.filter(r => Number.isFinite(r.rr)).length;
  console.log(`rebuilt ${records.length} days (${fitted} fitted) → ${S.HISTORY_FILE}`);
}

async function daily(days) {
  const existing = S.readHistory();
  const have = new Map(existing.map(r => [r.day, r]));
  const now = Date.now();
  // 当天 08:00 UTC 之前窗口未结束，不抓当天
  const lastDay = new Date(now - 8 * 3600 * 1000).toISOString().slice(0, 10);
  const todo = [];
  for (let k = days - 1; k >= 0; k--) {
    const day = new Date(Date.parse(lastDay) - k * DAY).toISOString().slice(0, 10);
    const r = have.get(day);
    if (!r || !Number.isFinite(r.rr)) todo.push(day);
  }
  const fresh = [];
  for (const day of todo) {
    try {
      const rec = S.recordFromInsts(await S.fetchDayInsts(day));
      fresh.push(rec);
      console.log(day, 'rr', rec.rr, 'atm', rec.atm, 'n', rec.n);
    } catch (err) {
      console.warn(day, 'fetch failed:', err.message);
    }
  }
  if (!fresh.length) { console.log('nothing new'); return; }
  S.writeHistory(S.HISTORY_FILE, S.upsertRecords(existing, fresh));
}

(async () => {
  const dir = arg('--rebuild', null);
  if (dir) return rebuild(dir);
  await daily(Number(arg('--days', 7)));
})().catch(err => { console.error(err); process.exit(1); });
