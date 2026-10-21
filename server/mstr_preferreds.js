const fs = require('fs');
const path = require('path');
const { fetchWithTimeout } = require('./http_client');
const { fetchFredSeries } = require('./macro_fetcher');
const { recordAttempt, recordSuccess, recordFailure } = require('./data_health');
const { withDataHealth, seedCachedHealth, atomicWriteJson } = require('./data_health_cache');

// MSTR 融资压力：STRC 平价锚定 + 优先股分层利差
const CONFIG_FILE = path.join(__dirname, '..', 'data', 'mstr_preferreds.json');
const CACHE_FILE = path.join(__dirname, '..', 'data', 'mstr_preferreds_cache.json');
const CACHE_TTL_MS = 10 * 60 * 1000;
const PAR = 100;
const BREAK_LEVEL = 99;
const SPREAD_SMOOTH_DAYS = 5;
const REQUIRED_IDS = ['preferreds', 'yahoo:STRC', 'yahoo:STRF', 'yahoo:STRD', 'fred:DGS1MO'];
const MAX_FUTURE_MS = 5 * 60 * 1000;
const isPosNum = v => v !== null && v !== undefined && typeof v !== 'boolean' &&
  !(typeof v === 'string' && v.trim() === '') && Number.isFinite(Number(v)) && Number(v) > 0;

// STRC 月度股息率历史：由官网 /debt 的 strc_metrics 自动按月记录 (Actions 快照会提交该文件，跨部署累积)
const STRC_RATE_HISTORY_FILE = path.join(__dirname, '..', 'data', 'strc_rate_history.json');
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

let inMemoryCache = null;
let lastFetchTime = 0;

function loadStrcRateHistory() {
  try {
    if (fs.existsSync(STRC_RATE_HISTORY_FILE)) {
      const h = JSON.parse(fs.readFileSync(STRC_RATE_HISTORY_FILE, 'utf8'));
      if (h && h.months && typeof h.months === 'object') return h;
    }
  } catch (err) {
    console.error('[Preferreds] Error reading STRC rate history:', err.message);
  }
  return { months: {} };
}

/**
 * 从已采集的官方披露 (strategy.com/debt) 读取 STRC 当期股息率并按月归档。
 * strc_metrics.dividend 是当期年化股息率，next_record_date 是该期的记录日 (月末)，
 * 所以以记录日所在月份为键。只读取披露服务已保存的状态 (peek)，不触发网络请求。
 */
async function recordOfficialStrcRate(history, {
  // 延迟加载：披露服务依赖较多，避免与本模块形成加载期耦合
  peek = () => require('./mstr_disclosures').peekMstrDisclosures(),
  file = STRC_RATE_HISTORY_FILE,
  now = () => new Date()
} = {}) {
  let disc;
  try {
    disc = await peek();
  } catch (err) {
    return { status: 'unavailable', reason: err.message };
  }
  // Preferred: the 8-K announcement schedule (full history, one entry per
  // effective date). Fallback: the single current rate on the issuer page.
  if (Array.isArray(disc && disc.strcRateSchedule) && disc.strcRateSchedule.length) {
    return recordStrcRateSchedule(history, disc.strcRateSchedule, { file, now });
  }
  const strc = Array.isArray(disc && disc.preferreds) ? disc.preferreds.find(p => p && p.ticker === 'STRC') : null;
  const rate = strc ? strc.dividendPct : null;
  if (!strc || typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0
      || typeof strc.nextRecordDate !== 'string' || !ISO_DAY.test(strc.nextRecordDate)) {
    return { status: 'unavailable', reason: 'no STRC dividend in disclosure snapshot' };
  }
  const month = strc.nextRecordDate.slice(0, 7);
  const prev = history.months[month];
  if (prev && prev.ratePct === rate) return { status: 'unchanged', month };
  history.months[month] = {
    ratePct: rate,
    recordDate: strc.nextRecordDate,
    source: strc.sourceUrl || 'https://www.strategy.com/debt',
    capitalAsOf: disc.capital && disc.capital.asOf ? disc.capital.asOf : null,
    observedAt: now().toISOString(),
    ...(prev ? { revisedFrom: prev.ratePct } : {})
  };
  try {
    atomicWriteJson(file, history, 2);
  } catch (err) {
    console.error('[Preferreds] Failed to save STRC rate history:', err.message);
  }
  return { status: prev ? 'revised' : 'recorded', month };
}

// STRC 于 2025 年 7 月底上市：推断出的初始股息率 (首次公告里的 "from X%") 只回填到这个月为止
const STRC_FIRST_MONTH = '2025-07';

/**
 * 按 8-K 股息率公告时间表回填每个月的股息率：取每月 1 日生效的利率。
 * 只记录到当月为止 (下个月的有条件公告不提前入账)；与已有记录相同则不改写。
 */
function recordStrcRateSchedule(history, schedule, { file, now }) {
  const valid = schedule.filter(e => e && typeof e.ratePct === 'number' && Number.isFinite(e.ratePct) && e.ratePct > 0
    && (e.effectiveFrom === null || (typeof e.effectiveFrom === 'string' && ISO_DAY.test(e.effectiveFrom))));
  const dated = valid.filter(e => e.effectiveFrom).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  if (!dated.length) return { status: 'unavailable', reason: 'empty STRC rate schedule' };
  const inferred = valid.find(e => e.effectiveFrom === null) || null;
  const nowDate = now();
  const currentMonth = nowDate.toISOString().slice(0, 7);
  const startMonth = inferred ? STRC_FIRST_MONTH : dated[0].effectiveFrom.slice(0, 7);
  let changed = 0;
  let revised = 0;
  for (let m = startMonth; m <= currentMonth; m = nextMonth(m)) {
    let hit = inferred;
    for (const e of dated) if (e.effectiveFrom <= `${m}-01`) hit = e;
    if (!hit) continue;
    const prev = history.months[m];
    if (prev && prev.ratePct === hit.ratePct && prev.source === 'sec_8k') continue;
    history.months[m] = {
      ratePct: hit.ratePct,
      effectiveFrom: hit.effectiveFrom,
      source: 'sec_8k',
      documentUrl: hit.documentUrl || null,
      accession: hit.accession || null,
      inferred: !!hit.inferred,
      conditional: !!hit.conditional,
      observedAt: nowDate.toISOString(),
      ...(prev && prev.ratePct !== hit.ratePct ? { revisedFrom: prev.ratePct } : {})
    };
    changed++;
    if (prev && prev.ratePct !== hit.ratePct) revised++;
  }
  if (!changed) return { status: 'unchanged', month: currentMonth };
  try {
    atomicWriteJson(file, history, 2);
  } catch (err) {
    console.error('[Preferreds] Failed to save STRC rate history:', err.message);
  }
  return { status: revised ? 'revised' : 'recorded', month: currentMonth, months: changed };
}

function nextMonth(m) {
  const [y, mo] = m.split('-').map(Number);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
}

/**
 * 官方自动记录 + 手动配置合并。手动配置用于回填官方记录开始之前的月份；
 * 同一月份两者不一致时以官方为准，并在 issues 中注明。
 */
function mergeStrcRates(history, manual) {
  const rates = {};
  const sourceOf = {};
  const issues = [];
  for (const [month, v] of Object.entries(manual || {})) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) { rates[month] = v; sourceOf[month] = 'manual'; }
  }
  for (const [month, rec] of Object.entries(history.months || {})) {
    if (!rec || typeof rec.ratePct !== 'number') continue;
    if (sourceOf[month] === 'manual' && rates[month] !== rec.ratePct) {
      issues.push(`strc_rate_conflict:${month}:manual=${rates[month]},official=${rec.ratePct}`);
    }
    rates[month] = rec.ratePct;
    sourceOf[month] = rec.source === 'sec_8k' ? 'sec' : 'official';
  }
  return { rates, sourceOf, issues };
}

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
  const hid = `yahoo:${symbol}`;
  recordAttempt(hid, { now: Date.now() });
  try {
    const resp = await fetchWithTimeout('https://query1.finance.yahoo.com/v8/finance/chart/' + symbol + '?range=2y&interval=1d', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' }
    });
    if (!resp.ok) throw new Error('Yahoo ' + symbol + ' HTTP ' + resp.status);
    const json = await resp.json();
    const res = json.chart?.result?.[0];
    const q = res?.indicators?.quote?.[0];
    if (!Array.isArray(res?.timestamp) || !q || !Array.isArray(q.close)
        || q.close.length !== res.timestamp.length || !res.timestamp.length) {
      throw new Error('Yahoo ' + symbol + ' empty payload or timestamp/close mismatch');
    }
    // Side arrays must align with timestamps when present; a missing OHLC
    // array must never silently substitute the close for high/low.
    for (const leg of ['high', 'low', 'volume']) {
      if (Array.isArray(q[leg]) && q[leg].length !== res.timestamp.length) {
        throw new Error('Yahoo ' + symbol + ': ' + leg + ' array length mismatch');
      }
    }
    const map = new Map();
    const nowMs = Date.now();
    let prevDay = '';
    res.timestamp.forEach((t, i) => {
      if (!Number.isFinite(t) || t <= 0) throw new Error('Yahoo ' + symbol + ': non-finite timestamp');
      if (t * 1000 > nowMs + MAX_FUTURE_MS) throw new Error('Yahoo ' + symbol + ': future timestamp');
      const c = q.close[i];
      if (c === null || c === undefined) return; // non-trading day
      const day = new Date(t * 1000).toISOString().slice(0, 10);
      if (day <= prevDay) throw new Error('Yahoo ' + symbol + ': timestamps not strictly ascending');
      prevDay = day;
      if (!isPosNum(c)) throw new Error('Yahoo ' + symbol + ': invalid close ' + c);
      // high/low arrays are required together with close rows; null is a
      // missing-leg error, not a reason to clone the close.
      for (const leg of ['high', 'low']) {
        const arr = q[leg];
        const v = Array.isArray(arr) ? arr[i] : null;
        if (v === null || v === undefined || !isPosNum(v)) {
          throw new Error('Yahoo ' + symbol + ': invalid ' + leg + ' ' + JSON.stringify(v));
        }
      }
      const vol = Array.isArray(q.volume) ? q.volume[i] : null;
      if (vol !== null && vol !== undefined && !(Number.isFinite(vol) && vol >= 0)) {
        throw new Error('Yahoo ' + symbol + ': invalid volume ' + vol);
      }
      map.set(day, {
        close: Number(c),
        high: Number(q.high[i]),
        low: Number(q.low[i]),
        volume: vol === null || vol === undefined ? null : vol
      });
    });
    if (!map.size) throw new Error('Yahoo ' + symbol + ': no usable close rows');
    const maxDate = Array.from(map.keys()).sort().pop();
    recordSuccess(hid, { dataAsOf: maxDate, asOfKind: 'source', source: 'yahoo.finance/' + symbol });
    return map;
  } catch (err) {
    recordFailure(hid, err);
    throw err;
  }
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
  const rateHistory = loadStrcRateHistory();
  const officialRate = await recordOfficialStrcRate(rateHistory);
  const { rates: strcRates, sourceOf: strcRateSourceOf, issues: strcRateIssues } =
    mergeStrcRates(rateHistory, config.strcMonthlyRatePct);

  // Every required leg must succeed. A failed/malformed leg throws — the
  // caller falls back to the COMPLETE prior payload and never lets a
  // half-empty rebuild overwrite valid historical legs on disk.
  const [strc, strf, strd, tbill] = await Promise.all([
    fetchYahooDaily('STRC'),
    fetchYahooDaily('STRF'),
    fetchYahooDaily('STRD'),
    fetchFredSeries('DGS1MO').then(m => {
      if (!(m && m.size)) throw new Error('DGS1MO series empty');
      return m;
    })
  ]);

  const sources = {
    'Yahoo STRC': 'ok',
    'Yahoo STRF': strf.size ? 'ok' : 'failed',
    'Yahoo STRD': strd.size ? 'ok' : 'failed',
    'FRED DGS1MO': tbill.size ? 'ok' : 'failed'
  };
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
      rateSource: rate !== null ? strcRateSourceOf[month] : null,
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
    strcRateCoverage: {
      officialMonths: ratedMonths.filter(m => m.rateSource === 'official').length,
      secMonths: ratedMonths.filter(m => m.rateSource === 'sec').length,
      manualMonths: ratedMonths.filter(m => m.rateSource === 'manual').length,
      officialStatus: officialRate.status,
      issues: strcRateIssues
    },
    hikeFailedMonths: monthly.filter(m => m.hikeFailed).length,
    hikeMonths: monthly.filter(m => m.hiked).length,
    sources,
    updatedAt: new Date().toISOString()
  };

  const payload = { points, monthly, summary };

  const degradedLegs = Object.entries(sources).filter(([, s]) => s !== 'ok').map(([k, s]) => `${k}:${s}`);
  recordSuccess('preferreds', {
    dataAsOf: summary.asOf, asOfKind: 'source', source: 'preferreds/build',
    issues: degradedLegs
  });

  const bound = withDataHealth(payload, REQUIRED_IDS);
  try {
    atomicWriteJson(CACHE_FILE, bound, 0);
  } catch (err) {
    console.error('[Preferreds] Failed to save cache:', err.message);
  }
  inMemoryCache = bound;
  lastFetchTime = Date.now();
  return bound;
}

/** Validate actual point rows (numeric values + parseable dates), not just
 * the presence of the arrays. */
function validatePreferredsCache(cached) {
  if (!cached || !Array.isArray(cached.points) || !cached.points.length) return false;
  for (const p of cached.points) {
    if (!p || typeof p.date !== 'string' || isNaN(Date.parse(p.date))) return false;
    if (!Number.isFinite(Number(p.strcClose))) return false;
    for (const k of ['strcVwap20', 'strfClose', 'strdClose', 'juniorSpread']) {
      if (p[k] !== null && p[k] !== undefined && !Number.isFinite(Number(p[k]))) return false;
    }
  }
  if (Array.isArray(cached.monthly)) {
    for (const m of cached.monthly) {
      if (!m || typeof m.month !== 'string') return false;
      if (!Number.isFinite(Number(m.avgPrice))) return false;
    }
  }
  return true;
}

function readCacheFile() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return validatePreferredsCache(cached) ? cached : null;
  } catch (e) {
    return null;
  }
}

const FAILURE_RETRY_MS = 2 * 60 * 1000;
let rebuildInflight = null;
let diskSeeded = false;

/** Seed honest disk clocks once, before the first rebuild attempt. Restore
 * every required source from persisted payload health when present; legacy
 * files seed only the aggregate hint and keep the leaves UNKNOWN. */
function seedDiskOnce(cached) {
  if (diskSeeded || !cached) return;
  diskSeeded = true;
  for (const id of REQUIRED_IDS) {
    seedCachedHealth(cached, id, id === 'preferreds'
      ? { dataAsOf: cached.summary?.asOf || null, lastSuccessAt: cached.summary?.updatedAt || null }
      : {});
  }
}

// 单飞 + 失败退避，与 macro_fetcher 一致
function rebuildOnce() {
  if (!rebuildInflight) {
    recordAttempt('preferreds', { now: Date.now() });
    rebuildInflight = fetchAndBuildPreferreds()
      .catch((err) => {
        recordFailure('preferreds', err);
        lastFetchTime = Date.now() - CACHE_TTL_MS + FAILURE_RETRY_MS;
        throw err;
      })
      .finally(() => { rebuildInflight = null; });
  }
  return rebuildInflight;
}

async function getPreferredsData(forceRefresh = false) {
  if (!inMemoryCache) {
    const cached = readCacheFile();
    if (cached) {
      inMemoryCache = cached;
      seedDiskOnce(cached);
      const age = Date.now() - (Date.parse(cached.summary?.updatedAt) || 0);
      lastFetchTime = Date.now() - Math.min(age, CACHE_TTL_MS);
    }
  }
  if (forceRefresh || !inMemoryCache) {
    try {
      return await rebuildOnce();
    } catch (err) {
      if (!inMemoryCache) throw err;
      console.warn('[Preferreds] Live rebuild failed, serving cached dataset:', err.message);
      return withDataHealth(inMemoryCache, REQUIRED_IDS);
    }
  }
  if (Date.now() - lastFetchTime >= CACHE_TTL_MS) {
    rebuildOnce().catch(e => console.error('[Preferreds] Background refresh failed:', e.message));
  }
  return withDataHealth(inMemoryCache, REQUIRED_IDS);
}

module.exports = {
  getPreferredsData,
  _internal: { recordOfficialStrcRate, recordStrcRateSchedule, mergeStrcRates }
};
