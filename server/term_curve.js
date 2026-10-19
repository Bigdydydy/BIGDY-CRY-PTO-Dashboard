/**
 * Module 2-C: Cross-sectional basis term structure (crypto "dollar yield curve")
 *
 * Every Deribit BTC monthly and quarterly future with at least 7 days left, priced as an
 * annualized basis over the Deribit BTC index, set against the US Treasury curve at matching
 * tenors. Weeklies / dailies and the final week of any contract are left out: annualizing a few
 * dollars of basis over a few days turns noise into double-digit APRs.
 *
 * Output per contract: APR, Treasury yield interpolated to the same tenor, spread (crypto term
 * premium), and the implied forward rate between neighbouring contracts. Comparison curves
 * (1W / 1M / 3M ago) are rebuilt from each contract's 08:00 UTC daily close on that date — no
 * snapshot storage needed, so they survive restarts of the deployed host.
 */

const {
  deribitGet,
  fetchDeribitDailyCloses,
  fetchTbillLookup,
  getLastFridayOfMonth,
  deribitFutureName,
  parseDeribitFutureExpiry,
  getHistoricalBasisData,
  HURDLE_SPREAD
} = require('./basis_fetcher');

const DAY_MS = 86400000;
const MIN_DAYS = 7;
const MAX_DAYS = 400;
const LIVE_TTL_MS = 60 * 1000;
const UST_TTL_MS = 6 * 3600 * 1000;
const COMPARE_DAYS = [7, 30, 90];
// FRED constant-maturity Treasury series and their tenors in days
const UST_SERIES = [['DGS1MO', 30], ['DGS3MO', 91], ['DGS6MO', 182], ['DGS1', 365]];

const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));
const isoDate = ts => new Date(ts).toISOString().slice(0, 10);

/**
 * True if an 08:00 UTC expiry timestamp falls on the last Friday of its calendar month
 * (monthly / quarterly Deribit future, excluding weekly / daily expiries).
 */
function isMonthlyOrQuarterlyExpiry(expTs) {
  if (!Number.isFinite(expTs)) return false;
  const d = new Date(expTs);
  return expTs === getLastFridayOfMonth(d.getUTCFullYear(), d.getUTCMonth()).getTime();
}

/**
 * Extract monthly and quarterly BTC futures directly from a Deribit book summary array.
 * Filters out perpetuals, weeklies/dailies, and contracts outside [MIN_DAYS, MAX_DAYS].
 */
function extractLiveCurvePoints(book, now, index) {
  if (!Array.isArray(book) || !(index > 0)) return [];
  const points = [];
  for (const b of book) {
    if (!b || !(b.mark_price > 0)) continue;
    const exp = parseDeribitFutureExpiry(b.instrument_name);
    if (!isMonthlyOrQuarterlyExpiry(exp)) continue;
    const days = (exp - now) / DAY_MS;
    if (days < MIN_DAYS || days > MAX_DAYS) continue;
    points.push({
      name: b.instrument_name,
      expiry: isoDate(exp),
      days,
      apr: (b.mark_price - index) / index * 365 / days * 100,
      oiUsd: Math.round((Number(b.open_interest) || 0) * index),
      volumeUsd: Math.round(Number(b.volume_usd) || 0)
    });
  }
  return points.sort((a, b) => a.days - b.days);
}

/**
 * Interpolate APR on a curve at a constant tenor (in days), with a small boundary snap
 * tolerance (default 5 days) so a quarterly roll right around 30D/90D does not drop to null.
 */
function aprAtTenor(points, targetDays, edgeToleranceDays = 5) {
  const pts = (points || []).filter(p => p && Number.isFinite(p.days) && Number.isFinite(p.apr)).sort((a, b) => a.days - b.days);
  if (!pts.length) return null;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (targetDays >= a.days && targetDays <= b.days) {
      return b.days === a.days ? a.apr : a.apr + (b.apr - a.apr) * (targetDays - a.days) / (b.days - a.days);
    }
  }
  if (targetDays < pts[0].days && pts[0].days - targetDays <= edgeToleranceDays) return pts[0].apr;
  const last = pts[pts.length - 1];
  if (targetDays > last.days && targetDays - last.days <= edgeToleranceDays) return last.apr;
  return null;
}

/**
 * Expiries that form the curve on a given day: the monthly contracts (last Friday) of the next
 * three calendar months plus the quarterlies (Mar/Jun/Sep/Dec) within MAX_DAYS. Whether a
 * contract was actually listed is decided by the price source (book summary / daily candle).
 */
function curveExpiries(ts) {
  const d = new Date(ts);
  const out = new Set();
  for (let k = 0; k < 15; k++) {
    const y = d.getUTCFullYear() + Math.floor((d.getUTCMonth() + k) / 12);
    const m = (d.getUTCMonth() + k) % 12;
    const exp = getLastFridayOfMonth(y, m).getTime();
    const days = (exp - ts) / DAY_MS;
    if (days < MIN_DAYS || days > MAX_DAYS) continue;
    if (k <= 3 || m % 3 === 2) out.add(exp);
  }
  return [...out].sort((a, b) => a - b);
}

/** Treasury yield at a tenor: flat below 1M, linear between FRED tenors, flat beyond 1Y */
function ustAt(days, ust) {
  const pts = UST_SERIES.map(([id, d]) => [d, ust[id]]).filter(([, v]) => Number.isFinite(v));
  if (!pts.length) return null;
  if (days <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [d0, v0] = pts[i - 1];
    const [d1, v1] = pts[i];
    if (days <= d1) return v0 + (v1 - v0) * (days - d0) / (d1 - d0);
  }
  return pts[pts.length - 1][1];
}

/** Implied simple-annualized forward rate between two tenors, from their simple annualized rates */
function forwardRate(a, b) {
  const growthA = 1 + a.apr / 100 * a.days / 365;
  const growthB = 1 + b.apr / 100 * b.days / 365;
  return (growthB / growthA - 1) * 365 / (b.days - a.days) * 100;
}

/** Attach Treasury yield, spread and forwards; compute summary metrics */
function decorateCurve(points, ust) {
  const pts = points
    .filter(p => p.days >= MIN_DAYS && Number.isFinite(p.apr))
    .sort((a, b) => a.days - b.days)
    .map(p => {
      const u = ustAt(p.days, ust);
      return { ...p, apr: round(p.apr), days: round(p.days, 1), ust: round(u), spread: u == null ? null : round(p.apr - u) };
    });
  const forwards = [];
  for (let i = 1; i < pts.length; i++) {
    forwards.push({ from: pts[i - 1].name, to: pts[i].name, fromDays: pts[i - 1].days, toDays: pts[i].days, apr: round(forwardRate(pts[i - 1], pts[i])) });
  }
  const spreads = pts.filter(p => p.spread != null);
  const widest = spreads.reduce((best, p) => (!best || p.spread > best.spread ? p : best), null);
  return {
    points: pts,
    forwards,
    metrics: pts.length >= 2 ? {
      // Back minus front: > 0 upward-sloping (contango steepening), < 0 front-loaded / inverted
      slope: round(pts[pts.length - 1].apr - pts[0].apr),
      frontApr: pts[0].apr,
      backApr: pts[pts.length - 1].apr,
      avgSpread: spreads.length ? round(spreads.reduce((s, p) => s + p.spread, 0) / spreads.length) : null,
      widestSpread: widest ? { name: widest.name, days: widest.days, spread: widest.spread } : null
    } : null
  };
}

// ---------------------------------------------------------------------------
// Treasury curve
// ---------------------------------------------------------------------------

let ustCache = null;
let ustCacheTime = 0;

async function getUstLookups() {
  if (ustCache && Date.now() - ustCacheTime < UST_TTL_MS) return ustCache;
  const lookups = await Promise.all(UST_SERIES.map(([id]) => fetchTbillLookup(id)));
  ustCache = Object.fromEntries(UST_SERIES.map(([id], i) => [id, lookups[i]]));
  ustCacheTime = Date.now();
  return ustCache;
}

function ustOn(lookups, dateStr) {
  return Object.fromEntries(UST_SERIES.map(([id]) => [id, lookups[id].at(dateStr) ?? lookups[id].latest]));
}

// ---------------------------------------------------------------------------
// Live and historical curves
// ---------------------------------------------------------------------------

let liveCache = null;
let liveCacheTime = 0;

async function buildLiveCurve(ustLookups) {
  if (liveCache && Date.now() - liveCacheTime < LIVE_TTL_MS) return liveCache;
  const now = Date.now();
  const book = await deribitGet('get_book_summary_by_currency', { currency: 'BTC', kind: 'future' });
  const byName = new Map(book.map(b => [b.instrument_name, b]));
  const index = Number(byName.get('BTC-PERPETUAL')?.estimated_delivery_price);
  if (!(index > 0)) throw new Error('Deribit index unavailable');
  const points = extractLiveCurvePoints(book, now, index);
  const ust = ustOn(ustLookups, isoDate(now));
  liveCache = { asOf: now, date: isoDate(now), live: true, index: round(index, 1), ust, ...decorateCurve(points, ust) };
  liveCacheTime = now;
  return liveCache;
}

// Past dates never change, so their reconstructed curves are cached for the process lifetime
const historicalCache = new Map();

async function buildHistoricalCurve(dateStr, indexPrice, ustLookups) {
  if (historicalCache.has(dateStr)) return historicalCache.get(dateStr);
  const ts = Date.parse(`${dateStr}T08:00:00Z`);
  const points = [];
  for (const exp of curveExpiries(ts)) {
    const name = deribitFutureName(exp);
    let closes;
    try {
      closes = await fetchDeribitDailyCloses(name, ts, ts);
    } catch (err) {
      continue; // contract not listed that day
    }
    const close = closes.get(ts);
    if (!(close > 0)) continue;
    const days = (exp - ts) / DAY_MS;
    points.push({ name, expiry: isoDate(exp), days, apr: (close - indexPrice) / indexPrice * 365 / days * 100 });
  }
  const ust = ustOn(ustLookups, dateStr);
  const curve = { asOf: ts, date: dateStr, live: false, index: indexPrice, ust, ...decorateCurve(points, ust) };
  if (curve.points.length >= 2) historicalCache.set(dateStr, curve);
  return curve;
}

/**
 * Live curve plus comparison curves from the daily history (08:00 UTC snapshots).
 * funding0d: the market-wide 0D funding rate, shown as a separate marker (not joined to the futures).
 */
async function getTermCurve({ funding0d = null } = {}) {
  const [ustLookups, history] = await Promise.all([getUstLookups(), getHistoricalBasisData().catch(() => [])]);
  const live = await buildLiveCurve(ustLookups);

  const comparisons = [];
  for (const back of COMPARE_DAYS) {
    const target = isoDate(Date.now() - back * DAY_MS);
    // Nearest stored snapshot on or before the target date gives the Deribit index at 08:00 UTC
    const row = [...history].reverse().find(r => r.date <= target && r.btcPrice > 0);
    if (!row) continue;
    try {
      const curve = await buildHistoricalCurve(row.date, row.btcPrice, ustLookups);
      if (curve.points.length >= 2) comparisons.push({ backDays: back, label: back === 7 ? '1 周前' : back === 30 ? '1 个月前' : '3 个月前', ...curve });
    } catch (err) {
      console.warn(`[TermCurve] Comparison curve ${row.date} unavailable:`, err.message);
    }
  }

  return {
    generatedAt: Date.now(),
    methodology: {
      contracts: 'Deribit BTC 月度与季度合约，剩余 ≥7 天；周/日合约与合约最后一周不计入',
      apr: '(合约价 − Deribit BTC 指数) / 指数 × 365 / 剩余天数',
      ust: 'FRED 美债收益率 1M / 3M / 6M / 1Y，按剩余天数线性插值（1 个月以内取 1M）',
      forward: '相邻合约推出的隐含远期年化：[(1+r₂t₂)/(1+r₁t₁) − 1] / (t₂ − t₁)',
      history: '对比曲线用各合约当日 08:00 UTC 日 K 收盘重建'
    },
    funding0d: round(funding0d),
    hurdleSpread: HURDLE_SPREAD,
    live,
    comparisons
  };
}

module.exports = {
  getTermCurve,
  curveExpiries,
  isMonthlyOrQuarterlyExpiry,
  extractLiveCurvePoints,
  aprAtTenor,
  ustAt,
  forwardRate,
  decorateCurve,
  UST_SERIES
};
