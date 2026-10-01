const { describe, it } = require('node:test');
const assert = require('node:assert');
const E = require('../server/wave_engine');

const T0 = 1780000000 - (1780000000 % 14400);

/** 由折线顶点生成 15m K线 (每段 steps 根)，再按 16 根聚合为 4H */
function build(vertices, steps) {
  const m15 = [];
  let t = T0;
  for (let k = 1; k < vertices.length; k++) {
    const a = vertices[k - 1], b = vertices[k];
    for (let s = 0; s < steps; s++) {
      const o = a + (b - a) * s / steps, c = a + (b - a) * (s + 1) / steps;
      m15.push({ time: t, open: o, close: c, high: Math.max(o, c) + 0.02, low: Math.min(o, c) - 0.02 });
      t += 900;
    }
  }
  const h4 = [];
  for (let i = 0; i < m15.length; i += 16) {
    const g = m15.slice(i, i + 16);
    h4.push({ time: g[0].time, open: g[0].open, close: g[g.length - 1].close,
      high: Math.max(...g.map(b => b.high)), low: Math.min(...g.map(b => b.low)) });
  }
  return { m15, h4 };
}

/** 顶点 k 所在的 4H K线时间与价格 (模拟用户在 4H 图上点击该拐点) */
function clickAt(vertices, steps, k) {
  const i15 = k * steps;
  return { time: T0 + Math.floor(i15 / 16) * 14400, price: vertices[k] };
}

const PREFIX = [120, 108, 112, 100];
const W1 = [110, 105, 122, 116, 130];            // 浪1: 五段
const W2 = [118, 124, 112];                      // 浪2: abc
const W3_FIVE = [130, 122, 160, 150, 172];       // 浪3: 五段
const W3_THREE = [140, 128, 172];                // 浪3: 只有三段
const W4 = [160, 166, 150];                      // 浪4: abc
const W5 = [160, 155, 172, 166, 180];            // 浪5: 五段
const STEPS = 24;

function impulsePath(w3, w4) {
  const v = PREFIX.concat(W1, W2, w3, w4 || W4, W5, [170]);
  const ends = [];
  let k = PREFIX.length - 1;
  ends.push(k);
  for (const seg of [W1, W2, w3, w4 || W4, W5]) { k += seg.length; ends.push(k); }
  return { v, ends };
}

function evaluate(v, ends, tool, extra) {
  const { m15, h4 } = build(v, STEPS);
  const points = ends.map(k => clickAt(v, STEPS, k));
  return E.evaluateUserCount(h4, 'TEST', Object.assign({ tool, points, timeframe: '4h', subBars: { '15m': m15 } }, extra || {}));
}

describe('Module 8: 用户画浪评估 (4H 画浪 → 15m 子浪证伪)', () => {
  it('标准 5-3-5-3-5 推动浪: 铁律全过，15m 子浪逐段符合', () => {
    const { v, ends } = impulsePath(W3_FIVE);
    const r = evaluate(v, ends, 'IMPULSE');
    assert.strictEqual(r.primary.type, 'IMPULSE');
    assert.strictEqual(r.primary.hardFails.length, 0);
    assert.deepStrictEqual(r.primary.legs.map(L => L.status), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS']);
    assert.ok(r.primary.legs.every(L => L.source === '15m'), '子浪应在 15m 上判定');
    assert.ok(['VALID', 'DOUBT'].includes(r.verdict), r.verdict);
    assert.ok(r.commentary.lines.some(l => /只讨论波浪/.test(l)));
  });

  it('浪3在 15m 只走了三段 → 小级别证伪 (不是推动浪)', () => {
    const { v, ends } = impulsePath(W3_THREE);
    const r = evaluate(v, ends, 'IMPULSE');
    const w3 = r.primary.legs[2];
    assert.strictEqual(w3.status, 'FAIL');
    assert.strictEqual(w3.severity, 'strong');
    assert.match(w3.text, /只走了3段/);
    assert.strictEqual(r.verdict, 'FALSIFIED_SUB');
  });

  it('浪4切入浪1价格区 → 推动浪按铁律否决 (I1)', () => {
    const { v, ends } = impulsePath(W3_FIVE, [150, 158, 126]);
    const r = evaluate(v, ends, 'IMPULSE');
    const imp = r.interpretations.find(i => i.type === 'IMPULSE');
    assert.ok(imp.hardFails > 0);
    const { m15, h4 } = build(v, STEPS);
    const solo = E.evaluateUserCount(h4, 'TEST', { tool: 'IMPULSE', points: ends.map(k => clickAt(v, STEPS, k)), timeframe: '4h', subBars: { '15m': m15 } });
    if (solo.primary.type === 'IMPULSE') {
      assert.strictEqual(solo.verdict, 'INVALID');
      assert.ok(solo.primary.hardFails.some(f => f.id === 'I1'));
    } else {
      assert.strictEqual(solo.primary.type, 'DIAGONAL', '推动浪被否决时应改按楔形解读');
    }
  });

  it('只画到浪2，之后价格跌破浪1起点 → 走势证伪 (浪2回撤不能超过浪1起点)', () => {
    const v = PREFIX.concat(W1, W2, [120, 95, 97]);
    const ends = [PREFIX.length - 1, PREFIX.length - 1 + W1.length, PREFIX.length - 1 + W1.length + W2.length];
    const r = evaluate(v, ends, 'IMPULSE');
    assert.strictEqual(r.primary.hardFails.length, 0, '按画的点本身不违规');
    assert.ok(r.live.extension, '应识别出浪2延伸');
    assert.ok(r.primary.liveHardFails.some(f => f.id === 'M1'));
    assert.strictEqual(r.verdict, 'FALSIFIED_PRICE');
  });

  it('手画点偏离 → 吸附到真实极值', () => {
    const { v, ends } = impulsePath(W3_FIVE);
    const { m15, h4 } = build(v, STEPS);
    const points = ends.map(k => clickAt(v, STEPS, k));
    points[3] = { time: points[3].time + 14400, price: points[3].price - 4 }; // 浪3终点点偏右一根、偏低 4
    const r = E.evaluateUserCount(h4, 'TEST', { tool: 'IMPULSE', points, timeframe: '4h', subBars: { '15m': m15 } });
    assert.ok(Math.abs(r.points[3].price - 172) < 0.1, `吸附后应为 172，实为 ${r.points[3].price}`);
    assert.ok(r.adjustments.some(a => a.point === '3'));
  });

  it('低周期端点精化: 取主K线内创出极值的那根 15m', () => {
    const { v } = impulsePath(W3_FIVE);
    const { m15, h4 } = build(v, STEPS);
    const k = PREFIX.length - 1 + W1.length; // 浪1终点 130
    const c = clickAt(v, STEPS, k);
    const t = E._internal.refineSubTime({ name: '15m', bars: m15 }, { time: c.time, type: 'high' }, 14400);
    const bar = m15.find(b => b.time === t);
    assert.ok(Math.abs(bar.high - 130.02) < 1e-6);
  });

  it('部分画浪 (三角形 0-a-b、三锯齿 0-w-x-y) 不报错并给出下一浪要求', () => {
    const v = [100, 130, 110, 124, 112, 120, 115, 118];
    const { m15, h4 } = build(v, 40);
    const pts = [0, 1, 2].map(k => clickAt(v, 40, k));
    const tri = E.evaluateUserCount(h4, 'TEST', { tool: 'ABCDE', points: pts, timeframe: '4h', subBars: { '15m': m15 } });
    assert.ok(tri.invalidation.structural);
    const v2 = [100, 80, 90, 70, 75];
    const b2 = build(v2, 40);
    const tz = E.evaluateUserCount(b2.h4, 'TEST', { tool: 'WXYXZ', points: [0, 1, 2, 3].map(k => clickAt(v2, 40, k)), timeframe: '4h', subBars: { '15m': b2.m15 } });
    assert.ok(Array.isArray(tz.targets));
  });

  it('b浪在 15m 反复大幅重叠 → 判为调整性质，不因「数不清」而证伪', () => {
    // a: 五段下跌 130→100；b: 100→115 之间来回 16 次、每次回撤约本段 40%；c: 五段下跌
    const chop = [];
    for (let i = 0; i < 16; i++) chop.push(i % 2 === 0 ? 104 + i * 0.6 : 98 + i * 0.6);
    const v = [140, 128, 130, 118, 122, 106, 110, 100].concat(chop, [115, 105, 108, 96, 99, 88]);
    const a0 = 2, aEnd = 7, bEnd = aEnd + chop.length + 1, cEnd = v.length - 1;
    const r = evaluate(v, [a0, aEnd, bEnd, cEnd], 'ABC');
    const b = r.primary.legs[1];
    assert.strictEqual(b.found, '3');
    assert.notStrictEqual(b.status, 'FAIL');
    assert.notStrictEqual(r.verdict, 'FALSIFIED_SUB');
  });

  it('输入校验: 点数过少 / 时间倒序 / 未知工具', () => {
    const { v, ends } = impulsePath(W3_FIVE);
    const { h4 } = build(v, STEPS);
    const pts = ends.map(k => clickAt(v, STEPS, k));
    assert.throws(() => E.evaluateUserCount(h4, 'T', { tool: 'IMPULSE', points: pts.slice(0, 2) }), /至少需要 3 个点/);
    assert.throws(() => E.evaluateUserCount(h4, 'T', { tool: 'IMPULSE', points: [pts[2], pts[1], pts[3]] }), /须晚于/);
    assert.throws(() => E.evaluateUserCount(h4, 'T', { tool: 'XYZ', points: pts }), /未知画浪工具/);
  });
});
