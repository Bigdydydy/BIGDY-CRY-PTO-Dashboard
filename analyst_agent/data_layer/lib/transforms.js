/**
 * Pure transform functions over ascending series [{ date: 'YYYY-MM-DD', value }].
 * Names match the `transforms` lists in methodology/indicators.json. Each transform returns a plain
 * object (or number) and throws when the series is too short, so the snapshot can report why a value is missing.
 */

const DAY_MS = 86400000;

function last(series) {
  if (!series || !series.length) throw new Error('empty series');
  return series[series.length - 1];
}

function truncate(series, asof) {
  if (!asof) return series;
  let hi = series.length;
  while (hi > 0 && series[hi - 1].date > asof) hi--;
  return series.slice(0, hi);
}

function shiftDate(date, n, unit) {
  const d = new Date(date + 'T00:00:00Z');
  if (unit === 'd') d.setUTCDate(d.getUTCDate() - n);
  else if (unit === 'w') d.setUTCDate(d.getUTCDate() - 7 * n);
  else if (unit === 'm') d.setUTCMonth(d.getUTCMonth() - n);
  else if (unit === 'y') d.setUTCFullYear(d.getUTCFullYear() - n);
  else throw new Error('bad unit ' + unit);
  return d.toISOString().slice(0, 10);
}

/** Last observation dated on or before `date`. */
function valueAtOrBefore(series, date) {
  let lo = 0;
  let hi = series.length - 1;
  let found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].date <= date) {
      found = series[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

function windowSince(series, date) {
  return series.filter(o => o.date > date);
}

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function std(xs) {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length);
}

function round(v, dp = 4) {
  if (v == null || !Number.isFinite(v)) return null;
  const f = Math.pow(10, dp);
  return Math.round(v * f) / f;
}

function lastN(series, n) {
  if (series.length < n) throw new Error('need ' + n + ' observations, have ' + series.length);
  return series.slice(series.length - n);
}

/** chg_{N}{d|w|m|y}[_bp|_pct]: change between the latest value and the value N calendar units earlier. */
function change(series, n, unit, mode) {
  const cur = last(series);
  const base = valueAtOrBefore(series, shiftDate(cur.date, n, unit));
  if (!base) throw new Error('no observation ' + n + unit + ' before ' + cur.date);
  let v;
  if (mode === 'bp') v = (cur.value - base.value) * 100;
  else if (mode === 'pct') v = (cur.value / base.value - 1) * 100;
  else v = cur.value - base.value;
  return { value: round(v, mode === 'bp' ? 1 : 4), from: base.date, from_value: base.value };
}

function sma(series, n) {
  return mean(lastN(series, n).map(o => o.value));
}

/** Last observation of each ISO week (weeks keyed by their Monday). */
function weekly(series) {
  const byWeek = new Map();
  for (const o of series) {
    const d = new Date(o.date + 'T00:00:00Z');
    const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
    byWeek.set(monday, o);
  }
  return [...byWeek.values()];
}

function vsSma(series, n) {
  const s = sma(series, n);
  const cur = last(series).value;
  return { value: round((cur / s - 1) * 100, 2), sma: round(s, 4) };
}

function daysBelowSma(series, n) {
  if (series.length < n) throw new Error('need ' + n + ' observations');
  let count = 0;
  for (let end = series.length; end >= n; end--) {
    const win = series.slice(end - n, end);
    const s = mean(win.map(o => o.value));
    if (win[win.length - 1].value < s) count++;
    else break;
  }
  return { value: count };
}

function drawdown(series) {
  const cur = last(series);
  const yearAgo = shiftDate(cur.date, 1, 'y');
  const win1y = series.filter(o => o.date > yearAgo);
  const high1y = win1y.reduce((a, b) => (b.value > a.value ? b : a));
  const highAll = series.reduce((a, b) => (b.value > a.value ? b : a));
  return {
    value: round((cur.value / high1y.value - 1) * 100, 2),
    high_1y: high1y.value,
    high_1y_date: high1y.date,
    from_history_high_pct: round((cur.value / highAll.value - 1) * 100, 2),
    history_high_date: highAll.date
  };
}

function percentile(series, years) {
  const cur = last(series);
  const win = windowSince(series, shiftDate(cur.date, years, 'y')).map(o => o.value);
  if (win.length < 20) throw new Error('window too short for percentile');
  const below = win.filter(v => v < cur.value).length;
  const equal = win.filter(v => v === cur.value).length;
  return { value: round(((below + 0.5 * equal) / win.length) * 100, 1), window_obs: win.length };
}

function zscore(series, years) {
  const cur = last(series);
  const win = windowSince(series, shiftDate(cur.date, years, 'y')).map(o => o.value);
  if (win.length < 20) throw new Error('window too short for zscore');
  const s = std(win);
  return { value: s === 0 ? 0 : round((cur.value - mean(win)) / s, 2) };
}

function yoy(series) {
  return change(series, 12, 'm', 'pct');
}

function momPct(series) {
  const [prev, cur] = lastN(series, 2);
  return { value: round((cur.value / prev.value - 1) * 100, 3), from: prev.date };
}

function momChange(series) {
  const [prev, cur] = lastN(series, 2);
  return { value: round(cur.value - prev.value, 2), from: prev.date };
}

function momAnnualized3m(series) {
  const win = lastN(series, 4);
  return { value: round((Math.pow(win[3].value / win[0].value, 4) - 1) * 100, 2), from: win[0].date };
}

function avgChange(series, n) {
  const win = lastN(series, n + 1);
  return { value: round((win[n].value - win[0].value) / n, 2), from: win[0].date };
}

function avgLast(series, n) {
  return { value: round(mean(lastN(series, n).map(o => o.value)), 2) };
}

/** OLS slope per observation over the last n points. */
function slope(series, n) {
  const ys = lastN(series, n).map(o => o.value);
  const xm = (n - 1) / 2;
  const ym = mean(ys);
  let num = 0;
  let den = 0;
  ys.forEach((y, i) => {
    num += (i - xm) * (y - ym);
    den += (i - xm) * (i - xm);
  });
  return { value: round(num / den, 6), per: 'observation' };
}

/** Sahm-rule style gap: 3-month average unemployment minus its low over the prior 12 months. */
function sahm(series) {
  if (series.length < 15) throw new Error('need 15 monthly observations');
  const avg3 = [];
  for (let i = 2; i < series.length; i++) avg3.push(mean(series.slice(i - 2, i + 1).map(o => o.value)));
  const cur = avg3[avg3.length - 1];
  const prior = avg3.slice(-13, -1);
  return { value: round(cur - Math.min(...prior), 2) };
}

/** Inner-join two series by date. */
function align(a, b) {
  const mb = new Map(b.map(o => [o.date, o.value]));
  return a.filter(o => mb.has(o.date)).map(o => ({ date: o.date, a: o.value, b: mb.get(o.date) }));
}

/** Multi-series alignment taking equal-weighted mean across available observations. */
function alignMean(seriesList, mode = 'date') {
  if (!seriesList || !seriesList.length) return [];
  if (seriesList.length === 1) return seriesList[0];
  const keyFn = mode === 'month' ? (d => d.slice(0, 7)) : (d => d);
  const byKey = new Map();
  for (const s of seriesList) {
    if (!Array.isArray(s)) continue;
    for (const o of s) {
      if (!o || o.value == null || isNaN(o.value)) continue;
      const k = keyFn(o.date);
      if (!byKey.has(k)) byKey.set(k, { dates: [], values: [] });
      const b = byKey.get(k);
      b.dates.push(o.date);
      b.values.push(o.value);
    }
  }
  const out = [];
  const sortedKeys = [...byKey.keys()].sort();
  for (const k of sortedKeys) {
    const { dates, values } = byKey.get(k);
    if (!values.length) continue;
    dates.sort();
    const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
    out.push({ date: dates[dates.length - 1], value: round(avg, 4) });
  }
  return out;
}

function ratioSeries(a, b) {
  return align(a, b).map(o => ({ date: o.date, value: o.a / o.b }));
}

function correlation(xs, ys) {
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) * (xs[i] - mx);
    syy += (ys[i] - my) * (ys[i] - my);
  }
  return sxy / Math.sqrt(sxx * syy);
}

/**
 * Rolling correlation of daily changes: `aMode`/`bMode` pick 'pct' (returns) or 'diff' (level changes,
 * e.g. yields). Returns a series so the snapshot can take its level and historical percentile.
 */
function rollingChangeCorrelation(a, b, window, aMode = 'pct', bMode = 'diff') {
  const joined = align(a, b);
  const d = [];
  for (let i = 1; i < joined.length; i++) {
    const ca = aMode === 'pct' ? joined[i].a / joined[i - 1].a - 1 : joined[i].a - joined[i - 1].a;
    const cb = bMode === 'pct' ? joined[i].b / joined[i - 1].b - 1 : joined[i].b - joined[i - 1].b;
    d.push({ date: joined[i].date, a: ca, b: cb });
  }
  const out = [];
  for (let end = window; end <= d.length; end++) {
    const win = d.slice(end - window, end);
    const r = correlation(win.map(o => o.a), win.map(o => o.b));
    if (Number.isFinite(r)) out.push({ date: win[win.length - 1].date, value: r });
  }
  return out;
}

/**
 * Curve regime from weekly changes in 2y and 10y yields (bp).
 * Moves under 3bp in both legs are reported as 'flat' to avoid labelling noise; legs moving
 * in opposite directions by 3bp+ each are a 'twist'.
 */
function curveRegime(chg2y, chg10y) {
  if (Math.abs(chg2y) < 3 && Math.abs(chg10y) < 3) return 'flat';
  const steepening = chg10y - chg2y > 0;
  if (Math.abs(chg2y) >= 3 && Math.abs(chg10y) >= 3 && Math.sign(chg2y) !== Math.sign(chg10y)) {
    return steepening ? 'twist_steepener' : 'twist_flattener';
  }
  const avg = (chg2y + chg10y) / 2;
  if (avg >= 0) return steepening ? 'bear_steepener' : 'bear_flattener';
  return steepening ? 'bull_steepener' : 'bull_flattener';
}

/**
 * Implied forward yield between maturities m1 < m2 (years).
 * Uses discrete compounding:
 *   ( (1 + y2/100)^m2 / (1 + y1/100)^m1 )^(1 / (m2 - m1)) - 1
 * When method === 'linear' or if yields are extreme, falls back to linear approximation.
 */
function forwardYield(y1, m1, y2, m2, method = 'compound') {
  if (method === 'linear') {
    return (y2 * m2 - y1 * m1) / (m2 - m1);
  }
  const r1 = y1 / 100;
  const r2 = y2 / 100;
  if (r1 <= -1 || r2 <= -1) {
    return (y2 * m2 - y1 * m1) / (m2 - m1);
  }
  const ratio = Math.pow(1 + r2, m2) / Math.pow(1 + r1, m1);
  if (ratio <= 0) return (y2 * m2 - y1 * m1) / (m2 - m1);
  const f = Math.pow(ratio, 1 / (m2 - m1)) - 1;
  return round(f * 100, 4);
}

/**
 * Brooks-style oil supply disruption implied by a price rise: price_rise% * elasticity = share of
 * global supply that must be destroyed on the demand side for the market to clear.
 */
function impliedOilDisruption(price, baseline, elasticity, globalSupplyMbd) {
  const rise = price / baseline - 1;
  const share = rise * elasticity;
  return { price_rise_pct: round(rise * 100, 1), implied_share_of_supply_pct: round(share * 100, 2), implied_mbd: round(share * globalSupplyMbd, 2) };
}

const PARAM_RE = /^chg_(\d+)([dwmy])(?:_(bp|pct))?$/;
const SMA_RE = /^vs_sma(\d+)$/;
const SLOPE_RE = /^slope_(\d+)([dwmy])?$/;

/**
 * Single-series transforms keyed by name. Cross-series transforms (curve_regime, rel_to_spx, ...) live in
 * snapshot.js because they need other indicators.
 */
function applySeriesTransform(name, series) {
  const m = name.match(PARAM_RE);
  if (m) return change(series, parseInt(m[1], 10), m[2], m[3]);
  if (name === 'vs_sma50w') return vsSma(weekly(series), 50);
  const sm = name.match(SMA_RE);
  if (sm) return vsSma(series, parseInt(sm[1], 10));
  const sl = name.match(SLOPE_RE);
  if (sl) return slope(series, parseInt(sl[1], 10));
  switch (name) {
    case 'level': {
      const o = last(series);
      return { value: o.value, date: o.date };
    }
    case 'days_below_sma200': return daysBelowSma(series, 200);
    case 'drawdown_from_high': return drawdown(series);
    case 'percentile_1y': return percentile(series, 1);
    case 'percentile_10y': return percentile(series, 10);
    case 'zscore_1y': return zscore(series, 1);
    case 'yoy': return yoy(series);
    case 'mom': return momPct(series);
    case 'mom_change': return momChange(series);
    case 'mom_annualized_3m': return momAnnualized3m(series);
    case 'avg_3m_change': return avgChange(series, 3);
    case 'avg_4w': return avgLast(series, 4);
    case 'slope_4w': return slope(series, 4);
    case 'slope_20d': return slope(series, 20);
    case 'sahm': return sahm(series);
    default: return undefined;
  }
}

module.exports = {
  truncate,
  shiftDate,
  valueAtOrBefore,
  change,
  sma,
  weekly,
  vsSma,
  daysBelowSma,
  drawdown,
  percentile,
  zscore,
  yoy,
  sahm,
  slope,
  align,
  alignMean,
  ratioSeries,
  rollingChangeCorrelation,
  curveRegime,
  forwardYield,
  impliedOilDisruption,
  applySeriesTransform,
  round,
  last
};
