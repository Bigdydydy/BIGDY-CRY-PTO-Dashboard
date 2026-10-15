/**
 * 波动率曲面日度档案 —— 为 25Δ 偏度"贵贱"判断提供自身历史基准
 *
 * Greeks.live skew_chart 只返回约 1 天的点，无法回答"当前偏度相对历史是否偏贵"。
 * 服务器每个 UTC 日保存一条记录 (同一天内后写覆盖前写，取当日最后状态)，保留 400 天：
 *   { day, ts, spot, iv1m, dvol, rr7, rr30, rr90, bf25 }
 * 文件写在 data/vol_surface_history_BTC.local.json (gitignored)，写入节流为每小时一次。
 */

const fs = require('fs');
const path = require('path');

const RETENTION_DAYS = 400;
const WRITE_THROTTLE_MS = 3600 * 1000;
const HISTORY_FILE = path.join(__dirname, '..', 'data', 'vol_surface_history_BTC.local.json');

let cache = null;
let lastWriteTs = 0;

const dayKey = ts => new Date(ts).toISOString().slice(0, 10);

function readHistory(file = HISTORY_FILE) {
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(json.records) ? json.records.filter(r => r && typeof r.day === 'string') : [];
  } catch (err) {
    return [];
  }
}

/** 插入或覆盖当日记录，按日期排序并裁剪到保留期 */
function upsertRecord(records, record, retentionDays = RETENTION_DAYS) {
  const out = records.filter(r => r.day !== record.day);
  out.push(record);
  out.sort((a, b) => a.day.localeCompare(b.day));
  return out.slice(-retentionDays);
}

/** 由各板块分析结果组装当日记录；关键字段缺失时返回 null */
function recordFromAnalyses({ atm, smile, skew, spot, ts = Date.now() }) {
  if (!skew || !Number.isFinite(skew.d30)) return null;
  const num = v => (Number.isFinite(v) ? v : null);
  return {
    day: dayKey(ts),
    ts,
    spot: num(spot),
    iv1m: num(atm?.iv1m),
    dvol: num(atm?.dvolLatest),
    rr7: num(skew.d7),
    rr30: num(skew.d30),
    rr90: num(skew.d90),
    bf25: num(smile?.bf25)
  };
}

function getHistory() {
  if (!cache) cache = readHistory();
  return cache;
}

/** 记录当日快照 (内存立即更新，磁盘写入每小时最多一次) */
function recordSnapshot(analyses, { file = HISTORY_FILE, now = Date.now() } = {}) {
  const record = recordFromAnalyses({ ...analyses, ts: now });
  if (!record) return getHistory();
  cache = upsertRecord(getHistory(), record);
  if (now - lastWriteTs >= WRITE_THROTTLE_MS) {
    lastWriteTs = now;
    try {
      fs.writeFileSync(file, JSON.stringify({ currency: 'BTC', version: 1, records: cache }));
    } catch (err) {
      console.warn('[VolSurfaceHistory] write failed:', err.message);
    }
  }
  return cache;
}

module.exports = {
  HISTORY_FILE,
  RETENTION_DAYS,
  dayKey,
  readHistory,
  upsertRecord,
  recordFromAnalyses,
  getHistory,
  recordSnapshot
};
