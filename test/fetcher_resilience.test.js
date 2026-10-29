/**
 * Leaf-source resilience lifecycle tests — fully offline.
 *
 * Every scenario runs: good → malformed/empty refresh → all-fail fallback →
 * recovery, asserting that a failed refresh never overwrites the last-good
 * disk cache, zero values are accepted where valid, and health is truthful.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { installModuleMocks, srv, freshRequire, resetHealth, fakeResp } = require('./helpers/leaf_env');
const { getSourceHealth } = require('../server/data_health');

const HTTP = srv('http_client.js');
const SPOT = srv('spot_daily.js');
const LIQHIST = srv('liquidity_history.js');

const nowSec = () => Math.floor(Date.now() / 1000);
const iso = d => new Date(d).toISOString().slice(0, 10);

function dailyRows(n, basePrice, { step = 86400000 } = {}) {
  const startMs = Date.now() - n * step;
  return Array.from({ length: n }, (_, i) => ({
    date: iso(startMs + i * step),
    openTime: startMs + i * step,
    close: basePrice + i
  }));
}

function diskBytes(file) {
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

// ===========================================================================
// A · CDRI — Coinglass performance + history
// ===========================================================================

function cdriHttp(holder) {
  return async (url) => {
    const s = holder.state;
    if (s.fail) return fakeResp({}, { ok: false, status: 503 });
    if (url.includes('/api/index/cgri/performance')) return fakeResp({ code: 0, data: s.perf });
    if (url.includes('/api/index/cgri')) return fakeResp({ code: 0, data: s.hist });
    throw new Error('unexpected url ' + url);
  };
}

const cdriGood = () => ({
  perf: { price: 0, yesterday: 40, week: 50, month: 60, yearHigh: 90, yearLow: 10 },
  hist: {
    timeList: [nowSec() - 2 * 86400, nowSec() - 86400, nowSec()],
    valueList: [30, 0, 50],
    priceList: [50000, 51000, 52000]
  }
});

test('A/CDRI lifecycle: good → malformed → all-fail → recovery; disk preserved', async (t) => {
  resetHealth();
  const state = cdriGood();
  const holder = { state };
  const { tmpDir } = installModuleMocks(t, { [HTTP]: { fetchWithTimeout: cdriHttp(holder) } });
  const mod = freshRequire('cdri_fetcher.js');
  const cacheFile = path.join(tmpDir, 'cdri_data.json');

  const r1 = await mod.fetchCdriData(true);
  assert.equal(r1.performance.price, 0); // zero is a legal CDRI print
  assert.equal(r1.dataHealth.state, 'OK');
  const goodBytes = diskBytes(cacheFile);
  assert.ok(goodBytes?.length > 0, 'cache persisted');

  // Malformed: valueList out of [0,100] → failure, fallback payload, disk untouched
  holder.state = { ...cdriGood(), hist: { ...cdriGood().hist, valueList: [30, 0, 200] } };
  const r2 = await mod.fetchCdriData(true);
  assert.equal(r2.performance.price, 0); // last-good still served
  assert.notEqual(r2.dataHealth.state, 'OK');
  assert.deepEqual(diskBytes(cacheFile), goodBytes, 'malformed refresh must not rewrite cache');
  assert.equal(getSourceHealth('cdri').lastError !== null, true);

  // All-fail: still the last good data, health degraded
  holder.state = { fail: true };
  const r3 = await mod.fetchCdriData(true);
  assert.equal(r3.performance.price, 0);
  assert.notEqual(r3.dataHealth.state, 'OK');
  assert.deepEqual(diskBytes(cacheFile), goodBytes);

  // Recovery: fresh good payload restores OK
  holder.state = cdriGood();
  const r4 = await mod.fetchCdriData(true);
  assert.equal(r4.dataHealth.state, 'OK');
  assert.equal(getSourceHealth('cdri').lastError, null);
});

// ===========================================================================
// B · Coinbase — L2 book + daily candles + ticker/stats
// ===========================================================================

function cbBook() {
  return {
    bids: [['49900', '1.5'], ['49800', '2']],
    asks: [['50100', '1'], ['50200', '1.2']],
    sequence: 1
  };
}
function cbCandles(n = 35) {
  // newest first, [time(sec), low, high, open, close, volume]
  return Array.from({ length: n }, (_, i) => {
    const t = nowSec() - i * 86400;
    const o = 50000 - i;
    return [t, o - 100, o + 100, o, o + 50, 10 + (i === 0 ? 0 : i)]; // vol 0 legal on row 0
  });
}
const cbTicker = () => ({ price: '50000', volume: '10', time: new Date().toISOString() });
const cbStats = () => ({ last: '50000', volume: '100', open: '49000', high: '51000', low: '48000' });

function cbHttp(holder) {
  return async (url) => {
    const s = holder.state;
    if (s.fail) return fakeResp({}, { ok: false, status: 503 });
    if (url.includes('/book?level=2')) return fakeResp(s.book ?? cbBook());
    if (url.includes('/candles')) return fakeResp(s.candles ?? cbCandles());
    if (url.includes('/ticker')) return fakeResp(s.ticker ?? cbTicker());
    if (url.includes('/stats')) return fakeResp(s.stats ?? cbStats());
    throw new Error('unexpected url ' + url);
  };
}

test('B/Coinbase lifecycle: good → malformed book → all-fail → recovery; disk preserved', async (t) => {
  resetHealth();
  const holder = { state: {} };
  const { tmpDir } = installModuleMocks(t, {
    [HTTP]: { fetchWithTimeout: cbHttp(holder) },
    [LIQHIST]: { recordLiveSnapshot() {} }
  });
  const mod = freshRequire('coinbase_fetcher.js');
  const cacheFile = path.join(tmpDir, 'coinbase_liquidity.json');

  const r1 = await mod.getCoinbaseLiquidityData(true);
  assert.ok(r1.midPrice > 0);
  assert.equal(r1.dataHealth.state, 'OK');
  assert.equal(getSourceHealth('coinbase_candles').state, 'OK');
  const goodBytes = diskBytes(cacheFile);
  assert.ok(goodBytes?.length > 0);

  // Malformed book (empty asks) → failure; last-good served; disk untouched
  holder.state = { book: { bids: [['49900', '1']], asks: [] } };
  const r2 = await mod.getCoinbaseLiquidityData(true);
  assert.ok(r2.midPrice > 0);
  assert.notEqual(r2.dataHealth.state, 'OK');
  assert.deepEqual(diskBytes(cacheFile), goodBytes);

  // All-fail → fallback still serves the valid copy
  holder.state = { fail: true };
  const r3 = await mod.getCoinbaseLiquidityData(true);
  assert.ok(r3.midPrice > 0);
  assert.notEqual(r3.dataHealth.state, 'OK');
  assert.deepEqual(diskBytes(cacheFile), goodBytes);

  // Recovery
  holder.state = {};
  const r4 = await mod.getCoinbaseLiquidityData(true);
  assert.equal(r4.dataHealth.state, 'OK');
});

// ===========================================================================
// C · Gold — spot_daily venue series
// ===========================================================================

test('C/Gold lifecycle: good → malformed → all-fail → recovery; disk preserved', async (t) => {
  resetHealth();
  const holder = { state: { mode: 'good' } };
  const fakeSpot = {
    fetchSpotDailyCloses: async () => {
      const s = holder.state;
      if (s.mode === 'fail') throw new Error('All spot venues failed — offline');
      if (s.mode === 'malformed') throw new Error('PAXG: invalid close NaN');
      return {
        venue: 'TestVenue', quote: 'USD',
        series: { PAXG: dailyRows(40, 2500), BTC: dailyRows(40, 50000) },
        errors: [], partial: false, coverageStart: iso(Date.now() - 40 * 86400000)
      };
    }
  };
  const { tmpDir } = installModuleMocks(t, { [SPOT]: fakeSpot });
  const mod = freshRequire('gold_fetcher.js');
  const cacheFile = path.join(tmpDir, 'gold_correlation.json');

  const r1 = await mod.getGoldCorrelationData(true);
  assert.equal(r1.series.length, 40);
  assert.equal(r1.dataHealth.state, 'OK');
  const goodBytes = diskBytes(cacheFile);
  assert.ok(goodBytes?.length > 0);

  holder.state.mode = 'malformed';
  const r2 = await mod.getGoldCorrelationData(true);
  assert.equal(r2.series.length, 40);
  assert.notEqual(r2.dataHealth.state, 'OK');
  assert.deepEqual(diskBytes(cacheFile), goodBytes);

  holder.state.mode = 'fail';
  const r3 = await mod.getGoldCorrelationData(true);
  assert.equal(r3.series.length, 40);
  assert.notEqual(r3.dataHealth.state, 'OK');
  assert.deepEqual(diskBytes(cacheFile), goodBytes);

  holder.state.mode = 'good';
  const r4 = await mod.getGoldCorrelationData(true);
  assert.equal(r4.dataHealth.state, 'OK');
});

// ===========================================================================
// D · SSRO — DefiLlama history + TradingView quote + BTC daily
// ===========================================================================

function ssroHttp(holder) {
  return async (url, opts) => {
    const s = holder.state;
    if (s.fail) return fakeResp({}, { ok: false, status: 503 });
    if (url.includes('stablecoins.llama.fi')) {
      if (s.llamaTimeout) throw new Error('Request timeout of 30000ms exceeded');
      if (s.llamaEmpty) return fakeResp([]);
      const rows = Array.from({ length: 40 }, (_, i) => ({
        date: String(nowSec() - (39 - i) * 86400),
        totalCirculatingUSD: { peggedUSD: 150e9 + i * 1e8 }
      }));
      return fakeResp(rows);
    }
    if (url.includes('scanner.tradingview.com')) {
      if (s.quoteMissing) {
        // stableCap present but btcPrice absent → quote legs incomplete
        return fakeResp({ data: [{ s: 'CRYPTOCAP:STABLE.C', d: ['x', 150e9, 0.5] }] });
      }
      return fakeResp({
        data: [
          { s: 'CRYPTOCAP:STABLE.C', d: ['x', 150e9, 0.5] },
          { s: 'BINANCE:BTCUSDT', d: ['x', 51000, 1.2] },
          { s: 'CRYPTOCAP:BTC', d: ['x', 1.05e12] }
        ]
      });
    }
    throw new Error('unexpected url ' + url);
  };
}

const ssroSpot = {
  fetchSpotDailyCloses: async () => ({
    venue: 'TestVenue', quote: 'USDT',
    series: { BTC: dailyRows(40, 50000) },
    errors: [], partial: false, coverageStart: iso(Date.now() - 40 * 86400000)
  })
};

test('D/SSRO lifecycle: live quote only when both legs valid; history never fabricates today', async (t) => {
  resetHealth();
  const holder = { state: {} };
  const { tmpDir } = installModuleMocks(t, {
    [HTTP]: { fetchWithTimeout: ssroHttp(holder) },
    [SPOT]: ssroSpot
  });
  const mod = freshRequire('ssro_fetcher.js');
  const cacheFile = path.join(tmpDir, 'ssro_chart.json');
  const today = iso(Date.now());

  const r1 = await mod.getSsroData(true);
  assert.equal(r1.points[r1.points.length - 1].date, today, 'live quote appends today');
  assert.equal(r1.dataHealth.state, 'OK');
  const goodBytes = diskBytes(cacheFile);
  assert.ok(goodBytes?.length > 0);

  // Quote missing a leg → ancillary failure, no fabricated "today" row,
  // last point stays at the last real historical intersection date.
  holder.state = { quoteMissing: true };
  const r2 = await mod.getSsroData(true);
  const last2 = r2.points[r2.points.length - 1];
  assert.notEqual(last2.date, today, 'missing quote legs must not fabricate today');
  assert.ok(last2.date < today);
  assert.equal(getSourceHealth('ssro_quote').state !== 'OK', true);
  assert.notEqual(r2.dataHealth.state, 'OK');
  assert.deepEqual(diskBytes(cacheFile).length > 0, true);

  // Empty DefiLlama → build failure → last-good fallback, disk untouched by
  // the failed round (the file still holds the r2-era valid payload)
  const beforeFail = diskBytes(cacheFile);
  holder.state = { llamaEmpty: true, fail: false };
  const r3 = await mod.getSsroData(true);
  assert.ok(r3.points.length > 0);
  assert.notEqual(r3.dataHealth.state, 'OK');
  assert.deepEqual(diskBytes(cacheFile), beforeFail);

  // Recovery: full quote + history again
  holder.state = {};
  const r4 = await mod.getSsroData(true);
  assert.equal(r4.points[r4.points.length - 1].date, today);
  assert.equal(r4.dataHealth.state, 'OK');
});

test('D/SSRO DefiLlama timeout: BTC leg keeps updating on cached stablecoin history, never persisted', async (t) => {
  resetHealth();
  const holder = { state: {} };
  const { tmpDir } = installModuleMocks(t, {
    [HTTP]: { fetchWithTimeout: ssroHttp(holder) },
    [SPOT]: ssroSpot
  });
  const mod = freshRequire('ssro_fetcher.js');
  const cacheFile = path.join(tmpDir, 'ssro_chart.json');
  const today = iso(Date.now());

  await mod.getSsroData(true);
  const goodBytes = diskBytes(cacheFile);

  holder.state = { llamaTimeout: true, quoteMissing: true };
  const r = await mod.getSsroData(true);
  assert.equal(r.points.length, 39, 'built from cached stablecoin history, no fabricated today');
  assert.equal(getSourceHealth('ssro_stable').state, 'FALLBACK');
  assert.match(getSourceHealth('ssro_stable').lastError, /timeout/);
  const ssro = getSourceHealth('ssro');
  assert.ok(ssro.issues.some(i => /沿用缓存/.test(i)));
  assert.equal(getSourceHealth('ssro_quote').lastError, 'TradingView 返回缺 BTCUSDT');
  assert.deepEqual(diskBytes(cacheFile), goodBytes, 'cached-history round is not persisted');

  // Cold process with only the disk file: still builds from disk stablecoin points
  const cold = freshRequire('ssro_fetcher.js');
  holder.state = { llamaTimeout: true };
  const rc = await cold.getSsroData(true);
  assert.equal(rc.points[rc.points.length - 1].date, today);
  assert.equal(getSourceHealth('ssro').state, 'FALLBACK');
});

test('D/SSRO live quote is not stitched onto history that ends before yesterday', async (t) => {
  resetHealth();
  const holder = { state: {} };
  installModuleMocks(t, {
    [HTTP]: { fetchWithTimeout: ssroHttp(holder) },
    [SPOT]: {
      fetchSpotDailyCloses: async () => ({
        venue: 'TestVenue', quote: 'USDT',
        series: { BTC: dailyRows(40, 50000).slice(0, 35) },
        errors: [], partial: false, coverageStart: iso(Date.now() - 40 * 86400000)
      })
    }
  });
  const mod = freshRequire('ssro_fetcher.js');
  const r = await mod.getSsroData(true);
  assert.equal(r.points.length, 34, 'no live point across a multi-day gap');
  assert.ok(r.points[33].date < iso(Date.now() - 86400000));
});
