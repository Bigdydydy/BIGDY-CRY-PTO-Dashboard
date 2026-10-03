const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateLegPnLBTC, calculatePortfolioPnLBTC, generatePnLCurve, parseInstrument, legTheo, evaluatePortfolio, generatePnLView, impliedCarry, MS_PER_DAY } = require('../public/pnl_engine.js');

test('Single Long Call PnL in BTC standard', () => {
  const leg = { instrument: 'BTC-26DEC26-80000-C', strike: 80000, price: 0.05, amount: 10, direction: 'buy', isCall: true };
  // S = 80,000 (ATM): PnL = (0 - 0.05) * 10 = -0.5 BTC
  const pnlAtm = calculateLegPnLBTC(leg, 80000);
  assert.equal(pnlAtm, -0.5);

  // S = 160,000: Payoff = 1 - 80000/160000 = 0.5. Net = 0.5 - 0.05 = 0.45. Total = 4.5 BTC
  const pnlItm = calculateLegPnLBTC(leg, 160000);
  assert.equal(Math.round(pnlItm * 100) / 100, 4.5);

  // S = 40,000 (OTM): PnL = -0.5 BTC
  const pnlOtm = calculateLegPnLBTC(leg, 40000);
  assert.equal(pnlOtm, -0.5);
});

test('Single Long Put PnL in BTC standard (Nonlinear Inverse Curvature)', () => {
  const leg = { instrument: 'BTC-26DEC26-80000-P', strike: 80000, price: 0.05, amount: 1, direction: 'buy', isCall: false };
  // S = 80,000: PnL = -0.05 BTC
  assert.equal(calculateLegPnLBTC(leg, 80000), -0.05);

  // S = 40,000: Payoff = 80000/40000 - 1 = 1.0 BTC. Net = 1.0 - 0.05 = 0.95 BTC
  assert.equal(Math.round(calculateLegPnLBTC(leg, 40000) * 100) / 100, 0.95);

  // S = 20,000: Payoff = 80000/20000 - 1 = 3.0 BTC. Net = 3.0 - 0.05 = 2.95 BTC (Hyperbolic expansion!)
  assert.equal(Math.round(calculateLegPnLBTC(leg, 20000) * 100) / 100, 2.95);
});

test('Bull Call Spread PnL Curve & Breakeven Point', () => {
  const legs = [
    { instrument: 'BTC-26DEC26-80000-C', strike: 80000, price: 0.06, amount: 10, direction: 'buy', isCall: true },
    { instrument: 'BTC-26DEC26-90000-C', strike: 90000, price: 0.02, amount: 10, direction: 'sell', isCall: true }
  ];
  // Net premium paid: (-0.06 + 0.02) * 10 = -0.4 BTC
  const res = generatePnLCurve(legs, 85000);
  assert.equal(Math.round(res.initialCashFlowBTC * 100) / 100, -0.4);
  assert.ok(res.series.length > 50);
  // There should be exactly 1 breakeven point between 80,000 and 90,000
  assert.equal(res.breakevens.length, 1);
  assert.ok(res.breakevens[0] > 80000 && res.breakevens[0] < 90000);
});

test('Iron Condor 4-leg bounded payoff profile', () => {
  const legs = [
    { instrument: 'BTC-26DEC26-70000-P', strike: 70000, price: 0.01, amount: 20, direction: 'buy', isCall: false },
    { instrument: 'BTC-26DEC26-75000-P', strike: 75000, price: 0.03, amount: 20, direction: 'sell', isCall: false },
    { instrument: 'BTC-26DEC26-90000-C', strike: 90000, price: 0.03, amount: 20, direction: 'sell', isCall: true },
    { instrument: 'BTC-26DEC26-95000-C', strike: 95000, price: 0.01, amount: 20, direction: 'buy', isCall: true }
  ];
  const res = generatePnLCurve(legs, 82000);
  assert.ok(res.initialCashFlowBTC > 0); // Net credit collector (+0.8 BTC)
  assert.equal(res.isProfitCapped, true);
  assert.equal(res.isLossCapped, true);
  // Breakevens detected
  assert.ok(res.breakevens.length >= 2);
  assert.ok(res.breakevens.includes(72116) || res.breakevens.some(b => Math.abs(b - 72116) < 100));
});

test('Bear Put Spread Payoff (BTC Standard)', () => {
  const legs = [
    { instrument: 'BTC-26DEC26-90000-P', strike: 90000, price: 0.08, amount: 5, direction: 'buy', isCall: false },
    { instrument: 'BTC-26DEC26-80000-P', strike: 80000, price: 0.03, amount: 5, direction: 'sell', isCall: false }
  ];
  // Net debit paid: (-0.08 + 0.03) * 5 = -0.25 BTC
  const res = generatePnLCurve(legs, 85000);
  assert.equal(Math.round(res.initialCashFlowBTC * 100) / 100, -0.25);
  assert.equal(res.isLossCapped, true);
  assert.equal(res.breakevens.length, 1);
  assert.ok(res.breakevens[0] > 80000 && res.breakevens[0] < 90000);
});

test('Net short call spread: loss bounded in BTC, worst case is the S -> infinity limit', () => {
  const legs = [
    { instrument: 'BTC-30OCT26-90000-C', strike: 90000, price: 0.03, amount: 10, direction: 'buy', isCall: true },
    { instrument: 'BTC-30OCT26-95000-C', strike: 95000, price: 0.015, amount: 30, direction: 'sell', isCall: true }
  ];
  const res = generatePnLCurve(legs, 85000);
  // Calls only: payoff caps at 1 BTC per contract, so neither side diverges in BTC terms
  assert.equal(res.isProfitCapped, true);
  assert.equal(res.isLossCapped, true);
  // S -> infinity: 10 * (1 - 0.03) - 30 * (1 - 0.015) = 9.7 - 29.55 = -19.85 BTC
  assert.equal(Math.round(res.pnlAtInfinity * 100) / 100, -19.85);
  assert.equal(Math.round(res.minPnl * 100) / 100, -19.85);
});

test('Net long / short puts flag unbounded profit / loss as S -> 0', () => {
  const longPut = generatePnLCurve([{ instrument: 'BTC-30OCT26-80000-P', strike: 80000, price: 0.02, amount: 5, direction: 'buy', isCall: false }], 85000);
  assert.equal(longPut.isProfitCapped, false);
  assert.equal(longPut.isLossCapped, true);
  const shortPut = generatePnLCurve([{ instrument: 'BTC-30OCT26-80000-P', strike: 80000, price: 0.02, amount: 5, direction: 'sell', isCall: false }], 85000);
  assert.equal(shortPut.isProfitCapped, true);
  assert.equal(shortPut.isLossCapped, false);
});

test('parseInstrument reads Deribit option names (08:00 UTC expiry)', () => {
  assert.deepEqual(parseInstrument('BTC-30OCT26-100000-C'), {
    currency: 'BTC', expiryMs: Date.UTC(2026, 9, 30, 8), strike: 100000, isCall: true
  });
  assert.equal(parseInstrument('BTC-3OCT26-85000-P').expiryMs, Date.UTC(2026, 9, 3, 8));
  assert.equal(parseInstrument('BTC-3OCT26-85000-P').isCall, false);
  assert.equal(parseInstrument('[30OCT26] 空头组合'), null);
});

test('legTheo: inverse Black-Scholes value, parity and expiry limit', () => {
  const now = Date.UTC(2026, 0, 1, 8);
  const expiryMs = now + 365 * MS_PER_DAY;
  // ATM, sigma 50%, T = 1y: C/S = N(0.25) - N(-0.25) = 0.19741
  const call = legTheo({ strike: 100000, isCall: true, iv: 50, expiryMs }, 100000, now);
  assert.ok(Math.abs(call.valueBtc - 0.19741) < 1e-4);
  assert.ok(Math.abs(call.delta - 0.5987) < 1e-3);
  // Put-call parity in BTC terms: C - P = 1 - K/S
  const S = 90000;
  const c = legTheo({ strike: 100000, isCall: true, iv: 60, expiryMs }, S, now).valueBtc;
  const p = legTheo({ strike: 100000, isCall: false, iv: 60, expiryMs }, S, now).valueBtc;
  assert.ok(Math.abs((c - p) - (1 - 100000 / S)) < 1e-6);
  // At / after expiry the value is intrinsic and Greeks other than delta vanish
  const atExp = legTheo({ strike: 80000, isCall: true, iv: 50, expiryMs }, 160000, expiryMs);
  assert.equal(atExp.valueBtc, 0.5);
  assert.equal(atExp.delta, 1);
  assert.equal(atExp.vegaUsd, 0);
  // IV shift is relative: +100% doubles IV
  assert.ok(Math.abs(legTheo({ strike: 100000, isCall: true, iv: 25, expiryMs }, 100000, now, 100).valueBtc - call.valueBtc) < 1e-9);
});

test('legTheo with forward carry reproduces a Deribit mark price', () => {
  // Deribit BTC-30OCT26-100000-C snapshot: index 84553.93, expiry forward 84910.52, mark IV 37.76, mark 0.0026601
  const now = 1791004279032;
  const expiryMs = Date.UTC(2026, 9, 30, 8);
  const carry = impliedCarry(84910.52, 84553.93, expiryMs, now);
  const leg = { strike: 100000, isCall: true, iv: 37.76, expiryMs, carry };
  assert.ok(Math.abs(legTheo(leg, 84553.93, now).valueBtc - 0.0026601) < 2e-6);
  // Without the basis the index-only model under-prices this OTM call by ~9%
  assert.ok(legTheo({ ...leg, carry: 0 }, 84553.93, now).valueBtc < 0.00245);
  // The basis is gone at expiry: payoff back to max(1 - K/S, 0) on the index
  assert.equal(legTheo(leg, 125000, expiryMs).valueBtc, 1 - 100000 / 125000);
  assert.equal(impliedCarry(84910.52, 84553.93, expiryMs, expiryMs), 0);
});

test('evaluatePortfolio aggregates position PnL and Greeks with direction signs', () => {
  const now = Date.UTC(2026, 0, 1, 8);
  const expiryMs = now + 30 * MS_PER_DAY;
  const legs = [
    { strike: 90000, isCall: true, iv: 40, expiryMs, price: 0.03, amount: 10, direction: 'buy' },
    { strike: 90000, isCall: true, iv: 40, expiryMs, price: 0.03, amount: 10, direction: 'sell' }
  ];
  const res = evaluatePortfolio(legs, 88000, now);
  assert.ok(Math.abs(res.pnlBtc) < 1e-12);
  assert.ok(Math.abs(res.totals.delta) < 1e-12);
  assert.ok(Math.abs(res.totals.vegaUsd) < 1e-9);
  assert.ok(res.legs[0].posVegaUsd > 0 && res.legs[1].posVegaUsd < 0);
});

test('generatePnLView: simulated curve converges to expiry curve, long option keeps time value before it', () => {
  const now = Date.UTC(2026, 9, 3, 4);
  const legs = [{ instrument: 'BTC-30OCT26-90000-C', strike: 90000, isCall: true, iv: 40, price: 0.02, amount: 10, direction: 'buy',
    expiryMs: parseInstrument('BTC-30OCT26-90000-C').expiryMs }];
  const today = generatePnLView(legs, { spotPrice: 85000, nowMs: now, evalMs: now });
  assert.ok(Math.abs(today.maxDays - (Date.UTC(2026, 9, 30, 8) - now) / MS_PER_DAY) < 1e-9);
  assert.ok(today.series.every(p => p.simBtc >= p.expBtc - 1e-9));
  assert.equal(today.breakevens.length, 1);
  // Matches the pure terminal payoff curve for a single-expiry position
  const terminal = generatePnLCurve(legs, 85000);
  assert.deepEqual(today.breakevens, terminal.breakevens);

  const atExpiry = generatePnLView(legs, { spotPrice: 85000, nowMs: now, evalMs: now + 999 * MS_PER_DAY });
  assert.equal(atExpiry.evalMs, today.nearestExpiryMs); // clamped
  assert.ok(atExpiry.series.every(p => Math.abs(p.simBtc - p.expBtc) < 1e-12));
});

test('generatePnLView: expired legs settle at intrinsic, multi-expiry expiry curve uses nearest expiry', () => {
  const now = Date.UTC(2026, 9, 3, 4);
  const legs = [
    { instrument: 'BTC-25SEP26-85000-C', strike: 85000, isCall: true, iv: 40, price: 0.02, amount: 1, direction: 'sell', expiryMs: Date.UTC(2026, 8, 25, 8) },
    { instrument: 'BTC-30OCT26-95000-C', strike: 95000, isCall: true, iv: 40, price: 0.01, amount: 1, direction: 'buy', expiryMs: Date.UTC(2026, 9, 30, 8) },
    { instrument: 'BTC-27NOV26-95000-C', strike: 95000, isCall: true, iv: 40, price: 0.02, amount: 1, direction: 'sell', expiryMs: Date.UTC(2026, 10, 27, 8) }
  ];
  const view = generatePnLView(legs, { spotPrice: 85000, nowMs: now });
  assert.equal(view.nearestExpiryMs, Date.UTC(2026, 9, 30, 8));
  const S = 100000;
  const pt = view.series.find(p => p.S === S) || view.series.reduce((a, b) => Math.abs(b.S - S) < Math.abs(a.S - S) ? b : a);
  const expected = evaluatePortfolio(legs, pt.S, view.nearestExpiryMs).pnlBtc;
  assert.ok(Math.abs(pt.expBtc - expected) < 1e-12);
  // The Nov leg still carries time value at the Oct expiry, so the curve differs from pure intrinsic
  assert.ok(Math.abs(pt.expBtc - calculatePortfolioPnLBTC(legs, pt.S)) > 1e-4);
});

test('PnL HTML Modal Decoupling & Structure Integrity', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  // Must have dedicated independent pnl-modal-backdrop
  assert.ok(html.includes('id="pnl-modal-backdrop"'), 'Must have dedicated #pnl-modal-backdrop');
  assert.ok(html.includes('id="pnl-chart-container"'), 'Must have #pnl-chart-container');
  assert.ok(html.includes('id="btn-close-pnl-modal"'), 'Must have #btn-close-pnl-modal');
  assert.ok(html.includes('src="/pnl_engine.js"'), 'Must include /pnl_engine.js script tag');
  assert.ok(html.includes('<th>收益模拟</th>'), 'Must have 收益模拟 column header in whale table');

  // Must NOT nest pnl-modal-backdrop inside trade-modal-backdrop
  const tradeModalIdx = html.indexOf('id="trade-modal-backdrop"');
  const tradeModalCloseIdx = html.indexOf('</div> <!-- /#trade-modal-backdrop -->');
  const pnlModalIdx = html.indexOf('id="pnl-modal-backdrop"');

  assert.ok(tradeModalIdx > 0 && tradeModalCloseIdx > tradeModalIdx);
  assert.ok(pnlModalIdx > tradeModalCloseIdx, 'pnl-modal-backdrop must be strictly separated and declared outside trade-modal-backdrop');
});
