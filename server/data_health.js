/**
 * Per-source data health registry (singleton).
 *
 * Records attempts/successes/failures per upstream source id and derives a
 * truthful health verdict per data_health_policy.js windows. A failed refresh
 * never extends any timestamp: it only records lastAttemptAt/lastError and
 * increments consecutiveFailures, preserving the last good receipt.
 */

const { getSourcePolicy } = require('./data_health_policy');

const MAX_FUTURE_SKEW_MS = 5 * 60000;
const registry = new Map();

function toMs(ts) {
  if (ts === null || ts === undefined) return null;
  const ms = ts instanceof Date ? ts.getTime() : (typeof ts === 'number' ? ts : new Date(ts).getTime());
  return Number.isFinite(ms) ? ms : null;
}

const toIso = ms => new Date(ms).toISOString();

function requireNow(now) {
  const ms = toMs(now);
  if (ms === null) throw new Error('data_health: invalid now timestamp');
  return ms;
}

/**
 * Validate an explicit timestamp: must parse and must not be more than 5 min
 * in the future. Throws before any mutation; callers must not invent one.
 */
function validateTs(ts, nowMs, field) {
  const ms = toMs(ts);
  if (ms === null) throw new Error(`data_health: invalid ${field} timestamp`);
  if (ms > nowMs + MAX_FUTURE_SKEW_MS) {
    throw new Error(`data_health: ${field} timestamp is more than 5min in the future`);
  }
  return ms;
}

function ensureRecord(id) {
  let r = registry.get(id);
  if (!r) {
    r = {
      lastAttemptAt: null,
      lastSuccessAt: null,
      dataAsOf: null,
      asOfKind: null,
      source: null,
      lastError: null,
      consecutiveFailures: 0,
      issues: [],
      available: true
    };
    registry.set(id, r);
  }
  return r;
}

function recordAttempt(id, { now = Date.now() } = {}) {
  const nowMs = requireNow(now);
  ensureRecord(id).lastAttemptAt = toIso(nowMs);
}

function recordSuccess(id, { now = Date.now(), dataAsOf, asOfKind = 'source', source = null, issues = [] } = {}) {
  const nowMs = requireNow(now);
  const dataAsOfMs = dataAsOf === null || dataAsOf === undefined ? null : validateTs(dataAsOf, nowMs, 'dataAsOf');
  const r = ensureRecord(id); // mutate only after validation above
  r.lastAttemptAt = toIso(nowMs);
  r.lastSuccessAt = toIso(nowMs);
  r.dataAsOf = dataAsOfMs === null ? null : toIso(dataAsOfMs);
  r.asOfKind = asOfKind;
  r.source = source;
  r.lastError = null;
  r.consecutiveFailures = 0;
  r.issues = Array.isArray(issues) ? issues.map(String) : [String(issues)];
  r.available = true; // a real success restores availability
}

function recordFailure(id, error, { now = Date.now() } = {}) {
  const nowMs = requireNow(now);
  const r = ensureRecord(id);
  r.lastAttemptAt = toIso(nowMs);
  r.lastError = error && error.message ? String(error.message) : String(error);
  r.consecutiveFailures += 1;
  // lastSuccessAt / dataAsOf / availability intentionally untouched
}

function seedSource(id, { dataAsOf, lastSuccessAt = null, asOfKind = 'source', source = 'disk', issues = [], now = Date.now() } = {}) {
  if (registry.has(id)) return registry.get(id); // never overwrite a runtime record
  const nowMs = requireNow(now);
  // Validate EVERY explicit timestamp before the record exists so a bad seed
  // leaves no observed=true residue in the registry.
  const dataAsOfMs = dataAsOf === null || dataAsOf === undefined ? null : validateTs(dataAsOf, nowMs, 'dataAsOf');
  const successMs = lastSuccessAt === null ? null : validateTs(lastSuccessAt, nowMs, 'lastSuccessAt');
  const r = ensureRecord(id);
  r.dataAsOf = dataAsOfMs === null ? null : toIso(dataAsOfMs);
  r.lastSuccessAt = successMs === null ? null : toIso(successMs);
  r.asOfKind = asOfKind;
  r.source = source;
  r.issues = Array.isArray(issues) ? issues.map(String) : [String(issues)];
  return r;
}

/**
 * Pure health derivation from a record-shaped object (registry record or a
 * clamped payload-bound record). Returns the same shape as getSourceHealth.
 */
function deriveSourceHealth(id, r, now = Date.now()) {
  const nowMs = requireNow(now);
  const policy = getSourcePolicy(id);

  const ageMs = r && r.lastSuccessAt ? nowMs - toMs(r.lastSuccessAt) : null;
  const dataAgeMs = r && r.dataAsOf ? nowMs - toMs(r.dataAsOf) : null;
  const warnings = [];

  let state = 'UNKNOWN';
  let freshnessStatus = 'UNKNOWN';
  let usable = false;
  let stale = false;
  let expired = false;

  if (r) {
    freshnessStatus = dataAgeMs === null ? 'UNKNOWN' : (dataAgeMs > policy.dataWarnMs ? 'STALE' : 'FRESH');
    if (r.available === false) {
      state = 'UNAVAILABLE';
    } else if (r.dataAsOf === null || r.lastSuccessAt === null) {
      // No usable data timestamp, or no verified receipt (e.g. disk seed without
      // lastSuccessAt): browsable history at best, never a live-usable source.
      // A failure with no valid data is a real outage, not an unknown.
      state = r.lastError ? 'UNAVAILABLE' : 'UNKNOWN';
    } else {
      const fetchExpired = ageMs > policy.fetchBlockMs;
      const dataExpired = dataAgeMs > policy.dataBlockMs;
      expired = fetchExpired || dataExpired;
      const fetchWarn = ageMs > policy.fetchWarnMs;
      const dataWarn = dataAgeMs > policy.dataWarnMs;
      stale = fetchWarn || dataWarn || expired;
      if (expired) {
        state = 'STALE';
        if (fetchExpired) warnings.push(`receipt at ${r.lastSuccessAt} exceeds fetchBlockMs ${policy.fetchBlockMs}ms`);
        if (dataExpired) warnings.push(`data at ${r.dataAsOf} exceeds dataBlockMs ${policy.dataBlockMs}ms`);
      } else {
        usable = true;
        if (fetchWarn) warnings.push(`receipt at ${r.lastSuccessAt} exceeds fetchWarnMs ${policy.fetchWarnMs}ms`);
        if (dataWarn) warnings.push(`data at ${r.dataAsOf} exceeds dataWarnMs ${policy.dataWarnMs}ms`);
        if (fetchWarn || dataWarn) {
          state = 'STALE';
        } else if (r.source === 'disk' || r.lastError || r.issues.length) {
          state = 'FALLBACK';
        } else {
          state = 'OK';
        }
      }
    }
  }

  return {
    id,
    observed: !!r,
    state,
    freshnessStatus,
    usable,
    stale,
    expired,
    ageMs,
    dataAgeMs,
    warnings,
    policy,
    lastAttemptAt: r ? r.lastAttemptAt : null,
    lastSuccessAt: r ? r.lastSuccessAt : null,
    dataAsOf: r ? r.dataAsOf : null,
    asOfKind: r ? r.asOfKind : null,
    source: r ? r.source : null,
    lastError: r ? r.lastError : null,
    consecutiveFailures: r ? r.consecutiveFailures : 0,
    issues: r ? [...(r.issues || [])] : [],
    available: r ? r.available : true
  };
}

function getSourceHealth(id, now = Date.now()) {
  return deriveSourceHealth(id, registry.get(id), now);
}

/**
 * Aggregate per-source healths. `resolveHealth` defaults to live registry
 * lookups; callers that must bind clocks to a specific payload (e.g.
 * withDataHealth on a persisted/accepted snapshot) supply their own resolver
 * so one source's fresh registry clock never rejuvenates another payload's
 * older data.
 */
function summarizeHealth(ids, now = Date.now(), resolveHealth) {
  const list = Array.isArray(ids) ? ids : [];
  if (!list.length) {
    return { state: 'UNKNOWN', analysisAllowed: false, stale: false, sources: {}, failedSources: [], blockedSources: [] };
  }
  const sources = {};
  for (const id of list) sources[id] = (resolveHealth || getSourceHealth)(id, now);
  const healths = list.map(id => sources[id]);
  // Any non-OK source is reported as failed/degraded; blockedSources is the
  // stricter subset that actually cannot be used at all.
  const failedSources = list.filter(id => sources[id].state !== 'OK');
  const blockedSources = list.filter(id => !sources[id].usable);
  const analysisAllowed = blockedSources.length === 0;
  let state;
  if (healths.every(h => h.state === 'OK')) state = 'OK';
  else if (healths.every(h => h.state === 'UNKNOWN')) state = 'UNKNOWN';
  else if (!healths.some(h => h.usable)) state = 'UNAVAILABLE';
  else state = 'DEGRADED';
  return {
    state,
    analysisAllowed,
    stale: healths.some(h => h.stale),
    sources,
    failedSources,
    blockedSources
  };
}

/** Read-only copy of observed registry entries, optionally filtered by id prefix. */
function listSources(prefix) {
  const out = [];
  for (const [id, r] of registry.entries()) {
    if (prefix !== undefined && !String(id).startsWith(prefix)) continue;
    out.push({ id, ...r, issues: [...r.issues] });
  }
  return out;
}

function resetHealthForTests() {
  registry.clear();
}

module.exports = {
  recordAttempt,
  recordSuccess,
  recordFailure,
  seedSource,
  getSourceHealth,
  deriveSourceHealth,
  summarizeHealth,
  listSources,
  resetHealthForTests
};
