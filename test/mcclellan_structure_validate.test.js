/**
 * Structure-block payload validation — server/crypto_mcclellan_fetcher.js
 * validateMcClellanData.
 *
 * Covers the v3 schema contract: every historical structure point must carry
 * boolean ready/index_ready on a valid non-future date; a ready point needs
 * finite 0..100 EW/CW 52-week drawdowns and a finite ±100 gap; optional
 * numeric fields must be real numbers (never numeric strings); the published
 * `current` must deep-equal the latest series row and share the Core track
 * date. Legacy payloads (no structure block, version < 3 or unspecified)
 * stay valid.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { validateMcClellanData } = require('../server/crypto_mcclellan_fetcher.js');

function trackPoint(date, over = {}) {
  return { date, ready: true, oscillator: 0.5, summation: 12.5, ...over };
}

function basePayload({ structure, version } = {}) {
  const data = {
    metadata: {
      generated_at: new Date(Date.now() - 3600e3).toISOString(),
      benchmark_date: '2026-10-16'
    },
    current: {
      core: trackPoint('2026-10-16'),
      frontier: trackPoint('2026-10-16', { oscillator: -3.2, summation: 4.1 })
    },
    series: ['2026-10-14', '2026-10-15', '2026-10-16'].map(d => ({
      date: d, core_n: 10, frontier_n: 5, dex_volume: 1e6
    }))
  };
  if (version !== undefined) data.metadata.version = version;
  if (structure !== undefined) data.structure = structure;
  return data;
}

function structPoint(date, over = {}) {
  return {
    date, ready: false, index_ready: false, status: 'warming_up',
    consecutive_days: 10,
    ew_index: 100.4, cw_index: 100.1,
    ew_drawdown_52w: null, cw_drawdown_52w: null, drawdown_gap_pp: null,
    gap_percentile: null, median_constituent_drawdown_52w: null,
    drawdown_eligible: 0, pct_above_sma200: null, sma200_eligible: 0,
    constituents: 100, expected_constituents: 100, coverage_pct: 98.5,
    realized_vol_30d: null, alt_btc_corr_30d: null, volatility_observations: 10,
    ...over
  };
}

/** Structure whose `current` deep-equals the last series row (same object). */
function structureWith(points) {
  return {
    methodology: { drawdown_calendar_days: 364 },
    current: points[points.length - 1],
    series: points
  };
}

function validStructure() {
  return structureWith([
    structPoint('2026-10-14'),
    structPoint('2026-10-15'),
    structPoint('2026-10-16', {
      ready: true, index_ready: true, status: 'ready',
      consecutive_days: 370,
      ew_drawdown_52w: 5.5, cw_drawdown_52w: 3.0, drawdown_gap_pp: 2.5,
      median_constituent_drawdown_52w: 20.1, drawdown_eligible: 90,
      pct_above_sma200: 40.0, sma200_eligible: 85,
      realized_vol_30d: 55.0, alt_btc_corr_30d: 0.5, volatility_observations: 30
    })
  ]);
}

test('mcclellan validate: valid structure block accepted (warmup rows + ready current)', () => {
  assert.strictEqual(validateMcClellanData(basePayload({ structure: validStructure() })), true);
});

test('mcclellan validate: legacy payloads without structure block stay valid', () => {
  assert.strictEqual(validateMcClellanData(basePayload()), true);
  assert.strictEqual(validateMcClellanData(basePayload({ version: 2 })), true);
});

test('mcclellan validate: v3 metadata without structure block is malformed', () => {
  assert.throws(() => validateMcClellanData(basePayload({ version: 3 })), /structure/);
});

test('mcclellan validate: malformed historical row rejected (non-boolean ready)', () => {
  const s = validStructure();
  s.series[0].ready = 'yes';
  assert.throws(() => validateMcClellanData(basePayload({ structure: s })), /ready/);
});

test('mcclellan validate: current must deep-equal the latest series row', () => {
  const s = validStructure();
  s.current = { ...s.series[2], ew_drawdown_52w: 9.9 }; // same date, different value
  assert.throws(() => validateMcClellanData(basePayload({ structure: s })), /current/);
});

test('mcclellan validate: structure current date must match core track date', () => {
  const s = structureWith([
    structPoint('2026-10-14'),
    structPoint('2026-10-15', {
      ready: true, index_ready: true, status: 'ready',
      ew_drawdown_52w: 5.5, cw_drawdown_52w: 3.0, drawdown_gap_pp: 2.5
    })
  ]);
  // Deep-equal holds, but the Core track says 2026-10-16.
  assert.throws(() => validateMcClellanData(basePayload({ structure: s })), /core\.date|Core/);
});

test('mcclellan validate: numeric-string optional field rejected', () => {
  const s = validStructure();
  s.series[1].coverage_pct = '98.5';
  assert.throws(() => validateMcClellanData(basePayload({ structure: s })), /coverage_pct/);
});

test('mcclellan validate: ready=true requires index_ready and real drawdowns/gap', () => {
  const s1 = validStructure();
  s1.series[2].index_ready = false;
  s1.current = s1.series[2];
  assert.throws(() => validateMcClellanData(basePayload({ structure: s1 })), /index_ready/);

  const s2 = validStructure();
  s2.series[2].drawdown_gap_pp = '2.5'; // string gap, not a number
  s2.current = s2.series[2];
  assert.throws(() => validateMcClellanData(basePayload({ structure: s2 })), /gap|drawdown/);

  const s3 = validStructure();
  s3.series[2].ew_drawdown_52w = 120; // out of 0..100
  s3.current = s3.series[2];
  assert.throws(() => validateMcClellanData(basePayload({ structure: s3 })), /drawdown|回撤/);
});

test('mcclellan validate: unsorted and future structure dates rejected', () => {
  const s1 = validStructure();
  s1.series[0].date = '2026-10-15'; // out of order vs series[1]
  s1.series[1].date = '2026-10-14';
  assert.throws(() => validateMcClellanData(basePayload({ structure: s1 })), /升序|日期|sort/i);

  const s2 = validStructure();
  // Future point last keeps the sort valid so the non-future check fires.
  s2.series[2] = structPoint('2099-01-01', {
    ready: true, index_ready: true, status: 'ready',
    ew_drawdown_52w: 5.5, cw_drawdown_52w: 3.0, drawdown_gap_pp: 2.5
  });
  s2.current = s2.series[2];
  assert.throws(() => validateMcClellanData(basePayload({ structure: s2 })), /未来|future/i);
});
