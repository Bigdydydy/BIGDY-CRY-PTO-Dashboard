const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../server/skew_history');
const { analyze25DeltaSkew } = require('../server/analytics_engine');

const DAY = 86400000;

/** 合成一天的合约 IV：iv = 50 + slope·ln(K/F)，slope < 0 为 Put 偏斜 */
function syntheticDay(slope, { day = '2026-01-01', F = 100000 } = {}) {
  const insts = {};
  for (let k = 0.70; k <= 1.40; k += 0.025) {
    const K = Math.round(F * k / 500) * 500;
    const iv = 50 + slope * Math.log(K / F);
    insts[`BTC-31JAN26-${K}-${K >= F ? 'C' : 'P'}`] = [Number(iv.toFixed(2)), 3];
  }
  return { day, index: F, insts };
}

function series(n, rrOf, start = '2025-01-01') {
  const t0 = Date.parse(start);
  return Array.from({ length: n }, (_, i) => ({ day: new Date(t0 + i * DAY).toISOString().slice(0, 10), rr: rrOf(i), atm: 50, n: 20 }));
}

describe('skew_history 重建', () => {
  test('fitDay：Put 偏斜得到负 RR，Call 偏斜得到正 RR，ATM 接近平值 IV', () => {
    const put = S.fitDay(syntheticDay(-30));
    assert.ok(put.rr < -2, `put rr ${put.rr}`);
    assert.ok(Math.abs(put.atm - 50) < 2);
    const call = S.fitDay(syntheticDay(30));
    assert.ok(call.rr > 2, `call rr ${call.rr}`);
  });

  test('fitDay：只有一翼时不外推', () => {
    const rec = syntheticDay(-30);
    for (const k of Object.keys(rec.insts)) if (k.endsWith('-C')) delete rec.insts[k];
    assert.equal(S.fitDay(rec), null);
  });

  test('richness：最新值在近一年最负区间 → put_rich；历史不足 / 过期分别标明', () => {
    const recs = series(300, i => -3 + Math.sin(i / 7));
    recs.push(...series(3, () => -9, recs.length ? new Date(Date.parse(recs[recs.length - 1].day) + DAY).toISOString().slice(0, 10) : '2025-01-01'));
    const last = recs[recs.length - 1].day;
    const now = Date.parse(`${last}T09:00:00Z`);
    const r = S.richnessFromHistory(recs, { now });
    assert.equal(r.verdict, 'put_rich');
    assert.equal(r.basis, 'reconstructed');
    assert.equal(r.asOf, last);
    assert.equal(S.richnessFromHistory(recs.slice(-50), { now }).verdict, 'insufficient_history');
    assert.equal(S.richnessFromHistory(recs, { now: now + 5 * DAY }).verdict, 'stale');
  });

  test('richness：3 日中位数压掉单日离群值', () => {
    const recs = series(300, () => -3);
    recs[recs.length - 1].rr = -20; // 单日离群
    const now = Date.parse(`${recs[recs.length - 1].day}T09:00:00Z`);
    assert.notEqual(S.richnessFromHistory(recs, { now }).verdict, 'put_rich');
  });

  test('upsertRecords 同日覆盖并排序', () => {
    const out = S.upsertRecords([{ day: '2026-01-02', rr: 1 }, { day: '2026-01-01', rr: 0 }], [{ day: '2026-01-02', rr: 5 }]);
    assert.deepEqual(out.map(r => [r.day, r.rr]), [['2026-01-01', 0], ['2026-01-02', 5]]);
  });
});

describe('Card 05 三层研判', () => {
  const row = { timestamps: Date.now(), day1: -1, days7: -4, days30: -6.6, days90: -6.6, days180: -5.5, days365: -4.6 };
  const flatAtm = { iv1m: 45, termPoints: [{ dte: 30, iv: 45 }, { dte: 90, iv: 45 }, { dte: 365, iv: 45 }] };

  test('重建历史判定 Put 偏贵时：结论行带分位、要点引用基准率且声明不是崩盘预警、要点不超过 3 条', () => {
    const r = analyze25DeltaSkew([row], {
      atm: flatAtm,
      skewRichness: { verdict: 'put_rich', percentile: 17, value: -8.5, asOf: '2026-11-27', n: 361, basis: 'reconstructed' },
      skewStudy: S.STUDY
    });
    assert.equal(r.richness.basis, 'reconstructed');
    assert.equal(r.brief.headline, '30D Put 偏斜偏贵：近一年第 17 分位');
    assert.ok(r.brief.headline.length <= 40);
    assert.ok(r.brief.points.length <= 3);
    assert.ok(r.brief.points[0].includes('不是崩盘预警'));
    assert.ok(r.brief.details.some(d => d.label === '研究出处' && d.href));
    assert.ok(r.brief.details.some(d => d.label === '交易含义（非建议）'));
    assert.ok(r.paragraph.includes('重建'), 'paragraph 兼容字段仍完整');
  });

  test('重建历史过期时退回本地档案', () => {
    const r = analyze25DeltaSkew([row], { atm: flatAtm, skewRichness: { verdict: 'stale' }, skewStudy: S.STUDY });
    assert.equal(r.richness.basis, 'local');
    assert.equal(r.richness.verdict, 'insufficient_history');
    assert.ok(r.brief.headline.includes('暂无历史分位'));
  });
});
