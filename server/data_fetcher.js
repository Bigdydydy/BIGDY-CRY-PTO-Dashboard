const crypto = require('crypto');
const { getXSign } = require('./crypto_signer');
const { recordAndMergeTrades, getCachedTrades } = require('./trade_store');
const { analyzeTermPremium } = require('./term_premium_engine');
const { getGoldCorrelationData } = require('./gold_fetcher');
const { fetchWithTimeout } = require('./http_client');
const { recordAttempt, recordSuccess, recordFailure, summarizeHealth, getSourceHealth } = require('./data_health');
const { withDataHealth } = require('./data_health_cache');

const GREEKS_BASE_URL = 'https://api.greeks.live/api/v1';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Health-tracked upstream source ids (see data_health_policy.js)
const MARKET_SOURCE_IDS = ['greeks_trades', 'greeks_atm', 'greeks_gex', 'greeks_iv_history', 'greeks_skew', 'greeks_smile', 'deribit_dvol', 'gold'];
const REQUIRED_GREEKS = ['greeks_trades', 'greeks_atm', 'greeks_gex', 'greeks_iv_history', 'greeks_skew', 'greeks_smile'];
const HEALTH_SOURCE_IDS = [...MARKET_SOURCE_IDS, 'basis_live', 'basis_history'];

/** Parse a timestamp that may be ms epoch, seconds epoch, or an ISO/date string. */
function tsToMs(ts) {
  if (ts === null || ts === undefined) return null;
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts < 1e12 ? ts * 1000 : ts;
  const ms = new Date(ts).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** A provider timestamp is usable only if it parses and is not far-future. */
function usableSourceTs(ts, nowMs) {
  const ms = tsToMs(ts);
  if (ms === null || ms > nowMs + 5 * 60000) return null;
  return ms;
}

/** Strict numeric check: null/undefined/boolean/blank-string are NOT numbers. */
const isFiniteNum = v =>
  v !== null && v !== undefined &&
  typeof v !== 'boolean' &&
  !(typeof v === 'string' && v.trim() === '') &&
  Number.isFinite(Number(v));
const isPosNum = v => isFiniteNum(v) && Number(v) > 0;

/* ---- Upstream payload validators: a payload failing these is a source
 * failure and must never overwrite the last-good cache. ---- */

function validateBlockTrades(v) {
  if (!Array.isArray(v)) return 'block_trade data 不是数组';
  for (const t of v) {
    if (!t || typeof t !== 'object') return 'trade 不是对象';
    if (typeof t.instrument_name !== 'string' || !t.instrument_name) return '缺 instrument_name';
    const dir = String(t.direction || '').toLowerCase();
    if (dir !== 'buy' && dir !== 'sell') return `非法 direction: ${t.direction}`;
    if (!isPosNum(t.amount)) return 'amount 非正数';
    if (!isPosNum(t.index_price)) return 'index_price 非正数';
    if (!isFiniteNum(t.price) || Number(t.price) < 0) return 'price 为负/非法';
    if (usableSourceTs(t.timestamp, Date.now()) === null) return 'timestamp 无效或未来';
  }
  return null;
}

function validateAtmData(v) {
  if (!Array.isArray(v) || !v.length) return 'atm_data 为空或非数组';
  for (const row of v) {
    if (!row || typeof row !== 'object') return 'atm row 非对象';
    if (!isPosNum(row.underlying_price)) return 'underlying_price 非正数';
    if (!Array.isArray(row.list) || !row.list.length) return 'list 为空';
    const i = row.atm_index;
    if (!Number.isInteger(i) || i < 0 || i >= row.list.length) return 'atm_index 越界';
    if (!isPosNum(row.list[i] && row.list[i].iv)) return 'ATM iv 非有限正数';
  }
  return null;
}

function validateGex(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'gex 非对象';
  if (!isPosNum(v.index_price)) return 'index_price 非正数';
  if (!v.by_expiry || typeof v.by_expiry !== 'object' || Array.isArray(v.by_expiry) || !Object.keys(v.by_expiry).length) return 'by_expiry 为空';
  let validStrikes = 0;
  for (const rows of Object.values(v.by_expiry)) {
    if (!Array.isArray(rows)) return 'by_expiry 条目非数组';
    for (const r of rows) {
      if (!r || !isFiniteNum(r.strike) || !isFiniteNum(r.number)) return 'strike/number 非有限数';
      if (Number(r.strike) > 0) validStrikes++;
    }
  }
  if (!validStrikes) return '无任何 strike>0 的有效档';
  if (usableSourceTs(v.ts, Date.now()) === null) return 'ts 无效或未来';
  return null;
}

function validateIvHistory(v) {
  if (!Array.isArray(v) || !v.length) return 'iv_history 为空或非数组';
  for (const row of v) {
    if (!row || typeof row !== 'object') return 'iv_history row 非对象';
    if (usableSourceTs(row.created_at, Date.now()) === null) return 'created_at 无效或未来';
    for (const k of ['month1', 'month3', 'month6']) {
      if (!isPosNum(row[k])) return `${k} 非有限正数`;
    }
  }
  return null;
}

function validateSkewChart(v) {
  if (!Array.isArray(v) || !v.length) return 'skew_chart 为空或非数组';
  for (const row of v) {
    if (!row || typeof row !== 'object') return 'skew row 非对象';
    if (usableSourceTs(row.timestamps, Date.now()) === null) return 'timestamps 无效或未来';
    if (!isFiniteNum(row.days30)) return 'days30 非有限数';
  }
  return null;
}

function validateSmileMonth(m, label) {
  if (!m || typeof m !== 'object') return `${label} 缺失`;
  if (!isPosNum(m.underlying_price)) return `${label}.underlying_price 非正数`;
  if (!Array.isArray(m.iv_list) || !m.iv_list.length) return `${label}.iv_list 为空`;
  for (const p of m.iv_list) {
    if (!p || !isPosNum(p.strike) || !isPosNum(p.iv)) return `${label}.iv_list 条目 strike/iv 非法`;
  }
  return null;
}

function validateIvSkewMonth(v) {
  if (!v || typeof v !== 'object') return 'iv_skew_month 非对象';
  const err = validateSmileMonth(v.month1, 'month1');
  if (err) return err;
  if (v.month3 !== undefined && v.month3 !== null) return validateSmileMonth(v.month3, 'month3');
  return null;
}

function validateDvolStats(v) {
  if (!v || typeof v !== 'object' || !Array.isArray(v.chrono) || !v.chrono.length) return 'dvol chrono 为空';
  for (const p of v.chrono) {
    if (!p || usableSourceTs(p.ts, Date.now()) === null || !isPosNum(p.dvol)) return 'dvol chrono 条目 ts/dvol 非法';
  }
  return null;
}

// Cache structure tracking data and update status
let dataCache = {
  lastSyncCheckTime: null,
  lastDataChangeTime: null,
  lastSuccessAt: null, // advances ONLY when every required Greeks source truly succeeded
  dataVersion: 1,
  currency: 'BTC',
  blockTrades: [],
  tradeStoreStats: null,
  atmData: null,
  gex: null,
  ivHistory: null,
  skewChart: null,
  ivSkewMonth: null,
  dvolStats: null,
  termPremium: null,
  goldCorrelation: null,
  lastFingerprints: {},
  lastChanges: {
    hasAnyUpdate: false,
    summary: '初始加载完成',
    blockTrades: false,
    newTradesCount: 0,
    gex: false,
    ivHistory: false,
    skewChart: false,
    ivSkewMonth: false,
    priceChanged: false
  }
};

/**
 * Hash generator for change detection
 */
function hashObject(obj) {
  if (!obj) return '';
  return crypto.createHash('md5').update(JSON.stringify(obj)).digest('hex');
}

/**
 * Make signed request to Greeks.live DataLab
 */
async function fetchGreeksDataLab(endpoint, payload) {
  const url = `${GREEKS_BASE_URL}/deribit/datalab/${endpoint}`;
  const xSign = getXSign();
  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      'X-Sign': xSign,
      'Origin': 'https://www.greeks.live',
      'Referer': 'https://www.greeks.live/'
    },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    throw new Error(`Greeks.live DataLab error on ${endpoint}: ${resp.status} ${resp.statusText}`);
  }
  const json = await resp.json();
  if (json.code !== 200 && json.code !== 0) {
    throw new Error(`Greeks.live DataLab error on ${endpoint}: code=${json.code}, msg=${json.msg}`);
  }
  return json.data;
}

/**
 * Fetch raw Block Trades from Greeks.live
 */
async function fetchBlockTrades(currency = 'BTC') {
  const url = `${GREEKS_BASE_URL}/block_trade`;
  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT
    },
    body: JSON.stringify({ currency, kind: 'option' })
  });

  if (!resp.ok) {
    throw new Error(`Greeks.live Block Trade error: ${resp.status}`);
  }
  const json = await resp.json();
  // Envelope must be explicit: an error code or a missing data field is a
  // source failure, never silently converted to an empty array.
  if (json && typeof json === 'object' && 'code' in json && json.code !== 0 && json.code !== 200) {
    throw new Error(`Greeks.live Block Trade error: code=${json.code}, msg=${json.msg}`);
  }
  if (!Array.isArray(json?.data)) {
    throw new Error('Greeks.live Block Trade error: data 字段缺失或非数组');
  }
  // Rows are validated here too so direct callers cannot bypass validation.
  const badRow = validateBlockTrades(json.data);
  if (badRow) throw new Error(`Greeks.live Block Trade error: payload 校验失败: ${badRow}`);
  return json.data;
}

/**
 * Deribit 永续价格，对齐到 DVOL 日线 (同一交易所)，用于估计现货-波动率联动 (偏度实现机制)。
 * DVOL 日线以 00:00 UTC 为界，而永续日线在 08:00 UTC 收盘，直接按日对齐会错开 8 小时；
 * 因此取小时线中 23:00 开盘 (00:00 收盘) 的一根，映射到同一 00:00 收盘的 DVOL 日线；当日未收盘的 DVOL 配最新小时收盘。
 * 只取最近 120 天 (回归窗口 90 天)。返回 Map<DVOL 日起点 ts, close>；失败时返回空 Map，不影响 DVOL 分位
 */
const SPOT_ALIGN_DAYS = 120;
function alignHourlyToDvolDays(ticks, close) {
  const out = new Map();
  ticks.forEach((t, i) => {
    if (!(typeof close[i] === 'number' && close[i] > 0)) return;
    if (new Date(t).getUTCHours() === 23) out.set(t + 3600000 - 86400000, close[i]);
  });
  // 当日 DVOL 日线仍在形成中：配最新一根小时收盘
  const lastIdx = ticks.length - 1;
  if (lastIdx >= 0 && close[lastIdx] > 0) {
    const dayStart = Math.floor(ticks[lastIdx] / 86400000) * 86400000;
    if (!out.has(dayStart)) out.set(dayStart, close[lastIdx]);
  }
  return out;
}

async function fetchPerpetualDailyCloses(currency, startTs, endTs) {
  const empty = { daily: new Map(), hourly: [] };
  try {
    const from = Math.max(startTs, endTs - SPOT_ALIGN_DAYS * 86400000);
    const url = `https://www.deribit.com/api/v2/public/get_tradingview_chart_data?instrument_name=${currency}-PERPETUAL&start_timestamp=${from}&end_timestamp=${endTs}&resolution=60`;
    const resp = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!resp.ok) return empty;
    const json = await resp.json();
    const ticks = json.result?.ticks || [];
    const close = json.result?.close || [];
    const hourly = ticks.map((ts, i) => ({ ts, close: close[i] })).filter(p => isPosNum(p.close));
    return { daily: alignHourlyToDvolDays(ticks, close), hourly };
  } catch (err) {
    console.warn('Failed to fetch perpetual daily closes:', err.message);
  }
  return empty;
}

/** DVOL 小时线 (最近 30 小时)，用于过去 24 小时的波动率变化；失败时返回空数组 */
async function fetchDvolHourly(currency, endTs) {
  try {
    const url = `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=${currency}&start_timestamp=${endTs - 30 * 3600000}&end_timestamp=${endTs}&resolution=3600`;
    const resp = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!resp.ok) return [];
    const json = await resp.json();
    return (json.result?.data || [])
      .filter(d => Array.isArray(d) && Number.isFinite(d[0]) && isPosNum(d[4]))
      .map(d => ({ ts: d[0], close: d[4] }));
  } catch (err) {
    console.warn('Failed to fetch hourly DVOL:', err.message);
    return [];
  }
}

/**
 * 过去 hours 小时的现货与 DVOL 变化：两者各取最新一根小时收盘，与距其 hours 小时最近的一根比较。
 * 任一侧缺少足够样本时返回 null。供做市商"已触发对冲流"估计。
 */
function recentChange(perpHourly, dvolHourly, hours = 24) {
  const pick = series => {
    if (!Array.isArray(series) || series.length < 2) return null;
    const last = series[series.length - 1];
    const target = last.ts - hours * 3600000;
    const then = series.reduce((best, p) => (Math.abs(p.ts - target) < Math.abs(best.ts - target) ? p : best));
    if (Math.abs(then.ts - target) > 2 * 3600000 || then.ts >= last.ts) return null;
    return { now: last.close, then: then.close, nowTs: last.ts, thenTs: then.ts };
  };
  const spot = pick(perpHourly);
  const dvol = pick(dvolHourly);
  if (!spot || !dvol) return null;
  return {
    hours,
    spotNow: spot.now,
    spotThen: spot.then,
    dvolNow: dvol.now,
    dvolThen: dvol.then,
    asOf: new Date(Math.min(spot.nowTs, dvol.nowTs)).toISOString()
  };
}

/**
 * Fetch Deribit DVOL historical statistics
 */
async function fetchDvolHistoricalStats(currency = 'BTC') {
  try {
    const endTs = Date.now();
    const startTs = endTs - 2 * 365 * 24 * 3600 * 1000;
    const url = `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=${currency}&start_timestamp=${startTs}&end_timestamp=${endTs}&resolution=1D`;
    const resp = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!resp.ok) return null;
    const json = await resp.json();
    const data = json.result?.data || [];
    if (!data.length) return null;

    // 原始行先整体验证：坏行不允许被静默过滤成"成功"。
    for (const d of data) {
      if (!Array.isArray(d) || usableSourceTs(d[0], Date.now()) === null || !isPosNum(d[4])) {
        throw new Error('Deribit DVOL row 校验失败 (ts/dvol 非法)');
      }
    }

    // 时间序列 (日线收盘)：最后一根为当日实时值。DVOL 与自身历史比较，避免拿 ATM 去比 VIX 式方差口径
    const chrono = data.map(d => ({ ts: d[0], dvol: d[4] }));
    const [perp, dvolHourly] = await Promise.all([
      fetchPerpetualDailyCloses(currency, startTs, endTs),
      fetchDvolHourly(currency, endTs)
    ]);
    for (const p of chrono) {
      if (perp.daily.has(p.ts)) p.spot = perp.daily.get(p.ts);
    }
    // 过去 24 小时现货与 DVOL 变化 (做市商已触发对冲流)
    const recent24h = recentChange(perp.hourly, dvolHourly, 24);

    const closes = chrono.map(p => p.dvol);
    closes.sort((a, b) => a - b);

    return {
      latest: chrono.length ? chrono[chrono.length - 1].dvol : null,
      chrono,
      recent24h,
      count: closes.length,
      min: closes[0],
      max: closes[closes.length - 1],
      median: closes[Math.floor(closes.length * 0.5)],
      p10: closes[Math.floor(closes.length * 0.1)],
      p25: closes[Math.floor(closes.length * 0.25)],
      p75: closes[Math.floor(closes.length * 0.75)],
      p90: closes[Math.floor(closes.length * 0.9)],
      historicalSeries: closes
    };
  } catch (err) {
    console.warn('Failed to fetch DVOL stats, fallback to standard bounds:', err.message);
    return null;
  }
}

/**
 * Compare new data against fingerprints to detect actual updates
 */
function detectDataChanges(accumulatedTrades, newGex, newIvHistory, newSkewChart, newIvSkewMonth, newAddedTrades = 0, newAtmData = null, hadValidSource = false) {
  const prevFps = dataCache.lastFingerprints;
  const changes = {
    hasAnyUpdate: false,
    blockTrades: false,
    newTradesCount: 0,
    gex: false,
    ivHistory: false,
    atmData: false,
    skewChart: false,
    ivSkewMonth: false,
    priceChanged: false,
    summary: ''
  };

  // 1. Block Trades diff from persistent 60-day store
  if (newAddedTrades > 0) {
    changes.blockTrades = true;
    changes.newTradesCount = newAddedTrades;
    changes.hasAnyUpdate = true;
  }

  // 2. GEX diff
  const gexFp = newGex ? `${newGex.ts}_${newGex.index_price}` : '';
  if (prevFps.gex && prevFps.gex !== gexFp) {
    changes.gex = true;
    changes.hasAnyUpdate = true;
  }

  // Spot Price diff
  const oldPrice = dataCache.gex?.index_price;
  const newPrice = newGex?.index_price;
  if (oldPrice && newPrice && Math.abs(oldPrice - newPrice) >= 0.5) {
    changes.priceChanged = true;
    changes.hasAnyUpdate = true;
  }

  // 3. IV History diff
  const latestIvItem = newIvHistory && newIvHistory.length ? newIvHistory[newIvHistory.length - 1] : null;
  const ivFp = latestIvItem ? `${latestIvItem.created_at}_${latestIvItem.month1}_${latestIvItem.month3}` : '';
  if (prevFps.ivHistory && prevFps.ivHistory !== ivFp) {
    changes.ivHistory = true;
    changes.hasAnyUpdate = true;
  }

  // 4. Real-time ATM IV diff across maturities
  const atmFp = Array.isArray(newAtmData) && newAtmData.length
    ? newAtmData.map(x => `${x.underlying_index}:${(x.list?.[x.atm_index]?.iv || 0).toFixed(2)}`).join('|')
    : '';
  if (prevFps.atmData && prevFps.atmData !== atmFp) {
    changes.atmData = true;
    changes.hasAnyUpdate = true;
  }

  // 5. Skew Chart diff
  const latestSkewItem = newSkewChart && newSkewChart.length ? newSkewChart[newSkewChart.length - 1] : null;
  const skewFp = latestSkewItem ? `${latestSkewItem.timestamps}_${latestSkewItem.days30}_${latestSkewItem.day1}` : '';
  if (prevFps.skewChart && prevFps.skewChart !== skewFp) {
    changes.skewChart = true;
    changes.hasAnyUpdate = true;
  }

  // 6. IV Skew Month (Smile) diff
  const smileFp = newIvSkewMonth?.month1 ? `${newIvSkewMonth.month1.underlying_price}_${newIvSkewMonth.month1.iv_list?.length}` : '';
  if (prevFps.ivSkewMonth && prevFps.ivSkewMonth !== smileFp) {
    changes.ivSkewMonth = true;
    changes.hasAnyUpdate = true;
  }

  // Initial load check: only real, valid upstream data may trigger the
  // initial-load transition; an all-failed first poll is not "ready".
  if (!dataCache.lastDataChangeTime && hadValidSource) {
    changes.hasAnyUpdate = true;
    changes.summary = '初始数据加载完成';
  } else if (changes.hasAnyUpdate) {
    const parts = [];
    if (changes.blockTrades) parts.push(`新增 ${changes.newTradesCount} 笔大宗成交并持久沉淀`);
    if (changes.priceChanged) parts.push(`现货更新至 $${Math.round(newPrice).toLocaleString()}`);
    if (changes.gex) parts.push('GEX 敞口更新');
    if (changes.atmData || changes.ivHistory) parts.push('ATM IV 期限结构变动');
    if (changes.skewChart) parts.push('25Δ 偏度更新');
    if (changes.ivSkewMonth) parts.push('微笑曲线更新');
    changes.summary = `检测到新变动: ${parts.join('、')}，所有量化模块已全量重新研判`;
  } else {
    changes.summary = hadValidSource
      ? '本次校验未发现新变动'
      : '本轮未获取到有效上游数据，沿用最近缓存';
  }

  // Store new fingerprints
  dataCache.lastFingerprints = {
    gex: gexFp,
    ivHistory: ivFp,
    atmData: atmFp,
    skewChart: skewFp,
    ivSkewMonth: smileFp
  };

  return changes;
}

/**
 * Max accepted clock skew for provider timestamps (matches data_health).
 */
const SOURCE_TS_MAX_FUTURE_MS = 5 * 60000;

let refreshInflight = null;

/**
 * Refresh all market data, verify updates, and trigger re-analysis.
 * Single-flight: concurrent callers share one in-flight refresh so duplicate
 * requests never double-hit upstream.
 */
function refreshAllMarketData(currency = 'BTC') {
  if (refreshInflight) return refreshInflight;
  refreshInflight = doRefreshAllMarketData(currency)
    .finally(() => { refreshInflight = null; });
  return refreshInflight;
}

/**
 * Provider-clocked sources: an absent/invalid/far-future provider timestamp is
 * a SOURCE FAILURE — it must never be silently replaced with receipt time.
 * Returns null on unusable timestamps; callers record failure and preserve
 * cache. (Only sources with no provider clock — trades/atm/smile — may stamp
 * explicit asOfKind 'received'.)
 */
function providerAsOf(candidateTs, receiptMs) {
  const ms = usableSourceTs(candidateTs, receiptMs);
  if (ms === null) return null;
  return { dataAsOf: new Date(ms).toISOString(), asOfKind: 'source', issues: [] };
}

// DVOL 统计是 2 年日线 + 120 天永续小时线 + 30 小时 DVOL，日内变化很慢：
// 成功后 10 分钟内的刷新轮次直接沿用 (策略窗口 30 分钟预警，不受影响)。
const DVOL_REFRESH_MS = 10 * 60 * 1000;
let lastDvolSuccessMs = 0;

async function doRefreshAllMarketData(currency) {
  const checkTime = new Date().toISOString();
  const attemptMs = Date.now();
  console.log(`[DataFetcher] Checking & refreshing market data for ${currency} at ${checkTime}...`);

  // Every real upstream call is tracked: attempt recorded immediately before
  // invocation; rejection/invalid payload recorded as failure with last-good
  // cache preserved.
  const callSrc = (id, fn) => { recordAttempt(id, { now: attemptMs }); return fn(); };
  // A source counts as fresh THIS round only if its receipt actually changed
  // during the round — an identical lastSuccessAt from a previous round
  // (identical-ms stamps are possible) must not pass as a new success.
  const prevReceipt = {};
  for (const id of ['basis_live', 'basis_history', ...MARKET_SOURCE_IDS]) {
    prevReceipt[id] = getSourceHealth(id, attemptMs).lastSuccessAt || null;
  }
  const dvolReused = !!dataCache.dvolStats && attemptMs - lastDvolSuccessMs < DVOL_REFRESH_MS;
  const [
    blockTradesRes,
    atmDataRes,
    gexRes,
    ivHistoryRes,
    skewChartRes,
    ivSkewMonthRes,
    dvolStatsRes,
    goldRes
  ] = await Promise.allSettled([
    callSrc('greeks_trades', () => fetchBlockTrades(currency)),
    callSrc('greeks_atm', () => fetchGreeksDataLab('atm_data', { currency })),
    callSrc('greeks_gex', () => fetchGreeksDataLab('gex', { currency })),
    callSrc('greeks_iv_history', () => fetchGreeksDataLab('iv_history', { currency, gap: '1d' })),
    callSrc('greeks_skew', () => fetchGreeksDataLab('skew_chart', { currency, gap: '1d' })),
    callSrc('greeks_smile', () => fetchGreeksDataLab('iv_skew_month', { currency })),
    dvolReused
      ? Promise.resolve(dataCache.dvolStats)
      : callSrc('deribit_dvol', () => fetchDvolHistoricalStats(currency)),
    // gold is leaf-instrumented: it records its own attempt/success/failure,
    // so no central attempt is recorded here.
    getGoldCorrelationData()
  ]);

  const receiptMs = Date.now();
  const receiptIso = new Date(receiptMs).toISOString();
  const succeeded = [];      // verified-fresh upstream successes (market ids)
  const failedSources = [];  // rejected / invalid payloads
  const unverified = [];     // returned something we cannot prove fresh (e.g. cache hit)
  const failSrc = (id, err) => { recordFailure(id, err); failedSources.push(id); };
  const okSrc = (id, asOf, source, extraIssues = []) => {
    recordSuccess(id, { dataAsOf: asOf.dataAsOf, asOfKind: asOf.asOfKind, source, issues: [...(asOf.issues || []), ...extraIssues] });
    succeeded.push(id);
  };

  // --- greeks_trades: an empty array IS a legitimate confirmed poll; its
  // timestamp is our receipt time, never a fabricated provider time.
  let accumulatedTrades = dataCache.blockTrades;
  let tradeStats = dataCache.tradeStoreStats;
  let newAddedTrades = 0;
  if (blockTradesRes.status === 'fulfilled') {
    const bad = validateBlockTrades(blockTradesRes.value);
    if (bad) {
      failSrc('greeks_trades', new Error(`block_trade payload 校验失败: ${bad}`));
      if (!accumulatedTrades.length) accumulatedTrades = getCachedTrades(currency);
    } else {
      okSrc('greeks_trades', { dataAsOf: receiptIso, asOfKind: 'received' }, 'greeks.live/block_trade');
      const mergeResult = recordAndMergeTrades(currency, blockTradesRes.value);
      accumulatedTrades = mergeResult.trades;
      tradeStats = mergeResult.stats;
      newAddedTrades = tradeStats.newAddedCount;
    }
  } else {
    failSrc('greeks_trades', blockTradesRes.reason);
    if (!accumulatedTrades.length) accumulatedTrades = getCachedTrades(currency);
  }

  // --- greeks_atm: no publisher timestamp on the matrix -> receipt time.
  let newAtmData = dataCache.atmData;
  if (atmDataRes.status === 'fulfilled') {
    const bad = validateAtmData(atmDataRes.value);
    if (bad) failSrc('greeks_atm', new Error(`atm_data payload 校验失败: ${bad}`));
    else {
      okSrc('greeks_atm', { dataAsOf: receiptIso, asOfKind: 'received' }, 'greeks.live/datalab/atm_data');
      newAtmData = atmDataRes.value;
    }
  } else failSrc('greeks_atm', atmDataRes.reason);

  // --- greeks_gex: provider ts (seconds tolerated).
  let newGex = dataCache.gex;
  if (gexRes.status === 'fulfilled') {
    const bad = validateGex(gexRes.value);
    if (bad) failSrc('greeks_gex', new Error(`gex payload 校验失败: ${bad}`));
    else {
      const asOf = providerAsOf(gexRes.value.ts, receiptMs);
      if (!asOf) failSrc('greeks_gex', new Error('gex provider ts 无效或未来'));
      else {
        okSrc('greeks_gex', asOf, 'greeks.live/datalab/gex');
        newGex = gexRes.value;
      }
    }
  } else failSrc('greeks_gex', gexRes.reason);

  // --- greeks_iv_history: max created_at across rows.
  let newIvHistory = dataCache.ivHistory;
  if (ivHistoryRes.status === 'fulfilled') {
    const bad = validateIvHistory(ivHistoryRes.value);
    if (bad) failSrc('greeks_iv_history', new Error(`iv_history payload 校验失败: ${bad}`));
    else {
      let maxTs = null;
      for (const row of ivHistoryRes.value) {
        const ms = tsToMs(row.created_at);
        if (ms !== null && (maxTs === null || ms > maxTs)) maxTs = ms;
      }
      const asOf = providerAsOf(maxTs, receiptMs);
      if (!asOf) failSrc('greeks_iv_history', new Error('iv_history provider ts 无效或未来'));
      else {
        okSrc('greeks_iv_history', asOf, 'greeks.live/datalab/iv_history');
        newIvHistory = ivHistoryRes.value;
      }
    }
  } else failSrc('greeks_iv_history', ivHistoryRes.reason);

  // --- greeks_skew: max timestamps across rows.
  let newSkewChart = dataCache.skewChart;
  if (skewChartRes.status === 'fulfilled') {
    const bad = validateSkewChart(skewChartRes.value);
    if (bad) failSrc('greeks_skew', new Error(`skew_chart payload 校验失败: ${bad}`));
    else {
      let maxTs = null;
      for (const row of skewChartRes.value) {
        const ms = tsToMs(row.timestamps);
        if (ms !== null && (maxTs === null || ms > maxTs)) maxTs = ms;
      }
      const asOf = providerAsOf(maxTs, receiptMs);
      if (!asOf) failSrc('greeks_skew', new Error('skew provider ts 无效或未来'));
      else {
        okSrc('greeks_skew', asOf, 'greeks.live/datalab/skew_chart');
        newSkewChart = skewChartRes.value;
      }
    }
  } else failSrc('greeks_skew', skewChartRes.reason);

  // --- greeks_smile: no publisher timestamp -> receipt time.
  let newIvSkewMonth = dataCache.ivSkewMonth;
  if (ivSkewMonthRes.status === 'fulfilled') {
    const bad = validateIvSkewMonth(ivSkewMonthRes.value);
    if (bad) failSrc('greeks_smile', new Error(`iv_skew_month payload 校验失败: ${bad}`));
    else {
      okSrc('greeks_smile', { dataAsOf: receiptIso, asOfKind: 'received' }, 'greeks.live/datalab/iv_skew_month');
      newIvSkewMonth = ivSkewMonthRes.value;
    }
  } else failSrc('greeks_smile', ivSkewMonthRes.reason);

  // --- deribit_dvol: latest chrono point; null payload is a failure.
  if (dvolReused) {
    // reused within DVOL_REFRESH_MS: no new receipt, no new failure
  } else if (dvolStatsRes.status === 'fulfilled') {
    const bad = validateDvolStats(dvolStatsRes.value);
    if (bad) failSrc('deribit_dvol', new Error(`dvol payload 校验失败: ${bad}`));
    else {
      let maxTs = null;
      for (const p of dvolStatsRes.value.chrono) {
        const ms = tsToMs(p.ts);
        if (ms !== null && (maxTs === null || ms > maxTs)) maxTs = ms;
      }
      const asOf = providerAsOf(maxTs, receiptMs);
      if (!asOf) failSrc('deribit_dvol', new Error('dvol provider ts 无效或未来'));
      else {
        okSrc('deribit_dvol', asOf, 'deribit/volatility_index');
        dataCache.dvolStats = dvolStatsRes.value;
        lastDvolSuccessMs = attemptMs;
      }
    }
  } else failSrc('deribit_dvol', dvolStatsRes.reason);

  // No hardcoded spot fallback: a missing real spot stays null and analyses
  // that need it are gated on source health, never fed a fabricated price.
  const spotPrice = newGex?.index_price ?? null;

  // --- Term premium / basis: leaf-instrumented in basis_fetcher, which records
  // its own attempt/success/failure on REAL upstream calls. Here we only
  // classify what this round did from the registry (a disk/cache read never
  // counts as fresh, a missing clock is never green).
  try {
    const tp = await analyzeTermPremium([], spotPrice);
    // termPremium dataHealth is bound to the full basis chain, including the
    // FRED DGS3MO hurdle leg — a defaulted T-Bill is a degraded input, not a
    // clean success.
    dataCache.termPremium = withDataHealth(tp, ['basis_live', 'basis_history', 'fred:DGS3MO']);
    const feed = tp?.metadata?.feed || {};
    const blh = getSourceHealth('basis_live', Date.now());
    const liveFresh = !!(blh.lastSuccessAt && blh.lastSuccessAt !== prevReceipt.basis_live);
    if (feed.liveOk && liveFresh) {
      succeeded.push('basis_live');
    } else if (feed.liveError || !blh.usable) {
      failedSources.push('basis_live');
    } else {
      unverified.push('basis_live'); // TTL cache hit — real but not re-verified
    }
    const bhh = getSourceHealth('basis_history', Date.now());
    if (!bhh.usable) failedSources.push('basis_history');
    else if (!bhh.lastSuccessAt || bhh.lastSuccessAt === prevReceipt.basis_history) {
      unverified.push('basis_history'); // valid disk/history reuse, not rebuilt this round
    }
  } catch (err) {
    console.warn('[DataFetcher] Term Premium analysis error:', err.message);
    recordFailure('basis_live', err);
    failedSources.push('basis_live');
  }

  // --- Gold: leaf-instrumented in gold_fetcher. Classify this round from the
  // registry: fresh success / usable fallback (cache or disk) / unavailable.
  if (goldRes.status === 'fulfilled' && goldRes.value && typeof goldRes.value === 'object') {
    dataCache.goldCorrelation = goldRes.value;
    const gh = getSourceHealth('gold', Date.now());
    if (gh.lastSuccessAt && gh.lastSuccessAt !== prevReceipt.gold) {
      succeeded.push('gold');
    } else if (gh.usable || !gh.lastError) {
      // Fallback copy served (usable), or the leaf returned a payload with no
      // verifiable clock at all (e.g. a pure cache hit): unverified, not failed.
      unverified.push('gold');
    } else {
      failedSources.push('gold');
    }
  } else if (goldRes.status === 'rejected') {
    failedSources.push('gold'); // leaf already recorded the failure
  } else {
    failedSources.push('gold');
  }

  // Run change detection with persistent trade store additions and real-time ATM data.
  // hadValidSource: only real valid upstream data may trigger the initial-load transition.
  const hadValidSource = succeeded.length > 0;
  const changeReport = detectDataChanges(accumulatedTrades, newGex, newIvHistory, newSkewChart, newIvSkewMonth, newAddedTrades, newAtmData, hadValidSource);

  // Update in-memory data (each field already kept last-good on failure above)
  dataCache.blockTrades = accumulatedTrades;
  dataCache.tradeStoreStats = tradeStats;
  dataCache.gex = newGex;
  dataCache.ivHistory = newIvHistory;
  dataCache.skewChart = newSkewChart;
  dataCache.ivSkewMonth = newIvSkewMonth;
  dataCache.atmData = newAtmData;

  // lastSyncCheckTime = real completion time of this check (an attempt, not a success).
  const completionIso = new Date().toISOString();
  dataCache.lastSyncCheckTime = completionIso;
  // lastSuccessfulRefreshTime advances only when EVERY health-tracked source is
  // usable AND every live source actually succeeded THIS round. Round success
  // is tallied from the registry (leaf-instrumented sources record there too).
  const healthNow = summarizeHealth(HEALTH_SOURCE_IDS);
  const roundFreshOk = id => {
    const h = getSourceHealth(id);
    return !!(h.lastSuccessAt && h.lastSuccessAt !== prevReceipt[id]);
  };
  // A DVOL round reused inside DVOL_REFRESH_MS is not a failure: its own
  // health window still governs usability via healthNow below.
  const liveRoundOk = [...MARKET_SOURCE_IDS.filter(id => !(dvolReused && id === 'deribit_dvol')), 'basis_live'].every(roundFreshOk);
  if (liveRoundOk && healthNow.analysisAllowed) dataCache.lastSuccessAt = completionIso;

  // Truthful summary: failure/degradation first, never "all verified" on failure.
  const total = MARKET_SOURCE_IDS.length;
  const marketOk = succeeded.filter(id => MARKET_SOURCE_IDS.includes(id));
  let statusLine;
  if (!marketOk.length && !unverified.filter(id => MARKET_SOURCE_IDS.includes(id)).length) {
    statusLine = `数据同步失败：${total} 个上游源全部不可用，沿用最近缓存`;
  } else if (failedSources.length || unverified.length) {
    const parts = [`数据同步部分降级：${marketOk.length}/${total} 个上游源成功`];
    if (failedSources.length) parts.push(`失败源 ${failedSources.join('、')} 沿用缓存`);
    if (unverified.length) parts.push(`未验证 ${unverified.join('、')}`);
    statusLine = parts.join('，');
  } else {
    statusLine = `数据同步完成：${total} 个上游源全部成功`;
  }
  changeReport.summary = changeReport.summary ? `${statusLine}；${changeReport.summary}` : statusLine;
  dataCache.lastChanges = changeReport;

  if (changeReport.hasAnyUpdate) {
    dataCache.lastDataChangeTime = completionIso;
    dataCache.dataVersion += 1;
    console.log(`[DataFetcher] ⚡ New data detected! Incrementing dataVersion to ${dataCache.dataVersion}. Summary: ${changeReport.summary}`);
  } else {
    console.log(`[DataFetcher] ✓ No new changes detected. Maintained at dataVersion ${dataCache.dataVersion}. (Stored: ${accumulatedTrades.length} trades)`);
  }

  return {
    hasAnyUpdate: changeReport.hasAnyUpdate,
    dataVersion: dataCache.dataVersion,
    summary: changeReport.summary,
    changes: changeReport,
    lastSyncCheckTime: dataCache.lastSyncCheckTime,
    lastDataChangeTime: dataCache.lastDataChangeTime,
    lastSuccessAt: dataCache.lastSuccessAt,
    dataHealth: healthNow,
    succeededSources: succeeded.slice(),
    failedSources: failedSources.slice(),
    unverifiedSources: unverified.slice()
  };
}

function getCachedData() {
  // Health is computed live so expiry progresses between refreshes.
  dataCache.sourceHealth = summarizeHealth(HEALTH_SOURCE_IDS);
  return dataCache;
}

module.exports = {
  refreshAllMarketData,
  fetchDvolHistoricalStats,
  alignHourlyToDvolDays,
  recentChange,
  getCachedData,
  fetchBlockTrades,
  MARKET_SOURCE_IDS,
  _internal: { expireDvolReuse: () => { lastDvolSuccessMs = 0; } }
};
