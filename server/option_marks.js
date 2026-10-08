/**
 * Deribit live option marks (mark IV / mark price / expiry forward) for the Module 4 PV view.
 * One public book-summary call covers every option of a currency; it is cached briefly and shared
 * across concurrent requests. If a refresh fails, the last good snapshot is served as stale.
 */
const { fetchWithTimeout } = require('./http_client');

const TTL_MS = 30 * 1000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const cache = new Map(); // currency -> { ts, snapshot, inflight }

/**
 * Reduce Deribit `get_book_summary_by_currency?kind=option` rows to what the PV engine needs.
 * @param {Array} rows
 * @returns {{indexPrice: number|null, marks: Object<string, {markIv: number, markPrice: number, underlyingPrice: number}>}}
 */
function compactBookSummary(rows) {
  const marks = {};
  let indexPrice = null;
  (rows || []).forEach(r => {
    if (!r || !r.instrument_name || !(Number(r.mark_iv) > 0)) return;
    marks[r.instrument_name] = {
      markIv: Number(r.mark_iv),
      markPrice: Number(r.mark_price) || 0,
      underlyingPrice: Number(r.underlying_price) || 0
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
  return json.result;
}

async function fetchSnapshot(currency) {
  const rows = await fetchBookSummaryRows(currency);
  return { currency, timestamp: Date.now(), ...compactBookSummary(rows) };
}

/**
 * @param {string} currency
 * @param {{fetcher?: Function, now?: number}} [deps] - injectable for tests
 */
async function getOptionMarks(currency = 'BTC', deps = {}) {
  const fetcher = deps.fetcher || fetchSnapshot;
  const now = deps.now || Date.now();
  const entry = cache.get(currency) || {};
  if (entry.snapshot && now - entry.ts < TTL_MS) return { ...entry.snapshot, stale: false };

  if (!entry.inflight) {
    entry.inflight = fetcher(currency)
      .then(snapshot => {
        entry.snapshot = snapshot;
        entry.ts = now;
        return snapshot;
      })
      .finally(() => { entry.inflight = null; });
    cache.set(currency, entry);
  }

  try {
    return { ...(await entry.inflight), stale: false };
  } catch (err) {
    if (entry.snapshot) {
      console.warn(`[option-marks] refresh failed, serving stale snapshot: ${err.message}`);
      return { ...entry.snapshot, stale: true };
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
