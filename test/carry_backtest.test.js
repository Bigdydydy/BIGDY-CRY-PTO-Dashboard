/**
 * Cash-and-carry backtest engine (server/carry_backtest.js) on synthetic term-structure records:
 * locked basis at delivery, execution lag, T-Bill publication lag, fee model, unmarked final week,
 * perp funding accrual and the report builder.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const bt = require('../server/carry_backtest');
const { buildReport } = require('../scripts/carry_backtest');

const DAY = 86400000;
const T0 = Date.UTC(2025, 0, 1, 8);
const ZERO = { spotFeeBps: 0, futFeeBps: 0, perpFeeBps: 0, slipBps: 0, settleBps: 0 };
const near = (a, b, tol = 1e-9, msg = '') => {
  if (typeof tol === 'string') [tol, msg] = [1e-9, tol];
  assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b} ${msg}`);
};

/**
 * Daily records shaped like data/term_premium_history.json. Quarterly expiries fall every 91 days
 * starting `firstExpiry` days after T0; the front one loses its mark inside its final week.
 */
function gen(n, {
  firstExpiry = 30,
  apr = () => 10,          // (expiryTs, i) → annualized basis %
  price = () => 100000,
  tbill = () => 0,
  funding = () => 10,
  funding24h = () => 10,
  score = () => 50
} = {}) {
  const expiries = Array.from({ length: 20 }, (_, k) => T0 + (firstExpiry + 91 * k) * DAY);
  return Array.from({ length: n }, (_, i) => {
    const ts = T0 + i * DAY;
    const [cq, nq] = expiries.filter(e => e > ts);
    const cqDays = (cq - ts) / DAY;
    const cqValid = cqDays >= 7;
    return {
      date: new Date(ts).toISOString().slice(0, 10),
      timestamp: ts,
      btcPrice: price(i),
      cqApr: cqValid ? apr(cq, i) : null,
      cqDays,
      cqValid,
      nqApr: apr(nq, i),
      nqDays: (nq - ts) / DAY,
      tbill: tbill(i),
      fundingApr: funding(i),
      fundingApr24h: funding24h(i),
      carryScore: score(i)
    };
  });
}

const E1 = T0 + 30 * DAY;
const E2 = T0 + 121 * DAY;

test('legs and dollar basis are recovered from the stored annualized basis', () => {
  const [row] = gen(1, { price: () => 80000 });
  const legs = bt.legsOf(row);
  assert.deepEqual(legs.map(l => l.tenor), ['CQ', 'NQ']);
  assert.equal(legs[0].expiryTs, E1);
  assert.equal(bt.contractName(E1), 'BTC-31JAN25');
  near(bt.basisUsdAt(row, E1), 80000 * 0.10 * 30 / 365);
  assert.equal(bt.basisUsdAt(row, T0 - DAY), 0, 'expired contract has converged');
  assert.equal(bt.basisUsdAt(row, T0 + 999 * DAY), null, 'unknown contract has no mark');
});

test('held to delivery the trade earns exactly the entry basis, whatever spot does', () => {
  // Spot whipsaws; CQ trades at 10% annualized, NQ at 9%. Only CQ clears the 9.5% gate.
  const rows = gen(40, {
    price: i => 100000 * (1 + 0.3 * Math.sin(i)),
    apr: exp => (exp === E1 ? 10 : 9)
  });
  const res = bt.runQuarterly(rows, bt.hurdleRule(9.5, null), { lag: 0, costs: ZERO });
  assert.equal(res.trades.length, 1);
  const t = res.trades[0];
  assert.deepEqual(t.contracts, ['BTC-31JAN25']);
  assert.equal(t.exitDate, '2025-01-31');
  near(res.daily[30].equity, 1 + 0.10 * 30 / 365);
  near(res.daily[39].equity, res.daily[30].equity, 'flat in cash at a 0% T-Bill afterwards');
});

test('a signal on day d is executed at day d + lag prices', () => {
  const rows = gen(40, { apr: exp => (exp === E1 ? 10 : 9) });
  const res = bt.runQuarterly(rows, bt.hurdleRule(9.5, null), { costs: ZERO }); // default lag = 1
  assert.equal(res.trades[0].entryDate, rows[1].date);
  near(res.daily[30].equity, 1 + 0.10 * 29 / 365);
});

test('decisions see the previous day T-Bill (FRED publishes after the 08:00 UTC snapshot)', () => {
  const rows = gen(40, { tbill: i => (i === 0 ? 20 : 0) });
  assert.equal(bt.decisionTbill(rows, 0), 20);
  assert.equal(bt.decisionTbill(rows, 1), 20);
  assert.equal(bt.decisionTbill(rows, 2), 0);
  const res = bt.runQuarterly(rows, bt.hurdleRule(5, null), { lag: 0, costs: ZERO });
  assert.equal(res.trades[0].entryDate, rows[2].date);
});

test('the front contract is carried unmarked through its final week and booked at delivery', () => {
  const rows = gen(40, { apr: (exp, i) => 10 + i, price: i => 100000 + 500 * i });
  const res = bt.runQuarterly(rows, bt.hurdleRule(-1000, null), { lag: 0, costs: ZERO });
  // Day 23 → 7 days left (last mark); days 24..29 have no CQ mark
  for (let i = 24; i < 30; i++) near(res.daily[i].equity, res.daily[23].equity);
  // Opened at day 0 in CQ (equal APRs, zero costs: the first listed leg wins the tie)
  const qty = 1 / rows[0].btcPrice;
  const b0 = rows[0].btcPrice * 0.10 * 30 / 365;
  near(res.daily[30].equity, 1 + qty * b0, 1e-9);
});

test('fees: entry pays spot + futures, delivery pays settlement, exit from delivery pays spot only', () => {
  const costs = { spotFeeBps: 10, futFeeBps: 5, perpFeeBps: 0, slipBps: 1, settleBps: 2.5 };
  // Net of the 12 bp futures round trip: CQ 12 − 1.46 = 10.54 clears 9.5, NQ 9 − 0.36 does not
  const rows = gen(40, { apr: exp => (exp === E1 ? 12 : 9) });
  const res = bt.runQuarterly(rows, bt.hurdleRule(9.5, null), { lag: 0, costs });
  let eq = 1 - (10 + 5 + 2) / 1e4;
  near(res.daily[0].equity, eq);
  const qty = eq / 100000;
  eq += qty * 100000 * 0.12 * 30 / 365;
  eq -= qty * 100000 * 2.5 / 1e4;
  eq -= eq * (10 + 1) / 1e4;
  near(res.daily[30].equity, eq);
});

test('rolling at delivery keeps the spot leg and only pays the new futures leg', () => {
  const costs = { spotFeeBps: 10, futFeeBps: 5, perpFeeBps: 0, slipBps: 0, settleBps: 0 };
  // CQ 12% beats NQ 10% even after amortizing the round trip over its shorter life; at the roll
  // E2 (10%) beats the next quarterly (8%)
  const rows = gen(40, { apr: exp => (exp === E1 ? 12 : exp === E2 ? 10 : 8) });
  const res = bt.runQuarterly(rows, bt.ALWAYS_QUARTERLY, { lag: 0, costs });
  const t = res.trades[0];
  assert.deepEqual(t.contracts, ['BTC-31JAN25', 'BTC-2MAY25']);
  assert.ok(t.open);
  const beforeRoll = 1 - 15 / 1e4 + (1 - 15 / 1e4) * 0.12 * 30 / 365;
  // After the roll the new contract is marked at the same price, so equity only moved by the fee
  near(res.daily[30].equity, beforeRoll * (1 - 5 / 1e4));
});

test('early exit switches into a better contract instead of going to cash', () => {
  // CQ starts at 12% and collapses to 1%; NQ stays at 8%. Exit rule: remaining < T-Bill (0) + 2%.
  const rows = gen(40, { apr: (exp, i) => (exp === E1 ? (i < 10 ? 12 : 1) : 8) });
  const res = bt.runQuarterly(rows, bt.hurdleRule(5, 2), { lag: 0, costs: ZERO });
  assert.deepEqual(res.trades[0].contracts, ['BTC-31JAN25', 'BTC-2MAY25']);
  // CQ basis fell from 12% to 1% annualized → mark-to-market gain booked at the switch
  const b0 = 0.12 * 30 / 365;
  const b10 = 0.01 * 20 / 365;
  near(res.daily[10].equity, 1 + b0 - b10);
});

test('perp carry earns realized 24h funding only while positioned', () => {
  const rows = gen(10, { funding: i => (i < 5 ? 20 : -1), funding24h: () => 36.5 });
  const res = bt.runPerp(rows, bt.perpRule(5, 0), { costs: ZERO }); // lag 1
  assert.equal(res.trades[0].entryDate, rows[1].date);
  assert.equal(res.trades[0].exitDate, rows[6].date);
  near(res.daily[1].equity, 1);
  near(res.daily[2].equity, 1.001);
  near(res.daily[6].equity, 1.001 ** 5);
  near(res.daily[9].equity, 1.001 ** 5, 'flat afterwards at a 0% T-Bill');
});

test('metrics: drawdown, exposure and excess over cash', () => {
  const daily = [1, 1.02, 0.99, 1.0, 1.05].map((equity, i) => ({
    date: new Date(T0 + i * DAY).toISOString().slice(0, 10), ts: T0 + i * DAY, equity, held: i > 0 && i < 3, cashRet: i ? 0.0001 : 0
  }));
  const m = bt.metrics({ daily, trades: [] });
  near(m.maxDrawdownPct, (0.99 / 1.02 - 1) * 100);
  near(m.exposurePct, 50);
  near(m.totalReturnPct, 5);
  assert.ok(m.sharpe > 0);
  const cash = bt.metrics(bt.runCash(gen(366, { tbill: () => 5 })));
  near(cash.cagrPct, ((1 + 0.05 / 365) ** 365 - 1) * 100, 1e-6);
  assert.equal(cash.sharpe, null);
});

test('yearly returns chain across calendar years', () => {
  const rows = gen(400, { tbill: () => 5 });
  const years = bt.yearlyReturns(bt.runCash(rows));
  assert.deepEqual(years.map(y => y.year), ['2025', '2026']);
  near(years[0].returnPct, years[0].cashPct);
  assert.equal(years[1].partial, true);
});

test('report builds from a synthetic archive', () => {
  const rows = gen(500, { apr: (exp, i) => 6 + 4 * Math.sin(i / 40), tbill: () => 4, funding: i => 5 + 6 * Math.cos(i / 30) });
  const { md, json } = buildReport({ file: 'synthetic', rows });
  assert.match(md, /## 主结果/);
  assert.match(md, /## 门槛敏感性/);
  assert.equal(json.strategies.length, 8);
  assert.equal(json.grid.length, 10);
  assert.ok(json.strategies.every(s => Number.isFinite(s.metrics.cagrPct)));
});
