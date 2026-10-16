const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  analyzeAtmIv,
  analyzeDynamicGex,
  analyzeIvSmile,
  analyze25DeltaSkew,
  interpolateTotalVariance,
  detectFrontEvent,
  estimateGammaFlip,
  estimateSpotVolBeta,
  classifySkewRegime
} = require('../server/analytics_engine');
const { alignHourlyToDvolDays } = require('../server/data_fetcher');
const volHistory = require('../server/vol_surface_history');

const DAY = 86400000;
const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));

describe('期权套件 · ATM IV：分位口径、√365、VRP 与事件溢价', () => {
  const series = range(100, i => 30 + i * 0.5); // DVOL 历史 30 ~ 79.5

  test('分位用最新 DVOL 对比 DVOL 自身历史，不再用 ATM 去比方差口径的 DVOL', () => {
    const ivHistory = [{ month1: 31, month3: 33, month6: 35 }];
    const result = analyzeAtmIv(ivHistory, { latest: 55, historicalSeries: series, min: 30, max: 79.5, median: 55 });
    assert.equal(result.percentileBasis, 'dvol_vs_dvol');
    assert.equal(result.dvolLatest, 55);
    assert.equal(result.percentile, 51); // 55 在 30~79.5 中的经验分位
    assert.equal(result.regime, 'Normal', 'ATM 31% 虽低于 DVOL 历史最小值，但 DVOL 自身处于中位，不能报极值');
    assert.equal(result.extremeAlert, false);
  });

  test('缺少最新 DVOL 时不计算分位，也不给极值预警', () => {
    const result = analyzeAtmIv([{ month1: 31, month3: 33, month6: 35 }], { historicalSeries: series });
    assert.equal(result.percentile, null);
    assert.equal(result.extremeAlert, false);
  });

  test('日振幅按 365 日历日：σ/√365，周振幅 σ/√52', () => {
    const result = analyzeAtmIv([{ month1: 36.5, month3: 38, month6: 40 }], null);
    assert.equal(result.dailyExpectedMovePct, Number((36.5 / Math.sqrt(365)).toFixed(2)));
    assert.equal(result.weeklyExpectedMovePct, Number((36.5 / Math.sqrt(52)).toFixed(2)));
    assert.ok(result.dailyExpectedMovePct < 36.5 / 16, '不能沿用股票 256 交易日的 σ/16');
  });

  test('读取 iv_history 的 HV30 计算 VRP，低分位但 VRP 为正时不判为"便宜"', () => {
    const hvRow = hv30 => ({ month1: 40, month3: 42, month6: 44, data: [{ day: 7, hv: 30 }, { day: 30, hv: hv30 }] });
    const lowDvol = { latest: 34, historicalSeries: series };

    const rich = analyzeAtmIv([hvRow(35)], lowDvol);
    assert.equal(rich.hv30, 35);
    assert.equal(rich.vrp30, 5);
    assert.equal(rich.volView, 'low_but_not_cheap');
    assert.ok(!rich.recommendation.includes('买入平值跨式'));

    const cheap = analyzeAtmIv([hvRow(41)], lowDvol);
    assert.equal(cheap.vrp30, -1);
    assert.equal(cheap.volView, 'cheap');
    assert.ok(cheap.recommendation.includes('日历价差是负 Gamma'), '做多 Gamma 与日历价差必须区分');
  });

  test('高分位且已实现更高时不建议做空波动率', () => {
    const result = analyzeAtmIv(
      [{ month1: 70, month3: 65, month6: 60, data: [{ day: 30, hv: 80 }] }],
      { latest: 78, historicalSeries: series }
    );
    assert.equal(result.volView, 'high_but_realized_higher');
    assert.ok(!result.recommendation.includes('蝶式'));
  });

  test('期限插值按总方差 σ²T 线性', () => {
    const v = interpolateTotalVariance([{ dte: 10, iv: 40 }, { dte: 40, iv: 30 }], 20);
    const expected = Math.sqrt((1600 * 10 + (10 / 30) * (900 * 40 - 1600 * 10)) / 20);
    assert.ok(Math.abs(v - expected) < 0.01, `${v} vs ${expected}`);
  });

  const atmItem = (name, hour, iv) => ({
    underlying_index: name,
    hour,
    day: Math.ceil(hour / 24),
    atm_index: 0,
    underlying_price: 80000,
    list: [{ iv, strike: 80000, delta: 0.5 }]
  });

  test('近端事件溢价：按 Bennett 跳空拆分，基准取一周后两期限间远期波动率', () => {
    const atmData = [
      atmItem('BTC-15OCT26', 3, 51.4),      // 不足 1 天，报价噪声，不参与
      atmItem('BTC-16OCT26', 27, 45.06),
      atmItem('BTC-23OCT26', 195, 33.91),
      atmItem('BTC-30OCT26', 363, 33.61),
      atmItem('BTC-27NOV26', 1035, 36.81)
    ];
    const result = analyzeAtmIv([], null, atmData);
    const ev = result.frontEvent;
    assert.ok(ev, '应识别出近端事件溢价');
    assert.equal(ev.expiry, 'BTC-16OCT26');
    assert.ok(Math.abs(ev.baseIv - 33.26) < 0.05, `基准 ${ev.baseIv}`);
    assert.ok(Math.abs(ev.expectedAbsMovePct - 1.94) < 0.05, `事件期望振幅 ${ev.expectedAbsMovePct}`);
    assert.ok(ev.expectedAbsMovePct > ev.normalDayAbsMovePct);
    assert.ok(result.curveDesc.includes('事件倒挂'));
  });

  test('近端 IV 未明显高于基准时不报事件', () => {
    const points = [
      { expiry: 'A', dte: 2, iv: 36 },
      { expiry: 'B', dte: 9, iv: 34 },
      { expiry: 'C', dte: 16, iv: 34 }
    ];
    assert.equal(detectFrontEvent(points, 35), null);
  });
});

describe('期权套件 · GEX：Gamma 体制按全部到期日判定', () => {
  const gexData = {
    index_price: 80400,
    by_expiry: {
      '16OCT26': [{ strike: 80000, number: -90e6 }, { strike: 85000, number: 10e6 }],
      '23OCT26': [{ strike: 78000, number: -30e6 }, { strike: 84000, number: 5e6 }],
      '30OCT26': [{ strike: 90000, number: 40e6 }, { strike: 78000, number: -10e6 }],
      '25DEC26': [{ strike: 80000, number: 60e6 }, { strike: 60000, number: -5e6 }]
    }
  };
  const ref = new Date('2026-10-15T06:00:00Z');

  test('主力交割为正但近端周度为负时，按全部到期日合计判为负 Gamma 并提示背离', () => {
    const result = analyzeDynamicGex(gexData, ref);
    assert.ok(result.totalFocusedGexM > 0);
    assert.ok(result.totalNearGexM < 0);
    assert.equal(result.totalAllGexM, -20);
    assert.equal(result.marketMakerRegime, 'Short Gamma (Volatility Accelerating)');
    assert.ok(result.paragraph.includes('方向相反'));
    assert.ok(!result.paragraph.includes('钉盘 (Pinning) 倾向'));
    assert.ok(result.paragraph.includes('口径说明'), '必须披露做市商方向假设');
    const weekly = result.allExpiries.find(e => e.expiry === '16OCT26');
    assert.equal(weekly.isNearTerm, true);
    assert.equal(weekly.categoryTag, '近端周度');
  });

  test('全部到期净额相对总敞口很小时判为中性，并标注远离现货的翻转位', () => {
    const mixed = {
      index_price: 80000,
      by_expiry: {
        '16OCT26': [{ strike: 80000, number: -105e6 }],
        '30OCT26': [{ strike: 90000, number: 50e6 }],
        '25DEC26': [{ strike: 140000, number: 57e6 }]
      }
    };
    const result = analyzeDynamicGex(mixed, ref);
    assert.equal(result.totalAllGexM, 2);
    assert.equal(result.marketMakerRegime, 'Neutral (Mixed Expiries)');
    assert.ok(result.paragraph.includes('以近端到期为准'));
    assert.ok(result.gammaFlip && result.gammaFlip.farFromSpot);
    assert.ok(result.paragraph.includes('参考意义有限'));
  });

  test('零 Gamma 翻转位：累计 GEX 变号处线性插值，取离现货最近的一个', () => {
    const flip = estimateGammaFlip([
      { strike: 70000, number: -5 },
      { strike: 75000, number: -3 },
      { strike: 85000, number: 10 }
    ], 80000);
    assert.deepEqual(flip, { strike: 83000, from: -1, to: 1 });
  });

  test('累计 GEX 全程同号时翻转位为空，叙述如实说明', () => {
    assert.equal(estimateGammaFlip([{ strike: 70000, number: -5 }, { strike: 80000, number: -1 }], 75000), null);
    const result = analyzeDynamicGex({ index_price: 75000, by_expiry: { '30OCT26': [{ strike: 70000, number: -5e6 }, { strike: 80000, number: -1e6 }] } }, ref);
    assert.equal(result.gammaFlip, null);
    assert.ok(result.paragraph.includes('未变号'));
  });
});

describe('期权套件 · 微笑：固定 Delta 的 25Δ RR / BF', () => {
  const ref = new Date('2026-10-15T08:00:00Z');
  // 生成 Call Delta 从 0.98 到 0.15 的行权价：低行权价 (高 Delta) 一侧比高行权价一侧多得多
  const strikesFrom = ivOfDelta => range(28, i => {
    const delta = 0.98 - i * 0.03;
    return { strike: 60000 + i * 1000, delta, iv: ivOfDelta(delta) };
  });

  test('两翼按 25Δ 取点，行权价范围不对称时不会制造假偏斜', () => {
    const symmetric = strikesFrom(d => 35 + 40 * (d - 0.5) ** 2);
    const result = analyzeIvSmile({ month1: { underlying_index: 'BTC-30OCT26', underlying_price: 73500, iv_list: symmetric } }, 73500, ref);
    assert.equal(result.basis, 'delta');
    assert.ok(Math.abs(result.rr25) < 0.05, `对称微笑的 RR 应约为 0，实际 ${result.rr25}`);
    assert.ok(result.bf25 > 0);
    assert.ok(result.skewShape.startsWith('对称'));
  });

  test('Put 侧更贵时 RR 为负、判为左偏，并标注真实到期与剩余天数', () => {
    const putSkew = strikesFrom(d => 30 + 12 * d);
    const result = analyzeIvSmile({ month1: { underlying_index: 'BTC-30OCT26', underlying_price: 73500, iv_list: putSkew } }, 73500, ref);
    assert.ok(result.rr25 < -1.2);
    assert.ok(result.skewShape.startsWith('左偏'));
    assert.ok(result.putWingPremium > 0 && result.callWingPremium < 0);
    assert.equal(result.dte, 15);
    assert.ok(result.paragraph.includes('BTC-30OCT26（剩 15 天'));
  });

  test('无 Delta 时退回对称对数虚实值取点', () => {
    const list = range(41, i => ({ strike: 60000 + i * 1000, iv: 35 + (80000 - (60000 + i * 1000)) / 2000 }));
    const result = analyzeIvSmile({ month1: { underlying_index: 'BTC-30OCT26', underlying_price: 80000, iv_list: list } }, 80000, ref);
    assert.equal(result.basis, 'moneyness');
    assert.ok(result.rr25 < 0);
  });

  test('有远月数据时给出近远月 RR/BF 对比', () => {
    const putSkew = strikesFrom(d => 30 + 12 * d);
    const result = analyzeIvSmile({
      month1: { underlying_index: 'BTC-30OCT26', underlying_price: 73500, iv_list: putSkew },
      month3: { underlying_index: 'BTC-25DEC26', underlying_price: 73500, iv_list: strikesFrom(d => 33 + 6 * d) }
    }, 73500, ref);
    assert.equal(result.backMonth.underlying, 'BTC-25DEC26');
    assert.ok(result.paragraph.includes('BTC-25DEC26'));
  });
});

describe('期权套件 · 25Δ Skew：数据驱动叙述、√T 一致性、实现机制与贵贱', () => {
  const skewRow = o => [{ timestamps: 1, day1: -4.8, days7: -2.75, days15: -2.6, days30: -2.56, days60: -2.05, days90: -1.84, days180: -1.43, days365: -0.77, ...o }];
  const flatAtm = { iv1m: 35, termPoints: [{ dte: 1, iv: 35 }, { dte: 400, iv: 35 }] };

  test('叙述随数据变化，不再硬编码"超短端贴近零轴"', () => {
    const result = analyze25DeltaSkew(skewRow(), { atm: flatAtm });
    assert.ok(!result.paragraph.includes('贴近零轴'));
    assert.equal(result.nearTermSentiment, 'Put 溢价');
    assert.ok(result.paragraph.includes('1D -4.80'));

    const callSide = analyze25DeltaSkew(skewRow({ day1: 2, days7: 1.5, days30: 1.2, days90: 1.0 }), { atm: flatAtm });
    assert.equal(callSide.nearTermSentiment, 'Call 溢价');
    assert.equal(callSide.midTermSentiment, 'Call 溢价');
  });

  test('√T 一致性用 RR/σ 比较：7D 与 30D 相当为一致，7D 远陡于 30D 为近端重定价', () => {
    assert.equal(analyze25DeltaSkew(skewRow(), { atm: flatAtm }).termConsistency.verdict, 'consistent');
    assert.equal(analyze25DeltaSkew(skewRow({ days7: -8 }), { atm: flatAtm }).termConsistency.verdict, 'front_steeper');
    assert.equal(analyze25DeltaSkew(skewRow({ days7: -0.5 }), { atm: flatAtm }).termConsistency.verdict, 'front_flatter');
  });

  test('Bennett 四种机制按 β/s 划分', () => {
    const s = -20;
    assert.equal(classifySkewRegime(0, s).key, 'sticky_delta');
    assert.equal(classifySkewRegime(-20, s).key, 'sticky_strike');
    assert.equal(classifySkewRegime(-40, s).key, 'sticky_local_vol');
    assert.equal(classifySkewRegime(-60, s).key, 'jumpy');
    assert.equal(classifySkewRegime(25, s).key, 'inverse');
  });

  // 合成日度序列：ΔDVOL = beta · Δln S
  const chronoWith = (beta, noise = 0) => {
    let spot = 80000;
    let dvol = 40;
    return range(100, i => {
      const r = 0.02 * Math.sin(i * 1.7) + (i % 3 - 1) * 0.004;
      spot *= Math.exp(r);
      dvol += beta * r + noise * Math.cos(i * 2.3);
      return { ts: i * DAY, dvol, spot };
    });
  };

  test('现货-波动率回归能还原 β', () => {
    const est = estimateSpotVolBeta(chronoWith(-30));
    assert.ok(Math.abs(est.beta + 30) < 1e-6);
    assert.ok(est.r2 > 0.999);
    assert.equal(est.n, 90);
  });

  test('β/s ≈ 2 判为黏性局部波动率；β 与偏斜方向相反判为反向联动', () => {
    const sigma = 35;
    const slope = -2.56 / (2 * 0.6745 * (sigma / 100) * Math.sqrt(30 / 365));
    const local = analyze25DeltaSkew(skewRow(), { atm: flatAtm, dvolStats: { chrono: chronoWith(2 * slope) } });
    assert.equal(local.realizedRegime.key, 'sticky_local_vol');
    assert.ok(Math.abs(local.realizedRegime.ratio - 2) < 0.02);

    const inverse = analyze25DeltaSkew(skewRow(), { atm: flatAtm, dvolStats: { chrono: chronoWith(25) } });
    assert.equal(inverse.realizedRegime.key, 'inverse');
  });

  test('回归不显著时不判定机制', () => {
    const noisy = chronoWith(0.5, 3);
    const result = analyze25DeltaSkew(skewRow(), { atm: flatAtm, dvolStats: { chrono: noisy } });
    assert.equal(result.realizedRegime.key, 'insignificant');
  });

  test('偏度贵贱需本地历史 ≥30 天；Put 侧偏贵且机制不支持持有 Put 时才给牛市风险逆转', () => {
    const sigma = 35;
    const slope = -2.56 / (2 * 0.6745 * (sigma / 100) * Math.sqrt(30 / 365));
    const ctx = { atm: flatAtm, dvolStats: { chrono: chronoWith(slope) } }; // 黏性行权价

    const noHistory = analyze25DeltaSkew(skewRow(), ctx);
    assert.equal(noHistory.richness.verdict, 'insufficient_history');
    assert.ok(!noHistory.institutionalAction.includes('卖 25Δ Put'));

    const history = range(40, i => ({ day: `2026-09-${String(i + 1).padStart(2, '0')}`, rr30: -1 - i * 0.03 }));
    const rich = analyze25DeltaSkew(skewRow({ days30: -3.5 }), { ...ctx, history });
    assert.equal(rich.richness.verdict, 'put_rich');
    assert.ok(rich.institutionalAction.includes('牛市风险逆转'));

    const jumpy = analyze25DeltaSkew(skewRow({ days30: -3.5 }), {
      atm: flatAtm,
      dvolStats: { chrono: chronoWith(4 * (-3.5 / (2 * 0.6745 * 0.35 * Math.sqrt(30 / 365)))) },
      history
    });
    assert.equal(jumpy.realizedRegime.key, 'jumpy');
    assert.ok(!jumpy.institutionalAction.includes('牛市风险逆转'), '跳跃机制下持有 Put 占优，不应卖 Put');
  });
});

describe('期权套件 · 数据层：现货对齐与偏度日度档案', () => {
  test('永续小时线 23:00 收盘对齐到同一 00:00 收盘的 DVOL 日线，当日用最新小时价', () => {
    const d0 = Date.UTC(2026, 9, 13);
    const ticks = [d0 + 23 * 3600000, d0 + DAY + 22 * 3600000, d0 + DAY + 23 * 3600000, d0 + 2 * DAY + 5 * 3600000];
    const close = [100, 101, 102, 103];
    const out = alignHourlyToDvolDays(ticks, close);
    assert.equal(out.get(d0), 100);
    assert.equal(out.get(d0 + DAY), 102);
    assert.equal(out.get(d0 + 2 * DAY), 103);
    assert.equal(out.size, 3);
  });

  test('日度档案同日覆盖、按日期排序并裁剪保留期', () => {
    let recs = [];
    recs = volHistory.upsertRecord(recs, { day: '2026-10-02', rr30: -1 }, 2);
    recs = volHistory.upsertRecord(recs, { day: '2026-10-01', rr30: -2 }, 2);
    recs = volHistory.upsertRecord(recs, { day: '2026-10-02', rr30: -3 }, 2);
    assert.deepEqual(recs.map(r => [r.day, r.rr30]), [['2026-10-01', -2], ['2026-10-02', -3]]);
    recs = volHistory.upsertRecord(recs, { day: '2026-10-03', rr30: -4 }, 2);
    assert.deepEqual(recs.map(r => r.day), ['2026-10-02', '2026-10-03']);
  });

  test('由分析结果组装记录并写入文件；缺少 30D 偏度时不记录', () => {
    assert.equal(volHistory.recordFromAnalyses({ skew: { d30: null } }), null);
    const rec = volHistory.recordFromAnalyses({
      atm: { iv1m: 36, dvolLatest: 38.8 },
      smile: { bf25: 1.4 },
      skew: { d7: -2.7, d30: -2.5, d90: -1.8 },
      spot: 80000,
      ts: Date.UTC(2026, 9, 15, 6)
    });
    assert.deepEqual(rec, { day: '2026-10-15', ts: Date.UTC(2026, 9, 15, 6), spot: 80000, iv1m: 36, dvol: 38.8, rr7: -2.7, rr30: -2.5, rr90: -1.8, bf25: 1.4 });

    // 只读写临时文件：结果与真实档案、当前日期无关
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'volhist-')), 'h.json');
    fs.writeFileSync(file, JSON.stringify({ records: [{ day: '2026-10-14', rr30: -1.9 }] }));
    volHistory.recordSnapshot({ atm: { iv1m: 36 }, skew: { d30: -2.5 }, spot: 80000 }, { file, now: Date.UTC(2026, 9, 15) });
    volHistory.recordSnapshot({ skew: { d30: null } }, { file, now: Date.UTC(2026, 9, 16) });
    const written = volHistory.readHistory(file);
    assert.deepEqual(written.map(r => [r.day, r.rr30]), [['2026-10-14', -1.9], ['2026-10-15', -2.5]]);
  });
});
