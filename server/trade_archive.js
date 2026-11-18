/**
 * 大宗成交永久归档 —— Module 4 的 60 天热数据 (data/block_trades_<CUR>.json) 之外，见过的每一笔成交都永久保留
 *
 * - 按 UTC 月份分文件：data/block_trades_archive/<CUR>_YYYY-MM.jsonl，一行一笔 (Deribit 原始字段)，
 *   按 (timestamp, trade_id) 升序排列。新成交只会追加或补全字段，从不删除，git diff 也只是新增的几行。
 * - 由采集脚本 (GitHub Actions 的 4B 日更，经 trade_store.recordAndMergeTrades) 写入并提交；
 *   本地 HTTP 服务器只读，不写这些文件，避免与 Actions 的提交冲突。
 * - 同一笔成交 (trade_id) 再次出现时合并字段 ({...旧, ...新})，与热数据的去重口径一致。
 */

const fs = require('fs');
const path = require('path');

const ARCHIVE_DIR = path.join(__dirname, '..', 'data', 'block_trades_archive');

/** 成交的唯一键 (与 trade_store 一致) */
function getTradeKey(trade) {
  if (trade.trade_id) return String(trade.trade_id);
  return `${trade.block_trade_id || 'BLK'}_${trade.instrument_name}_${trade.timestamp}_${trade.amount}_${trade.direction}`;
}

function monthOf(ts) {
  return new Date(ts).toISOString().slice(0, 7);
}

function monthFile(currency, month, dir = ARCHIVE_DIR) {
  return path.join(dir, `${currency.toUpperCase()}_${month}.jsonl`);
}

/** 读一个月的归档；文件损坏时抛错 (绝不能在损坏的文件上覆盖写) */
function readMonth(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch (err) {
      throw new Error(`${path.basename(file)} 第 ${i + 1} 行无法解析：${err.message}`);
    }
  }
  return out;
}

const byTime = (a, b) => (a.timestamp - b.timestamp) || String(getTradeKey(a)).localeCompare(String(getTradeKey(b)));

/**
 * 把成交并入归档 (只增不删)。只改写内容有变化的月份文件。
 * @returns {{added: number, updated: number, months: string[]}}
 */
function mergeIntoArchive(currency = 'BTC', trades = [], { dir = ARCHIVE_DIR } = {}) {
  const byMonth = new Map();
  for (const t of trades || []) {
    if (!t || !Number.isFinite(t.timestamp) || t.timestamp <= 0) continue;
    const m = monthOf(t.timestamp);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(t);
  }
  let added = 0;
  let updated = 0;
  const months = [];
  for (const [month, incoming] of [...byMonth.entries()].sort()) {
    const file = monthFile(currency, month, dir);
    const existing = readMonth(file);
    const map = new Map(existing.map(t => [getTradeKey(t), t]));
    let changed = false;
    for (const t of incoming) {
      const k = getTradeKey(t);
      const old = map.get(k);
      if (!old) {
        map.set(k, t);
        added++;
        changed = true;
      } else {
        const merged = { ...old, ...t };
        if (JSON.stringify(merged) !== JSON.stringify(old)) {
          map.set(k, merged);
          updated++;
          changed = true;
        }
      }
    }
    if (!changed) continue;
    const body = [...map.values()].sort(byTime).map(t => JSON.stringify(t)).join('\n') + '\n';
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp_${process.pid}_${Date.now()}`;
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, file);
    months.push(month);
  }
  return { added, updated, months };
}

function listMonths(currency = 'BTC', dir = ARCHIVE_DIR) {
  if (!fs.existsSync(dir)) return [];
  const re = new RegExp(`^${currency.toUpperCase()}_(\\d{4}-\\d{2})\\.jsonl$`);
  return fs.readdirSync(dir).map(f => (re.exec(f) || [])[1]).filter(Boolean).sort();
}

/**
 * 读取归档里 [fromTs, toTs] 的成交 (升序)。不传区间即全部。
 */
function readArchive(currency = 'BTC', { fromTs = -Infinity, toTs = Infinity, dir = ARCHIVE_DIR } = {}) {
  const out = [];
  for (const m of listMonths(currency, dir)) {
    const start = Date.parse(`${m}-01T00:00:00Z`);
    const next = new Date(start);
    next.setUTCMonth(next.getUTCMonth() + 1);
    if (next.getTime() <= fromTs || start > toTs) continue;
    for (const t of readMonth(monthFile(currency, m, dir))) {
      if (t.timestamp >= fromTs && t.timestamp <= toTs) out.push(t);
    }
  }
  return out;
}

// 概况按文件 mtime 缓存：HTTP 请求频繁，不能每次都读完整个归档
const summaryCache = new Map();

/** 归档概况：总笔数、起止时间、月份数 */
function archiveSummary(currency = 'BTC', { dir = ARCHIVE_DIR } = {}) {
  const months = listMonths(currency, dir);
  const sig = months.map(m => {
    try { return `${m}:${fs.statSync(monthFile(currency, m, dir)).mtimeMs}`; } catch (e) { return m; }
  }).join('|');
  const key = `${dir}|${currency}`;
  const hit = summaryCache.get(key);
  if (hit && hit.sig === sig) return hit.value;
  let total = 0;
  let earliest = null;
  let latest = null;
  for (const m of months) {
    const trades = readMonth(monthFile(currency, m, dir));
    total += trades.length;
    if (trades.length) {
      if (earliest === null || trades[0].timestamp < earliest) earliest = trades[0].timestamp;
      if (latest === null || trades[trades.length - 1].timestamp > latest) latest = trades[trades.length - 1].timestamp;
    }
  }
  const value = { totalTrades: total, earliestTs: earliest, latestTs: latest, months: months.length };
  summaryCache.set(key, { sig, value });
  return value;
}

module.exports = {
  ARCHIVE_DIR,
  getTradeKey,
  monthOf,
  monthFile,
  readMonth,
  mergeIntoArchive,
  listMonths,
  readArchive,
  archiveSummary
};
