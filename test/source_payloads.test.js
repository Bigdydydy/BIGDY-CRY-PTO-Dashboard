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

// ===========================================================================
// K · MSTR official disclosures — model (captured issuer HTML) + service
// ===========================================================================
const os = require('os');
const { describe } = require('node:test');
const MD = require('../server/mstr_disclosure_model');
const { createDisclosureService, SOURCE_IDS: MD_SOURCE_IDS } = require('../server/mstr_disclosures');
const MSTR_AUDIT_DIR = path.join(__dirname, 'fixtures', 'mstr');
const MD_T0 = Date.parse('2026-10-03T12:00:00Z');
const MD_UA = 'BIGDY-CRY-PTO/1.0 (ops@example.com)';

const MD_LEDGER_ROW1 = {
  uid: 'blt1', _version: 1, row_index: 1, date_of_purchase: '2026-10-01',
  count: 1000, purchase_price: 50000, total_purchase_price: 50000000,
  btc_holdings: 1000, average_price: 50000, total_acquisition_cost: 50,
  basic_shares_outstanding: 100000, assumed_diluted_shares_outstanding: 120000, sale: false
};
const MD_LEDGER_ROW2 = {
  ...MD_LEDGER_ROW1, uid: 'blt2', row_index: 2, date_of_purchase: '2026-10-02',
  count: 100, total_purchase_price: 5000000, btc_holdings: 1100, total_acquisition_cost: 55
};
const MD_LEDGER_SALE = {
  ...MD_LEDGER_ROW1, uid: 'blt2', row_index: 2, date_of_purchase: '2026-10-02',
  count: -100, sale: true, total_purchase_price: -5000000, btc_holdings: 900, total_acquisition_cost: 45
};
const MD_SHARE_ROW = {
  uid: 'blts1', _version: 1, date: '2026-10-01', basic_shares_outstanding: 100,
  class_a: 90, class_b: 10, assumed_diluted_shares_outstanding: 120,
  options_outstanding: 20, rsu_psu_unvested: 0, total_bitcoin_holdings: 1000
};
const MD_SEC_JSON = {
  cik: '0001050446', name: 'Strategy Inc',
  filings: { recent: {
    accessionNumber: ['0001193125-26-000001'], filingDate: ['2026-10-02'],
    form: ['8-K'], primaryDocument: ['mstr.htm'],
    acceptanceDateTime: ['2026-10-02T12:00:00Z']
  } }
};
// Capital page rows consistent with the ledger/shares fixtures above so a
// clean scan carries no cross-source issues: asOf 2026-10-02 == latest
// reportedOn, holdings 1100 == ledger, basic 100000 == share table units.
const MD_CAPITAL_STATS = {
  uid: 'bltcap1', _version: 1, latest: true, as_of_date: '2026-10-02',
  cash: 5e9, debt: 2e9, pref: 3e9, operating_cash: 4e8, annual_dividends: 800,
  common_equity_raised: 1e10, preferred_equity_raised: 5e9,
  btc_holdings: 1100, basic_shares_outstanding: 100000, debt_years: 3,
  shares: { convert_2028: 1000, convert_strk: 50, options_outstanding: 20, rsu_psu_unvested: 5 },
  strc_metrics: { dividend: 12, next_payout_date: '2026-11-15', next_record_date: '2026-10-31',
    show_transition_dividend: false, transition_dividend_rate: 11.5, shares: 85982656,
    notional_intl: 0, current_fx_rate: 0, cumulative_notional: 12304980000 }
};
const MD_CONVERT_ROW = {
  uid: 'bltconv1', _version: 1, title: 'Convert 2028', notional: 2e9, coupon: 0.625,
  strike_price: 183.19, issue_date: '2024-09-20', maturity_date: '2028-09-16',
  put_date: '2027-09-16', earliest_call_date: '2027-12-20',
  last_traded_price: 111.65, last_trade_date: '2026-10-02', market_value: 2.1e9,
  average_bitcoin_price: 60100, yield: -17.48
};
const MD_PRESS_ROW = {
  uid: 'bltpr1', title: 'Strategy Acquires 250 BTC and Repurchases $192 Million of STRC',
  publication_date: 'October 2, 2026', publication_type: 'Press Release',
  url: '/press/strategy-acquires-250-btc-and-repurchases-192-million-of-strc_10-02-2026',
  updated_at: '2026-10-02T12:00:00Z'
};
const MD_PRESS_ROW2 = {
  uid: 'bltpr2', title: 'Strategy Announces Third Quarter 2026 Financial Results',
  publication_date: 'October 1, 2026', publication_type: 'Press Release',
  url: '/press/q3-results_10-01-2026', updated_at: '2026-10-01T12:00:00Z'
};

function mdNext(pageUrl, payload) {
  return '<html><script id="__NEXT_DATA__">' + JSON.stringify({ props: { pageProps: { pageUrl, ...payload } } }) + '</script></html>';
}
const mdLedger = rows => mdNext('/ledger', { bitcoinData: rows });
const mdShares = rows => mdNext('/shares', { shares: rows });
const mdCapital = (statsRows, convertRows) => mdNext('/debt', { mstrStats: statsRows, convertData: convertRows });
const mdPress = releases => mdNext('/press', { releaseList: releases });
function mdGoodBodies() {
  return {
    ledger: mdLedger([MD_LEDGER_ROW1, MD_LEDGER_ROW2]),
    shares: mdShares([MD_SHARE_ROW]),
    capital: mdCapital([MD_CAPITAL_STATS], [MD_CONVERT_ROW]),
    press: mdPress([MD_PRESS_ROW, MD_PRESS_ROW2]),
    sec: MD_SEC_JSON,
    // The index lists one 8-K; its body carries no BTC/USD/STRC sections.
    sec8k: '<html><body>Item 5.02 Departure of Directors</body></html>',
    xbrl: MD_XBRL_JSON
  };
}
const MD_XBRL_JSON = {
  cik: 1050446,
  units: {
    USD: [{ end: '2026-06-30', val: 2e9, form: '10-Q', filed: '2026-08-03', accn: '0001050446-26-000001' }],
    shares: [{ end: '2026-06-30', val: 20, form: '10-Q', filed: '2026-08-03', accn: '0001050446-26-000001' }]
  }
};
const MD_BODY_KEYS = ['ledger', 'shares', 'capital', 'press', 'sec'];
// A cold scan also reads the listed 8-K body and two XBRL cross-check concepts.
const MD_SCAN_KEYS = [...MD_BODY_KEYS, 'sec8k', 'xbrl', 'xbrl'];
function mdBodyKey(url) {
  if (url.includes('/Archives/edgar/')) return 'sec8k';
  if (url.includes('/api/xbrl/')) return 'xbrl';
  if (url.includes('/ledger')) return 'ledger';
  if (url.includes('/shares')) return 'shares';
  if (url.includes('/debt')) return 'capital';
  if (url.includes('/press')) return 'press';
  return 'sec';
}
function mdRequest(bodies) {
  const calls = [];
  const request = async (url) => {
    calls.push(url);
    const key = mdBodyKey(url);
    const v = typeof bodies[key] === 'function' ? bodies[key]() : bodies[key];
    if (v instanceof Error) throw v;
    if (v && v.__status) return fakeResp(v.body || 'denied', { ok: false, status: v.__status });
    return fakeResp(v);
  };
  return { calls, request };
}
// Official-mNAV market inputs are an injected provider — the default never
// runs in tests. The toy capital fixture (1,100 BTC vs ~$3.6B net claims)
// needs an unrealistic BTC price for a positive Net BPS; it is a stub value.
const MD_PRICES = {
  mstrPriceUsd: 300, btcPriceUsd: 5_000_000,
  btcSource: 'coinbase', mstrSource: 'yahoo',
  priceAsOfIso: '2026-10-03T11:00:00Z'
};
function mdService(bodies, { now = MD_T0, secUa = MD_UA, dataDir, prices } = {}) {
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'be-mstr-'));
  const rq = mdRequest(bodies);
  const svc = createDisclosureService({
    dataDir: dir, request: rq.request, clock: () => now, secUserAgent: () => secUa,
    prices: prices || (async () => ({ ...MD_PRICES })),
    sleep: async () => {}
  });
  return { svc, dir, calls: rq.calls };
}
function mdFixedNow(t, ms = MD_T0) {
  const real = Date.now;
  Date.now = () => ms;
  t.after(() => { Date.now = real; });
}

describe('MSTR disclosure model (captured issuer HTML)', () => {
  test('K1: captured ledger/shares pages reproduce the frozen validation results', () => {
    const ledgerHtml = fs.readFileSync(path.join(MSTR_AUDIT_DIR, 'strategy-ledger.html'), 'utf8');
    const ledgerParsed = MD.parseStrategyLedger(ledgerHtml, Date.now());
    const events = ledgerParsed.events;
    assert.equal(events.length, 124);
    const latest = MD.latestActive(events, 'reportedOn');
    assert.equal(latest.reportedOn, '2026-10-19');
    assert.equal(latest.holdingsBtc, 848517);
    assert.equal(latest.averageCostUsd, 75446);
    assert.equal(latest.aggregateCostUsd, 64017000000);
    assert.equal(latest.basicShares, 422353257);

    const sharesHtml = fs.readFileSync(path.join(MSTR_AUDIT_DIR, 'strategy-shares.html'), 'utf8');
    const shares = MD.latestActive(MD.parseStrategyShares(sharesHtml, Date.now()).snapshots, 'asOf');
    assert.equal(shares.asOf, '2026-10-18');
    assert.equal(shares.basicShares, 422353000);
    assert.equal(shares.assumedDilutedShares, 451933000);
    assert.equal(shares.fullyDilutedShares, null);
    assert.deepEqual(MD.reconcileLatest(latest, shares), []);

    const costIssues = events.filter(e => (e.issues || []).includes('reported_cost_does_not_reconcile'));
    assert.equal(costIssues.length, 1, 'exactly one historical cost discrepancy');
    assert.equal(costIssues[0].reportedOn, '2025-08-18');

    const merged = MD.mergeRevisions(events,
      MD.parseStrategyLedger(ledgerHtml, Date.now()).events,
      new Date().toISOString(), { requireCompleteHistory: true });
    assert.equal(merged.length, 124, 'repeat merge is idempotent');
  });

  test('K1b: captured /debt page reproduces the frozen capital structure', () => {
    const debtHtml = fs.readFileSync(path.join(MSTR_AUDIT_DIR, 'strategy-debt.html'), 'utf8');
    const parsed = MD.parseStrategyCapital(debtHtml, Date.now());

    assert.equal(parsed.capitalSnapshots.length, 1);
    const cap = parsed.capitalSnapshots[0];
    assert.equal(cap.id, 'strategy-capital:2026-10-19');
    assert.equal(cap.asOf, '2026-10-19');
    assert.equal(cap.cashUsd, 4833000000);
    assert.equal(cap.debtUsd, 6714000000);
    assert.equal(cap.prefUsd, 13556668500);
    assert.equal(cap.operatingCashUsd, 447000000);
    assert.equal(cap.annualDividendsUsd, 806.613);
    assert.equal(cap.commonEquityRaisedUsd, 13681000000);
    assert.equal(cap.preferredEquityRaisedUsd, 7524000000);
    assert.equal(cap.btcHoldings, 848517);
    assert.equal(cap.basicShares, 422353257);
    assert.equal(cap.debtYears, 3.4);
    assert.deepEqual(cap.sharesComponents, {
      convert2028: 5513489, convert2029: 2230800, convert2030A: 5341600,
      convert2030B: 4614400, convert2031: 2594314, convert2032: 3915200,
      convertStrk: 1402000, optionsOutstanding: 3106115, rsuPsuUnvested: 862703
    });
    // The 250k rounding gap between instrument notional and the issuer debt
    // headline stays inside tolerance — never flagged.
    assert.deepEqual(cap.issues, []);

    assert.equal(parsed.debtInstruments.length, 6);
    const c28 = parsed.debtInstruments.find(i => i.name === 'Convert 2028');
    assert.equal(c28.notionalUsd, 1010000000);
    assert.equal(c28.couponPct, 0.625);
    assert.equal(c28.strikeUsd, 183.19);
    assert.equal(c28.maturityDate, '2028-09-16');
    assert.equal(c28.putDate, '2027-09-16');
    assert.equal(c28.earliestCallDate, '2027-12-20');
    assert.equal(c28.lastTradedPrice, 111.65);
    assert.equal(c28.lastTradeDate, '2026-10-19');
    assert.equal(c28.marketValueUsd, 2310173000);
    const c30b = parsed.debtInstruments.find(i => i.name === 'Convert 2030 B');
    assert.equal(c30b.marketValueUsd, null, 'null market_value stays null, never fabricated');

    assert.equal(parsed.preferredTerms.length, 5);
    const pref = Object.fromEntries(parsed.preferredTerms.map(p => [p.ticker, p]));
    assert.equal(pref.STRC.dividendPct, 12);
    assert.equal(pref.STRC.nextPayoutDate, '2026-11-15');
    assert.equal(pref.STRC.nextRecordDate, '2026-10-31');
    assert.equal(pref.STRC.sharesOutstanding, 85982656);
    assert.equal(pref.STRF.dividendPct, 10);
    assert.equal(pref.STRF.sharesOutstanding, 12839689);
    assert.equal(pref.STRK.dividendPct, 8);
    assert.equal(pref.STRK.sharesOutstanding, 14020744);
    assert.equal(pref.STRD.dividendPct, 10);
    assert.equal(pref.STRD.sharesOutstanding, 14024221);
    assert.equal(pref.STRE.dividendPct, 10);
    assert.equal(pref.STRE.sharesOutstanding, 8699375);
    assert.equal(pref.STRE.notionalIntl, 7750000);
    assert.equal(pref.STRE.fxRate, 1.1225);

    // Real-capture reconciliation: the /shares page reports basic shares in
    // thousands (422,353,000) while /debt stats are exact (422,353,257).
    // A 257-share gap is page-resolution noise — it must NOT flag a conflict.
    const ledgerHtml = fs.readFileSync(path.join(MSTR_AUDIT_DIR, 'strategy-ledger.html'), 'utf8');
    const latestEvent = MD.latestActive(MD.parseStrategyLedger(ledgerHtml, Date.now()).events, 'reportedOn');
    const sharesHtml = fs.readFileSync(path.join(MSTR_AUDIT_DIR, 'strategy-shares.html'), 'utf8');
    const shares = MD.latestActive(MD.parseStrategyShares(sharesHtml, Date.now()).snapshots, 'asOf');
    assert.equal(shares.basicShares, 422353000, 'shares fixture stays in thousand-share units');
    assert.equal(cap.basicShares - shares.basicShares, 257);
    assert.deepEqual(MD.reconcileCapital(cap, latestEvent, shares), [],
      'real captured inputs reconcile cleanly — no false conflict');
  });

  test('K1c: captured /press index reproduces 156 title-level announcements', () => {
    const pressHtml = fs.readFileSync(path.join(MSTR_AUDIT_DIR, 'strategy-press.html'), 'utf8');
    const parsed = MD.parseStrategyPress(pressHtml, Date.now());
    assert.equal(parsed.announcements.length, 156);

    const newest = parsed.announcements[0];
    assert.equal(newest.title, 'Strategy Acquires 250 BTC and Repurchases $192 Million of STRC');
    assert.equal(newest.publishedOn, '2026-10-12');
    assert.ok(newest.kinds.includes('BTC_PURCHASE'));
    assert.ok(newest.kinds.includes('STRC_REPURCHASE'));
    assert.equal(newest.url,
      'https://www.strategy.com/press/strategy-acquires-250-btc-and-repurchases-192-million-of-strc_10-12-2026');

    // A third party holding STRC is a mention, never issuer preferred capital.
    const strive = parsed.announcements.find(a => /Strive Adds/.test(a.title));
    assert.deepEqual(strive.kinds, ['OTHER_MENTION']);

    const earnings = parsed.announcements.find(a => /Second Quarter 2026 Financial Results/.test(a.title));
    assert.ok(earnings.kinds.includes('EARNINGS'));

    // Titles are discovery signals: no amounts or dates may be extracted.
    for (const a of parsed.announcements) {
      assert.ok(!Object.keys(a).some(k => /amount|cash|btc|shares|notional/i.test(k)),
        `announcement ${a.id} must not carry extracted amounts`);
    }
  });
});

describe('MSTR disclosure service', () => {
  test('K2: cold get() scans five sources sequentially and persists state + evidence', async (t) => {
    resetHealth(); mdFixedNow(t);
    const bodies = mdGoodBodies();
    const { svc, dir, calls } = mdService(bodies);
    const view = await svc.get();
    assert.deepEqual(calls.map(mdBodyKey), MD_SCAN_KEYS,
      'each source fetched exactly once, in order, then the 8-K body and XBRL cross-checks');
    assert.equal(view.schemaVersion, 1);
    assert.equal(view.latest.reportedOn, '2026-10-02');
    assert.equal(view.latest.holdingsBtc, 1100);
    assert.equal(view.events.length, 2);
    assert.equal(view.revisionCount, 0);
    assert.equal(view.shares.basicShares, 100000, 'share page units are thousands');
    assert.equal(view.shares.assumedDilutedShares, 120000);
    assert.equal(view.shares.fullyDilutedShares, null);

    // Milestone 2: issuer capital structure + press discovery
    assert.equal(view.capital.asOf, '2026-10-02');
    assert.equal(view.capital.debtUsd, 2e9);
    assert.equal(view.capital.btcHoldings, 1100);
    assert.equal(view.capital.sharesComponents.convert2028, 1000);
    assert.equal(view.instruments.length, 1);
    assert.equal(view.instruments[0].name, 'Convert 2028');
    assert.equal(view.instruments[0].notionalUsd, 2e9);
    assert.equal(view.preferreds.length, 1);
    assert.equal(view.preferreds[0].ticker, 'STRC');
    assert.equal(view.preferreds[0].dividendPct, 12);
    assert.equal(view.announcements.length, 2);
    assert.deepEqual(view.announcements[0].kinds, ['BTC_PURCHASE', 'STRC_REPURCHASE']);
    assert.deepEqual(view.announcements[1].kinds, ['EARNINGS']);
    assert.equal(view.announcements[0].url,
      'https://www.strategy.com/press/strategy-acquires-250-btc-and-repurchases-192-million-of-strc_10-02-2026');

    const f = view.filings[0];
    assert.equal(f.form, '8-K');
    assert.equal(f.status, 'contents_not_verified');
    assert.equal(f.documentUrl,
      'https://www.sec.gov/Archives/edgar/data/1050446/000119312526000001/mstr.htm');
    assert.ok(!('holdingsBtc' in f) && !('bitcoinHoldings' in f), 'no business facts inferred from the index');

    // fixture shares row reports the older 1000-BTC position vs latest ledger 1100
    assert.ok(view.reconciliationIssues.includes('issuer_holdings_conflict'));

    // The listed 8-K body was fetched and parsed (it has no BTC/USD/STRC sections),
    // so the SEC path has no holdings and the issuer path stays in use.
    assert.equal(view.coverage.sec, '8k_parsed');
    assert.equal(view.coverage.strc, 'announcements_only');
    assert.equal(view.coverage.capitalStructure, 'issuer_reported');
    assert.equal(view.capitalSource, 'issuer');
    assert.deepEqual(Object.keys(view.dataHealth.sources).sort(), [...MD_SOURCE_IDS].sort(), 'issuer path keeps the six-source contract');
    // Milestone 3: the injected price provider + stored capital/share inputs
    // produce a computed official mNAV record (derived — never evidence).
    assert.equal(view.coverage.officialMnav, 'computed');
    assert.ok(view.officialMnav && view.officialMnav.result);
    assert.equal(view.officialMnav.result.methodologyVersion, '2026-07-23');
    assert.ok(Number.isFinite(view.officialMnav.result.mnav));
    assert.equal(view.officialMnav.mstrPriceUsd, 300);
    assert.equal(view.officialMnav.btcSource, 'coinbase');
    assert.equal(view.officialMnav.mstrSource, 'yahoo');
    assert.equal(view.dataHealth.state, 'OK',
      'reconcile conflicts surface via reconciliationIssues; source records stay clean');

    const snap = JSON.parse(fs.readFileSync(path.join(dir, 'mstr_disclosures.json'), 'utf8'));
    assert.equal(snap.schemaVersion, 1);
    assert.equal(snap.events.length, 2);
    assert.equal(Object.keys(snap.dataHealth.sources).length, 7,
      'five evidence sources, the 8-K body scan and the derived mNAV input leg');
    assert.deepEqual(snap.requiredSources, MD_SOURCE_IDS, 'issuer path recorded for the monitor');
    assert.ok(snap.mnav && snap.mnav.result, 'mnav record persisted with state');
    assert.ok(!snap.mnav.fingerprint, 'derived record is never fingerprinted');
    const evDir = path.join(dir, 'mstr_disclosure_evidence');
    assert.equal(fs.readdirSync(evDir).length, 6,
      'one immutable evidence file per source response, incl. the 8-K body (XBRL cross-checks are not evidence)');
    const evMap = view.evidence || {};
    assert.ok(view.events.every(e => evMap[e.fingerprint] && evMap[e.fingerprint].sha256 &&
      fs.existsSync(path.join(evDir, evMap[e.fingerprint].sha256 + '.json'))));
    assert.equal(view.lastAttemptAt, view.lastCompletedAt, 'clean scan stamps completion at attempt');
  });

  test('K3: within-POLL get() serves memory; concurrent force joins one scan', async (t) => {
    resetHealth(); mdFixedNow(t);
    const bodies = mdGoodBodies();
    const { svc, calls } = mdService(bodies);
    await svc.get();
    const v2 = await svc.get();
    assert.equal(calls.length, 8, 'get() within the poll interval does not refetch');
    const [a, b] = await Promise.all([svc.get(true), svc.get(true)]);
    // Second scan: the five pages again; the parsed 8-K and same-day XBRL are not refetched.
    assert.equal(calls.length, 13, 'concurrent force shares a single request sequence');
    assert.equal(a.events.length, 2);
    assert.equal(b.events.length, 2);
    assert.equal(a.events[0].reportedOn, '2026-10-02', 'disclosed date never follows the receipt clock');
  });

  test('K4: revised issuer row supersedes its predecessor; a version downgrade fails', async (t) => {
    resetHealth(); mdFixedNow(t);
    const bodies = mdGoodBodies();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'be-mstr-'));
    let now = MD_T0;
    const rq = mdRequest(bodies);
    const svc = createDisclosureService({
      dataDir: dir, request: rq.request, clock: () => now, secUserAgent: () => MD_UA, prices: async () => ({ ...MD_PRICES }) });
    await svc.get();
    const firstReceipt = getSourceHealth('mstr_official_ledger').lastSuccessAt;

    now += 1000;
    bodies.ledger = mdLedger([MD_LEDGER_ROW1, { ...MD_LEDGER_ROW2, _version: 2, average_price: 50001 }]);
    const v2 = await svc.get(true);
    assert.equal(v2.events.length, 2, 'still one active revision per stable id');
    assert.equal(v2.latest.averageCostUsd, 50001);
    assert.equal(v2.revisionCount, 1, 'superseded copy retained');
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'mstr_disclosures.json'), 'utf8'));
    const revs = state.events.filter(e => e.id === 'strategy-ledger:blt2');
    assert.equal(revs.length, 2, 'superseded copy retained in history');
    assert.equal(revs.filter(r => r.supersededAt).length, 1, 'exactly one superseded revision');
    const secondReceipt = getSourceHealth('mstr_official_ledger').lastSuccessAt;
    assert.ok(secondReceipt > firstReceipt, 'accepted scan advances the receipt');

    now += 1000;
    bodies.ledger = mdLedger([MD_LEDGER_ROW1, MD_LEDGER_ROW2]); // _version back to 1
    const v3 = await svc.get(true);
    assert.equal(v3.latest.averageCostUsd, 50001, 'regressed revision must not replace the newer fact');
    const h = getSourceHealth('mstr_official_ledger');
    assert.match(h.lastError, /regressed/);
    assert.equal(h.lastSuccessAt, secondReceipt, 'failed scan must not advance the success clock');
  });

  test('K5: malformed/shifted/future/impossible/truncated payloads never replace good facts', async (t) => {
    const variants = [
      ['empty ledger', mdLedger([])],
      ['wrong page header', mdNext('/earnings', { bitcoinData: [MD_LEDGER_ROW1, MD_LEDGER_ROW2] })],
      ['future purchase date', mdLedger([MD_LEDGER_ROW1, { ...MD_LEDGER_ROW2, date_of_purchase: '2030-01-01' }])],
      ['impossible calendar date', mdLedger([MD_LEDGER_ROW1, { ...MD_LEDGER_ROW2, date_of_purchase: '2026-02-30' }])],
      ['non-numeric field', mdLedger([MD_LEDGER_ROW1, { ...MD_LEDGER_ROW2, count: 'oops' }])],
      ['truncated history', mdLedger([MD_LEDGER_ROW2])]
    ];
    for (const [name, bad] of variants) {
      resetHealth(); mdFixedNow(t);
      const bodies = mdGoodBodies();
      const { svc, dir } = mdService(bodies);
      await svc.get();
      const receipt = getSourceHealth('mstr_official_ledger').lastSuccessAt;
      bodies.ledger = bad;
      const view = await svc.get(true);
      assert.equal(view.events.length, 2, name + ': prior events preserved');
      assert.equal(view.latest.holdingsBtc, 1100, name + ': latest fact preserved');
      const h = getSourceHealth('mstr_official_ledger');
      assert.ok(h.lastError, name + ': failure recorded');
      assert.equal(h.lastSuccessAt, receipt, name + ': success clock untouched');
      const snap = JSON.parse(fs.readFileSync(path.join(dir, 'mstr_disclosures.json'), 'utf8'));
      assert.equal(snap.dataHealth.sources.mstr_official_ledger.lastError, h.lastError,
        name + ': failed metadata persisted to disk');
    }
  });

  test('K6: HTTP 403 after a good scan preserves facts and reports degraded', async (t) => {
    resetHealth(); mdFixedNow(t);
    const bodies = mdGoodBodies();
    const { svc } = mdService(bodies);
    await svc.get();
    const receipt = getSourceHealth('mstr_official_ledger').lastSuccessAt;
    bodies.ledger = { __status: 403, body: 'denied' };
    const view = await svc.get(true);
    assert.equal(view.events.length, 2);
    const h = getSourceHealth('mstr_official_ledger');
    assert.match(h.lastError, /HTTP 403/);
    assert.equal(h.lastSuccessAt, receipt);
    assert.equal(view.dataHealth.sources.mstr_official_ledger.state, 'FALLBACK',
      'recent good data plus fresh failure is FALLBACK');
    assert.notEqual(view.dataHealth.state, 'OK', 'overall must not claim OK');
  });

  test('K7: missing SEC_USER_AGENT records failure without any SEC request', async (t) => {
    resetHealth(); mdFixedNow(t);
    const bodies = mdGoodBodies();
    const { svc, calls } = mdService(bodies, { secUa: '' });
    const view = await svc.get();
    assert.equal(calls.length, 4, 'SEC endpoint must not be contacted without an honest UA');
    assert.ok(calls.every(u => !u.includes('sec.gov')));
    const h = getSourceHealth('mstr_sec_index');
    assert.match(h.lastError, /SEC_USER_AGENT must identify/);
    assert.equal(h.lastSuccessAt, null);
    assert.notEqual(view.dataHealth.state, 'OK');
  });

  test('K8: cold disk seed is FALLBACK (not fresh); tampered records are rejected', async (t) => {
    resetHealth(); mdFixedNow(t);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'be-mstr-'));
    const bodies = mdGoodBodies();
    const rq = mdRequest(bodies);
    const svc1 = createDisclosureService({
      dataDir: dir, request: rq.request, clock: () => MD_T0, secUserAgent: () => MD_UA, prices: async () => ({ ...MD_PRICES }) });
    await svc1.get();

    resetHealth();
    const offline = async () => { throw new Error('offline'); };
    const svc2 = createDisclosureService({
      dataDir: dir, request: offline, clock: () => MD_T0, secUserAgent: () => MD_UA, prices: async () => ({ ...MD_PRICES }) });
    const peeked = await svc2.peek();
    assert.equal(peeked.events.length, 2, 'disk facts load without network');
    assert.equal(peeked.latest.holdingsBtc, 1100);
    for (const id of MD_SOURCE_IDS) {
      assert.equal(getSourceHealth(id).state, 'FALLBACK',
        id + ' seeded disk health is FALLBACK, never fresh OK');
    }
    assert.equal(peeked.dataHealth.state, 'DEGRADED');

    const snap = JSON.parse(fs.readFileSync(path.join(dir, 'mstr_disclosures.json'), 'utf8'));
    snap.events[0].holdingsBtc = 999999;
    fs.writeFileSync(path.join(dir, 'mstr_disclosures.json'), JSON.stringify(snap));
    resetHealth();
    const svc3 = createDisclosureService({
      dataDir: dir, request: offline, clock: () => MD_T0, secUserAgent: () => MD_UA, prices: async () => ({ ...MD_PRICES }) });
    const bad = await svc3.peek();
    assert.equal(bad.latest, null, 'tampered revision must not surface as a fact');
    assert.ok(bad.cacheIssues.length > 0);
    for (const id of MD_SOURCE_IDS) {
      assert.equal(getSourceHealth(id).observed, false,
        id + ' must not be seeded healthy from a corrupt file');
    }
  });

  test('K9: persistence failure never publishes a success clock', async (t) => {
    resetHealth(); mdFixedNow(t);
    const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'be-mstr-')), 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    const { svc } = mdService(mdGoodBodies(), { dataDir: blocker });
    const view = await svc.get();
    for (const id of MD_SOURCE_IDS) {
      const h = getSourceHealth(id);
      assert.equal(h.lastSuccessAt, null, id + ' must not gain a success receipt without committed state');
      assert.ok(h.lastError, id + ' failure recorded');
    }
    assert.equal(view.events.length, 0);
    assert.equal(view.dataHealth.state, 'UNAVAILABLE', 'fresh-but-unpersisted state is not healthy');
  });

  test('K10: reported sales keep explicit issuer cost fields (never inferred)', async (t) => {
    resetHealth(); mdFixedNow(t);
    const bodies = mdGoodBodies();
    bodies.ledger = mdLedger([MD_LEDGER_ROW1, MD_LEDGER_SALE]);
    const { svc } = mdService(bodies);
    const view = await svc.get();
    const sale = view.events.find(e => e.type === 'BTC_SALE');
    assert.ok(sale);
    assert.equal(sale.deltaBtc, -100);
    assert.equal(sale.transactionCashUsd, 5000000, 'absolute reported proceeds');
    assert.equal(sale.holdingsBtc, 900);
    assert.equal(sale.aggregateCostUsd, 45000000, 'aggregate cost stays the issuer-reported figure');
    assert.equal(sale.averageCostUsd, 50000);
  });

  test('K11: issuer anomalies surface as source issues without rewriting facts', async (t) => {
    resetHealth(); mdFixedNow(t);
    const badAgg = { ...MD_LEDGER_ROW2, total_acquisition_cost: 999 }; // 999e6 vs 1100*50000 = 55e6
    const bodies = mdGoodBodies();
    bodies.ledger = mdLedger([MD_LEDGER_ROW1, badAgg]);
    const { svc } = mdService(bodies);
    const view = await svc.get();
    const ev = view.events.find(e => e.id === 'strategy-ledger:blt2');
    assert.ok(ev.issues.includes('reported_cost_does_not_reconcile'));
    assert.equal(ev.aggregateCostUsd, 999000000, 'reported figure kept verbatim, not rewritten');
    assert.equal(ev.averageCostUsd, 50000);
    const h = getSourceHealth('mstr_official_ledger');
    assert.ok((h.issues || []).some(i => i.includes('blt2')),
      'active event issues ride on the source health record');
  });

  test('K12: capital/press failures preserve prior facts and success clocks', async (t) => {
    resetHealth(); mdFixedNow(t);
    const bodies = mdGoodBodies();
    const { svc, calls } = mdService(bodies);
    const view = await svc.get();
    assert.equal(view.capital.debtUsd, 2e9);
    assert.equal(view.announcements.length, 2);
    const capReceipt = getSourceHealth('mstr_official_capital').lastSuccessAt;
    const pressReceipt = getSourceHealth('mstr_official_press').lastSuccessAt;

    bodies.capital = mdCapital([MD_CAPITAL_STATS], []);            // empty convertData
    bodies.press = mdNext('/earnings', { releaseList: [MD_PRESS_ROW] }); // wrong page
    const v2 = await svc.get(true);
    assert.equal(v2.capital.debtUsd, 2e9, 'prior capital snapshot preserved');
    assert.equal(v2.instruments.length, 1, 'prior instruments preserved');
    assert.equal(v2.preferreds.length, 1, 'prior preferred terms preserved');
    assert.equal(v2.announcements.length, 2, 'prior announcements preserved');
    const hc = getSourceHealth('mstr_official_capital');
    const hp = getSourceHealth('mstr_official_press');
    assert.ok(hc.lastError && hp.lastError, 'both failures recorded');
    assert.equal(hc.lastSuccessAt, capReceipt, 'capital success clock untouched');
    assert.equal(hp.lastSuccessAt, pressReceipt, 'press success clock untouched');
    // Sibling sources still refreshed (sequential independence).
    assert.equal(calls.length, 13, 'second scan refetches the five pages only (8-K parsed, XBRL same day)');
    assert.equal(v2.dataHealth.sources.mstr_official_ledger.state, 'OK');
    assert.notEqual(v2.dataHealth.state, 'OK');
  });

  test('K13: malformed capital payloads reject wholesale and keep prior facts', async (t) => {
    const variants = [
      ['empty convertData', mdCapital([MD_CAPITAL_STATS], [])],
      ['wrong page header', mdNext('/ledger', { mstrStats: [MD_CAPITAL_STATS], convertData: [MD_CONVERT_ROW] })],
      ['negative notional', mdCapital([MD_CAPITAL_STATS], [{ ...MD_CONVERT_ROW, notional: -1 }])],
      ['missing stats row', mdCapital([], [MD_CONVERT_ROW])],
      ['future as_of_date', mdCapital([{ ...MD_CAPITAL_STATS, as_of_date: '2030-01-01' }], [MD_CONVERT_ROW])],
      ['non-numeric cash', mdCapital([{ ...MD_CAPITAL_STATS, cash: 'oops' }], [MD_CONVERT_ROW])],
      ['bad instrument date', mdCapital([MD_CAPITAL_STATS], [{ ...MD_CONVERT_ROW, maturity_date: '2028-02-30' }])],
      ['bad preferred metrics', mdCapital([{ ...MD_CAPITAL_STATS, strc_metrics: { dividend: 'high' } }], [MD_CONVERT_ROW])]
    ];
    for (const [name, bad] of variants) {
      resetHealth(); mdFixedNow(t);
      const bodies = mdGoodBodies();
      const { svc } = mdService(bodies);
      await svc.get();
      const receipt = getSourceHealth('mstr_official_capital').lastSuccessAt;
      bodies.capital = bad;
      const view = await svc.get(true);
      assert.equal(view.capital.debtUsd, 2e9, name + ': prior capital fact preserved');
      assert.equal(view.instruments.length, 1, name + ': prior instruments preserved');
      const h = getSourceHealth('mstr_official_capital');
      assert.ok(h.lastError, name + ': failure recorded');
      assert.equal(h.lastSuccessAt, receipt, name + ': success clock untouched');
    }
  });

  test('K14: a v1 snapshot without milestone-2 arrays still loads', async (t) => {
    resetHealth(); mdFixedNow(t);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'be-mstr-'));
    const bodies = mdGoodBodies();
    const rq = mdRequest(bodies);
    const svc1 = createDisclosureService({
      dataDir: dir, request: rq.request, clock: () => MD_T0, secUserAgent: () => MD_UA, prices: async () => ({ ...MD_PRICES }) });
    await svc1.get();

    // Simulate a pre-milestone-2 file: strip the new record groups (and the
    // milestone-3 derived mnav record — absent on older snapshots).
    const file = path.join(dir, 'mstr_disclosures.json');
    const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete snap.capitalSnapshots;
    delete snap.debtInstruments;
    delete snap.preferredTerms;
    delete snap.announcements;
    delete snap.mnav;
    fs.writeFileSync(file, JSON.stringify(snap));

    resetHealth();
    const offline = async () => { throw new Error('offline'); };
    const svc2 = createDisclosureService({
      dataDir: dir, request: offline, clock: () => MD_T0, secUserAgent: () => MD_UA, prices: async () => ({ ...MD_PRICES }) });
    const peeked = await svc2.peek();
    assert.equal(peeked.events.length, 2, 'prior facts survive the upgrade');
    assert.equal(peeked.capital, null, 'no fabricated capital on a missing section');
    assert.deepEqual(peeked.instruments, []);
    assert.deepEqual(peeked.preferreds, []);
    assert.deepEqual(peeked.announcements, []);
    assert.equal(peeked.coverage.capitalStructure, 'unavailable');
    assert.equal(peeked.officialMnav, null, 'absent mnav record reads back as null');
    assert.equal(peeked.coverage.officialMnav, 'not_computed');
    assert.ok(!peeked.cacheIssues, 'backfilled v1 file is accepted, not rejected');
    for (const id of MD_SOURCE_IDS) {
      assert.equal(getSourceHealth(id).state, 'FALLBACK',
        id + ' seeded disk health is FALLBACK, never fresh OK');
    }
  });

  test('K15: capital reconciliation issues surface, never rewrite facts', async (t) => {
    // Same-date capital row disagreeing on holdings -> conflict.
    resetHealth(); mdFixedNow(t);
    const bodies = mdGoodBodies();
    bodies.capital = mdCapital([{ ...MD_CAPITAL_STATS, btc_holdings: 9999 }], [MD_CONVERT_ROW]);
    const { svc } = mdService(bodies);
    const view = await svc.get();
    assert.ok(view.reconciliationIssues.includes('capital_holdings_conflict'));
    assert.equal(view.capital.btcHoldings, 9999, 'issuer figure kept verbatim');
    assert.equal(view.latest.holdingsBtc, 1100, 'ledger figure kept verbatim');

    // Earlier-dated capital row -> informational lag, not a conflict.
    resetHealth();
    const bodies2 = mdGoodBodies();
    bodies2.capital = mdCapital([{ ...MD_CAPITAL_STATS, as_of_date: '2026-09-01' }], [MD_CONVERT_ROW]);
    const { svc: svc2 } = mdService(bodies2);
    const view2 = await svc2.get();
    assert.ok(view2.reconciliationIssues.includes('capital_asof_lags_ledger'));
    assert.ok(!view2.reconciliationIssues.includes('capital_holdings_conflict'));
    assert.ok(!view2.reconciliationIssues.includes('capital_shares_conflict'),
      'an older cutoff is never compared to newer share data');

    // Issuer debt headline way off the instrument sum -> reconcile gap issue.
    resetHealth();
    const bodies3 = mdGoodBodies();
    bodies3.capital = mdCapital([{ ...MD_CAPITAL_STATS, debt: 9e9 }], [MD_CONVERT_ROW]); // 9e9 vs 2e9 sum
    const { svc: svc3 } = mdService(bodies3);
    const view3 = await svc3.get();
    assert.ok(view3.capital.issues.includes('debt_notional_reconcile_gap'));
    assert.ok(view3.reconciliationIssues.includes('debt_notional_reconcile_gap'),
      'record issues pass through to the reconciliation list');
  });

  test('K16: press announcements union by uid — aged-out releases stay in history', async (t) => {
    resetHealth(); mdFixedNow(t);
    const bodies = mdGoodBodies();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'be-mstr-'));
    let now = MD_T0;
    const rq = mdRequest(bodies);
    const svc = createDisclosureService({
      dataDir: dir, request: rq.request, clock: () => now, secUserAgent: () => MD_UA, prices: async () => ({ ...MD_PRICES }) });
    await svc.get();

    now += 1000;
    // Next index drops bltpr2 and edits bltpr1's title in place.
    bodies.press = mdPress([{ ...MD_PRESS_ROW, title: 'Strategy Acquires 300 BTC' }]);
    const view = await svc.get(true);
    assert.equal(view.announcements.length, 2, 'aged-out release kept in history');
    const edited = view.announcements.find(a => a.uid === 'bltpr1');
    assert.equal(edited.title, 'Strategy Acquires 300 BTC');
    assert.deepEqual(edited.kinds, ['BTC_PURCHASE']);
    const kept = view.announcements.find(a => a.uid === 'bltpr2');
    assert.ok(kept, 'release no longer in the index remains');
    assert.equal(kept.publishedOn, '2026-10-01');
  });
});

// ===========================================================================
// K-mNAV · official mNAV (methodology 2026-07-23) — pure model + service wiring
// ===========================================================================
const { computeOfficialMnav, METHODOLOGY_VERSION, STRK_FALLBACK_STRIKE_USD } =
  require('../server/mstr_mnav');

// Frozen example built from the captured issuer pages (see K1/K1b):
// capital asOf 2026-10-19, shares asOf 2026-10-18 — real disclosed numbers.
const MNAV_CAPITAL = {
  asOf: '2026-10-19', btcHoldings: 848517, cashUsd: 4833000000,
  basicShares: 422353257,
  sharesComponents: {
    convert2028: 5513489, convert2029: 2230800, convert2030A: 5341600,
    convert2030B: 4614400, convert2031: 2594314, convert2032: 3915200,
    convertStrk: 1402000, optionsOutstanding: 3106115, rsuPsuUnvested: 862703
  }
};
const MNAV_INSTRUMENTS = [
  { name: 'Convert 2028', notionalUsd: 1010000000, strikeUsd: 183.19 },
  { name: 'Convert 2029', notionalUsd: 1500000000, strikeUsd: 672.4 },
  { name: 'Convert 2030 A', notionalUsd: 800000000, strikeUsd: 149.77 },
  { name: 'Convert 2030 B', notionalUsd: 2000000000, strikeUsd: 433.43 },
  { name: 'Convert 2031', notionalUsd: 603750000, strikeUsd: 232.72 },
  { name: 'Convert 2032', notionalUsd: 800000000, strikeUsd: 204.33 }
];
const MNAV_PREFS = [
  { ticker: 'STRC', dividendPct: 12, sharesOutstanding: 85982656, notionalIntl: 0, fxRate: 0 },
  { ticker: 'STRD', dividendPct: 10, sharesOutstanding: 14024221, notionalIntl: 0, fxRate: 0 },
  { ticker: 'STRE', dividendPct: 10, sharesOutstanding: 8699375, notionalIntl: 7750000, fxRate: 1.1225 },
  { ticker: 'STRF', dividendPct: 10, sharesOutstanding: 12839689, notionalIntl: 0, fxRate: 0 },
  { ticker: 'STRK', dividendPct: 8, sharesOutstanding: 14020744, notionalIntl: 0, fxRate: 0 }
];
const MNAV_SHARES = { asOf: '2026-10-18', basicShares: 422353257 };
const MNAV_BTC = 100000;

// Preferred notional (USD): STRC 8,598,265,600 / STRD 1,402,422,100 /
// STRF 1,283,968,900 / STRE 869,937,500 × 1.1225 / STRK 1,402,074,400.
const MNAV_PREF_NON_STRK = 8598265600 + 1402422100 + 1283968900 + 869937500 * 1.1225;
const MNAV_STRK_NOTIONAL = 1402074400;
const MNAV_PREF_ALL = MNAV_PREF_NON_STRK + MNAV_STRK_NOTIONAL;
const MNAV_FDSO_BASE = 422353257 + 3106115 + 862703; // basic + options + rsu
const MNAV_ITM_AT_300 = ['Convert 2028', 'Convert 2030 A', 'Convert 2031', 'Convert 2032'];
const MNAV_CONVERT_SHARES_ITM_300 = 5513489 + 5341600 + 2594314 + 3915200;
const MNAV_CONVERT_SHARES_ALL = MNAV_CONVERT_SHARES_ITM_300 + 2230800 + 4614400;

function mnavCase(mstrPriceUsd, over = {}) {
  const issues = [];
  const result = computeOfficialMnav({
    mstrPriceUsd, btcPriceUsd: MNAV_BTC,
    capital: over.capital === undefined ? MNAV_CAPITAL : over.capital,
    instruments: over.instruments === undefined ? MNAV_INSTRUMENTS : over.instruments,
    preferreds: over.preferreds === undefined ? MNAV_PREFS : over.preferreds,
    shares: over.shares === undefined ? MNAV_SHARES : over.shares,
    issues
  });
  return { result, issues };
}

describe('MSTR official mNAV — methodology 2026-07-23', () => {
  test('L1: case A (MSTR $300) — deep ITM converts convert, far strikes stay claims', () => {
    const { result } = mnavCase(300);
    assert.ok(result, 'frozen inputs must compute');
    assert.equal(result.methodologyVersion, '2026-07-23');
    assert.equal(METHODOLOGY_VERSION, '2026-07-23');
    assert.deepEqual(result.itmConverts, MNAV_ITM_AT_300);
    assert.deepEqual(result.otmConverts, ['Convert 2029', 'Convert 2030 B']);
    assert.equal(result.strkItm, false);
    assert.ok(Math.abs(result.strkConversionPrice - 1000) < 0.2,
      'derived STRK strike must verify against the known ~$1000');
    assert.equal(result.fdso, MNAV_FDSO_BASE + MNAV_CONVERT_SHARES_ITM_300);
    assert.deepEqual(result.fdsoBreakdown, {
      basic: 422353257, options: 3106115, rsu: 862703,
      converts: MNAV_CONVERT_SHARES_ITM_300, strk: 0
    });
    const claims = 1500000000 + 2000000000 + MNAV_PREF_ALL; // OTM notionals + all prefs
    assert.equal(result.claimsUsd, Math.round(claims));
    assert.equal(result.usdAssetsUsd, 4833000000);
    const netBtcUsd = 848517 * MNAV_BTC - claims + 4833000000;
    assert.equal(result.netBtcUsd, Math.round(netBtcUsd));
    assert.equal(result.netBtcBtc, Math.round(netBtcUsd / MNAV_BTC * 1e4) / 1e4);
    assert.equal(result.netBpsUsd, Math.round(netBtcUsd / result.fdso * 100) / 100);
    assert.ok(Math.abs(result.mnav - 300 / (netBtcUsd / result.fdso)) < 5e-5);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.inputs, {
      mstrPriceUsd: 300, btcPriceUsd: MNAV_BTC, capitalAsOf: '2026-10-19'
    });
  });

  test('L2: case B (MSTR $700) — all six converts in the money', () => {
    const { result } = mnavCase(700);
    assert.equal(result.itmConverts.length, 6, '672.4 <= 700 -> every convert ITM');
    assert.deepEqual(result.otmConverts, []);
    assert.equal(result.strkItm, false, 'STRK ~$1000 strike stays OTM');
    assert.equal(result.fdso, MNAV_FDSO_BASE + MNAV_CONVERT_SHARES_ALL);
    // No convert notional remains a claim; all five preferreds do (STRK OTM).
    assert.equal(result.claimsUsd, Math.round(MNAV_PREF_ALL));
    const netBtcUsd = 848517 * MNAV_BTC - MNAV_PREF_ALL + 4833000000;
    assert.equal(result.netBtcUsd, Math.round(netBtcUsd));
    assert.deepEqual(result.issues, []);
  });

  test('L3: case C (MSTR $1100) — STRK converts, its notional leaves the claims', () => {
    const { result } = mnavCase(1100);
    assert.equal(result.itmConverts.length, 6);
    assert.equal(result.strkItm, true, '1000.05 <= 1100 -> STRK in the money');
    assert.equal(result.fdsoBreakdown.strk, 1402000, 'issuer convertStrk shares enter FDSO');
    assert.equal(result.fdso, MNAV_FDSO_BASE + MNAV_CONVERT_SHARES_ALL + 1402000);
    assert.equal(result.claimsUsd, Math.round(MNAV_PREF_NON_STRK),
      'ITM STRK notional excluded from claims');
    const netBtcUsd = 848517 * MNAV_BTC - MNAV_PREF_NON_STRK + 4833000000;
    assert.equal(result.netBtcUsd, Math.round(netBtcUsd));
    assert.deepEqual(result.issues, []);
  });

  test('L4: missing structural inputs return null and name the absent input', () => {
    for (const [over, want] of [
      [{ capital: null }, 'missing_input:capital'],
      [{ capital: { ...MNAV_CAPITAL, cashUsd: undefined } }, 'missing_input:capital.cashUsd'],
      [{ capital: { ...MNAV_CAPITAL, btcHoldings: undefined } }, 'missing_input:capital.btcHoldings'],
      [{ capital: { ...MNAV_CAPITAL, sharesComponents: null } }, 'missing_input:capital.sharesComponents'],
      [{ shares: null }, 'missing_input:shares'],
      [{ shares: { asOf: '2026-10-18' } }, 'missing_input:shares.basicShares']
    ]) {
      const { result, issues } = mnavCase(300, over);
      assert.equal(result, null, want);
      assert.ok(issues.includes(want), `${want} must be reported`);
    }
  });

  test('L5: non-positive/non-finite prices reject with an issue, never a value', () => {
    for (const px of [0, -5, NaN, Infinity, '300']) {
      const issues = [];
      assert.equal(computeOfficialMnav({
        mstrPriceUsd: px, btcPriceUsd: MNAV_BTC,
        capital: MNAV_CAPITAL, instruments: MNAV_INSTRUMENTS,
        preferreds: MNAV_PREFS, shares: MNAV_SHARES, issues
      }), null);
      assert.ok(issues.includes('invalid_mstr_price'), `mstr price ${px}`);
      const issues2 = [];
      assert.equal(computeOfficialMnav({
        mstrPriceUsd: 300, btcPriceUsd: px,
        capital: MNAV_CAPITAL, instruments: MNAV_INSTRUMENTS,
        preferreds: MNAV_PREFS, shares: MNAV_SHARES, issues: issues2
      }), null);
      assert.ok(issues2.includes('invalid_btc_price'), `btc price ${px}`);
    }
  });

  test('L6: non-positive Net BPS still returns a value with the issue attached', () => {
    const issues = [];
    const r = computeOfficialMnav({
      mstrPriceUsd: 300, btcPriceUsd: 1000, // BTC reserve ~$0.85B vs ~$17.2B claims
      capital: MNAV_CAPITAL, instruments: MNAV_INSTRUMENTS,
      preferreds: MNAV_PREFS, shares: MNAV_SHARES, issues
    });
    assert.ok(r, 'non-positive Net BPS is a flagged result, never a silent null');
    assert.ok(r.netBpsUsd <= 0);
    assert.ok(r.issues.includes('net_bps_nonpositive'));
    assert.equal(issues, r.issues);
    assert.ok(r.mnav < 0);
  });

  test('L7: unmapped instrument adds notional only, always flagged', () => {
    const extra = { name: 'Convert 2033', notionalUsd: 500000000, strikeUsd: 50 };
    const { result } = mnavCase(300, { instruments: [...MNAV_INSTRUMENTS, extra] });
    assert.ok(result.issues.includes('unmapped_instrument:Convert 2033'));
    assert.ok(result.itmConverts.includes('Convert 2033'), 'ITM by strike');
    assert.equal(result.fdsoBreakdown.converts, MNAV_CONVERT_SHARES_ITM_300,
      'unmapped instrument contributes zero shares even when ITM');
    const otm = { name: 'Convert 2034', notionalUsd: 750000000, strikeUsd: 9999 };
    const { result: r2 } = mnavCase(300, { instruments: [...MNAV_INSTRUMENTS, otm] });
    assert.ok(r2.issues.includes('unmapped_instrument:Convert 2034'));
    assert.ok(r2.otmConverts.includes('Convert 2034'));
    const claimsOtm = 1500000000 + 2000000000 + 750000000 + MNAV_PREF_ALL;
    assert.equal(r2.claimsUsd, Math.round(claimsOtm), 'OTM unmapped notional still a claim');
  });

  test('L8: STRK strike derivation falls back to $1000 with an issue', () => {
    const cap = { ...MNAV_CAPITAL, sharesComponents: { ...MNAV_CAPITAL.sharesComponents, convertStrk: null } };
    const { result } = mnavCase(1100, { capital: cap });
    assert.equal(result.strkConversionPrice, STRK_FALLBACK_STRIKE_USD);
    assert.ok(result.issues.includes('strk_strike_fallback'));
    assert.equal(result.strkItm, true, 'fallback 1000 <= 1100');
    assert.ok(result.fdsoBreakdown.strk > 0, 'ITM STRK derives shares from notional/strike');
    // STRK row absent entirely: no claim, no shares, no fallback noise.
    const { result: r2 } = mnavCase(1100, { preferreds: MNAV_PREFS.filter(p => p.ticker !== 'STRK') });
    assert.equal(r2.strkItm, false);
    assert.equal(r2.strkConversionPrice, null);
    assert.equal(r2.fdsoBreakdown.strk, 0);
    assert.ok(!r2.issues.includes('strk_strike_fallback'));
  });
});

describe('MSTR disclosure service — official mNAV wiring', () => {
  test('L9: injected prices persist state.mnav and emit officialMnav + health', async (t) => {
    resetHealth(); mdFixedNow(t);
    const bodies = mdGoodBodies();
    const { svc, dir } = mdService(bodies, {
      prices: async () => ({
        mstrPriceUsd: 350.25, btcPriceUsd: 5000000,
        btcSource: 'coinbase', mstrSource: 'yahoo',
        priceAsOfIso: '2026-10-03T11:58:00Z'
      })
    });
    const view = await svc.get();
    const m = view.officialMnav;
    assert.ok(m && m.result, 'officialMnav carried on the payload');
    assert.equal(m.priceAsOf, '2026-10-03T11:58:00Z');
    assert.equal(m.computedAt, '2026-10-03T12:00:00.000Z');
    assert.equal(m.mstrPriceUsd, 350.25);
    assert.equal(m.btcPriceUsd, 5000000);
    assert.equal(m.btcSource, 'coinbase');
    assert.equal(m.result.methodologyVersion, '2026-07-23');
    // Toy fixture: Convert 2028 ITM (183.19 <= 350.25), STRK row absent.
    assert.deepEqual(m.result.itmConverts, ['Convert 2028']);
    assert.equal(m.result.fdsoBreakdown.converts, 1000);
    const h = getSourceHealth('mstr_mnav_inputs');
    assert.equal(h.state, 'OK');
    assert.equal(h.dataAsOf, '2026-10-03T11:58:00.000Z', 'dataAsOf binds the price receipt');
    const snap = JSON.parse(fs.readFileSync(path.join(dir, 'mstr_disclosures.json'), 'utf8'));
    assert.equal(snap.mnav.result.mnav, m.result.mnav, 'persisted record round-trips');
    assert.equal(view.coverage.officialMnav, 'computed');
  });

  test('L10: a throwing price provider never fails the five disclosure sources', async (t) => {
    resetHealth(); mdFixedNow(t);
    const bodies = mdGoodBodies();
    const { svc, calls } = mdService(bodies, {
      prices: async () => { throw new Error('price feed down'); }
    });
    const view = await svc.get();
    assert.equal(calls.length, 8, 'all five issuer/SEC sources (plus 8-K body and XBRL) still collected');
    assert.equal(view.events.length, 2);
    assert.equal(view.capital.debtUsd, 2e9);
    assert.equal(view.officialMnav, null, 'no mnav record when inputs never arrived');
    assert.equal(view.coverage.officialMnav, 'not_computed');
    const h = getSourceHealth('mstr_mnav_inputs');
    assert.match(h.lastError || '', /price feed down/);
    for (const id of MD_SOURCE_IDS.slice(0, 5)) {
      assert.equal(getSourceHealth(id).state, 'OK', id + ' unaffected by the price outage');
    }
    assert.notEqual(view.dataHealth.state, 'OK', 'aggregate reflects the failed input leg');
    // lastCompletedAt still stamps: the five-source evidence scan was complete.
    assert.equal(view.lastCompletedAt, view.lastAttemptAt);
  });

  test('L11: non-finite provider output fails the leg but keeps a null result record', async (t) => {
    resetHealth(); mdFixedNow(t);
    const { svc } = mdService(mdGoodBodies(), {
      prices: async () => ({ mstrPriceUsd: NaN, btcPriceUsd: 5000000, btcSource: 'coinbase', mstrSource: 'yahoo' })
    });
    const view = await svc.get();
    assert.ok(view.officialMnav, 'mnav record exists to carry the reason');
    assert.equal(view.officialMnav.result, null);
    assert.ok(view.officialMnav.issues.includes('invalid_mstr_price'));
    const h = getSourceHealth('mstr_mnav_inputs');
    assert.match(h.lastError || '', /invalid_mstr_price/);
    assert.equal(h.lastSuccessAt, null);
    assert.equal(view.coverage.officialMnav, 'not_computed');
  });

  test('L12: incomplete disclosures cannot compute — sources still succeed', async (t) => {
    resetHealth(); mdFixedNow(t);
    const bodies = mdGoodBodies();
    bodies.capital = mdCapital([], [MD_CONVERT_ROW]); // capital parse fails -> no snapshot
    const { svc } = mdService(bodies);
    const view = await svc.get();
    assert.equal(view.capital, null);
    assert.equal(view.officialMnav.result, null);
    assert.ok(view.officialMnav.issues.includes('missing_input:capital'));
    const h = getSourceHealth('mstr_mnav_inputs');
    assert.match(h.lastError || '', /missing_input:capital/);
    assert.equal(getSourceHealth('mstr_official_shares').state, 'OK',
      'sibling evidence sources unaffected');
  });

  test('L13: persisted mnav record survives a reload; corrupt mnav is rejected', async (t) => {
    resetHealth(); mdFixedNow(t);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'be-mstr-'));
    const bodies = mdGoodBodies();
    const rq = mdRequest(bodies);
    const svc1 = createDisclosureService({
      dataDir: dir, request: rq.request, clock: () => MD_T0, secUserAgent: () => MD_UA,
      prices: async () => ({ ...MD_PRICES }) });
    const v1 = await svc1.get();
    const mnav1 = v1.officialMnav.result.mnav;

    resetHealth();
    const offline = async () => { throw new Error('offline'); };
    const svc2 = createDisclosureService({
      dataDir: dir, request: offline, clock: () => MD_T0, secUserAgent: () => MD_UA,
      prices: async () => { throw new Error('offline'); } });
    const peeked = await svc2.peek();
    assert.equal(peeked.officialMnav.result.mnav, mnav1, 'derived record reloads from disk');
    assert.equal(peeked.coverage.officialMnav, 'computed');
    assert.equal(getSourceHealth('mstr_mnav_inputs').state, 'FALLBACK',
      'disk-bound receipt is FALLBACK, never fresh OK');

    // A tampered mnav field invalidates the snapshot, like any other section.
    const snap = JSON.parse(fs.readFileSync(path.join(dir, 'mstr_disclosures.json'), 'utf8'));
    snap.mnav = 'tampered';
    fs.writeFileSync(path.join(dir, 'mstr_disclosures.json'), JSON.stringify(snap));
    resetHealth();
    const svc3 = createDisclosureService({
      dataDir: dir, request: offline, clock: () => MD_T0, secUserAgent: () => MD_UA,
      prices: async () => ({ ...MD_PRICES }) });
    const bad = await svc3.peek();
    assert.equal(bad.latest, null);
    assert.ok(bad.cacheIssues.some(i => /mnav/.test(i)), 'invalid mnav field must be rejected');
  });
});
