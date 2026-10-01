const { describe, it } = require('node:test');
const assert = require('node:assert');
const E = require('../server/wave_engine');

const { evaluatePattern, _internal } = E;
const S = 6; // 每段K线数

/**
 * 由折线顶点生成K线，并返回每个顶点对应的拐点 {idx,time,price,type}。
 * mains: 需要作为主级别拐点的顶点下标
 */
function build(pathPts, mains) {
  const bars = [];
  let t = 1700000000;
  for (let k = 1; k < pathPts.length; k++) {
    const a = pathPts[k - 1], b = pathPts[k];
    for (let s = 0; s < S; s++) {
      const o = a + (b - a) * s / S, c = a + (b - a) * (s + 1) / S;
      bars.push({ time: t, open: o, close: c, high: Math.max(o, c) + 0.05, low: Math.min(o, c) - 0.05 });
      t += 3600;
    }
  }
  const pivotAt = k => {
    const idx = k === 0 ? 0 : k * S - 1;
    const prev = k === 0 ? pathPts[1] : pathPts[k - 1];
    return { idx, time: bars[idx].time, price: pathPts[k], type: pathPts[k] > prev ? 'high' : 'low', confirmed: true };
  };
  const ev = { bars, highs: bars.map(b => b.high), lows: bars.map(b => b.low), sources: null, structCache: new Map() };
  return { bars, ev, pts: mains.map(pivotAt) };
}

describe('Module 8 v3: 调整浪子形态识别与交替原则', () => {
  it('子形态识别: 浪4内部为收缩三角形 (a-b-c-d-e 收敛)', () => {
    // 0 100 →1 200 →(浪2单锯齿) 160,180,140 →3 320 →(浪4三角形) 290,312,296,308,300 →5 400
    const path = [100, 200, 160, 180, 140, 320, 290, 312, 296, 308, 300, 400];
    const { ev, pts } = build(path, [0, 1, 4, 5, 10, 11]);
    const w4 = _internal.classifyCorrectiveLeg(pts[3], pts[4], ev, false);
    assert.ok(w4 && w4.best, '应识别出浪4子形态');
    assert.strictEqual(w4.best.type, 'TRIANGLE');
    assert.strictEqual(w4.form, 'sideways');
    const w2 = _internal.classifyCorrectiveLeg(pts[1], pts[2], ev, false);
    assert.strictEqual(w2.best.type, 'ZIGZAG');
    assert.strictEqual(w2.form, 'sharp');
  });

  it('交替原则: 浪2单锯齿(陡) + 浪4三角形(横) → 通过，I2 指引计分', () => {
    // 浪3 分三段推进 (用时足够，满足手稿M8「浪4用时≤2×浪3」)
    const path = [100, 200, 160, 180, 140, 250, 230, 320, 290, 312, 296, 308, 300, 400];
    const { ev, pts } = build(path, [0, 1, 4, 7, 12, 13]);
    const res = evaluatePattern('IMPULSE', pts, ev);
    assert.strictEqual(res.hardFails.length, 0);
    const i2 = res.checks.find(c => c.id === 'I2');
    assert.ok(i2 && i2.pass && !i2.neutral && !i2.pending, i2 && i2.detail);
    assert.ok(/一陡一横/.test(i2.detail), i2.detail);
  });

  it('交替原则: 浪2与浪4同为单锯齿 → 未交替，I2 不通过（仅降权，不否决）', () => {
    // 浪4: 320→290→305→280 单锯齿
    const path = [100, 200, 160, 180, 140, 250, 230, 320, 290, 305, 280, 400];
    const { ev, pts } = build(path, [0, 1, 4, 7, 10, 11]);
    const res = evaluatePattern('IMPULSE', pts, ev);
    assert.strictEqual(res.hardFails.length, 0, '交替是指引，不应产生硬性否决');
    const i2 = res.checks.find(c => c.id === 'I2');
    assert.strictEqual(i2.pass, false, i2.detail);
    assert.ok(/未交替/.test(i2.detail));
  });

  it('浪3运行中: 由浪2形态预判浪4 (浪2陡 → 浪4预期横向)', () => {
    const path = [100, 200, 160, 180, 140, 300];
    const { ev, pts } = build(path, [0, 1, 4, 5]);
    pts[3].open = true;
    const g = _internal.mkGeom(pts);
    const alt = _internal.alternationFor(g, ev);
    assert.strictEqual(alt.pass, null);
    assert.strictEqual(alt.expectWave4.form, 'sideways');
    assert.deepStrictEqual(alt.expectWave4.types, ['FLAT', 'TRIANGLE', 'EXPANDING_TRIANGLE', 'COMBINATION']);
  });

  it('浪4运行中: 列出仍成立的浪4形态（柳玉冬「平台形可以否定，剩余联合形、三角形」式排除）', () => {
    // 浪4 已走 a-b-c-d 四段收敛，e 浪进行中
    const path = [100, 200, 160, 180, 140, 320, 290, 312, 296, 308, 302];
    const { ev, pts } = build(path, [0, 1, 4, 5, 10]);
    pts[4].open = true;
    const w4 = _internal.classifyCorrectiveLeg(pts[3], pts[4], ev, true);
    assert.ok(w4.developing);
    assert.ok(w4.alive.some(a => a.type === 'TRIANGLE'), JSON.stringify(w4.alive.map(a => a.type)));
    const g = _internal.mkGeom(pts);
    const alt = _internal.alternationFor(g, ev);
    assert.ok(alt.wave4 && /仍成立/.test(alt.wave4.text));
  });

  it('联合形组成部分: 三角形只能作最后一部分 (w为三角形 → CG5 不通过)', () => {
    // w: 400→370→392→376→388→380 (三角形, 净跌20)；x: →395；y: 395→375→385→360 (单锯齿)
    const path = [400, 370, 392, 376, 388, 380, 395, 375, 385, 360];
    const { ev, pts } = build(path, [0, 5, 6, 9]);
    const res = evaluatePattern('COMBINATION', pts, ev);
    assert.strictEqual(res.hardFails.length, 0, JSON.stringify(res.hardFails.map(f => f.id)));
    const cg5 = res.checks.find(c => c.id === 'CG5');
    assert.strictEqual(cg5.pass, false, cg5.detail);
    assert.ok(/w=收缩三角形/.test(cg5.detail), cg5.detail);
    const comps = _internal.combinationComponents('COMBINATION', _internal.mkGeom(pts), ev, 'COMPLETED');
    assert.strictEqual(comps[1].class.best.type, 'ZIGZAG');
  });

  it('时间规则前瞻: 浪2运行中给出截止日期 (≤浪1用时×9, 手稿P34 M7)', () => {
    const path = [100, 200, 160];
    const { ev, pts } = build(path, [0, 1, 2]);
    pts[2].open = true;
    const g = _internal.mkGeom(pts);
    const tw = _internal.buildTimeWindows('IMPULSE', g, 'DEVELOPING', ev);
    const dl = tw.find(w => w.kind === 'deadline');
    assert.ok(dl && dl.rule === 'M7');
    assert.strictEqual(dl.maxBars, 9 * g.t[0]);
    assert.strictEqual(dl.deadline, pts[1].time + 9 * g.t[0] * 3600);
    assert.ok(/前结束/.test(dl.text));
    assert.strictEqual(_internal.buildTimeWindows('IMPULSE', g, 'COMPLETED', ev).filter(w => w.kind === 'deadline').length, 0, '已完成的计数不再给截止日期');
  });

  it('时间规则前瞻: 收缩三角形给出边界交点日期（柳玉冬「交叉点在X日，必须在此之前突破」）', () => {
    const path = [400, 370, 392, 376, 388, 380];
    const { ev, pts } = build(path, [0, 1, 2, 3, 4, 5]);
    const g = _internal.mkGeom(pts);
    const apex = _internal.buildTimeWindows('TRIANGLE', g, 'COMPLETED', ev).find(w => w.kind === 'apex');
    assert.ok(apex, '应给出三角形交点');
    assert.ok(apex.deadline > pts[5].time);
  });

  it('扩散平台形(穿头破脚): b浪越过a浪起点、c浪跌破a浪终点 → 硬规则通过并标注扩散平台形', () => {
    const P = (idx, price, type) => ({ idx, time: idx, price, type, confirmed: true });
    const pts = [P(0, 200, 'high'), P(10, 150, 'low'), P(22, 210, 'high'), P(34, 130, 'low')];
    const res = evaluatePattern('FLAT', pts, null);
    assert.strictEqual(res.hardFails.length, 0);
    const zz = evaluatePattern('ZIGZAG', pts, null);
    assert.ok(zz.hardFails.some(f => f.id === 'Z2'), '单锯齿b浪不得越过a起点');
  });
});
