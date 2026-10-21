/**
 * pipeline_health unit tests — producer job heartbeats.
 * Truth rules: failure never advances a receipt; a partial run keeps the
 * older job clock; verifiedSkip counts as a successful CHECK (heartbeat only,
 * no source data renewed).
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ph = require('../server/pipeline_health');

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'be-job-'));
const NOW = Date.parse('2026-10-18T12:00:00Z');
const jobPath = (dir, id) => path.join(dir, `job_health_${id}.json`);

describe('pipeline_health', () => {
  test('unknown job id is rejected', () => {
    const d = mk();
    assert.throws(() => ph.beginJob('not_a_job', { now: NOW, dataDir: d }), /unknown monitored job/);
    assert.throws(() => ph.readJob('not_a_job', { dataDir: d }), /unknown monitored job/);
  });

  test('all steps ok -> status ok, job receipt advances', () => {
    const d = mk();
    ph.beginJob('macro_snapshot', { now: NOW, dataDir: d });
    ph.recordStep('macro_snapshot', 'macro', { ok: true, now: NOW + 1000, dataAsOf: '2026-10-18', dataDir: d });
    ph.recordStep('macro_snapshot', 'preferreds', { ok: true, now: NOW + 2000, dataDir: d });
    ph.recordStep('macro_snapshot', 'mstr_disclosures', { ok: true, now: NOW + 2500, dataDir: d });
    const rec = ph.finishJob('macro_snapshot', { now: NOW + 3000, dataDir: d });
    assert.equal(rec.status, 'ok');
    assert.equal(rec.lastSuccessAt, new Date(NOW + 3000).toISOString());
    assert.equal(rec.lastAttemptAt, new Date(NOW).toISOString());
    assert.equal(rec.steps.macro.status, 'ok');
    assert.equal(rec.steps.macro.dataAsOf, '2026-10-18T00:00:00.000Z');
    assert.equal(fs.existsSync(jobPath(d, 'macro_snapshot')), true);
    assert.deepEqual(ph.readJob('macro_snapshot', { dataDir: d }), rec);
  });

  test('one failed step -> partial; failed step keeps prior-run receipt', () => {
    const d = mk();
    // Run 1: fully ok at T0 — establishes receipts.
    ph.beginJob('macro_snapshot', { now: NOW, dataDir: d });
    ph.recordStep('macro_snapshot', 'macro', { ok: true, now: NOW, dataDir: d });
    ph.recordStep('macro_snapshot', 'preferreds', { ok: true, now: NOW, dataDir: d });
    ph.recordStep('macro_snapshot', 'mstr_disclosures', { ok: true, now: NOW, dataDir: d });
    ph.finishJob('macro_snapshot', { now: NOW + 500, dataDir: d });
    const t0Success = new Date(NOW + 500).toISOString();
    const step0Success = new Date(NOW).toISOString(); // each step keeps its own receipt

    // Run 2 (next schedule): preferreds fails.
    const NOW2 = NOW + 6 * 3600e3;
    ph.beginJob('macro_snapshot', { now: NOW2, dataDir: d });
    ph.recordStep('macro_snapshot', 'macro', { ok: true, now: NOW2, dataDir: d });
    ph.recordStep('macro_snapshot', 'preferreds', { ok: false, error: new Error('yahoo down'), now: NOW2 + 10, dataDir: d });
    ph.recordStep('macro_snapshot', 'mstr_disclosures', { ok: true, now: NOW2 + 15, dataDir: d });
    const rec = ph.finishJob('macro_snapshot', { now: NOW2 + 20, dataDir: d });
    assert.equal(rec.status, 'partial');
    assert.equal(rec.lastSuccessAt, t0Success, 'job receipt must not advance on a partial run');
    assert.match(rec.lastError, /preferreds: yahoo down/);
    // The failed step still carries its own older verified receipt.
    assert.equal(rec.steps.preferreds.lastSuccessAt, step0Success);
    assert.equal(rec.steps.macro.lastSuccessAt, new Date(NOW2).toISOString());
  });

  test('all steps fail -> failed; old job receipt preserved', () => {
    const d = mk();
    ph.beginJob('liquidity_hourly', { now: NOW, dataDir: d });
    ph.recordStep('liquidity_hourly', 'samples', { ok: true, now: NOW, dataDir: d });
    ph.finishJob('liquidity_hourly', { now: NOW + 100, dataDir: d });

    const NOW2 = NOW + 3600e3;
    ph.beginJob('liquidity_hourly', { now: NOW2, dataDir: d });
    ph.recordStep('liquidity_hourly', 'samples', { ok: false, error: new Error('coinbase down'), now: NOW2, dataDir: d });
    const rec = ph.finishJob('liquidity_hourly', { now: NOW2 + 10, dataDir: d });
    assert.equal(rec.status, 'failed');
    assert.equal(rec.lastSuccessAt, new Date(NOW + 100).toISOString());
    assert.equal(rec.steps.samples.lastSuccessAt, new Date(NOW).toISOString());
  });

  test('verifiedSkip advances the step receipt without new source data', () => {
    const d = mk();
    ph.beginJob('liquidity_hourly', { now: NOW, dataDir: d });
    ph.recordStep('liquidity_hourly', 'samples', { ok: true, now: NOW, verifiedSkip: true, dataDir: d });
    const rec = ph.finishJob('liquidity_hourly', { now: NOW + 5, dataDir: d });
    assert.equal(rec.status, 'ok');
    assert.equal(rec.steps.samples.verifiedSkip, true);
    assert.equal(rec.steps.samples.lastSuccessAt, new Date(NOW).toISOString());
  });

  test('future/invalid timestamps are rejected before mutation', () => {
    const d = mk();
    assert.throws(() => ph.beginJob('liquidity_hourly', { now: Date.now() + 3600e3, dataDir: d }), /invalid now/);
    ph.beginJob('liquidity_hourly', { now: NOW, dataDir: d });
    assert.throws( // bad dataAsOf rejects before any write
      () => ph.recordStep('liquidity_hourly', 'samples', { ok: true, now: NOW, dataAsOf: Date.now() + 3600e3, dataDir: d }),
      /invalid dataAsOf/
    );
  });

  test('finishJob never throws on write failure — best-effort failure persists', () => {
    // dataDir that cannot be written: a path that is a FILE, not a directory.
    const d = mk();
    const fileAsDir = path.join(d, 'not-a-dir');
    fs.writeFileSync(fileAsDir, 'x');
    assert.doesNotThrow(() => ph.finishJob('liquidity_hourly', { now: NOW, dataDir: fileAsDir }));
    assert.equal(ph.finishJob('liquidity_hourly', { now: NOW, dataDir: fileAsDir }), null);
  });

  test('readJob returns null for missing heartbeat', () => {
    assert.equal(ph.readJob('mcclellan_daily', { dataDir: mk() }), null);
  });

  test('recordStep without beginJob creates a minimal running record', () => {
    const d = mk();
    ph.recordStep('block_insight_daily', 'marks', { ok: true, now: NOW, dataDir: d });
    const rec = ph.readJob('block_insight_daily', { dataDir: d });
    assert.equal(rec.status, 'running');
    assert.equal(rec.steps.marks.status, 'ok');
  });
});
