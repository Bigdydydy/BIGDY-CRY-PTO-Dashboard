/**
 * Real Historical Basis & Term Structure Fetcher (schema v5)
 * Source: Deribit BTC inverse futures + CoinGlass OI-weighted BTC funding + FRED DGS3MO
 *
 * Deribit is used because it is reachable from the deployed server: Binance answers the Render
 * host with HTTP 418 (shared egress IPs are banned), which froze this module online.
 *
 * Daily snapshots are taken at 08:00 UTC (16:00 UTC+8): Deribit's daily candles, index fixing
 * and quarterly expiries all fall on that hour.
 *
 * Only tenors that actually trade are used:
 *   0D   = market-wide perpetual funding: CoinGlass OI-weighted BTC funding (8h bars), trailing
 *          7-day realized average annualized. Deribit's own perp funding is dampened toward 0
 *          (260 of ~1000 days under 1% APR vs 78 market-wide) and biased the short-end spread
 *          by ~1.6pp; it is kept as deribitFundingApr and used as the fallback when CoinGlass
 *          is unavailable or does not cover a day (fundingSource records which one was used).
 *   CQ   = current-quarter future (dropped when < 7 days to expiry)
 *   NQ   = next-quarter future
 *   90D  = linear interpolation between the real points that bracket 90 days
 * No extrapolation outside the observed points.
 */

const fs = require('fs');
const path = require('path');
const { fetchWithTimeout } = require('./http_client');
const { fetchFredSeries } = require('./macro_fetcher');
const { callCoinglassEndpoint } = require('./cdri_fetcher');
const { recordAttempt, recordSuccess, recordFailure, getSourceHealth } = require('./data_health');
const { seedCachedHealth, atomicWriteJson } = require('./data_health_cache');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'term_premium_history.json');
// Sidecar receipt file: the bare-array artifact itself carries no health
// record, so a verified build persists its producer receipt alongside and a
// cold start can restore an honest clock ONLY when it matches the array tail.
const HEALTH_FILE = path.join(__dirname, '..', 'data', 'term_premium_history.health.json');
const SCHEMA_VERSION = 5;
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
 * CoinGlass BTC OI-weighted funding, 8h bars (~1000 days; the endpoint does not page further back).
 * Bar t covers [t, t + 8h]; its close is the rate settled at t + 8h, in % per 8h. Returned as
 * funding rows { fundingTime: settlement time, fundingRate: decimal per 8h } so the same window
 * aggregation as Deribit applies. The still-open bar settles in the future and is never counted.
 */
const CG_FUNDING_TTL_MS = 30 * 60 * 1000;
let cgFundingCache = null;
let cgFundingCacheTime = 0;

async function fetchCoinglassOiFunding() {
  if (cgFundingCache && Date.now() - cgFundingCacheTime < CG_FUNDING_TTL_MS) return cgFundingCache;
  const bars = await callCoinglassEndpoint('/api/priceAndIndicator?symbol=BTC&interval=h8&index=avg_fr_kline&limit=3000');
  if (!Array.isArray(bars) || !bars.length) throw new Error('CoinGlass OI-weighted funding: empty response');
  const rows = bars
    .map(b => ({ fundingTime: Number(b.data[0]) * 1000 + 8 * HOUR_MS, fundingRate: Number(b.data[4]) / 100 }))
    .filter(r => Number.isFinite(r.fundingTime) && Number.isFinite(r.fundingRate))
    .sort((a, b) => a.fundingTime - b.fundingTime);
  cgFundingCache = rows;
  cgFundingCacheTime = Date.now();
  return rows;
}

/** Annualized funding over the window, or null unless ≥ 90% of the expected settlements are present */
function coveredFundingApr(rows, ts, windowDays, settlementsPerDay) {
  if (!rows || !rows.length) return null;
  let n = 0;
  for (const r of rows) {
    if (r.fundingTime > ts - windowDays * DAY_MS && r.fundingTime <= ts) n++;
  }
  return n >= 0.9 * windowDays * settlementsPerDay ? aggregateDailyFunding(rows, ts, windowDays) : null;
}

/**
 * 0D tenor for one snapshot: OI-weighted market funding when CoinGlass covers the 7-day window,
 * otherwise Deribit perpetual funding. Deribit's value is always kept for comparison.
 */
function resolveFunding(ts, cgRows, deribitRows) {
  const deribit7d = aggregateDailyFunding(deribitRows, ts, FUNDING_WINDOW_DAYS);
  const cg7d = coveredFundingApr(cgRows, ts, FUNDING_WINDOW_DAYS, 3);
  if (cg7d != null) {
    return {
      fundingApr: cg7d,
      fundingApr24h: coveredFundingApr(cgRows, ts, 1, 3),
      fundingSource: 'coinglass_oi',
      deribitFundingApr: deribit7d
    };
  }
  return {
    fundingApr: deribit7d,
    fundingApr24h: aggregateDailyFunding(deribitRows, ts, 1),
    fundingSource: 'deribit',
    deribitFundingApr: deribit7d
  };
}

async function fetchCoinglassOiFundingSafe() {
  try {
    return await fetchCoinglassOiFunding();
  } catch (err) {
    console.warn('[BasisFetcher] CoinGlass OI-weighted funding unavailable, falling back to Deribit:', err.message);
    return null;
  }
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
function buildCurvePoint({
  timestamp, indexPrice, cqPrice, nqPrice, cqExpiryTs, nqExpiryTs,
  fundingApr, fundingApr24h = null, fundingSource = null, deribitFundingApr = null, tbill
}) {
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
    fundingSource,
    deribitFundingApr: round(deribitFundingApr),
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

// Deribit rate-limits public calls per IP, and the deployed host shares its egress IP with other
// tenants (plus this app's options modules). All calls from this module go through one queue,
// spaced apart, and a 429 is retried with exponential backoff instead of failing the refresh.
const DERIBIT_MIN_GAP_MS = 250;
const DERIBIT_429_BACKOFF_MS = [1000, 3000, 8000];
let deribitQueue = Promise.resolve();
let deribitLastCallAt = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function deribitGet(method, params) {
  const task = deribitQueue.then(async () => {
    const url = `${DERIBIT_API}/${method}?${new URLSearchParams(params)}`;
    for (let attempt = 0; ; attempt++) {
      const wait = deribitLastCallAt + DERIBIT_MIN_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      deribitLastCallAt = Date.now();
      const res = await fetchWithTimeout(url, { timeout: 20000, retries: 1 });
      if (res.status === 429 && attempt < DERIBIT_429_BACKOFF_MS.length) {
        await sleep(DERIBIT_429_BACKOFF_MS[attempt]);
        continue;
      }
      if (!res.ok) throw new Error(`Deribit ${method} HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(`Deribit ${method}: ${json.error.message || json.error.code}`);
      return json.result;
    }
  });
  // Keep the queue alive after a failure
  deribitQueue = task.catch(() => {});
  return task;
}

/**
 * BTC-PERPETUAL hourly funding rows from startTs to endTs, as
 * { fundingTime, fundingRate (realized interest_1h), indexPrice }.
 * Requested in 30-day chunks through the rate-limited queue.
 */
async function fetchDeribitFundingHistory(startTs, endTs = Date.now()) {
  const rows = [];
  for (let s = startTs; s < endTs; s += FUNDING_CHUNK_MS) {
    rows.push(...await deribitGet('get_funding_rate_history', {
      instrument_name: 'BTC-PERPETUAL',
      start_timestamp: s,
      end_timestamp: Math.min(endTs, s + FUNDING_CHUNK_MS)
    }));
  }
  const byTime = new Map();
  for (const r of rows) {
    if (!r || !Number.isFinite(r.timestamp) || !Number.isFinite(r.interest_1h)
        || !Number.isFinite(r.index_price) || r.index_price <= 0) {
      throw new Error('Deribit funding row 校验失败 (timestamp/interest_1h/index_price 非法)');
    }
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
async function fetchTbillLookup(seriesId = 'DGS3MO') {
  const map = await fetchFredSeries(seriesId);
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

// Incremental refresh re-derives this many trailing days (fills short gaps) and appends new ones;
// a cache older than INCREMENTAL_MAX_AGE_DAYS, or none at all, triggers a full rebuild.
const INCREMENTAL_OVERLAP_DAYS = 10;
const INCREMENTAL_MAX_AGE_DAYS = 60;

/**
 * Build the historical term structure from real CQ / NQ / funding / T-Bill data.
 * With a usable cached series only the trailing overlap plus the missing days are fetched
 * (≈3 Deribit calls); otherwise everything since HISTORY_START_TS is rebuilt.
 */
async function fetchAndBuildHistoricalBasis(cachedSeries = null) {
  const lastSnapshot = latestSnapshotTs();
  const cacheLast = isFreshSchema(cachedSeries) ? cachedSeries[cachedSeries.length - 1].timestamp : null;
  const incremental = cacheLast != null && lastSnapshot - cacheLast <= INCREMENTAL_MAX_AGE_DAYS * DAY_MS;
  const fromTs = incremental ? Math.max(HISTORY_START_TS, cacheLast - INCREMENTAL_OVERLAP_DAYS * DAY_MS) : HISTORY_START_TS;
  console.log(`[BasisFetcher] ${incremental ? 'Incremental' : 'Full'} Deribit refresh from ${new Date(fromTs).toISOString().slice(0, 10)}...`);
  const snapshots = [];
  for (let ts = fromTs; ts <= lastSnapshot; ts += DAY_MS) snapshots.push(ts);

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

  const tbillLookup = await fetchTbillLookup();
  const cgFundingRows = await fetchCoinglassOiFundingSafe();
  const fundingRows = await fetchDeribitFundingHistory(fromTs - (FUNDING_WINDOW_DAYS + 1) * DAY_MS, lastSnapshot + HOUR_MS);
  const closesByName = new Map();
  for (const c of contracts.values()) {
    closesByName.set(c.name, await fetchDeribitDailyCloses(c.name, c.from, c.to));
  }
  const indexAt = new Map(fundingRows.map(r => [r.fundingTime, r.indexPrice]));

  const resultSeries = [];
  let lastTbill = tbillLookup.at(new Date(fromTs).toISOString().slice(0, 10)) ?? tbillLookup.latest ?? DEFAULT_TBILL;
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
      ...resolveFunding(ts, cgFundingRows, fundingRows),
      tbill: lastTbill
    }));
  }
  if (skipped) console.warn(`[BasisFetcher] Skipped ${skipped} snapshot(s) missing index or next-quarter price`);
  if (!resultSeries.length || resultSeries[resultSeries.length - 1].timestamp !== lastSnapshot) {
    throw new Error(`Deribit history incomplete: latest snapshot ${new Date(lastSnapshot).toISOString()} missing`);
  }

  // Keep cached days before the re-derived window; rolling vol / momentum / score are recomputed
  // over the whole merged series because they look back up to 30 days
  const merged = incremental
    ? cachedSeries.filter(r => r.timestamp < fromTs).map(r => ({ ...r })).concat(resultSeries)
    : resultSeries;
  applyCarryMetrics(merged);

  try {
    atomicWriteJson(CACHE_FILE, merged, 2);
    console.log(`[BasisFetcher] Archived ${merged.length} daily term-structure records (${resultSeries.length} re-derived) to ${CACHE_FILE}`);
  } catch (err) {
    console.warn('[BasisFetcher] Error persisting historical basis:', err.message);
  }

  // Real build completed: data-as-of is the LAST ACTUAL 08:00 UTC snapshot ts.
  // A defaulted T-Bill lookup is an honest fallback issue, not "normal".
  const issues = [];
  if (tbillLookup.latest == null) issues.push('fred:DGS3MO 不可用，使用默认 T-Bill ' + DEFAULT_TBILL + '%');
  recordSuccess('basis_history', {
    dataAsOf: new Date(merged[merged.length - 1].timestamp).toISOString(),
    asOfKind: 'source', source: 'deribit/basis-history', issues
  });
  // Persist the producer receipt in a sidecar file so a cold start can
  // restore this build's honest clock (kept separate: the data file stays a
  // bare array for backward compatibility).
  try {
    atomicWriteJson(HEALTH_FILE, {
      dataHealth: {
        sources: {
          basis_history: {
            dataAsOf: new Date(merged[merged.length - 1].timestamp).toISOString(),
            lastSuccessAt: new Date().toISOString(),
            asOfKind: 'source',
            source: 'deribit/basis-history',
            issues
          }
        }
      }
    }, 0);
  } catch (e) {
    console.warn('[BasisFetcher] failed to persist health sidecar:', e.message);
  }

  inMemoryCache = merged;
  return merged;
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
  // A TTL cache hit must not advance basis_live — no attempt, no success.
  if (liveCache && now - liveCacheTime < LIVE_TTL_MS) {
    return { ...liveCache, tbill: round(tbill), ...rebaseOnTbill(liveCache, tbill) };
  }
  recordAttempt('basis_live', { now: Date.now() });
  try {
    const [book, funding, cgFunding] = await Promise.all([
      deribitGet('get_book_summary_by_currency', { currency: 'BTC', kind: 'future' }),
      fetchDeribitFundingHistory(now - (FUNDING_WINDOW_DAYS + 1) * DAY_MS, now),
      fetchCoinglassOiFundingSafe()
    ]);

    const [q1Expiry, q2Expiry] = getQuarterExpiries(new Date(now));
    const byName = new Map(book.map(b => [b.instrument_name, b]));
    const cq = byName.get(deribitFutureName(q1Expiry.getTime()));
    const nq = byName.get(deribitFutureName(q2Expiry.getTime()));
    const perp = byName.get('BTC-PERPETUAL');
    const indexPrice = Number(perp?.estimated_delivery_price || cq?.estimated_delivery_price);
    // Future/Infinity mark/index values are invalid — finite positive only.
    if (!cq || !nq || !Number.isFinite(indexPrice) || !(indexPrice > 0)) {
      throw new Error('Deribit live curve incomplete');
    }
    if (![cq.mark_price, nq.mark_price].every(v => Number.isFinite(Number(v)) && Number(v) > 0)) {
      throw new Error('Deribit live curve: cq/nq mark_price 非法');
    }
    if (perp && perp.funding_8h != null && !Number.isFinite(Number(perp.funding_8h))) {
      throw new Error('Deribit live curve: funding_8h 非有限数');
    }

    const point = buildCurvePoint({
      timestamp: now,
      indexPrice,
      cqPrice: Number(cq.mark_price),
      nqPrice: Number(nq.mark_price),
      cqExpiryTs: q1Expiry.getTime(),
      nqExpiryTs: q2Expiry.getTime(),
      ...resolveFunding(now, cgFunding, funding),
      tbill
    });
    // Rate accruing in the current, not yet settled 8h period (market-wide when available)
    const openBar = cgFunding && cgFunding[cgFunding.length - 1];
    if (point.fundingSource === 'coinglass_oi' && openBar && openBar.fundingTime > now) {
      point.predictedFundingApr = round(openBar.fundingRate * 3 * 365 * 100);
    } else if (perp?.funding_8h != null) {
      point.predictedFundingApr = round(Number(perp.funding_8h) * 3 * 365 * 100);
    }
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
    // Real upstream completion; the live snapshot's data-as-of is the receipt.
    recordSuccess('basis_live', {
      dataAsOf: new Date(now).toISOString(), asOfKind: 'received', source: 'deribit/basis-live'
    });
    return point;
  } catch (err) {
    recordFailure('basis_live', err);
    throw err;
  }
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
/** Read + validate the sidecar receipt: it only counts when its dataAsOf
 * exactly matches the array's latest snapshot timestamp — a stale sidecar
 * must never rejuvenate a rolled-back artifact. */
function readHealthSidecar(latestTs) {
  try {
    if (!fs.existsSync(HEALTH_FILE)) return null;
    const json = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8'));
    const rec = json && json.dataHealth && json.dataHealth.sources
      ? json.dataHealth.sources.basis_history : null;
    if (!rec || !rec.dataAsOf || !rec.lastSuccessAt) return null;
    if (Date.parse(rec.dataAsOf) !== latestTs) return null;
    return json;
  } catch (e) {
    return null;
  }
}

/** Seed honest disk clocks once: last REAL snapshot ts as data-as-of; a
 * matching sidecar receipt restores the producer clock, otherwise the record
 * stays UNKNOWN (legacy bare arrays have no trustworthy receipt). */
let diskSeeded = false;
function seedDiskOnce(series) {
  if (diskSeeded || !Array.isArray(series) || !series.length) return;
  diskSeeded = true;
  const latestTs = series[series.length - 1].timestamp;
  const sidecar = readHealthSidecar(latestTs);
  if (sidecar) {
    seedCachedHealth(sidecar, 'basis_history', {});
  } else {
    seedCachedHealth({ dataHealth: null }, 'basis_history', {
      dataAsOf: new Date(latestTs).toISOString(),
      lastSuccessAt: fetchStatus.lastSuccessAt ? new Date(fetchStatus.lastSuccessAt).toISOString() : null
    });
  }
}

async function getHistoricalBasisData(forceRefresh = false) {
  const now = Date.now();

  if (!forceRefresh) {
    if (!inMemoryCache) inMemoryCache = readDiskCache();
    if (inMemoryCache) seedDiskOnce(inMemoryCache);
    if (inMemoryCache && hasLatestSnapshot(inMemoryCache, now)) {
      // The artifact is current but its receipt is unverified (e.g. a bare
      // legacy array with no sidecar). Schedule ONE throttled real
      // verification through the normal incremental-build path — it goes
      // through the existing Deribit queue and records an honest receipt on
      // success. The data stays servable meanwhile.
      const h = getSourceHealth('basis_history', now);
      if (!h.lastSuccessAt && now - fetchStatus.lastAttemptAt >= RETRY_INTERVAL_MS) {
        fetchStatus.lastAttemptAt = now;
        recordAttempt('basis_history', { now });
        fetchAndBuildHistoricalBasis(inMemoryCache)
          .then(() => { fetchStatus.lastSuccessAt = Date.now(); fetchStatus.lastError = null; })
          .catch(e => {
            fetchStatus.lastError = e.message;
            recordFailure('basis_history', e);
          });
      }
      return inMemoryCache;
    }
    if (inMemoryCache && now - fetchStatus.lastAttemptAt < RETRY_INTERVAL_MS) return inMemoryCache;
  }

  fetchStatus.lastAttemptAt = now;
  recordAttempt('basis_history', { now: Date.now() });
  try {
    const series = await fetchAndBuildHistoricalBasis(forceRefresh ? null : (inMemoryCache || readDiskCache()));
    fetchStatus.lastSuccessAt = Date.now();
    fetchStatus.lastError = null;
    return series;
  } catch (err) {
    fetchStatus.lastError = err.message;
    recordFailure('basis_history', err);
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
  resolveFunding,
  interpolateAtDay,
  applyCarryMetrics,
  calculateCarryScore,
  scoreTier,
  deribitFutureName,
  parseDeribitFutureExpiry,
  latestSnapshotTs,
  getQuarterExpiries,
  getLastFridayOfMonth,
  // Shared with term_curve.js so every Deribit call goes through the same rate-limited queue
  deribitGet,
  fetchDeribitDailyCloses,
  fetchTbillLookup,
  CACHE_FILE,
  SCHEMA_VERSION,
  CQ_MIN_DAYS,
  HURDLE_SPREAD,
  FUNDING_WINDOW_DAYS
};
