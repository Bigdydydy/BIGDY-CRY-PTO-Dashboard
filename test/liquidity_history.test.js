const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const h = require('../server/liquidity_history');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 0, 1);

function snap(over = {}) {
  return { mid: 100000, spr: 0.01, d10: 30, d50: 70, d100: 90, b10: 50, vol24: 1000, s5: 5, s10: 10, ...over };
}

// 连续 hours 小时的样本，fn(i) 可覆盖字段
function series(hours, fn = () => ({}), start = T0) {
  let samples = [];
  for (let i = 0; i < hours; i++) samples = h.mergeSnapshot(samples, snap(fn(i)), start + i * HOUR);
  return samples;
}

describe('liquidity history recorder', () => {
  test('snapshots in the same hour average into one bucket and track the 10bps low', () => {
    let s = h.mergeSnapshot([], snap({ d10: 30 }), T0 + 5 * 60 * 1000);
    s = h.mergeSnapshot(s, snap({ d10: 20 }), T0 + 40 * 60 * 1000);
    assert.strictEqual(s.length, 1);
    assert.strictEqual(s[0].ts, T0);
    assert.strictEqual(s[0].n, 2);
    assert.strictEqual(s[0].d10, 25);
    assert.strictEqual(s[0].d10min, 20);

    s = h.mergeSnapshot(s, snap(), T0 + HOUR);
    assert.strictEqual(s.length, 2);
  });

  test('mergeSampleSets keeps the bucket with more snapshots', () => {
    const a = [{ ts: T0, n: 3, d10: 1 }, { ts: T0 + HOUR, n: 1, d10: 2 }];
    const b = [{ ts: T0, n: 1, d10: 9 }, { ts: T0 + 2 * HOUR, n: 2, d10: 3 }];
    const m = h.mergeSampleSets(a, b);
    assert.deepStrictEqual(m.map(x => x.d10), [1, 2, 3]);
  });

  test('history file round-trips with one sample per line', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'liq-')), 'h.json');
    const samples = series(3);
    h.writeHistoryFile(file, samples);
    const text = fs.readFileSync(file, 'utf8');
    assert.strictEqual(text.split('\n').filter(l => l.includes('"ts"')).length, 3);
    assert.deepStrictEqual(h.readHistoryFile(file), samples);
  });

  test('snapshotFromLiquidity reads tiers, volume and $5M/$10M sell slippage', () => {
    const result = {
      midPrice: 100000,
      spreadBps: 0.01,
      depthProfile: { 10: { totalUsd: 30e6, bidPct: 52 }, 50: { totalUsd: 70e6 }, 100: { totalUsd: 90e6 } },
      volume24h: { usd: 1.2e9 },
      slippageSimulation: [
        { sizeUsd: 5000000, sell: { slippageBps: 4 } },
        { sizeUsd: 10000000, sell: { slippageBps: 9 } }
      ]
    };
    const s = h.snapshotFromLiquidity(result);
    assert.deepStrictEqual(
      [s.d10, s.d50, s.d100, s.b10, s.vol24, s.s5, s.s10],
      [30, 70, 90, 52, 1200, 4, 9]
    );
  });
});

describe('liquidity history indicators', () => {
  test('resilience score is 100bps depth over 24h volume x100', () => {
    const view = h.buildHistoryView(series(2, () => ({ d100: 74, vol24: 1000 })), { now: T0 + 2 * HOUR });
    assert.strictEqual(view.series[0].score, 7.4);
    assert.strictEqual(view.indicators.resilience.ma7, 7.4);
    assert.strictEqual(view.thresholds, null);
    assert.strictEqual(view.indicators.resilience.zone, null);
    assert.strictEqual(view.indicators.withdrawal.code, 'INSUFFICIENT');
  });

  test('parallel collapse of all three tiers is classified as wholesale withdrawal', () => {
    const hours = 8 * 24;
    const samples = series(hours, i => (i >= hours - 6 ? { d10: 15, d50: 35, d100: 45 } : {}));
    const ind = h.buildHistoryView(samples, { now: T0 + hours * HOUR }).indicators;
    assert.strictEqual(ind.vsBaseline7d.d10, -50);
    assert.strictEqual(ind.withdrawal.code, 'WHOLESALE_WITHDRAWAL');
  });

  test('near-touch thinning when only 10bps drops', () => {
    const hours = 8 * 24;
    const samples = series(hours, i => (i >= hours - 6 ? { d10: 15 } : {}));
    const ind = h.buildHistoryView(samples, { now: T0 + hours * HOUR }).indicators;
    assert.strictEqual(ind.withdrawal.code, 'NEAR_TOUCH_THINNING');
  });

  test('48h change and drawdown from the daily peak', () => {
    const hours = 10 * 24;
    // 第 2 天峰值 48，之后回落到 24
    const samples = series(hours, i => ({ d10: i >= 24 && i < 48 ? 48 : (i >= hours - 48 ? 24 : 40) }));
    const ind = h.buildHistoryView(samples, { now: T0 + hours * HOUR }).indicators;
    assert.strictEqual(ind.peak.date, '2026-01-02');
    assert.strictEqual(ind.change48h, -40);
    // 当前 7D 均值 = (5 天 × 40 + 2 天 × 24) / 7 ≈ 35.43 → 较峰值 48 回撤 26.2%
    assert.strictEqual(ind.peak.drawdownPct, -26.2);
  });

  test('score rising only because volume shrinks is flagged as inflated', () => {
    const hours = 15 * 24;
    const samples = series(hours, i => ({ vol24: i >= hours - 7 * 24 ? 400 : 1000 }));
    const ind = h.buildHistoryView(samples, { now: T0 + hours * HOUR }).indicators;
    assert.ok(ind.resilience.chg7dPct >= 20);
    assert.strictEqual(ind.resilience.inflated, true);
  });

  test('thresholds come only from Coinbase daily score quartiles', () => {
    // 第 d 天的评分 = (50 + (d % 10) * 5) / 1000 * 100
    const build = days => series(days * 24, i => ({ d100: 50 + (Math.floor(i / 24) % 10) * 5 }));

    assert.strictEqual(h.buildHistoryView(build(6), { now: T0 + 6 * DAY }).thresholds, null);

    const early = h.buildHistoryView(build(8), { now: T0 + 8 * DAY }).thresholds;
    assert.strictEqual(early.days, 8);
    assert.strictEqual(early.provisional, true);

    const full = h.buildHistoryView(build(31), { now: T0 + 31 * DAY });
    assert.strictEqual(full.thresholds.provisional, false);
    assert.ok(full.thresholds.high > full.thresholds.low);
    assert.ok(full.thresholds.low >= 5 && full.thresholds.high <= 9.5);
    assert.ok(full.indicators.resilience.zone);
  });

  test('range trims chart series but moving averages use full history', () => {
    const hours = 20 * 24;
    const samples = series(hours, i => ({ d100: i < 10 * 24 ? 200 : 50 }));
    const view = h.buildHistoryView(samples, { now: T0 + hours * HOUR, rangeDays: 7 });
    assert.ok(view.series.length <= 7 * 24 + 1);
    assert.strictEqual(view.coverage.samples, hours);
  });
});
