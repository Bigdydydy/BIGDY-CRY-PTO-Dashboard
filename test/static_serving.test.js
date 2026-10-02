const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { server, _internal } = require('../server/index');

let port;

function get(pathname, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, headers: headers || {} }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}

describe('静态资源: 预压缩 + ETag 校验缓存 (Render 免费实例减负)', () => {
  before(() => new Promise(resolve => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); })));
  after(() => new Promise(resolve => server.close(resolve)));

  it('支持 gzip 时返回预压缩内容，解压后与原文件一致', async () => {
    const res = await get('/wave_ui.js', { 'Accept-Encoding': 'gzip' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers['content-encoding'], 'gzip');
    assert.strictEqual(res.headers['cache-control'], 'no-cache');
    assert.ok(res.headers.etag);
    const plain = await get('/wave_ui.js');
    assert.strictEqual(plain.headers['content-encoding'], undefined);
    assert.ok(zlib.gunzipSync(res.body).equals(plain.body));
    assert.ok(res.body.length < plain.body.length / 2, '压缩后应明显变小');
  });

  it('If-None-Match 命中时返回 304 且无正文', async () => {
    const first = await get('/index.html', { 'Accept-Encoding': 'gzip' });
    const again = await get('/index.html', { 'Accept-Encoding': 'gzip', 'If-None-Match': first.headers.etag });
    assert.strictEqual(again.status, 304);
    assert.strictEqual(again.body.length, 0);
  });

  it('目录越界与不存在的文件返回 404', async () => {
    assert.strictEqual((await get('/../package.json')).status, 404);
    assert.strictEqual((await get('/%2e%2e/package.json')).status, 404);
    assert.strictEqual((await get('/no_such_file.js')).status, 404);
  });

  it('/wave_engine.js 直接由 server/wave_engine.js 提供 (public 下不再保留副本)', async () => {
    assert.ok(!fs.existsSync(path.join(__dirname, '..', 'public', 'wave_engine.js')));
    const res = await get('/wave_engine.js');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.equals(fs.readFileSync(path.join(__dirname, '..', 'server', 'wave_engine.js'))));
  });

  it('/pnl_engine.js 正常静态提供且与 public/pnl_engine.js 内容一致', async () => {
    const res = await get('/pnl_engine.js');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.equals(fs.readFileSync(path.join(__dirname, '..', 'public', 'pnl_engine.js'))));
  });

  it('K线缓存只按 200/1000/10000 三档存放，任意 limit 从档位切片', async () => {
    const realFetch = global.fetch;
    let calls = 0;
    global.fetch = async url => {
      calls++;
      const lim = +new URL(url).searchParams.get('limit');
      const end = new URL(url).searchParams.get('endTime');
      const top = end ? +end : 1700000000000 + 20000 * 3600000;
      const rows = [];
      for (let i = lim - 1; i >= 0; i--) { const t = top - i * 3600000; rows.push([t, '1', '2', '0.5', '1.5', '10']); }
      return { ok: true, json: async () => rows };
    };
    try {
      _internal.waveKlineCache.clear();
      const a = await _internal.fetchBinanceKlines('TESTUSDT', '1h', 37);
      const b = await _internal.fetchBinanceKlines('TESTUSDT', '1h', 173);
      const c = await _internal.fetchBinanceKlines('TESTUSDT', '1h', 999);
      assert.strictEqual(a.length, 37);
      assert.strictEqual(b.length, 173);
      assert.strictEqual(c.length, 999);
      assert.strictEqual(a[a.length - 1].time, c[c.length - 1].time, '切片取最新的K线');
      const keys = Array.from(_internal.waveKlineCache.keys()).filter(k => k.startsWith('TESTUSDT'));
      assert.deepStrictEqual(keys.sort(), ['TESTUSDT_1h_1000', 'TESTUSDT_1h_200'].sort());
      const before = calls;
      await _internal.fetchBinanceKlines('TESTUSDT', '1h', 150);
      assert.strictEqual(calls, before, '同档位命中缓存，不再请求');
    } finally {
      global.fetch = realFetch;
      _internal.waveKlineCache.clear();
    }
  });

  it('按需刷新: 有 API 访问后不处于空闲状态', () => {
    _internal.noteApiActivity();
    assert.strictEqual(_internal.isServerIdle(), false);
  });

  it('K线接口: 1d/1w 作为高周期辅助数据放行，其余非研判周期仍拒绝', async () => {
    const bad = await get('/api/wave/klines?symbol=BTCUSDT&interval=3d');
    assert.strictEqual(bad.status, 400);
    const badTf = await get('/api/wave/klines?symbol=BTCUSDT&interval=1m');
    assert.strictEqual(badTf.status, 400);
  });
});
