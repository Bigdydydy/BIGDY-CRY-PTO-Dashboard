/**
 * Phase 3A/E — /api/market-data analysis gating (offline, module stubs).
 *
 * Proves: an unusable required source means the corresponding analyzer is
 * NEVER invoked (data_unavailable emitted instead), healthy sibling sections
 * keep working, vol_surface_history.recordSnapshot is skipped while inputs are
 * unusable, and everything resumes after recovery.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { installModuleMocks, srv, freshRequire } = require('./helpers/leaf_env');
const { recordSuccess, recordFailure, resetHealthForTests } = require('../server/data_health');

const ANALYZERS = ['analyzeAtmIv', 'analyzeDynamicGex', 'analyzeBlockTrades', 'analyzeIvSmile', 'analyze25DeltaSkew'];

function buildServer(t, calls, { flowPayload } = {}) {
  const analytics = { calcGreeks: () => ({}), parseInstrument: () => null, parseDeribitExpiry: () => null };
  ANALYZERS.forEach(name => {
    calls[name] = 0;
    analytics[name] = () => { calls[name]++; return { ok: true, summaryText: 'live' }; };
  });
  installModuleMocks(t, {
    [srv('data_fetcher.js')]: {
      refreshAllMarketData: async () => ({ summary: 'ok' }),
      getCachedData: () => ({
        currency: 'BTC', dataVersion: 1, blockTrades: [],
        lastSyncCheckTime: new Date().toISOString(),
        ivHistory: { rows: [] }, dvolStats: {}, atmData: {},
        gex: { index_price: 50000, by_expiry: {} },
        ivSkewMonth: {}, skewChart: {},
        sourceHealth: { state: 'DEGRADED', failedSources: [], sources: {} }
      })
    },
    [srv('macro_fetcher.js')]: { getMacroChartData: async () => ({}) },
    [srv('mstr_preferreds.js')]: { getPreferredsData: async () => ({}) },
    [srv('cdri_fetcher.js')]: { fetchCdriData: async () => ({}) },
    [srv('ssro_fetcher.js')]: { getSsroData: async () => ({}) },
    [srv('coinbase_fetcher.js')]: { getCoinbaseLiquidityData: async () => ({}) },
    [srv('gold_fetcher.js')]: { getGoldCorrelationData: async () => ({}) },
    [srv('crypto_mcclellan_fetcher.js')]: { getMcClellanData: async () => ({}), getLastRefreshStatus: () => ({ status: 'cached' }) },
    [srv('flow_force.js')]: { getFlowForce: async () => flowPayload || {} },
    [srv('liquidity_history.js')]: { getMergedHistory: async () => [], recordLiveSnapshot() {} },
    [srv('audit_engine.js')]: { getSystemAuditData: async () => ({ modules: [] }) },
    [srv('etf_linkage_engine.js')]: { getEtfLinkageData: async () => ({}) },
    [srv('basis_fetcher.js')]: { getHistoricalBasisData: async () => ({}) },
    [srv('option_marks.js')]: { getOptionMarks: async () => ({}), pickInstruments: (s, i) => s, fetchBookSummaryRows: async () => [] },
    [srv('option_oi_history.js')]: { getMergedHistory: async () => [], maybeRecordLiveSnapshot() {}, dayKey: () => '', profileFromItems: () => ({}) },
    [srv('block_insight.js')]: { getServerInsight: async () => ({}) },
    [srv('vol_surface_history.js')]: { getHistory: () => [], recordSnapshot: () => { calls.recordSnapshot++; } },
    [srv('wave_engine.js')]: { analyzeWaves: () => ({}), evaluateUserCount: () => ({}), evaluateUserSketch: () => ({}), USER_TOOLS: [] },
    [srv('trade_store.js')]: { filterTradesByWindow: t => t },
    [srv('analytics_engine.js')]: analytics
  });
  const idx = freshRequire('index.js');
  return new Promise(resolve => {
    const s = idx.server.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }));
    t.after(() => new Promise(r => s.close(r)));
  });
}

function freshSource(id) {
  recordSuccess(id, { dataAsOf: new Date().toISOString(), asOfKind: 'source', source: 'test' });
}

test('gate: unusable greeks_atm → atmIv + delta25Skew blocked, analyzer not called; gex still works; no surface write', async (t) => {
  const calls = { recordSnapshot: 0 };
  const { port } = await buildServer(t, calls);
  resetHealthForTests();

  recordFailure('greeks_atm', new Error('upstream down')); // cold failure → UNAVAILABLE
  freshSource('greeks_gex');
  freshSource('greeks_trades');
  // iv_history / dvol / smile / skew left unobserved → UNKNOWN → unusable.

  const resp = await fetch(`http://127.0.0.1:${port}/api/market-data`);
  const json = await resp.json();
  assert.equal(resp.status, 200);
  assert.equal(json.code, 0);

  assert.equal(json.atmIv.status, 'data_unavailable');
  assert.match(json.atmIv.summaryText, /暂停当前研判/);
  assert.equal(json.atmIv.historicalOnly, true);
  assert.equal(calls.analyzeAtmIv, 0, 'analyzer must not run on unusable input');
  assert.equal(json.analysisHealth.atmIv.analysisAllowed, false);

  assert.equal(json.delta25Skew.status, 'data_unavailable');
  assert.equal(calls.analyze25DeltaSkew, 0);

  // Healthy sibling section is unaffected by the bad feed.
  assert.equal(json.gex.status, undefined);
  assert.equal(json.gex.ok, true);
  assert.equal(calls.analyzeDynamicGex, 1);

  // The daily vol-surface archive is not written from unusable inputs.
  assert.equal(calls.recordSnapshot, 0);
});

test('gate: recovery — all required sources usable again → analyzers run and surface snapshot resumes', async (t) => {
  const calls = { recordSnapshot: 0 };
  const { port } = await buildServer(t, calls);
  resetHealthForTests();

  ['greeks_atm', 'greeks_iv_history', 'deribit_dvol', 'greeks_smile', 'greeks_gex', 'greeks_skew', 'greeks_trades',
    'basis_live', 'basis_history', 'fred:DGS3MO'].forEach(freshSource);

  const resp = await fetch(`http://127.0.0.1:${port}/api/market-data`);
  const json = await resp.json();
  assert.equal(resp.status, 200);
  assert.equal(json.atmIv.ok, true);
  assert.equal(json.atmIv.status, undefined, 'no data_unavailable marker once recovered');
  assert.equal(calls.analyzeAtmIv, 1);
  assert.equal(calls.analyzeDynamicGex, 1);
  assert.equal(calls.analyzeIvSmile, 1);
  assert.equal(calls.analyze25DeltaSkew, 1);
  assert.equal(calls.recordSnapshot, 1, 'surface archive resumes only on usable inputs');
});

test('gate: cross-midnight — prior-UTC-day receipts are usable but never archived as today\'s snapshot', async (t) => {
  const calls = { recordSnapshot: 0 };
  const { port } = await buildServer(t, calls);
  resetHealthForTests();

  // 00:01 UTC: every source was genuinely refreshed 90s ago — at 23:59:30 the
  // previous UTC day. Sources are usable (well inside LIVE windows) yet their
  // receipt/data date is yesterday, so the daily archive must not write.
  const realNow = Date.now;
  const fakeNow = Date.UTC(2026, 9, 16, 0, 1);
  const seedClocks = new Date(Date.UTC(2026, 9, 15, 23, 59, 30)).toISOString();
  Date.now = () => fakeNow;
  try {
    const { seedSource } = require('../server/data_health');
    const seed = id => seedSource(id, {
      dataAsOf: seedClocks,
      lastSuccessAt: seedClocks,
      asOfKind: 'source',
      source: 'test'
    });
    ['greeks_atm', 'greeks_iv_history', 'deribit_dvol', 'greeks_smile', 'greeks_gex',
      'greeks_skew', 'greeks_trades', 'basis_live', 'basis_history', 'fred:DGS3MO'].forEach(seed);

    const resp = await fetch(`http://127.0.0.1:${port}/api/market-data`);
    const json = await resp.json();
    assert.equal(resp.status, 200);
    assert.equal(json.atmIv.ok, true, 'sources remain usable — analyzers still run');
    assert.equal(calls.analyzeAtmIv, 1);
    assert.equal(calls.recordSnapshot, 0, 'yesterday 23:59 cache must not become today\'s 00:01 snapshot');
  } finally {
    Date.now = realNow;
  }
});

test('wire: explicit historicalOnly is never revived as a live conclusion', async (t) => {
  const calls = {};
  const flowPayload = {
    code: 0,
    historicalOnly: true,
    dataHealth: { state: 'DEGRADED', analysisAllowed: true, sources: {} }
  };
  const { port } = await buildServer(t, calls, { flowPayload });
  const resp = await fetch(`http://127.0.0.1:${port}/api/flow-force?tf=1h`);
  const json = await resp.json();
  assert.equal(resp.status, 200);
  assert.equal(json.historicalOnly, true, 'explicit history-only flag survives the wire');
  assert.equal(json.dataHealth.analysisAllowed, false, 'history-only payload cannot be presented as usable for live conclusions');
  assert.equal(json.dataHealth.state, 'DEGRADED', 'non-OK state preserved');
  assert.equal(flowPayload.dataHealth.analysisAllowed, true, 'source payload health object is not mutated');
});

test('wire: history-only payload with an OK health is demoted to DEGRADED on the wire', async (t) => {
  const calls = {};
  const flowPayload = {
    code: 0,
    historicalOnly: true,
    dataHealth: { state: 'OK', analysisAllowed: true, sources: {} }
  };
  const { port } = await buildServer(t, calls, { flowPayload });
  const resp = await fetch(`http://127.0.0.1:${port}/api/flow-force?tf=1h`);
  const json = await resp.json();
  assert.equal(json.historicalOnly, true);
  assert.equal(json.dataHealth.analysisAllowed, false);
  assert.equal(json.dataHealth.state, 'DEGRADED', 'OK health cannot accompany an explicit history-only payload');
  assert.equal(flowPayload.dataHealth.state, 'OK', 'source payload state is not mutated');
});

test('wire: ordinary usable payload keeps analysisAllowed and historicalOnly=false; blocked health stays historical', async (t) => {
  const calls = {};
  const usable = { code: 0, dataHealth: { state: 'OK', analysisAllowed: true, sources: {} } };
  const { port } = await buildServer(t, calls, { flowPayload: usable });
  const resp = await fetch(`http://127.0.0.1:${port}/api/flow-force?tf=1h`);
  const json = await resp.json();
  assert.equal(json.historicalOnly, false);
  assert.equal(json.dataHealth.analysisAllowed, true);

  const blocked = { code: 0, dataHealth: { state: 'UNAVAILABLE', analysisAllowed: false, sources: {} } };
  const { port: port2 } = await buildServer(t, {}, { flowPayload: blocked });
  const resp2 = await fetch(`http://127.0.0.1:${port2}/api/flow-force?tf=1h`);
  const json2 = await resp2.json();
  assert.equal(json2.historicalOnly, true, 'unusable health still forces historicalOnly');
  assert.equal(json2.dataHealth.analysisAllowed, false);
});
