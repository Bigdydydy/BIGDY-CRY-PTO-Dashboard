const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { fetchWithTimeout } = require('./http_client');
const { recordAttempt, recordSuccess, recordFailure } = require('./data_health');
const { withDataHealth, seedCachedHealth, atomicWriteJson } = require('./data_health_cache');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'cdri_data.json');
let inMemoryCache = null;
let lastFetchTime = 0;
let inflight = null;
let diskSeeded = false;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes cache

const MAX_FUTURE_MS = 5 * 60 * 1000;
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const inBand = v => isNum(v) && v >= 0 && v <= 100;
const cdriTsMs = t => (isNum(t) ? (t > 1e11 ? t : t * 1000) : null);

/**
 * 近 365 天的最高/最低点。CoinGlass performance 的 yearHigh/yearLow 实为历史极值
 * (2026 年返回 2022/2024 的日期)，与「年度」标签不符，改由历史序列自算。
 */
function trailingYearExtremes(historyRaw, nowMs = Date.now()) {
  const times = historyRaw.timeList || [];
  const values = historyRaw.valueList || [];
  let hi = null, lo = null;
  times.forEach((t, i) => {
    const ms = t > 1e11 ? t : t * 1000;
    const v = Number(values[i]);
    if (ms < nowMs - 365 * 86400000 || !Number.isFinite(v)) return;
    if (!hi || v > hi.value) hi = { value: v, ms };
    if (!lo || v < lo.value) lo = { value: v, ms };
  });
  return { hi, lo };
}

/* CDRI schema validation: a payload failing these is a source failure and
 * never overwrites memory or disk. */

function validateCdriPerformance(p) {
  if (!p || typeof p !== 'object') return 'performance 缺失';
  if (!inBand(p.price)) return 'performance.price 非 [0,100] 有限数';
  for (const k of ['yesterday', 'week', 'month', 'yearHigh', 'yearLow']) {
    if (p[k] !== undefined && p[k] !== null && !inBand(p[k])) return `performance.${k} 越界 [0,100]`;
  }
  return null;
}

function validateCdriHistory(h) {
  if (!h || typeof h !== 'object') return 'history 缺失';
  const { timeList, valueList, priceList } = h;
  if (!Array.isArray(timeList) || !Array.isArray(valueList) || !Array.isArray(priceList)
      || !timeList.length || timeList.length !== valueList.length || timeList.length !== priceList.length) {
    return 'history timeList/valueList/priceList 为空或长度不等';
  }
  const nowMs = Date.now();
  let prev = -Infinity;
  for (let i = 0; i < timeList.length; i++) {
    const ms = cdriTsMs(timeList[i]);
    if (ms === null) return 'timeList 含非数值';
    if (ms <= prev) return 'timeList 非严格递增';
    if (ms > nowMs + MAX_FUTURE_MS) return 'timeList 含未来时间';
    prev = ms;
    if (!inBand(valueList[i])) return 'valueList 越界 [0,100]';
    if (!isNum(priceList[i]) || priceList[i] <= 0) return 'priceList 含非正值';
  }
  return null;
}

function cdriHistoryAsOf(h) {
  const ms = cdriTsMs(h.timeList[h.timeList.length - 1]);
  return ms === null ? null : new Date(ms).toISOString();
}

/** Same schema on persisted/in-memory payloads (missing values never back-filled). */
function validateCdriPayload(p) {
  if (!p || typeof p !== 'object') return 'payload 非对象';
  return validateCdriPerformance(p.performance) || validateCdriHistory(p.history);
}

function readValidatedDisk() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return validateCdriPayload(cached) ? null : cached;
  } catch (e) {
    console.warn('[CdriFetcher] Failed reading disk cache:', e.message);
    return null;
  }
}

/** Seed honest disk clocks once, before the first attempt is recorded. */
function seedDiskOnce() {
  if (diskSeeded) return;
  diskSeeded = true;
  const disk = readValidatedDisk();
  if (disk) {
    seedCachedHealth(disk, 'cdri', {
      dataAsOf: cdriHistoryAsOf(disk.history),
      lastSuccessAt: typeof disk.timestamp === 'number' ? disk.timestamp : null
    });
  }
}

// AES ECB 128 Decrypt with PKCS7
function aesEcbDecryptToHex(cipherTextB64, keyUtf8) {
  const cipherBuffer = Buffer.from(cipherTextB64, 'base64');
  const keyBuffer = Buffer.from(keyUtf8, 'utf8');
  const decipher = crypto.createDecipheriv('aes-128-ecb', keyBuffer, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(cipherBuffer), decipher.final()]).toString('hex');
}

function ee(hexStr) {
  const bytes = Buffer.from(hexStr, 'hex');
  return zlib.unzipSync(bytes).toString('utf8');
}

function ne(cipherTextB64, key) {
  const hex = aesEcbDecryptToHex(cipherTextB64, key);
  let str = ee(hex);
  if (str.startsWith('"')) str = str.slice(1);
  if (str.endsWith('"')) str = str.slice(0, -1);
  return str;
}

function getRe(url) {
  const idx = url.indexOf('/api');
  if (idx === -1) return url;
  const qIdx = url.indexOf('?');
  return qIdx === -1 ? url.slice(idx) : url.slice(idx, qIdx);
}

async function callCoinglassEndpoint(endpoint) {
  const url = 'https://capi.coinglass.com' + endpoint;
  const now = Date.now().toString();
  const resp = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://www.coinglass.com/pro/i/CDRI',
      'Origin': 'https://www.coinglass.com',
      'Accept': 'application/json, text/plain, */*',
      'cache-ts-v2': now,
      'encryption': 'true',
      'language': 'zh'
    }
  });

  if (!resp.ok) {
    throw new Error(`Coinglass HTTP ${resp.status} for ${endpoint}`);
  }

  const v = resp.headers.get('v');
  const user = resp.headers.get('user');
  const json = await resp.json();

  if (json.code !== '0' && json.code !== 0) {
    throw new Error(`Coinglass API error: ${json.msg || json.code}`);
  }

  if (!json.data) {
    return null;
  }

  if (typeof json.data === 'object') {
    return json.data;
  }

  let key1_raw = '';
  if (v === '77') key1_raw = '863f08689c97435b';
  else if (v === '66') key1_raw = 'd6537d845a964081';
  else if (v === '55') key1_raw = '170b070da9654622';
  else if (v === '0') key1_raw = now;
  else if (v === '1') key1_raw = getRe(url);
  else if (v === '2') key1_raw = resp.headers.get('time') || '';

  const key1 = Buffer.from(key1_raw).toString('base64').slice(0, 16);
  const key2 = ne(user, key1);
  const decryptedStr = ne(json.data, key2);
  return JSON.parse(decryptedStr);
}

function getRiskInfo(score) {
  if (score == null) return { level: '--', levelEn: '--', color: '#999', bg: 'rgba(153,153,153,0.1)', border: '#666' };
  if (score <= 30) {
    return { level: '低风险', levelEn: 'Low Risk', color: '#22ab94', bg: 'rgba(34, 171, 148, 0.15)', border: '#3da672' };
  } else if (score <= 60) {
    return { level: '中性波动', levelEn: 'Neutral Volatility', color: '#93ea2a', bg: 'rgba(147, 234, 42, 0.15)', border: '#93ea2a' };
  } else if (score <= 80) {
    return { level: '高风险', levelEn: 'High Risk', color: '#ffc800', bg: 'rgba(255, 200, 0, 0.15)', border: '#ffc800' };
  } else {
    return { level: '极端风险', levelEn: 'Extreme Risk', color: '#f23645', bg: 'rgba(242, 54, 69, 0.15)', border: '#cd6200' };
  }
}

function formatUtc8Date(timestampMs) {
  if (!timestampMs) return '';
  const d = new Date(Number(timestampMs));
  const utc8 = new Date(d.getTime() + 8 * 3600 * 1000);
  const y = utc8.getUTCFullYear();
  const m = String(utc8.getUTCMonth() + 1).padStart(2, '0');
  const day = String(utc8.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatUtc8DateTime(timestampMs) {
  if (!timestampMs) return '';
  const d = new Date(Number(timestampMs));
  const utc8 = new Date(d.getTime() + 8 * 3600 * 1000);
  const y = utc8.getUTCFullYear();
  const m = String(utc8.getUTCMonth() + 1).padStart(2, '0');
  const day = String(utc8.getUTCDate()).padStart(2, '0');
  const h = String(utc8.getUTCHours()).padStart(2, '0');
  const min = String(utc8.getUTCMinutes()).padStart(2, '0');
  const s = String(utc8.getUTCSeconds()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${min}:${s}`;
}

/** Single-flight: concurrent callers share one in-flight upstream round. */
function fetchCdriData(forceRefresh = false) {
  if (inflight) return inflight;
  inflight = doFetchCdriData(forceRefresh).finally(() => { inflight = null; });
  return inflight;
}

async function doFetchCdriData(forceRefresh = false) {
  const now = Date.now();
  seedDiskOnce();

  // Return in-memory cache if valid (cache hit never extends lastSuccessAt)
  if (!forceRefresh && inMemoryCache && (now - lastFetchTime < CACHE_TTL_MS)) {
    return withDataHealth(inMemoryCache, ['cdri']);
  }

  // Check disk cache if valid
  if (!forceRefresh) {
    const cached = readValidatedDisk();
    const cachedAt = cached && typeof cached.timestamp === 'number' ? cached.timestamp : 0;
    if (cached && now - cachedAt < CACHE_TTL_MS) {
      inMemoryCache = cached;
      lastFetchTime = cachedAt;
      return withDataHealth(inMemoryCache, ['cdri']);
    }
  }

  console.log('[CdriFetcher] Fetching fresh CDRI data from Coinglass...');
  recordAttempt('cdri', { now: Date.now() });

  try {
    const [perfRaw, historyRaw] = await Promise.all([
      callCoinglassEndpoint('/api/index/cgri/performance'),
      callCoinglassEndpoint('/api/index/cgri')
    ]);

    if (!perfRaw || !historyRaw) {
      throw new Error('Failed to retrieve CDRI data from Coinglass');
    }
    const bad = validateCdriPerformance(perfRaw) || validateCdriHistory(historyRaw);
    if (bad) throw new Error(`CDRI payload 校验失败: ${bad}`);

    const currentScore = perfRaw.price ?? null;
    const currentRisk = getRiskInfo(currentScore);

    const yesterdayRisk = getRiskInfo(perfRaw.yesterday);
    const weekRisk = getRiskInfo(perfRaw.week);
    const monthRisk = getRiskInfo(perfRaw.month);
    const { hi: yearHi, lo: yearLo } = trailingYearExtremes(historyRaw, now);
    const yearHigh = yearHi ? yearHi.value : (perfRaw.yearHigh ?? null);
    const yearHighDate = yearHi ? yearHi.ms : perfRaw.yearHighDate;
    const yearLow = yearLo ? yearLo.value : (perfRaw.yearLow ?? null);
    const yearLowDate = yearLo ? yearLo.ms : perfRaw.yearLowDate;
    const yearHighRisk = getRiskInfo(yearHigh);
    const yearLowRisk = getRiskInfo(yearLow);

    const performance = {
      price: currentScore,
      level: currentRisk.level,
      levelEn: currentRisk.levelEn,
      color: currentRisk.color,
      yesterday: perfRaw.yesterday ?? null,
      yesterdayRisk,
      week: perfRaw.week ?? null,
      weekRisk,
      month: perfRaw.month ?? null,
      monthRisk,
      yearHigh,
      yearHighDate,
      yearHighDateStr: formatUtc8Date(yearHighDate),
      yearHighRisk,
      yearLow,
      yearLowDate,
      yearLowDateStr: formatUtc8Date(yearLowDate),
      yearLowRisk,
      yearExtremesBasis: yearHi ? 'trailing_365d' : 'provider',
      // 供参考：CoinGlass 原字段 (历史极值)
      allTimeHigh: perfRaw.yearHigh ?? null,
      allTimeHighDateStr: formatUtc8Date(perfRaw.yearHighDate),
      allTimeLow: perfRaw.yearLow ?? null,
      allTimeLowDateStr: formatUtc8Date(perfRaw.yearLowDate)
    };

    // Process history: timeList is in seconds (or ms)
    const rawTimes = historyRaw.timeList || [];
    const dates = rawTimes.map(t => {
      const ms = t > 1e11 ? t : t * 1000;
      return formatUtc8Date(ms);
    });

    const history = {
      timeList: rawTimes,
      dates,
      valueList: historyRaw.valueList || [],
      priceList: historyRaw.priceList || []
    };

    const result = {
      performance,
      history,
      updatedAt: formatUtc8DateTime(now),
      timestamp: now
    };

    // Real HTTP completion: data-as-of is the provider's latest history bar.
    recordSuccess('cdri', { dataAsOf: cdriHistoryAsOf(historyRaw), asOfKind: 'source', source: 'coinglass/cgri' });
    const bound = withDataHealth(result, ['cdri']);
    inMemoryCache = bound;
    lastFetchTime = Date.now();

    // Save to cache file (atomic: a failed write never corrupts the last good file)
    try {
      const dir = path.dirname(CACHE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      atomicWriteJson(CACHE_FILE, bound, 2);
      console.log('[CdriFetcher] CDRI cache successfully updated');
    } catch (e) {
      console.warn('[CdriFetcher] Failed writing disk cache:', e.message);
    }

    return bound;
  } catch (err) {
    console.error('[CdriFetcher] Error fetching CDRI data:', err.message);
    recordFailure('cdri', err);

    // Failure path: prefer a schema-valid in-memory copy, then validated disk.
    if (inMemoryCache && !validateCdriPayload(inMemoryCache)) {
      return withDataHealth(inMemoryCache, ['cdri']);
    }
    const disk = readValidatedDisk();
    if (disk) {
      inMemoryCache = disk;
      return withDataHealth(disk, ['cdri']);
    }
    throw err;
  }
}

module.exports = {
  fetchCdriData,
  callCoinglassEndpoint,
  getRiskInfo
};
