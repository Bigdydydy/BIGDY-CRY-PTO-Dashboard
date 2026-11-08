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

test('classifyTrade: open share = (V + ΔOI) / 2V within the snapshot window', (t) => {
  // classifyTrade reads the wall clock for trades after the latest snapshot: pin it just after that trade
  const realNow = Date.now;
  Date.now = () => day0 + D + 2 * H;
  t.after(() => { Date.now = realNow; });
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
  // After the latest snapshot but already expired -> unknown (no next snapshot will ever show its OI)
  assert.equal(oi.classifyTrade(list, 'X', day0 + D + H, day0 + D + 90 * 60 * 1000).status, 'unknown');
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
  // One leg opens, the other closes: the weighted average would hide it, the structure read keeps it
  assert.equal(p.status, 'split');
  assert.equal(p.legs.find(l => l.instrument === 'X').status, 'opening');
  assert.equal(p.legs.find(l => l.instrument === 'Y').status, 'closing');
  assert.equal(oi.profileFromItems(list, [{ instrument: 'X', ts: day0 + H, amount: 300 }]).status, 'opening');
  assert.equal(oi.profileFromItems(list, [{ instrument: 'X', ts: day0 + D + H, amount: 1 }]).status, 'pending');
});

test('shareBounds: the block alone is pinned down only when it dominates the window volume', () => {
  // V=1000, B=800, ΔOI=+700 -> c ∈ [500, 800] -> open share ∈ [0.8125, 1]
  const tight = oi.shareBounds(800, 700, 1000);
  assert.ok(Math.abs(tight.lo - 0.8125) < 1e-12);
  assert.equal(tight.hi, 1);
  assert.equal(tight.dominance, 0.8);
  // Same ΔOI share but the block is only 10% of the volume -> anything from all-closing to all-opening
  const wide = oi.shareBounds(100, 700, 1000);
  assert.equal(wide.lo, 0);
  assert.equal(wide.hi, 1);
  // Volume smaller than |ΔOI| (24h volume missing part of a long window) is widened, never inverted
  const widened = oi.shareBounds(100, 500, 300);
  assert.ok(widened.lo <= widened.hi);
});

test('profileFromItems: confirmed vs leaning, and iceberg slices pooled into one block per window', () => {
  const I = 'BTC-26DEC26-90000-C';
  // exact window volume recorded (4th column) so the bounds are valid on a 24h window
  const list = [snap(day0, { [I]: [1000, 0] }), { ...snap(day0 + D, { [I]: [1700, 1000, 1000] }), winFrom: day0 }];
  // A lone 100-contract slice: point estimate 85% opening, but the other 900 contracts could explain it
  const single = oi.profileFromItems(list, [{ instrument: I, ts: day0 + H, amount: 100 }]);
  assert.equal(single.status, 'opening');
  assert.equal(single.confidence, 'leaning');
  assert.ok(Math.abs(single.dominance - 0.1) < 1e-12);
  // Eight slices of one iceberg in the same window pool to B=800 -> lower bound 0.8125 -> confirmed
  const slices = Array.from({ length: 8 }, (_, i) => ({ instrument: I, ts: day0 + H + i * 60000, amount: 100 }));
  const pooled = oi.profileFromItems(list, slices);
  assert.equal(pooled.confidence, 'confirmed');
  assert.ok(Math.abs(pooled.openLo - 0.8125) < 1e-12);
});

test('profileFromItems: exact window volume makes long windows usable; approximate ones never confirm', () => {
  const I = 'BTC-26DEC26-90000-C';
  // 27h window, 24h volume only: point estimate only
  const approx = [snap(day0, { [I]: [0, 0] }), snap(day0 + 27 * H, { [I]: [900, 900] })];
  const pa = oi.profileFromItems(approx, [{ instrument: I, ts: day0 + H, amount: 900 }]);
  assert.equal(pa.status, 'opening');
  assert.equal(pa.confidence, 'leaning');
  assert.equal(pa.openLo, null);
  assert.equal(pa.dominance, null); // window volume unknown -> no block share, so it cannot outrank the rule
  const { reconcileLifecycle } = require('../server/analytics_engine.js');
  assert.equal(reconcileLifecycle({ action: 'CLOSING' }, pa).basis, 'rule');
  // Same window with the exact tape volume recorded (winFrom = previous snapshot) -> confirmed
  const exact = [snap(day0, { [I]: [0, 0] }), { ...snap(day0 + 27 * H, { [I]: [900, 900, 950] }), winFrom: day0 }];
  assert.equal(oi.profileFromItems(exact, [{ instrument: I, ts: day0 + H, amount: 900 }]).confidence, 'confirmed');
  // A 2-day gap is still judged with exact volume, but not without it
  const gapExact = [snap(day0, { [I]: [0, 0] }), { ...snap(day0 + 2 * D, { [I]: [900, 900, 1000] }), winFrom: day0 }];
  assert.equal(oi.classifyTrade(gapExact, I, day0 + H).volumeKind, 'exact');
  // exact volume recorded against a different previous snapshot is ignored
  const stale = [snap(day0, { [I]: [0, 0] }), { ...snap(day0 + 27 * H, { [I]: [900, 900, 950] }), winFrom: day0 - D }];
  assert.equal(oi.classifyTrade(stale, I, day0 + H).volumeKind, 'approx');
  // round trip keeps the 4th column and winFrom
  const json = JSON.parse(JSON.stringify(oi.encodeHistory(exact)));
  assert.deepEqual(oi.decodeHistory(json), exact);
});

test('profileFromItems: near leg closing + far leg opening reads as a roll', () => {
  const near = 'BTC-27NOV26-90000-C';
  const far = 'BTC-25DEC26-95000-C';
  const list = [
    snap(day0, { [near]: [2000, 0], [far]: [100, 0] }),
    { ...snap(day0 + D, { [near]: [1100, 1000, 1000], [far]: [1000, 1000, 1000] }), winFrom: day0 }
  ];
  const p = oi.profileFromItems(list, [
    { instrument: near, ts: day0 + H, amount: 900, expiryMs: Date.UTC(2026, 10, 27, 8) },
    { instrument: far, ts: day0 + H, amount: 900, expiryMs: Date.UTC(2026, 11, 25, 8) }
  ]);
  assert.equal(p.status, 'roll');
  assert.equal(p.structure.text, '近月平仓 / 远月开仓');
  assert.equal(p.confidence, 'confirmed');
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

test('reconcileLifecycle: OI overrides the rule only when it pins the block down, and flags contradictions', () => {
  const { reconcileLifecycle } = require('../server/analytics_engine.js');
  const open = { action: 'OPENING', tag: '🧱 全新结构建仓' };
  const confirmedClose = { status: 'closing', openShare: 0.18, openLo: 0, openHi: 0.3, confidence: 'confirmed', dominance: 0.7 };
  const c = reconcileLifecycle(open, confirmedClose);
  assert.equal(c.kind, 'close');
  assert.equal(c.basis, 'oi-confirmed');
  assert.equal(c.conflict, true);
  assert.ok(c.conflictText.includes('规则判开仓'));
  // Weak OI (block is 10% of the volume) leaves the rule in charge, no conflict
  const weak = reconcileLifecycle(open, { ...confirmedClose, confidence: 'leaning', dominance: 0.1 });
  assert.equal(weak.kind, 'open');
  assert.equal(weak.basis, 'rule');
  assert.equal(weak.conflict, false);
  // Rule-only cross-expiry is not called a roll outright
  assert.ok(reconcileLifecycle({ action: 'ROLLOVER' }, null).label.includes('展期或日历价差'));
  // Pending OI keeps the rule and marks it
  const pend = reconcileLifecycle(open, { status: 'pending' });
  assert.equal(pend.pending, true);
  assert.equal(pend.basis, 'rule');
  assert.equal(reconcileLifecycle({ action: 'UNCONFIRMED' }, null).kind, 'unknown');
});

test('annotateSmartFamilies stars only OI-confirmed opens of a historically strong family', () => {
  const { annotateSmartFamilies } = require('../server/block_insight.js');
  const families = [
    { key: 'bear', label: '方向看空', weight: 0.63, weightBasis: 'final', finals: 39, hitRate: 0.64 },
    { key: 'bull', label: '方向看多', weight: 0.24, weightBasis: 'final', finals: 47, hitRate: 0.23 }
  ];
  const confirmedOpen = { kind: 'open', basis: 'oi-confirmed' };
  const analysis = {
    whaleBlocks: [
      { netDeltaUSD: -5e6, notionalUSD: 30e6, netVegaUSD: 0, legs: [], lifecycle: confirmedOpen },
      { netDeltaUSD: -5e6, notionalUSD: 30e6, netVegaUSD: 0, legs: [], lifecycle: { kind: 'open', basis: 'rule' } },
      { netDeltaUSD: 5e6, notionalUSD: 30e6, netVegaUSD: 0, legs: [], lifecycle: confirmedOpen }
    ],
    icebergClusters: []
  };
  annotateSmartFamilies(analysis, families);
  assert.deepEqual(analysis.whaleBlocks.map(b => b.smart.star), [true, false, false]);
  assert.equal(analysis.whaleBlocks[0].smart.family, 'bear');
});

test('windowVolumesFromTape: pages from the last millisecond, dedupes, keeps only (from, to]', async () => {
  const pages = [
    { trades: [
      { trade_id: 1, timestamp: day0, instrument_name: 'X', amount: 99 }, // == from: excluded
      { trade_id: 2, timestamp: day0 + 10, instrument_name: 'X', amount: 5 },
      { trade_id: 3, timestamp: day0 + 20, instrument_name: 'Y', amount: 2 }
    ], hasMore: true },
    { trades: [
      { trade_id: 3, timestamp: day0 + 20, instrument_name: 'Y', amount: 2 }, // repeated boundary trade
      { trade_id: 4, timestamp: day0 + 30, instrument_name: 'X', amount: 1.5 },
      { trade_id: 5, timestamp: day0 + D + 1, instrument_name: 'X', amount: 50 } // after `to`
    ], hasMore: false }
  ];
  const starts = [];
  const r = await oi.windowVolumesFromTape(async (cur, start) => { starts.push(start); return pages[starts.length - 1]; }, { fromTs: day0, toTs: day0 + D, sleepMs: 0 });
  assert.deepEqual(r.volumes, { X: 6.5, Y: 2 });
  assert.deepEqual(starts, [day0, day0 + 20]);
});

test('backfillWindowVolumes fills settled windows, skips fresh ones and rejects truncated tapes', async () => {
  const I = 'BTC-26DEC26-90000-C';
  const list = [
    snap(day0, { [I]: [0, 0] }),
    snap(day0 + D, { [I]: [500, 1000] }),
    snap(day0 + 2 * D, { [I]: [800, 1000] })
  ];
  const tape = amount => async (cur, start) => ({ trades: [{ trade_id: start, timestamp: start + H, instrument_name: I, amount }], hasMore: false });
  // Last snapshot is only 1h old: only the earlier window is filled
  const r = await oi.backfillWindowVolumes(list, { fetchPage: tape(900), now: day0 + 2 * D + H, sleepMs: 0 });
  assert.equal(r.filled, 1);
  assert.equal(list[1].winFrom, day0);
  assert.equal(list[1].oi[I][2], 900);
  assert.equal(list[2].winFrom, undefined);
  // A tape far below the rolling 24h volume is treated as truncated and not written
  const r2 = await oi.backfillWindowVolumes(list, { fetchPage: tape(10), now: day0 + 3 * D, sleepMs: 0 });
  assert.equal(r2.filled, 0);
  assert.equal(r2.errors.length, 1);
  assert.equal(list[2].winFrom, undefined);
});

test('withProvisionalSnapshot appends live OI only between 30 minutes and 24 hours after the last snapshot', () => {
  const I = 'BTC-26DEC26-90000-C';
  const list = [snap(day0, { [I]: [100, 0] })];
  const marks = ts => ({ timestamp: ts, indexPrice: 80000, marks: { [I]: { openInterest: 900, volume24h: 850 } } });
  const live = oi.withProvisionalSnapshot(list, marks(day0 + 6 * H));
  assert.equal(live.length, 2);
  assert.equal(live[1].provisional, true);
  assert.equal(oi.withProvisionalSnapshot(list, marks(day0 + 10 * 60000)).length, 1);
  assert.equal(oi.withProvisionalSnapshot(list, marks(day0 + 25 * H)).length, 1);
  // A trade after the last real snapshot is judged against the live book instead of waiting
  const p = oi.profileFromItems(live, [{ instrument: I, ts: day0 + H, amount: 800 }]);
  assert.equal(p.status, 'opening');
  assert.equal(p.provisional, true);
  assert.equal(p.confidence, 'confirmed'); // V=850 (upper bound), B=800, ΔOI=+800
});

test('OI lag: a trade in the last 4h before a snapshot is judged against the next one', () => {
  const I = 'BTC-26DEC26-90000-C';
  const list = [
    snap(day0, { [I]: [0, 0] }),
    { ...snap(day0 + D, { [I]: [100, 900, 900] }), winFrom: day0 },
    { ...snap(day0 + 2 * D, { [I]: [900, 900, 900] }), winFrom: day0 + D }
  ];
  const early = oi.classifyTrade(list, I, day0 + 5 * H);
  assert.equal(early.windowEnd, day0 + D);
  const late = oi.classifyTrade(list, I, day0 + D - 2 * H);
  assert.equal(late.windowStart, day0);
  assert.equal(late.windowEnd, day0 + 2 * D); // skips the snapshot taken 2h after the trade
  assert.equal(late.volume, 1800);              // both exact segments summed (overlap only widens bounds)
  assert.equal(late.deltaOI, 900);
  // 24h volume is an upper bound only for windows up to 20h
  const short = [snap(day0, { [I]: [0, 0] }), snap(day0 + 18 * H, { [I]: [500, 600] })];
  assert.equal(oi.classifyTrade(short, I, day0 + H).volumeKind, 'upper');
  const daily = [snap(day0, { [I]: [0, 0] }), snap(day0 + 23 * H, { [I]: [500, 600] })];
  assert.equal(oi.classifyTrade(daily, I, day0 + H).volumeKind, 'approx');
  // Within 4h of the latest snapshot -> still pending
  assert.equal(oi.classifyTrade(list, I, day0 + 2 * D - H, Date.UTC(2099, 0, 1)).status, 'pending');
});
