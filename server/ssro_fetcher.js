const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'ssro_chart.json');
let inMemoryCache = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes cache

/**
 * Fetch JSON with basic timeout and headers
 */
async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        ...(options.headers || {})
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timeoutId);
  }
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

    return result;
  } catch (err) {
    console.warn('[SSRO] TradingView quote fetch warning:', err.message);
    return {
      stableCap: null,
      stableChange: null,
      btcPrice: null,
      btcCap: null,
      time: Date.now()
    };
  }
}

/**
 * Fetch historical stablecoin circulating market caps from DefiLlama
 */
async function fetchDefiLlamaStablecoins() {
  try {
    const data = await fetchJson('https://stablecoins.llama.fi/stablecoincharts/all');
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error('Invalid DefiLlama payload');
    }
    const map = new Map();
    for (const item of data) {
      const d = new Date(parseInt(item.date, 10) * 1000).toISOString().slice(0, 10);
      const cap = item.totalCirculatingUSD?.peggedUSD || item.totalCirculating?.peggedUSD || 0;
      if (cap > 0) {
        map.set(d, cap);
      }
    }
    return map;
  } catch (err) {
    console.error('[SSRO] DefiLlama historical fetch error:', err.message);
    return new Map();
  }
}

/**
 * Fetch daily BTC close price history from Binance
 */
async function fetchBinanceBtcDaily(startDateStr = '2021-01-01') {
  try {
    let start = new Date(startDateStr).getTime();
    const now = Date.now();
    const allKlines = [];
    while (start < now) {
      const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&startTime=${start}&limit=1000`;
      const data = await fetchJson(url);
      if (!Array.isArray(data) || data.length === 0) break;
      allKlines.push(...data);
      const lastTime = data[data.length - 1][0];
      if (lastTime <= start) break;
      start = lastTime + 86400000;
    }
    const map = new Map();
    for (const k of allKlines) {
      const d = new Date(k[0]).toISOString().slice(0, 10);
      map.set(d, parseFloat(k[4])); // Daily close
    }
    return map;
  } catch (err) {
    console.error('[SSRO] Binance BTC price fetch error:', err.message);
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

  const [tvQuote, stableHistoryMap, btcDailyMap] = await Promise.all([
    fetchTradingViewQuote(),
    fetchDefiLlamaStablecoins(),
    fetchBinanceBtcDaily('2021-01-01')
  ]);

  console.log(`[SSRO] Ingestion stats: TV STABLE.C=$${tvQuote.stableCap ? (tvQuote.stableCap / 1e9).toFixed(2) + 'B' : 'N/A'}, DefiLlama=${stableHistoryMap.size} days, BTC=${btcDailyMap.size} days`);

  // Intersect dates
  const dates = Array.from(btcDailyMap.keys())
    .filter(d => stableHistoryMap.has(d))
    .sort();

  if (dates.length === 0) {
    if (fs.existsSync(CACHE_FILE)) {
      console.warn('[SSRO] Live fetch returned empty, using disk cache');
      const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      return cached;
    }
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

  // Update or append the latest day with live TradingView quote if available
  const todayStr = new Date().toISOString().slice(0, 10);
  const livePrice = tvQuote.btcPrice || (rawRecords.length > 0 ? rawRecords[rawRecords.length - 1].btcPrice : 77000);
  const liveStableCap = tvQuote.stableCap || (rawRecords.length > 0 ? rawRecords[rawRecords.length - 1].stableCap : 309e9);
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
  let quantZoneLabel = '均衡博弈区';
  let quantColor = 'text-primary';
  let quantSignal = '流动性供需处于统计正态平衡区间，价格受现货与微观期权综合驱动。';

  const z = latestPoint.ssro200 !== null ? latestPoint.ssro200 : (latestPoint.ssro50 || 0);
  if (z <= -2.0) {
    quantZone = 'extreme_oversold';
    quantZoneLabel = '极度充沛 (强劲支撑)';
    quantColor = 'text-green';
    quantSignal = '稳定币蓄水池相对于 BTC 市值处于历史充沛高位，场外买盘承接与抄底法币弹药充盈，具有高胜率宏观支撑。';
  } else if (z < -1.0) {
    quantZone = 'moderately_oversold';
    quantZoneLabel = '充裕健康 (偏强支撑)';
    quantColor = 'text-green-light';
    quantSignal = '稳定币购买力充沛，下行回踩具备充足法币流动性缓冲与吸筹意愿。';
  } else if (z >= 2.0) {
    quantZone = 'extreme_overbought';
    quantZoneLabel = '购买力衰竭 (顶部风险)';
    quantColor = 'text-red';
    quantSignal = 'BTC 涨速脱离稳定币总量扩张斜率，稳定币买盘承接力过度透支，警惕流动性挤压或顶部回调。';
  } else if (z > 1.0) {
    quantZone = 'moderately_overbought';
    quantZoneLabel = '偏热警戒 (买力消耗)';
    quantColor = 'text-amber';
    quantSignal = 'BTC 相对稳定币市值扩张较为激进，增量流动性承接开始收紧，建议注意阶段性止盈。';
  }

  const payload = {
    code: 0,
    updatedAt: new Date().toISOString(),
    source: 'TradingView (CRYPTOCAP:STABLE.C) & DefiLlama & Binance',
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

  // Cache to disk
  try {
    const dataDir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(payload, null, 2), 'utf8');
    console.log('[SSRO] Successfully updated cache at:', CACHE_FILE);
  } catch (e) {
    console.warn('[SSRO] Failed to write disk cache:', e.message);
  }

  inMemoryCache = payload;
  lastFetchTime = Date.now();
  return payload;
}

/**
 * Get SSRO data with memory & disk caching
 */
async function getSsroData(force = false) {
  const now = Date.now();
  if (!force && inMemoryCache && (now - lastFetchTime < CACHE_TTL_MS)) {
    return inMemoryCache;
  }

  if (!force && !inMemoryCache && fs.existsSync(CACHE_FILE)) {
    try {
      const stat = fs.statSync(CACHE_FILE);
      if (now - stat.mtimeMs < CACHE_TTL_MS) {
        inMemoryCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        lastFetchTime = stat.mtimeMs;
        console.log('[SSRO] Served from warm disk cache');
        return inMemoryCache;
      }
    } catch (e) {
      console.warn('[SSRO] Error reading disk cache:', e.message);
    }
  }

  return await fetchAndBuildSsroData();
}

module.exports = {
  getSsroData,
  fetchAndBuildSsroData
};
