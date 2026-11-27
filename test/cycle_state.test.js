/**
 * Module 1-E / 1-F cycle clock & activity percentiles — pure calculations, the shipped archive,
 * and an offline build with mocked Coinbase candles and a stubbed leverage_norm.
 */
process.env.SWR_BUDGET_MS = '40'; // 先回旧数据的等待上限 (server/swr.js)，须在加载模块前设置

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { installModuleMocks, srv, freshRequire, resetHealth, fakeResp, REPO_ROOT } = require('./helpers/leaf_env');
const cs = require('../server/cycle_state');

const DAY = 86400000;
const iso = ts => new Date(ts).toISOString().slice(0, 10);
const closesFrom = (start, values) => values.map((close, i) => ({ date: iso(Date.parse(start) + i * DAY), close }));

// ---------------------------------------------------------------------------
// Pure calculations
// ---------------------------------------------------------------------------

test('parseCoinbaseCandles: drops the forming UTC day, sorts, and rejects impossible bars', () => {
  const now = Date.parse('2026-01-03T12:00:00Z');
  const t = d => Date.parse(`${d}T00:00:00Z`) / 1000;
  const rows = cs.parseCoinbaseCandles([
    [t('2026-01-03'), 90, 110, 100, 105, 5],   // still forming
    [t('2026-01-02'), 95, 120, 100, 110, 7],
    [t('2026-01-01'), 90, 105, 95, 100, 6]
  ], now);
  assert.deepEqual(rows.map(r => r.date), ['2026-01-01', '2026-01-02']);
  assert.equal(rows[1].close, 110);
  assert.throws(() => cs.parseCoinbaseCandles([[t('2026-01-01'), 100, 90, 95, 95, 1]], now), /非法/);
  assert.throws(() => cs.parseCoinbaseCandles([[t('2026-01-01'), 90, 110, 100, 105, -1]], now), /非法/);
  assert.throws(() => cs.parseCoinbaseCandles({}, now), /数组/);
});

test('mergeDaily: fresh rows replace stored rows of the same date', () => {
  const out = cs.mergeDaily([{ date: '2026-01-01', close: 1 }, { date: '2026-01-02', close: 2 }], [{ date: '2026-01-02', close: 3 }, { date: '2026-01-03', close: 4 }]);
  assert.deepEqual(out.map(r => [r.date, r.close]), [['2026-01-01', 1], ['2026-01-02', 3], ['2026-01-03', 4]]);
});

test('cleanWicks: a print far below the body is cut to the body; ordinary bars are untouched', () => {
  const { rows, cleaned } = cs.cleanWicks([
    { date: 'a', open: 1173, high: 1191, low: 0.06, close: 1178 },
    { date: 'b', open: 100, high: 130, low: 70, close: 110 }
  ]);
  assert.equal(rows[0].low, 1173);
  assert.equal(rows[1].low, 70);
  assert.deepEqual(cleaned, ['a low 0.06']);
});

test('detectDrawdownEpisodes: a quick recovery is a correction, a year without one is a cycle bear', () => {
  const vals = [];
  for (let i = 0; i < 400; i++) vals.push(10 + i * 0.1);          // warm-up climb to an ATH of ~49.9
  const peak = vals[vals.length - 1];
  for (let i = 1; i <= 50; i++) vals.push(peak * (1 - 0.6 * i / 50)); // −60% in 50 days
  for (let i = 1; i <= 100; i++) vals.push(peak * 0.4 + (peak * 0.65) * i / 100); // recover above the peak
  const peak2 = vals[vals.length - 1];
  for (let i = 1; i <= 500; i++) vals.push(peak2 * (1 - 0.5 * Math.min(1, i / 100))); // −50% and stays there
  const eps = cs.detectDrawdownEpisodes(closesFrom('2015-01-01', vals));
  assert.equal(eps.length, 2);
  assert.equal(eps[0].kind, 'correction');
  assert.equal(eps[0].daysToTrough, 50);
  assert.ok(Math.abs(eps[0].maxDrawdown + 0.6) < 1e-3);
  assert.ok(eps[0].recoveryDate && eps[0].daysToRecover > 50 && eps[0].daysToRecover <= 150);
  assert.equal(eps[1].kind, 'cycle_bear');
  assert.equal(eps[1].ongoing, true);
  assert.equal(eps[1].recoveryDate, null);
  assert.equal(eps[1].daysSincePeak, 500);
  assert.equal(eps[1].path[0][1], 0, 'paths start at the peak');
});

test('detectDrawdownEpisodes: a drawdown from a peak inside the first year of data is dropped', () => {
  const vals = [10, 11, 12];
  for (let i = 0; i < 100; i++) vals.push(4);                     // −67% from a day-2 "peak"
  for (let i = 0; i < 400; i++) vals.push(13 + i * 0.01);
  assert.equal(cs.detectDrawdownEpisodes(closesFrom('2011-08-18', vals)).length, 0);
});

test('causalPercentile: compares only with the prior window and needs enough observations', () => {
  const dates = Array.from({ length: 400 }, (_, i) => iso(Date.parse('2020-01-01') + i * DAY));
  const vals = dates.map((_, i) => i);
  const p = cs.causalPercentile(dates, vals, 365, 300);
  assert.equal(p[299], null, 'not enough history yet');
  assert.equal(p[300], 100, 'a new high beats every prior day; the day itself is excluded');
  const down = cs.causalPercentile(dates, vals.map(v => -v), 365, 300);
  assert.equal(down[399], 0);
});

test('wilderAtrPct and rollingMean: constant bars give constant output after warm-up', () => {
  const rows = Array.from({ length: 30 }, () => ({ open: 100, high: 102, low: 98, close: 100 }));
  const atr = cs.wilderAtrPct(rows, 14);
  assert.equal(atr[12], null);
  assert.ok(Math.abs(atr[13] - 4) < 1e-9);
  assert.ok(Math.abs(atr[29] - 4) < 1e-9);
  const m = cs.rollingMean([1, 2, 3, null, 5, 6, 7], 3);
  assert.deepEqual(m, [null, null, 2, null, null, null, 6]);
});

// ---------------------------------------------------------------------------
// The shipped archive
// ---------------------------------------------------------------------------

test('shipped archive: the three completed cycle bears and the 2017 bad print are found', () => {
  const d = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data', 'btc_daily_history.json'), 'utf8'));
  const hist = {
    bitstamp: d.bitstamp.map(([date, close]) => ({ date, close })),
    coinbase: d.coinbase.map(([date, open, high, low, close, volume]) => ({ date, open, high, low, close, volume }))
  };
  const out = cs.buildFromHistory(hist, null);
  const bears = out.cycles.filter(e => e.kind === 'cycle_bear' && !e.ongoing);
  assert.deepEqual(bears.map(e => e.peakDate), ['2013-12-04', '2017-12-16', '2021-11-08']);
  assert.deepEqual(bears.map(e => e.troughDate), ['2015-01-14', '2018-12-15', '2022-11-21']);
  assert.ok(out.cycles.some(e => e.peakDate === '2021-04-13' && e.kind === 'correction'));
  assert.ok(!out.cycles.some(e => e.peakDate.startsWith('2011')), 'the truncated 2011 top is not a cycle');
  assert.ok(out.metadata.activity.caveats.some(t => t.includes('2017-04-15 low 0.06')));
  assert.ok(out.activity.episodes.some(e => e.start === '2019-02-10' && e.regime === 'bear_aged'));
  assert.ok(out.activity.episodes.some(e => e.start === '2018-05-02' && e.regime === 'bear_young'));
  const oi = out.activity.legs.find(l => l.key === 'oi');
  assert.equal(oi.percentile, null, 'no OI panel → no OI percentile, never a guess');
  assert.match(out.clock.headline, /最高收盘/);
});

// ---------------------------------------------------------------------------
// Offline build
// ---------------------------------------------------------------------------

const HTTP = srv('http_client.js');
const LEV = srv('leverage_norm.js');

/** Coinbase candles for whatever window is asked: a slow rise to an ATH ~600 days ago, then −50% */
function coinbase(holder) {
  const ath = Date.parse(iso(Date.now() - 600 * DAY));
  const priceAt = ms => {
    const d = (ms - ath) / DAY;
    return d <= 0 ? 100 * Math.exp(d / 900) : 100 * (1 - 0.5 * Math.min(1, d / 120));
  };
  return async (url) => {
    if (holder.state.down) return fakeResp({}, { ok: false, status: 503 });
    const m = /start=([^&]+)&end=([^&]+)/.exec(url);
    if (!m || !url.includes('api.exchange.coinbase.com')) throw new Error('unexpected url ' + url);
    holder.calls = (holder.calls || 0) + 1;
    const out = [];
    for (let t = Date.parse(decodeURIComponent(m[1])); t <= Date.parse(decodeURIComponent(m[2])); t += DAY) {
      const c = priceAt(t);
      out.push([t / 1000, c * 0.98, c * 1.02, c, c, 1000 + (t / DAY) % 50]);
    }
    return fakeResp(out.reverse());
  };
}

function levStub(holder) {
  return {
    getLeverageNormData: async () => {
      if (holder.state.oiDown) throw new Error('CoinGlass down');
      const rows = [];
      for (let i = 800; i >= 1; i--) rows.push({ date: iso(Date.now() - i * DAY), futOiBtc: 500000 + i * 10 });
      return { oi: rows };
    }
  };
}

test('offline build: archive bootstraps from Coinbase, OI outage degrades only the OI leg, Coinbase outage serves the cache', async (t) => {
  resetHealth();
  const holder = { state: {} };
  const { tmpDir } = installModuleMocks(t, { [HTTP]: { fetchWithTimeout: coinbase(holder) }, [LEV]: levStub(holder) });
  const mod = freshRequire('cycle_state.js');

  const r1 = await mod.getCycleStateData(true);
  assert.equal(r1.dataHealth.analysisAllowed, true);
  assert.equal(r1.freshness.spotLatest, iso(Date.now() - DAY), 'the forming day is never stored');
  assert.ok(holder.calls >= 10, 'an empty archive pages back to 2015-07-20');
  const stored = JSON.parse(fs.readFileSync(path.join(tmpDir, 'btc_daily_history.json'), 'utf8'));
  assert.equal(stored.coinbase[0][0], '2015-07-20');
  assert.equal(r1.clock.currentKind, 'cycle_bear');
  assert.ok(Math.abs(r1.clock.drawdown + 0.5) < 0.01);
  assert.equal(r1.oiError, null);
  assert.ok(r1.activity.legs.find(l => l.key === 'oi').percentile != null);

  // A second build only asks Coinbase for the days after the archive
  holder.calls = 0;
  const r2 = await mod.getCycleStateData(true);
  assert.ok(holder.calls <= 1, 'incremental update');
  assert.equal(r2.freshness.spotLatest, r1.freshness.spotLatest);

  // OI outage: the build still succeeds and reuses the previous OI series
  holder.state = { oiDown: true };
  const r3 = await mod.getCycleStateData(true);
  assert.match(r3.oiError, /CoinGlass/);
  assert.equal(r3.dataHealth.analysisAllowed, true);
  assert.ok(r3.activity.legs.find(l => l.key === 'oi').percentile != null, 'previous OI series reused');

  // Coinbase outage with a stale archive: the last good build is served and flagged
  const histFile = path.join(tmpDir, 'btc_daily_history.json');
  const h = JSON.parse(fs.readFileSync(histFile, 'utf8'));
  h.coinbase = h.coinbase.slice(0, -10);
  fs.writeFileSync(histFile, JSON.stringify(h));
  holder.state = { down: true };
  const r4 = await mod.getCycleStateData(true);
  assert.equal(r4.stale, true);
  assert.notEqual(r4.dataHealth.state, 'OK');
});
