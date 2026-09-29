const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  findPivots,
  validateImpulseRules,
  analyzeWaves,
  evaluatePattern,
  generateLiuCommentary,
  identifyRangeExtrema,
  analyzePrecedingContext,
  PATTERNS,
  _internal
} = require('../server/wave_engine');
const { server } = require('../server/index');

const P = (idx, price, type) => ({ idx, time: idx, price, type, confirmed: true });

describe('Module 9: 柳玉冬波浪理论智能研判引擎 (Liu Yudong Wave Theory Engine)', () => {

  it('Iron Rule 1: 浪2回撤绝不能跌破浪1起点 (多头与空头双向)', () => {
    // Bullish
    const p0 = { price: 100, type: 'low' };
    const p1 = { price: 200, type: 'high' };
    const p2_valid = { price: 120, type: 'low' };
    const p2_invalid = { price: 95, type: 'low' };
    const p3 = { price: 350, type: 'high' };
    const p4 = { price: 220, type: 'low' };

    const validRules = validateImpulseRules(p0, p1, p2_valid, p3, p4, null, true);
    assert.strictEqual(validRules.rule1_wave2_retrace, true);
    assert.strictEqual(validRules.passedAll, true);

    const invalidRules = validateImpulseRules(p0, p1, p2_invalid, p3, p4, null, true);
    assert.strictEqual(invalidRules.rule1_wave2_retrace, false);
    assert.strictEqual(invalidRules.passedAll, false);

    // Bearish
    const bp0 = { price: 300, type: 'high' };
    const bp1 = { price: 200, type: 'low' };
    const bp2_valid = { price: 270, type: 'high' };
    const bp2_invalid = { price: 310, type: 'high' };
    const bp3 = { price: 120, type: 'low' };
    const bp4 = { price: 180, type: 'high' };

    const bValid = validateImpulseRules(bp0, bp1, bp2_valid, bp3, bp4, null, false);
    assert.strictEqual(bValid.rule1_wave2_retrace, true);
    assert.strictEqual(bValid.passedAll, true);

    const bInvalid = validateImpulseRules(bp0, bp1, bp2_invalid, bp3, bp4, null, false);
    assert.strictEqual(bInvalid.rule1_wave2_retrace, false);
    assert.strictEqual(bInvalid.passedAll, false);
  });

  it('Iron Rule 2: 浪3不能是最短的驱动浪', () => {
    const p0 = { price: 100, type: 'low' };
    const p1 = { price: 300, type: 'high' };
    const p2 = { price: 250, type: 'low' };
    const p3 = { price: 350, type: 'high' }; // len3 = 100
    const p4 = { price: 320, type: 'low' };
    const p5 = { price: 600, type: 'high' }; // len5 = 280

    const rules = validateImpulseRules(p0, p1, p2, p3, p4, p5, true);
    assert.strictEqual(rules.rule2_wave3_not_shortest, false);
    assert.strictEqual(rules.passedAll, false);
  });

  it('Iron Rule 3: 推动浪中浪4底绝不能进入浪1顶领地 (无重叠)', () => {
    const p0 = { price: 100, type: 'low' };
    const p1 = { price: 200, type: 'high' };
    const p2 = { price: 150, type: 'low' };
    const p3 = { price: 350, type: 'high' };
    const p4_valid = { price: 205, type: 'low' };
    const p4_overlap = { price: 195, type: 'low' };

    const valid = validateImpulseRules(p0, p1, p2, p3, p4_valid, null, true);
    assert.strictEqual(valid.rule3_wave4_no_overlap, true);
    assert.strictEqual(valid.passedAll, true);

    const overlap = validateImpulseRules(p0, p1, p2, p3, p4_overlap, null, true);
    assert.strictEqual(overlap.rule3_wave4_no_overlap, false);
    assert.strictEqual(overlap.passedAll, false);
  });

  it('手稿边界: 浪2回撤恰好100% (价格相等) 也否决 — P32', () => {
    const exact = validateImpulseRules(
      { price: 100, type: 'low' }, { price: 200, type: 'high' },
      { price: 100, type: 'low' }, { price: 300, type: 'high' },
      { price: 250, type: 'low' }, null, true);
    assert.strictEqual(exact.rule1_wave2_retrace, false);
    assert.strictEqual(exact.passedAll, false);
  });

  it('手稿硬规则: 浪3必须超过浪1终点 — P32/P40', () => {
    // 浪3终点 180 未越过浪1终点 200
    const res = evaluatePattern('IMPULSE', [
      P(0, 100, 'low'), P(10, 200, 'high'), P(20, 150, 'low'), P(30, 180, 'high')
    ], null);
    assert.ok(res.hardFails.some(f => f.id === 'M3'));
  });

  it('手稿硬规则: 浪4时间超过浪3的2倍即否决 — P43', () => {
    const res = evaluatePattern('IMPULSE', [
      P(0, 100, 'low'), P(5, 200, 'high'), P(10, 150, 'low'),
      P(15, 400, 'high'), P(40, 350, 'low')
    ], null);
    assert.ok(res.hardFails.some(f => f.id === 'M8'));
  });

  it('手稿硬规则: 平台形 b浪总量须≥a浪70% — P234', () => {
    // a=40, b=20 (50% < 70%)
    const res = evaluatePattern('FLAT', [
      P(0, 100, 'high'), P(10, 60, 'low'), P(20, 80, 'high'), P(30, 55, 'low')
    ], null);
    assert.ok(res.hardFails.some(f => f.id === 'F1'));
  });

  it('手稿硬规则: 单锯齿 c浪须≥0.9×b浪, b浪不得越a起点 — P213', () => {
    const shortC = evaluatePattern('ZIGZAG', [
      P(0, 100, 'high'), P(10, 70, 'low'), P(20, 85, 'high'), P(30, 80, 'low')
    ], null);
    assert.ok(shortC.hardFails.some(f => f.id === 'Z3')); // c=5 < 0.9*15

    const overB = evaluatePattern('ZIGZAG', [
      P(0, 100, 'high'), P(10, 70, 'low'), P(20, 105, 'high'), P(30, 60, 'low')
    ], null);
    assert.ok(overB.hardFails.some(f => f.id === 'Z2')); // b越过a起点
  });

  it('手稿硬规则: 收缩三角形 c浪不得大于b浪 — P302', () => {
    const res = evaluatePattern('TRIANGLE', [
      P(0, 50, 'low'), P(10, 100, 'high'), P(20, 70, 'low'),
      P(30, 105, 'high'), P(40, 75, 'low'), P(45, 90, 'high')
    ], null);
    assert.ok(res.hardFails.some(f => f.id === 'T4'));
  });

  it('手稿硬规则: 双锯齿 x浪终点不得越w浪起点, y浪>0.9×w — P362/P372', () => {
    const badX = evaluatePattern('DOUBLE_ZIGZAG', [
      P(0, 100, 'high'), P(10, 60, 'low'), P(20, 105, 'high'), P(30, 40, 'low')
    ], null);
    assert.ok(badX.hardFails.some(f => f.id === 'W2'));
    const shortY = evaluatePattern('DOUBLE_ZIGZAG', [
      P(0, 100, 'high'), P(10, 60, 'low'), P(20, 85, 'high'), P(30, 75, 'low')
    ], null);
    assert.ok(shortY.hardFails.some(f => f.id === 'W4')); // y=10 < 0.9*40
  });

  it('合规推动浪五段全部硬规则通过', () => {
    const res = evaluatePattern('IMPULSE', [
      P(0, 100, 'low'), P(10, 200, 'high'), P(20, 150, 'low'),
      P(35, 400, 'high'), P(45, 350, 'low'), P(60, 500, 'high')
    ], null);
    assert.strictEqual(res.hardFails.length, 0);
    assert.ok(res.complete);
  });

  it('Pivot Finder: 生成严格交替的高低拐点序列并包含边界锚点', () => {
    const bars = [];
    for (let i = 0; i < 120; i++) {
      const swing = Math.sin(i / 6) * 30;
      const price = 100 + swing;
      bars.push({
        time: 1700000000 + i * 14400,
        open: price - 1,
        high: price + 3,
        low: price - 3,
        close: price + 1,
        volume: 1000
      });
    }

    const pivots = findPivots(bars, 4);
    assert.ok(pivots.length >= 5, 'Should identify multiple swings with boundary anchors');
    for (let i = 1; i < pivots.length; i++) {
      assert.notStrictEqual(pivots[i].type, pivots[i - 1].type, 'Pivots must strictly alternate high and low');
    }
  });

  it('Wave Engine: 单锯齿调整浪 (Zigzag a-b-c) 识别与最低要求判定', () => {
    const bars = [];
    const points = [100, 70, 88, 65];
    let t = 1700000000;
    for (let s = 0; s < points.length - 1; s++) {
      const sp = points[s];
      const ep = points[s + 1];
      for (let i = 0; i < 25; i++) {
        const p = sp + (ep - sp) * (i / 25);
        bars.push({
          time: t,
          open: p,
          high: p + 1,
          low: p - 1,
          close: p + 0.2,
          volume: 200
        });
        t += 14400;
      }
    }

    const res = analyzeWaves(bars, 'ETH/USDT');
    assert.strictEqual(res.symbol, 'ETH/USDT');
    assert.ok(res.pattern, 'Should detect a pattern');
    assert.ok(res.pattern.monitoringPivot, 'Should provide monitoring pivot');
    assert.ok(res.pattern.targets.length >= 2, 'Should provide Fibonacci targets');
  });

  it('Wave Engine: 柳玉冬实战文风报告与核心名言完整生成', () => {
    const dummyPattern = {
      type: 'IMPULSE_BULLISH',
      name: '五浪上升推动浪 (第 5 浪运行中)',
      direction: 'BULLISH',
      monitoringPivot: { price: 82000 }
    };
    const commentary = generateLiuCommentary(dummyPattern, 85000, 'BTC/USDT');
    assert.ok(commentary.title.includes('BTC/USDT 4H'));
    assert.ok(commentary.thesis.includes('三大铁律检验全部通过'));
    assert.ok(commentary.bottomTopSignal.includes('82,000'));
    assert.ok(commentary.quote.includes('愚昧无法战胜科学，波浪理论是科学'));
  });

  it('Wave Engine 边界约束: 数据不足抛出中文异常', () => {
    assert.throws(() => {
      analyzeWaves([], 'BTC/USDT');
    }, /K线数据不足/);
  });

  it('HTTP API: GET /api/wave/klines 严格限制标的为 BTC/USDT 与 ETH/USDT', async () => {
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', async () => {
        const port = server.address().port;
        try {
          // 非受限标的应被拒绝 400
          const resInvalid = await fetch(`http://127.0.0.1:${port}/api/wave/klines?symbol=SOLUSDT&interval=4h`);
          assert.strictEqual(resInvalid.status, 400);
          const jsonInvalid = await resInvalid.json();
          assert.ok(jsonInvalid.error.includes('仅限定 BTC/USDT 与 ETH/USDT'));

          // 非 4h/1h/15m 周期应被拒绝 400
          const resBadInterval = await fetch(`http://127.0.0.1:${port}/api/wave/klines?symbol=BTCUSDT&interval=1m`);
          assert.strictEqual(resBadInterval.status, 400);
          const jsonBadInterval = await resBadInterval.json();
          assert.ok(jsonBadInterval.error.includes('时间框架'));
        } finally {
          server.close(resolve);
        }
      });
    });
  });

  it('HTTP API: GET /api/wave/analysis 返回符合柳玉冬规范的波浪分析数据与候选集', async () => {
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', async () => {
        const port = server.address().port;
        try {
          const resp = await fetch(`http://127.0.0.1:${port}/api/wave/analysis?symbol=BTCUSDT`);
          assert.strictEqual(resp.status, 200);
          const data = await resp.json();
          assert.strictEqual(data.code, 0);
          assert.strictEqual(data.timeframe, '4h');
          assert.ok(data.pattern);
          assert.ok(data.pattern.monitoringPivot);
          assert.ok(Array.isArray(data.candidates), '应包含并列候选浪型数组');
          assert.ok(Array.isArray(data.scenarios), '应包含发展情景推演数组');
          assert.ok(data.commentary);
          assert.ok(data.commentary.quote.includes('柳玉冬'));
        } finally {
          server.close(resolve);
        }
      });
    });
  });

  it('Wave Engine: 平台形调整浪 (Flat a-b-c) 满足 B 浪 >= 70% a 浪手稿铁律', () => {
    // 构造平台形：0: 100(高) -> a: 60(低, drop 40) -> b: 92(高, rise 32, 80% retrace) -> c: 55(低)
    const bars = [];
    // Leg 0->A (100 -> 60)
    for (let i = 0; i <= 10; i++) {
      const p = 100 - (40 / 10) * i;
      bars.push({ time: 1700000000 + i * 14400, open: p, high: p + 1, low: p - 1, close: p, volume: 100 });
    }
    // Leg A->B (60 -> 92)
    for (let i = 1; i <= 10; i++) {
      const p = 60 + (32 / 10) * i;
      bars.push({ time: 1700000000 + (10 + i) * 14400, open: p, high: p + 1, low: p - 1, close: p, volume: 100 });
    }
    // Leg B->C (92 -> 55)
    for (let i = 1; i <= 10; i++) {
      const p = 92 - (37 / 10) * i;
      bars.push({ time: 1700000000 + (20 + i) * 14400, open: p, high: p + 1, low: p - 1, close: p, volume: 100 });
    }

    const res = analyzeWaves(bars, 'BTC/USDT', { ranking: { maxCands: 99, minRel: 0 } });
    assert.ok(res.candidates.length > 0);
    const flatCandidate = res.candidates.find(c => c.type.includes('FLAT'));
    assert.ok(flatCandidate, '应识别出平台形候选');
    assert.ok(flatCandidate.metrics.retrace_B >= 0.70, 'B浪回撤必须 >= 70%');
  });

  it('Wave Engine: 选区切片分析与“出身决定命运”微观校验', () => {
    const bars = [];
    for (let i = 0; i < 50; i++) {
      const p = 50000 + Math.sin(i / 3) * 2000;
      bars.push({
        time: 1720000000 + i * 14400,
        open: p,
        high: p + 100,
        low: p - 100,
        close: p + 20,
        volume: 1000
      });
    }

    const tStart = bars[0].time;
    const tEnd = bars[35].time;
    const res = analyzeWaves(bars, 'BTC/USDT', { startTime: tStart, endTime: tEnd });
    assert.strictEqual(res.selectedRange.barsCount, 36);
    assert.strictEqual(res.selectedRange.contextBars, 0);
    assert.ok(res.originAnalysis);
    assert.ok(res.originAnalysis.originType);
    assert.ok(res.candidates.length > 0);
  });

  it('Wave Engine: 选区为观察窗口——向左扩展上下文，浪型起点可早于选区', () => {
    const bars = [];
    for (let i = 0; i < 200; i++) {
      const p = 50000 + Math.sin(i / 4) * 3000 + i * 30;
      bars.push({
        time: 1720000000 + i * 14400,
        open: p, high: p + 150, low: p - 150, close: p + 30, volume: 1000
      });
    }
    // 选取中段 [100..170]，共 71 根 → 左扩 36 根，切片应自 bar 64 起
    const res = analyzeWaves(bars, 'BTC/USDT', { startTime: bars[100].time, endTime: bars[170].time });
    assert.strictEqual(res.selectedRange.barsCount, 71, 'barsCount 应为用户选区根数');
    assert.strictEqual(res.selectedRange.contextBars, 36, '应向左扩展 0.5×选区长度的上下文');
    assert.ok(res.barsCount > res.selectedRange.barsCount, '实际分析切片应包含上下文');
    // 所有候选终点仍锚定选区右缘附近（最后一个拐点时间在选区内）
    for (const c of res.candidates) {
      const lastPv = c.pivots[c.pivots.length - 1];
      assert.ok(lastPv.time <= bars[170].time, '候选浪型终点不得越过选区右缘');
    }
    assert.ok(res.candidates.length > 0);
  });

  it('Wave Engine: 选区过短 (<10根) 抛出中文异常', () => {
    const bars = [];
    for (let i = 0; i < 60; i++) {
      const p = 50000 + i * 10;
      bars.push({ time: 1720000000 + i * 14400, open: p, high: p + 50, low: p - 50, close: p, volume: 100 });
    }
    assert.throws(() => {
      analyzeWaves(bars, 'BTC/USDT', { startTime: bars[20].time, endTime: bars[25].time });
    }, /选区过短/);
  });

  it('Wave Engine 诚实性: 不编造子浪拐点，subPivots 全部来自真实K线时间', () => {
    const bars = [];
    const points = [100, 70, 88, 65];
    let t = 1700000000;
    for (let s = 0; s < points.length - 1; s++) {
      for (let i = 0; i < 25; i++) {
        const p = points[s] + (points[s + 1] - points[s]) * (i / 25);
        bars.push({ time: t, open: p, high: p + 1, low: p - 1, close: p + 0.2, volume: 200 });
        t += 14400;
      }
    }
    const times = new Set(bars.map(b => b.time));
    const res = analyzeWaves(bars, 'ETH/USDT');
    for (const c of res.candidates) {
      for (const sp of (c.subPivots || [])) {
        assert.ok(times.has(sp.time), '子浪拐点必须来自真实K线，不允许按比例插值生成');
      }
    }
  });

  it('联合形(P50): x浪必须回撤w浪70%以上，运行总量不得超过1.5倍', () => {
    const w = [P(0, 100, 'high'), P(10, 60, 'low')]; // w = 40
    const tooSmall = evaluatePattern('COMBINATION', [w[0], w[1], P(20, 78, 'high'), P(30, 55, 'low')], null); // x=18=0.45w
    assert.ok(tooSmall.hardFails.some(r => r.id === 'C1'), 'x浪仅回撤45%应违反P50的70%铁律');

    const tooBig = evaluatePattern('COMBINATION', [w[0], w[1], P(20, 124, 'high'), P(30, 58, 'low')], null); // x=64=1.6w
    assert.ok(tooBig.hardFails.some(r => r.id === 'C2'), 'x浪运行总量超1.5倍w应违反P301');

    const valid = evaluatePattern('COMBINATION', [w[0], w[1], P(20, 92, 'high'), P(30, 58, 'low')], null); // x=32=0.8w
    assert.strictEqual(valid.hardFails.length, 0, 'x浪0.8倍回撤应通过全部硬规则');
  });

  it('联合形(P297): x浪时间超过w浪10倍即否决', () => {
    const res = evaluatePattern('COMBINATION',
      [P(0, 100, 'high'), P(2, 60, 'low'), P(25, 92, 'high'), P(30, 58, 'low')], null); // x时间23 > 2×10
    assert.ok(res.hardFails.some(r => r.id === 'C3'), 'x浪时间超限应违反时间铁律');
  });

  it('三重横向整理(P51): xx浪必须回撤y浪70%以上', () => {
    const bad = evaluatePattern('TRIPLE_COMBINATION',
      [P(0, 100, 'high'), P(10, 60, 'low'), P(20, 95, 'high'), P(30, 55, 'low'), P(40, 80, 'high'), P(45, 58, 'low')], null); // xx=25=0.625y
    assert.ok(bad.hardFails.some(r => r.id === 'C5'), 'xx浪仅回撤62.5%应违反P51');

    const ok = evaluatePattern('TRIPLE_COMBINATION',
      [P(0, 100, 'high'), P(10, 60, 'low'), P(20, 95, 'high'), P(30, 55, 'low'), P(40, 92, 'high'), P(45, 60, 'low')], null); // xx=37=0.925y
    assert.strictEqual(ok.hardFails.length, 0, 'xx浪92.5%回撤应通过全部硬规则');
  });

  it('联合形指引(P50/P131): y≈w且箱型外观得分更高，不进入blockers', () => {
    const boxy = evaluatePattern('COMBINATION', [P(0, 100, 'high'), P(10, 60, 'low'), P(20, 95, 'high'), P(30, 62, 'low')], null);
    const drifted = evaluatePattern('COMBINATION', [P(0, 100, 'high'), P(10, 60, 'low'), P(20, 95, 'high'), P(30, 20, 'low')], null);
    assert.ok(boxy.guide.weightGot > drifted.guide.weightGot, '箱型外观+y≈w应获得更高指引分');
    assert.ok(drifted.guide.fail > 0 && drifted.hardFails.length === 0, '指引失败不应升级为硬规则否决');
  });

  it('收缩三角形(P299): c浪等于b浪也不允许（须严格小于）', () => {
    const eq = evaluatePattern('TRIANGLE',
      [P(0, 100, 'low'), P(10, 160, 'high'), P(20, 80, 'low'), P(30, 160, 'high'), P(40, 85, 'low'), P(50, 140, 'high')], null); // c=80=b
    assert.ok(eq.hardFails.some(r => r.id === 'T4'), 'c浪等于b浪应按P299否决');
  });

  it('Wave Engine: 选区极值智能识别与磁吸锚定 (消除人工截取边界误差)', () => {
    // 构造一段行情：真实谷底在 bar 15 (price 50000)，真实波峰在 bar 35 (price 68000)
    // 模拟真人点击：用户在 bar 18 (price 52500) 点下起点，在 bar 38 (price 66000) 点下终点
    const bars = [];
    for (let i = 0; i < 60; i++) {
      let p;
      if (i <= 15) p = 60000 - (10000 / 15) * i; // 60000 -> 50000
      else if (i <= 35) p = 50000 + (18000 / 20) * (i - 15); // 50000 -> 68000
      else p = 68000 - (8000 / 24) * (i - 35); // 68000 -> 60000
      bars.push({
        time: 1720000000 + i * 14400,
        open: p, high: p + 100, low: p - 100, close: p + 10, volume: 100
      });
    }

    // 用户框选 [18, 38]（人手无法绝对精准落在15或35）
    const ext = identifyRangeExtrema(bars, 18, 38);
    assert.ok(ext);
    // 选区内部的极值
    assert.ok(ext.minPrice <= 53000);
    assert.ok(ext.maxPrice >= 67900);
    assert.strictEqual(ext.dominantDirection, 'BULLISH', '谷底在波峰之前，主导结构应为多头');
    assert.strictEqual(ext.isTroughFirst, true);
    assert.strictEqual(ext.primaryAnchor.type, 'low');

    // 边界容差探测：bar 15 就在 bar 18 往前 3 根之内，tolMinPrice 应探测到真正的全局底 50000
    assert.ok(ext.tolMinPrice < 50500, '边界容差应捕捉到落在边缘 3 根内的真实谷底');
    assert.strictEqual(ext.tolMinIdx, 15);
  });

  it('Wave Engine: 承前启后·大级别前序浪型脉络与传承 (柳玉冬“观当下必先审前身”)', () => {
    // 构造前序大幅顺势下跌驱动（从 70000 跌至 52000），随后在 52000 展开反弹
    const bars = [];
    for (let i = 0; i < 40; i++) {
      // 0..25: 前序大跌 (70000 -> 52000)
      // 26..39: 选区反弹 (52000 -> 58000)
      let p;
      if (i <= 25) p = 70000 - (18000 / 25) * i;
      else p = 52000 + (6000 / 14) * (i - 25);
      bars.push({
        time: 1720000000 + i * 14400,
        open: p, high: p + 150, low: p - 150, close: p, volume: 500
      });
    }

    // 选取 [26, 39] 进行分析
    const ctx = analyzePrecedingContext(bars, 26, null, '4h', null);
    assert.strictEqual(ctx.hasPrecedingData, true);
    assert.strictEqual(ctx.dominantTrend, 'BEARISH');
    assert.strictEqual(ctx.character, 'IMPULSE_DOWN');
    assert.ok(ctx.amplitudePct > 20);
    assert.ok(ctx.liuDeduction.includes('观当下必先审前身'));
    assert.ok(ctx.liuDeduction.includes('次级调整浪'));
    assert.ok(ctx.keyResistance >= 69000);
    assert.ok(ctx.favoredWaveTypes.includes('ZIGZAG'));
  });

  it('Wave Engine: 选区综合研判无缝集成极值磁吸、前序脉络与柳玉冬实战文风报告', () => {
    const bars = [];
    // 构造前序下跌 + 选区内平台/锯齿反弹走势
    for (let i = 0; i < 80; i++) {
      let p = 60000;
      if (i < 30) p = 60000 - i * 300; // 0..29: drop to 51300
      else {
        // 30..79: multi-swing bounce
        const offset = i - 30;
        p = 51300 + Math.sin(offset / 3) * 1500 + offset * 80;
      }
      bars.push({
        time: 1720000000 + i * 14400,
        open: p, high: p + 100, low: p - 100, close: p + 20, volume: 800
      });
    }

    const res = analyzeWaves(bars, 'BTC/USDT', { startTime: bars[30].time, endTime: bars[70].time });
    assert.ok(res.rangeExtrema, '应输出选区极值数据结构');
    assert.ok(res.rangeExtrema.minPrice > 0);
    assert.ok(res.rangeExtrema.maxPrice > 0);
    assert.ok(res.precedingContext, '应输出前序浪型脉络');
    assert.strictEqual(res.precedingContext.hasPrecedingData, true);
    assert.strictEqual(res.selectedRange.rangeExtrema.minPrice, res.rangeExtrema.minPrice);
    assert.ok(res.commentary);
    assert.ok(res.commentary.thesis.includes('【极值磁吸】'), '报告中应包含极值磁吸说明');
    assert.ok(res.commentary.thesis.includes('【承前启后·大级别脉络】'), '报告中应包含前序脉络说明');
  });

  it('回归: 真实ETH 4H选区应产出自然五浪推动计数及三类画法候选', () => {
    const bars = JSON.parse(fs.readFileSync(
      path.join(__dirname, 'fixtures', 'eth_usdt_4h_20260501_20260928.json'), 'utf8'));
    const opts = {
      timeframe: '4h',
      startTime: Date.UTC(2026, 5, 26) / 1000,
      endTime: Date.UTC(2026, 8, 22) / 1000
    };
    const res = analyzeWaves(bars, 'ETH/USDT', opts);

    // 自然五浪计数 (UTC): 0=06-26 00:00, 1=07-27 04:00, 2=08-01 16:00,
    // 3=09-11 12:00, 4=09-15 16:00, 5=09-21 20:00
    const expectTimes = [
      Date.UTC(2026, 5, 26, 0) / 1000,
      Date.UTC(2026, 6, 27, 4) / 1000,
      Date.UTC(2026, 7, 1, 16) / 1000,
      Date.UTC(2026, 8, 11, 12) / 1000,
      Date.UTC(2026, 8, 15, 16) / 1000,
      Date.UTC(2026, 8, 21, 20) / 1000
    ];
    assert.ok(res.candidates.length >= 1 && res.candidates.length <= 5,
      `默认排名下候选数应在1-5之间，实际 ${res.candidates.length}`);
    const top = res.candidates[0];
    assert.ok(top.baseType === 'IMPULSE' && top.pivots.length === 6 &&
      top.pivots.every((p, i) => p.time === expectTimes[i]),
      '自然五浪计数应为首选候选。实际候选: ' + JSON.stringify(
        res.candidates.map(c => ({
          t: c.baseType, n: c.pivots.length, s: c.score,
          p: c.pivots.map(p => new Date(p.time * 1000).toISOString())
        }))));

    // 全集视角（评估harness放宽排名参数）：4点五浪画法与调整浪画法仍应存在
    const full = analyzeWaves(bars, 'ETH/USDT',
      Object.assign({}, opts, { ranking: { maxCands: 99, minRel: 0 } }));
    assert.ok(full.candidates.some(c => c.baseType === 'IMPULSE' && c.pivots.length === 4),
      '全集中应包含4点推动浪候选（浪3运行中·五浪画法）');
    assert.ok(full.candidates.some(c => PATTERNS[c.baseType].category !== '驱动浪'),
      '全集中应包含调整浪候选（ABC画法/三浪画法）');
  });

  it('可变候选: 相对权重、概率和与决断度字段完备', () => {
    const bars = JSON.parse(fs.readFileSync(
      path.join(__dirname, 'fixtures', 'eth_usdt_4h_20260501_20260928.json'), 'utf8'));
    const res = analyzeWaves(bars, 'ETH/USDT', {
      timeframe: '4h',
      startTime: Date.UTC(2026, 5, 26) / 1000,
      endTime: Date.UTC(2026, 8, 22) / 1000
    });
    assert.ok(res.candidates.length > 0);
    assert.strictEqual(res.candidates[0].relWeight, 1, '首选候选 relWeight 应为 1');
    for (const c of res.candidates) {
      assert.ok(c.relWeight >= 0.15, `${c.name} relWeight ${c.relWeight} 应 >= minRel`);
    }
    const probSum = res.candidates.reduce((s, c) => s + c.probability, 0);
    assert.ok(Math.abs(probSum - 100) <= 2, `probability 合计应在 100±2，实际 ${probSum}`);
    assert.ok(['HIGH', 'MEDIUM', 'LOW', 'NONE'].includes(res.decisiveness.level),
      `决断度应为 HIGH/MEDIUM/LOW/NONE，实际 ${res.decisiveness.level}`);
    assert.strictEqual(res.decisiveness.shown, res.candidates.length);
  });

  it('可变候选: ranking.maxCands=1 时仅保留单一方案', () => {
    const bars = JSON.parse(fs.readFileSync(
      path.join(__dirname, 'fixtures', 'eth_usdt_4h_20260501_20260928.json'), 'utf8'));
    const res = analyzeWaves(bars, 'ETH/USDT', {
      timeframe: '4h',
      startTime: Date.UTC(2026, 5, 26) / 1000,
      endTime: Date.UTC(2026, 8, 22) / 1000,
      ranking: { maxCands: 1 }
    });
    assert.strictEqual(res.candidates.length, 1);
    assert.strictEqual(res.decisiveness.level, 'HIGH', '单一方案决断度应为HIGH');
  });

  it('同级别比例硬规则: 第4段用时不得少于第3段的8% (L4)', () => {
    const bad = evaluatePattern('IMPULSE', [
      P(0, 100, 'low'), P(50, 200, 'high'), P(60, 160, 'low'),
      P(160, 400, 'high'), P(161, 350, 'low'), P(200, 500, 'high')
    ], null);
    assert.ok(bad.hardFails.some(f => f.id === 'L4'), '浪4仅1根vs浪3共100根应触发L4否决');

    const ok = evaluatePattern('IMPULSE', [
      P(0, 100, 'low'), P(50, 200, 'high'), P(60, 160, 'low'),
      P(160, 400, 'high'), P(180, 350, 'low'), P(200, 500, 'high')
    ], null);
    assert.ok(!ok.hardFails.some(f => f.id === 'L4'), '浪4共20根(20%)不应触发L4');
  });

  it('未评估指引按中性计分: 发展中计数 guide.weight 覆盖全部软规则', () => {
    const res = evaluatePattern('IMPULSE', [
      P(0, 100, 'low'), P(50, 200, 'high'), P(60, 160, 'low'), P(160, 400, 'high')
    ], null);
    const expected = PATTERNS.IMPULSE.rules.filter(r => !r.hard).reduce((s, r) => s + r.w, 0);
    assert.strictEqual(res.guide.weight, expected, '未评估的非硬规则应以0.5中性计入权重');
  });

  it('同级别显著性指引(G8): 驱动浪内部回撤不得大于相邻调整浪', () => {
    // 合成K线：浪5内部藏有一次大于浪4幅度的逆向回撤 → G8判不过；干净形态 → 通过
    const mkBars = (withDip) => {
      const path = [];
      for (let i = 0; i <= 90; i++) {
        let p;
        if (i <= 20) p = 100 + 5 * i;                            // 浪1: 100->200
        else if (i <= 30) p = 200 - 4 * (i - 20);                // 浪2: 200->160 (40)
        else if (i <= 60) p = 160 + 8 * (i - 30);                // 浪3: 160->400
        else if (i <= 70) p = 400 - 6 * (i - 60);                // 浪4: 400->340 (60)
        else if (withDip && i <= 80) p = 340 + 16 * (i - 70);    // 浪5冲至500
        else if (withDip && i <= 85) p = 500 - 14 * (i - 80);    // 内部逆撤至430 (70>60)
        else if (withDip) p = 430 + 18 * (i - 85);               // 收回520
        else p = 340 + 9 * (i - 70);                             // 干净浪5: 340->520
        path.push(p);
      }
      return path.map((p, i) => ({ time: 1700000000 + i * 14400, open: p, high: p + 2, low: p - 2, close: p, volume: 100 }));
    };
    const pts = [P(0, 100, 'low'), P(20, 200, 'high'), P(30, 160, 'low'),
      P(60, 400, 'high'), P(70, 340, 'low'), P(90, 520, 'high')];
    const evOf = bars => ({ highs: bars.map(b => b.high), lows: bars.map(b => b.low) });

    const badG8 = evaluatePattern('IMPULSE', pts, evOf(mkBars(true))).checks.find(c => c.id === 'G8');
    assert.ok(badG8 && badG8.pass === false, '浪5内回撤70>浪4(60)应违反G8: ' + (badG8 && badG8.detail));

    const goodG8 = evaluatePattern('IMPULSE', pts, evOf(mkBars(false))).checks.find(c => c.id === 'G8');
    assert.ok(goodG8 && goodG8.pass === true, '内部回撤均小于相邻调整浪应通过G8: ' + (goodG8 && goodG8.detail));
  });

  it('边界稳健性: 数据左缘10-24根选区不抛异常且标注contextShortfall', () => {
    const bars = JSON.parse(fs.readFileSync(
      path.join(__dirname, 'fixtures', 'eth_usdt_4h_20260501_20260928.json'), 'utf8'));
    for (const [s, e] of [[0, 9], [0, 14], [0, 24]]) {
      const res = analyzeWaves(bars, 'ETH/USDT', {
        timeframe: '4h', startTime: bars[s].time, endTime: bars[e].time
      });
      assert.ok(res && Array.isArray(res.candidates), `选区[${s}..${e}]应返回结果`);
      assert.strictEqual(res.selectedRange.contextShortfall, true, `选区[${s}..${e}]应标注上下文不足`);
      assert.ok(res.blockers.some(b => b.includes('前序上下文仅')),
        `选区[${s}..${e}]应在blockers中提示左缘上下文不足`);
    }
    const mid = analyzeWaves(bars, 'ETH/USDT', {
      timeframe: '4h', startTime: bars[400].time, endTime: bars[409].time
    });
    assert.strictEqual(mid.selectedRange.contextShortfall, false, '中段选区不应标注上下文不足');
  });

  it('结构复核规则仅检查首段出身 (legs=[0])', () => {
    for (const type of Object.keys(PATTERNS)) {
      for (const r of PATTERNS[type].rules) {
        if (r.struct) assert.deepStrictEqual(r.legs, [0], `${type}/${r.id} 应仅检验首段出身`);
      }
    }
  });

  it('对偶情境: counterRolesForR 按R比值边界分档', () => {
    const { counterRolesForR } = _internal;
    assert.deepStrictEqual(counterRolesForR(0.1), []);
    assert.strictEqual(counterRolesForR(0.5).length, 2);
    assert.strictEqual(counterRolesForR(0.8).length, 4);
    const mid = counterRolesForR(1.2);
    assert.strictEqual(mid.length, 2);
    assert.ok(mid.some(r => r.role === '扩散平台形b浪'));
    assert.strictEqual(counterRolesForR(1.7).length, 1);
    assert.deepStrictEqual(counterRolesForR(2.5), []);
    assert.deepStrictEqual(counterRolesForR(null), []);
  });

  it('对偶情境: ETH真实选区锚点 O/X/H0 与 R>2 → A_ONLY', () => {
    const bars = JSON.parse(fs.readFileSync(
      path.join(__dirname, 'fixtures', 'eth_usdt_4h_20260501_20260928.json'), 'utf8'));
    const startTime = Date.UTC(2026, 5, 26) / 1000;
    const endTime = Date.UTC(2026, 8, 22) / 1000;
    const res = analyzeWaves(bars, 'ETH/USDT', { timeframe: '4h', startTime, endTime });

    const ds = res.dualScenario;
    assert.ok(ds, '应输出对偶情境');
    assert.strictEqual(ds.direction, 'BULLISH');
    assert.strictEqual(ds.anchors.O.price, 1510.87);
    assert.strictEqual(ds.anchors.X.price, 2806.76);

    // 按同一定义在夹具上复算 H0：slice=选区左扩后的K线，扫描O左侧最后一根 low<O.price 的K线，
    // 其右至O之间取最大 high（预期命中 2026-06-15 高点 1848.78，因 06-06 低点 1503.6 < O）
    let iS = bars.findIndex(b => b.time >= startTime);
    let iE = bars.length - 1;
    while (iE >= 0 && bars[iE].time > endTime) iE--;
    const margin = Math.min(300, Math.max(30, Math.round((iE - iS + 1) * 0.5)));
    const slice = bars.slice(Math.max(0, iS - margin), iE + 1);
    const iO = slice.findIndex(b => b.time === startTime);
    const oPrice = 1510.87;
    let k = -1;
    for (let i = iO - 1; i >= 0; i--) {
      if (slice[i].low < oPrice) { k = i; break; }
    }
    let expH0 = -Infinity;
    for (let i = k + 1; i <= iO - 1; i++) expH0 = Math.max(expH0, slice[i].high);
    assert.strictEqual(expH0, 1848.78, '复算H0应为06-15高点1848.78');
    assert.strictEqual(ds.anchors.H0.price, expH0);

    assert.ok(ds.R > 2, `R=${ds.R} 应大于2`);
    assert.strictEqual(ds.stance, 'A_ONLY');
    assert.strictEqual(ds.lean.A, 100);
    assert.ok(ds.arbitration.some(a => a.price === oPrice && a.rule === 'M1'),
      '仲裁价位应包含 O 位的 M1 否决线');
  });

  it('对偶情境: 合成slice+B_ONLY/BOTH/空头镜像', () => {
    const { buildDualScenario } = _internal;
    const t0 = 1700000000;
    const mk = (i, p, h, l) => ({ time: t0 + i * 14400, open: p, high: h !== undefined ? h : p + 1, low: l !== undefined ? l : p - 1, close: p, volume: 10 });
    // 多头切片: 前置腿 140->100, 当前段 100->120 (Slen=20, D=40, R=0.5)
    const bull = [
      mk(0, 95, 96, 94), mk(1, 95, 96, 94), mk(2, 139, 140, 138),
      mk(3, 135), mk(4, 130), mk(5, 125), mk(6, 118), mk(7, 110), mk(8, 104),
      mk(9, 100, 105, 100),
      mk(10, 102), mk(11, 105), mk(12, 108), mk(13, 110), mk(14, 112),
      mk(15, 114), mk(16, 116), mk(17, 117), mk(18, 118), mk(19, 119, 120, 118)
    ];
    const topBull = { direction: 'BULLISH', baseType: 'ZIGZAG', pivots: [{ price: 100, time: bull[9].time, idx: 9 }] };
    const zzBull = [{ baseType: 'ZIGZAG', direction: 'BULLISH', pivots: [{ time: bull[9].time }] }];

    // (a) 仅锯齿计数 → 情境A出身不合法，B_ONLY
    const a = buildDualScenario({ cands: zzBull, top: topBull, slice: bull, precedingContext: null, mtf: null });
    assert.ok(a);
    assert.strictEqual(a.anchors.H0.price, 140);
    assert.ok(Math.abs(a.R - 0.5) < 1e-9, `R=${a.R} 应为0.5`);
    assert.strictEqual(a.stance, 'B_ONLY');
    assert.strictEqual(a.scenarios.A.allowed, false);
    assert.strictEqual(a.scenarios.B.allowed, true);

    // (b) 叠加推动浪计数 → BOTH + 启发式lean
    const impStub = { baseType: 'IMPULSE', direction: 'BULLISH', pivots: [{ time: bull[9].time }] };
    const b = buildDualScenario({ cands: zzBull.concat([impStub]), top: topBull, slice: bull, precedingContext: null, mtf: null });
    assert.strictEqual(b.stance, 'BOTH');
    assert.strictEqual(b.lean.A, null);
    assert.strictEqual(b.lean.B, null);
    assert.strictEqual(b.lean.validated, 'rule');
    assert.match(b.lean.text, /分水岭/);

    // (c) 空头镜像 → direction BEARISH + B_ONLY
    const bear = [
      mk(0, 145, 146, 144), mk(1, 145, 146, 144), mk(2, 101, 102, 100),
      mk(3, 105), mk(4, 110), mk(5, 115), mk(6, 122), mk(7, 130), mk(8, 136),
      mk(9, 140, 140, 135),
      mk(10, 138), mk(11, 135), mk(12, 132), mk(13, 130), mk(14, 128),
      mk(15, 126), mk(16, 124), mk(17, 123), mk(18, 122), mk(19, 121, 122, 120)
    ];
    const topBear = { direction: 'BEARISH', baseType: 'ZIGZAG', pivots: [{ price: 140, time: bear[9].time, idx: 9 }] };
    const zzBear = [{ baseType: 'ZIGZAG', direction: 'BEARISH', pivots: [{ time: bear[9].time }] }];
    const c = buildDualScenario({ cands: zzBear, top: topBear, slice: bear, precedingContext: null, mtf: null });
    assert.ok(c);
    assert.strictEqual(c.direction, 'BEARISH');
    assert.strictEqual(c.stance, 'B_ONLY');
    assert.strictEqual(c.anchors.H0.price, 100);
  });

  it('对偶情境: 拐点不足早退路径 dualScenario 为 null', () => {
    const flat = Array.from({ length: 30 }, (_, i) => ({
      time: 1700000000 + i * 14400, open: 100, high: 100, low: 100, close: 100, volume: 10
    }));
    const res = analyzeWaves(flat, 'BTC/USDT');
    assert.strictEqual(res.dualScenario, null);
  });
});
