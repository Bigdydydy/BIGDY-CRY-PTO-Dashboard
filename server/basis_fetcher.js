/**
 * Real Historical Basis & Term Structure Fetcher (schema v4, Deribit)
 * Source: Deribit BTC inverse futures + BTC-PERPETUAL funding + FRED DGS3MO
 *
 * Deribit is used because it is reachable from the deployed server: Binance answers the Render
 * host with HTTP 418 (shared egress IPs are banned), which froze this module online.
 *
 * Daily snapshots are taken at 08:00 UTC (16:00 UTC+8): Deribit's daily candles, index fixing
 * and quarterly expiries all fall on that hour.
 *
 * Only tenors that actually trade are used:
 *   0D   = BTC-PERPETUAL realized funding (sum of hourly interest_1h), trailing 7-day average
 *          annualized (raw 24h kept as fundingApr24h; 24h funding is far noisier than the basis)
 *   CQ   = current-quarter future (dropped when < 7 days to expiry)
 *   NQ   = next-quarter future
 *   90D  = linear interpolation between the real points that bracket 90 days
 * No extrapolation outside the observed points.
 */

const fs = require('fs');
const path = require('path');
const { fetchWithTimeout } = require('./http_client');
const { fetchFredSeries } = require('./macro_fetcher');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'term_premium_history.json');
const SCHEMA_VERSION = 4;
const HISTORY_START_TS = Date.UTC(2024, 0, 1, 8); // Spot ETF launch era (ETFs listed 2024-01-11)
const SNAPSHOT_HOUR_UTC = 8;
const DERIBIT_API = 'https://www.deribit.com/api/v2/public';
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const CQ_MIN_DAYS = 7;            // Front quarterly is dropped inside its final week
const HURDLE_SPREAD = 3.5;        // Institutional hurdle = 3M T-Bill + 3.5%
const DEFAULT_TBILL = 4.0;        // Only used if FRED is unreachable and no prior value exists
const VOL_WINDOW = 30;            // Rolling window (days) for basis mark-to-market volatility
const VOL_FLOOR = 1.0;            // Annualized MTM vol floor (%), avoids blow-ups in quiet periods
const FUNDING_WINDOW_DAYS = 7;    // 0D tenor = realized perp funding over the trailing week
const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const FUNDING_CHUNK_MS = 30 * DAY_MS; // Deribit returns at most ~744 hourly funding rows per call

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
 * Deribit future name for an 08:00 UTC expiry, e.g. 2026-12-25 → BTC-25DEC26
 */
function deribitFutureName(expiryTs) {
  const d = new Date(expiryTs);
  return `BTC-${d.getUTCDate()}${MONTHS[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(2)}`;
}

/**
 * Parse a Deribit future name (e.g. BTC-25DEC26) into its 08:00 UTC expiry timestamp
 */
function parseDeribitFutureExpiry(name) {
  const m = /^BTC-(\d{1,2})([A-Z]{3})(\d{2})$/.exec(name || '');
  if (!m || MONTHS.indexOf(m[2]) < 0) return null;
  return Date.UTC(2000 + Number(m[3]), MONTHS.indexOf(m[2]), Number(m[1]), 8, 0, 0);
}

/**
 * 08:00 UTC snapshot timestamp of the UTC date containing ts
 */
function snapshotTsOf(ts) {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), SNAPSHOT_HOUR_UTC);
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

async function deribitGet(method, params) {
  const url = `${DERIBIT_API}/${method}?${new URLSearchParams(params)}`;
  const res = await fetchWithTimeout(url, { timeout: 20000, retries: 2 });
  if (!res.ok) throw new Error(`Deribit ${method} HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`Deribit ${method}: ${json.error.message || json.error.code}`);
  return json.result;
}

/**
 * BTC-PERPETUAL hourly funding rows from startTs to endTs, as
 * { fundingTime, fundingRate (realized interest_1h), indexPrice }.
 * Requested in 30-day chunks, a few chunks at a time.
 */
async function fetchDeribitFundingHistory(startTs, endTs = Date.now()) {
  const chunks = [];
  for (let s = startTs; s < endTs; s += FUNDING_CHUNK_MS) chunks.push([s, Math.min(endTs, s + FUNDING_CHUNK_MS)]);
  const rows = [];
  for (let i = 0; i < chunks.length; i += 4) {
    const batch = await Promise.all(chunks.slice(i, i + 4).map(([s, e]) => deribitGet('get_funding_rate_history', {
      instrument_name: 'BTC-PERPETUAL',
      start_timestamp: s,
      end_timestamp: e
    })));
    for (const part of batch) rows.push(...part);
  }
  const byTime = new Map();
  for (const r of rows) {
    byTime.set(r.timestamp, { fundingTime: r.timestamp, fundingRate: r.interest_1h, indexPrice: r.index_price });
  }
  return [...byTime.values()].sort((a, b) => a.fundingTime - b.fundingTime);
}

/**
 * Daily (08:00 UTC) closes of one future: Map(snapshotTs → price at that snapshot).
 * Deribit's 1D candle with tick T spans T → T + 1 day, so its close is the price at T + 1 day.
 */
async function fetchDeribitDailyCloses(instrument, startTs, endTs) {
  const res = await deribitGet('get_tradingview_chart_data', {
    instrument_name: instrument,
    start_timestamp: startTs - DAY_MS,
    end_timestamp: endTs,
    resolution: '1D'
  });
  const closes = new Map();
  (res.ticks || []).forEach((t, i) => {
    if (res.close[i] > 0) closes.set(t + DAY_MS, Number(res.close[i]));
  });
  return closes;
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
  console.log('[BasisFetcher] Ingesting Deribit futures + perpetual funding and FRED 3M T-Bill...');
  const lastSnapshot = latestSnapshotTs();
  const snapshots = [];
  for (let ts = HISTORY_START_TS; ts <= lastSnapshot; ts += DAY_MS) snapshots.push(ts);

  // Every quarterly that served as CQ or NQ on some snapshot, with the window it was needed for
  const contracts = new Map();
  for (const ts of snapshots) {
    for (const exp of getQuarterExpiries(new Date(ts))) {
      const name = deribitFutureName(exp.getTime());
      const c = contracts.get(name) || { name, from: ts, to: ts };
      c.to = ts;
      contracts.set(name, c);
    }
  }

  const [fundingRows, tbillLookup, closesList] = await Promise.all([
    fetchDeribitFundingHistory(HISTORY_START_TS - (FUNDING_WINDOW_DAYS + 1) * DAY_MS, lastSnapshot + HOUR_MS),
    fetchTbillLookup(),
    Promise.all([...contracts.values()].map(c => fetchDeribitDailyCloses(c.name, c.from, c.to)
      .then(closes => [c.name, closes])))
  ]);
  const closesByName = new Map(closesList);
  const indexAt = new Map(fundingRows.map(r => [r.fundingTime, r.indexPrice]));

  const resultSeries = [];
  let lastTbill = tbillLookup.at(new Date(HISTORY_START_TS).toISOString().slice(0, 10)) ?? tbillLookup.latest ?? DEFAULT_TBILL;
  let skipped = 0;

  for (const ts of snapshots) {
    const dateStr = new Date(ts).toISOString().slice(0, 10);
    const [q1Expiry, q2Expiry] = getQuarterExpiries(new Date(ts));
    const indexPrice = indexAt.get(ts);
    const cqPrice = closesByName.get(deribitFutureName(q1Expiry.getTime()))?.get(ts) ?? null;
    const nqPrice = closesByName.get(deribitFutureName(q2Expiry.getTime()))?.get(ts) ?? null;
    const tb = tbillLookup.at(dateStr);
    if (tb != null) lastTbill = tb;
    // A day without the index or the next-quarter close cannot be anchored; skip it rather than guess
    if (!(indexPrice > 0) || !(nqPrice > 0)) {
      skipped++;
      continue;
    }

    resultSeries.push(buildCurvePoint({
      timestamp: ts,
      indexPrice,
      cqPrice,
      nqPrice,
      cqExpiryTs: q1Expiry.getTime(),
      nqExpiryTs: q2Expiry.getTime(),
      fundingApr: aggregateDailyFunding(fundingRows, ts, FUNDING_WINDOW_DAYS),
      fundingApr24h: aggregateDailyFunding(fundingRows, ts, 1),
      tbill: lastTbill
    }));
  }
  if (skipped) console.warn(`[BasisFetcher] Skipped ${skipped} snapshot(s) missing index or next-quarter price`);
  if (!resultSeries.length || resultSeries[resultSeries.length - 1].timestamp !== lastSnapshot) {
    throw new Error(`Deribit history incomplete: latest snapshot ${new Date(lastSnapshot).toISOString()} missing`);
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
 * Live Deribit snapshot: CQ / NQ mark vs the BTC index plus trailing perpetual funding.
 * Same exchange and same formulas as the history, so the latest point does not splice sources.
 */
let liveCache = null;
let liveCacheTime = 0;
const LIVE_TTL_MS = 60 * 1000;

async function fetchLiveCurve(tbill) {
  const now = Date.now();
  if (liveCache && now - liveCacheTime < LIVE_TTL_MS) {
    return { ...liveCache, tbill: round(tbill), ...rebaseOnTbill(liveCache, tbill) };
  }
  const [book, funding] = await Promise.all([
    deribitGet('get_book_summary_by_currency', { currency: 'BTC', kind: 'future' }),
    fetchDeribitFundingHistory(now - (FUNDING_WINDOW_DAYS + 1) * DAY_MS, now)
  ]);

  const [q1Expiry, q2Expiry] = getQuarterExpiries(new Date(now));
  const byName = new Map(book.map(b => [b.instrument_name, b]));
  const cq = byName.get(deribitFutureName(q1Expiry.getTime()));
  const nq = byName.get(deribitFutureName(q2Expiry.getTime()));
  const perp = byName.get('BTC-PERPETUAL');
  const indexPrice = Number(perp?.estimated_delivery_price || cq?.estimated_delivery_price);
  if (!cq || !nq || !(indexPrice > 0)) throw new Error('Deribit live curve incomplete');

  const point = buildCurvePoint({
    timestamp: now,
    indexPrice,
    cqPrice: Number(cq.mark_price),
    nqPrice: Number(nq.mark_price),
    cqExpiryTs: q1Expiry.getTime(),
    nqExpiryTs: q2Expiry.getTime(),
    fundingApr: aggregateDailyFunding(funding, now, FUNDING_WINDOW_DAYS),
    fundingApr24h: aggregateDailyFunding(funding, now, 1),
    tbill
  });
  if (perp?.funding_8h != null) point.predictedFundingApr = round(Number(perp.funding_8h) * 3 * 365 * 100);
  point.contracts = [[cq, q1Expiry], [nq, q2Expiry]].map(([b, exp]) => {
    const days = (exp.getTime() - now) / DAY_MS;
    return {
      instrument: b.instrument_name,
      expiryDate: exp.toISOString().slice(0, 10),
      daysToExpiry: round(days, 2),
      markPrice: Number(b.mark_price),
      basisAPR: round((b.mark_price - indexPrice) / indexPrice * 365 / days * 100)
    };
  });
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
 * Latest daily snapshot that should already exist: 08:00 UTC (16:00 UTC+8) each day, available
 * once Deribit's daily candle and that hour's funding row have printed.
 */
const PUBLISH_LAG_MS = 15 * 60 * 1000;
function latestSnapshotTs(now = Date.now()) {
  return snapshotTsOf(now - SNAPSHOT_HOUR_UTC * HOUR_MS - PUBLISH_LAG_MS);
}

function expectedLatestDate(now = Date.now()) {
  return new Date(latestSnapshotTs(now)).toISOString().slice(0, 10);
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
const RETRY_INTERVAL_MS = 10 * 60 * 1000; // after a failed fetch, wait before hitting Deribit again

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
 * published daily snapshot; once a new 08:00 UTC snapshot is due, Deribit is queried again
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
  fetchLiveCurve,
  buildCurvePoint,
  aggregateDailyFunding,
  interpolateAtDay,
  applyCarryMetrics,
  calculateCarryScore,
  scoreTier,
  deribitFutureName,
  parseDeribitFutureExpiry,
  latestSnapshotTs,
  getQuarterExpiries,
  CACHE_FILE,
  SCHEMA_VERSION,
  CQ_MIN_DAYS,
  HURDLE_SPREAD,
  FUNDING_WINDOW_DAYS
};
