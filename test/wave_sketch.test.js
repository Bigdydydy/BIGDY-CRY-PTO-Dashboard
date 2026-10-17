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

  it('双锯齿与横向整理都成立时互为并列解读，按外观斜度与比率区分（P364/P366/P50）', () => {
    // w 120→100，x 回撤 75% 到 115，y 跌到 94：两种浪型的铁律都过
    const v = [125, 120, 100, 115, 94, 96];
    const bars = build(v);
    const r = E.evaluateUserCount(bars['1h'], 'TEST', { tool: 'WXY', timeframe: '1h', subBars: { '15m': bars['15m'] }, points: [1, 2, 3, 4].map(k => pt(v, k, 3600)) });
    const types = (r.hypotheses || []).map(h => h.type);
    assert.ok(types.includes('DOUBLE_ZIGZAG') && types.includes('COMBINATION'), JSON.stringify(r.hypotheses.map(h => [h.type, h.verdict])));
    const dz = r.hypotheses.find(h => h.type === 'DOUBLE_ZIGZAG'), cb = r.hypotheses.find(h => h.type === 'COMBINATION');
    assert.ok(dz.conditions.some(c => /^外观斜度 [\d.]+%：双锯齿/.test(c)) && dz.conditions.some(c => /已越过 w 浪终点/.test(c)), dz.conditions.join(' / '));
    assert.ok(cb.conditions.some(c => /^外观斜度 [\d.]+%：横向整理/.test(c)) && cb.conditions.some(c => /横向整理须 ≥70%/.test(c)), cb.conditions.join(' / '));
    // 斜度指引: 双锯齿要求倾斜 (WG6)，横向整理要求平缓 (CG2)，口径相同
    const E2 = E._internal;
    assert.ok(Math.abs(E2.pgSlope(E2.mkGeom([1, 2, 3, 4].map(k => ({ idx: k, time: k, price: v[k] })))) - 0.275) < 1e-9);
  });

  it('锯齿类 / 横向整理判定: 铁律都过时按外观斜度依次判定，两可时按指引并列给出，并列出区分依据', () => {
    const run = v => { const bars = build(v); return E.evaluateUserCount(bars['1h'], 'TEST', { tool: 'WXY', timeframe: '1h', subBars: { '15m': bars['15m'] }, points: [1, 2, 3, 4].map(k => pt(v, k, 3600)) }); };
    // x 回撤 75%，y = 1.5w：铁律两者都过，斜度约 50% → 双锯齿
    const steep = run([125, 120, 100, 115, 85, 87]);
    assert.strictEqual(steep.discrimination.chosen, 'DOUBLE_ZIGZAG', steep.discrimination.reason);
    assert.strictEqual(steep.primary.type, 'DOUBLE_ZIGZAG');
    assert.ok(steep.discrimination.steps.some(x => /外观斜度/.test(x.basis) && x.supports === 'DOUBLE_ZIGZAG'));
    // x 回撤 90%，y ≈ w：斜度约 10% → 双重横向整理
    const flat = run([125, 120, 100, 118, 98, 100]);
    assert.strictEqual(flat.primary.type, 'COMBINATION', flat.discrimination.reason);
    // 斜度在 25%~35% 之间: 两可，两种读法都作为并列解读
    const mid = run([125, 120, 100, 115, 94, 96]);
    assert.strictEqual(mid.discrimination.ambiguous, true, mid.discrimination.reason);
    // 三锯齿补上 xx 常见回撤指引 (P351)
    assert.ok(E.PATTERNS.TRIPLE_ZIGZAG.rules.some(r => r.id === 'XG1'));
  });

  it('子浪多阈值投票: 多数阈值数不成五浪才判三浪，数成五浪的多数只能数成楔形才判楔形，打平归于被评估的计数', () => {
    const V = E._internal.structVotes;
    const imp = { five: { kind: 'IMPULSE' } }, dia = { five: { kind: 'DIAGONAL' } }, none = { five: null };
    assert.deepStrictEqual([V([imp, none]).label, V([imp, none]).motive], ['5', 'IMPULSE'], '打平按五浪');
    assert.strictEqual(V([imp, none, none]).label, '3', '多数数不成五浪才判三浪');
    assert.strictEqual(V([dia, imp, none]).motive, 'IMPULSE', '数成五浪的阈值里推动浪、楔形打平按推动浪');
    assert.strictEqual(V([dia, dia, imp]).motive, 'DIAGONAL', '多数只能数成楔形才判楔形');
    // 没有校准系数 (回测中指引无可证实的预测力) 时不给校准概率
    assert.strictEqual(E._internal.calibratedOf({ baseType: 'IMPULSE', ruleChecks: [] }, { randomWalkPct: 60 }), null);
  });

  it('计数否定位与本段防线分开: c浪运行中跌破 b 终点只说明 b 浪延伸，越过 a 浪起点才否定', () => {
    const v = [106, 100, 103, 101.5, 104, 102.5, 120, 112, 114, 113, 115, 114.5];
    const bars = build(v);
    const r = E.evaluateUserCount(bars['1h'], 'TEST', { tool: 'ABC', timeframe: '1h', subBars: { '15m': bars['15m'] }, points: [1, 6, 7].map(k => pt(v, k, 3600)) });
    assert.match(r.primary.name, /c浪运行中/, '名称按走势后的计数，与价位一致');
    assert.ok(Math.abs(r.invalidation.structural.price - 100) < 0.1, r.invalidation.structural.text);
    assert.match(r.invalidation.structural.label, /计数否定位/);
    assert.ok(Math.abs(r.invalidation.leg.price - 112) < 0.1, r.invalidation.leg.text);
    assert.match(r.invalidation.leg.text, /计数本身未否定/);
    // 推动浪浪3运行中: 否定位是浪1起点，浪2终点只是本段防线
    const w = [106, 100, 110, 104, 113, 112.5];
    const b2 = build(w);
    const m = E.evaluateUserCount(b2['1h'], 'TEST', { tool: 'IMPULSE', timeframe: '1h', subBars: { '15m': b2['15m'] }, points: [1, 2, 3].map(k => pt(w, k, 3600)) });
    assert.ok(Math.abs(m.invalidation.structural.price - 100) < 0.1, m.invalidation.structural.text);
    assert.ok(Math.abs(m.invalidation.leg.price - 104) < 0.1, m.invalidation.leg.text);
  });

  it('推演: c浪最低是 0.9×b（硬规则），0.618×a 只是常见目标之一', () => {
    const v = [106, 100, 103, 101.5, 104, 102.5, 120, 112, 114, 113, 115, 114.5];
    const bars = build(v);
    const r = E.evaluateUserCount(bars['1h'], 'TEST', { tool: 'ABC', timeframe: '1h', subBars: { '15m': bars['15m'] }, points: [1, 6, 7].map(k => pt(v, k, 3600)) });
    const c = r.projection.waves[0];
    assert.ok(Math.abs(c.min.price - (112 + 0.9 * 8)) < 0.2, JSON.stringify(c.min));
    assert.ok(c.min.price < c.zone.lo, '最低要求低于常见区间下端');
    assert.ok(c.common.some(x => /0\.618×a/.test(x.label)) && c.common.some(x => /1×a/.test(x.label) && Math.abs(x.price - 132) < 0.2));
  });

  it('评语精简: 子浪结构、价位、目标、推演、并列假设不在评语里重复，免责声明只出现一次', () => {
    const v = [106, 100, 103, 101.5, 104, 102.5, 120, 112, 114, 113, 115, 114.5];
    const bars = build(v);
    const r = E.evaluateUserCount(bars['1h'], 'TEST', { tool: 'ABC', timeframe: '1h', subBars: { '15m': bars['15m'] }, points: [1, 6, 7].map(k => pt(v, k, 3600)) });
    const L = r.commentary.lines;
    assert.ok(!L.some(l => /^(子浪结构|目标：|假设推演|并列假设|小级别监测点)/.test(l)), L.join('\n'));
    assert.ok(!L.some(l => /计数否定位|本段防线）：/.test(l) && !/可检验的预测/.test(l)), L.join('\n'));
    assert.strictEqual(L.filter(l => /只讨论波浪/.test(l)).length, 1);
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
    // 回测无区分度的重新定性只作提示：保留在 reclassify 里，不写进评语
    assert.ok(r.reclassify.weak);
    assert.ok(!r.commentary.lines.some(l => /重新定性/.test(l)));
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

  it('容差带: 比率规则差阈值不到容差 → 存疑；超出容差或 tolerance=0 → 否决', () => {
    const run = (c, tol) => {
      const v = [96, 100, 120, 110, c, 113];
      const bars = build(v);
      return E.evaluateUserCount(bars['1h'], 'TEST', { tool: 'ABC', forceType: 'ZIGZAG', points: [1, 2, 3, 4].map(k => pt(v, k, 3600)), timeframe: '1h', subBars: { '15m': bars['15m'] }, tolerance: tol });
    };
    const near = run(118.6); // c/b = 0.86，差 0.9 的 4.4%
    assert.strictEqual(near.verdict, 'DOUBT');
    assert.deepStrictEqual(near.primary.nearFails.map(x => x.id), ['Z3']);
    assert.ok(near.doubts.some(t => /接近阈值/.test(t)));
    assert.strictEqual(run(118.6, 0).verdict, 'INVALID');
    assert.strictEqual(run(117.5).verdict, 'INVALID'); // c/b = 0.75，差 16.7%
  });

  it('计数生命周期: 上次预测的结局、阶段与判决变化及触发的价格事件', () => {
    const bars = [100, 101, 103, 99, 96, 97].map((c, i) => ({ time: 1000 + i * 3600, open: c, close: c, high: c + 0.5, low: c - 0.5 }));
    const prev = { at: 1000, verdict: 'VALID', verdictLabel: '成立', type: 'ZIGZAG', name: '单锯齿（c浪运行中）', reclassify: null, issues: [],
      forecast: { direction: 'UP', issuedAt: 1000, deadline: 1000 + 10 * 3600, target: { price: 105, label: 'c=a' }, invalidation: { price: 97, label: 'b浪终点' } } };
    const now = { at: 1000 + 5 * 3600, verdict: 'FALSIFIED_PRICE', verdictLabel: '走势否定', type: 'ZIGZAG', name: '单锯齿（锯齿完成）', reclassify: null, issues: [], forecast: null };
    const lc = E.diffEvaluation(prev, now, bars, null);
    const kinds = lc.events.map(e => e.kind);
    assert.deepStrictEqual(kinds, ['MISS', 'STAGE', 'VERDICT']);
    assert.strictEqual(lc.events[0].time, 1000 + 4 * 3600, '第 5 根K线最低 95.5 先跌破 97');
    assert.ok(/97/.test(lc.events[1].text) && /触发/.test(lc.events[1].text));
    assert.deepStrictEqual(E.diffEvaluation(prev, Object.assign({}, prev), bars, null).events, [], '没有新K线不记');
  });

  it('拖动固定的点 (fixed) 不再吸附到附近极值，只取所在K线的高/低点', () => {
    const v = [96, 100, 120, 110, 125, 113];
    const bars = build(v);
    const pts = [1, 2, 3, 4].map(k => pt(v, k, 3600));
    pts[1] = { time: pts[1].time - 2 * 3600, price: 119 }; // a 浪终点放在真实高点左边 2 根
    const run = fixed => E.evaluateUserCount(bars['1h'], 'TEST', { tool: 'ABC', points: pts.map((p, i) => i === 1 ? Object.assign({}, p, { fixed }) : p), timeframe: '1h', subBars: { '15m': bars['15m'] } });
    const free = run(false), fixed = run(true);
    assert.notStrictEqual(free.points[1].time, pts[1].time, '未固定: 吸附到附近的高点');
    assert.ok(free.points[1].price > fixed.points[1].price);
    assert.strictEqual(fixed.points[1].time, pts[1].time, '固定: 留在所放的K线');
    const b = bars['1h'].find(x => x.time === pts[1].time);
    assert.strictEqual(fixed.points[1].price, b.high, '价格取该K线的最高价');
  });
  it('替代计数: 起点、终点与所画相同，判决不差于所画；成立时不给', () => {
    const v = [120, 100, 110, 105, 122, 116, 130, 126];
    const bars = build(v);
    const run = (tool, ks) => E.evaluateUserSketch({ '1h': bars['1h'], '15m': bars['15m'] }, 'TEST',
      { drawings: [{ id: 'A', tool, timeframe: '1h', points: ks.map(k => pt(v, k, 3600)) }] }).nodes[0];
    // abc 画在一段清楚的五浪上 (0=100 → a=122 → b=116 → c=130)，中间重新数应为推动浪
    const abc = run('ABC', [1, 4, 5, 6]);
    assert.notStrictEqual(abc.verdict, 'VALID');
    assert.ok(abc.suggestions.length > 0, '应给出替代计数');
    assert.ok(abc.suggestions.some(sg => sg.type === 'IMPULSE' && sg.verdict === 'VALID' && sg.points.length === 6), JSON.stringify(abc.suggestions.map(x => [x.type, x.verdict])));
    const rank = { VALID: 0, DOUBT: 1, FALSIFIED_PRICE: 2, FALSIFIED_SUB: 3, INVALID: 4 };
    const ends = q => [q[0].time, q[q.length - 1].time];
    abc.suggestions.forEach(sg => {
      assert.deepStrictEqual(ends(sg.points), ends(abc.result.points), `替代计数的起点、终点须与所画相同：${sg.name}`);
      assert.ok(sg.sameVerdict ? rank[sg.verdict] === rank[abc.verdict] : rank[sg.verdict] < rank[abc.verdict], `替代计数不得差于所画：${sg.name} ${sg.verdict}`);
      assert.ok(E.USER_TOOLS[sg.tool].types.includes(sg.type));
      assert.ok(sg.points.length >= 3);
    });
    const imp = run('IMPULSE', [1, 2, 3, 4, 5, 6]);
    if (imp.verdict === 'VALID') assert.deepStrictEqual(imp.suggestions, []);
  });
  it('精确用时: 同一组点在 4H 与 1H 上的时间规则判断一致 (不受所画周期粒度影响)', () => {
    // a 浪 6 小时、b 浪 55 小时、c 浪 80 小时 (15m 粒度生成)
    const legs = [[100, 96, 24], [96, 99.5, 220], [99.5, 92, 320], [92, 93, 40]];
    const m15 = [];
    let t = T0;
    for (const [a, b, n] of legs) {
      for (let k = 0; k < n; k++) {
        const o = a + (b - a) * k / n, c = a + (b - a) * (k + 1) / n;
        m15.push({ time: t, open: o, close: c, high: Math.max(o, c) + 0.01, low: Math.min(o, c) - 0.01 });
        t += 900;
      }
    }
    const agg = k => {
      const out = [];
      for (let i = 0; i < m15.length; i += k) {
        const g = m15.slice(i, i + k);
        out.push({ time: g[0].time, open: g[0].open, close: g[g.length - 1].close, high: Math.max(...g.map(x => x.high)), low: Math.min(...g.map(x => x.low)) });
      }
      return out;
    };
    const h1 = agg(4), h4 = agg(16);
    const at = (bars, i15) => bars.filter(b => b.time <= m15[i15].time).pop().time;
    const ends = [0, 23, 243, 563];
    const run = (tf, bars, sub) => E.evaluateUserCount(bars, 'TEST', { tool: 'ABC', forceType: 'ZIGZAG', timeframe: tf, subBars: sub,
      points: ends.map((i, k) => ({ time: at(bars, i), price: [100, 96, 99.5, 92][k] })) });
    const z5 = r => r.primary.ruleChecks.find(c => c.id === 'Z5');
    const r4 = run('4h', h4, { '1h': h1, '15m': m15 }), r1 = run('1h', h1, { '15m': m15 });
    assert.strictEqual(z5(r1).pass, true, z5(r1).detail);
    assert.strictEqual(z5(r4).pass, true, `4H 上 a 浪只占 1~2 根，按根数会判 b 超过 10 倍：${z5(r4).detail}`);
  });

  it('假设推演: 推动浪只画到浪3 时推演浪4 / 浪5，浪4 不进入浪1 价格区，画满且已完成时不推演', () => {
    const v = [96, 100, 110, 105, 122, 121.5];
    const bars = build(v);
    const run = ks => E.evaluateUserCount(bars['1h'], 'TEST', { tool: 'IMPULSE', forceType: 'IMPULSE', timeframe: '1h', subBars: { '15m': bars['15m'] },
      points: ks.map(k => pt(v, k, 3600)) });
    const r = run([1, 2, 3, 4]);
    assert.notStrictEqual(r.verdict, 'INVALID', r.reasons.join(' / '));
    const pj = r.projection;
    assert.ok(pj, '应给出推演');
    const by = l => pj.waves.find(w => w.label === l);
    assert.ok(by('4') && by('5'), JSON.stringify(pj.waves.map(w => w.label)));
    assert.ok(by('4').zone.lo >= 110 - 1e-9, '浪4 不进入浪1 价格区（浪1 终点 110）');
    assert.ok(by('4').inv && Math.abs(by('4').inv.price - r.live.points[1].price) < 1e-9, '浪4 失效位 = 浪1 终点');
    assert.ok(by('5').zone.mid > by('4').zone.mid, '上升推动浪: 浪5 中值高于浪4 中值');
    assert.ok(by('4').window.from > by('4').start.time && by('4').window.to >= by('4').window.from);
    assert.strictEqual(pj.path.length, pj.waves.length + 1);
    // 画满 0-5 且末浪已完成: 不推演
    const v2 = [96, 100, 110, 105, 122, 116, 130, 124, 125, 123, 124];
    const b2 = build(v2);
    const full = E.evaluateUserCount(b2['1h'], 'TEST', { tool: 'IMPULSE', timeframe: '1h', subBars: { '15m': b2['15m'] }, points: [1, 2, 3, 4, 5, 6].map(k => pt(v2, k, 3600)) });
    assert.strictEqual(full.projection, null);
  });

  describe('楔形', () => {
    // 15m 直线段生成K线 (阳线高点 +0.01，阴线 +0.004，相邻K线高低点不相等)
    const mk = segs => {
      const m15 = []; let t = T0;
      for (const [a, b, n] of segs) for (let k = 0; k < n; k++) {
        const o = a + (b - a) * k / n, c = a + (b - a) * (k + 1) / n;
        m15.push({ time: t, open: o, close: c, high: Math.max(o, c) + (c > o ? 0.01 : 0.004), low: Math.min(o, c) - (c < o ? 0.01 : 0.004) });
        t += 900;
      }
      const h1 = [];
      for (let i = 0; i < m15.length; i += 4) {
        const g = m15.slice(i, i + 4);
        h1.push({ time: g[0].time, open: g[0].open, close: g[g.length - 1].close, high: Math.max(...g.map(x => x.high)), low: Math.min(...g.map(x => x.low)) });
      }
      return { m15, h1 };
    };
    const three = (a, b, n) => { const d = b - a; return [[a, a + 0.62 * d, n], [a + 0.62 * d, a + 0.3 * d, n], [a + 0.3 * d, b, n]]; };
    const five = (a, b, n) => { const d = b - a; return [[a, a + 0.3 * d, n], [a + 0.3 * d, a + 0.18 * d, n], [a + 0.18 * d, a + 0.72 * d, n], [a + 0.72 * d, a + 0.6 * d, n], [a + 0.6 * d, b, n]]; };
    function build(legs) {
      const segs = [[legs[0][1] + 4, legs[0][1], 60]], marks = [];
      for (const [fn, a, b, n] of legs) { marks.push(segs.reduce((x, y) => x + y[2], 0)); fn(a, b, n).forEach(q => segs.push(q)); }
      marks.push(segs.reduce((x, y) => x + y[2], 0));
      const last = legs[legs.length - 1][2];
      segs.push([last, last - 6, 40]);
      const { m15, h1 } = mk(segs);
      const at = (i15, price) => ({ time: h1.filter(b => b.time <= m15[i15].time).pop().time, price });
      return { m15, h1, at, marks };
    }

    it('单独画的 3-3-3-3-3 识别为三浪腿的楔形，5-3-5-3-5 识别为引导楔形；楔形不套用推动浪比率指引', () => {
      const run = (types, v) => {
        const d = build(types.map((k, i) => [k === 5 ? five : three, v[i], v[i + 1], 8]));
        return E.evaluateUserCount(d.h1, 'TEST', { tool: 'IMPULSE', timeframe: '1h', subBars: { '15m': d.m15 }, points: d.marks.map((m, i) => d.at(m, v[i])) });
      };
      const ending = run([3, 3, 3, 3, 3], [100, 110, 102.2, 110.2, 105, 110.5]);
      assert.strictEqual(ending.primary.type, 'DIAGONAL');
      assert.strictEqual(ending.primary.structure, 'DIAGONAL_THREES', ending.primary.legs.map(L => L.name + ':' + L.found).join(' '));
      assert.ok(/3-3-3-3-3/.test(ending.primary.name), ending.primary.name);
      assert.ok(!ending.primary.ruleChecks.some(c => ['G1', 'G2', 'G3', 'G4', 'G5', 'I1'].includes(c.id)), '楔形不套用推动浪专属规则');
      const leading = run([5, 3, 5, 3, 5], [100, 110, 102.5, 110.5, 105.2, 110.8]);
      assert.strictEqual(leading.primary.structure, 'DIAGONAL_LEADING');
      assert.ok(/5-3-5-3-5/.test(leading.primary.name), leading.primary.name);
    });

    it('母浪浪5 内画终结楔形 (3-3-3-3-3、浪4 进入浪1 区)：子浪判终结楔形成立，母浪不冲突', () => {
      const d = build([
        [five, 100, 120, 10], [three, 120, 110, 10], [five, 110, 145, 12], [three, 145, 135, 10],
        [three, 135, 144, 6], [three, 144, 138, 6], [three, 138, 145, 6], [three, 145, 141, 6], [three, 141, 146, 6]
      ]);
      const mk6 = (idx, prices) => idx.map((k, i) => d.at(d.marks[k], prices[i]));
      const parent = mk6([0, 1, 2, 3, 4, 9], [100, 120, 110, 145, 135, 146]);
      const child = mk6([4, 5, 6, 7, 8, 9], [135, 144, 138, 145, 141, 146]);
      const r = E.evaluateUserSketch({ '1h': d.h1, '15m': d.m15 }, 'TEST', { drawings: [{ id: 'P', tool: 'IMPULSE', timeframe: '1h', points: parent }, { id: 'C', tool: 'IMPULSE', timeframe: '1h', points: child }] });
      const P = r.nodes.find(x => x.id === 'P'), C = r.nodes.find(x => x.id === 'C');
      assert.strictEqual(C.parentId, 'P');
      assert.strictEqual(C.result.primary.type, 'DIAGONAL');
      assert.ok(/终结楔形/.test(C.name) && /3-3-3-3-3/.test(C.name), C.name);
      assert.strictEqual(C.verdict, 'VALID', C.result.reasons.concat(C.result.doubts).join(' / '));
      assert.ok(P.result.primary.ruleChecks.filter(c => c.hard).every(c => c.pass), '母浪铁律全过');
      assert.ok(/浪5为终结楔形/.test(P.name), P.name);
    });
  });

  it('前序检验取同级别的前一段: 调整用时 5 段时不拿 1 段的小回调来比', () => {
    // 71→90→86→100 的上涨后 100→93→96→84→88→80 调整 (20 点、5 段)；最近的反向拐点 86 只走了 1 段
    const v = [62, 60, 75, 71, 90, 86, 100, 93, 96, 84, 88, 80, 83];
    const bars = build(v);
    const r = E.evaluateUserCount(bars['1h'], 'TEST', { tool: 'WXY', timeframe: '1h', subBars: { '15m': bars['15m'] }, points: [6, 7, 8, 11].map(k => pt(v, k, 3600)) });
    assert.ok(r.preceding, '应有前序');
    assert.ok(Math.abs(r.preceding.from.price - 71) < 0.1, `前序起点应为 71，实际 ${r.preceding.from.price}`);
    assert.ok(r.preceding.ratio < 1 && !r.preceding.warning, r.preceding.text);
  });

  it('楔形浪4 运行中给出浪4 价位 (浪3 终点 ± 浪2 长度)，扩张时注明两种口径分歧', () => {
    // 下跌楔形: 100→90 (浪1=10) →98 (浪2=8) →86 (浪3=12，长于浪1) →90.5 (浪4 运行中)
    const v = [96, 100, 90, 98, 86, 90.5];
    const bars = build(v);
    const r = E.evaluateUserCount(bars['1h'], 'TEST', { tool: 'IMPULSE', forceType: 'DIAGONAL', timeframe: '1h', subBars: { '15m': bars['15m'] }, points: [1, 2, 3, 4, 5].map(k => pt(v, k, 3600)) });
    const lim = r.invalidation.diagLimit;
    assert.ok(lim, '应给出楔形浪4 价位');
    const lp = r.live.points;
    assert.ok(Math.abs(lim.price - (lp[3].price + Math.abs(lp[2].price - lp[1].price))) < 1e-6);
    assert.strictEqual(lim.expandingByLength, true);
    assert.match(lim.text, /两种口径在此价分歧/);
  });

  it('并列假设: abc 画法同时给出驱动浪前三浪的解读及区分条件', () => {
    const v = [120, 100, 110, 105, 122, 121.5];
    const bars = build(v);
    const r = E.evaluateUserCount(bars['1h'], 'TEST', { tool: 'ABC', timeframe: '1h', subBars: { '15m': bars['15m'] }, points: [1, 2, 3, 4].map(k => pt(v, k, 3600)) });
    assert.strictEqual(r.hypotheses.length, 2, JSON.stringify(r.hypotheses));
    const prim = r.hypotheses.find(h => h.isPrimary), alt = r.hypotheses.find(h => !h.isPrimary);
    assert.strictEqual(prim.type, r.primary.type);
    assert.strictEqual(prim.verdict, r.verdict);
    assert.ok(['IMPULSE', 'DIAGONAL'].includes(alt.type));
    assert.ok(alt.conditions.some(c => /浪5/.test(c)), alt.conditions.join(' / '));
    assert.ok(prim.conditions.some(c => /起点/.test(c)), prim.conditions.join(' / '));
  });

  it('完成确认位: 推动浪完成后调整低点反弹收回 ≥0.382，跌破即确认完成', () => {
    const run = tail => {
      const v = [96, 100, 110, 105, 122, 116, 130].concat(tail);
      const bars = build(v);
      return E.evaluateUserCount(bars['1h'], 'TEST', { tool: 'IMPULSE', timeframe: '1h', subBars: { '15m': bars['15m'] }, points: [1, 2, 3, 4, 5, 6].map(k => pt(v, k, 3600)) });
    };
    const before = run([122, 127, 124]);
    assert.ok(before.invalidation.completion, '应给出完成确认位');
    assert.ok(Math.abs(before.invalidation.completion.price - 122) < 0.1, before.invalidation.completion.text);
    assert.strictEqual(before.invalidation.completion.broken, false);
    const after = run([122, 127, 119, 121]);
    assert.strictEqual(after.invalidation.completion.broken, true, after.invalidation.completion.text);
    assert.match(after.invalidation.completion.text, /确认.*已结束/);
  });

  it('升一级重数: 小级别计数被走势证伪时，起点不变、按大一级重新取三个转折', () => {
    // 100→103→102→106 画成楔形前三浪；之后跌到 101.5 (破浪2 终点) 再涨到 105.5
    const v = [104, 100, 103, 102, 106, 101.5, 105.5, 105];
    const bars = build(v);
    const sk = E.evaluateUserSketch({ '1h': bars['1h'], '15m': bars['15m'] }, 'TEST',
      { drawings: [{ id: 'R', tool: 'IMPULSE', type: 'DIAGONAL', timeframe: '1h', points: [1, 2, 3, 4].map(k => pt(v, k, 3600)) }] });
    const nd = sk.nodes[0];
    assert.strictEqual(nd.verdict, 'FALSIFIED_PRICE', nd.verdictLabel);
    const rg = nd.suggestions.filter(x => x.source === 'REGROUP');
    assert.ok(rg.length > 0, JSON.stringify(nd.suggestions.map(x => [x.source, x.type])));
    const p = rg[0].points;
    assert.ok(Math.abs(p[1].price - 106) < 0.1 && Math.abs(p[2].price - 101.5) < 0.1, p.map(q => q.price).join(','));
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
