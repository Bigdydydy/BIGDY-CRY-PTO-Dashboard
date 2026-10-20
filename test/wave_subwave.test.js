const { describe, it } = require('node:test');
const assert = require('node:assert');
const { _internal } = require('../server/wave_engine');

const H = 3600e3;
// BTC 2026-09-22 → 10-15 的 a 浪内 15m 主要拐点 (高低交替)
const PIVS = [
  [87385, 'high'], [82832, 'low'], [85224, 'high'], [82500, 'low'],
  [87250, 'high'], [80345, 'low'], [84340, 'high'], [79732, 'low'],
].map(([price, type], i) => ({ price, type, time: 1790000000000 + i * 24 * H, idx: i * 96 }));

describe('Module 8: 子浪自动补完的「一浪」定义', () => {
  it('一浪的两端都须是区间极值: 中间有更高的高点时，下跌段不能从较低的高点起算', () => {
    const ok = _internal.buildLegTable(PIVS);
    assert.strictEqual(ok[2][5], false, '85,224 → 80,345 之间有 87,250，起点不是极值');
    assert.strictEqual(ok[4][5], true);
    assert.strictEqual(ok[0][3], true, '87,385 → 82,500 中间的 85,224 不越过两端');
    assert.strictEqual(ok[1][4], false, '82,832 → 87,250 之间有更低的 82,500');
  });

  it('五浪按同级别显著性择优: (ii) 取 87,250 而不是 85,224', () => {
    const pts = _internal.findMotiveCount(PIVS);
    assert.ok(pts, '应能数出五浪');
    assert.deepStrictEqual(pts.map(p => p.price), [87385, 82500, 87250, 80345, 84340, 79732]);
  });
});
