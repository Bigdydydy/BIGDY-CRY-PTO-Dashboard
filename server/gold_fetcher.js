const fs = require('fs');
const path = require('path');
const { fetchSpotDailyCloses } = require('./spot_daily');
const { recordAttempt, recordSuccess, recordFailure } = require('./data_health');
const { withDataHealth, seedCachedHealth, atomicWriteJson } = require('./data_health_cache');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'gold_correlation.json');
const HISTORY_DAYS = 1000;
const DAY_MS = 86400000;
const isoDate = ts => new Date(ts).toISOString().slice(0, 10);

const strictNum = v => v !== null && v !== undefined && typeof v !== 'boolean' &&
  !(typeof v === 'string' && v.trim() === '') && Number.isFinite(Number(v));

/**
 * Same schema the live path produces: nonempty daily series with valid
 * strictly-ascending dates, finite positive prices and finite positive
 * timestamps (null must never coerce to 0). rollingCorr may be null in
 * warmup. `current`, when present, must correspond to the last series row.
 */
function validateGoldPayload(c) {
  if (!c || typeof c !== 'object' || !Array.isArray(c.series) || !c.series.length) return false;
  const nowMs = Date.now();
  let prevTs = -Infinity;
  for (const r of c.series) {
    if (!r || typeof r.date !== 'string' || isNaN(Date.parse(r.date))) return false;
    if (!strictNum(r.timestamp) || Number(r.timestamp) <= 0 || Number(r.timestamp) > nowMs + 5 * 60000) return false;
    if (Number(r.timestamp) <= prevTs) return false; // dates must ascend
    prevTs = Number(r.timestamp);
    if (!strictNum(r.btcPrice) || !(Number(r.btcPrice) > 0)) return false;
    if (!strictNum(r.goldPrice) || !(Number(r.goldPrice) > 0)) return false;
    if (r.rollingCorr30d !== null && r.rollingCorr30d !== undefined && !Number.isFinite(Number(r.rollingCorr30d))) return false;
  }
  if (c.current && typeof c.current === 'object') {
    const last = c.series[c.series.length - 1];
    if (c.current.date !== last.date || Number(c.current.timestamp) !== Number(last.timestamp)) return false;
  }
  return true;
}

function readCachedSeries() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return validateGoldPayload(cached) ? cached : null;
  } catch (e) {
    return null;
  }
}
const GOLD_ABOVE_GROUND_OZ = 6.832e9; // Approx 6.832B troy oz for ~212,500 tonnes of global above-ground gold
const BTC_CIRCULATING_SUPPLY = 19.8e6; // Approx 19.8M circulating BTC in 2026

let inMemoryCache = null;
let lastFetchTime = 0;
let currentFetchPromise = null;
let diskSeeded = false;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes cache

/** Seed honest disk clocks once, before the first upstream attempt. */
function seedDiskOnce() {
  if (diskSeeded) return;
  diskSeeded = true;
  const cached = readCachedSeries();
  if (cached) {
    seedCachedHealth(cached, 'gold', {
      dataAsOf: cached.current?.timestamp || cached.current?.date,
      lastSuccessAt: cached.updatedAt || null
    });
  }
}

/**
 * Calculates Pearson correlation coefficient between two equal-length numerical arrays
 */
function calculatePearsonCorrelation(x, y) {
  if (!x || !y || x.length !== y.length || x.length < 2) return 0;
  const n = x.length;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;

  let cov = 0;
  let varX = 0;
  let varY = 0;

  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }

  const denom = Math.sqrt(varX * varY);
  if (denom === 0) return 0;
  return Number((cov / denom).toFixed(3));
}

/**
 * Calculates rolling Pearson correlation series of daily percentage returns
 */
function calculateRollingPearsonCorrelation(series1, series2, window = 30) {
  if (!series1 || !series2 || series1.length !== series2.length || series1.length < 2) return [];

  // Calculate daily returns: (P_t - P_t-1) / P_t-1
  const r1 = [];
  const r2 = [];
  for (let i = 1; i < series1.length; i++) {
    const prev1 = series1[i - 1];
    const prev2 = series2[i - 1];
    r1.push(prev1 > 0 ? (series1[i] - prev1) / prev1 : 0);
    r2.push(prev2 > 0 ? (series2[i] - prev2) / prev2 : 0);
  }

  const result = [null]; // 1st element has no return

  for (let i = 0; i < r1.length; i++) {
    if (i < window - 1) {
      result.push(null);
      continue;
    }
    const sliceX = r1.slice(i - window + 1, i + 1);
    const sliceY = r2.slice(i - window + 1, i + 1);
    result.push(calculatePearsonCorrelation(sliceX, sliceY));
  }

  return result;
}

/**
 * Classify the 30D return correlation. A correlation only says how the two series co-move: it
 * cannot tell joint rallies from joint sell-offs, and it is not evidence of flows between them.
 */
function classifyCorrelationRegime(r, btcGoldRatio, btcMarketCapShare) {
  const corr = typeof r === 'number' && !isNaN(r) ? r : 0;
  const ratioText = `比价：1 BTC ≈ ${btcGoldRatio?.toFixed(1) || '--'} 盎司黄金，BTC 市值约为黄金的 ${btcMarketCapShare?.toFixed(1) || '--'}%；看比价方向可知 BTC 相对黄金的强弱。`;
  const windowText = '30 日窗口样本较少，单个宏观事件即可明显改变相关系数。';

  if (corr >= 0.5) {
    return {
      regimeCode: 'DEBASEMENT_HEDGE',
      regimeName: '强正相关 (Strong Co-movement)',
      badgeClass: 'badge-pos',
      color: '#10b981',
      summary: `BTC 与黄金 30 日收益率相关系数 r = +${corr.toFixed(2)}，同向波动显著。正相关只说明同向，不说明方向：共同上涨与共同下跌都会产生它。“同受全球流动性驱动”是一种可能解释，需结合实际利率、美元与 ETF 资金流验证。`,
      keyPointers: [
        `先区分同涨与同跌：对照同期两者各自的收益方向。`,
        ratioText,
        windowText
      ]
    };
  } else if (corr >= 0.1) {
    return {
      regimeCode: 'MODERATE_LINKAGE',
      regimeName: '温和正相关 (Moderate Linkage)',
      badgeClass: 'badge-cyan',
      color: '#38bdf8',
      summary: `BTC 与黄金 30 日相关系数 r = +${corr.toFixed(2)}，有一定同向性，但对彼此的解释力有限 (r² ≈ ${(corr * corr).toFixed(2)})。`,
      keyPointers: [
        ratioText,
        `观察 CPI、利率决议等共同冲击是否推高相关性。`,
        windowText
      ]
    };
  } else if (corr >= -0.2) {
    return {
      regimeCode: 'DECOUPLED_REGIME',
      regimeName: '低相关 (Decoupled)',
      badgeClass: 'badge-warning',
      color: '#f59e0b',
      summary: `BTC 与黄金 30 日相关系数 r = ${corr.toFixed(2)}，近期走势基本没有线性关系。BTC 的变化需要从其他因素解释，但低相关本身不能指认具体驱动。`,
      keyPointers: [
        ratioText,
        `低相关可能持续，也可能只是两种状态之间的过渡。`,
        windowText
      ]
    };
  } else {
    return {
      regimeCode: 'ASSET_ROTATION',
      regimeName: '负相关 (Inverse Co-movement)',
      badgeClass: 'badge-neg',
      color: '#f43f5e',
      summary: `BTC 与黄金 30 日相关系数 r = ${corr.toFixed(2)}，近期反向波动。这与“资金在黄金与 BTC 之间转移”的解释相容，但相关系数不能证明资金流向，需要 ETF 申赎、期货持仓等流量数据佐证。`,
      keyPointers: [
        ratioText,
        `本模块未统计负相关阶段之后的走势，不应据此推断反转。`,
        windowText
      ]
    };
  }
}

/**
 * Fetch ~1000 daily PAXG and BTC closes (same venue for both legs) and calculate
 * the gold/BTC ratio and rolling correlation
 */
async function fetchGoldCorrelationFromSource() {
  const startMs = Date.now() - HISTORY_DAYS * DAY_MS;
  const { venue, quote, series: spot, errors, partial, coverageStart } = await fetchSpotDailyCloses(['PAXG', 'BTC'], startMs);
  if (errors.length) console.warn(`[GoldFetcher] Using ${venue} after: ${errors.join(' | ')}`);

  const paxgMap = new Map(spot.PAXG.map(r => [r.date, r]));

  // Intersect with BTC closes by calendar date
  const alignedDates = [];
  const btcPrices = [];
  const goldPrices = [];
  const timestamps = [];

  // The fallback venue lists PAXG for less than the full window: keep the cached days before its
  // first bar (both legs from the cached venue), so each day's ratio still uses a single venue
  let dataSource = `${venue} PAXG/${quote} (1:1 实物黄金锚定) + BTC/${quote} 现货 24/7 连续日线`;
  let historySource = dataSource; // single-venue label of the oldest days, carried across splices
  if (partial) {
    const cached = readCachedSeries();
    const older = cached ? cached.series.filter(r => r.date < coverageStart && r.date >= isoDate(startMs)) : [];
    for (const r of older) {
      alignedDates.push(r.date);
      timestamps.push(r.timestamp);
      btcPrices.push(r.btcPrice);
      goldPrices.push(r.goldPrice);
    }
    if (older.length) {
      historySource = cached.metadata?.historySource || cached.metadata?.dataSource || '缓存历史';
      dataSource = `${historySource}（至 ${older[older.length - 1].date}）+ ${venue} PAXG/${quote} + BTC/${quote}（自 ${coverageStart} 起）`;
    }
  }

  for (const k of spot.BTC) {
    if (paxgMap.has(k.date) && (!partial || k.date >= coverageStart)) {
      alignedDates.push(k.date);
      timestamps.push(k.openTime);
      btcPrices.push(k.close);
      goldPrices.push(paxgMap.get(k.date).close);
    }
  }

  if (alignedDates.length < 35) {
    throw new Error(`Insufficient aligned historical records: ${alignedDates.length}`);
  }

  // Calculate 30-day rolling Pearson correlation
  const rollingCorrs = calculateRollingPearsonCorrelation(btcPrices, goldPrices, 30);

  // Build full daily series
  const series = [];
  for (let i = 0; i < alignedDates.length; i++) {
    const btc = btcPrices[i];
    const gold = goldPrices[i];
    const btcGoldRatio = Number((btc / gold).toFixed(2)); // oz of gold per 1 BTC
    const goldBtcRatio = Number((gold / btc).toFixed(5)); // BTC per 1 oz of gold
    const btcMcap = btc * BTC_CIRCULATING_SUPPLY;
    const goldMcap = gold * GOLD_ABOVE_GROUND_OZ;
    const marketCapShare = Number(((btcMcap / goldMcap) * 100).toFixed(2));
    const r = rollingCorrs[i];

    series.push({
      date: alignedDates[i],
      timestamp: timestamps[i],
      btcPrice: Math.round(btc),
      goldPrice: Number(gold.toFixed(2)),
      btcGoldRatio,
      goldBtcRatio,
      marketCapShare,
      rollingCorr30d: r
    });
  }

  // Current stats (latest point)
  const latest = series[series.length - 1];
  const prev1d = series.length > 1 ? series[series.length - 2] : latest;
  const ratioChange24h = Number((((latest.btcGoldRatio - prev1d.btcGoldRatio) / prev1d.btcGoldRatio) * 100).toFixed(2));
  const regime = classifyCorrelationRegime(latest.rollingCorr30d, latest.btcGoldRatio, latest.marketCapShare);

  return {
    metadata: {
      dataSource,
      historySource,
      venue,
      venueFallbackErrors: errors,
      targetReference: 'Newhedge.io (Bitcoin vs. Gold Correlation & Ratio)',
      externalUrl: 'https://newhedge.io/bitcoin/gold-correlation',
      timeRange: `${series[0].date} 至 ${latest.date}`,
      totalDays: series.length,
      correlationWindowDays: 30,
      goldBenchmarkMarketCap: `$${(latest.goldPrice * GOLD_ABOVE_GROUND_OZ / 1e12).toFixed(2)}T (全球地上黄金存量动态估算)`,
      isRealHistorical: true
    },
    current: {
      btcPrice: latest.btcPrice,
      goldPrice: latest.goldPrice,
      btcGoldRatio: latest.btcGoldRatio,     // e.g. 17.58 oz per BTC
      goldBtcRatio: latest.goldBtcRatio,     // e.g. 0.05688 BTC per oz
      ratioChange24h,                        // 24h percentage change of ratio
      marketCapShare: latest.marketCapShare, // e.g. 8.21%
      rollingCorr30d: latest.rollingCorr30d, // e.g. +0.71
      timestamp: latest.timestamp,
      date: latest.date
    },
    regime,
    series,
    updatedAt: new Date().toISOString()
  };
}

/**
 * Public getter with memory caching, single-flight fetching, and disk fallback
 */
async function getGoldCorrelationData(forceRefresh = false) {
  const now = Date.now();
  seedDiskOnce();
  if (!forceRefresh && inMemoryCache && (now - lastFetchTime < CACHE_TTL_MS)) {
    return withDataHealth(inMemoryCache, ['gold']);
  }

  if (currentFetchPromise) {
    return currentFetchPromise;
  }

  recordAttempt('gold', { now: Date.now() });
  currentFetchPromise = (async () => {
    try {
      console.log('[GoldFetcher] Fetching real-time PAXG and BTC klines from Binance...');
      const result = await fetchGoldCorrelationFromSource();

      // Real fetch completed: data-as-of is the latest series point's own
      // timestamp, never the receipt time.
      const issues = [
        ...(result.metadata?.venueFallbackErrors || []).map(String),
        ...(result.metadata?.partial ? ['venue history partial — spliced cached prefix'] : [])
      ];
      recordSuccess('gold', {
        dataAsOf: result.current.timestamp || result.current.date,
        asOfKind: 'source',
        source: result.metadata?.venue || 'spot_daily',
        issues
      });
      const bound = withDataHealth(result, ['gold']);
      inMemoryCache = bound;
      lastFetchTime = Date.now();

      // Persist to disk (atomic)
      try {
        atomicWriteJson(CACHE_FILE, bound, 2);
        console.log(`[GoldFetcher] Successfully persisted ${result.series.length} days of Gold/BTC data to ${CACHE_FILE}`);
      } catch (writeErr) {
        console.warn('[GoldFetcher] Warning: failed to write cache to disk:', writeErr.message);
      }

      return bound;
    } catch (err) {
      console.warn('[GoldFetcher] Live fetch failed:', err.message);
      recordFailure('gold', err);

      // Fallback: valid in-memory copy first, then validated disk.
      if (inMemoryCache && validateGoldPayload(inMemoryCache)) {
        return withDataHealth(inMemoryCache, ['gold']);
      }
      const cached = readCachedSeries();
      if (cached) {
        console.log('[GoldFetcher] Returning persisted disk cache fallback');
        inMemoryCache = cached;
        return withDataHealth(cached, ['gold']);
      }

      throw err;
    } finally {
      currentFetchPromise = null;
    }
  })();

  return currentFetchPromise;
}

module.exports = {
  getGoldCorrelationData,
  calculatePearsonCorrelation,
  calculateRollingPearsonCorrelation,
  classifyCorrelationRegime,
  GOLD_ABOVE_GROUND_OZ,
  BTC_CIRCULATING_SUPPLY
};
