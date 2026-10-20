/**
 * Phase-1 API contract + UI toast-ordering tests (offline).
 *
 * - /api/refresh on a real localhost socket with every upstream stubbed via
 *   require-cache: verifies the ok/partial/failed contract, per-module
 *   outcomes, and the 503 structure.
 * - loadMarketData extracted from public/app.js into a VM: verifies a partial
 *   refresh with new data can NEVER produce the success toast, and a 503
 *   produces the failure path.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { installModuleMocks, srv, freshRequire } = require('./helpers/leaf_env');

// ---------------------------------------------------------------------------
// /api/refresh contract
// ---------------------------------------------------------------------------

const AUX_NAMES = ['macro', 'preferreds', 'cdri', 'ssro', 'coinbase', 'gold', 'mcclellan'];

function buildServer(t, holder) {
  const aux = AUX_NAMES.map(() => () => holder.aux?.() ?? { dataHealth: { state: 'OK' } });
  installModuleMocks(t, {
    [srv('data_fetcher.js')]: {
      refreshAllMarketData: async () => holder.core(),
      getCachedData: () => holder.cached?.() ?? {
        currency: 'BTC', dataVersion: 1, blockTrades: [], sourceHealth: { state: 'OK', failedSources: [], sources: {} }
      }
    },
    [srv('macro_fetcher.js')]: { getMacroChartData: aux[0] },
    [srv('mstr_preferreds.js')]: { getPreferredsData: aux[1] },
    [srv('cdri_fetcher.js')]: { fetchCdriData: aux[2] },
    [srv('ssro_fetcher.js')]: { getSsroData: aux[3] },
    [srv('coinbase_fetcher.js')]: { getCoinbaseLiquidityData: aux[4] },
    [srv('gold_fetcher.js')]: { getGoldCorrelationData: aux[5] },
    [srv('crypto_mcclellan_fetcher.js')]: { getMcClellanData: aux[6], getLastRefreshStatus: () => ({ status: 'cached' }) },
    [srv('flow_force.js')]: { getFlowForce: async () => ({}) },
    [srv('liquidity_history.js')]: { getMergedHistory: async () => [], recordLiveSnapshot() {} },
    [srv('audit_engine.js')]: { getSystemAuditData: async () => ({ modules: [] }) },
    [srv('etf_linkage_engine.js')]: { getEtfLinkageData: async () => ({}) },
    [srv('basis_fetcher.js')]: { getHistoricalBasisData: async () => ({}) },
    [srv('option_marks.js')]: { getOptionMarks: async () => ({}), pickInstruments: (s, i) => s, fetchBookSummaryRows: async () => [] },
    [srv('option_oi_history.js')]: { getMergedHistory: async () => [], maybeRecordLiveSnapshot() {}, dayKey: () => '', profileFromItems: () => ({}) },
    [srv('block_insight.js')]: { getServerInsight: async () => ({}) },
    [srv('vol_surface_history.js')]: { getHistory: () => [], recordSnapshot() {} },
    [srv('wave_engine.js')]: { analyzeWaves: () => ({}), evaluateUserCount: () => ({}), evaluateUserSketch: () => ({}), USER_TOOLS: [] },
    [srv('trade_store.js')]: { filterTradesByWindow: t => t },
    [srv('analytics_engine.js')]: {
      analyzeAtmIv: () => ({}), analyzeDynamicGex: () => ({}), analyzeBlockTrades: () => ({}),
      analyzeIvSmile: () => ({}), analyze25DeltaSkew: () => ({}), calcGreeks: () => ({}),
      parseInstrument: () => null, parseDeribitExpiry: () => null
    }
  });
  const idx = freshRequire('index.js');
  return new Promise(resolve => {
    const s = idx.server.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port, idx }));
    t.after(() => new Promise(r => s.close(r)));
  });
}

async function postRefresh(port, ip = '10.0.0.1') {
  const resp = await fetch(`http://127.0.0.1:${port}/api/refresh`, {
    method: 'POST',
    headers: { 'x-forwarded-for': ip }
  });
  return { status: resp.status, json: await resp.json() };
}

test('API contract: all sources healthy → 200 ok; aux dataHealth.OK counts as success', async (t) => {
  const holder = {
    core: () => ({ summary: 'ok', hasAnyUpdate: true, dataVersion: 2, dataHealth: { state: 'OK', failedSources: [], sources: {} }, lastSuccessAt: '2026-10-18T00:00:00Z' }),
    aux: () => ({ dataHealth: { state: 'OK' } })
  };
  const { port } = await buildServer(t, holder);
  const r = await postRefresh(port, '10.0.0.11');
  assert.equal(r.status, 200);
  assert.equal(r.json.code, 0);
  assert.equal(r.json.status, 'ok');
  assert.equal(r.json.ok, true);
  assert.equal(r.json.outcomes.every(o => o.status === 'ok'), true, JSON.stringify(r.json.outcomes));
  assert.equal(r.json.failures.length, 0);
});

test('API contract: degraded core → 200 partial + failures visible (partial+new data ≠ success)', async (t) => {
  const holder = {
    core: () => ({
      summary: 'partial', hasAnyUpdate: true, dataVersion: 3,
      dataHealth: {
        state: 'DEGRADED', failedSources: ['greeks_dvol'],
        sources: { greeks_dvol: { state: 'FALLBACK', lastError: 'HTTP 503' } }
      }
    }),
    aux: () => ({ dataHealth: { state: 'OK' } })
  };
  const { port } = await buildServer(t, holder);
  const r = await postRefresh(port, '10.0.0.12');
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'partial');
  assert.equal(r.json.ok, false);
  assert.equal(r.json.partialFailure, true);
  assert.equal(r.json.hasAnyUpdate, true); // data moved, yet the contract still says partial
  assert.ok(r.json.failures.some(f => f.source === 'greeks_dvol'));
  assert.ok(r.json.outcomes.some(o => o.module === 'market_data' && o.status === 'degraded'));
});

test('API contract: aux stale/unknown outcomes surface; zero successes → 503 with report', async (t) => {
  const holder = {
    core: () => { throw new Error('all sources down'); },
    aux: async () => { throw new Error('aux down'); }
  };
  const { port } = await buildServer(t, holder);
  const r = await postRefresh(port, '10.0.0.13');
  assert.equal(r.status, 503);
  assert.equal(r.json.code, -1);
  assert.equal(r.json.status, 'failed');
  assert.equal(r.json.ok, false);
  assert.equal(r.json.outcomes.every(o => o.status === 'failed'), true);
  assert.ok(r.json.failures.length >= 8);
});

test('API contract: fulfilled aux with stale flag or pipelineUnavailable → degraded (not ok)', async (t) => {
  let n = 0;
  const holder = {
    core: () => ({ summary: 'ok', dataHealth: { state: 'OK', failedSources: [], sources: {} } }),
    aux: () => (++n % 2 ? { stale: true } : { refresh_status: { status: 'pipelineUnavailable' } })
  };
  const { port } = await buildServer(t, holder);
  const r = await postRefresh(port, '10.0.0.14');
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'partial');
  const auxOutcomes = r.json.outcomes.filter(o => o.module !== 'market_data');
  assert.ok(auxOutcomes.every(o => o.status === 'degraded'), JSON.stringify(auxOutcomes));
  assert.ok(r.json.failures.length >= auxOutcomes.length);
});

test('API contract: read-only audit GET + OPTIONS never mark activity or wake the idle refresher', async (t) => {
  let refreshCalls = 0;
  const holder = {
    core: () => {
      refreshCalls++;
      return { summary: 'ok', dataHealth: { state: 'OK', failedSources: [], sources: {} } };
    },
    // lastSyncCheckTime present so /api/market-data itself never fetches inline —
    // only noteApiActivity()'s idle-wake could call the (spied) refresher.
    cached: () => ({
      currency: 'BTC', dataVersion: 1, blockTrades: [],
      lastSyncCheckTime: new Date().toISOString(),
      sourceHealth: { state: 'OK', failedSources: [], sources: {} }
    }),
    aux: () => ({ dataHealth: { state: 'OK' } })
  };
  const { port, idx } = await buildServer(t, holder);
  idx._internal.setBackgroundRefreshEnabled(true); // simulate production flag
  assert.equal(idx._internal.lastApiActivity(), 0);

  const audit = await fetch(`http://127.0.0.1:${port}/api/system/audit`);
  assert.equal(audit.status, 200);
  await audit.json();
  assert.equal(idx._internal.lastApiActivity(), 0, 'audit GET must not extend API activity');
  assert.equal(refreshCalls, 0, 'audit GET must not wake the background refresher');

  const opt = await fetch(`http://127.0.0.1:${port}/api/market-data`, { method: 'OPTIONS' });
  assert.equal(opt.status, 204);
  assert.equal(idx._internal.lastApiActivity(), 0, 'OPTIONS preflight must not extend API activity');
  assert.equal(refreshCalls, 0);

  // Control: a normal endpoint DOES mark activity and (idle since start) wakes
  // the refresher exactly once — proves the flag was live and the exemptions
  // above were what prevented the calls.
  const md = await fetch(`http://127.0.0.1:${port}/api/market-data`);
  assert.equal(md.status, 200);
  await md.json();
  assert.ok(idx._internal.lastApiActivity() > 0);
  assert.equal(refreshCalls, 1);
});

// ---------------------------------------------------------------------------
// UI: loadMarketData toast ordering (VM-extracted real function)
// ---------------------------------------------------------------------------

function extractFn(file, signature) {
  const src = fs.readFileSync(file, 'utf8');
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `function ${signature} not found`);
  let depth = 0, end = start;
  const braceOpen = src.indexOf('{', start);
  for (end = braceOpen; end < src.length; end++) {
    if (src[end] === '{') depth++;
    else if (src[end] === '}') { depth--; if (depth === 0) { end++; break; } }
  }
  return src.slice(start, end);
}

function makeUiSandbox(fetchImpl) {
  const toasts = [];
  const loaderCalls = [];
  const loader = name => async (...args) => { loaderCalls.push({ name, args }); };
  const el = () => ({ classList: { add() {}, remove() {}, contains: () => false, toggle() {} }, textContent: '', disabled: false, value: '' });
  const sandbox = {
    console,
    setTimeout,
    fetch: fetchImpl,
    showToast: (msg) => toasts.push(msg),
    triggerRecomputedAnimation() {},
    renderAll() {},
    loadMacroData: loader('macro'),
    loadPreferredsData: loader('preferreds'),
    loadCdriData: loader('cdri'),
    fetchSsroData: loader('ssro'),
    btnRefresh: el(),
    elRefreshBtnText: el(),
    elSyncPulseDot: el(),
    thresholdSelect: { value: '30000000' },
    timeRangeSelect: { value: 'all' },
    currentMarketData: null,
    lastDataVersion: null,
    // DataHealthUI bridge helpers from app.js top scope — extracted function
    // references them; the real bridge no-ops when window.DataHealthUI absent.
    dhUpdate: () => {},
    dhFail: () => {}
  };
  vm.createContext(sandbox);
  const fnSrc = extractFn(path.join(__dirname, '..', 'public', 'app.js'), 'async function loadMarketData');
  sandbox.loadMarketData = vm.runInContext(`(${fnSrc})`, sandbox);
  return { sandbox, toasts, loaderCalls };
}

const okResp = body => ({ ok: true, status: 200, json: async () => body });

test('UI: partial refresh + new data must NOT show the success toast', async () => {
  const { sandbox, toasts } = makeUiSandbox(async (url) => {
    if (url.startsWith('/api/refresh')) {
      return okResp({ code: 0, status: 'partial', ok: false, partialFailure: true, hasAnyUpdate: true, failures: [{ source: 'greeks_dvol', error: 'x' }] });
    }
    return okResp({
      code: 0,
      syncStatus: { hasAnyUpdate: true, dataVersion: 2, failedSources: ['greeks_dvol'] },
      dataHealth: { state: 'DEGRADED', failedSources: ['greeks_dvol'] }
    });
  });
  await sandbox.loadMarketData(true);
  assert.ok(toasts.length === 1, JSON.stringify(toasts));
  assert.match(toasts[0], /部分数据源/);
  assert.doesNotMatch(toasts[0], /已重新计算|已是最新/);
});

test('UI: 503 refresh → failure toast, never 已是最新', async () => {
  const { sandbox, toasts } = makeUiSandbox(async (url) => {
    if (url.startsWith('/api/refresh')) {
      return { ok: false, status: 503, json: async () => ({ code: -1, status: 'failed', failures: [{ source: 'macro', error: 'x' }] }) };
    }
    return okResp({ code: 0, syncStatus: { dataVersion: 1 }, dataHealth: { state: 'OK', failedSources: [] } });
  });
  await sandbox.loadMarketData(true);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /同步失败/);
});

test('UI: fully healthy refresh with new data → recompute toast', async () => {
  const { sandbox, toasts } = makeUiSandbox(async (url) => {
    if (url.startsWith('/api/refresh')) {
      return okResp({ code: 0, status: 'ok', ok: true, hasAnyUpdate: true });
    }
    return okResp({
      code: 0,
      syncStatus: { hasAnyUpdate: true, dataVersion: 2, failedSources: [] },
      dataHealth: { state: 'OK', failedSources: [] }
    });
  });
  await sandbox.loadMarketData(true);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /已重新计算/);
});

test('UI: manual refresh forces upstreams once — aux loaders only read the caches /api/refresh filled', async () => {
  const urls = [];
  const { sandbox, loaderCalls } = makeUiSandbox(async (url) => {
    urls.push(url);
    if (url.startsWith('/api/refresh')) return okResp({ code: 0, status: 'ok', ok: true, hasAnyUpdate: false });
    return okResp({ code: 0, syncStatus: { dataVersion: 1 }, dataHealth: { state: 'OK', failedSources: [] } });
  });
  await sandbox.loadMarketData(true);
  assert.equal(urls.filter(u => u.startsWith('/api/refresh')).length, 1);
  assert.deepEqual(loaderCalls.map(c => c.name).sort(), ['cdri', 'macro', 'preferreds', 'ssro']);
  for (const c of loaderCalls) assert.equal(c.args.length, 0, `${c.name} must not be force-refreshed again`);
});
