const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { installModuleMocks, srv, freshRequire } = require('./helpers/leaf_env');

function zip(csv) {
  const data = zlib.deflateRawSync(Buffer.from(csv)), head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(8, 8);
  head.writeUInt32LE(data.length, 18);
  return Buffer.concat([head, data]);
}

test('Binance archive: one failed daily file does not discard valid history and is retried', async t => {
  const realNow = Date.now;
  Date.now = () => Date.UTC(2026, 10, 10);
  t.after(() => { Date.now = realNow; });
  let fail = true, attempts = 0;
  installModuleMocks(t, { [srv('http_client.js')]: { async fetchWithTimeout(url) {
    if (url.includes('2026-11-08')) { attempts++; if (fail) throw new Error('daily offline'); }
    const date = url.match(/(\d{4}-\d{2}-\d{2})\.zip$/)?.[1];
    assert.ok(date);
    const t = Date.parse(date + 'T00:00:00Z');
    return { ok: true, status: 200, async arrayBuffer() { return zip(`${t},1,2,0.5,1.5,10,0,15\n`); } };
  } } });
  const mod = freshRequire('binance_feed.js');
  const from = Date.UTC(2026, 10, 7);
  const partial = await mod.fetchArchiveBars('perp', '1d', from);
  assert.equal(partial.length, 2);
  fail = false;
  const complete = await mod.fetchArchiveBars('perp', '1d', from);
  assert.equal(complete.length, 3);
  assert.equal(attempts, 2, 'failed file is not cached as successful');
});
