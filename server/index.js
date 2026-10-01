const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const zlib = require('zlib');
const crypto = require('crypto');
const { refreshAllMarketData, getCachedData } = require('./data_fetcher');
const { filterTradesByWindow } = require('./trade_store');
const {
  analyzeAtmIv,
  analyzeDynamicGex,
  analyzeBlockTrades,
  analyzeIvSmile,
  analyze25DeltaSkew
} = require('./analytics_engine');
const { getMacroChartData } = require('./macro_fetcher');
const { fetchCdriData } = require('./cdri_fetcher');
const { getSsroData } = require('./ssro_fetcher');
const { getCoinbaseLiquidityData } = require('./coinbase_fetcher');
const { getGoldCorrelationData } = require('./gold_fetcher');
const { getMcClellanData } = require('./crypto_mcclellan_fetcher');
const { getSystemAuditData } = require('./audit_engine');
const { analyzeWaves } = require('./wave_engine');

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
const WAVE_SUB_INTERVALS = {
  '15m': [],
  '1h': ['15m'],
  '4h': ['1h', '15m']
};
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

const KLINE_SOURCES = [
  { base: 'https://fapi.binance.com/fapi/v1/klines', pageMax: 1500 },
  { base: 'https://data-api.binance.vision/api/v3/klines', pageMax: 1000 },
  { base: 'https://api.binance.com/api/v3/klines', pageMax: 1000 }
];

async function fetchKlinePages(source, symbol, interval, limit) {
  const rows = [];
  let endTime = null;
  while (rows.length < limit) {
    const pageLimit = Math.min(source.pageMax, limit - rows.length);
    const url = `${source.base}?symbol=${symbol}&interval=${interval}&limit=${pageLimit}${endTime ? `&endTime=${endTime}` : ''}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) {
      if (!rows.length) throw new Error(`HTTP ${response.status}`);
      break; // 已拿到的较新数据仍可用
    }
    const page = await response.json();
    if (!Array.isArray(page) || !page.length) break;
    rows.unshift(...page);
    if (page.length < pageLimit) break; // 已到上市首日
    endTime = page[0][0] - 1;
  }
  return rows;
}

// 缓存只按固定档位存放，避免 ?limit= 任意取值造成缓存键无限增长
const KLINE_TIERS = [200, 1000, WAVE_MAX_BARS];

async function fetchBinanceKlines(symbol, interval = '4h', limit = 1000) {
  limit = Math.max(1, Math.min(WAVE_MAX_BARS, parseInt(limit, 10) || 1000));
  const tier = KLINE_TIERS.find(t => t >= limit) || WAVE_MAX_BARS;
  const bars = await fetchKlineTier(symbol, interval, tier);
  return bars.length > limit ? bars.slice(bars.length - limit) : bars;
}

async function fetchKlineTier(symbol, interval, limit) {
  const cacheKey = `${symbol}_${interval}_${limit}`;
  const cached = waveKlineCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.timestamp < 120000) {
    return cached.data;
  }
  // 同一标的/周期/根数的并发请求合并为一次 (图表与研判接口常同时触发)
  if (waveKlineInflight.has(cacheKey)) return waveKlineInflight.get(cacheKey);

  const task = (async () => {
    // 优先采用币安 Futures 合约行情通道 (fapi.binance.com)，降级回退至公共现货源
    let rawData = null;
    for (const source of KLINE_SOURCES) {
      try {
        const rows = await fetchKlinePages(source, symbol, interval, limit);
        if (rows.length) { rawData = rows; break; }
      } catch (e) {
        // try next
      }
    }

    if (!rawData || !Array.isArray(rawData)) {
      throw new Error(`未能从币安行情源拉取到 ${interval} K 线数据，请稍后重试`);
    }

    const bars = rawData.map(b => ({
      time: Math.floor(b[0] / 1000),
      open: parseFloat(b[1]),
      high: parseFloat(b[2]),
      low: parseFloat(b[3]),
      close: parseFloat(b[4]),
      volume: parseFloat(b[5])
    }));

    waveKlineCache.set(cacheKey, { timestamp: Date.now(), data: bars });
    return bars;
  })();
  waveKlineInflight.set(cacheKey, task);
  try {
    return await task;
  } finally {
    waveKlineInflight.delete(cacheKey);
  }
}

// MIME types for static serving
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

/**
 * Send JSON response with ETag negotiation (304), Gzip/Deflate compression, and CORS headers
 */
function sendJsonResponse(req, res, statusCode, payload, extraHeaders = {}) {
  const jsonStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
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
  noteApiActivity();

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
      const spotPrice = data.gex?.index_price || 77250;

      // Filter trades from persistent 30-day store based on user-selected window
      const activeTrades = filterTradesByWindow(data.blockTrades, timeRangeParam);

      // Always re-run analysis dynamically on current data (enhanced with real-time atmData)
      const atmAnalysis = analyzeAtmIv(data.ivHistory, data.dvolStats, data.atmData);
      const gexAnalysis = analyzeDynamicGex(data.gex, new Date());
      const blockAnalysis = analyzeBlockTrades(activeTrades, thresholdParam, timeRangeParam, spotPrice);
      blockAnalysis.timeRange = timeRangeParam;
      blockAnalysis.activeTradesCount = activeTrades.length;
      blockAnalysis.tradeStoreStats = data.tradeStoreStats || null;
      const smileAnalysis = analyzeIvSmile(data.ivSkewMonth, spotPrice);
      const skewAnalysis = analyze25DeltaSkew(data.skewChart);

      const payload = {
        code: 0,
        currency: data.currency,
        syncStatus: {
          hasAnyUpdate: data.lastChanges?.hasAnyUpdate || false,
          dataVersion: data.dataVersion,
          summary: data.lastChanges?.summary || '数据已校验',
          changes: data.lastChanges || {},
          lastSyncCheckTime: data.lastSyncCheckTime,
          lastDataChangeTime: data.lastDataChangeTime
        },
        lastUpdated: data.lastDataChangeTime || data.lastSyncCheckTime,
        indexPrice: spotPrice,
        atmIv: atmAnalysis,
        gex: gexAnalysis,
        blockTrades: blockAnalysis,
        ivSmile: smileAnalysis,
        delta25Skew: skewAnalysis,
        termPremium: data.termPremium || null
      };

      sendJsonResponse(req, res, 200, payload);
    } catch (err) {
      console.error('[API Error] market-data:', err);
      sendJsonResponse(req, res, 500, { code: -1, error: err.message });
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
      sendJsonResponse(req, res, 200, {
        code: 0,
        ...data.termPremium
      });
    } catch (err) {
      console.error('[API Error] term-premium:', err);
      sendJsonResponse(req, res, 500, { code: -1, error: err.message });
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
        ...finalMacroData
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
        ...cdriData
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
      sendJsonResponse(req, res, 200, ssroData);
    } catch (err) {
      console.error('[API Error] ssro:', err);
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
        ...cbData
      });
    } catch (err) {
      console.error('[API Error] coinbase-liquidity:', err);
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
        ...goldData
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
      sendJsonResponse(req, res, 200, {
        code: 0,
        refreshStatus: data.refresh_status,
        data,
        ...data
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

      // Single-flight lock: deduplicate concurrent background refresh calls
      if (!activeRefreshPromise) {
        activeRefreshPromise = (async () => {
          const [syncResult] = await Promise.all([
            refreshAllMarketData('BTC'),
            getMacroChartData(true).catch(e => console.error('[MacroFetcher] Sync refresh error:', e.message)),
            fetchCdriData(true).catch(e => console.error('[CdriFetcher] Sync refresh error:', e.message)),
            getSsroData(true).catch(e => console.error('[SsroFetcher] Sync refresh error:', e.message)),
            getCoinbaseLiquidityData(true).catch(e => console.error('[CoinbaseFetcher] Sync refresh error:', e.message)),
            getGoldCorrelationData(true).catch(e => console.error('[GoldFetcher] Sync refresh error:', e.message)),
            getMcClellanData(true).catch(e => console.error('[McClellanFetcher] Sync refresh error:', e.message))
          ]);
          return syncResult;
        })().finally(() => {
          activeRefreshPromise = null;
        });
      }

      const syncResult = await activeRefreshPromise;
      sendJsonResponse(req, res, 200, {
        code: 0,
        msg: syncResult?.summary || '数据已刷新',
        hasAnyUpdate: syncResult?.hasAnyUpdate || false,
        dataVersion: syncResult?.dataVersion || null,
        changes: syncResult?.changes || {},
        lastSyncCheckTime: syncResult?.lastSyncCheckTime || new Date().toISOString(),
        lastDataChangeTime: syncResult?.lastDataChangeTime || null
      });
    } catch (err) {
      console.error('[API Error] refresh:', err);
      sendJsonResponse(req, res, 500, { code: -1, error: err.message });
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
    if (!WAVE_INTERVALS.includes(interval) && !isAux) {
      sendJsonResponse(req, res, 400, { code: 400, error: `波浪理论研判限定 ${WAVE_INTERVALS.join('/')} 时间框架` });
      return;
    }

    const maxBars = isAux ? WAVE_AUX_MAX_BARS : WAVE_MAX_BARS;
    const limit = Math.min(parseInt(parsedUrl.query?.limit, 10) || maxBars, maxBars);

    try {
      const bars = await fetchBinanceKlines(rawSymbol, interval, limit);
      sendJsonResponse(req, res, 200, {
        code: 0,
        symbol: rawSymbol === 'BTCUSDT' ? 'BTC/USDT' : 'ETH/USDT',
        interval,
        count: bars.length,
        bars
      });
    } catch (err) {
      console.error('[API Error] wave-klines:', err);
      sendJsonResponse(req, res, 502, { code: 502, error: err.message });
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

      // 并发并行抓取主周期 + 子周期 + 宏观高周期 K 线，防止串行请求导致延迟累加
      const [mainBars, subResults, htfResults] = await Promise.all([
        fetchBinanceKlines(rawSymbol, interval, WAVE_MAX_BARS),
        Promise.all(subTfs.map(tf => fetchBinanceKlines(rawSymbol, tf, 1000).catch(() => null))),
        Promise.all(htfTfs.map(tf => fetchBinanceKlines(rawSymbol, tf, 200).catch(() => null)))
      ]);

      const subBars = {};
      subTfs.forEach((tf, i) => { if (subResults[i]) subBars[tf] = subResults[i]; });
      const htfBars = {};
      htfTfs.forEach((tf, i) => { if (htfResults[i]) htfBars[tf] = htfResults[i]; });

      const analysis = analyzeWaves(mainBars, displaySymbol, {
        startTime,
        endTime,
        timeframe: interval,
        subBars,
        htfBars
      });

      sendJsonResponse(req, res, 200, {
        code: 0,
        ...analysis
      });
    } catch (err) {
      console.error('[API Error] wave-analysis:', err);
      sendJsonResponse(req, res, 502, { code: 502, error: err.message });
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

  // 宏观数据每 5 分钟刷新 (同样仅在有人访问时)
  setInterval(async () => {
    if (isServerIdle()) return;
    try {
      await getMacroChartData(true);
    } catch (e) {
      console.warn('[Server] Background macro sync error:', e.message);
    }
  }, 300000);
}

if (require.main === module) {
  startServer();
}

module.exports = {
  server,
  startServer,
  sendJsonResponse,
  _internal: { fetchBinanceKlines, waveKlineCache, KLINE_TIERS, noteApiActivity, isServerIdle }
};
