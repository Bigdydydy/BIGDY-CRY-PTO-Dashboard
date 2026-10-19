/**
 * Phase 3B/E — wave kline health & endpoint gating tests (offline).
 *
 * Covers: malformed primary source → fallback; all-source failure → old cache
 * array with untouched receipt; clock expiry → unusable; tier slicing keeping
 * the larger tier's receipt; /api/wave/klines historical browsing vs
 * /api/wave/analysis + /api/wave/evaluate 503 data_unavailable gates.
 */
const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const { server, _internal } = require('../server/index.js');
const { getSourceHealth, resetHealthForTests } = require('../server/data_health');

const H = 3600000;

/** Binance-shaped ascending rows ending at the current (or given) hour boundary. */
function binanceRows(url, top = Math.floor(Date.now() / H) * H) {
  const u = new URL(url);
  const lim = +u.searchParams.get('limit');
  const end = u.searchParams.get('endTime');
  const last = end ? +end - ((+end) % H) : top;
  const rows = [];
  for (let i = lim - 1; i >= 0; i--) { const t = last - i * H; rows.push([t, '1', '2', '0.5', '1.5', '10']); }
  return rows;
}

function bybitRows(url, top = Math.floor(Date.now() / H) * H) {
  const u = new URL(url);
  const lim = +u.searchParams.get('limit');
  const end = u.searchParams.get('end');
  const last = end ? +end - ((+end) % H) : top;
  const list = [];
  for (let i = 0; i < lim; i++) list.push([String(last - i * H), '1', '2', '0.5', '1.5', '10', '0']); // newest→oldest
  return list;
}

async function withFetch(fake, fn) {
  const realFetch = global.fetch;
  global.fetch = fake;
  _internal.waveKlineCache.clear();
  resetHealthForTests();
  try { return await fn(); } finally { global.fetch = realFetch; _internal.waveKlineCache.clear(); resetHealthForTests(); }
}

describe('Wave kline health (Phase 3B)', () => {
  it('malformed primary source rows → that source fails, next source serves; no NaN cached', async () => {
    await withFetch(async url => {
      const host = new URL(url).host;
      if (/binance/.test(host)) {
        const rows = binanceRows(url);
        rows[3] = ['NaN', 'x', 'y', 'z', 'w', 'bad']; // malformed row inside a good-looking page
        return { ok: true, json: async () => rows };
      }
      if (/bybit/.test(host)) {
        return { ok: true, json: async () => ({ retCode: 0, result: { list: bybitRows(url) } }) };
      }
      return { ok: false, status: 403, json: async () => ({}) };
    }, async () => {
      const bars = await _internal.fetchBinanceKlines('TESTUSDT', '1h', 150);
      assert.strictEqual(bars.length, 150);
      assert.ok(bars.every(b => [b.time, b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite)), 'no NaN bars');
      const h = _internal.waveKlineSourceHealth('TESTUSDT', '1h', 150);
      assert.strictEqual(h.state, 'FALLBACK', 'a successful non-primary source is 备用源, never green OK');
      assert.strictEqual(h.source, 'Bybit 永续', 'fallback source recorded, not the failed primary');
      assert.ok(Array.isArray(h.issues) && h.issues.length >= 1, 'skipped primary errors preserved as issues');
      assert.match(h.issues.join(' '), /币安/);
    });
  });

  it('all sources fail → old cached array returned, receipt clocks untouched, failure recorded', async () => {
    let fail = false;
    await withFetch(async url => {
      const host = new URL(url).host;
      if (fail) throw new Error('network down');
      if (/binance/.test(host)) return { ok: true, json: async () => binanceRows(url) };
      return { ok: false, status: 403, json: async () => ({}) };
    }, async () => {
      const first = await _internal.fetchBinanceKlines('TESTUSDT', '1h', 150);
      const entry = _internal.waveKlineCache.get('TESTUSDT_1h_200');
      const acq = entry.acquiredAt, asof = entry.dataAsOf, data = entry.data;

      // Age past the 2min fresh window so a refresh is attempted, but keep the
      // receipt/data clocks young enough that the entry is still usable.
      entry.timestamp = Date.now() - 3 * 60000;
      fail = true;
      const second = await _internal.fetchBinanceKlines('TESTUSDT', '1h', 150);
      assert.deepStrictEqual(second, first, 'old data served, not rebuilt');
      assert.strictEqual(_internal.waveKlineCache.get('TESTUSDT_1h_200').data, data,
        'cache entry array untouched by the failed refresh');

      const after = _internal.waveKlineCache.get('TESTUSDT_1h_200');
      assert.strictEqual(after.acquiredAt, acq, 'receipt must not be renewed by a failed refresh');
      assert.strictEqual(after.dataAsOf, asof, 'data clock must not be renewed by a failed refresh');

      const h = _internal.waveKlineSourceHealth('TESTUSDT', '1h', 150);
      assert.ok(h.usable, 'recent last-good stays usable (FALLBACK/STALE, not green OK)');
      assert.notStrictEqual(h.state, 'OK');
      assert.ok(h.lastError, 'failure reason surfaced in health');
      const reg = getSourceHealth(_internal.waveSourceId('TESTUSDT', '1h', 200));
      assert.ok(reg.consecutiveFailures >= 1);
      assert.strictEqual(reg.lastSuccessAt, new Date(acq).toISOString(), 'registry lastSuccess keeps the old receipt');
    });
  });

  it('expired clocks → usable=false with stale/expired warnings', async () => {
    await withFetch(async url => {
      const host = new URL(url).host;
      if (/binance/.test(host)) return { ok: true, json: async () => binanceRows(url) };
      return { ok: false, status: 403, json: async () => ({}) };
    }, async () => {
      await _internal.fetchBinanceKlines('TESTUSDT', '1h', 150);
      const entry = _internal.waveKlineCache.get('TESTUSDT_1h_200');
      const old = Date.now() - 30 * 60000;
      entry.timestamp = old;
      entry.acquiredAt = old;                       // receipt 30min old > fetchBlock 15min
      const h = _internal.waveKlineSourceHealth('TESTUSDT', '1h', 150);
      assert.strictEqual(h.usable, false);
      assert.strictEqual(h.stale, true);
      assert.notStrictEqual(h.state, 'OK');
    });
  });

  it('slicing a bigger tier keeps the ORIGINAL tier receipt (not a fresh acquire)', async () => {
    await withFetch(async url => {
      const host = new URL(url).host;
      if (/binance/.test(host)) return { ok: true, json: async () => binanceRows(url) };
      return { ok: false, status: 403, json: async () => ({}) };
    }, async () => {
      await _internal.fetchBinanceKlines('TESTUSDT', '1h', 10000); // fills tier 10000
      const big = _internal.waveKlineCache.get('TESTUSDT_1h_10000');
      const bars = await _internal.fetchBinanceKlines('TESTUSDT', '1h', 1000); // slices the big tier
      assert.strictEqual(bars.length, 1000);
      const small = _internal.waveKlineCache.get('TESTUSDT_1h_1000');
      assert.strictEqual(small.acquiredAt, big.acquiredAt, 'slice inherits the big-tier receipt');
      assert.strictEqual(small.dataAsOf, big.dataAsOf, 'slice inherits the big-tier data clock');
      assert.strictEqual(small.timestamp, big.timestamp);
    });
  });

  it('expired cache → /wave/klines still serves the historical chart (200 historicalOnly) while /wave/analysis and /wave/evaluate 503', async (t) => {
    const port = await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
    t.after(() => new Promise(r => server.close(r)));

    // Upstream kline calls fail; localhost (our own HTTP client) passes through.
    const realFetch = global.fetch;
    global.fetch = (url, opts) => {
      const s = typeof url === 'string' ? url : (url && url.url) || '';
      if (s.includes('127.0.0.1') || s.includes('localhost')) return realFetch(url, opts);
      return Promise.reject(new Error('all kline sources down'));
    };
    _internal.waveKlineCache.clear();
    resetHealthForTests();
    try {
      const now = Date.now();
      const old = now - 30 * 60000;
      // Seed expired entries for the 4h tiers the endpoints will consult.
      const mk = tier => {
        const bars = [];
        for (let i = tier - 1; i >= 0; i--) {
          const t = Math.floor((old - i * 4 * H) / 1000);
          bars.push({ time: t, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });
        }
        _internal.waveKlineCache.set(`BTCUSDT_4h_${tier}`, {
          timestamp: old, acquiredAt: old, dataAsOf: bars[bars.length - 1].time * 1000,
          data: bars, source: { name: '币安合约' }
        });
      };
      mk(10000); mk(1000);

      // Historical chart stays browsable — explicitly marked.
      const r1 = await fetch(`http://127.0.0.1:${port}/api/wave/klines?symbol=BTCUSDT&interval=4h&limit=1000`);
      const j1 = await r1.json();
      assert.strictEqual(r1.status, 200, 'historical chart still served');
      assert.strictEqual(j1.code, 0);
      assert.strictEqual(j1.historicalOnly, true);
      assert.strictEqual(j1.usable, false);
      assert.strictEqual(j1.dataHealth.analysisAllowed, false);
      assert.ok(j1.bars.length > 0);

      // Analysis on the same timeframe is gated: 503 data_unavailable, no conclusions.
      const r2 = await fetch(`http://127.0.0.1:${port}/api/wave/analysis`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: 'BTCUSDT', interval: '4h' })
      });
      const j2 = await r2.json();
      assert.strictEqual(r2.status, 503);
      assert.strictEqual(j2.code, 503);
      assert.strictEqual(j2.status, 'data_unavailable');
      assert.ok(j2.dataHealth && j2.dataHealth.sources);
      assert.ok(!j2.waves && !j2.verdict, 'no analysis conclusion emitted');

      // User-sketch evaluation on an expired required tf → same 503 contract.
      const firstTime = Math.floor((now - 300 * 4 * H) / 1000);
      const r3 = await fetch(`http://127.0.0.1:${port}/api/wave/evaluate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: 'BTCUSDT',
          drawings: [{
            id: 'd1', tool: 'ABC', timeframe: '4h',
            points: [
              { time: firstTime, price: 1 }, { time: firstTime + 50 * 4 * 3600, price: 2 }, { time: firstTime + 100 * 4 * 3600, price: 1.5 }
            ]
          }]
        })
      });
      const j3 = await r3.json();
      assert.strictEqual(r3.status, 503);
      assert.strictEqual(j3.status, 'data_unavailable');
      assert.ok(j3.dataHealth && j3.dataHealth.sources);
    } finally {
      global.fetch = realFetch;
      _internal.waveKlineCache.clear();
      resetHealthForTests();
    }
  });
});
