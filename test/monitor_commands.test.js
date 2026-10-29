/**
 * Monitor command + endpoint tests (offline):
 * - runCheck: report file, exit semantics (CRITICAL/UNKNOWN -> failure,
 *   DEGRADED -> warning only), injected
 *   fetcher covering bad bodies, zero-network default, missing heartbeat.
 * - sendAlert: unconfigured webhook never sends; mock POST shape; failures
 *   redact the secret URL.
 * - GET /api/system/health: read-only scope, no idle-wakeup, 503 semantics.
 * - Producer CLI scripts in the sandbox: blocked fetches must record failed
 *   heartbeats without touching the committed archives.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');

const { installModuleMocks, srv, freshRequire } = require('./helpers/leaf_env');
const http = require('http');
const { runCheck, exitCodeFor } = require('../scripts/data_health_check');
const { sendAlert } = require('../scripts/data_health_alert');
const { MONITOR_LIVE_MODULES } = require('../server/data_health_monitor_policy');

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'be-mon-'));
const NOW = Date.parse('2026-10-18T12:00:00Z');
const iso = ms => new Date(ms).toISOString();
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const SANDBOX = process.env.BE_SANDBOX_ROOT || path.join(__dirname, '..');

function greenDataDir(dir) {
  const fresh = NOW - 60e3;
  const okStep = () => ({ status: 'ok', lastAttemptAt: iso(fresh), lastSuccessAt: iso(fresh), lastError: null, dataAsOf: null, verifiedSkip: false });
  const jobs = {
    macro_snapshot: ['macro', 'preferreds', 'mstr_disclosures'],
    liquidity_hourly: ['samples'],
    block_insight_daily: ['option_oi', 'block_trades', 'marks'],
    mcclellan_daily: ['pipeline']
  };
  for (const [id, steps] of Object.entries(jobs)) {
    const s = {};
    for (const n of steps) s[n] = okStep();
    fs.writeFileSync(path.join(dir, `job_health_${id}.json`),
      JSON.stringify({ id, status: 'ok', lastAttemptAt: iso(fresh), lastSuccessAt: iso(fresh), lastError: null, steps: s }));
  }
  const srcMeta = ids => ({ dataHealth: { state: 'OK', sources: Object.fromEntries(ids.map(i => [i, { lastSuccessAt: iso(fresh), dataAsOf: iso(fresh - 60e3) }])) } });
  const today = new Date(NOW).toISOString().slice(0, 10);
  fs.writeFileSync(path.join(dir, 'macro_chart.json'),
    JSON.stringify(srcMeta(['macro', 'fred:DGS1', 'fred:DGS10', 'fred:WALCL', 'fred:WTREGEN', 'fred:RRPONTSYD', 'macro_btc', 'yahoo:MSTR'])));
  fs.writeFileSync(path.join(dir, 'mstr_preferreds_cache.json'),
    JSON.stringify(srcMeta(['preferreds', 'yahoo:STRC', 'yahoo:STRF', 'yahoo:STRD', 'fred:DGS1MO'])));
  fs.writeFileSync(path.join(dir, 'mstr_disclosures.json'),
    JSON.stringify(srcMeta(['mstr_official_ledger', 'mstr_official_shares',
      'mstr_official_capital', 'mstr_official_press', 'mstr_sec_index', 'mstr_mnav_inputs'])));
  fs.writeFileSync(path.join(dir, 'coinbase_liquidity_history.json'), JSON.stringify({ samples: [{ ts: fresh, n: 3 }] }));
  fs.writeFileSync(path.join(dir, 'option_oi_history_BTC.json'), JSON.stringify({ snapshots: [{ ts: fresh }] }));
  fs.writeFileSync(path.join(dir, 'block_flow_daily_BTC.json'), JSON.stringify({ days: {} }));
  fs.writeFileSync(path.join(dir, 'smart_money_BTC.json'), JSON.stringify({ structures: [] }));
  fs.writeFileSync(path.join(dir, 'crypto_mcclellan.json'), JSON.stringify({
    metadata: { generated_at: iso(fresh) },
    current: { core: { ready: true, date: today, oscillator: 1, summation: 1 }, frontier: { ready: true, date: today, oscillator: 1, summation: 1 } },
    series: [{ date: today, core_n: 5, frontier_n: 5 }]
  }));
}

function greenLiveReport() {
  const modules = {};
  for (const id of MONITOR_LIVE_MODULES) modules[id] = { healthStatus: 'ONLINE' };
  return { code: 0, modules, modulesCount: MONITOR_LIVE_MODULES.length, overallHealth: 'HEALTHY' };
}

const fakeResp = (body, { ok = true, status = 200 } = {}) => ({
  ok, status,
  headers: { get: () => null },
  json: async () => body,
  text: async () => JSON.stringify(body)
});

describe('scripts/data_health_check runCheck', () => {
  test('healthy inputs + good live audit -> HEALTHY report, output file written', async () => {
    const dir = mk();
    greenDataDir(dir);
    const out = path.join(dir, 'report.json');
    const report = await runCheck({
      dataDir: dir, outputPath: out, now: NOW,
      env: { DASHBOARD_HEALTH_URL: 'http://127.0.0.1:9/audit' },
      fetcher: async () => fakeResp(greenLiveReport()),
      summaryPath: null
    });
    assert.equal(report.overallHealth, 'HEALTHY');
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')).overallHealth, 'HEALTHY');
  });

  test('missing live URL -> live UNKNOWN, never claims healthy; no fetch issued', async () => {
    const dir = mk();
    greenDataDir(dir);
    let calls = 0;
    const report = await runCheck({
      dataDir: dir, now: NOW, env: {},
      fetcher: async () => { calls++; return fakeResp(greenLiveReport()); },
      summaryPath: null
    });
    assert.equal(calls, 0, 'no live URL => zero network');
    assert.equal(report.live.state, 'UNKNOWN');
    assert.notEqual(report.overallHealth, 'HEALTHY');
  });

  test('missing live URL -> actionable step summary + fixed console hint (no real URL leaked)', async () => {
    const dir = mk();
    greenDataDir(dir);
    const summaryFile = path.join(dir, 'summary.md');
    let calls = 0;
    const logs = [];
    const origLog = console.log;
    console.log = (...a) => logs.push(a.join(' '));
    let report;
    try {
      report = await runCheck({
        dataDir: dir, now: NOW, env: {},
        fetcher: async () => { calls++; return fakeResp(greenLiveReport()); },
        summaryPath: summaryFile
      });
    } finally {
      console.log = origLog;
    }
    assert.equal(calls, 0, 'no live URL => zero network');
    assert.equal(report.overallHealth, 'UNKNOWN');
    for (const j of Object.values(report.jobs)) assert.equal(j.state, 'HEALTHY');
    for (const a of Object.values(report.artifacts)) assert.equal(a.state, 'HEALTHY');
    assert.ok(report.alerts.some(a => a.id === 'live_dashboard' && a.state === 'UNKNOWN'),
      'alerts must carry the live_dashboard UNKNOWN');

    const md = fs.readFileSync(summaryFile, 'utf8');
    assert.match(md, /Live coverage is incomplete/);
    assert.match(md, /monitoring configuration gap, not a confirmed upstream outage/);
    assert.match(md, /Settings > Secrets and variables > Actions >\s*Variables/);
    assert.match(md, /DASHBOARD_HEALTH_URL/);
    assert.match(md, /https:\/\/<deployed-host>\/api\/system\/health/, 'placeholder endpoint, never a real URL');
    assert.ok(logs.some(l => l.includes('[data-health] configuration required') &&
      l.includes('DASHBOARD_HEALTH_URL') && l.includes('<deployed-host>')),
      'runCheck prints the fixed console hint with a placeholder URL');
  });

  test('configured live audit -> summary carries no missing-configuration instructions', async () => {
    const dir = mk();
    greenDataDir(dir);
    const okFile = path.join(dir, 'ok.md');
    const ok = await runCheck({
      dataDir: dir, now: NOW, env: { DASHBOARD_HEALTH_URL: 'http://127.0.0.1:9/audit' },
      fetcher: async () => fakeResp(greenLiveReport()),
      summaryPath: okFile
    });
    assert.equal(ok.overallHealth, 'HEALTHY');
    const okMd = fs.readFileSync(okFile, 'utf8');
    assert.ok(!okMd.includes('Settings > Secrets'), 'healthy report carries no configuration instructions');
    assert.ok(!okMd.includes('coverage is incomplete'));

    // Configured but the body is not an audit report: UNKNOWN via a different
    // reason — the missing-configuration paragraph must NOT appear.
    const badFile = path.join(dir, 'bad.md');
    const bad = await runCheck({
      dataDir: dir, now: NOW, env: { DASHBOARD_HEALTH_URL: 'https://dash.example/audit' },
      fetcher: async () => fakeResp('<html>broken</html>'),
      summaryPath: badFile
    });
    assert.equal(bad.live.state, 'UNKNOWN');
    assert.notEqual(bad.live.reason, 'Live dashboard audit URL not configured');
    const badMd = fs.readFileSync(badFile, 'utf8');
    assert.ok(!badMd.includes('Settings > Secrets'), 'a different UNKNOWN reason must not print config instructions');
    assert.ok(!badMd.includes('coverage is incomplete'));
  });

  test('live fetch HTTP error / bad JSON body -> live.error, overall not healthy', async () => {
    const dir = mk();
    greenDataDir(dir);
    const bad = await runCheck({
      dataDir: dir, now: NOW, env: { DASHBOARD_HEALTH_URL: 'https://dash.example/audit' },
      fetcher: async () => fakeResp('nope', { ok: false, status: 503 }),
      summaryPath: null
    });
    assert.equal(bad.live.state, 'CRITICAL');
    // Body that fails to parse -> fetch-layer error -> CRITICAL
    const badJson = await runCheck({
      dataDir: dir, now: NOW, env: { DASHBOARD_HEALTH_URL: 'https://dash.example/audit' },
      fetcher: async () => ({ ...fakeResp({}), json: async () => { throw new SyntaxError('Unexpected token <'); } }),
      summaryPath: null
    });
    assert.equal(badJson.live.state, 'CRITICAL');
    // A body that parses but is not an audit report -> evaluator UNKNOWN
    const badShape = await runCheck({
      dataDir: dir, now: NOW, env: { DASHBOARD_HEALTH_URL: 'https://dash.example/audit' },
      fetcher: async () => fakeResp('<html>broken</html>'),
      summaryPath: null
    });
    assert.equal(badShape.live.state, 'UNKNOWN');
  });

  test('503 carrying an audit report is evaluated as an observation; /healthz is hit first to wake the host', async () => {
    const dir = mk();
    greenDataDir(dir);
    const urls = [];
    const report = await runCheck({
      dataDir: dir, now: NOW, env: { DASHBOARD_HEALTH_URL: 'https://dash.example/api/system/health' },
      fetcher: async (url) => {
        urls.push(url);
        return url.endsWith('/healthz') ? fakeResp('OK') : fakeResp(greenLiveReport(), { ok: false, status: 503 });
      },
      summaryPath: null
    });
    assert.deepEqual(urls, ['https://dash.example/healthz', 'https://dash.example/api/system/health']);
    assert.ok(!report.live.error, 'a 503 audit body is not a transport failure');
  });

  test('fetchWithTimeout-style timeout errors are classified as timeouts', async () => {
    const dir = mk();
    greenDataDir(dir);
    const report = await runCheck({
      dataDir: dir, now: NOW, env: { DASHBOARD_HEALTH_URL: 'https://dash.example/api/system/health' },
      fetcher: async () => { throw new Error('Request timeout of 90000ms exceeded'); },
      summaryPath: null
    });
    assert.match(JSON.stringify(report.live), /timeout/);
  });

  test('non-https / credentialed live URL is refused before fetch', async () => {
    const dir = mk();
    greenDataDir(dir);
    let calls = 0;
    const report = await runCheck({
      dataDir: dir, now: NOW,
      env: { DASHBOARD_HEALTH_URL: 'https://user:pass@dash.example/audit' },
      fetcher: async () => { calls++; return fakeResp(greenLiveReport()); },
      summaryPath: null
    });
    assert.equal(calls, 0);
    assert.equal(report.live.state, 'CRITICAL');
  });
});

describe('scripts/data_health_alert sendAlert', () => {
  test('unconfigured webhook logs and skips — never fabricates a send', async () => {
    let calls = 0;
    const r = await sendAlert({ reportPath: 'x.json', webhookUrl: null, fetcher: async () => { calls++; } });
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'webhook not configured');
    assert.equal(calls, 0);
  });

  test('configured webhook POSTs compact text+summary; secret URL never leaks', async () => {
    const dir = mk();
    const reportPath = path.join(dir, 'r.json');
    fs.writeFileSync(reportPath, JSON.stringify({
      checkedAt: '2026-10-18T12:00:00Z', overallHealth: 'CRITICAL',
      alerts: [{ id: 'job:x', state: 'CRITICAL', reason: 'heartbeat stale' }]
    }));
    const SECRET = 'https://hooks.example/secret/TOK3N';
    let sent = null;
    const r = await sendAlert({
      reportPath, webhookUrl: SECRET,
      fetcher: async (url, opts) => { sent = { url, opts }; return fakeResp({ ok: true }); }
    });
    assert.equal(r.sent, true);
    assert.equal(sent.url, SECRET);
    const body = JSON.parse(sent.opts.body);
    assert.match(body.text, /Data health CRITICAL/);
    assert.equal(body.report.overallHealth, 'CRITICAL');
    assert.ok(!JSON.stringify(body).includes('TOK3N'), 'secret token must not be echoed into the body');
    assert.equal(sent.opts.retries, 0);
    assert.equal(sent.opts.timeout, 10000);
  });

  test('webhook failure is reported without URL/token', async () => {
    const dir = mk();
    const reportPath = path.join(dir, 'r.json');
    fs.writeFileSync(reportPath, JSON.stringify({ overallHealth: 'DEGRADED', alerts: [] }));
    const r = await sendAlert({
      reportPath, webhookUrl: 'https://hooks.example/secret/TOK3N',
      fetcher: async () => { throw new Error('request to https://hooks.example/secret/TOK3N timed out'); }
    });
    assert.equal(r.sent, false);
    assert.ok(!String(r.reason).includes('TOK3N'), 'reason must not leak the secret URL');
  });

  test('thrown errors carrying the secret URL never reach console output or the return value', async () => {
    const dir = mk();
    const reportPath = path.join(dir, 'r.json');
    fs.writeFileSync(reportPath, JSON.stringify({ overallHealth: 'DEGRADED', alerts: [] }));
    const SECRET = 'https://hooks.example/secret/TOK3N';
    const captured = [];
    const origErr = console.error, origLog = console.log;
    console.error = (...a) => captured.push(a.join(' '));
    console.log = (...a) => captured.push(a.join(' '));
    let r;
    try {
      r = await sendAlert({
        reportPath, webhookUrl: SECRET,
        fetcher: async () => { throw new Error(`connect ECONNREFUSED ${SECRET} — token TOK3N invalid`); }
      });
    } finally {
      console.error = origErr; console.log = origLog;
    }
    assert.equal(r.sent, false);
    const blob = captured.join('\n') + '\n' + JSON.stringify(r);
    assert.ok(!blob.includes('hooks.example'), 'logs/return must not contain the secret host');
    assert.ok(!blob.includes('TOK3N'), 'logs/return must not contain the secret token');
    assert.ok(['request failed', 'request timed out'].includes(r.reason), `unexpected reason: ${r.reason}`);
  });

  test('credentialed webhook URL is refused before any fetch', async () => {
    let calls = 0;
    const r = await sendAlert({
      reportPath: 'x.json', webhookUrl: 'https://user:TOK3N@hooks.example/x',
      fetcher: async () => { calls++; }
    });
    assert.equal(r.sent, false);
    assert.equal(calls, 0);
    assert.match(r.reason, /credentials/);
  });

  test('CLI: unconfigured exits 0; configured-but-failed webhook exits 1', async (t) => {
    const dir = mk();
    const reportPath = path.join(dir, 'r.json');
    fs.writeFileSync(reportPath, JSON.stringify({ overallHealth: 'CRITICAL', alerts: [] }));
    const script = path.join(SANDBOX, 'scripts', 'data_health_alert.js');

    const noCfg = spawnSync(process.execPath, [script, reportPath],
      { cwd: SANDBOX, encoding: 'utf8', timeout: 20000, env: { ...process.env, DATA_HEALTH_WEBHOOK_URL: '' } });
    assert.equal(noCfg.status, 0, `stderr: ${noCfg.stderr}`);
    assert.match(noCfg.stdout, /webhook not configured/);

    // Loopback webhook that always 500s — allowed through the guard, real POST fails.
    // Must be async: spawnSync would block this process's event loop and the
    // loopback server (hosted here) could never answer the child's request.
    const srv500 = http.createServer((req, res) => { res.writeHead(500); res.end('no'); });
    await new Promise(r => srv500.listen(0, '127.0.0.1', r));
    t.after(() => srv500.close());
    const failed = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, reportPath],
        { cwd: SANDBOX, env: { ...process.env, DATA_HEALTH_WEBHOOK_URL: `http://127.0.0.1:${srv500.address().port}/hook` } });
      let out = '', err = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { err += d; });
      child.on('error', reject);
      child.on('close', code => resolve({ status: code, stdout: out, stderr: err }));
    });
    assert.equal(failed.status, 1, `stdout: ${failed.stdout} stderr: ${failed.stderr}`);
    assert.match(failed.stderr, /webhook POST failed \(HTTP 500\)/);
  });
});

describe('live report failure classification never leaks the configured URL', () => {
  test('fetcher error carrying the URL is redacted to a fixed class', async () => {
    const dir = mk();
    greenDataDir(dir);
    const SECRET = 'https://dash-internal.example/audit?tok=4cc355';
    const report = await runCheck({
      dataDir: dir, now: NOW, env: { DASHBOARD_HEALTH_URL: SECRET },
      fetcher: async () => { throw new Error(`fetch ${SECRET} ECONNREFUSED`); },
      summaryPath: null
    });
    assert.equal(report.live.state, 'CRITICAL');
    assert.ok(!String(report.live.reason).includes('dash-internal'), 'reason must not contain the URL');
    assert.ok(!String(report.live.reason).includes('4cc355'), 'reason must not contain the token');
  });

  test('a parsed-but-invalid body maps to evaluator UNKNOWN, not CRITICAL', async () => {
    const dir = mk();
    greenDataDir(dir);
    const report = await runCheck({
      dataDir: dir, now: NOW, env: { DASHBOARD_HEALTH_URL: 'https://dash.example/audit' },
      fetcher: async () => fakeResp('not an audit report'),
      summaryPath: null
    });
    assert.equal(report.live.state, 'UNKNOWN');
  });
});

// ---------------------------------------------------------------------------
// GET /api/system/health
// ---------------------------------------------------------------------------

function buildServer(t, auditOutcome) {
  installModuleMocks(t, {
    [srv('data_fetcher.js')]: {
      refreshAllMarketData: async () => ({ summary: 'ok', dataHealth: { state: 'OK', failedSources: [], sources: {} } }),
      getCachedData: () => ({ currency: 'BTC', dataVersion: 1, blockTrades: [], sourceHealth: { state: 'OK', failedSources: [], sources: {} } })
    },
    [srv('macro_fetcher.js')]: { getMacroChartData: async () => ({}) },
    [srv('mstr_preferreds.js')]: { getPreferredsData: async () => ({}) },
    [srv('cdri_fetcher.js')]: { fetchCdriData: async () => ({}) },
    [srv('ssro_fetcher.js')]: { getSsroData: async () => ({}) },
    [srv('coinbase_fetcher.js')]: { getCoinbaseLiquidityData: async () => ({}) },
    [srv('gold_fetcher.js')]: { getGoldCorrelationData: async () => ({}) },
    [srv('crypto_mcclellan_fetcher.js')]: { getMcClellanData: async () => ({}), getLastRefreshStatus: () => ({ status: 'cached' }) },
    [srv('flow_force.js')]: { getFlowForce: async () => ({}) },
    [srv('liquidity_history.js')]: { getMergedHistory: async () => [], recordLiveSnapshot() {} },
    [srv('audit_engine.js')]: { getSystemAuditData: async () => auditOutcome },
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
      parseInstrument: () => null, parseDeribitExpiry: () => null, buildForwardsMap: () => ({})
    }
  });
  const idx = freshRequire('index.js');
  return new Promise(resolve => {
    const s = idx.server.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port, idx }));
    t.after(() => new Promise(r => s.close(r)));
  });
}

describe('GET /api/system/health', () => {
  test('200 DEGRADED, 503 UNKNOWN/CRITICAL, no wakeup of the idle refresher', async (t) => {
    const { port, idx } = await buildServer(t, { code: 0, overallHealth: 'DEGRADED', modules: { x: {} } });
    idx._internal.setBackgroundRefreshEnabled(true);
    assert.equal(idx._internal.lastApiActivity(), 0);

    const r1 = await fetch(`http://127.0.0.1:${port}/api/system/health`);
    const j1 = await r1.json();
    assert.equal(r1.status, 200);
    assert.equal(j1.overallHealth, 'DEGRADED');
    assert.equal(j1.scope, 'live-source-observations');
    assert.equal(j1.code, 0);
    assert.equal(idx._internal.lastApiActivity(), 0, 'health GET must not mark API activity');

    const { port: p2 } = await buildServer(t, { code: 0, overallHealth: 'UNKNOWN', modules: {} });
    const r2 = await fetch(`http://127.0.0.1:${p2}/api/system/health`);
    assert.equal(r2.status, 503);
    assert.equal((await r2.json()).overallHealth, 'UNKNOWN');
  });
});

// ---------------------------------------------------------------------------
// Producer CLI scripts inside the sandbox (blocked network -> honest heartbeats)
// ---------------------------------------------------------------------------

describe('producer scripts under the offline guard', () => {
  test('record_pipeline_result: non-mcclellan job rejected; failure outcome -> failed heartbeat, exit 0', () => {
    const bad = spawnSync(process.execPath, ['scripts/record_pipeline_result.js', 'not_a_job'],
      { cwd: SANDBOX, encoding: 'utf8', timeout: 20000 });
    assert.equal(bad.status, 2);

    const dataDir = path.join(SANDBOX, 'data');
    const r = spawnSync(process.execPath, ['scripts/record_pipeline_result.js', 'mcclellan_daily'],
      { cwd: SANDBOX, encoding: 'utf8', timeout: 20000, env: { ...process.env, PIPELINE_OUTCOME: 'failure' } });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const hb = JSON.parse(fs.readFileSync(path.join(dataDir, 'job_health_mcclellan_daily.json'), 'utf8'));
    assert.equal(hb.status, 'failed');
    assert.equal(hb.steps.pipeline.status, 'failed');
    assert.match(hb.steps.pipeline.lastError, /pipeline outcome failure/);
  });

  test('liquidity_snapshot: blocked fetch -> failed heartbeat, archive byte-identical', () => {
    const dataDir = path.join(SANDBOX, 'data');
    const archive = path.join(dataDir, 'coinbase_liquidity_history.json');
    const before = fs.existsSync(archive) ? sha(archive) : null;
    const r = spawnSync(process.execPath, ['scripts/liquidity_snapshot.js', '--shots', '1'],
      { cwd: SANDBOX, encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 1, `stderr: ${r.stderr.slice(0, 300)}`);
    const hb = JSON.parse(fs.readFileSync(path.join(dataDir, 'job_health_liquidity_hourly.json'), 'utf8'));
    assert.equal(hb.status, 'failed');
    assert.equal(hb.steps.samples.status, 'failed');
    if (before) assert.equal(sha(archive), before, 'failed run must not touch the archive');
    else assert.equal(fs.existsSync(archive), false);
  });

  test('block_insight_daily: all steps blocked -> failed heartbeat; archives untouched', () => {
    const dataDir = path.join(SANDBOX, 'data');
    const daily = path.join(dataDir, 'block_flow_daily_BTC.json');
    const reg = path.join(dataDir, 'smart_money_BTC.json');
    const before = [daily, reg].map(f => fs.existsSync(f) ? sha(f) : null);
    const r = spawnSync(process.execPath, ['scripts/block_insight_daily.js'],
      { cwd: SANDBOX, encoding: 'utf8', timeout: 30000, env: { ...process.env, OPTION_OI_STEP_OUTCOME: 'failure' } });
    assert.equal(r.status, 1, `stderr: ${r.stderr.slice(0, 300)}`);
    const hb = JSON.parse(fs.readFileSync(path.join(dataDir, 'job_health_block_insight_daily.json'), 'utf8'));
    assert.equal(hb.status, 'failed');
    assert.equal(hb.steps.option_oi.status, 'failed');
    assert.equal(hb.steps.block_trades.status, 'failed');
    assert.equal(hb.steps.marks.status, 'failed');
    [daily, reg].forEach((f, i) => {
      if (before[i]) assert.equal(sha(f), before[i], `${f} must be byte-identical after a failed run`);
    });
  });

  test('exit gate: only CRITICAL / UNKNOWN fail; DEGRADED warns', () => {
    assert.equal(exitCodeFor('HEALTHY'), 0);
    assert.equal(exitCodeFor('DEGRADED'), 0);
    assert.equal(exitCodeFor('CRITICAL'), 1);
    assert.equal(exitCodeFor('UNKNOWN'), 1);
    assert.equal(exitCodeFor(undefined), 1);
  });

  test('data_health_check CLI exits 1 when live coverage is UNKNOWN', () => {
    const out = path.join(SANDBOX, 'scratch-report.json');
    const r = spawnSync(process.execPath, ['scripts/data_health_check.js', '--output', out],
      { cwd: SANDBOX, encoding: 'utf8', timeout: 30000, env: { ...process.env, DASHBOARD_HEALTH_URL: '' } });
    assert.equal(r.status, 1, `stderr: ${r.stderr.slice(0, 300)}`);
    const report = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.notEqual(report.overallHealth, 'HEALTHY');
    assert.equal(report.live.state, 'UNKNOWN'); // URL unset -> never claims live health
    try { fs.unlinkSync(out); } catch (e) { /* scratch cleanup best effort */ }
  });
});
