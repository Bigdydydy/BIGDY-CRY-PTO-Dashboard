const test = require('node:test');
const assert = require('node:assert/strict');
const BI = require('../server/block_insight.js');

const H = 3600 * 1000;
const D = 24 * H;
const now = Date.UTC(2026, 9, 8, 4, 0); // 2026-10-08 04:00 UTC -> OI day 2026-10-07
const trade = (inst, direction, amount, ts, extra = {}) => ({
  trade_id: `${inst}-${ts}-${direction}`, instrument_name: inst, direction, amount, price: 0.02, iv: 45, index_price: 80000, timestamp: ts, ...extra
});

test('aggregateTrades: one row per OI day × instrument, with completeness', () => {
  const days = BI.aggregateTrades([
    trade('BTC-30OCT26-95000-C', 'buy', 10, Date.UTC(2026, 9, 6, 9)),
    trade('BTC-30OCT26-95000-C', 'sell', 4, Date.UTC(2026, 9, 7, 7)),   // still OI day 10-06 (before 08:00)
    trade('BTC-30OCT26-95000-C', 'buy', 2, Date.UTC(2026, 9, 7, 9)),    // OI day 10-07 (in progress)
    trade('BTC-30OCT26-80000-P', 'sell', 5, Date.UTC(2026, 9, 6, 10))
  ], Date.UTC(2026, 9, 6, 8), now);
  assert.deepEqual(Object.keys(days).sort(), ['2026-10-06', '2026-10-07']);
  assert.equal(days['2026-10-06'].complete, true);
  assert.equal(days['2026-10-07'].complete, false);
  const call = days['2026-10-06'].rows.find(r => r.isCall);
  assert.equal(call.buyQty, 10);
  assert.equal(call.sellQty, 4);
  assert.equal(call.count, 2);
  assert.ok(call.netDeltaUSD > 0);
  assert.equal(call.netPremiumUSD, 0.02 * 6 * 80000);
  // Coverage starting after the day began -> incomplete
  assert.equal(BI.aggregateTrades([trade('BTC-30OCT26-95000-C', 'buy', 1, Date.UTC(2026, 9, 6, 9))], Date.UTC(2026, 9, 6, 8, 30), now)['2026-10-06'].complete, false);
});

test('encodeDaily / decodeDaily round-trip and mergeDaily precedence', () => {
  const days = BI.aggregateTrades([
    trade('BTC-30OCT26-95000-C', 'buy', 10, Date.UTC(2026, 9, 6, 9)),
    trade('BTC-27NOV26-90000-C', 'sell', 3, Date.UTC(2026, 9, 6, 9))
  ], 0, now);
  assert.deepEqual(BI.decodeDaily(JSON.parse(JSON.stringify(BI.encodeDaily(days)))), days);

  const row = n => ({ expiry: '30OCT26', strike: 95000, isCall: true, buyQty: n, sellQty: 0, netDeltaUSD: 0, netVegaUSD: 0, netPremiumUSD: 0, grossUSD: 0, count: n });
  const committed = { a: { complete: true, rows: [row(1)] }, b: { complete: false, rows: [row(1)] }, c: { complete: false, rows: [row(5)] } };
  const fresh = { a: { complete: true, rows: [row(9)] }, b: { complete: true, rows: [row(2)] }, c: { complete: false, rows: [row(7)] }, d: { complete: false, rows: [row(1)] } };
  const merged = BI.mergeDaily(committed, fresh);
  assert.equal(merged.a.rows[0].count, 1); // both complete -> primary
  assert.equal(merged.b.rows[0].count, 2); // complete beats incomplete
  assert.equal(merged.c.rows[0].count, 7); // both incomplete -> more trades
  assert.ok(merged.d);
});

test('horizonFlows: buckets by days left, weekly windows, expired contracts excluded, coverage start reported', () => {
  const daily = BI.aggregateTrades([
    trade('BTC-30OCT26-95000-C', 'buy', 100, now - 1 * D),
    trade('BTC-30OCT26-95000-C', 'sell', 40, now - 25 * D),
    trade('BTC-25DEC26-85000-C', 'sell', 50, now - 2 * D),
    trade('BTC-26MAR27-90000-P', 'buy', 10, now - 3 * D),
    trade('BTC-25SEP26-80000-C', 'buy', 999, now - 20 * D)
  ], 0, now);
  const f = BI.horizonFlows(daily, now, 4);
  const [m1, m3, m6, far] = f.horizons;
  assert.equal(m1.count, 2);
  assert.ok(m1.weeks[3].netDeltaUSD > 0 && m1.weeks[0].netDeltaUSD < 0);
  assert.ok(m3.netDeltaUSD < 0 && m3.netVegaUSD < 0);
  assert.ok(m6.netDeltaUSD < 0);
  assert.equal(far.count, 0);
  assert.deepEqual(m1.topExpiries.map(e => e.expiry), ['30OCT26']);
  assert.equal(m1.oiOpenShare, null);
  assert.ok(f.coverageStartMs <= now - 25 * D);
  assert.equal(BI.horizonFlows(daily, now, 12).weekEnds.length, 12);
});

test('familyOf classifies by delta ratio, then vega sign', () => {
  assert.equal(BI.familyOf({ netDeltaUSD: 20, notionalUSD: 100, netVegaUSD: -1 }), 'bull');
  assert.equal(BI.familyOf({ netDeltaUSD: -20, notionalUSD: 100, netVegaUSD: 1 }), 'bear');
  assert.equal(BI.familyOf({ netDeltaUSD: 5, notionalUSD: 100, netVegaUSD: 1 }), 'long-vol');
  assert.equal(BI.familyOf({ netDeltaUSD: -5, notionalUSD: 100, netVegaUSD: -1 }), 'short-vol');
});

const leg = (instrument, direction, amount, price, indexPrice = 80000) => ({ instrument, direction, amount, price, indexPrice });

test('registerStructures dedupes whales inside icebergs and keeps unmarked entries refreshable', () => {
  const analysis = {
    icebergClusters: [{ blockIds: ['B1', 'B2'], startTimestamp: now - 3 * D, clusterNotionalUSD: 60e6, netDeltaUSD: 20e6, netVegaUSD: 1000, strategyNameZh: '单腿买入看涨', legs: [leg('BTC-30OCT26-90000-C', 'buy', 750, 0.03)] }],
    whaleBlocks: [
      { blockId: 'B1', timestamp: now - 3 * D, notionalUSD: 40e6, legs: [leg('BTC-30OCT26-90000-C', 'buy', 500, 0.03)] },
      { blockId: 'B9', timestamp: now - D, notionalUSD: 35e6, netDeltaUSD: -1e6, netVegaUSD: -500, strategyNameZh: '卖出跨式', legs: [leg('BTC-30OCT26-85000-C', 'sell', 220, 0.04), leg('BTC-30OCT26-85000-P', 'sell', 220, 0.05)] },
      { blockId: 'B5', timestamp: now - D, notionalUSD: 20e6, legs: [leg('BTC-30OCT26-85000-C', 'buy', 250, 0.04)] }
    ]
  };
  const { registry, added } = BI.registerStructures([], analysis);
  assert.equal(added, 2);
  assert.deepEqual(registry.map(s => s.id), ['ICE:B1', 'BLK:B9']);
  assert.equal(registry[0].family, 'bull');
  assert.equal(registry[1].family, 'short-vol');
  assert.equal(registry[1].expiry, '30OCT26');
  assert.equal(registry[0].entrySpot, 80000);
  // A larger version of the same iceberg replaces the unmarked entry
  const grown = { icebergClusters: [{ ...analysis.icebergClusters[0], clusterNotionalUSD: 80e6 }], whaleBlocks: [] };
  const again = BI.registerStructures(registry, grown);
  assert.equal(again.added, 0);
  assert.equal(again.registry.find(s => s.id === 'ICE:B1').notionalUSD, 80e6);
});

test('markStructures marks once per OI day, settles at delivery and compresses marks', () => {
  const entry = {
    id: 'BLK:X', kind: 'whale', ts: Date.UTC(2026, 8, 1, 10), notionalUSD: 40e6, netDeltaUSD: 10e6, netVegaUSD: 1, family: 'bull',
    legs: [{ instrument: 'BTC-25SEP26-80000-C', direction: 'buy', amount: 10, price: 0.02 }], marks: [], final: null
  };
  // Live: mark price
  const live = BI.markStructures([entry], { markByInstrument: { 'BTC-25SEP26-80000-C': 0.05 }, spot: 82000, nowMs: Date.UTC(2026, 8, 3, 9) });
  assert.equal(live.marked, 1);
  assert.ok(Math.abs(live.registry[0].marks[0].pnlBtc - 0.3) < 1e-9);
  const sameDay = BI.markStructures(live.registry, { markByInstrument: { 'BTC-25SEP26-80000-C': 0.06 }, nowMs: Date.UTC(2026, 8, 3, 20) });
  assert.equal(sameDay.marked, 0);
  // Missing mark -> not marked
  assert.equal(BI.markStructures([entry], { markByInstrument: {}, nowMs: Date.UTC(2026, 8, 3, 9) }).marked, 0);
  // After expiry: settles at delivery price, max(1 - K/D, 0) = 0.2 at D = 100k
  const settled = BI.markStructures(live.registry, { deliveryByDate: { '2026-09-25': 100000 }, nowMs: Date.UTC(2026, 8, 26, 9) });
  assert.equal(settled.settled, 1);
  const s = settled.registry[0];
  assert.ok(Math.abs(s.final.pnlBtc - 1.8) < 1e-9); // 10 × (0.2 − 0.02)
  assert.ok(s.marks.length <= 4);
  // Without the delivery price it waits
  assert.equal(BI.markStructures(live.registry, { deliveryByDate: {}, nowMs: Date.UTC(2026, 8, 26, 9) }).settled, 0);
});

test('summarizeSmartMoney: Laplace-smoothed weights, final outcomes first, weighted directional bias', () => {
  const mk = (i, family, pnl, extra = {}) => ({ id: `S${i}`, ts: now - 40 * D, family, notionalUSD: 50e6, legs: [], marks: [], final: pnl === null ? null : { pnlBtc: pnl, ts: now }, ...extra });
  const registry = [
    ...[1, 2, 3, 4, 5, 6].map(i => mk(i, 'bull', i <= 5 ? 1 : -1)),        // 5/6 wins
    ...[7, 8].map(i => mk(i, 'bear', -1)),                                 // 2 finals only -> no basis
    mk(20, 'bull', null, { ts: now - 2 * D }),
    mk(21, 'bear', null, { ts: now - 2 * D })
  ];
  const sm = BI.summarizeSmartMoney(registry, now);
  const bull = sm.families.find(f => f.key === 'bull');
  const bear = sm.families.find(f => f.key === 'bear');
  assert.equal(bull.weightBasis, 'final');
  assert.ok(Math.abs(bull.weight - 6 / 8) < 1e-12);
  assert.ok(Math.abs(bull.hitRate - 5 / 6) < 1e-12);
  assert.equal(bear.weightBasis, null);
  assert.equal(bear.weight, 0.5);
  // Open bull (edge 0.5) and open bear (edge 0): bias = (50e6 × 0.5) / 100e6
  assert.ok(Math.abs(sm.directionalBias - 0.25) < 1e-12);
  assert.equal(sm.settled, 8);
  assert.ok(Math.abs(sm.overallHitRate - 5 / 8) < 1e-12);
  assert.equal(sm.recent[0].id, 'S20');
});

test('profitZone: butterfly peaks at the body, credit put spread is open-ended above the short strike', () => {
  const fly = BI.profitZone([
    { instrument: 'BTC-30OCT26-90000-C', direction: 'buy', amount: 1, price: 0.03 },
    { instrument: 'BTC-30OCT26-95000-C', direction: 'sell', amount: 2, price: 0.012 },
    { instrument: 'BTC-30OCT26-100000-C', direction: 'buy', amount: 1, price: 0.004 }
  ], 82000);
  assert.equal(fly.peakPrice, 95000);
  assert.equal(fly.peakOpenEnded, null);
  assert.equal(fly.profitRanges.length, 1);
  assert.ok(fly.profitRanges[0].lo > 90000 && fly.profitRanges[0].hi < 100000);

  const bullPut = BI.profitZone([
    { instrument: 'BTC-30OCT26-68000-P', direction: 'buy', amount: 1, price: 0.002 },
    { instrument: 'BTC-30OCT26-74000-P', direction: 'sell', amount: 1, price: 0.01 }
  ], 82000);
  assert.equal(bullPut.peakOpenEnded, 'up');
  assert.equal(bullPut.peakPrice, 74000);
  assert.equal(bullPut.profitRanges[0].hi, null);
});

test('strikeMap: cumulative net per strike, OI walls and target zones for one expiry', () => {
  const t1 = Date.UTC(2026, 9, 5, 10);
  const daily = BI.aggregateTrades([
    trade('BTC-30OCT26-90000-C', 'buy', 100, t1),
    trade('BTC-30OCT26-95000-C', 'sell', 200, t1),
    trade('BTC-30OCT26-100000-C', 'buy', 100, t1),
    trade('BTC-27NOV26-90000-C', 'buy', 999, t1)
  ], 0, now);
  const oiLatest = { ts: now, oi: { 'BTC-30OCT26-95000-C': [250, 10], 'BTC-30OCT26-70000-P': [80, 5], 'BTC-30OCT26-90000-C': [120, 5] } };
  const registry = [{
    id: 'ICE:1', ts: t1, strategyNameZh: '对称多头看涨蝶式', family: 'short-vol', notionalUSD: 32e6,
    legs: [
      { instrument: 'BTC-30OCT26-90000-C', direction: 'buy', amount: 100, price: 0.03 },
      { instrument: 'BTC-30OCT26-95000-C', direction: 'sell', amount: 200, price: 0.012 },
      { instrument: 'BTC-30OCT26-100000-C', direction: 'buy', amount: 100, price: 0.004 }
    ]
  }, {
    id: 'BLK:2', ts: t1, strategyNameZh: '日历价差', family: 'long-vol', notionalUSD: 40e6,
    legs: [
      { instrument: 'BTC-30OCT26-90000-C', direction: 'sell', amount: 100, price: 0.03 },
      { instrument: 'BTC-27NOV26-90000-C', direction: 'buy', amount: 100, price: 0.05 }
    ]
  }];
  const m = BI.strikeMap(daily, '30OCT26', { oiLatest, spot: 82000, registry, nowMs: now });
  assert.deepEqual(m.strikes, [70000, 90000, 95000, 100000]);
  const k95 = m.cumulative.find(c => c.strike === 95000);
  assert.equal(k95.callNet, -200);
  assert.equal(k95.callOI, 250);
  assert.equal(m.flowWalls[0].strike, 95000);
  assert.deepEqual(m.oiWalls.map(w => `${w.strike}${w.type}`), ['95000C', '90000C', '70000P']);
  assert.equal(m.targetZones.length, 1); // calendar spans two expiries -> excluded
  assert.equal(m.targetZones[0].peakPrice, 95000);
  assert.equal(m.cells.length, 3);
});

test('buildBlockInsight picks the requested live expiry, else the largest', () => {
  const daily = BI.aggregateTrades([
    trade('BTC-30OCT26-95000-C', 'buy', 100, now - D),
    trade('BTC-27NOV26-90000-C', 'buy', 10, now - D),
    trade('BTC-25SEP26-80000-C', 'buy', 5000, now - 20 * D)
  ], 0, now);
  const out = BI.buildBlockInsight({ daily, registry: [], nowMs: now, spot: 82000 });
  assert.deepEqual(out.expiries.map(e => e.expiry), ['30OCT26', '27NOV26']);
  assert.equal(out.strikeMap.expiry, '30OCT26');
  assert.equal(BI.buildBlockInsight({ daily, registry: [], nowMs: now, spot: 82000, expiry: '27NOV26' }).strikeMap.expiry, '27NOV26');
  assert.deepEqual(Object.keys(out.flows), ['4', '12', '26']);
  assert.equal(out.coverage.dailyDays, 2);
  assert.equal(out.smartMoney.tracked, 0);
});
