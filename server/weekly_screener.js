'use strict';
/**
 * Weekly anomaly screener: which of the archived metrics moved most unusually this week, which
 * research angles that points to, and what is on the calendar. It proposes; the editor picks.
 *
 * For every metric the latest weekly move is ranked against the metric's own history of weekly
 * moves (percentile rank). Extremeness = |percentile − 50| × 2, so 0 = an ordinary week and
 * 100 = the largest move on record in either direction. The level is ranked the same way and
 * counts at 60%: a metric sitting at a record level is a story even in a quiet week.
 *
 * Modes:
 *   diff   change = v(t) − v(t − lag)
 *   pct    change = (v(t) / v(t − lag) − 1) × 100
 *   sum    change = Σ v over (t − lag, t]   (flows: the week's total against past weeks' totals)
 *   level  no change; only the level is ranked (irregular series such as weekly 8-K figures)
 *
 * Pure functions only; scripts/weekly_screener.js reads the archives and writes the report.
 */

const DAY_MS = 86400000;
const MIN_HISTORY = 60;          // fewer past weekly moves than this → ranking is tentative
const SHORT_HISTORY_WEIGHT = 0.5;
const LEVEL_WEIGHT = 0.6;
const LOOKUP_TOLERANCE_DAYS = 3; // t − lag may fall on a missing day (weekends, gaps)
const EVENT_BONUS = 10;
const EVENT_BONUS_CAP = 20;
const RECENCY_DAYS = 28;
const RECENCY_PENALTY = 25;

const dayMs = d => Date.parse(`${d}T00:00:00Z`);
const isoDay = ms => new Date(ms).toISOString().slice(0, 10);

/** Percentile rank of v in xs (0–100), ties counted half */
function percentileRank(xs, v) {
  if (!xs.length || v == null || !Number.isFinite(v)) return null;
  let below = 0;
  let equal = 0;
  for (const x of xs) {
    if (x < v) below++;
    else if (x === v) equal++;
  }
  return (below + equal / 2) / xs.length * 100;
}

const extremeness = pct => (pct == null ? null : Math.abs(pct - 50) * 2);

/** Clean, date-sorted, one value per day (last one wins) */
function normalizeSeries(series) {
  const byDate = new Map();
  for (const p of series || []) {
    if (!p || typeof p.date !== 'string' || p.value == null || !Number.isFinite(+p.value)) continue;
    byDate.set(p.date, +p.value);
  }
  return [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, value]) => ({ date, value }));
}

/** Value at the last point on or before `date`, at most `tol` days earlier */
function valueAtOrBefore(series, date, tol = LOOKUP_TOLERANCE_DAYS) {
  const t = dayMs(date);
  let lo = 0;
  let hi = series.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].date <= date) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (found < 0) return null;
  return t - dayMs(series[found].date) <= tol * DAY_MS ? series[found].value : null;
}

/** Weekly moves for every point that has a comparison point: [{date, change}] */
function changeSeries(series, mode, lag = 7) {
  const out = [];
  if (mode === 'level') return out;
  if (mode === 'sum') {
    let start = 0;
    let sum = 0;
    for (let i = 0; i < series.length; i++) {
      sum += series[i].value;
      const t = dayMs(series[i].date);
      while (dayMs(series[start].date) <= t - lag * DAY_MS) { sum -= series[start].value; start++; }
      // Only full windows: the first point must be at least lag − 1 days back
      if (dayMs(series[0].date) <= t - (lag - 1) * DAY_MS) out.push({ date: series[i].date, change: sum });
    }
    return out;
  }
  for (const p of series) {
    const prev = valueAtOrBefore(series, isoDay(dayMs(p.date) - lag * DAY_MS));
    if (prev == null) continue;
    if (mode === 'pct') {
      if (prev === 0) continue;
      out.push({ date: p.date, change: (p.value / prev - 1) * 100 });
    } else {
      out.push({ date: p.date, change: p.value - prev });
    }
  }
  return out;
}

/**
 * Rank one metric as of `cutoff` (YYYY-MM-DD).
 * def: {id, label, group, unit, mode, lag?, license?, maxAgeDays?}
 */
function analyzeMetric(def, rawSeries, cutoff) {
  const series = normalizeSeries(rawSeries).filter(p => p.date <= cutoff);
  const base = { id: def.id, label: def.label, group: def.group, unit: def.unit, mode: def.mode, license: def.license || 'ok' };
  if (!series.length) return { ...base, missing: true, score: null };
  const last = series[series.length - 1];
  const ageDays = (dayMs(cutoff) - dayMs(last.date)) / DAY_MS;
  const stale = ageDays > (def.maxAgeDays ?? 3);

  const levels = series.map(p => p.value);
  const levelPct = percentileRank(levels.slice(0, -1), last.value);
  let change = null;
  let changePct = null;
  let n = levels.length - 1;
  if (def.mode !== 'level') {
    const ch = changeSeries(series, def.mode, def.lag ?? 7);
    const cur = ch.length && ch[ch.length - 1].date === last.date ? ch[ch.length - 1] : null;
    n = ch.length - 1;
    if (cur) {
      change = cur.change;
      changePct = percentileRank(ch.slice(0, -1).map(c => c.change), cur.change);
    }
  }
  // A flow's "value" is the week's total, ranked among past weekly totals (not the last day)
  let value = last.value;
  let lvlPct = levelPct;
  if (def.mode === 'sum') {
    value = change;
    lvlPct = changePct;
  }
  const chgExt = extremeness(changePct);
  const lvlExt = extremeness(lvlPct);
  const short = n < MIN_HISTORY;
  const raw = def.mode === 'level' ? lvlExt : Math.max(chgExt ?? 0, (lvlExt ?? 0) * LEVEL_WEIGHT);
  const score = raw == null ? null : raw * (short ? SHORT_HISTORY_WEIGHT : 1);
  return {
    ...base, lastDate: last.date, value, change, changePct, levelPct: lvlPct,
    chgExt, lvlExt, score, n, short, stale, missing: false
  };
}

/** Last Friday 08:00 UTC of a month (Deribit monthly and quarterly expiry) */
function lastFriday(year, month) {
  const last = new Date(Date.UTC(year, month + 1, 0));
  const back = (last.getUTCDay() - 5 + 7) % 7;
  return isoDay(Date.UTC(year, month, last.getUTCDate() - back));
}

/**
 * Events within [cutoff, cutoff + horizon]: Deribit monthly / quarterly expiries, Strategy's
 * Monday 8-K, plus a hand-kept list [{date, title, tags}] (FOMC etc.).
 */
function buildCalendar(cutoff, horizonDays = 14, manual = [], { expiryShares = {} } = {}) {
  const from = dayMs(cutoff);
  const to = from + horizonDays * DAY_MS;
  const inWindow = d => dayMs(d) > from && dayMs(d) <= to;
  const ev = [];
  const c = new Date(from);
  for (let k = 0; k <= 2; k++) {
    const y = c.getUTCFullYear() + Math.floor((c.getUTCMonth() + k) / 12);
    const m = (c.getUTCMonth() + k) % 12;
    const d = lastFriday(y, m);
    if (!inWindow(d)) continue;
    const quarterly = m % 3 === 2;
    const share = expiryShares[d];
    ev.push({
      date: d,
      title: `Deribit ${quarterly ? '季度' : '月度'}期权与期货到期（08:00 UTC）${share != null ? `，占期权未平仓 ${share}%` : ''}`,
      tags: quarterly ? ['expiry', 'quarterly'] : ['expiry']
    });
  }
  for (let t = from + DAY_MS; t <= to; t += DAY_MS) {
    // Routine every week, so it is listed but earns no angle a bonus
    if (new Date(t).getUTCDay() === 1) ev.push({ date: isoDay(t), title: 'Strategy 每周 8-K（持仓、ATM、回购）', tags: ['routine'] });
  }
  for (const e of manual || []) if (e && e.date && inWindow(e.date)) ev.push({ date: e.date, title: e.title, tags: e.tags || [] });
  return ev.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Rank research angles. angle: {id, title, metrics:[ids], events?:[tags], method}
 * base = mean of the three highest metric scores among usable metrics
 *        (fresh, present; an angle with fewer than two usable metrics is skipped)
 * + EVENT_BONUS per matching event (capped), − RECENCY_PENALTY if used within RECENCY_DAYS.
 */
function scoreAngles(results, angles, events, log, cutoff) {
  const byId = new Map(results.map(r => [r.id, r]));
  const out = [];
  for (const a of angles) {
    const ms = a.metrics.map(id => byId.get(id)).filter(Boolean);
    const usable = ms.filter(m => !m.missing && !m.stale && m.score != null);
    if (usable.length < 2) continue;
    const ranked = [...usable].sort((x, y) => y.score - x.score);
    const top = ranked.slice(0, 3);
    const base = top.reduce((s, m) => s + m.score, 0) / top.length;
    const matched = events.filter(e => (a.events || []).some(t => e.tags.includes(t)));
    const bonus = Math.min(EVENT_BONUS_CAP, matched.length * EVENT_BONUS);
    const lastUse = (log || []).filter(l => l.angle === a.id && l.date <= cutoff).map(l => l.date).sort().pop() || null;
    const recent = lastUse && dayMs(cutoff) - dayMs(lastUse) < RECENCY_DAYS * DAY_MS;
    out.push({
      id: a.id, title: a.title, method: a.method,
      score: base + bonus - (recent ? RECENCY_PENALTY : 0),
      base, bonus, recentUse: recent ? lastUse : null,
      drivers: top, calm: ranked.length > 3 ? ranked.slice(-1) : [],
      events: matched,
      unusable: ms.filter(m => m.missing || m.stale).map(m => m.id),
      redLicense: usable.filter(m => m.license === 'red').map(m => m.id)
    });
  }
  return out.sort((x, y) => y.score - x.score);
}

/** Default research-angle library. Metric ids refer to scripts/weekly_screener.js definitions. */
const ANGLES = [
  { id: 'forced_flow', title: '这轮波动是被迫平仓还是主动交易？', metrics: ['funding_deribit', 'funding_premium30d', 'oi_fut_btc', 'blk_net_delta7', 'cb_d50', 'btc_ret'], method: '资金费与按币计 OI 同步下降说明杠杆在出清；大宗主动方净 Delta 与盘口撤单区分主动卖出与被动成交' },
  { id: 'who_sells', title: '卖压（或买盘）来自现货、衍生品还是机构？', metrics: ['cb_d50', 'cb_vol', 'cq_basis', 'funding_deribit', 'etf_flow20', 'cme_share'], method: '现货深度与成交、期货基差、ETF 净流入三条线分别看，哪条先动、哪条没动' },
  { id: 'expiry_map', title: '大额到期前的 Gamma 地图与钉住', metrics: ['gex', 'flip_gap', 'opt_oi_btc', 'rr7'], events: ['expiry'], method: '按行权价的 Gamma 分布、翻转位与最大痛点，到期后复盘价格是否被钉住' },
  { id: 'vol_pricing', title: '期权在为什么定价：方向、尾部还是整体波动？', metrics: ['iv1m', 'dvol', 'rr7', 'rr30', 'bf25', 'opt_fut_ratio'], method: '把 ATM、偏斜、蝶式分开看：偏斜动而 ATM 不动是方向保险，蝶式动是尾部' },
  { id: 'mstr_reflex', title: 'Strategy 的融资节奏与 mNAV 反身性', metrics: ['mstr_added', 'mstr_atm', 'strc_rep', 'btc_vs_cost', 'strc_close', 'junior_spread'], events: ['mstr'], method: '8-K 的 ATM、回购与增持三者对照 mNAV；优先股价格看资本结构压力' },
  { id: 'alt_breadth', title: '山寨币与 BTC 的分化', metrics: ['pct_above_200', 'med_dd', 'ramo7', 'btc_ret'], method: '等权与市值加权、200 日线占比、回撤中位数，判断下跌是否集中在长尾' },
  { id: 'carry_window', title: 'carry 窗口：基差相对美债', metrics: ['cq_basis', 'nq_excess', 'funding_deribit', 'tbill'], events: ['quarterly'], method: 'carry 回测规则的当前状态，基差与美债的差距，交割前后的展期' },
  { id: 'macro_rates', title: '短端利率与流动性向加密的传导', metrics: ['us1y', 'us10y', 'yield_spread', 'net_liq', 'btc_ret'], events: ['fomc', 'macro'], method: '短端收益率、曲线形态、净流动性与 BTC 的同步性，事件前后对比' },
  { id: 'hard_asset', title: 'BTC 与黄金：硬资产叙事是否成立', metrics: ['gold_corr', 'btc_gold_ratio', 'us10y'], method: '相关系数的方向分解（同涨还是同跌）与比价，长端利率作对照' },
  { id: 'block_case', title: '本周最大的大宗结构拆解', metrics: ['blk_gross7', 'blk_net_delta7', 'blk_put_share'], events: ['expiry'], method: '挑一笔最大结构：腿、主动方、盈亏区间、到期情景，并跟踪到到期' },
  { id: 'spot_liquidity', title: '现货盘口的流动性状态', metrics: ['cb_d10', 'cb_d50', 'cb_spread', 'cb_vol'], method: '近端与深层挂单分开、按币计与按美元计分开，看做市商是否撤单' },
  { id: 'stablecoin', title: '稳定币购买力与场外资金', metrics: ['stable_cap', 'ssr'], method: '稳定币总市值与 SSR 的变化，资金是在场外等待还是离场' }
];

module.exports = {
  MIN_HISTORY, RECENCY_DAYS, RECENCY_PENALTY, EVENT_BONUS, EVENT_BONUS_CAP, ANGLES,
  percentileRank, extremeness, normalizeSeries, valueAtOrBefore, changeSeries,
  analyzeMetric, lastFriday, buildCalendar, scoreAngles
};
