/**
 * 周期时钟 & 成交量 / 持仓分位 (Module 1-E / 1-F)
 *
 * 两张卡共用一份 BTC 日线档案：
 *   1. 周期时钟   距历史最高收盘的天数与回撤，并与此前每一段 ≥ 40% 的回撤并排：高点 → 最低收盘
 *                 用了多少天、跌了多少、多久收复。回撤持续一年以上仍未收复的记为“周期熊市”，
 *                 一年内收复的记为“牛市中段回撤”。只做描述，不外推谷底。
 *   2. 量 / 持仓  Coinbase 30 日均成交量 (按 BTC 计)、ATR% (Wilder 14)、全市场期货 OI (按 BTC 计)
 *                 各自与此前 365 天比较的因果分位；并列出历史上“低波动 + 低量”同时出现的时段
 *                 及其之后 90 / 180 天的表现。回测 (docs/reports/four-lows-backtest-2026-11-27.md)
 *                 显示这种组合既出现在底部，也出现在下跌中途与顶部前，所以这里只给描述与历史对照。
 *
 * 数据：data/btc_daily_history.json (Bitstamp 2011-08 → 2015-07 日收盘 + Coinbase BTC-USD 日线，
 * 运行时把新收盘的日线增量追加到 .local.json)；期货 OI 取 Module 2-D (server/leverage_norm.js)。
 */

const fs = require('fs');
const path = require('path');
const { fetchWithTimeout } = require('./http_client');
const { recordAttempt, recordSuccess, recordFailure } = require('./data_health');
const { withDataHealth, seedCachedHealth, atomicWriteJson } = require('./data_health_cache');
const { snapshotPath } = require('./snapshot_path');
const { raceStale } = require('./swr');

const DATA_DIR = path.join(__dirname, '..', 'data');
const HISTORY_FILE = snapshotPath(path.join(DATA_DIR, 'btc_daily_history.json'));
const CACHE_FILE = path.join(DATA_DIR, 'cycle_state.json');
const CACHE_TTL_MS = 60 * 60 * 1000;
const SCHEMA_VERSION = 2;          // bump when a field changes shape; older disk caches are rebuilt
const REQUIRED_IDS = ['cycle_spot_daily'];
const ANCILLARY_IDS = ['lev_oi'];

const DAY_MS = 86400000;
const COINBASE_START = '2015-07-20';
const COINBASE_PAGE_DAYS = 300;         // Coinbase candles: at most 300 bars per request
const DRAWDOWN_EPISODE = 0.40;          // a drawdown of ≥ 40% from the all-time-high close opens an episode
const BEAR_DAYS = 365;                  // unrecovered for more than a year = cycle bear
const PATH_CAP_DAYS = 1200;             // overlay paths stop here (the 2013 bear took ~1170 days to recover)
const PCT_LOOKBACK_DAYS = 365;
const PCT_MIN_OBS = 300;
const LOW_PCT = 20;
const HIGH_PCT = 80;
const EPISODE_GAP_DAYS = 30;
const VOLUME_WINDOW = 30;
const ATR_LEN = 14;
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json' };

let memoryCache = null;
let memoryCacheTime = 0;
let buildInflight = null;
let diskSeeded = false;

const isoDate = ts => new Date(ts).toISOString().slice(0, 10);
const dayMs = d => Date.parse(`${d}T00:00:00Z`);
const daysBetween = (a, b) => Math.round((dayMs(b) - dayMs(a)) / DAY_MS);
const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Number(Number(v).toFixed(d)));
const isFiniteNum = v => typeof v === 'number' && Number.isFinite(v);
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;

// ---------------------------------------------------------------------------
// History archive
// ---------------------------------------------------------------------------

/** Coinbase candles [time(sec), low, high, open, close, volume] → validated rows, forming candle dropped */
function parseCoinbaseCandles(raw, now = Date.now()) {
  if (!Array.isArray(raw)) throw new Error('Coinbase 日线返回的不是数组');
  const today = isoDate(now);
  const rows = [];
  for (const c of raw) {
    if (!Array.isArray(c) || c.length < 6) throw new Error('Coinbase 日线行格式错误');
    const [t, low, high, open, close, volume] = c.map(Number);
    if (![t, low, high, open, close, volume].every(Number.isFinite)) throw new Error('Coinbase 日线含非数值');
    if (low <= 0 || high < low || open < low || open > high || close < low || close > high || volume < 0) {
      throw new Error(`Coinbase 日线 OHLCV 非法 @ ${isoDate(t * 1000)}`);
    }
    const date = isoDate(t * 1000);
    if (date >= today) continue; // the UTC day is still forming
    rows.push({ date, open, high, low, close, volume });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

/** Merge by date (fresh rows win); returns a strictly increasing series */
function mergeDaily(existing, fresh) {
  const byDate = new Map(existing.map(r => [r.date, r]));
  for (const r of fresh) byDate.set(r.date, r);
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function readHistory() {
  try {
    const d = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (!d || !Array.isArray(d.coinbase) || !Array.isArray(d.bitstamp)) return null;
    return {
      bitstamp: d.bitstamp.map(([date, close]) => ({ date, close })),
      coinbase: d.coinbase.map(([date, open, high, low, close, volume]) => ({ date, open, high, low, close, volume }))
    };
  } catch (e) {
    return null;
  }
}

function writeHistory(hist) {
  const out = {
    schema: 1,
    note: 'BTC 日线档案：bitstamp = Bitstamp BTC/USD 日收盘 (2011-08-18 → 2015-07-19，只用于补 Coinbase 上线前的历史高点与 2013 轮周期)；coinbase = Coinbase Exchange BTC-USD 日线 [date, open, high, low, close, volume(BTC)]，UTC 日界，服务器运行时增量追加到 .local.json。',
    bitstamp: hist.bitstamp.map(r => [r.date, r.close]),
    coinbase: hist.coinbase.map(r => [r.date, r.open, r.high, r.low, r.close, r.volume])
  };
  atomicWriteJson(HISTORY_FILE, out, 0);
}

async function fetchCoinbaseRange(fromDate, now = Date.now()) {
  const rows = [];
  let start = dayMs(fromDate);
  const end = now;
  for (let guard = 0; guard < 30 && start < end; guard++) {
    const stop = Math.min(end, start + (COINBASE_PAGE_DAYS - 1) * DAY_MS);
    const url = `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400&start=${new Date(start).toISOString()}&end=${new Date(stop).toISOString()}`;
    const resp = await fetchWithTimeout(url, { headers: UA, timeout: 12000, retries: 1 });
    if (!resp.ok) throw new Error(`Coinbase 日线 HTTP ${resp.status}`);
    rows.push(...parseCoinbaseCandles(await resp.json(), now));
    start = stop + DAY_MS;
  }
  return rows;
}

/** Append newly closed days to the archive; throws when the archive cannot be brought up to date */
async function refreshHistory(now = Date.now()) {
  recordAttempt('cycle_spot_daily', { now });
  try {
    const hist = readHistory() || { bitstamp: [], coinbase: [] };
    const last = hist.coinbase.length ? hist.coinbase[hist.coinbase.length - 1].date : null;
    const from = last ? isoDate(dayMs(last) + DAY_MS) : COINBASE_START;
    const yesterday = isoDate(now - DAY_MS);
    if (!last || last < yesterday) {
      // Re-request the last stored day as well so a partially stored bar is overwritten
      const fresh = await fetchCoinbaseRange(last ? last : from, now);
      if (fresh.length) {
        hist.coinbase = mergeDaily(hist.coinbase, fresh);
        try { writeHistory(hist); } catch (e) { console.warn('[CycleState] Error persisting history:', e.message); }
      }
    }
    if (!hist.coinbase.length) throw new Error('BTC 日线档案为空');
    const latest = hist.coinbase[hist.coinbase.length - 1].date;
    if (daysBetween(latest, isoDate(now)) > 3) throw new Error(`Coinbase 日线只到 ${latest}`);
    recordSuccess('cycle_spot_daily', { dataAsOf: latest, asOfKind: 'source', source: 'coinbase/candles-1d' });
    return hist;
  } catch (err) {
    recordFailure('cycle_spot_daily', err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Card 1: cycle clock
// ---------------------------------------------------------------------------

/** Coinbase printed a $0.06 low on 2017-04-15; a wick beyond 2× the body is a bad print, cut to the body */
function cleanWicks(rows) {
  const cleaned = [];
  const out = rows.map(r => {
    let { low, high } = r;
    const bodyLo = Math.min(r.open, r.close);
    const bodyHi = Math.max(r.open, r.close);
    if (low < 0.5 * bodyLo) { cleaned.push(`${r.date} low ${low}`); low = bodyLo; }
    if (high > 2 * bodyHi) { cleaned.push(`${r.date} high ${high}`); high = bodyHi; }
    return low === r.low && high === r.high ? r : { ...r, low, high };
  });
  return { rows: out, cleaned };
}

/**
 * Every drawdown of ≥ `threshold` from the running all-time-high close.
 * An episode opens on the first close ≥ threshold below the ATH, keeps that ATH as its peak and
 * closes on the first close above the peak. A peak inside the first `warmupDays` of data may be a
 * local high below an older, unseen peak (Bitstamp starts 2011-08-18, after the 2011-06 top), so
 * such episodes are dropped.
 */
function detectDrawdownEpisodes(closes, { threshold = DRAWDOWN_EPISODE, bearDays = BEAR_DAYS, pathCap = PATH_CAP_DAYS, warmupDays = 365 } = {}) {
  const episodes = [];
  if (!closes.length) return episodes;
  let athIdx = 0;
  let open = null;
  const finish = (ep, endIdx, recovered) => {
    const peak = closes[ep.peakIdx];
    if (daysBetween(closes[0].date, peak.date) < warmupDays) return;
    let troughIdx = ep.peakIdx;
    const stop = recovered ? endIdx - 1 : endIdx;
    for (let j = ep.peakIdx; j <= stop; j++) if (closes[j].close < closes[troughIdx].close) troughIdx = j;
    const trough = closes[troughIdx];
    const lastIdx = recovered ? endIdx : closes.length - 1;
    const path = [];
    for (let j = ep.peakIdx; j <= lastIdx; j++) {
      const d = daysBetween(peak.date, closes[j].date);
      if (d > pathCap) break;
      path.push([d, round(closes[j].close / peak.close - 1, 4)]);
    }
    const spanDays = daysBetween(peak.date, recovered ? closes[endIdx].date : closes[closes.length - 1].date);
    episodes.push({
      peakDate: peak.date,
      peakClose: round(peak.close, 2),
      troughDate: trough.date,
      troughClose: round(trough.close, 2),
      daysToTrough: daysBetween(peak.date, trough.date),
      maxDrawdown: round(trough.close / peak.close - 1, 4),
      recoveryDate: recovered ? closes[endIdx].date : null,
      daysToRecover: recovered ? spanDays : null,
      ongoing: !recovered,
      daysSincePeak: spanDays,
      kind: spanDays > bearDays ? 'cycle_bear' : (recovered ? 'correction' : 'undetermined'),
      path
    });
  };
  for (let i = 1; i < closes.length; i++) {
    const c = closes[i].close;
    if (c > closes[athIdx].close) {
      if (open) { finish(open, i, true); open = null; }
      athIdx = i;
      continue;
    }
    if (!open && c <= closes[athIdx].close * (1 - threshold)) open = { peakIdx: athIdx };
  }
  if (open) finish(open, closes.length - 1, false);
  return episodes;
}

function buildClock(closes, episodes) {
  let athIdx = 0;
  for (let i = 1; i < closes.length; i++) if (closes[i].close >= closes[athIdx].close) athIdx = i;
  const ath = closes[athIdx];
  const last = closes[closes.length - 1];
  const sinceAth = daysBetween(ath.date, last.date);
  const drawdown = last.close / ath.close - 1;
  let lowIdx = athIdx;
  for (let i = athIdx; i < closes.length; i++) if (closes[i].close < closes[lowIdx].close) lowIdx = i;
  const current = episodes.find(e => e.ongoing) || null;
  const priorBears = episodes.filter(e => !e.ongoing && e.kind === 'cycle_bear');
  const range = (vals, fmt) => {
    if (!vals.length) return '--';
    const lo = Math.min(...vals), hi = Math.max(...vals);
    return lo === hi ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`;
  };
  const pct = v => `${Math.round(Math.abs(v) * 100)}%`;
  const priorStats = priorBears.length ? {
    n: priorBears.length,
    daysToTroughMin: Math.min(...priorBears.map(e => e.daysToTrough)),
    daysToTroughMax: Math.max(...priorBears.map(e => e.daysToTrough)),
    maxDrawdownShallowest: Math.max(...priorBears.map(e => e.maxDrawdown)),
    maxDrawdownDeepest: Math.min(...priorBears.map(e => e.maxDrawdown)),
    daysToRecoverMin: Math.min(...priorBears.map(e => e.daysToRecover)),
    daysToRecoverMax: Math.max(...priorBears.map(e => e.daysToRecover))
  } : null;

  let headline;
  const athText = `${ath.date} 的最高收盘 $${Math.round(ath.close).toLocaleString('en-US')}`;
  if (!current) {
    headline = `距 ${athText} ${sinceAth} 天，回撤 ${pct(drawdown)}，不在 ≥ ${pct(DRAWDOWN_EPISODE)} 的回撤阶段。`;
  } else {
    const parts = [`距 ${athText} 已 ${sinceAth} 天，回撤 ${pct(drawdown)}（本轮最低收盘在 ${current.troughDate}，回撤 ${pct(current.maxDrawdown)}）。`];
    if (priorStats) {
      const inWindow = sinceAth < priorStats.daysToTroughMin ? '还没到这段时间' : (sinceAth <= priorStats.daysToTroughMax ? '正处在这段时间里' : '已超过这段时间');
      const depth = current.maxDrawdown > priorStats.maxDrawdownShallowest ? '浅于其中任何一轮' : (current.maxDrawdown < priorStats.maxDrawdownDeepest ? '深于其中任何一轮' : '在其范围内');
      parts.push(`此前 ${priorStats.n} 轮周期熊市从高点到最低收盘用了 ${range(priorBears.map(e => e.daysToTrough), v => `${v}`)} 天，最大回撤 ${range(priorBears.map(e => Math.abs(e.maxDrawdown)), pct)}；本轮${inWindow}，回撤深度${depth}。`);
    }
    if (current.kind === 'cycle_bear') parts.push(`回撤已持续 ${current.daysSincePeak} 天未收复，按一年口径归为周期熊市而非牛市中段回撤。`);
    headline = parts.join('');
  }
  return {
    ath: { date: ath.date, close: round(ath.close, 2) },
    last: { date: last.date, close: round(last.close, 2) },
    sinceAth,
    drawdown: round(drawdown, 4),
    lowSinceAth: { date: closes[lowIdx].date, close: round(closes[lowIdx].close, 2), drawdown: round(closes[lowIdx].close / ath.close - 1, 4), daysFromAth: daysBetween(ath.date, closes[lowIdx].date) },
    currentKind: current ? current.kind : null,
    priorStats,
    headline
  };
}

// ---------------------------------------------------------------------------
// Card 2: volume / volatility / OI percentiles
// ---------------------------------------------------------------------------

function wilderAtrPct(rows, len = ATR_LEN) {
  const out = new Array(rows.length).fill(null);
  let atr = null;
  let seed = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const tr = i === 0 ? r.high - r.low : Math.max(r.high - r.low, Math.abs(r.high - rows[i - 1].close), Math.abs(r.low - rows[i - 1].close));
    if (i < len) {
      seed += tr;
      if (i === len - 1) { atr = seed / len; out[i] = 100 * atr / r.close; }
      continue;
    }
    atr = (atr * (len - 1) + tr) / len;
    out[i] = 100 * atr / r.close;
  }
  return out;
}

function rollingMean(vals, n) {
  const out = new Array(vals.length).fill(null);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (isFiniteNum(v)) { sum += v; count++; }
    if (i >= n) { const o = vals[i - n]; if (isFiniteNum(o)) { sum -= o; count--; } }
    if (i >= n - 1 && count === n) out[i] = sum / n;
  }
  return out;
}

/** Percentile of each value among the values of the previous `lookback` calendar days (t excluded) */
function causalPercentile(dates, vals, lookback = PCT_LOOKBACK_DAYS, minObs = PCT_MIN_OBS) {
  const out = new Array(vals.length).fill(null);
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (!isFiniteNum(v)) continue;
    const t = dayMs(dates[i]);
    let n = 0, below = 0;
    for (let j = i - 1; j >= 0; j--) {
      if (t - dayMs(dates[j]) > lookback * DAY_MS) break;
      const p = vals[j];
      if (!isFiniteNum(p)) continue;
      n++;
      if (p < v) below++;
    }
    if (n >= minObs) out[i] = 100 * below / n;
  }
  return out;
}

function regimeOf(drawdown, sinceAth) {
  if (drawdown <= -DRAWDOWN_EPISODE && sinceAth >= BEAR_DAYS) return 'bear_aged';
  if (drawdown <= -DRAWDOWN_EPISODE) return 'bear_young';
  return 'not_bear';
}

function buildActivity(rows, oiRows) {
  const dates = rows.map(r => r.date);
  const atrPct = wilderAtrPct(rows);
  const vol30 = rollingMean(rows.map(r => r.volume), VOLUME_WINDOW);
  const oiBy = new Map((oiRows || []).filter(r => isFiniteNum(r.futOiBtc)).map(r => [r.date, r.futOiBtc]));
  const oiBtc = dates.map(d => (oiBy.has(d) ? oiBy.get(d) : null));
  const pAtr = causalPercentile(dates, atrPct);
  const pVolume = causalPercentile(dates, vol30);
  const pOi = causalPercentile(dates, oiBtc);

  // running ATH (closes include the pre-Coinbase history passed in through rows[0].athBefore)
  let ath = rows.length ? (rows[0].athBefore || 0) : 0;
  let athDate = rows.length ? (rows[0].athBeforeDate || rows[0].date) : null;
  const dd = [], since = [];
  for (const r of rows) {
    if (r.close >= ath) { ath = r.close; athDate = r.date; }
    dd.push(r.close / ath - 1);
    since.push(daysBetween(athDate, r.date));
  }

  const series = rows.map((r, i) => ({
    date: r.date,
    close: round(r.close, 2),
    atrPct: round(atrPct[i], 3),
    vol30: round(vol30[i], 0),
    oiBtc: oiBtc[i] == null ? null : Math.round(oiBtc[i]),
    pAtr: round(pAtr[i], 1),
    pVolume: round(pVolume[i], 1),
    pOi: round(pOi[i], 1)
  }));

  // Historical "low volatility + low volume" spells and what followed
  const fwd = (i, h) => (i + h < rows.length ? round(rows[i + h].close / rows[i].close - 1, 4) : null);
  const episodes = [];
  let lastSignal = -Infinity;
  for (let i = 0; i < rows.length; i++) {
    if (pAtr[i] == null || pVolume[i] == null || pAtr[i] > LOW_PCT || pVolume[i] > LOW_PCT) continue;
    if (i - lastSignal > EPISODE_GAP_DAYS) {
      episodes.push({
        start: rows[i].date, end: rows[i].date, days: 1,
        close: round(rows[i].close, 2),
        drawdown: round(dd[i], 4), sinceAth: since[i],
        regime: regimeOf(dd[i], since[i]),
        pOi: round(pOi[i], 1),
        ret90: fwd(i, 90), ret180: fwd(i, 180)
      });
    } else {
      const e = episodes[episodes.length - 1];
      e.end = rows[i].date;
      e.days += 1;
    }
    lastSignal = i;
  }

  const lastOf = arr => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return { date: dates[i], value: arr[i] }; return null; };
  const legs = [
    { key: 'volume', label: 'Coinbase 30 日均成交量', pct: lastOf(pVolume), raw: lastOf(vol30), unit: 'BTC/日' },
    { key: 'atr', label: 'ATR%（14 日）', pct: lastOf(pAtr), raw: lastOf(atrPct), unit: '%' },
    { key: 'oi', label: '期货 OI（按币计）', pct: lastOf(pOi), raw: lastOf(oiBtc), unit: 'BTC' }
  ].map(l => ({
    key: l.key, label: l.label, unit: l.unit,
    date: l.pct ? l.pct.date : null,
    percentile: l.pct ? round(l.pct.value, 1) : null,
    value: l.raw ? round(l.raw.value, l.key === 'atr' ? 3 : 0) : null,
    state: !l.pct ? null : (l.pct.value <= LOW_PCT ? 'low' : (l.pct.value >= HIGH_PCT ? 'high' : 'mid'))
  }));
  const fmt = l => `${l.label}第 ${Math.round(l.percentile)} 分位`;
  const ready = legs.filter(l => l.percentile != null);
  const lows = ready.filter(l => l.state === 'low');
  const highs = ready.filter(l => l.state === 'high');
  const lastIdx = rows.length - 1;
  const recent = episodes.length ? episodes[episodes.length - 1] : null;
  let headline = ready.length ? `与此前一年比：${ready.map(fmt).join('，')}。` : '分位样本不足。';
  if (ready.length) {
    headline += lows.length === ready.length ? '三项都处在低位。'
      : lows.length ? `处在低位（≤ ${LOW_PCT} 分位）的只有${lows.map(l => l.label).join('、')}。`
      : '没有一项处在低位。';
    if (highs.length >= 2) headline += `${highs.map(l => l.label).join('、')}都在 ${HIGH_PCT} 分位以上，市场处在高活跃状态。`;
  }
  if (recent) headline += `最近一次“低波动 + 低量”同时出现是 ${recent.start}${recent.end !== recent.start ? ` → ${recent.end}` : ''}。`;

  return {
    series,
    legs,
    lowThreshold: LOW_PCT,
    highThreshold: HIGH_PCT,
    regimeNow: lastIdx >= 0 ? regimeOf(dd[lastIdx], since[lastIdx]) : null,
    episodes,
    headline
  };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function buildFromHistory(hist, oiPanel, { oiError = null } = {}) {
  const { rows: cb, cleaned } = cleanWicks(hist.coinbase);
  const first = cb.length ? cb[0].date : null;
  const pre = hist.bitstamp.filter(r => !first || r.date < first);
  const closes = [...pre.map(r => ({ date: r.date, close: r.close })), ...cb.map(r => ({ date: r.date, close: r.close }))];
  if (closes.length < 400) throw new Error('BTC 日线不足以计算周期');
  const episodes = detectDrawdownEpisodes(closes);
  const clock = buildClock(closes, episodes);
  let athBefore = 0, athBeforeDate = null;
  for (const r of pre) if (r.close >= athBefore) { athBefore = r.close; athBeforeDate = r.date; }
  const rows = cb.map((r, i) => (i === 0 ? { ...r, athBefore, athBeforeDate } : r));
  const activity = buildActivity(rows, oiPanel);
  const last = cb[cb.length - 1];
  return {
    schema: SCHEMA_VERSION,
    generatedAt: Date.now(),
    freshness: {
      spotLatest: last.date,
      oiLatest: oiPanel && oiPanel.length ? oiPanel[oiPanel.length - 1].date : null
    },
    clock,
    cycles: episodes,
    activity,
    oiError,
    metadata: {
      sources: {
        spot: `Coinbase Exchange BTC-USD 日线（${first} 起，UTC 日界）；更早的历史高点与 2013 轮周期用 Bitstamp BTC/USD 日收盘（${pre.length ? pre[0].date : '--'} 起）`,
        oi: 'CoinGlass 全场所期货 OI（按 BTC 计、链式拼接，2020-02 起；见杠杆与资金归一化卡）'
      },
      clock: {
        method: [
          `回撤阶段：收盘价较此前历史最高收盘回撤 ≥ ${DRAWDOWN_EPISODE * 100}% 时开始，收盘重新站上该高点时结束；高点到阶段内最低收盘为“高点 → 最低”。持续 ${BEAR_DAYS} 天以上仍未收复记为周期熊市，一年内收复记为牛市中段回撤。`
        ],
        caveats: [
          '周期样本只有 2013、2017、2021 三轮完整熊市，高点 → 最低的天数与跌幅只是历史对照，不是对本轮谷底的预测。',
          '2015-07 之前用 Bitstamp、之后用 Coinbase 收盘，两家同日收盘略有差异，对百分比回撤的影响可以忽略。'
        ]
      },
      activity: {
        method: [
          `分位：Coinbase ${VOLUME_WINDOW} 日均成交量（按 BTC 计）、ATR%（Wilder ${ATR_LEN} 日真实波幅 ÷ 收盘）、期货 OI（按币计）各自与此前 ${PCT_LOOKBACK_DAYS} 天（不含当日、至少 ${PCT_MIN_OBS} 个观测）比较；≤ ${LOW_PCT} 记为低位，≥ ${HIGH_PCT} 记为高位。`,
          `“低波动 + 低量”时段：ATR% 与成交量同时 ≤ ${LOW_PCT} 分位，相隔超过 ${EPISODE_GAP_DAYS} 天算新时段，取首日计算之后 90 / 180 天的收盘涨跌。阶段按首日划分：较历史高点回撤 ≥ ${DRAWDOWN_EPISODE * 100}% 为熊市，再按距高点是否满 ${BEAR_DAYS} 天细分。`
        ],
        caveats: [
          '回测（docs/reports/four-lows-backtest-2026-11-27.md）：低波动、低量、低关注度、低持仓同时出现的时点，既有 2019、2023 年的底部，也有 2018-05、2022-04 的下跌中途和 2025-09、2026-10 的顶部前平静；按周期聚类后与随机日没有显著差别。这里的分位只描述市场是否安静，不是入场信号。',
          '单看低波动，之后 30–90 天的价格区间反而偏小（波动率聚集）；“低波动预示大行情”在价格区间口径上不成立。',
          'Coinbase 份额逐年被 ETF 与离岸场所分走，成交量有长期下降趋势；一年分位能消除大部分漂移，但低位出现得会略多。',
          ...(cleaned.length ? [`坏价清洗：${cleaned.join('、')}（影线超过实体 2 倍按实体截断）。`] : [])
        ]
      }
    }
  };
}

async function buildCycleState(previous = null) {
  const hist = await refreshHistory();
  let oiPanel = null;
  let oiError = null;
  try {
    // Lazy require keeps leverage_norm (and its CoinGlass client) out of this module's load path
    const lev = require('./leverage_norm');
    const data = await lev.getLeverageNormData(false);
    oiPanel = Array.isArray(data.oi) ? data.oi.map(r => ({ date: r.date, futOiBtc: r.futOiBtc })) : null;
    if (!oiPanel || !oiPanel.length) throw new Error('期货 OI 为空');
  } catch (err) {
    oiError = err.message;
    console.warn('[CycleState] OI unavailable:', err.message);
    const prevOi = previous && previous.activity && previous.activity.series
      ? previous.activity.series.filter(r => r.oiBtc != null).map(r => ({ date: r.date, futOiBtc: r.oiBtc }))
      : null;
    oiPanel = prevOi && prevOi.length ? prevOi : null;
  }
  return buildFromHistory(hist, oiPanel, { oiError });
}

// ---------------------------------------------------------------------------
// Cache / public API (same shape as leverage_norm.js)
// ---------------------------------------------------------------------------

function readDiskCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const d = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (d && d.schema === SCHEMA_VERSION && d.clock && d.activity && Number.isFinite(d.generatedAt)) return d;
    }
  } catch (e) {
    console.warn('[CycleState] Error reading cache:', e.message);
  }
  return null;
}

function seedDiskOnce(disk) {
  if (diskSeeded || !disk) return;
  diskSeeded = true;
  const receipt = Number.isFinite(disk.generatedAt) ? new Date(disk.generatedAt).toISOString() : null;
  seedCachedHealth(disk, 'cycle_spot_daily', { dataAsOf: disk.freshness?.spotLatest || null, lastSuccessAt: receipt });
}

function rebuildOnce(disk) {
  if (!buildInflight) buildInflight = rebuild(disk).finally(() => { buildInflight = null; });
  return buildInflight;
}

async function getCycleStateData(force = false) {
  const now = Date.now();
  if (!force && memoryCache && now - memoryCacheTime < CACHE_TTL_MS) {
    return withDataHealth(memoryCache, REQUIRED_IDS, ANCILLARY_IDS);
  }
  const disk = memoryCache ? null : readDiskCache();
  if (disk) seedDiskOnce(disk);
  if (!force && disk && now - disk.generatedAt < CACHE_TTL_MS) {
    memoryCache = disk;
    memoryCacheTime = now;
    return withDataHealth(disk, REQUIRED_IDS, ANCILLARY_IDS);
  }
  const build = rebuildOnce(disk);
  if (force) return build;
  const previous = memoryCache || disk;
  if (!previous) return build;
  return raceStale(build, () => withDataHealth(previous, REQUIRED_IDS, ANCILLARY_IDS));
}

async function rebuild(disk) {
  const now = Date.now();
  try {
    const data = await buildCycleState(memoryCache || disk);
    const bound = withDataHealth(data, REQUIRED_IDS, ANCILLARY_IDS);
    memoryCache = bound;
    memoryCacheTime = now;
    try { atomicWriteJson(CACHE_FILE, bound, 0); } catch (e) { console.warn('[CycleState] Error persisting cache:', e.message); }
    return bound;
  } catch (err) {
    console.error('[CycleState] Build failed:', err.message);
    const fallback = memoryCache || disk || readDiskCache();
    if (fallback) {
      seedDiskOnce(fallback);
      return withDataHealth({ ...fallback, stale: true }, REQUIRED_IDS, ANCILLARY_IDS);
    }
    // No build has ever succeeded: describe the shipped archive, flagged stale (health stays failed)
    const hist = readHistory();
    if (hist && hist.coinbase.length) {
      return withDataHealth({ ...buildFromHistory(hist, null, { oiError: err.message }), stale: true }, REQUIRED_IDS, ANCILLARY_IDS);
    }
    throw err;
  }
}

module.exports = {
  getCycleStateData,
  parseCoinbaseCandles,
  mergeDaily,
  cleanWicks,
  detectDrawdownEpisodes,
  buildClock,
  wilderAtrPct,
  rollingMean,
  causalPercentile,
  buildActivity,
  buildFromHistory,
  REQUIRED_IDS,
  ANCILLARY_IDS,
  CACHE_FILE,
  HISTORY_FILE
};
