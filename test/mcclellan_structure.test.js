/**
 * Module 1-B structural breadth panel — VM tests for public/mcclellan_structure.js.
 *
 * Covers: a 0pp gap renders as a real zero (never '--'), warmup vs missing
 * payload states stay distinct, no fixed 4pp/6pp danger threshold exists
 * anywhere in rendered output, a payload without the structure block degrades
 * gracefully, and a blocked Module 1 IV payload never leaves a stale DVOL
 * number on screen.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const M = require('../public/mcclellan_structure.js');

function makeEl() {
  return {
    textContent: '',
    _classes: new Set(),
    classList: {
      add(c) { this._el._classes.add(c); },
      remove(c) { this._el._classes.delete(c); },
      toggle(c, on) { if (on === undefined) on = !this._el._classes.has(c); on ? this._el._classes.add(c) : this._el._classes.delete(c); },
      contains(c) { return this._el._classes.has(c); }
    },
    get hidden() { return this._classes.has('hidden'); }
  };
}

function makeDoc(ids) {
  const els = {};
  for (const id of ids) {
    const el = makeEl();
    el.classList._el = el;
    els[id] = el;
  }
  return { getElementById: id => els[id] || null, els };
}

const KPI_IDS = [
  'kpi-ms-gap', 'kpi-ms-gap-chip', 'kpi-ms-gap-sub',
  'kpi-ms-window', 'kpi-ms-window-chip', 'kpi-ms-window-sub',
  'kpi-ms-median_dd', 'kpi-ms-median_dd-chip', 'kpi-ms-median_dd-sub',
  'kpi-ms-sma200', 'kpi-ms-sma200-chip', 'kpi-ms-sma200-sub',
  'kpi-ms-rv30', 'kpi-ms-rv30-chip', 'kpi-ms-rv30-sub',
  'kpi-ms-corr', 'kpi-ms-corr-chip', 'kpi-ms-corr-sub',
  'mcclellan-structure-notice', 'mcclellan-structure-echarts',
  'mcclellan-structure-dvol', 'mcclellan-structure-disclaimer'
];

function readyPoint(overrides = {}) {
  return {
    date: '2026-10-20', ready: true, index_ready: true, status: 'ready',
    consecutive_days: 400, ew_index: 118.2, cw_index: 124.6,
    ew_drawdown_52w: 12.4, cw_drawdown_52w: 9.1, drawdown_gap_pp: 3.3,
    gap_percentile: 71.0, median_constituent_drawdown_52w: 34.5,
    drawdown_eligible: 61, pct_above_sma200: 42.0, sma200_eligible: 78,
    constituents: 99, expected_constituents: 100, coverage_pct: 99.0,
    realized_vol_30d: 48.7, alt_btc_corr_30d: 0.62, volatility_observations: 30,
    ...overrides
  };
}

function payload(point) {
  return {
    structure: {
      methodology: { drawdown_calendar_days: 364, index_base: 100 },
      current: point,
      series: [point]
    }
  };
}

test('structure: a 0.0 pp gap renders as a number, never a dash', () => {
  const kpis = M.buildKpis(readyPoint({ drawdown_gap_pp: 0 }), {});
  const gap = kpis.find(k => k.id === 'gap');
  assert.notStrictEqual(gap.value, '--');
  assert.match(gap.value, /0\.0/);
  assert.strictEqual(M.fmtPp(0), '0.0 pp');
  assert.strictEqual(M.fmtPp(null), '--');
  assert.strictEqual(M.fmtPp(NaN), '--');
  // render path: the zero must reach the DOM as well
  const doc = makeDoc(KPI_IDS);
  M.render({ data: payload(readyPoint({ drawdown_gap_pp: 0 })), deps: { document: doc } });
  assert.notStrictEqual(doc.els['kpi-ms-gap'].textContent, '--');
  assert.match(doc.els['kpi-ms-gap'].textContent, /0\.0/);
});

test('structure: warming-up vs missing payload stay distinct states', () => {
  // Warming up: index exists, drawdowns are legitimately null -> '--'
  const warm = readyPoint({
    ready: false, status: 'warming_up', consecutive_days: 120,
    ew_drawdown_52w: null, cw_drawdown_52w: null, drawdown_gap_pp: null,
    gap_percentile: null
  });
  const kpis = M.buildKpis(warm, { drawdown_calendar_days: 364 });
  assert.strictEqual(kpis.find(k => k.id === 'gap').value, '--');
  assert.match(kpis.find(k => k.id === 'window').chip, /120\/364/);
  const notice = M.noticeText(payload(warm).structure);
  assert.match(notice, /预热/);
  assert.match(notice, /120\/364/);
  // Unavailable: no structure block at all -> different copy, never a fake streak
  const missing = M.noticeText(null);
  assert.match(missing, /尚未生成|不含/);
  assert.notStrictEqual(missing, notice);
});

test('structure: no fixed 4pp/6pp danger threshold anywhere in rendered output', () => {
  const doc = makeDoc(KPI_IDS);
  M.render({
    data: payload(readyPoint({ drawdown_gap_pp: 4.2, gap_percentile: 95 })),
    deps: { document: doc }
  });
  const allText = Object.values(doc.els).map(e => e.textContent).join(' ');
  assert.doesNotMatch(allText, /\b[4-6]\s*pp\s*(阈值|危险|alert|危险区)/i);
  assert.doesNotMatch(allText, /买卖信号|看涨|看跌|胜率|买入|卖出/);
  assert.match(doc.els['kpi-ms-gap-sub'].textContent, /无固定危险阈值/);
  assert.match(doc.els['mcclellan-structure-disclaimer'].textContent, /不是资金流/);
  assert.match(doc.els['mcclellan-structure-disclaimer'].textContent, /不是市场崩盘预测/);
  // chart: the only markLine permitted is the gap's zero line
  const opt = M.buildChartOption(payload(readyPoint()).structure, {});
  for (const s of opt.series) {
    if (!s.markLine) continue;
    assert.ok(s.markLine.data.every(m => m.yAxis === 0),
      `${s.name} draws a non-zero guide line`);
  }
});

test('structure: missing block degrades gracefully (old payload)', () => {
  const doc = makeDoc(KPI_IDS);
  let threw = null;
  try {
    M.render({ data: { current: {}, series: [] }, deps: { document: doc } });
    M.render({ data: null, deps: { document: doc } });
    M.render({ deps: { document: doc } });
  } catch (e) { threw = e; }
  assert.strictEqual(threw, null);
  assert.strictEqual(doc.els['kpi-ms-gap'].textContent, '--');
  assert.strictEqual(doc.els['kpi-ms-median_dd'].textContent, '--');
  assert.match(doc.els['mcclellan-structure-notice'].textContent, /尚未生成|不含/);
  assert.ok(!doc.els['mcclellan-structure-notice'].hidden);
});

test('structure: DVOL label is a static Module 1 pointer — never repeats a live number', () => {
  // Blocked upstream: unavailable wording, and the stale figure is not shown.
  const doc = makeDoc(KPI_IDS);
  M.render({
    data: payload(readyPoint()),
    deps: {
      document: doc,
      marketData: { atmIv: { status: 'data_unavailable', iv1m: 55.5, dvolLatest: 61.2 } }
    }
  });
  const label = doc.els['mcclellan-structure-dvol'].textContent;
  assert.doesNotMatch(label, /55\.5|61\.2/);
  assert.match(label, /不可用/);
  assert.match(label, /VIX/);

  // Healthy numeric payload: still only the static pointer — this panel sits
  // outside Module 1's health gate, so it must not duplicate the figure.
  const healthy = M.dvolLabel({ atmIv: { iv1m: 42.5, status: 'ok' } });
  assert.doesNotMatch(healthy, /42\.5/);
  assert.match(healthy, /Module 1/);

  // null iv1m must not degrade into a fake "0.0%".
  const nul = M.dvolLabel({ atmIv: { iv1m: null, status: 'ok' } });
  assert.doesNotMatch(nul, /0\.0|null/i);
  assert.match(nul, /Module 1/);

  // Numeric-string payload: never echoed either.
  const str = M.dvolLabel({ atmIv: { iv1m: '33.3', status: 'ok' } });
  assert.doesNotMatch(str, /33\.3/);
  assert.match(str, /Module 1/);
});

test('structure: ready with null percentile -> 分位样本不足 chip + calibration notice', () => {
  const pt = readyPoint({ gap_percentile: null });
  const kpis = M.buildKpis(pt, { drawdown_calendar_days: 364 });
  assert.strictEqual(kpis.find(k => k.id === 'gap').chip, '分位样本不足');

  const structure = { methodology: {}, current: pt, series: [pt] };
  const notice = M.noticeText(structure);
  assert.match(notice, /样本不足/);
  // Notice states the declared minimum (fallback 60) as PRIOR ready
  // observations — it does not silently say "ready".
  assert.match(notice, /60 个先验就绪观测/);

  // A payload-declared minimum is honoured instead of the fallback.
  const custom = { methodology: { gap_percentile_min_observations: 30 }, current: pt, series: [pt] };
  assert.match(M.noticeText(custom), /30 个先验就绪观测/);

  // Warmup notice distinguishes window progress from percentile calibration.
  const warm = readyPoint({ ready: false, status: 'warming_up', consecutive_days: 120, gap_percentile: null });
  const warmNotice = M.noticeText({ methodology: { drawdown_calendar_days: 364 }, current: warm, series: [warm] });
  assert.match(warmNotice, /120\/364/);
  assert.match(warmNotice, /先验就绪观测/);
});

test('structure: missing UTC dates become null placeholders in the chart', () => {
  const p1 = readyPoint({ date: '2026-01-03', ew_index: 100 });
  const p2 = readyPoint({ date: '2026-01-06', ew_index: 99 });
  const opt = M.buildChartOption({ methodology: {}, current: p2, series: [p1, p2] }, {});
  assert.deepStrictEqual(opt.xAxis[0].data, ['2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06']);
  const ew = opt.series.find(s => s.name.includes('EW 指数'));
  assert.deepStrictEqual(ew.data, [100, null, null, 99]);
  // Presentation only: the source rows are untouched.
  assert.strictEqual(p1.date, '2026-01-03');
  assert.strictEqual(Object.keys(p2).length > 2, true);
});

test('structure: render -> missing block clears the old chart', () => {
  const doc = makeDoc(KPI_IDS);
  const calls = { setOption: 0, clear: 0 };
  const fakeChart = { setOption: () => calls.setOption++, clear: () => calls.clear++ };
  const fakeEcharts = { init: () => fakeChart };

  M.render({ data: payload(readyPoint()), deps: { document: doc, echarts: fakeEcharts } });
  assert.strictEqual(calls.setOption, 1);
  assert.strictEqual(calls.clear, 0);

  // A later refresh without the structure block must wipe the stale series.
  M.render({ data: { current: {}, series: [] }, deps: { document: doc, echarts: fakeEcharts } });
  assert.strictEqual(calls.clear, 1);
  assert.strictEqual(calls.setOption, 1);
});

test('structure: nulls break chart lines instead of drawing fake zeros', () => {
  const p1 = readyPoint({ date: '2026-10-18' });
  const p2 = readyPoint({ date: '2026-10-19', ew_drawdown_52w: null, cw_drawdown_52w: null, drawdown_gap_pp: null });
  const p3 = readyPoint({ date: '2026-10-20' });
  const opt = M.buildChartOption({ methodology: {}, current: p3, series: [p1, p2, p3] }, {});
  const gapSeries = opt.series.find(s => s.name.includes('回撤差'));
  assert.deepStrictEqual(gapSeries.data, [3.3, null, 3.3]);
  assert.strictEqual(gapSeries.connectNulls, false);
});
