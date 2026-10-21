const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const zlib = require('zlib');
const crypto = require('crypto');
const { refreshAllMarketData, getCachedData } = require('./data_fetcher');
const {
  summarizeHealth, deriveSourceHealth, getSourceHealth,
  recordAttempt, recordSuccess, recordFailure, seedSource
} = require('./data_health');
const { fetchWithTimeout } = require('./http_client');
const { filterTradesByWindow } = require('./trade_store');
const {
  analyzeAtmIv,
  analyzeDynamicGex,
  analyzeBlockTrades,
  analyzeIvSmile,
  analyze25DeltaSkew,
  buildForwardsMap
} = require('./analytics_engine');
const { getMacroChartData } = require('./macro_fetcher');
const { getPreferredsData } = require('./mstr_preferreds');
const { fetchCdriData } = require('./cdri_fetcher');
const { getSsroData } = require('./ssro_fetcher');
const { getFlowForce } = require('./flow_force');
const { getCoinbaseLiquidityData } = require('./coinbase_fetcher');
const liquidityHistory = require('./liquidity_history');
const { getGoldCorrelationData } = require('./gold_fetcher');
const { getMcClellanData } = require('./crypto_mcclellan_fetcher');
const { getSystemAuditData } = require('./audit_engine');
const { getEtfLinkageData } = require('./etf_linkage_engine');
const { getTermCurve } = require('./term_curve');
const { getHistoricalBasisData } = require('./basis_fetcher');
const { getOptionMarks, pickInstruments, fetchBookSummaryRows } = require('./option_marks');
const optionOiHistory = require('./option_oi_history');
const blockInsight = require('./block_insight');
const volSurfaceHistory = require('./vol_surface_history');
const { analyzeDealerExposure } = require('./dealer_engine');
const optionFlowLedger = require('./option_flow_ledger');
const dealerHistory = require('./dealer_history');
const { getMstrDisclosures, POLL_MS: MSTR_DISCLOSURE_POLL_MS } = require('./mstr_disclosures');

/**
 * Coinbase ±200bps 盘口深度 (Module 6 的缓存)，用于对冲流量级对比；最多等 2.5 秒，取不到时返回 null
 */
async function coinbaseDepthForDealer() {
  try {
    const cb = await Promise.race([
      getCoinbaseLiquidityData(false),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2500))
    ]);
    const tier = cb?.depthProfile?.[200];
    if (!tier || !(tier.bidUsd > 0) || !(tier.askUsd > 0)) return null;
    return { venue: 'Coinbase', band: '±2%', bidUsd: tier.bidUsd, askUsd: tier.askUsd, asOf: cb.timestamp ? new Date(cb.timestamp).toISOString() : null };
  } catch (err) {
    return null;
  }
}
const { analyzeWaves, evaluateUserCount, evaluateUserSketch, USER_TOOLS } = require('./wave_engine');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const WAVE_ENGINE_FILE = path.join(__dirname, 'wave_engine.js');

/**
 * Parse JSON request body helper
 */
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) {
        req.destroy();
        reject(new Error('Payload too large (limit 1MB)'));
      }
    });
    req.on('end', () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        resolve(parsed);
      } catch (e) {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

// Rate limiting & Single-flight locks
const refreshRateLimitMap = new Map();
let activeRefreshPromise = null;

// ---------------------------------------------------------------------------
// Phase 3A — truthful per-analysis health gates
// ---------------------------------------------------------------------------

/** Required upstream sources per market-data analysis section. */
const ANALYSIS_REQUIREMENTS = {
  atmIv: ['greeks_atm', 'greeks_iv_history', 'deribit_dvol'],
  gex: ['greeks_gex'],
  blockTrades: ['greeks_trades', 'greeks_gex'],
  ivSmile: ['greeks_smile', 'greeks_gex'],
  delta25Skew: ['greeks_skew', 'greeks_atm', 'greeks_iv_history', 'deribit_dvol'],
  termPremium: ['basis_live', 'basis_history', 'fred:DGS3MO']
};

// The vol-surface daily archive is built from every input the analyses consume.
const VOL_SURFACE_REQUIRED = [
  'greeks_atm', 'greeks_iv_history', 'deribit_dvol',
  'greeks_smile', 'greeks_gex', 'greeks_skew'
];

const DATA_UNAVAILABLE_TEXT = '数据过期或不可用，暂停当前研判';

/**
 * Truthful replacement for a blocked analysis: the analyzer is never called,
 * conclusions are never emitted, and the raw historical input (if any) is kept
 * for browsing — explicitly marked historicalOnly.
 */
function unavailableAnalysis(health, historical) {
  const out = {
    status: 'data_unavailable',
    summaryText: DATA_UNAVAILABLE_TEXT,
    dataHealth: health,
    historicalOnly: true
  };
  if (historical !== undefined && historical !== null) out.historical = historical;
  return out;
}

/**
 * Attach/repair health on a module payload before it goes over the wire:
 * keeps the payload's own dataHealth when present, falls back to a live
 * registry summary for `requiredIds`, and flags the response historicalOnly
 * whenever current-conclusion inputs are not usable.
 */
function withApiHealth(payload, requiredIds = []) {
  const out = payload && typeof payload === 'object' ? { ...payload } : {};
  if (!out.dataHealth && requiredIds.length) {
    out.dataHealth = summarizeHealth(requiredIds);
  }
  out.historicalOnly = out.historicalOnly === true ||
    !!(out.dataHealth && out.dataHealth.analysisAllowed === false);
  // An explicit history-only payload must not be revived as a live conclusion
  // even when the bound health is still usable: demote the wire health on a
  // shallow clone — the caller's dataHealth object is never mutated.
  if (out.historicalOnly && out.dataHealth && out.dataHealth.analysisAllowed !== false) {
    const demoted = { ...out.dataHealth, analysisAllowed: false };
    if (demoted.state === 'OK') demoted.state = 'DEGRADED';
    out.dataHealth = demoted;
  }
  return out;
}

// 按需刷新: 记录最近一次 API 访问；无人访问时暂停定时拉取外部行情
const IDLE_PAUSE_MS = 5 * 60 * 1000;
const MARKET_REFRESH_MS = 30000;
let lastApiActivity = 0;
let lastMarketRefreshAt = 0;
let marketRefreshInflight = null;
let backgroundRefreshEnabled = false; // 仅 startServer() 启动的常驻服务才做后台刷新 (测试中引入模块不触发外部请求)

function refreshMarketInBackground() {
  if (marketRefreshInflight) return marketRefreshInflight;
  marketRefreshInflight = refreshAllMarketData('BTC')
    .catch(e => console.warn('[Server] Background sync check error:', e.message))
    .finally(() => {
      lastMarketRefreshAt = Date.now();
      marketRefreshInflight = null;
    });
  return marketRefreshInflight;
}

/** 空闲后的第一次访问立即在后台补一次刷新 (不阻塞本次响应) */
function noteApiActivity() {
  const now = Date.now();
  const wasIdle = now - lastApiActivity > IDLE_PAUSE_MS;
  lastApiActivity = now;
  if (backgroundRefreshEnabled && wasIdle && now - lastMarketRefreshAt > MARKET_REFRESH_MS) refreshMarketInBackground();
}

function isServerIdle() {
  return Date.now() - lastApiActivity > IDLE_PAUSE_MS;
}

// Wave Engine API Rate Limiting & Kline Cache
const waveRateLimitMap = new Map();
const waveKlineCache = new Map();

// Module 8 波浪引擎支持的研判周期，严格限定为 15m / 1h / 4h (方案 B 主路径)
const WAVE_INTERVALS = ['15m', '1h', '4h'];
// 浏览器端研判所需的高周期背景 (仅限少量根数)
const WAVE_AUX_INTERVALS = ['1d', '1w'];
const WAVE_AUX_MAX_BARS = 500;
// 子浪判定的最细周期 (1H 上画的浪用 5m 判子浪)：只作K线源，不作研判周期
const WAVE_SUB_ONLY_INTERVALS = ['5m'];
const WAVE_SUB_INTERVALS = {
  '15m': [],
  '1h': ['15m'],
  '4h': ['1h', '15m']
};
// 画浪评估的子浪判定周期 (由细到粗)：4H 画浪 → 15m 子浪，覆盖不足时退至 1h
const WAVE_USER_SUB_INTERVALS = {
  '15m': ['5m'],
  '1h': ['15m', '5m'],
  '4h': ['15m', '1h']
};
const WAVE_TF_SEC = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14400 };
const WAVE_HTF_INTERVALS = {
  '15m': ['1h', '4h'],
  '1h': ['4h', '1d'],
  '4h': ['1d', '1w']
};

function checkWaveRateLimit(clientIp) {
  const now = Date.now();
  const windowMs = 60000;
  if (waveRateLimitMap.size > 2000) {
    for (const [ip, ts] of waveRateLimitMap) {
      if (!ts.length || now - ts[ts.length - 1] >= windowMs) waveRateLimitMap.delete(ip);
    }
  }
  const maxReq = 20; // Max 20 requests per minute per IP
  let timestamps = waveRateLimitMap.get(clientIp) || [];
  timestamps = timestamps.filter(t => now - t < windowMs);
  if (timestamps.length >= maxReq) {
    waveRateLimitMap.set(clientIp, timestamps);
    return false;
  }
  timestamps.push(now);
  waveRateLimitMap.set(clientIp, timestamps);
  return true;
}

// 主图 K 线上限: 币安单次最多 1500 (合约) / 1000 (现货)，超过则按 endTime 向前分页拼接
const WAVE_MAX_BARS = 10000;
const waveKlineInflight = new Map();

const KLINE_SEC = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800 };

/** 币安格式的一页K线: [[openTimeMs, o, h, l, c, v], ...] (升序) */
function binanceSource(name, base, pageMax) {
  return {
    name, pageMax,
    async page(symbol, interval, limit, endTimeMs) {
      const url = `${base}?symbol=${symbol}&interval=${interval}&limit=${limit}${endTimeMs ? `&endTime=${endTimeMs}` : ''}`;
      // One 8s budget per source page, no retries: 5 fallback sources must all
      // fit inside the browser's 45s fetch timeout.
      const response = await fetchWithTimeout(url, {
        timeout: 8000,
        retries: 0,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const rows = await response.json();
      if (!Array.isArray(rows)) throw new Error('非数组响应');
      return rows;
    }
  };
}

// 币安在部分云服务器出口 IP 上会限流 / 拒绝 (Render 共享出口)：备用 Bybit、OKX 的 USDT 永续K线
const BYBIT_INTERVAL = { '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D', '1w': 'W' };
const bybitSource = {
  name: 'Bybit 永续', pageMax: 1000, maxPages: 10,
  async page(symbol, interval, limit, endTimeMs) {
    const iv = BYBIT_INTERVAL[interval];
    if (!iv) throw new Error(`不支持 ${interval}`);
    const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${iv}&limit=${limit}${endTimeMs ? `&end=${endTimeMs}` : ''}`;
    const response = await fetchWithTimeout(url, { timeout: 8000, retries: 0 });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    if (!json || json.retCode !== 0 || !json.result || !Array.isArray(json.result.list)) throw new Error(`retCode ${json && json.retCode}`);
    // Bybit returns newest-first: reverse BEFORE validation so timestamps ascend.
    return json.result.list.map(r => [+r[0], r[1], r[2], r[3], r[4], r[5]]).reverse();
  }
};
const OKX_INTERVAL = { '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1Dutc', '1w': '1Wutc' };
const okxSource = {
  name: 'OKX 永续', pageMax: 100, maxPages: 30,
  async page(symbol, interval, limit, endTimeMs) {
    const bar = OKX_INTERVAL[interval];
    if (!bar) throw new Error(`不支持 ${interval}`);
    const instId = symbol.replace(/USDT$/, '-USDT-SWAP');
    // after = 返回早于该时间戳的K线 (向前分页)
    const url = `https://www.okx.com/api/v5/market/history-candles?instId=${instId}&bar=${bar}&limit=${limit}${endTimeMs ? `&after=${endTimeMs + 1}` : ''}`;
    const response = await fetchWithTimeout(url, { timeout: 8000, retries: 0 });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    if (!json || json.code !== '0' || !Array.isArray(json.data)) throw new Error(`code ${json && json.code}`);
    // OKX returns newest-first: reverse BEFORE validation so timestamps ascend.
    return json.data.map(r => [+r[0], r[1], r[2], r[3], r[4], r[5]]).reverse();
  }
};

const KLINE_SOURCES = [
  binanceSource('币安合约', 'https://fapi.binance.com/fapi/v1/klines', 1500),
  binanceSource('币安现货镜像', 'https://data-api.binance.vision/api/v3/klines', 1000),
  binanceSource('币安现货', 'https://api.binance.com/api/v3/klines', 1000),
  bybitSource,
  okxSource
];

/**
 * Strict raw kline row validation, run BEFORE any row enters memory or cache.
 * Rows are `[[t, o, h, l, c, v, ...], ...]` in ascending time order (Bybit/OKX
 * pages are already reversed by their source adapters). Any bad row fails the
 * whole source — NaN/malformed data is never silently filtered into a cache.
 */
function validateKlineRows(rows) {
  if (!Array.isArray(rows)) return '非数组K线';
  const maxFuture = Date.now() + 5 * 60000;
  let prevT = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!Array.isArray(r) || r.length < 6) return `第${i}行格式非法`;
    // Strict numeric read: null / '' / booleans must not coerce to a fake 0/1.
    const strictNum = x => (x === null || x === undefined || typeof x === 'boolean' ||
      (typeof x === 'string' && x.trim() === '')) ? NaN : Number(x);
    const t = strictNum(r[0]);
    const o = strictNum(r[1]);
    const h = strictNum(r[2]);
    const l = strictNum(r[3]);
    const c = strictNum(r[4]);
    const v = strictNum(r[5]);
    if (![t, o, h, l, c, v].every(Number.isFinite)) return `第${i}行含非有限值`;
    if (t <= 0) return `第${i}行时间戳非法`;
    if (o <= 0 || h <= 0 || l <= 0 || c <= 0) return `第${i}行OHLC非正`;
    if (h < Math.max(o, c, l) || l > Math.min(o, c, h)) return `第${i}行OHLC不自洽`;
    if (v < 0) return `第${i}行volume为负`;
    if (t > maxFuture) return `第${i}行是未来K线`;
    if (prevT !== null && t <= prevT) return `第${i}行时间戳非升序`;
    prevT = t;
  }
  return null;
}

/** 从一个源按 endTime 向前分页拼接最新的 limit 根 (备用源有页数上限，可能少于 limit) */
async function fetchKlinePages(source, symbol, interval, limit) {
  const rows = [];
  let endTime = null, pages = 0;
  while (rows.length < limit && (!source.maxPages || pages < source.maxPages)) {
    const pageLimit = Math.min(source.pageMax, limit - rows.length);
    let page;
    try {
      page = await source.page(symbol, interval, pageLimit, endTime);
    } catch (e) {
      if (!rows.length) throw e;
      break; // 网络类失败且已拿到较新数据: 已收集部分仍可用
    }
    // A malformed page makes the WHOLE source untrustworthy — try the next
    // source rather than splicing bad rows into the cache.
    const bad = validateKlineRows(page);
    if (bad) throw new Error(`${source.name} K线校验失败: ${bad}`);
    pages++;
    if (!page.length) break;
    rows.unshift(...page);
    if (page.length < pageLimit) break; // 已到上市首日
    endTime = page[0][0] - 1;
  }
  return rows;
}

function rowsToBars(rows) {
  return rows.map(b => ({
    time: Math.floor(b[0] / 1000),
    open: parseFloat(b[1]),
    high: parseFloat(b[2]),
    low: parseFloat(b[3]),
    close: parseFloat(b[4]),
    volume: parseFloat(b[5])
  }));
}

// 缓存只按固定档位存放，避免 ?limit= 任意取值造成缓存键无限增长
const KLINE_TIERS = [200, 1000, WAVE_MAX_BARS];
const KLINE_FRESH_MS = 120000;

async function fetchBinanceKlines(symbol, interval = '4h', limit = 1000) {
  limit = Math.max(1, Math.min(WAVE_MAX_BARS, parseInt(limit, 10) || 1000));
  const tier = KLINE_TIERS.find(t => t >= limit) || WAVE_MAX_BARS;
  const bars = await fetchKlineTier(symbol, interval, tier);
  return bars.length > limit ? bars.slice(bars.length - limit) : bars;
}

/** 依次尝试各个源；全部失败时错误信息列出每个源的失败原因。命中备用源时带回此前各源的错误作 issues。 */
async function fetchFromSources(symbol, interval, limit, preferred) {
  const order = preferred ? [preferred].concat(KLINE_SOURCES.filter(s => s !== preferred)) : KLINE_SOURCES;
  const errors = [];
  for (const source of order) {
    try {
      const rows = await fetchKlinePages(source, symbol, interval, limit);
      // issues carry the failures of every source skipped before this winner —
      // a Bybit/OKX fallback must read as 备用源, not green-OK primary data.
      if (rows.length) return { rows, source, issues: errors.slice() };
      errors.push(`${source.name}: 空数据`);
    } catch (e) {
      errors.push(`${source.name}: ${e.message}`);
    }
  }
  console.error('[Wave Klines]', symbol, interval, limit, errors.join(' | '));
  throw new Error(`未能拉取到 ${interval} K 线（${errors.join('；')}）`);
}

/** Health source id carried by every kline cache tier entry. */
function waveSourceId(symbol, interval, tier) {
  return `wave:${symbol}:${interval}:${tier}`;
}

/** New cache entry: stamps its own receipt + data clock, never "now" for data. */
function klineCacheEntry(data, source, issues = []) {
  const acquiredAt = Date.now();
  const lastBar = data && data.length ? data[data.length - 1] : null;
  return {
    timestamp: acquiredAt,
    acquiredAt,
    dataAsOf: lastBar ? lastBar.time * 1000 : null, // last bar open time, ms
    data,
    source,
    issues
  };
}

/**
 * 档位缓存 + 增量更新 + 出错回退旧缓存:
 * - 2 分钟内直接返回缓存；更大档位的新鲜缓存可直接切片；
 * - 过期后只补拉最新一页并与缓存拼接 (请求量从 7 页降到 1 页，减少被限流)；
 * - 拉取全部失败时返回旧缓存，而不是报错 — 旧缓存自己的 acquire/data 时钟不续期。
 */
async function fetchKlineTier(symbol, interval, limit) {
  const cacheKey = `${symbol}_${interval}_${limit}`;
  const cached = waveKlineCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.timestamp < KLINE_FRESH_MS) return cached.data;
  // 同一标的/周期/根数的并发请求合并为一次 (图表与研判接口常同时触发)
  if (waveKlineInflight.has(cacheKey)) return waveKlineInflight.get(cacheKey);

  const healthId = waveSourceId(symbol, interval, limit);

  const task = (async () => {
    for (const t of KLINE_TIERS) {
      const big = t > limit && waveKlineCache.get(`${symbol}_${interval}_${t}`);
      if (big && now - big.timestamp < KLINE_FRESH_MS && big.data.length >= limit) {
        const data = big.data.slice(-limit);
        // The slice inherits the LARGER tier's receipt + data clock — a slice is
        // not a new acquisition and must not claim one.
        waveKlineCache.set(cacheKey, {
          timestamp: big.timestamp,
          acquiredAt: big.acquiredAt,
          dataAsOf: big.dataAsOf,
          data,
          source: big.source,
          issues: big.issues || []
        });
        // Seed the sliced tier's registry record with the ORIGINAL receipt so
        // audits see the same clocks — never a fabricated fresh acquire.
        seedSource(waveSourceId(symbol, interval, limit), {
          dataAsOf: big.dataAsOf != null ? new Date(big.dataAsOf).toISOString() : null,
          lastSuccessAt: big.acquiredAt ? new Date(big.acquiredAt).toISOString() : null,
          asOfKind: 'source',
          source: big.source && big.source.name ? big.source.name : null,
          issues: big.issues || []
        });
        return data;
      }
    }
    // A real upstream fetch is about to happen (slice-from-tier above is not one).
    recordAttempt(healthId);
    if (cached && cached.data.length) {
      const sec = KLINE_SEC[interval] || 3600;
      const last = cached.data[cached.data.length - 1].time;
      const need = Math.ceil((now / 1000 - last) / sec) + 2;
      if (need <= 1000) {
        try {
          const { rows, source, issues } = await fetchFromSources(symbol, interval, need, cached.source);
          const fresh = rowsToBars(rows);
          const data = cached.data.filter(b => b.time < fresh[0].time).concat(fresh).slice(-limit);
          const entry = klineCacheEntry(data, source, issues);
          waveKlineCache.set(cacheKey, entry);
          recordSuccess(healthId, {
            dataAsOf: entry.dataAsOf, asOfKind: 'source',
            source: source.name, issues
          });
          return data;
        } catch (e) {
          recordFailure(healthId, e); // old entry's clocks stay untouched
          return cached.data; // 增量也失败: 先用旧缓存
        }
      }
    }
    try {
      const { rows, source, issues } = await fetchFromSources(symbol, interval, limit);
      const data = rowsToBars(rows);
      const entry = klineCacheEntry(data, source, issues);
      waveKlineCache.set(cacheKey, entry);
      recordSuccess(healthId, {
        dataAsOf: entry.dataAsOf, asOfKind: 'source',
        source: source.name, issues
      });
      return data;
    } catch (e) {
      recordFailure(healthId, e);
      if (cached && cached.data.length) return cached.data;
      throw e;
    }
  })();
  waveKlineInflight.set(cacheKey, task);
  try {
    return await task;
  } finally {
    waveKlineInflight.delete(cacheKey);
  }
}

/** 当前缓存使用的行情源名称 (响应里告诉前端是否用了备用源) */
function klineSourceName(symbol, interval, limit) {
  const tier = KLINE_TIERS.find(t => t >= limit) || WAVE_MAX_BARS;
  const c = waveKlineCache.get(`${symbol}_${interval}_${tier}`);
  return c && c.source ? c.source.name : null;
}

/**
 * Entry-bound source health for the kline cache tier serving `limit` bars.
 * Clocks come from the served cache entry itself (never borrowed from the
 * registry's possibly-newer sibling record); the latest registry error is
 * overlaid so a failed refresh shows through. Sliced tiers inherit the larger
 * tier's receipt; tiers with no entry fall back to the registry record.
 */
function waveKlineSourceHealth(symbol, interval, limit) {
  const tier = KLINE_TIERS.find(t => t >= limit) || WAVE_MAX_BARS;
  const id = waveSourceId(symbol, interval, tier);
  const entry = waveKlineCache.get(`${symbol}_${interval}_${tier}`);
  const reg = getSourceHealth(id);
  let record = null;
  if (entry) {
    record = {
      lastAttemptAt: reg.lastAttemptAt || null,
      lastSuccessAt: entry.acquiredAt ? new Date(entry.acquiredAt).toISOString() : null,
      dataAsOf: entry.dataAsOf != null ? new Date(entry.dataAsOf).toISOString() : null,
      asOfKind: 'source',
      source: entry.source && entry.source.name ? entry.source.name : null,
      lastError: reg.lastError || null,
      consecutiveFailures: reg.consecutiveFailures || 0,
      // Fallback-source issues live on the entry; the registry may also carry
      // them (slices seed them from the big tier).
      issues: (entry.issues && entry.issues.length ? entry.issues : (reg.issues || [])),
      available: true
    };
  } else if (reg.observed) {
    record = reg; // health object is record-compatible
  }
  return deriveSourceHealth(id, record);
}

/**
 * summarizeHealth-shaped aggregate built from per-id entry-bound healths.
 * Entries carry `required`: only required sources gate `analysisAllowed`
 * (main/drawing timeframes). Auxiliary timeframes (sub-wave falsification,
 * higher-tf background) land in `ancillarySources` — an expired aux may
 * degrade the verdict to DEGRADED but never blocks it, and is never fed to
 * the engine as current input by the callers.
 */
function waveHealthSummary(entries) {
  const sources = {};
  const ancillary = {};
  for (const { id, health, required = true } of entries) (required ? sources : ancillary)[id] = health;
  const required = Object.values(sources);
  const aux = Object.values(ancillary);
  const analysisAllowed = required.length > 0 && required.every(h => h.usable);
  let state;
  if (!required.length || required.every(h => h.state === 'UNKNOWN')) state = 'UNKNOWN';
  else if (!required.some(h => h.usable)) state = 'UNAVAILABLE';
  else if (required.every(h => h.state === 'OK') && aux.every(h => h.state === 'OK')) state = 'OK';
  else state = 'DEGRADED';
  return {
    state,
    analysisAllowed,
    stale: [...required, ...aux].some(h => h.stale),
    sources,
    ancillarySources: Object.keys(ancillary).length ? ancillary : undefined,
    failedSources: required.filter(h => h.state !== 'OK').map(h => h.id),
    blockedSources: required.filter(h => !h.usable).map(h => h.id)
  };
}

// MIME types for static serving
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
};

/**
 * Send JSON response with ETag negotiation (304), Gzip/Deflate compression, and CORS headers
 */
function sendJsonResponse(req, res, statusCode, payload, extraHeaders = {}) {
  // Per-call derived ages on SOURCE-HEALTH objects (recognized by their own
  // policy/lastSuccessAt keys) are recomputed from lastSuccessAt/dataAsOf on
  // every request; keeping them off the wire lets byte-identical responses
  // keep a stable strong ETag (304). Business payloads that legitimately
  // carry an `ageMs`/`dataAgeMs` field are untouched — only objects that
  // also carry health shape are stripped.
  const isHealthObject = (o) => o && typeof o === 'object' && 'lastSuccessAt' in o &&
    ('policy' in o || 'usable' in o || 'state' in o);
  const jsonStr = typeof payload === 'string'
    ? payload
    : JSON.stringify(payload, function (key, value) {
        if ((key === 'ageMs' || key === 'dataAgeMs') && isHealthObject(this)) return undefined;
        return value;
      });
  const bodyBuffer = Buffer.from(jsonStr, 'utf8');

  // Compute strong MD5 ETag
  const etag = `"${crypto.createHash('md5').update(bodyBuffer).digest('hex')}"`;

  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'ETag': etag,
    'Cache-Control': 'public, no-cache',
    ...extraHeaders
  };

  // ETag conditional check (If-None-Match)
  const clientEtag = req && req.headers ? req.headers['if-none-match'] : null;
  if (clientEtag && (clientEtag === etag || clientEtag === etag.replace(/"/g, ''))) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  // Handle compression (gzip / deflate)
  const acceptEncoding = (req && req.headers ? req.headers['accept-encoding'] : '') || '';
  if (acceptEncoding.includes('gzip')) {
    try {
      const gzipped = zlib.gzipSync(bodyBuffer);
      headers['Content-Encoding'] = 'gzip';
      headers['Content-Length'] = gzipped.length;
      res.writeHead(statusCode, headers);
      res.end(gzipped);
      return;
    } catch (e) {
      console.warn('[Gzip Error, fallback to raw]:', e.message);
    }
  } else if (acceptEncoding.includes('deflate')) {
    try {
      const deflated = zlib.deflateSync(bodyBuffer);
      headers['Content-Encoding'] = 'deflate';
      headers['Content-Length'] = deflated.length;
      res.writeHead(statusCode, headers);
      res.end(deflated);
      return;
    } catch (e) {
      console.warn('[Deflate Error, fallback to raw]:', e.message);
    }
  }

  headers['Content-Length'] = bodyBuffer.length;
  res.writeHead(statusCode, headers);
  res.end(bodyBuffer);
}

/**
 * Handle API requests
 */
async function handleApiRequest(req, res, parsedUrl) {
  const pathname = parsedUrl.pathname;

  // Read-only self-checks and CORS preflights must not mark the instance
  // "active": a probe of the audit/health endpoints must never wake the idle
  // background refresher into external calls.
  if (req.method !== 'OPTIONS' &&
    pathname !== '/api/system/audit' &&
    pathname !== '/api/audit' &&
    pathname !== '/api/system/health') {
    noteApiActivity();
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  // GET /api/market-data
  if (pathname === '/api/market-data' && req.method === 'GET') {
    try {
      const cache = getCachedData();
      if (!cache.lastSyncCheckTime) {
        await refreshAllMarketData('BTC');
      }
      const data = getCachedData();
      const thresholdParam = parseInt(parsedUrl.query?.threshold, 10) || 30000000;
      const timeRangeParam = parsedUrl.query?.timeRange || 'all'; // '24h' | '3d' | '7d' | '30d' | 'all'
      // No fabricated spot: a missing real index price stays null and every
      // analysis that needs it is gated on source health below.
      const spotPrice = (data.gex && Number.isFinite(data.gex.index_price) && data.gex.index_price > 0)
        ? data.gex.index_price
        : null;

      // Per-analysis health gates — a required source that is expired,
      // unavailable, or unverified blocks ONLY that analysis; healthy sibling
      // sections keep their real conclusions.
      const analysisHealth = {};
      for (const [key, ids] of Object.entries(ANALYSIS_REQUIREMENTS)) {
        analysisHealth[key] = summarizeHealth(ids);
      }
      const allowed = key => analysisHealth[key].analysisAllowed;

      // Filter trades from persistent 30-day store based on user-selected window
      const activeTrades = filterTradesByWindow(data.blockTrades, timeRangeParam);

      // Analyzers run only when every required source is usable — never on
      // cached/expired/unverified inputs presented as current.
      const atmAnalysis = allowed('atmIv')
        ? analyzeAtmIv(data.ivHistory, data.dvolStats, data.atmData)
        : unavailableAnalysis(analysisHealth.atmIv, data.ivHistory);
      const gexAnalysis = allowed('gex')
        ? analyzeDynamicGex(data.gex, new Date())
        : unavailableAnalysis(analysisHealth.gex, data.gex);

      // Deribit OI 日快照：验证大宗成交是开仓还是平仓；当天缺快照时后台补采，不阻塞本次请求
      let oiSnapshots = [];
      try {
        oiSnapshots = await optionOiHistory.getMergedHistory();
        optionOiHistory.maybeRecordLiveSnapshot(oiSnapshots, () => fetchBookSummaryRows('BTC'));
      } catch (err) {
        console.warn('[API] option OI history unavailable:', err.message);
      }

      const volHist = volSurfaceHistory.getHistory();
      const smileAnalysis = (allowed('ivSmile') && spotPrice !== null)
        ? analyzeIvSmile(data.ivSkewMonth, spotPrice, new Date(), { history: volHist })
        : unavailableAnalysis(analysisHealth.ivSmile, data.ivSkewMonth);
      const skewAnalysis = allowed('delta25Skew')
        ? analyze25DeltaSkew(data.skewChart, {
          // Never feed an unavailable-shaped placeholder into a live analyzer.
          atm: atmAnalysis.status === 'data_unavailable' ? null : atmAnalysis,
          dvolStats: data.dvolStats,
          history: volHist
        })
        : unavailableAnalysis(analysisHealth.delta25Skew, data.skewChart);

      // 拉取 Deribit 全链快照，既用于提取各到期日 Black-76 远期价 F（喂给大宗 Greeks），又用于做市商敞口引擎
      let marksSnapshot = null;
      let marksErr = null;
      try {
        marksSnapshot = await getOptionMarks('BTC');
      } catch (err) {
        marksErr = err;
      }
      const forwardsByExpiry = buildForwardsMap(data.atmData, marksSnapshot);
      const liveSmile = smileAnalysis && smileAnalysis.status !== 'data_unavailable' && smileAnalysis.status !== 'insufficient_data' ? smileAnalysis : null;
      const liveSkew = skewAnalysis && skewAnalysis.status !== 'data_unavailable' && skewAnalysis.status !== 'insufficient_data' ? skewAnalysis : null;
      const smileContext = (liveSmile || liveSkew) ? {
        skew25d: Number.isFinite(liveSkew?.d30) ? liveSkew.d30 : (Number.isFinite(liveSmile?.rr25) ? liveSmile.rr25 : undefined),
        bf25: liveSmile?.bf25,
        putWingPremium: liveSmile?.putWingPremium,
        callWingPremium: liveSmile?.callWingPremium
      } : null;

      let blockAnalysis;
      if (allowed('blockTrades') && spotPrice !== null) {
        blockAnalysis = analyzeBlockTrades(activeTrades, thresholdParam, timeRangeParam, spotPrice, oiSnapshots, {
          smileContext,
          forwardsByExpiry
        });
      } else {
        blockAnalysis = unavailableAnalysis(analysisHealth.blockTrades, activeTrades);
        if (spotPrice === null && analysisHealth.blockTrades.analysisAllowed) {
          blockAnalysis.summaryText = '无可用实时现货价，暂停当前研判';
        }
      }
      blockAnalysis.oiHistory = {
        days: oiSnapshots.length,
        latestTs: oiSnapshots.length ? oiSnapshots[oiSnapshots.length - 1].ts : null
      };
      blockAnalysis.timeRange = timeRangeParam;
      blockAnalysis.activeTradesCount = activeTrades.length;
      blockAnalysis.tradeStoreStats = data.tradeStoreStats || null;

      // 做市商敞口：Deribit 全链快照自算 DEX/GEX/VEX/CEX、滑动翻转位、到期脱落与压力矩阵；
      // 台账可用时以全成交校正为主口径，惯例口径并列。
      // 快照与 Module 4 PV 视图共用 option_marks 的 30s 缓存；刷新失败时用上一份快照并标注 stale。
      let dealerExposure;
      try {
        if (!marksSnapshot) throw (marksErr || new Error('Deribit option_marks unavailable'));
        let flowLedger = null;
        try {
          flowLedger = await optionFlowLedger.getLedger();
        } catch (err) {
          console.warn('[API] option flow ledger unavailable:', err.message);
        }
        const depth = await coinbaseDepthForDealer();
        dealerExposure = analyzeDealerExposure(marksSnapshot, {
          // 全成交累计净额台账：台账可用时作为主口径 (状态、预警、压力情景)，惯例口径并列对照
          flowLedger,
          gexReference: gexAnalysis.status === 'data_unavailable' ? null : gexAnalysis,
          // 台账不可用时退回 30 天大宗成交库
          blockTrades: data.blockTrades || [],
          // 过去 24 小时现货与 DVOL 变化 (已触发对冲流)
          recent24h: data.dvolStats?.recent24h || null,
          // 25Δ 偏度：预警中的偏度条件
          skew: skewAnalysis && skewAnalysis.status !== 'data_unavailable' ? skewAnalysis : null,
          depth
        });
        if (dealerExposure.status === 'ok') {
          // 日度档案 (Actions 每日提交) + 当前实时记录
          const archived = await dealerHistory.getHistory().catch(() => []);
          dealerExposure.history = dealerHistory.withLivePoint(archived, dealerHistory.recordFromAnalysis(dealerExposure));
        }
      } catch (err) {
        console.warn('[API] dealer exposure unavailable:', err.message);
        dealerExposure = { status: 'data_unavailable', summaryText: `Deribit 全链快照不可用：${err.message}` };
      }

      // The daily vol-surface record is written ONLY from genuinely usable
      // inputs: every required source must be live-OK (not FALLBACK/STALE/
      // UNKNOWN, no lastError) AND its receipt must be from today (UTC) — a
      // yesterday-23:55 cache must not become today's 00:01 snapshot. The
      // source's own receipt is the collection clock, never the GET time.
      const todayUtc = new Date().toISOString().slice(0, 10);
      const volSurfaceHealth = summarizeHealth(VOL_SURFACE_REQUIRED);
      const volSurfaceOk = volSurfaceHealth.analysisAllowed && spotPrice !== null &&
        Object.values(volSurfaceHealth.sources).every(h =>
          h.state === 'OK' && !h.lastError &&
          h.lastSuccessAt && String(h.lastSuccessAt).slice(0, 10) === todayUtc &&
          h.dataAsOf && String(h.dataAsOf).slice(0, 10) === todayUtc);
      if (volSurfaceOk) {
        volSurfaceHistory.recordSnapshot({ atm: atmAnalysis, smile: smileAnalysis, skew: skewAnalysis, spot: spotPrice });
      }

      const termPremium = data.termPremium || null;
      const termPremiumOut = !termPremium
        ? null
        : (analysisHealth.termPremium.analysisAllowed
          ? termPremium
          : {
            status: 'data_unavailable',
            summaryText: DATA_UNAVAILABLE_TEXT,
            dataHealth: analysisHealth.termPremium,
            historicalOnly: true,
            // Historical series stays browsable; current conclusions are withheld.
            series: termPremium.series ?? null,
            metadata: termPremium.metadata ?? null
          });

      const payload = {
        code: 0,
        currency: data.currency,
        syncStatus: {
          hasAnyUpdate: data.lastChanges?.hasAnyUpdate || false,
          dataVersion: data.dataVersion,
          summary: data.lastChanges?.summary || '尚未执行过同步检查',
          changes: data.lastChanges || {},
          lastSyncCheckTime: data.lastSyncCheckTime,
          lastDataChangeTime: data.lastDataChangeTime,
          // Advances ONLY on a batch where every required Greeks source truly succeeded
          lastSuccessAt: data.lastSuccessAt || null,
          lastSuccessfulRefreshTime: data.lastSuccessAt || null,
          state: data.sourceHealth?.state || 'UNKNOWN',
          partialFailure: (data.sourceHealth?.failedSources?.length || 0) > 0,
          failedSources: data.sourceHealth?.failedSources || [],
          sourceStatus: Object.fromEntries(
            Object.entries(data.sourceHealth?.sources || {}).map(([id, h]) => [id, h.state])
          )
        },
        dataHealth: data.sourceHealth || null,
        analysisHealth,
        lastUpdated: data.lastDataChangeTime || data.lastSyncCheckTime,
        indexPrice: spotPrice,
        atmIv: atmAnalysis,
        gex: gexAnalysis,
        blockTrades: blockAnalysis,
        ivSmile: smileAnalysis,
        delta25Skew: skewAnalysis,
        dealerExposure,
        termPremium: termPremiumOut
      };

      sendJsonResponse(req, res, 200, payload);
    } catch (err) {
      console.error('[API Error] market-data:', err);
      sendJsonResponse(req, res, 500, { code: -1, error: err.message });
    }
    return;
  }

  // GET /api/option-marks?currency=BTC&instruments=BTC-30OCT26-100000-C,...
  // Live Deribit mark IV / mark price / expiry forward for the Module 4 PV view
  if (pathname === '/api/option-marks' && req.method === 'GET') {
    try {
      const currency = String(parsedUrl.query?.currency || 'BTC').toUpperCase();
      if (!/^[A-Z]{2,6}$/.test(currency)) {
        sendJsonResponse(req, res, 400, { code: -1, error: 'invalid currency' });
        return;
      }
      const instruments = String(parsedUrl.query?.instruments || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .slice(0, 200);
      const snapshot = await getOptionMarks(currency);
      sendJsonResponse(req, res, 200, {
        code: 0,
        ...withApiHealth(pickInstruments(snapshot, instruments), ['option_marks'])
      });
    } catch (err) {
      console.error('[API Error] option-marks:', err.message);
      sendJsonResponse(req, res, 502, { code: -1, error: err.message });
    }
    return;
  }

  // GET /api/block-insight?expiry=30OCT26
  // Module 4B：期限资金流向 (日聚合)、行权价热力图与目标区间、聪明钱命中率
  if (pathname === '/api/block-insight' && req.method === 'GET') {
    try {
      if (!getCachedData().lastSyncCheckTime) await refreshAllMarketData('BTC');
      const data = getCachedData();
      const expiryParam = String(parsedUrl.query?.expiry || '').toUpperCase();
      let oiSnapshots = [];
      try {
        oiSnapshots = await optionOiHistory.getMergedHistory();
      } catch (err) {
        console.warn('[API] option OI history unavailable:', err.message);
      }
      const marksSnap = await getOptionMarks('BTC').catch(() => null);
      const insight = await blockInsight.getServerInsight({
        trades: data.blockTrades,
        nowMs: Date.now(),
        spot: data.gex?.index_price || null,
        expiry: /^\d{1,2}[A-Z]{3}\d{2}$/.test(expiryParam) ? expiryParam : null,
        oiSnapshots,
        fetchRows: () => fetchBookSummaryRows('BTC'),
        forwardsByExpiry: buildForwardsMap(data.atmData, marksSnap)
      });
      sendJsonResponse(req, res, 200, {
        code: 0,
        ...withApiHealth(insight, ['block_flow', 'smart_money'])
      });
    } catch (err) {
      console.error('[API Error] block-insight:', err);
      sendJsonResponse(req, res, 500, { code: -1, error: err.message });
    }
    return;
  }

  // GET /api/term-curve — cross-sectional Deribit basis curve vs the Treasury curve (Module 2-C)
  if (pathname === '/api/term-curve' && req.method === 'GET') {
    try {
      const funding0d = getCachedData().termPremium?.current?.fundingApr ?? null;
      const data = await getTermCurve({ funding0d });
      sendJsonResponse(req, res, 200, { code: 0, ...data });
    } catch (err) {
      console.error('[API Error] term-curve:', err.message);
      sendJsonResponse(req, res, 502, { code: -1, error: err.message });
    }
    return;
  }

  // GET /api/term-premium
  if (pathname === '/api/term-premium' && req.method === 'GET') {
    try {
      const cache = getCachedData();
      if (!cache.termPremium) {
        await refreshAllMarketData('BTC');
      }
      const data = getCachedData();
      const tpHealth = summarizeHealth(ANALYSIS_REQUIREMENTS.termPremium);
      const tp = data.termPremium;
      sendJsonResponse(req, res, 200, tp && tpHealth.analysisAllowed
        ? { code: 0, ...tp, dataHealth: tp.dataHealth || tpHealth }
        : {
          code: 0,
          status: 'data_unavailable',
          summaryText: DATA_UNAVAILABLE_TEXT,
          dataHealth: tpHealth,
          historicalOnly: true,
          // The payload's daily rows are `series` (not `curve`): keep them
          // browsable while current conclusions are withheld.
          series: tp?.series ?? null,
          metadata: tp?.metadata ?? null
        });
    } catch (err) {
      console.error('[API Error] term-premium:', err);
      sendJsonResponse(req, res, 500, { code: -1, error: err.message });
    }
    return;
  }

  // GET /api/etf-linkage — ETF flows × CME positioning × basis carry linkage (Module 2-B)
  if (pathname === '/api/etf-linkage' && req.method === 'GET') {
    try {
      const force = parsedUrl.query?.force === '1';
      const basisSeries = await getHistoricalBasisData().catch(() => []);
      const data = await getEtfLinkageData(basisSeries, force);
      sendJsonResponse(req, res, 200, { code: 0, ...withApiHealth(data, ['etf', 'cot', 'etf_oi']) });
    } catch (err) {
      console.error('[API Error] etf-linkage:', err.message);
      sendJsonResponse(req, res, 502, { code: -1, error: err.message });
    }
    return;
  }

  // GET /api/mstr-preferreds — STRC 平价锚定与优先股分层利差
  if (pathname === '/api/mstr-preferreds' && req.method === 'GET') {
    try {
      const forceParam = parsedUrl.query?.force === '1' || parsedUrl.query?.refresh === 'true';
      const data = await getPreferredsData(forceParam);
      sendJsonResponse(req, res, 200, {
        code: 0,
        ...withApiHealth(data, ['preferreds', 'yahoo:STRC', 'yahoo:STRF', 'yahoo:STRD', 'fred:DGS1MO'])
      });
    } catch (err) {
      console.error('[API Error] mstr-preferreds:', err);
      sendJsonResponse(req, res, 500, { code: -1, error: err.message });
    }
    return;
  }

  // GET /api/mstr-disclosures?force=1 — Strategy 官方披露账本 (issuer ledger /
  // shares + SEC filing discovery). The payload carries its own persisted,
  // receipt-bound dataHealth — do NOT rebind via withApiHealth.
  if (pathname === '/api/mstr-disclosures' && req.method === 'GET') {
    try {
      const forceParam = parsedUrl.query?.force === '1';
      const data = await getMstrDisclosures(forceParam);
      sendJsonResponse(req, res, 200, { code: 0, ...data });
    } catch (err) {
      console.error('[API Error] mstr-disclosures:', err);
      sendJsonResponse(req, res, 502, { code: -1, error: 'mstr disclosures collection failed' });
    }
    return;
  }

  // GET /api/macro-chart
  if (pathname === '/api/macro-chart' && req.method === 'GET') {
    try {
      const forceParam = parsedUrl.query?.force === '1' || parsedUrl.query?.refresh === 'true';
      const macroData = await getMacroChartData(forceParam);

      // Inject real-time Spot Price and dynamically recalculate current multipliers
      const cache = getCachedData();
      const realtimeSpot = cache.gex?.index_price || cache.termPremium?.spotPrice || null;

      let finalMacroData = macroData;
      if (realtimeSpot && macroData && macroData.summary) {
        const updatedSummary = { ...macroData.summary };
        updatedSummary.currentBtc = realtimeSpot;
        if (updatedSummary.currentMstrCost) {
          updatedSummary.mstrProfitMultiplier = Number((realtimeSpot / updatedSummary.currentMstrCost).toFixed(2));
        }

        // Dynamically update the latest point in points array if today
        const points = Array.isArray(macroData.points) ? [...macroData.points] : [];
        if (points.length > 0) {
          const lastIdx = points.length - 1;
          points[lastIdx] = { ...points[lastIdx], btcPrice: realtimeSpot };
        }

        finalMacroData = {
          ...macroData,
          points,
          summary: updatedSummary
        };
      }

      sendJsonResponse(req, res, 200, {
        code: 0,
        ...withApiHealth(finalMacroData, [
          'macro', 'fred:DGS1', 'fred:DGS10', 'fred:WALCL', 'fred:WTREGEN',
          'fred:RRPONTSYD', 'macro_btc', 'yahoo:MSTR'
        ])
      });
    } catch (err) {
      console.error('[API Error] macro-chart:', err);
      sendJsonResponse(req, res, 500, { code: -1, error: err.message });
    }
    return;
  }

  // GET /api/cdri
  if (pathname === '/api/cdri' && req.method === 'GET') {
    try {
      const forceParam = parsedUrl.query?.force === '1' || parsedUrl.query?.refresh === 'true';
      const cdriData = await fetchCdriData(forceParam);
      sendJsonResponse(req, res, 200, {
        code: 0,
        ...withApiHealth(cdriData, ['cdri'])
      });
    } catch (err) {
      console.error('[API Error] cdri:', err);
      sendJsonResponse(req, res, 500, { code: -1, error: err.message });
    }
    return;
  }

  // GET /api/ssro
  if (pathname === '/api/ssro' && req.method === 'GET') {
    try {
      const forceParam = parsedUrl.query?.force === '1' || parsedUrl.query?.refresh === 'true';
      const ssroData = await getSsroData(forceParam);
      sendJsonResponse(req, res, 200, withApiHealth(ssroData, ['ssro', 'ssro_stable']));
    } catch (err) {
      console.error('[API Error] ssro:', err);
      sendJsonResponse(req, res, 500, { code: -1, error: err.message });
    }
    return;
  }

  // GET /api/flow-force?tf=15m|1h|4h|1d|1w (Module 5: BTC 主导力量 期货/现货 × 亚太/欧美)
  if (pathname === '/api/flow-force' && req.method === 'GET') {
    try {
      const tf = String(parsedUrl.query?.tf || '1h');
      const forceParam = parsedUrl.query?.force === '1';
      const ffData = await getFlowForce(tf, forceParam);
      sendJsonResponse(req, res, 200, withApiHealth(ffData, [`flow:${tf}`]));
    } catch (err) {
      console.error('[API Error] flow-force:', err);
      sendJsonResponse(req, res, 500, { code: -1, error: err.message });
    }
    return;
  }

  // GET /api/coinbase-liquidity
  if (pathname === '/api/coinbase-liquidity' && req.method === 'GET') {
    try {
      const forceParam = parsedUrl.query?.force === '1' || parsedUrl.query?.refresh === 'true';
      const cbData = await getCoinbaseLiquidityData(forceParam);
      sendJsonResponse(req, res, 200, {
        code: 0,
        ...withApiHealth(cbData, ['coinbase', 'coinbase_candles'])
      });
    } catch (err) {
      console.error('[API Error] coinbase-liquidity:', err);
      sendJsonResponse(req, res, 500, { code: -1, error: err.message });
    }
    return;
  }

  // GET /api/coinbase-liquidity-history?range=7d|30d|90d|all
  if (pathname === '/api/coinbase-liquidity-history' && req.method === 'GET') {
    try {
      const rangeParam = String(parsedUrl.query?.range || '30d');
      const days = parseInt(rangeParam, 10);
      const view = liquidityHistory.buildHistoryView(await liquidityHistory.getMergedHistory(), {
        rangeDays: Number.isFinite(days) && days > 0 ? days : null
      });
      sendJsonResponse(req, res, 200, {
        code: 0,
        range: rangeParam,
        ...withApiHealth(view, ['liquidity_history'])
      });
    } catch (err) {
      console.error('[API Error] coinbase-liquidity-history:', err);
      sendJsonResponse(req, res, 500, { code: -1, error: err.message });
    }
    return;
  }

  // GET /api/gold-correlation
  if (pathname === '/api/gold-correlation' && req.method === 'GET') {
    try {
      const forceParam = parsedUrl.query?.force === '1' || parsedUrl.query?.refresh === 'true';
      const goldData = await getGoldCorrelationData(forceParam);
      sendJsonResponse(req, res, 200, {
        code: 0,
        ...withApiHealth(goldData, ['gold'])
      });
    } catch (err) {
      console.error('[API Error] gold-correlation:', err);
      sendJsonResponse(req, res, 500, { code: -1, error: err.message });
    }
    return;
  }


  // GET /api/crypto-mcclellan (Module 1-B: Crypto Dual-Track McClellan Oscillator & Liquidity Siphon)
  if (pathname === '/api/crypto-mcclellan' && req.method === 'GET') {
    try {
      const forceRefresh = parsedUrl.query?.refresh === 'true' || parsedUrl.query?.force === '1';
      const data = await getMcClellanData(forceRefresh);
      const healthy = withApiHealth(data, ['mcclellan_core', 'mcclellan_frontier']);
      sendJsonResponse(req, res, 200, {
        code: 0,
        refreshStatus: data.refresh_status,
        data: healthy,
        ...healthy
      });
    } catch (err) {
      console.error('[API Error] crypto-mcclellan:', err);
      sendJsonResponse(req, res, 500, { code: -1, error: err.message });
    }
    return;
  }

  // GET /api/system/audit or GET /api/audit (Comprehensive Data Provenance & Health Audit)
  if ((pathname === '/api/system/audit' || pathname === '/api/audit') && req.method === 'GET') {
    try {
      const doProbe = parsedUrl.query?.probe === '1' || parsedUrl.query?.probe === 'true';
      const auditPayload = await getSystemAuditData(doProbe);
      sendJsonResponse(req, res, 200, auditPayload);
    } catch (err) {
      console.error('[API Error] system-audit:', err);
      sendJsonResponse(req, res, 500, { code: -1, error: err.message });
    }
    return;
  }

  // GET /api/system/health — read-only liveness of observed sources. No
  // probe, no refresh, no activity wakeup: it reports the last observed
  // per-module health (scope 'live-source-observations'). Modules that were
  // never collected show UNKNOWN. UNKNOWN or CRITICAL => 503 so uptime
  // probes do not treat an unverified/offline instance as serving live data;
  // DEGRADED stays 200 but the body is never 'HEALTHY'.
  if (pathname === '/api/system/health' && req.method === 'GET') {
    try {
      const auditPayload = await getSystemAuditData(false);
      const status = auditPayload.overallHealth === 'UNKNOWN' || auditPayload.overallHealth === 'CRITICAL' ? 503 : 200;
      sendJsonResponse(req, res, status, { ...auditPayload, scope: 'live-source-observations' });
    } catch (err) {
      console.error('[API Error] system-health:', err);
      sendJsonResponse(req, res, 500, { code: -1, error: err.message, scope: 'live-source-observations' });
    }
    return;
  }

  // POST /api/refresh
  if (pathname === '/api/refresh' && req.method === 'POST') {
    const clientIp = (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : null) || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    const lastRequest = refreshRateLimitMap.get(clientIp) || 0;

    // 10s IP rate limit window
    if (now - lastRequest < 10000) {
      const retryAfter = Math.ceil((10000 - (now - lastRequest)) / 1000);
      sendJsonResponse(req, res, 429, {
        code: 429,
        error: `请求过于频繁，请等待 ${retryAfter} 秒后再试 (Rate limit: 1 refresh per 10s per IP)`
      }, { 'Retry-After': String(retryAfter) });
      return;
    }

    refreshRateLimitMap.set(clientIp, now);

    // Clean up stale entries if map gets too large
    if (refreshRateLimitMap.size > 1000) {
      for (const [ip, time] of refreshRateLimitMap.entries()) {
        if (now - time > 60000) refreshRateLimitMap.delete(ip);
      }
    }

    try {
      console.log(`[API] Live sync refresh requested by client (${clientIp})`);

      // Single-flight lock: deduplicate concurrent background refresh calls.
      // allSettled so an auxiliary failure is reported, never swallowed.
      if (!activeRefreshPromise) {
        activeRefreshPromise = (async () => Promise.allSettled([
          refreshAllMarketData('BTC'),
          getMacroChartData(true),
          getPreferredsData(true),
          fetchCdriData(true),
          getSsroData(true),
          getCoinbaseLiquidityData(true),
          getGoldCorrelationData(true),
          getMcClellanData(true)
        ]))().finally(() => {
          activeRefreshPromise = null;
        });
      }

      const settled = await activeRefreshPromise;
      const auxNames = ['macro', 'preferreds', 'cdri', 'ssro', 'coinbase', 'gold', 'mcclellan'];
      const core = settled[0];

      // A fulfilled fetcher that returned a stale/cached/failed result is NOT
      // a fresh success. Where no reliable health flag exists -> 'unknown'.
      function auxOutcome(v) {
        if (v === null || v === undefined) return { status: 'failed', error: 'empty result' };
        if (v.error) return { status: 'failed', error: String(v.error) };
        const st = String(v.refresh_status?.status || v.refreshStatus?.status || '').toLowerCase();
        if (['failed', 'error'].includes(st)) return { status: 'failed', error: `status=${st}` };
        if (['stale', 'cached', 'degraded', 'fallback', 'pipelineunavailable'].includes(st)) {
          return { status: 'degraded', error: `status=${st}` };
        }
        if (v.dataHealth) {
          // A live computed health map is authoritative in both directions.
          if (v.dataHealth.state === 'OK') return { status: 'ok' };
          if (v.dataHealth.state === 'UNAVAILABLE') return { status: 'failed', error: 'dataHealth unavailable' };
          if (v.dataHealth.state === 'UNKNOWN') return { status: 'unknown', error: 'dataHealth unknown' };
          return { status: 'degraded', error: `dataHealth=${v.dataHealth.state}` };
        }
        if (v.metadata?.feed && v.metadata.feed.liveOk === false) {
          return { status: 'degraded', error: v.metadata.feed.liveError ? String(v.metadata.feed.liveError) : 'live feed not ok' };
        }
        if (st === 'refreshed' || st === 'ok' || st === 'success') return { status: 'ok' };
        if (v.stale === true) return { status: 'degraded', error: 'stale flag' };
        return { status: 'unknown' }; // no reliable health flag: do not guess success
      }

      const outcomes = [];
      const failures = [];
      let syncReport = null;

      if (core.status === 'fulfilled') {
        syncReport = core.value;
        const dh = syncReport?.dataHealth;
        const st = dh
          ? (dh.state === 'OK' ? 'ok' : dh.state === 'UNAVAILABLE' ? 'failed' : dh.state === 'UNKNOWN' ? 'unknown' : 'degraded')
          : 'unknown';
        outcomes.push({ module: 'market_data', status: st, failedSources: dh?.failedSources || [] });
        for (const id of (dh?.failedSources || [])) failures.push({ source: id, error: dh.sources?.[id]?.lastError || 'not healthy' });
      } else {
        outcomes.push({ module: 'market_data', status: 'failed', error: core.reason?.message || String(core.reason) });
        failures.push({ source: 'market_data', error: core.reason?.message || String(core.reason) });
      }

      settled.slice(1).forEach((r, i) => {
        const name = auxNames[i];
        let o;
        if (r.status === 'rejected') {
          o = { module: name, status: 'failed', error: r.reason?.message || String(r.reason) };
          console.error(`[Refresh] ${name} refresh failed:`, o.error);
        } else {
          o = { module: name, ...auxOutcome(r.value) };
          if (o.status !== 'ok') console.warn(`[Refresh] ${name} outcome: ${o.status}${o.error ? ` (${o.error})` : ''}`);
        }
        outcomes.push(o);
        // unknown is surfaced too: the client must see "we could not verify"
        // rather than silence — but the message never claims usable cache is empty.
        if (o.status !== 'ok') failures.push({ source: name, error: o.error || o.status });
      });

      const okCount = outcomes.filter(o => o.status === 'ok').length;
      const status = okCount === 0 ? 'failed' : (outcomes.every(o => o.status === 'ok') ? 'ok' : 'partial');
      const httpStatus = status === 'failed' ? 503 : 200;

      sendJsonResponse(req, res, httpStatus, {
        code: status === 'failed' ? -1 : 0,
        ok: status === 'ok',
        status,
        partialFailure: status === 'partial',
        msg: syncReport?.summary || (status === 'failed' ? '数据同步失败' : status === 'partial' ? '部分数据源同步失败' : '数据已刷新'),
        hasAnyUpdate: syncReport?.hasAnyUpdate || false,
        dataVersion: syncReport?.dataVersion || null,
        changes: syncReport?.changes || {},
        lastSyncCheckTime: syncReport?.lastSyncCheckTime || null,
        lastDataChangeTime: syncReport?.lastDataChangeTime || null,
        lastSuccessfulRefreshTime: syncReport?.lastSuccessAt || null,
        dataHealth: syncReport?.dataHealth || null,
        outcomes,
        failures
      });
    } catch (err) {
      console.error('[API Error] refresh:', err);
      sendJsonResponse(req, res, 500, { code: -1, ok: false, status: 'failed', error: err.message });
    }
    return;
  }

  // GET /api/wave/klines (Module 8: Wave Kline Feed Proxy & Cache with IP Rate Limit)
  if (pathname === '/api/wave/klines' && req.method === 'GET') {
    const clientIp = (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : null) || req.socket?.remoteAddress || 'unknown';
    if (!checkWaveRateLimit(clientIp)) {
      sendJsonResponse(req, res, 429, { code: 429, error: '请求过于频繁，请稍后再试 (Rate limit: 20 req/min per IP)' });
      return;
    }

    const rawSymbol = (parsedUrl.query?.symbol || 'BTCUSDT').toUpperCase().replace(/[\/\-_]/g, '');
    if (rawSymbol !== 'BTCUSDT' && rawSymbol !== 'ETHUSDT') {
      sendJsonResponse(req, res, 400, { code: 400, error: '波浪理论研判目前仅限定 BTC/USDT 与 ETH/USDT 标的' });
      return;
    }

    const interval = parsedUrl.query?.interval || '4h';
    const isAux = WAVE_AUX_INTERVALS.includes(interval);
    if (!WAVE_INTERVALS.includes(interval) && !isAux && !WAVE_SUB_ONLY_INTERVALS.includes(interval)) {
      sendJsonResponse(req, res, 400, { code: 400, error: `波浪理论研判限定 ${WAVE_INTERVALS.join('/')} 时间框架` });
      return;
    }

    const maxBars = isAux ? WAVE_AUX_MAX_BARS : WAVE_MAX_BARS;
    const limit = Math.min(parseInt(parsedUrl.query?.limit, 10) || maxBars, maxBars);

    try {
      const bars = await fetchBinanceKlines(rawSymbol, interval, limit);
      const src = waveKlineSourceHealth(rawSymbol, interval, limit);
      const tier = KLINE_TIERS.find(t => t >= limit) || WAVE_MAX_BARS;
      sendJsonResponse(req, res, 200, {
        code: 0,
        symbol: rawSymbol === 'BTCUSDT' ? 'BTC/USDT' : 'ETH/USDT',
        interval,
        count: bars.length,
        source: klineSourceName(rawSymbol, interval, limit),
        bars,
        // Historical bars stay browsable even when unusable for live judging —
        // historicalOnly tells the client not to present them as current.
        dataHealth: waveHealthSummary([{ id: waveSourceId(rawSymbol, interval, tier), health: src }]),
        stale: src.stale,
        usable: src.usable,
        lastSuccessAt: src.lastSuccessAt,
        dataAsOf: src.dataAsOf,
        historicalOnly: !src.usable
      });
    } catch (err) {
      console.error('[API Error] wave-klines:', err);
      const tier = KLINE_TIERS.find(t => t >= limit) || WAVE_MAX_BARS;
      const src = waveKlineSourceHealth(rawSymbol, interval, limit);
      sendJsonResponse(req, res, 503, {
        code: 503,
        status: 'data_unavailable',
        error: err.message,
        dataHealth: waveHealthSummary([{ id: waveSourceId(rawSymbol, interval, tier), health: src }])
      });
    }
    return;
  }

  // GET / POST /api/wave/analysis (Module 8: Liu Yudong Elliott Wave Theory Analysis API)
  if (pathname === '/api/wave/analysis' && (req.method === 'GET' || req.method === 'POST')) {
    const clientIp = (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : null) || req.socket?.remoteAddress || 'unknown';
    if (!checkWaveRateLimit(clientIp)) {
      sendJsonResponse(req, res, 429, { code: 429, error: '请求过于频繁，请稍后再试 (Rate limit: 20 req/min per IP)' });
      return;
    }

    let payload = {};
    if (req.method === 'POST') {
      try {
        payload = await parseJsonBody(req);
      } catch (e) {
        sendJsonResponse(req, res, 400, { code: 400, error: 'Invalid JSON request payload' });
        return;
      }
    }

    const rawSymbol = ((payload.symbol || parsedUrl.query?.symbol) || 'BTCUSDT').toUpperCase().replace(/[\/\-_]/g, '');
    if (rawSymbol !== 'BTCUSDT' && rawSymbol !== 'ETHUSDT') {
      sendJsonResponse(req, res, 400, { code: 400, error: '波浪理论研判目前仅限定 BTC/USDT 与 ETH/USDT 标的' });
      return;
    }

    const startTime = payload.startTime || parsedUrl.query?.startTime || null;
    const endTime = payload.endTime || parsedUrl.query?.endTime || null;
    const interval = (payload.interval || parsedUrl.query?.interval || '4h');
    if (!WAVE_INTERVALS.includes(interval)) {
      sendJsonResponse(req, res, 400, { code: 400, error: `波浪理论研判限定 ${WAVE_INTERVALS.join('/')} 时间框架` });
      return;
    }

    try {
      const displaySymbol = rawSymbol === 'BTCUSDT' ? 'BTC/USDT' : 'ETH/USDT';
      const subTfs = (WAVE_SUB_INTERVALS[interval] || []).slice(0, 2);
      const htfTfs = (WAVE_HTF_INTERVALS[interval] || []).slice(0, 2);
      const SUB_LIMIT = 1000;
      const HTF_LIMIT = 200;

      // 并发并行抓取主周期 + 子周期 + 宏观高周期 K 线，防止串行请求导致延迟累加
      const [mainBars, subResults, htfResults] = await Promise.all([
        fetchBinanceKlines(rawSymbol, interval, WAVE_MAX_BARS),
        Promise.all(subTfs.map(tf => fetchBinanceKlines(rawSymbol, tf, SUB_LIMIT).catch(() => null))),
        Promise.all(htfTfs.map(tf => fetchBinanceKlines(rawSymbol, tf, HTF_LIMIT).catch(() => null)))
      ]);

      // Health is judged on the ACTUAL timeframes this request consumes.
      // The main timeframe is required; expired/unknown/unavailable -> 503.
      const healthEntries = [];
      const warnings = [];
      const mainHealth = waveKlineSourceHealth(rawSymbol, interval, WAVE_MAX_BARS);
      const mainTier = KLINE_TIERS.find(t => t >= WAVE_MAX_BARS) || WAVE_MAX_BARS;
      healthEntries.push({ id: waveSourceId(rawSymbol, interval, mainTier), health: mainHealth });

      const subBars = {};
      subTfs.forEach((tf, i) => {
        const h = waveKlineSourceHealth(rawSymbol, tf, SUB_LIMIT);
        healthEntries.push({ id: h.id, health: h, required: false });
        if (subResults[i] && h.usable) subBars[tf] = subResults[i];
        else warnings.push(`子周期 ${tf} K线${subResults[i] ? '已过期或不可用' : '获取失败'}，子浪判定降级`);
      });
      const htfBars = {};
      htfTfs.forEach((tf, i) => {
        const h = waveKlineSourceHealth(rawSymbol, tf, HTF_LIMIT);
        healthEntries.push({ id: h.id, health: h, required: false });
        if (htfResults[i] && h.usable) htfBars[tf] = htfResults[i];
        else warnings.push(`高周期 ${tf} K线${htfResults[i] ? '已过期或不可用' : '获取失败'}，宏观背景降级`);
      });

      const dataHealth = waveHealthSummary(healthEntries);
      if (!mainHealth.usable) {
        sendJsonResponse(req, res, 503, {
          code: 503,
          status: 'data_unavailable',
          error: `主周期 ${interval} K线数据不可用或已过期`,
          dataHealth,
          warnings
        });
        return;
      }

      const analysis = analyzeWaves(mainBars, displaySymbol, {
        startTime,
        endTime,
        timeframe: interval,
        subBars,
        htfBars
      });

      sendJsonResponse(req, res, 200, {
        code: 0,
        ...analysis,
        dataHealth,
        dataWarnings: warnings
      });
    } catch (err) {
      console.error('[API Error] wave-analysis:', err);
      sendJsonResponse(req, res, 503, {
        code: 503,
        status: 'data_unavailable',
        error: err.message,
        dataHealth: waveHealthSummary([{
          id: waveSourceId(rawSymbol, interval, KLINE_TIERS.find(t => t >= WAVE_MAX_BARS) || WAVE_MAX_BARS),
          health: waveKlineSourceHealth(rawSymbol, interval, WAVE_MAX_BARS)
        }])
      });
    }
    return;
  }

  // POST /api/wave/evaluate (Module 8: 用户画浪评估 — 4H 画浪 + 15m 子浪证伪 + 柳氏监测点/目标)
  if (pathname === '/api/wave/evaluate' && req.method === 'POST') {
    const clientIp = (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : null) || req.socket?.remoteAddress || 'unknown';
    if (!checkWaveRateLimit(clientIp)) {
      sendJsonResponse(req, res, 429, { code: 429, error: '请求过于频繁，请稍后再试 (Rate limit: 20 req/min per IP)' });
      return;
    }

    let payload;
    try {
      payload = await parseJsonBody(req);
    } catch (e) {
      sendJsonResponse(req, res, 400, { code: 400, error: 'Invalid JSON request payload' });
      return;
    }

    const rawSymbol = (payload.symbol || 'BTCUSDT').toUpperCase().replace(/[\/\-_]/g, '');
    if (rawSymbol !== 'BTCUSDT' && rawSymbol !== 'ETHUSDT') {
      sendJsonResponse(req, res, 400, { code: 400, error: '波浪理论研判目前仅限定 BTC/USDT 与 ETH/USDT 标的' });
      return;
    }
    // 多级别画浪 (母浪 + 子浪)：payload.drawings = [{id, tool, timeframe, points}]
    if (Array.isArray(payload.drawings)) {
      const drawings = payload.drawings.slice(0, 20);
      const bad = drawings.find(d => !d || !USER_TOOLS[d.tool] || !WAVE_INTERVALS.includes(d.timeframe) ||
        !Array.isArray(d.points) || d.points.length < 2 || d.points.length > 6 ||
        !d.points.every(p => p && Number.isFinite(+p.time) && Number.isFinite(+p.price)));
      if (!drawings.length || bad) {
        sendJsonResponse(req, res, 400, { code: 400, error: `画浪数据无效：每个浪须为 ${WAVE_INTERVALS.join('/')} 周期、${Object.keys(USER_TOOLS).join(' / ')} 工具、2~6 个 {time, price}` });
        return;
      }
      try {
        const nowSec = Math.floor(Date.now() / 1000);
        const firstTime = Math.min(...drawings.map(d => Math.min(...d.points.map(p => +p.time))));
        const tfs = new Set();
        const requiredTfs = new Set();
        drawings.forEach(d => {
          tfs.add(d.timeframe);
          requiredTfs.add(d.timeframe); // every drawing's own timeframe is required
          (WAVE_USER_SUB_INTERVALS[d.timeframe] || []).forEach(t => tfs.add(t));
        });
        const list = Array.from(tfs);
        const limitOf = tf => Math.min(WAVE_MAX_BARS, Math.ceil((nowSec - firstTime) / WAVE_TF_SEC[tf]) + 300);
        const fetched = await Promise.all(list.map(tf =>
          fetchBinanceKlines(rawSymbol, tf, limitOf(tf)).catch(() => null)));
        // Gate on every timeframe actually consumed: a required drawing tf that
        // is expired/unknown/failed blocks the evaluation with 503; auxiliary
        // sub-tfs that are unusable are dropped (never fed as current input).
        const healthEntries = [];
        const warnings = [];
        const blockedRequired = [];
        const barsByTf = {};
        list.forEach((tf, i) => {
          const h = waveKlineSourceHealth(rawSymbol, tf, limitOf(tf));
          healthEntries.push({ id: h.id, health: h, required: requiredTfs.has(tf) });
          const ok = fetched[i] && h.usable;
          if (ok) {
            barsByTf[tf] = fetched[i];
          } else if (requiredTfs.has(tf)) {
            blockedRequired.push(`${tf}(${fetched[i] ? '数据过期或不可用' : '获取失败'})`);
          } else {
            warnings.push(`子浪判定周期 ${tf} K线${fetched[i] ? '已过期或不可用' : '获取失败'}，该级别证伪降级`);
          }
        });
        const dataHealth = waveHealthSummary(healthEntries);
        if (blockedRequired.length) {
          sendJsonResponse(req, res, 503, {
            code: 503,
            status: 'data_unavailable',
            error: `画浪所需周期K线不可用: ${blockedRequired.join(', ')}`,
            dataHealth,
            warnings
          });
          return;
        }
        const displaySymbol = rawSymbol === 'BTCUSDT' ? 'BTC/USDT' : 'ETH/USDT';
        const result = evaluateUserSketch(barsByTf, displaySymbol, { drawings });
        sendJsonResponse(req, res, 200, { code: 0, ...result, dataHealth, dataWarnings: warnings });
      } catch (err) {
        console.error('[API Error] wave-evaluate sketch:', err);
        sendJsonResponse(req, res, 422, { code: 422, error: err.message });
      }
      return;
    }

    const interval = payload.interval || '4h';
    if (!WAVE_INTERVALS.includes(interval)) {
      sendJsonResponse(req, res, 400, { code: 400, error: `波浪理论研判限定 ${WAVE_INTERVALS.join('/')} 时间框架` });
      return;
    }
    if (!USER_TOOLS[payload.tool]) {
      sendJsonResponse(req, res, 400, { code: 400, error: `画浪工具须为 ${Object.keys(USER_TOOLS).join(' / ')}` });
      return;
    }
    const points = Array.isArray(payload.points) ? payload.points : [];
    if (points.length < 3 || points.length > 6 || !points.every(p => p && Number.isFinite(+p.time) && Number.isFinite(+p.price))) {
      sendJsonResponse(req, res, 400, { code: 400, error: '画浪点须为 3~6 个 {time, price}' });
      return;
    }

    try {
      const displaySymbol = rawSymbol === 'BTCUSDT' ? 'BTC/USDT' : 'ETH/USDT';
      // 子周期根数须覆盖画浪起点至今 (fetchBinanceKlines 内部按缓存档位取整)
      const nowSec = Math.floor(Date.now() / 1000);
      const firstTime = Math.min(...points.map(p => +p.time));
      const subLimit = tf => Math.min(WAVE_MAX_BARS, Math.ceil((nowSec - firstTime) / WAVE_TF_SEC[tf]) + 200);
      const subTfs = WAVE_USER_SUB_INTERVALS[interval] || [];
      const htfTfs = (WAVE_HTF_INTERVALS[interval] || []).slice(0, 2);

      let mainBars, subResults, htfResults;
      try {
        [mainBars, subResults, htfResults] = await Promise.all([
          fetchBinanceKlines(rawSymbol, interval, WAVE_MAX_BARS),
          Promise.all(subTfs.map(tf => fetchBinanceKlines(rawSymbol, tf, subLimit(tf)).catch(() => null))),
          Promise.all(htfTfs.map(tf => fetchBinanceKlines(rawSymbol, tf, 200).catch(() => null)))
        ]);
      } catch (fetchErr) {
        console.error('[API Error] wave-evaluate klines:', fetchErr);
        sendJsonResponse(req, res, 503, {
          code: 503,
          status: 'data_unavailable',
          error: fetchErr.message,
          dataHealth: waveHealthSummary([{
            id: waveSourceId(rawSymbol, interval, WAVE_MAX_BARS),
            health: waveKlineSourceHealth(rawSymbol, interval, WAVE_MAX_BARS)
          }])
        });
        return;
      }

      // Health over the actual timeframes consumed: main tf required, sub/htf
      // auxiliary (unusable aux is dropped, never presented as current input).
      const healthEntries = [];
      const warnings = [];
      const mainHealth = waveKlineSourceHealth(rawSymbol, interval, WAVE_MAX_BARS);
      healthEntries.push({ id: waveSourceId(rawSymbol, interval, WAVE_MAX_BARS), health: mainHealth });
      const subBars = {};
      subTfs.forEach((tf, i) => {
        const h = waveKlineSourceHealth(rawSymbol, tf, subLimit(tf));
        healthEntries.push({ id: h.id, health: h, required: false });
        if (subResults[i] && h.usable) subBars[tf] = subResults[i];
        else warnings.push(`子浪判定周期 ${tf} K线${subResults[i] ? '已过期或不可用' : '获取失败'}，证伪降级`);
      });
      const htfBars = {};
      htfTfs.forEach((tf, i) => {
        const h = waveKlineSourceHealth(rawSymbol, tf, 200);
        healthEntries.push({ id: h.id, health: h, required: false });
        if (htfResults[i] && h.usable) htfBars[tf] = htfResults[i];
        else warnings.push(`高周期 ${tf} K线${htfResults[i] ? '已过期或不可用' : '获取失败'}，背景降级`);
      });
      const dataHealth = waveHealthSummary(healthEntries);
      if (!mainHealth.usable) {
        sendJsonResponse(req, res, 503, {
          code: 503,
          status: 'data_unavailable',
          error: `主周期 ${interval} K线数据不可用或已过期`,
          dataHealth,
          warnings
        });
        return;
      }

      const result = evaluateUserCount(mainBars, displaySymbol, {
        tool: payload.tool,
        points: points.map(p => ({ time: +p.time, price: +p.price })),
        timeframe: interval,
        subBars,
        htfBars,
        compare: payload.compare !== false,
        forceType: payload.type || null
      });
      sendJsonResponse(req, res, 200, { code: 0, ...result, dataHealth, dataWarnings: warnings });
    } catch (err) {
      console.error('[API Error] wave-evaluate:', err);
      // 输入类错误 (点序/方向/点数) 直接回给用户
      sendJsonResponse(req, res, 422, { code: 422, error: err.message });
    }
    return;
  }

  sendJsonResponse(req, res, 404, { code: 404, error: 'Not found' });
}

/**
 * Handle static file serving
 * 首次请求时把文件读入内存并预先 gzip，按 mtime/size 失效；
 * 带 ETag，浏览器以 no-cache 方式每次校验，未变化则 304 不重复下载。
 */
const staticCache = new Map();
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.svg']);

function loadStaticEntry(filePath, stats) {
  const cached = staticCache.get(filePath);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached;
  const raw = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const gz = COMPRESSIBLE.has(ext) && raw.length > 1024 ? zlib.gzipSync(raw, { level: 9 }) : null;
  const entry = {
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    raw,
    gz,
    etag: `"${crypto.createHash('md5').update(raw).digest('hex')}"`,
    contentType: MIME_TYPES[ext] || 'application/octet-stream'
  };
  staticCache.set(filePath, entry);
  return entry;
}

function handleStaticRequest(req, res, parsedUrl) {
  let reqPath = parsedUrl.pathname;
  if (reqPath === '/' || reqPath === '') {
    reqPath = '/index.html';
  }

  const safePath = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, '');
  // 前端与服务端共用同一份 UMD 引擎文件，不再在 public/ 下保留副本
  const filePath = reqPath === '/wave_engine.js' ? WAVE_ENGINE_FILE : path.join(PUBLIC_DIR, safePath);
  if (filePath !== WAVE_ENGINE_FILE && !filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }

    let entry;
    try {
      entry = loadStaticEntry(filePath, stats);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('500 Internal Server Error');
      return;
    }

    const headers = {
      'Content-Type': entry.contentType,
      'Cache-Control': 'no-cache',
      'ETag': entry.etag,
      'Vary': 'Accept-Encoding'
    };
    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').map(t => t.trim()).includes(entry.etag)) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (entry.gz && acceptsGzip) {
      headers['Content-Encoding'] = 'gzip';
      headers['Content-Length'] = entry.gz.length;
      res.writeHead(200, headers);
      res.end(entry.gz);
      return;
    }
    headers['Content-Length'] = entry.raw.length;
    res.writeHead(200, headers);
    res.end(entry.raw);
  });
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // Universal Health Check Endpoints for Render / Cloud deployments (instant 200 OK)
  if (pathname === '/healthz' || pathname === '/health' || pathname === '/ping' || pathname === '/api/health') {
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache'
    });
    res.end('OK');
    return;
  }

  // Handle HEAD requests for health checkers
  if (req.method === 'HEAD') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end();
    return;
  }

  if (pathname.startsWith('/api/')) {
    await handleApiRequest(req, res, parsedUrl);
  } else {
    handleStaticRequest(req, res, parsedUrl);
  }
});

function startServer() {
  // Bind port immediately so Render health checks succeed instantly without timing out
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`=======================================================`);
    console.log(`  Greeks.live Quantitative Market Intelligence Server  `);
    console.log(`  Running on 0.0.0.0:${PORT}                           `);
    console.log(`=======================================================`);
  });

  backgroundRefreshEnabled = true;
  console.log('[Server] Initializing market data cache...');
  refreshMarketInBackground()
    .then(() => console.log('[Server] Initial market data cache ready.'));

  fetchCdriData()
    .then(() => console.log('[Server] Initial CDRI data cache ready.'))
    .catch(e => console.warn('[Server] Initial CDRI fetch warning:', e.message));

  getCoinbaseLiquidityData()
    .then(() => console.log('[Server] Initial Coinbase liquidity cache ready.'))
    .catch(e => console.warn('[Server] Initial Coinbase fetch warning:', e.message));

  getMcClellanData()
    .then(() => console.log('[Server] Initial McClellan data cache ready.'))
    .catch(e => console.warn('[Server] Initial McClellan fetch warning:', e.message));

  getMacroChartData()
    .then(() => console.log('[Server] Initial Macro chart data cache ready.'))
    .catch(e => console.warn('[Server] Initial Macro fetch warning:', e.message));

  // 高频行情每 30 秒后台刷新；5 分钟内无人访问则暂停，避免空转消耗免费实例的 CPU 与外部配额
  setInterval(() => {
    if (isServerIdle()) return;
    refreshMarketInBackground();
  }, MARKET_REFRESH_MS);

  // Coinbase 深度每 5 分钟采样一次写入小时档案 (仅在有人访问时；可靠的逐小时序列由 GitHub Actions 记录)
  setInterval(() => {
    if (isServerIdle()) return;
    getCoinbaseLiquidityData(true)
      .catch(e => console.warn('[Server] Background Coinbase sample error:', e.message));
  }, 300000);

  // 宏观数据每 5 分钟刷新 (同样仅在有人访问时)
  setInterval(async () => {
    if (isServerIdle()) return;
    try {
      await getMacroChartData(true);
    } catch (e) {
      console.warn('[Server] Background macro sync error:', e.message);
    }
  }, 300000);

  // Strategy 官方披露采集：轻量 collector，每 5 分钟检查一次，不依赖浏览器是否
  // 打开 (无 isServerIdle 检查)。宿主休眠时仍然无法运行——此时依赖 GitHub Actions
  // 的六小时 producer job (macro_snapshot workflow) 与磁盘快照。
  getMstrDisclosures()
    .catch(e => console.warn('[Server] Initial MSTR disclosures warning:', e.message));
  setInterval(() => {
    getMstrDisclosures().catch(e => console.warn('[Server] MSTR disclosures poll error:', e.message));
  }, MSTR_DISCLOSURE_POLL_MS).unref();
}

if (require.main === module) {
  startServer();
}

module.exports = {
  server,
  startServer,
  sendJsonResponse,
  _internal: {
    fetchBinanceKlines, fetchKlinePages, fetchKlineTier,
    waveKlineSourceHealth, waveHealthSummary, waveSourceId, klineCacheEntry,
    KLINE_SOURCES, waveKlineCache, KLINE_TIERS, KLINE_SEC, noteApiActivity, isServerIdle,
    setBackgroundRefreshEnabled: v => { backgroundRefreshEnabled = !!v; },
    lastApiActivity: () => lastApiActivity
  }
};
