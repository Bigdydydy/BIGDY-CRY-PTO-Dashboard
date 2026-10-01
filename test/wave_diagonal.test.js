const { describe, it } = require('node:test');
const assert = require('node:assert');
const E = require('../server/wave_engine');

const T0 = 1780000000 - (1780000000 % 14400);
const STEPS = 24;

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

function clickAt(vertices, k) {
  return { time: T0 + Math.floor(k * STEPS / 16) * 14400, price: vertices[k] };
}

/** 前缀 + 各段子浪顶点 → 顶点序列与各主浪端点下标 */
function path(prefix, segs, tail) {
  const v = prefix.slice();
  const ends = [v.length - 1];
  for (const seg of segs) { v.push(...seg); ends.push(v.length - 1); }
  return { v: v.concat(tail || []), ends };
}

function evaluate(v, ends, tool) {
  const { m15, h4 } = build(v, STEPS);
  return E.evaluateUserCount(h4, 'TEST', { tool: tool || 'IMPULSE', points: ends.map(k => clickAt(v, k)), timeframe: '4h', subBars: { '15m': m15 } });
}

/**
 * 阶梯行情: 从 from 起，n 组「推进 1.4 步 / 回撤 0.4 步」。
 * endOnRetrace=true 时以回撤收尾 (to 为趋势中途的回撤低点)，否则以推进收尾 (to 为趋势极值)。
 */
function staircase(from, to, n, endOnRetrace) {
  const dir = to > from ? 1 : -1;
  const step = Math.abs(to - from) / (endOnRetrace ? n : n + 0.4);
  const out = [from];
  let p = from;
  for (let i = 0; i < n; i++) {
    p += dir * step * 1.4;
    out.push(+p.toFixed(2));
    if (i < n - 1 || endOnRetrace) { p -= dir * step * 0.4; out.push(+p.toFixed(2)); }
  }
  out[out.length - 1] = to;
  return out;
}

const PREFIX = [120, 108, 112, 100];
const W1 = [110, 105, 122, 116, 130];
const W2 = [118, 124, 112];
const W3 = [130, 122, 160, 150, 172];
const W4 = [160, 166, 150];

// 收缩楔形，各段为三浪 (a-b-c)：1=20 2=12 3=18 4=11 5=14，浪4(120)切入浪1(125)
const DIAG_33333 = [[115, 110, 125], [119, 122, 113], [123, 118, 131], [125, 128, 120], [127, 123, 134]];

describe('Module 8: 楔形 (引导 / 终结) 与失败第五浪', () => {
  it('推动浪的浪5为终结楔形 (15m 上数成重叠五段) → 浪5子浪通过并标注终结楔形', () => {
    // 浪5: 150→166→156→170→162→173，浪4(162)切入浪1(166)：收缩终结楔形
    const W5_DIAG = [166, 156, 170, 162, 173];
    const { v, ends } = path(PREFIX, [W1, W2, W3, W4, W5_DIAG], [150, 154, 140]);
    const r = evaluate(v, ends);
    assert.strictEqual(r.primary.type, 'IMPULSE');
    assert.strictEqual(r.primary.hardFails.length, 0);
    const w5 = r.primary.legs[4];
    assert.strictEqual(w5.status, 'PASS', w5.text);
    assert.strictEqual(w5.diagonal, '终结楔形');
    assert.match(r.primary.name, /浪5为终结楔形/);
    assert.ok(r.targets.some(x => /终结楔形起点/.test(x.label) && Math.abs(x.price - 150) < 0.5), JSON.stringify(r.targets));
  });

  it('浪3只能数成楔形 → 存疑 (浪3不能是楔形)', () => {
    // 浪3: 112→136→124→152→132→172，浪4(132)切入浪1(136)，数不成推动浪
    const W3_DIAG = [136, 124, 152, 132, 172];
    const { v, ends } = path(PREFIX, [W1, W2, W3_DIAG, W4, [160, 155, 172, 166, 180]], [170]);
    const r = evaluate(v, ends);
    assert.strictEqual(r.primary.type, 'IMPULSE');
    const w3 = r.primary.legs[2];
    assert.strictEqual(w3.status, 'DOUBT', w3.text);
    assert.match(w3.text, /浪3不能是楔形/);
  });

  it('上涨趋势末端的 3-3-3-3-3 收缩楔形 → 终结楔形，完成后目标回到楔形起点', () => {
    const prefix = staircase(40, 105, 15, true);
    const { v, ends } = path(prefix, DIAG_33333, [110, 116, 100]);
    const r = evaluate(v, ends);
    assert.strictEqual(r.primary.type, 'DIAGONAL', r.primary.name);
    assert.match(r.primary.name, /^收缩终结楔形（3-3-3-3-3）/);
    assert.strictEqual(r.primary.hardFails.length, 0);
    assert.ok(r.primary.legs.every(L => L.status === 'PASS'), r.primary.legs.map(L => L.text).join('\n'));
    assert.ok(r.targets.some(x => /终结楔形起点/.test(x.label) && Math.abs(x.price - 105) < 0.5), JSON.stringify(r.targets));
    const { h4 } = build(v, STEPS);
    const g = { p: ends.map(k => clickAt(v, k)), d: 1 };
    assert.strictEqual(E._internal.diagonalRole(g, { bars: h4 }), 'ENDING');
  });

  it('下跌之后新低起步的 3-3-3-3-3 楔形 → 引导楔形 (引导楔形也可为 3-3-3-3-3)', () => {
    const prefix = staircase(200, 105, 15, false);
    const { v, ends } = path(prefix, DIAG_33333, [115, 119, 112]);
    const r = evaluate(v, ends);
    assert.strictEqual(r.primary.type, 'DIAGONAL', r.primary.name);
    assert.match(r.primary.name, /^收缩引导楔形（3-3-3-3-3）/);
    const { h4 } = build(v, STEPS);
    const g = { p: ends.map(k => clickAt(v, k)), d: 1 };
    assert.strictEqual(E._internal.diagonalRole(g, { bars: h4 }), 'LEADING');
  });

  it('失败第五浪: 浪5未越过浪3终点但内部五浪、长度≥0.7×浪4 → 成立并标注', () => {
    // 浪5: 150→160→155→168→163→169 (<172)，长 19 ≥ 0.7×22；浪3=60 ≥ 1.618×浪1(30)
    const { v, ends } = path(PREFIX, [W1, W2, W3, W4, [160, 155, 168, 163, 169]], [150, 154, 140]);
    const r = evaluate(v, ends);
    assert.strictEqual(r.primary.type, 'IMPULSE');
    assert.strictEqual(r.primary.hardFails.length, 0, JSON.stringify(r.primary.hardFails));
    assert.match(r.primary.name, /失败第五浪/);
    assert.strictEqual(r.primary.legs[4].status, 'PASS', r.primary.legs[4].text);
  });

  it('失败第五浪内部只有三段 → 浪5子浪证伪 (更可能浪4未完)', () => {
    const { v, ends } = path(PREFIX, [W1, W2, W3, W4, [162, 156, 169]], [150, 154, 140]);
    const r = evaluate(v, ends);
    assert.strictEqual(r.primary.type, 'IMPULSE');
    assert.strictEqual(r.primary.legs[4].status, 'FAIL', r.primary.legs[4].text);
    assert.strictEqual(r.verdict, 'FALSIFIED_SUB');
  });

  it('楔形规则: 浪4切入浪1只在浪4为末点时暂缓，浪5运行中仍须满足 (D1)', () => {
    // 浪4(150) 未切入浪1(130)：按楔形必须否决，即使浪5尚未确认
    const pts = [100, 130, 112, 172, 150, 165].map((price, i) => ({ idx: i * 10, time: T0 + i * 144000, price, type: i % 2 ? 'high' : 'low' }));
    pts[5].open = true;
    const res = E.evaluatePattern('DIAGONAL', pts, null);
    assert.ok(res.hardFails.some(c => c.id === 'D1'), JSON.stringify(res.hardFails.map(c => c.id)));
    // 浪4为末点且未确认时，切入要求暂缓 (浪4可能继续下探)
    const res4 = E.evaluatePattern('DIAGONAL', pts.slice(0, 5).map((p, i) => i === 4 ? Object.assign({}, p, { open: true }) : p), null);
    assert.ok(!res4.hardFails.some(c => c.id === 'D1'));
  });

  it('扩张三角形: 各段依次放大、边界发散 → 收缩三角形否决，扩张三角形成立', () => {
    // 0=120 a→112 b→124 c→106 d→130 e→100；a=8 b=12 c=18 d=24 e=30，各段为三浪
    const legs = [[116, 118, 112], [119, 116, 124], [116, 120, 106], [117, 113, 130], [118, 123, 100]];
    const prefix = staircase(60, 120, 12, false);
    const { v, ends } = path(prefix, legs, [110, 106, 118]);
    const r = evaluate(v, ends, 'ABCDE');
    assert.strictEqual(r.primary.type, 'EXPANDING_TRIANGLE', r.primary.name);
    assert.strictEqual(r.primary.hardFails.length, 0, JSON.stringify(r.primary.hardFails));
    assert.match(r.primary.name, /扩张三角形/);
    const tri = r.interpretations.find(i => i.type === 'TRIANGLE');
    assert.ok(tri.hardFails > 0, '收缩三角形应被铁律否决 (c<b、d≤c 等)');
  });

  it('扩张三角形规则: c须大于b (E1)、d须大于c (E2)', () => {
    const mk = arr => arr.map((price, i) => ({ idx: i * 10, time: T0 + i * 144000, price, type: i % 2 ? 'low' : 'high' }));
    const ok = E.evaluatePattern('EXPANDING_TRIANGLE', mk([120, 112, 124, 106, 130, 100]), null);
    assert.ok(!ok.hardFails.length, JSON.stringify(ok.hardFails.map(c => c.id)));
    const contracting = E.evaluatePattern('EXPANDING_TRIANGLE', mk([120, 100, 116, 104, 112, 107]), null);
    assert.ok(contracting.hardFails.some(c => c.id === 'E1'));
  });

  it('楔形规则: 收缩楔形浪4须小于浪2 (D3)、浪5须小于浪3 (D5)', () => {
    const mk = arr => arr.map((price, i) => ({ idx: i * 10, time: T0 + i * 144000, price, type: i % 2 ? 'high' : 'low' }));
    // 3<1 (收缩)，但 4(16) > 2(12)
    const bad4 = E.evaluatePattern('DIAGONAL', mk([100, 120, 108, 126, 110, 122]), null);
    assert.ok(bad4.hardFails.some(c => c.id === 'D3'));
    const good = E.evaluatePattern('DIAGONAL', mk([100, 120, 108, 126, 117, 130]), null);
    assert.ok(!good.hardFails.length, JSON.stringify(good.hardFails.map(c => c.id)));
  });
});
