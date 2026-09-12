const crypto = require('crypto');
const { getXSign } = require('./crypto_signer');
const { recordAndMergeTrades, getCachedTrades } = require('./trade_store');
const { analyzeTermPremium } = require('./term_premium_engine');

const GREEKS_BASE_URL = 'https://api.greeks.live/api/v1';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Cache structure tracking data and update status
let dataCache = {
  lastSyncCheckTime: null,
  lastDataChangeTime: null,
  dataVersion: 1,
  currency: 'BTC',
  blockTrades: [],
  tradeStoreStats: null,
  atmData: null,
  gex: null,
  ivHistory: null,
  skewChart: null,
  ivSkewMonth: null,
  dvolStats: null,
  termPremium: null,
  lastFingerprints: {},
  lastChanges: {
    hasAnyUpdate: false,
    summary: '初始加载完成',
    blockTrades: false,
    newTradesCount: 0,
    gex: false,
    ivHistory: false,
    skewChart: false,
    ivSkewMonth: false,
    priceChanged: false
  }
};

/**
 * Hash generator for change detection
 */
function hashObject(obj) {
  if (!obj) return '';
  return crypto.createHash('md5').update(JSON.stringify(obj)).digest('hex');
}

/**
 * Make signed request to Greeks.live DataLab
 */
async function fetchGreeksDataLab(endpoint, payload) {
  const url = `${GREEKS_BASE_URL}/deribit/datalab/${endpoint}`;
  const xSign = getXSign();
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      'X-Sign': xSign,
      'Origin': 'https://www.greeks.live',
      'Referer': 'https://www.greeks.live/'
    },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    throw new Error(`Greeks.live DataLab error on ${endpoint}: ${resp.status} ${resp.statusText}`);
  }
  const json = await resp.json();
  if (json.code !== 200 && json.code !== 0) {
    throw new Error(`Greeks.live DataLab error on ${endpoint}: code=${json.code}, msg=${json.msg}`);
  }
  return json.data;
}

/**
 * Fetch raw Block Trades from Greeks.live
 */
async function fetchBlockTrades(currency = 'BTC') {
  const url = `${GREEKS_BASE_URL}/block_trade`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT
    },
    body: JSON.stringify({ currency, kind: 'option' })
  });

  if (!resp.ok) {
    throw new Error(`Greeks.live Block Trade error: ${resp.status}`);
  }
  const json = await resp.json();
  return json.data || [];
}

/**
 * Fetch Deribit DVOL historical statistics
 */
async function fetchDvolHistoricalStats(currency = 'BTC') {
  try {
    const endTs = Date.now();
    const startTs = endTs - 2 * 365 * 24 * 3600 * 1000;
    const url = `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=${currency}&start_timestamp=${startTs}&end_timestamp=${endTs}&resolution=1D`;
    const resp = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!resp.ok) return null;
    const json = await resp.json();
    const data = json.result?.data || [];
    if (!data.length) return null;

    const closes = data.map(d => d[4]).filter(v => typeof v === 'number' && !isNaN(v));
    closes.sort((a, b) => a - b);

    return {
      count: closes.length,
      min: closes[0],
      max: closes[closes.length - 1],
      median: closes[Math.floor(closes.length * 0.5)],
      p10: closes[Math.floor(closes.length * 0.1)],
      p25: closes[Math.floor(closes.length * 0.25)],
      p75: closes[Math.floor(closes.length * 0.75)],
      p90: closes[Math.floor(closes.length * 0.9)],
      historicalSeries: closes
    };
  } catch (err) {
    console.warn('Failed to fetch DVOL stats, fallback to standard bounds:', err.message);
    return null;
  }
}

/**
 * Fetch Deribit futures book summary for term structure calculation
 */
async function fetchDeribitFutures(currency = 'BTC') {
  try {
    const url = `https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${currency}&kind=future`;
    const resp = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!resp.ok) return [];
    const json = await resp.json();
    return json.result || [];
  } catch (err) {
    console.warn('Failed to fetch Deribit futures:', err.message);
    return [];
  }
}

/**
 * Compare new data against fingerprints to detect actual updates
 */
function detectDataChanges(accumulatedTrades, newGex, newIvHistory, newSkewChart, newIvSkewMonth, newAddedTrades = 0) {
  const prevFps = dataCache.lastFingerprints;
  const changes = {
    hasAnyUpdate: false,
    blockTrades: false,
    newTradesCount: 0,
    gex: false,
    ivHistory: false,
    skewChart: false,
    ivSkewMonth: false,
    priceChanged: false,
    summary: ''
  };

  // 1. Block Trades diff from persistent 30-day store
  if (newAddedTrades > 0) {
    changes.blockTrades = true;
    changes.newTradesCount = newAddedTrades;
    changes.hasAnyUpdate = true;
  }

  // 2. GEX diff
  const gexFp = newGex ? `${newGex.ts}_${newGex.index_price}` : '';
  if (prevFps.gex && prevFps.gex !== gexFp) {
    changes.gex = true;
    changes.hasAnyUpdate = true;
  }

  // Spot Price diff
  const oldPrice = dataCache.gex?.index_price;
  const newPrice = newGex?.index_price;
  if (oldPrice && newPrice && Math.abs(oldPrice - newPrice) >= 0.5) {
    changes.priceChanged = true;
    changes.hasAnyUpdate = true;
  }

  // 3. IV History diff
  const latestIvItem = newIvHistory && newIvHistory.length ? newIvHistory[newIvHistory.length - 1] : null;
  const ivFp = latestIvItem ? `${latestIvItem.created_at}_${latestIvItem.month1}_${latestIvItem.month3}` : '';
  if (prevFps.ivHistory && prevFps.ivHistory !== ivFp) {
    changes.ivHistory = true;
    changes.hasAnyUpdate = true;
  }

  // 4. Skew Chart diff
  const latestSkewItem = newSkewChart && newSkewChart.length ? newSkewChart[newSkewChart.length - 1] : null;
  const skewFp = latestSkewItem ? `${latestSkewItem.timestamps}_${latestSkewItem.days30}_${latestSkewItem.day1}` : '';
  if (prevFps.skewChart && prevFps.skewChart !== skewFp) {
    changes.skewChart = true;
    changes.hasAnyUpdate = true;
  }

  // 5. IV Skew Month (Smile) diff
  const smileFp = newIvSkewMonth?.month1 ? `${newIvSkewMonth.month1.underlying_price}_${newIvSkewMonth.month1.iv_list?.length}` : '';
  if (prevFps.ivSkewMonth && prevFps.ivSkewMonth !== smileFp) {
    changes.ivSkewMonth = true;
    changes.hasAnyUpdate = true;
  }

  // Initial load check
  if (!dataCache.lastDataChangeTime) {
    changes.hasAnyUpdate = true;
    changes.summary = '初始全量数据加载完成，所有量化模型已就绪';
  } else if (changes.hasAnyUpdate) {
    const parts = [];
    if (changes.blockTrades) parts.push(`新增 ${changes.newTradesCount} 笔大宗成交并持久沉淀`);
    if (changes.priceChanged) parts.push(`现货更新至 $${Math.round(newPrice).toLocaleString()}`);
    if (changes.gex) parts.push('GEX 敞口更新');
    if (changes.ivHistory) parts.push('ATM IV 更新');
    if (changes.skewChart) parts.push('25Δ 偏度更新');
    if (changes.ivSkewMonth) parts.push('微笑曲线更新');
    changes.summary = `检测到新变动: ${parts.join('、')}，所有量化模块已全量重新研判`;
  } else {
    changes.summary = '所有数据源已校验，暂无新成交或价格变动，保持最新分析';
  }

  // Store new fingerprints
  dataCache.lastFingerprints = {
    gex: gexFp,
    ivHistory: ivFp,
    skewChart: skewFp,
    ivSkewMonth: smileFp
  };

  return changes;
}

/**
 * Refresh all market data, verify updates, and trigger re-analysis
 */
async function refreshAllMarketData(currency = 'BTC') {
  const checkTime = new Date().toISOString();
  console.log(`[DataFetcher] Checking & refreshing market data for ${currency} at ${checkTime}...`);

  const [
    blockTradesRes,
    atmDataRes,
    gexRes,
    ivHistoryRes,
    skewChartRes,
    ivSkewMonthRes,
    dvolStatsRes,
    futuresRes
  ] = await Promise.allSettled([
    fetchBlockTrades(currency),
    fetchGreeksDataLab('atm_data', { currency }),
    fetchGreeksDataLab('gex', { currency }),
    fetchGreeksDataLab('iv_history', { currency, gap: '1d' }),
    fetchGreeksDataLab('skew_chart', { currency, gap: '1d' }),
    fetchGreeksDataLab('iv_skew_month', { currency }),
    fetchDvolHistoricalStats(currency),
    fetchDeribitFutures(currency)
  ]);

  let accumulatedTrades = dataCache.blockTrades;
  let tradeStats = dataCache.tradeStoreStats;
  let newAddedTrades = 0;

  if (blockTradesRes.status === 'fulfilled' && Array.isArray(blockTradesRes.value)) {
    const mergeResult = recordAndMergeTrades(currency, blockTradesRes.value);
    accumulatedTrades = mergeResult.trades;
    tradeStats = mergeResult.stats;
    newAddedTrades = tradeStats.newAddedCount;
  } else if (!accumulatedTrades.length) {
    accumulatedTrades = getCachedTrades(currency);
  }

  const newGex = gexRes.status === 'fulfilled' ? gexRes.value : dataCache.gex;
  const newIvHistory = ivHistoryRes.status === 'fulfilled' ? ivHistoryRes.value : dataCache.ivHistory;
  const newSkewChart = skewChartRes.status === 'fulfilled' ? skewChartRes.value : dataCache.skewChart;
  const newIvSkewMonth = ivSkewMonthRes.status === 'fulfilled' ? ivSkewMonthRes.value : dataCache.ivSkewMonth;
  const spotPrice = newGex?.index_price || 77400;

  // Calculate Term Premium & Basis Structure
  try {
    const futuresList = futuresRes.status === 'fulfilled' && Array.isArray(futuresRes.value) ? futuresRes.value : [];
    dataCache.termPremium = await analyzeTermPremium(futuresList, spotPrice);
  } catch (err) {
    console.warn('[DataFetcher] Term Premium analysis error:', err.message);
  }

  // Run change detection with persistent trade store additions
  const changeReport = detectDataChanges(accumulatedTrades, newGex, newIvHistory, newSkewChart, newIvSkewMonth, newAddedTrades);

  // Update in-memory data
  dataCache.blockTrades = accumulatedTrades;
  dataCache.tradeStoreStats = tradeStats;
  dataCache.gex = newGex;
  dataCache.ivHistory = newIvHistory;
  dataCache.skewChart = newSkewChart;
  dataCache.ivSkewMonth = newIvSkewMonth;
  if (atmDataRes.status === 'fulfilled') dataCache.atmData = atmDataRes.value;
  if (dvolStatsRes.status === 'fulfilled' && dvolStatsRes.value) dataCache.dvolStats = dvolStatsRes.value;

  dataCache.lastSyncCheckTime = checkTime;
  dataCache.lastChanges = changeReport;

  if (changeReport.hasAnyUpdate) {
    dataCache.lastDataChangeTime = checkTime;
    dataCache.dataVersion += 1;
    console.log(`[DataFetcher] ⚡ New data detected! Incrementing dataVersion to ${dataCache.dataVersion}. Summary: ${changeReport.summary}`);
  } else {
    console.log(`[DataFetcher] ✓ No new changes detected. Maintained at dataVersion ${dataCache.dataVersion}. (Stored: ${accumulatedTrades.length} trades)`);
  }

  return {
    hasAnyUpdate: changeReport.hasAnyUpdate,
    dataVersion: dataCache.dataVersion,
    summary: changeReport.summary,
    changes: changeReport,
    lastSyncCheckTime: dataCache.lastSyncCheckTime,
    lastDataChangeTime: dataCache.lastDataChangeTime
  };
}

function getCachedData() {
  return dataCache;
}

module.exports = {
  refreshAllMarketData,
  getCachedData
};
