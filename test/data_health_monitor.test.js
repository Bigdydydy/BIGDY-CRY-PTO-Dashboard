/**
 * data_health_monitor tests — feed the lead-authored evaluateMonitoring
 * with fixture inputs (no I/O inside the evaluator). Verifies: all-green
 * verdict, job failure not masked by a same-name artifact, metadata
 * timestamps that cannot rejuvenate stale source data, missing heartbeats /
 * live URL / modules staying UNKNOWN, legitimate warmup, and warn/block
 * boundaries.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateMonitoring } = require('../server/data_health_monitor');
const { MONITOR_LIVE_MODULES, JOB_POLICIES } = require('../server/data_health_monitor_policy');

const NOW = Date.parse('2026-10-18T12:00:00Z');
const iso = ms => new Date(ms).toISOString();
const todayStr = new Date(NOW).toISOString().slice(0, 10);

function okStep() {
  return { status: 'ok', lastAttemptAt: iso(NOW - 60e3), lastSuccessAt: iso(NOW - 60e3), lastError: null, dataAsOf: iso(NOW - 120e3), verifiedSkip: false };
}

function okJob(stepNames) {
  const steps = {};
  for (const s of stepNames) steps[s] = okStep();
  return { id: null, status: 'ok', lastAttemptAt: iso(NOW - 90e3), lastSuccessAt: iso(NOW - 90e3), lastError: null, steps };
}

function sourceOk() {
  return { lastSuccessAt: iso(NOW - 60e3), dataAsOf: iso(NOW - 120e3), lastError: null, issues: [] };
}

function greenInputs() {
  const fresh = NOW - 60e3;
  const jobs = {
    macro_snapshot: { ...okJob(['macro', 'preferreds', 'mstr_disclosures']), id: 'macro_snapshot' },
    liquidity_hourly: { ...okJob(['samples']), id: 'liquidity_hourly' },
    block_insight_daily: { ...okJob(['option_oi', 'block_trades', 'marks']), id: 'block_insight_daily' },
    mcclellan_daily: { ...okJob(['pipeline']), id: 'mcclellan_daily' }
  };
  const srcMeta = ids => ({ dataHealth: { state: 'OK', sources: Object.fromEntries(ids.map(id => [id, sourceOk()])) } });
  const snapshots = {
    'macro_chart.json': srcMeta(['macro', 'fred:DGS1', 'fred:DGS10', 'fred:WALCL', 'fred:WTREGEN', 'fred:RRPONTSYD', 'macro_btc', 'yahoo:MSTR']),
    'mstr_preferreds_cache.json': srcMeta(['preferreds', 'yahoo:STRC', 'yahoo:STRF', 'yahoo:STRD', 'fred:DGS1MO']),
    'mstr_disclosures.json': srcMeta(['mstr_official_ledger', 'mstr_official_shares',
      'mstr_official_capital', 'mstr_official_press', 'mstr_sec_index', 'mstr_mnav_inputs']),
    'coinbase_liquidity_history.json': { samples: [{ ts: fresh, n: 3, d10: 1 }] },
    'option_oi_history_BTC.json': { snapshots: [{ ts: fresh }] },
    'block_flow_daily_BTC.json': { days: {} },
    'smart_money_BTC.json': { structures: [] },
    'crypto_mcclellan.json': {
      metadata: { generated_at: iso(fresh) },
      current: {
        core: { ready: true, date: todayStr, oscillator: 1.5, summation: 2.5 },
        frontier: { ready: true, date: todayStr, oscillator: -0.5, summation: 1.1 }
      },
      series: [
        { date: new Date(NOW - 86400e3).toISOString().slice(0, 10), core_n: 80, frontier_n: 40 },
        { date: todayStr, core_n: 81, frontier_n: 41 }
      ]
    }
  };
  const modules = {};
  for (const id of MONITOR_LIVE_MODULES) modules[id] = { healthStatus: 'ONLINE' };
  const live = { report: { code: 0, modules, modulesCount: MONITOR_LIVE_MODULES.length, overallHealth: 'HEALTHY' } };
  return { jobs, snapshots, live };
}

describe('evaluateMonitoring', () => {
  test('all-green inputs -> HEALTHY with zero alerts', () => {
    const report = evaluateMonitoring(greenInputs(), NOW);
    assert.equal(report.overallHealth, 'HEALTHY');
    assert.equal(report.alerts.length, 0);
    assert.equal(report.jobs.macro_snapshot.state, 'HEALTHY');
    assert.equal(report.artifacts.mcclellan_core.state, 'HEALTHY');
    assert.equal(report.live.state, 'HEALTHY');
  });

  test('a failed job is not covered up by a same-name artifact file', () => {
    const g = greenInputs();
    g.jobs.block_insight_daily = {
      id: 'block_insight_daily', status: 'failed',
      lastAttemptAt: iso(NOW - 60e3), lastSuccessAt: iso(NOW - 4 * 86400e3), // beyond the 3d block window
      lastError: 'block_trades: Greeks 503', steps: {}
    };
    const report = evaluateMonitoring(g, NOW);
    // The job heartbeat itself is stale + failed.
    assert.equal(report.jobs.block_insight_daily.state, 'CRITICAL');
    // The event archives read the (missing) step receipts — never the file's
    // own presence — so they cannot stay green either.
    assert.notEqual(report.artifacts.block_flow_archive.state, 'HEALTHY');
    assert.notEqual(report.artifacts.smart_money_archive.state, 'HEALTHY');
    assert.notEqual(report.overallHealth, 'HEALTHY');
  });

  test('bumping generated_at on a stale breadth artifact stays CRITICAL', () => {
    const g = greenInputs();
    const old = new Date(NOW - 10 * 86400e3).toISOString().slice(0, 10);
    const snap = g.snapshots['crypto_mcclellan.json'];
    snap.current.core.date = old;
    snap.current.frontier.date = old;
    snap.series = snap.series.map(r => ({ ...r, date: old }));
    // metadata.generated_at is irrelevant to the verdict — only source dates count.
    snap.metadata.generated_at = iso(NOW - 60e3);
    const report = evaluateMonitoring(g, NOW);
    assert.equal(report.artifacts.mcclellan_core.state, 'CRITICAL');
    assert.equal(report.artifacts.mcclellan_frontier.state, 'CRITICAL');
    assert.equal(report.overallHealth, 'CRITICAL');
  });

  test('missing heartbeat, live URL or a live module all surface UNKNOWN, never HEALTHY', () => {
    const g1 = greenInputs();
    delete g1.jobs.mcclellan_daily;
    let report = evaluateMonitoring(g1, NOW);
    assert.equal(report.jobs.mcclellan_daily.state, 'UNKNOWN');
    assert.equal(report.overallHealth, 'UNKNOWN');

    const g2 = greenInputs();
    g2.live = null;
    report = evaluateMonitoring(g2, NOW);
    assert.equal(report.live.state, 'UNKNOWN');
    assert.equal(report.overallHealth, 'UNKNOWN');

    const g3 = greenInputs();
    delete g3.live.report.modules.wave_engine;
    g3.live.report.modulesCount = MONITOR_LIVE_MODULES.length; // coverage mismatch also caught
    report = evaluateMonitoring(g3, NOW);
    assert.equal(report.live.state, 'UNKNOWN');
  });

  test('degraded live modules are named in the DEGRADED reason', () => {
    const g = greenInputs();
    const [a, b] = MONITOR_LIVE_MODULES;
    g.live.report.overallHealth = 'DEGRADED';
    g.live.report.modules[a].healthStatus = 'DEGRADED';
    g.live.report.modules[b].healthStatus = 'DEGRADED';
    const report = evaluateMonitoring(g, NOW);
    assert.equal(report.overallHealth, 'DEGRADED');
    assert.equal(report.live.reason, `Live sources degraded: ${a}, ${b}`);
  });

  test('legitimate warmup (ready=false) with real source rows stays HEALTHY', () => {
    const g = greenInputs();
    const snap = g.snapshots['crypto_mcclellan.json'];
    snap.current.core.ready = false;
    snap.current.core.oscillator = null;
    snap.current.core.summation = null;
    const report = evaluateMonitoring(g, NOW);
    assert.equal(report.artifacts.mcclellan_core.state, 'HEALTHY');
    assert.equal(report.artifacts.mcclellan_core.warmingUp, true);
  });

  test('job warn/block boundary: just past warn -> DEGRADED, past block -> CRITICAL', () => {
    const warn = JOB_POLICIES.liquidity_hourly.warnMs;
    const block = JOB_POLICIES.liquidity_hourly.blockMs;

    const g1 = greenInputs();
    g1.jobs.liquidity_hourly.lastSuccessAt = iso(NOW - warn - 1000);
    let report = evaluateMonitoring(g1, NOW);
    assert.equal(report.jobs.liquidity_hourly.state, 'DEGRADED');

    const g2 = greenInputs();
    g2.jobs.liquidity_hourly.lastSuccessAt = iso(NOW - block - 1000);
    report = evaluateMonitoring(g2, NOW);
    assert.equal(report.jobs.liquidity_hourly.state, 'CRITICAL');
  });

  test('live audit reporting OFFLINE module or non-ok code degrades correctly', () => {
    const g = greenInputs();
    g.live.report.modules.option_atm_iv.healthStatus = 'OFFLINE';
    let report = evaluateMonitoring(g, NOW);
    assert.equal(report.live.state, 'CRITICAL');

    const g2 = greenInputs();
    g2.live.report.code = -1;
    report = evaluateMonitoring(g2, NOW);
    assert.equal(report.live.state, 'UNKNOWN');

    const g3 = greenInputs();
    g3.live = { error: 'HTTP 503' };
    report = evaluateMonitoring(g3, NOW);
    assert.equal(report.live.state, 'CRITICAL');
  });

  test('a failed step keeps the artifact DEGRADED via its preserved receipt', () => {
    const g = greenInputs();
    // block_trades failed this run but retains yesterday's verified receipt.
    g.jobs.block_insight_daily.status = 'partial';
    g.jobs.block_insight_daily.steps.block_trades = {
      status: 'failed', lastAttemptAt: iso(NOW - 60e3),
      lastSuccessAt: iso(NOW - 30 * 3600e3), // inside 36h warn: older than warn? warn=36h
      lastError: 'Greeks 503', dataAsOf: null, verifiedSkip: false
    };
    const report = evaluateMonitoring(g, NOW);
    const a = report.artifacts.block_flow_archive;
    assert.ok(['DEGRADED', 'CRITICAL'].includes(a.state), `expected degraded/critical, got ${a.state}`);
    assert.equal(a.clockKind, 'producer_check');
    assert.equal(a.noNewEventsIsValid, true);
  });
});
