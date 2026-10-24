/**
 * Module 2-D: Leverage & capital-flow normalization
 *
 * Dollar totals move with the BTC price and with exchange coverage, so they cannot be compared
 * across cycles. Each panel divides by the base it acts on:
 *   1. Perp funding premium  OI-weighted funding × perpetual OI, summed over 30 days: the dollars
 *                            longs paid shorts (negative = shorts paid longs).
 *                            Perpetual OI ≈ all-venue futures OI ex-CME.
 *   2. Futures OI in BTC     the same book counted in coins strips the price; the 30-day USD change
 *                            splits into position change (BTC) and price effect.
 *   3. ETF flow / volume     20-session net flow ÷ dollar volume of the same funds: money arriving
 *                            vs money only changing hands.
 *   4. Options / futures OI  the options book relative to the futures book (BTC terms).
 *
 * Coverage: CoinGlass adds venues over time (MEXC / Bitunix / WhiteBIT 2025-03, Aster 2025-09 ...)
 * and a raw sum jumps on the day a venue enters. OI levels are chain-linked instead: each day's
 * change uses only venues reported on both days, anchored on the latest all-venue total.
 *
 * Sources: CoinGlass futures OI (all venues) / options OI / OI-weighted funding (8h) / US spot ETF
 * daily flows; Yahoo Finance daily volume × close for the ETF tickers.
 */

const fs = require('fs');
const path = require('path');
const { fetchWithTimeout } = require('./http_client');
const { callCoinglassEndpoint } = require('./cdri_fetcher');
const { recordAttempt, recordSuccess, recordFailure } = require('./data_health');
const { withDataHealth, seedCachedHealth, atomicWriteJson } = require('./data_health_cache');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'leverage_norm.json');
const CACHE_TTL_MS = 60 * 60 * 1000;
const SCHEMA_VERSION = 1;          // bump when a field's definition changes; older disk caches are rebuilt
const REQUIRED_IDS = ['lev_oi', 'lev_funding'];
// The ETF panel enriches the card but never gates the OI / funding panels
const ANCILLARY_IDS = ['lev_etf_flow', 'etf_volume'];

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const MAX_FUTURE_MS = 5 * 60 * 1000;
const PREMIUM_WINDOW_DAYS = 30;
const SETTLEMENTS_PER_DAY = 3;      // CoinGlass OI-weighted funding is published on 8h bars
const ETF_WINDOW = 20;              // ≈ four weeks of US sessions
const ETF_START = '2024-01-11';     // US spot ETFs listed 2024-01-11
const CORE_ETF_TICKERS = ['IBIT', 'FBTC', 'GBTC'];
const RATIO_AVG_DAYS = 90;          // one quarterly expiry cycle: options OI saw-tooths into each expiry
const ETF_REGIME_BAND = 0.05;       // |flow / volume| ≥ 5% = flow-dominated, else turnover
const OI_TREND_BAND = 0.03;         // |30-day BTC OI change| ≥ 3% = rebuilding / deleveraging
const YAHOO_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' };

let memoryCache = null;
let memoryCacheTime = 0;
let inflight = null;
let diskSeeded = false;

const isoDate = ts => new Date(ts).toISOString().slice(0, 10);
const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Number(Number(v).toFixed(d)));
const isNonNeg = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function fmtUsd(v) {
  if (v == null || !Number.isFinite(v)) return '--';
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(0)}M`;
  return `${sign}$${abs.toFixed(0)}`;
}
const fmtPct = (v, d = 1) => (v == null || !Number.isFinite(v) ? '--' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(d)}%`);

// ---------------------------------------------------------------------------
// Open interest
// ---------------------------------------------------------------------------

/**
 * One CoinGlass venue payload → [{ date, ts, price, venues: { name: value } }] in date order.
 * The endpoint ends with an intraday point stamped "now"; the last observation of each UTC date
 * wins, so today's row is the latest reading. null means the venue is not covered that day.
 */
function parseVenuePayload(payload, label, now = Date.now()) {
  if (!payload || !Array.isArray(payload.dateList) || !payload.dateList.length) {
    throw new Error(`${label}: dateList 缺失或为空`);
  }
  const dataMap = payload.dataMap;
  if (!dataMap || typeof dataMap !== 'object' || !Object.keys(dataMap).length) {
    throw new Error(`${label}: dataMap 缺失`);
  }
  const n = payload.dateList.length;
  for (const [venue, values] of Object.entries(dataMap)) {
    if (!Array.isArray(values) || values.length !== n) throw new Error(`${label}: ${venue} 与 dateList 长度不等`);
    for (const v of values) {
      if (v !== null && v !== undefined && !isNonNeg(v)) throw new Error(`${label}: ${venue} 含非法值 ${JSON.stringify(v)}`);
    }
  }
  const prices = Array.isArray(payload.priceList) && payload.priceList.length === n ? payload.priceList : null;
  const byDate = new Map();
  let prevTs = -Infinity;
  payload.dateList.forEach((ts, i) => {
    if (!Number.isFinite(ts)) throw new Error(`${label}: dateList 含非数值`);
    if (ts <= prevTs) throw new Error(`${label}: dateList 非严格递增`);
    if (ts > now + MAX_FUTURE_MS) throw new Error(`${label}: dateList 含未来时间`);
    prevTs = ts;
    const venues = {};
    for (const [venue, values] of Object.entries(dataMap)) {
      if (values[i] !== null && values[i] !== undefined) venues[venue] = values[i];
    }
    const p = prices ? Number(prices[i]) : NaN;
    byDate.set(isoDate(ts), { date: isoDate(ts), ts, price: p > 0 ? p : null, venues });
  });
  return [...byDate.values()];
}

/**
 * Coverage-corrected level series. `raw` sums the venues reported that day; each day's growth uses
 * only venues reported on both days, so a venue entering or leaving coverage moves `raw` but not
 * `chained`. The chain is anchored on the latest raw total and walked backwards.
 */
function chainLink(rows, include = () => true) {
  const out = rows.map(r => {
    let raw = 0;
    let venues = 0;
    for (const [v, x] of Object.entries(r.venues)) {
      if (include(v)) { raw += x; venues++; }
    }
    return { date: r.date, raw, venues, growth: 1, chained: null };
  });
  for (let i = 1; i < rows.length; i++) {
    let cur = 0;
    let prev = 0;
    for (const [v, x] of Object.entries(rows[i].venues)) {
      const p = rows[i - 1].venues[v];
      if (!include(v) || p === undefined) continue;
      cur += x;
      prev += p;
    }
    out[i].growth = prev > 0 && cur > 0 ? cur / prev : 1;
  }
  let level = out.length ? out[out.length - 1].raw : null;
  for (let i = out.length - 1; i >= 0; i--) {
    out[i].chained = level;
    level /= out[i].growth;
  }
  return out;
}

/** Daily OI panel: chain-linked futures (USD / BTC / ex-CME), options (USD / BTC) and venue shares */
function buildOiPanel({ futUsd, futBtc, optUsd, optBtc }, now = Date.now()) {
  const fu = parseVenuePayload(futUsd, '期货 OI/USD', now);
  const fb = parseVenuePayload(futBtc, '期货 OI/BTC', now);
  const ou = parseVenuePayload(optUsd, '期权 OI/USD', now);
  const ob = parseVenuePayload(optBtc, '期权 OI/BTC', now);
  const byDate = (rows, chain) => new Map(rows.map((r, i) => [r.date, chain[i]]));
  const fuC = chainLink(fu);
  const perpC = chainLink(fu, v => v !== 'CME');
  const fbBy = byDate(fb, chainLink(fb));
  const ouBy = byDate(ou, chainLink(ou));
  const obBy = byDate(ob, chainLink(ob));

  const rows = fu.map((r, i) => {
    const btc = fbBy.get(r.date);
    const optU = ouBy.get(r.date);
    const optB = obBy.get(r.date);
    const share = name => (fuC[i].raw > 0 && r.venues[name] !== undefined ? r.venues[name] / fuC[i].raw : null);
    return {
      date: r.date,
      price: round(r.price, 0),
      futOiUsd: round(fuC[i].chained, 0),
      futOiUsdRaw: round(fuC[i].raw, 0),
      futVenues: fuC[i].venues,
      futOiBtc: btc ? round(btc.chained, 0) : null,
      perpOiUsd: round(perpC[i].chained, 0),
      optOiUsd: optU ? round(optU.chained, 0) : null,
      optOiBtc: optB ? round(optB.chained, 0) : null,
      optFutRatio: btc && optB && btc.chained > 0 ? round(optB.chained / btc.chained, 3) : null,
      cmeShare: round(share('CME'), 4),
      binanceShare: round(share('Binance'), 4),
      hyperliquidShare: round(share('Hyperliquid'), 4)
    };
  });

  // Trailing 90-day mean of the ratio (≥ 60 observations), so a reading is not dominated by where
  // it falls in the quarterly expiry cycle
  let lo = 0;
  let sum = 0;
  let n = 0;
  rows.forEach((r, i) => {
    if (r.optFutRatio != null) { sum += r.optFutRatio; n++; }
    const startMs = Date.parse(r.date) - (RATIO_AVG_DAYS - 1) * DAY_MS;
    while (Date.parse(rows[lo].date) < startMs) {
      if (rows[lo].optFutRatio != null) { sum -= rows[lo].optFutRatio; n--; }
      lo++;
    }
    r.optFutRatio90d = n >= 60 ? round(sum / n, 3) : null;
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Funding premium
// ---------------------------------------------------------------------------

/**
 * CoinGlass OI-weighted funding, 8h bars: bar t covers [t, t + 8h] and its close is the rate
 * settled at t + 8h in % per 8h (same convention as basis_fetcher). The still-open bar is skipped.
 */
function parseFundingBars(bars, now = Date.now()) {
  if (!Array.isArray(bars) || !bars.length) throw new Error('资金费率: 空响应');
  const byTime = new Map();
  for (const b of bars) {
    const open = Number(b?.data?.[0]);
    const close = Number(b?.data?.[4]);
    if (!Number.isFinite(open) || open <= 0 || !Number.isFinite(close)) throw new Error('资金费率: bar 含非法值');
    const fundingTime = open * 1000 + 8 * HOUR_MS;
    if (fundingTime > now) continue;
    byTime.set(fundingTime, { fundingTime, rate: close / 100 });
  }
  const rows = [...byTime.values()].sort((a, b) => a.fundingTime - b.fundingTime);
  if (!rows.length) throw new Error('资金费率: 无已结算 bar');
  return rows;
}

/**
 * Daily dollars longs paid shorts = Σ settlement rate × perpetual OI of that day, and its trailing
 * 30-day sum. A window counts only with ≥ 90% of its settlements; the current UTC day is incomplete
 * and left out. A settlement at 00:00 closes the previous day.
 */
function buildFundingPremium(fundingRows, oiPanel, now = Date.now()) {
  const perpByDate = new Map(oiPanel.map(r => [r.date, r.perpOiUsd]));
  const today = isoDate(now);
  const days = new Map();
  for (const f of fundingRows) {
    const date = isoDate(f.fundingTime - 1);
    if (date >= today) continue;
    const oi = perpByDate.get(date);
    if (!(oi > 0)) continue;
    const d = days.get(date) || { date, paidUsd: 0, rateSum: 0, n: 0 };
    d.paidUsd += f.rate * oi;
    d.rateSum += f.rate;
    d.n++;
    days.set(date, d);
  }
  const list = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  return list.map((day, i) => {
    const startMs = Date.parse(day.date) - (PREMIUM_WINDOW_DAYS - 1) * DAY_MS;
    let paid = 0;
    let rate = 0;
    let n = 0;
    for (let j = i; j >= 0 && Date.parse(list[j].date) >= startMs; j--) {
      paid += list[j].paidUsd;
      rate += list[j].rateSum;
      n += list[j].n;
    }
    const covered = n >= 0.9 * PREMIUM_WINDOW_DAYS * SETTLEMENTS_PER_DAY;
    return {
      date: day.date,
      fundingUsd: round(day.paidUsd, 0),
      premium30dUsd: covered ? round(paid, 0) : null,
      fundingApr30d: covered ? round(rate * 365 / PREMIUM_WINDOW_DAYS * 100, 2) : null
    };
  });
}

// ---------------------------------------------------------------------------
// ETF flow / dollar volume
// ---------------------------------------------------------------------------

/** CoinGlass daily ETF flows → [{ date, funds: { TICKER: changeUsd | null } }] since ETF_START */
function parseEtfFlows(rows) {
  if (!Array.isArray(rows)) throw new Error('ETF 流量: payload 非数组');
  const byDate = new Map();
  for (const r of rows) {
    // A day counts once at least one fund has printed; trailing blank days are dropped
    if (!Array.isArray(r?.list) || !r.list.some(f => f && f.changeUsd != null)) continue;
    if (!Number.isFinite(Number(r.date))) throw new Error('ETF 流量: date 非数值');
    const funds = {};
    for (const f of r.list) {
      if (!f || typeof f.ticker !== 'string' || !f.ticker.trim()) throw new Error('ETF 流量: 基金缺 ticker');
      if (f.changeUsd != null && !Number.isFinite(Number(f.changeUsd))) throw new Error(`ETF 流量: ${f.ticker} changeUsd 非法`);
      funds[f.ticker.trim()] = f.changeUsd == null ? null : Number(f.changeUsd);
    }
    const date = isoDate(Number(r.date));
    if (date >= ETF_START) byDate.set(date, { date, funds });
  }
  const out = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (!out.length) throw new Error('ETF 流量: 过滤后为空');
  return out;
}

/** Yahoo daily chart → Map(date → close × volume). Non-trading rows (null close) are skipped. */
function parseYahooDollarVolume(json, symbol, now = Date.now()) {
  const res = json?.chart?.result?.[0];
  const q = res?.indicators?.quote?.[0];
  if (!Array.isArray(res?.timestamp) || !res.timestamp.length || !q
      || !Array.isArray(q.close) || !Array.isArray(q.volume)
      || q.close.length !== res.timestamp.length || q.volume.length !== res.timestamp.length) {
    throw new Error(`Yahoo ${symbol}: 空响应或 timestamp/close/volume 长度不等`);
  }
  const map = new Map();
  let prevDay = '';
  res.timestamp.forEach((t, i) => {
    if (!Number.isFinite(t) || t <= 0) throw new Error(`Yahoo ${symbol}: timestamp 非法`);
    if (t * 1000 > now + MAX_FUTURE_MS) throw new Error(`Yahoo ${symbol}: 含未来时间`);
    const close = q.close[i];
    const volume = q.volume[i];
    if (close == null || volume == null) return;
    if (!(close > 0) || !isNonNeg(volume)) throw new Error(`Yahoo ${symbol}: close/volume 非法`);
    const day = isoDate(t * 1000);
    if (day <= prevDay) throw new Error(`Yahoo ${symbol}: 日期非严格递增`);
    prevDay = day;
    if (day >= ETF_START) map.set(day, close * volume);
  });
  if (!map.size) throw new Error(`Yahoo ${symbol}: 无有效成交额`);
  return map;
}

/**
 * Daily net flow and dollar volume over the funds whose volume is known that day, and the
 * trailing ETF_WINDOW-session ratio. A day missing a core fund's volume is skipped.
 */
function buildEtfTurnover(flows, volumes) {
  const tickers = Object.keys(volumes);
  const rows = [];
  for (const f of flows) {
    let flow = 0;
    let vol = 0;
    let missingCore = false;
    for (const t of tickers) {
      const v = volumes[t].get(f.date);
      if (v === undefined) {
        if (CORE_ETF_TICKERS.includes(t)) missingCore = true;
        continue;
      }
      vol += v;
      flow += f.funds[t] ?? 0;
    }
    if (missingCore || !(vol > 0)) continue;
    rows.push({ date: f.date, flowUsd: flow, volumeUsd: vol });
  }
  return rows.map((r, i) => {
    let flow20 = null;
    let vol20 = null;
    if (i >= ETF_WINDOW - 1) {
      flow20 = 0;
      vol20 = 0;
      for (let j = i - ETF_WINDOW + 1; j <= i; j++) {
        flow20 += rows[j].flowUsd;
        vol20 += rows[j].volumeUsd;
      }
    }
    return {
      date: r.date,
      flowUsd: round(r.flowUsd, 0),
      volumeUsd: round(r.volumeUsd, 0),
      flow20Usd: round(flow20, 0),
      volume20Usd: round(vol20, 0),
      ratio20: vol20 > 0 ? round(flow20 / vol20, 4) : null
    };
  });
}

// ---------------------------------------------------------------------------
// Summaries (each headline is the panel's conclusion, written as a sentence)
// ---------------------------------------------------------------------------

function percentileRank(values, v) {
  const xs = values.filter(Number.isFinite);
  if (!xs.length || !Number.isFinite(v)) return null;
  return round(xs.filter(x => x <= v).length / xs.length, 3);
}

function extremeOf(rows, field, pick) {
  let best = null;
  for (const r of rows) {
    if (r[field] == null) continue;
    if (!best || pick(r[field], best.value)) best = { date: r.date, value: r[field] };
  }
  return best;
}

/** Last row dated on or before `date` */
function rowOnOrBefore(rows, date) {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].date <= date) return rows[i];
  return null;
}

function summarizeFunding(rows) {
  const valid = rows.filter(r => r.premium30dUsd != null);
  const last = valid[valid.length - 1];
  if (!last) return null;
  const sign = Math.sign(last.premium30dUsd);
  let streakDays = 0;
  for (let i = valid.length - 1; i >= 0 && sign !== 0 && Math.sign(valid[i].premium30dUsd) === sign; i--) streakDays++;
  const values = valid.map(r => r.premium30dUsd);
  const percentile = percentileRank(values, last.premium30dUsd);
  const max = extremeOf(valid, 'premium30dUsd', (a, b) => a > b);
  const min = extremeOf(valid, 'premium30dUsd', (a, b) => a < b);
  const pctText = percentile == null ? '--' : `${Math.round(percentile * 100)}%`;
  const headline = sign >= 0
    ? `近 30 天多头向空头净付 ${fmtUsd(last.premium30dUsd)}（年化资金费 ${last.fundingApr30d}%），位于 ${valid[0].date} 以来 ${pctText} 分位；样本峰值 ${fmtUsd(max.value)}（${max.date}）。`
    : `近 30 天空头向多头净付 ${fmtUsd(-last.premium30dUsd)}，已连续 ${streakDays} 天为负：做空要付费，空头回补时会变成被动买盘。样本最低 ${fmtUsd(min.value)}（${min.date}）。`;
  return {
    date: last.date,
    premium30dUsd: last.premium30dUsd,
    fundingApr30d: last.fundingApr30d,
    longsPay: sign >= 0,
    streakDays,
    percentile,
    max,
    min,
    sampleFrom: valid[0].date,
    headline
  };
}

function summarizeOi(panel) {
  const last = panel[panel.length - 1];
  if (!last || last.futOiUsd == null || last.futOiBtc == null) return null;
  const dateMinus = days => isoDate(Date.parse(last.date) - days * DAY_MS);
  const prev30 = rowOnOrBefore(panel, dateMinus(30));
  const prev365 = rowOnOrBefore(panel, dateMinus(365));
  const change = (a, b) => (a != null && b > 0 ? a / b - 1 : null);
  const usd30 = change(last.futOiUsd, prev30?.futOiUsd);
  const btc30 = change(last.futOiBtc, prev30?.futOiBtc);
  const priceEffect30 = usd30 != null && btc30 != null ? (1 + usd30) / (1 + btc30) - 1 : null;
  const year = panel.filter(r => r.date > dateMinus(365));
  const peakUsd = extremeOf(year, 'futOiUsd', (a, b) => a > b);
  const peakBtc = extremeOf(year, 'futOiBtc', (a, b) => a > b);
  const ddUsd = change(last.futOiUsd, peakUsd?.value);
  const ddBtc = change(last.futOiBtc, peakBtc?.value);
  const trend = btc30 == null ? '' : btc30 >= OI_TREND_BAND ? '持仓在重建' : btc30 <= -OI_TREND_BAND ? '仍在去杠杆' : '持仓基本持平';
  const headline = `期货 OI 距一年高点：美元口径 ${fmtPct(ddUsd)}，按币计 ${fmtPct(ddBtc)}。近 30 天按币计 ${fmtPct(btc30)}（美元口径 ${fmtPct(usd30)}，其中币价贡献 ${fmtPct(priceEffect30)}），${trend}。`;
  return {
    date: last.date,
    futOiUsd: last.futOiUsd,
    futOiBtc: last.futOiBtc,
    futVenues: last.futVenues,
    usd30,
    btc30,
    priceEffect30,
    trend,
    peakUsd,
    peakBtc,
    drawdownUsd: round(ddUsd, 4),
    drawdownBtc: round(ddBtc, 4),
    cmeShare: last.cmeShare,
    cmeShare1y: prev365?.cmeShare ?? null,
    hyperliquidShare: last.hyperliquidShare,
    hyperliquidShare1y: prev365?.hyperliquidShare ?? null,
    headline
  };
}

function summarizeOptions(panel) {
  const valid = panel.filter(r => r.optFutRatio90d != null);
  const last = valid[valid.length - 1];
  if (!last) return null;
  const prev365 = rowOnOrBefore(valid, isoDate(Date.parse(last.date) - 365 * DAY_MS));
  const max = extremeOf(valid, 'optFutRatio90d', (a, b) => a > b);
  const f2 = v => (v == null ? '--' : v.toFixed(2));
  const headline = `期权 OI 相当于期货 OI 的 ${f2(last.optFutRatio90d)} 倍（90 日均值；一年前 ${f2(prev365?.optFutRatio90d)}，样本最高 ${f2(max.value)} @ ${max.date}；当日 ${f2(last.optFutRatio)}，季度交割前后单日值会大幅跳动）。期权占比越高，风险越多以对冲形式持有，去杠杆时被迫平掉的部分越少。`;
  return {
    date: last.date,
    ratio: last.optFutRatio,
    ratio90d: last.optFutRatio90d,
    ratio90d1y: prev365?.optFutRatio90d ?? null,
    optOiUsd: last.optOiUsd,
    optOiBtc: last.optOiBtc,
    max,
    headline
  };
}

function summarizeEtf(rows) {
  const valid = rows.filter(r => r.ratio20 != null);
  const last = valid[valid.length - 1];
  if (!last) return null;
  const ratios = valid.map(r => r.ratio20);
  const mean = ratios.reduce((s, v) => s + v, 0) / ratios.length;
  const regime = last.ratio20 >= ETF_REGIME_BAND ? 'INFLOW' : last.ratio20 <= -ETF_REGIME_BAND ? 'OUTFLOW' : 'TURNOVER';
  const regimeLabel = { INFLOW: '新钱净流入主导', OUTFLOW: '净赎回主导', TURNOVER: '以换手为主' }[regime];
  const max = extremeOf(valid, 'ratio20', (a, b) => a > b);
  const min = extremeOf(valid, 'ratio20', (a, b) => a < b);
  const headline = `近 ${ETF_WINDOW} 个交易日 ETF 净流入 ${fmtUsd(last.flow20Usd)}，占同期成交额 ${fmtPct(last.ratio20)}（样本均值 ${fmtPct(mean)}）：${regimeLabel}。`;
  return {
    date: last.date,
    ratio20: last.ratio20,
    flow20Usd: last.flow20Usd,
    volume20Usd: last.volume20Usd,
    mean: round(mean, 4),
    percentile: percentileRank(ratios, last.ratio20),
    regime,
    regimeLabel,
    max,
    min,
    headline
  };
}

// ---------------------------------------------------------------------------
// Data acquisition
// ---------------------------------------------------------------------------

async function fetchOiPanel() {
  recordAttempt('lev_oi', { now: Date.now() });
  try {
    const [futUsd, futBtc, optUsd, optBtc] = await Promise.all([
      callCoinglassEndpoint('/api/openInterest/v3/chart?symbol=BTC&timeType=0&exchangeName=&currency=USD&type=0'),
      callCoinglassEndpoint('/api/openInterest/v3/chart?symbol=BTC&timeType=0&exchangeName=&currency=COIN&type=0'),
      callCoinglassEndpoint('/api/option/oi/history?symbol=BTC&timeType=0&currency=USD'),
      callCoinglassEndpoint('/api/option/oi/history?symbol=BTC&timeType=0&currency=COIN')
    ]);
    const panel = buildOiPanel({ futUsd, futBtc, optUsd, optBtc });
    if (!panel.length) throw new Error('OI 面板为空');
    recordSuccess('lev_oi', {
      dataAsOf: futUsd.dateList[futUsd.dateList.length - 1],
      asOfKind: 'source',
      source: 'coinglass/oi-all-venues'
    });
    return panel;
  } catch (err) {
    recordFailure('lev_oi', err);
    throw err;
  }
}

async function fetchFundingRows() {
  recordAttempt('lev_funding', { now: Date.now() });
  try {
    const bars = await callCoinglassEndpoint('/api/priceAndIndicator?symbol=BTC&interval=h8&index=avg_fr_kline&limit=3000');
    const rows = parseFundingBars(bars);
    recordSuccess('lev_funding', {
      dataAsOf: rows[rows.length - 1].fundingTime,
      asOfKind: 'source',
      source: 'coinglass/avg_fr_kline'
    });
    return rows;
  } catch (err) {
    recordFailure('lev_funding', err);
    throw err;
  }
}

async function fetchEtfFlowRows() {
  recordAttempt('lev_etf_flow', { now: Date.now() });
  try {
    const flows = parseEtfFlows(await callCoinglassEndpoint('/api/etf/flow'));
    recordSuccess('lev_etf_flow', { dataAsOf: flows[flows.length - 1].date, asOfKind: 'source', source: 'coinglass/etf/flow' });
    return flows;
  } catch (err) {
    recordFailure('lev_etf_flow', err);
    throw err;
  }
}

async function fetchYahooDollarVolume(symbol) {
  const period1 = Math.floor(Date.parse(ETF_START) / 1000) - 7 * 86400;
  const period2 = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d`;
  const resp = await fetchWithTimeout(url, { headers: YAHOO_HEADERS });
  if (!resp.ok) throw new Error(`Yahoo ${symbol} HTTP ${resp.status}`);
  return parseYahooDollarVolume(await resp.json(), symbol);
}

/**
 * Dollar volume of every fund that appears in the flow list. A missing core fund fails the leg;
 * a missing small fund is dropped from both numerator and denominator and reported as an issue.
 */
async function fetchEtfVolumes(tickers) {
  recordAttempt('etf_volume', { now: Date.now() });
  try {
    const volumes = {};
    const missing = [];
    for (let i = 0; i < tickers.length; i += 4) {
      const batch = tickers.slice(i, i + 4);
      const results = await Promise.allSettled(batch.map(fetchYahooDollarVolume));
      results.forEach((r, j) => {
        if (r.status === 'fulfilled') volumes[batch[j]] = r.value;
        else missing.push({ ticker: batch[j], error: r.reason?.message || String(r.reason) });
      });
    }
    const missingCore = missing.filter(m => CORE_ETF_TICKERS.includes(m.ticker));
    if (missingCore.length) throw new Error(`核心 ETF 成交额缺失: ${missingCore.map(m => `${m.ticker} (${m.error})`).join('; ')}`);
    const asOf = CORE_ETF_TICKERS.map(t => [...volumes[t].keys()].pop()).sort()[0];
    recordSuccess('etf_volume', {
      dataAsOf: asOf,
      asOfKind: 'source',
      source: 'yahoo/chart',
      issues: missing.map(m => `${m.ticker} 成交额缺失，已从分子分母同时剔除`)
    });
    return { volumes, missing: missing.map(m => m.ticker) };
  } catch (err) {
    recordFailure('etf_volume', err);
    throw err;
  }
}

async function fetchEtfPanel() {
  const flows = await fetchEtfFlowRows();
  const tickers = [...new Set(flows.flatMap(f => Object.keys(f.funds)))].sort();
  const missingCoreFlow = CORE_ETF_TICKERS.filter(t => !tickers.includes(t));
  if (missingCoreFlow.length) throw new Error(`ETF 流量缺核心基金: ${missingCoreFlow.join(', ')}`);
  const { volumes, missing } = await fetchEtfVolumes(tickers);
  const rows = buildEtfTurnover(flows, volumes);
  if (!rows.some(r => r.ratio20 != null)) throw new Error(`ETF 成交额对齐后不足 ${ETF_WINDOW} 个交易日`);
  return { rows, tickers: { included: Object.keys(volumes).sort(), missing } };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function buildLeverageNorm(previous = null) {
  const [oiPanel, fundingRows] = await Promise.all([fetchOiPanel(), fetchFundingRows()]);
  const funding = buildFundingPremium(fundingRows, oiPanel);
  if (!funding.some(r => r.premium30dUsd != null)) throw new Error('资金费率与 OI 对齐后不足 30 天');

  // The ETF panel is ancillary: on failure the previous good panel is kept and flagged
  let etf = null;
  let etfError = null;
  try {
    etf = await fetchEtfPanel();
  } catch (err) {
    etfError = err.message;
    console.warn('[LeverageNorm] ETF panel unavailable:', err.message);
    if (previous?.etf?.rows?.length) etf = { ...previous.etf, stale: true };
  }

  const last = oiPanel[oiPanel.length - 1];
  return {
    schema: SCHEMA_VERSION,
    generatedAt: Date.now(),
    freshness: {
      oiLatest: last.date,
      fundingLatest: funding[funding.length - 1].date,
      etfLatest: etf?.rows?.length ? etf.rows[etf.rows.length - 1].date : null
    },
    summary: {
      funding: summarizeFunding(funding),
      oi: summarizeOi(oiPanel),
      options: summarizeOptions(oiPanel),
      etf: etf ? summarizeEtf(etf.rows) : null
    },
    oi: oiPanel,
    funding,
    etf,
    etfError,
    metadata: {
      sources: {
        oi: 'CoinGlass 全场所 BTC 期货 OI（USD / BTC 两口径）与期权 OI（Deribit、OKX、CME、Binance、Bybit）',
        funding: 'CoinGlass 全市场 OI 加权资金费率（8h bar）',
        etf: 'CoinGlass 美国现货 BTC ETF 日净流入 × Yahoo Finance 日成交量 × 收盘价'
      },
      method: [
        '覆盖校正：CoinGlass 的场所覆盖逐年扩大，原始加总在新场所纳入当天跳升。OI 序列做链式拼接，每日变化只用前后两日都有数据的场所，并以最新一日全场所合计为锚。',
        `资金溢价：每次结算的 OI 加权费率 × 当日永续 OI（全市场期货 OI 剔除 CME 近似），按日加总后滚动 ${PREMIUM_WINDOW_DAYS} 天求和；窗口内结算覆盖不足 90% 不出值。`,
        `ETF 流入/成交额：${ETF_WINDOW} 个交易日净流入 ÷ 同期成交额（成交量 × 收盘价），只计当日成交额可得的基金；±${ETF_REGIME_BAND * 100}% 为“流入/赎回主导”与“换手为主”的分界。`,
        `期权/期货：两边均按币计（链式拼接）后相除，剥离币价；期权 OI 在每个季度交割前堆高、交割后骤降，结论用 ${RATIO_AVG_DAYS} 日均值。`
      ],
      caveats: [
        '永续 OI 以期货 OI 剔除 CME 近似，含少量离岸交割合约，资金溢价的美元值略偏大。',
        '覆盖口径与 Glassnode 不同（这里含 MEXC、Gate 等长尾场所），期权/期货比的绝对水平不能直接对比其报告，看自身趋势。',
        '链式拼接假设新纳入场所在纳入前的持仓与已覆盖场所同比例变化；Hyperliquid 等新场所纳入前的真实增长因此被摊入历史。',
        'ETF 成交额用收盘价 × 成交量近似，不是成交均价；Glassnode 未披露其 ETF 成交额口径，流入/成交额的绝对水平同样只看自身分位。'
      ]
    }
  };
}

function readDiskCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const d = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (d && d.schema === SCHEMA_VERSION && Array.isArray(d.oi) && Array.isArray(d.funding) && Number.isFinite(d.generatedAt)) return d;
    }
  } catch (e) {
    console.warn('[LeverageNorm] Error reading cache:', e.message);
  }
  return null;
}

/** Seed honest disk clocks once — persisted receipts win; a file without them seeds nothing newer. */
function seedDiskOnce(disk) {
  if (diskSeeded || !disk) return;
  diskSeeded = true;
  const receipt = Number.isFinite(disk.generatedAt) ? new Date(disk.generatedAt).toISOString() : null;
  seedCachedHealth(disk, 'lev_oi', { dataAsOf: disk.freshness?.oiLatest || null, lastSuccessAt: receipt });
  seedCachedHealth(disk, 'lev_funding', { dataAsOf: disk.freshness?.fundingLatest || null, lastSuccessAt: receipt });
  const ancillary = { dataHealth: { sources: disk.ancillarySources || {} } };
  seedCachedHealth(ancillary, 'lev_etf_flow', {});
  seedCachedHealth(ancillary, 'etf_volume', {});
}

/** Single-flight: concurrent callers share one in-flight build. */
function getLeverageNormData(force = false) {
  if (inflight) return inflight;
  inflight = doGetLeverageNormData(force).finally(() => { inflight = null; });
  return inflight;
}

async function doGetLeverageNormData(force = false) {
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
  try {
    const data = await buildLeverageNorm(memoryCache || disk);
    // Bind the accepted payload to its own health snapshot so a later sibling fetch never
    // rejuvenates this copy's per-source clocks.
    const bound = withDataHealth(data, REQUIRED_IDS, ANCILLARY_IDS);
    memoryCache = bound;
    memoryCacheTime = now;
    try {
      atomicWriteJson(CACHE_FILE, bound, 0);
    } catch (e) {
      console.warn('[LeverageNorm] Error persisting cache:', e.message);
    }
    return bound;
  } catch (err) {
    console.error('[LeverageNorm] Build failed, using stale cache:', err.message);
    const fallback = memoryCache || disk || readDiskCache();
    if (fallback) {
      seedDiskOnce(fallback);
      return withDataHealth({ ...fallback, stale: true }, REQUIRED_IDS, ANCILLARY_IDS);
    }
    throw err;
  }
}

module.exports = {
  getLeverageNormData,
  parseVenuePayload,
  chainLink,
  buildOiPanel,
  parseFundingBars,
  buildFundingPremium,
  parseEtfFlows,
  parseYahooDollarVolume,
  buildEtfTurnover,
  summarizeFunding,
  summarizeOi,
  summarizeOptions,
  summarizeEtf,
  REQUIRED_IDS,
  ANCILLARY_IDS,
  CACHE_FILE
};
