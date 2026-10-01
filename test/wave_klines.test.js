const { describe, it } = require('node:test');
const assert = require('node:assert');
const { _internal } = require('../server/index.js');

const H = 3600000;
const TOP = 1700000000000 + 20000 * H;

/** 币安格式的模拟K线: 以 endTime (或 TOP) 为最新一根，向前 limit 根 */
function binanceRows(url, top) {
  const u = new URL(url);
  const lim = +u.searchParams.get('limit');
  const end = u.searchParams.get('endTime');
  const last = end ? +end - ((+end) % H) : top;
  const rows = [];
  for (let i = lim - 1; i >= 0; i--) { const t = last - i * H; rows.push([t, '1', '2', '0.5', '1.5', '10']); }
  return rows;
}

async function withFetch(fake, fn) {
  const realFetch = global.fetch;
  global.fetch = fake;
  _internal.waveKlineCache.clear();
  try { return await fn(); } finally { global.fetch = realFetch; _internal.waveKlineCache.clear(); }
}

describe('Module 8: K线行情源 (币安限流 / 拒绝时的回退)', () => {
  it('币安三个源都被拒 → 改用 Bybit；全部失败时错误列出每个源的原因', async () => {
    const hosts = [];
    await withFetch(async url => {
      const host = new URL(url).host;
      hosts.push(host);
      if (/binance/.test(host)) return { ok: false, status: 451, json: async () => ({}) };
      if (/bybit/.test(host)) {
        const lim = +new URL(url).searchParams.get('limit');
        const list = [];
        for (let i = 0; i < lim; i++) list.push([String(TOP - i * H), '1', '2', '0.5', '1.5', '10', '0']); // 新→旧
        return { ok: true, json: async () => ({ retCode: 0, result: { list } }) };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    }, async () => {
      const bars = await _internal.fetchBinanceKlines('TESTUSDT', '1h', 150);
      assert.strictEqual(bars.length, 150);
      assert.strictEqual(bars[bars.length - 1].time, TOP / 1000, 'Bybit 新→旧的顺序已转为升序');
      assert.ok(bars.every((b, i) => !i || b.time > bars[i - 1].time));
      assert.deepStrictEqual(hosts.slice(0, 4), ['fapi.binance.com', 'data-api.binance.vision', 'api.binance.com', 'api.bybit.com']);
    });

    await withFetch(async url => ({ ok: false, status: /binance/.test(url) ? 418 : 403, json: async () => ({}) }), async () => {
      await assert.rejects(() => _internal.fetchBinanceKlines('TESTUSDT', '4h', 100), err => {
        assert.match(err.message, /币安合约: HTTP 418/);
        assert.match(err.message, /Bybit 永续: HTTP 403/);
        assert.match(err.message, /OKX 永续: HTTP 403/);
        return true;
      });
    });
  });

  it('缓存过期后只补拉最新一页并拼接；拉取失败时返回旧缓存', async () => {
    let top = TOP, calls = [], fail = false;
    await withFetch(async url => {
      calls.push(+new URL(url).searchParams.get('limit'));
      if (fail) return { ok: false, status: 429, json: async () => ({}) };
      return { ok: true, json: async () => binanceRows(url, top) };
    }, async () => {
      const a = await _internal.fetchBinanceKlines('TESTUSDT', '1h', 1000);
      assert.strictEqual(a.length, 1000);
      // 时间过去 3 根K线，缓存过期 (当前时间与模拟K线对齐)
      const key = 'TESTUSDT_1h_1000';
      const realNow = Date.now;
      const now = TOP + 3 * H + 60000;
      Date.now = () => now;
      try {
        _internal.waveKlineCache.get(key).timestamp = now - 10 * 60000;
        top = TOP + 3 * H;
        calls = [];
        const b = await _internal.fetchBinanceKlines('TESTUSDT', '1h', 1000);
        assert.strictEqual(calls.length, 1, '只请求了一页');
        assert.ok(calls[0] <= 10, `增量页大小 ${calls[0]}`);
        assert.strictEqual(b.length, 1000);
        assert.strictEqual(b[b.length - 1].time, (TOP + 3 * H) / 1000, '拼上了新的K线');
        assert.ok(b.every((x, i) => !i || x.time > b[i - 1].time), '无重复、升序');

        _internal.waveKlineCache.get(key).timestamp = now - 10 * 60000;
        fail = true;
        const c = await _internal.fetchBinanceKlines('TESTUSDT', '1h', 1000);
        assert.strictEqual(c.length, 1000, '全部源失败时返回旧缓存');
        assert.strictEqual(c[c.length - 1].time, b[b.length - 1].time);
      } finally {
        Date.now = realNow;
      }
    });
  });
});
