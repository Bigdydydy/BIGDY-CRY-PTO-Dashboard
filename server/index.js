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

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Rate limiting & Single-flight locks
const refreshRateLimitMap = new Map();
let activeRefreshPromise = null;

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

      // Always re-run analysis dynamically on current data
      const atmAnalysis = analyzeAtmIv(data.ivHistory, data.dvolStats);
      const gexAnalysis = analyzeDynamicGex(data.gex, new Date());
      const blockAnalysis = analyzeBlockTrades(activeTrades, thresholdParam, timeRangeParam);
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
      sendJsonResponse(req, res, 200, {
        code: 0,
        ...macroData
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
            getCoinbaseLiquidityData(true).catch(e => console.error('[CoinbaseFetcher] Sync refresh error:', e.message))
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

  sendJsonResponse(req, res, 404, { code: 404, error: 'Not found' });
}

/**
 * Handle static file serving
 */
function handleStaticRequest(req, res, parsedUrl) {
  let reqPath = parsedUrl.pathname;
  if (reqPath === '/' || reqPath === '') {
    reqPath = '/index.html';
  }

  const safePath = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    fs.createReadStream(filePath).pipe(res);
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

  console.log('[Server] Initializing market data cache...');
  refreshAllMarketData('BTC')
    .then(() => console.log('[Server] Initial market data cache ready.'))
    .catch(e => console.warn('[Server] Initial fetch warning:', e.message));

  fetchCdriData()
    .then(() => console.log('[Server] Initial CDRI data cache ready.'))
    .catch(e => console.warn('[Server] Initial CDRI fetch warning:', e.message));

  getCoinbaseLiquidityData()
    .then(() => console.log('[Server] Initial Coinbase liquidity cache ready.'))
    .catch(e => console.warn('[Server] Initial Coinbase fetch warning:', e.message));

  // Background auto-refresh every 30 seconds
  setInterval(async () => {
    try {
      await refreshAllMarketData('BTC');
    } catch (e) {
      console.warn('[Server] Background sync check error:', e.message);
    }
  }, 30000);
}

if (require.main === module) {
  startServer();
}

module.exports = {
  server,
  startServer,
  sendJsonResponse
};
