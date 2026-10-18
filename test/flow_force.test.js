const test = require('node:test');
const assert = require('node:assert');
const { computeFlowForce, venuePressure, aggregateBars, normCdf, summarize } = require('../server/flow_force');

const HOUR = 3.6e6;

/** 确定性伪随机K线：rets 为逐根对数收益，vol 为逐根美元成交额 */
function makeBars(rets, vols, start = Date.UTC(2026, 0, 5)) {
  let c = 80000;
  return rets.map((r, i) => {
    const o = c;
    c = o * Math.exp(r);
    return { t: start + i * HOUR, o, h: Math.max(o, c), l: Math.min(o, c), c, v: vols[i] };
  });
}

function noise(n, seed = 1) {
  let s = seed;
  return Array.from({ length: n }, () => {
    s = (s * 16807) % 2147483647;
    return (s / 2147483647 - 0.5) * 0.004;
  });
}

test('normCdf 对称且与标准值吻合', () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-4);
  assert.ok(Math.abs(normCdf(-1) + normCdf(1) - 1) < 1e-9);
});

test('venuePressure: 恒定刷量不制造信号，异常放量才放大压力', () => {
  const rets = noise(120);
  rets[110] = 0.01; // 一根显著上涨
  const flat = makeBars(rets, rets.map(() => 1e6));
  const washed = makeBars(rets, rets.map(() => 5e6)); // 同样走势、成交额整体 ×5 (持续刷量)
  const surge = makeBars(rets, rets.map((_, i) => (i === 110 ? 4e6 : 1e6)));
  const t = flat[110].t;
  const pf = venuePressure(flat).get(t).p;
  assert.ok(pf > 0.9, '显著上涨对应正的净主动量');
  assert.ok(Math.abs(venuePressure(washed).get(t).p - pf) < 1e-9, '成交额整体放大倍数被自身基线抵消');
  assert.ok(Math.abs(venuePressure(surge).get(t).p - 4 * pf) < 1e-9, '相对自身基线 4 倍放量 → 压力 ×4');
});

test('computeFlowForce: 期货放量时柱为正 (期货主导)，现货放量时为负', () => {
  const rets = noise(120, 7);
  rets[110] = 0.012;
  const base = rets.map(() => 1e6);
  const boosted = rets.map((_, i) => (i === 110 ? 5e6 : 1e6));
  const t = makeBars(rets, base)[110].t / 1000;

  const futLed = computeFlowForce({
    bnPerp: makeBars(rets, boosted), okxPerp: makeBars(rets, boosted), hlPerp: makeBars(rets, boosted),
    bnSpot: makeBars(rets, base), okxSpot: makeBars(rets, base), usSpot: makeBars(rets, base)
  });
  const rowF = futLed.find(p => p.time === t);
  assert.ok(rowF.hist > 0, '期货相对放量 → 柱 > 0');

  const westSpotLed = computeFlowForce({
    bnPerp: makeBars(rets, base), okxPerp: makeBars(rets, base), hlPerp: makeBars(rets, base),
    bnSpot: makeBars(rets, base), okxSpot: makeBars(rets, base), usSpot: makeBars(rets, boosted)
  });
  const rowS = westSpotLed.find(p => p.time === t);
  assert.ok(rowS.hist < 0, 'Coinbase 现货放量 → 柱 < 0 (现货主导)');
  assert.ok(rowS.region < 0, 'Coinbase 现货放量 → 点 < 0 (欧美主导)');
});

test('computeFlowForce: 同格按深度加权，缺失场所不阻断计算', () => {
  const rets = noise(120, 3);
  rets[110] = 0.01;
  const base = rets.map(() => 1e6);
  const boosted = rets.map((_, i) => (i === 110 ? 6e6 : 1e6));
  const t = makeBars(rets, base)[110].t / 1000;
  const venues = {
    bnPerp: makeBars(rets, base), okxPerp: makeBars(rets, boosted), hlPerp: [],
    bnSpot: makeBars(rets, base), okxSpot: [], usSpot: makeBars(rets, base)
  };
  const lowOkx = computeFlowForce(venues, { bnPerp: 9, okxPerp: 1 }).find(p => p.time === t);
  const highOkx = computeFlowForce(venues, { bnPerp: 1, okxPerp: 9 }).find(p => p.time === t);
  assert.ok(highOkx.futAsia > lowOkx.futAsia, 'OKX 深度占比越高，其放量对期货/亚太格的影响越大');
  assert.strictEqual(lowOkx.futWest, null, 'Hyperliquid 缺失时该格为 null');
  assert.ok(Number.isFinite(lowOkx.hist), '其余格仍可合成柱值');
});

test('Coinbase 溢价按 USDT/USD 换汇：USDT 折价 13bps 时原始价差 −13bps 对应真实溢价 ≈0', () => {
  const rets = noise(80, 5);
  const base = rets.map(() => 1e6);
  const bnSpot = makeBars(rets, base);
  const rate = 0.9987; // 1 USDT = 0.9987 USD
  // Coinbase 美元价 = 币安 USDT 价 × 汇率 (没有真实溢价)
  const usSpot = bnSpot.map(b => ({ ...b, o: b.o * rate, h: b.h * rate, l: b.l * rate, c: b.c * rate }));
  const venues = { bnPerp: makeBars(rets, base), okxPerp: [], hlPerp: [], bnSpot, okxSpot: [], usSpot };
  const rates = new Map(bnSpot.map(b => [b.t, rate]));
  const last = computeFlowForce(venues, {}, rates).at(-1);
  assert.ok(Math.abs(last.usPremiumRawBps - -13) < 0.01, '未换汇价差 = USDT 折价');
  assert.ok(Math.abs(last.usPremiumBps) < 0.01, '换汇后真实溢价为 0');
  const noRate = computeFlowForce(venues).at(-1);
  assert.strictEqual(noRate.usPremiumBps, null, '无汇率时不给出换汇溢价');
});

test('TradingView 行情帧拆分', () => {
  const { splitFrames } = require('../server/tradingview_feed');
  const a = JSON.stringify({ m: 'series_completed', p: [] });
  assert.deepStrictEqual(splitFrames(`~m~${a.length}~m~${a}~m~4~m~~h~7`), [a, '~h~7']);
});

test('aggregateBars: 1h → 4h 按 UTC 对齐并丢弃不完整首桶', () => {
  const bars = makeBars(noise(10), Array(10).fill(1), Date.UTC(2026, 0, 5, 2));
  const out = aggregateBars(bars, 4 * HOUR);
  assert.strictEqual(new Date(out[0].t).getUTCHours(), 4);
  assert.strictEqual(out[0].v, 4);
  assert.strictEqual(out[0].o, bars[2].o);
  assert.strictEqual(out[0].c, bars[5].c);
});

test('summarize 只看已收盘K线', () => {
  const series = [
    { hist: 0.5, region: -0.2, fut: 1, spot: 0.5 },
    { hist: 0.3, region: -0.4, fut: 1, spot: 0.5 },
    { hist: 0.1, region: -0.1, fut: 1, spot: 0.5 },
    { hist: -9, region: 9, fut: -1, spot: -1 } // 进行中，不计入
  ];
  const s = summarize(series);
  assert.strictEqual(s.leader, 'futures');
  assert.strictEqual(s.regionLeader, 'west');
  assert.strictEqual(s.futDir, '净买');
});
