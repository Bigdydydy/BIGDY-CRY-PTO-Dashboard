const fs = require('fs');
const path = require('path');
const { fetchWithTimeout } = require('./http_client');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'gold_correlation.json');
const GOLD_GLOBAL_MARKET_CAP_USD = 18.5e12; // Approx $18.5T for ~212,500 tonnes of global above-ground gold
const BTC_CIRCULATING_SUPPLY = 19.8e6;     // Approx 19.8M circulating BTC in 2026

let inMemoryCache = null;
let currentFetchPromise = null;

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
 * Classify correlation regime and provide institutional macroeconomic insights
 */
function classifyCorrelationRegime(r, btcGoldRatio, btcMarketCapShare) {
  const corr = typeof r === 'number' && !isNaN(r) ? r : 0;

  if (corr >= 0.5) {
    return {
      regimeCode: 'DEBASEMENT_HEDGE',
      regimeName: '高抗通胀共振 (Debasement Hedge)',
      badgeClass: 'badge-pos',
      color: '#10b981',
      summary: `BTC 与黄金呈现强正向共振联动 (30D r = +${corr.toFixed(2)})。两者作为“抗法币贬值硬资产”的宏观定位高度共鸣，全球流动性扩张推动两者同步上涨。`,
      keyPointers: [
        `硬资产溢价同频：机构资金将两者共同纳入去中心化储备对冲篮子，对冲美元信用扩张与主权债务压力。`,
        `高贝塔弹性释放：在法币贬值主升浪中，BTC 表现为黄金的“杠杆高贝塔版本”，兑黄金比价持续扩张。`,
        `宏观驱动胜过微观：美联储利率预期与全球央行资产负债表是二者价格中枢的最核心主线。`
      ]
    };
  } else if (corr >= 0.1) {
    return {
      regimeCode: 'MODERATE_LINKAGE',
      regimeName: '温和正向联动 (Moderate Linkage)',
      badgeClass: 'badge-cyan',
      color: '#38bdf8',
      summary: `BTC 与黄金保持温和正相关 (30D r = +${corr.toFixed(2)})。宏观大宗流动性平稳有序，两者维持基准协同但各自具有资产特色。`,
      keyPointers: [
        `流动性常态传导：宏观货币政策处于观察期，黄金稳步筑底，BTC 维持温和风险偏好。`,
        `比价震荡巩固：1 BTC 稳定在 ${btcGoldRatio?.toFixed(1) || '--'} 盎司黄金区间，机构套利与再平衡策略顺畅。`,
        `关注事件催化：密切跟踪 CPI 通胀数据与地缘局势变化，观察是否触发共振升级。`
      ]
    };
  } else if (corr >= -0.2) {
    return {
      regimeCode: 'DECOUPLED_REGIME',
      regimeName: '独立脱钩震荡 (Decoupled Regime)',
      badgeClass: 'badge-warning',
      color: '#f59e0b',
      summary: `BTC 与黄金走势基本脱钩 (30D r = ${corr.toFixed(2)})。BTC 主要由加密原生基本面（期权衍生品伽马、ETF 净申赎与链上筹码分布）自主定价。`,
      keyPointers: [
        `原生微观主导：加密衍生品市场微观结构与现货 ETF 资金流主导盘面，剥离传统大宗商品节奏。`,
        `避险偏好分歧：避险资金单向流入传统黄金，而加密市场处于存量博弈或高波动去杠杆通道。`,
        `相对估值参考：BTC 相对黄金市值渗透率稳定在 ${btcMarketCapShare?.toFixed(1) || '--'}%，估值具备长期向上空间。`
      ]
    };
  } else {
    return {
      regimeCode: 'ASSET_ROTATION',
      regimeName: '资产跷跷板轮动 (Asset Rotation)',
      badgeClass: 'badge-neg',
      color: '#f43f5e',
      summary: `BTC 与黄金呈现显著负相关 (30D r = ${corr.toFixed(2)})。市场资金在“传统实物黄金避险”与“高风险投机资产”之间出现结构性转移或吸血。`,
      keyPointers: [
        `极度风险规避：地缘或黑天鹅冲击导致机构选择传统黄金防守，流动性收紧迫使加密杠杆头寸平仓。`,
        `相对购买力回撤：1 BTC 等价黄金盎司数收缩，数字黄金相对实物黄金估值暂时处于相对低位。`,
        `反转窗口酝酿：历史上长期深负相关多为非理性恐慌或流动性休克，往往酝酿中长期均值回归良机。`
      ]
    };
  }
}

/**
 * Fetch historical klines from Binance and calculate gold/BTC ratio and rolling correlation
 */
async function fetchGoldCorrelationFromSource() {
  const [paxgResp, btcResp] = await Promise.all([
    fetchWithTimeout('https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=1d&limit=1000'),
    fetchWithTimeout('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=1000')
  ]);

  if (!paxgResp.ok) throw new Error(`Binance PAXG HTTP ${paxgResp.status}`);
  if (!btcResp.ok) throw new Error(`Binance BTC HTTP ${btcResp.status}`);

  const paxgKlines = await paxgResp.json();
  const btcKlines = await btcResp.json();

  // Create date lookup map for PAXG
  const paxgMap = new Map();
  for (const k of paxgKlines) {
    const d = new Date(k[0]).toISOString().slice(0, 10);
    paxgMap.set(d, {
      openTime: k[0],
      close: parseFloat(k[4])
    });
  }

  // Intersect with BTC klines by calendar date
  const alignedDates = [];
  const btcPrices = [];
  const goldPrices = [];
  const timestamps = [];

  for (const k of btcKlines) {
    const d = new Date(k[0]).toISOString().slice(0, 10);
    if (paxgMap.has(d)) {
      alignedDates.push(d);
      timestamps.push(k[0]);
      btcPrices.push(parseFloat(k[4]));
      goldPrices.push(paxgMap.get(d).close);
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
    const marketCapShare = Number(((btcMcap / GOLD_GLOBAL_MARKET_CAP_USD) * 100).toFixed(2));
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
      dataSource: 'Binance PAXG/USDT (1:1 实物黄金锚定) + BTC/USDT 官方现货 24/7 连续日线',
      targetReference: 'Newhedge.io (Bitcoin vs. Gold Correlation & Ratio)',
      externalUrl: 'https://newhedge.io/bitcoin/gold-correlation',
      timeRange: `${series[0].date} 至 ${latest.date}`,
      totalDays: series.length,
      correlationWindowDays: 30,
      goldBenchmarkMarketCap: '$18.50T (全球存量地上黄金估算)',
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
    series
  };
}

/**
 * Public getter with memory caching, single-flight fetching, and disk fallback
 */
async function getGoldCorrelationData(forceRefresh = false) {
  if (!forceRefresh && inMemoryCache) {
    return inMemoryCache;
  }

  if (currentFetchPromise) {
    return currentFetchPromise;
  }

  currentFetchPromise = (async () => {
    try {
      console.log('[GoldFetcher] Fetching real-time PAXG and BTC klines from Binance...');
      const result = await fetchGoldCorrelationFromSource();
      inMemoryCache = result;

      // Persist to disk
      try {
        fs.writeFileSync(CACHE_FILE, JSON.stringify(result, null, 2), 'utf8');
        console.log(`[GoldFetcher] Successfully persisted ${result.series.length} days of Gold/BTC data to ${CACHE_FILE}`);
      } catch (writeErr) {
        console.warn('[GoldFetcher] Warning: failed to write cache to disk:', writeErr.message);
      }

      return result;
    } catch (err) {
      console.warn('[GoldFetcher] Live fetch failed:', err.message);

      // Fallback to disk cache if available
      if (fs.existsSync(CACHE_FILE)) {
        try {
          const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
          console.log('[GoldFetcher] Returning persisted disk cache fallback');
          inMemoryCache = cached;
          return cached;
        } catch (readErr) {
          console.warn('[GoldFetcher] Error reading disk fallback:', readErr.message);
        }
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
  GOLD_GLOBAL_MARKET_CAP_USD,
  BTC_CIRCULATING_SUPPLY
};
