/**
 * Deribit 期权未平仓量 (OI) 日快照档案 —— 判定大宗成交是「开仓」还是「平仓」
 *
 * 成交记录本身不区分开平仓，但每个合约每天的 OI 变化 + 24h 成交量可以给出估计：
 *   设该合约一个快照窗口内成交量 V、OI 变化 ΔOI，若每笔成交整体上要么双方开仓、要么双方平仓，
 *   则 开仓量 ≈ (V + ΔOI) / 2，平仓量 ≈ (V − ΔOI) / 2，开仓占比 = (V + ΔOI) / (2V)。
 *   窗口内该合约的大宗成交按这个比例归属（同一合约同一天无法再细分到单笔）。
 *
 * 快照口径：
 *  - 每个「OI 日」(UTC 08:00 交割后起算) 取一次 get_book_summary_by_currency 的 open_interest / volume(24h)；
 *    GitHub Actions 在 08:15 UTC 前后采样并提交 data/option_oi_history_BTC.json (权威序列)；
 *  - 服务器运行时若当天还没有快照，自己补采一份写入 .local.json (gitignored)，读取时与提交版合并，
 *    提交版优先；线上实例磁盘只是部署时的快照，因此也从 GitHub raw 拉取最新提交的档案 (30 分钟缓存)。
 *  - 文件用「合约名字典 + 每日 [序号, OI, 24h 成交量] 行」压缩存储，约 30KB/天 (~800 个合约)，保留 45 天，
 *    覆盖 30 天大宗成交库并留出余量。
 */

const fs = require('fs');
const path = require('path');
const { fetchWithTimeout } = require('./http_client');

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const RETENTION_DAYS = 45;
const DAY_START_OFFSET_MS = 8 * HOUR_MS; // Deribit 期权 08:00 UTC 交割，OI 日从此刻起算
const MAX_WINDOW_MS = 30 * HOUR_MS;      // 相邻快照间隔超过此值 (漏采) 时 24h 成交量覆盖不了窗口，不做判定
const OPENING_MIN = 0.65;
const CLOSING_MAX = 0.35;

const COMMITTED_FILE = path.join(__dirname, '..', 'data', 'option_oi_history_BTC.json');
const LOCAL_FILE = path.join(__dirname, '..', 'data', 'option_oi_history_BTC.local.json');

/** OI 日标识：UTC 08:00 之前的时刻仍属于前一天 */
function dayKey(ts) {
  return new Date(ts - DAY_START_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Deribit book summary 行 -> 快照 { ts, index, oi: { name: [openInterest, volume24h] } }
 * 只保留 OI 或成交量非零的合约。
 */
function snapshotFromBookSummary(rows, ts = Date.now()) {
  const oi = {};
  let index = null;
  for (const r of rows || []) {
    const name = r && r.instrument_name;
    const openInterest = Number(r && r.open_interest) || 0;
    const volume = Number(r && r.volume) || 0;
    if (!name || (openInterest <= 0 && volume <= 0)) continue;
    oi[name] = [Math.round(openInterest * 10) / 10, Math.round(volume * 10) / 10];
    if (index === null && Number(r.estimated_delivery_price) > 0) index = Number(r.estimated_delivery_price);
  }
  return Object.keys(oi).length ? { ts, index, oi } : null;
}

function encodeHistory(snapshots, currency = 'BTC') {
  const instruments = [];
  const idOf = new Map();
  const encoded = snapshots.map(s => ({
    ts: s.ts,
    index: s.index,
    rows: Object.entries(s.oi).map(([name, [openInterest, volume]]) => {
      if (!idOf.has(name)) {
        idOf.set(name, instruments.length);
        instruments.push(name);
      }
      return [idOf.get(name), openInterest, volume];
    })
  }));
  return { currency, version: 1, instruments, snapshots: encoded };
}

function decodeHistory(json) {
  if (!json || !Array.isArray(json.instruments) || !Array.isArray(json.snapshots)) return [];
  return json.snapshots
    .filter(s => Number.isFinite(s.ts) && Array.isArray(s.rows))
    .map(s => {
      const oi = {};
      for (const [i, openInterest, volume] of s.rows) {
        const name = json.instruments[i];
        if (name) oi[name] = [Number(openInterest) || 0, Number(volume) || 0];
      }
      return { ts: s.ts, index: s.index ?? null, oi };
    })
    .sort((a, b) => a.ts - b.ts);
}

/** 每个 OI 日只保留一份快照：先到者 (或集合 a 中的) 优先 */
function mergeSnapshotSets(a, b) {
  const byDay = new Map();
  for (const s of [...(a || []), ...(b || [])]) {
    const k = dayKey(s.ts);
    if (!byDay.has(k)) byDay.set(k, s);
  }
  return [...byDay.values()].sort((x, y) => x.ts - y.ts);
}

function pruneHistory(snapshots, now = Date.now()) {
  const cutoff = now - RETENTION_DAYS * DAY_MS;
  return snapshots.filter(s => s.ts >= cutoff);
}

function hasSnapshotForDay(snapshots, ts = Date.now()) {
  const k = dayKey(ts);
  return snapshots.some(s => dayKey(s.ts) === k);
}

function readHistoryFile(file) {
  try {
    return decodeHistory(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    return [];
  }
}

function writeHistoryFile(file, snapshots, currency = 'BTC') {
  fs.writeFileSync(file, JSON.stringify(encodeHistory(snapshots, currency)));
}

/**
 * 单个合约在时刻 ts 附近的开平仓估计
 * @returns {{status: 'opening'|'closing'|'mixed'|'pending'|'unknown', openShare?: number, deltaOI?: number, volume?: number}}
 */
function classifyTrade(snapshots, instrument, ts, expiryMs = null) {
  if (!snapshots || !snapshots.length) return { status: 'unknown' };
  // 第一个晚于成交时刻的快照
  let lo = 0;
  let hi = snapshots.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (snapshots[mid].ts > ts) hi = mid; else lo = mid + 1;
  }
  const s1 = snapshots[lo];
  const s0 = snapshots[lo - 1];
  if (!s1) {
    // 合约已在下一次快照前交割：OI 归零，无法判断
    if (expiryMs && expiryMs <= Date.now()) return { status: 'unknown' };
    return { status: 'pending' };
  }
  if (!s0 || s1.ts - s0.ts > MAX_WINDOW_MS) return { status: 'unknown' };
  if (expiryMs && expiryMs <= s1.ts) return { status: 'unknown' };

  const [oi0] = s0.oi[instrument] || [0, 0];
  const after = s1.oi[instrument];
  if (!after) return { status: 'unknown' };
  const [oi1, volume] = after;
  if (!(volume > 0)) return { status: 'unknown' };

  const deltaOI = oi1 - oi0;
  const openShare = Math.min(1, Math.max(0, (volume + deltaOI) / (2 * volume)));
  return { status: statusOf(openShare), openShare, deltaOI, volume };
}

function statusOf(openShare) {
  if (openShare >= OPENING_MIN) return 'opening';
  if (openShare <= CLOSING_MAX) return 'closing';
  return 'mixed';
}

/**
 * 多腿 / 多笔聚合：按张数加权的开仓占比。
 * @param {Array<{instrument: string, ts: number, amount: number, expiryMs?: number}>} items
 */
function profileFromItems(snapshots, items) {
  let known = 0;
  let total = 0;
  let openWeighted = 0;
  let pending = 0;
  for (const it of items || []) {
    const amt = Number(it.amount) || 0;
    if (amt <= 0) continue;
    total += amt;
    const c = classifyTrade(snapshots, it.instrument, it.ts, it.expiryMs);
    if (c.status === 'pending') pending += amt;
    if (c.openShare === undefined) continue;
    known += amt;
    openWeighted += c.openShare * amt;
  }
  if (!total) return { status: 'unknown', coverage: 0 };
  const coverage = known / total;
  if (coverage < 0.5) {
    return { status: pending / total >= 0.5 ? 'pending' : 'unknown', coverage };
  }
  const openShare = openWeighted / known;
  return { status: statusOf(openShare), openShare, coverage };
}

// ---- 线上 / 本地读取与补采 ----

const REMOTE_URL = process.env.OPTION_OI_HISTORY_URL
  || 'https://raw.githubusercontent.com/Bigdydydy/BIGDY-CRY-PTO-Dashboard/main/data/option_oi_history_BTC.json';
const REMOTE_TTL_MS = 30 * 60 * 1000;
const LIVE_RETRY_MS = 10 * 60 * 1000;

let remoteCache = { snapshots: null, at: 0 };
let committedCache = { mtimeMs: -1, snapshots: [] };
let localSnapshots = null;
let liveInflight = null;
let lastLiveAttempt = 0;

function readCommittedFromDisk() {
  try {
    const { mtimeMs } = fs.statSync(COMMITTED_FILE);
    if (mtimeMs !== committedCache.mtimeMs) committedCache = { mtimeMs, snapshots: readHistoryFile(COMMITTED_FILE) };
  } catch (err) {
    committedCache = { mtimeMs: -1, snapshots: [] };
  }
  return committedCache.snapshots;
}

async function readRemote(now) {
  if (remoteCache.snapshots && now - remoteCache.at < REMOTE_TTL_MS) return remoteCache.snapshots;
  try {
    const resp = await fetchWithTimeout(REMOTE_URL, { headers: { Accept: 'application/json' }, timeout: 8000, retries: 0 });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    remoteCache = { snapshots: decodeHistory(await resp.json()), at: now };
  } catch (err) {
    // 尚未推送或网络不可达：沿用上次结果，下次再试
    remoteCache = { snapshots: remoteCache.snapshots || [], at: now };
  }
  return remoteCache.snapshots;
}

/** 合并后的快照序列：仓库提交版 > GitHub raw 最新版 > 本机补采 */
async function getMergedHistory(now = Date.now()) {
  if (localSnapshots === null) localSnapshots = readHistoryFile(LOCAL_FILE);
  const remote = await readRemote(now);
  return pruneHistory(mergeSnapshotSets(mergeSnapshotSets(readCommittedFromDisk(), remote), localSnapshots), now);
}

/**
 * 当天还没有快照时由服务器补采一份 (不阻塞请求；失败 10 分钟后再试)。
 * @param {Function} fetchRows - async () => Deribit book summary rows
 */
function maybeRecordLiveSnapshot(merged, fetchRows, now = Date.now()) {
  if (hasSnapshotForDay(merged, now) || liveInflight || now - lastLiveAttempt < LIVE_RETRY_MS) return liveInflight;
  lastLiveAttempt = now;
  liveInflight = (async () => {
    try {
      const snap = snapshotFromBookSummary(await fetchRows(), Date.now());
      if (!snap) return;
      if (localSnapshots === null) localSnapshots = readHistoryFile(LOCAL_FILE);
      localSnapshots = pruneHistory(mergeSnapshotSets(localSnapshots, [snap]), snap.ts);
      writeHistoryFile(LOCAL_FILE, localSnapshots);
      console.log(`[OptionOI] recorded live snapshot for ${dayKey(snap.ts)} (${Object.keys(snap.oi).length} instruments)`);
    } catch (err) {
      console.warn('[OptionOI] live snapshot failed:', err.message);
    } finally {
      liveInflight = null;
    }
  })();
  return liveInflight;
}

module.exports = {
  COMMITTED_FILE,
  LOCAL_FILE,
  RETENTION_DAYS,
  dayKey,
  snapshotFromBookSummary,
  encodeHistory,
  decodeHistory,
  mergeSnapshotSets,
  pruneHistory,
  hasSnapshotForDay,
  readHistoryFile,
  writeHistoryFile,
  classifyTrade,
  profileFromItems,
  getMergedHistory,
  maybeRecordLiveSnapshot
};
