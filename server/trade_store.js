const fs = require('fs');
const path = require('path');
const { formatUTC8 } = require('./analytics_engine');

const DATA_DIR = path.join(__dirname, '..', 'data');
const RETENTION_DAYS = 60;
const MAX_RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

// Currencies whose archive was written by this process (see recordAndMergeTrades step 6)
const persistedThisProcess = new Set();

// In-memory trade cache by currency
const memoryCache = new Map();

/**
 * Get storage file path for currency
 */
function getStorageFilePath(currency = 'BTC') {
  return path.join(DATA_DIR, `block_trades_${currency.toUpperCase()}.json`);
}

/**
 * Ensure data directory exists
 */
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * Load persisted trades from disk
 */
function loadPersistedTrades(currency = 'BTC') {
  const filePath = getStorageFilePath(currency);
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return parsed.trades || [];
  } catch (err) {
    console.error(`[TradeStore] Error loading ${filePath}:`, err.message);
    return [];
  }
}

/**
 * Atomically save trades to disk
 */
function saveTradesToDisk(currency = 'BTC', trades = []) {
  ensureDataDir();
  const filePath = getStorageFilePath(currency);
  const tempPath = `${filePath}.tmp_${Date.now()}`;
  
  const payload = {
    currency: currency.toUpperCase(),
    retentionDays: RETENTION_DAYS,
    lastUpdated: new Date().toISOString(),
    totalTrades: trades.length,
    trades
  };

  try {
    fs.writeFileSync(tempPath, JSON.stringify(payload), 'utf-8');
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    console.error(`[TradeStore] Failed to save trades to ${filePath}:`, err.message);
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (_) {}
    throw err; // A failed archive write must not be reported as a successful merge.
  }
}

/**
 * Generate unique identity key for a trade
 */
function getTradeKey(trade) {
  if (trade.trade_id) return String(trade.trade_id);
  return `${trade.block_trade_id || 'BLK'}_${trade.instrument_name}_${trade.timestamp}_${trade.amount}_${trade.direction}`;
}

/**
 * Merge newly fetched trades with historical 60-day database
 * Automatically prunes trades older than 60 days
 */
function recordAndMergeTrades(currency = 'BTC', newTrades = []) {
  const curKey = currency.toUpperCase();
  
  // 1. Get existing trades
  let existingTrades = memoryCache.get(curKey);
  if (!existingTrades) {
    existingTrades = loadPersistedTrades(curKey);
    memoryCache.set(curKey, existingTrades);
  }

  // 2. Build index map
  const tradeMap = new Map();
  for (const t of existingTrades) {
    tradeMap.set(getTradeKey(t), t);
  }

  // 3. Merge new trades
  let newAddedCount = 0;
  let enrichedCount = 0;
  for (const t of newTrades) {
    const key = getTradeKey(t);
    if (!tradeMap.has(key)) {
      tradeMap.set(key, t);
      newAddedCount++;
    } else {
      // Update with any richer fields if present
      const old = tradeMap.get(key);
      if (Object.keys(t).some(k => old[k] !== t[k] && JSON.stringify(old[k]) !== JSON.stringify(t[k]))) enrichedCount++;
      tradeMap.set(key, { ...old, ...t });
    }
  }

  // 4. Prune trades older than 60 days
  const now = Date.now();
  const cutoffTime = now - MAX_RETENTION_MS;
  const mergedList = [];

  for (const t of tradeMap.values()) {
    const ts = t.timestamp;
    if (ts && ts >= cutoffTime) {
      mergedList.push(t);
    }
  }

  // 5. Sort chronologically descending (newest first)
  mergedList.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  // 6. Persist the first verified merge of this process (retention-policy
  // migration, even for an empty poll), then only when the archive actually
  // changed (new legs, richer duplicates, pruning) — the 60-day file is
  // several MB and polls run every 30 s.
  const pruned = mergedList.length < tradeMap.size;
  if (!persistedThisProcess.has(curKey) || newAddedCount > 0 || enrichedCount > 0 || pruned) {
    saveTradesToDisk(curKey, mergedList);
    persistedThisProcess.add(curKey);
  }
  memoryCache.set(curKey, mergedList);

  // 7. Calculate stats
  const earliestTs = mergedList.length > 0 ? mergedList[mergedList.length - 1].timestamp : null;
  const latestTs = mergedList.length > 0 ? mergedList[0].timestamp : null;
  const historySpanHours = earliestTs && latestTs ? Math.max(0, (latestTs - earliestTs) / 3600000) : 0;
  const historySpanDays = (historySpanHours / 24).toFixed(1);

  const stats = {
    totalStored: mergedList.length,
    newAddedCount,
    retentionDays: RETENTION_DAYS,
    earliestTimeUTC8: earliestTs ? formatUTC8(earliestTs) : '--',
    latestTimeUTC8: latestTs ? formatUTC8(latestTs) : '--',
    historySpanHours: Math.round(historySpanHours * 10) / 10,
    historySpanDays: parseFloat(historySpanDays),
    storageFile: `data/block_trades_${curKey}.json`
  };

  return {
    trades: mergedList,
    stats
  };
}

/**
 * Filter trades by time window
 * @param {Array} trades 
 * @param {string} windowKey '24h' | '3d' | '7d' | '30d' | '60d' | 'all'
 */
function filterTradesByWindow(trades = [], windowKey = 'all') {
  if (!trades || !trades.length || windowKey === 'all') {
    return trades;
  }

  const now = Date.now();
  let windowMs = MAX_RETENTION_MS;

  if (windowKey === '24h') {
    windowMs = 24 * 60 * 60 * 1000;
  } else if (windowKey === '3d') {
    windowMs = 3 * 24 * 60 * 60 * 1000;
  } else if (windowKey === '7d') {
    windowMs = 7 * 24 * 60 * 60 * 1000;
  } else if (windowKey === '30d') {
    windowMs = 30 * 24 * 60 * 60 * 1000;
  }

  const cutoff = now - windowMs;
  return trades.filter(t => (t.timestamp || 0) >= cutoff);
}

/**
 * Get current cached trades without re-fetching
 */
function getCachedTrades(currency = 'BTC') {
  const curKey = currency.toUpperCase();
  let trades = memoryCache.get(curKey);
  if (!trades) {
    trades = loadPersistedTrades(curKey);
    memoryCache.set(curKey, trades);
  }
  return trades;
}

module.exports = {
  recordAndMergeTrades,
  filterTradesByWindow,
  getCachedTrades,
  RETENTION_DAYS
};
