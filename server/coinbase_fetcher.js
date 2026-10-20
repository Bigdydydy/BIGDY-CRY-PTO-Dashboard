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
const liquidityHistory = require('./liquidity_history');
const { recordAttempt, recordSuccess, recordFailure } = require('./data_health');
const { withDataHealth, seedCachedHealth, atomicWriteJson } = require('./data_health_cache');
const { fetchUpstreamJson } = require('./upstream_mirror');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'coinbase_liquidity.json');
const CACHE_TTL_MS = 15000; // 15 seconds memory cache
const REQUIRED_IDS = ['coinbase', 'coinbase_candles'];
const MAX_FUTURE_MS = 5 * 60 * 1000;

let inMemoryCache = null;
let lastFetchTime = 0;
let inflight = null;
let diskSeeded = false;

const isFiniteNum = v =>
  v !== null && v !== undefined && typeof v !== 'boolean' &&
  !(typeof v === 'string' && v.trim() === '') && Number.isFinite(Number(v));
const isPosNum = v => isFiniteNum(v) && Number(v) > 0;

/** L2 book: nonempty bids/asks, valid levels, sorted, no crossed book. */
function validateOrderBook(book) {
  if (!book || typeof book !== 'object') return 'order book 非对象';
  const { bids, asks } = book;
  if (!Array.isArray(bids) || !bids.length || !Array.isArray(asks) || !asks.length) return 'bids/asks 为空';
  const sideOk = (side, desc) => {
    let prev = desc ? Infinity : -Infinity;
    for (const lv of side) {
      if (!Array.isArray(lv) || !isPosNum(lv[0]) || !isFiniteNum(lv[1]) || Number(lv[1]) < 0) return false;
      const p = Number(lv[0]);
      if (desc ? p > prev : p < prev) return false;
      prev = p;
    }
    return true;
  };
  if (!sideOk(bids, true)) return 'bids 非降序或字段非法';
  if (!sideOk(asks, false)) return 'asks 非升序或字段非法';
  if (!(Number(bids[0][0]) < Number(asks[0][0]))) return 'bestBid >= bestAsk';
  return null;
}

/** Daily candles [time(sec), low, high, open, close, volume]: valid OHLC,
 * volume >= 0. Raw fields are checked — Number(null)===0 must never pass. */
function validateDailyCandles(rows) {
  if (!Array.isArray(rows) || !rows.length) return 'candles 为空或非数组';
  const nowMs = Date.now();
  for (const c of rows) {
    if (!Array.isArray(c) || c.length < 6) return 'candle 行字段不足';
    if (!isPosNum(c[0])) return 'candle 时间非法';
    if (Number(c[0]) * 1000 > nowMs + MAX_FUTURE_MS) return 'candle 时间在未来';
    if (![c[1], c[2], c[3], c[4]].every(isPosNum)) return 'OHLC 非正数';
    const [t, l, h, o, cl] = c.map(Number);
    if (h < Math.max(o, cl, l) || l > Math.min(o, cl, h)) return 'OHLC 不自洽';
    if (!isFiniteNum(c[5]) || Number(c[5]) < 0) return 'volume 非法';
  }
  return null;
}

/** Ticker/stats are required fields, never coerced to {}. */
function validateTickerStats(ticker, stats) {
  if (!ticker || !isPosNum(ticker.price)) return 'ticker.price 非正数';
  if (ticker.time !== undefined && ticker.time !== null) {
    const ms = Date.parse(ticker.time);
    if (!Number.isFinite(ms) || ms > Date.now() + MAX_FUTURE_MS) return 'ticker.time 非法/未来';
  }
  if (!stats || !isPosNum(stats.last)) return 'stats.last 非正数';
  if (!isFiniteNum(stats.volume) || Number(stats.volume) < 0) return 'stats.volume 非法';
  return null;
}

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
  const book = await resp.json();
  const bad = validateOrderBook(book);
  if (bad) throw new Error(`Coinbase order book 校验失败: ${bad}`);
  return book;
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
  const rows = await resp.json();
  const bad = validateDailyCandles(rows);
  if (bad) throw new Error(`Coinbase candles 校验失败: ${bad}`);
  return rows;
}

/**
 * Fetch 24h stats and ticker from Coinbase Exchange. Any non-OK response or
 * missing price/volume/last is a source failure, never coerced to {}.
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

  if (!tickerResp.ok) throw new Error(`Coinbase Ticker HTTP ${tickerResp.status}`);
  if (!statsResp.ok) throw new Error(`Coinbase Stats HTTP ${statsResp.status}`);
  const ticker = await tickerResp.json();
  const stats = await statsResp.json();
  const bad = validateTickerStats(ticker, stats);
  if (bad) throw new Error(`Coinbase ticker/stats 校验失败: ${bad}`);
  return { ticker, stats };
}

/**
 * Calculate rolling empirical cumulative distribution function (ECDF) percentile of value in an array
 * Uses mid-rank weighting: (below + 0.5 * equal) / N * 100
 * Eliminates boundary step bias and guarantees unbiased rank representation
 */
function calcPercentile(arr, val) {
  if (!arr || arr.length === 0) return 50.0;
  let below = 0;
  let equal = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v < val) {
      below++;
    } else if (v === val) {
      equal++;
    }
  }
  const ecdf = ((below + 0.5 * equal) / arr.length) * 100;
  return parseFloat(Math.min(100.0, Math.max(0.0, ecdf)).toFixed(1));
}


/**
 * Simulate walking the order book for an institutional market order of targetUsd.
 * If the visible levels run out before targetUsd is reached the result is flagged
 * `complete: false` (fillRatio < 1): avgPrice / worstPrice then only describe the filled part
 * and must not be read as the execution price of the full order.
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
  const complete = filledUsd >= targetUsd * 0.999;
  const fillRatio = targetUsd > 0 ? Math.min(1, filledUsd / targetUsd) : 1;
  return { filledUsd, filledQty, avgPrice, worstPrice, complete, fillRatio };
}

// Coinbase L2 snapshots have historically been capped at the top 50 aggregated levels per side.
// A side returning >= this many levels may be truncated, so depth beyond its last level is unknown.
const L2_TRUNCATION_LEVELS = 50;

/** Distance (bps from mid) the visible levels of one side reach; Infinity if the side is not truncated. */
function sideCoverageBps(levels, midPrice) {
  if (!Array.isArray(levels) || levels.length < L2_TRUNCATION_LEVELS) return Infinity;
  const last = parseFloat(levels[levels.length - 1][0]);
  return Math.abs(last - midPrice) / midPrice * 10000;
}

/**
 * Average-price slippage of an order the book could not fill, extrapolated from the filled part
 * with the square-root impact law (impact ∝ √size). Returns observed bps when complete.
 */
function extrapolateSlippageBps(observedBps, result, targetUsd) {
  if (result.complete || !(result.filledUsd > 0)) return observedBps;
  return observedBps * Math.sqrt(targetUsd / result.filledUsd);
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

  // 0. Book coverage: a truncated L2 snapshot only describes depth out to its last visible level,
  // so tiers / order sizes beyond that reach cannot be measured from this snapshot.
  const bidReachBps = sideCoverageBps(bids, midPrice);
  const askReachBps = sideCoverageBps(asks, midPrice);
  const bookTruncated = Number.isFinite(bidReachBps) || Number.isFinite(askReachBps);

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
      imbalanceDelta: parseFloat((bidPct - 50.0).toFixed(1)), // >0 is bid dominant, <0 is ask dominant
      // false: the tier extends past the last visible level, so its depth is a lower bound
      covered: bp <= bidReachBps && bp <= askReachBps
    };
  }

  // 2. Pyramid Ratios (Gold Standard ~3.1x for 100bps/10bps); null when either tier is not covered,
  // since a truncated far tier would collapse the ratio towards 1.0x.
  const pyramidRatio = (far, near) => (depthProfile[far].covered && depthProfile[near].covered
    ? parseFloat(((depthProfile[far].totalUsd || 1) / (depthProfile[near].totalUsd || 1)).toFixed(2))
    : null);

  const pyramidRatio100_10 = pyramidRatio(100, 10);
  const pyramidRatio50_10 = pyramidRatio(50, 10);
  const pyramidRatio200_100 = pyramidRatio(200, 100);
  const hasPyr = pyramidRatio100_10 !== null;

  // 3. Simulated Institutional Market Order Walking & Slippage
  const testSizes = [250000, 500000, 1000000, 2000000, 5000000, 10000000, 20000000];
  const slippageSimulation = [];

  const sideImpact = (result, sizeUsd) => {
    const observedBps = Math.abs((result.avgPrice - midPrice) / midPrice) * 10000;
    return {
      avgPrice: parseFloat(result.avgPrice.toFixed(2)),
      worstPrice: parseFloat(result.worstPrice.toFixed(2)),
      // Unfilled orders: √-law extrapolation from the filled part (flagged), not the partial average
      slippageBps: parseFloat(extrapolateSlippageBps(observedBps, result, sizeUsd).toFixed(2)),
      // Unfilled orders: the last visible level is only a lower bound for the true worst price
      maxImpactBps: parseFloat((Math.abs((result.worstPrice - midPrice) / midPrice) * 10000).toFixed(2)),
      complete: result.complete,
      fillRatio: parseFloat(result.fillRatio.toFixed(4)),
      extrapolated: !result.complete
    };
  };

  for (const sizeUsd of testSizes) {
    // Market Sell (hitting bids) / Market Buy (lifting asks)
    const sell = sideImpact(walkOrderBook(bids, sizeUsd), sizeUsd);
    const buy = sideImpact(walkOrderBook(asks, sizeUsd), sizeUsd);

    // Asymmetry penalty (>1 means selling suffers worse slippage than buying)
    const asymmetryRatio = buy.slippageBps > 0 ? parseFloat((sell.slippageBps / buy.slippageBps).toFixed(2)) : 1.0;

    slippageSimulation.push({
      sizeUsd,
      sizeUsdM: parseFloat((sizeUsd / 1e6).toFixed(2)),
      sizeLabel: sizeUsd >= 1000000 ? `$${sizeUsd / 1000000}M` : `$${sizeUsd / 1000}K`,
      sell,
      buy,
      asymmetryRatio,
      penaltyBps: parseFloat((sell.slippageBps - buy.slippageBps).toFixed(2))
    });
  }

  // 4. 90-Day Rolling Percentiles from Coinbase Daily Candles & Rolling 24h Stats
  let pctlPrice = 50.0;
  let pctlVol24h = 50.0;
  let pctlVol7d = 50.0;
  let cur24hVolBtc = 0;
  let cur7dVolBtc = 0;

  if (Array.isArray(candleData) && candleData.length >= 30) {
    // candleData is sorted newest first: [ [time, low, high, open, close, volume], ... ]
    // candleData[0] is the INCOMPLETE current UTC day's candle.
    // Completed past daily candles start at index 1:
    const completedCandles = candleData.slice(1, 91); // 90 completed full days
    const completedVolumes = completedCandles.map(c => parseFloat(c[5])).filter(v => Number.isFinite(v) && v > 0);
    const historicalCloses = candleData.slice(0, 90).map(c => parseFloat(c[4])).filter(v => Number.isFinite(v) && v > 0);

    const latestClose = midPrice || (candleData[0] ? parseFloat(candleData[0][4]) : 0);

    // True rolling 24h volume from Coinbase official /stats endpoint:
    const rollingStatsVol = parseFloat(tickerStats.stats?.volume || tickerStats.ticker?.volume || 0);
    if (rollingStatsVol > 0) {
      cur24hVolBtc = rollingStatsVol;
    } else if (completedVolumes.length > 0) {
      // Fallback: if stats endpoint volume is unavailable, use yesterday's completed full 24h volume
      cur24hVolBtc = completedVolumes[0];
    } else if (candleData[0]) {
      cur24hVolBtc = parseFloat(candleData[0][5]);
    }

    // 7-day average volume: average of past 7 completed 24h days
    const last7CompletedVols = completedVolumes.slice(0, 7);
    cur7dVolBtc = last7CompletedVols.length > 0
      ? last7CompletedVols.reduce((a, b) => a + b, 0) / last7CompletedVols.length
      : cur24hVolBtc;

    pctlPrice = calcPercentile(historicalCloses, latestClose);
    pctlVol24h = calcPercentile(completedVolumes, cur24hVolBtc);
    pctlVol7d = calcPercentile(completedVolumes, cur7dVolBtc);
  }

  // 5. Macro-Microstructure Regime Diagnosis (Amberdata Framework)
  const bid10Pct = depthProfile[10].bidPct;
  const bid5Pct = depthProfile[5].bidPct;

  let regimeCode = 'NEUTRAL_BALANCED';
  let regimeLabel = '⚪ 中性均衡 / 震荡整理';
  let regimeSeverity = 'neutral';
  let regimeColor = '#a1a1aa';

  if (pctlPrice >= 75 && (pctlVol24h <= 25 || pctlVol7d <= 30) && bid10Pct < 48.5 && hasPyr && pyramidRatio100_10 > 5.0) {
    regimeCode = 'FALSE_PROSPERITY';
    regimeLabel = '🚨 虚假繁荣 / 贫瘠逼空';
    regimeSeverity = 'critical';
    regimeColor = '#f43f5e';
  } else if (pctlPrice >= 70 && (pctlVol24h >= 55 || pctlVol7d >= 60) && bid10Pct >= 51.0 && hasPyr && pyramidRatio100_10 <= 5.5) {
    regimeCode = 'HEALTHY_EXPANSION';
    regimeLabel = '🟢 充盈共振 / 稳健主升';
    regimeSeverity = 'success';
    regimeColor = '#10b981';
  } else if (pctlPrice >= 55 && pctlVol24h >= 45 && (bid10Pct < 46.0 || bid5Pct < 45.0)) {
    regimeCode = 'SELL_WALL_PRESSURE';
    regimeLabel = '⚠️ 顶部分发 / 卖墙重压';
    regimeSeverity = 'warning';
    regimeColor = '#f59e0b';
  } else if (pctlPrice <= 30 && pctlVol24h <= 35 && bid10Pct >= 51.5 && hasPyr && pyramidRatio100_10 <= 4.5) {
    regimeCode = 'ACCUMULATION_BOTTOM';
    regimeLabel = '💎 机构吸筹 / 缩量筑底';
    regimeSeverity = 'success';
    regimeColor = '#38bdf8';
  } else if (pctlPrice <= 30 && pctlVol24h >= 75 && bid10Pct < 45.0) {
    regimeCode = 'PANIC_CAPITULATION';
    regimeLabel = '🔴 恐慌踩踏 / 流动性击穿';
    regimeSeverity = 'critical';
    regimeColor = '#ef4444';
  } else if (hasPyr && pyramidRatio100_10 > 6.0) {
    regimeCode = 'HOLLOW_NEAR_END';
    regimeLabel = '⚡ 金字塔形变 / 防线下移';
    regimeSeverity = 'warning';
    regimeColor = '#eab308';
  }

  // Key institutional diagnostic insights
  const sim5m = slippageSimulation[4];
  const fmtReach = v => (Number.isFinite(v) ? `约 ${v.toFixed(0)} bps` : '完整');
  const coverageNote = bookTruncated
    ? `（L2 快照可能仅含前 ${L2_TRUNCATION_LEVELS} 档，可见深度买盘${fmtReach(bidReachBps)} / 卖盘${fmtReach(askReachBps)}）`
    : '';
  const insights = [
    `【阶梯买盘占比】±5 bps 与 ±10 bps 买单占比分别为 ${bid5Pct}% 与 ${bid10Pct}%（卖方主导 ${depthProfile[5].askPct}% / ${depthProfile[10].askPct}%），${bid10Pct < 48 ? '盘口上方堆积限价卖单，越靠近现价承接越单薄。' : '买卖双向挂单相对均衡。'}`,
    `【90天滚动量价分位】Coinbase 现货价格处于 90 天第 ${pctlPrice}% 分位（${pctlPrice >= 75 ? '高位偏热' : (pctlPrice <= 25 ? '低位低估' : '常态中枢')}），真·24h 滚动成交量居第 ${pctlVol24h}% 分位（${pctlVol24h <= 25 ? '极度低迷' : (pctlVol24h >= 70 ? '放量活跃' : '中性温和')}，约 ${cur24hVolBtc.toFixed(0)} ₿），7D 均量居第 ${pctlVol7d}% 分位。`,
    `【大单执行冲击】${sim5m.sell.complete ? '实测' : `可见盘口仅能成交 ${(sim5m.sell.fillRatio * 100).toFixed(0)}%，按平方根冲击模型外推的`} $5M 市价抛售执行滑点为 ${sim5m.sell.slippageBps} bps（${sim5m.sell.complete ? '底价' : '可见最低档'} $${sim5m.sell.worstPrice.toLocaleString()}），比同规模买入滑点${sim5m.penaltyBps >= 0 ? `高出 ${sim5m.penaltyBps} bps` : `低 ${Math.abs(sim5m.penaltyBps)} bps`}，${sim5m.penaltyBps > 0 ? '下行缓冲具备非对称脆弱性。' : '买卖盘滑点结构对称。'}${coverageNote}`,
    hasPyr
      ? `【金字塔倍数】100 bps 深度与 10 bps 深度比值为 ${pyramidRatio100_10}x（健康基准 ~3.1x），${pyramidRatio100_10 > 5.5 ? '表明做市商防御性挂单向远端撤退，即时缓冲层相对中空。' : '做市商阶梯深度逐级递增，具备良好吸震能力。'}`
      : `【金字塔倍数】L2 快照可见深度未覆盖 ±100 bps${coverageNote}，100/10 bps 深度比无法可靠计算，暂不参与体制判定。`
  ];

  // Rolling 24h volume straight from /stats, independent of the candle history,
  // so the depth-history recorder gets a denominator even without candles.
  const statsVolBtc = parseFloat(tickerStats?.stats?.volume || tickerStats?.ticker?.volume || 0) || cur24hVolBtc;

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
    bookCoverage: {
      bidLevels: bids.length,
      askLevels: asks.length,
      truncated: bookTruncated,
      bidReachBps: Number.isFinite(bidReachBps) ? parseFloat(bidReachBps.toFixed(1)) : null,
      askReachBps: Number.isFinite(askReachBps) ? parseFloat(askReachBps.toFixed(1)) : null
    },
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
    volume24h: {
      btc: parseFloat(statsVolBtc.toFixed(1)),
      usd: Math.round(statsVolBtc * midPrice)
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

function readValidatedDisk() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    // Same schema the live path produces: a book-derived result must carry
    // the depth profile and a sane mid price.
    if (!cached || typeof cached !== 'object' || !isPosNum(cached.midPrice) || !cached.depthProfile) return null;
    return cached;
  } catch (e) {
    return null;
  }
}

/** Seed honest disk clocks once, before the first attempt is recorded. */
function seedDiskOnce() {
  if (diskSeeded) return;
  diskSeeded = true;
  const disk = readValidatedDisk();
  if (disk) {
    const asOf = disk.updatedAt || (Number.isFinite(disk.timestamp) ? new Date(disk.timestamp).toISOString() : null);
    seedCachedHealth(disk, 'coinbase', { dataAsOf: asOf, lastSuccessAt: asOf, asOfKind: 'received' });
    // Legacy files carry no real candle data date — updatedAt must not pose
    // as the candles' dataAsOf. Persisted health wins; otherwise UNKNOWN.
    seedCachedHealth(disk, 'coinbase_candles', {});
  }
}

/**
 * 线上兜底: 取线上 /api/coinbase-liquidity 的结果。去掉线上的 code / dataHealth，
 * 按线上原始时间在本地重新登记来源 (source = upstream-mirror)，不冒充本地直连、也不刷新"新鲜度"。
 * 结构不合格 (与磁盘缓存同一标准) 或未配置线上网址时返回 null。
 * 不写入本地深度历史，也不覆盖磁盘缓存——它们只记录本机直连采到的数据。
 */
async function fetchMirroredLiquidity() {
  let data;
  try {
    data = await fetchUpstreamJson('/api/coinbase-liquidity');
  } catch (e) {
    return null;
  }
  const { code, dataHealth, ...payload } = data;
  if (!isPosNum(payload.midPrice) || !payload.depthProfile) return null;
  const sources = (dataHealth && dataHealth.sources) || {};
  const asOf = (sources.coinbase && sources.coinbase.dataAsOf) || payload.updatedAt || null;
  recordSuccess('coinbase', { dataAsOf: asOf, asOfKind: 'received', source: 'upstream-mirror' });
  const candleAsOf = sources.coinbase_candles && sources.coinbase_candles.dataAsOf;
  if (candleAsOf) recordSuccess('coinbase_candles', { dataAsOf: candleAsOf, asOfKind: 'source', source: 'upstream-mirror' });
  console.log(`[CoinbaseFetcher] 使用线上转发的 Coinbase 深度数据 (线上采样时间 ${asOf})`);
  return { ...payload, mirroredFrom: 'upstream', mirroredAt: new Date().toISOString() };
}

/**
 * Main public getter for Coinbase liquidity dataset (single-flight).
 */
function getCoinbaseLiquidityData(forceRefresh = false) {
  if (inflight) return inflight;
  inflight = doGetCoinbaseLiquidityData(forceRefresh).finally(() => { inflight = null; });
  return inflight;
}

async function doGetCoinbaseLiquidityData(forceRefresh = false) {
  const now = Date.now();
  seedDiskOnce();

  // Return in-memory cache if valid (cache hits never extend lastSuccessAt)
  if (!forceRefresh && inMemoryCache && (now - lastFetchTime) < CACHE_TTL_MS) {
    return withDataHealth(inMemoryCache, REQUIRED_IDS);
  }

  try {
    console.log('[CoinbaseFetcher] Fetching real-time BTC-USD orderbook, candles, and ticker...');
    const attemptMs = Date.now();
    recordAttempt('coinbase', { now: attemptMs });
    recordAttempt('coinbase_candles', { now: attemptMs });
    const [bookRes, candleRes, tickRes] = await Promise.allSettled([
      fetchCoinbaseOrderBook(),
      fetchCoinbaseDailyCandles(),
      fetchCoinbaseTickerAndStats()
    ]);

    const receiptIso = new Date().toISOString();
    // 'coinbase' covers the live book + ticker/stats leg.
    if (bookRes.status === 'rejected') recordFailure('coinbase', bookRes.reason);
    if (tickRes.status === 'rejected') recordFailure('coinbase', tickRes.reason);
    if (candleRes.status === 'rejected') recordFailure('coinbase_candles', candleRes.reason);
    const anyFailed = [bookRes, candleRes, tickRes].some(r => r.status === 'rejected');
    if (anyFailed) {
      const err = bookRes.reason || tickRes.reason || candleRes.reason;
      throw err instanceof Error ? err : new Error(String(err));
    }

    // A live getter never substitutes missing candles for the 50% defaults:
    // all three legs must be present and validated (validation inside fetchers).
    recordSuccess('coinbase', {
      dataAsOf: receiptIso, asOfKind: 'received', source: 'coinbase.exchange/book+ticker'
    });
    const maxCandleSec = Math.max(...candleRes.value.map(c => Number(c[0])));
    recordSuccess('coinbase_candles', {
      dataAsOf: new Date(maxCandleSec * 1000).toISOString(), asOfKind: 'source', source: 'coinbase.exchange/candles'
    });

    const result = processCoinbaseData(bookRes.value, candleRes.value, tickRes.value);

    const bound = withDataHealth(result, REQUIRED_IDS);
    inMemoryCache = bound;
    lastFetchTime = now;
    liquidityHistory.recordLiveSnapshot(result, now);

    // Persist to local JSON cache (atomic)
    try {
      const dataDir = path.dirname(CACHE_FILE);
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      atomicWriteJson(CACHE_FILE, bound, 2);
      console.log(`[CoinbaseFetcher] Successfully updated Coinbase liquidity cache at ${new Date().toISOString()}`);
    } catch (writeErr) {
      console.warn('[CoinbaseFetcher] Warning: Failed to write cache file:', writeErr.message);
    }

    return bound;
  } catch (err) {
    console.error('[CoinbaseFetcher] Error fetching from Coinbase:', err.message);

    // 本机直连被拦截时，读线上部署直连 Coinbase 得到的同一份结果
    const mirrored = await fetchMirroredLiquidity();
    if (mirrored) {
      const bound = withDataHealth(mirrored, REQUIRED_IDS);
      inMemoryCache = bound;
      lastFetchTime = now;
      return bound;
    }

    // Failures never record live snapshots nor touch the persisted file.
    if (inMemoryCache) return withDataHealth(inMemoryCache, REQUIRED_IDS);
    const cached = readValidatedDisk();
    if (cached) {
      console.log('[CoinbaseFetcher] Returning disk fallback cache');
      inMemoryCache = cached;
      return withDataHealth(cached, REQUIRED_IDS);
    }
    throw err;
  }
}

module.exports = {
  getCoinbaseLiquidityData,
  fetchCoinbaseOrderBook,
  fetchCoinbaseTickerAndStats,
  calcPercentile,
  walkOrderBook,
  processCoinbaseData
};

