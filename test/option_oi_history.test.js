const test = require('node:test');
const assert = require('node:assert/strict');
const oi = require('../server/option_oi_history.js');
const { analyzeBlockTrades } = require('../server/analytics_engine.js');

const H = 3600 * 1000;
const D = 24 * H;
const day0 = Date.UTC(2026, 9, 6, 8, 15); // 2026-10-06 08:15 UTC
const snap = (ts, oiMap) => ({ ts, index: 80000, oi: oiMap });

test('dayKey: an OI day starts at the 08:00 UTC expiry', () => {
  assert.equal(oi.dayKey(Date.UTC(2026, 9, 8, 8, 15)), '2026-10-08');
  assert.equal(oi.dayKey(Date.UTC(2026, 9, 8, 7, 59)), '2026-10-07');
});

test('snapshotFromBookSummary keeps OI / 24h volume and the index, drops empty instruments', () => {
  const s = oi.snapshotFromBookSummary([
    { instrument_name: 'BTC-30OCT26-95000-C', open_interest: 25336.04, volume: 812.3, estimated_delivery_price: 82648.6 },
    { instrument_name: 'BTC-30OCT26-50000-P', open_interest: 0, volume: 0 }
  ], day0);
  assert.deepEqual(s.oi, { 'BTC-30OCT26-95000-C': [25336, 812.3] });
  assert.equal(s.index, 82648.6);
  assert.equal(oi.snapshotFromBookSummary([], day0), null);
});

test('encode / decode round-trips through the instrument dictionary', () => {
  const list = [
    snap(day0, { A: [10, 2], B: [5, 1] }),
    snap(day0 + D, { B: [7, 3], C: [1, 1] })
  ];
  const json = JSON.parse(JSON.stringify(oi.encodeHistory(list)));
  assert.deepEqual(json.instruments, ['A', 'B', 'C']);
  assert.deepEqual(oi.decodeHistory(json), list);
});

test('mergeSnapshotSets keeps one snapshot per OI day (first set wins) and pruneHistory drops old days', () => {
  const committed = [snap(day0, { A: [1, 1] })];
  const local = [snap(day0 + 3 * H, { A: [99, 99] }), snap(day0 + D, { A: [2, 1] })];
  const merged = oi.mergeSnapshotSets(committed, local);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0].oi.A, [1, 1]);
  assert.equal(oi.hasSnapshotForDay(merged, day0 + D + 2 * H), true);
  assert.equal(oi.hasSnapshotForDay(merged, day0 + 2 * D), false);
  assert.equal(oi.pruneHistory(merged, day0 + (oi.RETENTION_DAYS + 0.5) * D).length, 1);
});

test('classifyTrade: open share = (V + ΔOI) / 2V within the snapshot window', () => {
  const list = [
    snap(day0, { X: [1000, 50], Y: [800, 10] }),
    snap(day0 + D, { X: [1800, 1000], Y: [200, 700] })
  ];
  const opening = oi.classifyTrade(list, 'X', day0 + 5 * H);
  assert.equal(opening.status, 'opening'); // (1000 + 800) / 2000 = 0.9
  assert.ok(Math.abs(opening.openShare - 0.9) < 1e-12);
  const closing = oi.classifyTrade(list, 'Y', day0 + 5 * H);
  assert.equal(closing.status, 'closing'); // (700 - 600) / 1400 ≈ 0.07
  // Newly listed instrument: absent before -> OI 0
  const fresh = oi.classifyTrade([snap(day0, {}), snap(day0 + D, { Z: [300, 300] })], 'Z', day0 + H);
  assert.equal(fresh.openShare, 1);
  // After the latest snapshot -> pending; before the first -> unknown; gap > 30h -> unknown
  assert.equal(oi.classifyTrade(list, 'X', day0 + D + H, day0 + 30 * D).status, 'pending');
  assert.equal(oi.classifyTrade(list, 'X', day0 - H).status, 'unknown');
  const gap = [snap(day0, { X: [1, 1] }), snap(day0 + 2 * D, { X: [5, 5] })];
  assert.equal(oi.classifyTrade(gap, 'X', day0 + H).status, 'unknown');
  // Expired before the next snapshot -> unknown
  assert.equal(oi.classifyTrade(list, 'X', day0 + H, day0 + 10 * H).status, 'unknown');
});

test('profileFromItems weights by contracts and needs half the size covered', () => {
  const list = [
    snap(day0, { X: [1000, 50], Y: [800, 10] }),
    snap(day0 + D, { X: [1800, 1000], Y: [200, 700] })
  ];
  const p = oi.profileFromItems(list, [
    { instrument: 'X', ts: day0 + H, amount: 300 },
    { instrument: 'Y', ts: day0 + H, amount: 100 }
  ]);
  const expected = (0.9 * 300 + (100 / 1400) * 100) / 400;
  assert.ok(Math.abs(p.openShare - expected) < 1e-12);
  assert.equal(p.status, 'opening');
  assert.equal(oi.profileFromItems(list, [{ instrument: 'X', ts: day0 + D + H, amount: 1 }]).status, 'pending');
});

test('analyzeBlockTrades: headline totals dedupe whales that are also iceberg slices', () => {
  const t0 = Date.UTC(2026, 9, 1, 0, 0);
  const tr = (id, amount, ts) => ({ trade_id: id, block_trade_id: `BLK-${id}`, instrument_name: 'BTC-26DEC26-90000-C', direction: 'buy', amount, price: 0.03, iv: 45, index_price: 80000, timestamp: ts });
  // Two slices of one iceberg: the first is itself a whale (≥ $30M), the second is not
  const trades = [tr('a', 500, t0), tr('b', 200, t0 + 5 * 60000), tr('c', 400, t0 + 86400000)];
  const r = analyzeBlockTrades(trades, 30e6);
  assert.equal(r.whaleBlocks.length, 2); // a ($40M) and c ($32M)
  assert.equal(r.icebergClusters.length, 1); // a + b
  assert.equal(r.whaleInClusterCount, 1);
  assert.ok(Math.abs(r.totalWhaleVolumeM - 72) < 1e-9);
  assert.ok(Math.abs(r.icebergOnlyM - 16) < 1e-9);
  assert.ok(Math.abs(r.dedupedTotalM - 88) < 1e-9); // 40 + 16 + 32, not 72 + 56
  assert.ok(r.paragraph.includes('去重后的大宗资金总名义为 $88.0M'));
});

test('analyzeBlockTrades attaches OI opening / closing profiles when snapshots are given', () => {
  const ts = day0 + 2 * H;
  const trades = [{ trade_id: 't', block_trade_id: 'BLK-t', instrument_name: 'BTC-26DEC26-90000-C', direction: 'buy', amount: 500, price: 0.03, iv: 45, index_price: 80000, timestamp: ts }];
  const snaps = [snap(day0, { 'BTC-26DEC26-90000-C': [1000, 100] }), snap(day0 + D, { 'BTC-26DEC26-90000-C': [1500, 600] })];
  const r = analyzeBlockTrades(trades, 30e6, 'all', 80000, snaps);
  assert.equal(r.whaleBlocks[0].oiProfile.status, 'opening');
  assert.equal(analyzeBlockTrades(trades, 30e6).whaleBlocks[0].oiProfile, null);
});
