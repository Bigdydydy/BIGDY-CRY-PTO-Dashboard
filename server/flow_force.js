/**
 * BTC 主导力量指标 (Flow Force): 推动当前行情的力量来自 期货/现货、亚太/欧美 中的哪一方
 *
 * 2×2 场所矩阵 (每格一个"压力"值):
 *   期货/亚太  币安 BTCUSDT 永续 + OKX BTC-USDT-SWAP
 *   期货/欧美  Hyperliquid BTC 永续
 *   现货/亚太  币安 BTCUSDT 现货 + OKX BTC-USDT 现货
 *   现货/欧美  Coinbase BTC-USD (直连被拦截时经 TradingView 的 COINBASE:BTCUSD 获取同一份成交)
 *
 * 每个场所每根K线:
 *   1. 主动买卖量用 BVC (Bulk Volume Classification, Easley-López de Prado-O'Hara 2012) 估计:
 *      净主动量 = V·(2Φ(r/σ) − 1)，r 为对数收益，σ 为前 n 根收益的标准差。
 *   2. 除以该场所自身前 n 根的平均成交额 → 相对压力 P。持续刷量只抬高基线、不制造信号。
 *   3. 同格两个场所按"定死的"权重合成 (2026-10-18 实测 ±10bps 盘口深度占比)。权重不再随实时深度
 *      变化，否则每次刷新都会改写全部历史。
 * 合成:
 *   柱 H = |期货| − |现货| (>0 期货主导)，点 R = |亚太| − |欧美| (>0 亚太主导)
 *   Coinbase 溢价 = Coinbase BTC-USD ÷ (币安 BTCUSDT × USDT/USD) − 1，以及 永续基差。
 *
 * 历史不可变:
 *   - 已收盘K线按"先写入者为准"存档 (data/flow_force/<周期>.json)，之后不再被任何数据源覆盖。
 *   - 某根K线收盘且 6 个场所 + USDT/USD 全部到齐，这一行指标即"定死"，以后原样返回、不再重算。
 *   - 缺场所的行标记为暂定 (missing)，等数据补齐 (币安最迟次日官方档案) 后再定死。
 *   - 进行中的K线按已过时间折算成交额，与已收盘K线可比，并标出缺失的场所。
 * 币安不直接依赖 REST (云主机共享出口常被 418 封禁)，见 binance_feed.js。
 */

const fs = require('fs');
const path = require('path');
const { fetchWithTimeout } = require('./http_client');
const { fetchTvBars } = require('./tradingview_feed');
const binance = require('./binance_feed');
const { fetchUpstreamJson, getUpstreamOrigin } = require('./upstream_mirror');
const { recordAttempt, recordSuccess, recordFailure } = require('./data_health');
const { withDataHealth } = require('./data_health_cache');

const TF_MS = { '15m': 9e5, '1h': 3.6e6, '4h': 1.44e7, '1d': 8.64e7, '1w': 6.048e8 };
const TF_TTL_MS = { '15m': 60e3, '1h': 120e3, '4h': 300e3, '1d': 600e3, '1w': 900e3 };
const LOOKBACK = 50;        // σ 与成交额基线窗口
const FETCH_BARS = 300;     // 每次向数据源要的根数 (含 LOOKBACK 预热)
const KEEP_BARS = 1000;     // 每个场所存档保留的已收盘K线
const KEEP_ROWS = 1000;     // 存档保留的已定死指标行
const CLOSE_GRACE_MS = 2 * 60e3; // 收盘后再等 2 分钟才视为最终值，避免把尚未补齐的末尾成交写死
const DAY_MS = 8.64e7;
const MONDAY_OFFSET_MS = 4 * DAY_MS; // 1970-01-01 是周四，+4 天对齐到周一 (币安 / OKX 周线口径)
const AUDIT_TTL_MS = 10 * 60e3;
const DEPTH_BAND = 0.001;   // ±10bps
const ALGO_VERSION = 2;     // 算法口径变化时 +1，旧的定死行作废重建 (原始K线存档保留)
const STORE_DIR = process.env.FLOW_FORCE_STORE_DIR || path.join(__dirname, '..', 'data', 'flow_force');

// 同格权重定死 (2026-10-18 实测 ±10bps 深度: 币安永续 $42.6M / OKX 永续 $38.1M；币安现货 $13.6M / OKX 现货 $7.6M)
// 与 tradingview/btc_flow_force.pine 的默认输入一致。改这里会作废全部定死行。
const FIXED_WEIGHTS = { bnPerp: 0.53, okxPerp: 0.47, hlPerp: 1, bnSpot: 0.64, okxSpot: 0.36, usSpot: 1 };

const VENUES = {
  bnPerp:  { name: '币安 USDT 永续', type: 'futures', region: 'asia', tv: 'BINANCE:BTCUSDT.P' },
  // TradingView 上 OKX 永续的 volume 是 USDT 计价，其余均为 BTC 数量 (2026-10-18 与各交易所 API 逐根核对)
  okxPerp: { name: 'OKX USDT 永续', type: 'futures', region: 'asia', tv: 'OKX:BTCUSDT.P', tvVolume: 'quote' },
  hlPerp:  { name: 'Hyperliquid 永续', type: 'futures', region: 'west', tv: 'HYPERLIQUID:BTCUSDC.P' },
  bnSpot:  { name: '币安现货 BTCUSDT', type: 'spot', region: 'asia', tv: 'BINANCE:BTCUSDT' },
  okxSpot: { name: 'OKX 现货 BTC-USDT', type: 'spot', region: 'asia', tv: 'OKX:BTCUSDT' },
  usSpot:  { name: 'Coinbase BTC-USD', type: 'spot', region: 'west', tv: 'COINBASE:BTCUSD' }
};
const VENUE_KEYS = Object.keys(VENUES);
const CELLS = {
  futAsia: ['bnPerp', 'okxPerp'],
  futWest: ['hlPerp'],
  spotAsia: ['bnSpot', 'okxSpot'],
  spotWest: ['usSpot']
};

const tfOffset = tf => (tf === '1w' ? MONDAY_OFFSET_MS : 0);
const alignT = (t, tf) => Math.floor((t - tfOffset(tf)) / TF_MS[tf]) * TF_MS[tf] + tfOffset(tf);
/** 收盘并过了宽限期，数据可视为最终值 */
const isFinal = (t, tf, now = Date.now()) => t + TF_MS[tf] + CLOSE_GRACE_MS <= now;

/** Per-bar schema: finite t/o/h/l/c/v, positive OHLC, consistent wicks,
 * v >= 0, strictly increasing timestamps, t > 0 and not beyond the 5-minute
 * future-skew limit. A bad bar fails that venue source. */
function validateFlowBars(bars, label) {
  if (!Array.isArray(bars)) throw new Error(`${label}: 非数组`);
  const maxT = Date.now() + 5 * 60e3;
  let prev = -Infinity;
  for (const b of bars) {
    if (!b || typeof b !== 'object') throw new Error(`${label}: 非对象bar`);
    for (const k of ['t', 'o', 'h', 'l', 'c', 'v']) {
      if (!Number.isFinite(b[k])) throw new Error(`${label}: ${k} 非有限数`);
    }
    if (b.t <= 0) throw new Error(`${label}: t 非正`);
    if (b.t > maxT) throw new Error(`${label}: t 超出未来 5min 容差`);
    if (b.o <= 0 || b.h <= 0 || b.l <= 0 || b.c <= 0) throw new Error(`${label}: OHLC 非正值`);
    if (b.h < Math.max(b.o, b.c, b.l)) throw new Error(`${label}: h < max(o,c,l)`);
    if (b.l > Math.min(b.o, b.c, b.h)) throw new Error(`${label}: l > min(o,c,h)`);
    if (b.v < 0) throw new Error(`${label}: v < 0`);
    if (b.t <= prev) throw new Error(`${label}: 时间非严格递增`);
    prev = b.t;
  }
}

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

/**
 * 把小周期K线合并为大周期 (offset 控制对齐点)。每根带 n = 子K线个数，
 * 调用方用 need 判断是否完整 (不完整且已收盘的合成K线不会被存档)。
 */
function aggregateBars(bars, periodMs, offsetMs = 0, need = null) {
  const out = [];
  let cur = null;
  for (const b of bars) {
    const key = Math.floor((b.t - offsetMs) / periodMs) * periodMs + offsetMs;
    if (!cur || cur.t !== key) {
      if (cur) out.push(cur);
      cur = { t: key, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, n: 1 };
      if (need) cur.need = need;
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
      cur.n++;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// 各场所K线来源
// ---------------------------------------------------------------------------
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
  return tf === '1w' ? aggregateBars(bars, TF_MS['1w'], MONDAY_OFFSET_MS, 7) : bars;
}

// Coinbase 没有 4h / 1w 粒度：由 1h / 1d 合成；单次最多 300 根，向前分页
const CB_PLAN = { '15m': [900, 1], '1h': [3600, 1], '4h': [3600, 4], '1d': [86400, 1], '1w': [86400, 7] };
async function fetchCoinbase(tf, product = 'BTC-USD') {
  const [gran, mult] = CB_PLAN[tf];
  const need = Math.min(FETCH_BARS * mult + mult, 2100);
  const all = new Map();
  let end = Math.floor(Date.now() / 1000 / gran) * gran + gran;
  while (all.size < need) {
    const start = end - 300 * gran;
    const rows = await getJson(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=${gran}&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`, {
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
  return tf === '1w' ? aggregateBars(bars, TF_MS['1w'], MONDAY_OFFSET_MS, 7) : aggregateBars(bars, TF_MS[tf], 0, mult);
}

/** 经 TradingView 行情通道取同一交易所的K线，成交量换算成美元成交额 (volume 口径见 VENUES.tvVolume) */
async function fetchViaTv(symbol, tf, volume = 'base') {
  const rows = await fetchTvBars(symbol, tf, FETCH_BARS);
  return rows.map(r => ({ t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: volume === 'quote' ? r.vol : r.vol * typical(r.h, r.l, r.c) }));
}

const DIRECT = {
  okxPerp: { label: 'OKX API', fn: tf => fetchOkx('BTC-USDT-SWAP', tf) },
  okxSpot: { label: 'OKX API', fn: tf => fetchOkx('BTC-USDT', tf) },
  hlPerp: { label: 'Hyperliquid API', fn: fetchHlPerp },
  usSpot: { label: 'Coinbase API', fn: tf => fetchCoinbase(tf) }
};

/**
 * 币安: 官方档案 (已收盘历史) → WebSocket 流 (当天收盘与进行中) → REST (带熔断) → TradingView。
 * 只为存档里缺的K线去找数据源，存档补齐后正常情况下不再访问 REST。
 */
async function fetchBinanceVenue(key, tf, stored, now) {
  const market = key === 'bnPerp' ? 'perp' : 'spot';
  const tfMs = TF_MS[tf];
  const current = alignT(now, tf);
  const fromT = current - (FETCH_BARS - 1) * tfMs;
  const todayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const got = new Map();
  const used = [];
  const errors = [];
  const missing = t => !stored.has(t) && !got.has(t);
  const gridTimes = [];
  for (let t = fromT; t <= current; t += tfMs) gridTimes.push(t);

  // 1. 档案：今天之前、已收盘但存档里没有的K线。
  //    周线档案的月度文件并不完整 (有缺月)，改由日线档案合成周一对齐的周线，7 根齐全才算数
  const oldGap = gridTimes.filter(t => t + tfMs <= todayStart && missing(t));
  if (oldGap.length) {
    try {
      const bars = tf === '1w'
        ? aggregateBars(await binance.fetchArchiveBars(market, '1d', oldGap[0]), tfMs, MONDAY_OFFSET_MS, 7)
        : await binance.fetchArchiveBars(market, tf, oldGap[0]);
      validateFlowBars(bars, '官方档案');
      for (const b of bars) got.set(b.t, b);
      if (bars.length) used.push('官方档案');
    } catch (e) {
      errors.push(`官方档案: ${e.message}`);
    }
  }
  // 2. 实时流：坏批次记为错误再走 REST/TV，不中断后续兜底
  binance.ensureStreams();
  try {
    const streamBars = binance.getStreamBars(market, tf);
    validateFlowBars(streamBars, '实时流');
    for (const b of streamBars) {
      // 流里未标记收盘却已过收盘时间的K线可能缺最后的成交，不采用
      if (b.closed || b.t === current) got.set(b.t, b);
    }
    if (streamBars.length) used.push('实时流');
  } catch (e) {
    errors.push(`实时流: ${e.message}`);
  }
  // 3/4. 仍缺的近期K线 (服务启动前的当天K线、断流期间、昨天的档案尚未发布) → REST → TradingView
  const recentFrom = Math.min(todayStart, current) - tfMs;
  const isUsable = t => !missing(t) && !(got.get(t) && got.get(t).need && got.get(t).n < got.get(t).need && t !== current);
  const recentGap = () => gridTimes.filter(t => t >= recentFrom && !isUsable(t));
  if (recentGap().length) {
    try {
      const bars = await binance.fetchRestBars(market, tf, Math.min(1000, FETCH_BARS));
      validateFlowBars(bars, 'REST');
      for (const b of bars) if (!isUsable(b.t) || b.t === current) got.set(b.t, b);
      used.push('REST');
    } catch (e) {
      errors.push(`REST: ${e.message}`);
    }
  }
  if (recentGap().length) {
    try {
      const bars = await fetchViaTv(VENUES[key].tv, tf, VENUES[key].tvVolume);
      validateFlowBars(bars, 'TradingView');
      for (const b of bars) if (!isUsable(b.t)) got.set(b.t, { ...b, viaTv: true });
      used.push('TradingView');
    } catch (e) {
      errors.push(`TradingView: ${e.message}`);
    }
  }
  return { bars: [...got.values()].sort((a, b) => a.t - b.t), source: used.join(' + ') || null, errors };
}

/**
 * 线上兜底: 本机连不上 Coinbase 时，读线上部署 /api/flow-force 里线上直连 Coinbase 得到的K线与 USDT/USD，
 * 与线上页面完全同源 (TradingView 通道的成交量与 Coinbase API 略有出入)。
 */
async function fetchUpstreamFlow(tf) {
  const d = await fetchUpstreamJson(`/api/flow-force?tf=${tf}`);
  if (!Array.isArray(d.candles) || !/Coinbase/.test(d.candleSource || '')) throw new Error('线上主图K线不是 Coinbase');
  return d;
}

const MIRROR = {
  usSpot: {
    label: '线上转发',
    fn: async tf => (await fetchUpstreamFlow(tf)).candles
      .map(k => ({ t: k.time * 1000, o: k.open, h: k.high, l: k.low, c: k.close, v: k.volumeUsd }))
  }
};

async function fetchVenue(key, tf, stored, now) {
  if (key === 'bnPerp' || key === 'bnSpot') return fetchBinanceVenue(key, tf, stored, now);
  const errors = [];
  const direct = DIRECT[key];
  try {
    const bars = await direct.fn(tf);
    validateFlowBars(bars, direct.label);
    if (bars.length) return { bars, source: direct.label, errors };
    errors.push(`${direct.label}: 空数据`);
  } catch (e) {
    errors.push(`${direct.label}: ${e.message}`);
  }
  const mirror = MIRROR[key];
  if (mirror && getUpstreamOrigin()) {
    try {
      const bars = await mirror.fn(tf);
      validateFlowBars(bars, mirror.label);
      if (bars.length) return { bars, source: mirror.label, errors };
      errors.push(`${mirror.label}: 空数据`);
    } catch (e) {
      errors.push(`${mirror.label}: ${e.message}`);
    }
  }
  try {
    const bars = await fetchViaTv(VENUES[key].tv, tf, VENUES[key].tvVolume);
    validateFlowBars(bars, 'TradingView');
    if (bars.length) return { bars: bars.map(b => ({ ...b, viaTv: true })), source: 'TradingView', errors };
  } catch (e) {
    errors.push(`TradingView: ${e.message}`);
  }
  return { bars: [], source: null, errors };
}

/** USDT/USD (Coinbase USDT-USD)：把币安 USDT 计价换成美元，才能得到真正的 Coinbase 溢价 */
async function fetchUsdtUsd(tf) {
  const errors = [];
  for (const src of [
    { label: 'Coinbase API', fn: () => fetchCoinbase(tf, 'USDT-USD') },
    {
      label: '线上转发',
      skip: !getUpstreamOrigin(),
      fn: async () => {
        const d = await fetchUpstreamFlow(tf);
        if (!Array.isArray(d.usdtUsd) || !d.usdtUsd.length) throw new Error('线上未提供 USDT/USD (旧版本部署)');
        return d.usdtUsd.filter(r => r[1] > 0).map(([time, c]) => ({ t: time * 1000, o: c, h: c, l: c, c, v: 0 }));
      }
    },
    { label: 'TradingView', fn: () => fetchViaTv('COINBASE:USDTUSD', tf) }
  ]) {
    if (src.skip) continue;
    try {
      const bars = await src.fn();
      validateFlowBars(bars, src.label);
      if (bars.length) return { bars, source: src.label, errors };
    } catch (e) {
      errors.push(`${src.label}: ${e.message}`);
    }
  }
  return { bars: [], source: null, errors };
}

// ---------------------------------------------------------------------------
// 计算
// ---------------------------------------------------------------------------
/** 标准正态 CDF (Abramowitz-Stegun 7.1.26, 误差 < 1.5e-7) */
function normCdf(x) {
  const u = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * u);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-u * u);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/**
 * 单场所逐根压力: P_t = V_t·(2Φ(r_t/σ_t)−1) / mean(V_{t−n..t−1})
 * σ_t、成交额基线都只用 t 之前的 n 根。传入 tfMs 时要求这 n+1 根时间上连续 (存档有缺口时
 * 不拿跨缺口的窗口凑数)；传入 now 时进行中的K线按已过时间折算成交额 (至少按 10% 计)。
 */
function venuePressure(bars, n = LOOKBACK, opts = {}) {
  const { tfMs = null, now = null } = opts;
  const out = new Map();
  const rets = bars.map((b, i) => (i > 0 && bars[i - 1].c > 0 && b.c > 0 ? Math.log(b.c / bars[i - 1].c) : null));
  for (let i = n + 1; i < bars.length; i++) {
    if (tfMs && bars[i].t - bars[i - n - 1].t !== (n + 1) * tfMs) continue;
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
    let v = bars[i].v;
    let frac = 1;
    if (tfMs && now && bars[i].t + tfMs > now) {
      frac = Math.min(1, Math.max(0.1, (now - bars[i].t) / tfMs));
      v /= frac;
    }
    out.set(bars[i].t, { p: v * (2 * normCdf(z) - 1) / baseV, base: baseV, c: bars[i].c, v: bars[i].v, frac });
  }
  return out;
}

const mean = vals => {
  const xs = vals.filter(v => v !== null && Number.isFinite(v));
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
};
const round = (v, d = 4) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

/**
 * 由各场所K线合成 2×2 压力矩阵与 柱/点 序列 (纯函数，便于单测)
 * @param venueBars { venueKey: bars[] }
 * @param weights { venueKey: 同格权重 }；缺失时同格按成交额基线加权
 * @param usdtUsd Map(开盘毫秒 → USDT/USD)
 * @param opts { tfMs, now } 见 venuePressure；listedFrom { venueKey: 上线后第一根K线 } 之前该场所算结构性缺席；
 *             行上会标出 live / missing / absent / complete
 */
function computeFlowForce(venueBars, weights = {}, usdtUsd = new Map(), opts = {}) {
  const { tfMs = null, now = null, listedFrom = {} } = opts;
  const pressures = {};
  for (const [k, bars] of Object.entries(venueBars)) if (bars && bars.length) pressures[k] = venuePressure(bars, LOOKBACK, opts);

  const times = new Set();
  for (const m of Object.values(pressures)) for (const t of m.keys()) times.add(t);
  const sorted = [...times].sort((a, b) => a - b);

  const series = [];
  for (const t of sorted) {
    const cell = {};
    for (const [ck, members] of Object.entries(CELLS)) {
      let num = 0, den = 0;
      const useFixed = members.every(k => weights[k] > 0);
      for (const k of members) {
        const pt = pressures[k] && pressures[k].get(t);
        if (!pt) continue;
        const w = useFixed ? weights[k] : pt.base;
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

    // Absolute activity intensities for dominance comparisons (avoids cancellation of hedging/arbitrage flows)
    const absVal = x => (x !== null && !isNaN(x) ? Math.abs(x) : null);
    const futStrength = mean([absVal(cell.futAsia), absVal(cell.futWest)]);
    const spotStrength = mean([absVal(cell.spotAsia), absVal(cell.spotWest)]);
    const asiaStrength = mean([absVal(cell.futAsia), absVal(cell.spotAsia)]);
    const westStrength = mean([absVal(cell.futWest), absVal(cell.spotWest)]);

    const px = k => (pressures[k] && pressures[k].get(t) ? pressures[k].get(t).c : null);
    const bnS = px('bnSpot') || px('okxSpot');
    const us = px('usSpot');
    const perp = mean([px('bnPerp'), px('okxPerp')]);
    const rate = usdtUsd.get(t); // 1 USDT = rate USD
    // 场所尚未上线 (含上线后 n+1 根预热期) 是结构性缺席，永远不会补齐，不算缺数据
    const lacking = VENUE_KEYS.filter(k => !(pressures[k] && pressures[k].get(t)));
    const absent = lacking.filter(k => listedFrom[k] && tfMs && t < listedFrom[k] + (LOOKBACK + 1) * tfMs);
    const missing = lacking.filter(k => !absent.includes(k));
    const live = !!(tfMs && now && t + tfMs > now);
    const usPremiumBps = us && bnS && rate > 0 ? round((us / (bnS * rate) - 1) * 1e4, 2) : null;

    const row = {
      time: Math.floor(t / 1000),
      futAsia: round(cell.futAsia), futWest: round(cell.futWest),
      spotAsia: round(cell.spotAsia), spotWest: round(cell.spotWest),
      fut: round(F), spot: round(S), asia: round(A), west: round(W),
      hist: futStrength !== null && spotStrength !== null ? round(futStrength - spotStrength) : null,
      region: asiaStrength !== null && westStrength !== null ? round(asiaStrength - westStrength) : null,
      // Coinbase 溢价 = Coinbase BTC-USD ÷ (币安 BTCUSDT × USDT/USD) − 1，两边都换成美元后再比
      usPremiumBps,
      // 未换汇的原始价差 = 真实溢价 + USDT 相对美元的折溢价
      usPremiumRawBps: us && bnS ? round((us / bnS - 1) * 1e4, 2) : null,
      basisBps: perp && bnS ? round((perp / bnS - 1) * 1e4, 2) : null,
      price: round(us || bnS, 2),
      missing,
      complete: missing.length === 0 && usPremiumBps !== null
    };
    if (absent.length) row.absent = absent;
    if (live) {
      row.live = true;
      const anyLive = VENUE_KEYS.map(k => pressures[k] && pressures[k].get(t)).find(Boolean);
      row.liveFrac = anyLive ? round(anyLive.frac, 3) : null;
    }
    series.push(row);
  }
  // 拿不到 USDT/USD 时的退路: 原始价差减去前 n 根均值 (近似剔除缓慢漂移的 USDT 汇差)
  for (let i = 0; i < series.length; i++) {
    const prev = series.slice(Math.max(0, i - LOOKBACK), i).map(p => p.usPremiumRawBps);
    const base = prev.length >= 10 ? mean(prev) : null;
    const cur = series[i].usPremiumRawBps;
    series[i].usPremiumDevBps = cur !== null && base !== null ? round(cur - base, 2) : null;
  }
  return series;
}

/** 最近 k 根已收盘 (不含进行中) 的均值研判 */
function summarize(series, k = 3) {
  const done = series.filter(p => !p.live).slice(-k);
  if (!done.length) return null;
  const h = mean(done.map(p => p.hist));
  const r = mean(done.map(p => p.region));
  const f = mean(done.map(p => p.fut));
  const s = mean(done.map(p => p.spot));
  const dir = v => (v === null ? '' : v > 0.05 ? '净买' : v < -0.05 ? '净卖' : '中性');
  return {
    bars: done.length,
    complete: done.every(p => p.complete),
    hist: round(h), region: round(r),
    leader: h === null ? null : h > 0 ? 'futures' : 'spot',
    leaderLabel: h === null ? '--' : h > 0 ? '期货主导' : '现货主导',
    regionLeader: r === null ? null : r > 0 ? 'asia' : 'west',
    regionLabel: r === null ? '--' : r > 0 ? '亚太主导' : '欧美主导',
    futDir: dir(f), spotDir: dir(s)
  };
}

// ---------------------------------------------------------------------------
// 存档: 已收盘K线先写入者为准 + 定死的指标行
// ---------------------------------------------------------------------------
const stores = new Map();

function emptyStore() {
  const bars = {};
  for (const k of VENUE_KEYS) bars[k] = new Map();
  return { bars, usdt: new Map(), rows: new Map(), dirty: false };
}

function storeFile(tf) {
  return path.join(STORE_DIR, `${tf}.json`);
}

function loadStore(tf) {
  if (stores.has(tf)) return stores.get(tf);
  const st = emptyStore();
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile(tf), 'utf8'));
    for (const k of VENUE_KEYS) {
      for (const r of (raw.bars && raw.bars[k]) || []) st.bars[k].set(r[0], { t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] });
    }
    for (const r of raw.usdt || []) st.usdt.set(r[0], r[1]);
    // 算法或权重变了，旧的定死行作废 (原始K线仍然有效，会按新口径重新定死)
    if (raw.algo === ALGO_VERSION && JSON.stringify(raw.weights) === JSON.stringify(FIXED_WEIGHTS)) {
      for (const row of raw.rows || []) st.rows.set(row.time, row);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[FlowForce] 读取存档 ${tf} 失败: ${e.message}`);
  }
  stores.set(tf, st);
  return st;
}

function saveStore(tf, st) {
  if (!st.dirty) return;
  st.dirty = false;
  const trimSorted = (entries, keep) => entries.sort((a, b) => a[0] - b[0]).slice(-keep);
  const bars = {};
  for (const k of VENUE_KEYS) {
    bars[k] = trimSorted([...st.bars[k].values()].map(b => [b.t, b.o, b.h, b.l, b.c, round(b.v, 2)]), KEEP_BARS);
    // 内存里也同步裁剪，避免无限增长
    if (st.bars[k].size > KEEP_BARS) for (const [t] of [...st.bars[k].entries()].sort((a, b) => a[0] - b[0]).slice(0, st.bars[k].size - KEEP_BARS)) st.bars[k].delete(t);
  }
  const usdt = trimSorted([...st.usdt.entries()], KEEP_BARS);
  const rows = [...st.rows.values()].sort((a, b) => a.time - b.time).slice(-KEEP_ROWS);
  const payload = JSON.stringify({ algo: ALGO_VERSION, weights: FIXED_WEIGHTS, tf, savedAt: new Date().toISOString(), bars, usdt, rows });
  fs.promises.mkdir(STORE_DIR, { recursive: true })
    .then(() => fs.promises.writeFile(`${storeFile(tf)}.tmp`, payload))
    .then(() => fs.promises.rename(`${storeFile(tf)}.tmp`, storeFile(tf)))
    .catch(e => console.warn(`[FlowForce] 写入存档 ${tf} 失败: ${e.message}`));
}

/**
 * TradingView 的成交量口径与交易所 API 可能不同；和该场所存档里已有的成交额比，
 * 量级差 20 倍以上就判定口径不符，丢弃这批K线，避免污染基线。
 */
function tvUnitsPlausible(bars, stored) {
  const ref = [...stored.values()].slice(-LOOKBACK).map(b => b.v).filter(v => v > 0).sort((a, b) => a - b);
  const vals = bars.map(b => b.v).filter(v => v > 0).sort((a, b) => a - b);
  if (ref.length < 10 || vals.length < 3) return true;
  const ratio = vals[Math.floor(vals.length / 2)] / ref[Math.floor(ref.length / 2)];
  return ratio > 1 / 20 && ratio < 20;
}

/** 把新拿到的已收盘K线并入存档 (已存在的时间点不覆盖)；返回本次计算用的K线 (存档 + 未定的近期K线) */
function mergeVenue(st, key, bars, tf, now) {
  const stored = st.bars[key];
  const transient = new Map();
  let usable = bars.filter(b => !(b.need && b.n < b.need && isFinal(b.t, tf, now)));
  if (usable.some(b => b.viaTv) && !tvUnitsPlausible(usable.filter(b => b.viaTv), stored)) {
    usable = usable.filter(b => !b.viaTv);
  }
  for (const b of usable) {
    const final = isFinal(b.t, tf, now) && (!b.need || b.n >= b.need) && (b.closed !== false);
    if (final) {
      if (!stored.has(b.t)) {
        stored.set(b.t, { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
        st.dirty = true;
      }
    } else if (!stored.has(b.t)) {
      transient.set(b.t, b);
    }
  }
  const merged = new Map(stored);
  for (const [t, b] of transient) merged.set(t, b);
  return [...merged.values()].sort((a, b) => a.t - b.t);
}

/**
 * 已定死的行原样使用 (即使本次某个场所缺数据、重算结果不同)；
 * 新满足条件 (已收盘过宽限期 + 6 场所与 USDT/USD 全部到齐) 的行写入定死集合。
 */
function applyFrozen(st, computed, tf, now) {
  let newlyFrozen = 0;
  for (const row of computed) {
    if (st.rows.has(row.time)) continue;
    if (!row.live && row.complete && isFinal(row.time * 1000, tf, now)) {
      st.rows.set(row.time, { ...row, frozen: true });
      st.dirty = true;
      newlyFrozen++;
    }
  }
  const byTime = new Map(computed.map(r => [r.time, r]));
  for (const [t, row] of st.rows) byTime.set(t, row);
  return { series: [...byTime.values()].sort((a, b) => a.time - b.time).slice(-KEEP_ROWS), newlyFrozen };
}

// ---------------------------------------------------------------------------
// 场所审计: 24h 成交额、±10bps 盘口深度、换手/深度比 (刷量嫌疑参考；不再参与计算)
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
    const book = await binance.getBinanceJson('https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=1000');
    const tk = await binance.getBinanceJson('https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=BTCUSDT');
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
    const book = await binance.getBinanceJson('https://data-api.binance.vision/api/v3/depth?symbol=BTCUSDT&limit=5000');
    const tk = await binance.getBinanceJson('https://data-api.binance.vision/api/v3/ticker/24hr?symbol=BTCUSDT');
    return { depth: bandDepth(book.bids, book.asks), vol24h: +tk.quoteVolume };
  },
  async okxSpot() {
    const [book, tk] = await Promise.all([
      getJson('https://www.okx.com/api/v5/market/books-full?instId=BTC-USDT&sz=5000'),
      getJson('https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT')
    ]);
    return { depth: bandDepth(book.data[0].bids, book.data[0].asks), vol24h: +tk.data[0].volCcy24h };
  },
  // 订单簿只能直连 Coinbase 获取 (TradingView 不提供盘口)
  async usSpot() {
    const h = { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } };
    let book, st;
    try {
      [book, st] = await Promise.all([
        getJson('https://api.exchange.coinbase.com/products/BTC-USD/book?level=2', h),
        getJson('https://api.exchange.coinbase.com/products/BTC-USD/stats', h)
      ]);
    } catch (e) {
      // 线上兜底: 用线上直连 Coinbase 测得的盘口深度
      if (getUpstreamOrigin()) {
        try {
          const row = (await fetchUpstreamJson('/api/flow-force?tf=1h')).audit.rows.usSpot;
          if (row && row.depthUsd > 0) return { depth: row.depthUsd, vol24h: row.vol24hUsd, via: '线上转发' };
        } catch (upErr) {
          throw new Error(`本机网络无法直连 Coinbase 盘口，线上兜底也失败: ${upErr.message}`);
        }
      }
      throw new Error(`本机网络无法直连 Coinbase 盘口: ${e.message}`);
    }
    return { depth: bandDepth(book.bids, book.asks), vol24h: +st.volume * +st.last };
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
      const base = { name: VENUES[k].name, type: VENUES[k].type, region: VENUES[k].region, fixedWeight: FIXED_WEIGHTS[k] };
      if (r.status === 'fulfilled' && r.value.depth > 0) {
        rows[k] = {
          ...base,
          depthUsd: Math.round(r.value.depth),
          vol24hUsd: Math.round(r.value.vol24h),
          turnoverToDepth: round(r.value.vol24h / r.value.depth, 1),
          ...(r.value.via ? { via: r.value.via } : {})
        };
      } else {
        rows[k] = { ...base, error: r.status === 'rejected' ? r.reason.message : '深度为空' };
      }
    });
    // 实时深度占比，只用于和定死权重对照
    for (const members of Object.values(CELLS)) {
      if (!members.every(k => rows[k].depthUsd)) continue;
      const total = members.reduce((s, k) => s + rows[k].depthUsd, 0);
      for (const k of members) rows[k].liveDepthShare = round(rows[k].depthUsd / total, 3);
    }
    auditCache = { updatedAt: new Date().toISOString(), band: '±10bps', rows };
    auditAt = Date.now();
    return auditCache;
  })().finally(() => { auditInflight = null; });
  return auditInflight;
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------
const cache = new Map();
const inflight = new Map();

async function buildFlowForce(tf) {
  const now = Date.now();
  const st = loadStore(tf);
  const aggId = `flow:${tf}`;
  const venueId = k => `flow:${tf}:${k}`;
  // Attempts are recorded before any fetch: a later failure preserves each
  // source's previous success clock instead of fabricating freshness.
  recordAttempt(aggId, { now });
  for (const k of VENUE_KEYS) recordAttempt(venueId(k), { now });
  recordAttempt(`flow:${tf}:fx`, { now });
  try {
    const [fetched, audit, usdt] = await Promise.all([
      Promise.all(VENUE_KEYS.map(k => fetchVenue(k, tf, st.bars[k], now))),
      getVenueAudit().catch(() => null),
      fetchUsdtUsd(tf)
    ]);

    // FX receipt: last ACTUAL fetched FX bar time, never server time.
    if (usdt.bars.length) {
      recordSuccess(`flow:${tf}:fx`, {
        dataAsOf: new Date(usdt.bars[usdt.bars.length - 1].t).toISOString(),
        asOfKind: 'source', source: usdt.source, issues: usdt.errors
      });
    } else {
      recordFailure(`flow:${tf}:fx`, new Error(usdt.errors.join(' | ') || 'USDT/USD 不可用'));
    }

    const venueBars = {};
    const sources = {};
    const issues = [];
    // This run's last ACTUAL fetched bar per venue — merged disk bars must
    // never advance a leaf receipt or the aggregate clock.
    const fetchedLastT = {};
    VENUE_KEYS.forEach((k, i) => {
      const f = fetched[i];
      venueBars[k] = mergeVenue(st, k, f.bars, tf, now);
      if (f.bars.length) {
        fetchedLastT[k] = f.bars[f.bars.length - 1].t;
        recordSuccess(venueId(k), {
          dataAsOf: new Date(fetchedLastT[k]).toISOString(),
          asOfKind: 'source', source: f.source, issues: f.errors
        });
        if (f.errors.length) issues.push(`${k} 经fallback源 ${f.source}`);
      } else {
        recordFailure(venueId(k), new Error(f.errors.join(' | ') || '无可用K线'));
        issues.push(`${k} 不可用`);
      }
      const last = venueBars[k][venueBars[k].length - 1];
      sources[k] = {
        name: VENUES[k].name, type: VENUES[k].type, region: VENUES[k].region,
        source: f.source,
        // 本次拿到了当前这根K线才算在线；只有存档时为离线 (历史不受影响)
        ok: !!last && last.t === alignT(now, tf),
        stored: st.bars[k].size,
        errors: f.errors
      };
      if (f.errors.length) console.warn(`[FlowForce] ${tf} ${k}: ${f.errors.join(' | ')}`);
    });
    if (usdt.errors.length) issues.push(`USDT/USD: ${usdt.errors.join(' | ')}`);

    for (const b of usdt.bars) {
      if (isFinal(b.t, tf, now) && (!b.need || b.n >= b.need) && !st.usdt.has(b.t)) {
        st.usdt.set(b.t, b.c);
        st.dirty = true;
      }
    }
    const rates = new Map(st.usdt);
    for (const b of usdt.bars) if (!rates.has(b.t)) rates.set(b.t, b.c);
    if (usdt.errors.length) console.warn(`[FlowForce] ${tf} USDT/USD: ${usdt.errors.join(' | ')}`);

    // 数据源正常应答、却给不满请求窗口的场所：首根有成交的K线即上线时间
    // (Hyperliquid 会把上线前的日子补成成交量为 0 的占位K线，因此不能只看第一根)
    const windowStart = alignT(now, tf) - (FETCH_BARS - 1) * TF_MS[tf];
    const listedFrom = {};
    VENUE_KEYS.forEach((k, i) => {
      const first = venueBars[k].find(b => b.v > 0);
      if (first && !fetched[i].errors.length && first.t > windowStart + 2 * TF_MS[tf]) listedFrom[k] = first.t;
    });

    const computed = computeFlowForce(venueBars, FIXED_WEIGHTS, rates, { tfMs: TF_MS[tf], now, listedFrom });
    const { series, newlyFrozen } = applyFrozen(st, computed, tf, now);
    if (!series.length) throw new Error('各场所K线均不可用');
    saveStore(tf, st);

    // 主图K线: Coinbase；欧美现货整体缺失时退到币安现货
    const candleKey = venueBars.usSpot.length ? 'usSpot' : 'bnSpot';
    const firstTime = series[0].time;
    const candles = venueBars[candleKey]
      .filter(b => b.t / 1000 >= firstTime)
      .map(b => ({ time: Math.floor(b.t / 1000), open: b.o, high: b.h, low: b.l, close: b.c, volumeUsd: Math.round(b.v) }));

    const premiumMode = series.some(p => p.usPremiumBps !== null) ? 'usd' : 'dev';
    if (premiumMode === 'dev') issues.push('USDT/USD 不可用，溢价退回原始价差均值口径');

    const payload = {
      code: 0,
      tf,
      updatedAt: new Date().toISOString(),
      lookback: LOOKBACK,
      method: 'BVC 净主动量 / 自身 50 根均额 → 同格定死权重 → 柱 |期货|−|现货|，点 |亚太|−|欧美|',
      cells: CELLS,
      weights: FIXED_WEIGHTS,
      sources,
      streams: binance.getStreamStatus(),
      audit,
      archive: {
        frozenRows: st.rows.size,
        newlyFrozen,
        provisionalRows: series.filter(r => !r.frozen && !r.live).length
      },
      summary: summarize(series),
      latest: series[series.length - 1],
      candleSource: sources[candleKey].source ? `${VENUES[candleKey].name} · ${sources[candleKey].source}` : VENUES[candleKey].name,
      premiumMode,
      usdtUsdSource: usdt.source,
      candles,
      // 与主图K线同一时间轴的 USDT/USD，供本地服务在连不上 Coinbase 时转发同一口径的汇率
      usdtUsd: candles.map(k => [k.time, rates.has(k.time * 1000) ? rates.get(k.time * 1000) : null]),
      series
    };

    // Aggregate receipt: only when EVERY cell supplied a fresh fetched receipt
    // this run. cellLatest = max last-actual-fetched-bar t among cell members.
    const cellLatest = [];
    for (const members of Object.values(CELLS)) {
      let maxT = null;
      for (const k of members) {
        if (fetchedLastT[k] != null && (maxT === null || fetchedLastT[k] > maxT)) maxT = fetchedLastT[k];
      }
      if (maxT === null) break;
      cellLatest.push(maxT);
    }
    if (cellLatest.length === Object.keys(CELLS).length) {
      // dataAsOf = MIN(last served series row, all four cells' latest fetched bar).
      const aggAsOf = new Date(Math.min(series[series.length - 1].time * 1000, ...cellLatest)).toISOString();
      recordSuccess(aggId, { dataAsOf: aggAsOf, asOfKind: 'source', source: 'flow/aggregate', issues });
      return payload;
    }
    // A cell without newly fetched bars: serve the archived history — charts
    // and frozen rows intact — but stale/history-only, never a fresh success.
    recordFailure(aggId, new Error('部分场所未取到新K线，仅返回存档历史'));
    return { ...payload, stale: true, historicalOnly: true };
  } catch (err) {
    recordFailure(aggId, err);
    throw err;
  }
}

const venueIdsFor = tf => Object.keys(VENUES).map(k => `flow:${tf}:${k}`).concat([`flow:${tf}:fx`]);

async function getFlowForce(tf = '1h', force = false) {
  if (!TF_MS[tf]) tf = '1h';
  const hit = cache.get(tf);
  // Cache health is recomputed live so expiry progresses between refreshes.
  if (!force && hit && Date.now() - hit.at < TF_TTL_MS[tf]) {
    return withDataHealth(hit.data, [`flow:${tf}`], venueIdsFor(tf));
  }
  if (inflight.has(tf)) return inflight.get(tf);
  const task = buildFlowForce(tf)
    .then(data => {
      // A history-only build (a cell had no newly fetched bars) is real data
      // but must never replace or rejuvenate the last good payload's clocks.
      if (data.historicalOnly && hit) {
        return withDataHealth({ ...hit.data, stale: true, historicalOnly: true }, [`flow:${tf}`], venueIdsFor(tf));
      }
      // Store the health-bound snapshot so a sibling timeframe's newer fetch
      // can never rejuvenate this payload's per-source clocks.
      const bound = withDataHealth(data, [`flow:${tf}`], venueIdsFor(tf));
      cache.set(tf, { at: Date.now(), data: bound });
      return bound;
    })
    .catch(err => {
      if (hit) {
        console.warn(`[FlowForce] ${tf} 刷新失败，回退旧缓存: ${err.message}`);
        return withDataHealth({ ...hit.data, stale: true }, [`flow:${tf}`], venueIdsFor(tf));
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
  mergeVenue,
  applyFrozen,
  emptyStore,
  normCdf,
  summarize,
  FIXED_WEIGHTS,
  TF_MS,
  // 测试用: 单个场所 / USDT/USD 的取数链路
  fetchVenue,
  fetchUsdtUsd
};
