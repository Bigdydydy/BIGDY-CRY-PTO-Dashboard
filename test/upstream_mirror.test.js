const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

process.env.FLOW_FORCE_NO_STREAMS = '1';
delete process.env.UPSTREAM_ORIGIN;

const mirror = require('../server/upstream_mirror');

/** 本机假"线上"服务: routes = { '/path?query': payload | (() => payload) } */
function startUpstream(routes) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const r = routes[req.url];
    if (r === undefined) { res.writeHead(404); res.end('{}'); return; }
    const body = typeof r === 'function' ? r() : r;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({ origin: `http://127.0.0.1:${server.address().port}`, hits, close: () => new Promise(r => server.close(r)) });
  }));
}

test('线上网址: 未配置时不生效，指向本机自身端口时拒绝 (防回环)', () => {
  delete process.env.UPSTREAM_ORIGIN;
  assert.strictEqual(mirror.getUpstreamOrigin(), null);
  process.env.UPSTREAM_ORIGIN = 'https://bigdy.example.com/some/path';
  assert.strictEqual(mirror.getUpstreamOrigin(), 'https://bigdy.example.com');
  process.env.PORT = '3000';
  process.env.UPSTREAM_ORIGIN = 'http://localhost:3000';
  assert.strictEqual(mirror.getUpstreamOrigin(), null);
  process.env.UPSTREAM_ORIGIN = 'not a url';
  assert.strictEqual(mirror.getUpstreamOrigin(), null);
  delete process.env.UPSTREAM_ORIGIN;
});

test('线上失败后进入冷却，期间不再请求', async () => {
  const up = await startUpstream({});
  process.env.UPSTREAM_ORIGIN = up.origin;
  mirror.resetUpstreamMirror();
  await assert.rejects(mirror.fetchUpstreamJson('/api/coinbase-liquidity'), /HTTP 404/);
  await assert.rejects(mirror.fetchUpstreamJson('/api/coinbase-liquidity'), /线上暂不可达/);
  assert.strictEqual(up.hits.length, 1, '冷却期内只打过一次');
  await up.close();
  delete process.env.UPSTREAM_ORIGIN;
  mirror.resetUpstreamMirror();
});

test('模块 6: 本机连不上 Coinbase 时使用线上转发的深度数据，并标明来源', async () => {
  const upstreamPayload = {
    code: 0,
    midPrice: 81234.5,
    depthProfile: { '10bps': { bidUsd: 1e6, askUsd: 1e6 } },
    updatedAt: '2026-10-20T05:00:00.000Z',
    dataHealth: { state: 'OK', sources: { coinbase: { dataAsOf: '2026-10-20T05:00:00.000Z' } } }
  };
  const up = await startUpstream({ '/api/coinbase-liquidity': upstreamPayload });
  process.env.UPSTREAM_ORIGIN = up.origin;
  mirror.resetUpstreamMirror();
  const { getCoinbaseLiquidityData } = require('../server/coinbase_fetcher');
  const data = await getCoinbaseLiquidityData(true); // 直连 Coinbase 被离线沙箱拦截 → 走线上
  assert.strictEqual(data.mirroredFrom, 'upstream');
  assert.strictEqual(data.midPrice, 81234.5);
  assert.strictEqual(data.code, undefined, '线上的 code 不透传');
  assert.ok(data.dataHealth, '本地重新生成健康信息');
  assert.notDeepStrictEqual(data.dataHealth, upstreamPayload.dataHealth, '不照搬线上的健康信息');
  await up.close();
  delete process.env.UPSTREAM_ORIGIN;
  mirror.resetUpstreamMirror();
});

test('模块 5: Coinbase K线与 USDT/USD 按 Coinbase API → 线上转发 → TradingView 的顺序兜底', async () => {
  const t0 = Math.floor((Date.now() - 10 * 3.6e6) / 3.6e6) * 3600;
  const candles = Array.from({ length: 5 }, (_, i) => ({ time: t0 + i * 3600, open: 80000 + i, high: 80100 + i, low: 79900 + i, close: 80050 + i, volumeUsd: 1e6 + i }));
  const flow = {
    code: 0,
    candleSource: 'Coinbase BTC-USD · Coinbase API',
    candles,
    usdtUsd: candles.map(k => [k.time, 0.9987]),
    audit: { rows: { usSpot: { depthUsd: 12e6, vol24hUsd: 9e8 } } }
  };
  const up = await startUpstream({ '/api/flow-force?tf=1h': flow });
  process.env.UPSTREAM_ORIGIN = up.origin;
  mirror.resetUpstreamMirror();
  const ff = require('../server/flow_force');

  const venue = await ff.fetchVenue('usSpot', '1h', new Map(), Date.now());
  assert.strictEqual(venue.source, '线上转发');
  assert.strictEqual(venue.bars.length, 5);
  assert.deepStrictEqual(venue.bars[0], { t: t0 * 1000, o: 80000, h: 80100, l: 79900, c: 80050, v: 1e6 });
  assert.match(venue.errors[0], /^Coinbase API:/, '先尝试过直连');

  const usdt = await ff.fetchUsdtUsd('1h');
  assert.strictEqual(usdt.source, '线上转发');
  assert.strictEqual(usdt.bars[0].c, 0.9987);
  assert.strictEqual(up.hits.length, 1, '同一刷新内的K线与汇率共用一次线上请求');
  await up.close();

  // 线上给的主图不是 Coinbase (线上自己也退到了币安) → 不采用
  const up2 = await startUpstream({ '/api/flow-force?tf=1h': { ...flow, candleSource: '币安现货 BTCUSDT · 官方档案' } });
  process.env.UPSTREAM_ORIGIN = up2.origin;
  mirror.resetUpstreamMirror();
  const venue2 = await ff.fetchVenue('usSpot', '1h', new Map(), Date.now());
  assert.notStrictEqual(venue2.source, '线上转发');
  assert.ok(venue2.errors.some(e => /线上主图K线不是 Coinbase/.test(e)));
  await up2.close();
  delete process.env.UPSTREAM_ORIGIN;
  mirror.resetUpstreamMirror();
});
