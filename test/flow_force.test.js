const test = require('node:test');
const assert = require('node:assert');
process.env.FLOW_FORCE_NO_STREAMS = '1';
const { computeFlowForce, venuePressure, aggregateBars, normCdf, summarize, mergeVenue, applyFrozen, emptyStore, FIXED_WEIGHTS } = require('../server/flow_force');

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

test('aggregateBars: 1h → 4h 按 UTC 对齐，首桶不完整时由子K线数标出', () => {
  const bars = makeBars(noise(10), Array(10).fill(1), Date.UTC(2026, 0, 5, 2));
  const out = aggregateBars(bars, 4 * HOUR, 0, 4);
  assert.strictEqual(new Date(out[0].t).getUTCHours(), 0);
  assert.strictEqual(out[0].n, 2, '02:00、03:00 两根 → 不完整');
  assert.strictEqual(new Date(out[1].t).getUTCHours(), 4);
  assert.strictEqual(out[1].n, 4);
  assert.strictEqual(out[1].v, 4);
  assert.strictEqual(out[1].o, bars[2].o);
  assert.strictEqual(out[1].c, bars[5].c);
});

const ALL6 = ['bnPerp', 'okxPerp', 'hlPerp', 'bnSpot', 'okxSpot', 'usSpot'];
function sixVenues(rets, vols, start) {
  const out = {};
  // 每个场所放量节奏不同，缺一个场所时合成结果才会变化
  ALL6.forEach((k, j) => { out[k] = makeBars(rets, vols.map((v, i) => v * (1 + ((i + j * 3) % 5) / 4)), start); });
  return out;
}

test('mergeVenue: 已收盘K线先写入者为准，进行中/不完整的不入档', () => {
  const st = emptyStore();
  const start = Date.UTC(2026, 0, 5);
  const bars = makeBars(noise(6), Array(6).fill(100), start);
  const now = start + 5 * HOUR + 30 * 60e3; // 第 6 根 (05:00) 进行中
  mergeVenue(st, 'okxPerp', bars, '1h', now);
  assert.strictEqual(st.bars.okxPerp.size, 5, '只存 5 根已收盘');
  // 换一个数据源，同一时间点给出不同的值 → 存档不变
  const other = bars.map(b => ({ ...b, v: 999, c: b.c + 1 }));
  const used = mergeVenue(st, 'okxPerp', other, '1h', now);
  assert.strictEqual(st.bars.okxPerp.get(start).v, 100, '已存的K线不被覆盖');
  assert.strictEqual(used.at(-1).v, 999, '进行中的K线用最新值');
  // 已收盘但子K线不全的合成K线既不入档也不参与计算
  const agg = [{ t: start + 6 * HOUR, o: 1, h: 1, l: 1, c: 1, v: 1, n: 3, need: 4 }];
  const used2 = mergeVenue(st, 'usSpot', agg, '1h', now + 3 * HOUR);
  assert.strictEqual(st.bars.usSpot.size, 0);
  assert.strictEqual(used2.length, 0);
});

test('mergeVenue: TradingView 成交量口径与存档相差 20 倍以上时整批丢弃', () => {
  const st = emptyStore();
  const start = Date.UTC(2026, 0, 5);
  const now = start + 40 * HOUR;
  mergeVenue(st, 'okxPerp', makeBars(noise(30), Array(30).fill(1e6), start), '1h', now);
  const tv = makeBars(noise(5), Array(5).fill(8e10), start + 30 * HOUR).map(b => ({ ...b, viaTv: true }));
  mergeVenue(st, 'okxPerp', tv, '1h', now);
  assert.strictEqual(st.bars.okxPerp.size, 30, '量级不符的 TradingView K线未入档');
});

test('venuePressure: 存档有缺口时不拿跨缺口的窗口凑数', () => {
  const bars = makeBars(noise(80), Array(80).fill(1e6));
  const gapped = bars.filter((_, i) => i !== 60);
  const p = venuePressure(gapped, 50, { tfMs: HOUR });
  assert.ok(!p.has(bars[61].t), '窗口跨过缺口 → 不出值');
  assert.ok(!p.has(bars[79].t), '缺口后不满 51 根连续K线 → 仍不出值');
  assert.ok(p.has(bars[59].t), '缺口之前正常');
});

test('进行中K线按已过时间折算成交额', () => {
  const rets = noise(60, 9);
  rets[59] = 0.01;
  const bars = makeBars(rets, Array(60).fill(1e6));
  const t = bars[59].t;
  const full = venuePressure(bars, 50).get(t).p;
  // 只过了 1/4，成交额也只有 1/4 → 折算后与整根相同
  const partial = bars.map((b, i) => (i === 59 ? { ...b, v: b.v / 4 } : b));
  const p = venuePressure(partial, 50, { tfMs: HOUR, now: t + HOUR / 4 }).get(t);
  assert.ok(Math.abs(p.p - full) < 1e-9);
  assert.strictEqual(p.frac, 0.25);
});

test('定死: 已收盘且 6 场所齐全的行写死，之后场所缺失也不改变历史', () => {
  const rets = noise(80, 11);
  const vols = rets.map((_, i) => 1e6 * (1 + (i % 7) / 10));
  const start = Date.UTC(2026, 0, 5);
  const now = start + 80 * HOUR + 10 * 60e3;
  const rates = new Map(makeBars(rets, vols, start).map(b => [b.t, 1]));
  const opts = { tfMs: HOUR, now };
  const st = emptyStore();

  const full = computeFlowForce(sixVenues(rets, vols, start), FIXED_WEIGHTS, rates, opts);
  const first = applyFrozen(st, full, '1h', now);
  assert.ok(first.newlyFrozen > 20);
  const frozenTime = full.find(r => r.complete && !r.live).time;
  const before = first.series.find(r => r.time === frozenTime);

  // OKX 永续断线：重算结果会变，但定死的行原样返回
  const degradedVenues = sixVenues(rets, vols, start);
  degradedVenues.okxPerp = [];
  const degraded = computeFlowForce(degradedVenues, FIXED_WEIGHTS, rates, opts);
  const recomputed = degraded.find(r => r.time === frozenTime);
  assert.notStrictEqual(recomputed.futAsia, before.futAsia, '没有定死时，缺 OKX 会改变期货/亚太');
  assert.deepStrictEqual(recomputed.missing, ['okxPerp']);
  assert.strictEqual(recomputed.complete, false);
  const second = applyFrozen(st, degraded, '1h', now);
  assert.deepStrictEqual(second.series.find(r => r.time === frozenTime), before, '定死的行不变');
  assert.strictEqual(second.newlyFrozen, 0, '缺场所的行不会被定死');
});

test('场所上线前 (含预热期) 算结构性缺席，不阻止定死', () => {
  const rets = noise(160, 13);
  const vols = rets.map(() => 1e6);
  const start = Date.UTC(2026, 0, 5);
  const venues = sixVenues(rets, vols, start);
  venues.hlPerp = venues.hlPerp.slice(60); // Hyperliquid 第 60 根才上线
  const rates = new Map(venues.bnPerp.map(b => [b.t, 1]));
  const opts = { tfMs: HOUR, now: start + 200 * HOUR };
  const early = venues.bnPerp[80].t / 1000;
  const noListing = computeFlowForce(venues, FIXED_WEIGHTS, rates, opts).find(r => r.time === early);
  assert.deepStrictEqual(noListing.missing, ['hlPerp'], '不知道上线时间时算缺数据');
  const listed = computeFlowForce(venues, FIXED_WEIGHTS, rates, { ...opts, listedFrom: { hlPerp: venues.hlPerp[0].t } }).find(r => r.time === early);
  assert.deepStrictEqual(listed.missing, []);
  assert.deepStrictEqual(listed.absent, ['hlPerp']);
  assert.strictEqual(listed.complete, true);
});

test('币安档案: 解出单文件 zip，兼容现货微秒时间戳与合约表头', () => {
  const zlib = require('zlib');
  const { unzipSingle, parseKlineCsv } = require('../server/binance_feed');
  const csv = '1792195200000000,81615.91,81677.88,81489.79,81571.65,406.8,1792198799999999,33197118.73,1,2,3,0\n';
  const name = Buffer.from('a.csv');
  const data = zlib.deflateRawSync(Buffer.from(csv));
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(8, 8);
  head.writeUInt32LE(data.length, 18);
  head.writeUInt16LE(name.length, 26);
  const bars = parseKlineCsv(unzipSingle(Buffer.concat([head, name, data])).toString());
  assert.deepStrictEqual(bars, [{ t: 1792195200000, o: 81615.91, h: 81677.88, l: 81489.79, c: 81571.65, v: 33197118.73 }]);
  const withHeader = parseKlineCsv('open_time,open,high,low,close,volume,close_time,quote_volume\n1792278000000,1,2,0.5,1.5,10,0,15\n');
  assert.strictEqual(withHeader.length, 1);
  assert.strictEqual(withHeader[0].v, 15);
});

test('summarize 只看已收盘K线', () => {
  const series = [
    { hist: 0.5, region: -0.2, fut: 1, spot: 0.5 },
    { hist: 0.3, region: -0.4, fut: 1, spot: 0.5 },
    { hist: 0.1, region: -0.1, fut: 1, spot: 0.5 },
    { hist: -9, region: 9, fut: -1, spot: -1, live: true } // 进行中，不计入
  ];
  const s = summarize(series);
  assert.strictEqual(s.leader, 'futures');
  assert.strictEqual(s.regionLeader, 'west');
  assert.strictEqual(s.futDir, '净买');
});
