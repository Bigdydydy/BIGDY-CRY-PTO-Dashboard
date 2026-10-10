const fs = require('fs');
const path = require('path');
const { fetchWithTimeout } = require('./http_client');
const { fetchFredSeries } = require('./macro_fetcher');

// MSTR 融资压力：STRC 平价锚定 + 优先股分层利差
const CONFIG_FILE = path.join(__dirname, '..', 'data', 'mstr_preferreds.json');
const CACHE_FILE = path.join(__dirname, '..', 'data', 'mstr_preferreds_cache.json');
const CACHE_TTL_MS = 10 * 60 * 1000;
const PAR = 100;
const BREAK_LEVEL = 99;
const SPREAD_SMOOTH_DAYS = 5;

let inMemoryCache = null;
let lastFetchTime = 0;

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    console.error('[Preferreds] Error reading config:', err.message);
  }
  return {};
}

/**
 * Yahoo 日线：收盘 / 最高 / 最低 / 成交量
 */
async function fetchYahooDaily(symbol) {
  const resp = await fetchWithTimeout('https://query1.finance.yahoo.com/v8/finance/chart/' + symbol + '?range=2y&interval=1d', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' }
  });
  if (!resp.ok) throw new Error('Yahoo ' + symbol + ' HTTP ' + resp.status);
  const json = await resp.json();
  const res = json.chart?.result?.[0];
  const q = res?.indicators?.quote?.[0];
  if (!res?.timestamp || !q) throw new Error('Yahoo ' + symbol + ' empty payload');
  const map = new Map();
  res.timestamp.forEach((t, i) => {
    if (typeof q.close[i] !== 'number' || q.close[i] <= 0) return;
    map.set(new Date(t * 1000).toISOString().slice(0, 10), {
      close: q.close[i],
      high: q.high[i] ?? q.close[i],
      low: q.low[i] ?? q.close[i],
      volume: q.volume[i] || 0
    });
  });
  return map;
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function round(v, d = 2) {
  return v === null || v === undefined || !isFinite(v) ? null : Number(v.toFixed(d));
}

function spreadZone(v, t) {
  if (v === null) return null;
  if (v >= t.stress) return 'stress';
  if (v >= t.watch) return 'watch';
  return 'normal';
}

async function fetchAndBuildPreferreds() {
  const config = loadConfig();
  const coupons = config.fixedCouponPct || { STRF: 10, STRD: 10 };
  const thresholds = config.spreadThresholdsPct || { watch: 3.5, stress: 4.5 };
  const strcRates = config.strcMonthlyRatePct || {};

  const [strc, strf, strd, tbill] = await Promise.all([
    fetchYahooDaily('STRC'),
    fetchYahooDaily('STRF').catch(e => { console.warn('[Preferreds] STRF:', e.message); return new Map(); }),
    fetchYahooDaily('STRD').catch(e => { console.warn('[Preferreds] STRD:', e.message); return new Map(); }),
    fetchFredSeries('DGS1MO')
  ]);

  const dates = Array.from(strc.keys()).sort();
  if (dates.length === 0) throw new Error('STRC price series empty');

  // 指标一：平价偏离、20D VWAP（典型价 × 成交量）、连续低于 $99 天数
  // 指标三：STRD − STRF 当期收益率利差（5D 中位数平滑，抵消除息日与低流动性噪音）
  const rawSpreads = [];
  let streak = 0;
  let maxStreak = 0;
  let maxStreakEnd = null;
  const points = dates.map((date, i) => {
    const bar = strc.get(date);
    let pv = 0;
    let vol = 0;
    for (let j = Math.max(0, i - 19); j <= i; j++) {
      const b = strc.get(dates[j]);
      pv += ((b.high + b.low + b.close) / 3) * b.volume;
      vol += b.volume;
    }
    streak = bar.close < BREAK_LEVEL ? streak + 1 : 0;
    if (streak > maxStreak) { maxStreak = streak; maxStreakEnd = date; }

    const f = strf.get(date);
    const d = strd.get(date);
    const raw = (f && d) ? (coupons.STRD * PAR) / d.close - (coupons.STRF * PAR) / f.close : null;
    if (raw !== null) rawSpreads.push(raw);
    const spread = raw !== null ? median(rawSpreads.slice(-SPREAD_SMOOTH_DAYS)) : null;

    return {
      date,
      strcClose: round(bar.close),
      strcVwap20: round(vol > 0 ? pv / vol : bar.close),
      belowParStreak: streak,
      strfClose: f ? round(f.close) : null,
      strdClose: d ? round(d.close) : null,
      juniorSpread: round(spread)
    };
  });

  const latest = points[points.length - 1];
  const last60 = points.slice(-60);
  const spreadPts = points.filter(p => p.juniorSpread !== null);
  const spreadLatest = spreadPts.length ? spreadPts[spreadPts.length - 1].juniorSpread : null;
  const spread20dAgo = spreadPts.length > 20 ? spreadPts[spreadPts.length - 21].juniorSpread : null;
  const spreadYear = spreadPts.slice(-252).map(p => p.juniorSpread);
  const spreadPercentile = spreadLatest !== null && spreadYear.length
    ? Math.round(spreadYear.filter(v => v <= spreadLatest).length / spreadYear.length * 100)
    : null;

  // 指标二：月度——股息率上调后月均价仍低于平价；股息率需在配置中按月维护
  const monthBuckets = new Map();
  for (const p of points) {
    const k = p.date.slice(0, 7);
    if (!monthBuckets.has(k)) monthBuckets.set(k, { prices: [], tbills: [] });
    monthBuckets.get(k).prices.push(p.strcClose);
  }
  for (const [date, v] of tbill) {
    const b = monthBuckets.get(date.slice(0, 7));
    if (b) b.tbills.push(v);
  }
  const avg = a => a.reduce((s, x) => s + x, 0) / a.length;
  const monthly = [];
  let prevRate = null;
  for (const [month, b] of monthBuckets) {
    const rate = typeof strcRates[month] === 'number' ? strcRates[month] : null;
    const avgPx = avg(b.prices);
    const tb = b.tbills.length ? avg(b.tbills) : null;
    const currentYield = rate !== null ? (rate * PAR) / avgPx : null;
    const hiked = rate !== null && prevRate !== null && rate > prevRate;
    monthly.push({
      month,
      ratePct: rate,
      avgPrice: round(avgPx),
      tbill1mPct: round(tb),
      currentYieldPct: round(currentYield),
      spreadOverTbillPct: currentYield !== null && tb !== null ? round(currentYield - tb) : null,
      impliedGapBp: currentYield !== null ? Math.round(Math.max(0, currentYield - rate) * 100) : null,
      hiked,
      hikeFailed: hiked && avgPx < 99.5
    });
    if (rate !== null) prevRate = rate;
  }
  const ratedMonths = monthly.filter(m => m.ratePct !== null);
  const lastRated = ratedMonths.length ? ratedMonths[ratedMonths.length - 1] : null;

  const summary = {
    asOf: latest.date,
    strcClose: latest.strcClose,
    strcDeviationPct: round((latest.strcClose - PAR) / PAR * 100),
    strcVwap20: latest.strcVwap20,
    belowParStreak: latest.belowParStreak,
    maxBelowParStreak: maxStreak,
    maxBelowParStreakEnd: maxStreakEnd,
    belowParDays60: last60.filter(p => p.strcClose < BREAK_LEVEL).length,
    window60: last60.length,
    juniorSpreadPct: spreadLatest,
    juniorSpreadChange20dBp: spreadLatest !== null && spread20dAgo !== null ? Math.round((spreadLatest - spread20dAgo) * 100) : null,
    juniorSpreadPercentile1y: spreadPercentile,
    juniorSpreadZone: spreadZone(spreadLatest, thresholds),
    spreadThresholdsPct: thresholds,
    strcRateConfigured: ratedMonths.length > 0,
    strcLatestRatedMonth: lastRated,
    hikeFailedMonths: monthly.filter(m => m.hikeFailed).length,
    hikeMonths: monthly.filter(m => m.hiked).length,
    updatedAt: new Date().toISOString()
  };

  const payload = { points, monthly, summary };
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(payload), 'utf8');
  } catch (err) {
    console.error('[Preferreds] Failed to save cache:', err.message);
  }
  inMemoryCache = payload;
  lastFetchTime = Date.now();
  return payload;
}

function readCacheFile() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return cached && Array.isArray(cached.points) && cached.points.length ? cached : null;
  } catch (e) {
    return null;
  }
}

async function getPreferredsData(forceRefresh = false) {
  if (!forceRefresh && inMemoryCache && Date.now() - lastFetchTime < CACHE_TTL_MS) return inMemoryCache;
  try {
    return await fetchAndBuildPreferreds();
  } catch (err) {
    const fallback = inMemoryCache || readCacheFile();
    if (!fallback) throw err;
    console.warn('[Preferreds] Live rebuild failed, serving cached dataset:', err.message);
    inMemoryCache = fallback;
    return fallback;
  }
}

module.exports = { getPreferredsData };
