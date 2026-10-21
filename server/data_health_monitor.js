const { getSourcePolicy } = require('./data_health_policy');
const {
  MONITOR_JOBS, MONITOR_LIVE_MODULES, SNAPSHOT_CHECKS, MONITOR_CONTRACT, JOB_POLICIES
} = require('./data_health_monitor_policy');

const PRIORITY = { HEALTHY: 0, DEGRADED: 1, UNKNOWN: 2, CRITICAL: 3 };
const worst = states => states.reduce((a, b) => PRIORITY[b] > PRIORITY[a] ? b : a, 'HEALTHY');
const finite = value => typeof value === 'number' && Number.isFinite(value);

function timestamp(value, now) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms) || ms <= 0 || ms > now + MONITOR_CONTRACT.maxFutureSkewMs) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      new Date(ms).toISOString().slice(0, 10) !== value) return null;
  return ms;
}

function ageCheck(value, warnMs, blockMs, now) {
  const ms = timestamp(value, now);
  if (ms === null) return { state: 'UNKNOWN', asOf: null, reason: 'Missing or invalid timestamp' };
  const ageMs = Math.max(0, now - ms);
  const state = ageMs > blockMs ? 'CRITICAL' : ageMs > warnMs ? 'DEGRADED' : 'HEALTHY';
  return { state, asOf: new Date(ms).toISOString(), ageMs };
}

function inspectJob(id, record, now) {
  if (!record || record.id !== id) return { state: 'UNKNOWN', reason: 'Producer heartbeat missing or mismatched' };
  const p = JOB_POLICIES[id];
  const result = ageCheck(record.lastSuccessAt, p.warnMs, p.blockMs, now);
  if (timestamp(record.lastAttemptAt, now) === null) {
    return { ...result, state: 'UNKNOWN', reason: 'Invalid producer attempt timestamp' };
  }
  if (record.status === 'failed' || record.status === 'partial') {
    result.state = result.asOf === null ? 'CRITICAL' : worst([result.state, 'DEGRADED']);
    result.reason = record.lastError || `Latest producer run ${record.status}`;
  } else if (!['ok', 'running'].includes(record.status)) {
    result.state = worst([result.state, 'UNKNOWN']);
    result.reason = 'Unknown producer outcome';
  }
  return { ...result, lastAttemptAt: record.lastAttemptAt, producerStatus: record.status };
}

function inspectSourceSnapshot(rule, data, now) {
  const sources = {};
  const declared = rule.requiredSourcesField && Array.isArray(data[rule.requiredSourcesField])
    ? data[rule.requiredSourcesField].filter(id => (rule.allowedSources || rule.sources).includes(id))
    : [];
  for (const id of declared.length ? declared : rule.sources) {
    const h = data.dataHealth?.sources?.[id];
    if (!h || timestamp(h.lastSuccessAt, now) === null) {
      sources[id] = { state: 'UNKNOWN', reason: 'Verified source receipt missing' };
      continue;
    }
    const p = getSourcePolicy(id);
    const result = ageCheck(h.dataAsOf, p.dataWarnMs, p.dataBlockMs, now);
    if (h.available === false) {
      result.state = 'CRITICAL';
      result.reason = 'Source data unavailable';
    } else if (h.lastError || h.issues?.length) {
      result.state = worst([result.state, 'DEGRADED']);
      result.reason = h.lastError || h.issues.join('; ');
    }
    sources[id] = { ...result, lastSuccessAt: h.lastSuccessAt };
  }
  return { state: worst(Object.values(sources).map(h => h.state)), sources };
}

function inspectSamples(rule, data, now) {
  const rows = data[rule.arrayField];
  if (!Array.isArray(rows) || !rows.length) return { state: 'UNKNOWN', reason: 'Archive samples missing' };
  let latest = null;
  for (const row of rows) {
    const ms = timestamp(row?.[rule.timestampField], now);
    if (ms === null) return { state: 'UNKNOWN', reason: 'Invalid archive sample timestamp' };
    if (latest === null || ms > latest) latest = ms;
  }
  const p = getSourcePolicy(rule.sourcePolicy);
  return ageCheck(latest, p.dataWarnMs, p.dataBlockMs, now);
}

function inspectBreadth(rule, data, now) {
  const track = data.current?.[rule.track];
  if (!track || typeof track.ready !== 'boolean' || !Array.isArray(data.series) || !data.series.length) {
    return { state: 'UNKNOWN', reason: 'Breadth source schema missing' };
  }
  let latest = null;
  for (const row of data.series) {
    const n = row?.[rule.seriesCountField];
    if (n === null || n === undefined) continue; // The other track may have a longer history.
    if (!finite(n) || n <= 0) return { state: 'UNKNOWN', reason: 'Invalid breadth constituent count' };
    const ms = timestamp(row.date, now);
    if (ms === null) return { state: 'UNKNOWN', reason: 'Invalid breadth source date' };
    if (latest === null || ms > latest) latest = ms;
  }
  const currentAt = timestamp(track.date, now);
  if (currentAt === null || latest === null || currentAt !== latest) {
    return { state: 'UNKNOWN', reason: 'Current breadth date does not match actual source rows' };
  }
  if (track.ready && (!finite(track.oscillator) || !finite(track.summation))) {
    return { state: 'UNKNOWN', reason: 'Published breadth values invalid' };
  }
  const p = getSourcePolicy(rule.sourcePolicy);
  return { ...ageCheck(currentAt, p.dataWarnMs, p.dataBlockMs, now), warmingUp: !track.ready };
}

function inspectEvents(rule, data, jobs, now) {
  const collection = data[rule.collectionField];
  const validCollection = rule.collectionField === 'structures'
    ? Array.isArray(collection)
    : collection && typeof collection === 'object' && !Array.isArray(collection);
  if (!validCollection) return { state: 'UNKNOWN', reason: 'Event archive schema missing' };
  const step = jobs[rule.producerJob]?.steps?.[rule.producerStep];
  if (!step) return { state: 'UNKNOWN', reason: 'Event producer step heartbeat missing' };
  const p = JOB_POLICIES[rule.producerJob];
  const result = ageCheck(step.lastSuccessAt, p.warnMs, p.blockMs, now);
  if (step.status !== 'ok') {
    result.state = result.asOf === null ? 'CRITICAL' : worst([result.state, 'DEGRADED']);
    result.reason = step.lastError || 'Event producer step did not complete';
  }
  return { ...result, clockKind: 'producer_check', noNewEventsIsValid: true };
}

function inspectLive(live) {
  if (!live) return { state: 'UNKNOWN', reason: 'Live dashboard audit URL not configured' };
  if (live.error) return { state: 'CRITICAL', reason: String(live.error) };
  const report = live.report;
  if (!report || report.code !== 0 || !report.modules ||
      typeof report.modules !== 'object' || Array.isArray(report.modules)) {
    return { state: 'UNKNOWN', reason: 'Invalid live audit response' };
  }
  const modules = Object.values(report.modules);
  if (!modules.length || modules.length !== report.modulesCount) {
    return { state: 'UNKNOWN', reason: 'Live audit module coverage invalid' };
  }
  if (MONITOR_LIVE_MODULES.some(id => !report.modules[id])) {
    return { state: 'UNKNOWN', reason: 'Required live modules absent from audit response' };
  }
  if (modules.some(m => m.healthStatus === 'OFFLINE')) return { state: 'CRITICAL', reason: 'Live module offline' };
  if (report.overallHealth === 'CRITICAL') return { state: 'CRITICAL', reason: 'Live audit critical' };
  if (report.overallHealth === 'HEALTHY' && modules.every(m => m.healthStatus === 'ONLINE')) {
    return { state: 'HEALTHY' };
  }
  if (report.overallHealth === 'UNKNOWN') return { state: 'UNKNOWN', reason: 'Live sources not yet verified' };
  return { state: 'DEGRADED', reason: 'Live sources degraded or not yet acquired' };
}

// Pure evaluation: callers collect files/HTTP responses. No I/O, refreshes,
// synthetic success timestamps, model calculations, or outbound alerts here.
function evaluateMonitoring({ jobs = {}, snapshots = {}, live = null } = {}, now = Date.now()) {
  if (!finite(now) || now <= 0) throw new Error('Invalid monitoring clock');
  const jobResults = {};
  for (const id of MONITOR_JOBS) jobResults[id] = inspectJob(id, jobs[id], now);
  const artifacts = {};
  for (const rule of SNAPSHOT_CHECKS) {
    const data = snapshots[rule.file];
    if (!data || typeof data !== 'object') {
      artifacts[rule.id] = { state: 'UNKNOWN', reason: `Snapshot missing or unreadable: ${rule.file}` };
    } else if (rule.kind === 'source_metadata') {
      artifacts[rule.id] = inspectSourceSnapshot(rule, data, now);
    } else if (rule.kind === 'sample_times') {
      artifacts[rule.id] = inspectSamples(rule, data, now);
    } else if (rule.kind === 'breadth_track') {
      artifacts[rule.id] = inspectBreadth(rule, data, now);
    } else if (rule.kind === 'event_archive') {
      artifacts[rule.id] = inspectEvents(rule, data, jobs, now);
    } else {
      throw new Error(`Unknown monitoring rule kind: ${rule.kind}`);
    }
  }
  const liveResult = inspectLive(live);
  const checks = {
    ...Object.fromEntries(Object.entries(jobResults).map(([id, value]) => [`job:${id}`, value])),
    ...Object.fromEntries(Object.entries(artifacts).map(([id, value]) => [`artifact:${id}`, value])),
    live_dashboard: liveResult
  };
  const alerts = Object.entries(checks).filter(([, check]) => check.state !== 'HEALTHY')
    .map(([id, check]) => ({ id, state: check.state, reason: check.reason || 'Source health requires attention' }));
  return {
    checkedAt: new Date(now).toISOString(),
    overallHealth: worst(Object.values(checks).map(check => check.state)),
    jobs: jobResults, artifacts, live: liveResult, alerts
  };
}

module.exports = { evaluateMonitoring };
