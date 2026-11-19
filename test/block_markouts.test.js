const test = require('node:test');
const assert = require('node:assert/strict');
const mo = require('../server/block_markouts');
const mh = require('../server/option_marks_history');

const near = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

test('impliedVol inverts bsUSD', () => {
  const p = mo.bsUSD(80000, 90000, 0.25, 0.55, true);
  near(mo.impliedVol(p, 80000, 90000, 0.25, true), 0.55, 1e-6);
  assert.equal(mo.impliedVol(1, 80000, 70000, 0.25, true), null); // below intrinsic
});

test('hedgePnlUSD: a short inverse perpetual loses like short BTC', () => {
  near(mo.hedgePnlUSD({ instrument: 'BTC-PERPETUAL', direction: 'sell', amount: 800000, price: 80000 }, 88000), -80000, 1e-6);
  near(mo.hedgePnlUSD({ instrument: 'BTC_USDC-PERPETUAL', direction: 'buy', amount: 2, price: 80000 }, 81000), 2000, 1e-9);
});

test('markoutAt splits total P&L into directional and vol parts, with hedges and expiry settlement', () => {
  const I = 'BTC-25DEC26-80000-C';
  const ts = Date.parse('2026-11-01T12:00:00Z');
  const day7 = mh.closeDayOf(ts + 7 * 86400000);
  const day1 = mh.closeDayOf(ts + 86400000);
  const closeTs = mh.closeTsOf(day7);
  const history = {
    [day1]: { closeTs: mh.closeTsOf(day1), index: 80000, marks: { [I]: [0.05, mh.closeTsOf(day1), 80000] } },
    [day7]: { closeTs, index: 88000, marks: { [I]: [0.1, closeTs, 88000] } }
  };
  const s = {
    ts, entrySpot: 80000, notionalUSD: 8e6, netDeltaUSD: 50 * 80000, netVegaUSD: 10000,
    legs: [{ instrument: I, direction: 'buy', amount: 100, price: 0.05 }], hedges: []
  };
  const m = mo.markoutAt(s, 7, history, {});
  // 100 × (0.1 × 88000 − 0.05 × 80000) = 480,000
  assert.equal(m.totalUSD, 480000);
  assert.equal(m.directionalUSD, 400000); // 50 BTC × 8000
  assert.equal(m.volUSD, 80000);
  // vol points are normalised by the gross vega priced from the entry premium
  const gv = mo.grossVegaUSD(s);
  assert.ok(gv > 0);
  near(m.volPoints, 80000 / gv, 0.01);
  assert.equal(m.totalBps, 600);
  // A short-perp hedge of 50 BTC removes the directional part from the total
  const hedged = { ...s, netDeltaUSD: 0, hedges: [{ instrument: 'BTC-PERPETUAL', direction: 'sell', amount: 4000000, price: 80000 }] };
  const mh7 = mo.markoutAt(hedged, 7, history, {});
  assert.equal(mh7.totalUSD, 80000);
  assert.equal(mh7.directionalUSD, 0);
  // Missing marks -> no markout
  assert.equal(mo.markoutAt({ ...s, legs: [{ instrument: 'BTC-25DEC26-99000-C', direction: 'buy', amount: 1, price: 0.01 }] }, 7, history, {}), null);
  // An option that expired before the valuation day is worth its intrinsic value at delivery
  const expired = { ...s, legs: [{ instrument: 'BTC-6NOV26-75000-C', direction: 'buy', amount: 10, price: 0.05 }] };
  const me = mo.markoutAt(expired, 7, history, { '2026-11-06': 85000 });
  assert.equal(me.totalUSD, 10 * (10000 - 0.05 * 80000));
});

test('stale marks are repriced to the closing index through implied vol', () => {
  const I = 'BTC-25DEC26-80000-C';
  const ts = Date.parse('2026-11-01T12:00:00Z');
  const day = mh.closeDayOf(ts + 86400000);
  const closeTs = mh.closeTsOf(day);
  const obsTs = closeTs - 6 * 3600000;
  const exp = Date.parse('2026-12-25T08:00:00Z');
  const Y = 365.25 * 86400000;
  const markObs = mo.bsUSD(78000, 80000, (exp - obsTs) / Y, 0.5, true) / 78000;
  const history = { [day]: { closeTs, index: 82000, marks: { [I]: [markObs, obsTs, 78000] } } };
  const v = mo.legValueUSD({ instrument: I }, day, history, {});
  near(v.usd, mo.bsUSD(82000, 80000, (exp - closeTs) / Y, 0.5, true), 1e-3);
});

test('clusteredStats averages within a trade day before computing t', () => {
  const rows = [
    { day: 'a', v: 10 }, { day: 'a', v: 10 }, { day: 'a', v: 10 }, { day: 'a', v: 10 },
    { day: 'b', v: -2 },
    { day: 'c', v: 4 }
  ];
  const s = mo.clusteredStats(rows);
  assert.equal(s.days, 3);
  assert.equal(s.n, 6);
  near(s.mean, 4, 1e-9); // (10 − 2 + 4) / 3, not (40 − 2 + 4) / 6
  assert.ok(s.t < 2);
  const fams = mo.summarizeMarkouts([], ['bull', 'long-vol']);
  assert.equal(fams.bull.primaryMetric, 'totalBps');
  assert.equal(fams['long-vol'].primaryMetric, 'volPoints');
  assert.equal(fams.bull.signal, 'insufficient');
});

test('winsorised stats keep one tiny-vega outlier from driving the mean', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ day: `d${i}`, v: (i % 2 ? 1 : -1) }));
  rows.push({ day: 'd40', v: 500 });
  const raw = mo.clusteredStats(rows);
  const w = mo.clusteredStats(rows, { winsor: 0.05 });
  assert.ok(raw.mean > 10);
  assert.ok(Math.abs(w.mean) < 0.2);
  assert.equal(w.median, 1); // 20 × −1, 20 × +1, one outlier: the 21st value
});
