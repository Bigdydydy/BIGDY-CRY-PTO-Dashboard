/**
 * Producer job heartbeat — pure telemetry for scheduled collectors
 * (GitHub Actions workflows). A job run writes data/job_health_<id>.json so
 * the monitor can distinguish "collector ran and checked" from "collector
 * silently stopped": event archives with no new events are legitimate only
 * when the producer check itself has a fresh receipt.
 *
 * Truth rules:
 * - A failed step never advances lastSuccessAt; the previous run's receipt is
 *   carried forward instead.
 * - finishJob only grants job-level lastSuccessAt when every expected step
 *   succeeded this run. Partial runs keep the older job receipt.
 * - Nothing here exits the process or fabricates timestamps; callers must
 *   still write heartbeat + useful partial artifacts before exitCode=1.
 */

const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./data_health_cache');
const { MONITOR_JOBS } = require('./data_health_monitor_policy');

const MAX_FUTURE_SKEW_MS = 5 * 60000;
const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');

// Expected producer steps per job (fixed contract with the monitor rules).
const EXPECTED_STEPS = Object.freeze({
  macro_snapshot: ['macro', 'preferreds'],
  liquidity_hourly: ['samples'],
  block_insight_daily: ['option_oi', 'block_trades', 'marks'],
  mcclellan_daily: ['pipeline']
});

// Previous run's step receipts, stashed at beginJob so a failed step can
// carry its older lastSuccessAt into the new record.
const previousSteps = new Map();

function toMs(ts) {
  const ms = ts instanceof Date ? ts.getTime() : (typeof ts === 'number' ? ts : Date.parse(ts));
  return Number.isFinite(ms) ? ms : null;
}
const toIso = ms => new Date(ms).toISOString();

function requireNow(now) {
  const ms = toMs(now === undefined ? Date.now() : now);
  if (ms === null || ms <= 0 || ms > Date.now() + MAX_FUTURE_SKEW_MS) {
    throw new Error('pipeline_health: invalid now timestamp');
  }
  return ms;
}

function optionalTs(ts, field) {
  if (ts === null || ts === undefined) return null;
  const ms = toMs(ts);
  if (ms === null || ms <= 0 || ms > Date.now() + MAX_FUTURE_SKEW_MS) {
    throw new Error(`pipeline_health: invalid ${field} timestamp`);
  }
  return ms;
}

function requireJob(id) {
  if (!MONITOR_JOBS.includes(id)) {
    throw new Error(`pipeline_health: unknown monitored job ${JSON.stringify(id)}`);
  }
  return id;
}

function jobFile(id, dataDir) {
  return path.join(dataDir || DEFAULT_DATA_DIR, `job_health_${id}.json`);
}

function readJob(id, { dataDir } = {}) {
  requireJob(id);
  try {
    const j = JSON.parse(fs.readFileSync(jobFile(id, dataDir), 'utf8'));
    return j && typeof j === 'object' && j.id === id ? j : null;
  } catch (err) {
    return null;
  }
}

function persist(id, record, dataDir) {
  atomicWriteJson(jobFile(id, dataDir), record, 2);
}

/** Begin a run: fresh attempt clock, prior receipts preserved for rollback. */
function beginJob(id, { now = Date.now(), dataDir } = {}) {
  const nowMs = requireNow(now);
  requireJob(id);
  const prev = readJob(id, { dataDir }) || {};
  previousSteps.set(id, prev.steps && typeof prev.steps === 'object' ? prev.steps : {});
  const record = {
    id,
    status: 'running',
    lastAttemptAt: toIso(nowMs),
    lastSuccessAt: prev.lastSuccessAt || null,
    lastError: null,
    steps: {}
  };
  persist(id, record, dataDir);
  return record;
}

/**
 * Record one step outcome. ok (or verifiedSkip — the step verified existing
 * state was already complete) advances the step receipt to the real check
 * time; a failed step keeps the previous run's lastSuccessAt.
 */
function recordStep(id, name, { ok, error = null, now = Date.now(), dataAsOf = null, verifiedSkip = false, dataDir } = {}) {
  const nowMs = requireNow(now);
  const dataAsOfMs = optionalTs(dataAsOf, 'dataAsOf');
  requireJob(id);
  const record = readJob(id, { dataDir }) || {
    id, status: 'running', lastAttemptAt: null, lastSuccessAt: null, lastError: null, steps: {}
  };
  const prior = (previousSteps.get(id) || {})[name] || record.steps?.[name] || null;
  const step = {
    status: ok ? 'ok' : 'failed',
    lastAttemptAt: toIso(nowMs),
    lastSuccessAt: ok ? toIso(nowMs) : (prior && prior.lastSuccessAt) || null,
    lastError: ok ? null : (error && error.message ? String(error.message) : String(error || 'step failed')),
    dataAsOf: dataAsOfMs === null ? null : toIso(dataAsOfMs),
    verifiedSkip: !!verifiedSkip
  };
  record.steps = { ...(record.steps || {}), [name]: step };
  persist(id, record, dataDir);
  return record;
}

/**
 * Close the run. Every expected step ok -> status 'ok' and the job receipt
 * advances; otherwise 'partial' (≥1 ok) or 'failed', keeping the older
 * lastSuccessAt. Failures while finishing are persisted best-effort instead
 * of thrown — the caller still decides its own exit code.
 */
function finishJob(id, { now = Date.now(), dataDir } = {}) {
  try {
    const nowMs = requireNow(now);
    requireJob(id);
    const record = readJob(id, { dataDir }) || {
      id, status: 'running', lastAttemptAt: null, lastSuccessAt: null, lastError: null, steps: {}
    };
    const steps = record.steps || {};
    const results = EXPECTED_STEPS[id].map(name => steps[name] || null);
    const okCount = results.filter(s => s && s.status === 'ok').length;
    const errors = EXPECTED_STEPS[id]
      .filter(name => !steps[name] || steps[name].status !== 'ok')
      .map(name => `${name}: ${steps[name] ? steps[name].lastError : 'not recorded'}`);

    if (okCount === EXPECTED_STEPS[id].length) {
      record.status = 'ok';
      record.lastSuccessAt = toIso(nowMs);
      record.lastError = null;
    } else {
      record.status = okCount > 0 ? 'partial' : 'failed';
      record.lastError = errors.join('; ');
      // lastSuccessAt preserved: a partial run is not a full collection.
    }
    persist(id, record, dataDir);
    previousSteps.delete(id);
    return record;
  } catch (err) {
    try {
      const record = readJob(id, { dataDir });
      if (record) {
        record.status = record.status === 'ok' ? 'ok' : 'failed';
        record.lastError = `finishJob internal error: ${err.message}`;
        persist(id, record, dataDir);
      }
    } catch (inner) {
      console.error(`[pipeline_health] finishJob ${id} could not persist failure: ${inner.message}`);
    }
    previousSteps.delete(id);
    return null;
  }
}

module.exports = { beginJob, recordStep, finishJob, readJob, EXPECTED_STEPS };
