/**
 * Weekly topic screener: percentile ranking of weekly moves, change modes, calendar, angle scoring
 * (event bonus, recency penalty, licensing) and the report built from a small synthetic archive.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../server/weekly_screener');
const cli = require('../scripts/weekly_screener');

const DAY = 86400000;
const iso = ms => new Date(ms).toISOString().slice(0, 10);
const T0 = Date.UTC(2026, 0, 1);
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);

/** n daily points, value = f(i) */
const daily = (n, f, start = T0) => Array.from({ length: n }, (_, i) => ({ date: iso(start + i * DAY), value: f(i) }));

test('percentile rank counts ties half; extremeness is distance from the median', () => {
  near(S.percentileRank([1, 2, 3, 4], 2.5), 50);
  near(S.percentileRank([1, 2, 2, 4], 2), 50);
  near(S.percentileRank([1, 2, 3], 10), 100);
  assert.equal(S.percentileRank([], 1), null);
  near(S.extremeness(50), 0);
  near(S.extremeness(2), 96);
  near(S.extremeness(100), 100);
});

test('weekly changes: diff, pct across a missing day, and full-window sums', () => {
  const s = S.normalizeSeries([...daily(20, i => 100 + i)].filter((p, i) => i !== 10));
  const diff = S.changeSeries(s, 'diff');
  assert.equal(diff[0].date, '2026-01-08');
  near(diff[0].change, 7);
  // 2026-01-18 looks back to 01-11, which is missing → falls back to 01-10 (within tolerance)
  const d18 = diff.find(c => c.date === '2026-01-18');
  near(d18.change, 117 - 109);
  const pct = S.changeSeries(s, 'pct');
  near(pct[0].change, (107 / 100 - 1) * 100);
  const sums = S.changeSeries(S.normalizeSeries(daily(10, () => 1)), 'sum');
  assert.equal(sums[0].date, '2026-01-07', 'first full 7-day window');
  near(sums[0].change, 7);
  near(sums[sums.length - 1].change, 7);
  assert.deepEqual(S.changeSeries(s, 'level'), []);
});

test('a flow metric reports the week total as its value', () => {
  const series = daily(100, i => (i >= 93 ? 10 : 1));
  const r = S.analyzeMetric({ id: 'f', label: 'F', mode: 'sum' }, series, iso(T0 + 99 * DAY));
  near(r.value, 70);
  near(r.change, 70);
  assert.equal(r.levelPct, r.changePct);
  assert.ok(r.changePct > 99);
});

test('a record weekly drop ranks at the bottom and scores near 100', () => {
  const series = daily(300, i => (i < 299 ? 100 + Math.sin(i) : 70));
  const r = S.analyzeMetric({ id: 'x', label: 'X', mode: 'diff' }, series, iso(T0 + 299 * DAY));
  assert.equal(r.short, false);
  assert.equal(r.stale, false);
  assert.ok(r.changePct < 1, `changePct ${r.changePct}`);
  assert.ok(r.score > 97, `score ${r.score}`);
});

test('stale, missing and short-history metrics are flagged; short ones count half', () => {
  const cutoff = iso(T0 + 99 * DAY);
  const stale = S.analyzeMetric({ id: 's', label: 'S', mode: 'diff' }, daily(90, i => i), cutoff);
  assert.equal(stale.stale, true);
  const weekly = S.analyzeMetric({ id: 'w', label: 'W', mode: 'level', maxAgeDays: 9 }, daily(10, i => i * 7).map((p, i) => ({ ...p, date: iso(T0 + (i * 7 + 30) * DAY) })), cutoff);
  assert.equal(weekly.stale, false);
  assert.equal(weekly.short, true);
  near(weekly.levelPct, 100);
  near(weekly.score, 100 * 0.5);
  assert.equal(S.analyzeMetric({ id: 'm', label: 'M', mode: 'diff' }, [], cutoff).missing, true);
  // Data after the cutoff is ignored
  const future = S.analyzeMetric({ id: 'f', label: 'F', mode: 'diff' }, daily(200, i => i), iso(T0 + 150 * DAY));
  assert.equal(future.lastDate, iso(T0 + 150 * DAY));
});

test('calendar: Deribit monthly and quarterly expiries, routine 8-K, hand-kept events', () => {
  assert.equal(S.lastFriday(2026, 10), '2026-11-27');
  assert.equal(S.lastFriday(2026, 11), '2026-12-25');
  const ev = S.buildCalendar('2026-11-16', 14, [{ date: '2026-11-25', title: 'FOMC', tags: ['fomc'] }, { date: '2026-12-09', title: 'beyond', tags: [] }, { date: '2027-03-01', title: 'later', tags: [] }], { expiryShares: { '2026-11-27': 26 } });
  const exp = ev.find(e => e.date === '2026-11-27');
  assert.deepEqual(exp.tags, ['expiry']);
  assert.match(exp.title, /26%/);
  assert.ok(ev.some(e => e.title === 'FOMC'));
  assert.ok(!ev.some(e => e.title === 'later' || e.title === 'beyond'), 'only the next 14 days');
  assert.deepEqual(ev.filter(e => e.title.includes('8-K')).map(e => e.date), ['2026-11-23', '2026-11-30']);
  assert.ok(ev.filter(e => e.title.includes('8-K')).every(e => e.tags.includes('routine')));
  const dec = S.buildCalendar('2026-12-20', 10);
  assert.deepEqual(dec.find(e => e.date === '2026-12-25').tags, ['expiry', 'quarterly']);
});

test('angles: top-three mean, capped event bonus, recency penalty, red sources listed', () => {
  const m = (id, score, extra = {}) => ({ id, label: id, score, missing: false, stale: false, license: 'ok', ...extra });
  const results = [m('a', 90), m('b', 60), m('c', 30), m('d', 0), m('r', 80, { license: 'red' }), m('z', 99, { stale: true })];
  const angles = [
    { id: 'one', title: 'one', metrics: ['a', 'b', 'c', 'd'], events: ['expiry'] },
    { id: 'two', title: 'two', metrics: ['a', 'r'] },
    { id: 'thin', title: 'thin', metrics: ['z', 'd'] }
  ];
  const events = [{ date: '2026-11-27', tags: ['expiry'] }, { date: '2026-12-25', tags: ['expiry', 'quarterly'] }, { date: '2026-12-26', tags: ['expiry'] }];
  const out = S.scoreAngles(results, angles, events, [{ date: '2026-11-02', angle: 'two' }], '2026-11-16');
  assert.deepEqual(out.map(x => x.id), ['one', 'two'], 'an angle with one usable metric is skipped');
  const one = out[0];
  near(one.base, 60);
  assert.equal(one.bonus, S.EVENT_BONUS_CAP);
  assert.deepEqual(one.calm.map(x => x.id), ['d']);
  const two = out[1];
  near(two.score, 85 - S.RECENCY_PENALTY);
  assert.equal(two.recentUse, '2026-11-02');
  assert.deepEqual(two.redLicense, ['r']);
  const later = S.scoreAngles(results, angles, [], [{ date: '2026-10-01', angle: 'two' }], '2026-11-16');
  assert.equal(later.find(x => x.id === 'two').recentUse, null);
});

test('every metric an angle names is defined by the script', () => {
  const ids = new Set(cli.buildMetrics({
    tp: [], macro: [], gold: [], mc: { series: [], structure: { series: [] } }, vol: [], dealer: [], blocks: {}, cb: [], optOi: [], sec: [],
    lev: { oi: [], funding: [], etf: { rows: [] } }, ssro: [], pref: [], calendar: { events: [] }, topics: []
  }).map(m => m.def.id));
  for (const a of S.ANGLES) for (const id of a.metrics) assert.ok(ids.has(id), `${a.id} → ${id}`);
});

test('helpers: Deribit expiry codes and 8-K filings that report two periods', () => {
  assert.equal(cli.expiryDate('27NOV26'), '2026-11-27');
  assert.equal(cli.expiryDate('5JAN27'), '2027-01-05');
  assert.equal(cli.expiryDate('bad'), null);
  const sec = cli.secHoldings({
    secDocs: {
      a: { holdings: [{ asOf: '2026-09-30', holdingsBtc: 10, averageCostUsd: 1 }, { asOf: '2026-10-04', holdingsBtc: 12, averageCostUsd: 1 }], flows: [{ kind: 'atm', shares: { MSTR: 5 } }, { kind: 'repurchase', shares: { STRC: 3 } }] },
      b: { holdings: [{ asOf: '2026-09-27', holdingsBtc: 8, averageCostUsd: 1 }], flows: [] },
      c: { holdings: [], flows: [] }
    }
  });
  assert.deepEqual(sec.map(r => [r.date, r.btc, r.atm, r.rep]), [['2026-09-27', 8, 0, 0], ['2026-10-04', 12, 5, 3]]);
});

test('report from a synthetic archive names candidates, anomalies and the calendar', () => {
  const n = 200;
  const end = T0 + (n - 1) * DAY;
  const tp = Array.from({ length: n }, (_, i) => ({
    date: iso(T0 + i * DAY), btcPrice: i < n - 7 ? 60000 + 100 * Math.sin(i) : 50000, cqApr: 5 + 0.1 * Math.sin(i), nqApr: 6, tbill: 4, deribitFundingApr: 3 + Math.cos(i)
  }));
  const macro = tp.map((r, i) => ({ date: r.date, fedNetLiquidity: 5.8, yieldSpread: 0.5 + 0.01 * Math.sin(i), us1y: 4, us10y: 4.5 + 0.01 * Math.cos(i) }));
  const a = {
    tp, macro, gold: [], mc: { series: [], structure: { series: [] } }, vol: [], dealer: [], blocks: {}, cb: [], optOi: [], sec: [],
    lev: { oi: [], funding: [], etf: { rows: [] } }, ssro: [], pref: [], calendar: { events: [] }, topics: []
  };
  const out = cli.screen(a, iso(end));
  const btc = out.results.find(r => r.id === 'btc_ret');
  assert.ok(btc.changePct < 2 && btc.score > 95);
  const md = cli.buildReport(out);
  assert.match(md, /## 候选主题/);
  assert.match(md, /## 最反常的指标/);
  assert.match(md, /\| BTC 价格 \|/);
  assert.match(md, /## 未来 14 天/);
  assert.match(md, /没有数据/, 'empty archives are reported as data problems');
});
