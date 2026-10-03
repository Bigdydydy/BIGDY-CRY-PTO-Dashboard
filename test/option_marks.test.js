const test = require('node:test');
const assert = require('node:assert/strict');
const { getOptionMarks, compactBookSummary, pickInstruments, clearOptionMarksCache } = require('../server/option_marks.js');

const ROWS = [
  { instrument_name: 'BTC-30OCT26-100000-C', mark_iv: 37.76, mark_price: 0.0026601, underlying_price: 84910.52, estimated_delivery_price: 84553.93 },
  { instrument_name: 'BTC-30OCT26-80000-P', mark_iv: 44.1, mark_price: 0.0121, underlying_price: 84910.52, estimated_delivery_price: 84553.93 },
  { instrument_name: 'BTC-4OCT26-70000-P', mark_iv: 0, mark_price: 0, underlying_price: 84560 }
];

test('compactBookSummary keeps mark IV / price / forward and the index, drops rows without IV', () => {
  const snap = compactBookSummary(ROWS);
  assert.equal(snap.indexPrice, 84553.93);
  assert.deepEqual(snap.marks['BTC-30OCT26-100000-C'], { markIv: 37.76, markPrice: 0.0026601, underlyingPrice: 84910.52 });
  assert.equal(snap.marks['BTC-4OCT26-70000-P'], undefined);
  assert.equal(Object.keys(snap.marks).length, 2);
});

test('pickInstruments filters to the requested legs', () => {
  const snap = { indexPrice: 1, marks: compactBookSummary(ROWS).marks };
  const picked = pickInstruments(snap, ['BTC-30OCT26-80000-P', 'BTC-MISSING-1-C']);
  assert.deepEqual(Object.keys(picked.marks), ['BTC-30OCT26-80000-P']);
  assert.equal(pickInstruments(snap, []).marks, snap.marks);
});

test('getOptionMarks caches for 30s, shares in-flight requests and serves stale on failure', async () => {
  clearOptionMarksCache();
  let calls = 0;
  const ok = async () => { calls++; return { currency: 'BTC', timestamp: 1, ...compactBookSummary(ROWS) }; };

  const [a, b] = await Promise.all([getOptionMarks('BTC', { fetcher: ok, now: 1000 }), getOptionMarks('BTC', { fetcher: ok, now: 1000 })]);
  assert.equal(calls, 1);
  assert.equal(a.stale, false);
  assert.equal(b.marks['BTC-30OCT26-100000-C'].markIv, 37.76);

  await getOptionMarks('BTC', { fetcher: ok, now: 20000 });
  assert.equal(calls, 1); // still fresh

  const failing = async () => { calls++; throw new Error('boom'); };
  const stale = await getOptionMarks('BTC', { fetcher: failing, now: 60000 });
  assert.equal(calls, 2);
  assert.equal(stale.stale, true);
  assert.equal(stale.indexPrice, 84553.93);

  clearOptionMarksCache();
  await assert.rejects(getOptionMarks('BTC', { fetcher: failing, now: 70000 }), /boom/);
});
