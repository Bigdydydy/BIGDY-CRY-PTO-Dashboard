'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { server, _internal } = require('../server/index');
const lev = require('../server/leverage_norm');
const ledger = require('../server/option_flow_ledger');
const health = require('../server/data_health');

test('malformed wave requests return 400 and leave the HTTP service alive', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const request = (url, body) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: url, method: body === undefined ? 'GET' : 'POST' }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(body);
  });
  try {
    for (const [url, body] of [
      ['/api/wave/klines?symbol=a&symbol=b'],
      ['/api/wave/evaluate', 'null'],
      ['/api/wave/analysis', '{"symbol":1}'],
      ['/api/wave/evaluate', '[]'],
      ['/api/wave/analysis', '{"symbol":false}']
    ]) {
      assert.equal(await request(url, body), 400);
      assert.equal(await request('/healthz'), 200);
    }
    assert.equal(await request('/api/wave/evaluate', JSON.stringify({ padding: 'x'.repeat(1000001) })), 413);
    assert.equal(await request('/healthz'), 200);
    assert.equal(await request('/api/nonexistent?force=1'), 404);
    assert.equal(await request('/api/nonexistent?force=1'), 429);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('proxy headers require explicit trusted-hop configuration', () => {
  const old = process.env.TRUST_PROXY_HOPS;
  const req = { headers: { 'x-forwarded-for': 'fake, real' }, socket: { remoteAddress: 'peer' } };
  try {
    delete process.env.TRUST_PROXY_HOPS;
    assert.equal(_internal.clientAddress(req), 'peer');
    process.env.TRUST_PROXY_HOPS = '1';
    assert.equal(_internal.clientAddress(req), 'real');
  } finally {
    if (old === undefined) delete process.env.TRUST_PROXY_HOPS; else process.env.TRUST_PROXY_HOPS = old;
  }
});

test('missing 90D basis produces an insufficient-data regime', () => {
  const { evaluateCarryRegime } = require('../server/term_premium_engine');
  for (const apr90d of [null, undefined, NaN, Infinity]) {
    assert.equal(evaluateCarryRegime({ apr90d, cqApr: 6.2, nqApr: 6.8 }).regimeCode, 'INSUFFICIENT_DATA');
  }
});

test('a corrupt trade archive cannot be overwritten by the next poll', () => {
  const file = path.join(__dirname, '../data/block_trades_CORRUPTAUDIT.json');
  const original = '{truncated';
  fs.writeFileSync(file, original);
  try {
    assert.throws(() => require('../server/trade_store').recordAndMergeTrades('CORRUPTAUDIT', [{ trade_id: 1, timestamp: Date.now() }]));
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  } finally { fs.unlinkSync(file); }
});

test('missing funding and unpublished ETF flows cannot masquerade as zero', () => {
  for (const rate of [null, undefined, '', false]) {
    assert.throws(() => lev.parseFundingBars([{ data: [1700000000, 0, 0, 0, rate] }]));
  }
  assert.equal(lev.parseFundingBars([{ data: [1700000000, 0, 0, 0, 0] }])[0].rate, 0);
  const volumes = { IBIT: new Map([['2026-11-01', 100]]), FBTC: new Map([['2026-11-01', 100]]) };
  assert.deepEqual(lev.buildEtfTurnover([{ date: '2026-11-01', funds: { IBIT: 10, FBTC: null } }], volumes), []);
});

test('a failed remote ledger fetch never renews disk success receipts', async () => {
  health.resetHealthForTests(); ledger.clearLedgerCache();
  const file = path.join(__dirname, '../data/ledger_audit.json');
  fs.writeFileSync(file, JSON.stringify({ instruments: {}, syncedThrough: Date.now() - 1000 }));
  try {
    await ledger.getLedger({ file, fetcher: async () => { throw new Error('offline'); } });
    const h = health.getSourceHealth('option_flow_ledger');
    assert.equal(h.lastSuccessAt, null);
    assert.match(h.lastError, /offline/);
  } finally { fs.unlinkSync(file); ledger.clearLedgerCache(); }
});

test('runtime sidecars preserve the committed seed and producers retain explicit archive paths', () => {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-snapshot-'));
  const file = path.join(dir, 'seed.json');
  const oldRoot = process.env.BE_SANDBOX_ROOT;
  const oldMode = process.env.SNAPSHOT_MODE;
  const { snapshotPath } = require('../server/snapshot_path');
  fs.writeFileSync(file, '{"old":1}');
  try {
    delete process.env.BE_SANDBOX_ROOT;
    delete process.env.SNAPSHOT_MODE;
    const runtime = snapshotPath(file);
    assert.notEqual(runtime, file);
    assert.equal(fs.readFileSync(runtime, 'utf8'), '{"old":1}');
    fs.writeFileSync(runtime, '{"new":2}');
    assert.equal(snapshotPath(file), runtime);
    assert.equal(fs.readFileSync(runtime, 'utf8'), '{"new":2}');
    assert.equal(fs.readFileSync(file, 'utf8'), '{"old":1}');
    process.env.SNAPSHOT_MODE = 'producer';
    assert.equal(snapshotPath(file), file);
  } finally {
    if (oldRoot === undefined) delete process.env.BE_SANDBOX_ROOT; else process.env.BE_SANDBOX_ROOT = oldRoot;
    if (oldMode === undefined) delete process.env.SNAPSHOT_MODE; else process.env.SNAPSHOT_MODE = oldMode;
    for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));
    fs.rmdirSync(dir);
  }
});

test('exact OI volume rejects a timestamp page that cannot advance', async () => {
  const oi = require('../server/option_oi_history');
  const fetchPage = async () => ({ trades: [{ trade_id: 'x', timestamp: 10, amount: 2, instrument_name: 'BTC-25DEC26-80000-C' }], hasMore: true });
  await assert.rejects(oi.windowVolumesFromTape(fetchPage, { fromTs: 0, toTs: 20, sleepMs: 0 }), /completeness/);
});

test('missing SEC USD assets stay unknown and prevent official mNAV', () => {
  const sec = require('../server/mstr_sec_model');
  const ref = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/mstr_capital_reference.json'), 'utf8'));
  const derived = sec.deriveSecCapital({ reference: ref, today: '2026-10-20', docs: [{
    holdings: [{ asOf: '2026-10-19', holdingsBtc: 800000, aggregateCostUsd: 1, averageCostUsd: 1 }],
    accession: 'audit', filedOn: '2026-10-20', documentUrl: 'https://example.test/audit', flows: [], strcRates: []
  }] });
  assert.equal(derived.capital.cashUsd, null);
  assert.ok(derived.issues.includes('usd_balances_missing'));
});

test('production McClellan reads the published archive without running Python', async t => {
  const { installModuleMocks, freshRequire, srv, fakeResp } = require('./helpers/leaf_env');
  const payload = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/crypto_mcclellan.json'), 'utf8'));
  const old = process.env.NODE_ENV;
  let fetches = 0;
  let pythonCalls = 0;
  const stubs = {
    [srv('http_client.js')]: { fetchWithTimeout: async () => { fetches++; return fakeResp(payload); } },
    child_process: { exec: () => { pythonCalls++; throw new Error('Python must not run'); }, execSync: () => { pythonCalls++; throw new Error('Python must not run'); } }
  };
  installModuleMocks(t, stubs);
  try {
    process.env.NODE_ENV = 'production';
    const mod = freshRequire('crypto_mcclellan_fetcher.js');
    const first = await mod.getMcClellanData(true);
    const second = await mod.getMcClellanData(true);
    assert.deepEqual(first.current, payload.current);
    assert.deepEqual(second.current, payload.current);
    assert.equal(fetches, 1);
    assert.equal(pythonCalls, 0);
  } finally { if (old === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = old; }
});
