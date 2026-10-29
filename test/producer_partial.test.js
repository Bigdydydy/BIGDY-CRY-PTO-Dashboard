/**
 * Producer CLI partial-failure semantics (offline, require-cache injection):
 * - macro_snapshot: one failed step keeps the other step's artifacts and the
 *   heartbeat lands 'partial' with exitCode 1.
 * - block_insight_daily: a marks step that could not value every open
 *   structure is failed (no fake-green), partial marks are still persisted
 *   under the OLD producer receipt; a trades failure leaves the daily
 *   archive byte-identical; a legit empty window + complete marks is ok.
 * - liquidity_snapshot.done(): a heartbeat that could not be persisted
 *   (finishJob -> null) must set exitCode 1.
 * - record_pipeline_result.run(): a recorded failure exits 0, but a
 *   heartbeat write failure exits 1.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const { installModuleMocks, srv, REPO_ROOT, DATA_DIR } = require('./helpers/leaf_env');

const SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'be-prod-'));

/** Drop a script + pipeline_health from the cache so top-level requires pick
 * up this test's stubs and the CURRENT fs redirection. */
function freshScript(t, name) {
  const p = require.resolve(path.join(SCRIPTS_DIR, name));
  for (const k of [p, srv('pipeline_health.js'), srv('data_health_cache.js'), srv('trade_store.js')]) {
    delete require.cache[k];
  }
  const mod = require(p);
  t.after(() => { delete require.cache[p]; });
  return mod;
}

function readHeartbeat(dir, job) {
  const f = path.join(dir, `job_health_${job}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

const okHealth = { state: 'OK', sources: { s1: { state: 'OK' } }, failedSources: [] };

/** Scripts set process.exitCode — restore it so the test process stays 0. */
function resetExitCode(t) {
  process.exitCode = 0;
  t.after(() => { process.exitCode = 0; });
}

describe('macro_snapshot CLI (mocked substeps)', () => {
  test('macro ok + preferreds failed -> job partial, heartbeat records both, exitCode 1', async (t) => {
    const { tmpDir } = installModuleMocks(t, {
      [srv('macro_fetcher.js')]: {
        fetchAndBuildMacroData: async () => ({
          summary: { dateRange: { end: '2026-10-17' }, sources: {} },
          dataHealth: okHealth
        })
      },
      [srv('mstr_preferreds.js')]: {
        getPreferredsData: async () => { throw new Error('yahoo down'); }
      },
      [srv('mstr_disclosures.js')]: {
        getMstrDisclosures: async () => ({ lastCompletedAt: '2026-10-17T00:00:00.000Z', dataHealth: okHealth }),
        peekMstrDisclosures: async () => null
      }
    });

    resetExitCode(t);
    const script = freshScript(t, 'macro_snapshot.js');
    await script.main();

    const hb = readHeartbeat(tmpDir, 'macro_snapshot');
    assert.ok(hb, 'heartbeat must be persisted');
    assert.equal(hb.status, 'partial');
    assert.equal(hb.steps.macro.status, 'ok');
    assert.equal(hb.steps.preferreds.status, 'failed');
    assert.equal(hb.steps.mstr_disclosures.status, 'ok');
    assert.match(hb.steps.preferreds.lastError, /yahoo down/);
    assert.equal(hb.lastSuccessAt, null, 'partial run must not advance the job receipt');
    assert.equal(process.exitCode, 1);
  });

  test('both steps ok -> job ok, exitCode untouched', async (t) => {
    const { tmpDir } = installModuleMocks(t, {
      [srv('macro_fetcher.js')]: {
        fetchAndBuildMacroData: async () => ({
          summary: { dateRange: { end: '2026-10-17' }, sources: {} },
          dataHealth: okHealth
        })
      },
      [srv('mstr_preferreds.js')]: {
        getPreferredsData: async () => ({
          summary: { asOf: '2026-10-17', sources: {} },
          dataHealth: okHealth
        })
      },
      [srv('mstr_disclosures.js')]: {
        getMstrDisclosures: async () => ({ lastCompletedAt: '2026-10-17T00:00:00.000Z', dataHealth: okHealth }),
        peekMstrDisclosures: async () => null
      }
    });

    resetExitCode(t);
    const script = freshScript(t, 'macro_snapshot.js');
    await script.main();

    const hb = readHeartbeat(tmpDir, 'macro_snapshot');
    assert.equal(hb.status, 'ok');
    assert.ok(hb.lastSuccessAt, 'ok run advances the job receipt');
    assert.equal(process.exitCode, 0);
  });
});

describe('block_insight_daily CLI (mocked substeps)', () => {
  const TODAY = new Date().toISOString().slice(0, 10);

  function blockStubs(dir, { trades, markResult, registry, delivery = { [TODAY]: 50000 } }) {
    const dailyFile = path.join(dir, 'block_flow_daily_BTC.json');
    const smartFile = path.join(dir, 'smart_money_BTC.json');
    const BI = {
      DAILY_FILE: dailyFile,
      SMART_FILE: smartFile,
      STRUCTURE_MIN_NOTIONAL: 0,
      readDailyFile: () => ({}),
      readRegistryFile: () => registry,
      aggregateTrades: () => ({ [TODAY]: { complete: true } }),
      mergeDaily: (d, f) => ({ ...d, ...f }),
      registerStructures: (reg) => ({ registry: reg, added: 0 }),
      markStructures: markResult,
      marksFromBookSummary: () => ({ markByInstrument: {}, spot: 50000 }),
      fetchDeliveryPrices: async () => delivery,
      writeDailyFile: (days, f, health) => fs.writeFileSync(f, JSON.stringify({ days, producerHealth: health || null })),
      writeRegistryFile: (reg, f, health) => fs.writeFileSync(f, JSON.stringify({ structures: reg, producerHealth: health || null }))
    };
    return {
      [srv('block_insight.js')]: BI,
      [srv('data_fetcher.js')]: { fetchBlockTrades: trades },
      [srv('option_marks.js')]: { fetchBookSummaryRows: async () => [{ instrument_name: 'BTC-X', mark_price: 1 }] },
      [srv('analytics_engine.js')]: { formatUTC8: ts => new Date(ts).toISOString(), analyzeBlockTrades: () => ({ whaleBlocks: [], icebergClusters: [] }), buildForwardsMap: () => ({}) },
      [srv('option_oi_history.js')]: {
        COMMITTED_FILE: path.join(dir, 'oi.json'),
        readHistoryFile: () => [{ ts: Date.now() }],
        hasSnapshotForDay: () => true,
        dayKey: (ts) => new Date(ts).toISOString().slice(0, 10)
      }
    };
  }

  test('trades ok + marks missing for an open structure -> marks failed, registry keeps OLD producerHealth, job partial', async (t) => {
    const dir = tmp();
    const smartFile = path.join(dir, 'smart_money_BTC.json');
    const OLD_RECEIPT = { status: 'ok', lastAttemptAt: '2026-10-15T00:00:00.000Z', lastSuccessAt: '2026-10-15T00:00:00.000Z', lastError: null };
    fs.writeFileSync(smartFile, JSON.stringify({ structures: [], producerHealth: OLD_RECEIPT }));
    const dailyFile = path.join(dir, 'block_flow_daily_BTC.json');

    const openStructure = { id: 'BLK:unmarked', final: null, marks: [], legs: [] };
    const { tmpDir } = installModuleMocks(t, blockStubs(dir, {
      trades: async () => [{ timestamp: Date.now() - 3600e3, index_price: 50000 }],
      registry: [],
      markResult: (reg) => ({ registry: [...reg, openStructure], marked: 0, settled: 0 })
    }));
    delete process.env.OPTION_OI_STEP_OUTCOME;

    resetExitCode(t);
    const script = freshScript(t, 'block_insight_daily.js');
    await script.main();

    const hb = readHeartbeat(tmpDir, 'block_insight_daily');
    assert.equal(hb.status, 'partial');
    assert.equal(hb.steps.block_trades.status, 'ok');
    assert.equal(hb.steps.marks.status, 'failed');
    assert.match(hb.steps.marks.lastError, /missing mark|no mark|unmarked/i);
    assert.equal(process.exitCode, 1);

    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'block_trades_BTC.json'), 'utf8'));
    assert.equal(raw.retentionDays, 60);
    assert.equal(raw.trades.length, 1, 'raw legs survive a partial marks failure');

    // Daily archive got the successful step's receipt.
    const daily = JSON.parse(fs.readFileSync(dailyFile, 'utf8'));
    assert.equal(daily.producerHealth.status, 'ok');
    assert.ok(daily.days[TODAY]);
    // Registry kept the valid new structure but the receipt was NOT renewed.
    const smart = JSON.parse(fs.readFileSync(smartFile, 'utf8'));
    assert.equal(smart.structures.length, 1);
    assert.deepEqual(smart.producerHealth, OLD_RECEIPT, 'failed marks step must not renew the archive receipt');
  });

  test('marks ok + trades failed -> daily archive bytes unchanged, registry renewed under marks receipt', async (t) => {
    const dir = tmp();
    const dailyFile = path.join(dir, 'block_flow_daily_BTC.json');
    const smartFile = path.join(dir, 'smart_money_BTC.json');
    const dailyBytes = JSON.stringify({ days: { '2026-10-10': { complete: true } }, producerHealth: { status: 'ok' } });
    fs.writeFileSync(dailyFile, dailyBytes);
    fs.writeFileSync(smartFile, JSON.stringify({ structures: [], producerHealth: null }));

    const markedToday = { id: 'BLK:done', final: null, marks: [{ day: TODAY, ts: Date.now(), pnlBtc: 1 }], legs: [] };
    const { tmpDir } = installModuleMocks(t, blockStubs(dir, {
      trades: async () => { throw new Error('Greeks 503'); },
      registry: [markedToday],
      markResult: (reg) => ({ registry: reg, marked: 1, settled: 0 })
    }));

    resetExitCode(t);
    const script = freshScript(t, 'block_insight_daily.js');
    await script.main();

    const hb = readHeartbeat(tmpDir, 'block_insight_daily');
    assert.equal(hb.status, 'partial');
    assert.equal(hb.steps.block_trades.status, 'failed');
    assert.equal(hb.steps.marks.status, 'ok');
    assert.equal(process.exitCode, 1);
    // The failed step's archive is byte-identical.
    assert.equal(fs.readFileSync(dailyFile, 'utf8'), dailyBytes);
    // The successful step's archive carries its own fresh receipt.
    const smart = JSON.parse(fs.readFileSync(smartFile, 'utf8'));
    assert.equal(smart.producerHealth.status, 'ok');
    assert.ok(smart.producerHealth.lastSuccessAt > '2026-10-15', 'receipt renewed for the marks step only');
  });

  test('empty trade window + all-final registry -> all steps legitimately ok', async (t) => {
    const dir = tmp();
    const dailyFile = path.join(dir, 'block_flow_daily_BTC.json');
    const smartFile = path.join(dir, 'smart_money_BTC.json');
    fs.writeFileSync(smartFile, JSON.stringify({ structures: [], producerHealth: null }));

    const settledStructure = { id: 'BLK:settled', final: { pnlBtc: 2, ts: 1 }, marks: [], legs: [] };
    const { tmpDir } = installModuleMocks(t, blockStubs(dir, {
      trades: async () => [],               // valid endpoint, zero events in window
      registry: [settledStructure],
      markResult: (reg) => ({ registry: reg, marked: 0, settled: 0 })
    }));

    resetExitCode(t);
    const script = freshScript(t, 'block_insight_daily.js');
    await script.main();

    const hb = readHeartbeat(tmpDir, 'block_insight_daily');
    assert.equal(hb.status, 'ok', `expected ok, got ${hb.status}: ${hb.lastError}`);
    assert.equal(hb.steps.block_trades.status, 'ok');
    assert.equal(hb.steps.marks.status, 'ok');
    assert.equal(hb.steps.option_oi.verifiedSkip, true);
    assert.equal(process.exitCode, 0);
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'block_trades_BTC.json'), 'utf8'));
    assert.equal(raw.retentionDays, 60);
    assert.deepEqual(raw.trades, [], 'empty verified polls still persist the retention policy');

    // A verified empty window still stamps the archive with the check receipt.
    const daily = JSON.parse(fs.readFileSync(dailyFile, 'utf8'));
    assert.equal(daily.producerHealth.status, 'ok');
    assert.deepEqual(daily.days, {}, 'no fabricated days for an empty window');
  });
});

describe('liquidity_snapshot done() / record_pipeline_result run() write-failure handling', () => {
  test('finishJob returning null (heartbeat write failure) forces exitCode 1', async (t) => {
    installModuleMocks(t, {
      [srv('pipeline_health.js')]: {
        beginJob() {}, recordStep() {}, finishJob: () => null, readJob: () => null, EXPECTED_STEPS: {}
      },
      [srv('coinbase_fetcher.js')]: {
        fetchCoinbaseOrderBook: async () => ({}),
        fetchCoinbaseTickerAndStats: async () => ({}),
        processCoinbaseData: () => ({})
      },
      [srv('liquidity_history.js')]: {
        COMMITTED_FILE: 'x', readHistoryFile: () => [], hourSampleCount: () => 0,
        mergeSnapshot: s => s, snapshotFromLiquidity: () => null, writeHistoryFile() {}
      }
    });
    resetExitCode(t);
    const script = freshScript(t, 'liquidity_snapshot.js');
    script.done();
    assert.equal(process.exitCode, 1, 'lost heartbeat must not leave the run green');
  });

  test('record_pipeline_result: recorded failure -> 0; heartbeat write failure -> 1', async (t) => {
    const dir = tmp();
    const snap = path.join(dir, 'mcc.json');
    fs.writeFileSync(snap, JSON.stringify({
      metadata: {}, current: { core: { ready: true, date: TODAY2(), oscillator: 1, summation: 1, core_n: 5 }, frontier: { ready: false, date: TODAY2(), frontier_n: 1 } },
      series: [{ date: TODAY2(), core_n: 5, frontier_n: 1 }]
    }));
    installModuleMocks(t, {
      [srv('crypto_mcclellan_fetcher.js')]: { validateMcClellanData: () => {} },
      [srv('pipeline_health.js')]: {
        beginJob() {}, recordStep() {},
        finishJob: () => global.__finishResult, readJob: () => null, EXPECTED_STEPS: {}
      }
    });
    const script = freshScript(t, 'record_pipeline_result.js');

    global.__finishResult = { status: 'failed' };
    assert.equal(script.run({ job: 'mcclellan_daily', outcome: 'failure', snapshotFile: snap, dataDir: dir }), 0,
      'a recorded failure result must not mask the workflow outcome');
    global.__finishResult = null;
    assert.equal(script.run({ job: 'mcclellan_daily', outcome: 'failure', snapshotFile: snap, dataDir: dir }), 1,
      'an unpersisted heartbeat is itself a failure');
    global.__finishResult = { status: 'ok' };
    assert.equal(script.run({ job: 'mcclellan_daily', outcome: 'success', snapshotFile: snap, dataDir: dir }), 0);
    delete global.__finishResult;
  });
});

function TODAY2() { return new Date().toISOString().slice(0, 10); }
