const test = require('node:test');
const assert = require('node:assert/strict');
const {
  recordAttempt,
  recordSuccess,
  recordFailure,
  seedSource,
  getSourceHealth,
  summarizeHealth,
  listSources,
  resetHealthForTests
} = require('../server/data_health');
const { getSourcePolicy } = require('../server/data_health_policy');

const T0 = 1_760_000_000_000; // fixed synthetic "now"
const iso = ms => new Date(ms).toISOString();
// LIVE policy for greeks_atm: fetchWarn 3m, fetchBlock 15m, dataWarn 3m, dataBlock 15m
const LIVE = getSourcePolicy('greeks_atm');
const DAY = 86400000;

test.beforeEach(() => resetHealthForTests());

test('unobserved source is UNKNOWN and unusable; attempt alone stays UNKNOWN', () => {
  let h = getSourceHealth('greeks_atm', T0);
  assert.equal(h.state, 'UNKNOWN');
  assert.equal(h.usable, false);
  assert.equal(h.observed, false);
  assert.equal(h.freshnessStatus, 'UNKNOWN');

  recordAttempt('greeks_atm', { now: T0 });
  h = getSourceHealth('greeks_atm', T0);
  assert.equal(h.observed, true);
  assert.equal(h.state, 'UNKNOWN');
  assert.equal(h.usable, false);
});

test('recordSuccess yields OK/FRESH; identical data re-success still counts', () => {
  recordSuccess('greeks_atm', { now: T0, dataAsOf: T0 });
  let h = getSourceHealth('greeks_atm', T0);
  assert.equal(h.state, 'OK');
  assert.equal(h.usable, true);
  assert.equal(h.freshnessStatus, 'FRESH');
  assert.equal(h.lastSuccessAt, iso(T0));
  assert.equal(h.dataAsOf, iso(T0));
  assert.equal(h.ageMs, 0);
  assert.equal(h.dataAgeMs, 0);

  // unchanged valid data still counts as a success and moves the receipt clock
  recordSuccess('greeks_atm', { now: T0 + 60000, dataAsOf: T0 });
  h = getSourceHealth('greeks_atm', T0 + 60000);
  assert.equal(h.lastSuccessAt, iso(T0 + 60000));
  assert.equal(h.dataAsOf, iso(T0));
  assert.equal(h.state, 'OK');
});

test('recordSuccess rejects invalid/far-future timestamps atomically', () => {
  recordSuccess('greeks_atm', { now: T0, dataAsOf: T0 });
  // >5min future dataAsOf rejected; record untouched
  assert.throws(() => recordSuccess('greeks_atm', { now: T0 + 1000, dataAsOf: T0 + 10 * 60000 }));
  let h = getSourceHealth('greeks_atm', T0);
  assert.equal(h.lastSuccessAt, iso(T0));
  assert.equal(h.lastError, null);
  // unparsable timestamp rejected and leaves NO observed residue on a fresh id
  assert.throws(() => recordSuccess('greeks_gex', { now: T0, dataAsOf: 'not-a-timestamp' }));
  assert.equal(getSourceHealth('greeks_gex', T0).observed, false);
  // absent dataAsOf is allowed but the source is UNKNOWN/unusable
  recordSuccess('greeks_smile', { now: T0, dataAsOf: null });
  h = getSourceHealth('greeks_smile', T0);
  assert.equal(h.state, 'UNKNOWN');
  assert.equal(h.usable, false);
});

test('failure preserves last-good timestamps, increments, and does not touch availability', () => {
  recordSuccess('greeks_atm', { now: T0, dataAsOf: T0 });
  recordFailure('greeks_atm', new Error('boom'), { now: T0 + 60000 });
  let h = getSourceHealth('greeks_atm', T0 + 60000);
  assert.equal(h.lastSuccessAt, iso(T0), 'failure must not move lastSuccessAt');
  assert.equal(h.dataAsOf, iso(T0), 'failure must not move dataAsOf');
  assert.equal(h.lastError, 'boom');
  assert.equal(h.consecutiveFailures, 1);
  assert.equal(h.state, 'FALLBACK', 'error present -> FALLBACK while still fresh');
  assert.equal(h.usable, true);
  recordFailure('greeks_atm', new Error('boom2'), { now: T0 + 120000 });
  h = getSourceHealth('greeks_atm', T0 + 120000);
  assert.equal(h.consecutiveFailures, 2);
  assert.equal(h.lastSuccessAt, iso(T0));

  // cold failure: never had valid data -> UNAVAILABLE (not UNKNOWN)
  recordFailure('greeks_gex', new Error('down'), { now: T0 });
  h = getSourceHealth('greeks_gex', T0);
  assert.equal(h.state, 'UNAVAILABLE');
  assert.equal(h.usable, false);
});

test('recovery: success after failures clears error and restores availability', () => {
  recordFailure('greeks_atm', new Error('down'), { now: T0 });
  recordFailure('greeks_atm', new Error('still down'), { now: T0 + 1000 });
  recordSuccess('greeks_atm', { now: T0 + 2000, dataAsOf: T0 + 2000 });
  const h = getSourceHealth('greeks_atm', T0 + 2000);
  assert.equal(h.state, 'OK');
  assert.equal(h.lastError, null);
  assert.equal(h.consecutiveFailures, 0);
  assert.equal(h.available, true);
});

test('expiry follows exact policy boundaries (strictly-greater semantics)', () => {
  recordSuccess('greeks_atm', { now: T0, dataAsOf: T0 });
  // exactly at fetchWarn boundary -> still OK
  let h = getSourceHealth('greeks_atm', T0 + LIVE.fetchWarnMs);
  assert.equal(h.state, 'OK');
  // just past fetchWarn -> STALE but still usable
  h = getSourceHealth('greeks_atm', T0 + LIVE.fetchWarnMs + 1);
  assert.equal(h.state, 'STALE');
  assert.equal(h.usable, true);
  assert.equal(h.stale, true);
  // exactly at fetchBlock boundary -> still usable
  h = getSourceHealth('greeks_atm', T0 + LIVE.fetchBlockMs);
  assert.equal(h.usable, true);
  // past block -> expired: STALE + unusable
  h = getSourceHealth('greeks_atm', T0 + LIVE.fetchBlockMs + 1);
  assert.equal(h.state, 'STALE');
  assert.equal(h.usable, false);
  assert.equal(h.expired, true);
  assert.ok(h.warnings.length > 0);

  // data-age expiry on a slow source (deribit_dvol: dataWarn 3d, dataBlock 7d)
  const DVOL = getSourcePolicy('deribit_dvol');
  recordSuccess('deribit_dvol', { now: T0, dataAsOf: T0 - 4 * DAY }); // 4d old: past dataWarn, inside block
  h = getSourceHealth('deribit_dvol', T0);
  assert.equal(h.state, 'STALE');
  assert.equal(h.freshnessStatus, 'STALE');
  assert.equal(h.usable, true);
  h = getSourceHealth('deribit_dvol', T0 + (DVOL.dataBlockMs - 4 * DAY) + 1); // data age just past block
  assert.equal(h.usable, false);
});

test('seedSource: disk fallback needs both timestamps; invalid seed leaves no residue', () => {
  // full disk seed inside warn windows -> FALLBACK, usable, never OK
  seedSource('macro', { dataAsOf: T0 - 300000, lastSuccessAt: T0 - 300000, now: T0 });
  let h = getSourceHealth('macro', T0);
  assert.equal(h.state, 'FALLBACK');
  assert.equal(h.usable, true);
  assert.equal(h.source, 'disk');

  // missing lastSuccessAt -> UNKNOWN/unusable (browsable history, not live)
  seedSource('cdri', { dataAsOf: T0 - 300000, now: T0 });
  h = getSourceHealth('cdri', T0);
  assert.equal(h.state, 'UNKNOWN');
  assert.equal(h.usable, false);

  // missing dataAsOf -> UNKNOWN/unusable
  seedSource('ssro', { lastSuccessAt: T0 - 60000, now: T0 });
  h = getSourceHealth('ssro', T0);
  assert.equal(h.state, 'UNKNOWN');
  assert.equal(h.usable, false);

  // invalid timestamps rejected atomically -> no observed residue
  assert.throws(() => seedSource('etf', { dataAsOf: 'garbage', lastSuccessAt: T0, now: T0 }));
  assert.equal(getSourceHealth('etf', T0).observed, false);
  assert.throws(() => seedSource('cot', { dataAsOf: T0, lastSuccessAt: T0 + 10 * 60000, now: T0 }));
  assert.equal(getSourceHealth('cot', T0).observed, false);

  // seed never overwrites a live runtime record
  recordSuccess('gold', { now: T0, dataAsOf: T0 });
  seedSource('gold', { dataAsOf: T0 - 9 * DAY, lastSuccessAt: T0 - 9 * DAY, now: T0 });
  h = getSourceHealth('gold', T0);
  assert.equal(h.dataAsOf, iso(T0));
  assert.equal(h.state, 'OK');
});

test('summarizeHealth: OK / DEGRADED / UNAVAILABLE / UNKNOWN semantics', () => {
  // empty -> never OK
  let s = summarizeHealth([], T0);
  assert.notEqual(s.state, 'OK');
  assert.equal(s.analysisAllowed, false);

  // all unknown -> UNKNOWN
  s = summarizeHealth(['greeks_atm', 'greeks_gex'], T0);
  assert.equal(s.state, 'UNKNOWN');
  assert.equal(s.analysisAllowed, false);

  // mixed ok + degraded -> DEGRADED, failedSources lists every non-OK source
  recordSuccess('greeks_atm', { now: T0, dataAsOf: T0 });
  seedSource('macro', { dataAsOf: T0 - 60000, lastSuccessAt: T0 - 60000, now: T0 }); // disk FALLBACK
  s = summarizeHealth(['greeks_atm', 'macro'], T0);
  assert.equal(s.state, 'DEGRADED');
  assert.equal(s.analysisAllowed, true, 'FALLBACK is usable');
  assert.deepEqual(s.failedSources, ['macro'], 'non-OK sources are reported even when usable');
  assert.deepEqual(s.blockedSources, []);

  // failed source blocks analysisAllowed but not the summary when others usable
  recordFailure('greeks_gex', new Error('down'), { now: T0 });
  s = summarizeHealth(['greeks_atm', 'greeks_gex'], T0);
  assert.equal(s.state, 'DEGRADED');
  assert.equal(s.analysisAllowed, false);
  assert.deepEqual(s.failedSources, ['greeks_gex']);
  assert.deepEqual(s.blockedSources, ['greeks_gex']);

  // zero usable with real failures -> UNAVAILABLE
  s = summarizeHealth(['greeks_gex'], T0);
  assert.equal(s.state, 'UNAVAILABLE');
  assert.equal(s.analysisAllowed, false);

  // all OK -> OK
  recordSuccess('greeks_gex', { now: T0 + 1000, dataAsOf: T0 + 1000 });
  s = summarizeHealth(['greeks_atm', 'greeks_gex'], T0 + 1000);
  assert.equal(s.state, 'OK');
  assert.equal(s.analysisAllowed, true);
  assert.deepEqual(s.failedSources, []);
});

test('listSources returns a read-only copy filtered by prefix', () => {
  recordSuccess('wave:1h', { now: T0, dataAsOf: T0 });
  recordSuccess('flow:1h', { now: T0, dataAsOf: T0 });
  recordSuccess('greeks_atm', { now: T0, dataAsOf: T0 });
  const wave = listSources('wave:');
  assert.equal(wave.length, 1);
  assert.equal(wave[0].id, 'wave:1h');
  wave[0].issues.push('mutated');
  assert.equal(getSourceHealth('wave:1h', T0).issues.length, 0, 'snapshot is a copy');
  assert.equal(listSources().length, 3);
});

test('policy: fred:DGS6MO shares the DAILY FRED policy with DGS3MO; unknown FRED ids throw', () => {
  const dgs6 = getSourcePolicy('fred:DGS6MO');
  const dgs3 = getSourcePolicy('fred:DGS3MO');
  assert.deepEqual(dgs6, dgs3, 'DGS6MO (6-month T-bill) uses the same daily FRED windows as DGS3MO');
  assert.throws(() => getSourcePolicy('fred:NOT_A_SERIES'), /unknown|no policy|unsupported/i);
});
