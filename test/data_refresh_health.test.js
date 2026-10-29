const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server');
const health = require(path.join(SERVER, 'data_health.js'));

function stubModule(rel, exportsObj) {
  const resolved = require.resolve(path.join(SERVER, rel));
  const m = new Module(resolved, null);
  m.filename = resolved;
  m.loaded = true;
  m.exports = exportsObj;
  require.cache[resolved] = m;
}

const NOW = Date.now();
// 磁盘归档的日期相对 NOW 计算：写死日期会在超过 ARCHIVE 策略的 3 天 dataWarn 后把 FALLBACK 变成 STALE
const ARCHIVE_DATE = new Date(NOW - 86400000).toISOString().slice(0, 10);
const TRADE = {
  trade_id: 't1', instrument_name: 'BTC-26DEC26-100000-C',
  direction: 'buy', amount: 5, price: 0.02, index_price: 80000, timestamp: NOW
};
const SMILE_MONTH = {
  underlying_price: 80000, underlying_index: 'BTC-26DEC26',
  iv_list: [{ strike: 70000, iv: 55 }, { strike: 80000, iv: 50 }, { strike: 90000, iv: 55 }]
};

function goodRoutes() {
  return {
    blockTrades: { code: 0, data: [TRADE] },
    atm: { code: 200, data: [{ underlying_index: 'BTC-26DEC26', underlying_price: 80000, atm_index: 0, list: [{ iv: 50, strike: 80000 }] }] },
    gex: { code: 200, data: { index_price: 80000, ts: NOW, by_expiry: { '26DEC26': [{ strike: 80000, number: 1.5 }] } } },
    ivHistory: { code: 200, data: [{ created_at: NOW, month1: 50, month3: 48, month6: 45 }] },
    skew: { code: 200, data: [{ timestamps: NOW, days30: 0.5 }] },
    smile: { code: 200, data: { month1: SMILE_MONTH, month3: SMILE_MONTH } },
    dvol: { result: { data: [[NOW - 86400000, 0, 0, 0, 50], [NOW, 0, 0, 0, 52]] } },
    perp: { result: { ticks: [], close: [] } }
  };
}

const KEY_FOR = [
  ['/block_trade', 'blockTrades'],
  ['datalab/atm_data', 'atm'],
  ['datalab/gex', 'gex'],
  ['datalab/iv_history', 'ivHistory'],
  ['datalab/skew_chart', 'skew'],
  ['datalab/iv_skew_month', 'smile'],
  ['get_volatility_index_data', 'dvol'],
  ['get_tradingview_chart_data', 'perp']
];

/**
 * Build a data_fetcher with all network/storage dependencies stubbed.
 * `shared` is read live at call time so tests can flip routes mid-scenario.
 */
function loadFetcher(shared = {}) {
  const s = Object.assign({ routes: goodRoutes(), goldMode: 'fresh', tpMode: 'live', calls: 0, dvolCalls: 0 }, shared);
  stubModule('http_client.js', {
    fetchWithTimeout: async (url) => {
      s.calls++;
      if (url.includes('get_volatility_index_data')) s.dvolCalls++;
      const hit = KEY_FOR.find(([frag]) => url.includes(frag));
      if (!hit) throw new Error(`unexpected url: ${url}`);
      const v = s.routes[hit[1]];
      if (v === 'fail') throw new Error(`offline: ${hit[1]}`);
      if (v instanceof Error) throw v;
      return { ok: true, status: 200, json: async () => v };
    },
    fetchBinanceSpot: async () => { throw new Error('offline'); }
  });
  stubModule('trade_store.js', {
    recordAndMergeTrades: (cur, rows) => ({ trades: rows.slice(), stats: { newAddedCount: 0 } }),
    getCachedTrades: () => [],
    filterTradesByWindow: () => []
  });
  // Phase 2 moved health recording into the leaf fetchers — the stubs must
  // emulate the real leaves' registry writes for data_fetcher's classifier.
  stubModule('term_premium_engine.js', {
    analyzeTermPremium: async () => {
      if (s.tpMode === 'fail') {
        health.recordFailure('basis_live', new Error('term premium offline'));
        throw new Error('term premium offline');
      }
      if (s.tpMode === 'live') {
        health.recordSuccess('basis_live', { dataAsOf: new Date().toISOString(), asOfKind: 'source', source: 'test-deribit' });
      } else {
        health.recordFailure('basis_live', new Error('curve stale'));
      }
      // Real basis_fetcher seeds the archive from disk: FALLBACK, never OK.
      health.seedSource('basis_history', {
        dataAsOf: ARCHIVE_DATE,
        lastSuccessAt: new Date(Date.now() - 60000).toISOString(),
        source: 'disk'
      });
      return {
        metadata: { feed: { liveOk: s.tpMode === 'live', liveError: s.tpMode === 'stale' ? 'curve stale' : null } },
        current: { timestamp: Date.now(), date: new Date().toISOString().slice(0, 10) },
        series: [{ date: ARCHIVE_DATE }]
      };
    }
  });
  stubModule('gold_fetcher.js', {
    getGoldCorrelationData: async () => {
      if (s.goldMode === 'fail') {
        health.recordFailure('gold', new Error('gold offline'));
        throw new Error('gold offline');
      }
      if (s.goldMode === 'fresh') {
        health.recordSuccess('gold', { dataAsOf: new Date(NOW).toISOString(), asOfKind: 'source', source: 'test-venue' });
      }
      // 'cached': a pure cache hit — the real leaf records nothing new.
      const updatedAt = s.goldMode === 'cached' ? new Date(Date.now() - 3600000).toISOString() : new Date().toISOString();
      return { updatedAt, metadata: { venue: 'binance' }, series: [{ timestamp: NOW }] };
    }
  });
  const resolved = require.resolve(path.join(SERVER, 'data_fetcher.js'));
  delete require.cache[resolved];
  return { df: require(resolved), shared: s };
}

test.beforeEach(() => health.resetHealthForTests());

test('all sources fail twice: no readiness text, no version bump, no lastDataChangeTime', async () => {
  const { df, shared } = loadFetcher({
    routes: Object.fromEntries(Object.keys(goodRoutes()).map(k => [k, 'fail'])),
    goldMode: 'fail',
    tpMode: 'fail'
  });
  const r1 = await df.refreshAllMarketData('BTC');
  assert.equal(r1.hasAnyUpdate, false);
  assert.equal(r1.dataVersion, 1);
  assert.doesNotMatch(r1.summary, /已就绪|已校验/);
  assert.match(r1.summary, /失败|不可用/);
  assert.equal(r1.dataHealth.state, 'UNAVAILABLE');
  assert.equal(r1.dataHealth.analysisAllowed, false);
  assert.ok(r1.failedSources.length >= 8);

  const c1 = df.getCachedData();
  assert.equal(c1.lastDataChangeTime, null);
  assert.equal(c1.lastSuccessAt, null);
  assert.equal(c1.gex, null);
  assert.equal(c1.atmData, null);
  assert.ok(c1.lastSyncCheckTime, 'attempt time is still recorded');
  for (const id of ['greeks_trades', 'greeks_atm', 'greeks_gex']) {
    assert.equal(health.getSourceHealth(id).state, 'UNAVAILABLE', id);
  }

  const r2 = await df.refreshAllMarketData('BTC');
  assert.equal(r2.hasAnyUpdate, false);
  assert.equal(r2.dataVersion, 1, 'still no version bump without valid data');
  assert.equal(df.getCachedData().lastDataChangeTime, null);
  assert.doesNotMatch(r2.summary, /所有数据源已校验|已就绪/);
});

test('empty block-trades array is a legitimate confirmed poll (received asOf)', async () => {
  const { df } = loadFetcher({ routes: { ...goodRoutes(), blockTrades: { code: 0, data: [] } } });
  const r = await df.refreshAllMarketData('BTC');
  assert.ok(r.succeededSources.includes('greeks_trades'));
  const h = health.getSourceHealth('greeks_trades');
  assert.equal(h.state, 'OK');
  assert.equal(h.asOfKind, 'received');
});

test('one failure: that source keeps last-good cache, others succeed; batch not fully successful', async () => {
  const { df } = loadFetcher({ routes: { ...goodRoutes(), atm: 'fail' } });
  const r = await df.refreshAllMarketData('BTC');
  assert.ok(r.failedSources.includes('greeks_atm'));
  assert.ok(r.succeededSources.includes('greeks_gex'));
  const c = df.getCachedData();
  assert.equal(c.atmData, null, 'failed source leaves cache empty, not wiped');
  assert.ok(c.gex && c.gex.index_price === 80000);
  assert.equal(c.lastSuccessAt, null, 'lastSuccessAt only when ALL required Greeks succeed');
  assert.equal(r.dataHealth.state, 'DEGRADED');
  assert.match(r.summary, /部分降级/);
});

test('malformed payloads are source failures and never reach the cache', async () => {
  const { df } = loadFetcher({
    routes: {
      ...goodRoutes(),
      blockTrades: { code: 0, data: [{ instrument_name: 'X', direction: 'hold', amount: -1, price: -1, index_price: 0, timestamp: 'bad' }] },
      gex: { code: 200, data: { index_price: -5, ts: NOW, by_expiry: {} } },
      smile: { code: 200, data: null }
    }
  });
  const r = await df.refreshAllMarketData('BTC');
  for (const id of ['greeks_trades', 'greeks_gex', 'greeks_smile']) {
    assert.ok(r.failedSources.includes(id), `${id} should have failed validation`);
  }
  const c = df.getCachedData();
  assert.deepEqual(c.blockTrades, []);
  assert.equal(c.gex, null);
  assert.equal(c.ivSkewMonth, null);
});

test('missing envelope field is a failure, not an empty success', async () => {
  const { df } = loadFetcher({ routes: { ...goodRoutes(), blockTrades: { code: 0 } } });
  const r = await df.refreshAllMarketData('BTC');
  assert.ok(r.failedSources.includes('greeks_trades'));
});

test('good then bad refresh: cache kept byte-identical, clocks never promoted', async () => {
  const { df, shared } = loadFetcher();
  const r1 = await df.refreshAllMarketData('BTC');
  assert.equal(r1.hasAnyUpdate, true, 'first valid arrival triggers initial load');
  const c1 = df.getCachedData();
  const snap = {
    gex: JSON.stringify(c1.gex),
    atmData: JSON.stringify(c1.atmData),
    blockTrades: JSON.stringify(c1.blockTrades),
    ivHistory: JSON.stringify(c1.ivHistory)
  };
  const changeTime1 = c1.lastDataChangeTime;
  const success1 = c1.lastSuccessAt;
  assert.ok(success1, 'all required Greeks succeeded -> batch success time set');
  const v1 = c1.dataVersion;

  shared.routes = Object.fromEntries(Object.keys(goodRoutes()).map(k => [k, 'fail']));
  shared.goldMode = 'fail';
  shared.tpMode = 'fail';
  df._internal.expireDvolReuse(); // DVOL is reused for 10 min; force a real round
  const r2 = await df.refreshAllMarketData('BTC');
  assert.equal(r2.hasAnyUpdate, false);
  const c2 = df.getCachedData();
  assert.equal(JSON.stringify(c2.gex), snap.gex);
  assert.equal(JSON.stringify(c2.atmData), snap.atmData);
  assert.equal(JSON.stringify(c2.blockTrades), snap.blockTrades);
  assert.equal(JSON.stringify(c2.ivHistory), snap.ivHistory);
  assert.equal(c2.lastDataChangeTime, changeTime1, 'failure must not promote the change clock');
  assert.equal(c2.lastSuccessAt, success1, 'failure must not promote lastSuccessAt');
  assert.equal(c2.dataVersion, v1);
  // Just-failed sources still hold fresh last-good data -> FALLBACK (usable):
  // listed as failed but NOT blocked; aggregate is DEGRADED, not UNAVAILABLE.
  assert.equal(r2.dataHealth.state, 'DEGRADED');
  for (const id of ['greeks_trades', 'greeks_atm', 'greeks_gex', 'greeks_iv_history', 'greeks_skew', 'greeks_smile', 'deribit_dvol', 'gold']) {
    assert.ok(r2.dataHealth.failedSources.includes(id), `${id} failed this round`);
    assert.equal(r2.dataHealth.sources[id].state, 'FALLBACK', `${id} serves last-good within its window`);
  }
  assert.deepEqual(r2.dataHealth.blockedSources, []);
  assert.ok(r2.dataHealth.sources.basis_history.usable, 'disk archive stays usable within its window');
});

test('DVOL stats are reused inside the 10-minute window: no refetch, no failure, batch success still advances', async () => {
  const { df, shared } = loadFetcher();
  await df.refreshAllMarketData('BTC');
  const callsAfterFirst = shared.dvolCalls;
  const r2 = await df.refreshAllMarketData('BTC');
  assert.ok(!r2.dataHealth.failedSources.includes('deribit_dvol'));
  assert.equal(r2.dataHealth.sources.deribit_dvol.state, 'OK');
  assert.ok(callsAfterFirst > 0, 'first round fetched DVOL');
  assert.equal(shared.dvolCalls, callsAfterFirst, 'no DVOL refetch inside the window');
  assert.ok(df.getCachedData().lastSuccessAt, 'batch success time is set');
});

test('recovery: source returns to OK and error cleared after a failed round', async () => {
  const { df, shared } = loadFetcher({ routes: { ...goodRoutes(), gex: 'fail' } });
  await df.refreshAllMarketData('BTC');
  let h = health.getSourceHealth('greeks_gex');
  assert.equal(h.state, 'UNAVAILABLE');
  assert.equal(h.consecutiveFailures, 1);
  shared.routes = goodRoutes();
  await df.refreshAllMarketData('BTC');
  h = health.getSourceHealth('greeks_gex');
  assert.equal(h.state, 'OK');
  assert.equal(h.lastError, null);
  assert.equal(h.consecutiveFailures, 0);
});

test('single-flight: concurrent refreshes share one upstream round', async () => {
  const { df, shared } = loadFetcher();
  const [a, b] = await Promise.all([df.refreshAllMarketData('BTC'), df.refreshAllMarketData('BTC')]);
  // 8 个数据源各一次 + DVOL 小时线一次 (做市商过去 24 小时已触发对冲流)
  assert.equal(shared.calls, 9, 'one upstream call per source for two concurrent refreshes');
  assert.equal(a, b, 'single-flight returns the same in-flight promise');
});

test('gold cache hit is unverified, never recorded as fresh success', async () => {
  const { df, shared } = loadFetcher();
  shared.goldMode = 'cached';
  const r = await df.refreshAllMarketData('BTC');
  assert.ok(r.unverifiedSources.includes('gold'));
  assert.equal(health.getSourceHealth('gold').state, 'UNKNOWN', 'no verifiable timestamp -> UNKNOWN not green');
});

test('basis live feed flags are honored instead of claiming success', async () => {
  const { df, shared } = loadFetcher();
  shared.tpMode = 'stale'; // liveOk=false with liveError
  const r = await df.refreshAllMarketData('BTC');
  assert.ok(r.failedSources.includes('basis_live'));
  const h = health.getSourceHealth('basis_history');
  assert.equal(h.state, 'FALLBACK', 'history file is disk-sourced, never OK-green');
});

test('same-ms rounds: a wholly failing second round must not promote any clock', async () => {
  const { df, shared } = loadFetcher();
  const realNow = Date.now;
  const M = realNow(); // one real-ish millisecond, frozen for BOTH rounds
  Date.now = () => M;
  try {
    const r1 = await df.refreshAllMarketData('BTC');
    assert.equal(r1.hasAnyUpdate, true);
    const c1 = df.getCachedData();
    assert.ok(c1.lastSuccessAt, 'first valid round produces a batch success clock');
    // Round-1 receipts were stamped at the frozen attempt millisecond — the
    // exact identical-ms scenario: receipt ms === the second round's attempt ms.
    const h1 = health.getSourceHealth('greeks_atm');
    assert.equal(new Date(h1.lastSuccessAt).getTime(), M,
      'receipt equals the shared attempt ms (>= comparison cannot distinguish rounds)');

    // Real wall-clock delay: a wrongful advance writes a different completion ISO.
    await new Promise(r => setTimeout(r, 30));

    shared.routes = Object.fromEntries(Object.keys(goodRoutes()).map(k => [k, 'fail']));
    shared.goldMode = 'fail';
    shared.tpMode = 'fail';
    const r2 = await df.refreshAllMarketData('BTC');
    const c2 = df.getCachedData();
    assert.equal(r2.hasAnyUpdate, false);
    assert.equal(c2.lastSuccessAt, c1.lastSuccessAt,
      'all-failed round must not promote lastSuccessAt (old >= comparison fails here)');
    assert.equal(c2.lastDataChangeTime, c1.lastDataChangeTime, 'failure must not promote the change clock');
    assert.equal(c2.dataVersion, c1.dataVersion, 'failure must not bump dataVersion');
    assert.ok(!r2.summary.includes('全部成功'), 'never claims all-verified on a failing round');
    assert.equal(r2.dataHealth.state, 'DEGRADED');
  } finally {
    Date.now = realNow;
  }
});
