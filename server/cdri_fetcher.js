const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'cdri_data.json');
let inMemoryCache = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes cache

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
  const resp = await fetch(url, {
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

async function fetchCdriData(forceRefresh = false) {
  const now = Date.now();

  // Return in-memory cache if valid
  if (!forceRefresh && inMemoryCache && (now - lastFetchTime < CACHE_TTL_MS)) {
    return inMemoryCache;
  }

  // Check disk cache if valid
  if (!forceRefresh && fs.existsSync(CACHE_FILE)) {
    try {
      const fileStat = fs.statSync(CACHE_FILE);
      if (now - fileStat.mtimeMs < CACHE_TTL_MS) {
        const raw = fs.readFileSync(CACHE_FILE, 'utf8');
        inMemoryCache = JSON.parse(raw);
        lastFetchTime = fileStat.mtimeMs;
        return inMemoryCache;
      }
    } catch (e) {
      console.warn('[CdriFetcher] Failed reading disk cache:', e.message);
    }
  }

  console.log('[CdriFetcher] Fetching fresh CDRI data from Coinglass...');

  try {
    const [perfRaw, historyRaw] = await Promise.all([
      callCoinglassEndpoint('/api/index/cgri/performance'),
      callCoinglassEndpoint('/api/index/cgri')
    ]);

    if (!perfRaw || !historyRaw) {
      throw new Error('Failed to retrieve CDRI data from Coinglass');
    }

    const currentScore = perfRaw.price ?? null;
    const currentRisk = getRiskInfo(currentScore);

    const yesterdayRisk = getRiskInfo(perfRaw.yesterday);
    const weekRisk = getRiskInfo(perfRaw.week);
    const monthRisk = getRiskInfo(perfRaw.month);
    const yearHighRisk = getRiskInfo(perfRaw.yearHigh);
    const yearLowRisk = getRiskInfo(perfRaw.yearLow);

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
      yearHigh: perfRaw.yearHigh ?? null,
      yearHighDate: perfRaw.yearHighDate,
      yearHighDateStr: formatUtc8Date(perfRaw.yearHighDate),
      yearHighRisk,
      yearLow: perfRaw.yearLow ?? null,
      yearLowDate: perfRaw.yearLowDate,
      yearLowDateStr: formatUtc8Date(perfRaw.yearLowDate),
      yearLowRisk
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

    inMemoryCache = result;
    lastFetchTime = now;

    // Save to cache file
    try {
      const dir = path.dirname(CACHE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(result, null, 2), 'utf8');
      console.log('[CdriFetcher] CDRI cache successfully updated');
    } catch (e) {
      console.warn('[CdriFetcher] Failed writing disk cache:', e.message);
    }

    return result;
  } catch (err) {
    console.error('[CdriFetcher] Error fetching CDRI data:', err.message);

    // If fetch failed, return disk cache if available even if stale
    if (fs.existsSync(CACHE_FILE)) {
      try {
        const raw = fs.readFileSync(CACHE_FILE, 'utf8');
        inMemoryCache = JSON.parse(raw);
        return inMemoryCache;
      } catch (e) {}
    }

    if (inMemoryCache) return inMemoryCache;
    throw err;
  }
}

module.exports = {
  fetchCdriData,
  getRiskInfo
};
