const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateLegPnLBTC, calculatePortfolioPnLBTC, generatePnLCurve } = require('../public/pnl_engine.js');

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
  assert.equal(res.isCappedUpside, true);
  assert.equal(res.isCappedDownside, true);
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
  assert.equal(res.isCappedDownside, true);
  assert.equal(res.breakevens.length, 1);
  assert.ok(res.breakevens[0] > 80000 && res.breakevens[0] < 90000);
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
