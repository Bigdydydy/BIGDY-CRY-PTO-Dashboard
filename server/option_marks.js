/**
 * Deribit live option marks (mark IV / mark price / expiry forward) for the Module 4 PV view.
 * One public book-summary call covers every option of a currency; it is cached briefly and shared
 * across concurrent requests. If a refresh fails, the last good snapshot is served as stale.
 */
const { fetchWithTimeout } = require('./http_client');
const { recordAttempt, recordSuccess, recordFailure } = require('./data_health');
const { withDataHealth } = require('./data_health_cache');

const TTL_MS = 30 * 1000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const cache = new Map(); // currency -> { ts, snapshot, inflight }

const isNonNegNum = v => v !== null && v !== undefined && typeof v !== 'boolean' &&
  !(typeof v === 'string' && v.trim() === '') && Number.isFinite(Number(v)) && Number(v) >= 0;
const isPosNum = v => isNonNegNum(v) && Number(v) > 0;

/**
 * Raw book-summary schema: nonempty array; every row has a valid instrument
 * name; mark_price/open_interest >= 0 when present; index/underlying price
 * fields > 0 when present. A row with mark_iv > 0 is an ACTIVE option quote
 * and must carry a finite mark_price >= 0 plus a positive forward
 * (underlying_price or estimated_delivery_price) — never defaulted to 0.
 */
function validateBookSummaryRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return 'book summary 为空';
  for (const r of rows) {
    if (!r || typeof r !== 'object') return '行非对象';
    if (typeof r.instrument_name !== 'string' || !r.instrument_name) return 'instrument_name 非法';
    if (r.mark_price !== undefined && r.mark_price !== null && !isNonNegNum(r.mark_price)) return 'mark_price <0 或非法';
    if (r.open_interest !== undefined && r.open_interest !== null && !isNonNegNum(r.open_interest)) return 'open_interest <0 或非法';
    for (const k of ['estimated_delivery_price', 'underlying_price', 'index_price']) {
      if (r[k] !== undefined && r[k] !== null && !isPosNum(r[k])) return `${k} 非正值`;
    }
    if (Number(r.mark_iv) > 0) {
      if (!isNonNegNum(r.mark_price)) return `${r.instrument_name}: mark_iv>0 但 mark_price 缺失/非法`;
      if (!isPosNum(r.underlying_price) && !isPosNum(r.estimated_delivery_price)) {
        return `${r.instrument_name}: mark_iv>0 但 underlying/estimated_delivery_price 缺失/非法`;
      }
    }
  }
  return null;
}

/**
 * Accepted snapshot schema — used for fetched AND injected snapshots.
 * A future/NaN timestamp or a mark with non-finite prices must never be
 * written into the cache where it would become "last good" fallback data.
 */
function validateMarkSnapshot(snapshot, nowMs) {
  if (!snapshot || typeof snapshot !== 'object') return 'snapshot 非对象';
  if (!Number.isFinite(Number(snapshot.timestamp)) || Number(snapshot.timestamp) <= 0) return 'snapshot.timestamp 非法';
  if (Number(snapshot.timestamp) > nowMs + 5 * 60000) return 'snapshot.timestamp 在未来';
  if (!snapshot.marks || typeof snapshot.marks !== 'object' || !Object.keys(snapshot.marks).length) return 'marks 为空';
  for (const [name, m] of Object.entries(snapshot.marks)) {
    if (!m || typeof m !== 'object') return `marks.${name} 非对象`;
    if (!isPosNum(m.markIv)) return `marks.${name}.markIv 非法`;
    if (!isNonNegNum(m.markPrice)) return `marks.${name}.markPrice 非法`;
    if (!isPosNum(m.underlyingPrice)) return `marks.${name}.underlyingPrice 非法`;
  }
  if (snapshot.indexPrice !== null && snapshot.indexPrice !== undefined && !isPosNum(snapshot.indexPrice)) {
    return 'indexPrice 非法';
  }
  return null;
}

/**
 * Reduce Deribit `get_book_summary_by_currency?kind=option` rows to what the PV engine needs.
 * @param {Array} rows
 * @returns {{indexPrice: number|null, marks: Object<string, {markIv: number, markPrice: number, underlyingPrice: number, openInterest: number}>}}
 */
function compactBookSummary(rows) {
  const marks = {};
  let indexPrice = null;
  (rows || []).forEach(r => {
    if (!r || !r.instrument_name || !(Number(r.mark_iv) > 0)) return;
    // Validation already guarantees these fields exist and are numeric —
    // missing prices must never be compacted into a default 0.
    marks[r.instrument_name] = {
      markIv: Number(r.mark_iv),
      markPrice: Number(r.mark_price),
      underlyingPrice: Number(r.underlying_price ?? r.estimated_delivery_price),
      // 做市商敞口引擎用的全链 OI (BTC)；缺失时记 0，不参与敞口聚合
      openInterest: Number(r.open_interest) || 0
    };
    if (indexPrice === null && Number(r.estimated_delivery_price) > 0) {
      indexPrice = Number(r.estimated_delivery_price);
    }
  });
  return { indexPrice, marks };
}

/**
 * Keep only the requested instruments (the PV modal only needs its own legs).
 */
function pickInstruments(snapshot, instruments) {
  if (!instruments || !instruments.length) return snapshot;
  const marks = {};
  instruments.forEach(name => {
    if (snapshot.marks[name]) marks[name] = snapshot.marks[name];
  });
  return { ...snapshot, marks };
}

/**
 * Raw Deribit option book summary rows (also used by the daily open-interest snapshot).
 */
async function fetchBookSummaryRows(currency = 'BTC') {
  const url = `https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${encodeURIComponent(currency)}&kind=option`;
  const resp = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT }, timeout: 8000 });
  if (!resp.ok) throw new Error(`Deribit book summary HTTP ${resp.status}`);
  const json = await resp.json();
  if (!Array.isArray(json.result)) throw new Error('Deribit book summary: malformed result');
  // Shared validation: OI snapshots / scripts calling this directly get the
  // same schema guarantee as the marks path.
  const bad = validateBookSummaryRows(json.result);
  if (bad) throw new Error(`Deribit book summary 校验失败: ${bad}`);
  return json.result;
}

async function fetchSnapshot(currency) {
  const rows = await fetchBookSummaryRows(currency);
  const bad = validateBookSummaryRows(rows);
  if (bad) throw new Error(`Deribit book summary 校验失败: ${bad}`);
  const snapshot = { currency, timestamp: Date.now(), ...compactBookSummary(rows) };
  if (!Object.keys(snapshot.marks).length) throw new Error('book summary 无有效 mark');
  return snapshot;
}

/**
 * @param {string} currency
 * @param {{fetcher?: Function, now?: number}} [deps] - injectable for tests
 */
async function getOptionMarks(currency = 'BTC', deps = {}) {
  const fetcher = deps.fetcher || fetchSnapshot;
  const now = deps.now || Date.now();
  const entry = cache.get(currency) || {};
  if (entry.snapshot && now - entry.ts < TTL_MS) {
    return withDataHealth({ ...entry.snapshot, stale: false }, ['option_marks']);
  }

  if (!entry.inflight) {
    recordAttempt('option_marks', { now });
    entry.inflight = fetcher(currency)
      .then(snapshot => {
        // Full schema validation BEFORE the cache write — an invalid snapshot
        // must never become the next failure's "last good" fallback, and a
        // recordSuccess throw must not leave polluted cache behind.
        const bad = validateMarkSnapshot(snapshot, now);
        if (bad) throw new Error(`option marks snapshot 校验失败: ${bad}`);
        // Snapshot timestamp is the real acquisition receipt, never reader now.
        recordSuccess('option_marks', {
          dataAsOf: new Date(snapshot.timestamp).toISOString(),
          asOfKind: 'received', source: 'deribit/book_summary'
        });
        entry.snapshot = snapshot;
        entry.ts = now;
        return snapshot;
      })
      .catch(err => {
        recordFailure('option_marks', err);
        throw err;
      })
      .finally(() => { entry.inflight = null; });
    cache.set(currency, entry);
  }

  try {
    return withDataHealth({ ...(await entry.inflight), stale: false }, ['option_marks']);
  } catch (err) {
    if (entry.snapshot) {
      console.warn(`[option-marks] refresh failed, serving stale snapshot: ${err.message}`);
      return withDataHealth({ ...entry.snapshot, stale: true }, ['option_marks']);
    }
    throw err;
  }
}

function clearOptionMarksCache() {
  cache.clear();
}

module.exports = {
  getOptionMarks,
  fetchBookSummaryRows,
  compactBookSummary,
  pickInstruments,
  clearOptionMarksCache
};
