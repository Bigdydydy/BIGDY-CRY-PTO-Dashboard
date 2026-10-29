const fs = require('fs');
const path = require('path');
const { fetchWithTimeout } = require('./http_client');
const { fetchSpotDailyCloses } = require('./spot_daily');
const { recordAttempt, recordSuccess, recordFailure } = require('./data_health');
const { withDataHealth, seedCachedHealth, atomicWriteJson } = require('./data_health_cache');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'ssro_chart.json');
let inMemoryCache = null;
let lastFetchTime = 0;
let inflight = null;
let diskSeeded = false;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes cache
// stablecoincharts/all 约 1.3MB，Render 出口偶尔要 10s 以上才传完
const DEFILLAMA_TIMEOUT_MS = 30000;
let lastStableMap = null;
const REQUIRED_IDS = ['ssro', 'ssro_stable'];
const ANCILLARY_IDS = ['ssro_quote'];

/** Built payload schema: nonempty points with finite positive price/cap/ssr,
 * strictly ascending non-future dates; ssro200/ssro50 may be null in warmup. */
function validateSsroPayload(p) {
  if (!p || typeof p !== 'object' || !Array.isArray(p.points) || !p.points.length) return 'ssro points 为空';
  const nowMs = Date.now();
  let prev = '';
  for (const pt of p.points) {
    if (!pt || typeof pt.date !== 'string' || isNaN(Date.parse(pt.date))) return 'point date 非法';
    if (Date.parse(pt.date) > nowMs + 5 * 60000) return 'point date 在未来';
    if (pt.date <= prev) return 'point dates 非严格递增';
    prev = pt.date;
    for (const k of ['btcPrice', 'stableCap', 'ssr']) {
      if (!Number.isFinite(Number(pt[k])) || Number(pt[k]) <= 0 || typeof pt[k] === 'boolean') return `point.${k} 非正值`;
    }
    for (const k of ['ssro200', 'ssro50']) {
      if (pt[k] !== null && pt[k] !== undefined && !Number.isFinite(pt[k])) return `point.${k} 非法`;
    }
  }
  return null;
}

function readValidatedDisk() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return validateSsroPayload(cached) ? null : cached;
  } catch (e) {
    return null;
  }
}

/** Seed honest disk clocks once for every required + ancillary source —
 * persisted per-source health wins; legacy files keep only aggregate hints. */
function seedDiskOnce() {
  if (diskSeeded) return;
  diskSeeded = true;
  const disk = readValidatedDisk();
  if (disk) {
    const hints = {
      ssro: { dataAsOf: disk.latest?.date || disk.summary?.endDate || null, lastSuccessAt: disk.updatedAt || null },
      ssro_stable: { dataAsOf: disk.summary?.endDate || null, lastSuccessAt: disk.updatedAt || null }
    };
    for (const id of [...REQUIRED_IDS, ...ANCILLARY_IDS]) {
      seedCachedHealth(disk, id, hints[id] || {});
    }
  }
}

/**
 * Fetch JSON with resilient timeout, retries, and headers
 */
async function fetchJson(url, options = {}) {
  const res = await fetchWithTimeout(url, {
    timeout: 12000,
    retries: 1,
    ...options,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      ...(options.headers || {})
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return await res.json();
}

/**
 * Fetch real-time TradingView STABLE.C and BTC quote from TradingView global scanner
 */
async function fetchTradingViewQuote() {
  try {
    const postData = JSON.stringify({
      symbols: { tickers: ['CRYPTOCAP:STABLE.C', 'BINANCE:BTCUSDT', 'CRYPTOCAP:BTC'] },
      columns: ['name', 'close', 'change', 'description', 'SMA50', 'SMA200', 'time']
    });

    const data = await fetchJson('https://scanner.tradingview.com/global/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: postData
    });

    const result = {
      stableCap: null,
      stableChange: null,
      btcPrice: null,
      btcCap: null,
      time: Date.now()
    };

    if (data && Array.isArray(data.data)) {
      for (const row of data.data) {
        if (row.s === 'CRYPTOCAP:STABLE.C') {
          result.stableCap = row.d[1];
          result.stableChange = row.d[2];
        } else if (row.s === 'BINANCE:BTCUSDT') {
          result.btcPrice = row.d[1];
        } else if (row.s === 'CRYPTOCAP:BTC') {
          result.btcCap = row.d[1];
        }
      }
    }

    // Fallback to symbol endpoint if scanner missed STABLE.C
    if (!result.stableCap) {
      const symData = await fetchJson('https://scanner.tradingview.com/symbol?symbol=CRYPTOCAP%3ASTABLE.C&fields=close,change,high,low');
      if (symData && symData.close) {
        result.stableCap = symData.close;
        result.stableChange = symData.change;
      }
    }

    const missing = [!result.stableCap && 'STABLE.C', !result.btcPrice && 'BTCUSDT'].filter(Boolean);
    if (missing.length) result.error = `TradingView 返回缺 ${missing.join('/')}`;
    return result;
  } catch (err) {
    console.warn('[SSRO] TradingView quote fetch warning:', err.message);
    return {
      stableCap: null,
      stableChange: null,
      btcPrice: null,
      btcCap: null,
      time: Date.now(),
      error: err.message
    };
  }
}

/**
 * Fetch historical stablecoin circulating market caps from DefiLlama
 */
async function fetchDefiLlamaStablecoins() {
  recordAttempt('ssro_stable', { now: Date.now() });
  try {
    const data = await fetchJson('https://stablecoins.llama.fi/stablecoincharts/all', { timeout: DEFILLAMA_TIMEOUT_MS });
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error('Invalid DefiLlama payload');
    }
    // Validate EVERY row first — a malformed/future/non-finite row must not be
    // silently skipped into a "successful" history.
    const map = new Map();
    const nowMs = Date.now();
    for (const item of data) {
      const rawDate = item && item.date;
      const sec = Number(rawDate);
      if (rawDate === null || rawDate === undefined || typeof rawDate === 'boolean'
          || (typeof rawDate === 'string' && !/^\d+$/.test(rawDate.trim()))
          || !Number.isFinite(sec) || sec <= 0) {
        throw new Error(`DefiLlama row: invalid date ${JSON.stringify(rawDate)}`);
      }
      if (sec * 1000 > nowMs + 5 * 60000) {
        throw new Error(`DefiLlama row: future date ${new Date(sec * 1000).toISOString()}`);
      }
      const d = new Date(sec * 1000).toISOString().slice(0, 10);
      const cap = item.totalCirculatingUSD?.peggedUSD ?? item.totalCirculating?.peggedUSD;
      if (typeof cap === 'boolean' || !Number.isFinite(Number(cap)) || !(Number(cap) > 0)) {
        throw new Error(`DefiLlama row ${d}: invalid cap ${JSON.stringify(cap)}`);
      }
      map.set(d, Number(cap));
    }
    if (!map.size) throw new Error('DefiLlama payload: 无有效 date/cap 行');
    const maxDate = Array.from(map.keys()).sort().pop();
    recordSuccess('ssro_stable', { dataAsOf: maxDate, asOfKind: 'source', source: 'defillama/stablecoincharts' });
    lastStableMap = map;
    return { map, fromCache: false };
  } catch (err) {
    console.error('[SSRO] DefiLlama historical fetch error:', err.message);
    recordFailure('ssro_stable', err);
    const fallback = cachedStableHistory();
    if (fallback.size) console.warn(`[SSRO] DefiLlama 失败，沿用缓存稳定币历史 ${fallback.size} 天`);
    return { map: fallback, fromCache: true };
  }
}

/** 上次成功的稳定币历史：内存优先，其次已验证的磁盘 payload。
 * 只用于让 BTC 腿继续更新；ssro_stable 的时钟不推进，交集止于缓存最后一天。 */
function cachedStableHistory() {
  if (lastStableMap && lastStableMap.size) return lastStableMap;
  const disk = inMemoryCache || readValidatedDisk();
  const map = new Map();
  for (const pt of (disk && disk.points) || []) map.set(pt.date, Number(pt.stableCap));
  return map;
}

/**
 * Fetch daily BTC close price history (Binance, falling back to OKX / Coinbase when the host
 * is blocked — see spot_daily.js). Records which venue served the data.
 */
let btcDailyVenue = null;
async function fetchBtcDaily(startDateStr = '2021-01-01') {
  try {
    const { venue, series, errors } = await fetchSpotDailyCloses(['BTC'], new Date(startDateStr).getTime());
    if (errors.length) console.warn(`[SSRO] BTC daily from ${venue} after: ${errors.join(' | ')}`);
    btcDailyVenue = venue;
    return new Map(series.BTC.map(r => [r.date, r.close]));
  } catch (err) {
    console.error('[SSRO] BTC daily price fetch error:', err.message);
    return new Map();
  }
}

/**
 * Calculate circulating Bitcoin supply curve (Halving-aware)
 */
function getBtcSupply(dateStr) {
  const t = new Date(dateStr).getTime();
  const t0 = new Date('2021-01-01').getTime();
  const tHalving2024 = new Date('2024-04-20').getTime();
  if (t < tHalving2024) {
    const days = (t - t0) / 86400000;
    return 18587000 + days * 900;
  } else {
    const daysPre = (tHalving2024 - t0) / 86400000;
    const daysPost = (t - tHalving2024) / 86400000;
    return 18587000 + daysPre * 900 + daysPost * 450;
  }
}

/**
 * PineScript calculation:
 * method ssro(float src, array<float> stblsrc, int len) =>
 *     float ssr = src / stblsrc.sum()
 *     (ssr - ta.sma(ssr, len)) / ta.stdev(ssr, len)
 */
function computePineScriptSsro(records, len = 200) {
  const n = records.length;
  const result = new Array(n).fill(null);
  const smaArr = new Array(n).fill(null);
  const stdevArr = new Array(n).fill(null);

  for (let i = 0; i < n; i++) {
    if (i >= len - 1) {
      let sum = 0;
      for (let j = i - len + 1; j <= i; j++) {
        sum += records[j].ssr;
      }
      const sma = sum / len;
      smaArr[i] = sma;

      let varSum = 0;
      for (let j = i - len + 1; j <= i; j++) {
        varSum += Math.pow(records[j].ssr - sma, 2);
      }
      const stdev = Math.sqrt(varSum / len);
      stdevArr[i] = stdev;

      if (stdev > 0) {
        result[i] = (records[i].ssr - sma) / stdev;
      } else {
        result[i] = 0;
      }
    }
  }

  return { ssro: result, sma: smaArr, stdev: stdevArr };
}

/**
 * Fetch and build the complete SSRO dataset
 */
async function fetchAndBuildSsroData() {
  console.log('[SSRO] Initiating data ingestion for BTC & STABLE.C...');

  const [tvQuote, { map: stableHistoryMap, fromCache: stableFromCache }, btcDailyMap] = await Promise.all([
    fetchTradingViewQuote(),
    fetchDefiLlamaStablecoins(),
    fetchBtcDaily('2021-01-01')
  ]);

  console.log(`[SSRO] Ingestion stats: TV STABLE.C=$${tvQuote.stableCap ? (tvQuote.stableCap / 1e9).toFixed(2) + 'B' : 'N/A'}, DefiLlama=${stableHistoryMap.size} days, BTC=${btcDailyMap.size} days`);

  // TradingView 实时报价：两腿都取得有限正值才算一次成功报价，
  // 缺任一腿绝不拿历史值生成"今天"
  const quoteValid = Number.isFinite(Number(tvQuote.stableCap)) && Number(tvQuote.stableCap) > 0
    && Number.isFinite(Number(tvQuote.btcPrice)) && Number(tvQuote.btcPrice) > 0;
  if (quoteValid) {
    recordSuccess('ssro_quote', { dataAsOf: new Date().toISOString(), asOfKind: 'received', source: 'tradingview/scan' });
  } else {
    recordFailure('ssro_quote', new Error(tvQuote.error || 'TradingView 报价缺 stableCap 或 btcPrice'));
  }

  // Intersect dates
  const dates = Array.from(btcDailyMap.keys())
    .filter(d => stableHistoryMap.has(d))
    .sort();

  if (dates.length === 0) {
    // 历史交集为空 = 构建失败；由 getter 负责磁盘兜底
    throw new Error('Failed to retrieve history for SSRO calculation');
  }

  const rawRecords = [];
  for (const date of dates) {
    const btcPrice = btcDailyMap.get(date);
    const stableCap = stableHistoryMap.get(date);
    const supply = getBtcSupply(date);
    const btcCap = btcPrice * supply;
    const ssr = btcCap / stableCap;
    rawRecords.push({
      date,
      btcPrice,
      btcCap,
      stableCap,
      ssr
    });
  }

  // 仅在实时报价双腿都有效、且历史连到昨天或今天时，用它更新/追加"今天"；
  // 否则保留最后一个真实历史日期，绝不拿历史腿的价格冒充今天的报价，也不跨缺口拼接
  const todayStr = new Date().toISOString().slice(0, 10);
  const yesterdayStr = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (quoteValid && rawRecords[rawRecords.length - 1].date >= yesterdayStr) {
    const livePrice = tvQuote.btcPrice;
    const liveStableCap = tvQuote.stableCap;
    const liveSupply = getBtcSupply(todayStr);
    const liveBtcCap = livePrice * liveSupply;
    const liveSsr = liveBtcCap / liveStableCap;

    const lastRecord = rawRecords[rawRecords.length - 1];
    if (lastRecord && lastRecord.date === todayStr) {
      lastRecord.btcPrice = livePrice;
      lastRecord.btcCap = liveBtcCap;
      lastRecord.stableCap = liveStableCap;
      lastRecord.ssr = liveSsr;
    } else {
      rawRecords.push({
        date: todayStr,
        btcPrice: livePrice,
        btcCap: liveBtcCap,
        stableCap: liveStableCap,
        ssr: liveSsr
      });
    }
  }

  // Compute PineScript SSRO for len = 200 (Macro default) and len = 50 (tactical)
  const calc200 = computePineScriptSsro(rawRecords, 200);
  const calc50 = computePineScriptSsro(rawRecords, 50);

  const points = rawRecords.map((r, idx) => {
    const ssro200 = calc200.ssro[idx];
    const sma200 = calc200.sma[idx];
    const stdev200 = calc200.stdev[idx];

    const ssro50 = calc50.ssro[idx];
    const sma50 = calc50.sma[idx];
    const stdev50 = calc50.stdev[idx];

    return {
      date: r.date,
      btcPrice: Math.round(r.btcPrice * 100) / 100,
      stableCap: Math.round(r.stableCap),
      ssr: Math.round(r.ssr * 1000) / 1000,
      ssro200: ssro200 !== null ? Math.round(ssro200 * 1000) / 1000 : null,
      sma200: sma200 !== null ? Math.round(sma200 * 1000) / 1000 : null,
      stdev200: stdev200 !== null ? Math.round(stdev200 * 1000) / 1000 : null,
      upper2_200: sma200 !== null && stdev200 !== null ? Math.round((sma200 + 2 * stdev200) * 1000) / 1000 : null,
      lower2_200: sma200 !== null && stdev200 !== null ? Math.round((sma200 - 2 * stdev200) * 1000) / 1000 : null,
      ssro50: ssro50 !== null ? Math.round(ssro50 * 1000) / 1000 : null,
      sma50: sma50 !== null ? Math.round(sma50 * 1000) / 1000 : null,
      stdev50: stdev50 !== null ? Math.round(stdev50 * 1000) / 1000 : null
    };
  });

  const latestPoint = points[points.length - 1];

  // Determine market liquidity state & quant evaluation
  let quantZone = 'neutral';
  let quantZoneLabel = '均衡区间';
  let quantColor = 'text-primary';
  let quantSignal = 'BTC 市值与稳定币总量之比处于统计常态区间 (|z| ≤ 1)。';

  const z = latestPoint.ssro200 !== null ? latestPoint.ssro200 : (latestPoint.ssro50 || 0);
  if (z <= -2.0) {
    quantZone = 'extreme_oversold';
    quantZoneLabel = '稳定币相对充裕 (z ≤ -2)';
    quantColor = 'text-green';
    quantSignal = 'BTC 市值相对稳定币总量处于统计低位，稳定币存量相对 BTC 偏大。存量不等于买入意愿：稳定币也用作保证金、支付与 DeFi 抵押；本模块未统计该区间之后的历史胜率。';
  } else if (z < -1.0) {
    quantZone = 'moderately_oversold';
    quantZoneLabel = '稳定币偏充裕 (-2 < z < -1)';
    quantColor = 'text-green-light';
    quantSignal = 'BTC 市值相对稳定币总量偏低；稳定币存量是否转化为现货买盘，需结合交易所稳定币净流入观察。';
  } else if (z >= 2.0) {
    quantZone = 'extreme_overbought';
    quantZoneLabel = '稳定币相对紧缺 (z ≥ 2)';
    quantColor = 'text-red';
    quantSignal = 'BTC 市值增速明显快于稳定币总量，上涨更多依赖稳定币以外的资金或杠杆。这提高了回撤时的脆弱性，但不构成顶部判断。';
  } else if (z > 1.0) {
    quantZone = 'moderately_overbought';
    quantZoneLabel = '稳定币偏紧 (1 < z < 2)';
    quantColor = 'text-amber';
    quantSignal = 'BTC 市值相对稳定币总量偏高，稳定币存量对现价的覆盖在下降。';
  }

  const payload = {
    code: 0,
    updatedAt: new Date().toISOString(),
    source: `TradingView (CRYPTOCAP:STABLE.C) & DefiLlama & ${btcDailyVenue || 'Binance'}`,
    pinescript: `method ssro(float src, array<float> stblsrc, int len) =>\n    float ssr = src / stblsrc.sum()               // Source of the underlying divided by the sum of stablecoin sources\n    (ssr - ta.sma(ssr, len)) / ta.stdev(ssr, len) // Z-Score Transformed`,
    latest: {
      date: latestPoint.date,
      btcPrice: latestPoint.btcPrice,
      stableCap: latestPoint.stableCap,
      stableCapBillions: (latestPoint.stableCap / 1e9).toFixed(2),
      ssr: latestPoint.ssr,
      ssro200: latestPoint.ssro200,
      ssro50: latestPoint.ssro50,
      tvQuote: {
        symbol: 'CRYPTOCAP:STABLE.C',
        change24h: tvQuote.stableChange || 0,
        priceUsd: tvQuote.stableCap || latestPoint.stableCap
      },
      quantEvaluation: {
        zScore: z,
        zone: quantZone,
        label: quantZoneLabel,
        colorClass: quantColor,
        signal: quantSignal
      }
    },
    summary: {
      totalDays: points.length,
      startDate: points[0].date,
      endDate: latestPoint.date,
      minSsro200: Math.min(...points.filter(p => p.ssro200 !== null).map(p => p.ssro200)),
      maxSsro200: Math.max(...points.filter(p => p.ssro200 !== null).map(p => p.ssro200))
    },
    points
  };

  const invalid = validateSsroPayload(payload);
  if (invalid) {
    recordFailure('ssro', new Error(`SSRO payload 校验失败: ${invalid}`));
    if (inMemoryCache) return withDataHealth(inMemoryCache, REQUIRED_IDS, ANCILLARY_IDS);
    throw new Error(`SSRO payload 校验失败: ${invalid}`);
  }

  recordSuccess('ssro', {
    dataAsOf: latestPoint.date, asOfKind: 'source', source: 'ssro/build',
    issues: [
      ...(quoteValid ? [] : ['TradingView 实时报价缺失，未注入今日报价']),
      ...(stableFromCache ? ['DefiLlama 未更新，稳定币历史沿用缓存'] : [])
    ]
  });

  // Persist AFTER the success is recorded, with required+ancillary health
  // bound in so the next cold start can restore honest clocks (atomic write —
  // a failed write never corrupts the last good file). A round built on cached
  // stablecoin history is served but not persisted: disk keeps the last fully live build.
  const bound = withDataHealth(payload, REQUIRED_IDS, ANCILLARY_IDS);
  if (!stableFromCache) {
    try {
      atomicWriteJson(CACHE_FILE, bound, 2);
      console.log('[SSRO] Successfully updated cache at:', CACHE_FILE);
    } catch (e) {
      console.warn('[SSRO] Failed to write disk cache:', e.message);
    }
  }

  inMemoryCache = bound;
  lastFetchTime = Date.now();
  return bound;
}

/**
 * Get SSRO data with memory & disk caching (single-flight)
 */
async function getSsroData(force = false) {
  const now = Date.now();
  // Seed disk clocks BEFORE any return path — a warm-disk hit must not skip it.
  seedDiskOnce();
  if (!force && inMemoryCache && (now - lastFetchTime < CACHE_TTL_MS)) {
    return withDataHealth(inMemoryCache, REQUIRED_IDS, ANCILLARY_IDS);
  }

  if (!force && !inMemoryCache && fs.existsSync(CACHE_FILE)) {
    try {
      const cached = readValidatedDisk();
      const cachedAt = cached && cached.updatedAt ? new Date(cached.updatedAt).getTime() : 0;
      if (cached && now - cachedAt < CACHE_TTL_MS) {
        inMemoryCache = cached;
        lastFetchTime = cachedAt;
        console.log('[SSRO] Served from warm disk cache');
        return withDataHealth(inMemoryCache, REQUIRED_IDS, ANCILLARY_IDS);
      }
    } catch (e) {
      console.warn('[SSRO] Error reading disk cache:', e.message);
    }
  }

  if (inflight) return inflight;
  inflight = (async () => {
    try {
      return await fetchAndBuildSsroData();
    } catch (err) {
      recordFailure('ssro', err);
      // 失败兜底：内存有效数据优先，其次验证过的磁盘缓存（标记 fallback，不推进时钟）
      const cached = inMemoryCache || readValidatedDisk();
      if (cached) {
        if (!inMemoryCache) { inMemoryCache = cached; lastFetchTime = Date.now(); }
        return withDataHealth(cached, REQUIRED_IDS, ANCILLARY_IDS);
      }
      throw err;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

module.exports = {
  getSsroData,
  fetchAndBuildSsroData
};
