const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('../server/wave_engine');
const { build: buildLiuThreads, extractLevels } = require('../scripts/liu_threads/build_liu_threads');
const { resolveWaveSymbol, getLiuThread } = require('../server/wave_symbols');

const { analyzeWaves, evaluatePattern, _internal } = E;
const P = (idx, price, type) => ({ idx, time: idx, price, type, confirmed: true });

/** 由折线顶点生成逐根K线 (每段 steps 根，high/low 为开收±wick) */
function barsFromPath(points, steps, wick) {
  const bars = [];
  let t = 1700000000;
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1], b = points[k];
    for (let s = 0; s < steps; s++) {
      const o = a + (b - a) * s / steps, c = a + (b - a) * (s + 1) / steps;
      bars.push({ time: t, open: o, close: c, high: Math.max(o, c) + wick, low: Math.min(o, c) - wick });
      t += 3600;
    }
  }
  return bars;
}

function signalsFor(bars, thr) {
  const pivs = E.zigzagPivots(bars, thr);
  const ev = { bars, highs: bars.map(b => b.high), lows: bars.map(b => b.low), sources: null, structCache: new Map() };
  return E.buildLiuSignals(bars, pivs, ev);
}

describe('Module 8 v3: 柳玉冬实战信号层 / 级别阶梯 / 目标位修正', () => {
  it('浪5极限: 浪3短于浪1时 = 浪4终点 + 浪3长度 (浪3不能最短)', () => {
    const g = _internal.mkGeom([
      P(0, 100, 'low'), P(10, 300, 'high'), P(20, 200, 'low'),
      P(30, 350, 'high'), P(40, 320, 'low'), { idx: 50, time: 50, price: 380, type: 'high', open: true }
    ]);
    const lv = _internal.buildLevels('IMPULSE', g, 'RUNNING', {});
    const lim = lv.targets.find(t => /浪5极限/.test(t.label));
    assert.ok(lim, '应给出浪5极限');
    assert.strictEqual(lim.price, 320 + 150);
    assert.ok(!lv.targets.some(t => /0\.382×浪3/.test(t.label)), '旧的0.382×浪3上限已移除');
  });

  it('五浪完成后的回撤以0→5整段价格为基准，并给出0.2起点与0.8极限', () => {
    const g = _internal.mkGeom([
      P(0, 100, 'low'), P(10, 200, 'high'), P(20, 150, 'low'),
      P(35, 400, 'high'), P(45, 350, 'low'), P(60, 500, 'high')
    ]);
    const lv = _internal.buildLevels('IMPULSE', g, 'COMPLETED', {});
    assert.strictEqual(lv.targets.find(t => t.ratio === 0.618).price, Math.round((500 - 0.618 * 400) * 100) / 100);
    assert.strictEqual(lv.targets.find(t => t.ratio === 0.2).price, 420);
    const lim = lv.targets.find(t => t.ratio === 0.8);
    assert.ok(lim && /极限/.test(lim.label));
    assert.strictEqual(lim.price, 180);
  });

  it('ZG8 指引: 单锯齿c浪超过a浪1.618倍 → 有发展为推动浪的危险', () => {
    const bad = evaluatePattern('ZIGZAG', [P(0, 500, 'high'), P(10, 400, 'low'), P(20, 450, 'high'), P(30, 250, 'low')], null);
    const zg8 = bad.checks.find(c => c.id === 'ZG8');
    assert.strictEqual(zg8.pass, false);
    assert.ok(/推动浪/.test(zg8.detail));
    const ok = evaluatePattern('ZIGZAG', [P(0, 500, 'high'), P(10, 400, 'low'), P(20, 450, 'high'), P(30, 340, 'low')], null);
    assert.strictEqual(ok.checks.find(c => c.id === 'ZG8').pass, true);
  });

  it('最大回撤判据: 回撤量超过本段内部最大回撤 → 很小级别见顶', () => {
    // 前段 200→100，本段 100→180 (内部最大回撤≈10)，随后回撤≈25 (小于主级别阈值30，180仍为运行中极值)
    const sig = signalsFor(barsFromPath([200, 100, 140, 130, 180, 155], 8, 0.5), 30);
    assert.strictEqual(sig.direction, 'BULLISH');
    assert.ok(Math.abs(sig.largestCounterMove.innerMax - 11) < 1.5, `内部最大回撤 ${sig.largestCounterMove.innerMax}`);
    assert.strictEqual(sig.largestCounterMove.exceeded, true);
    assert.ok(/小级别见顶/.test(sig.largestCounterMove.text));
    assert.ok(sig.eatBack.ratio > 0.79 && sig.eatBack.ratio < 0.82);
    assert.ok(/0\.7/.test(sig.eatBack.verdict), sig.eatBack.verdict);
    assert.strictEqual(sig.partsProjector.find(r => r.pattern === '平台形').reachedMin, true);
    assert.ok(sig.lines.length >= 4);
  });

  it('最大回撤判据: 回撤未超过内部最大回撤 → 给出「回撤量不大于X之前仍有动力」阈值', () => {
    const sig = signalsFor(barsFromPath([200, 100, 140, 120, 180, 175], 8, 0.2), 30);
    assert.strictEqual(sig.largestCounterMove.exceeded, false);
    assert.ok(Math.abs(sig.largestCounterMove.thresholdLevel - (sig.activeLeg.extreme.price - sig.largestCounterMove.innerMax)) < 1e-6);
    assert.strictEqual(sig.monitorPoint.status, 'HOLDING');
  });

  it('调整分部投射: 前段为第一部分时 三角形≈0.618 / 平台·联合形≥0.7 (白银2026-04-18口径)', () => {
    const sig = signalsFor(barsFromPath([121, 60, 80], 10, 0.2), 10);
    const Lp = sig.eatBack.priorLeg.from - sig.eatBack.priorLeg.to;
    const O = sig.eatBack.priorLeg.to;
    const tri = sig.partsProjector.find(r => r.pattern === '收缩三角形');
    const flat = sig.partsProjector.find(r => r.pattern === '平台形');
    const comb = sig.partsProjector.find(r => r.pattern === '联合形');
    const dz = sig.partsProjector.find(r => r.pattern === '双锯齿');
    assert.ok(Math.abs(tri.typicalPrice - (O + 0.618 * Lp)) < 1e-3);
    assert.ok(Math.abs(flat.minPrice - (O + 0.7 * Lp)) < 1e-3);
    assert.strictEqual(flat.minPrice, comb.minPrice);
    assert.strictEqual(flat.reachedMin, false);
    assert.ok(/尚需到达/.test(flat.status));
    assert.strictEqual(dz.reachedMin, true, '双锯齿x浪不需到0.618');
  });

  it('出身: 当前段只有三段且第三段>1.618×第一段 → 警示可能发展为推动浪', () => {
    // 前段 300→100；当前段 100→150→130→230 (c≈2×a)
    const bars = barsFromPath([300, 100, 150, 130, 230], 12, 0.1);
    const sig = signalsFor(bars, 60);
    if (sig.origin.structure === '3') {
      assert.ok(sig.threeLegWarning && /推动浪/.test(sig.threeLegWarning));
      assert.ok(sig.origin.leadingDiagonal && Math.abs(sig.origin.leadingDiagonal.mustHold - 100) < 0.5);
    } else {
      assert.ok(['5', 'unknown'].includes(sig.origin.structure));
    }
  });

  it('analyzeWaves v3: liuSignals / degreeLadder / commentary.liuLines / 0.7仲裁位', () => {
    const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'eth_usdt_4h_20260501_20260928.json'), 'utf8'));
    const bars = fx.bars || fx;
    const res = analyzeWaves(bars, 'ETH/USDT', { timeframe: '4h' });
    assert.strictEqual(res.engineVersion, '3.0.0');
    assert.ok(['HOLDING', 'BROKEN', 'CONFIRMED_END'].includes(res.liuSignals.monitorPoint.status));
    assert.strictEqual(res.liuSignals.partsProjector.length, 5);
    const main = res.degreeLadder.levels.find(l => l.degree === 'MAIN');
    assert.strictEqual(main.count.name, res.pattern.name);
    const higher = res.degreeLadder.levels.find(l => l.degree === 'HIGHER');
    assert.ok(higher && higher.pivotCount < main.pivotCount, '应找到更粗一级的计数层');
    assert.ok(res.commentary.liuLines.length > 0);
    if (res.dualScenario && res.dualScenario.anchors.H0) {
      assert.ok(res.dualScenario.arbitration.some(a => a.rule === 'F1/C1'));
    }
  });

  it('标的白名单: 归一化与柳玉冬线程映射', () => {
    assert.strictEqual(resolveWaveSymbol('xau/usdt').symbol, 'XAUUSDT');
    assert.strictEqual(resolveWaveSymbol('1810.HK/USDT').symbol, 'HK1810USDT');
    assert.strictEqual(resolveWaveSymbol('BTC-USDT').display, 'BTC/USDT');
    assert.strictEqual(resolveWaveSymbol('SOLUSDT'), null);
    const th = getLiuThread(resolveWaveSymbol('XAUUSDT'));
    assert.ok(th, 'data/liu_wave_threads.json 应包含黄金线程');
    assert.strictEqual(th.code, 'XAU');
    assert.ok(th.entries.length > 50 && th.monitorTrail.length > 10);
    for (let i = 1; i < th.entries.length; i++) assert.ok(th.entries[i].ts >= th.entries[i - 1].ts, '线程须按时间排序');
  });

  it('语料线程: 价位抽取与跨帖谱系串联 (目标 → 后帖「顺利实现」)', () => {
    const lv = extractLevels('黄金 2026年1月16日 / 只要不跌破4550认为会继续涨，目标4826。跌破4550才是针对橙线回撤。');
    const mon = lv.find(l => l.kind === 'monitor');
    assert.strictEqual(mon.price, 4550);
    assert.strictEqual(mon.side, 'below');
    assert.ok(lv.some(l => l.kind === 'target' && l.price === 4826));
    assert.ok(!lv.some(l => l.price === 2026 || l.price === 16), '日期不得被识别为价位');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liu-corpus-'));
    const mk = (name, text, ocr) => {
      fs.mkdirSync(path.join(dir, name));
      fs.writeFileSync(path.join(dir, name, 'info.txt'),
        `链接: x\n发布时间: x\n图片数量: 1\n正文:\n${text}\n\n=== 波浪图解识别 ===\n--- 图 1 ---\n${ocr}\n`);
    };
    mk('2026-01-15_1025_#黄金#_AAAAAAA1', '#黄金# 今天的监测点4550。',
      '品种/周期: 黄金现货/美元(XAU/USD) 日线图 OANDA\n浪级关系: 橙线ⅰ-ⅴ新驱动浪进行中\n图中文字: "黄金 2026年1月15日 / 只要不跌破4550认为会继续涨，目标4826。"');
    mk('2026-01-21_1022_#黄金#_AAAAAAA2', '#黄金# 的4826元目标顺利实现。',
      '品种/周期: 黄金现货/美元(XAU/USD) 日线图 OANDA\n浪级关系: 橙线第5浪\n图中文字: "黄金 2026年1月21日 / 4826顺利实现。如果维持4737之上认为继续涨。"');
    try {
      const xau = buildLiuThreads(dir).symbols.XAU;
      assert.strictEqual(xau.entries.length, 2);
      assert.strictEqual(xau.entries[0].timeframe, '1d');
      assert.ok(xau.entries[0].methods.includes('MONITOR'));
      const t = xau.entries[0].levels.find(l => l.kind === 'target' && l.price === 4826);
      assert.strictEqual(t.followups.length, 1);
      assert.strictEqual(t.followups[0].verb, 'HIT');
      assert.strictEqual(xau.monitorTrail[0].price, 4550);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
