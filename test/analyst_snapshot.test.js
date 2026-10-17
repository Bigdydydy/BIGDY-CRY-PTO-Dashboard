const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const T = require('../analyst_agent/data_layer/lib/transforms');
const { buildComposite, crossTransform, summarizeAuctions } = require('../analyst_agent/data_layer/lib/snapshot');
const { parseArgs } = require('../analyst_agent/data_layer/fetch_snapshot');

function daily(start, values) {
  const d = new Date(start + 'T00:00:00Z');
  return values.map((value, i) => ({ date: new Date(d.getTime() + i * 86400000).toISOString().slice(0, 10), value }));
}

function monthly(startYear, values) {
  return values.map((value, i) => {
    const y = startYear + Math.floor(i / 12);
    const m = String((i % 12) + 1).padStart(2, '0');
    return { date: y + '-' + m + '-01', value };
  });
}

describe('series helpers', () => {
  test('truncate drops observations after asof (no look-ahead)', () => {
    const s = daily('2026-01-01', [1, 2, 3, 4, 5]);
    assert.deepEqual(T.truncate(s, '2026-01-03').map(o => o.value), [1, 2, 3]);
    assert.equal(T.truncate(s, '2025-12-31').length, 0);
  });

  test('valueAtOrBefore steps back over gaps', () => {
    const s = [{ date: '2026-01-02', value: 1 }, { date: '2026-01-05', value: 2 }];
    assert.equal(T.valueAtOrBefore(s, '2026-01-04').value, 1);
    assert.equal(T.valueAtOrBefore(s, '2026-01-01'), null);
  });

  test('chg transforms in bp, pct and level units', () => {
    const s = daily('2026-01-01', [4.0, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.75]);
    assert.equal(T.applySeriesTransform('chg_1w_bp', s).value, 75);
    assert.equal(T.applySeriesTransform('chg_1d_pct', s).value, T.round((4.75 / 4.6 - 1) * 100));
    assert.equal(T.applySeriesTransform('chg_7d', s).value, 0.75);
  });

  test('yoy and annualized 3m on monthly index', () => {
    const s = monthly(2025, Array.from({ length: 13 }, (_, i) => 100 * Math.pow(1.0025, i)));
    assert.equal(Math.round(T.applySeriesTransform('yoy', s).value * 100) / 100, Math.round((Math.pow(1.0025, 12) - 1) * 10000) / 100);
    assert.equal(Math.round(T.applySeriesTransform('mom_annualized_3m', s).value * 100) / 100, Math.round((Math.pow(1.0025, 12) - 1) * 10000) / 100);
  });

  test('vs_sma200 and days_below_sma200 need 200 observations', () => {
    assert.throws(() => T.applySeriesTransform('vs_sma200', daily('2026-01-01', [1, 2, 3])));
    const rising = daily('2025-01-01', Array.from({ length: 220 }, (_, i) => 100 + i));
    const falling = rising.concat(daily('2025-08-09', [100, 99, 98]));
    assert.ok(T.applySeriesTransform('vs_sma200', rising).value > 0);
    assert.equal(T.applySeriesTransform('days_below_sma200', falling).value, 3);
  });

  test('drawdown measures from the trailing 1y high', () => {
    const s = daily('2026-01-01', [100, 120, 90, 96]);
    const dd = T.drawdown(s);
    assert.equal(dd.value, -20);
    assert.equal(dd.high_1y_date, '2026-01-02');
  });

  test('sahm gap: 3m average minus prior 12m low', () => {
    const u = monthly(2025, [4.0, 4.0, 4.0, 4.0, 4.0, 4.0, 4.0, 4.0, 4.0, 4.0, 4.0, 4.0, 4.3, 4.6, 4.9]);
    assert.equal(T.sahm(u).value, 0.6);
  });
});

describe('methodology-specific calculations', () => {
  test('curve regime labels', () => {
    assert.equal(T.curveRegime(5, 16), 'bear_steepener');
    assert.equal(T.curveRegime(13, 2), 'bear_flattener');
    assert.equal(T.curveRegime(-20, -5), 'bull_steepener');
    assert.equal(T.curveRegime(-4, -12), 'bull_flattener');
    assert.equal(T.curveRegime(-9, 6), 'twist_steepener');
    assert.equal(T.curveRegime(1, -2), 'flat');
  });

  test('10y10y forward from 10y and 20y yields', () => {
    assert.equal(T.round(T.forwardYield(5.17, 10, 5.6, 20), 3), 6.03);
  });

  test('Brooks oil model: +60% at elasticity 0.15 implies ~9.5 mb/d of 105', () => {
    const r = T.impliedOilDisruption(110.4, 69, 0.15, 105);
    assert.equal(r.price_rise_pct, 60);
    assert.equal(r.implied_share_of_supply_pct, 9);
    assert.equal(r.implied_mbd, 9.45);
  });

  test('rolling correlation of returns vs yield changes', () => {
    const a = daily('2026-01-01', [100, 101, 99, 102, 103, 101, 104]);
    const b = daily('2026-01-01', [4.0, 4.01, 3.99, 4.02, 4.03, 4.01, 4.04]);
    const c = T.rollingChangeCorrelation(a, b, 5);
    assert.equal(c.length, 2);
    assert.ok(c[c.length - 1].value > 0.99);
  });

  test('net liquidity composite steps daily RRP onto weekly dates', () => {
    const ind = { composite: { type: 'net_liquidity', inputs: { walcl: { provider: 'fred', series: 'W' }, tga: { provider: 'fred', series: 'T' }, rrp: { provider: 'fred', series: 'R' } } } };
    const data = {
      'fred:W': [{ date: '2026-09-30', value: 6743031 }],
      'fred:T': [{ date: '2026-09-30', value: 948674 }],
      'fred:R': [{ date: '2026-09-29', value: 1.5 }, { date: '2026-10-01', value: 99 }]
    };
    const s = buildComposite(ind, src => data[src.provider + ':' + src.series]);
    assert.equal(T.round(s[0].value, 4), T.round(6.743031 - 0.948674 - 0.0015, 4));
  });

  test('share_of_nominal_move: real-rate share of the 10y move', () => {
    const dates = daily('2026-06-01', Array.from({ length: 100 }, () => 0)).map(o => o.date);
    const nominal = dates.map((date, i) => ({ date, value: 4 + i * 0.01 }));
    const real = dates.map((date, i) => ({ date, value: 1.8 + i * 0.009 }));
    const ctx = { series: new Map([['UST10Y', nominal]]), params: {} };
    const r = crossTransform('share_of_nominal_move', { id: 'REAL10Y' }, real, ctx);
    assert.equal(r.share_4w, 0.9);
  });

  test('VIX divergence: SPX 20-day low without a VIX 20-day high', () => {
    const spx = daily('2026-01-01', Array.from({ length: 20 }, (_, i) => 100 - i * 0.1).concat([90]));
    const vix = daily('2026-01-01', Array.from({ length: 20 }, (_, i) => (i === 5 ? 30 : 20)).concat([25]));
    const r = crossTransform('divergence_vs_spx', { id: 'VIX' }, vix, { series: new Map([['SPX', spx]]), params: {} });
    assert.equal(r.value, true);
  });

  test('auction summary compares latest with prior six of the same term', () => {
    const rows = [1, 2, 3, 4, 5, 6, 7].map(i => ({
      date: '2026-0' + i + '-15', term: '5-Year', high_yield: 4 + i / 10, bid_to_cover: i === 7 ? 2.2 : 2.4,
      indirect_share: 0.65, dealer_share: i === 7 ? 0.2 : 0.15, soma_accepted: 0
    }));
    const s = summarizeAuctions(rows, '2026-12-31')['5-Year'];
    assert.equal(s.date, '2026-07-15');
    assert.equal(s.bid_to_cover_vs_avg6, -0.2);
    assert.equal(s.dealer_share_vs_avg6, 0.05);
    assert.equal(summarizeAuctions(rows, '2026-03-31')['5-Year'].date, '2026-03-15');
  });
});

describe('CLI args', () => {
  test('parses asof, event and lens', () => {
    const a = parseArgs(['--asof', '2026-09-25', '--event', '2026-02-27', '--lens', 'esther,brooks']);
    assert.equal(a.asof, '2026-09-25');
    assert.deepEqual(a.lens, ['esther', 'brooks']);
    assert.throws(() => parseArgs(['--asof', '09/25/2026']));
  });
});

describe('key level distance', () => {
  const { crossTransform } = require('../analyst_agent/data_layer/lib/snapshot');
  const s = [{ date: '2026-10-15', value: 4200 }];
  test('price indicators get a % distance, rate indicators a bp distance', () => {
    const ctx = { series: new Map(), params: { key_levels: { GOLD: [4000], UST10Y: [5.35] } } };
    assert.deepEqual(crossTransform('distance_to_key_level_bp', { id: 'GOLD', unit: 'USD/oz' }, s, ctx).value, [{ level: 4000, distance_pct: 5 }]);
    assert.deepEqual(crossTransform('distance_to_key_level_bp', { id: 'UST10Y', unit: '%' }, [{ date: '2026-10-15', value: 5.19 }], ctx).value, [{ level: 5.35, distance_bp: -16 }]);
  });
});
