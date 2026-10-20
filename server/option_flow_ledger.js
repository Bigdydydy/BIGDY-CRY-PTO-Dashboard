/**
 * Deribit 期权全成交累计净额台账 —— 做市商持仓符号的订单流校正
 *
 * 每个现存合约从上市起的逐笔成交 (history.deribit.com) 按主动方方向累计，分三类分别记账：
 *   screen  屏幕成交 (撮合簿)
 *   block   大宗成交的腿 (带 block_trade_id)
 *   liq     强平成交 (带 liquidation 标记；被强平方确定是客户)
 * 客户净买入 = 主动方净买入 (假设主动方是客户)；强平按被强平的一方计：
 *   liquidation 'T' 主动方被强平 → 客户方向 = 主动方方向
 *   liquidation 'M' 挂单方被强平 → 客户方向 = 主动方方向的反面
 *   liquidation 'MT' 双方都被强平 → 两边都是客户，对做市商无影响，记 0
 * 从上市累计的净额里开仓与平仓自然抵消，因此不再需要用 OI 变化推断开平仓。
 *
 * 只存按合约汇总的累计量，不存逐笔：
 *   instruments[name] = [screenNet, blockNet, liqNet, screenGross, blockGross, liqGross, trades]
 * 同步游标 lastTradeTs + 该毫秒内已入账的 trade_id (boundaryTradeIds)，增量同步从游标所在毫秒重新取并去重。
 *
 * 档案由 scripts/option_flow_ledger.js 生成 (首次全量回补，之后每日增量)，GitHub Actions 每日提交
 * data/option_flow_ledger_BTC.json；线上实例从 GitHub raw 读取最新提交 (30 分钟缓存)，取不到时读磁盘。
 */

const fs = require('fs');
const path = require('path');
const { fetchWithTimeout } = require('./http_client');
const { recordAttempt, recordSuccess, recordFailure } = require('./data_health');
const { atomicWriteJson } = require('./data_health_cache');

const HISTORY_BASE = 'https://history.deribit.com/api/v2/public';
const LIVE_BASE = 'https://www.deribit.com/api/v2/public';
const PAGE_SIZE = 1000;
const LEDGER_FILE = path.join(__dirname, '..', 'data', 'option_flow_ledger_BTC.json');
const REMOTE_URL = process.env.OPTION_FLOW_LEDGER_URL
  || 'https://raw.githubusercontent.com/Bigdydydy/BIGDY-CRY-PTO-Dashboard/main/data/option_flow_ledger_BTC.json';
const REMOTE_TTL_MS = 30 * 60 * 1000;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// 记账元组下标
const SCREEN_NET = 0;
const BLOCK_NET = 1;
const LIQ_NET = 2;
const SCREEN_GROSS = 3;
const BLOCK_GROSS = 4;
const LIQ_GROSS = 5;
const TRADES = 6;

const round = v => Math.round(v * 1e4) / 1e4;

function emptyLedger(currency = 'BTC') {
  return {
    currency,
    version: 1,
    startTs: null,          // 回补起点 (现存合约中最早的上市时间)
    syncedThrough: null,    // 该时刻之前的成交已全部入账
    lastTradeTs: null,
    boundaryTradeIds: [],
    instruments: {}
  };
}

/** 单笔成交 -> { bucket, customer } (customer 为客户净买入 BTC，正为买)；非法成交返回 null */
function classifyTrade(t) {
  const amount = Number(t?.amount);
  if (!t || typeof t.instrument_name !== 'string' || !(amount > 0)) return null;
  if (t.direction !== 'buy' && t.direction !== 'sell') return null;
  const taker = t.direction === 'buy' ? amount : -amount;
  if (t.liquidation) {
    const liq = String(t.liquidation);
    if (liq === 'T') return { bucket: 'liq', customer: taker, amount };
    if (liq === 'M') return { bucket: 'liq', customer: -taker, amount };
    return { bucket: 'liq', customer: 0, amount }; // 'MT'：双方都是客户
  }
  if (t.block_trade_id) return { bucket: 'block', customer: taker, amount };
  return { bucket: 'screen', customer: taker, amount };
}

/**
 * 把一页成交 (按时间升序) 记入台账。早于游标或游标毫秒内已入账的成交跳过；
 * liveSet 给出时，只为其中的合约记账 (已到期合约与本台账无关)，但游标照常前进。
 */
function applyTrades(ledger, trades, { liveSet = null } = {}) {
  let applied = 0;
  let skipped = 0;
  let lastTs = ledger.lastTradeTs;
  let boundary = new Set(ledger.boundaryTradeIds || []);
  for (const t of trades || []) {
    const ts = Number(t?.timestamp);
    const id = String(t?.trade_id ?? '');
    if (!Number.isFinite(ts)) { skipped++; continue; }
    if (lastTs !== null && (ts < lastTs || (ts === lastTs && boundary.has(id)))) { skipped++; continue; }
    if (lastTs === null || ts > lastTs) {
      lastTs = ts;
      boundary = new Set();
    }
    boundary.add(id);

    const c = classifyTrade(t);
    if (!c) { skipped++; continue; }
    if (liveSet && !liveSet.has(t.instrument_name)) continue;
    const row = ledger.instruments[t.instrument_name] || [0, 0, 0, 0, 0, 0, 0];
    const netIdx = c.bucket === 'screen' ? SCREEN_NET : (c.bucket === 'block' ? BLOCK_NET : LIQ_NET);
    row[netIdx] = round(row[netIdx] + c.customer);
    row[netIdx + 3] = round(row[netIdx + 3] + c.amount);
    row[TRADES] += 1;
    ledger.instruments[t.instrument_name] = row;
    applied++;
  }
  ledger.lastTradeTs = lastTs;
  ledger.boundaryTradeIds = [...boundary];
  return { applied, skipped };
}

function expiryOf(name) {
  const m = /^[A-Z]+-(\d{1,2})([A-Z]{3})(\d{2})-/.exec(name || '');
  if (!m) return null;
  const month = MONTHS.indexOf(m[2]);
  return month < 0 ? null : Date.UTC(2000 + Number(m[3]), month, Number(m[1]), 8, 0, 0);
}

/** 删除已交割合约 */
function pruneExpired(ledger, nowMs = Date.now()) {
  for (const name of Object.keys(ledger.instruments)) {
    const exp = expiryOf(name);
    if (exp !== null && exp <= nowMs) delete ledger.instruments[name];
  }
  return ledger;
}

async function getJson(url) {
  const resp = await fetchWithTimeout(url, { timeout: 15000, retries: 2, backoffMs: 1500 });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${url}`);
  const json = await resp.json();
  if (!json || !json.result) throw new Error(`malformed response ${url}`);
  return json.result;
}

async function fetchTradesPage(currency, startTs, endTs) {
  const url = `${HISTORY_BASE}/get_last_trades_by_currency_and_time?currency=${currency}&kind=option&start_timestamp=${startTs}&end_timestamp=${endTs}&count=${PAGE_SIZE}&sorting=asc`;
  const result = await getJson(url);
  return { trades: Array.isArray(result.trades) ? result.trades : [], hasMore: Boolean(result.has_more) };
}

/** 现存期权合约名单与其中最早的上市时间 */
async function fetchLiveInstruments(currency = 'BTC') {
  const list = await getJson(`${LIVE_BASE}/get_instruments?currency=${currency}&kind=option&expired=false`);
  const names = new Set();
  let earliest = Infinity;
  for (const i of list) {
    if (!i?.instrument_name) continue;
    names.add(i.instrument_name);
    if (Number(i.creation_timestamp) > 0) earliest = Math.min(earliest, Number(i.creation_timestamp));
  }
  return { names, earliestCreation: Number.isFinite(earliest) ? earliest : null };
}

/**
 * 从游标同步到 endTs。下一页从本页最后一笔的毫秒重新取 (游标内去重)，避免同毫秒成交跨页时丢失。
 * 返回 complete=false 表示触到 maxPages 上限，下次从游标继续。
 */
async function syncLedger(ledger, {
  currency = 'BTC',
  endTs = Date.now(),
  liveSet = null,
  fetchPage = fetchTradesPage,
  sleepMs = 120,
  maxPages = Infinity,
  onPage = null
} = {}) {
  let cursor = ledger.lastTradeTs ?? ledger.startTs;
  if (!Number.isFinite(cursor)) throw new Error('ledger 缺少 startTs / lastTradeTs，无法确定同步起点');
  let pages = 0;
  let applied = 0;
  let complete = false;
  while (pages < maxPages) {
    const { trades, hasMore } = await fetchPage(currency, cursor, endTs);
    pages++;
    const r = applyTrades(ledger, trades, { liveSet });
    applied += r.applied;
    if (onPage) onPage({ pages, applied, cursor, lastTradeTs: ledger.lastTradeTs });
    if (!hasMore || !trades.length) { complete = true; break; }
    const lastTs = Number(trades[trades.length - 1].timestamp);
    // 整页落在同一毫秒 (>1000 笔同毫秒成交) 时只能跳过该毫秒，否则会原地循环
    cursor = lastTs > cursor ? lastTs : cursor + 1;
    if (sleepMs) await new Promise(r => setTimeout(r, sleepMs));
  }
  if (complete) ledger.syncedThrough = endTs;
  return { pages, applied, complete };
}

function validLedger(json) {
  if (!json || typeof json !== 'object' || !json.instruments || typeof json.instruments !== 'object') return false;
  if (json.syncedThrough !== null && !(Number.isFinite(json.syncedThrough) && json.syncedThrough > 0)) return false;
  return Object.entries(json.instruments).every(([name, row]) =>
    typeof name === 'string' && name && Array.isArray(row) && row.length === 7 && row.every(Number.isFinite)
  );
}

function readLedger(file = LEDGER_FILE) {
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    return validLedger(json) ? json : null;
  } catch (err) {
    return null;
  }
}

function writeLedger(file, ledger) {
  atomicWriteJson(file, ledger);
}

let remoteCache = { ledger: null, at: 0 };

/**
 * 服务器读取：优先 GitHub raw 上最新提交的档案 (30 分钟缓存)，失败时读部署时的磁盘文件。
 * 两者都没有时返回 null，敏感性回退到 30 天大宗校正。
 */
async function getLedger({ now = Date.now(), fetcher = fetchWithTimeout, file = LEDGER_FILE } = {}) {
  if (remoteCache.ledger && now - remoteCache.at < REMOTE_TTL_MS) return remoteCache.ledger;
  recordAttempt('option_flow_ledger', { now: Date.now() });
  let ledger = null;
  let source = 'github-archive';
  try {
    const resp = await fetcher(REMOTE_URL, { headers: { Accept: 'application/json' }, timeout: 8000, retries: 0 });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (!validLedger(json)) throw new Error('remote flow ledger 校验失败');
    ledger = json;
  } catch (err) {
    ledger = readLedger(file);
    source = 'disk';
    if (!ledger) recordFailure('option_flow_ledger', err);
  }
  if (ledger) {
    recordSuccess('option_flow_ledger', {
      dataAsOf: ledger.syncedThrough ? new Date(Math.min(ledger.syncedThrough, Date.now())).toISOString() : null,
      asOfKind: 'source',
      source
    });
  }
  remoteCache = { ledger, at: now };
  return ledger;
}

function clearLedgerCache() {
  remoteCache = { ledger: null, at: 0 };
}

/** 客户净买入：大宗 + 强平 + 屏幕 × 折扣系数 (屏幕成交里主动方不是客户的比例更高) */
function customerNet(row, screenWeight = 1) {
  return row[BLOCK_NET] + row[LIQ_NET] + screenWeight * row[SCREEN_NET];
}

module.exports = {
  LEDGER_FILE,
  REMOTE_URL,
  emptyLedger,
  classifyTrade,
  applyTrades,
  pruneExpired,
  expiryOf,
  fetchTradesPage,
  fetchLiveInstruments,
  syncLedger,
  validLedger,
  readLedger,
  writeLedger,
  getLedger,
  clearLedgerCache,
  customerNet
};
