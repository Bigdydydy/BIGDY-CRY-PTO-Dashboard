#!/usr/bin/env node
/**
 * Record a pipeline producer heartbeat after a non-Node collector ran.
 * Only mcclellan_daily is supported (the Python breadth pipeline).
 *
 *   node scripts/record_pipeline_result.js mcclellan_daily
 *
 * PIPELINE_OUTCOME carries the workflow step's outcome. The 'pipeline' step
 * is ok only when outcome === 'success' AND the exported dataset passes the
 * same schema validation the server applies. This script never re-runs or
 * modifies the pipeline output, never recomputes dates, and exits 0 even
 * when the recorded outcome is a failure — the failed step is already red
 * in the workflow; the heartbeat write must not block the artifact commit.
 */

const fs = require('fs');
const path = require('path');
const { validateMcClellanData } = require('../server/crypto_mcclellan_fetcher');
const { beginJob, recordStep, finishJob } = require('../server/pipeline_health');

const ALLOWED = new Set(['mcclellan_daily']);
const SNAPSHOT_FILE = path.join(__dirname, '..', 'data', 'crypto_mcclellan.json');

/**
 * Injectable for tests: job/outcome/snapshotFile/dataDir can be passed in.
 * Returns the intended exit code; the caller decides process.exit.
 */
function run({ job, outcome = '', snapshotFile = SNAPSHOT_FILE, dataDir } = {}) {
  if (!ALLOWED.has(job)) {
    console.error(`[record_pipeline_result] unsupported job: ${job || '(missing)'} — allowed: ${[...ALLOWED].join(', ')}`);
    return 2;
  }

  beginJob(job, { dataDir });

  let ok = false;
  let reason = `pipeline outcome ${outcome || 'unknown'}`;
  let dataAsOf = null;

  if (outcome === 'success') {
    try {
      const parsed = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
      validateMcClellanData(parsed);
      ok = true;
      reason = null;
      // dataAsOf is the tracks' real observation date, not generated_at —
      // generated_at is the producer receipt clock, not the data date.
      const dates = ['core', 'frontier']
        .map(k => parsed.current && parsed.current[k] && parsed.current[k].date)
        .filter(d => typeof d === 'string' && !isNaN(Date.parse(d)));
      dataAsOf = dates.length ? dates.sort().pop() : null;
    } catch (err) {
      reason = `snapshot validation failed: ${err.message}`;
    }
  } else {
    // skipped / failure / unknown outcome — the collection did not verify.
    reason = outcome ? `pipeline outcome ${outcome}` : 'pipeline outcome missing';
  }

  recordStep(job, 'pipeline', {
    ok,
    error: ok ? null : new Error(reason),
    dataAsOf: ok ? dataAsOf : null,
    dataDir
  });
  const rec = finishJob(job, { dataDir });
  console.log(`[record_pipeline_result] ${job}: ${rec ? rec.status : 'heartbeat write failed'} (${ok ? 'verified' : reason})`);
  // Exit 0 only when the outcome was actually persisted (a recorded failure
  // result still exits 0 — the Python step's own outcome already controls
  // the workflow color). A heartbeat that could not be written is itself a
  // failure and must be visible.
  return rec ? 0 : 1;
}

if (require.main === module) {
  process.exit(run({ job: process.argv[2], outcome: process.env.PIPELINE_OUTCOME }));
}

module.exports = { run };
