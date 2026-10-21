const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  CONVENTION_SIGN,
  black76,
  contractsFromMarks,
  evaluateBook,
  spotSlide,
  expiryRollOff,
  stressMatrix,
  analyzeDealerExposure
} = require('../server/dealer_engine');
const { compactBookSummary } = require('../server/option_marks');

const NOW = Date.UTC(2026, 9, 20, 6, 0, 0); // 2026-10-20 06:00 UTC
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b}`);
const mark = (iv, F, oi) => ({ markIv: iv, markPrice: 0.01, underlyingPrice: F, openInterest: oi });

describe('dealer_engine · Black-76 Greeks', () => {
  const F = 80000;
  const K = 84000;
  const T = 30 / 365;
  const s = 0.4;

  test('Put-Call 平价：C − P = F − K (r = 0)', () => {
    const c = black76(F, K, T, s, true);
    const p = black76(F, K, T, s, false);
    close(c.price - p.price, F - K, 1e-6);
    close(c.delta - p.delta, 1, 1e-12, 'Δc − Δp');
  });

  test('Delta / Gamma / Vanna / Charm 与有限差分一致', () => {
    const g = black76(F, K, T, s, true);
    const h = 1;
    close(g.delta, (black76(F + h, K, T, s, true).price - black76(F - h, K, T, s, true).price) / (2 * h), 1e-4, 'delta');
    close(g.gamma, (black76(F + h, K, T, s, true).delta - black76(F - h, K, T, s, true).delta) / (2 * h), 1e-8, 'gamma');
    const ds = 1e-4;
    close(g.vanna, (black76(F, K, T, s + ds, true).delta - black76(F, K, T, s - ds, true).delta) / (2 * ds), 1e-3, 'vanna');
    // charm 为日历时间流逝方向：dΔ/dt = −∂Δ/∂T
    const dT = 1e-5;
    close(g.charm, -(black76(F, K, T + dT, s, true).delta - black76(F, K, T - dT, s, true).delta) / (2 * dT), 1e-2, 'charm');
    const gp = black76(F, K, T, s, false);
    close(gp.charm, g.charm, 1e-12, 'Call 与 Put 的 charm 相同');
    close(gp.vanna, g.vanna, 1e-12, 'Call 与 Put 的 vanna 相同');
  });
});

describe('dealer_engine · 合约解析与惯例符号', () => {
  test('剔除已到期、无 OI、非法 IV/远期与非法合约名，Call +1 / Put −1', () => {
    const contracts = contractsFromMarks({
      'BTC-30OCT26-80000-C': mark(40, 80000, 10),
      'BTC-30OCT26-80000-P': mark(42, 80000, 5),
      'BTC-19OCT26-80000-C': mark(40, 80000, 10), // 已于 10-19 08:00 交割
      'BTC-30OCT26-90000-C': mark(40, 80000, 0),
      'BTC-30OCT26-70000-P': mark(0, 80000, 3),
      'BTC-PERPETUAL': mark(40, 80000, 1)
    }, NOW);
    assert.deepEqual(contracts.map(c => [c.name, c.sign]), [['BTC-30OCT26-80000-C', 1], ['BTC-30OCT26-80000-P', -1]]);
    assert.equal(CONVENTION_SIGN.call, 1);
    assert.equal(CONVENTION_SIGN.put, -1);
    close(contracts[0].T, (Date.UTC(2026, 9, 30, 8) - NOW) / (365 * 86400000), 1e-12, 'T');
  });

  test('evaluateBook 按 OI × 符号聚合，GEX 为现货 +1% 的 Delta 变化', () => {
    const [c] = contractsFromMarks({ 'BTC-30OCT26-84000-C': mark(40, 80000, 10) }, NOW);
    const book = evaluateBook([c]);
    const g = black76(80000, 84000, c.T, 0.4, true);
    close(book.delta, 10 * g.delta, 1e-9);
    close(book.gamma1pct, 10 * g.gamma * 80000 * 0.01, 1e-9);
    close(book.vannaPt, 10 * g.vanna * 0.01, 1e-12);
    close(book.charmDay, 10 * g.charm / 365, 1e-12);
    // GEX 的含义：全链重估现货 +1% 后的 Delta 变化 ≈ gamma1pct
    const up = evaluateBook([c], { spotMult: 1.001 });
    close((up.delta - book.delta) * 10, book.gamma1pct, book.gamma1pct * 0.01, '1% 对应 10×0.1% 的变化');
  });

  test('同行权价 Call 多 + Put 空 = 合成多头：Delta ≈ OI、无 Gamma/Vanna/Charm', () => {
    const contracts = contractsFromMarks({
      'BTC-30OCT26-80000-C': mark(40, 80000, 7),
      'BTC-30OCT26-80000-P': mark(40, 80000, 7)
    }, NOW);
    const book = evaluateBook(contracts);
    close(book.delta, 7, 1e-9);
    close(book.gamma1pct, 0, 1e-9);
    close(book.vannaPt, 0, 1e-12);
    close(book.charmDay, 0, 1e-12);
  });
});

describe('dealer_engine · 现货滑动翻转位', () => {
  // 惯例口径：下方 Put (做市商空) 贡献负 Gamma，上方 Call (做市商多) 贡献正 Gamma
  const contracts = contractsFromMarks({
    'BTC-30OCT26-72000-P': mark(45, 80000, 100),
    'BTC-30OCT26-88000-C': mark(40, 80000, 100)
  }, NOW);

  test('网格 + 二分求出的翻转位处 GEX ≈ 0，两侧符号与 from/to 一致', () => {
    const { gammaFlip, flips, curve } = spotSlide(contracts, 80000);
    assert.equal(flips.length, 1);
    assert.equal(gammaFlip.from, -1);
    assert.equal(gammaFlip.to, 1);
    assert.ok(gammaFlip.price > 72000 && gammaFlip.price < 88000);
    const mult = gammaFlip.price / 80000;
    const atFlip = evaluateBook(contracts, { spotMult: mult }).gamma1pct;
    const scale = Math.max(...curve.map(p => Math.abs(p.gexUsd))) / (80000 * mult);
    assert.ok(Math.abs(atFlip) < scale * 1e-3, `翻转位处 GEX ${atFlip}`);
    assert.equal(curve.length, 41);
    assert.ok(evaluateBook(contracts, { spotMult: mult * 0.98 }).gamma1pct < 0);
    assert.ok(evaluateBook(contracts, { spotMult: mult * 1.02 }).gamma1pct > 0);
  });

  test('±20% 内不变号时没有翻转位', () => {
    const callsOnly = contractsFromMarks({ 'BTC-30OCT26-80000-C': mark(40, 80000, 10) }, NOW);
    assert.equal(spotSlide(callsOnly, 80000).gammaFlip, null);
  });
});

describe('dealer_engine · 到期脱落与压力矩阵', () => {
  const marks = {
    'BTC-21OCT26-80000-C': mark(40, 80000, 10),  // 周三：日度
    'BTC-23OCT26-80000-C': mark(40, 80000, 20),  // 周五：周度
    'BTC-30OCT26-80000-P': mark(40, 80000, 30),  // 10 月最后一个周五：月度
    'BTC-25DEC26-80000-C': mark(40, 80000, 40)   // 12 月最后一个周五：季度
  };
  const contracts = contractsFromMarks(marks, NOW);

  test('到期按日期排序，识别日度/周度/月度/季度，OI 占比合计 100%，解除对冲量 = 该到期做市商 Delta', () => {
    const { totalOiBtc, expiries } = expiryRollOff(contracts, 80000, NOW);
    assert.equal(totalOiBtc, 100);
    assert.deepEqual(expiries.map(e => [e.expiry, e.kind]), [['21OCT26', '日度'], ['23OCT26', '周度'], ['30OCT26', '月度'], ['25DEC26', '季度']]);
    close(expiries.reduce((a, e) => a + e.oiShare, 0), 100, 0.11);
    for (const e of expiries) assert.equal(e.rollOffFlowUsd, e.dealerDeltaUsd);
    assert.ok(expiries[2].dealerDeltaUsd > 0, '做市商空 Put 的 Delta 为正');
  });

  test('正 Gamma 组合：现货上涨时做市商卖出；一阶分解与全链重估在小幅变动下接近', () => {
    const calls = contractsFromMarks({ 'BTC-25DEC26-80000-C': mark(40, 80000, 100) }, NOW);
    const base = evaluateBook(calls);
    const stress = stressMatrix(calls, 80000, base);
    const up = stress.find(s => s.key === 'spot_up');
    const down = stress.find(s => s.key === 'spot_down');
    assert.ok(up.flowUsd < 0 && down.flowUsd > 0);
    close(up.flowUsd, up.approx.gammaUsd, Math.abs(up.approx.gammaUsd) * 0.1, '3% 内一阶近似误差 < 10%');
    assert.equal(up.approx.vannaUsd === 0 || Object.is(up.approx.vannaUsd, -0), true);
  });

  test('时间情景中到期的合约视为已交割，其对冲解除计入对冲流', () => {
    const now = Date.UTC(2026, 9, 21, 0, 0, 0); // 21OCT26 只剩 8 小时
    const book = contractsFromMarks({ 'BTC-21OCT26-78000-C': mark(40, 80000, 10) }, now);
    const base = evaluateBook(book);
    const decay = stressMatrix(book, 80000, base).find(s => s.key === 'decay');
    close(decay.flowBtc, base.delta, 1e-9, '过 1 天后全部交割：对冲流 = +原 Delta');
  });
});

describe('dealer_engine · analyzeDealerExposure 输出', () => {
  const strikes = [70000, 74000, 78000, 80000, 82000, 86000, 90000];
  const marks = {};
  for (const K of strikes) {
    marks[`BTC-30OCT26-${K}-C`] = mark(40, 80200, 50);
    marks[`BTC-30OCT26-${K}-P`] = mark(44, 80200, 30);
    marks[`BTC-23OCT26-${K}-P`] = mark(46, 80100, 20);
  }
  const snapshot = { indexPrice: 80000, marks, timestamp: NOW - 5000, stale: true };

  test('输出敞口、翻转位、到期、压力情景与惯例口径披露', () => {
    const r = analyzeDealerExposure(snapshot, { now: NOW, gexReference: { totalAllGexM: -5 } });
    assert.equal(r.status, 'ok');
    assert.equal(r.convention, 'dealer_long_calls_short_puts');
    assert.equal(r.stale, true);
    assert.equal(r.contractCount, 21);
    assert.equal(r.totalOiBtc, 700);
    assert.equal(r.stress.length, 6);
    assert.equal(r.expiries.length, 2);
    close(r.exposures.syntheticForwardBtc, 30 * strikes.length, 1e-9, '每个行权价配对 min(50, 30)');
    close(r.exposures.hedgeUsd, -r.exposures.dexUsd, 1e-6);
    assert.ok(r.paragraph.includes('【惯例口径】'));
    assert.ok(r.paragraph.includes('合成多头'));
    assert.ok(r.paragraph.includes('全曲面平移'));
    if (r.exposures.gexUsd > 0) assert.ok(r.paragraph.includes('方向相反'));
    assert.ok(!r.paragraph.includes('+$-'));
  });

  test('缺指数价或可算合约太少时返回 insufficient_data', () => {
    assert.equal(analyzeDealerExposure({ marks }, { now: NOW }).status, 'insufficient_data');
    assert.equal(analyzeDealerExposure({ indexPrice: 80000, marks: { 'BTC-30OCT26-80000-C': mark(40, 80000, 1) } }, { now: NOW }).status, 'insufficient_data');
  });

  test('option_marks 压缩快照带上 OI，可直接喂给引擎', () => {
    const snap = compactBookSummary([
      { instrument_name: 'BTC-30OCT26-80000-C', mark_iv: 40, mark_price: 0.03, underlying_price: 80200, estimated_delivery_price: 80000, open_interest: 12.5 }
    ]);
    assert.equal(snap.marks['BTC-30OCT26-80000-C'].openInterest, 12.5);
    assert.equal(snap.indexPrice, 80000);
  });
});

describe('dealer_engine · 持仓符号敏感性', () => {
  const { applyBlockFlow, flipThreshold, signSensitivity } = require('../server/dealer_engine');
  const SPOT = 80000;

  test('翻号阈值：把阈值比例的 Call Gamma 改划为客户买入后净 GEX 归零', () => {
    const book = contractsFromMarks({
      'BTC-30OCT26-84000-C': mark(40, 80000, 120),
      'BTC-30OCT26-90000-C': mark(42, 80000, 80),
      'BTC-30OCT26-76000-P': mark(45, 80000, 60)
    }, NOW);
    const th = flipThreshold(book, SPOT);
    assert.equal(th.side, 'call');
    assert.ok(th.sharePct > 0 && th.sharePct < 100);
    const share = th.sharePct / 100;
    const shifted = [];
    for (const c of book) {
      if (c.isCall) {
        shifted.push({ ...c, oi: c.oi * share, sign: -1 });
        shifted.push({ ...c, oi: c.oi * (1 - share) });
      } else {
        shifted.push(c);
      }
    }
    const before = evaluateBook(book).gamma1pct;
    const after = evaluateBook(shifted).gamma1pct;
    assert.ok(Math.abs(after) < Math.abs(before) * 0.01, `改划后 ${after} 应接近 0 (改划前 ${before})`);
    close(th.netShareOfGrossPct, (th.callGammaUsd - th.putGammaUsd) / (th.callGammaUsd + th.putGammaUsd) * 100, 0.1);
  });

  test('只有 Put 时各口径同号，判为稳健；无大宗数据时省略大宗口径', () => {
    const puts = contractsFromMarks({
      'BTC-30OCT26-76000-P': mark(45, 80000, 60),
      'BTC-30OCT26-72000-P': mark(48, 80000, 40)
    }, NOW);
    const sens = signSensitivity(puts, SPOT, {});
    assert.deepEqual(sens.scenarios.map(s => s.key), ['convention', 'otm_call_bought']);
    assert.ok(sens.scenarios.every(s => s.gexUsd < 0));
    assert.equal(sens.robust, true);
    assert.equal(sens.coverage, null);
    assert.equal(sens.threshold.side, 'put');
    assert.equal(sens.threshold.sharePct, 50, '只有 Put 时，一半 Put Gamma 改划为做市商多头即归零');
  });

  test('虚值 Call 主导 Gamma 时，改划虚值 Call 会让净 GEX 变号，判为不稳健', () => {
    const book = contractsFromMarks({
      'BTC-30OCT26-84000-C': mark(40, 80000, 200),
      'BTC-30OCT26-76000-P': mark(45, 80000, 60)
    }, NOW);
    const sens = signSensitivity(book, SPOT, {});
    const conv = sens.scenarios.find(s => s.key === 'convention');
    const otm = sens.scenarios.find(s => s.key === 'otm_call_bought');
    assert.ok(conv.gexUsd > 0 && otm.gexUsd < 0);
    assert.equal(sens.robust, false);
  });

  test('大宗校正：覆盖量封顶 OI，覆盖部分取客户方向的反面，统计覆盖率与一致率', () => {
    const book = contractsFromMarks({
      'BTC-30OCT26-84000-C': mark(40, 80000, 3),
      'BTC-30OCT26-76000-P': mark(45, 80000, 10)
    }, NOW);
    const trades = [
      { instrument_name: 'BTC-30OCT26-84000-C', direction: 'buy', amount: 4 },
      { instrument_name: 'BTC-30OCT26-84000-C', direction: 'buy', amount: 1 },
      { instrument_name: 'BTC-30OCT26-76000-P', direction: 'sell', amount: 2 },
      { instrument_name: 'BTC-30OCT26-76000-P', direction: 'hold', amount: 9 },
      { instrument_name: 'BTC-30OCT26-76000-P', direction: 'buy', amount: 0 }
    ];
    const { contracts, coverage } = applyBlockFlow(book, trades, SPOT);
    const pick = (name, sign) => contracts.filter(c => c.name === name && c.sign === sign).reduce((a, c) => a + c.oi, 0);
    assert.equal(pick('BTC-30OCT26-84000-C', -1), 3, '客户净买 5 张，封顶为 OI 3 张，做市商空');
    assert.equal(pick('BTC-30OCT26-84000-C', 1), 0);
    assert.equal(pick('BTC-30OCT26-76000-P', 1), 2, '客户净卖 2 张 Put，做市商多');
    assert.equal(pick('BTC-30OCT26-76000-P', -1), 8, '其余 8 张沿用惯例');
    assert.equal(coverage.tradeCount, 3);
    assert.equal(coverage.oiShare, Number((5 / 13 * 100).toFixed(1)));
    assert.equal(coverage.agreeShare, 0, '两处覆盖都与惯例相反');
    assert.equal(coverage.netCallBtc, 5);
    assert.equal(coverage.netPutBtc, -2);
  });

  test('analyzeDealerExposure 输出三种口径，结论变号时叙述与字段都标为不稳健', () => {
    const marks = {};
    for (const K of [80000, 82000, 84000, 86000, 88000, 90000]) marks[`BTC-30OCT26-${K}-C`] = mark(40, 80000, 60);
    for (const K of [70000, 72000, 74000, 76000]) marks[`BTC-30OCT26-${K}-P`] = mark(46, 80000, 30);
    const trades = [{ instrument_name: 'BTC-30OCT26-84000-C', direction: 'buy', amount: 40 }];
    const r = analyzeDealerExposure({ indexPrice: 80000, marks }, { now: NOW, blockTrades: trades });
    assert.deepEqual(r.sensitivity.scenarios.map(s => s.key), ['convention', 'otm_call_bought', 'block_adjusted']);
    assert.equal(r.robust, false);
    assert.ok(r.paragraph.includes('【结论不稳健'));
    assert.ok(r.paragraph.includes('【符号敏感性】'));
    assert.ok(r.paragraph.includes('翻号'));
    assert.ok(r.sensitivity.coverage.tradeCount === 1);
  });
});

describe('dealer_engine · 全成交校正与屏幕折扣敏感性', () => {
  const { applyFlowLedger, signSensitivity, SCREEN_WEIGHTS } = require('../server/dealer_engine');
  const SPOT = 80000;
  const book = contractsFromMarks({
    'BTC-30OCT26-84000-C': mark(40, 80000, 10),
    'BTC-30OCT26-76000-P': mark(45, 80000, 20),
    'BTC-30OCT26-90000-C': mark(42, 80000, 5)
  }, NOW);
  // [screenNet, blockNet, liqNet, screenGross, blockGross, liqGross, trades]
  const ledger = {
    syncedThrough: NOW - 3600000,
    instruments: {
      'BTC-30OCT26-84000-C': [8, 6, 0, 40, 6, 0, 12],   // 客户净买 14 > OI 10：超出封顶
      'BTC-30OCT26-76000-P': [-6, 2, -1, 30, 10, 1, 9]   // 客户净卖 5：做市商多 5 张 Put
    }
  };

  test('覆盖量封顶 OI、符号取客户方向反面，统计封顶自检、成交构成与未入账 OI', () => {
    const { contracts, coverage } = applyFlowLedger(book, ledger, SPOT, 1, NOW);
    const oiOf = (name, sign) => contracts.filter(c => c.name === name && c.sign === sign).reduce((a, c) => a + c.oi, 0);
    assert.equal(oiOf('BTC-30OCT26-84000-C', -1), 10);
    assert.equal(oiOf('BTC-30OCT26-84000-C', 1), 0);
    assert.equal(oiOf('BTC-30OCT26-76000-P', 1), 5);
    assert.equal(oiOf('BTC-30OCT26-76000-P', -1), 15);
    assert.equal(oiOf('BTC-30OCT26-90000-C', 1), 5, '台账没有的合约沿用惯例');
    assert.equal(coverage.source, 'ledger');
    assert.equal(coverage.oiShare, Number((15 / 35 * 100).toFixed(1)));
    assert.equal(coverage.noLedgerOiShare, Number((5 / 35 * 100).toFixed(1)));
    assert.equal(coverage.agreeShare, 0);
    assert.equal(coverage.capCheck.flowInstruments, 2);
    assert.equal(coverage.capCheck.overCapInstruments, 1);
    assert.equal(coverage.capCheck.overshootPct, Number((4 / 19 * 100).toFixed(1)));
    assert.deepEqual(coverage.volumeMix, { screen: Number((70 / 87 * 100).toFixed(1)), block: Number((16 / 87 * 100).toFixed(1)), liq: Number((1 / 87 * 100).toFixed(1)) });
    assert.equal(coverage.stale, false);
    assert.equal(applyFlowLedger(book, { ...ledger, syncedThrough: NOW - 4 * 86400000 }, SPOT, 1, NOW).coverage.stale, true);
  });

  test('折扣系数 0 时只信大宗与强平', () => {
    const { contracts } = applyFlowLedger(book, ledger, SPOT, 0, NOW);
    const oiOf = (name, sign) => contracts.filter(c => c.name === name && c.sign === sign).reduce((a, c) => a + c.oi, 0);
    assert.equal(oiOf('BTC-30OCT26-84000-C', -1), 6, '只剩大宗净买 6 张');
    // 大宗 +2 与强平 −1 合计客户净买 1 张 → 做市商空 1 张，与惯例同号，加上其余 19 张惯例共 20 张
    assert.equal(oiOf('BTC-30OCT26-76000-P', -1), 20);
    assert.ok(contracts.some(c => c.name === 'BTC-30OCT26-76000-P' && c.oi === 1 && c.sign === -1));
  });

  test('有台账时给出全成交校正与 5 档折扣敏感性，无台账时退回大宗校正', () => {
    const sens = signSensitivity(book, SPOT, { ledger, blockTrades: [{ instrument_name: 'BTC-30OCT26-84000-C', direction: 'buy', amount: 1 }], now: NOW });
    assert.deepEqual(sens.scenarios.map(s => s.key), ['convention', 'otm_call_bought', 'flow_adjusted']);
    assert.deepEqual(sens.screenWeights.map(w => w.screenWeight), SCREEN_WEIGHTS);
    assert.equal(sens.coverage.source, 'ledger');
    assert.equal(typeof sens.flowRobust, 'boolean');
    close(sens.screenWeights.at(-1).gexUsd, sens.scenarios[2].gexUsd, 1e-6, '折扣 1 即全成交校正');

    const fallback = signSensitivity(book, SPOT, { ledger: { instruments: {} }, blockTrades: [{ instrument_name: 'BTC-30OCT26-84000-C', direction: 'buy', amount: 1 }], now: NOW });
    assert.deepEqual(fallback.scenarios.map(s => s.key), ['convention', 'otm_call_bought', 'block_adjusted']);
    assert.equal(fallback.coverage.source, 'block_trades');
    assert.deepEqual(fallback.screenWeights, []);
    assert.equal(fallback.flowRobust, null);
  });

  test('analyzeDealerExposure 叙述包含封顶自检与折扣系数区间', () => {
    const marks = {};
    for (const K of [72000, 76000, 80000, 84000, 88000]) {
      marks[`BTC-30OCT26-${K}-C`] = mark(40, 80000, 20);
      marks[`BTC-30OCT26-${K}-P`] = mark(45, 80000, 20);
    }
    const r = analyzeDealerExposure({ indexPrice: 80000, marks }, { now: NOW, flowLedger: ledger });
    assert.ok(r.paragraph.includes('OI 封顶自检'));
    assert.ok(r.paragraph.includes('屏幕成交折扣系数从 0'));
    assert.equal(r.sensitivity.screenWeights.length, 5);
  });
});

describe('dealer_engine · 5 档期限矩阵、深度尾部行权价 OI、全链墙与交割断崖模拟', () => {
  const { strikeWalls, maturityStructure, postExpiryCliff } = require('../server/dealer_engine');
  const SPOT = 80000;
  const marks = {
    'BTC-23OCT26-78000-P': mark(45, 80000, 40),   // 3d (<2w)
    'BTC-30OCT26-90000-C': mark(40, 80200, 120),  // 10d (<2w, 月度主力)
    'BTC-30OCT26-50000-P': mark(60, 80200, 80),   // 10d (<2w, 深虚值 Put <= 0.75F)
    'BTC-27NOV26-100000-C': mark(42, 80800, 60),  // 38d (2–6w)
    'BTC-25DEC26-70000-P': mark(44, 81500, 100),  // 66d (6–10w, 季度)
    'BTC-26MAR27-140000-C': mark(48, 83000, 90),  // 157d (>16w, 深虚值 Call >= 1.50F)
    'BTC-26MAR27-60000-P': mark(52, 83000, 50)    // 157d (>16w, 深虚值 Put <= 0.75F)
  };
  const contracts = contractsFromMarks(marks, NOW);

  test('strikeWalls 提取全链与主力交割 Call Wall / Put Wall', () => {
    const w = strikeWalls(contracts, SPOT, '30OCT26');
    assert.equal(w.callWall.strike, 90000);
    assert.equal(w.callWall.oiBtc, 120);
    assert.equal(w.putWall.strike, 70000);
    assert.equal(w.putWall.oiBtc, 100);
    assert.equal(w.nextMajorCallWall.strike, 90000);
    assert.equal(w.nextMajorPutWall.strike, 50000);
  });

  test('maturityStructure 输出 5 档期限分布、Call:Put 比与深度尾部 OI 占比', () => {
    const mat = maturityStructure(contracts, SPOT, NOW);
    assert.equal(mat.buckets.length, 5);
    assert.equal(mat.buckets[0].key, 'lt2w');
    assert.equal(mat.buckets[0].totalOiBtc, 240);
    assert.equal(mat.buckets[4].key, 'gt16w');
    assert.equal(mat.buckets[4].totalOiBtc, 140);
    assert.equal(mat.chainCallOiBtc, 270);
    assert.equal(mat.chainPutOiBtc, 270);
    assert.equal(mat.chainCallPutRatio, 1);
    assert.equal(mat.tailWings.deepPutOiBtc, 130); // 50k Put (80) + 60k Put (50)
    assert.equal(mat.tailWings.deepCallOiBtc, 90); // 140k Call (90)
    assert.equal(mat.tailWings.minPutStrike, 50000);
    assert.equal(mat.tailWings.maxCallStrike, 140000);
  });

  test('postExpiryCliff 模拟剔除主力交割后的残余 GEX 与变号判定', () => {
    const roll = expiryRollOff(contracts, SPOT, NOW);
    const base = evaluateBook(contracts);
    const cliff = postExpiryCliff(contracts, SPOT, NOW, roll, { gexUsd: base.gamma1pct * SPOT });
    assert.equal(cliff.afterNextMajor.expiry, '30OCT26');
    const exMajor = contracts.filter(c => c.expiry !== '30OCT26');
    close(cliff.afterNextMajor.residualGexUsd, evaluateBook(exMajor).gamma1pct * SPOT, 1e-6);
    assert.equal(typeof cliff.afterNextMajor.regimeFlips, 'boolean');
  });
});
