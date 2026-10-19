/**
 * Flow Force resilience tests — fully offline.
 *
 * binance_feed / tradingview_feed / http_client are stubbed through
 * installModuleMocks; the archive store is redirected via
 * FLOW_FORCE_STORE_DIR to a per-test temp dir (module reads the env var at
 * load time, so it is set before freshRequire). No real sockets/HTTP ever run.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installModuleMocks, srv, freshRequire, resetHealth, fakeResp } = require('./helpers/leaf_env');
const { getSourceHealth } = require('../server/data_health');

const TF = '1h';
const STEP = 3600e3;
const alignNow = () => Math.floor(Date.now() / STEP) * STEP;
const iso = ms => new Date(ms).toISOString();

/** Strictly increasing schema-valid bars ending at endT (ms, aligned). */
function bars(n, endT, { step = STEP, price = 50000, vol = 2e6 } = {}) {
  const d = price * 0.001; // price-scaled wick so small-price feeds (USDT/USD) stay positive
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const t = endT - i * step;
    const o = price, c = price + d;
    out.push({ t, o, h: c + d, l: o - d, c, v: vol });
  }
  return out;
}

/**
 * Mutable fetch state shared by every stub. `fail` holds venue keys whose
 * fetch must throw; `cbRows`/`tvRows` override the Coinbase/TV payloads so a
 * malformed batch can be injected.
 */
function defaultState() {
  const end = alignNow();
  return {
    fail: new Set(),
    bnBars: bars(310, end),
    okxBars: bars(310, end),
    hlBars: bars(310, end),
    cbRows: null,   // raw Coinbase rows override
    cbBars: bars(310, end),
    fxBars: bars(310, end, { price: 1.0001, vol: 1e6 }),
    tvRows: null    // TradingView rows override
  };
}

const okxRows = bs => bs.map(b => [b.t, b.o, b.h, b.l, b.c, '1', '1', b.v]).reverse();
const cbRows = bs => bs.map(b => [Math.floor(b.t / 1000), b.l, b.h, b.o, b.c, 1]).reverse();

function httpStub(S) {
  return async (url) => {
    if (url.includes('/api/v5/market/candles')) {
      if (S.fail.has('okx')) throw new Error('okx down');
      return fakeResp({ code: '0', data: okxRows(S.okxBars) });
    }
    if (url.includes('hyperliquid')) {
      if (S.fail.has('hl')) throw new Error('hl down');
      return fakeResp(S.hlBars.map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: 5 })));
    }
    if (url.includes('products/USDT-USD/candles')) {
      if (S.fail.has('fx')) throw new Error('fx down');
      return fakeResp(cbRows(S.fxBars));
    }
    if (url.includes('products/BTC-USD/candles')) {
      if (S.fail.has('cb')) throw new Error('cb down');
      return fakeResp(S.cbRows || cbRows(S.cbBars));
    }
    // Order-book / ticker / audit endpoints: unavailable in tests.
    throw new Error(`unhandled ${url}`);
  };
}

function binanceStub(S) {
  return {
    ensureStreams() {},
    getStreamBars() {
      if (S.fail.has('stream')) throw new Error('stream broken');
      return [];
    },
    fetchArchiveBars() {
      if (S.fail.has('archive')) throw new Error('archive n/a');
      return [];
    },
    fetchRestBars() {
      if (S.fail.has('bn')) throw new Error('rest down');
      return S.bnBars;
    },
    getStreamStatus() { return { spot: { connected: true }, perp: { connected: true } }; },
    getBinanceJson() { throw new Error('audit n/a'); }
  };
}

function tvStub(S) {
  return {
    async fetchTvBars(symbol) {
      if (S.fail.has('tv')) throw new Error('tv down');
      if (S.tvRows) return S.tvRows;
      const src = symbol === 'COINBASE:USDTUSD' ? S.fxBars : S.okxBars;
      return src.map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, vol: b.v }));
    }
  };
}

function setup(t) {
  resetHealth();
  const S = defaultState();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-store-'));
  const prev = process.env.FLOW_FORCE_STORE_DIR;
  process.env.FLOW_FORCE_STORE_DIR = tmp;
  t.after(() => { if (prev === undefined) delete process.env.FLOW_FORCE_STORE_DIR; else process.env.FLOW_FORCE_STORE_DIR = prev; });
  installModuleMocks(t, {
    [srv('binance_feed.js')]: binanceStub(S),
    [srv('tradingview_feed.js')]: tvStub(S),
    [srv('http_client.js')]: { fetchWithTimeout: httpStub(S) }
  });
  const mod = freshRequire('flow_force.js');
  return { S, mod, tmp };
}

const storeFile = tmp => path.join(tmp, `${TF}.json`);
const agg = () => getSourceHealth(`flow:${TF}`);
const leaf = k => getSourceHealth(`flow:${TF}:${k}`);
// saveStore is a fire-and-forget fs.promises chain — poll for the file before
// asserting on it, and give pending writes a beat to settle.
const waitFile = async p => {
  for (let i = 0; i < 100 && !fs.existsSync(p); i++) await new Promise(r => setTimeout(r, 10));
};
const settle = () => new Promise(r => setTimeout(r, 60));

// ===========================================================================
test('a · all venues + FX succeed: provider clocks, fixed weights, archive/streams fields', async (t) => {
  const { S, mod } = setup(t);
  const r = await mod.getFlowForce(TF, true);

  assert.equal(r.code, 0);
  assert.equal(r.historicalOnly, undefined);
  assert.equal(r.weights, mod.FIXED_WEIGHTS, 'fixed weights object must be served');
  assert.ok(r.archive && Number.isInteger(r.archive.frozenRows), 'archive block served');
  assert.deepEqual(r.streams, { spot: { connected: true }, perp: { connected: true } });
  assert.equal(r.dataHealth.state, 'OK');
  assert.equal(r.premiumMode, 'usd', 'FX coverage must yield real premium');
  assert.equal(r.sources.bnPerp.ok, true, 'current bar present → venue online');

  // Leaf receipts carry the last ACTUAL fetched bar time, not the receipt time.
  const lastT = iso(S.okxBars[S.okxBars.length - 1].t);
  for (const k of ['bnPerp', 'okxPerp', 'hlPerp', 'bnSpot', 'okxSpot', 'usSpot']) {
    assert.equal(leaf(k).dataAsOf, lastT, `${k} dataAsOf`);
    assert.ok(leaf(k).lastSuccessAt, `${k} receipt`);
    assert.equal(leaf(k).lastError, null, `${k} no error`);
  }
  assert.equal(getSourceHealth(`flow:${TF}:fx`).dataAsOf, iso(S.fxBars[S.fxBars.length - 1].t));

  const aggH = agg();
  assert.ok(aggH.lastSuccessAt);
  // Aggregate dataAsOf = MIN(last served series row, all four cellLatest).
  const expectedAsOf = iso(Math.min(r.series[r.series.length - 1].time * 1000, S.okxBars[S.okxBars.length - 1].t));
  assert.equal(aggH.dataAsOf, expectedAsOf);
});

// ===========================================================================
test('b · malformed OHLC / future rows rejected before archive; agg clock + frozen rows preserved', async (t) => {
  const { S, mod, tmp } = setup(t);
  const good = await mod.getFlowForce(TF, true);
  const goodFrozen = good.archive.frozenRows;
  await waitFile(storeFile(tmp)); await settle();
  const goodStore = JSON.parse(fs.readFileSync(storeFile(tmp), 'utf8'));
  const aggSuccessAt = agg().lastSuccessAt;
  const cbSuccessAt = leaf('usSpot').lastSuccessAt;

  // Coinbase returns a NaN-priced row; the TradingView fallback hands back a
  // future-dated bar. Both must fail schema validation, never reach the archive.
  // Mutate the row in place — keeping its own timestamp key so it cannot be
  // overwritten by a valid duplicate inside fetchCoinbase's dedupe Map.
  const bad = cbRows(S.cbBars);
  bad[5][1] = Number.NaN; // low = NaN
  S.cbRows = bad;
  S.tvRows = [{ t: Date.now() + 10 * 60e3, o: 1, h: 2, l: 1, c: 1, vol: 1 }];
  const r = await mod.getFlowForce(TF, true);

  assert.equal(r.historicalOnly, true, 'spotWest cell missing → history-only');
  assert.equal(r.stale, true);
  assert.equal(agg().lastSuccessAt, aggSuccessAt, 'aggregate success clock preserved');
  assert.equal(agg().lastSuccessAt === undefined, false);
  assert.ok(leaf('usSpot').lastError.includes('Coinbase API'), 'direct venue error recorded');
  assert.ok(leaf('usSpot').lastError.includes('TradingView'), 'fallback error recorded');
  assert.equal(leaf('usSpot').lastSuccessAt, cbSuccessAt, 'failed leaf keeps old receipt');
  // Malformed bars never entered the archive: the usSpot section is identical
  // (frozen rows may legitimately grow once a pending row crosses the grace
  // window, so rows are asserted monotone rather than byte-equal).
  await settle();
  const after = JSON.parse(fs.readFileSync(storeFile(tmp), 'utf8'));
  assert.deepEqual(after.bars.usSpot, goodStore.bars.usSpot, 'no usSpot bar may enter the archive');
  assert.ok(after.rows.length >= goodStore.rows.length && after.rows.length >= goodFrozen,
    'frozen rows are never dropped');
});

// ===========================================================================
test('c · every fetch path fails after a success: last-good payload and clocks kept', async (t) => {
  const { S, mod } = setup(t);
  const good = await mod.getFlowForce(TF, true);
  const aggSuccessAt = agg().lastSuccessAt;
  const okxSuccessAt = leaf('okxPerp').lastSuccessAt;

  for (const k of ['bn', 'archive', 'stream', 'okx', 'hl', 'cb', 'fx', 'tv']) S.fail.add(k);
  const r = await mod.getFlowForce(TF, true);

  assert.equal(r.historicalOnly, true);
  assert.equal(r.stale, true);
  assert.equal(r.updatedAt, good.updatedAt, 'served payload is the last-good one');
  assert.equal(r.series.length, good.series.length);
  assert.equal(agg().lastSuccessAt, aggSuccessAt, 'aggregate clock not rejuvenated');
  assert.equal(leaf('okxPerp').lastSuccessAt, okxSuccessAt, 'leaf clock preserved');
  assert.ok(agg().lastError, 'aggregate failure recorded');
  assert.notEqual(r.dataHealth.state, 'OK');
});

// ===========================================================================
test('d · one missing cell cannot advance the aggregate while siblings keep fetching', async (t) => {
  const { S, mod } = setup(t);
  await mod.getFlowForce(TF, true);
  const aggBase = { lastSuccessAt: agg().lastSuccessAt, dataAsOf: agg().dataAsOf };
  const okxBase = { lastSuccessAt: leaf('okxPerp').lastSuccessAt, dataAsOf: leaf('okxPerp').dataAsOf };
  const usBase = leaf('usSpot').lastSuccessAt;
  assert.ok(aggBase.lastSuccessAt && okxBase.lastSuccessAt && usBase);

  S.fail.add('cb'); S.fail.add('tv'); // usSpot (single-member spotWest cell) dies

  // Advance the wall clock one full step: sibling venues now serve genuinely
  // newer bars, so their receipts/dataAsOf must really advance while the
  // aggregate's success clocks stay pinned to the accepted baseline.
  const realNow = Date.now;
  const end2 = alignNow() + STEP;
  Date.now = () => end2;
  try {
    S.bnBars = bars(310, end2);
    S.okxBars = bars(310, end2);
    S.hlBars = bars(310, end2);
    S.fxBars = bars(310, end2, { price: 1.0001, vol: 1e6 });
    const r = await mod.getFlowForce(TF, true);

    assert.equal(r.historicalOnly, true);
    assert.equal(agg().lastSuccessAt, aggBase.lastSuccessAt, 'newer sibling receipts must not advance the aggregate');
    assert.equal(agg().dataAsOf, aggBase.dataAsOf, 'aggregate data clock stays at the accepted baseline');

    const okxH = leaf('okxPerp');
    assert.ok(okxH.lastSuccessAt > okxBase.lastSuccessAt, 'sibling receipt genuinely advanced this run');
    assert.ok(okxH.dataAsOf > okxBase.dataAsOf, 'sibling data clock advanced to the newer fetched bars');
    // The failed leaf keeps its old receipt; no fabricated success.
    assert.equal(leaf('usSpot').lastSuccessAt, usBase);
    assert.ok(leaf('usSpot').lastError);
  } finally {
    Date.now = realNow;
  }
});

// ===========================================================================
test('e · cold disk-only archive: historicalOnly, no fabricated success', async (t) => {
  const { S, mod, tmp } = setup(t);
  await mod.getFlowForce(TF, true);               // seed the archive store
  await waitFile(storeFile(tmp)); await settle();
  assert.ok(fs.existsSync(storeFile(tmp)), 'store persisted');

  resetHealth();
  const cold = freshRequire('flow_force.js');      // drops in-memory store/cache
  for (const k of ['bn', 'archive', 'stream', 'okx', 'hl', 'cb', 'fx', 'tv']) S.fail.add(k);
  const r = await cold.getFlowForce(TF, true);

  assert.equal(r.historicalOnly, true);
  assert.ok(r.series.length > 0, 'disk history still served');
  assert.ok(r.archive.frozenRows > 0, 'frozen rows survive the cold start');
  assert.equal(agg().lastSuccessAt, null, 'no aggregate success may be fabricated');
  assert.equal(leaf('usSpot').lastSuccessAt, null, 'no leaf success may be fabricated');
  assert.notEqual(r.dataHealth.state, 'OK');
});

// ===========================================================================
test('f · FX dataAsOf is the last actual FX bar; a stale FX is never renewed to now', async (t) => {
  const { S, mod } = setup(t);
  // FX feed lags 3 hours behind the venues.
  const fxEnd = alignNow() - 3 * STEP;
  S.fxBars = bars(310, fxEnd, { price: 1.0001 });
  const r1 = await mod.getFlowForce(TF, true);

  const fxH = getSourceHealth(`flow:${TF}:fx`);
  assert.equal(fxH.dataAsOf, iso(fxEnd), 'FX clock = last actual FX bar, not server time');
  assert.ok(fxH.lastSuccessAt);
  assert.equal(r1.code, 0);

  // FX now fails entirely (both Coinbase and the TV fallback): the old
  // receipt/dataAsOf must be preserved, never refreshed to "now".
  S.fail.add('fx'); S.fail.add('tv');
  await mod.getFlowForce(TF, true);
  const fxH2 = getSourceHealth(`flow:${TF}:fx`);
  assert.equal(fxH2.dataAsOf, iso(fxEnd), 'failed FX refresh keeps the old data clock');
  assert.equal(fxH2.lastSuccessAt, fxH.lastSuccessAt);
  assert.ok(fxH2.lastError);
});
