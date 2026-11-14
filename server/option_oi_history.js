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
 *  - 文件用「合约名字典 + 每日 [序号, OI, 24h 成交量, 窗口精确成交量?] 行」压缩存储，约 30KB/天 (~800 个合约)，
 *    保留 45 天，覆盖 30 天大宗成交库并留出余量。
 *  - 窗口精确成交量：每日任务用逐笔成交 (history.deribit.com) 汇总相邻两次快照之间每个合约的成交量，
 *    写成第 4 列并在快照上记 winFrom (= 上一快照 ts)。快照时间漂移 (GitHub 定时任务常晚数小时) 与漏采几天的长窗口
 *    都因此可判；没有精确值时退回 24h 成交量 (窗口 ≤ 24h 时是上界，区间仍成立；更长时只给点估计)。
 *
 * 判定口径 (profileFromItems)：点估计是「该合约当日整体」的开仓占比；本单自身的开仓占比只能给区间
 * (shareBounds)，区间下界 ≥ 65% / 上界 ≤ 35% 才算「确证」，否则只是「倾向」。
 */

const fs = require('fs');
const path = require('path');
const { fetchWithTimeout } = require('./http_client');
const { recordAttempt, recordSuccess, recordFailure } = require('./data_health');
const { seedCachedHealth, atomicWriteJson } = require('./data_health_cache');

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const RETENTION_DAYS = 45;
const DAY_START_OFFSET_MS = 8 * HOUR_MS; // Deribit 期权 08:00 UTC 交割，OI 日从此刻起算
const MAX_WINDOW_MS = 30 * HOUR_MS;      // 相邻快照间隔超过此值 (漏采) 且没有精确窗口成交量时，不做判定
const MAX_EXACT_WINDOW_MS = 96 * HOUR_MS; // 有逐笔汇总的精确窗口成交量时，漏采几天的长窗口仍可判定 (区间更宽)
// Deribit book summary 的 open_interest 落后于成交 (实测 11-05~11-07：快照前 2~4 小时内的成交常未计入 OI)。
// 因此窗口成交量从 s0 前 OI_LAG_MS 起算；快照前 OI_LAG_MS 内的成交改用下一次快照作为窗口终点。
const OI_LAG_MS = 4 * HOUR_MS;
const UPPER_WINDOW_MS = DAY_MS - OI_LAG_MS; // 窗口不超过此长度时，终点快照的 24h 成交量覆盖 (s0 − 滞后, s1]，是窗口成交量的上界
const OPENING_MIN = 0.65;
const CLOSING_MAX = 0.35;

const COMMITTED_FILE = path.join(__dirname, '..', 'data', 'option_oi_history_BTC.json');
const LOCAL_FILE = path.join(__dirname, '..', 'data', 'option_oi_history_BTC.local.json');

/** OI 日标识：UTC 08:00 之前的时刻仍属于前一天 */
function dayKey(ts) {
  return new Date(ts - DAY_START_OFFSET_MS).toISOString().slice(0, 10);
}

const isNonNegNum = v => v !== null && v !== undefined && typeof v !== 'boolean' &&
  !(typeof v === 'string' && v.trim() === '') && Number.isFinite(Number(v)) && Number(v) >= 0;

/**
 * Deribit book summary 行 -> 快照 { ts, index, oi: { name: [openInterest, volume24h] } }
 * 只保留 OI 或成交量非零的合约。OI 数据不能 missing silently 0：任一行的
 * open_interest / volume 缺失或非有限值即整个快照校验失败。
 */
function snapshotFromBookSummary(rows, ts = Date.now()) {
  const oi = {};
  let index = null;
  for (const r of rows || []) {
    const name = r && r.instrument_name;
    if (typeof name !== 'string' || !name) throw new Error('OI snapshot: instrument_name 非法');
    if (!isNonNegNum(r.open_interest)) throw new Error(`OI snapshot: ${name} open_interest 非法 ${JSON.stringify(r.open_interest)}`);
    if (!isNonNegNum(r.volume)) throw new Error(`OI snapshot: ${name} volume 非法 ${JSON.stringify(r.volume)}`);
    const openInterest = Number(r.open_interest);
    const volume = Number(r.volume);
    if (openInterest <= 0 && volume <= 0) continue;
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
    ...(Number.isFinite(s.winFrom) ? { winFrom: s.winFrom } : {}),
    rows: Object.entries(s.oi).map(([name, [openInterest, volume, winVolume]]) => {
      if (!idOf.has(name)) {
        idOf.set(name, instruments.length);
        instruments.push(name);
      }
      return Number.isFinite(winVolume)
        ? [idOf.get(name), openInterest, volume, winVolume]
        : [idOf.get(name), openInterest, volume];
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
      for (const [i, openInterest, volume, winVolume] of s.rows) {
        const name = json.instruments[i];
        if (!name) continue;
        oi[name] = Number.isFinite(winVolume)
          ? [Number(openInterest) || 0, Number(volume) || 0, Number(winVolume)]
          : [Number(openInterest) || 0, Number(volume) || 0];
      }
      const out = { ts: s.ts, index: s.index ?? null, oi };
      if (Number.isFinite(s.winFrom)) out.winFrom = s.winFrom;
      return out;
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
  atomicWriteJson(file, encodeHistory(snapshots, currency), 0);
}

/**
 * 窗口 (s0, s1] 内该合约可能影响 OI 变化的成交量 (含 s0 前 OI_LAG_MS 的滞后段)：
 *  - exact：窗口经过的每一段相邻快照都记录了逐笔汇总的精确量 (第 3 列，口径为 (前一快照 − 滞后, 本快照])；
 *    跨多段时相加，滞后段会重叠计入，只会偏大 —— 区间推导依旧保守成立
 *  - upper：窗口 ≤ 20h 时终点快照的滚动 24h 成交量覆盖整个 (s0 − 滞后, s1]，是上界，区间仍成立 (只是更宽)
 *  - approx：其余情况只能给点估计，不能给确证
 */
function windowVolume(snapshots, i0, i1, instrument) {
  const s0 = snapshots[i0];
  const s1 = snapshots[i1];
  const row = s1.oi[instrument];
  if (!row) return null;
  let exact = 0;
  let hasExact = true;
  for (let k = i0 + 1; k <= i1; k++) {
    const sk = snapshots[k];
    const r = sk.oi[instrument];
    if (sk.winFrom !== snapshots[k - 1].ts) { hasExact = false; break; }
    // 中间快照里没有该合约 (OI 与成交都为 0) 时该段成交量为 0
    if (r && Number.isFinite(r[2])) exact += r[2];
    else if (r) { hasExact = false; break; }
  }
  if (hasExact) return { volume: exact, kind: 'exact' };
  return { volume: row[1], kind: s1.ts - s0.ts <= UPPER_WINDOW_MS ? 'upper' : 'approx' };
}

/**
 * 单个合约在时刻 ts 附近的开平仓估计。
 * 窗口起点 = 成交前最后一次快照；终点 = 成交后至少 OI_LAG_MS 的第一次快照 (OI 滞后，太近的快照还没反映这笔成交)。
 * @returns {{status: 'opening'|'closing'|'mixed'|'pending'|'unknown', openShare?: number, deltaOI?: number,
 *   volume?: number, volumeKind?: string, windowStart?: number, windowEnd?: number, provisional?: boolean}}
 */
function classifyTrade(snapshots, instrument, ts, expiryMs = null) {
  if (!snapshots || !snapshots.length) return { status: 'unknown' };
  const firstAfter = target => {
    let lo = 0;
    let hi = snapshots.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (snapshots[mid].ts > target) hi = mid; else lo = mid + 1;
    }
    return lo;
  };
  const i0 = firstAfter(ts) - 1;
  const i1 = firstAfter(ts + OI_LAG_MS - 1);
  const s1 = snapshots[i1];
  if (!s1) {
    // 合约已在下一次可用快照前交割：OI 归零，无法判断
    if (expiryMs && expiryMs <= Date.now()) return { status: 'unknown' };
    return { status: 'pending' };
  }
  if (i0 < 0) return { status: 'unknown' };
  const s0 = snapshots[i0];
  if (expiryMs && expiryMs <= s1.ts) return { status: 'unknown' };

  const wv = windowVolume(snapshots, i0, i1, instrument);
  if (!wv || !(wv.volume > 0)) return { status: 'unknown' };
  if (s1.ts - s0.ts > (wv.kind === 'exact' ? MAX_EXACT_WINDOW_MS : MAX_WINDOW_MS)) return { status: 'unknown' };
  const [oi0] = s0.oi[instrument] || [0, 0];
  const deltaOI = s1.oi[instrument][0] - oi0;

  const openShare = Math.min(1, Math.max(0, (wv.volume + deltaOI) / (2 * wv.volume)));
  return {
    status: statusOf(openShare),
    openShare,
    deltaOI,
    volume: wv.volume,
    volumeKind: wv.kind,
    windowStart: s0.ts,
    windowEnd: s1.ts,
    provisional: Boolean(s1.provisional)
  };
}

function statusOf(openShare) {
  if (openShare >= OPENING_MIN) return 'opening';
  if (openShare <= CLOSING_MAX) return 'closing';
  return 'mixed';
}

/**
 * 本单在窗口内的开仓占比区间 (不假设「无换手」，严格成立)：
 *   本单量 B 对 OI 的贡献 c ∈ [−B, B]；窗口内其余成交量 V−B 对 OI 的贡献同样不超过其量，
 *   故 c ∈ [ΔOI − (V−B), ΔOI + (V−B)]。开仓占比 = (B + c) / 2B。
 *   V 取 max(V, B, |ΔOI|)：24h 量偶有小于本单或 |ΔOI| 的口径错位时放宽，保证区间仍然保守。
 */
function shareBounds(B, deltaOI, volume) {
  const V = Math.max(volume, B, Math.abs(deltaOI));
  const rest = V - B;
  const cLo = Math.max(-B, deltaOI - rest);
  const cHi = Math.min(B, deltaOI + rest);
  return { lo: (B + cLo) / (2 * B), hi: (B + cHi) / (2 * B), dominance: B / V };
}

/** 汇总一组 (合约×窗口) 的估计：点估计、区间 (approx 口径不给区间)、本单占窗口成交的比例 */
function summarizeGroups(groups) {
  let known = 0;
  let point = 0;
  let lo = 0;
  let hi = 0;
  let volSum = 0;
  let boundsValid = true;
  let provisional = false;
  for (const g of groups) {
    known += g.amount;
    point += g.openShare * g.amount;
    lo += g.lo * g.amount;
    hi += g.hi * g.amount;
    volSum += g.amount / g.dominance;
    if (g.volumeKind === 'approx') boundsValid = false;
    if (g.provisional) provisional = true;
  }
  if (!known) return null;
  const openShare = point / known;
  const openLo = lo / known;
  const openHi = hi / known;
  const status = statusOf(openShare);
  const confirmed = boundsValid && ((status === 'opening' && openLo >= OPENING_MIN) || (status === 'closing' && openHi <= CLOSING_MAX));
  return {
    status,
    openShare,
    openLo: boundsValid ? openLo : null,
    openHi: boundsValid ? openHi : null,
    confidence: confirmed ? 'confirmed' : 'leaning',
    // 只有 24h 成交量且窗口更长 (approx) 时窗口成交量未知，本单占比无意义
    dominance: boundsValid ? Math.min(1, known / volSum) : null,
    provisional,
    amount: known
  };
}

/**
 * 多腿 / 多笔聚合 (按张数加权)。
 * 同一合约同一窗口内的多笔 (冰山子单) 先合并为一个 B 再求区间 —— 合并后本单占窗口成交的比例更高，区间更窄。
 * 多腿结构额外给出逐腿结果与结构判读：跨到期的「近平远开 / 远平近开」识别为展期，腿间开平相反识别为分化。
 * @param {Array<{instrument: string, ts: number, amount: number, expiryMs?: number}>} items
 */
function profileFromItems(snapshots, items) {
  let total = 0;
  let pending = 0;
  const groups = new Map(); // instrument|windowEnd -> group
  for (const it of items || []) {
    const amt = Number(it.amount) || 0;
    if (amt <= 0) continue;
    total += amt;
    const c = classifyTrade(snapshots, it.instrument, it.ts, it.expiryMs);
    if (c.status === 'pending') pending += amt;
    if (c.openShare === undefined) continue;
    const key = `${it.instrument}|${c.windowStart}|${c.windowEnd}`;
    if (!groups.has(key)) {
      groups.set(key, {
        instrument: it.instrument,
        expiryMs: Number.isFinite(it.expiryMs) ? it.expiryMs : null,
        amount: 0,
        deltaOI: c.deltaOI,
        volume: c.volume,
        openShare: c.openShare,
        volumeKind: c.volumeKind,
        provisional: c.provisional
      });
    }
    groups.get(key).amount += amt;
  }
  if (!total) return { status: 'unknown', coverage: 0 };
  const all = [...groups.values()];
  for (const g of all) Object.assign(g, shareBounds(g.amount, g.deltaOI, g.volume));
  const coverage = all.reduce((s, g) => s + g.amount, 0) / total;
  if (coverage < 0.5) {
    return { status: pending / total >= 0.5 ? 'pending' : 'unknown', coverage };
  }

  const { amount: _a, ...overall } = summarizeGroups(all);

  // 逐腿 (同一合约跨窗口的组合并)
  const byInst = new Map();
  for (const g of all) {
    if (!byInst.has(g.instrument)) byInst.set(g.instrument, []);
    byInst.get(g.instrument).push(g);
  }
  const legs = [...byInst.entries()].map(([instrument, gs]) => {
    const { amount: _b, ...s } = summarizeGroups(gs);
    return { instrument, ...s };
  });

  let structure = null;
  if (legs.length >= 2) {
    const expiries = [...new Set(all.map(g => g.expiryMs).filter(Number.isFinite))].sort((a, b) => a - b);
    if (expiries.length >= 2) {
      const near = summarizeGroups(all.filter(g => g.expiryMs === expiries[0]));
      const far = summarizeGroups(all.filter(g => g.expiryMs !== expiries[0]));
      if (near && far && ((near.status === 'closing' && far.status === 'opening') || (near.status === 'opening' && far.status === 'closing'))) {
        structure = {
          kind: 'roll',
          text: near.status === 'closing' ? '近月平仓 / 远月开仓' : '远月平仓 / 近月开仓',
          confidence: near.confidence === 'confirmed' && far.confidence === 'confirmed' ? 'confirmed' : 'leaning'
        };
      }
    }
    if (!structure) {
      const opens = legs.filter(l => l.status === 'opening');
      const closes = legs.filter(l => l.status === 'closing');
      if (opens.length && closes.length) {
        structure = {
          kind: 'split',
          text: `${opens.length} 腿开仓 / ${closes.length} 腿平仓`,
          confidence: [...opens, ...closes].every(l => l.confidence === 'confirmed') ? 'confirmed' : 'leaning'
        };
      }
    }
  }

  const out = { ...overall, coverage, legs };
  if (structure) {
    out.structure = structure;
    out.status = structure.kind; // 'roll' | 'split'
    out.confidence = structure.confidence;
  }
  return out;
}

// ---- 精确窗口成交量 (逐笔成交汇总) 与盘中初判 ----

const BACKFILL_SETTLE_MS = 2 * HOUR_MS;   // 快照后至少等 2h 再汇总：history 接口的逐笔成交可能略有滞后
const PROVISIONAL_MIN_MS = 30 * 60 * 1000; // 距上次快照不足 30 分钟时不做盘中初判 (OI 变化太小，意义不大)

/**
 * 汇总 (fromTs, toTs] 内每个合约的成交量 (张数，单边计，与 book summary 的 volume 同口径)。
 * 分页方式与 option_flow_ledger.syncLedger 相同：下一页从本页最后一笔的毫秒重新取，按 trade_id 去重。
 * @param {Function} fetchPage - (currency, startTs, endTs) => {trades, hasMore}
 */
async function windowVolumesFromTape(fetchPage, { currency = 'BTC', fromTs, toTs, sleepMs = 120, maxPages = 400 } = {}) {
  const volumes = {};
  const seen = new Set();
  let cursor = fromTs;
  let pages = 0;
  for (;;) {
    if (pages >= maxPages) throw new Error(`逐笔成交超过 ${maxPages} 页，放弃本窗口`);
    const { trades, hasMore } = await fetchPage(currency, cursor, toTs);
    pages++;
    for (const t of trades || []) {
      const ts = Number(t.timestamp);
      if (!(ts > fromTs && ts <= toTs)) continue;
      const id = String(t.trade_id);
      if (seen.has(id)) continue;
      seen.add(id);
      const amt = Number(t.amount);
      if (t.instrument_name && amt > 0) volumes[t.instrument_name] = (volumes[t.instrument_name] || 0) + amt;
    }
    if (!hasMore || !trades || !trades.length) break;
    const lastTs = Number(trades[trades.length - 1].timestamp);
    if (!(lastTs > cursor)) throw new Error('Trade pagination stalled within one millisecond; completeness cannot be verified');
    cursor = lastTs;
    if (sleepMs) await new Promise(r => setTimeout(r, sleepMs));
  }
  return { volumes, pages, trades: seen.size };
}

/** 给快照 s1 写入相对上一快照 (winFrom = 上一快照 ts) 的精确窗口成交量 (第 3 列，口径为 (上一快照 − OI_LAG_MS, s1]) */
function attachWindowVolume(s1, fromTs, volumes) {
  const oi = {};
  for (const [name, row] of Object.entries(s1.oi)) {
    oi[name] = [row[0], row[1], Math.round((volumes[name] || 0) * 10) / 10];
  }
  return { ...s1, winFrom: fromTs, oi };
}

/**
 * 粗校验：逐笔汇总的总量至少应有 24h 成交量合计的一半 (按窗口长度折算，最多折到 24h)，
 * 防止 history 接口截断或滞后时写入偏小的成交量 —— 偏小的 V 会让区间过窄、错误地「确证」。
 */
function plausibleWindowVolume(s0, s1, volumes) {
  let tape = 0;
  let rolling = 0;
  for (const [name, row] of Object.entries(s1.oi)) {
    tape += volumes[name] || 0;
    rolling += row[1] || 0;
  }
  if (rolling <= 0) return true;
  const expected = rolling * Math.min(1, (s1.ts - s0.ts) / DAY_MS);
  return tape >= 0.5 * expected;
}

/**
 * 为缺少精确窗口成交量的快照补算 (从最新往回，每次最多 maxWindows 个窗口；原地替换数组元素)。
 * @returns {Promise<{filled: number, errors: string[]}>}
 */
async function backfillWindowVolumes(snapshots, { fetchPage, now = Date.now(), maxWindows = 40, sleepMs = 120, log = null } = {}) {
  let filled = 0;
  const errors = [];
  for (let i = snapshots.length - 1; i >= 1 && filled < maxWindows; i--) {
    const s0 = snapshots[i - 1];
    const s1 = snapshots[i];
    if (s1.winFrom === s0.ts) continue;
    if (now - s1.ts < BACKFILL_SETTLE_MS) continue;
    if (s1.ts - s0.ts > MAX_EXACT_WINDOW_MS) continue;
    try {
      // 起点前移 OI_LAG_MS：s0 的 OI 可能还没反映这段成交 (见 OI_LAG_MS)
      const r = await windowVolumesFromTape(fetchPage, { fromTs: s0.ts - OI_LAG_MS, toTs: s1.ts, sleepMs });
      if (!plausibleWindowVolume(s0, s1, r.volumes)) throw new Error(`逐笔汇总量明显偏小 (${r.trades} 笔)，疑似接口截断`);
      snapshots[i] = attachWindowVolume(s1, s0.ts, r.volumes);
      filled++;
      if (log) log(`${dayKey(s1.ts)}: ${r.trades} trades / ${r.pages} pages`);
    } catch (err) {
      errors.push(`${dayKey(s1.ts)}: ${err.message}`);
    }
  }
  return { filled, errors };
}

/**
 * 盘中初判：把实时 book summary (option_marks 30s 缓存) 当作一份临时快照接在序列末尾。
 * 只在距上次快照 30 分钟 ~ 20 小时之间使用 —— 此时滚动 24h 成交量覆盖 (上次快照 − OI 滞后, 现在]，是窗口成交量的上界，
 * 区间推导依旧成立；更久时不接 (上界不再成立)。OI 滞后的缘故，只有早于现在 OI_LAG_MS 的成交会用它判读，更近的仍显示待确认。
 * 临时快照不落盘，只用于 Module 4 的卡片判读。
 */
function withProvisionalSnapshot(snapshots, marksSnapshot, now = Date.now()) {
  if (!Array.isArray(snapshots) || !snapshots.length || !marksSnapshot || !marksSnapshot.marks) return snapshots;
  const last = snapshots[snapshots.length - 1];
  const ts = Number(marksSnapshot.timestamp) || now;
  if (ts - last.ts < PROVISIONAL_MIN_MS || ts - last.ts > UPPER_WINDOW_MS) return snapshots;
  const oi = {};
  for (const [name, m] of Object.entries(marksSnapshot.marks)) {
    if (!m || !Number.isFinite(m.volume24h) || !Number.isFinite(m.openInterest)) return snapshots;
    if (m.openInterest > 0 || m.volume24h > 0) oi[name] = [m.openInterest, m.volume24h];
  }
  if (!Object.keys(oi).length) return snapshots;
  return [...snapshots, { ts, index: marksSnapshot.indexPrice ?? null, oi, provisional: true }];
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

/** Remote archive is fully schema-validated before it may replace
 * remoteCache: nonempty instrument names; each snapshot ts > 0, not future;
 * index finite-positive when present; every [id, oi, volume] row references
 * a valid instrument with finite oi/volume >= 0. */
function validRemoteArchive(json) {
  if (!json || !Array.isArray(json.instruments) || !Array.isArray(json.snapshots) || !json.snapshots.length) return false;
  if (json.instruments.some(n => typeof n !== 'string' || !n)) return false;
  const nowMs = Date.now();
  return json.snapshots.every(s => {
    if (!s || !Number.isFinite(s.ts) || s.ts <= 0 || s.ts > nowMs + 5 * 60000) return false;
    if (s.index !== null && s.index !== undefined && !(Number.isFinite(Number(s.index)) && Number(s.index) > 0)) return false;
    if (!Array.isArray(s.rows)) return false;
    return s.rows.every(row =>
      Array.isArray(row) && row.length >= 3 &&
      Number.isInteger(row[0]) && row[0] >= 0 && row[0] < json.instruments.length &&
      isNonNegNum(row[1]) && isNonNegNum(row[2])
    );
  });
}

async function readRemote(now) {
  if (remoteCache.snapshots && now - remoteCache.at < REMOTE_TTL_MS) return remoteCache.snapshots;
  recordAttempt('oi_history', { now: Date.now() });
  try {
    const resp = await fetchWithTimeout(REMOTE_URL, { headers: { Accept: 'application/json' }, timeout: 8000, retries: 0 });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (!validRemoteArchive(json)) throw new Error('remote OI archive 校验失败');
    const decoded = decodeHistory(json);
    // Artifact's own max snapshot ts is the data clock — never reader now.
    // recordSuccess BEFORE cache assignment: a throw must not leave a
    // polluted remoteCache behind.
    recordSuccess('oi_history', {
      dataAsOf: new Date(decoded[decoded.length - 1].ts).toISOString(),
      asOfKind: 'source', source: 'github-archive'
    });
    remoteCache = { snapshots: decoded, at: now };
  } catch (err) {
    recordFailure('oi_history', err);
    // 尚未推送或网络不可达：沿用上次结果，下次再试
    remoteCache = { snapshots: remoteCache.snapshots || [], at: now };
  }
  return remoteCache.snapshots;
}

/** Seed honest disk clocks once — committed/local files carry no success
 * receipt, so the merged archive seeds UNKNOWN until a real fetch verifies. */
let diskSeeded = false;
function seedDiskOnce(snapshots) {
  if (diskSeeded || !snapshots.length) return;
  diskSeeded = true;
  seedCachedHealth({ dataHealth: null }, 'oi_history', {
    dataAsOf: new Date(snapshots[snapshots.length - 1].ts).toISOString(),
    lastSuccessAt: null
  });
}

/** 合并后的快照序列：仓库提交版 > GitHub raw 最新版 > 本机补采 */
async function getMergedHistory(now = Date.now()) {
  if (localSnapshots === null) localSnapshots = readHistoryFile(LOCAL_FILE);
  const committed = readCommittedFromDisk();
  // Seed disk clocks BEFORE the remote attempt: a failure recorded first would
  // otherwise block the seed (seedSource never overwrites an existing record).
  seedDiskOnce(pruneHistory(mergeSnapshotSets(committed, localSnapshots), now));
  const remote = await readRemote(now);
  return pruneHistory(mergeSnapshotSets(mergeSnapshotSets(committed, remote), localSnapshots), now);
}

/**
 * 当天还没有快照时由服务器补采一份 (不阻塞请求；失败 10 分钟后再试)。
 * @param {Function} fetchRows - async () => Deribit book summary rows
 */
function maybeRecordLiveSnapshot(merged, fetchRows, now = Date.now()) {
  if (hasSnapshotForDay(merged, now) || liveInflight || now - lastLiveAttempt < LIVE_RETRY_MS) return liveInflight;
  lastLiveAttempt = now;
  recordAttempt('oi_history', { now: Date.now() });
  liveInflight = (async () => {
    try {
      const snap = snapshotFromBookSummary(await fetchRows(), Date.now());
      if (!snap) return;
      // A live local snapshot is a real acquisition; its ts is the data
      // clock. recordSuccess BEFORE mutating/writing — invalid data must
      // never become fallback data.
      recordSuccess('oi_history', {
        dataAsOf: new Date(snap.ts).toISOString(), asOfKind: 'received', source: 'deribit/book_summary'
      });
      if (localSnapshots === null) localSnapshots = readHistoryFile(LOCAL_FILE);
      localSnapshots = pruneHistory(mergeSnapshotSets(localSnapshots, [snap]), snap.ts);
      writeHistoryFile(LOCAL_FILE, localSnapshots);
      console.log(`[OptionOI] recorded live snapshot for ${dayKey(snap.ts)} (${Object.keys(snap.oi).length} instruments)`);
    } catch (err) {
      recordFailure('oi_history', err);
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
  OI_LAG_MS,
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
  shareBounds,
  profileFromItems,
  windowVolumesFromTape,
  attachWindowVolume,
  plausibleWindowVolume,
  backfillWindowVolumes,
  withProvisionalSnapshot,
  getMergedHistory,
  maybeRecordLiveSnapshot
};
