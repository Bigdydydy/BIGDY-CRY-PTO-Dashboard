const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const zlib = require('zlib');
const { server } = require('../server/index');

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

  it('K线接口: 1d/1w 作为高周期辅助数据放行，其余非研判周期仍拒绝', async () => {
    const bad = await get('/api/wave/klines?symbol=BTCUSDT&interval=3d');
    assert.strictEqual(bad.status, 400);
    const badTf = await get('/api/wave/klines?symbol=BTCUSDT&interval=1m');
    assert.strictEqual(badTf.status, 400);
  });
});
