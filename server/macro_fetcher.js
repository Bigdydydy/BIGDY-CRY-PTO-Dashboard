const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');
const { fetchWithTimeout, fetchBinanceSpot } = require('./http_client');
const { recordAttempt, recordSuccess, recordFailure } = require('./data_health');
const { withDataHealth, seedCachedHealth, atomicWriteJson } = require('./data_health_cache');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'macro_chart.json');

// Required legs of the `macro` aggregate. mstr_cost / mstr_treasury are
// ancillary — supplementary reference legs that never gate the aggregate.
const MACRO_REQUIRED = [
  'macro', 'fred:DGS1', 'fred:DGS10', 'fred:WALCL', 'fred:WTREGEN', 'fred:RRPONTSYD',
  'macro_btc', 'yahoo:MSTR'
];
const MACRO_ANCILLARY = ['mstr_cost', 'mstr_treasury'];
const MAX_FUTURE_MS = 5 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Round-trip the ISO day: Date.parse accepts nonexistent dates like Feb 30
// by rolling them over — reject those.
const validDateStr = d => typeof d === 'string' && DATE_RE.test(d) && !isNaN(Date.parse(d))
  && new Date(d).toISOString().slice(0, 10) === d;
const STRICT_NUM_RE = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
const isPosNum = v => v !== null && v !== undefined && typeof v !== 'boolean' &&
  !(typeof v === 'string' && v.trim() === '') && Number.isFinite(Number(v)) && Number(v) > 0;
const BT_STRATEGY_FILE = path.join(__dirname, '..', 'data', 'bitcointreasuries_strategy.json');
const MSTR_CAPITAL_FILE = path.join(__dirname, '..', 'data', 'mstr_capital_structure.json');
let inMemoryCache = null;

// 区块补贴：2024-04-20 第四次减半后 3.125 BTC × 144 块 ≈ 450 BTC/天
function dailyIssuanceBtc(dateStr) {
  return dateStr >= '2024-04-20' ? 450 : 900;
}

const CURVE_NOISE_BP = 3;
const CURVE_WINDOWS = Object.freeze([
  ['7d', 7, '1W'],
  ['20d', 20, '20D'],
  ['3m', 90, '3M'],
  ['6m', 180, '6M'],
  ['1y', 365, '1Y'],
  ['3y', 1095, '3Y'],
  ['all', null, 'ALL']
]);

/**
 * Classify 10Y-1Y yield curve movement over a window from bp changes in 1Y and 10Y.
 * Handles bull/bear steepeners & flatteners, twist steepeners/flatteners (opposite
 * moves >= 3bp each), and flat noise (< 3bp on both legs).
 */
function classifyYieldCurveRegime(chg1yBp, chg10yBp) {
  if (!Number.isFinite(chg1yBp) || !Number.isFinite(chg10yBp)) return null;
  const c1 = Number(chg1yBp.toFixed(1));
  const c10 = Number(chg10yBp.toFixed(1));
  const chgSpreadBp = Number((c10 - c1).toFixed(1));

  if ((Math.abs(c1) < CURVE_NOISE_BP && Math.abs(c10) < CURVE_NOISE_BP) ||
      (Math.abs(chgSpreadBp) < 2 && Math.abs(c1) < 4 && Math.abs(c10) < 4)) {
    return {
      code: 'flat',
      label: '窄幅钝化',
      shortLabel: '钝化',
      tone: 'neutral',
      driver: '短长端变动不足3bp · 曲线横盘',
      chg1yBp: c1,
      chg10yBp: c10,
      chgSpreadBp
    };
  }

  const steepening = chgSpreadBp > 0;
  if (Math.abs(c1) >= CURVE_NOISE_BP && Math.abs(c10) >= CURVE_NOISE_BP && Math.sign(c1) !== Math.sign(c10)) {
    return steepening
      ? {
          code: 'twist_steepener',
          label: '扭曲走陡',
          shortLabel: '扭陡',
          tone: 'warn',
          driver: '短跌长涨 · 降息预期叠加长端期限溢价上行',
          chg1yBp: c1,
          chg10yBp: c10,
          chgSpreadBp
        }
      : {
          code: 'twist_flattener',
          label: '扭曲走平',
          shortLabel: '扭平',
          tone: 'negative',
          driver: '短涨长跌 · 短端偏鹰收紧叠加长端避险买盘',
          chg1yBp: c1,
          chg10yBp: c10,
          chgSpreadBp
        };
  }

  const avg = (c1 + c10) / 2;
  if (avg < 0 && steepening) {
    return {
      code: 'bull_steepener',
      label: '牛陡',
      shortLabel: '牛陡',
      tone: 'positive',
      driver: '短端领跌 · 降息宽松定价驱动修复',
      chg1yBp: c1,
      chg10yBp: c10,
      chgSpreadBp
    };
  }
  if (avg >= 0 && steepening) {
    return {
      code: 'bear_steepener',
      label: '熊陡',
      shortLabel: '熊陡',
      tone: 'negative',
      driver: '长端领涨 · 期限溢价/财政供给施压久期',
      chg1yBp: c1,
      chg10yBp: c10,
      chgSpreadBp
    };
  }
  if (avg < 0 && !steepening) {
    return {
      code: 'bull_flattener',
      label: '牛平',
      shortLabel: '牛平',
      tone: 'warn',
      driver: '长端领跌 · 增长放缓担忧或久期避险',
      chg1yBp: c1,
      chg10yBp: c10,
      chgSpreadBp
    };
  }
  return {
    code: 'bear_flattener',
    label: '熊平',
    shortLabel: '熊平',
    tone: 'negative',
    driver: '短端领涨 · 联储鹰派定价收紧流动性',
    chg1yBp: c1,
    chg10yBp: c10,
    chgSpreadBp
  };
}

/**
 * Compute yield-curve regime across multiple lookback windows on aligned daily points.
 */
function summarizeYieldCurve(points) {
  const valid = (points || []).filter(p =>
    p && Number.isFinite(p.us1y) && Number.isFinite(p.us10y)
  );
  if (valid.length < 2) return {};
  const cur = valid[valid.length - 1];
  const out = {};
  for (const [key, days, windowLabel] of CURVE_WINDOWS) {
    const idx = days == null ? 0 : Math.max(0, valid.length - 1 - days);
    const base = valid[idx];
    if (!base || base.date === cur.date) continue;
    const chg1yBp = (cur.us1y - base.us1y) * 100;
    const chg10yBp = (cur.us10y - base.us10y) * 100;
    const reg = classifyYieldCurveRegime(chg1yBp, chg10yBp);
    if (reg) {
      out[key] = {
        ...reg,
        windowKey: key,
        windowLabel,
        fromDate: base.date,
        toDate: cur.date,
        from1y: base.us1y,
        from10y: base.us10y,
        fromSpread: Number((base.us10y - base.us1y).toFixed(3))
      };
    }
  }
  return out;
}

function enrichMacroSummaryCurve(payload) {
  if (!payload || !payload.summary || !Array.isArray(payload.points)) return payload;
  if (!payload.summary.curveRegimes) {
    const curveRegimes = summarizeYieldCurve(payload.points);
    payload.summary.curveRegimes = curveRegimes;
    payload.summary.curveRegime20d = curveRegimes['20d'] || null;
    payload.summary.curveRegime7d = curveRegimes['7d'] || null;
  }
  return payload;
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
    if (!Array.isArray(parsed)) throw new Error('Coinglass MSTR cost: non-array payload');
    // Verified-event source: receipt time is the clock, never the last
    // purchase date (purchases do not update daily).
    recordSuccess('mstr_cost', {
      dataAsOf: new Date().toISOString(), asOfKind: 'received', source: 'coinglass/microStrategyCostV2'
    });
    return parsed;
  } catch (err) {
    console.error('[MacroFetcher] Error fetching Coinglass MSTR cost:', err.message);
    recordFailure('mstr_cost', err);
    return [];
  }
}

/**
 * 该站响应头约 18KB，超过 Node fetch (undici) 默认的 16KB 上限会报 UND_ERR_HEADERS_OVERFLOW，
 * 所以这里用 https 模块并放宽 maxHeaderSize。
 */
function fetchTextLargeHeaders(url, { timeout = 15000, redirects = 2 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      maxHeaderSize: 128 * 1024,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(fetchTextLargeHeaders(new URL(res.headers.location, url).toString(), { timeout, redirects: redirects - 1 }));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      res.setEncoding('utf8');
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    });
    req.setTimeout(timeout, () => req.destroy(new Error('timeout ' + timeout + 'ms')));
    req.on('error', reject);
  });
}

/**
 * bitcointreasuries.net 实时快照：最新持仓、成本、企业价值与市值。
 * 页面是内嵌的 SvelteKit 数据，只给当前值（不再有逐条 holdings_news）。
 */
async function fetchLiveBtSnapshot() {
  recordAttempt('mstr_treasury', { now: Date.now() });
  try {
    const text = await fetchTextLargeHeaders('https://bitcointreasuries.net/public-companies/strategy');
    const btM = text.match(/\["BTC",\{asset:\{symbol:"BTC"[^}]*\},balance:(\d+),date:"(\d{4}-\d{2}-\d{2})",cost_basis:\{value:app\.decode\('BigDecimal', "([\d.]+)"\)/);
    if (!btM) throw new Error('holdings block not found (page format changed?)');
    const num = (re) => { const m = text.match(re); return m ? parseFloat(m[1]) : null; };
    const balance = parseInt(btM[1], 10);
    const costBasis = parseFloat(btM[3]);
    if (!(balance > 0) || !(costBasis > 0)) {
      throw new Error(`implausible treasury values balance=${btM[1]} costBasis=${btM[3]}`);
    }
    // Event source: unchanged holdings still confirm liveness — receipt time.
    recordSuccess('mstr_treasury', {
      dataAsOf: new Date().toISOString(), asOfKind: 'received', source: 'bitcointreasuries.net'
    });
    return {
      date: btM[2],
      timestamp: new Date(btM[2] + 'T00:00:00Z').getTime(),
      balance,
      costBasis,
      avgCost: balance > 0 ? Number((costBasis / balance).toFixed(2)) : null,
      enterpriseValue: num(/enterprise_value:\{native:([\d.]+)/),
      marketCap: num(/market_cap_basic:\{native:([\d.]+)/),
      stockPrice: num(/stock_price:\{native:([\d.]+)/)
    };
  } catch (err) {
    console.warn('[MacroFetcher] Live bitcointreasuries fetch failed:', err.message);
    recordFailure('mstr_treasury', err);
    return null;
  }
}


/**
 * Fetch Treasury yield series from FRED CSV
 */
async function fetchFredSeries(id) {
  const hid = `fred:${id}`;
  recordAttempt(hid, { now: Date.now() });
  try {
    const resp = await fetchWithTimeout('https://fred.stlouisfed.org/graph/fredgraph.csv?id=' + id, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    if (!resp.ok) throw new Error('FRED HTTP ' + resp.status);
    const text = await resp.text();
    const lines = text.trim().split('\n');
    // Verify the CSV shape: a DATE/observation_date column + the series id column.
    const headerCols = (lines[0] || '').toLowerCase().split(',').map(s => s.trim());
    const dateCol = headerCols.findIndex(c => c === 'date' || c === 'observation_date');
    const valCol = headerCols.findIndex(c => c === id.toLowerCase());
    if (dateCol < 0 || valCol < 0) {
      throw new Error(`FRED ${id}: unexpected CSV header "${lines[0]}"`);
    }
    const map = new Map();
    let lastDate = '';
    const nowMs = Date.now();
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length <= Math.max(dateCol, valCol)) continue;
      const date = parts[dateCol].trim();
      const valStr = parts[valCol].trim();
      if (valStr === '.' || valStr === '') continue; // publication gap — skippable
      if (!validDateStr(date)) throw new Error(`FRED ${id}: invalid date "${date}"`);
      if (Date.parse(date) > nowMs + MAX_FUTURE_MS) throw new Error(`FRED ${id}: future date ${date}`);
      if (date <= lastDate) throw new Error(`FRED ${id}: non-ascending dates`);
      lastDate = date;
      // Non-numeric garbage must not be parseFloat-swallowed.
      if (!STRICT_NUM_RE.test(valStr)) throw new Error(`FRED ${id}: non-numeric value "${valStr}"`);
      map.set(date, parseFloat(valStr));
    }
    if (!map.size) throw new Error(`FRED ${id}: no data rows parsed`);
    // dataAsOf = latest REAL observation date (never a forward-filled point).
    recordSuccess(hid, { dataAsOf: lastDate, asOfKind: 'source', source: 'fred.stlouisfed.org' });
    return map;
  } catch (err) {
    console.error('[MacroFetcher] Error fetching FRED ' + id + ':', err.message);
    recordFailure(hid, err);
    return new Map();
  }
}

/**
 * Fetch daily BTC close price history from Binance
 */
async function fetchBtcDailyPrices(startDateStr = '2020-08-01') {
  recordAttempt('macro_btc', { now: Date.now() });
  try {
    let start = new Date(startDateStr).getTime();
    const now = Date.now();
    const allKlines = [];
    let truncated = false;
    while (start < now) {
      const resp = await fetchBinanceSpot('/api/v3/klines?symbol=BTCUSDT&interval=1d&startTime=' + start + '&limit=1000');
      if (!resp.ok) { truncated = true; break; }
      const data = await resp.json();
      if (!Array.isArray(data) || data.length === 0) break;
      allKlines.push(...data);
      const lastTime = data[data.length - 1][0];
      if (lastTime <= start) { truncated = true; break; } // no forward progress
      start = lastTime + 86400000;
    }
    if (truncated) throw new Error('BTC klines pagination truncated before latest data');
    const map = new Map();
    // A malformed or future row must fail the whole fetch, not be skipped
    // into a "successful" but corrupt history.
    let prevDay = '';
    for (const k of allKlines) {
      if (!Array.isArray(k) || k.length < 5 || !Number.isFinite(Number(k[0])) || !isPosNum(k[4])) {
        throw new Error('BTC kline row malformed: ' + JSON.stringify(k && k.slice ? k.slice(0, 6) : k));
      }
      const ms = Number(k[0]);
      if (ms > now + MAX_FUTURE_MS) throw new Error('BTC kline future row: ' + new Date(ms).toISOString());
      const dateStr = new Date(ms).toISOString().slice(0, 10);
      if (dateStr <= prevDay) throw new Error('BTC klines not strictly ascending');
      prevDay = dateStr;
      map.set(dateStr, Number(k[4]));
    }
    if (!map.size) throw new Error('BTC daily price feed returned no usable rows');
    const maxDate = Array.from(map.keys()).sort().pop();
    recordSuccess('macro_btc', { dataAsOf: maxDate, asOfKind: 'source', source: 'binance/BTCUSDT-1d' });
    return map;
  } catch (err) {
    console.error('[MacroFetcher] Error fetching Binance BTC prices:', err.message);
    recordFailure('macro_btc', err);
    return new Map();
  }
}

/**
 * Fetch daily MSTR stock close history from Yahoo Finance (for post-snapshot mNAV estimation)
 */
async function fetchMstrStockPrices() {
  recordAttempt('yahoo:MSTR', { now: Date.now() });
  try {
    const resp = await fetchWithTimeout('https://query1.finance.yahoo.com/v8/finance/chart/MSTR?range=5y&interval=1d', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' }
    });
    if (!resp.ok) throw new Error('Yahoo HTTP ' + resp.status);
    const json = await resp.json();
    const res = json.chart?.result?.[0];
    const ts = res?.timestamp;
    const quote = res?.indicators?.quote?.[0];
    const closes = quote?.close;
    if (!Array.isArray(ts) || !Array.isArray(closes) || ts.length !== closes.length || !ts.length) {
      throw new Error('Yahoo MSTR: timestamp/close arrays missing or length mismatch');
    }
    // Other OHLC legs must be finite-positive whenever present; volume must
    // be finite >= 0. Present arrays must align with timestamps.
    for (const leg of ['open', 'high', 'low', 'volume']) {
      const arr = quote[leg];
      if (!Array.isArray(arr)) continue;
      if (arr.length !== ts.length) throw new Error(`Yahoo MSTR: ${leg} length mismatch`);
      for (const v of arr) {
        if (v === null || v === undefined) continue; // non-trading day
        if (leg === 'volume'
          ? !(Number.isFinite(v) && v >= 0)
          : !isPosNum(v)) throw new Error(`Yahoo MSTR: invalid ${leg} value ${v}`);
      }
    }
    const map = new Map();
    const nowMs = Date.now();
    let prevDay = '';
    for (let i = 0; i < ts.length; i++) {
      if (!Number.isFinite(ts[i])) throw new Error('Yahoo MSTR: non-finite timestamp');
      if (ts[i] * 1000 > nowMs + MAX_FUTURE_MS) throw new Error('Yahoo MSTR: future timestamp');
      const c = closes[i];
      if (c === null || c === undefined) continue; // non-trading day
      const day = new Date(ts[i] * 1000).toISOString().slice(0, 10);
      if (day <= prevDay) throw new Error('Yahoo MSTR: timestamps not strictly ascending');
      prevDay = day;
      if (!isPosNum(c)) throw new Error(`Yahoo MSTR: invalid close ${c}`);
      map.set(day, c);
    }
    if (!map.size) throw new Error('Yahoo MSTR: no usable close rows');
    const maxDate = Array.from(map.keys()).sort().pop();
    recordSuccess('yahoo:MSTR', { dataAsOf: maxDate, asOfKind: 'source', source: 'yahoo.finance/MSTR' });
    return map;
  } catch (err) {
    console.error('[MacroFetcher] Error fetching Yahoo MSTR stock prices:', err.message);
    recordFailure('yahoo:MSTR', err);
    return new Map();
  }
}

/**
 * Fetch and build fully aligned macro dataset
 */
async function fetchAndBuildMacroData() {
  console.log('[MacroFetcher] Starting data fetch for Macro Chart...');
  const [mstrList, liveBt, fred1yRaw, fred10yRaw, fredWalclRaw, fredWtregenRaw, fredRrpRaw, btcMap, mstrStockMap] = await Promise.all([
    fetchMstrCost(),
    fetchLiveBtSnapshot(),
    fetchFredSeries('DGS1'),
    fetchFredSeries('DGS10'),
    fetchFredSeries('WALCL'),
    fetchFredSeries('WTREGEN'),
    fetchFredSeries('RRPONTSYD'),
    fetchBtcDailyPrices('2020-08-01'),
    fetchMstrStockPrices()
  ]);

  // 单个数据源失败时沿用上一版数据集的同一序列，避免把空值写进缓存；并记录各源状态供前端提示
  const previous = inMemoryCache || readMacroCacheFile();
  const prevPoints = previous && Array.isArray(previous.points) ? previous.points : [];
  const sources = {};
  const withFallback = (name, fresh, field, scale) => {
    if (fresh.size > 0) { sources[name] = 'ok'; return fresh; }
    const restored = new Map();
    for (const p of prevPoints) {
      if (p[field] !== null && p[field] !== undefined) restored.set(p.date, p[field] * scale);
    }
    sources[name] = restored.size > 0 ? 'fallback' : 'failed';
    return restored;
  };
  const fred1y = withFallback('FRED DGS1', fred1yRaw, 'us1y', 1);
  const fred10y = withFallback('FRED DGS10', fred10yRaw, 'us10y', 1);
  const fredWalcl = withFallback('FRED WALCL', fredWalclRaw, 'fedWalcl', 1e6);
  const fredWtregen = withFallback('FRED WTREGEN', fredWtregenRaw, 'fedTga', 1e6);
  const fredRrp = withFallback('FRED RRP', fredRrpRaw, 'fedRrp', 1000);
  sources['Binance BTC'] = btcMap.size > 0 ? 'ok' : 'failed';
  sources['Yahoo MSTR'] = mstrStockMap.size > 0 ? 'ok' : (prevPoints.length ? 'fallback' : 'failed');
  sources['bitcointreasuries'] = liveBt ? 'ok' : 'failed';
  sources['Coinglass'] = mstrList.length > 0 ? 'ok' : (previous?.rawMstr?.length ? 'fallback' : 'failed');
  const prevMnavByDate = new Map(prevPoints.map(p => [p.date, p]));

  console.log('[MacroFetcher] Raw data: MSTR=' + mstrList.length + ' purchases, Live BT=' + (liveBt ? liveBt.balance + '@' + liveBt.date : 'n/a') + ', FRED 1Y=' + fred1y.size + ', FRED 10Y=' + fred10y.size + ', WALCL=' + fredWalcl.size + ', WTREGEN=' + fredWtregen.size + ', RRP=' + fredRrp.size + ', BTC=' + btcMap.size + ' days, MSTR stock=' + mstrStockMap.size + ' days');

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
  if (effectiveMstrList.length === 0 && previous && Array.isArray(previous.rawMstr)) {
    effectiveMstrList = [...previous.rawMstr];
    console.log('[MacroFetcher] Loaded ' + effectiveMstrList.length + ' MSTR records from cache fallback');
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

  // bitcointreasuries 的成本基数按 $0.1B 取整，精度不如 Coinglass，只在 Coinglass 尚未覆盖该日期时补位
  const coinglassCovers = (ts) => effectiveMstrList.some(m => m.timestamp >= ts - 86400000);
  const postSnapshotBtEvents = (liveBt && liveBt.timestamp > lastOfficialPurchaseTs && liveBt.balance > 0 && liveBt.avgCost && !coinglassCovers(liveBt.timestamp))
    ? [{ timestamp: liveBt.timestamp, cost: liveBt.avgCost, holdings: liveBt.balance, source: 'bitcointreasuries' }]
    : [];

  const mergedMstrEvents = [
    ...btPurchases.map(p => ({ timestamp: p.timestamp, cost: p.avgCostUSD, holdings: p.balance, source: 'sec' })),
    ...postSnapshotBtEvents,
    ...effectiveMstrList
      .filter(m => m.timestamp > lastOfficialPurchaseTs)
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
      // 固定债权优先取手动配置；否则用 bitcointreasuries 实时的 EV − 股权市值
      const capital = loadMstrCapitalStructure();
      const liveClaims = (liveBt && liveBt.enterpriseValue && liveBt.marketCap) ? liveBt.enterpriseValue - liveBt.marketCap : null;
      const fixedClaims = capital ? capital.netFixedClaimsUSD : (liveClaims !== null ? liveClaims : 0);
      const ev = anchorDaily.mnav * anchorDaily.holdings * anchorBtc;
      const equity = ev - fixedClaims;
      if (equity > 0) {
        mnavAnchor = {
          date: anchorDaily.date,
          holdings: anchorDaily.holdings,
          fixedClaims,
          shares: equity / anchorPx,
          basis: (capital || liveClaims !== null) ? 'ev' : 'equity'
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
    } else if (!mnavAnchor && prevMnavByDate.get(date)?.mnavEstimated) {
      // Yahoo 不可用导致无法建立锚点：沿用上一版数据集当天的估算
      curMnav = prevMnavByDate.get(date).mnav;
      mnavEstimated = true;
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
  const curveRegimes = summarizeYieldCurve(points);

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
    curveRegime20d: curveRegimes['20d'] || null,
    curveRegime7d: curveRegimes['7d'] || null,
    curveRegimes,
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
    sources,
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

  // Aggregate health: dataset date is the latest real BTC close (allDates came
  // solely from the fresh BTC map); degraded legs surface as issues and via the
  // per-source health above — fallback-restored legs never advance any clock.
  const degraded = Object.entries(sources).filter(([, s]) => s !== 'ok').map(([k, s]) => `${k}:${s}`);
  recordSuccess('macro', {
    dataAsOf: allDates[allDates.length - 1],
    asOfKind: 'source', source: 'macro/build',
    issues: degraded
  });

  const bound = withDataHealth(payload, MACRO_REQUIRED, MACRO_ANCILLARY);
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    atomicWriteJson(CACHE_FILE, bound, 2);
    console.log('[MacroFetcher] Persisted ' + points.length + ' points to ' + CACHE_FILE);
  } catch (err) {
    console.error('[MacroFetcher] Failed to save cache:', err.message);
  }

  inMemoryCache = bound;
  lastFetchTime = Date.now();
  return bound;
}

const FAILURE_RETRY_MS = 2 * 60 * 1000;
const REMOTE_SNAPSHOT_URL = process.env.MACRO_SNAPSHOT_URL
  || 'https://raw.githubusercontent.com/Bigdydydy/BIGDY-CRY-PTO-Dashboard/main/data/macro_chart.json';
let rebuildInflight = null;

/** 单飞：并发请求共用同一次重建；失败后 2 分钟内不再重试，避免每次轮询都打满外部接口 */
function rebuildOnce() {
  if (!rebuildInflight) {
    recordAttempt('macro', { now: Date.now() });
    rebuildInflight = fetchAndBuildMacroData()
      .catch((err) => {
        recordFailure('macro', err);
        lastFetchTime = Date.now() - CACHE_TTL_MS + FAILURE_RETRY_MS;
        throw err;
      })
      .finally(() => { rebuildInflight = null; });
  }
  return rebuildInflight;
}

/**
 * 冷启动：Render 免费实例磁盘随部署重置，本地文件只是提交时的版本。
 * 与 GitHub 上由定时任务刷新的快照比较，取较新的一份。
 */
/** Snapshot schema: real points + summary provenance (never filled dates). */
function validMacroSnapshot(json) {
  if (!json || typeof json !== 'object') return false;
  if (!Array.isArray(json.points) || !json.points.length) return false;
  if (!json.summary || typeof json.summary !== 'object') return false;
  return json.points.every(p =>
    p && validDateStr(p.date) &&
    (p.btcPrice === null || isPosNum(p.btcPrice)) &&
    (p.us10y === null || p.us10y === undefined || Number.isFinite(Number(p.us10y)))
  );
}

/** Seed snapshot clocks once — persisted dataHealth wins for EVERY required
 * and ancillary source; legacy snapshots seed only aggregate hints and keep
 * the individual leaves UNKNOWN rather than borrowing now. */
let snapshotSeeded = false;
function seedSnapshotOnce(snapshot) {
  if (snapshotSeeded || !snapshot) return;
  snapshotSeeded = true;
  for (const id of [...MACRO_REQUIRED, ...MACRO_ANCILLARY]) {
    seedCachedHealth(snapshot, id, id === 'macro'
      ? {
          dataAsOf: snapshot.summary?.dateRange?.end || null,
          lastSuccessAt: snapshot.summary?.updatedAt || null
        }
      : {});
  }
}

async function loadFreshestSnapshot() {
  const local = readMacroCacheFile();
  let remote = null;
  try {
    const resp = await fetchWithTimeout(REMOTE_SNAPSHOT_URL, { timeout: 10000, retries: 0 });
    if (resp.ok) {
      const json = await resp.json();
      if (validMacroSnapshot(json)) remote = json;
    }
  } catch (err) {
    console.warn('[MacroFetcher] Remote snapshot unavailable:', err.message);
  }
  const ts = d => (d && d.summary && d.summary.updatedAt) ? Date.parse(d.summary.updatedAt) : 0;
  return ts(remote) > ts(local) ? remote : local;
}

/**
 * Get Macro Chart Data: 内存缓存过期时先返回旧数据并在后台重建 (stale-while-revalidate)
 */
async function getMacroChartData(forceRefresh = false) {
  if (!inMemoryCache) {
    const snapshot = await loadFreshestSnapshot();
    if (snapshot) {
      inMemoryCache = enrichMacroSummaryCurve(snapshot);
      seedSnapshotOnce(snapshot);
      const age = Date.now() - (Date.parse(snapshot.summary?.updatedAt) || 0);
      lastFetchTime = Date.now() - Math.min(age, CACHE_TTL_MS);
    }
  }

  if (forceRefresh || !inMemoryCache) {
    try {
      return await rebuildOnce();
    } catch (err) {
      if (!inMemoryCache) throw err;
      console.warn('[MacroFetcher] Live rebuild failed, serving last dataset:', err.message);
      return withDataHealth(enrichMacroSummaryCurve(inMemoryCache), MACRO_REQUIRED, MACRO_ANCILLARY);
    }
  }

  if (Date.now() - lastFetchTime >= CACHE_TTL_MS) {
    rebuildOnce().catch(e => console.error('[MacroFetcher] Background refresh failed:', e.message));
  }
  return withDataHealth(enrichMacroSummaryCurve(inMemoryCache), MACRO_REQUIRED, MACRO_ANCILLARY);
}

function readMacroCacheFile() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return validMacroSnapshot(cached) ? cached : null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  getMacroChartData,
  fetchAndBuildMacroData,
  fetchFredSeries,
  classifyYieldCurveRegime,
  summarizeYieldCurve
};
