const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  analyzeAtmIv,
  analyzeDynamicGex,
  analyzeBlockTrades,
  calcGreeks,
  parseInstrument,
  identifyInstitutionalStrategy,
  evaluate0DTEBehavior,
  evaluateTradeAction
} = require('../server/analytics_engine');

const { sendJsonResponse } = require('../server/index');

describe('Module 1: ATM IV & Percentile Engine', () => {
  const mockIvHistory = [
    {
      month1: 52.0,
      month2: 55.0,
      month3: 58.0,
      month6: 64.0,
      one_year: 70.0
    }
  ];

  const mockDvolStats = {
    count: 730,
    min: 35.0,
    max: 95.0,
    median: 55.0,
    p10: 42.0,
    p25: 48.0,
    p75: 65.0,
    p90: 78.0,
    historicalSeries: [35.0, 40.0, 45.0, 50.0, 55.0, 60.0, 65.0, 70.0, 75.0, 80.0, 85.0, 90.0, 95.0]
  };

  test('Calculates Contango structure correctly when forward IV increases with term', () => {
    const result = analyzeAtmIv(mockIvHistory, mockDvolStats);
    assert.equal(result.curveType, 'Contango');
    assert.equal(result.iv1m, 52.0);
    assert.equal(result.iv3m, 58.0);
    assert.equal(result.iv6m, 64.0);
    assert.ok(result.percentile > 0 && result.percentile <= 100);
    assert.ok(!result.paragraph.includes('undefined%'));
  });

  test('Boundary: percentile === 0 when current IV is at historical minimum', () => {
    const lowIvHistory = [
      {
        month1: 30.0, // lower than min (35.0)
        month3: 32.0,
        month6: 34.0
      }
    ];

    const result = analyzeAtmIv(lowIvHistory, mockDvolStats);
    assert.equal(result.percentile, 0, 'percentile should strictly be 0, not null or undefined');
    assert.equal(result.regime, 'Extreme Low');
    assert.ok(!result.paragraph.includes('undefined%'), 'narrative text must not contain undefined%');
    assert.ok(result.paragraph.includes('0.0%'), 'narrative should mention 0.0% quantile');
  });

  test('Graceful fallback when DVOL historical stats are absent', () => {
    const result = analyzeAtmIv(mockIvHistory, null);
    assert.equal(result.percentile, null);
    assert.ok(!result.paragraph.includes('undefined%'));
    assert.ok(result.paragraph.includes('参考常模'));
    assert.equal(result.isRealtime, false);
  });

  test('Real-time atmData ingestion correctly interpolates 1M, 2M, 3M, 6M IV from live term structure', () => {
    const mockAtmData = [
      {
        underlying_index: 'BTC-24SEP26',
        day: 2,
        atm_index: 0,
        underlying_price: 86000,
        list: [{ iv: 37.0, strike: 86000, delta: 0.50 }]
      },
      {
        underlying_index: 'BTC-9OCT26',
        day: 17,
        atm_index: 0,
        underlying_price: 86200,
        list: [{ iv: 36.5, strike: 86000, delta: 0.51 }]
      },
      {
        underlying_index: 'BTC-30OCT26',
        day: 38,
        atm_index: 0,
        underlying_price: 86500,
        list: [{ iv: 37.0, strike: 87000, delta: 0.50 }]
      },
      {
        underlying_index: 'BTC-25DEC26',
        day: 94,
        atm_index: 0,
        underlying_price: 87200,
        list: [{ iv: 38.8, strike: 88000, delta: 0.52 }]
      },
      {
        underlying_index: 'BTC-26MAR27',
        day: 185,
        atm_index: 0,
        underlying_price: 88200,
        list: [{ iv: 39.5, strike: 88000, delta: 0.53 }]
      }
    ];

    const result = analyzeAtmIv(mockIvHistory, mockDvolStats, mockAtmData);
    assert.equal(result.isRealtime, true, 'isRealtime should be true when atmData is provided');
    assert.ok(result.termPoints.length >= 5, 'termPoints should be populated');
    // 30D is interpolated between 17D (36.5%) and 38D (37.0%)
    assert.ok(result.iv1m >= 36.5 && result.iv1m <= 37.0, `iv1m (${result.iv1m}) should be interpolated between 36.5 and 37.0`);
    // 90D is interpolated between 38D (37.0%) and 94D (38.8%)
    assert.ok(result.iv3m >= 37.0 && result.iv3m <= 38.8, `iv3m (${result.iv3m}) should be interpolated between 37.0 and 38.8`);
    assert.equal(result.curveType, 'Contango');
    assert.ok(result.dailyExpectedMovePct > 0);
  });
});

describe('Module 2: Dynamic GEX Engine', () => {
  const mockGexData = {
    index_price: 77250,
    by_expiry: {
      '25SEP26': [
        { strike: 70000, number: 4000000 },
        { strike: 75000, number: 12000000 },
        { strike: 80000, number: 18000000 }, // Call Wall
        { strike: 65000, number: -17000000 } // Put Wall
      ],
      '27NOV26': [
        { strike: 85000, number: 29000000 },
        { strike: 60000, number: -24500000 }
      ]
    }
  };

  test('Identifies Call Wall and Put Wall accurately', () => {
    // Reference date in September 2026
    const refDate = new Date('2026-09-12T00:00:00Z');
    const result = analyzeDynamicGex(mockGexData, refDate);

    assert.ok(result.focusedExpiries.length > 0);
    const sepExp = result.focusedExpiries.find(e => e.expiry === '25SEP26');
    assert.ok(sepExp);
    assert.equal(sepExp.callWall, 80000);
    assert.equal(sepExp.putWall, 65000);
    assert.ok(sepExp.totalGex > 0);
  });

  test('Rolls front-month focus to next month end after current month expiry passes', () => {
    const rollData = {
      index_price: 77250,
      by_expiry: {
        '2OCT26': [{ strike: 78000, number: 1000000 }],
        '30OCT26': [
          { strike: 85000, number: 9000000 },
          { strike: 70000, number: -6000000 }
        ],
        '27NOV26': [{ strike: 90000, number: 2000000 }],
        '25DEC26': [{ strike: 100000, number: 5000000 }]
      }
    };
    const result = analyzeDynamicGex(rollData, new Date('2026-09-27T09:00:00Z'));
    const focused = result.focusedExpiries.map(e => e.expiry);
    assert.ok(focused.includes('30OCT26'));
    assert.ok(!focused.includes('2OCT26'));
    assert.ok(!focused.includes('27NOV26'));
    const oct = result.focusedExpiries.find(e => e.expiry === '30OCT26');
    assert.equal(oct.categoryTag, '次月月底交割');
    assert.equal(oct.callWall, 85000);
  });
});

describe('Module 3: Block Trades & Iceberg Clustering', () => {
  const baseTime = 1773300000000;
  const mockTrades = [
    // Whale block: single trade > $30M
    {
      trade_id: 'whale-1',
      instrument_name: 'BTC-27MAR26-80000-C',
      direction: 'buy',
      amount: 450,
      price: 0.12,
      index_price: 78000,
      timestamp: baseTime
    },
    // Iceberg cluster: 3 trades within 5 minutes on same instrument totaling > $30M
    {
      trade_id: 'iceberg-1',
      instrument_name: 'BTC-26DEC26-70000-P',
      direction: 'sell',
      amount: 150,
      price: 0.05,
      index_price: 78000,
      timestamp: baseTime + 60000
    },
    {
      trade_id: 'iceberg-2',
      instrument_name: 'BTC-26DEC26-70000-P',
      direction: 'sell',
      amount: 150,
      price: 0.05,
      index_price: 78000,
      timestamp: baseTime + 120000
    },
    {
      trade_id: 'iceberg-3',
      instrument_name: 'BTC-26DEC26-70000-P',
      direction: 'sell',
      amount: 150,
      price: 0.05,
      index_price: 78000,
      timestamp: baseTime + 180000
    }
  ];

  test('Filters single whale blocks and groups iceberg clusters above threshold', () => {
    const result = analyzeBlockTrades(mockTrades, 30000000);
    assert.ok(result.whaleBlocks.length >= 1);
    assert.ok(result.icebergClusters.length >= 1);

    const cluster = result.icebergClusters.find(c => c.instrument === 'BTC-26DEC26-70000-P');
    assert.ok(cluster);
    assert.equal(cluster.direction, 'sell');
    assert.equal(cluster.splitCount, 3);
    assert.equal(cluster.totalContracts, 450);
  });

  test('Iceberg clusters default to latest execution first and expose numeric start/end timestamps', () => {
    const t0 = Date.UTC(2026, 9, 1, 0, 0, 0);
    const slice = (id, inst, amount, ts) => ({ trade_id: id, instrument_name: inst, direction: 'buy', amount, price: 0.02, index_price: 80000, timestamp: ts });
    const trades = [
      // Larger, older cluster
      slice('old-1', 'BTC-26DEC26-90000-C', 400, t0),
      slice('old-2', 'BTC-26DEC26-90000-C', 400, t0 + 5 * 60000),
      // Smaller, newer cluster (a day later)
      slice('new-1', 'BTC-26DEC26-100000-C', 250, t0 + 86400000),
      slice('new-2', 'BTC-26DEC26-100000-C', 250, t0 + 86400000 + 3 * 60000)
    ];
    const result = analyzeBlockTrades(trades, 30000000);
    assert.equal(result.icebergClusters.length, 2);
    const [first, second] = result.icebergClusters;
    assert.equal(first.instrument, 'BTC-26DEC26-100000-C');
    assert.equal(first.startTimestamp, t0 + 86400000);
    assert.equal(first.endTimestamp, t0 + 86400000 + 3 * 60000);
    assert.ok(second.clusterNotionalUSD > first.clusterNotionalUSD);
  });

  test('Module 3: Pagination at 20 trades per page cleanly slices data and determines boundaries', () => {
    const PAGE_SIZE = 20;
    // Simulate 55 trades
    const items = Array.from({ length: 55 }, (_, i) => ({ id: `trade-${i + 1}` }));
    const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    assert.equal(totalPages, 3, '55 items at 20/page should be 3 pages');

    // Page 1
    const p1 = items.slice((1 - 1) * PAGE_SIZE, 1 * PAGE_SIZE);
    assert.equal(p1.length, 20);
    assert.equal(p1[0].id, 'trade-1');
    assert.equal(p1[19].id, 'trade-20');

    // Page 2
    const p2 = items.slice((2 - 1) * PAGE_SIZE, 2 * PAGE_SIZE);
    assert.equal(p2.length, 20);
    assert.equal(p2[0].id, 'trade-21');
    assert.equal(p2[19].id, 'trade-40');

    // Page 3 (partial page)
    const p3 = items.slice((3 - 1) * PAGE_SIZE, 3 * PAGE_SIZE);
    assert.equal(p3.length, 15);
    assert.equal(p3[0].id, 'trade-41');
    assert.equal(p3[14].id, 'trade-55');

    // Zero items boundary
    const emptyItems = [];
    const emptyPages = Math.max(1, Math.ceil(emptyItems.length / PAGE_SIZE));
    assert.equal(emptyPages, 1, 'Empty list should report 1 page');
    const pEmpty = emptyItems.slice(0, PAGE_SIZE);
    assert.equal(pEmpty.length, 0);
  });
});

describe('Module 4 & 5: IV Smile & 25Δ Skew', () => {
  test('Parses Deribit instruments accurately', () => {
    const parsed = parseInstrument('BTC-27NOV26-85000-C');
    assert.ok(parsed);
    assert.equal(parsed.currency, 'BTC');
    assert.equal(parsed.expiryStr, '27NOV26');
    assert.equal(parsed.strike, 85000);
    assert.equal(parsed.type, 'C');
    assert.equal(parsed.isCall, true);
  });

  test('Calculates Black-76 option Greeks correctly', () => {
    // S=75000, K=75000, T=0.25 (3M), iv_pct=60, isCall=true, r=0.04
    const greeksCall = calcGreeks(75000, 75000, 0.25, 60.0, true, 0.04);
    assert.ok(greeksCall.delta > 0.45 && greeksCall.delta < 0.65, 'ATM call delta should be around 0.5');
    assert.ok(greeksCall.gamma > 0, 'Gamma must be positive');
    assert.ok(greeksCall.vega > 0, 'Vega must be positive');
  });
});

describe('Server Layer: ETag & Compression Engine', () => {
  function createMockReqRes({ headers = {} } = {}) {
    let statusCode = 200;
    let writtenHeaders = {};
    let writtenBody = null;

    const req = {
      headers,
      socket: { remoteAddress: '127.0.0.1' }
    };

    const res = {
      writeHead(code, head = {}) {
        statusCode = code;
        writtenHeaders = { ...writtenHeaders, ...head };
      },
      setHeader(k, v) {
        writtenHeaders[k.toLowerCase()] = v;
      },
      end(body) {
        writtenBody = body !== undefined ? body : null;
      },
      getStatus: () => statusCode,
      getHeaders: () => writtenHeaders,
      getBody: () => writtenBody
    };

    return { req, res };
  }

  test('sendJsonResponse emits strong MD5 ETag header', () => {
    const { req, res } = createMockReqRes();
    const data = { message: 'hello world', count: 42 };

    sendJsonResponse(req, res, 200, data);

    const headers = res.getHeaders();
    assert.equal(res.getStatus(), 200);
    assert.ok(headers.ETag, 'ETag must be present');
    assert.match(headers.ETag, /^"[a-f0-9]{32}"$/);
  });

  test('sendJsonResponse returns 304 Not Modified when ETag matches', () => {
    const data = { message: 'test etag 304' };

    // 1. Initial request to obtain ETag
    const first = createMockReqRes();
    sendJsonResponse(first.req, first.res, 200, data);
    const etag = first.res.getHeaders().ETag;

    // 2. Subsequent request with If-None-Match matching etag
    const second = createMockReqRes({ headers: { 'if-none-match': etag } });
    sendJsonResponse(second.req, second.res, 200, data);

    assert.equal(second.res.getStatus(), 304);
    assert.equal(second.res.getBody(), null, '304 must return empty body');
  });

  test('sendJsonResponse compresses payload with gzip when requested', () => {
    const { req, res } = createMockReqRes({ headers: { 'accept-encoding': 'gzip, deflate' } });
    const data = { largeText: 'A'.repeat(5000) };

    sendJsonResponse(req, res, 200, data);

    const headers = res.getHeaders();
    assert.equal(res.getStatus(), 200);
    assert.equal(headers['Content-Encoding'], 'gzip');
    assert.ok(res.getBody() instanceof Buffer);
    assert.ok(res.getBody().length < 5000, 'Gzipped payload must be smaller than raw string');
  });
});

describe('HTTP Server Lifecycle & Security Endpoints', () => {
  const { server } = require('../server/index');

  test('GET /healthz returns 200 OK', async () => {
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', async () => {
        const port = server.address().port;
        try {
          const resp = await fetch(`http://127.0.0.1:${port}/healthz`);
          assert.equal(resp.status, 200);
          const text = await resp.text();
          assert.equal(text, 'OK');
        } finally {
          server.close(resolve);
        }
      });
    });
  });

  test('POST /api/refresh rate limits rapid sequential calls to 429', async () => {
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', async () => {
        const port = server.address().port;
        try {
          // First call triggers refresh
          const p1 = fetch(`http://127.0.0.1:${port}/api/refresh`, { method: 'POST' });
          // Immediate second call should be blocked by 10s IP rate limit (429)
          const p2 = fetch(`http://127.0.0.1:${port}/api/refresh`, { method: 'POST' });

          const [r1, r2] = await Promise.all([p1, p2]);
          assert.equal(r2.status, 429, 'Immediate second refresh must be rate limited to 429');
          const body2 = await r2.json();
          assert.equal(body2.code, 429);
          assert.ok(body2.error.includes('请求过于频繁'));
        } finally {
          server.close(resolve);
        }
      });
    });
  });

  test('GET /api/macro-chart returns 200 with code 0 and valid real-time spot price', async () => {
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', async () => {
        const port = server.address().port;
        try {
          const resp = await fetch(`http://127.0.0.1:${port}/api/macro-chart`);
          assert.equal(resp.status, 200);
          const body = await resp.json();
          assert.equal(body.code, 0);
          assert.ok(body.summary, 'summary object must exist');
          assert.ok(typeof body.summary.currentBtc === 'number' && body.summary.currentBtc > 50000);
          assert.ok(typeof body.summary.mstrProfitMultiplier === 'number');
          assert.ok(Array.isArray(body.points) && body.points.length > 0);
        } finally {
          server.close(resolve);
        }
      });
    });
  });
});

describe('Phase 2: Term Premium on Real Tenors & Carry Score', () => {
  const fs = require('fs');
  const path = require('path');
  const {
    buildCurvePoint,
    aggregateDailyFunding,
    interpolateAtDay,
    applyCarryMetrics,
    calculateCarryScore,
    scoreTier,
    deribitFutureName,
    parseDeribitFutureExpiry,
    getQuarterExpiries,
    SCHEMA_VERSION,
    CQ_MIN_DAYS
  } = require('../server/basis_fetcher');
  const { evaluateCarryRegime, analyzeTermPremium, etfCarryMetrics } = require('../server/term_premium_engine');
  const DAY = 86400000;

  test('Historical dataset uses only real tenors and never extrapolates', () => {
    const filePath = path.join(__dirname, '..', 'data', 'term_premium_history.json');
    assert.ok(fs.existsSync(filePath), 'data/term_premium_history.json must exist');
    const series = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.ok(series.length >= 900, `Dataset must cover 2024.01 onwards (>= 900 rows), got ${series.length}`);
    assert.equal(series[0].date, '2024-01-01');

    for (let i = 0; i < series.length; i++) {
      const row = series[i];
      assert.equal(row.schema, SCHEMA_VERSION, `Row ${i} schema`);
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(row.date), `Row ${i} date format`);
      if (i > 0) assert.ok(row.date > series[i - 1].date, `Row ${i} strictly ascending`);
      for (const k of ['fundingApr', 'nqApr', 'apr90d', 'tbill', 'spreadTerm', 'excessOverTBill', 'carryScore']) {
        assert.ok(typeof row[k] === 'number' && isFinite(row[k]), `Row ${i} ${k}`);
      }
      // Front quarterly is dropped inside its final week, and only then
      assert.equal(row.cqValid, row.cqDays >= CQ_MIN_DAYS, `Row ${i} cqValid`);
      assert.equal(row.cqApr === null, !row.cqValid, `Row ${i} cqApr null iff CQ excluded`);
      assert.equal(row.spreadShort === null, !row.cqValid, `Row ${i} spreadShort null iff CQ excluded`);
      // 90D must lie inside the envelope of the real points that bracket it (no extrapolation)
      const pts = [row.fundingApr, row.cqApr, row.nqApr].filter(v => v != null);
      assert.ok(row.apr90d >= Math.min(...pts) - 0.011 && row.apr90d <= Math.max(...pts) + 0.011, `Row ${i} apr90d inside real points`);
      assert.ok(row.carryScore >= 0 && row.carryScore <= 100, `Row ${i} carryScore in [0,100]`);
    }

    // In the front quarterly's final week 90D comes from funding→NQ with NQ at ~91-98D, so it must
    // sit next to NQ (funding weight ≤ 1 − 90/98). This is what removes the old expiry-day spikes.
    for (const row of series.filter(r => !r.cqValid)) {
      const fundingWeight = 1 - 90 / row.nqDays;
      assert.ok(fundingWeight >= -0.001 && fundingWeight < 0.09, `${row.date} NQ at ${row.nqDays}D`);
      assert.ok(Math.abs(row.apr90d - row.nqApr) <= fundingWeight * Math.abs(row.fundingApr - row.nqApr) + 0.02, `${row.date} 90D tracks NQ`);
    }
  });

  test('buildCurvePoint drops the front quarterly in its final week and interpolates 90D from real points', () => {
    const t0 = Date.UTC(2026, 2, 26, 0, 0, 0);
    const common = { timestamp: t0, indexPrice: 100000, fundingApr: 10, tbill: 4 };
    // CQ 1.33 days out (excluded), NQ 92.33 days out at 5% APR
    const nqDays = 92 + 1 / 3;
    const nqPrice = 100000 * (1 + 0.05 * nqDays / 365);
    const p = buildCurvePoint({ ...common, cqPrice: 100050, nqPrice, cqExpiryTs: t0 + (4 / 3) * DAY, nqExpiryTs: t0 + nqDays * DAY });
    assert.equal(p.cqValid, false);
    assert.equal(p.cqApr, null);
    assert.equal(p.spreadShort, null);
    assert.equal(p.spreadCalendar, null);
    assert.equal(p.nqApr, 5);
    // Linear between funding (0D, 10%) and NQ (92.33D, 5%)
    const expected = 10 + 90 * (5 - 10) / nqDays;
    assert.ok(Math.abs(p.apr90d - expected) < 0.01, `apr90d ${p.apr90d} vs ${expected}`);
    assert.equal(p.hurdle, 7.5);

    // Mid-quarter: CQ 60D @ 6%, NQ 151D @ 7% → 90D interpolated between the two contracts
    const q = buildCurvePoint({
      ...common,
      cqPrice: 100000 * (1 + 0.06 * 60 / 365),
      nqPrice: 100000 * (1 + 0.07 * 151 / 365),
      cqExpiryTs: t0 + 60 * DAY,
      nqExpiryTs: t0 + 151 * DAY
    });
    assert.equal(q.cqValid, true);
    assert.equal(q.cqApr, 6);
    assert.equal(q.spreadShort, -4);
    assert.equal(q.spreadCalendar, 1);
    assert.ok(Math.abs(q.apr90d - (6 + 30 / 91)) < 0.01);
  });

  test('interpolateAtDay refuses to extrapolate', () => {
    const pts = [{ days: 0, apr: 3 }, { days: 50, apr: 5 }, { days: 140, apr: 8 }];
    assert.equal(interpolateAtDay(pts, 25), 4);
    assert.equal(interpolateAtDay(pts, 140), 8);
    assert.equal(interpolateAtDay(pts, 180), null);
  });

  test('aggregateDailyFunding sums settlements in the window and annualizes', () => {
    const now = Date.UTC(2026, 9, 5);
    const rows = [
      { fundingTime: now - 9 * DAY, fundingRate: '0.01' },   // outside 7D window
      { fundingTime: now - 2 * DAY, fundingRate: '0.0001' },
      { fundingTime: now - 16 * 3600000, fundingRate: '0.0001' },
      { fundingTime: now - 8 * 3600000, fundingRate: '0.0001' },
      { fundingTime: now, fundingRate: '0.0001' }
    ];
    assert.ok(Math.abs(aggregateDailyFunding(rows, now, 1) - 0.0003 * 365 * 100) < 1e-9);
    assert.ok(Math.abs(aggregateDailyFunding(rows, now, 7) - 0.0004 * (365 / 7) * 100) < 1e-9);
    assert.equal(aggregateDailyFunding([], now, 7), null);
  });

  test('daily cache is refreshed as soon as a new 08:00 UTC snapshot is due', () => {
    const { expectedLatestDate, hasLatestSnapshot, latestSnapshotTs } = require('../server/basis_fetcher');
    // 10-06 16:30 UTC+8 = 08:30 UTC: the 10-06 snapshot is due
    assert.equal(expectedLatestDate(Date.UTC(2026, 9, 6, 8, 30)), '2026-10-06');
    assert.equal(latestSnapshotTs(Date.UTC(2026, 9, 6, 8, 30)), Date.UTC(2026, 9, 6, 8));
    // 10-06 15:55 UTC+8 = 07:55 UTC: still the 10-05 snapshot
    assert.equal(expectedLatestDate(Date.UTC(2026, 9, 6, 7, 55)), '2026-10-05');
    // Just after midnight UTC the previous day's 08:00 snapshot is still the latest
    assert.equal(expectedLatestDate(Date.UTC(2026, 9, 6, 0, 30)), '2026-10-05');
    const series = Array.from({ length: 101 }, () => ({ schema: SCHEMA_VERSION, date: '2026-10-05' }));
    assert.equal(hasLatestSnapshot(series, Date.UTC(2026, 9, 6, 7)), true);
    // The old "< 48h old" rule kept this cache for all of 10-06; it must now be treated as stale
    assert.equal(hasLatestSnapshot(series, Date.UTC(2026, 9, 6, 8, 30)), false);
  });

  test('Deribit quarterly names round-trip with the last-Friday expiry rule', () => {
    assert.equal(deribitFutureName(Date.UTC(2026, 11, 25, 8)), 'BTC-25DEC26');
    assert.equal(deribitFutureName(Date.UTC(2024, 2, 29, 8)), 'BTC-29MAR24');
    assert.equal(parseDeribitFutureExpiry('BTC-26MAR27'), Date.UTC(2027, 2, 26, 8));
    assert.equal(parseDeribitFutureExpiry('BTC-PERPETUAL'), null);
    const [cq, nq] = getQuarterExpiries(new Date(Date.UTC(2026, 9, 10, 8)));
    assert.equal(deribitFutureName(cq.getTime()), 'BTC-25DEC26');
    assert.equal(deribitFutureName(nq.getTime()), 'BTC-26MAR27');
  });

  test('calculateCarryScore: Sharpe-weighted, bounded, monotonic in carry', () => {
    const base = { basisVolAnn: 2, spreadTerm: 0, momentum30d: 0 };
    const low = calculateCarryScore({ ...base, excessOverTBill: -2 });
    const mid = calculateCarryScore({ ...base, excessOverTBill: 1 });
    const high = calculateCarryScore({ ...base, excessOverTBill: 6 });
    assert.ok(low.carryScore < mid.carryScore && mid.carryScore < high.carryScore);
    // Sharpe 0.5 → 37.5 pts × 0.6 + 50 × 0.25 + 50 × 0.15 = 42.5
    assert.equal(mid.carrySharpe, 0.5);
    assert.equal(mid.carryScore, 42.5);
    assert.equal(high.scoreComponents.sharpe, 100);
    assert.equal(low.scoreComponents.sharpe, 0);
    // Vol floor prevents a quiet tape from inflating the Sharpe
    assert.equal(calculateCarryScore({ ...base, basisVolAnn: 0.1, excessOverTBill: 1 }).carrySharpe, 1);
    // Perp funding far above the curve (crowding) lowers the score
    const crowded = calculateCarryScore({ ...base, excessOverTBill: 1, spreadTerm: -10 });
    assert.ok(crowded.carryScore < mid.carryScore);
    assert.equal(scoreTier(70).code, 'PRIME');
    assert.equal(scoreTier(50).code, 'QUALIFIED');
    assert.equal(scoreTier(35).code, 'MARGINAL');
    assert.equal(scoreTier(10).code, 'AVOID');
  });

  test('applyCarryMetrics computes rolling basis vol and momentum', () => {
    const series = Array.from({ length: 40 }, (_, i) => ({
      apr90d: 5 + (i % 2 ? 0.5 : -0.5),
      excessOverTBill: 1,
      spreadTerm: 0
    }));
    applyCarryMetrics(series);
    assert.equal(series[5].basisVolAnn, null, 'needs >= 10 observations');
    // daily change ±1pp in APR → ±0.2466% of notional → annualized ≈ 4.8%
    assert.ok(Math.abs(series[39].basisVolAnn - 1 * 90 / 365 * Math.sqrt(365) * Math.sqrt(30 / 29)) < 0.05);
    assert.equal(series[39].momentum30d, 0);
  });

  test('evaluateCarryRegime classifies all regimes on real-tenor fields', () => {
    const base = { fundingApr: 6, cqApr: 7, nqApr: 7.5, tbill: 4, hurdle: 7.5, spreadShort: 1, spreadTerm: 1, carryScore: 50 };
    assert.equal(evaluateCarryRegime({ ...base, apr90d: 10, excessOverTBill: 6, excessOverHurdle: 2.5 }).regimeCode, 'NORMAL_CONTANGO');
    assert.equal(evaluateCarryRegime({ ...base, apr90d: 6, excessOverTBill: 2, excessOverHurdle: -1.5 }).regimeCode, 'MARGINAL_CARRY');
    assert.equal(evaluateCarryRegime({ ...base, apr90d: 3.5, excessOverTBill: -0.5, excessOverHurdle: -4 }).regimeCode, 'SUB_TBILL_DRAIN');
    assert.equal(evaluateCarryRegime({ ...base, apr90d: 0.5, cqApr: -1, excessOverTBill: -3.5, excessOverHurdle: -7 }).regimeCode, 'CRISIS_COMPRESSION');
    assert.equal(evaluateCarryRegime({ ...base, fundingApr: 25, apr90d: 12, spreadTerm: -13, excessOverTBill: 8, excessOverHurdle: 4.5 }).regimeCode, 'OVERCROWDED_INVERSION');
  });

  test('etfCarryMetrics nets T-Bill, sponsor fee and amortized round-trip cost', () => {
    const m = etfCarryMetrics({ apr90d: 6, tbill: 4 });
    // cost = 0.25 + 0.25 × 365/90 = 1.264
    assert.equal(m.etfCostAnnualized, 1.26);
    assert.equal(m.etfNetCarry, 0.74);
    assert.equal(m.etfArbitrageStatus, 'COVERED');
    assert.equal(etfCarryMetrics({ apr90d: 5, tbill: 4 }).etfArbitrageStatus, 'UNWIND_RISK');
  });

  test('analyzeTermPremium (history only) returns real-tenor payload', async () => {
    const result = await analyzeTermPremium([], 0, { live: false });
    assert.equal(result.metadata.isRealHistorical, true);
    assert.ok(result.metadata.dataSource.includes('Deribit'));
    assert.ok(result.series.length >= 900);
    const c = result.current;
    for (const k of ['fundingApr', 'nqApr', 'apr90d', 'tbill', 'carryScore', 'carrySharpe', 'etfNetCarry']) {
      assert.ok(typeof c[k] === 'number', `current.${k}`);
    }
    assert.ok(c.scoreComponents && typeof c.scoreComponents.sharpe === 'number');
    assert.equal(result.tBillRate, c.tbill);
    assert.equal(result.hurdleRate, c.hurdle);
    assert.ok(result.regime.regimeCode);
  });
});

describe('Phase 2-B: ETF × Carry Linkage Statistics', () => {
  const { simpleRegression, ols, pearson, buildWeeklyPanel, analyzeLinkage } = require('../server/etf_linkage_engine');

  test('simpleRegression and ols recover known coefficients', () => {
    const xs = Array.from({ length: 50 }, (_, i) => i - 25);
    const ys = xs.map(x => 3 + 0.5 * x);
    const r = simpleRegression(xs, ys);
    assert.equal(r.beta, 0.5);
    assert.equal(r.alpha, 3);
    assert.equal(r.r2, 1);

    const X = xs.map((x, i) => [x, (i % 7) - 3]);
    const y = X.map(([a, b]) => 1 + 2 * a - 1.5 * b + ((a * 7919) % 3) * 0.01);
    const fit = ols(X, y);
    assert.ok(Math.abs(fit.coef[1] - 2) < 0.01 && Math.abs(fit.coef[2] + 1.5) < 0.01);
    assert.equal(pearson([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]).r, 1);
  });

  test('buildWeeklyPanel aggregates (prev Tue, Tue] and matches arbitrage flow', () => {
    const cot = [
      { date: '2026-09-01', lfNetShortBtc: 1000, amNetLongBtc: 0, oiBtc: 5000 },
      { date: '2026-09-08', lfNetShortBtc: 1600, amNetLongBtc: 50, oiBtc: 5400 }
    ];
    const etfFlows = [
      { date: '2026-09-01', flowBtc: 999, flowUsd: 1 },   // belongs to the previous week
      { date: '2026-09-02', flowBtc: 500, flowUsd: 50 },
      { date: '2026-09-08', flowBtc: 500, flowUsd: 50 }
    ];
    const basisSeries = [
      { date: '2026-09-03', excessOverTBill: 1, apr90d: 5, btcPrice: 80000 },
      { date: '2026-09-08', excessOverTBill: 3, apr90d: 7, btcPrice: 81000 }
    ];
    const [w] = buildWeeklyPanel({ etfFlows, cot, oiPanel: [], basisSeries });
    assert.equal(w.etfFlowBtc, 1000);
    assert.equal(w.etfDays, 2);
    assert.equal(w.dLfNetShortBtc, 600);
    assert.equal(w.arbMatchedBtc, 600);
    assert.equal(w.directionalBtc, 400);
    assert.equal(w.excessOverTBill, 2);
    assert.equal(w.btcPrice, 81000);
  });

  test('analyzeLinkage flags a hedged-flow regime and quantifies the hedge ratio', () => {
    const weeks = Array.from({ length: 60 }, (_, i) => {
      const flow = ((i * 37) % 21 - 10) * 1000;
      const carry = i % 10 < 3 ? -1 : 3;
      // Shorts track 60% of flows, plus noise
      const dLf = 0.6 * flow + (((i * 53) % 7) - 3) * 100;
      return {
        weekEnd: `2025-${String(1 + Math.floor(i / 5)).padStart(2, '0')}-${String(1 + (i % 5) * 5).padStart(2, '0')}`,
        etfFlowBtc: flow,
        etfFlowUsd: flow * 80000,
        dLfNetShortBtc: dLf,
        excessOverTBill: carry,
        arbMatchedBtc: flow > 0 && dLf > 0 ? Math.min(flow, dLf) : (flow < 0 && dLf < 0 ? Math.max(flow, dLf) : 0),
        directionalBtc: 0
      };
    });
    const out = analyzeLinkage(weeks);
    assert.ok(Math.abs(out.hedgeRatio.full.beta - 0.6) < 0.02, `beta ${out.hedgeRatio.full.beta}`);
    assert.ok(out.hedgeRatio.full.tBeta > 10);
    assert.equal(out.hedgeRatio.rolling.length, weeks.length);
    assert.equal(out.leadLag.length, 9);
    assert.ok(out.unwindEpisodes.length >= 1);
    const check = out.verdict.checks.find(c => c.key === 'hedgeRatio');
    assert.equal(check.pass, true);
    assert.ok(['STRONG', 'MODERATE', 'WEAK'].includes(out.verdict.level));
  });
});

describe('Phase 2: ECDF Mid-Rank Percentile & Order Book Walk', () => {
  const { calcPercentile, walkOrderBook } = require('../server/coinbase_fetcher');

  test('calcPercentile handles empty or invalid array gracefully', () => {
    assert.equal(calcPercentile([], 100), 50.0);
    assert.equal(calcPercentile(null, 100), 50.0);
  });

  test('calcPercentile calculates exact mid-rank ECDF percentiles', () => {
    const sample = [10, 20, 30];
    // val = 10: below=0, equal=1 => (0 + 0.5) / 3 * 100 = 16.666... => 16.7%
    assert.equal(calcPercentile(sample, 10), 16.7);
    // val = 20: below=1, equal=1 => (1 + 0.5) / 3 * 100 = 50.0%
    assert.equal(calcPercentile(sample, 20), 50.0);
    // val = 30: below=2, equal=1 => (2 + 0.5) / 3 * 100 = 83.3%
    assert.equal(calcPercentile(sample, 30), 83.3);
    // val = 40: below=3, equal=0 => (3 + 0) / 3 * 100 = 100.0%
    assert.equal(calcPercentile(sample, 40), 100.0);
    // val = 5: below=0, equal=0 => 0.0%
    assert.equal(calcPercentile(sample, 5), 0.0);
  });

  test('calcPercentile eliminates boundary tie bias with mid-rank weighting', () => {
    const tiedSample = [100, 100, 100, 100];
    // below=0, equal=4 => (0 + 0.5 * 4) / 4 * 100 = 50.0%
    assert.equal(calcPercentile(tiedSample, 100), 50.0);
  });

  test('walkOrderBook calculates accurate market order execution and slippage', () => {
    const orderBook = [
      ['70000', '1.0'],
      ['70500', '2.0'],
      ['71000', '5.0']
    ];

    const res1 = walkOrderBook(orderBook, 70000);
    assert.equal(res1.filledUsd, 70000);
    assert.equal(res1.filledQty, 1.0);
    assert.equal(res1.avgPrice, 70000);
    assert.equal(res1.worstPrice, 70000);

    const res2 = walkOrderBook(orderBook, 140500);
    assert.equal(res2.filledUsd, 140500);
    assert.equal(res2.filledQty, 2.0);
    assert.equal(res2.avgPrice, 70250);
    assert.equal(res2.worstPrice, 70500);
  });

  test('processCoinbaseData uses true rolling 24h volume and excludes uncompleted candle', () => {
    const { processCoinbaseData } = require('../server/coinbase_fetcher');
    const mockBook = {
      bids: [['80000', '10.0'], ['79900', '20.0'], ['79500', '50.0'], ['79000', '100.0']],
      asks: [['80010', '10.0'], ['80100', '20.0'], ['80500', '50.0'], ['81000', '100.0']]
    };
    // 35 candles: index 0 is today's incomplete candle (small volume: 500 BTC)
    // index 1..34 are completed days (volume ~ 10,000 BTC)
    const mockCandles = [];
    mockCandles.push([Date.now() / 1000, 79000, 81000, 79500, 80000, 500]); // in-progress
    for (let i = 1; i <= 34; i++) {
      mockCandles.push([Date.now() / 1000 - i * 86400, 75000, 82000, 76000, 80000, 10000 + i * 10]);
    }

    const mockStats = {
      ticker: { price: '80005', volume: '10150' },
      stats: { volume: '10150' } // True rolling 24h volume
    };

    const result = processCoinbaseData(mockBook, mockCandles, mockStats);
    assert.ok(result.percentiles);
    assert.equal(result.percentiles.volume24hBtc, 10150, 'Must use rolling 24h volume from stats, NOT incomplete candle volume (500)');
    assert.ok(result.percentiles.volume24hPctl > 40, 'Volume percentile must be sensible (>40%), not collapsed to 0%');
  });

  test('processCoinbaseData accurately classifies FALSE_PROSPERITY vs SELL_WALL_PRESSURE', () => {
    const { processCoinbaseData } = require('../server/coinbase_fetcher');
    // Case 1: High price, very low volume, sell dominance, high pyramid ratio => FALSE_PROSPERITY
    const thinBook = {
      bids: [['80000', '0.5'], ['79000', '50.0']], // very thin near end, heavy far end => high pyramid ratio
      asks: [['80010', '5.0'], ['80100', '10.0'], ['80500', '20.0']]
    };
    const mockCandles = [];
    mockCandles.push([Date.now() / 1000, 79000, 81000, 79500, 80000, 100]);
    for (let i = 1; i <= 34; i++) {
      mockCandles.push([Date.now() / 1000 - i * 86400, 70000, 75000, 71000, 72000, 10000]);
    }
    const lowStats = { stats: { volume: '500' } }; // low volume 500 vs 10000 => pctl <= 25

    const rFalse = processCoinbaseData(thinBook, mockCandles, lowStats);
    assert.equal(rFalse.regime.code, 'FALSE_PROSPERITY');

    // Case 2: High price, active volume, heavy ask wall => SELL_WALL_PRESSURE
    const wallBook = {
      bids: [['80000', '2.0']],
      asks: [['80010', '20.0']] // ask dominant => bid10Pct < 46
    };
    const activeStats = { stats: { volume: '10000' } };
    const rWall = processCoinbaseData(wallBook, mockCandles, activeStats);
    assert.equal(rWall.regime.code, 'SELL_WALL_PRESSURE');
  });
});

describe('Module 7: Gold & Bitcoin Correlation & Ratio Engine', () => {
  const fs = require('fs');
  const path = require('path');
  const {
    calculatePearsonCorrelation,
    calculateRollingPearsonCorrelation,
    classifyCorrelationRegime,
    getGoldCorrelationData
  } = require('../server/gold_fetcher');

  test('calculatePearsonCorrelation computes mathematically exact correlations', () => {
    // 1. Perfect positive correlation (r = 1.0)
    const x1 = [1, 2, 3, 4, 5];
    const y1 = [2, 4, 6, 8, 10];
    assert.equal(calculatePearsonCorrelation(x1, y1), 1.0);

    // 2. Perfect negative correlation (r = -1.0)
    const x2 = [1, 2, 3, 4, 5];
    const y2 = [10, 8, 6, 4, 2];
    assert.equal(calculatePearsonCorrelation(x2, y2), -1.0);

    // 3. Flat / zero variance returns 0
    const x3 = [5, 5, 5, 5];
    const y3 = [1, 2, 3, 4];
    assert.equal(calculatePearsonCorrelation(x3, y3), 0);

    // 4. Invalid or mismatched array length returns 0
    assert.equal(calculatePearsonCorrelation([], []), 0);
    assert.equal(calculatePearsonCorrelation([1, 2], [1]), 0);
  });

  test('classifyCorrelationRegime accurately classifies all four market regimes', () => {
    const r1 = classifyCorrelationRegime(0.72, 18.5, 8.2);
    assert.equal(r1.regimeCode, 'DEBASEMENT_HEDGE');
    assert.equal(r1.badgeClass, 'badge-pos');

    const r2 = classifyCorrelationRegime(0.28, 18.5, 8.2);
    assert.equal(r2.regimeCode, 'MODERATE_LINKAGE');
    assert.equal(r2.badgeClass, 'badge-cyan');

    const r3 = classifyCorrelationRegime(-0.05, 18.5, 8.2);
    assert.equal(r3.regimeCode, 'DECOUPLED_REGIME');
    assert.equal(r3.badgeClass, 'badge-warning');

    const r4 = classifyCorrelationRegime(-0.45, 18.5, 8.2);
    assert.equal(r4.regimeCode, 'ASSET_ROTATION');
    assert.equal(r4.badgeClass, 'badge-neg');
  });

  test('fetchSpotDailyCloses falls through blocked venues and keeps both legs on one venue', async () => {
    const { fetchSpotDailyCloses } = require('../server/spot_daily');
    const day = Date.UTC(2026, 9, 1);
    const blocked = { name: 'Blocked', quote: 'USDT', daily: async () => { throw new Error('HTTP 418'); } };
    // Serves BTC but not PAXG: must be skipped so the ratio never mixes venues
    const partial = { name: 'Partial', quote: 'USDT', daily: async s => (s === 'BTC' ? [{ openTime: day, close: 80000 }] : []) };
    const good = {
      name: 'Good',
      quote: 'USD',
      daily: async s => [
        { openTime: day + 86400000, close: s === 'BTC' ? 81000 : 4100 },
        { openTime: day, close: s === 'BTC' ? 80000 : 4000 }
      ]
    };
    const out = await fetchSpotDailyCloses(['PAXG', 'BTC'], day, [blocked, partial, good]);
    assert.equal(out.venue, 'Good');
    assert.equal(out.quote, 'USD');
    assert.deepEqual(out.series.BTC.map(r => [r.date, r.close]), [['2026-10-01', 80000], ['2026-10-02', 81000]]);
    assert.equal(out.errors.length, 2);
    assert.match(out.errors[0], /Blocked: HTTP 418/);
    await assert.rejects(fetchSpotDailyCloses(['BTC'], day, [blocked]), /All spot venues failed/);
  });

  test('Verified real Gold & BTC historical dataset exists and is clean', () => {
    const filePath = path.join(__dirname, '..', 'data', 'gold_correlation.json');
    assert.ok(fs.existsSync(filePath), 'data/gold_correlation.json must exist');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    assert.ok(data.metadata);
    assert.equal(data.metadata.isRealHistorical, true);
    // Venue depends on reachability (Binance → OKX → Coinbase), the instrument does not
    assert.ok(data.metadata.dataSource.includes('PAXG'));
    assert.ok(data.current);
    assert.ok(data.current.btcGoldRatio > 0);
    assert.ok(data.current.goldBtcRatio > 0);
    assert.ok(typeof data.current.rollingCorr30d === 'number');

    assert.ok(Array.isArray(data.series));
    assert.ok(data.series.length >= 500, `Must have >= 500 daily records, got ${data.series.length}`);

    // Verify chronological ordering and clean numbers
    for (let i = 0; i < data.series.length; i++) {
      const row = data.series[i];
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(row.date), `Row ${i} date format`);
      if (i > 0) {
        assert.ok(row.date >= data.series[i - 1].date, `Row ${i} date ascending`);
      }
      assert.ok(typeof row.btcPrice === 'number' && !isNaN(row.btcPrice));
      assert.ok(typeof row.goldPrice === 'number' && !isNaN(row.goldPrice));
      assert.ok(typeof row.btcGoldRatio === 'number' && !isNaN(row.btcGoldRatio));
      assert.ok(typeof row.goldBtcRatio === 'number' && !isNaN(row.goldBtcRatio));
      assert.ok(typeof row.marketCapShare === 'number' && !isNaN(row.marketCapShare));
    }
  });

  test('GET /api/gold-correlation returns 200 and complete payload', async () => {
    const { server } = require('../server/index');
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', async () => {
        const port = server.address().port;
        try {
          const resp = await fetch(`http://127.0.0.1:${port}/api/gold-correlation`);
          assert.equal(resp.status, 200);
          const json = await resp.json();
          assert.equal(json.code, 0);
          assert.ok(json.current);
          assert.ok(json.regime);
          assert.ok(json.series.length >= 500);
          assert.ok(json.metadata);
        } finally {
          server.close(resolve);
        }
      });
    });
  });
});


describe('Module 1-B: Crypto McClellan Oscillator (Core Top 100 vs On-chain Meme)', () => {
  const { getMcClellanData, validateMcClellanData } = require('../server/crypto_mcclellan_fetcher');

  test('Ratio-adjusted McClellan: RAMO bounds, EMA19 - EMA39 and running summation', () => {
    const ramo = (adv, dec) => (adv + dec > 0 ? (adv - dec) / (adv + dec) * 1000 : 0);
    assert.equal(ramo(60, 0), 1000);
    assert.equal(ramo(0, 60), -1000);
    assert.equal(ramo(75, 25), 500);

    const ema = (vals, span) => {
      const k = 2 / (span + 1);
      let prev = null;
      return vals.map(v => (prev = prev === null ? v : k * v + (1 - k) * prev));
    };
    const series = [...Array(20).fill(400), ...Array(30).fill(-400)];
    const fast = ema(series, 19);
    const slow = ema(series, 39);
    const osc = fast.map((f, i) => f - slow[i]);
    assert.ok(Math.abs(osc[19]) < 1e-9, 'constant input keeps fast == slow');
    assert.ok(osc[30] < 0, 'oscillator turns negative after breadth flips');
  });

  test('validateMcClellanData rejects payloads without both tracks', () => {
    assert.throws(() => validateMcClellanData({ metadata: {}, current: { core: { oscillator: 1 } }, series: [] }));
    assert.ok(validateMcClellanData({
      metadata: {}, current: { core: { oscillator: 1.5 }, frontier: { ready: false } }, series: []
    }));
  });

  test('getMcClellanData loads the dual-track payload with a year of Core history', async () => {
    const data = await getMcClellanData(false);
    assert.ok(data, 'data must exist');

    assert.equal(data.metadata.parameters.ema_fast, 19);
    assert.equal(data.metadata.parameters.ema_slow, 39);
    assert.equal(data.metadata.parameters.ratio_scale, 1000);
    assert.equal(data.metadata.core.top_n, 100);
    assert.deepEqual(data.metadata.frontier.chains, ['solana', 'bsc', 'robinhood']);

    const { core, frontier } = data.current;
    assert.ok(core.ready, 'Core track must be published');
    assert.ok(typeof core.oscillator === 'number');
    assert.ok(typeof core.summation === 'number');
    assert.ok(core.constituents >= 80 && core.constituents <= 100, `Core constituents ${core.constituents}`);
    assert.ok(typeof frontier.ready === 'boolean');
    assert.ok(typeof frontier.breadth_days === 'number');

    assert.ok(Array.isArray(data.series));
    assert.ok(data.series.length >= 300, `series length must be >= 300, got ${data.series.length}`);
    const last = data.series[data.series.length - 1];
    assert.ok(last.date);
    assert.ok(typeof last.btc_close === 'number');
    assert.ok(typeof last.core_oscillator === 'number');
    assert.ok(typeof last.core_summation === 'number');
    assert.ok(last.core_adv + last.core_dec <= last.core_n);
    // Frontier readings stay null until the EMA warm-up completes
    if (!frontier.ready) assert.equal(last.frontier_oscillator, null);

    assert.ok(data.refresh_status, 'refresh_status must exist');
    assert.ok(['refreshed', 'pipelineUnavailable', 'stale', 'cached'].includes(data.refresh_status.status));
  });

  test('HTTP Endpoint GET /api/crypto-mcclellan returns 200 with code 0 and ETag 304', async () => {
    const { server } = require('../server/index');
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', async () => {
        const port = server.address().port;
        try {
          const resp = await fetch(`http://127.0.0.1:${port}/api/crypto-mcclellan`);
          assert.equal(resp.status, 200);
          const json = await resp.json();
          assert.equal(json.code, 0);
          assert.ok(json.data);
          assert.ok(json.data.current.core);
          assert.ok(json.data.series.length >= 300);
          assert.ok(json.data.metadata.title.includes('麦克莱伦') || json.data.metadata.title.includes('McClellan'));

          // Verify ETag support on the endpoint
          const etag = resp.headers.get('etag');
          if (etag) {
            const cachedResp = await fetch(`http://127.0.0.1:${port}/api/crypto-mcclellan`, {
              headers: { 'if-none-match': etag }
            });
            assert.equal(cachedResp.status, 304);
          }
        } finally {
          server.close(resolve);
        }
      });
    });
  });
});

describe('System Audit & Data Provenance Verification Engine', () => {
  const { getSystemAuditData } = require('../server/audit_engine');

  test('getSystemAuditData returns complete registry of all 10 quantitative modules with provenance signatures', async () => {
    const audit = await getSystemAuditData(false);
    assert.equal(audit.code, 0);
    assert.ok(audit.serverTimeUTC);
    assert.ok(typeof audit.serverUptimeSeconds === 'number');
    assert.ok(['HEALTHY', 'DEGRADED'].includes(audit.overallHealth));
    assert.equal(audit.modulesCount, 10, 'Must register exactly 10 core modules');
    assert.ok(audit.onlineModulesCount >= 8, 'At least 8 modules must be online');

    const expectedModules = [
      'macro_liquidity',
      'option_atm_iv',
      'term_premium_basis',
      'dynamic_gex',
      'whale_block_trades',
      'iv_smile_and_skew',
      'coinbase_orderbook_liquidity',
      'gold_btc_correlation',
      'ssro_oscillator',
      'crypto_mcclellan_breadth'
    ];

    for (const modId of expectedModules) {
      const mod = audit.modules[modId];
      assert.ok(mod, `Module ${modId} must exist in audit report`);
      assert.ok(mod.name, `${modId} must have human-readable name`);
      assert.ok(mod.primarySource, `${modId} must specify official primary source`);
      assert.ok(Array.isArray(mod.targetEndpoints) && mod.targetEndpoints.length > 0, `${modId} targetEndpoints`);
      assert.ok(mod.timeframe, `${modId} timeframe description`);
      assert.ok(mod.updateInterval, `${modId} updateInterval`);
      // The breadth oscillator is computed once per UTC close, not streamed
      assert.equal(mod.isRealtime, modId !== 'crypto_mcclellan_breadth', `${modId} isRealtime`);
      assert.ok(Array.isArray(mod.provenanceSignatures) && mod.provenanceSignatures.length > 0, `${modId} provenanceSignatures`);
      assert.ok(['ONLINE', 'INITIALIZING'].includes(mod.healthStatus), `${modId} healthStatus`);
    }

    // Specific financial & provenance integrity checks
    assert.ok(audit.modules.macro_liquidity.recordCount >= 2000, 'Macro points count');
    assert.ok(audit.modules.macro_liquidity.mstrPurchasesCount >= 100, 'MSTR official purchases count');
    assert.ok(audit.modules.term_premium_basis.provenanceSignatures.includes('REAL_TENOR_CURVE_FUNDING_CQ_NQ'));
    assert.ok(audit.modules.term_premium_basis.provenanceSignatures.includes('ETF_CME_HEDGE_RATIO_REGRESSION'));
    assert.ok(audit.modules.gold_btc_correlation.recordCount >= 1000, 'Gold PAXG 1000 daily points');
    assert.ok(audit.modules.ssro_oscillator.recordCount >= 2000, 'DefiLlama & BTC joined series 2000+ points');
  });

  test('HTTP Endpoint GET /api/system/audit returns 200 with code 0 and ETag 304', async () => {
    const { server } = require('../server/index');
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', async () => {
        const port = server.address().port;
        try {
          const resp = await fetch(`http://127.0.0.1:${port}/api/system/audit`);
          assert.equal(resp.status, 200);
          const json = await resp.json();
          assert.equal(json.code, 0);
          assert.equal(json.modulesCount, 10);
          assert.ok(json.modules.macro_liquidity);
          assert.ok(json.modules.coinbase_orderbook_liquidity);

          // Test ETag
          const etag = resp.headers.get('etag');
          if (etag) {
            const cachedResp = await fetch(`http://127.0.0.1:${port}/api/system/audit`, {
              headers: { 'if-none-match': etag }
            });
            // If no async fetch updated dataVersion during this millisecond, status is 304; if dataVersion incremented, status is 200
            assert.ok(cachedResp.status === 304 || cachedResp.status === 200);
          }
        } finally {
          server.close(resolve);
        }
      });
    });
  });
});

describe('Module 3: Deribit Section 12 Advanced Multi-Leg Strategy Suite', () => {
  const S = 77000;

  test('Accurately identifies 4-Leg Iron Condor with defined risk and inverse profile', () => {
    // Buy Put 70k, Sell Put 72k, Sell Call 82k, Buy Call 85k
    const legs = [
      { instrument: 'BTC-26DEC26-70000-P', direction: 'buy', amount: 50, price: 0.02, strike: 70000, expiryStr: '26DEC26' },
      { instrument: 'BTC-26DEC26-72000-P', direction: 'sell', amount: 50, price: 0.035, strike: 72000, expiryStr: '26DEC26' },
      { instrument: 'BTC-26DEC26-82000-C', direction: 'sell', amount: 50, price: 0.04, strike: 82000, expiryStr: '26DEC26' },
      { instrument: 'BTC-26DEC26-85000-C', direction: 'buy', amount: 50, price: 0.022, strike: 85000, expiryStr: '26DEC26' }
    ];
    const res = identifyInstitutionalStrategy(legs, 0, -1500, 3200, 40000000);
    assert.equal(res.strategyType, 'IRON_CONDOR');
    assert.equal(res.strategyNameZh, '经典铁鹰策略 (Iron Condor / 4-Leg Strangle Credit)');
    assert.equal(res.intentBadgeClass, 'badge-vol-sell');
    assert.ok(res.riskProfile.inverseCurvature.includes('Deribit 反向合约'));
    assert.ok(res.theoreticalPointers.some(p => p.includes('Fully Defined Risk')));
  });

  test('Accurately identifies 4-Leg Iron Butterfly with ATM straddle short', () => {
    // Buy Put 72k, Sell Put 77k, Sell Call 77k, Buy Call 82k
    const legs = [
      { instrument: 'BTC-26DEC26-72000-P', direction: 'buy', amount: 30, price: 0.025, strike: 72000, expiryStr: '26DEC26' },
      { instrument: 'BTC-26DEC26-77000-P', direction: 'sell', amount: 30, price: 0.055, strike: 77000, expiryStr: '26DEC26' },
      { instrument: 'BTC-26DEC26-77000-C', direction: 'sell', amount: 30, price: 0.058, strike: 77000, expiryStr: '26DEC26' },
      { instrument: 'BTC-26DEC26-82000-C', direction: 'buy', amount: 30, price: 0.028, strike: 82000, expiryStr: '26DEC26' }
    ];
    const res = identifyInstitutionalStrategy(legs, 0, -2500, 4800, 35000000);
    assert.equal(res.strategyType, 'IRON_BUTTERFLY');
    assert.equal(res.strategyNameZh, '经典铁蝶策略 (Iron Butterfly / ATM Straddle Protection)');
    assert.ok(res.theoreticalPointers.some(p => p.includes('Pin Risk')));
  });

  test('Accurately identifies 1x2 Ratio Call Backspread (Lecture 12.11)', () => {
    // Sell 1 low Call @ 78k, Buy 2 high Calls @ 85k
    const legs = [
      { instrument: 'BTC-26DEC26-78000-C', direction: 'sell', amount: 100, price: 0.06, strike: 78000, expiryStr: '26DEC26' },
      { instrument: 'BTC-26DEC26-85000-C', direction: 'buy', amount: 200, price: 0.025, strike: 85000, expiryStr: '26DEC26' }
    ];
    const res = identifyInstitutionalStrategy(legs, 5000000, 3500, -2800, 50000000);
    assert.equal(res.strategyType, 'RATIO_CALL_BACKSPREAD');
    assert.equal(res.strategyNameZh, '看涨反比例价差 (1x2 Call Backspread)');
    assert.equal(res.intentBadgeClass, 'badge-vol-buy');
    assert.ok(res.riskProfile.inverseCurvature.includes('1.0 BTC'));
    assert.ok(res.theoreticalPointers.some(p => p.includes('Long Volatility & Gamma')));
  });

  test('Accurately identifies 1x2 Ratio Call Front Spread (Lecture 12.11)', () => {
    // Buy 1 low Call @ 78k, Sell 2 high Calls @ 85k
    const legs = [
      { instrument: 'BTC-26DEC26-78000-C', direction: 'buy', amount: 100, price: 0.06, strike: 78000, expiryStr: '26DEC26' },
      { instrument: 'BTC-26DEC26-85000-C', direction: 'sell', amount: 200, price: 0.025, strike: 85000, expiryStr: '26DEC26' }
    ];
    const res = identifyInstitutionalStrategy(legs, -2000000, -3500, 2800, 50000000);
    assert.equal(res.strategyType, 'RATIO_CALL_FRONT_SPREAD');
    assert.equal(res.strategyNameZh, '看涨正比例价差 (1x2 Call Front Spread)');
    assert.equal(res.intentBadgeClass, 'badge-vol-sell');
    assert.ok(res.theoreticalPointers.some(p => p.includes('收割偏度溢价')));
  });

  test('Accurately identifies 1x2 Ratio Put Backspread (Lecture 12.12)', () => {
    // Buy 2 low Puts @ 68k, Sell 1 high Put @ 75k
    const legs = [
      { instrument: 'BTC-26DEC26-68000-P', direction: 'buy', amount: 200, price: 0.02, strike: 68000, expiryStr: '26DEC26' },
      { instrument: 'BTC-26DEC26-75000-P', direction: 'sell', amount: 100, price: 0.05, strike: 75000, expiryStr: '26DEC26' }
    ];
    const res = identifyInstitutionalStrategy(legs, -5000000, 3000, -2200, 45000000);
    assert.equal(res.strategyType, 'RATIO_PUT_BACKSPREAD');
    assert.equal(res.strategyNameZh, '看跌反比例价差 (1x2 Put Backspread)');
    assert.equal(res.intentBadgeClass, 'badge-vol-buy');
  });

  test('Accurately identifies Symmetric Put Butterfly and Broken Wing Butterfly (Lecture 12.14)', () => {
    // Symmetric Put Butterfly: Buy 1 @ 70k, Sell 2 @ 75k, Buy 1 @ 80k
    const putFlyLegs = [
      { instrument: 'BTC-26DEC26-70000-P', direction: 'buy', amount: 50, price: 0.015, strike: 70000, expiryStr: '26DEC26' },
      { instrument: 'BTC-26DEC26-75000-P', direction: 'sell', amount: 100, price: 0.04, strike: 75000, expiryStr: '26DEC26' },
      { instrument: 'BTC-26DEC26-80000-P', direction: 'buy', amount: 50, price: 0.08, strike: 80000, expiryStr: '26DEC26' }
    ];
    const resSymm = identifyInstitutionalStrategy(putFlyLegs, 0, -800, 1500, 30000000);
    assert.equal(resSymm.strategyType, 'LONG_PUT_BUTTERFLY');
    assert.equal(resSymm.strategyNameZh, '对称多头看跌蝶式 (Long Put Butterfly 1-2-1)');

    // Broken Wing Butterfly: Buy 1 @ 70k, Sell 2 @ 75k, Buy 1 @ 85k (d1=5k != d2=10k)
    const bwbLegs = [
      { instrument: 'BTC-26DEC26-70000-C', direction: 'buy', amount: 50, price: 0.12, strike: 70000, expiryStr: '26DEC26' },
      { instrument: 'BTC-26DEC26-75000-C', direction: 'sell', amount: 100, price: 0.08, strike: 75000, expiryStr: '26DEC26' },
      { instrument: 'BTC-26DEC26-85000-C', direction: 'buy', amount: 50, price: 0.03, strike: 85000, expiryStr: '26DEC26' }
    ];
    const resBwb = identifyInstitutionalStrategy(bwbLegs, 1000000, -400, 900, 32000000);
    assert.equal(resBwb.strategyType, 'BROKEN_WING_BUTTERFLY');
    assert.equal(resBwb.strategyNameZh, '折翅非对称蝶式 (Broken Wing Butterfly / Skip Strike)');
  });

  test('Accurately identifies Synthetic Long & Short Future (Lecture 12.16)', () => {
    // Synthetic Long: Buy Call 77k + Sell Put 77k
    const synthLongLegs = [
      { instrument: 'BTC-26DEC26-77000-C', direction: 'buy', amount: 200, price: 0.06, strike: 77000, expiryStr: '26DEC26' },
      { instrument: 'BTC-26DEC26-77000-P', direction: 'sell', amount: 200, price: 0.055, strike: 77000, expiryStr: '26DEC26' }
    ];
    const resLong = identifyInstitutionalStrategy(synthLongLegs, 15400000, 0, 0, 30800000);
    assert.equal(resLong.strategyType, 'SYNTHETIC_LONG_FUTURE');
    assert.equal(resLong.strategyNameZh, '合成标的多头 (Synthetic Long Future / Parity Replication)');
    assert.ok(resLong.theoreticalPointers.some(p => p.includes('Put-Call Parity')));

    // Synthetic Short: Sell Call 77k + Buy Put 77k
    const synthShortLegs = [
      { instrument: 'BTC-26DEC26-77000-C', direction: 'sell', amount: 200, price: 0.06, strike: 77000, expiryStr: '26DEC26' },
      { instrument: 'BTC-26DEC26-77000-P', direction: 'buy', amount: 200, price: 0.055, strike: 77000, expiryStr: '26DEC26' }
    ];
    const resShort = identifyInstitutionalStrategy(synthShortLegs, -15400000, 0, 0, 30800000);
    assert.equal(resShort.strategyType, 'SYNTHETIC_SHORT_FUTURE');
    assert.equal(resShort.strategyNameZh, '合成标的空头 (Synthetic Short Future)');
  });

  test('Injects Module 4 Smile / Skew Alignment insight when smileContext provided', () => {
    const legs = [
      { instrument: 'BTC-26DEC26-72000-P', direction: 'sell', amount: 100, price: 0.03, strike: 72000, expiryStr: '26DEC26' },
      { instrument: 'BTC-26DEC26-85000-C', direction: 'buy', amount: 100, price: 0.03, strike: 85000, expiryStr: '26DEC26' }
    ];
    const smileContext = { skew25d: -3.8 };
    const res = identifyInstitutionalStrategy(legs, 8000000, 1000, -500, 40000000, smileContext);
    assert.ok(res.smileAlphaRating);
    assert.ok(res.smileAlphaRating.rating.includes('偏度套利高效'));
    assert.ok(res.smileAlphaRating.comment.includes('Put 相对 Call 显著高估'));
  });
});

describe('Module 4: 大宗交易开平仓推断与末日 0DTE 行为分类引擎', () => {
  const { parseDeribitExpiry } = require('../server/analytics_engine');

  describe('evaluate0DTEBehavior (末日期权行为诊断)', () => {
    test('Non-0DTE: 远期到期合约正确归类为 NORMAL_TERM', () => {
      const expTs = parseDeribitExpiry('26DEC26').getTime();
      const trade = {
        instrument_name: 'BTC-26DEC26-80000-C',
        timestamp: expTs - 48 * 3600 * 1000, // 48 hours to expiry
        direction: 'buy',
        price: 0.05
      };
      const res = evaluate0DTEBehavior(trade, 77000);
      assert.equal(res.is0DTE, false);
      assert.equal(res.hoursToExpiry, 48);
      assert.equal(res.timingCategory, 'NORMAL_TERM');
      assert.equal(res.tag, '远期/常规期权');
      assert.ok(res.rationale.includes('48 小时'));
    });

    test('0DTE Pin Risk Avoidance: 距交割 <= 4h 且现货紧贴行权价 (<=1.5%) 判定为钉盘避险', () => {
      const expTs = parseDeribitExpiry('25SEP26').getTime();
      const trade = {
        instrument_name: 'BTC-25SEP26-77000-C',
        timestamp: expTs - 2.5 * 3600 * 1000, // 2.5 hours to expiry
        direction: 'buy',
        price: 0.008,
        strike: 77000
      };
      const res = evaluate0DTEBehavior(trade, 77200); // dist = 0.26%
      assert.equal(res.is0DTE, true);
      assert.equal(res.hoursToExpiry, 2.5);
      assert.equal(res.timingCategory, '0DTE_PIN_RISK');
      assert.equal(res.tag, '末日钉盘避险');
      assert.equal(res.badgeClass, 'badge-0dte-danger');
      assert.ok(res.rationale.includes('Gamma 钉盘'));
    });

    test('0DTE Lotto Hunting: 距交割 <= 16h 且虚值 1.5%~6.5% 且极低单价买入判定为末日彩票', () => {
      const expTs = parseDeribitExpiry('25SEP26').getTime();
      const trade = {
        instrument_name: 'BTC-25SEP26-80000-C',
        timestamp: expTs - 6 * 3600 * 1000, // 6 hours to expiry
        direction: 'buy',
        price: 0.0012, // cheap ~0.0012 BTC ($90)
        strike: 80000
      };
      const res = evaluate0DTEBehavior(trade, 77000); // dist = 3.9%
      assert.equal(res.is0DTE, true);
      assert.equal(res.hoursToExpiry, 6);
      assert.equal(res.timingCategory, '0DTE_LOTTO');
      assert.equal(res.tag, '末日彩票博弈');
      assert.equal(res.badgeClass, 'badge-0dte-lotto');
      assert.ok(res.rationale.includes('百倍凸性赔率'));
    });

    test('0DTE Penny Scraping: 距交割 <= 16h 且深度虚值 >= 5% 且卖出判定为残值收割', () => {
      const expTs = parseDeribitExpiry('25SEP26').getTime();
      const trade = {
        instrument_name: 'BTC-25SEP26-70000-P',
        timestamp: expTs - 5 * 3600 * 1000, // 5 hours to expiry
        direction: 'sell',
        price: 0.0006, // $46 USD
        strike: 70000
      };
      const res = evaluate0DTEBehavior(trade, 77000); // dist = 9.1%
      assert.equal(res.is0DTE, true);
      assert.equal(res.hoursToExpiry, 5);
      assert.equal(res.timingCategory, '0DTE_PENNY');
      assert.equal(res.tag, '末日残值收割');
      assert.equal(res.badgeClass, 'badge-0dte-scraping');
      assert.ok(res.rationale.includes('权利金残值'));
    });

    test('0DTE Directional Momentum: 距交割 <= 16h 且平值买入判定为单边冲刺', () => {
      const expTs = parseDeribitExpiry('25SEP26').getTime();
      const trade = {
        instrument_name: 'BTC-25SEP26-77000-C',
        timestamp: expTs - 8 * 3600 * 1000, // 8 hours to expiry
        direction: 'buy',
        price: 0.012,
        strike: 77000
      };
      const res = evaluate0DTEBehavior(trade, 77100); // dist = 0.13%
      assert.equal(res.is0DTE, true);
      assert.equal(res.hoursToExpiry, 8);
      assert.equal(res.timingCategory, '0DTE_MOMENTUM');
      assert.equal(res.tag, '末日单边冲刺');
      assert.equal(res.badgeClass, 'badge-0dte-momentum');
      assert.ok(res.rationale.includes('替代现货'));
    });
  });

  describe('evaluateTradeAction (大宗交易开平仓推断)', () => {
    test('Rollover: 跨期限一买一卖组合精准判定为跨期展期 (CALENDAR_ROLLOVER)', () => {
      const group = {
        legs: [
          { instrument_name: 'BTC-25SEP26-80000-C', direction: 'sell', amount: 50, price: 0.02 },
          { instrument_name: 'BTC-26DEC26-80000-C', direction: 'buy', amount: 50, price: 0.06 }
        ],
        strategyType: 'LONG_CALENDAR_SPREAD'
      };
      const res = evaluateTradeAction(group, 77000);
      assert.equal(res.action, 'ROLLOVER');
      assert.equal(res.actionType, 'CALENDAR_ROLLOVER');
      assert.equal(res.confidence, 'HIGH');
      assert.equal(res.badgeClass, 'badge-action-roll');
      assert.ok(res.rationale.includes('跨期滚动展期'));
    });

    test('Strategy Entry: 经典闭合式多腿策略包精准判定为全新结构建仓 (STRATEGY_ENTRY)', () => {
      const group = {
        legs: [
          { instrument_name: 'BTC-26DEC26-75000-C', direction: 'buy', amount: 100, price: 0.08 },
          { instrument_name: 'BTC-26DEC26-85000-C', direction: 'sell', amount: 100, price: 0.03 }
        ],
        strategyType: 'BULL_CALL_SPREAD',
        strategyNameZh: '牛市看涨价差 (Bull Call Spread)'
      };
      const res = evaluateTradeAction(group, 77000);
      assert.equal(res.action, 'OPENING');
      assert.equal(res.actionType, 'STRATEGY_ENTRY');
      assert.equal(res.confidence, 'HIGH');
      assert.equal(res.badgeClass, 'badge-action-open');
      assert.ok(res.rationale.includes('全新结构建仓'));
    });

    test('Aggressive Open: 主动买入且 IV 显著溢价 (IV - Mark IV >= 1.2) 判定为溢价抢筹开仓', () => {
      const trade = {
        instrument_name: 'BTC-26DEC26-80000-C',
        direction: 'buy',
        iv: 58.5,
        mark_iv: 55.0, // +3.5% IV premium
        price: 0.06
      };
      const res = evaluateTradeAction(trade, 77000);
      assert.equal(res.action, 'OPENING');
      assert.equal(res.actionType, 'AGGRESSIVE_OPEN');
      assert.equal(res.confidence, 'MEDIUM_HIGH');
      assert.equal(res.badgeClass, 'badge-action-open');
      assert.ok(res.rationale.includes('溢价迅速扫盘买入'));
    });

    test('Discounted Close: 主动卖出且 IV 显著贴水 (IV - Mark IV <= -1.2) 判定为让利平仓离场', () => {
      const trade = {
        instrument_name: 'BTC-26DEC26-80000-C',
        direction: 'sell',
        iv: 51.5,
        mark_iv: 55.0, // -3.5% IV discount
        price: 0.04
      };
      const res = evaluateTradeAction(trade, 77000);
      assert.equal(res.action, 'CLOSING');
      assert.equal(res.actionType, 'DISCOUNTED_CLOSE');
      assert.equal(res.confidence, 'MEDIUM_HIGH');
      assert.equal(res.badgeClass, 'badge-action-close');
      assert.ok(res.rationale.includes('贴水让利挂单出脱'));
    });

    test('Pin Risk Close: 0DTE 钉盘高危窗口自动联动为钉盘避险平仓', () => {
      const expTs = parseDeribitExpiry('25SEP26').getTime();
      const trade = {
        instrument_name: 'BTC-25SEP26-77000-C',
        timestamp: expTs - 2 * 3600 * 1000, // 2 hours to expiry
        direction: 'buy',
        strike: 77000,
        price: 0.008
      };
      const res = evaluateTradeAction(trade, 77100);
      assert.equal(res.action, 'CLOSING');
      assert.equal(res.actionType, 'PIN_RISK_CLOSE');
      assert.equal(res.confidence, 'HIGH');
      assert.equal(res.badgeClass, 'badge-action-close');
    });

    test('Neutral Flow: 微观偏离极小且非标准组合判定为中性撮合 (需OI确认)', () => {
      const trade = {
        instrument_name: 'BTC-26DEC26-80000-C',
        direction: 'buy',
        iv: 55.2,
        mark_iv: 55.0, // +0.2% IV
        price: 0.05
      };
      const res = evaluateTradeAction(trade, 77000);
      assert.equal(res.action, 'UNCONFIRMED');
      assert.equal(res.actionType, 'NEUTRAL_FLOW');
      assert.equal(res.confidence, 'LOW');
      assert.equal(res.badgeClass, 'badge-action-neutral');
    });
  });

  describe('analyzeBlockTrades 完整端到端集成检验', () => {
    test('whaleBlocks 与 icebergClusters 完整挂载 actionProfile 与 timingProfile 字段', () => {
      const expTs = parseDeribitExpiry('25SEP26').getTime();
      const trades = [
        // Whale block: aggressive buy
        {
          trade_id: 'wb-1',
          block_trade_id: 'block-open-1',
          instrument_name: 'BTC-26DEC26-80000-C',
          direction: 'buy',
          amount: 500,
          price: 0.08,
          iv: 62.0,
          mark_iv: 58.0,
          index_price: 77500,
          timestamp: expTs - 100 * 3600 * 1000
        },
        // 0DTE Pin Risk Whale block
        {
          trade_id: 'wb-2',
          block_trade_id: 'block-0dte-pin',
          instrument_name: 'BTC-25SEP26-77500-C',
          direction: 'buy',
          amount: 450,
          price: 0.006,
          iv: 75.0,
          mark_iv: 75.0,
          index_price: 77550,
          timestamp: expTs - 2 * 3600 * 1000 // 2h before expiry, ATM
        }
      ];

      const result = analyzeBlockTrades(trades, 30000000, 'all', 77500);
      assert.ok(result.whaleBlocks.length >= 2);

      // Verify block 1
      const b1 = result.whaleBlocks.find(b => b.blockId === 'block-open-1');
      assert.ok(b1);
      assert.ok(b1.actionProfile);
      assert.equal(b1.actionProfile.action, 'OPENING');
      assert.equal(b1.is0DTE, false);
      assert.ok(b1.actionTag);
      assert.ok(b1.timingTag);

      // Verify block 2 (0DTE pin risk)
      const b2 = result.whaleBlocks.find(b => b.blockId === 'block-0dte-pin');
      assert.ok(b2);
      assert.ok(b2.timingProfile);
      assert.equal(b2.is0DTE, true);
      assert.equal(b2.timingProfile.timingCategory, '0DTE_PIN_RISK');
      assert.equal(b2.actionProfile.action, 'CLOSING');

      // Verify narrative paragraph integration
      assert.ok(result.paragraph.includes('规则推断'));
      assert.ok(result.paragraph.includes('全新建仓'));
      assert.ok(result.paragraph.includes('平仓离场'));

      // 聚集画像必须由数据推导，不得出现旧的硬编码结论句
      assert.ok(result.paragraph.includes('大资金名义额到期日集中于 12月26日交割（26DEC26）'),
        'paragraph should report the dominant expiry computed from trades');
      assert.ok(result.paragraph.includes('单腿买入看涨'),
        'paragraph should report the dominant strategy computed from trades');
      assert.ok(!result.paragraph.includes('较强防护信心'),
        'stale hardcoded conclusion sentence must be gone');
    });
  });
});

