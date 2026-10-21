const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { _internal } = require('../server/mstr_preferreds');
const { recordOfficialStrcRate, mergeStrcRates } = _internal;

const NOW = new Date('2026-10-21T05:00:00Z');

function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strc-rate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'strc_rate_history.json');
}

function disclosure(strc) {
  return {
    capital: { asOf: '2026-10-19' },
    preferreds: [
      { ticker: 'STRD', dividendPct: 10, nextRecordDate: '2026-12-15' },
      ...(strc ? [{ ticker: 'STRC', sourceUrl: 'https://www.strategy.com/debt', ...strc }] : [])
    ]
  };
}

test('official STRC rate is filed under the month of its record date and persisted', async (t) => {
  const file = tmpFile(t);
  const history = { months: {} };
  const r = await recordOfficialStrcRate(history, {
    peek: async () => disclosure({ dividendPct: 12, nextRecordDate: '2026-10-31' }),
    file,
    now: () => NOW
  });
  assert.deepEqual(r, { status: 'recorded', month: '2026-10' });
  assert.equal(history.months['2026-10'].ratePct, 12);
  assert.equal(history.months['2026-10'].recordDate, '2026-10-31');
  assert.equal(history.months['2026-10'].capitalAsOf, '2026-10-19');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).months['2026-10'].ratePct, 12);
});

test('same rate again is a no-op; a changed rate is a revision that keeps the prior value', async (t) => {
  const file = tmpFile(t);
  const history = { months: { '2026-10': { ratePct: 12, recordDate: '2026-10-31' } } };
  const same = await recordOfficialStrcRate(history, {
    peek: async () => disclosure({ dividendPct: 12, nextRecordDate: '2026-10-31' }), file, now: () => NOW
  });
  assert.equal(same.status, 'unchanged');
  assert.equal(fs.existsSync(file), false, 'unchanged rate must not rewrite the history file');

  const revised = await recordOfficialStrcRate(history, {
    peek: async () => disclosure({ dividendPct: 12.25, nextRecordDate: '2026-10-31' }), file, now: () => NOW
  });
  assert.equal(revised.status, 'revised');
  assert.equal(history.months['2026-10'].ratePct, 12.25);
  assert.equal(history.months['2026-10'].revisedFrom, 12);
});

test('blocked or incomplete disclosures leave history untouched', async (t) => {
  const file = tmpFile(t);
  const cases = [
    async () => { throw new Error('HTTP 403'); },               // issuer site blocked
    async () => disclosure(null),                                 // no STRC row
    async () => disclosure({ dividendPct: null, nextRecordDate: '2026-10-31' }),
    async () => disclosure({ dividendPct: 12, nextRecordDate: null }),
    async () => disclosure({ dividendPct: 0, nextRecordDate: '2026-10-31' })
  ];
  for (const peek of cases) {
    const history = { months: {} };
    const r = await recordOfficialStrcRate(history, { peek, file, now: () => NOW });
    assert.equal(r.status, 'unavailable');
    assert.deepEqual(history.months, {});
  }
  assert.equal(fs.existsSync(file), false);
});

test('manual rates backfill earlier months; official wins on overlap and the conflict is reported', () => {
  const history = { months: { '2026-09': { ratePct: 11.75 }, '2026-10': { ratePct: 12 } } };
  const manual = { '2026-08': 11.5, '2026-09': 11.5, bad: 'x', '2026-07': -1 };
  const { rates, sourceOf, issues } = mergeStrcRates(history, manual);
  assert.deepEqual(rates, { '2026-08': 11.5, '2026-09': 11.75, '2026-10': 12 });
  assert.deepEqual(sourceOf, { '2026-08': 'manual', '2026-09': 'official', '2026-10': 'official' });
  assert.deepEqual(issues, ['strc_rate_conflict:2026-09:manual=11.5,official=11.75']);
});
