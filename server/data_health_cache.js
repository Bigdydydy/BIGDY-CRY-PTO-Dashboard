/**
 * Shared helpers for leaf data-source modules: attach live recomputed health
 * to payloads, restore honest clocks from persisted payloads, and write JSON
 * snapshots atomically so a failed write never corrupts the last good file.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { summarizeHealth, getSourceHealth, deriveSourceHealth, seedSource } = require('./data_health');

const MAX_FUTURE_SKEW_MS = 5 * 60000;

function toMs(ts) {
  if (ts === null || ts === undefined) return null;
  const ms = ts instanceof Date ? ts.getTime() : (typeof ts === 'number' ? ts : new Date(ts).getTime());
  return Number.isFinite(ms) ? ms : null;
}

/** First candidate that parses and is not far-future, else null. */
function pickTrustedTs(...candidates) {
  for (const c of candidates) {
    const ms = toMs(c);
    if (ms !== null && ms <= Date.now() + MAX_FUTURE_SKEW_MS) return ms;
  }
  return null;
}

/**
 * Recompute health for `id` bound to `persisted` — the health snapshot this
 * payload carried when it was accepted. Per-source lastSuccessAt/dataAsOf are
 * clamped to the OLDER of the payload's accepted clock and the live registry
 * clock, so a fresh fetch of a sibling source can never rejuvenate this
 * payload's older data. A missing clock on either side stays unverifiable
 * (null wins). The latest registry lastError/issues are overlaid so a new
 * failure still shows through.
 */
function boundSourceHealth(id, persisted, now) {
  const reg = getSourceHealth(id, now);
  if (!persisted || typeof persisted !== 'object') return reg;
  const older = (a, b) => {
    const am = toMs(a);
    const bm = toMs(b);
    if (am === null || bm === null) return null;
    return am <= bm ? am : bm;
  };
  const olderMs = older(persisted.lastSuccessAt, reg.lastSuccessAt);
  const olderDataMs = older(persisted.dataAsOf, reg.dataAsOf);
  const record = {
    lastAttemptAt: reg.lastAttemptAt || persisted.lastAttemptAt || null,
    // Keep ISO strings so bound payloads expose the same shape as registry health.
    lastSuccessAt: olderMs === null ? null : new Date(olderMs).toISOString(),
    dataAsOf: olderDataMs === null ? null : new Date(olderDataMs).toISOString(),
    asOfKind: persisted.asOfKind || reg.asOfKind || null,
    source: persisted.source || reg.source || null,
    lastError: reg.lastError || null,
    consecutiveFailures: reg.consecutiveFailures || 0,
    issues: (Array.isArray(reg.issues) && reg.issues.length)
      ? reg.issues
      : (Array.isArray(persisted.issues) ? persisted.issues : []),
    available: reg.available !== false
  };
  const h = deriveSourceHealth(id, record, now);
  h.observed = true;
  return h;
}

/**
 * Shallow-clone `payload` and attach a live `dataHealth` summary for
 * `requiredIds`. When the payload already carries a `dataHealth.sources`
 * snapshot from its acceptance, every source's clocks are bound to that
 * snapshot (see boundSourceHealth) instead of the global registry.
 * `ancillaryIds` are reported per-source under `ancillarySources`; an
 * observed non-OK ancillary source may demote the aggregate OK -> DEGRADED
 * but can never upgrade anything.
 */
function withDataHealth(payload, requiredIds, ancillaryIds = []) {
  const out = { ...(payload || {}) };
  const persistedSources = payload && payload.dataHealth && payload.dataHealth.sources;
  const persistedAncillary = payload && payload.ancillarySources;
  const now = Date.now();
  const resolve = persistedSources
    ? (id) => boundSourceHealth(id, persistedSources[id], now)
    : undefined;
  const health = summarizeHealth(requiredIds, now, resolve);
  const ancillary = {};
  for (const id of ancillaryIds) {
    ancillary[id] = persistedAncillary && persistedAncillary[id]
      ? boundSourceHealth(id, persistedAncillary[id], now)
      : getSourceHealth(id, now);
  }
  if (health.state === 'OK' && ancillaryIds.some(id => {
    const h = ancillary[id];
    return h.observed && h.state !== 'OK';
  })) {
    health.state = 'DEGRADED';
  }
  out.dataHealth = health;
  if (ancillaryIds.length) out.ancillarySources = ancillary;
  return out;
}

/**
 * Restore honest clocks for `id` from a persisted payload. Priority:
 * payload.dataHealth.sources[id] (written by withDataHealth on a real
 * success), then caller-provided hints (e.g. a real snapshot timestamp).
 * Untrusted/missing timestamps are never invented; whatever is seeded is
 * always flagged source:'disk' so it can only ever be FALLBACK.
 * Returns true when a seed was applied.
 */
function seedCachedHealth(payload, id, hints = {}) {
  const persisted = payload && payload.dataHealth && payload.dataHealth.sources
    ? payload.dataHealth.sources[id]
    : null;
  const dataAsOfMs = pickTrustedTs(persisted && persisted.dataAsOf, hints.dataAsOf);
  const lastSuccessMs = pickTrustedTs(persisted && persisted.lastSuccessAt, hints.lastSuccessAt);
  if (dataAsOfMs === null && lastSuccessMs === null) return false;
  const issues = Array.isArray(persisted && persisted.issues)
    ? persisted.issues
    : (Array.isArray(hints.issues) ? hints.issues : []);
  try {
    seedSource(id, {
      dataAsOf: dataAsOfMs === null ? null : new Date(dataAsOfMs).toISOString(),
      lastSuccessAt: lastSuccessMs === null ? null : new Date(lastSuccessMs).toISOString(),
      asOfKind: (persisted && persisted.asOfKind) || hints.asOfKind || 'source',
      source: 'disk',
      issues
    });
    return true;
  } catch (err) {
    return false; // an untrusted seed must never throw inside a getter
  }
}

/**
 * Write JSON to a unique same-directory temp file then rename over `file`.
 * The existing file is never truncated on failure; the temp file is cleaned
 * up. Callers must validate `data` BEFORE invoking this.
 */
const sleepMsSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function atomicWriteJson(file, data, space = 0) {
  const dir = path.dirname(file);
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, space), 'utf8');
    // Windows transiently holds locks on fresh temp/destination paths
    // (indexer/AV): retry the rename briefly before surfacing the failure.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, file);
        break;
      } catch (err) {
        if ((err.code === 'EPERM' || err.code === 'EBUSY') && attempt < 5) {
          sleepMsSync(5 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (e) { /* best effort */ }
    throw err;
  }
  return file;
}

module.exports = {
  withDataHealth,
  seedCachedHealth,
  atomicWriteJson
};
