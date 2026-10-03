const { describe, it } = require('node:test');
const assert = require('node:assert');
const E = require('../server/wave_engine');

const T0 = 1780000000 - (1780000000 % 14400);
const STEPS = 24; // 每段 24 根 15m = 6 小时

/** 由折线顶点生成 15m K线，再聚合为 1h / 4h */
function build(vertices) {
  const m15 = [];
  let t = T0;
  for (let k = 1; k < vertices.length; k++) {
    const a = vertices[k - 1], b = vertices[k];
    for (let s = 0; s < STEPS; s++) {
      const o = a + (b - a) * s / STEPS, c = a + (b - a) * (s + 1) / STEPS;
      m15.push({ time: t, open: o, close: c, high: Math.max(o, c) + 0.02, low: Math.min(o, c) - 0.02 });
      t += 900;
    }
  }
  const agg = n => {
    const out = [];
    for (let i = 0; i < m15.length; i += n) {
      const g = m15.slice(i, i + n);
      out.push({ time: g[0].time, open: g[0].open, close: g[g.length - 1].close,
        high: Math.max(...g.map(b => b.high)), low: Math.min(...g.map(b => b.low)) });
    }
    return out;
  };
  return { '15m': m15, '1h': agg(4), '4h': agg(16) };
}

const vTime = k => T0 + k * STEPS * 900;
const pt = (v, k, tfSec) => ({ time: vTime(k) - (vTime(k) - T0) % tfSec, price: v[k] });

/** 前缀 + 各段顶点 → 顶点序列与各段端点下标 */
function path(prefix, segs, tail) {
  const v = prefix.slice();
  const ends = [v.length - 1];
  for (const seg of segs) { v.push(...seg); ends.push(v.length - 1); }
  return { v: v.concat(tail || []), ends };
}

const PREFIX = [120, 108, 112, 100];
const W1 = [110, 105, 122, 116, 130];
const W2_ZZ = [118, 124, 112];                       // 浪2: 单锯齿 (陡)
const W3 = [130, 122, 160, 150, 172];
const W4_TRI = [160, 168, 162, 166, 164.5];          // 浪4: 收缩三角形 (横)，e 浪终点 164.5 不是浪4最低点
const W5 = [175, 169, 185, 180, 192];
const TAIL = [180, 184, 170];

/** 母浪 (4H 推动浪) 与浪2 / 浪4 子浪 (1H) */
function sketch(w2, w2Tool, w4, w4Tool, w3) {
  const { v, ends } = path(PREFIX, [W1, w2, w3 || W3, w4, W5], TAIL);
  const bars = build(v);
  const parent = { id: 'P', tool: 'IMPULSE', timeframe: '4h', points: ends.map(k => pt(v, k, 14400)) };
  const kid = (id, tool, from, n) => ({ id, tool, timeframe: '1h', points: Array.from({ length: n + 1 }, (_, i) => pt(v, from + i, 3600)) });
  const drawings = [parent];
  if (w2Tool) drawings.push(kid('W2', w2Tool, ends[1], w2.length));
  if (w4Tool) drawings.push(kid('W4', w4Tool, ends[3], w4.length));
  return { v, ends, bars, drawings };
}

describe('Module 8: 多级别画浪 (母浪 + 子浪整体评估)', () => {
  it('推动浪 + 浪2单锯齿 + 浪4三角形 → 母子关系正确、子浪确认母浪该段、交替原则成立', () => {
    const s = sketch(W2_ZZ, 'ABC', W4_TRI, 'ABCDE');
    const r = E.evaluateUserSketch(s.bars, 'TEST', { drawings: s.drawings });
    const P = r.nodes.find(x => x.id === 'P'), K2 = r.nodes.find(x => x.id === 'W2'), K4 = r.nodes.find(x => x.id === 'W4');
    assert.deepStrictEqual(r.roots, ['P']);
    assert.strictEqual(K2.parentId, 'P'); assert.strictEqual(K2.parentLeg, 1); assert.strictEqual(K2.depth, 1);
    assert.strictEqual(K4.parentId, 'P'); assert.strictEqual(K4.parentLeg, 3);
    assert.strictEqual(K4.result.primary.type, 'TRIANGLE', K4.name);
    const legs = P.result.primary.legs;
    assert.strictEqual(legs[1].userChild, 'W2');
    assert.strictEqual(legs[3].userChild, 'W4');
    assert.ok(['PASS', 'DOUBT'].includes(legs[3].status), legs[3].text);
    // 浪4终点固定在三角形 e 浪终点 (164.5)，没有被吸附到浪4内部最低点 (a 浪 160)
    assert.ok(Math.abs(P.result.points[4].price - 164.5) < 0.05, `浪4终点 ${P.result.points[4].price}`);
    assert.ok(P.issues.some(x => /交替原则.*形成交替/.test(x.text)), JSON.stringify(P.issues));
    assert.ok(!['INVALID', 'FALSIFIED_SUB', 'ERROR'].includes(r.verdict), r.verdict + '\n' + r.lines.join('\n'));
  });

  it('浪2子浪画成推动浪 → 母浪浪2要求三浪，判为证伪', () => {
    const W2_5 = [121, 126, 116, 119, 112];
    const s = sketch(W2_5, 'IMPULSE', W4_TRI, null);
    const r = E.evaluateUserSketch(s.bars, 'TEST', { drawings: s.drawings });
    const P = r.nodes.find(x => x.id === 'P');
    assert.strictEqual(P.result.primary.legs[1].status, 'FAIL', P.result.primary.legs[1].text);
    assert.match(P.result.primary.legs[1].text, /要求三浪调整/);
    assert.strictEqual(r.verdict, 'FALSIFIED_SUB');
  });

  it('浪2子浪画成三角形 → 存疑并说明 (三角形通常不作为浪2)', () => {
    const W2_TRI = [116, 126, 119, 124, 122.5];
    const s = sketch(W2_TRI, 'ABCDE', W4_TRI, null, [135, 128, 160, 150, 172]);
    const r = E.evaluateUserSketch(s.bars, 'TEST', { drawings: s.drawings });
    const leg = r.nodes.find(x => x.id === 'P').result.primary.legs[1];
    assert.strictEqual(leg.status, 'DOUBT', leg.text);
    assert.match(leg.text, /三角形通常不作为浪2/);
  });

  it('指定浪型: abc 可指定为单锯齿或平台形，未指定时自动择优并列出可选浪型', () => {
    // 0→a 下跌 100→80，b 反弹到 96 (回撤 80%，单锯齿与平台形都不违反铁律)，c 下跌到 76
    const v = [120, 100, 80, 96, 76, 90];
    const bars = build(v);
    const pts = [1, 2, 3, 4].map(k => pt(v, k, 3600));
    const auto = E.evaluateUserCount(bars['1h'], 'TEST', { tool: 'ABC', points: pts, timeframe: '1h', subBars: { '15m': bars['15m'] } });
    assert.strictEqual(auto.forcedType, null);
    assert.deepStrictEqual(auto.toolTypes.map(t => t.type), ['ZIGZAG', 'FLAT']);
    for (const type of ['ZIGZAG', 'FLAT']) {
      const r = E.evaluateUserCount(bars['1h'], 'TEST', { tool: 'ABC', points: pts, timeframe: '1h', subBars: { '15m': bars['15m'] }, forceType: type });
      assert.strictEqual(r.primary.type, type);
      assert.strictEqual(r.forcedType, type);
      assert.deepStrictEqual(r.interpretations.map(x => x.type), [type], '指定后只按该浪型评估');
    }
    // 不属于该工具的浪型被忽略 (abc 不能指定为三角形)
    const bad = E.evaluateUserCount(bars['1h'], 'TEST', { tool: 'ABC', points: pts, timeframe: '1h', forceType: 'TRIANGLE' });
    assert.strictEqual(bad.forcedType, null);
    // 整体评估同样带上指定的浪型
    const sk = E.evaluateUserSketch(bars, 'TEST', { drawings: [{ id: 'A', tool: 'ABC', timeframe: '1h', type: 'FLAT', points: pts }] });
    assert.strictEqual(sk.nodes[0].result.primary.type, 'FLAT');
  });

  it('重新定性: 画成 abc 反弹，但起点以来已走成五浪推动 → 提出新趋势、判为存疑', () => {
    // 100 起的上涨: 110 → 105 → 122 → 116 → 130 (五浪)，用户只把 100-110-105-122 画成 abc
    const v = [120, 100, 110, 105, 122, 116, 130, 126];
    const bars = build(v);
    const pts = [1, 2, 3, 4].map(k => pt(v, k, 3600));
    const r = E.evaluateUserCount(bars['1h'], 'TEST', { tool: 'ABC', points: pts, timeframe: '1h', subBars: { '15m': bars['15m'] } });
    assert.ok(r.reclassify, '应提出重新定性');
    assert.strictEqual(r.reclassify.to, 'IMPULSE');
    assert.notStrictEqual(r.verdict, 'VALID');
    assert.ok(r.commentary.lines.some(l => /重新定性/.test(l)));
    // 真正的推动浪画法不触发
    const imp = E.evaluateUserCount(bars['1h'], 'TEST', { tool: 'IMPULSE', points: [1, 2, 3, 4, 5, 6].map(k => pt(v, k, 3600)), timeframe: '1h', subBars: { '15m': bars['15m'] } });
    assert.strictEqual(imp.reclassify, null);
  });

  it('标准化预测: 目标与失效位分处现价两侧，带期限与随机游走基准', () => {
    const v = [120, 100, 110, 105, 122, 116, 124];
    const bars = build(v);
    const r = E.evaluateUserCount(bars['1h'], 'TEST', { tool: 'IMPULSE', points: [1, 2, 3, 4, 5].map(k => pt(v, k, 3600)), timeframe: '1h', subBars: { '15m': bars['15m'] } });
    const f = r.forecast;
    assert.ok(f, '应给出预测');
    const px = r.currentPrice;
    assert.ok((f.target.price - px) * (f.invalidation.price - px) < 0, '目标与失效位分处现价两侧');
    assert.ok(f.deadline > bars['1h'][bars['1h'].length - 1].time);
    assert.ok(f.randomWalkPct > 0 && f.randomWalkPct < 100);
  });

  it('三锯齿标号为 0-w-x-y-xx-z', () => {
    assert.deepStrictEqual(E.USER_TOOLS.WXYXZ.labels, ['0', 'w', 'x', 'y', 'xx', 'z']);
    assert.deepStrictEqual(E.PATTERNS.TRIPLE_ZIGZAG.labels, ['0', 'w', 'x', 'y', 'xx', 'z']);
  });

  it('跨越母浪拐点的浪 → 无法判定级别关系', () => {
    const s = sketch(W2_ZZ, null, W4_TRI, null);
    const e = s.ends;
    // abc: 浪1终点 → 浪2终点 → 浪3中途 → 浪3中途：跨过了母浪浪2终点
    s.drawings.push({ id: 'X', tool: 'ABC', timeframe: '1h', points: [e[1], e[2], e[2] + 3, e[2] + 4].map(k => pt(s.v, k, 3600)) });
    const tree = E.buildSketchTree(s.drawings);
    assert.strictEqual(tree.nodes.X.parentId, null);
    assert.ok(tree.issues.X.some(x => x.severity === 'strong' && /跨越/.test(x.text)), JSON.stringify(tree.issues.X));
  });

  it('母子关系推断: 三层嵌套取最近一级母浪，深度依次递增', () => {
    const h = 3600;
    const mk = (id, tool, tf, times) => ({ id, tool, timeframe: tf, points: times.map((t, i) => ({ time: T0 + t * h, price: 100 + (i % 2 ? 10 : 0) })) });
    const big = mk('A', 'IMPULSE', '4h', [0, 40, 80, 160, 200, 280]);    // 浪3 = [80,160]
    const mid = mk('B', 'IMPULSE', '1h', [80, 96, 108, 132, 140, 160]);  // 浪3 内的五浪，其浪3 = [108,132]
    const small = mk('C', 'IMPULSE', '15m', [108, 112, 115, 122, 125, 132]);
    const tree = E.buildSketchTree([small, big, mid]);
    assert.deepStrictEqual([tree.nodes.A.depth, tree.nodes.B.depth, tree.nodes.C.depth], [0, 1, 2]);
    assert.strictEqual(tree.nodes.B.parentId, 'A'); assert.strictEqual(tree.nodes.B.leg, 2);
    assert.strictEqual(tree.nodes.C.parentId, 'B'); assert.strictEqual(tree.nodes.C.leg, 2);
  });
});
