const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { identifyInstitutionalStrategy } = require('../server/analytics_engine');
const PnLEngine = require('../public/pnl_engine');

// 详情卡的收益边界必须与 PV 到期曲线同源：同一组腿，两边给出同一组数字。
const NOW = Date.UTC(2026, 9, 20);
const leg = (instrument, direction, amount, price, indexPrice, iv = 50) => ({ instrument, direction, amount, price, indexPrice, iv });

function pvOf(legs, spot) {
  const pvLegs = legs.map(l => {
    const inst = PnLEngine.parseInstrument(l.instrument);
    return { ...l, strike: inst.strike, isCall: inst.isCall, expiryMs: inst.expiryMs };
  });
  return PnLEngine.generatePnLView(pvLegs, { spotPrice: spot, nowMs: NOW, numPoints: 240 });
}

function assertSameBounds(legs, spot) {
  const { riskProfile } = identifyInstitutionalStrategy(legs, 0, 0, 0, 1e7);
  const b = riskProfile.bounds;
  const pv = pvOf(legs, spot);
  assert.equal(b.isProfitCapped, pv.isProfitCapped);
  assert.equal(b.isLossCapped, pv.isLossCapped);
  if (pv.isProfitCapped) assert.ok(Math.abs(b.maxPnlBtc - pv.maxPnl) < 1e-9, `max ${b.maxPnlBtc} vs PV ${pv.maxPnl}`);
  if (pv.isLossCapped) assert.ok(Math.abs(b.minPnlBtc - pv.minPnl) < 1e-9, `min ${b.minPnlBtc} vs PV ${pv.minPnl}`);
  assert.deepEqual(b.breakevens, pv.breakevens);
  return riskProfile;
}

describe('收益边界：详情与 PV 同源', () => {
  test('对称蝶式：最大盈利按到期结算价 K2 折算，而非当前现货', () => {
    const S = 95000;
    const legs = [
      leg('BTC-25DEC26-90000-C', 'buy', 10, 0.12, S),
      leg('BTC-25DEC26-100000-C', 'sell', 20, 0.07, S),
      leg('BTC-25DEC26-110000-C', 'buy', 10, 0.035, S)
    ];
    const rp = assertSameBounds(legs, S);
    // ((100k - 90k) / 100k - 0.015) * 10 = 0.85 BTC；旧实现用 10k / 95k 得到 0.90
    assert.ok(Math.abs(rp.bounds.maxPnlBtc - 0.85) < 1e-9);
    assert.ok(rp.maxProfit.includes('+0.850 BTC @ $100,000'));
    assert.ok(rp.maxLoss.includes('S ≤ $90,000 或 S ≥ $110,000'));
  });

  test('多张买入看涨：上限是组合净收益 Σq·(1 - P)，不是每张 1 BTC', () => {
    const legs = [leg('BTC-25DEC26-100000-C', 'buy', 10, 0.05, 100000)];
    const rp = assertSameBounds(legs, 100000);
    assert.ok(Math.abs(rp.bounds.maxPnlBtc - 9.5) < 1e-9);
    assert.equal(rp.bounds.maxPnlAt, Infinity);
    assert.ok(rp.maxLoss.includes('-0.500 BTC (S ≤ $100,000)'));
  });

  test('盈亏平衡点二分到整数美元：K / (1 - P) 与 K / (1 + P)', () => {
    assert.deepEqual(assertSameBounds([leg('BTC-25DEC26-100000-C', 'buy', 1, 0.05, 100000)], 100000).bounds.breakevens, [105263]);
    assert.deepEqual(assertSameBounds([leg('BTC-25DEC26-80000-P', 'buy', 1, 0.04, 85000)], 85000).bounds.breakevens, [76923]);
  });

  test('跨期结构：按最近到期估值并在文案中注明', () => {
    const legs = [
      leg('BTC-25DEC26-100000-C', 'sell', 1, 0.04, 85000),
      leg('BTC-26MAR27-100000-C', 'buy', 1, 0.08, 85000)
    ];
    const { riskProfile } = identifyInstitutionalStrategy(legs, 0, 0, 0, 1e6);
    assert.ok(riskProfile.maxProfit.includes('按最近到期 2026-12-25 估值'));
    assert.equal(riskProfile.bounds.evalExpiryMs, Date.UTC(2026, 11, 25, 8));
  });

  test('随机同到期结构：详情边界与 PV 完全一致', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const strikes = [70000, 80000, 90000, 100000, 110000, 120000];
    for (let n = 0; n < 60; n++) {
      const S = 80000 + Math.round(rnd() * 30000);
      const k = 1 + Math.floor(rnd() * 4);
      const legs = Array.from({ length: k }, () => {
        const K = strikes[Math.floor(rnd() * strikes.length)];
        const cp = rnd() < 0.5 ? 'C' : 'P';
        return leg(`BTC-25DEC26-${K}-${cp}`, rnd() < 0.5 ? 'buy' : 'sell', 1 + Math.floor(rnd() * 20), Number((0.005 + rnd() * 0.15).toFixed(4)), S);
      });
      assertSameBounds(legs, S);
    }
  });
});
