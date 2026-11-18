#!/usr/bin/env node
/**
 * 大宗成交永久归档的回补：把 git 历史里 data/block_trades_<CUR>.json 的每一个提交版本 + 当前文件取并集，
 * 并入 data/block_trades_archive/ (server/trade_archive.js)。
 *
 * 热数据文件只保留 60 天，更早的成交已被剪掉，但每天的提交都还在 git 历史里，所以能全部找回。
 * 幂等：重复运行只会补上缺的成交。
 *
 * 用法: node scripts/block_trades_archive_backfill.js [--currency BTC] [--rev origin/main]
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const archive = require('../server/trade_archive');

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function tradesOf(json) {
  if (Array.isArray(json)) return json;
  return json && Array.isArray(json.trades) ? json.trades : [];
}

function main() {
  const cur = String(argValue('--currency', 'BTC')).toUpperCase();
  const rev = argValue('--rev', 'HEAD');
  const rel = `data/block_trades_${cur}.json`;
  const root = path.join(__dirname, '..');
  const git = args => execFileSync('git', args, { cwd: root, maxBuffer: 1024 * 1024 * 1024 }).toString();

  const revs = git(['log', '--format=%H', rev, '--', rel]).trim().split('\n').filter(Boolean);
  const all = new Map();
  let versions = 0;
  for (const r of revs) {
    let json;
    try {
      json = JSON.parse(git(['show', `${r}:${rel}`]));
    } catch (err) {
      continue; // 该提交里文件被删除或损坏
    }
    versions++;
    for (const t of tradesOf(json)) {
      const k = archive.getTradeKey(t);
      // 同一笔成交在较新的版本里可能补全了字段：按提交从新到旧遍历，保留最先见到的 (最新)，再用旧版本补缺字段
      all.set(k, all.has(k) ? { ...t, ...all.get(k) } : t);
    }
  }
  const file = path.join(root, rel);
  if (fs.existsSync(file)) {
    for (const t of tradesOf(JSON.parse(fs.readFileSync(file, 'utf8')))) {
      const k = archive.getTradeKey(t);
      all.set(k, all.has(k) ? { ...all.get(k), ...t } : t);
    }
  }

  const r = archive.mergeIntoArchive(cur, [...all.values()]);
  const s = archive.archiveSummary(cur);
  const d = ts => (ts ? new Date(ts).toISOString().slice(0, 10) : '--');
  console.log(`[archive] ${versions} git versions of ${rel} + working copy -> ${all.size} distinct trades`);
  console.log(`[archive] +${r.added} new, ${r.updated} enriched; months written: ${r.months.join(', ') || 'none'}`);
  console.log(`[archive] ${cur}: ${s.totalTrades} trades, ${d(s.earliestTs)} ~ ${d(s.latestTs)}, ${s.months} month file(s)`);
}

main();
