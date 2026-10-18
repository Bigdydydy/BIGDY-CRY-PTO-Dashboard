/**
 * BTC 主导力量指标 (Flow Force): 推动当前行情的力量来自 期货/现货、亚太/欧美 中的哪一方
 *
 * 2×2 场所矩阵 (每格一个"压力"值):
 *   期货/亚太  币安 BTCUSDT 永续 + OKX BTC-USDT-SWAP
 *   期货/欧美  Hyperliquid BTC 永续
 *   现货/亚太  币安 BTCUSDT 现货 + OKX BTC-USDT 现货 (按盘口深度加权，币安约占 2/3)
 *   现货/欧美  Coinbase BTC-USD (被墙/限流时退到 Kraken XBT/USD)
 *
 * 每个场所每根K线:
 *   1. 主动买卖量用 BVC (Bulk Volume Classification, Easley-López de Prado-O'Hara 2012) 估计:
 *      净主动量 = V·(2Φ(r/σ) − 1)，r 为对数收益，σ 为前 n 根收益的标准差。
 *      Coinbase / Hyperliquid 的K线没有 taker 拆分，全部场所统一用 BVC 才可比。
 *   2. 除以该场所自身前 n 根的平均成交额 → 相对压力 P。持续刷量会同时抬高分子分母的基线，
 *      只有超出自身常态的放量才计入信号；跨场所不比绝对成交额 (永续天然是现货的数倍)。
 *   3. 同格多场所按盘口 ±10bps 深度加权 (深度需要真金白银挂单，比成交额难刷)，深度缺失时按成交额加权。
 * 合成:
 *   F = 期货两格均值, S = 现货两格均值 → 柱 H = |F| − |S| (>0 期货主导, <0 现货主导)
 *   A = 亚太两格均值, U = 欧美两格均值 → 点 R = |A| − |U| (>0 亚太主导, <0 欧美主导)
 * 另附两条不受刷量影响的价格信号做交叉验证: Coinbase 溢价 (欧美现货 vs 币安现货) 与 永续基差。
 */

const { fetchWithTimeout, fetchBinanceSpot } = require('./http_client');

const TF_MS = { '15m': 9e5, '1h': 3.6e6, '4h': 1.44e7, '1d': 8.64e7, '1w': 6.048e8 };
const TF_TTL_MS = { '15m': 60e3, '1h': 120e3, '4h': 300e3, '1d': 600e3, '1w': 900e3 };
const LOOKBACK = 50;        // σ 与成交额基线窗口
const FETCH_BARS = 300;     // 拉取根数 (含 LOOKBACK 预热)
const DAY_MS = 8.64e7;
const MONDAY_OFFSET_MS = 4 * DAY_MS; // 1970-01-01 是周四，+4 天对齐到周一 (币安 / OKX 周线口径)
const AUDIT_TTL_MS = 10 * 60e3;
const DEPTH_BAND = 0.001;   // ±10bps

const VENUES = {
  bnPerp:  { name: '币安 USDT 永续', type: 'futures', region: 'asia' },
  okxPerp: { name: 'OKX USDT 永续', type: 'futures', region: 'asia' },
  hlPerp:  { name: 'Hyperliquid 永续', type: 'futures', region: 'west' },
  bnSpot:  { name: '币安现货 BTCUSDT', type: 'spot', region: 'asia' },
  okxSpot: { name: 'OKX 现货 BTC-USDT', type: 'spot', region: 'asia' },
  usSpot:  { name: 'Coinbase BTC-USD', type: 'spot', region: 'west' }
};
const CELLS = {
  futAsia: ['bnPerp', 'okxPerp'],
  futWest: ['hlPerp'],
  spotAsia: ['bnSpot', 'okxSpot'],
  spotWest: ['usSpot']
};

async function getJson(url, options = {}) {
  const res = await fetchWithTimeout(url, { timeout: 10000, retries: 1, ...options });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const hlPost = body => getJson('https://api.hyperliquid.xyz/info', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

/** 统一K线格式: { t: 开盘毫秒, o, h, l, c, v: 美元成交额 } 升序 */
const typical = (h, l, c) => (h + l + c) / 3;

/** 把小周期K线合并为大周期 (offset 控制对齐点)；首个桶可能缺子K线，丢弃 */
function aggregateBars(bars, periodMs, offsetMs = 0) {
  const out = [];
  let cur = null;
  for (const b of bars) {
    const key = Math.floor((b.t - offsetMs) / periodMs) * periodMs + offsetMs;
    if (!cur || cur.t !== key) {
      if (cur) out.push(cur);
      cur = { t: key, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
    }
  }
  if (cur) out.push(cur);
  return out.slice(1);
}

const BN_INTERVAL = { '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d', '1w': '1w' };
const binanceRows = rows => rows.map(r => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[7] }));

async function fetchBnPerp(tf) {
  const rows = await getJson(`https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=${BN_INTERVAL[tf]}&limit=${FETCH_BARS}`);
  return binanceRows(rows);
}

async function fetchBnSpot(tf) {
  const res = await fetchBinanceSpot(`/api/v3/klines?symbol=BTCUSDT&interval=${BN_INTERVAL[tf]}&limit=${FETCH_BARS}`, { timeout: 10000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return binanceRows(await res.json());
}

const OKX_BAR = { '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1Dutc', '1w': '1Wutc' };
async function fetchOkx(instId, tf) {
  const json = await getJson(`https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${OKX_BAR[tf]}&limit=${FETCH_BARS}`);
  if (json.code !== '0' || !Array.isArray(json.data)) throw new Error(`code ${json.code}`);
  // [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]，volCcyQuote 为 USDT 计价成交额
  return json.data.map(r => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[7] })).reverse();
}

// Hyperliquid 周线按 epoch(周四) 对齐，需由日线自行合成周一对齐的周线
async function fetchHlPerp(tf) {
  const base = tf === '1w' ? '1d' : tf;
  const span = tf === '1w' ? (FETCH_BARS + 1) * TF_MS['1w'] : FETCH_BARS * TF_MS[tf];
  const endTime = Date.now();
  const rows = await hlPost({ type: 'candleSnapshot', req: { coin: 'BTC', interval: base, startTime: endTime - span, endTime } });
  if (!Array.isArray(rows)) throw new Error('非数组响应');
  const bars = rows.map(r => {
    const h = +r.h, l = +r.l, c = +r.c;
    return { t: +r.t, o: +r.o, h, l, c, v: +r.v * typical(h, l, c) };
  });
  return tf === '1w' ? aggregateBars(bars, TF_MS['1w'], MONDAY_OFFSET_MS) : bars;
}

// Coinbase 没有 4h / 1w 粒度：由 1h / 1d 合成；单次最多 300 根，向前分页
const CB_PLAN = { '15m': [900, 1], '1h': [3600, 1], '4h': [3600, 4], '1d': [86400, 1], '1w': [86400, 7] };
async function fetchCoinbase(tf) {
  const [gran, mult] = CB_PLAN[tf];
  const need = Math.min(FETCH_BARS * mult + mult, 2100);
  const all = new Map();
  let end = Math.floor(Date.now() / 1000 / gran) * gran + gran;
  while (all.size < need) {
    const start = end - 300 * gran;
    const rows = await getJson(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=${gran}&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }
    });
    if (!Array.isArray(rows) || !rows.length) break;
    for (const r of rows) all.set(r[0], r); // [time, low, high, open, close, volume]
    end = start;
  }
  if (!all.size) throw new Error('空数据');
  const bars = [...all.values()].sort((a, b) => a[0] - b[0]).map(r => {
    const l = +r[1], h = +r[2], c = +r[4];
    return { t: r[0] * 1000, o: +r[3], h, l, c, v: +r[5] * typical(h, l, c) };
  });
  if (mult === 1) return bars;
  return tf === '1w' ? aggregateBars(bars, TF_MS['1w'], MONDAY_OFFSET_MS) : aggregateBars(bars, TF_MS[tf]);
}

// Kraken 只返回最近 720 根；周线同样按周四对齐，改由日线合成
const KRAKEN_PLAN = { '15m': 15, '1h': 60, '4h': 240, '1d': 1440, '1w': 1440 };
async function fetchKraken(tf) {
  const json = await getJson(`https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=${KRAKEN_PLAN[tf]}`);
  if (json.error && json.error.length) throw new Error(json.error.join(','));
  const key = Object.keys(json.result || {}).find(k => k !== 'last');
  // [time, o, h, l, c, vwap, volume, count]
  const bars = json.result[key].map(r => ({ t: r[0] * 1000, o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] * +r[6] }));
  return tf === '1w' ? aggregateBars(bars, TF_MS['1w'], MONDAY_OFFSET_MS) : bars;
}

const FETCHERS = {
  bnPerp: [{ label: '币安 USDT 永续', fn: fetchBnPerp }],
  okxPerp: [{ label: 'OKX USDT 永续', fn: tf => fetchOkx('BTC-USDT-SWAP', tf) }],
  hlPerp: [{ label: 'Hyperliquid 永续', fn: fetchHlPerp }],
  bnSpot: [{ label: '币安现货 BTCUSDT', fn: fetchBnSpot }],
  okxSpot: [{ label: 'OKX 现货 BTC-USDT', fn: tf => fetchOkx('BTC-USDT', tf) }],
  usSpot: [
    { label: 'Coinbase BTC-USD', fn: fetchCoinbase },
    { label: 'Kraken XBT/USD (Coinbase 不可达时的欧美现货替补)', fn: fetchKraken }
  ]
};

async function fetchVenue(key, tf) {
  const errors = [];
  for (const src of FETCHERS[key]) {
    try {
      const bars = await src.fn(tf);
      if (bars.length > LOOKBACK + 2) return { bars, source: src.label, errors };
      errors.push(`${src.label}: 仅 ${bars.length} 根`);
    } catch (e) {
      errors.push(`${src.label}: ${e.message}`);
    }
  }
  return { bars: [], source: null, errors };
}

/** 标准正态 CDF (Abramowitz-Stegun 7.1.26, 误差 < 1.5e-7) */
function normCdf(x) {
  const u = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * u);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-u * u);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/**
 * 单场所逐根压力: P_t = V_t·(2Φ(r_t/σ_t)−1) / mean(V_{t−n..t−1})
 * σ_t、成交额基线都只用 t 之前的 n 根，避免当根自我放大
 */
function venuePressure(bars, n = LOOKBACK) {
  const out = new Map();
  const rets = bars.map((b, i) => (i > 0 && bars[i - 1].c > 0 && b.c > 0 ? Math.log(b.c / bars[i - 1].c) : null));
  for (let i = n + 1; i < bars.length; i++) {
    let sumR = 0, sumR2 = 0, cnt = 0, sumV = 0;
    for (let j = i - n; j < i; j++) {
      if (rets[j] !== null) { sumR += rets[j]; sumR2 += rets[j] * rets[j]; cnt++; }
      sumV += bars[j].v;
    }
    const baseV = sumV / n;
    if (cnt < n / 2 || baseV <= 0 || rets[i] === null) continue;
    const mean = sumR / cnt;
    const sigma = Math.sqrt(Math.max(sumR2 / cnt - mean * mean, 0));
    const z = sigma > 0 ? rets[i] / sigma : 0;
    out.set(bars[i].t, { p: bars[i].v * (2 * normCdf(z) - 1) / baseV, base: baseV, c: bars[i].c, v: bars[i].v });
  }
  return out;
}

const mean = vals => {
  const xs = vals.filter(v => v !== null && Number.isFinite(v));
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
};
const round = (v, d = 4) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

/**
 * 由各场所K线合成 2×2 压力矩阵与 柱/点 序列 (纯函数，便于单测)
 * @param venueBars { venueKey: bars[] }
 * @param depthWeights { venueKey: ±10bps 深度美元 } 缺失时同格按成交额基线加权
 */
function computeFlowForce(venueBars, depthWeights = {}) {
  const pressures = {};
  for (const [k, bars] of Object.entries(venueBars)) if (bars && bars.length) pressures[k] = venuePressure(bars);

  const times = new Set();
  for (const m of Object.values(pressures)) for (const t of m.keys()) times.add(t);
  const sorted = [...times].sort((a, b) => a - b);

  const series = [];
  for (const t of sorted) {
    const cell = {};
    for (const [ck, members] of Object.entries(CELLS)) {
      let num = 0, den = 0;
      const useDepth = members.every(k => depthWeights[k] > 0);
      for (const k of members) {
        const pt = pressures[k] && pressures[k].get(t);
        if (!pt) continue;
        const w = useDepth ? depthWeights[k] : pt.base;
        num += w * pt.p;
        den += w;
      }
      cell[ck] = den > 0 ? num / den : null;
    }
    const F = mean([cell.futAsia, cell.futWest]);
    const S = mean([cell.spotAsia, cell.spotWest]);
    if (F === null || S === null) continue;
    const A = mean([cell.futAsia, cell.spotAsia]);
    const W = mean([cell.futWest, cell.spotWest]);

    const px = k => (pressures[k] && pressures[k].get(t) ? pressures[k].get(t).c : null);
    const bnS = px('bnSpot') || px('okxSpot');
    const us = px('usSpot');
    const perp = mean([px('bnPerp'), px('okxPerp')]);

    series.push({
      time: Math.floor(t / 1000),
      futAsia: round(cell.futAsia), futWest: round(cell.futWest),
      spotAsia: round(cell.spotAsia), spotWest: round(cell.spotWest),
      fut: round(F), spot: round(S), asia: round(A), west: round(W),
      hist: round(Math.abs(F) - Math.abs(S)),
      region: A !== null && W !== null ? round(Math.abs(A) - Math.abs(W)) : null,
      usPremiumBps: us && bnS ? round((us / bnS - 1) * 1e4, 2) : null,
      basisBps: perp && bnS ? round((perp / bnS - 1) * 1e4, 2) : null,
      price: round(us || bnS, 2)
    });
  }
  // 美元现货对 USDT 现货的原始价差含 USDT/USD 汇差 (缓慢漂移)，减去前 n 根均值得到真正的溢价偏离
  for (let i = 0; i < series.length; i++) {
    const prev = series.slice(Math.max(0, i - LOOKBACK), i).map(p => p.usPremiumBps);
    const base = prev.length >= 10 ? mean(prev) : null;
    const cur = series[i].usPremiumBps;
    series[i].usPremiumDevBps = cur !== null && base !== null ? round(cur - base, 2) : null;
  }
  return series;
}

/** 最近 k 根已收盘K线 (排除进行中的最后一根) 的均值研判 */
function summarize(series, k = 3) {
  const done = series.slice(-k - 1, -1);
  if (!done.length) return null;
  const h = mean(done.map(p => p.hist));
  const r = mean(done.map(p => p.region));
  const f = mean(done.map(p => p.fut));
  const s = mean(done.map(p => p.spot));
  const dir = v => (v === null ? '' : v > 0.05 ? '净买' : v < -0.05 ? '净卖' : '中性');
  return {
    bars: done.length,
    hist: round(h), region: round(r),
    leader: h === null ? null : h > 0 ? 'futures' : 'spot',
    leaderLabel: h === null ? '--' : h > 0 ? '期货主导' : '现货主导',
    regionLeader: r === null ? null : r > 0 ? 'asia' : 'west',
    regionLabel: r === null ? '--' : r > 0 ? '亚太主导' : '欧美主导',
    futDir: dir(f), spotDir: dir(s)
  };
}

// ---------------------------------------------------------------------------
// 场所审计: 24h 成交额、±10bps 盘口深度、换手/深度比 (刷量嫌疑参考)
// ---------------------------------------------------------------------------
function bandDepth(bids, asks, band = DEPTH_BAND, mult = 1) {
  if (!bids.length || !asks.length) return null;
  const mid = (+bids[0][0] + +asks[0][0]) / 2;
  let s = 0;
  for (const [p, q] of bids) if (+p >= mid * (1 - band)) s += +p * +q * mult;
  for (const [p, q] of asks) if (+p <= mid * (1 + band)) s += +p * +q * mult;
  return s;
}

const AUDIT_TASKS = {
  async bnPerp() {
    const [book, tk] = await Promise.all([
      getJson('https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=1000'),
      getJson('https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=BTCUSDT')
    ]);
    return { depth: bandDepth(book.bids, book.asks), vol24h: +tk.quoteVolume };
  },
  async okxPerp() {
    const [book, tk] = await Promise.all([
      getJson('https://www.okx.com/api/v5/market/books-full?instId=BTC-USDT-SWAP&sz=5000'),
      getJson('https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT-SWAP')
    ]);
    const b = book.data[0], t = tk.data[0];
    // 合约张数 × 面值 0.01 BTC
    return { depth: bandDepth(b.bids, b.asks, DEPTH_BAND, 0.01), vol24h: +t.volCcy24h * +t.last };
  },
  async hlPerp() {
    const [book, ctx] = await Promise.all([
      hlPost({ type: 'l2Book', coin: 'BTC', nSigFigs: 4 }),
      hlPost({ type: 'metaAndAssetCtxs' })
    ]);
    const idx = ctx[0].universe.findIndex(u => u.name === 'BTC');
    const toRows = side => side.map(l => [l.px, l.sz]);
    return { depth: bandDepth(toRows(book.levels[0]), toRows(book.levels[1])), vol24h: +ctx[1][idx].dayNtlVlm };
  },
  async bnSpot() {
    const [bookRes, tkRes] = await Promise.all([
      fetchBinanceSpot('/api/v3/depth?symbol=BTCUSDT&limit=5000', { timeout: 10000 }),
      fetchBinanceSpot('/api/v3/ticker/24hr?symbol=BTCUSDT', { timeout: 10000 })
    ]);
    if (!bookRes.ok || !tkRes.ok) throw new Error(`HTTP ${bookRes.status}/${tkRes.status}`);
    const book = await bookRes.json(), tk = await tkRes.json();
    return { depth: bandDepth(book.bids, book.asks), vol24h: +tk.quoteVolume };
  },
  async okxSpot() {
    const [book, tk] = await Promise.all([
      getJson('https://www.okx.com/api/v5/market/books-full?instId=BTC-USDT&sz=5000'),
      getJson('https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT')
    ]);
    return { depth: bandDepth(book.data[0].bids, book.data[0].asks), vol24h: +tk.data[0].volCcy24h };
  },
  async usSpot() {
    try {
      const h = { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } };
      const [book, st] = await Promise.all([
        getJson('https://api.exchange.coinbase.com/products/BTC-USD/book?level=2', h),
        getJson('https://api.exchange.coinbase.com/products/BTC-USD/stats', h)
      ]);
      return { depth: bandDepth(book.bids, book.asks), vol24h: +st.volume * +st.last, source: 'Coinbase BTC-USD' };
    } catch (e) {
      const [book, tk] = await Promise.all([
        getJson('https://api.kraken.com/0/public/Depth?pair=XBTUSD&count=500'),
        getJson('https://api.kraken.com/0/public/Ticker?pair=XBTUSD')
      ]);
      const b = Object.values(book.result)[0], t = Object.values(tk.result)[0];
      return { depth: bandDepth(b.bids, b.asks), vol24h: +t.v[1] * +t.p[1], source: 'Kraken XBT/USD' };
    }
  }
};

let auditCache = null;
let auditAt = 0;
let auditInflight = null;

async function getVenueAudit() {
  if (auditCache && Date.now() - auditAt < AUDIT_TTL_MS) return auditCache;
  if (auditInflight) return auditInflight;
  auditInflight = (async () => {
    const keys = Object.keys(AUDIT_TASKS);
    const results = await Promise.allSettled(keys.map(k => AUDIT_TASKS[k]()));
    const rows = {};
    keys.forEach((k, i) => {
      const r = results[i];
      if (r.status === 'fulfilled' && r.value.depth > 0) {
        rows[k] = {
          ...VENUES[k],
          name: r.value.source || VENUES[k].name,
          depthUsd: Math.round(r.value.depth),
          vol24hUsd: Math.round(r.value.vol24h),
          turnoverToDepth: round(r.value.vol24h / r.value.depth, 1)
        };
      } else {
        rows[k] = { ...VENUES[k], error: r.status === 'rejected' ? r.reason.message : '深度为空' };
      }
    });
    // 同格内的深度权重 (前端展示"谁说话算数")
    for (const members of Object.values(CELLS)) {
      const total = members.reduce((s, k) => s + (rows[k].depthUsd || 0), 0);
      for (const k of members) if (rows[k].depthUsd && total > 0) rows[k].cellWeight = round(rows[k].depthUsd / total, 3);
    }
    auditCache = { updatedAt: new Date().toISOString(), band: '±10bps', rows };
    auditAt = Date.now();
    return auditCache;
  })().finally(() => { auditInflight = null; });
  return auditInflight;
}

// ---------------------------------------------------------------------------
// 对外接口: 按周期缓存 + 并发合并 + 失败回退旧缓存
// ---------------------------------------------------------------------------
const cache = new Map();
const inflight = new Map();

async function buildFlowForce(tf) {
  const keys = Object.keys(VENUES);
  const [fetched, audit] = await Promise.all([
    Promise.all(keys.map(k => fetchVenue(k, tf))),
    getVenueAudit().catch(() => null)
  ]);
  const venueBars = {};
  const sources = {};
  keys.forEach((k, i) => {
    venueBars[k] = fetched[i].bars;
    sources[k] = {
      ...VENUES[k],
      source: fetched[i].source,
      ok: fetched[i].bars.length > 0,
      bars: fetched[i].bars.length,
      errors: fetched[i].errors
    };
    if (fetched[i].errors.length) console.warn(`[FlowForce] ${tf} ${k}: ${fetched[i].errors.join(' | ')}`);
  });

  const depthWeights = {};
  if (audit) for (const [k, row] of Object.entries(audit.rows)) if (row.depthUsd) depthWeights[k] = row.depthUsd;

  const series = computeFlowForce(venueBars, depthWeights);
  if (!series.length) throw new Error('各场所K线均不可用');
  return {
    code: 0,
    tf,
    updatedAt: new Date().toISOString(),
    lookback: LOOKBACK,
    method: 'BVC 净主动量 / 自身 50 根均额 → 同格按 ±10bps 深度加权 → 柱 |期货|−|现货|，点 |亚太|−|欧美|',
    cells: CELLS,
    sources,
    audit,
    summary: summarize(series),
    latest: series[series.length - 1],
    series
  };
}

async function getFlowForce(tf = '1h', force = false) {
  if (!TF_MS[tf]) tf = '1h';
  const hit = cache.get(tf);
  if (!force && hit && Date.now() - hit.at < TF_TTL_MS[tf]) return hit.data;
  if (inflight.has(tf)) return inflight.get(tf);
  const task = buildFlowForce(tf)
    .then(data => {
      cache.set(tf, { at: Date.now(), data });
      return data;
    })
    .catch(err => {
      if (hit) {
        console.warn(`[FlowForce] ${tf} 刷新失败，回退旧缓存: ${err.message}`);
        return { ...hit.data, stale: true };
      }
      throw err;
    })
    .finally(() => inflight.delete(tf));
  inflight.set(tf, task);
  return task;
}

module.exports = {
  getFlowForce,
  computeFlowForce,
  venuePressure,
  aggregateBars,
  normCdf,
  summarize,
  TF_MS
};
