/**
 * Real Historical Basis & Term Structure Fetcher (schema v2)
 * Source: Binance COIN-M BTCUSD (/futures/data/basis + /dapi/v1/fundingRate) + FRED DGS3MO
 *
 * Only tenors that actually trade are used:
 *   0D   = BTCUSD_PERP funding, trailing 7-day average annualized (raw 24h kept as fundingApr24h;
 *          24h funding is ~8x noisier day-to-day than the 90D basis and would swamp every spread)
 *   CQ   = current-quarter delivery contract (dropped when < 7 days to expiry)
 *   NQ   = next-quarter delivery contract
 *   90D  = linear interpolation between the real points that bracket 90 days
 * No extrapolation outside the observed points.
 */

const fs = require('fs');
const path = require('path');
const { fetchWithTimeout } = require('./http_client');
const { fetchFredSeries } = require('./macro_fetcher');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'term_premium_history.json');
const SCHEMA_VERSION = 3;
const HISTORY_START_TS = Date.UTC(2024, 0, 1); // Spot ETF launch era (ETFs listed 2024-01-11)
const CQ_MIN_DAYS = 7;            // Front quarterly is dropped inside its final week
const HURDLE_SPREAD = 3.5;        // Institutional hurdle = 3M T-Bill + 3.5%
const DEFAULT_TBILL = 4.0;        // Only used if FRED is unreachable and no prior value exists
const VOL_WINDOW = 30;            // Rolling window (days) for basis mark-to-market volatility
const VOL_FLOOR = 1.0;            // Annualized MTM vol floor (%), avoids blow-ups in quiet periods
const FUNDING_WINDOW_DAYS = 7;    // 0D tenor = realized perp funding over the trailing week
const DAY_MS = 86400000;
const BINANCE_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };

let inMemoryCache = null;

const round = (v, d = 2) => (v == null || !isFinite(v) ? null : Number(v.toFixed(d)));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Returns the last Friday of a given year and month (0-indexed month) at 08:00 UTC
 */
function getLastFridayOfMonth(year, month) {
  const lastDay = new Date(Date.UTC(year, month + 1, 0));
  const dayOfWeek = lastDay.getUTCDay();
  const diff = (dayOfWeek >= 5) ? (dayOfWeek - 5) : (dayOfWeek + 2);
  const lastFridayDate = lastDay.getUTCDate() - diff;
  return new Date(Date.UTC(year, month, lastFridayDate, 8, 0, 0));
}

/**
 * Returns the expiration dates for CURRENT_QUARTER and NEXT_QUARTER contracts
 */
function getQuarterExpiries(date) {
  const y = date.getUTCFullYear();
  const qMonths = [2, 5, 8, 11]; // Mar, Jun, Sep, Dec
  const candidates = [];
  for (let yr = y; yr <= y + 2; yr++) {
    for (const m of qMonths) {
      const f = getLastFridayOfMonth(yr, m);
      if (f > date) candidates.push(f);
    }
  }
  return [candidates[0], candidates[1]];
}

/**
 * Parse a Binance delivery symbol (e.g. BTCUSD_261225) into its 08:00 UTC expiry timestamp
 */
function parseBinanceDeliveryExpiry(symbol) {
  const m = /_(\d{2})(\d{2})(\d{2})$/.exec(symbol || '');
  if (!m) return null;
  return Date.UTC(2000 + Number(m[1]), Number(m[2]) - 1, Number(m[3]), 8, 0, 0);
}

/**
 * Annualized funding APR (%) from settlements inside (snapshotTs - windowDays, snapshotTs].
 * Summing the window (instead of averaging × 3) stays correct if the funding interval changes.
 */
function aggregateDailyFunding(fundingRows, snapshotTs, windowDays = 1) {
  let sum = 0;
  let n = 0;
  for (const r of fundingRows) {
    const t = Number(r.fundingTime);
    if (t > snapshotTs - windowDays * DAY_MS && t <= snapshotTs) {
      sum += Number(r.fundingRate);
      n++;
    }
  }
  return n ? sum * (365 / windowDays) * 100 : null;
}

/**
 * Linear interpolation over sorted real curve points [{days, apr}]; null outside the observed range
 */
function interpolateAtDay(points, targetDays) {
  const pts = points.filter(p => p && p.apr != null && isFinite(p.apr)).sort((a, b) => a.days - b.days);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (targetDays >= a.days && targetDays <= b.days) {
      if (b.days === a.days) return a.apr;
      return a.apr + (targetDays - a.days) * (b.apr - a.apr) / (b.days - a.days);
    }
  }
  return null;
}

/**
 * Build one curve record from raw prices. All APRs are simple annualized basis in %.
 */
function buildCurvePoint({ timestamp, indexPrice, cqPrice, nqPrice, cqExpiryTs, nqExpiryTs, fundingApr, fundingApr24h = null, tbill }) {
  const cqDays = (cqExpiryTs - timestamp) / DAY_MS;
  const nqDays = (nqExpiryTs - timestamp) / DAY_MS;
  const apr = (F, days) => (F > 0 && indexPrice > 0 && days > 0 ? (F - indexPrice) / indexPrice * (365 / days) * 100 : null);

  const cqAprRaw = apr(cqPrice, cqDays);
  const nqApr = apr(nqPrice, nqDays);
  const cqValid = cqAprRaw != null && cqDays >= CQ_MIN_DAYS;
  const cqApr = cqValid ? cqAprRaw : null;

  const points = [{ days: 0, apr: fundingApr }];
  if (cqValid) points.push({ days: cqDays, apr: cqApr });
  if (nqApr != null) points.push({ days: nqDays, apr: nqApr });
  const apr90d = interpolateAtDay(points, 90);

  const hurdle = tbill + HURDLE_SPREAD;
  return {
    date: new Date(timestamp).toISOString().slice(0, 10),
    timestamp,
    schema: SCHEMA_VERSION,
    btcPrice: Math.round(indexPrice),
    fundingApr: round(fundingApr),
    fundingApr24h: round(fundingApr24h),
    cqApr: round(cqApr),
    cqDays: round(cqDays, 2),
    cqValid,
    nqApr: round(nqApr),
    nqDays: round(nqDays, 2),
    apr90d: round(apr90d),
    tbill: round(tbill),
    hurdle: round(hurdle),
    // Short-end spread: front quarterly over perp funding (null while CQ is in its final week)
    spreadShort: cqValid && fundingApr != null ? round(cqApr - fundingApr) : null,
    // Quarterly calendar slope: next quarter over current quarter
    spreadCalendar: cqValid && nqApr != null ? round(nqApr - cqApr) : null,
    // Term slope: 90D constant maturity over perp funding (always defined)
    spreadTerm: apr90d != null && fundingApr != null ? round(apr90d - fundingApr) : null,
    excessOverTBill: apr90d != null ? round(apr90d - tbill) : null,
    excessOverHurdle: apr90d != null ? round(apr90d - hurdle) : null,
    isRealData: true
  };
}

/**
 * Carry score (0-100) from three transparent components:
 *   A. Carry Sharpe (60%): (90D APR - T-Bill) / annualized basis mark-to-market vol.
 *      Sharpe -1 → 0 pts, +3 → 100 pts.
 *   B. Curve structure (25%): 90D over perp funding. Funding far above the futures curve means
 *      leveraged perp longs are crowded and the basis is at risk of a violent reset.
 *   C. Carry momentum (15%): 30-day change in 90D APR — whether the carry window is opening or closing.
 */
function calculateCarryScore({ excessOverTBill, basisVolAnn, spreadTerm, momentum30d }) {
  if (excessOverTBill == null) return { carryScore: null, carrySharpe: null, scoreComponents: null };
  const vol = Math.max(VOL_FLOOR, basisVolAnn || VOL_FLOOR);
  const sharpe = excessOverTBill / vol;
  const sharpePts = clamp((sharpe + 1) / 4 * 100, 0, 100);
  const structurePts = spreadTerm == null ? 50 : clamp(50 + 50 * Math.tanh(spreadTerm / 4), 0, 100);
  const momentumPts = momentum30d == null ? 50 : clamp(50 + 50 * Math.tanh(momentum30d / 3), 0, 100);
  const score = 0.6 * sharpePts + 0.25 * structurePts + 0.15 * momentumPts;
  return {
    carryScore: round(score, 1),
    carrySharpe: round(sharpe, 2),
    scoreComponents: {
      sharpe: round(sharpePts, 1),
      structure: round(structurePts, 1),
      momentum: round(momentumPts, 1)
    }
  };
}

function scoreTier(score) {
  if (score == null) return { code: 'UNKNOWN', label: '--' };
  if (score >= 65) return { code: 'PRIME', label: '优质窗口' };
  if (score >= 45) return { code: 'QUALIFIED', label: '合格' };
  if (score >= 30) return { code: 'MARGINAL', label: '边际' };
  return { code: 'AVOID', label: '回避' };
}

/**
 * Second pass over the chronological series: rolling basis vol, momentum and carry score.
 * Basis MTM vol = std of daily changes in the 90D basis expressed as % of notional (APR × 90/365).
 */
function applyCarryMetrics(series) {
  for (let i = 0; i < series.length; i++) {
    const row = series[i];
    const diffs = [];
    for (let j = Math.max(1, i - VOL_WINDOW + 1); j <= i; j++) {
      const a = series[j - 1].apr90d;
      const b = series[j].apr90d;
      if (a != null && b != null) diffs.push((b - a) * 90 / 365);
    }
    let basisVolAnn = null;
    if (diffs.length >= 10) {
      const mean = diffs.reduce((s, v) => s + v, 0) / diffs.length;
      const variance = diffs.reduce((s, v) => s + (v - mean) ** 2, 0) / (diffs.length - 1);
      basisVolAnn = Math.sqrt(variance) * Math.sqrt(365);
    }
    const prev = i >= 30 ? series[i - 30] : null;
    const momentum30d = prev && prev.apr90d != null && row.apr90d != null ? row.apr90d - prev.apr90d : null;

    row.basisVolAnn = round(basisVolAnn);
    row.momentum30d = round(momentum30d);
    Object.assign(row, calculateCarryScore({
      excessOverTBill: row.excessOverTBill,
      basisVolAnn,
      spreadTerm: row.spreadTerm,
      momentum30d
    }));
    row.scoreTier = scoreTier(row.carryScore).code;
  }
  return series;
}

/**
 * Fetch all historical basis data from Binance DAPI for a given contract type
 */
async function fetchBinanceBasisSeries(contractType, startTs = HISTORY_START_TS) {
  const allRecords = [];
  let cur = startTs;
  const now = Date.now();

  while (cur < now) {
    const url = `https://dapi.binance.com/futures/data/basis?pair=BTCUSD&contractType=${contractType}&period=1d&startTime=${cur}&limit=500`;
    const res = await fetchWithTimeout(url, { headers: BINANCE_HEADERS });
    if (!res.ok) {
      throw new Error(`Binance basis HTTP ${res.status} for ${contractType}`);
    }
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;

    allRecords.push(...data);
    const lastTime = data[data.length - 1].timestamp;
    if (lastTime <= cur || data.length < 500) break;
    cur = lastTime + DAY_MS;
  }

  return allRecords;
}

/**
 * Fetch BTCUSD_PERP funding settlements from startTs to now
 */
async function fetchBinanceFundingHistory(startTs) {
  const rows = [];
  let cur = startTs;
  for (let guard = 0; guard < 50 && cur < Date.now(); guard++) {
    const url = `https://dapi.binance.com/dapi/v1/fundingRate?symbol=BTCUSD_PERP&startTime=${cur}&limit=1000`;
    const res = await fetchWithTimeout(url, { headers: BINANCE_HEADERS });
    if (!res.ok) throw new Error(`Binance funding HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;
    rows.push(...data);
    const last = Number(data[data.length - 1].fundingTime);
    if (data.length < 1000 || last <= cur) break;
    cur = last + 1;
  }
  return rows;
}

/**
 * 3-month T-Bill (FRED DGS3MO) lookup with forward fill over weekends/holidays
 */
async function fetchTbillLookup() {
  const map = await fetchFredSeries('DGS3MO');
  const dates = [...map.keys()].sort();
  return {
    latest: dates.length ? map.get(dates[dates.length - 1]) : null,
    at(dateStr) {
      let lo = 0;
      let hi = dates.length - 1;
      let found = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (dates[mid] <= dateStr) { found = dates[mid]; lo = mid + 1; } else hi = mid - 1;
      }
      return found ? map.get(found) : null;
    }
  };
}

/**
 * Build consolidated historical term structure from real CQ / NQ / funding / T-Bill data
 */
async function fetchAndBuildHistoricalBasis() {
  console.log('[BasisFetcher] Ingesting Binance COIN-M basis + funding and FRED 3M T-Bill...');
  const [cqList, nqList, fundingRows, tbillLookup] = await Promise.all([
    fetchBinanceBasisSeries('CURRENT_QUARTER'),
    fetchBinanceBasisSeries('NEXT_QUARTER'),
    fetchBinanceFundingHistory(HISTORY_START_TS - (FUNDING_WINDOW_DAYS + 1) * DAY_MS),
    fetchTbillLookup()
  ]);

  const nqMap = new Map(nqList.map(item => [item.timestamp, item]));
  const resultSeries = [];
  let lastTbill = tbillLookup.latest ?? DEFAULT_TBILL;
  const firstTbill = cqList.length ? tbillLookup.at(new Date(cqList[0].timestamp).toISOString().slice(0, 10)) : null;
  if (firstTbill != null) lastTbill = firstTbill;

  for (const cq of cqList) {
    const ts = cq.timestamp;
    const dateStr = new Date(ts).toISOString().slice(0, 10);
    const nq = nqMap.get(ts);
    const [q1Expiry, q2Expiry] = getQuarterExpiries(new Date(ts));
    const tb = tbillLookup.at(dateStr);
    if (tb != null) lastTbill = tb;

    resultSeries.push(buildCurvePoint({
      timestamp: ts,
      indexPrice: Number(cq.indexPrice),
      // Full-precision price ratio instead of Binance's 4-decimal basisRate
      cqPrice: Number(cq.futuresPrice),
      nqPrice: nq ? Number(nq.futuresPrice) : null,
      cqExpiryTs: q1Expiry.getTime(),
      nqExpiryTs: q2Expiry.getTime(),
      fundingApr: aggregateDailyFunding(fundingRows, ts, FUNDING_WINDOW_DAYS),
      fundingApr24h: aggregateDailyFunding(fundingRows, ts, 1),
      tbill: lastTbill
    }));
  }

  applyCarryMetrics(resultSeries);

  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(resultSeries, null, 2), 'utf8');
    console.log(`[BasisFetcher] Archived ${resultSeries.length} daily term-structure records to ${CACHE_FILE}`);
  } catch (err) {
    console.warn('[BasisFetcher] Error persisting historical basis:', err.message);
  }

  inMemoryCache = resultSeries;
  return resultSeries;
}

/**
 * Live Binance snapshot: perp / CQ / NQ mark vs index plus trailing-24h funding.
 * Same exchange and same formulas as the history, so the latest point does not splice sources.
 */
let liveCache = null;
let liveCacheTime = 0;
const LIVE_TTL_MS = 60 * 1000;

async function fetchLiveBinanceCurve(tbill) {
  const now = Date.now();
  if (liveCache && now - liveCacheTime < LIVE_TTL_MS) {
    return { ...liveCache, tbill: round(tbill), ...rebaseOnTbill(liveCache, tbill) };
  }
  const [premRes, fundRes] = await Promise.all([
    fetchWithTimeout('https://dapi.binance.com/dapi/v1/premiumIndex?pair=BTCUSD', { headers: BINANCE_HEADERS }),
    fetchWithTimeout(`https://dapi.binance.com/dapi/v1/fundingRate?symbol=BTCUSD_PERP&startTime=${now - (FUNDING_WINDOW_DAYS + 1) * DAY_MS}&limit=100`, { headers: BINANCE_HEADERS })
  ]);
  if (!premRes.ok) throw new Error(`Binance premiumIndex HTTP ${premRes.status}`);
  if (!fundRes.ok) throw new Error(`Binance funding HTTP ${fundRes.status}`);
  const prem = await premRes.json();
  const funding = await fundRes.json();

  const deliveries = prem
    .filter(p => /^BTCUSD_\d{6}$/.test(p.symbol))
    .map(p => ({ symbol: p.symbol, expiry: parseBinanceDeliveryExpiry(p.symbol), mark: Number(p.markPrice), index: Number(p.indexPrice) }))
    .filter(p => p.expiry && p.expiry > now)
    .sort((a, b) => a.expiry - b.expiry);
  const perp = prem.find(p => p.symbol === 'BTCUSD_PERP');
  if (deliveries.length < 2 || !perp) throw new Error('Binance live curve incomplete');

  const point = buildCurvePoint({
    timestamp: now,
    indexPrice: Number(perp.indexPrice),
    cqPrice: deliveries[0].mark,
    nqPrice: deliveries[1].mark,
    cqExpiryTs: deliveries[0].expiry,
    nqExpiryTs: deliveries[1].expiry,
    fundingApr: aggregateDailyFunding(funding, now, FUNDING_WINDOW_DAYS),
    fundingApr24h: aggregateDailyFunding(funding, now, 1),
    tbill
  });
  point.predictedFundingApr = round(Number(perp.lastFundingRate) * 3 * 365 * 100);
  point.contracts = deliveries.slice(0, 2).map(d => ({
    instrument: d.symbol,
    expiryDate: new Date(d.expiry).toISOString().slice(0, 10),
    daysToExpiry: round((d.expiry - now) / DAY_MS, 2),
    markPrice: d.mark,
    basisAPR: round((d.mark - d.index) / d.index * 365 / ((d.expiry - now) / DAY_MS) * 100)
  }));
  point.isLive = true;
  liveCache = point;
  liveCacheTime = now;
  return point;
}

function rebaseOnTbill(point, tbill) {
  const hurdle = tbill + HURDLE_SPREAD;
  return {
    hurdle: round(hurdle),
    excessOverTBill: point.apr90d != null ? round(point.apr90d - tbill) : null,
    excessOverHurdle: point.apr90d != null ? round(point.apr90d - hurdle) : null
  };
}

function isFreshSchema(parsed) {
  return Array.isArray(parsed) && parsed.length > 100 && parsed[parsed.length - 1].schema === SCHEMA_VERSION;
}

/**
 * Latest daily snapshot that should already exist. Binance stamps each daily basis record at
 * 00:00 UTC (08:00 UTC+8) and publishes it a few minutes later.
 */
const PUBLISH_LAG_MS = 10 * 60 * 1000;
function expectedLatestDate(now = Date.now()) {
  return new Date(now - PUBLISH_LAG_MS).toISOString().slice(0, 10);
}

function hasLatestSnapshot(series, now = Date.now()) {
  return isFreshSchema(series) && series[series.length - 1].date >= expectedLatestDate(now);
}

function readDiskCache() {
  if (!fs.existsSync(CACHE_FILE)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return isFreshSchema(parsed) ? parsed : null;
  } catch (e) {
    console.warn('[BasisFetcher] Error reading cache file:', e.message);
    return null;
  }
}

// Fetch health, surfaced to the UI so a stalled feed (e.g. a geo-blocked host) is visible
const fetchStatus = { lastAttemptAt: 0, lastSuccessAt: 0, lastError: null };
const RETRY_INTERVAL_MS = 10 * 60 * 1000; // after a failed fetch, wait before hitting Binance again

function getBasisFetchStatus(series = inMemoryCache) {
  const latestDate = series && series.length ? series[series.length - 1].date : null;
  const expected = expectedLatestDate();
  return {
    latestDate,
    expectedDate: expected,
    upToDate: !!latestDate && latestDate >= expected,
    lastAttemptAt: fetchStatus.lastAttemptAt || null,
    lastSuccessAt: fetchStatus.lastSuccessAt || null,
    lastError: fetchStatus.lastError
  };
}

/**
 * Get historical basis data. The cache is reused only while it already contains the newest
 * published daily snapshot; once a new UTC day's snapshot is due, Binance is queried again
 * (throttled to one attempt per RETRY_INTERVAL_MS while it keeps failing).
 */
async function getHistoricalBasisData(forceRefresh = false) {
  const now = Date.now();

  if (!forceRefresh) {
    if (!inMemoryCache) inMemoryCache = readDiskCache();
    if (inMemoryCache && hasLatestSnapshot(inMemoryCache, now)) return inMemoryCache;
    if (inMemoryCache && now - fetchStatus.lastAttemptAt < RETRY_INTERVAL_MS) return inMemoryCache;
  }

  fetchStatus.lastAttemptAt = now;
  try {
    const series = await fetchAndBuildHistoricalBasis();
    fetchStatus.lastSuccessAt = Date.now();
    fetchStatus.lastError = null;
    return series;
  } catch (err) {
    fetchStatus.lastError = err.message;
    console.error('[BasisFetcher] Network fetch failed, serving cached history:', err.message);
    const fallback = inMemoryCache || readDiskCache();
    if (fallback) {
      inMemoryCache = fallback;
      return fallback;
    }
    throw err;
  }
}

module.exports = {
  getHistoricalBasisData,
  getBasisFetchStatus,
  expectedLatestDate,
  hasLatestSnapshot,
  fetchAndBuildHistoricalBasis,
  fetchLiveBinanceCurve,
  buildCurvePoint,
  aggregateDailyFunding,
  interpolateAtDay,
  applyCarryMetrics,
  calculateCarryScore,
  scoreTier,
  parseBinanceDeliveryExpiry,
  getQuarterExpiries,
  CACHE_FILE,
  SCHEMA_VERSION,
  CQ_MIN_DAYS,
  HURDLE_SPREAD,
  FUNDING_WINDOW_DAYS
};
