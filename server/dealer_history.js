/**
 * 做市商敞口日度档案 —— "做市商 GEX 零轴翻转"与"对冲敞口走势"的历史序列
 *
 * 每个 UTC 日一条记录 (同日后写覆盖前写)，保留 400 天：
 *   { day, ts, spot, conv: { gexUsd, dexUsd, flip }, flow: { gexUsd, dexUsd, flip } | null,
 *     vexUsd, cexUsd, realized24hUsd, state, robust, nextMajor: { expiry, oiShare } }
 * flip 为现货滑动重估的零 Gamma 翻转价 (±20% 内无翻转位时为 null)；flow 为全成交校正口径 (台账可用时)。
 *
 * 档案由 scripts/dealer_exposure_snapshot.js 在 .github/workflows/option_flow_daily.yml 中每日写入并提交
 * data/dealer_exposure_history_BTC.json；线上从 GitHub raw 读取 (30 分钟缓存)，失败时读磁盘。
 */

const fs = require('fs');
const path = require('path');
const { fetchWithTimeout } = require('./http_client');
const { atomicWriteJson } = require('./data_health_cache');

const RETENTION_DAYS = 400;
const HISTORY_FILE = path.join(__dirname, '..', 'data', 'dealer_exposure_history_BTC.json');
const REMOTE_URL = process.env.DEALER_HISTORY_URL
  || 'https://raw.githubusercontent.com/Bigdydydy/BIGDY-CRY-PTO-Dashboard/main/data/dealer_exposure_history_BTC.json';
const REMOTE_TTL_MS = 30 * 60 * 1000;

const dayKey = ts => new Date(ts).toISOString().slice(0, 10);
const num = v => (Number.isFinite(v) ? Math.round(v) : null);
const flipPrice = s => (s && s.gammaFlip ? s.gammaFlip.price : null);

/** analyzeDealerExposure 结果 -> 日度记录；分析不可用时返回 null */
function recordFromAnalysis(r, ts = Date.now()) {
  if (!r || r.status !== 'ok') return null;
  const scen = key => (r.sensitivity?.scenarios || []).find(s => s.key === key) || null;
  const conv = scen('convention');
  const flow = scen('flow_adjusted');
  const realized = r.realized24h?.primary || r.realized24h?.convention || null;
  return {
    day: dayKey(ts),
    ts,
    spot: num(r.spot),
    conv: { gexUsd: num(r.exposures?.gexUsd), dexUsd: num(r.exposures?.dexUsd), flip: flipPrice(conv) },
    flow: flow ? { gexUsd: num(flow.gexUsd), dexUsd: num(r.primaryExposures?.dexUsd), flip: flipPrice(flow) } : null,
    vexUsd: num(r.primaryExposures?.vexUsd),
    cexUsd: num(r.primaryExposures?.cexUsd),
    realized24hUsd: realized ? num(realized.flowUsd) : null,
    state: r.state?.key || null,
    robust: typeof r.primaryRobust === 'boolean' ? r.primaryRobust : null,
    nextMajor: r.nextMajorExpiry ? { expiry: r.nextMajorExpiry.expiry, oiShare: r.nextMajorExpiry.oiShare } : null
  };
}

function upsertRecord(records, record, retentionDays = RETENTION_DAYS) {
  const out = (records || []).filter(x => x.day !== record.day);
  out.push(record);
  out.sort((a, b) => a.day.localeCompare(b.day));
  return out.slice(-retentionDays);
}

function validHistory(json) {
  return Boolean(json && Array.isArray(json.records) &&
    json.records.every(r => r && typeof r.day === 'string' && Number.isFinite(r.ts) && r.conv && typeof r.conv === 'object'));
}

function readHistory(file = HISTORY_FILE) {
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    return validHistory(json) ? json.records : [];
  } catch (err) {
    return [];
  }
}

function writeHistory(file, records) {
  atomicWriteJson(file, { currency: 'BTC', version: 1, records });
}

let remoteCache = { records: null, at: 0 };

async function getHistory({ now = Date.now(), fetcher = fetchWithTimeout, file = HISTORY_FILE } = {}) {
  if (remoteCache.records && now - remoteCache.at < REMOTE_TTL_MS) return remoteCache.records;
  let records;
  try {
    const resp = await fetcher(REMOTE_URL, { headers: { Accept: 'application/json' }, timeout: 8000, retries: 0 });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (!validHistory(json)) throw new Error('remote dealer history 校验失败');
    records = json.records;
  } catch (err) {
    records = readHistory(file);
  }
  remoteCache = { records, at: now };
  return records;
}

function clearHistoryCache() {
  remoteCache = { records: null, at: 0 };
}

/** 档案 + 当前实时记录 (同日以实时覆盖，标为 live)，供前端画走势 */
function withLivePoint(records, liveRecord) {
  if (!liveRecord) return records || [];
  const replacesArchived = (records || []).some(r => r.day === liveRecord.day);
  return upsertRecord(records || [], { ...liveRecord, live: true, replacesArchived });
}

module.exports = {
  HISTORY_FILE,
  RETENTION_DAYS,
  dayKey,
  recordFromAnalysis,
  upsertRecord,
  validHistory,
  readHistory,
  writeHistory,
  getHistory,
  clearHistoryCache,
  withLivePoint
};
