const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const D = require('../server/dealer_engine');
const { recentChange } = require('../server/data_fetcher');
const history = require('../server/dealer_history');

const NOW = Date.UTC(2026, 9, 20, 6, 0, 0);
const H = 3600000;
const mark = (iv, F, oi) => ({ markIv: iv, markPrice: 0.01, underlyingPrice: F, openInterest: oi });
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b}`);

describe('过去 24 小时变化', () => {
  const series = (n, f) => Array.from({ length: n }, (_, i) => ({ ts: NOW - (n - 1 - i) * H, close: f(i) }));

  test('取最新一根与 24 小时前最近的一根', () => {
    const r = recentChange(series(30, i => 80000 + i * 10), series(30, i => 40 + i * 0.1), 24);
    assert.equal(r.spotNow, 80290);
    assert.equal(r.spotThen, 80050);
    close(r.dvolNow - r.dvolThen, 2.4, 1e-9);
    assert.equal(r.hours, 24);
  });

  test('样本不足或缺口超过 2 小时时返回 null', () => {
    assert.equal(recentChange(series(10, () => 1), series(30, () => 1), 24), null);
    assert.equal(recentChange([], series(30, () => 1), 24), null);
  });
});

describe('dealer_engine · 已触发对冲流、状态、预警与深度', () => {
  const book = D.contractsFromMarks({
    'BTC-30OCT26-80000-C': mark(40, 80000, 100),
    'BTC-30OCT26-78000-P': mark(42, 80000, 60)
  }, NOW);

  test('已触发对冲流 = 回到 24 小时前状态重估的 Delta 差的反面', () => {
    const recent = { hours: 24, spotNow: 80000, spotThen: 81600, dvolNow: 41, dvolThen: 40 };
    const r = D.realizedFlow(book, 80000, recent);
    const now = D.evaluateBook(book);
    const then = D.evaluateBook(book, { spotMult: 81600 / 80000, volShift: -0.01, dtDays: -1 });
    close(r.flowUsd, -(now.delta - then.delta) * 80000, 1e-6);
    close(r.spotPct, (80000 / 81600 - 1) * 100, 0.01);
    assert.equal(r.dvolChange, 1);
    assert.equal(D.realizedFlow(book, 80000, null), null);
    assert.equal(D.realizedFlow(book, 80000, { ...recent, spotThen: NaN }), null);
  });

  test('对冲状态覆盖正 Gamma (含破位) 与负 Gamma 各分支', () => {
    assert.equal(D.hedgingState(10, 5, -5).key, 'buffer');
    assert.equal(D.hedgingState(10, -5, -5).key, 'buffer_fragile_down');
    assert.equal(D.hedgingState(10, 5, 5).key, 'buffer_fragile_up');
    assert.equal(D.hedgingState(10, -5, 5).key, 'buffer_fragile_both');
    assert.equal(D.hedgingState(-10, -5, 5).key, 'two_way_accel');
    assert.equal(D.hedgingState(-10, -5, -5).key, 'downside_accel');
    assert.equal(D.hedgingState(-10, 5, 5).key, 'upside_squeeze');
    assert.equal(D.hedgingState(-10, 5, -5).key, 'mixed');
  });

  test('偏度信号优先用相对历史，历史不足时用 30D RR 绝对值', () => {
    assert.deepEqual(D.skewSignal({ d30: -1, richness: { verdict: 'put_rich' } }).side, 'put');
    assert.equal(D.skewSignal({ d30: -1, richness: { verdict: 'put_rich' } }).extreme, true);
    assert.equal(D.skewSignal({ d30: -3.5, richness: { verdict: 'insufficient_history' } }).basis, '绝对值');
    assert.equal(D.skewSignal({ d30: -3.5, richness: { verdict: 'insufficient_history' } }).extreme, true);
    assert.equal(D.skewSignal({ d30: -1.5, richness: { verdict: 'normal' } }).extreme, false);
    assert.equal(D.skewSignal(null).side, null);
  });

  test('盘口深度对比：卖出量对买盘、买入量对卖盘', () => {
    const d = D.depthComparison(-30e6, 12e6, { venue: 'Coinbase', band: '±2%', bidUsd: 60e6, askUsd: 40e6 });
    assert.equal(d.downsideRatioPct, 50);
    assert.equal(d.upsideRatioPct, 30);
    assert.equal(D.depthComparison(10e6, -5e6, { bidUsd: 60e6, askUsd: 40e6 }).downsideRatioPct, 0);
    assert.equal(D.depthComparison(-1, 1, null), null);
  });

  test('预警：负 Gamma 助跌 + Put 偏斜极端 + IV 上升时卖出 → 高优先级；结论不稳健时降一级', () => {
    const args = {
      state: D.hedgingState(-10, -30e6, -1),
      vexUsd: 5e6,
      skew: { d30: -3.6, richness: { verdict: 'insufficient_history' } },
      robust: true,
      depth: D.depthComparison(-30e6, 0, { venue: 'Coinbase', band: '±2%', bidUsd: 60e6, askUsd: 40e6 }),
      crashFlowUsd: -30e6,
      squeezeFlowUsd: -1,
      basisLabel: '全成交校正口径'
    };
    const high = D.buildAlerts(args);
    assert.equal(high.length, 1);
    assert.equal(high[0].key, 'downside_cascade');
    assert.equal(high[0].level, 'high');
    assert.ok(high[0].detail.includes('50%'));
    assert.equal(D.buildAlerts({ ...args, robust: false })[0].level, 'medium');
    assert.equal(D.buildAlerts({ ...args, skew: { d30: -1 } })[0].level, 'medium');
    assert.deepEqual(D.buildAlerts({ ...args, state: D.hedgingState(10, 5, -5) }), []);
  });

  test('翻转位贴近现货且跨过后转负 Gamma 时给低优先级提示', () => {
    const base = { state: D.hedgingState(10, 5, -5), vexUsd: 0, skew: null, robust: true, depth: null, crashFlowUsd: 5, squeezeFlowUsd: -5, basisLabel: '惯例口径' };
    const near = D.buildAlerts({ ...base, gammaFlip: { price: 78500, distancePct: -1.8, from: -1, to: 1 } });
    assert.deepEqual(near.map(a => [a.key, a.level]), [['flip_proximity', 'low']]);
    assert.deepEqual(D.buildAlerts({ ...base, gammaFlip: { price: 70000, distancePct: -12, from: -1, to: 1 } }), []);
    assert.deepEqual(D.buildAlerts({ ...base, gammaFlip: { price: 82000, distancePct: 1.5, from: -1, to: 1 } }), [], '升破后转正 Gamma 不提示');
  });

  test('有台账时主口径为全成交校正：状态、压力情景、曲线与已触发对冲流都基于校正账本', () => {
    const marks = {};
    for (const K of [72000, 76000, 80000, 84000, 88000]) {
      marks[`BTC-30OCT26-${K}-C`] = mark(40, 80000, 30);
      marks[`BTC-30OCT26-${K}-P`] = mark(45, 80000, 30);
    }
    const ledger = { syncedThrough: NOW - H, instruments: { 'BTC-30OCT26-84000-C': [40, 0, 0, 40, 0, 0, 5], 'BTC-30OCT26-88000-C': [40, 0, 0, 40, 0, 0, 5] } };
    const r = D.analyzeDealerExposure({ indexPrice: 80000, marks }, {
      now: NOW,
      flowLedger: ledger,
      recent24h: { hours: 24, spotNow: 80000, spotThen: 80800, dvolNow: 42, dvolThen: 40 },
      depth: { venue: 'Coinbase', band: '±2%', bidUsd: 50e6, askUsd: 50e6 },
      skew: { d30: -3.5, richness: { verdict: 'insufficient_history' } }
    });
    assert.equal(r.primaryBasis, 'flow_adjusted');
    assert.ok(r.primaryExposures.gexUsd < r.exposures.gexUsd, '客户买入上方 Call 后做市商 Gamma 更低');
    assert.equal(r.primaryStress.length, 6);
    assert.ok(r.state && r.state.key);
    assert.ok(r.realized24h.convention && r.realized24h.primary);
    assert.ok(r.depth && r.depth.band === '±2%');
    const conv = r.sensitivity.scenarios.find(s => s.key === 'convention');
    const flow = r.sensitivity.scenarios.find(s => s.key === 'flow_adjusted');
    assert.equal(conv.curve.length, 41);
    assert.equal(flow.curve.length, 41);
    assert.equal(r.sensitivity.scenarios.find(s => s.key === 'otm_call_bought').curve, undefined);
    assert.equal(JSON.stringify(r).includes('flowBook'), false, '校正账本不进入输出');
    assert.ok(r.paragraph.includes('【对冲状态·全成交校正口径】'));
    assert.ok(r.paragraph.includes('过去 24 小时'));
    assert.ok(r.paragraph.includes('全成交校正口径净 GEX'), '体制叙述以主口径为准');
    assert.ok(r.paragraph.includes('（惯例口径 '), '惯例口径数字并列');
    assert.ok(r.paragraph.includes('累计净买入 Call 80 BTC'), '客户净买 Call 时说明假设情景有依据');
    assert.equal(r.primaryRegime, r.primaryExposures.gexUsd > 0 ? 'long_gamma' : 'short_gamma');

    const sold = D.analyzeDealerExposure({ indexPrice: 80000, marks }, {
      now: NOW,
      flowLedger: { syncedThrough: NOW - H, instruments: { 'BTC-30OCT26-84000-C': [-20, 0, 0, 20, 0, 0, 3] } }
    });
    assert.ok(sold.paragraph.includes('累计净卖出 Call 20 BTC'));
    assert.ok(sold.paragraph.includes('只作压力参照'));
  });
});

describe('dealer_history · 日度档案', () => {
  const analysis = {
    status: 'ok',
    spot: 80123.4,
    exposures: { gexUsd: 1.2e8, dexUsd: 6.9e9 },
    primaryExposures: { gexUsd: 4e7, dexUsd: 3e9, vexUsd: 7e7, cexUsd: -1.3e8 },
    primaryRobust: false,
    state: { key: 'buffer_fragile_down' },
    realized24h: { convention: { flowUsd: 3.8e8 }, primary: { flowUsd: 2e8 } },
    nextMajorExpiry: { expiry: '30OCT26', oiShare: 38 },
    sensitivity: {
      scenarios: [
        { key: 'convention', gexUsd: 1.2e8, gammaFlip: { price: 80450 } },
        { key: 'flow_adjusted', gexUsd: 4e7, gammaFlip: null }
      ]
    }
  };

  test('由分析结果组装记录，分析不可用时返回 null', () => {
    const rec = history.recordFromAnalysis(analysis, NOW);
    assert.deepEqual(rec, {
      day: '2026-10-20', ts: NOW, spot: 80123,
      conv: { gexUsd: 120000000, dexUsd: 6900000000, flip: 80450 },
      flow: { gexUsd: 40000000, dexUsd: 3000000000, flip: null },
      vexUsd: 70000000, cexUsd: -130000000, realized24hUsd: 200000000,
      state: 'buffer_fragile_down', robust: false, nextMajor: { expiry: '30OCT26', oiShare: 38 }
    });
    assert.equal(history.recordFromAnalysis({ status: 'insufficient_data' }), null);
  });

  test('同日覆盖、排序、保留期；实时点覆盖同日档案并标记 live', () => {
    let recs = [];
    recs = history.upsertRecord(recs, { day: '2026-10-19', ts: 1, conv: {} }, 2);
    recs = history.upsertRecord(recs, { day: '2026-10-18', ts: 0, conv: {} }, 2);
    recs = history.upsertRecord(recs, { day: '2026-10-20', ts: 2, conv: {} }, 2);
    assert.deepEqual(recs.map(r => r.day), ['2026-10-19', '2026-10-20']);
    const withLive = history.withLivePoint(recs, { day: '2026-10-20', ts: 3, conv: {} });
    assert.equal(withLive.length, 2);
    assert.equal(withLive[1].live, true);
    assert.equal(withLive[1].ts, 3);
    assert.equal(withLive[1].replacesArchived, true, '实时点覆盖同日档案时标记');
    assert.equal(history.withLivePoint(recs, { day: '2026-10-21', ts: 4, conv: {} }).at(-1).replacesArchived, false);
  });

  test('读写档案；线上失败时读磁盘', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dealerhist-'));
    const file = path.join(dir, 'h.json');
    history.writeHistory(file, [history.recordFromAnalysis(analysis, NOW)]);
    assert.equal(history.readHistory(file).length, 1);
    fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ records: [{ day: 1 }] }));
    assert.deepEqual(history.readHistory(path.join(dir, 'bad.json')), []);

    history.clearHistoryCache();
    const recs = await history.getHistory({ now: 1, fetcher: async () => ({ ok: false, status: 404 }), file });
    assert.equal(recs.length, 1);
    history.clearHistoryCache();
    const remote = await history.getHistory({ now: 1, fetcher: async () => ({ ok: true, json: async () => ({ records: [] }) }), file });
    assert.deepEqual(remote, []);
    history.clearHistoryCache();
  });
});
