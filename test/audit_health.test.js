const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const health = require('../server/data_health');
const audit = require('../server/audit_engine');

const EXPECTED_MODULES = [
  'macro_liquidity', 'option_atm_iv', 'term_premium_basis', 'dynamic_gex',
  'whale_block_trades', 'iv_smile_and_skew', 'coinbase_orderbook_liquidity',
  'gold_btc_correlation', 'ssro_oscillator', 'crypto_mcclellan_breadth',
  'cdri', 'mstr_preferreds', 'etf_linkage', 'flow_force', 'wave_engine',
  'block_insight', 'option_marks', 'option_oi_history', 'coinbase_liquidity_history',
  'mstr_disclosures', 'leverage_norm'
];

// All gating source ids needed to make every module ONLINE — these now match
// the leaf-level requiredIds, not just the aggregate ids.
const ALL_OK_IDS = [
  'macro', 'fred:DGS1', 'fred:DGS10', 'fred:WALCL', 'fred:WTREGEN', 'fred:RRPONTSYD',
  'macro_btc', 'yahoo:MSTR', 'greeks_atm', 'greeks_iv_history', 'deribit_dvol',
  'basis_live', 'basis_history', 'fred:DGS3MO', 'greeks_gex', 'greeks_trades',
  'greeks_smile', 'greeks_skew', 'coinbase', 'coinbase_candles', 'gold',
  'ssro', 'ssro_stable', 'mcclellan_core', 'mcclellan_frontier', 'cdri',
  'preferreds', 'yahoo:STRC', 'yahoo:STRF', 'yahoo:STRD', 'fred:DGS1MO',
  'etf', 'cot', 'etf_oi', 'block_flow', 'smart_money', 'option_marks',
  'oi_history', 'liquidity_history', 'wave:1h', 'flow:1h',
  'mstr_official_ledger', 'mstr_official_shares', 'mstr_official_capital',
  'mstr_official_press', 'mstr_sec_index', 'mstr_mnav_inputs',
  'lev_oi', 'lev_funding'
];

function blockAllNetwork(t) {
  const realFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; throw new Error('network blocked in test'); };
  t.after(() => { global.fetch = realFetch; });
  return () => calls;
}

test.beforeEach(() => health.resetHealthForTests());

test('default audit performs zero network I/O and zero upstream getter calls', async (t) => {
  const calls = blockAllNetwork(t);
  const report = await audit.getSystemAuditData(false);
  assert.equal(calls(), 0, 'audit must not fetch when doProbe is false');
  assert.equal(report.code, 0);
});

test('cold registry: nothing is ONLINE/FRESH just for existing; overall is UNKNOWN', async (t) => {
  blockAllNetwork(t);
  const report = await audit.getSystemAuditData(false);
  assert.equal(report.modulesCount, 21);
  for (const id of EXPECTED_MODULES) {
    const mod = report.modules[id];
    assert.ok(mod, `module ${id} present`);
    assert.equal(mod.healthStatus, 'INITIALIZING', `${id} unobserved -> INITIALIZING, never ONLINE`);
    assert.equal(mod.freshnessStatus, 'UNKNOWN');
    assert.equal(mod.lastUpdated, null, `${id} must not fall back to server-now`);
  }
  assert.equal(report.overallHealth, 'UNKNOWN');
  assert.equal(report.onlineModulesCount, 0);
});

test('registry health drives module status truthfully', async (t) => {
  blockAllNetwork(t);
  health.recordSuccess('greeks_gex', { dataAsOf: Date.now(), source: 'test' });
  let report = await audit.getSystemAuditData(false);
  assert.equal(report.modules.dynamic_gex.healthStatus, 'ONLINE');
  assert.equal(report.modules.option_atm_iv.healthStatus, 'INITIALIZING', 'partial mapping still unobserved');

  // a real failure with no valid data -> OFFLINE and overall CRITICAL
  health.resetHealthForTests();
  health.recordFailure('greeks_gex', new Error('upstream down'));
  report = await audit.getSystemAuditData(false);
  assert.equal(report.modules.dynamic_gex.healthStatus, 'OFFLINE');
  assert.equal(report.overallHealth, 'CRITICAL');
  assert.ok(report.offlineModules.includes('dynamic_gex'));
});

test('disk-seeded source reports FALLBACK -> module DEGRADED, not ONLINE', async (t) => {
  blockAllNetwork(t);
  health.seedSource('cdri', { dataAsOf: Date.now() - 300000, lastSuccessAt: Date.now() - 300000 });
  const report = await audit.getSystemAuditData(false);
  assert.equal(report.modules.cdri.healthStatus, 'DEGRADED');
  assert.equal(report.modules.cdri.sources.cdri.state, 'FALLBACK');
  assert.notEqual(report.overallHealth, 'HEALTHY');
});

test('probe is opt-in, verifies payload shape, and failures downgrade overall', async (t) => {
  // all mapped sources OK -> HEALTHY baseline
  for (const id of ALL_OK_IDS) health.recordSuccess(id, { dataAsOf: Date.now(), source: 'test' });
  let report = await audit.getSystemAuditData(false);
  assert.equal(report.overallHealth, 'HEALTHY');
  assert.equal(report.onlineModulesCount, 21);

  // probe with all endpoints unreachable -> downgrade to at least DEGRADED
  let calls = 0;
  const realFetch = global.fetch;
  global.fetch = async () => { calls++; throw new Error('offline'); };
  try {
    report = await audit.getSystemAuditData(true);
  } finally {
    global.fetch = realFetch;
  }
  assert.equal(calls, 4, 'exactly the 4 configured probe targets are queried');
  assert.equal(report.probeOk, false);
  assert.equal(report.overallHealth, 'DEGRADED', 'probe failure must downgrade HEALTHY');
  assert.ok(Object.values(report.probeResults).every(r => r.status === 'UNREACHABLE'));
});

test('HTTP-ok probe with wrong payload shape still counts as failure', async (t) => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ bogus: true }) });
  try {
    const report = await audit.getSystemAuditData(true);
    for (const [name, r] of Object.entries(report.probeResults)) {
      assert.notEqual(r.status, 'REACHABLE', `${name} shape check must fail`);
    }
    assert.equal(report.probeOk, false);
  } finally {
    global.fetch = realFetch;
  }
});

test('probes never register as business-data success in the registry', async (t) => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ price: '99000.5', result: {}, }) });
  try {
    await audit.getSystemAuditData(true);
  } finally {
    global.fetch = realFetch;
  }
  const h = health.getSourceHealth('coinbase');
  assert.equal(h.observed, false, 'probe reachability is not a data-source success');
});
