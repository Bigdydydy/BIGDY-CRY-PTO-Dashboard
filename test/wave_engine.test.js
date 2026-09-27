const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  findPivots,
  validateImpulseRules,
  analyzeWaves,
  generateLiuCommentary
} = require('../server/wave_engine');
const { server } = require('../server/index');

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
          assert.ok(jsonBadInterval.error.includes('限定 4h, 1h, 15m'));
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

    const res = analyzeWaves(bars, 'BTC/USDT');
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

    const tStart = bars[10].time;
    const tEnd = bars[35].time;
    const res = analyzeWaves(bars, 'BTC/USDT', { startTime: tStart, endTime: tEnd });
    assert.strictEqual(res.selectedRange.barsCount, 26);
    assert.ok(res.originAnalysis);
    assert.ok(res.originAnalysis.originType);
    assert.ok(res.candidates.length > 0);
  });

  // 折线路径构造器：在拐点间线性插值，每腿 24 根 K 线
  function mkSwingBars(points, baseTime = 1730000000) {
    const bars = [];
    let t = baseTime;
    for (let s = 0; s < points.length - 1; s++) {
      const sp = points[s];
      const ep = points[s + 1];
      const n = 24;
      for (let i = (s === 0 ? 0 : 1); i <= n; i++) {
        const p = sp + (ep - sp) * (i / n);
        bars.push({ time: t, open: p, high: p + 0.5, low: p - 0.5, close: p, volume: 300 + (s % 2) * 100 });
        t += 14400;
      }
    }
    return bars;
  }

  it('Wave Engine: 收缩三角形 a-b-c-d-e 满足柳玉冬 0.5-0.5-0.5-0.25 口诀', () => {
    // 100H -> 80L -> 95H -> 82L -> 90H -> 84L：逐腿递减且高低点收敛
    const bars = mkSwingBars([100, 80, 95, 82, 90, 84]);
    const res = analyzeWaves(bars, 'BTC/USDT');
    const tri = res.candidates.find(c => c.family === 'TRIANGLE');
    assert.ok(tri, '应识别出三角形调整浪候选');
    assert.strictEqual(tri.type, 'CONTRACTING_TRIANGLE');
    assert.ok(tri.monitoringPivot && tri.monitoringPivot.price > 0);
    assert.ok(Array.isArray(tri.targets) && tri.targets.length >= 1);
  });

  it('Wave Engine: 终结/引导楔形（对角线驱动浪）浪4重叠且逐腿收敛', () => {
    // 50L -> 80H -> 65L -> 88H -> 76L -> 84H：浪4 切入浪1 领地、浪腿收缩
    const bars = mkSwingBars([50, 80, 65, 88, 76, 84]);
    const res = analyzeWaves(bars, 'BTC/USDT');
    const diag = res.candidates.find(c => c.family === 'DIAGONAL');
    assert.ok(diag, '应识别出楔形（对角线）候选');
    assert.ok(diag.category.includes('驱动'));
    assert.ok(diag.invalidation && diag.invalidation.price > 0);
  });

  it('Wave Engine: 双锯齿 W-X-Y 复式调整浪识别', () => {
    // 100H -> 85L -> 95H -> 75L (W) -> 90H (X) -> 82L -> 86H -> 70L (Y)
    const bars = mkSwingBars([100, 85, 95, 75, 90, 82, 86, 70]);
    const res = analyzeWaves(bars, 'BTC/USDT');
    const dz = res.candidates.find(c => c.family === 'DOUBLE_ZIGZAG');
    assert.ok(dz, '应识别出双锯齿 W-X-Y 复式调整浪候选');
    assert.ok(dz.metrics && dz.metrics.x_retrace_of_W > 0.2 && dz.metrics.x_retrace_of_W < 0.95);
  });

  it('Wave Engine: 下跌推动浪（空头方向）完整识别', () => {
    // 100H -> 75L -> 88H -> 60L -> 70H -> 50L：空头 1-2-3-4-5
    const bars = mkSwingBars([100, 75, 88, 60, 70, 50]);
    const res = analyzeWaves(bars, 'BTC/USDT');
    const imp = res.candidates.find(c => c.family === 'IMPULSE');
    assert.ok(imp, '应识别出下跌推动浪候选');
    assert.strictEqual(imp.direction, 'BEARISH');
    assert.ok(imp.rules && imp.rules.passedAll !== false);
    assert.ok(imp.monitoringPivot && imp.monitoringPivot.price > 0);
  });
});
