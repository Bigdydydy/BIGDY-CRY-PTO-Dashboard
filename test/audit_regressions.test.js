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
  const request = (url, body, method) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: url, method: method || (body === undefined ? 'GET' : 'POST') }, res => {
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
    // Only a request that really starts a rebuild may consume the global
    // refresh cooldown: a CORS preflight, a wrong-method call or force=1 on a
    // path that ignores it must not lock the refresh button for everyone.
    assert.equal(await request('/api/refresh', undefined, 'OPTIONS'), 204);
    assert.equal(await request('/api/refresh'), 404);
    assert.equal(await request('/api/nonexistent?force=1'), 404);
    assert.equal(await request('/api/nonexistent?force=1'), 404);
    const [first, second] = await Promise.all([request('/api/refresh', ''), request('/api/refresh', '')]);
    assert.notEqual(first, 429, 'the first real refresh is not blocked by the requests above');
    assert.equal(second, 429, 'an immediate second refresh is still rate limited');
    // Inside the cooldown a panel-level force read degrades to the cached copy, never a 429.
    assert.notEqual(await request('/api/cdri?force=1'), 429);
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
    // Render production chain: [client, Cloudflare edge, Render internal proxy].
    process.env.TRUST_PROXY_HOPS = '3';
    const render = chain => ({ headers: { 'x-forwarded-for': chain }, socket: { remoteAddress: '127.0.0.1' } });
    assert.equal(_internal.clientAddress(render('23.248.1.2, 162.159.3.4, 10.28.5.6')), '23.248.1.2');
    // A client-supplied header is kept in front by the proxies, so counting from
    // the right still lands on the address Cloudflare saw, not the forged one.
    assert.equal(_internal.clientAddress(render('6.6.6.6, 23.248.1.2, 162.159.3.4, 10.28.5.6')), '23.248.1.2');
    // A short chain is not trusted: fall back to the peer (one shared bucket).
    assert.equal(_internal.clientAddress(render('162.159.3.4, 10.28.5.6')), '127.0.0.1');
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

test('an unsettled funding bar and a lagging small ETF do not discard valid data', () => {
  // The open bar (settles in the future) may carry no rate yet; settled history stays usable.
  const now = 1700000000 * 1000 + 9 * 3600000;
  const rows = lev.parseFundingBars([
    { data: [1700000000, 0, 0, 0, 0.01] },
    { data: [1700000000 + 8 * 3600, 0, 0, 0, null] }
  ], now);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rate, 0.0001);
  // A small fund that has not printed its flow leaves both sides of the ratio;
  // the day survives on the funds that did print. A core fund still vetoes the day.
  const day = '2026-11-02';
  const vol = n => new Map([[day, n]]);
  const volumes = { IBIT: vol(100), FBTC: vol(50), GBTC: vol(25), ARKB: vol(1000) };
  const out = lev.buildEtfTurnover([{ date: day, funds: { IBIT: 10, FBTC: 5, GBTC: -1, ARKB: null } }], volumes);
  assert.equal(out.length, 1);
  assert.equal(out[0].flowUsd, 14);
  assert.equal(out[0].volumeUsd, 175);
  assert.deepEqual(lev.buildEtfTurnover([{ date: day, funds: { IBIT: null, FBTC: 5, GBTC: -1, ARKB: 3 } }], volumes), []);
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

test('a newer committed archive supersedes only a producer-owned sidecar', () => {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-reseed-'));
  const file = path.join(dir, 'archive.json');
  const oldRoot = process.env.BE_SANDBOX_ROOT;
  const oldMode = process.env.SNAPSHOT_MODE;
  const { snapshotPath } = require('../server/snapshot_path');
  fs.writeFileSync(file, '{"v":1}');
  try {
    delete process.env.BE_SANDBOX_ROOT;
    delete process.env.SNAPSHOT_MODE;
    const local = snapshotPath(file, { producerOwned: true });
    fs.writeFileSync(local, '{"v":"runtime"}');
    // The collector publishes a newer archive (e.g. it arrives with a git pull).
    fs.writeFileSync(file, '{"v":2}');
    const later = new Date(Date.now() + 60000);
    fs.utimesSync(file, later, later);
    // A file only the HTTP process refreshes keeps its runtime copy…
    assert.equal(snapshotPath(file), local);
    assert.equal(fs.readFileSync(local, 'utf8'), '{"v":"runtime"}');
    // …a collector-owned archive is picked up instead of being shadowed for good.
    assert.equal(snapshotPath(file, { producerOwned: true }), local);
    assert.equal(fs.readFileSync(local, 'utf8'), '{"v":2}');
    assert.equal(fs.readFileSync(file, 'utf8'), '{"v":2}');
  } finally {
    if (oldRoot === undefined) delete process.env.BE_SANDBOX_ROOT; else process.env.BE_SANDBOX_ROOT = oldRoot;
    if (oldMode === undefined) delete process.env.SNAPSHOT_MODE; else process.env.SNAPSHOT_MODE = oldMode;
    for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));
    fs.rmdirSync(dir);
  }
});

test('the trade sidecar folds in committed rows it never saw, and a damaged committed copy is left alone', () => {
  const store = require('../server/trade_store');
  const committed = path.join(__dirname, '../data/block_trades_MERGEAUDIT.json');
  const sidecar = committed.replace(/\.json$/, '.local.json');
  const oldRoot = process.env.BE_SANDBOX_ROOT;
  const oldMode = process.env.SNAPSHOT_MODE;
  const now = Date.now();
  const leg = id => ({ trade_id: id, timestamp: now - id * 1000, instrument_name: 'BTC-25DEC26-100000-C', direction: 'buy', amount: 1 });
  fs.writeFileSync(committed, JSON.stringify({ trades: [leg(1), leg(2)] }));
  fs.writeFileSync(sidecar, JSON.stringify({ trades: [leg(1), leg(3)] }));
  try {
    delete process.env.BE_SANDBOX_ROOT;
    delete process.env.SNAPSHOT_MODE;
    const ids = store.recordAndMergeTrades('MERGEAUDIT', []).trades.map(t => t.trade_id).sort();
    assert.deepEqual(ids, [1, 2, 3]);
    assert.deepEqual(JSON.parse(fs.readFileSync(sidecar, 'utf8')).trades.map(t => t.trade_id).sort(), [1, 2, 3]);
    assert.deepEqual(JSON.parse(fs.readFileSync(committed, 'utf8')).trades.length, 2, 'the committed archive is never written by the HTTP process');
  } finally {
    if (oldRoot === undefined) delete process.env.BE_SANDBOX_ROOT; else process.env.BE_SANDBOX_ROOT = oldRoot;
    if (oldMode === undefined) delete process.env.SNAPSHOT_MODE; else process.env.SNAPSHOT_MODE = oldMode;
    for (const f of [committed, sidecar]) if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

test('a failed trade poll with a damaged archive does not abort the other market sources', () => {
  // Fresh process: the in-memory trade cache must be empty for the archive
  // fallback to be consulted at all (earlier tests in this file fill it).
  const { spawnSync } = require('node:child_process');
  const file = path.join(__dirname, '../data/block_trades_BADAUDIT.json');
  const original = '{truncated';
  fs.writeFileSync(file, original);
  try {
    const child = spawnSync(process.execPath, ['-e', `
      require(${JSON.stringify(path.join(__dirname, '../server/data_fetcher.js'))})
        .refreshAllMarketData('BADAUDIT')
        .then(r => { console.log('ROUND_DONE ' + JSON.stringify(r.failedSources)); process.exit(0); },
              e => { console.log('ROUND_REJECTED ' + e.message); process.exit(1); });
    `], { encoding: 'utf8', timeout: 60000 });
    // Offline sandbox: the live trade poll fails, the round falls back to the
    // archive, and the archive is damaged. The round must still complete.
    assert.match(child.stdout, /ROUND_DONE .*greeks_trades/, child.stdout + child.stderr);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  } finally { fs.unlinkSync(file); }
});
