const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mh = require('../server/option_marks_history');

const H = 3600000;
const at = (day, hh, mm = 0) => Date.parse(`${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);

test('closeDayOf: a snapshot day runs from the previous 08:00 UTC (exclusive) to 08:00 (inclusive)', () => {
  assert.equal(mh.closeDayOf(at('2026-11-18', 8)), '2026-11-18');
  assert.equal(mh.closeDayOf(at('2026-11-18', 8) + 1), '2026-11-19');
  assert.equal(mh.closeDayOf(at('2026-11-17', 8) + 1), '2026-11-18');
  assert.equal(mh.closeDayOf(at('2026-11-18', 0)), '2026-11-18');
});

test('snapshotsFromTrades keeps the latest mark per instrument and day, options only', () => {
  const I = 'BTC-26DEC26-80000-C';
  const snaps = mh.snapshotsFromTrades([
    { instrument_name: I, timestamp: at('2026-11-18', 1), mark_price: 0.05, index_price: 80000 },
    { instrument_name: I, timestamp: at('2026-11-18', 6), mark_price: 0.06, index_price: 81000 },
    { instrument_name: I, timestamp: at('2026-11-18', 9), mark_price: 0.07, index_price: 82000 },
    { instrument_name: 'BTC-PERPETUAL', timestamp: at('2026-11-18', 2), mark_price: 80000, index_price: 80000 }
  ]);
  assert.deepEqual(Object.keys(snaps).sort(), ['2026-11-18', '2026-11-19']);
  assert.deepEqual(snaps['2026-11-18'].marks[I], [0.06, at('2026-11-18', 6), 81000]);
  assert.equal(snaps['2026-11-18'].marks['BTC-PERPETUAL'], undefined);
  assert.equal(snaps['2026-11-18'].index, 81000);
  assert.equal(snaps['2026-11-18'].closeTs, at('2026-11-18', 8));
});

test('mergeSnapshots is idempotent, keeps the later observation, and markAt looks back with a staleness count', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marks-'));
  const I = 'BTC-26DEC26-80000-C';
  const first = mh.snapshotsFromTrades([{ instrument_name: I, timestamp: at('2026-11-17', 3), mark_price: 0.05, index_price: 80000 }]);
  assert.deepEqual(mh.mergeSnapshots('BTC', first, { dir }).months, ['2026-11']);
  assert.deepEqual(mh.mergeSnapshots('BTC', first, { dir }).months, []); // nothing new
  const later = mh.snapshotsFromTrades([{ instrument_name: I, timestamp: at('2026-11-17', 5), mark_price: 0.055, index_price: 80500 }]);
  mh.mergeSnapshots('BTC', later, { dir });
  const earlier = mh.snapshotsFromTrades([{ instrument_name: I, timestamp: at('2026-11-17', 1), mark_price: 0.01, index_price: 79000 }]);
  mh.mergeSnapshots('BTC', earlier, { dir });
  const h = mh.loadRange('BTC', '2026-11-01', '2026-11-30', { dir });
  assert.equal(h['2026-11-17'].marks[I][0], 0.055);
  const hit = mh.markAt(h, I, '2026-11-19');
  assert.equal(hit.staleDays, 2);
  assert.equal(hit.mark, 0.055);
  assert.equal(hit.indexAtObs, 80500);
  assert.equal(mh.markAt(h, I, '2026-11-25'), null); // beyond the look-back window
});
