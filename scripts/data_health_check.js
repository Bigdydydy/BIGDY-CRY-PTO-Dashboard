#!/usr/bin/env node
/**
 * Data health monitor CLI (hourly GitHub Actions job).
 *
 * Reads producer heartbeats (data/job_health_<job>.json) and the committed
 * snapshot files listed in SNAPSHOT_CHECKS, optionally queries the live
 * dashboard audit URL, then evaluates everything through the pure
 * evaluateMonitoring contract. A missing or unreadable file stays
 * `undefined` in the input — the evaluator decides UNKNOWN; this script
 * never substitutes mtimes or current time.
 *
 * Usage: node scripts/data_health_check.js [--output PATH]
 * Env:   DASHBOARD_HEALTH_URL — optional https (or http://localhost) audit URL.
 *        GITHUB_STEP_SUMMARY — when set, a readable check list is appended.
 * Exit:  0 iff report.overallHealth === 'HEALTHY', else 1.
 */

const fs = require('fs');
const path = require('path');
const { fetchWithTimeout } = require('../server/http_client');
const { atomicWriteJson } = require('../server/data_health_cache');
const { evaluateMonitoring } = require('../server/data_health_monitor');
const {
  MONITOR_JOBS, SNAPSHOT_CHECKS, MONITOR_CONTRACT
} = require('../server/data_health_monitor_policy');

const REPO = path.join(__dirname, '..');
const DEFAULT_DATA_DIR = path.join(REPO, 'data');

function readJsonOrUndefined(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return undefined; // evaluator reports UNKNOWN — never substitute file mtime
  }
}

function loopbackUrl(url) {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
}

/** Live audit URL: https only, or http to a loopback mock. No credentials. */
function validateLiveUrl(raw) {
  let url;
  try { url = new URL(raw); } catch (e) { throw new Error('live audit URL is not a valid URL'); }
  const ok = url.protocol === 'https:' || (url.protocol === 'http:' && loopbackUrl(url));
  if (!ok) throw new Error('live audit URL must be https (or loopback http for tests)');
  if (url.username || url.password) throw new Error('live audit URL must not embed credentials');
  return url.toString();
}

/** Fixed, URL-free failure classifications — the deployed URL is a secret
 * and can appear inside thrown error messages, so raw text never reaches
 * the report. */
function classifyLiveFailure(err) {
  if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) return 'timeout';
  return 'request failed';
}

async function fetchLiveReport(raw, fetcher = fetchWithTimeout) {
  let safe;
  try { safe = validateLiveUrl(raw); }
  catch (e) { return { error: 'live audit URL rejected' }; }
  try {
    const resp = await fetcher(safe, {
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      timeout: MONITOR_CONTRACT.liveTimeoutMs,
      retries: MONITOR_CONTRACT.liveRetries
    });
    if (!resp || !resp.ok) {
      const status = resp && typeof resp.status === 'number' ? `HTTP ${resp.status}` : 'no response';
      return { error: `live audit fetch failed (${status})` };
    }
    try {
      return { report: await resp.json() };
    } catch (e) {
      return { error: 'live audit fetch failed (invalid JSON)' };
    }
  } catch (err) {
    return { error: `live audit fetch failed (${classifyLiveFailure(err)})` };
  }
}

function escapeMd(s) {
  return String(s).replace(/([\\`*_[\]|<>])/g, '\\$1');
}

function formatSummary(report) {
  const lines = [
    '## Data source health',
    '',
    `- **Overall:** ${report.overallHealth} (checked ${report.checkedAt})`,
    '',
    '| Check | State | Reason |',
    '| --- | --- | --- |'
  ];
  const entries = [
    ...Object.entries(report.jobs).map(([k, v]) => [`job:${k}`, v]),
    ...Object.entries(report.artifacts).map(([k, v]) => [`artifact:${k}`, v]),
    ['live_dashboard', report.live]
  ];
  for (const [id, check] of entries) {
    lines.push(`| ${escapeMd(id)} | ${check.state} | ${escapeMd(check.reason || '—')} |`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Injectable for tests: pass dataDir/outputPath/fetcher/now/env. Default env
 * is process.env; the default run never writes into repo data/.
 */
async function runCheck({
  dataDir = DEFAULT_DATA_DIR,
  outputPath = null,
  fetcher = fetchWithTimeout,
  now = Date.now(),
  env = process.env,
  summaryPath = process.env.GITHUB_STEP_SUMMARY || null
} = {}) {
  const jobs = {};
  for (const id of MONITOR_JOBS) jobs[id] = readJsonOrUndefined(path.join(dataDir, `job_health_${id}.json`));
  const snapshots = {};
  for (const rule of SNAPSHOT_CHECKS) snapshots[rule.file] = readJsonOrUndefined(path.join(dataDir, rule.file));

  const liveUrl = env.DASHBOARD_HEALTH_URL || null;
  const live = liveUrl ? await fetchLiveReport(liveUrl, fetcher) : null;

  const report = evaluateMonitoring({ jobs, snapshots, live }, now);

  if (outputPath) atomicWriteJson(outputPath, report, 2);

  console.log(`[data-health] overall ${report.overallHealth} @ ${report.checkedAt}`);
  for (const a of report.alerts) console.log(`[data-health] ${a.state} ${a.id}: ${a.reason}`);

  if (summaryPath) {
    try { fs.appendFileSync(summaryPath, formatSummary(report), 'utf8'); }
    catch (err) { console.warn(`[data-health] could not write step summary: ${err.message}`); }
  }

  return report;
}

if (require.main === module) {
  const outIdx = process.argv.indexOf('--output');
  const outputPath = outIdx >= 0 ? process.argv[outIdx + 1] : null;
  runCheck({ outputPath }).then(report => {
    process.exit(report.overallHealth === 'HEALTHY' ? 0 : 1);
  }).catch(err => {
    console.error('[data-health] check failed:', err.message);
    process.exit(1);
  });
}

module.exports = { runCheck, validateLiveUrl, formatSummary };
