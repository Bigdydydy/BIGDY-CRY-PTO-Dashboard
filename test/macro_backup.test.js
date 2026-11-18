/**
 * 美债曲线 / Fed 净流动性备用源：解析器 + FRED/备用源合并（离线，mock HTTP）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { installModuleMocks, srv, freshRequire, resetHealth, fakeResp } = require('./helpers/leaf_env');
const { getSourceHealth } = require('../server/data_health');
const backup = require('../server/macro_backup');

const HTTP = srv('http_client.js');
const iso = ms => new Date(ms).toISOString().slice(0, 10);
const daysAgo = n => iso(Date.now() - n * 86400000);
const mdy = d => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`;

function treasuryCsv(rows) {
  return 'Date,"1 Mo","1 Yr","2 Yr","10 Yr","30 Yr"\n'
    + rows.map(([d, y1, y10]) => `${mdy(d)},4.10,${y1},4.80,${y10},5.40`).join('\n') + '\n';
}

function h41Csv(code, rows, { multiplier = '1000000' } = {}) {
  return [
    '"Series Description","Other series","Target series"',
    '"Unit:","Currency","Currency"',
    `"Multiplier:","1000000","${multiplier}"`,
    '"Currency:","USD","USD"',
    `"Unique Identifier: ","H41/H41/OTHER_N.WW","H41/H41/${code}"`,
    `"Time Period","OTHER_N.WW","${code}"`,
    ...rows.map(([d, v]) => `${d},1,${v}`)
  ].join('\n') + '\n';
}

function fredCsv(id, rows) {
  return `observation_date,${id}\n` + rows.map(([d, v]) => `${d},${v}`).join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

test('macro backup: Treasury CSV → DGS1/DGS10, N/A skipped, bad header/future rejected', () => {
  const d1 = daysAgo(2);
  const d2 = daysAgo(1);
  const csv = 'Date,"1 Yr","10 Yr"\n' + `${mdy(d2)},4.60,5.10\n${mdy(d1)},N/A,5.12\n`;
  const out = backup.parseTreasuryYieldCsv(csv);
  assert.deepEqual([...out.DGS1], [[d2, 4.6]]);
  assert.deepEqual([...out.DGS10], [[d1, 5.12], [d2, 5.1]]); // ascending
  assert.throws(() => backup.parseTreasuryYieldCsv('Date,"2 Yr"\n'), /header/);
  assert.throws(() => backup.parseTreasuryYieldCsv(treasuryCsv([[daysAgo(-3), '4.6', '5.1']])), /future/);
  assert.throws(() => backup.parseTreasuryYieldCsv(treasuryCsv([[daysAgo(1), 'abc', '5.1']])), /non-numeric/);
});

test('macro backup: NY Fed RRP sums same-day operations and converts USD → $B', () => {
  const d = daysAgo(1);
  const json = { repo: { operations: [
    { operationDate: d, operationType: 'Reverse Repo', totalAmtAccepted: 351000000 },
    { operationDate: d, operationType: 'Reverse Repo', totalAmtAccepted: 49000000 },
    { operationDate: d, operationType: 'Repo', totalAmtAccepted: 9e9 }
  ] } };
  assert.deepEqual([...backup.parseNyFedRrp(json)], [[d, 0.4]]);
  assert.throws(() => backup.parseNyFedRrp({}), /operations/);
  assert.throws(() => backup.parseNyFedRrp({ repo: { operations: [
    { operationDate: d, operationType: 'Reverse Repo', totalAmtAccepted: '1' }
  ] } }), /invalid totalAmtAccepted/);
});

test('macro backup: H.4.1 CSV picks the series by code, checks multiplier, skips ND', () => {
  const code = 'RESPPMA_N.WW';
  const csv = h41Csv(code, [[daysAgo(14), '6745635'], [daysAgo(7), 'ND']]);
  assert.deepEqual([...backup.parseH41Csv(csv, code)], [[daysAgo(14), 6745635]]);
  assert.throws(() => backup.parseH41Csv(csv, 'MISSING.WW'), /not found/);
  assert.throws(() => backup.parseH41Csv(h41Csv(code, [[daysAgo(7), '1']], { multiplier: '1000' }), code), /multiplier/);
  assert.throws(() => backup.parseH41Csv('<html>error</html>', code), /identifier row/);
});

// ---------------------------------------------------------------------------
// FRED + backup merge
// ---------------------------------------------------------------------------

function legHttp(state) {
  return async (url) => {
    if (url.includes('fredgraph.csv')) {
      if (state.fredFail) return fakeResp('', { ok: false, status: 503 });
      const id = new URL(url).searchParams.get('id');
      return fakeResp(state.fred[id]);
    }
    if (url.includes('home.treasury.gov')) {
      if (state.backupFail) return fakeResp('', { ok: false, status: 503 });
      return fakeResp(state.treasury);
    }
    if (url.includes('newyorkfed.org')) {
      if (state.backupFail) return fakeResp({}, { ok: false, status: 503 });
      return fakeResp(state.nyfed);
    }
    throw new Error('unexpected url ' + url);
  };
}

test('macro leg: FRED ok → backup only extends days after FRED, after overlap check', async (t) => {
  resetHealth();
  const [a, b, c] = [daysAgo(3), daysAgo(2), daysAgo(1)];
  const state = {
    fred: { DGS1: fredCsv('DGS1', [[a, '4.65'], [b, '4.62']]) },
    treasury: treasuryCsv([[a, '4.65', '5.15'], [b, '4.62', '5.12'], [c, '4.60', '5.10']])
  };
  installModuleMocks(t, { [HTTP]: { fetchWithTimeout: legHttp(state) } });
  const mod = freshRequire('macro_fetcher.js');

  const leg = await mod.fetchMacroLeg('DGS1');
  const r = mod.resolveMacroLeg(leg, [], 'us1y', 1, null);
  assert.equal(r.status, 'ok');
  assert.equal(r.source, 'fred+treasury');
  assert.equal(r.asOf, c);
  assert.deepEqual([...r.map], [[a, 4.65], [b, 4.62], [c, 4.6]]);
  const h = getSourceHealth('fred:DGS1');
  assert.equal(h.state, 'OK');
  assert.equal(h.dataAsOf.slice(0, 10), c);
});

test('macro leg: backup disagreeing with FRED on an overlap day is discarded', async (t) => {
  resetHealth();
  const [a, b] = [daysAgo(2), daysAgo(1)];
  const state = {
    fred: { DGS10: fredCsv('DGS10', [[a, '5.15']]) },
    treasury: treasuryCsv([[a, '4.65', '5.30'], [b, '4.62', '5.12']])
  };
  installModuleMocks(t, { [HTTP]: { fetchWithTimeout: legHttp(state) } });
  const mod = freshRequire('macro_fetcher.js');

  const leg = await mod.fetchMacroLeg('DGS10');
  const r = mod.resolveMacroLeg(leg, [], 'us10y', 1, null);
  assert.equal(r.source, 'fred');
  assert.equal(r.asOf, a);
  assert.deepEqual([...r.map], [[a, 5.15]]);
  assert.match(leg.backupError.message, /disagrees/);
});

test('macro leg: FRED down → backup overwrites snapshot placeholders, health FALLBACK', async (t) => {
  resetHealth();
  const [a, b, c] = [daysAgo(3), daysAgo(2), daysAgo(1)];
  const state = {
    fredFail: true,
    nyfed: { repo: { operations: [
      { operationDate: b, operationType: 'Reverse Repo', totalAmtAccepted: 182000000 },
      { operationDate: c, operationType: 'Reverse Repo', totalAmtAccepted: 351000000 }
    ] } }
  };
  installModuleMocks(t, { [HTTP]: { fetchWithTimeout: legHttp(state) } });
  const mod = freshRequire('macro_fetcher.js');

  // Previous snapshot: b was a forward-filled placeholder of a's value ($T).
  const prevPoints = [{ date: a, fedRrp: 0.000325 }, { date: b, fedRrp: 0.000325 }];
  const leg = await mod.fetchMacroLeg('RRPONTSYD');
  const r = mod.resolveMacroLeg(leg, prevPoints, 'fedRrp', 1000, { seriesAsOf: { fedRrp: a } });
  assert.equal(r.status, 'backup');
  assert.equal(r.source, 'nyfed+snapshot');
  assert.equal(r.asOf, c);
  assert.deepEqual([...r.map].map(([d, v]) => [d, Number(v.toFixed(3))]), [[a, 0.325], [b, 0.182], [c, 0.351]]);
  const h = getSourceHealth('fred:RRPONTSYD');
  assert.equal(h.state, 'FALLBACK');
  assert.equal(h.dataAsOf.slice(0, 10), c);
});

test('macro leg: FRED and backup both down → snapshot only, recorded failure', async (t) => {
  resetHealth();
  const a = daysAgo(2);
  installModuleMocks(t, { [HTTP]: { fetchWithTimeout: legHttp({ fredFail: true, backupFail: true }) } });
  const mod = freshRequire('macro_fetcher.js');

  const leg = await mod.fetchMacroLeg('DGS1');
  const r = mod.resolveMacroLeg(leg, [{ date: a, us1y: 4.65 }], 'us1y', 1, { seriesAsOf: { us1y: a } });
  assert.equal(r.status, 'fallback');
  assert.equal(r.source, 'snapshot');
  assert.equal(r.asOf, a);
  assert.notEqual(getSourceHealth('fred:DGS1').state, 'OK');
  assert.match(getSourceHealth('fred:DGS1').lastError || '', /backup home\.treasury\.gov/);

  const empty = mod.resolveMacroLeg(leg, [], 'us1y', 1, null);
  assert.equal(empty.status, 'failed');
  assert.equal(empty.map.size, 0);
});
