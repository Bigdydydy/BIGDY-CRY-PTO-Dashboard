/**
 * Module 2-D leverage normalization — pure calculations plus an offline build
 * with mocked CoinGlass / Yahoo payloads and a temp data dir.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { installModuleMocks, srv, freshRequire, resetHealth, fakeResp } = require('./helpers/leaf_env');
const lev = require('../server/leverage_norm');

const DAY = 86400000;
const HOUR = 3600000;
const iso = ts => new Date(ts).toISOString().slice(0, 10);
const midnight = ts => Date.parse(iso(ts));
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

/** CoinGlass-style venue payload over `dates` (ms); values[venue] is a function of the day index */
function venuePayload(dates, values, price = 80000) {
  const dataMap = {};
  for (const [venue, fn] of Object.entries(values)) dataMap[venue] = dates.map((_, i) => fn(i));
  return { dateList: dates, dataMap, priceList: dates.map(() => price) };
}

// ---------------------------------------------------------------------------
// Open interest
// ---------------------------------------------------------------------------

test('chainLink: a venue entering coverage moves the raw sum but not the chained series', () => {
  const rows = [
    { date: '2026-01-01', venues: { A: 100, B: 50 } },
    { date: '2026-01-02', venues: { A: 110, B: 55 } },
    { date: '2026-01-03', venues: { A: 110, B: 55, C: 300 } }, // C enters coverage
    { date: '2026-01-04', venues: { A: 121, B: 60.5, C: 330 } }
  ];
  const out = lev.chainLink(rows);
  assert.equal(out[2].raw, 465);
  assert.equal(out[3].chained, out[3].raw, 'anchored on the latest raw total');
  // Day 2 → day 3 common venues are flat, so the entry day is not growth
  assert.ok(near(out[2].chained, out[3].chained / 1.1));
  assert.ok(near(out[1].chained, out[2].chained));
  assert.ok(near(out[0].chained / out[1].chained, 150 / 165));
  // A venue gap (missing for a day) is excluded from both sides of that day's growth
  const gap = lev.chainLink([
    { date: 'd1', venues: { A: 100, B: 100 } },
    { date: 'd2', venues: { A: 100 } },
    { date: 'd3', venues: { A: 100, B: 100 } }
  ]);
  assert.deepEqual(gap.map(r => r.chained), [200, 200, 200]);
  // Venue filter: CME excluded from the perpetual proxy
  const perp = lev.chainLink(rows, v => v !== 'C');
  assert.equal(perp[3].raw, 181.5);
});

test('parseVenuePayload: last observation of a date wins; malformed payloads are rejected', () => {
  const now = Date.now();
  const d0 = midnight(now) - DAY;
  const p = venuePayload([d0, midnight(now), now - 1000], { A: i => [1, 2, 3][i] });
  const rows = lev.parseVenuePayload(p, 't', now);
  assert.equal(rows.length, 2, 'the intraday point replaces the same-date 00:00 point');
  assert.equal(rows[1].venues.A, 3);
  assert.throws(() => lev.parseVenuePayload(venuePayload([d0], { A: () => -1 }), 't', now), /非法值/);
  assert.throws(() => lev.parseVenuePayload(venuePayload([d0], { A: () => NaN }), 't', now), /非法值/);
  assert.throws(() => lev.parseVenuePayload(venuePayload([d0, d0], { A: () => 1 }), 't', now), /递增/);
  assert.throws(() => lev.parseVenuePayload(venuePayload([now + DAY], { A: () => 1 }), 't', now), /未来/);
  assert.throws(() => lev.parseVenuePayload({ dateList: [d0], dataMap: { A: [1, 2] } }, 't', now), /长度/);
});

test('buildOiPanel: ex-CME perpetual proxy, BTC-terms ratio, venue shares and the 90-day mean', () => {
  const end = midnight(Date.now()) - DAY;
  const dates = Array.from({ length: 100 }, (_, i) => end - (99 - i) * DAY);
  const panel = lev.buildOiPanel({
    futUsd: venuePayload(dates, { Binance: () => 6e9, CME: () => 2e9, Hyperliquid: () => 2e9 }),
    futBtc: venuePayload(dates, { Binance: () => 75000, CME: () => 25000, Hyperliquid: () => 25000 }),
    optUsd: venuePayload(dates, { Deribit: () => 8e9 }),
    optBtc: venuePayload(dates, { Deribit: i => (i % 2 ? 100000 : 50000) })
  });
  const last = panel[panel.length - 1];
  assert.equal(last.futOiUsd, 1e10);
  assert.equal(last.perpOiUsd, 8e9, 'CME is not a perpetual venue');
  assert.equal(last.cmeShare, 0.2);
  assert.equal(last.hyperliquidShare, 0.2);
  assert.ok(near(last.optFutRatio, 100000 / 125000, 1e-3));
  assert.equal(panel[58].optFutRatio90d, null, 'fewer than 60 observations');
  assert.ok(near(last.optFutRatio90d, 0.6, 1e-2), 'saw-tooth averages out');
});

// ---------------------------------------------------------------------------
// Funding premium
// ---------------------------------------------------------------------------

test('funding premium: open bar skipped, 00:00 settlement closes the prior day, 90% coverage gate', () => {
  const now = midnight(Date.now()) + 6 * HOUR;
  const start = midnight(now) - 40 * DAY;
  const bars = [];
  for (let t = start; t <= now; t += 8 * HOUR) bars.push({ data: [t / 1000, '0', '0', '0', '0.01'] });
  const rows = lev.parseFundingBars(bars, now);
  assert.ok(rows.every(r => r.fundingTime <= now), 'still-accruing bar is not settled');
  assert.equal(rows[0].rate, 0.0001);

  const oiPanel = Array.from({ length: 45 }, (_, i) => ({ date: iso(start + (i - 2) * DAY), perpOiUsd: 1e10 }));
  const prem = lev.buildFundingPremium(rows, oiPanel, now);
  assert.ok(prem.every(r => r.date < iso(now)), 'the current UTC day is incomplete and left out');
  const last = prem[prem.length - 1];
  assert.ok(near(last.fundingUsd, 3e6));
  assert.ok(near(last.premium30dUsd, 30 * 3e6));
  assert.ok(near(last.fundingApr30d, 0.0001 * 3 * 365 * 100, 1e-3));
  assert.equal(prem[5].premium30dUsd, null, 'window not yet covered');

  // Negative funding streak drives the shorts-pay headline
  const neg = lev.summarizeFunding([
    { date: '2026-05-01', premium30dUsd: 5e7, fundingApr30d: 1 },
    { date: '2026-05-02', premium30dUsd: -1e7, fundingApr30d: -0.2 },
    { date: '2026-05-03', premium30dUsd: -2e7, fundingApr30d: -0.4 }
  ]);
  assert.equal(neg.longsPay, false);
  assert.equal(neg.streakDays, 2);
  assert.match(neg.headline, /空头向多头净付 \$20M/);
  assert.deepEqual(neg.min, { date: '2026-05-03', value: -2e7 });
});

// ---------------------------------------------------------------------------
// ETF flow / volume
// ---------------------------------------------------------------------------

test('ETF turnover: 20-session ratio over funds with known volume; missing core volume skips the day', () => {
  const dates = Array.from({ length: 25 }, (_, i) => iso(Date.parse('2026-03-02') + i * DAY));
  const flows = lev.parseEtfFlows(dates.map(d => ({
    date: Date.parse(d),
    list: [
      { ticker: 'IBIT', changeUsd: 1e8 }, { ticker: 'FBTC', changeUsd: null },
      { ticker: 'GBTC', changeUsd: -5e7 }, { ticker: 'ARKB', changeUsd: 1e7 }
    ]
  })));
  const vol = v => new Map(dates.map(d => [d, v]));
  const volumes = { IBIT: vol(1e9), FBTC: vol(5e8), GBTC: vol(5e8) }; // ARKB volume unavailable
  volumes.FBTC.delete(dates[3]);
  const rows = lev.buildEtfTurnover(flows, volumes);
  assert.equal(rows.length, 24, 'the day missing core FBTC volume is skipped');
  assert.equal(rows[18].ratio20, null);
  const last = rows[rows.length - 1];
  assert.equal(last.flowUsd, 5e7, 'ARKB flow is dropped together with its missing volume');
  assert.equal(last.ratio20, 0.025);

  const s = lev.summarizeEtf(rows);
  assert.equal(s.regime, 'TURNOVER');
  assert.match(s.headline, /以换手为主/);
  assert.equal(lev.summarizeEtf([{ date: 'x', ratio20: 0.08, flow20Usd: 1 }]).regime, 'INFLOW');
  assert.equal(lev.summarizeEtf([{ date: 'x', ratio20: -0.2, flow20Usd: 1 }]).regime, 'OUTFLOW');
  assert.throws(() => lev.parseEtfFlows([{ date: 1, list: [{ ticker: 'IBIT', changeUsd: 'abc' }] }]), /changeUsd/);
});

test('summarizeOi splits the 30-day USD change into position change and price effect', () => {
  const rows = [];
  const end = Date.parse('2026-06-30');
  for (let i = 400; i >= 0; i--) {
    const date = iso(end - i * DAY);
    const recent = i < 30;
    rows.push({ date, futOiUsd: recent ? 90 : 100, futOiBtc: recent ? 1020 : 1000, futVenues: 20, cmeShare: 0.2, hyperliquidShare: 0.05 });
  }
  const s = lev.summarizeOi(rows);
  assert.ok(near(s.usd30, -0.1));
  assert.ok(near(s.btc30, 0.02));
  assert.ok(near((1 + s.btc30) * (1 + s.priceEffect30) - 1, s.usd30));
  assert.equal(s.trend, '持仓基本持平');
});

// ---------------------------------------------------------------------------
// Offline build: mocked upstreams, temp data dir
// ---------------------------------------------------------------------------

const HTTP = srv('http_client.js');
const ETF_TICKERS = ['IBIT', 'FBTC', 'GBTC', 'ARKB'];

function upstream(holder) {
  const now = Date.now();
  const end = midnight(now) - DAY;
  const days = Array.from({ length: 120 }, (_, i) => end - (119 - i) * DAY);
  const dates = [...days, now - 60000];
  const hl = i => (i >= 60 ? 3e9 : null); // Hyperliquid enters coverage on day 60
  const futUsd = venuePayload(dates, { Binance: () => 1e10, CME: () => 5e9, Hyperliquid: hl });
  const futBtc = venuePayload(dates, { Binance: () => 125000, CME: () => 62500, Hyperliquid: i => (hl(i) == null ? null : 37500) });
  const optUsd = venuePayload(days, { Deribit: () => 3e10 });
  const optBtc = venuePayload(days, { Deribit: () => 375000 });
  const bars = [];
  for (let t = days[0]; t <= now; t += 8 * HOUR) bars.push({ data: [t / 1000, '0', '0', '0', '0.01'] });
  const weekdays = days.slice(-60).filter(t => ![0, 6].includes(new Date(t).getUTCDay()));
  const flows = weekdays.map(t => ({
    date: t,
    list: [
      { ticker: 'IBIT', changeUsd: 1e8 }, { ticker: 'FBTC', changeUsd: 0 },
      { ticker: 'GBTC', changeUsd: -5e7 }, { ticker: 'ARKB', changeUsd: 1e7 }
    ]
  }));
  const yahoo = () => ({
    chart: { result: [{
      timestamp: weekdays.map(t => (t + 14.5 * HOUR) / 1000),
      indicators: { quote: [{ close: weekdays.map(() => 50), volume: weekdays.map(() => 1e7) }] }
    }] }
  });
  return async (url) => {
    const s = holder.state;
    if (url.includes('/api/openInterest/v3/chart')) {
      if (s.badOi) return fakeResp({ code: 0, data: { dateList: [1], dataMap: { A: [-5] } } });
      return fakeResp({ code: 0, data: url.includes('currency=COIN') ? futBtc : futUsd });
    }
    if (url.includes('/api/option/oi/history')) return fakeResp({ code: 0, data: url.includes('currency=COIN') ? optBtc : optUsd });
    if (url.includes('/api/priceAndIndicator')) return fakeResp({ code: 0, data: bars });
    if (url.includes('/api/etf/flow')) return fakeResp({ code: 0, data: flows });
    const m = /finance\/chart\/([A-Z]+)/.exec(url);
    if (m && ETF_TICKERS.includes(m[1])) {
      if ((s.yahooDown || []).includes(m[1])) return fakeResp({}, { ok: false, status: 429 });
      return fakeResp(yahoo());
    }
    throw new Error('unexpected url ' + url);
  };
}

test('offline build: good → small-fund volume gap → core ETF gap keeps OI/funding → OI malformed serves cache', async (t) => {
  resetHealth();
  const holder = { state: {} };
  const { tmpDir } = installModuleMocks(t, { [HTTP]: { fetchWithTimeout: upstream(holder) } });
  delete require.cache[srv('cdri_fetcher.js')];
  const mod = freshRequire('leverage_norm.js');
  const cacheFile = path.join(tmpDir, 'leverage_norm.json');

  const r1 = await mod.getLeverageNormData(true);
  assert.equal(r1.dataHealth.state, 'OK');
  assert.equal(r1.dataHealth.analysisAllowed, true);
  const first = r1.oi[0];
  const last = r1.oi[r1.oi.length - 1];
  assert.equal(first.futOiUsdRaw, 1.5e10);
  assert.equal(first.futOiUsd, 1.8e10, 'chain-linked history carries the latest coverage');
  assert.equal(last.futOiUsd, 1.8e10);
  assert.equal(last.perpOiUsd, 1.3e10);
  assert.ok(near(r1.summary.funding.premium30dUsd, 30 * 3 * 1.3e6));
  assert.equal(r1.summary.etf.ratio20, 0.03, '(1e8 − 5e7 + 1e7) / (4 × $500M)');
  assert.deepEqual(r1.etf.tickers.missing, []);
  const goodBytes = fs.readFileSync(cacheFile);

  // A small fund without volume is dropped from both sides and flagged
  holder.state = { yahooDown: ['ARKB'] };
  const r2 = await mod.getLeverageNormData(true);
  assert.ok(near(r2.summary.etf.ratio20, 5e7 / 1.5e9, 1e-3));
  assert.deepEqual(r2.etf.tickers.missing, ['ARKB']);
  assert.equal(r2.ancillarySources.etf_volume.state, 'FALLBACK');
  assert.equal(r2.dataHealth.state, 'DEGRADED');
  assert.equal(r2.dataHealth.analysisAllowed, true, 'the ETF panel never gates OI / funding');

  // A core fund without volume fails the ETF leg; the previous ETF panel is kept and flagged
  holder.state = { yahooDown: ['IBIT'] };
  const r3 = await mod.getLeverageNormData(true);
  assert.match(r3.etfError, /IBIT/);
  assert.equal(r3.etf.stale, true);
  assert.equal(r3.dataHealth.analysisAllowed, true);
  assert.ok(r3.summary.funding && r3.summary.oi);

  // Malformed OI fails the build: the last good disk file is served and left untouched
  holder.state = { badOi: true };
  const before = fs.readFileSync(cacheFile);
  const r4 = await mod.getLeverageNormData(true);
  assert.equal(r4.stale, true);
  assert.notEqual(r4.dataHealth.state, 'OK');
  assert.deepEqual(fs.readFileSync(cacheFile), before);
  assert.ok(goodBytes.length > 0);
});
