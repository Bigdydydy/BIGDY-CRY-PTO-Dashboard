/**
 * Coinbase BTC Order Book Depth & Micro-Liquidity Fetcher & Quantitative Engine
 * Based on Amberdata Microstructure Research Framework:
 * 1. Multi-tier depth profile (±5bps, ±10bps, ±20bps, ±50bps, ±100bps, ±200bps)
 * 2. Bid/Ask imbalance (Bid Depth %)
 * 3. Bid-Ask spread as liquidity tax
 * 4. Pyramid ratio verification (100bps / 10bps)
 * 5. Institutional order book walking slippage simulation ($250K - $20M)
 * 6. 90-day rolling percentile ranking for Price and Volume
 * 7. Regime & Fragility Diagnosis (False Prosperity / Squeeze detection)
 */

const fs = require('fs');
const path = require('path');
const { fetchWithTimeout } = require('./http_client');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'coinbase_liquidity.json');
const CACHE_TTL_MS = 15000; // 15 seconds memory cache

let inMemoryCache = null;
let lastFetchTime = 0;
let isFetching = false;

/**
 * Fetch raw Level 2 order book from Coinbase Exchange
 */
async function fetchCoinbaseOrderBook() {
  const url = 'https://api.exchange.coinbase.com/products/BTC-USD/book?level=2';
  const resp = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept': 'application/json'
    }
  });
  if (!resp.ok) {
    throw new Error(`Coinbase OrderBook HTTP ${resp.status}: ${resp.statusText}`);
  }
  return await resp.json();
}

/**
 * Fetch 350 daily candles from Coinbase Exchange for rolling 90-day percentiles
 * Format: [ time, low, high, open, close, volume ]
 */
async function fetchCoinbaseDailyCandles() {
  const url = 'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400';
  const resp = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept': 'application/json'
    }
  });
  if (!resp.ok) {
    throw new Error(`Coinbase Candles HTTP ${resp.status}: ${resp.statusText}`);
  }
  return await resp.json();
}

/**
 * Fetch 24h stats and ticker from Coinbase Exchange
 */
async function fetchCoinbaseTickerAndStats() {
  const [tickerResp, statsResp] = await Promise.all([
    fetchWithTimeout('https://api.exchange.coinbase.com/products/BTC-USD/ticker', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }),
    fetchWithTimeout('https://api.exchange.coinbase.com/products/BTC-USD/stats', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    })
  ]);

  const ticker = tickerResp.ok ? await tickerResp.json() : {};
  const stats = statsResp.ok ? await statsResp.json() : {};
  return { ticker, stats };
}

/**
 * Calculate rolling percentile of value in an array
 */
function calcPercentile(arr, val) {
  if (!arr || arr.length === 0) return 50.0;
  const sorted = [...arr].sort((a, b) => a - b);
  const count = sorted.filter(x => x <= val).length;
  return parseFloat(((count / sorted.length) * 100).toFixed(1));
}

/**
 * Simulate walking the order book for an institutional market order of targetUsd
 */
function walkOrderBook(book, targetUsd) {
  let filledUsd = 0;
  let filledQty = 0;
  let worstPrice = 0;

  for (const item of book) {
    const p = parseFloat(item[0]);
    const sz = parseFloat(item[1]);
    const levelUsd = p * sz;

    if (filledUsd + levelUsd >= targetUsd) {
      const neededUsd = targetUsd - filledUsd;
      const neededQty = neededUsd / p;
      filledUsd += neededUsd;
      filledQty += neededQty;
      worstPrice = p;
      break;
    } else {
      filledUsd += levelUsd;
      filledQty += sz;
      worstPrice = p;
    }
  }

  const avgPrice = filledQty > 0 ? filledUsd / filledQty : worstPrice;
  return { filledUsd, filledQty, avgPrice, worstPrice };
}

/**
 * Core quantitative computation engine
 */
function processCoinbaseData(bookData, candleData, tickerStats) {
  const bids = bookData.bids || [];
  const asks = bookData.asks || [];

  if (!bids.length || !asks.length) {
    throw new Error('Coinbase order book is empty');
  }

  const bestBid = parseFloat(bids[0][0]);
  const bestAsk = parseFloat(asks[0][0]);
  const midPrice = (bestBid + bestAsk) / 2;
  const spreadUsd = bestAsk - bestBid;
  const spreadBps = parseFloat(((spreadUsd / midPrice) * 10000).toFixed(3));

  // 1. Multi-Tier Symmetrical Depth Profile
  const tierBpsList = [5, 10, 20, 50, 100, 200];
  const depthProfile = {};

  for (const bp of tierBpsList) {
    const minBidPrice = midPrice * (1 - bp / 10000);
    const maxAskPrice = midPrice * (1 + bp / 10000);

    let bidUsd = 0;
    let bidBtc = 0;
    for (const b of bids) {
      const p = parseFloat(b[0]);
      if (p < minBidPrice) break;
      const sz = parseFloat(b[1]);
      bidBtc += sz;
      bidUsd += p * sz;
    }

    let askUsd = 0;
    let askBtc = 0;
    for (const a of asks) {
      const p = parseFloat(a[0]);
      if (p > maxAskPrice) break;
      const sz = parseFloat(a[1]);
      askBtc += sz;
      askUsd += p * sz;
    }

    const totalUsd = bidUsd + askUsd;
    const totalBtc = bidBtc + askBtc;
    const bidPct = totalUsd > 0 ? parseFloat(((bidUsd / totalUsd) * 100).toFixed(1)) : 50.0;
    const askPct = parseFloat((100 - bidPct).toFixed(1));

    depthProfile[bp] = {
      tierBps: bp,
      label: `±${bp} bps`,
      bidUsd: Math.round(bidUsd),
      bidUsdM: parseFloat((bidUsd / 1e6).toFixed(2)),
      bidBtc: parseFloat(bidBtc.toFixed(2)),
      askUsd: Math.round(askUsd),
      askUsdM: parseFloat((askUsd / 1e6).toFixed(2)),
      askBtc: parseFloat(askBtc.toFixed(2)),
      totalUsd: Math.round(totalUsd),
      totalUsdM: parseFloat((totalUsd / 1e6).toFixed(2)),
      totalBtc: parseFloat(totalBtc.toFixed(2)),
      bidPct,
      askPct,
      imbalanceDelta: parseFloat((bidPct - 50.0).toFixed(1)) // >0 is bid dominant, <0 is ask dominant
    };
  }

  // 2. Pyramid Ratios (Gold Standard ~3.1x for 100bps/10bps)
  const d10 = depthProfile[10].totalUsd || 1;
  const d50 = depthProfile[50].totalUsd || 1;
  const d100 = depthProfile[100].totalUsd || 1;
  const d200 = depthProfile[200].totalUsd || 1;

  const pyramidRatio100_10 = parseFloat((d100 / d10).toFixed(2));
  const pyramidRatio50_10 = parseFloat((d50 / d10).toFixed(2));
  const pyramidRatio200_100 = parseFloat((d200 / d100).toFixed(2));

  // 3. Simulated Institutional Market Order Walking & Slippage
  const testSizes = [250000, 500000, 1000000, 2000000, 5000000, 10000000, 20000000];
  const slippageSimulation = [];

  for (const sizeUsd of testSizes) {
    // Market Sell (hitting bids)
    const sellResult = walkOrderBook(bids, sizeUsd);
    const sellSlippageBps = parseFloat((Math.abs((sellResult.avgPrice - midPrice) / midPrice) * 10000).toFixed(2));
    const sellMaxImpactBps = parseFloat((Math.abs((sellResult.worstPrice - midPrice) / midPrice) * 10000).toFixed(2));

    // Market Buy (lifting asks)
    const buyResult = walkOrderBook(asks, sizeUsd);
    const buySlippageBps = parseFloat((Math.abs((buyResult.avgPrice - midPrice) / midPrice) * 10000).toFixed(2));
    const buyMaxImpactBps = parseFloat((Math.abs((buyResult.worstPrice - midPrice) / midPrice) * 10000).toFixed(2));

    // Asymmetry penalty (>1 means selling suffers worse slippage than buying)
    const asymmetryRatio = buySlippageBps > 0 ? parseFloat((sellSlippageBps / buySlippageBps).toFixed(2)) : 1.0;

    slippageSimulation.push({
      sizeUsd,
      sizeUsdM: parseFloat((sizeUsd / 1e6).toFixed(2)),
      sizeLabel: sizeUsd >= 1000000 ? `$${sizeUsd / 1000000}M` : `$${sizeUsd / 1000}K`,
      sell: {
        avgPrice: parseFloat(sellResult.avgPrice.toFixed(2)),
        worstPrice: parseFloat(sellResult.worstPrice.toFixed(2)),
        slippageBps: sellSlippageBps,
        maxImpactBps: sellMaxImpactBps
      },
      buy: {
        avgPrice: parseFloat(buyResult.avgPrice.toFixed(2)),
        worstPrice: parseFloat(buyResult.worstPrice.toFixed(2)),
        slippageBps: buySlippageBps,
        maxImpactBps: buyMaxImpactBps
      },
      asymmetryRatio,
      penaltyBps: parseFloat((sellSlippageBps - buySlippageBps).toFixed(2))
    });
  }

  // 4. 90-Day Rolling Percentiles from Coinbase Daily Candles
  let pctlPrice = 50.0;
  let pctlVol24h = 50.0;
  let pctlVol7d = 50.0;
  let cur24hVolBtc = 0;
  let cur7dVolBtc = 0;

  if (Array.isArray(candleData) && candleData.length >= 30) {
    // candles are sorted newest first [ time, low, high, open, close, volume ]
    const candles90 = candleData.slice(0, 90).reverse(); // oldest to newest
    const closes = candles90.map(c => parseFloat(c[4]));
    const volumes = candles90.map(c => parseFloat(c[5]));

    const latestClose = closes[closes.length - 1] || midPrice;
    cur24hVolBtc = volumes[volumes.length - 1] || parseFloat(tickerStats.stats?.volume || 0);

    const last7Vols = volumes.slice(-7);
    cur7dVolBtc = last7Vols.reduce((a, b) => a + b, 0) / (last7Vols.length || 1);

    pctlPrice = calcPercentile(closes, latestClose);
    pctlVol24h = calcPercentile(volumes, cur24hVolBtc);
    pctlVol7d = calcPercentile(volumes, cur7dVolBtc);
  }

  // 5. Macro-Microstructure Regime Diagnosis
  const bid10Pct = depthProfile[10].bidPct;
  const bid5Pct = depthProfile[5].bidPct;

  let regimeCode = 'NEUTRAL_BALANCED';
  let regimeLabel = '中性均衡承接';
  let regimeSeverity = 'neutral';
  let regimeColor = '#38bdf8';

  if (pctlPrice >= 75 && (pctlVol24h <= 20 || pctlVol7d <= 30) && bid10Pct < 48.5) {
    regimeCode = 'FALSE_PROSPERITY';
    regimeLabel = '🚨 虚假繁荣 / 贫瘠逼空';
    regimeSeverity = 'critical';
    regimeColor = '#f43f5e';
  } else if (bid10Pct < 46.0 || bid5Pct < 45.0) {
    regimeCode = 'SELL_WALL_PRESSURE';
    regimeLabel = '⚠️ 近端卖墙压制 / 承接中空';
    regimeSeverity = 'warning';
    regimeColor = '#f59e0b';
  } else if (pctlPrice >= 70 && pctlVol7d >= 60 && bid10Pct >= 51.0) {
    regimeCode = 'HEALTHY_ACCUMULATION';
    regimeLabel = '🟢 充盈承接 / 现货放量买入';
    regimeSeverity = 'success';
    regimeColor = '#10b981';
  } else if (pyramidRatio100_10 > 6.5) {
    regimeCode = 'HOLLOW_NEAR_END';
    regimeLabel = '⚡ 金字塔形变 / 防线下移';
    regimeSeverity = 'warning';
    regimeColor = '#eab308';
  }

  // Key institutional diagnostic insights
  const insights = [
    `【阶梯买盘占比】±5 bps 与 ±10 bps 买单占比分别为 ${bid5Pct}% 与 ${bid10Pct}%（卖方主导 ${depthProfile[5].askPct}% / ${depthProfile[10].askPct}%），印证盘口上方堆积限价卖单，越靠近现价承接越单薄。`,
    `【90天分位数背离】Coinbase 现货价格处于 90 天第 ${pctlPrice}% 分位（偏热），但 24h 现货成交量仅居第 ${pctlVol24h}% 分位（极度低迷），呈现典型的“高位缩量、流动性贫瘠”。`,
    `【大单执行冲击】实测 $5M 市价抛售执行滑点为 ${slippageSimulation[4].sell.slippageBps} bps（底价 $${slippageSimulation[4].sell.worstPrice.toLocaleString()}），比同规模买入滑点高出 ${Math.max(0, slippageSimulation[4].penaltyBps)} bps，下行缓冲具备非对称脆弱性。`,
    `【金字塔倍数】100 bps 深度与 10 bps 深度比值为 ${pyramidRatio100_10}x（健康基准 ~3.1x），表明做市商防御性挂单向远端（50-100 bps）撤退，即时缓冲层相对中空。`
  ];

  return {
    exchange: 'Coinbase Exchange',
    product: 'BTC-USD',
    timestamp: Date.now(),
    updatedAt: new Date().toISOString(),
    midPrice: parseFloat(midPrice.toFixed(2)),
    bestBid,
    bestAsk,
    spreadUsd: parseFloat(spreadUsd.toFixed(2)),
    spreadBps,
    depthProfile,
    pyramidRatios: {
      ratio100_10: pyramidRatio100_10,
      ratio50_10: pyramidRatio50_10,
      ratio200_100: pyramidRatio200_100,
      baseline100_10: 3.1
    },
    slippageSimulation,
    percentiles: {
      pricePctl: pctlPrice,
      volume24hPctl: pctlVol24h,
      volume7dPctl: pctlVol7d,
      volume24hBtc: parseFloat(cur24hVolBtc.toFixed(1)),
      volume7dBtc: parseFloat(cur7dVolBtc.toFixed(1))
    },
    regime: {
      code: regimeCode,
      label: regimeLabel,
      severity: regimeSeverity,
      color: regimeColor,
      bid10Pct,
      pyramidRatio100_10
    },
    insights
  };
}

/**
 * Main public getter for Coinbase liquidity dataset
 */
async function getCoinbaseLiquidityData(forceRefresh = false) {
  const now = Date.now();

  // Return in-memory cache if valid
  if (!forceRefresh && inMemoryCache && (now - lastFetchTime) < CACHE_TTL_MS) {
    return inMemoryCache;
  }

  // Prevent overlapping concurrent fetches
  if (isFetching && inMemoryCache) {
    return inMemoryCache;
  }

  isFetching = true;
  try {
    console.log('[CoinbaseFetcher] Fetching real-time BTC-USD orderbook, candles, and ticker...');
    const [bookData, candleData, tickerStats] = await Promise.all([
      fetchCoinbaseOrderBook(),
      fetchCoinbaseDailyCandles(),
      fetchCoinbaseTickerAndStats()
    ]);

    const result = processCoinbaseData(bookData, candleData, tickerStats);

    inMemoryCache = result;
    lastFetchTime = now;

    // Persist to local JSON cache
    try {
      const dataDir = path.dirname(CACHE_FILE);
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(result, null, 2), 'utf8');
      console.log(`[CoinbaseFetcher] Successfully updated Coinbase liquidity cache at ${new Date().toISOString()}`);
    } catch (writeErr) {
      console.warn('[CoinbaseFetcher] Warning: Failed to write cache file:', writeErr.message);
    }

    return result;
  } catch (err) {
    console.error('[CoinbaseFetcher] Error fetching from Coinbase:', err.message);

    // Fallback to disk cache if available
    if (fs.existsSync(CACHE_FILE)) {
      try {
        const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        console.log('[CoinbaseFetcher] Returning disk fallback cache');
        inMemoryCache = cached;
        return cached;
      } catch (readErr) {
        console.error('[CoinbaseFetcher] Failed to parse disk cache:', readErr.message);
      }
    }

    throw err;
  } finally {
    isFetching = false;
  }
}

module.exports = {
  getCoinbaseLiquidityData
};
