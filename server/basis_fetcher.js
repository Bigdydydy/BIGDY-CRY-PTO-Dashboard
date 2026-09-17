/**
 * Real Historical Basis & Term Premium Fetcher
 * Source: Binance COIN-M Delivery Futures (/futures/data/basis)
 * Fetches real historical delivery futures basis APR and index prices (2025-01-01 to Present)
 */

const fs = require('fs');
const path = require('path');
const { fetchWithTimeout } = require('./http_client');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'term_premium_history.json');
let inMemoryCache = null;
let lastCheckTime = 0;
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour check

/**
 * Returns the last Friday of a given year and month (0-indexed month)
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
 * Linear interpolation helper
 */
function interpolate(x, x0, x1, y0, y1) {
  if (x1 === x0) return y0;
  return y0 + (x - x0) * (y1 - y0) / (x1 - x0);
}

/**
 * Fetch all historical basis data from Binance DAPI for a given contract type
 */
async function fetchBinanceBasisSeries(contractType, startTs = new Date('2025-01-01T00:00:00Z').getTime()) {
  const allRecords = [];
  let cur = startTs;
  const now = Date.now();

  while (cur < now) {
    const url = `https://dapi.binance.com/futures/data/basis?pair=BTCUSD&contractType=${contractType}&period=1d&startTime=${cur}&limit=500`;
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    if (!res.ok) {
      throw new Error(`Binance basis HTTP ${res.status} for ${contractType}`);
    }
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;

    allRecords.push(...data);
    const lastTime = data[data.length - 1].timestamp;
    if (lastTime <= cur || data.length < 500) break;
    cur = lastTime + 86400000;
  }

  return allRecords;
}

/**
 * Build consolidated historical basis series from real CQ and NQ contract data
 */
async function fetchAndBuildHistoricalBasis() {
  console.log('[BasisFetcher] Ingesting real Bitcoin delivery futures basis from Binance DAPI...');
  const [cqList, nqList] = await Promise.all([
    fetchBinanceBasisSeries('CURRENT_QUARTER'),
    fetchBinanceBasisSeries('NEXT_QUARTER')
  ]);

  const nqMap = new Map();
  for (const item of nqList) {
    const dateStr = new Date(item.timestamp).toISOString().slice(0, 10);
    nqMap.set(dateStr, item);
  }

  const resultSeries = [];

  for (const cq of cqList) {
    const dateObj = new Date(cq.timestamp);
    const dateStr = dateObj.toISOString().slice(0, 10);
    const nq = nqMap.get(dateStr);

    const [q1Expiry, q2Expiry] = getQuarterExpiries(dateObj);
    const daysToQ1 = Math.max(0.5, (q1Expiry.getTime() - dateObj.getTime()) / 86400000);
    const daysToQ2 = Math.max(daysToQ1 + 10, (q2Expiry.getTime() - dateObj.getTime()) / 86400000);

    const cqApr = Number(cq.annualizedBasisRate) * 100;
    const nqApr = nq ? Number(nq.annualizedBasisRate) * 100 : cqApr;

    // Constant maturity interpolation for 7D, 30D, 90D, 180D
    function getAPRAtDay(targetD) {
      if (targetD <= daysToQ1) {
        // Extrapolate towards short end
        const slope = (nqApr - cqApr) / (daysToQ2 - daysToQ1);
        const val = cqApr - (daysToQ1 - targetD) * slope * 0.8;
        return Math.max(0.2, val);
      }
      if (targetD >= daysToQ2) {
        // Project long end with gentle slope dampening
        const slope = (nqApr - cqApr) / (daysToQ2 - daysToQ1);
        const val = nqApr + (targetD - daysToQ2) * slope * 0.5;
        return Math.max(0.5, val);
      }
      return interpolate(targetD, daysToQ1, daysToQ2, cqApr, nqApr);
    }

    const apr7d = Number(getAPRAtDay(7).toFixed(2));
    const apr30d = Number(getAPRAtDay(30).toFixed(2));
    const apr90d = Number(getAPRAtDay(90).toFixed(2));
    const apr180d = Number(getAPRAtDay(180).toFixed(2));

    const spread90d7d = Number((apr90d - apr7d).toFixed(2));
    const spread30d7d = Number((apr30d - apr7d).toFixed(2));
    const spread180d30d = Number((apr180d - apr30d).toFixed(2));
    const excessReturn = Number((apr30d - 4.5).toFixed(2));
    const sign = spread90d7d >= 0 ? 1 : -1;
    const carryScore = Number(((excessReturn / 35.0) * sign * 100).toFixed(1));
    const btcPrice = Math.round(Number(cq.indexPrice));

    resultSeries.push({
      date: dateStr,
      timestamp: cq.timestamp,
      apr7d,
      apr30d,
      apr90d,
      apr180d,
      spread90d7d,
      spread30d7d,
      spread180d30d,
      excessReturn,
      carryScore,
      btcPrice,
      isRealData: true
    });
  }

  // Persist to local JSON cache
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(resultSeries, null, 2), 'utf8');
    console.log(`[BasisFetcher] Successfully archived ${resultSeries.length} real daily basis records to ${CACHE_FILE}`);
  } catch (err) {
    console.warn('[BasisFetcher] Error persisting historical basis:', err.message);
  }

  inMemoryCache = resultSeries;
  lastCheckTime = Date.now();
  return resultSeries;
}

/**
 * Get historical basis data, with caching and fallback
 */
async function getHistoricalBasisData(forceRefresh = false) {
  const now = Date.now();

  if (!forceRefresh && inMemoryCache && (now - lastCheckTime < CHECK_INTERVAL_MS)) {
    return inMemoryCache;
  }

  // Check on-disk file
  if (!forceRefresh && fs.existsSync(CACHE_FILE)) {
    try {
      const content = fs.readFileSync(CACHE_FILE, 'utf8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed) && parsed.length > 100) {
        const lastRecord = parsed[parsed.length - 1];
        const lastDate = new Date(lastRecord.date).getTime();
        // If data is within 48 hours of today, consider cache fresh
        if (now - lastDate < 48 * 3600 * 1000) {
          inMemoryCache = parsed;
          lastCheckTime = now;
          return parsed;
        }
      }
    } catch (e) {
      console.warn('[BasisFetcher] Error reading cache file:', e.message);
    }
  }

  try {
    return await fetchAndBuildHistoricalBasis();
  } catch (err) {
    console.error('[BasisFetcher] Network fetch failed, falling back to disk cache:', err.message);
    if (fs.existsSync(CACHE_FILE)) {
      try {
        const content = fs.readFileSync(CACHE_FILE, 'utf8');
        inMemoryCache = JSON.parse(content);
        return inMemoryCache;
      } catch (e) {
        // Fall through
      }
    }
    throw err;
  }
}

module.exports = {
  getHistoricalBasisData,
  fetchAndBuildHistoricalBasis,
  CACHE_FILE
};
