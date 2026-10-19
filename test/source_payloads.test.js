/**
 * Source payload validation tests — offline, mocked HTTP payloads + temp fs.
 *
 * Covers E (macro FRED/aggregate), F (preferreds), H (ETF linkage), J
 * (McClellan artifact) plus spot_daily venue fallback on malformed rows.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { installModuleMocks, srv, freshRequire, resetHealth, fakeResp } = require('./helpers/leaf_env');
const { getSourceHealth } = require('../server/data_health');

const HTTP = srv('http_client.js');
const MACRO = srv('macro_fetcher.js');
const CHILD = 'child_process';

const nowSec = () => Math.floor(Date.now() / 1000);
const iso = d => new Date(d).toISOString().slice(0, 10);
const daysAgo = n => iso(Date.now() - n * 86400000);

function diskBytes(file) {
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

function fredCsv(id, rows) {
  return `DATE,${id}\n` + rows.map(([d, v]) => `${d},${v}`).join('\n') + '\n';
}

/** Encrypted Coinglass fixture: ne() = AES-128-ECB → hex → gunzip. */
function cgEnc(str, keyUtf8) {
  const hex = zlib.gzipSync(str).toString('hex');
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(keyUtf8, 'utf8'), null);
  return Buffer.concat([cipher.update(Buffer.from(hex, 'hex')), cipher.final()]).toString('base64');
}

// ===========================================================================
// E · macro — FRED leaf (exported fetchFredSeries)
// ===========================================================================

function macroHttp(holder) {
  const key2 = '0123456789abcdef';
  return async (url, opts = {}) => {
    const s = holder.state;
    if (s.fail) return fakeResp({}, { ok: false, status: 503 });
    if (url.includes('fredgraph.csv')) {
      const id = new URL(url).searchParams.get('id');
      const csv = (s.fredCsv && s.fredCsv[id]) || holder.fredCsvs?.[id]
        || fredCsv(id, [[daysAgo(2), '4.0'], [daysAgo(1), '4.1'], [daysAgo(0), '.']]);
      return fakeResp(csv);
    }
    if (url.includes('klines') || url.includes('binance')) {
      const rows = Array.from({ length: 30 }, (_, i) => [
        Date.now() - (29 - i) * 86400000, '50000', '51000', '49000', String(50000 + i), '10', 0, '0', 0, '0', '0', '0'
      ]);
      return fakeResp(s.btcKlines ?? rows);
    }
    if (url.includes('finance.yahoo.com')) {
      const ts = Array.from({ length: 30 }, (_, i) => nowSec() - (29 - i) * 86400);
      return fakeResp({
        chart: { result: [{ timestamp: ts, indicators: { quote: [{ close: ts.map((_, i) => 300 + i) }] } }] }
      });
    }
    if (url.includes('microStrategyCostV2')) {
      const key1 = Buffer.from(String(opts.headers?.['cache-ts-v2'] || '0')).toString('base64').slice(0, 16);
      const list = [{ timestamp: Date.now() - 86400000, microStrategyCost: 70000, totalBitcoin: 500000 }];
      return fakeResp(
        { code: '0', data: cgEnc(JSON.stringify(list), key2) },
        { headers: { 'v': '0', 'user': cgEnc(key2, key1) } }
      );
    }
    if (url.includes('macro_chart.json')) {
      return fakeResp(s.remoteSnapshot ?? {}, { ok: false, status: 404 });
    }
    throw new Error('unexpected url ' + url);
  };
}

test('E/macro FRED leaf: valid CSV, gap rows skipped, malformed/future/non-ascending fail', async (t) => {
  resetHealth();
  const holder = { state: {} };
  installModuleMocks(t, { [HTTP]: { fetchWithTimeout: macroHttp(holder) } });
  const mod = freshRequire('macro_fetcher.js');

  // Good: '.' gap skipped, dataAsOf = last real observation
  let map = await mod.fetchFredSeries('DGS1');
  assert.equal(map.size, 2);
  assert.equal(getSourceHealth('fred:DGS1').state, 'OK');
  assert.equal(getSourceHealth('fred:DGS1').dataAsOf.slice(0, 10), daysAgo(1));

  // Non-numeric garbage rejected (not parseFloat-swallowed)
  holder.state = { fredCsv: { DGS1: fredCsv('DGS1', [[daysAgo(1), 'abc']]) } };
  map = await mod.fetchFredSeries('DGS1');
  assert.equal(map.size, 0);
  assert.notEqual(getSourceHealth('fred:DGS1').state, 'OK');
  assert.match(getSourceHealth('fred:DGS1').lastError || '', /non-numeric/);

  // Future date rejected
  holder.state = { fredCsv: { DGS1: fredCsv('DGS1', [[iso(Date.now() + 86400000), '4.0']]) } };
  map = await mod.fetchFredSeries('DGS1');
  assert.equal(map.size, 0);
  assert.match(getSourceHealth('fred:DGS1').lastError || '', /future/);

  // Non-ascending rejected
  holder.state = { fredCsv: { DGS1: fredCsv('DGS1', [[daysAgo(1), '4.0'], [daysAgo(2), '4.1']]) } };
  map = await mod.fetchFredSeries('DGS1');
  assert.equal(map.size, 0);
  assert.match(getSourceHealth('fred:DGS1').lastError || '', /non-ascending/);

  // Missing series column rejected
  holder.state = { fredCsv: { DGS1: 'DATE,WRONG\n' + daysAgo(1) + ',4.0\n' } };
  map = await mod.fetchFredSeries('DGS1');
  assert.equal(map.size, 0);
  assert.match(getSourceHealth('fred:DGS1').lastError || '', /header/);

  // Recovery
  holder.state = {};
  map = await mod.fetchFredSeries('DGS1');
  assert.equal(map.size, 2);
  assert.equal(getSourceHealth('fred:DGS1').state, 'OK');
});

test('E/macro aggregate: full mock build → OK-ish health; failed FRED leg degrades with fallback issues', async (t) => {
  resetHealth();
  const holder = { state: {} };
  installModuleMocks(t, {
    [HTTP]: { fetchWithTimeout: macroHttp(holder), fetchBinanceSpot: macroHttp(holder) },
    [CHILD]: { exec: () => {}, execSync: () => { throw new Error('no python'); } },
    https: {
      get: () => {
        const req = { on(ev, fn) { if (ev === 'error') process.nextTick(() => fn(new Error('offline'))); return this; }, setTimeout() {} };
        return req;
      }
    }
  });
  const mod = freshRequire('macro_fetcher.js');

  const r1 = await mod.getMacroChartData(true);
  assert.ok(Array.isArray(r1.points) && r1.points.length > 0);
  assert.equal(getSourceHealth('macro_btc').state, 'OK');
  assert.equal(getSourceHealth('yahoo:MSTR').state, 'OK');
  assert.equal(getSourceHealth('mstr_cost').state, 'OK');
  // bitcointreasuries via https is offline in tests → ancillary failure only
  assert.equal(getSourceHealth('mstr_treasury').state !== 'OK', true);
  assert.ok(['DEGRADED', 'OK'].includes(r1.dataHealth.state));

  // FRED leg fails: dataset still builds (fallback restore), health reports it
  holder.state = { fredCsv: { DGS1: 'DATE,WRONG\n2020-01-01,4.0\n' } };
  const mod2 = freshRequire('macro_fetcher.js');
  const r2 = await mod2.getMacroChartData(true);
  assert.ok(r2.points.length > 0);
  assert.notEqual(getSourceHealth('fred:DGS1').state, 'OK');
  assert.notEqual(r2.dataHealth.state, 'OK');
});

// ===========================================================================
// F · preferreds — Yahoo STRC/STRF/STRD + FRED DGS1MO
// ===========================================================================

function yahooChart(sym, closes, opts = {}) {
  const ts = closes.map((_, i) => nowSec() - (closes.length - 1 - i) * 86400);
  return {
    chart: {
      result: [{
        timestamp: ts,
        indicators: {
          quote: [{
            close: closes,
            high: closes.map(c => opts.badHigh ? -1 : c + 0.5),
            low: closes.map(c => c - 0.5),
            volume: closes.map(() => 1000)
          }]
        }
      }]
    }
  };
}

function prefHttp(holder) {
  return async (url) => {
    const s = holder.state;
    if (url.includes('fredgraph.csv')) {
      return fakeResp(fredCsv('DGS1MO', [[daysAgo(2), '5.3'], [daysAgo(1), '5.32']]));
    }
    const m = url.match(/chart\/(\w+)/);
    if (m && s[m[1]] !== undefined) {
      if (s[m[1]] === null) return fakeResp({}, { ok: false, status: 503 });
      return fakeResp(s[m[1]]);
    }
    if (m) return fakeResp(yahooChart(m[1], Array.from({ length: 30 }, (_, i) => 99 + Math.sin(i) * 0.5 + i * 0.01)));
    throw new Error('unexpected url ' + url);
  };
}

test('F/preferreds: good → STRC malformed fails whole build → all-fail fallback → recovery', async (t) => {
  resetHealth();
  const holder = { state: {} };
  const { tmpDir } = installModuleMocks(t, { [HTTP]: { fetchWithTimeout: prefHttp(holder) } });
  const mod = freshRequire('mstr_preferreds.js');
  const cacheFile = path.join(tmpDir, 'mstr_preferreds_cache.json');

  const r1 = await mod.getPreferredsData(true);
  assert.ok(r1.summary.asOf);
  assert.equal(r1.summary.strcRateConfigured, false); // no config → honest flag, not fabricated rates
  const goodBytes = diskBytes(cacheFile);
  assert.ok(goodBytes?.length > 0);

  // STRC malformed (close 0) → build fails, last-good served, disk untouched
  holder.state = { STRC: yahooChart('STRC', [99.5, 0, 99.6]) };
  const r2 = await mod.getPreferredsData(true);
  assert.ok(r2.summary.asOf);
  assert.notEqual(r2.dataHealth.state, 'OK');
  assert.deepEqual(diskBytes(cacheFile), goodBytes);
  assert.match(getSourceHealth('yahoo:STRC').lastError || '', /invalid close/);

  // All legs fail → fallback still serves the valid copy
  holder.state = { STRC: null, STRF: null, STRD: null };
  const r3 = await mod.getPreferredsData(true);
  assert.ok(r3.summary.asOf);
  assert.notEqual(r3.dataHealth.state, 'OK');
  assert.deepEqual(diskBytes(cacheFile), goodBytes);

  // STRF dead → the COMPLETE prior payload is served verbatim (never a
  // half-empty rebuild overwriting valid legs), the file stays byte-identical,
  // and the leg's failure stays visible in health.
  holder.state = { STRF: null };
  const r4 = await mod.getPreferredsData(true);
  assert.equal(r4.summary.asOf, r3.summary.asOf, 'prior payload served verbatim');
  assert.deepEqual(diskBytes(cacheFile), goodBytes, 'a failed leg never overwrites the good file');
  assert.notEqual(getSourceHealth('yahoo:STRF').state, 'OK');
  assert.ok(getSourceHealth('yahoo:STRF').lastError);
  assert.notEqual(r4.dataHealth.state, 'OK');

  // Full recovery → fresh build resumes and rewrites the file
  holder.state = {};
  const r5 = await mod.getPreferredsData(true);
  assert.equal(r5.dataHealth.state, 'OK');
  assert.equal(getSourceHealth('preferreds').lastError, null);
  assert.notDeepEqual(diskBytes(cacheFile), goodBytes);
});

// ===========================================================================
// H · ETF linkage — flows + CFTC COT + OI panel
// ===========================================================================

const TUESDAYS = (() => {
  const out = [];
  let t = Date.now() - 30 * 86400000;
  while (out.length < 4) {
    const d = new Date(t);
    if (d.getUTCDay() === 2) out.push(iso(t));
    t += 86400000;
  }
  return out;
})();

function cotRow(code, date) {
  return {
    report_date_as_yyyy_mm_dd: date,
    cftc_contract_market_code: code,
    open_interest_all: '1000',
    lev_money_positions_long: '100',
    lev_money_positions_short: '200',
    asset_mgr_positions_long: '300',
    asset_mgr_positions_short: '50',
    dealer_positions_long_all: '60',
    dealer_positions_short_all: '70'
  };
}

function cftcPayload({ dropContract = null, dropField = null, dates = TUESDAYS } = {}) {
  const rows = [];
  for (const d of dates) {
    for (const code of ['133741', '133742']) {
      if (code === dropContract && d === dates[dates.length - 1]) continue;
      const r = cotRow(code, d);
      if (dropField) delete r[dropField];
      rows.push(r);
    }
  }
  return rows;
}

function etfFlowRows() {
  // flows inside each COT week window + pending days after the last Tuesday
  const rows = [];
  for (let i = 1; i < TUESDAYS.length; i++) {
    rows.push({ date: Date.parse(TUESDAYS[i]) - 3 * 86400000, list: [{ changeUsd: 5e6 }], change: 10 * (i - 2), changeUsd: 5e6 * (i - 1) });
  }
  rows.push({ date: Date.now() - 86400000, list: [{ changeUsd: 0 }], change: 0, changeUsd: 0 }); // printed zero flows are legal
  return rows;
}

function oiPayload(exchangeValues) {
  // Append a current-day bar so oiLatest stays within the etf_oi data window.
  const dl = TUESDAYS.map(d => Date.parse(d));
  const n = dl.length;
  const extend = (vals) => {
    if (!Array.isArray(vals)) return vals;
    return vals.length === n ? [...vals, vals[n - 1] ?? 0] : vals;
  };
  const dataMap = {};
  for (const [k, v] of Object.entries(exchangeValues)) dataMap[k] = extend(v);
  return { dateList: [...dl, Date.now()], dataMap, priceList: [...dl.map(() => 60000), 60000] };
}

function etfHttp(holder) {
  const key2 = '0123456789abcdef';
  return async (url, opts = {}) => {
    const s = holder.state;
    if (s.fail) return fakeResp({}, { ok: false, status: 503 });
    if (url.includes('publicreporting.cftc.gov')) {
      return fakeResp(s.cot ?? cftcPayload());
    }
    if (url.includes('/api/etf/flow')) {
      const data = s.etfFlows ?? etfFlowRows();
      return fakeResp({ code: 0, data });
    }
    if (url.includes('/api/openInterest/v3/chart')) {
      const coin = url.includes('currency=COIN');
      const data = s.oiFut ?? oiPayload(coin
        ? { Binance: [10, 11, 12, 13], CME: [20, 21, 22, 23] }
        : { Binance: [1e6, 1.1e6, 1.2e6, 1.3e6], CME: [2e6, 2.1e6, 2.2e6, 2.3e6] });
      return fakeResp({ code: 0, data });
    }
    if (url.includes('/api/option/oi/history')) {
      const coin = url.includes('currency=COIN');
      const data = s.oiOpt ?? oiPayload(coin
        ? { Deribit: [5, 6, 7, 8] }
        : { Deribit: [3e5, 3.2e5, 3.3e5, 3.4e5] });
      return fakeResp({ code: 0, data });
    }
    throw new Error('unexpected url ' + url);
  };
}

const basisSeries = TUESDAYS.map((d, i) => ({
  date: d, excessOverTBill: i % 2 ? -0.5 : 1.5, apr90d: 4.2, btcPrice: 60000
}));

test('H/ETF linkage: good → malformed CFTC missing field/contract → all-fail fallback → recovery', async (t) => {
  resetHealth();
  const holder = { state: {} };
  const { tmpDir } = installModuleMocks(t, { [HTTP]: { fetchWithTimeout: etfHttp(holder) } });
  // cdri_fetcher provides callCoinglassEndpoint — must re-require with the mock
  delete require.cache[srv('cdri_fetcher.js')];
  const mod = freshRequire('etf_linkage_engine.js');
  const cacheFile = path.join(tmpDir, 'etf_linkage.json');

  const r1 = await mod.getEtfLinkageData(basisSeries, true);
  assert.ok(r1.weeks.length >= 1);
  assert.equal(r1.dataHealth.state, 'OK');
  const goodBytes = diskBytes(cacheFile);
  assert.ok(goodBytes?.length > 0);

  // CFTC row missing a required numeric field → build fails, last-good served
  holder.state = { cot: cftcPayload({ dropField: 'lev_money_positions_long' }) };
  const r2 = await mod.getEtfLinkageData(basisSeries, true);
  assert.ok(r2.stale === true || r2.weeks.length >= 1);
  assert.notEqual(r2.dataHealth.state, 'OK');
  assert.deepEqual(diskBytes(cacheFile), goodBytes);

  // Latest report week missing one contract → incomplete source, failure
  holder.state = { cot: cftcPayload({ dropContract: '133742' }) };
  const r3 = await mod.getEtfLinkageData(basisSeries, true);
  assert.notEqual(r3.dataHealth.state, 'OK');
  assert.deepEqual(diskBytes(cacheFile), goodBytes);

  // OI null value → failure too
  holder.state = {
    oiFut: oiPayload({ Binance: [1e6, null, 1.2e6, 1.3e6], CME: [2e6, 2.1e6, 2.2e6, 2.3e6] })
  };
  const r4 = await mod.getEtfLinkageData(basisSeries, true);
  assert.notEqual(r4.dataHealth.state, 'OK');
  assert.deepEqual(diskBytes(cacheFile), goodBytes);

  // All-fail → fallback
  holder.state = { fail: true };
  const r5 = await mod.getEtfLinkageData(basisSeries, true);
  assert.notEqual(r5.dataHealth.state, 'OK');
  assert.deepEqual(diskBytes(cacheFile), goodBytes);

  // Mixed-leg failure: ETF serves a NEWER flow date while CFTC fails. The
  // Promise.all build lets the etf leg's recordSuccess land in the registry
  // (the fetch really succeeded), but the served fallback payload must keep
  // its own accepted dataAsOf — a sibling source's newer registry clock can
  // never rejuvenate this copy's data.
  holder.state = {
    etfFlows: [...etfFlowRows(), { date: Date.now(), list: [{ changeUsd: 1e6 }], change: 5, changeUsd: 1e6 }],
    cot: 'not-an-array'
  };
  const r6 = await mod.getEtfLinkageData(basisSeries, true);
  assert.notEqual(r6.dataHealth.state, 'OK');
  assert.equal(r6.dataHealth.sources.etf.dataAsOf, r1.dataHealth.sources.etf.dataAsOf,
    'fallback payload keeps its own bound etf dataAsOf');
  assert.ok(
    Date.parse(getSourceHealth('etf').dataAsOf) > Date.parse(r1.dataHealth.sources.etf.dataAsOf),
    'the live registry etf clock legitimately advanced — only the payload stayed bound');
  assert.deepEqual(diskBytes(cacheFile), goodBytes);

  // Recovery
  holder.state = {};
  const r7 = await mod.getEtfLinkageData(basisSeries, true);
  assert.equal(r7.dataHealth.state, 'OK');
});

// ===========================================================================
// J · McClellan — artifact validation, warmup, pipeline failure keeps data
// ===========================================================================

function mcArtifact({ ready = true, warmup = false } = {}) {
  const dates = ['2026-10-14', '2026-10-15', '2026-10-16'];
  return {
    metadata: { generated_at: new Date(Date.now() - 3600000).toISOString(), benchmark_date: '2026-10-16' },
    current: {
      core: ready ? { date: '2026-10-16', ready: true, oscillator: 0, summation: 12.5 } // finite 0 legal
                    : { date: '2026-10-16', ready: false, oscillator: null, summation: null },
      frontier: ready ? { date: '2026-10-16', ready: true, oscillator: -3.2, summation: 4.1 }
                      : { date: '2026-10-16', ready: false, oscillator: null, summation: null }
    },
    series: dates.map(d => ({ date: d, core_n: 10, frontier_n: 5, dex_volume: 1e6 }))
  };
}

test('J/McClellan: artifact loads → disk-seeded clocks; warmup not malformed; pipeline failure preserves data', async (t) => {
  resetHealth();
  const { tmpDir } = installModuleMocks(t, {
    [CHILD]: {
      exec: (cmd, opts, cb) => cb(new Error('no python')),
      execSync: () => { throw new Error('no python'); }
    }
  });
  const mod = freshRequire('crypto_mcclellan_fetcher.js');
  const dataFile = path.join(tmpDir, 'crypto_mcclellan.json');

  // Valid artifact on disk → served with seeded (fallback/unknown) clocks,
  // never a live success.
  fs.writeFileSync(dataFile, JSON.stringify(mcArtifact()));
  const r1 = await mod.getMcClellanData(false);
  assert.ok(r1.current.core.oscillator === 0); // finite zero accepted
  assert.notEqual(r1.dataHealth.state, 'OK'); // disk seed is never a live success
  const coreH = getSourceHealth('mcclellan_core');
  assert.equal(coreH.dataAsOf.slice(0, 10), '2026-10-16');

  // Warmup artifact: ready=false + oscillator=null is VALID, flagged warmup
  fs.writeFileSync(dataFile, JSON.stringify(mcArtifact({ ready: false })));
  const mod2 = freshRequire('crypto_mcclellan_fetcher.js');
  const r2 = await mod2.getMcClellanData(false);
  assert.equal(r2.current.core.warmup, true);
  assert.equal(r2.current.core.oscillator, null);

  // Malformed: ready=true but null oscillator → rejected, falls back to
  // the in-memory copy when present or throws
  fs.writeFileSync(dataFile, JSON.stringify({
    ...mcArtifact(), current: {
      core: { date: '2026-10-16', ready: true, oscillator: null, summation: 1 },
      frontier: { date: '2026-10-16', ready: true, oscillator: 1, summation: 1 }
    }
  }));
  const mod3 = freshRequire('crypto_mcclellan_fetcher.js');
  await assert.rejects(() => mod3.getMcClellanData(false), /oscillator/);

  // Pipeline failure: force refresh with stubbed child_process → failure is
  // recorded but the last-good disk payload is still served.
  resetHealth();
  fs.writeFileSync(dataFile, JSON.stringify(mcArtifact()));
  const mod4 = freshRequire('crypto_mcclellan_fetcher.js');
  const r5 = await mod4.getMcClellanData(true);
  assert.ok(r5.current.core.oscillator === 0 || r5.current.core.oscillator !== undefined);
  assert.notEqual(getSourceHealth('mcclellan_core').state, 'OK');
  assert.ok(getSourceHealth('mcclellan_core').lastError !== null || r5.dataHealth.state !== 'OK');
});

// ===========================================================================
// spot_daily — malformed venue rows fail that venue, next venue is used
// ===========================================================================

test('spot_daily: malformed kline (NaN close / future ts) fails the venue, next venue serves', async (t) => {
  const holder = { mode: 'mixed' };
  const http = async (url) => {
    if (url.includes('api.binance.com') || url.includes('data-api.binance.vision')) {
      // Binance serves a NaN close → venue must fail outright
      const rows = [[Date.now() - 86400000, '1', '2', '1', 'NaN', '10', 0, '0', 0, '0', '0', '0']];
      return fakeResp(rows);
    }
    if (url.includes('okx.com')) {
      const rows = [[String(Date.now() - 86400000), '50000', '51000', '49000', '50500', '10', '10', '10']];
      return fakeResp({ code: '0', data: rows });
    }
    if (url.includes('coinbase')) {
      const rows = [[nowSec() - 86400, 49000, 51000, 50000, 50500, 10]];
      return fakeResp(rows);
    }
    throw new Error('unexpected url ' + url);
  };
  installModuleMocks(t, { [HTTP]: { fetchWithTimeout: http } });
  const mod = freshRequire('spot_daily.js');
  const res = await mod.fetchSpotDailyCloses(['BTC'], Date.now() - 3 * 86400000);
  assert.equal(res.venue, 'OKX'); // binance hosts both failed, OKX served
  assert.ok(res.errors.some(e => /invalid close/.test(e)));
});
