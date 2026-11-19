/**
 * 大宗成交的非期权腿 (期货 / 永续 / 现货对冲腿)
 *
 * 期权大宗经常连同一条期货对冲腿一起成交 (同一个 block_trade_id)：「买 call + 卖期货」是买波动率而不是看涨。
 * Greeks.live 的大宗接口只返回期权腿，这里补齐其余的腿，让 Module 4 / 4B 按含对冲在内的净 Delta 判断方向。
 *
 * 判定依据：Deribit 每条大宗腿都带 block_trade_leg_count (整笔 block 的总腿数)；总腿数多于归档里的期权腿数，
 * 说明还有非期权腿，再按成交时刻到 Deribit 逐笔历史里按 block_trade_id 找回它们。
 * 实测 2026-01~09：5.4% 的 block、≥$30M 大单里 14% 带非期权腿。
 *
 * 文件 data/block_hedges_<CUR>.json：
 *   { currency, version, coveredThrough, blocks: { [blockId]: { ts, legCount, optionLegs, hedges: [...], complete } } }
 *   只记录带非期权腿的 block；coveredThrough 之前的 block 都已核查过 (不在 blocks 里 = 没有对冲腿)。
 * 由采集脚本 (scripts/block_hedges_sync.js，4B 日更) 写入并提交；线上服务器对更新的大单在后台即时查询，写本机 sidecar。
 */

const fs = require('fs');
const path = require('path');
const { fetchWithTimeout } = require('./http_client');
const { atomicWriteJson } = require('./data_health_cache');

const HISTORY_BASE = 'https://history.deribit.com/api/v2/public';
const COMMITTED_FILE = path.join(__dirname, '..', 'data', 'block_hedges_BTC.json');
const LOCAL_FILE = path.join(__dirname, '..', 'data', 'block_hedges_BTC.local.json');
const REMOTE_URL = process.env.BLOCK_HEDGES_URL
  || 'https://raw.githubusercontent.com/Bigdydydy/BIGDY-CRY-PTO-Dashboard/main/data/block_hedges_BTC.json';
const REMOTE_TTL_MS = 30 * 60 * 1000;
const LEG_WINDOW_MS = 2000;       // 同一 block 的各腿成交时刻相同；前后各留 2 秒余量
const DELTA_HEDGED_SHARE = 0.65;  // 对冲抵消期权 Delta 至少 65% 视为 Delta 对冲的波动率交易

const isOptionName = name => /-\d+-[CP]$/.test(String(name || ''));
/** USDC / USDT 线性合约与现货：amount 以 BTC 计；BTC-PERPETUAL、BTC-27DEC26 等反向合约：amount 以美元计 */
const isLinear = name => /_(USDC|USDT)/.test(String(name || ''));

/** 一条非期权腿的 Delta (BTC，按美元盈亏口径) */
function hedgeDeltaBTC(h) {
  const sign = h.direction === 'buy' ? 1 : -1;
  const amount = Number(h.amount) || 0;
  if (isLinear(h.instrument)) return sign * amount;
  const price = Number(h.price) || Number(h.index_price) || 0;
  return price > 0 ? sign * amount / price : 0;
}

/** 一组对冲腿的合计 Delta (BTC) */
function hedgeDeltaOf(entry) {
  return (entry?.hedges || []).reduce((s, h) => s + hedgeDeltaBTC(h), 0);
}

function emptySet(currency = 'BTC') {
  return { currency, version: 1, coveredThrough: null, blocks: {} };
}

function validSet(j) {
  return Boolean(j && typeof j === 'object' && j.blocks && typeof j.blocks === 'object');
}

function readSet(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return validSet(j) ? j : emptySet();
  } catch (err) {
    return emptySet();
  }
}

function writeSet(file, set) {
  const blocks = Object.fromEntries(Object.entries(set.blocks).sort((a, b) => (a[1].ts - b[1].ts) || a[0].localeCompare(b[0])));
  atomicWriteJson(file, { ...set, blocks }, 0);
}

/** 合并：同一 block 以 complete 的版本优先；coveredThrough 取较大者 (各自都核查到了那里) */
function mergeSets(a, b) {
  const out = emptySet(a?.currency || b?.currency || 'BTC');
  out.coveredThrough = Math.max(Number(a?.coveredThrough) || 0, Number(b?.coveredThrough) || 0) || null;
  for (const src of [a, b]) {
    for (const [id, e] of Object.entries(src?.blocks || {})) {
      const prev = out.blocks[id];
      if (!prev || (!prev.complete && e.complete)) out.blocks[id] = e;
    }
  }
  if (a?.checked || b?.checked) out.checked = { ...(a?.checked || {}), ...(b?.checked || {}) };
  return out;
}

async function getJson(url, fetcher = fetchWithTimeout) {
  const resp = await fetcher(url, { timeout: 15000, retries: 2, backoffMs: 1500 });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = await resp.json();
  if (!json || !json.result) throw new Error('malformed response');
  return json.result;
}

/**
 * 取一个 block 的全部腿 (BTC 与 USDC 两个币种的所有品种)。
 * @returns {{legCount: number|null, legs: Array}}
 */
async function fetchBlockLegs(blockId, ts, { fetcher = fetchWithTimeout } = {}) {
  const legs = new Map();
  let legCount = null;
  for (const currency of ['BTC', 'USDC']) {
    let start = ts - LEG_WINDOW_MS;
    const end = ts + LEG_WINDOW_MS;
    for (let page = 0; page < 20; page++) {
      const r = await getJson(`${HISTORY_BASE}/get_last_trades_by_currency_and_time?currency=${currency}&kind=any&start_timestamp=${start}&end_timestamp=${end}&count=1000&sorting=asc`, fetcher);
      const trades = Array.isArray(r.trades) ? r.trades : [];
      for (const t of trades) {
        if (t.block_trade_id !== blockId) continue;
        legs.set(String(t.trade_id), t);
        if (Number(t.block_trade_leg_count) > 0) legCount = Number(t.block_trade_leg_count);
      }
      if (!r.has_more || !trades.length) break;
      const last = Number(trades[trades.length - 1].timestamp);
      start = last > start ? last : start + 1;
    }
  }
  return { legCount, legs: [...legs.values()] };
}

/** fetchBlockLegs 的结果 -> 文件条目 (没有非期权腿时返回 null) */
function entryFromLegs(ts, { legCount, legs }) {
  const optionLegs = legs.filter(l => isOptionName(l.instrument_name)).length;
  const hedges = legs.filter(l => !isOptionName(l.instrument_name)).map(l => ({
    instrument: l.instrument_name,
    direction: l.direction,
    amount: Number(l.amount),
    price: Number(l.price),
    index_price: Number(l.index_price) || null,
    trade_id: String(l.trade_id)
  }));
  if (!hedges.length && !(legCount > optionLegs)) return null;
  return {
    ts,
    legCount,
    optionLegs,
    hedges,
    // 找到的腿数与 Deribit 标注的总腿数一致才算完整 (否则可能有腿在别的币种 / 品种)
    complete: legCount != null && legs.length >= legCount
  };
}

// ---- 线上读取：提交版 + GitHub raw (30 分钟缓存) + 本机 sidecar ----

let remoteCache = { at: 0, set: null };
let localSet = null;

async function readRemote(now = Date.now(), fetcher = fetchWithTimeout) {
  if (remoteCache.set && now - remoteCache.at < REMOTE_TTL_MS) return remoteCache.set;
  try {
    const resp = await fetcher(REMOTE_URL, { timeout: 8000 });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const j = await resp.json();
    if (!validSet(j)) throw new Error('invalid hedge archive');
    remoteCache = { at: now, set: j };
  } catch (err) {
    remoteCache = { at: now, set: remoteCache.set || emptySet() };
  }
  return remoteCache.set;
}

async function getMergedHedges(now = Date.now()) {
  if (localSet === null) localSet = readSet(LOCAL_FILE);
  const committed = readSet(COMMITTED_FILE);
  const remote = await readRemote(now);
  return mergeSets(mergeSets(committed, remote), localSet);
}

let liveInflight = null;

/**
 * 线上服务器：coveredThrough 之后、还没核查过的大单，在后台逐个查询 (每轮最多 maxFetch 个)，结果写本机 sidecar。
 * 没有非期权腿的 block 也记进 sidecar 的 checked，避免反复查询。
 * @param {Array<{blockId: string, ts: number}>} candidates
 */
function maybeFetchLiveHedges(merged, candidates, { maxFetch = 15, fetcher = fetchWithTimeout } = {}) {
  if (liveInflight) return liveInflight;
  const covered = Number(merged?.coveredThrough) || 0;
  const checked = merged?.checked || {};
  const todo = (candidates || [])
    .filter(c => c && c.blockId && c.ts > covered && !merged.blocks[c.blockId] && !checked[c.blockId])
    .sort((a, b) => b.ts - a.ts)
    .slice(0, maxFetch);
  if (!todo.length) return null;
  liveInflight = (async () => {
    if (localSet === null) localSet = readSet(LOCAL_FILE);
    let changed = false;
    for (const c of todo) {
      try {
        const r = await fetchBlockLegs(c.blockId, c.ts, { fetcher });
        if (!r.legs.length) continue; // history 接口还没收录：下一轮再查
        const e = entryFromLegs(c.ts, r);
        if (e) localSet.blocks[c.blockId] = e;
        localSet.checked = { ...(localSet.checked || {}), [c.blockId]: r.legCount || r.legs.length };
        changed = true;
      } catch (err) {
        console.warn(`[BlockHedges] live lookup ${c.blockId} failed:`, err.message);
      }
    }
    if (changed) {
      try { writeSet(LOCAL_FILE, localSet); } catch (err) { console.warn('[BlockHedges] sidecar write failed:', err.message); }
    }
  })().finally(() => { liveInflight = null; });
  return liveInflight;
}

module.exports = {
  COMMITTED_FILE,
  LOCAL_FILE,
  DELTA_HEDGED_SHARE,
  isOptionName,
  isLinear,
  hedgeDeltaBTC,
  hedgeDeltaOf,
  emptySet,
  readSet,
  writeSet,
  mergeSets,
  fetchBlockLegs,
  entryFromLegs,
  getMergedHedges,
  maybeFetchLiveHedges
};
