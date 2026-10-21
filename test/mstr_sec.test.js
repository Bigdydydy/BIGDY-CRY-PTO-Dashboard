const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SEC = require('../server/mstr_sec_model');
const { createDisclosureService, SOURCE_IDS, SEC_PATH_IDS, SEC_FILINGS_ID } = require('../server/mstr_disclosures');
const { recordOfficialStrcRate } = require('../server/mstr_preferreds')._internal;
const { resetHealthForTests } = require('../server/data_health');
const { evaluateMonitoring } = require('../server/data_health_monitor');

const FIX = path.join(__dirname, 'fixtures', 'mstr', 'sec');
const REFERENCE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'mstr_capital_reference.json'), 'utf8'));

/** Captured 8-K text fixture: "accession: …\nfiledOn: …\n\n<flattened text>". */
function fixture(name) {
  const raw = fs.readFileSync(path.join(FIX, `${name}.txt`), 'utf8');
  const accession = /^accession: (\S+)/m.exec(raw)[1];
  const filedOn = /^filedOn: (\S+)/m.exec(raw)[1];
  const body = raw.slice(raw.indexOf('\n\n') + 2);
  const documentUrl = `${SEC.SEC_ARCHIVE_PREFIX}${accession.replace(/-/g, '')}/${name}.htm`;
  return { accession, filedOn, documentUrl, body, name };
}
const parse = name => { const f = fixture(name); return SEC.parseSecEightK(f.body, f); };

describe('SEC 8-K parsing (captured Strategy filings)', () => {
  test('weekly 8-K: holdings triple, USD reserve + cash, ATM and repurchase flows', () => {
    const d = parse('8k-2026-10-19-weekly');
    assert.deepEqual(d.holdings, [{ asOf: '2026-10-18', holdingsBtc: 848517, aggregateCostUsd: 64.02e9, averageCostUsd: 75446 }]);
    assert.deepEqual(d.usd, { asOf: '2026-10-18', usdReserveUsd: 4.83e9, usdCashUsd: 447.3e6 });
    const atm = d.flows.find(f => f.kind === 'atm');
    const rep = d.flows.find(f => f.kind === 'repurchase');
    assert.equal(atm.periodEnd, '2026-10-18');
    assert.equal(atm.shares.MSTR, 140872);
    assert.equal(atm.shares.STRC, 0);
    assert.equal(rep.shares.STRC, 1938780);
    assert.equal(d.strcRate, null);
    assert.deepEqual(d.issues, []);
  });

  test('STRC rate announcements: maintain (semi-monthly), increase (from/to), conditional', () => {
    const maintain = parse('8k-2026-10-01-strc-maintain').strcRate;
    assert.equal(maintain.announcedOn, '2026-09-30');
    assert.equal(maintain.effectiveFrom, '2026-10-16');
    assert.equal(maintain.ratePct, 12);
    assert.equal(maintain.action, 'maintain');
    assert.equal(maintain.conditional, false);

    const increase = parse('8k-2026-01-02-strc-increase').strcRate;
    assert.equal(increase.effectiveFrom, '2026-01-01');
    assert.equal(increase.previousPct, 10.75);
    assert.equal(increase.ratePct, 11);
    assert.equal(increase.action, 'increase');

    const cond = parse('8k-2026-10-16-strc-conditional').strcRate;
    assert.equal(cond.effectiveFrom, '2026-11-01');
    assert.equal(cond.ratePct, 12);
    assert.equal(cond.conditional, true, 'shareholder-vote contingent rate is flagged');
  });

  test('holdings layouts: sale table, prose, two periods in one filing', () => {
    const sold = parse('8k-2026-06-01-btc-sold');
    assert.deepEqual(sold.holdings.map(h => [h.asOf, h.holdingsBtc, h.averageCostUsd]), [['2026-05-31', 843706, 75699]]);
    assert.equal(sold.usd.usdCashUsd, null, 'reserve-only era: USD Cash not disclosed');
    assert.equal(sold.usd.usdReserveUsd, 900e6);

    const prose = parse('8k-2026-05-26-prose');
    assert.deepEqual(prose.holdings.map(h => [h.asOf, h.holdingsBtc, h.averageCostUsd]), [['2026-05-25', 843738, 75700]]);

    const two = parse('8k-2026-07-06-two-periods');
    assert.deepEqual(two.holdings.map(h => [h.asOf, h.holdingsBtc]), [['2026-06-30', 846000], ['2026-07-05', 843775]]);
  });

  test('USD balances list layout', () => {
    assert.deepEqual(parse('8k-2026-08-24-usd-list').usd, { asOf: '2026-08-23', usdReserveUsd: 5.1e9, usdCashUsd: 1.59e9 });
  });

  test('a filing without recognised sections yields nothing and no issues', () => {
    const d = SEC.parseSecEightK('<html>Item 5.02 Departure of Directors</html>', {
      accession: '0001193125-26-000001', filedOn: '2026-10-02', documentUrl: `${SEC.SEC_ARCHIVE_PREFIX}x/y.htm`
    });
    assert.deepEqual([d.holdings, d.usd, d.strcRate, d.flows, d.issues], [[], null, null, [], []]);
  });

  test('a cost triple that does not reconcile is rejected with an issue, never stored', () => {
    const d = SEC.parseSecEightK('BTC Update As of October 18, 2026 Aggregate BTC Holdings 848,517 $ 99.99 $ 75,446', {
      accession: '0001193125-26-000002', filedOn: '2026-10-19', documentUrl: `${SEC.SEC_ARCHIVE_PREFIX}x/z.htm`
    });
    assert.deepEqual(d.holdings, []);
    assert.ok(d.issues.includes('btc_cost_does_not_reconcile:2026-10-18'));
  });
});

describe('SEC rate schedule and capital derivation', () => {
  const docs = ['8k-2026-01-02-strc-increase', '8k-2026-10-01-strc-maintain', '8k-2026-10-16-strc-conditional',
    '8k-2026-10-19-weekly'].map(parse);

  test('schedule: one entry per effective date, inferred prior rate from the first "from X%"', () => {
    const s = SEC.buildStrcRateSchedule(docs);
    assert.deepEqual(s.map(e => [e.effectiveFrom, e.ratePct, !!e.inferred, e.conditional]), [
      [null, 10.75, true, false], ['2026-01-01', 11, false, false], ['2026-10-16', 12, false, false], ['2026-11-01', 12, false, true]
    ]);
    assert.equal(SEC.strcRateOn(s, '2025-12-15').ratePct, 10.75);
    assert.equal(SEC.strcRateOn(s, '2026-10-20').effectiveFrom, '2026-10-16');
  });

  test('derived capital: 8-K holdings and USD assets, reference terms, STRC rate from the schedule', () => {
    const out = SEC.deriveSecCapital({ reference: REFERENCE, docs, today: '2026-10-21' });
    const c = out.capital;
    assert.equal(c.asOf, '2026-10-18');
    assert.equal(c.btcHoldings, 848517);
    assert.equal(c.cashUsd, 4.83e9 + 447.3e6, 'USD Assets = USD Reserve + USD Cash');
    assert.equal(c.basicShares, REFERENCE.basicShares, 'flows up to the reference cutoff are already in the reference');
    assert.equal(c.provenance.rolledForwardPeriods, 0);
    assert.equal(out.preferreds.find(p => p.ticker === 'STRC').dividendPct, 12);
    assert.equal(out.instruments.length, REFERENCE.instruments.length);
    assert.deepEqual(out.issues, []);
  });

  test('flows after the cutoff roll share counts forward once per period', () => {
    const flow = (kind, shares) => ({ kind, periodStart: '2026-10-19', periodEnd: '2026-10-25', shares });
    const later = {
      accession: '0001193125-26-999999', filedOn: '2026-10-26', documentUrl: 'u', issues: [], usd: null, strcRate: null,
      holdings: [{ asOf: '2026-10-25', holdingsBtc: 848600, aggregateCostUsd: 64.03e9, averageCostUsd: 75452 }],
      flows: [flow('atm', { MSTR: 1000, STRC: 0 }), flow('repurchase', { STRC: 500, MSTR: 0 })]
    };
    const restated = { ...later, accession: '0001193125-26-999998', holdings: [] }; // same period re-reported
    const out = SEC.deriveSecCapital({ reference: REFERENCE, docs: [...docs, later, restated], today: '2026-10-27' });
    const strcRef = REFERENCE.preferreds.find(p => p.ticker === 'STRC').sharesOutstanding;
    assert.equal(out.capital.basicShares, REFERENCE.basicShares + 1000);
    assert.equal(out.preferreds.find(p => p.ticker === 'STRC').sharesOutstanding, strcRef - 500);
    assert.equal(out.capital.provenance.rolledForwardPeriods, 2, 'restated period not double counted');
    assert.ok(out.issues.includes('usd_balances_lag_holdings'));
  });

  test('stale reference and XBRL debt drift are flagged, not silently used', () => {
    const xbrl = { longTermDebt: { value: 9e9, periodEnd: '2026-12-31', filedOn: '2027-02-15', form: '10-K' } };
    const out = SEC.deriveSecCapital({ reference: REFERENCE, docs, xbrl, today: '2027-03-01' });
    assert.ok(out.issues.includes('capital_reference_stale'));
    assert.ok(out.issues.includes('xbrl_debt_differs_from_reference'));
  });

  test('no 8-K holdings -> no SEC capital', () => {
    assert.equal(SEC.deriveSecCapital({ reference: REFERENCE, docs: [parse('8k-2026-10-01-strc-maintain')].map(d => ({ ...d, holdings: [] })) }), null);
  });
});

// --- service: strategy.com blocked, SEC path ---------------------------------

const T0 = Date.parse('2026-10-21T06:00:00Z');
const UA = 'BIGDY-CRY-PTO/1.0 (ops@example.com)';
const FILINGS = ['8k-2026-10-19-weekly', '8k-2026-10-16-strc-conditional', '8k-2026-10-01-strc-maintain', '8k-2026-01-02-strc-increase'].map(fixture);
const SUBMISSIONS = {
  cik: '0001050446', name: 'Strategy Inc',
  filings: { recent: {
    accessionNumber: FILINGS.map(f => f.accession),
    filingDate: FILINGS.map(f => f.filedOn),
    form: FILINGS.map(() => '8-K'),
    primaryDocument: FILINGS.map(f => `${f.name}.htm`),
    acceptanceDateTime: FILINGS.map(f => `${f.filedOn}T12:00:00.000Z`)
  } }
};
const XBRL = (unit, val) => ({ cik: 1050446, units: { [unit]: [{ end: '2026-06-30', val, form: '10-Q', filed: '2026-08-03' }] } });

function secPathService(dir, { ua = UA } = {}) {
  const calls = [];
  const resp = (body, status = 200) => ({
    ok: status === 200, status, headers: { get: () => null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body)
  });
  const request = async (url) => {
    calls.push(url);
    if (url.includes('www.strategy.com')) return resp('<HTML>Access Denied</HTML>', 403);
    if (url.includes('/submissions/')) return resp(SUBMISSIONS);
    if (url.includes('LongTermDebt')) return resp(XBRL('USD', 6709928000));
    if (url.includes('/api/xbrl/')) return resp(XBRL('shares', 3176000));
    const f = FILINGS.find(x => url === x.documentUrl.replace(/[^/]+$/, `${x.name}.htm`));
    if (f) return resp(f.body);
    throw new Error(`unexpected url ${url}`);
  };
  const svc = createDisclosureService({
    dataDir: dir, request, clock: () => T0, secUserAgent: () => ua,
    capitalReference: () => REFERENCE, sleep: async () => {},
    prices: async () => ({ mstrPriceUsd: 142.72, btcPriceUsd: 82840.42, mstrSource: 'yahoo', btcSource: 'coinbase', priceAsOfIso: '2026-10-21T05:59:00Z' })
  });
  return { svc, calls };
}

describe('MSTR disclosure service — SEC path when strategy.com is blocked', () => {
  test('issuer 403 everywhere: capital, holdings and mNAV come from 8-Ks; issuer pages are optional', async (t) => {
    resetHealthForTests();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'be-mstr-sec-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const { svc, calls } = secPathService(dir);
    const v = await svc.get(true);

    assert.equal(v.capitalSource, 'sec');
    assert.equal(v.holdingsSource, 'sec_8k');
    assert.equal(v.latest.holdingsBtc, 848517);
    assert.equal(v.latest.holdingsAsOf, '2026-10-18');
    assert.equal(v.capital.cashUsd, 4.83e9 + 447.3e6);
    assert.deepEqual(Object.keys(v.dataHealth.sources).sort(), [...SEC_PATH_IDS].sort());
    assert.equal(v.dataHealth.state, 'OK', 'SEC path complete -> healthy despite issuer 403');
    for (const id of ['mstr_official_ledger', 'mstr_official_shares', 'mstr_official_capital', 'mstr_official_press']) {
      assert.equal(v.optionalSources[id].state, 'UNAVAILABLE', `${id} reported as optional`);
      assert.match(v.optionalSources[id].lastError, /403/);
    }
    assert.ok(v.lastCompletedAt, 'SEC path completion stamps the scan');
    assert.equal(v.officialMnav.capitalSource, 'sec');
    assert.ok(Math.abs(v.officialMnav.result.mnav - 1.1024) < 0.001, `mNAV ${v.officialMnav.result.mnav}`);
    assert.equal(v.coverage.strc, 'sec_8k_rate_schedule');
    assert.equal(v.strcRateSchedule.at(-1).conditional, true);
    assert.equal(v.sec.documentsParsed, 4);
    assert.equal(v.sec.xbrl.longTermDebt.value, 6709928000);

    const snap = JSON.parse(fs.readFileSync(path.join(dir, 'mstr_disclosures.json'), 'utf8'));
    assert.deepEqual(snap.requiredSources, SEC_PATH_IDS, 'monitor learns the path in use');

    // Re-scan: parsed 8-Ks and same-day XBRL are not refetched.
    const archiveCalls = () => calls.filter(u => u.includes('/Archives/edgar/') || u.includes('/api/xbrl/')).length;
    const before = archiveCalls();
    await svc.get(true);
    assert.equal(archiveCalls(), before);
  });

  test('without an SEC identity no SEC request is made and the 8-K source fails', async (t) => {
    resetHealthForTests();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'be-mstr-sec-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const { svc, calls } = secPathService(dir, { ua: '' });
    const v = await svc.get(true);
    assert.equal(calls.filter(u => u.includes('sec.gov')).length, 0);
    assert.notEqual(v.dataHealth.state, 'OK');
    const snap = JSON.parse(fs.readFileSync(path.join(dir, 'mstr_disclosures.json'), 'utf8'));
    assert.match(snap.dataHealth.sources[SEC_FILINGS_ID].lastError, /SEC_USER_AGENT/);
    assert.deepEqual(snap.requiredSources, SOURCE_IDS, 'no SEC capital -> issuer path contract');
  });

  test('the monitor checks the sources the producer declared', () => {
    const now = T0;
    const ok = { lastSuccessAt: new Date(now - 60000).toISOString(), dataAsOf: new Date(now - 60000).toISOString(), lastError: null, issues: [] };
    const snapshots = {
      'mstr_disclosures.json': {
        requiredSources: SEC_PATH_IDS,
        dataHealth: { sources: {
          mstr_sec_index: ok, mstr_sec_filings: ok, mstr_mnav_inputs: ok,
          mstr_official_ledger: { ...ok, available: false, lastError: 'HTTP 403' }
        } }
      }
    };
    const report = evaluateMonitoring({ snapshots }, now);
    const art = report.artifacts.mstr_disclosures_snapshot;
    assert.deepEqual(Object.keys(art.sources).sort(), [...SEC_PATH_IDS].sort());
    assert.equal(art.state, 'HEALTHY');
  });
});

describe('STRC monthly rate history from the 8-K schedule', () => {
  test('backfills every month from STRC listing to the current month; rerun is a no-op', async (t) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'strc-sched-')), 'h.json');
    t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
    const docs = ['8k-2026-01-02-strc-increase', '8k-2026-10-01-strc-maintain', '8k-2026-10-16-strc-conditional'].map(parse);
    const schedule = SEC.buildStrcRateSchedule(docs);
    const peek = async () => ({ strcRateSchedule: schedule });
    const now = () => new Date('2026-10-21T06:00:00Z');
    const history = { months: {} };
    const r = await recordOfficialStrcRate(history, { peek, file, now });
    assert.equal(r.status, 'recorded');
    assert.equal(history.months['2025-07'].ratePct, 10.75);
    assert.equal(history.months['2025-07'].inferred, true);
    assert.equal(history.months['2026-01'].ratePct, 11);
    assert.equal(history.months['2026-10'].ratePct, 11, 'Oct 1 rate is the January step; the 12% maintain starts Oct 16');
    assert.equal(history.months['2026-11'], undefined, 'future conditional month is not booked');
    assert.equal(history.months['2026-01'].source, 'sec_8k');
    const again = await recordOfficialStrcRate(history, { peek, file, now });
    assert.equal(again.status, 'unchanged');
  });
});
