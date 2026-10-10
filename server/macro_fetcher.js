const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { fetchWithTimeout, fetchBinanceSpot } = require('./http_client');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'macro_chart.json');
const BT_STRATEGY_FILE = path.join(__dirname, '..', 'data', 'bitcointreasuries_strategy.json');
const MSTR_CAPITAL_FILE = path.join(__dirname, '..', 'data', 'mstr_capital_structure.json');
let inMemoryCache = null;

// 区块补贴：2024-04-20 第四次减半后 3.125 BTC × 144 块 ≈ 450 BTC/天
function dailyIssuanceBtc(dateStr) {
  return dateStr >= '2024-04-20' ? 450 : 900;
}

/**
 * 读取 MSTR 固定债权（可转债 + 优先股面值 − 现金，单位 USD）。
 * mNAV 外推时，这部分 EV 不随股价变动；未填写则退化为纯股权口径。
 */
function loadMstrCapitalStructure() {
  try {
    if (fs.existsSync(MSTR_CAPITAL_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(MSTR_CAPITAL_FILE, 'utf8'));
      if (typeof cfg.netFixedClaimsUSD === 'number') return cfg;
    }
  } catch (err) {
    console.error('[MacroFetcher] Error reading MSTR capital structure:', err.message);
  }
  return null;
}
let lastFetchTime = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes cache

/**
 * Load authoritative Strategy data from bitcointreasuries.net
 */
function loadBitcoinTreasuriesStrategy() {
  try {
    if (fs.existsSync(BT_STRATEGY_FILE)) {
      return JSON.parse(fs.readFileSync(BT_STRATEGY_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('[MacroFetcher] Error reading bitcointreasuries data:', err.message);
  }
  return null;
}


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

/**
 * Fetch and decrypt MicroStrategy average cost history from Coinglass
 */
async function fetchMstrCost() {
  try {
    const url = 'https://capi.coinglass.com/api/escape/index/microStrategyCostV2';
    const now = Date.now().toString();
    const resp = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.coinglass.com/pro/i/micro-strategy-cost',
        'Origin': 'https://www.coinglass.com',
        'Accept': 'application/json, text/plain, */*',
        'cache-ts-v2': now,
        'encryption': 'true',
        'language': 'en'
      }
    });

    if (!resp.ok) {
      throw new Error('Coinglass HTTP ' + resp.status);
    }

    const v = resp.headers.get('v');
    const user = resp.headers.get('user');
    const json = await resp.json();

    if (!json.data) {
      throw new Error('No encrypted data in Coinglass response');
    }

    let key1_raw = '';
    if (v === '77') {
      key1_raw = '863f08689c97435b';
    } else if (v === '66') {
      key1_raw = 'd6537d845a964081';
    } else if (v === '55') {
      key1_raw = '170b070da9654622';
    } else if (v === '0') {
      key1_raw = now;
    } else if (v === '1') {
      key1_raw = getRe(url);
    } else if (v === '2') {
      key1_raw = resp.headers.get('time') || '';
    }

    const key1 = Buffer.from(key1_raw).toString('base64').slice(0, 16);
    const key2 = ne(user, key1);
    const decryptedStr = ne(json.data, key2);
    const parsed = JSON.parse(decryptedStr);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('[MacroFetcher] Error fetching Coinglass MSTR cost:', err.message);
    return [];
  }
}

/**
 * Fetch latest holdings news directly from bitcointreasuries.net
 */
async function fetchLiveBtPurchases() {
  try {
    const resp = await fetchWithTimeout('https://bitcointreasuries.net/public-companies/strategy', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    if (!resp.ok) return [];
    const text = await resp.text();
    const regex = /\{[^{}]*kind:"holdings_news"[^{}]*facts:\{([^}]+)\}[^{}]*\}/g;
    const matches = [...text.matchAll(regex)];
    const events = [];
    for (const m of matches) {
      const factStr = m[1];
      const balM = factStr.match(/balance:(\d+)/);
      const dateM = factStr.match(/balance_date:"([^"]+)"/);
      const deltaM = factStr.match(/delta:(-?\d+)/);
      const costM = factStr.match(/cost_basis_total:(\d+|null)/);
      if (balM && dateM) {
        const balance = parseInt(balM[1], 10);
        const date = dateM[1];
        const timestamp = new Date(date + 'T00:00:00Z').getTime();
        const delta = deltaM ? parseInt(deltaM[1], 10) : 0;
        let costBasis = (costM && costM[1] !== 'null') ? parseFloat(costM[1]) : null;
        let avgCost = (costBasis && balance > 0) ? Number((costBasis / balance).toFixed(2)) : null;
        events.push({ date, timestamp, balance, delta, costBasis, avgCost });
      }
    }
    return events;
  } catch (err) {
    console.warn('[MacroFetcher] Live bitcointreasuries fetch skipped:', err.message);
    return [];
  }
}


/**
 * Fetch Treasury yield series from FRED CSV
 */
async function fetchFredSeries(id) {
  try {
    const resp = await fetchWithTimeout('https://fred.stlouisfed.org/graph/fredgraph.csv?id=' + id, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    if (!resp.ok) throw new Error('FRED HTTP ' + resp.status);
    const text = await resp.text();
    const lines = text.trim().split('\n');
    const map = new Map();
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length >= 2) {
        const date = parts[0].trim();
        const valStr = parts[1].trim();
        if (valStr !== '.' && valStr !== '' && !isNaN(parseFloat(valStr))) {
          map.set(date, parseFloat(valStr));
        }
      }
    }
    return map;
  } catch (err) {
    console.error('[MacroFetcher] Error fetching FRED ' + id + ':', err.message);
    return new Map();
  }
}

/**
 * Fetch daily BTC close price history from Binance
 */
async function fetchBtcDailyPrices(startDateStr = '2020-08-01') {
  try {
    let start = new Date(startDateStr).getTime();
    const now = Date.now();
    const allKlines = [];
    while (start < now) {
      const resp = await fetchBinanceSpot('/api/v3/klines?symbol=BTCUSDT&interval=1d&startTime=' + start + '&limit=1000');
      if (!resp.ok) break;
      const data = await resp.json();
      if (!Array.isArray(data) || data.length === 0) break;
      allKlines.push(...data);
      const lastTime = data[data.length - 1][0];
      if (lastTime <= start) break;
      start = lastTime + 86400000;
    }
    const map = new Map();
    for (const k of allKlines) {
      const dateStr = new Date(k[0]).toISOString().slice(0, 10);
      map.set(dateStr, parseFloat(k[4]));
    }
    return map;
  } catch (err) {
    console.error('[MacroFetcher] Error fetching Binance BTC prices:', err.message);
    return new Map();
  }
}

/**
 * Fetch daily MSTR stock close history from Yahoo Finance (for post-snapshot mNAV estimation)
 */
async function fetchMstrStockPrices() {
  try {
    const resp = await fetchWithTimeout('https://query1.finance.yahoo.com/v8/finance/chart/MSTR?range=5y&interval=1d', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' }
    });
    if (!resp.ok) throw new Error('Yahoo HTTP ' + resp.status);
    const json = await resp.json();
    const res = json.chart?.result?.[0];
    const ts = res?.timestamp;
    const closes = res?.indicators?.quote?.[0]?.close;
    const map = new Map();
    if (Array.isArray(ts) && Array.isArray(closes)) {
      for (let i = 0; i < ts.length; i++) {
        const c = closes[i];
        if (typeof c === 'number' && c > 0) {
          map.set(new Date(ts[i] * 1000).toISOString().slice(0, 10), c);
        }
      }
    }
    return map;
  } catch (err) {
    console.error('[MacroFetcher] Error fetching Yahoo MSTR stock prices:', err.message);
    return new Map();
  }
}

/**
 * Fetch and build fully aligned macro dataset
 */
async function fetchAndBuildMacroData() {
  console.log('[MacroFetcher] Starting data fetch for Macro Chart...');
  const [mstrList, liveBtList, fred1y, fred10y, fredWalcl, fredWtregen, fredRrp, btcMap, mstrStockMap] = await Promise.all([
    fetchMstrCost(),
    fetchLiveBtPurchases(),
    fetchFredSeries('DGS1'),
    fetchFredSeries('DGS10'),
    fetchFredSeries('WALCL'),
    fetchFredSeries('WTREGEN'),
    fetchFredSeries('RRPONTSYD'),
    fetchBtcDailyPrices('2020-08-01'),
    fetchMstrStockPrices()
  ]);

  console.log('[MacroFetcher] Raw data: MSTR=' + mstrList.length + ' purchases, Live BT=' + liveBtList.length + ' news, FRED 1Y=' + fred1y.size + ', FRED 10Y=' + fred10y.size + ', WALCL=' + fredWalcl.size + ', WTREGEN=' + fredWtregen.size + ', RRP=' + fredRrp.size + ', BTC=' + btcMap.size + ' days, MSTR stock=' + mstrStockMap.size + ' days');

  // Load authoritative bitcointreasuries.net data
  const btData = loadBitcoinTreasuriesStrategy();
  const btDailyMap = new Map();
  let btPurchases = [];
  if (btData) {
    if (Array.isArray(btData.dailyData)) {
      for (const item of btData.dailyData) {
        btDailyMap.set(item.date, item);
      }
    }
    if (Array.isArray(btData.purchases)) {
      btPurchases = [...btData.purchases].sort((a, b) => a.timestamp - b.timestamp);
    }
    console.log('[MacroFetcher] Loaded bitcointreasuries dataset: ' + btDailyMap.size + ' daily records, ' + btPurchases.length + ' official purchases');
  }

  let effectiveMstrList = mstrList;
  if (effectiveMstrList.length === 0 && fs.existsSync(CACHE_FILE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (cached && cached.rawMstr) {
        effectiveMstrList = cached.rawMstr;
        console.log('[MacroFetcher] Loaded ' + effectiveMstrList.length + ' MSTR records from cache fallback');
      }
    } catch (e) {}
  }

  effectiveMstrList.sort((a, b) => a.timestamp - b.timestamp);

  const allDates = Array.from(btcMap.keys()).sort();
  if (allDates.length === 0) {
    throw new Error('Failed to retrieve date sequence from BTC price feed');
  }

  // Initial defaults
  let lastMstrCost = 11652.84;
  let curHoldings = 21454;
  let curVelocity = 0;
  let curMnav = 1.05;
  let mstrEventIdx = 0;
  let last1y = null;
  let last10y = null;

  // Merge official snapshot purchases with live bitcointreasuries events and live Coinglass records
  // that postdate the snapshot, so cost/holdings keep updating continuously
  const lastOfficialPurchaseTs = btPurchases.length ? btPurchases[btPurchases.length - 1].timestamp : -Infinity;

  const postSnapshotBtEvents = (liveBtList || [])
    .filter(e => e.timestamp > lastOfficialPurchaseTs && e.balance > 0)
    .map(e => {
      let cost = e.avgCost;
      if (!cost && btPurchases.length > 0) {
        const lastOfficial = btPurchases[btPurchases.length - 1];
        const btcPx = btcMap.get(e.date) || 85000;
        const estCostBasis = (lastOfficial.costBasisUSD || 63800000000) + (e.delta > 0 ? e.delta * btcPx : 0);
        cost = Number((estCostBasis / e.balance).toFixed(2));
      }
      return { timestamp: e.timestamp, cost: cost || 75437, holdings: e.balance, source: 'bitcointreasuries' };
    });

  const mergedMstrEvents = [
    ...btPurchases.map(p => ({ timestamp: p.timestamp, cost: p.avgCostUSD, holdings: p.balance, source: 'sec' })),
    ...postSnapshotBtEvents,
    ...effectiveMstrList
      .filter(m => m.timestamp > lastOfficialPurchaseTs && !postSnapshotBtEvents.some(b => Math.abs(b.timestamp - m.timestamp) < 86400000))
      .map(m => ({ timestamp: m.timestamp, cost: m.microStrategyCost, holdings: m.totalBitcoin, source: 'coinglass' }))
  ].sort((a, b) => a.timestamp - b.timestamp);
  let lastMstrCostSource = null;
  let lastMstrCostDate = null;
  console.log('[MacroFetcher] MSTR events: ' + btPurchases.length + ' official purchases + ' + postSnapshotBtEvents.length + ' live BT news + ' + (mergedMstrEvents.length - btPurchases.length - postSnapshotBtEvents.length) + ' live Coinglass records');

  // mNAV anchor: last snapshot dailyData point, used to estimate mNAV beyond snapshot coverage
  // via market-cap/BTC-NAV ratio scaling with live MSTR stock price
  const stockDates = Array.from(mstrStockMap.keys()).sort();
  let stockIdx = 0;
  let lastMstrPx = null;
  let mnavAnchor = null;
  if (btData && Array.isArray(btData.dailyData) && btData.dailyData.length) {
    const anchorDaily = btData.dailyData.reduce((a, b) => (a.date > b.date ? a : b));
    const anchorBtc = btcMap.get(anchorDaily.date);
    let anchorPx = null;
    for (let k = stockDates.length - 1; k >= 0; k--) {
      if (stockDates[k] <= anchorDaily.date) { anchorPx = mstrStockMap.get(stockDates[k]); break; }
    }
    if (anchorDaily.mnav && anchorDaily.holdings && anchorBtc && anchorPx) {
      // EV = 股权市值 + 固定债权。只有股权部分随股价变动，股数由锚点反推
      const capital = loadMstrCapitalStructure();
      const fixedClaims = capital ? capital.netFixedClaimsUSD : 0;
      const ev = anchorDaily.mnav * anchorDaily.holdings * anchorBtc;
      const equity = ev - fixedClaims;
      if (equity > 0) {
        mnavAnchor = {
          date: anchorDaily.date,
          holdings: anchorDaily.holdings,
          fixedClaims,
          shares: equity / anchorPx,
          basis: capital ? 'ev' : 'equity'
        };
        console.log('[MacroFetcher] mNAV anchor @ ' + anchorDaily.date + ': mnav=' + anchorDaily.mnav + ' mstrPx=' + anchorPx.toFixed(2) + ' btc=' + anchorBtc + ' fixedClaims=' + fixedClaims + ' basis=' + mnavAnchor.basis);
      }
    }
  }
  // 锚点之后新增的 BTC 假设由 ATM 增发按当日股价融资，累计新增股数
  let dilutionShares = 0;
  let prevEstHoldings = mnavAnchor ? mnavAnchor.holdings : null;

  // Initialize Fed Liquidity with last known values before allDates[0]
  let lastWalcl = null;
  let lastWtregen = null;
  let lastRrp = null;
  const firstDate = allDates[0] || '2020-08-01';
  for (const [d, v] of fredWalcl) { if (d <= firstDate) lastWalcl = v; }
  for (const [d, v] of fredWtregen) { if (d <= firstDate) lastWtregen = v; }
  for (const [d, v] of fredRrp) { if (d <= firstDate) lastRrp = v; }

  const points = [];
  for (let i = 0; i < allDates.length; i++) {
    const date = allDates[i];
    const timeMs = new Date(date).getTime();

    // Advance merged MSTR events (official purchases + post-snapshot live Coinglass records)
    // 事件只在其自身日期当天及之后生效，避免提前一天引入未公告信息
    while (mstrEventIdx < mergedMstrEvents.length && mergedMstrEvents[mstrEventIdx].timestamp <= timeMs) {
      const ev = mergedMstrEvents[mstrEventIdx];
      lastMstrCost = ev.cost;
      curHoldings = ev.holdings;
      lastMstrCostSource = ev.source;
      lastMstrCostDate = new Date(ev.timestamp).toISOString().slice(0, 10);
      mstrEventIdx++;
    }

    // Advance MSTR stock price pointer to last trading day <= date
    while (stockIdx < stockDates.length && stockDates[stockIdx] <= date) {
      lastMstrPx = mstrStockMap.get(stockDates[stockIdx]);
      stockIdx++;
    }

    let mnavEstimated = false;

    // Check if bitcointreasuries daily time series has exact day data
    if (btDailyMap.has(date)) {
      const d = btDailyMap.get(date);
      curHoldings = d.holdings;
      curMnav = d.mnav;
    } else if (mnavAnchor && date > mnavAnchor.date) {
      // 快照之后：EV = (锚点股数 + 增发股数) × 股价 + 固定债权
      const btcToday = btcMap.get(date);
      if (lastMstrPx && curHoldings > 0 && btcToday > 0) {
        const added = curHoldings - prevEstHoldings;
        if (added > 0) dilutionShares += (added * btcToday) / lastMstrPx;
        prevEstHoldings = curHoldings;
        const evNow = (mnavAnchor.shares + dilutionShares) * lastMstrPx + mnavAnchor.fixedClaims;
        curMnav = Number((evNow / (curHoldings * btcToday)).toFixed(3));
        mnavEstimated = true;
      }
    }

    // 30 日平均净增持速率 (BTC/天)，保留符号：负值即净减持
    const windowDays = Math.min(i, 30);
    const prevHoldings = i >= 30 ? points[i - 30].mstrHoldings : (points[0] ? points[0].mstrHoldings : curHoldings);
    curVelocity = windowDays > 0 ? Number(((curHoldings - prevHoldings) / windowDays).toFixed(1)) : 0;

    if (fred1y.has(date)) last1y = fred1y.get(date);
    if (fred10y.has(date)) last10y = fred10y.get(date);

    if (fredWalcl.has(date)) lastWalcl = fredWalcl.get(date);
    if (fredWtregen.has(date)) lastWtregen = fredWtregen.get(date);
    if (fredRrp.has(date)) lastRrp = fredRrp.get(date);

    const yieldSpread = (last10y !== null && last1y !== null) ? Number((last10y - last1y).toFixed(3)) : null;

    // Net Liquidity = WALCL (M$) - WTREGEN (M$) - RRPONTSYD (B$ * 1000 = M$)
    // Value in Trillions ($T)
    let fedNetLiquidity = null;
    if (lastWalcl !== null && lastWtregen !== null && lastRrp !== null) {
      const netM = lastWalcl - lastWtregen - (lastRrp * 1000);
      fedNetLiquidity = Number((netM / 1000000).toFixed(4));
    }

    points.push({
      date,
      btcPrice: btcMap.get(date) || null,
      mstrCost: lastMstrCost,
      mstrHoldings: curHoldings,
      mstrBuyVelocity30d: curVelocity,
      mnav: curMnav,
      mnavEstimated,
      us1y: last1y,
      us10y: last10y,
      yieldSpread,
      fedWalcl: lastWalcl !== null ? Number((lastWalcl / 1000000).toFixed(3)) : null,
      fedTga: lastWtregen !== null ? Number((lastWtregen / 1000000).toFixed(3)) : null,
      fedRrp: lastRrp !== null ? Number((lastRrp / 1000).toFixed(3)) : null,
      fedNetLiquidity,
      fedNetLiqSma20: null
    });
  }

  // Compute 20D SMA for Net Liquidity: ta.sma(netLiquidity, 20)
  for (let i = 0; i < points.length; i++) {
    if (points[i].fedNetLiquidity === null) continue;
    let sum = 0;
    let count = 0;
    const windowStart = Math.max(0, i - 19);
    for (let j = windowStart; j <= i; j++) {
      if (points[j].fedNetLiquidity !== null) {
        sum += points[j].fedNetLiquidity;
        count++;
      }
    }
    points[i].fedNetLiqSma20 = count > 0 ? Number((sum / count).toFixed(4)) : points[i].fedNetLiquidity;
  }

  // Find peak 30-day velocity
  let peakVel = 0;
  let troughVel = 0;
  for (const p of points) {
    if (p.mstrBuyVelocity30d > peakVel) peakVel = p.mstrBuyVelocity30d;
    if (p.mstrBuyVelocity30d < troughVel) troughVel = p.mstrBuyVelocity30d;
  }
  if (btData && btData.metadata && btData.metadata.peakVelocity30d > peakVel) {
    peakVel = btData.metadata.peakVelocity30d;
  }

  const latest = points[points.length - 1];
  const prevPoint = points.length >= 2 ? points[points.length - 2] : null;
  const point20dAgo = points.length >= 21 ? points[points.length - 21] : null;

  const summary = {
    currentBtc: latest ? latest.btcPrice : null,
    currentMstrCost: latest ? latest.mstrCost : null,
    currentMstrHoldings: latest ? latest.mstrHoldings : (btData?.metadata?.latestHoldings || 845050),
    currentMstrVelocity30d: latest ? latest.mstrBuyVelocity30d : (btData?.metadata?.latestVelocity30d || 153.4),
    peakVelocity30d: peakVel,
    troughVelocity30d: troughVel,
    dailyIssuanceBtc: latest ? dailyIssuanceBtc(latest.date) : 450,
    velocityToIssuance: latest ? Number((latest.mstrBuyVelocity30d / dailyIssuanceBtc(latest.date)).toFixed(2)) : null,
    mstrCostSource: lastMstrCostSource,
    mstrCostAsOf: lastMstrCostDate,
    currentMnav: latest ? latest.mnav : (btData?.metadata?.latestMnav || 1.055),
    mnavEstimated: latest ? !!latest.mnavEstimated : false,
    mnavAnchorDate: mnavAnchor ? mnavAnchor.date : null,
    mnavBasis: mnavAnchor ? mnavAnchor.basis : null,
    minMnav: btData?.metadata?.minMnav || 0.929,
    maxMnav: btData?.metadata?.maxMnav || 8.006,
    mstrPurchasesCount: btPurchases.length || effectiveMstrList.length,
    current1y: latest ? latest.us1y : null,
    current10y: latest ? latest.us10y : null,
    currentSpread: latest ? latest.yieldSpread : null,
    isCurveInverted: latest ? (latest.yieldSpread !== null && latest.yieldSpread < 0) : false,
    mstrProfitMultiplier: (latest && latest.btcPrice && latest.mstrCost) ? Number((latest.btcPrice / latest.mstrCost).toFixed(2)) : null,
    currentFedNetLiquidity: latest ? latest.fedNetLiquidity : null,
    currentFedNetLiqSma20: latest ? latest.fedNetLiqSma20 : null,
    currentFedWalcl: latest ? latest.fedWalcl : null,
    currentFedTga: latest ? latest.fedTga : null,
    currentFedRrp: latest ? latest.fedRrp : null,
    fedNetLiqDailyChange: (latest && prevPoint && latest.fedNetLiquidity !== null && prevPoint.fedNetLiquidity !== null)
      ? Number((latest.fedNetLiquidity - prevPoint.fedNetLiquidity).toFixed(4))
      : 0,
    fedNetLiqChange20d: (latest && point20dAgo && latest.fedNetLiquidity !== null && point20dAgo.fedNetLiquidity !== null)
      ? Number((latest.fedNetLiquidity - point20dAgo.fedNetLiquidity).toFixed(4))
      : null,
    totalPoints: points.length,
    dateRange: {
      start: points[0] ? points[0].date : null,
      end: latest ? latest.date : null
    },
    updatedAt: new Date().toISOString()
  };

  const payload = {
    points,
    summary,
    rawMstr: effectiveMstrList
  };

  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(payload, null, 2), 'utf8');
    console.log('[MacroFetcher] Persisted ' + points.length + ' points to ' + CACHE_FILE);
  } catch (err) {
    console.error('[MacroFetcher] Failed to save cache:', err.message);
  }

  inMemoryCache = payload;
  lastFetchTime = Date.now();
  return payload;
}

/**
 * Get Macro Chart Data with memory & file caching
 */
async function getMacroChartData(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && inMemoryCache && (now - lastFetchTime < CACHE_TTL_MS)) {
    return inMemoryCache;
  }

  if (!forceRefresh && !inMemoryCache && fs.existsSync(CACHE_FILE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (cached && cached.points && cached.points.length > 0) {
        inMemoryCache = cached;
        lastFetchTime = now;
        fetchAndBuildMacroData().catch(e => console.error('[MacroFetcher] Background refresh failed:', e.message));
        return inMemoryCache;
      }
    } catch (e) {
      console.warn('[MacroFetcher] Cache file invalid, refetching...');
    }
  }

  try {
    return await fetchAndBuildMacroData();
  } catch (err) {
    const fallback = inMemoryCache || readMacroCacheFile();
    if (!fallback) throw err;
    console.warn('[MacroFetcher] Live rebuild failed, serving last cached dataset:', err.message);
    inMemoryCache = fallback;
    return fallback;
  }
}

function readMacroCacheFile() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return cached && Array.isArray(cached.points) && cached.points.length > 0 ? cached : null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  getMacroChartData,
  fetchAndBuildMacroData,
  fetchFredSeries
};
