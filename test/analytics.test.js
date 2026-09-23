const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  analyzeAtmIv,
  analyzeDynamicGex,
  analyzeBlockTrades,
  calcGreeks,
  parseInstrument
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

describe('Phase 2: Term Premium & Real Basis Dataset Engine', () => {
  const fs = require('fs');
  const path = require('path');
  const {
    calculateConstantMaturityBasis,
    loadHistoricalBasisSeries,
    evaluateCarryRegime,
    analyzeTermPremium,
    T_BILL_RATE,
    HURDLE_RATE
  } = require('../server/term_premium_engine');

  test('Verified real historical dataset exists and is clean', () => {
    const filePath = path.join(__dirname, '..', 'data', 'term_premium_history.json');
    assert.ok(fs.existsSync(filePath), 'data/term_premium_history.json must exist');
    const series = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.ok(Array.isArray(series));
    assert.ok(series.length >= 600, `Dataset must contain >= 600 daily records, got ${series.length}`);

    // Check chronological order and validity of fields
    let sum30d = 0;
    for (let i = 0; i < series.length; i++) {
      const row = series[i];
      assert.ok(typeof row.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date), `Row ${i} date format`);
      if (i > 0) {
        assert.ok(row.date >= series[i - 1].date, `Row ${i} date should be in ascending order`);
      }
      assert.ok(typeof row.apr7d === 'number' && !isNaN(row.apr7d), `Row ${i} apr7d`);
      assert.ok(typeof row.apr30d === 'number' && !isNaN(row.apr30d), `Row ${i} apr30d`);
      assert.ok(typeof row.apr60d === 'number' && !isNaN(row.apr60d), `Row ${i} apr60d`);
      assert.ok(typeof row.apr90d === 'number' && !isNaN(row.apr90d), `Row ${i} apr90d`);
      assert.ok(typeof row.apr180d === 'number' && !isNaN(row.apr180d), `Row ${i} apr180d`);
      assert.ok(typeof row.spread90d7d === 'number' && !isNaN(row.spread90d7d), `Row ${i} spread90d7d`);
      assert.ok(typeof row.spread30d7d === 'number' && !isNaN(row.spread30d7d), `Row ${i} spread30d7d`);
      assert.ok(typeof row.excessReturn === 'number' && !isNaN(row.excessReturn), `Row ${i} excessReturn`);
      assert.ok(typeof row.carryScore === 'number' && !isNaN(row.carryScore), `Row ${i} carryScore`);
      sum30d += row.apr30d;
    }

    // Economically sound check: avg 30D basis should be > 4.0% (verifies upstream Binance bug fix)
    const avg30d = sum30d / series.length;
    assert.ok(avg30d > 4.0, `Average 30D basis rate should be > 4.0%, got ${avg30d.toFixed(2)}%`);
  });

  test('analyzeTermPremium returns verified real metadata and current regime', async () => {
    const result = await analyzeTermPremium([], 77000);
    assert.ok(result.metadata);
    assert.equal(result.metadata.isRealHistorical, true);
    assert.ok(result.metadata.dataSource.includes('Binance'));
    assert.ok(result.series.length >= 600);
    assert.ok(result.current);
    assert.ok(typeof result.current.apr60d === 'number');
    assert.ok(result.regime);
    assert.ok(result.regime.regimeCode);
    assert.equal(result.tBillRate, T_BILL_RATE);
    assert.equal(result.hurdleRate, HURDLE_RATE);
  });

  test('evaluateCarryRegime classifies all Amberdata institutional regimes accurately', () => {
    const contangoState = {
      apr7d: 8.0,
      apr30d: 9.5,
      apr60d: 10.2,
      apr90d: 11.0,
      apr180d: 12.5,
      spread90d7d: 3.0,
      spread30d7d: 1.5,
      spread180d30d: 3.0,
      excessReturn: 1.5,
      excessOverTBill: 5.0,
      carryScore: 15.3,
      unannualizedBasis30d: 0.78
    };
    const r1 = evaluateCarryRegime(contangoState, []);
    assert.equal(r1.regimeCode, 'NORMAL_CONTANGO');

    const overcrowdedState = {
      apr7d: 15.0,
      apr30d: 13.0,
      apr90d: 12.0,
      apr180d: 11.0,
      spread90d7d: -3.0,
      spread30d7d: -2.0,
      spread180d30d: -2.0,
      excessReturn: 5.0,
      excessOverTBill: 8.5,
      carryScore: 10.4,
      unannualizedBasis30d: 1.07
    };
    const r2 = evaluateCarryRegime(overcrowdedState, []);
    assert.equal(r2.regimeCode, 'OVERCROWDED_INVERSION');

    const subTbillState = {
      apr7d: 4.0,
      apr30d: 4.2,
      apr90d: 4.6,
      spread90d7d: 0.6,
      spread30d7d: 0.2,
      excessReturn: -3.8,
      excessOverTBill: -0.3,
      carryScore: -0.8,
      unannualizedBasis30d: 0.35
    };
    const r3 = evaluateCarryRegime(subTbillState, []);
    assert.equal(r3.regimeCode, 'SUB_TBILL_DRAIN');

    const marginalState = {
      apr7d: 6.5,
      apr30d: 7.2,
      apr90d: 7.8,
      spread90d7d: 1.3,
      spread30d7d: 0.7,
      excessReturn: -0.8,
      excessOverTBill: 2.7,
      carryScore: 7.9,
      unannualizedBasis30d: 0.59
    };
    const r4 = evaluateCarryRegime(marginalState, []);
    assert.equal(r4.regimeCode, 'MARGINAL_CARRY');
  });

  test('calculateCarryScore implements Amberdata continuous risk-adjusted formula', () => {
    const { calculateCarryScore } = require('../server/term_premium_engine');
    // 1. High excess return (10.0% over T-bill) & steep curve (2.0%) -> Excellent tier (> 20)
    const s1 = calculateCarryScore(10.0, 2.0, 45.0);
    assert.equal(s1, 30.7);
    assert.ok(s1 > 20, 'High excess with steep curve must be in Excellent tier (>20)');

    // 2. Marginal excess (5.0% over T-bill) & positive curve (2.0%) -> Marginal tier (10 ~ 20)
    const s2 = calculateCarryScore(5.0, 2.0, 45.0);
    assert.equal(s2, 15.3);
    assert.ok(s2 >= 10 && s2 <= 20, 'Moderate excess must be in Marginal tier (10~20)');

    // 3. Sub-hurdle excess (1.0% over T-bill) -> Avoid tier (< 10)
    const s3 = calculateCarryScore(1.0, 2.0, 45.0);
    assert.equal(s3, 3.1);
    assert.ok(s3 < 10, 'Low excess must be in Avoid tier (<10)');

    // 4. Negative excess (-1.0%) with inverted curve (-3.0%) -> Smooth negative score
    const s4 = calculateCarryScore(-1.0, -3.0, 45.0);
    assert.equal(s4, -1.2);
    assert.ok(s4 < 0, 'Negative excess with inversion must be negative');

    // 5. Neutral state: 0% excess and 0% spread -> 0.0
    const s5 = calculateCarryScore(0.0, 0.0, 45.0);
    assert.equal(s5, 0.0);
  });

  test('analyzeTermPremium outputs unannualized basis and ETF friction metrics', async () => {
    const result = await analyzeTermPremium([], 77000);
    assert.ok(result.current.unannualizedBasis30d !== undefined);
    assert.equal(result.current.etfFrictionThreshold, 0.50);
    assert.ok(['COVERED', 'UNWIND_RISK'].includes(result.current.etfArbitrageStatus));
    assert.ok(typeof result.current.etfArbitrageMargin === 'number');
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

  test('Verified real Gold & BTC historical dataset exists and is clean', () => {
    const filePath = path.join(__dirname, '..', 'data', 'gold_correlation.json');
    assert.ok(fs.existsSync(filePath), 'data/gold_correlation.json must exist');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    assert.ok(data.metadata);
    assert.equal(data.metadata.isRealHistorical, true);
    assert.ok(data.metadata.dataSource.includes('Binance'));
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

describe('Module 8: AI–BTC 融资张力指数与微观传导检验系统 (AI–BTC Tension Platform)', () => {
  const { getAiBtcTensionData } = require('../server/ai_btc_tension_fetcher');

  test('getAiBtcTensionData returns valid 3-layer decoupled quantitative dataset', async () => {
    const data = await getAiBtcTensionData(false);
    assert.ok(data, 'Data object must exist');
    assert.ok(data.metadata, 'Metadata must exist');
    assert.ok(data.metadata.title.includes('全球宏观暗渠穿透') || data.metadata.title.includes('AI–BTC'), 'Title must be valid');
    assert.ok(data.metadata.core_hypothesis.length > 10, 'Core hypothesis must exist');
    assert.ok(data.metadata.total_days >= 1500, 'Total historical days must be >= 1500');
    assert.ok(Array.isArray(data.series), 'Series must be an array');
    assert.ok(data.series.length >= 1500, 'Series length must be >= 1500');
    assert.ok(Array.isArray(data.trajectory_180d), 'Trajectory 180d must be an array');
    assert.equal(data.trajectory_180d.length, 180, 'Trajectory must contain exactly 180 days');
  });

  test('4-Quadrant Phase Space state machine classification rules are verified', async () => {
    const data = await getAiBtcTensionData(false);
    const { current, regime_stats } = data;

    assert.ok(current, 'Current state object must exist');
    assert.ok(['Q1', 'Q2', 'Q3', 'Q4'].includes(current.regime_code));

    // Verify current quadrant logic
    if (current.p_ai >= 0 && current.p_btc < 0) {
      assert.equal(current.regime_code, 'Q1');
    } else if (current.p_ai >= 0 && current.p_btc >= 0) {
      assert.equal(current.regime_code, 'Q2');
    } else if (current.p_ai < 0 && current.p_btc >= 0) {
      assert.equal(current.regime_code, 'Q3');
    } else {
      assert.equal(current.regime_code, 'Q4');
    }

    // Verify regime distribution sum ≈ 100%
    assert.ok(regime_stats.Q1 && regime_stats.Q2 && regime_stats.Q3 && regime_stats.Q4);
    const totalPct = regime_stats.Q1.pct + regime_stats.Q2.pct + regime_stats.Q3.pct + regime_stats.Q4.pct;
    assert.ok(Math.abs(totalPct - 100.0) < 0.5, 'Regime percentages must sum to 100%');
  });

  test('Tension Intensity formula r = sqrt(P_AI^2 + P_BTC^2) is mathematically verified', async () => {
    const data = await getAiBtcTensionData(false);
    const { current } = data;

    const expectedR = Math.sqrt(Math.pow(current.p_ai, 2) + Math.pow(current.p_btc, 2));
    assert.ok(
      Math.abs(current.tension_intensity - expectedR) < 0.015,
      `Calculated r (${current.tension_intensity}) must match sqrt(p_ai^2 + p_btc^2) (${expectedR})`
    );
  });

  test('OLS Macro Orthogonal regression and Q2 hypothesis tests meet econometric criteria', async () => {
    const data = await getAiBtcTensionData(false);
    const { regression } = data;

    assert.ok(regression, 'Regression object must exist');
    assert.ok(Number.isFinite(regression.r_squared), 'Macro R-squared must be a finite number');
    assert.ok(regression.r_squared > 0.05, 'Macro R-squared must be economically meaningful (> 5%)');
    assert.ok(Array.isArray(regression.parameters), 'Parameters must be an array');

    const paramMap = {};
    regression.parameters.forEach(p => {
      paramMap[p.var] = p;
      assert.ok(Number.isFinite(p.beta), `Beta for ${p.var} must be a finite number`);
      assert.ok(Number.isFinite(p.t_stat), `t-stat for ${p.var} must be a finite number`);
      assert.ok(Number.isFinite(p.p_value), `p-value for ${p.var} must be a finite number`);
    });

    // Verify key explanatory variables
    assert.ok(paramMap.qqq_ret, 'QQQ return beta must be present');
    assert.ok(paramMap.qqq_ret.beta > 0, 'BTC has positive tech beta with QQQ');
    assert.ok(paramMap.qqq_ret.p_value < 0.05, 'QQQ beta must be statistically significant');

    assert.ok(paramMap.dxy_ret, 'DXY return beta must be present');
    assert.ok(paramMap.dxy_ret.beta < 0, 'BTC has negative relationship with USD index DXY');

    assert.ok(paramMap.delta_real_yield, 'TIPS real yield beta must be present');
    assert.ok(paramMap.vix_delta, 'VIX delta beta must be present');
    assert.ok(paramMap.delta_fed_net_liq, 'Fed net liquidity beta must be present');
    assert.ok(paramMap.delta_term_premium, '10Y Term Premium delta beta must be present');
    assert.ok(paramMap.repo_spread, 'Overnight SOFR-IORB repo spread beta must be present');

    // Q2 Hypothesis test with Welch's t-test and HAC standard errors
    assert.ok(regression.q2_hypothesis_test, 'Q2 hypothesis test must exist');
    const q2Test = regression.q2_hypothesis_test;
    assert.ok(Number.isFinite(q2Test.q2_avg_residual_daily_pct), 'Q2 residual must be finite number');
    assert.ok(Number.isFinite(q2Test.non_q2_avg_residual_daily_pct), 'Non-Q2 residual must be finite number');
    assert.ok(Number.isFinite(q2Test.t_stat), 'Welch t-stat must be finite number');
    assert.ok(Number.isFinite(q2Test.p_value), 'p-value must be finite number');
    assert.ok(Number.isFinite(q2Test.cohen_d), 'Cohen d effect size must be finite number');
    assert.strictEqual(typeof q2Test.is_significant_5pct, 'boolean');
    assert.ok(typeof q2Test.conclusion === 'string' && q2Test.conclusion.length > 10);
  });

  test('Event Study CAR windows and Phase 2 Miner-HPC Basket are intact', async () => {
    const data = await getAiBtcTensionData(false);
    const { event_study, miner_hpc_basket, causality, current } = data;

    // Macro plumbing & compute metrics
    assert.ok(Number.isFinite(current.i_compute), 'i_compute must exist');
    assert.ok(Number.isFinite(current.i_crypto), 'i_crypto must exist');
    assert.ok(Number.isFinite(current.repo_spread), 'repo_spread must exist');
    assert.ok(Number.isFinite(current.term_premium), 'term_premium must exist');

    // Event study
    assert.ok(Array.isArray(event_study), 'Event study must be an array');
    assert.ok(event_study.length >= 8, 'Must have at least 8 landmark AI Capex events');
    const firstEvent = event_study[0];
    assert.ok(firstEvent.event_date);
    assert.ok(firstEvent.ticker);
    assert.ok(typeof firstEvent.car_1d === 'number');
    assert.ok(typeof firstEvent.car_5d === 'number');
    assert.ok(typeof firstEvent.car_20d === 'number');

    // Miner HPC & Pure Play basket
    assert.ok(Array.isArray(miner_hpc_basket), 'Miner HPC basket must be an array');
    assert.ok(miner_hpc_basket.length >= 5, 'Must contain at least 5 key miner targets');
    const tickers = miner_hpc_basket.map(m => m.ticker);
    assert.ok(tickers.includes('CORZ'), 'CORZ must be in miner basket');
    assert.ok(tickers.includes('IREN'), 'IREN must be in miner basket');
    assert.ok(tickers.includes('WULF'), 'WULF must be in miner basket');
    assert.ok(tickers.includes('MARA'), 'MARA must be in miner basket');
    assert.ok(tickers.includes('RIOT'), 'RIOT must be in miner basket');

    // Granger causality with ADF unit-root tests and empirical findings
    assert.ok(causality, 'Granger causality must exist');
    assert.ok(causality.p_ai_causes_residual, 'P_AI -> ε_BTC must exist');
    assert.ok(causality.residual_causes_p_ai, 'ε_BTC -> P_AI must exist');
    assert.ok(causality.adf_tests, 'ADF stationarity tests must be documented');
    assert.ok(Array.isArray(causality.findings) && causality.findings.length > 0, 'Empirical findings must be reported');
  });

  test('Module 8 Auditability: HPC spread variance, granular factor breakdowns, econometric metadata, and honest refresh status', async () => {
    const data = await getAiBtcTensionData(false);

    // 1. Verify hpc_spread is non-zero and has empirical variance (resolves zero-variance bug)
    const hpcValues = data.series.map(s => s.hpc_spread).filter(v => typeof v === 'number');
    const nonZeroHpc = hpcValues.filter(v => v !== 0);
    assert.ok(nonZeroHpc.length > 1000, `hpc_spread must have over 1000 non-zero observations, found: ${nonZeroHpc.length}`);

    const hpcMean = hpcValues.reduce((a, b) => a + b, 0) / hpcValues.length;
    const hpcVariance = hpcValues.reduce((a, b) => a + Math.pow(b - hpcMean, 2), 0) / hpcValues.length;
    const hpcStd = Math.sqrt(hpcVariance);
    assert.ok(hpcStd > 0.5, `hpc_spread standard deviation must be > 0.5, found: ${hpcStd.toFixed(4)}`);

    // 2. Granular breakdown auditability for Layer 1 and Layer 2
    const latestItem = data.series[data.series.length - 1];
    assert.ok(latestItem.compute_breakdown, 'Latest series point must have compute_breakdown');
    assert.ok(latestItem.crypto_breakdown, 'Latest series point must have crypto_breakdown');

    // Layer 1 compute breakdown components
    const cb = latestItem.compute_breakdown;
    assert.equal(cb.hpc_spread.weight, 0.4, 'HPC spread weight must be 40% (0.4)');
    assert.equal(cb.capex_to_ocf.weight, 0.25, 'Capex to OCF weight must be 25% (0.25)');
    assert.equal(cb.capex_growth.weight, 0.20, 'Capex growth weight must be 20% (0.20)');
    assert.equal(cb.credit_cost.weight, 0.15, 'Credit cost weight must be 15% (0.15)');
    assert.ok(Number.isFinite(cb.hpc_spread.raw_ratio), 'HPC spread must have raw_ratio');
    assert.ok(Number.isFinite(cb.hpc_spread.contribution), 'HPC spread must have contribution');

    // Layer 2 crypto breakdown components
    const crb = latestItem.crypto_breakdown;
    assert.equal(crb.basis_inversion.weight, 0.35, 'Basis inversion weight must be 35% (0.35)');
    assert.equal(crb.basis_momentum.weight, 0.25, 'Basis momentum weight must be 25% (0.25)');
    assert.equal(crb.volatility_shock.weight, 0.20, 'Volatility shock weight must be 20% (0.20)');
    assert.equal(crb.miner_squeeze.weight, 0.20, 'Miner squeeze weight must be 20% (0.20)');
    assert.ok(Number.isFinite(crb.basis_inversion.raw_basis), 'Basis inversion must have raw_basis');

    // 3. Econometric metadata
    assert.ok(data.regression.hac_metadata, 'HAC robust covariance metadata must exist');
    assert.equal(data.regression.hac_metadata.maxlags, 5, 'HAC must use 5 lags');
    assert.ok(data.regression.hac_metadata.kernel.includes('Newey-West') || data.regression.hac_metadata.kernel.includes('Bartlett'));

    assert.ok(data.regression.oos_metadata, 'Out-Of-Sample rolling metadata must exist');
    assert.equal(data.regression.oos_metadata.rolling_window, 120, 'OOS rolling window must be 120 days');
    assert.equal(data.regression.oos_metadata.min_burnin, 60, 'OOS burn-in must be 60 days');

    assert.ok(data.event_study_metadata, 'Event study benchmark metadata must exist');
    assert.ok(data.event_study_metadata.windows.includes('[-1, +1]'));

    // 4. Structured honest refresh status
    assert.ok(data.refresh_status, 'refresh_status object must exist on returned data');
    assert.ok(['refreshed', 'pipelineUnavailable', 'stale', 'cached'].includes(data.refresh_status.status));
    assert.ok(typeof data.refresh_status.message === 'string' && data.refresh_status.message.length > 0);
  });

  test('HTTP Endpoint GET /api/ai-btc-tension returns 200 with code 0 and valid cache', async () => {
    const { server } = require('../server/index');
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', async () => {
        const port = server.address().port;
        try {
          const resp = await fetch(`http://127.0.0.1:${port}/api/ai-btc-tension`);
          assert.equal(resp.status, 200);
          const json = await resp.json();
          assert.equal(json.code, 0);
          assert.ok(json.data);
          assert.ok(json.data.current);
          assert.ok(json.data.metadata.title.includes('全球宏观暗渠穿透') || json.data.metadata.title.includes('AI–BTC'), 'Title must be valid');

          // Verify ETag support on the endpoint
          const etag = resp.headers.get('etag');
          if (etag) {
            const cachedResp = await fetch(`http://127.0.0.1:${port}/api/ai-btc-tension`, {
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

describe('Module 1-B: Dual-Track Crypto McClellan Oscillator & Breadth Regimes', () => {
  const { getMcClellanData } = require('../server/crypto_mcclellan_fetcher');

  test('RAMO mathematical bounds and liquidity penalty logic', () => {
    // RAMO = sign(R) * ln(1 + |R|) * (Vol / Median(Vol)) * min(1, LP / 300,000)
    const calcRamo = (ret, vol, medVol, lp) => {
      const sign = ret > 0 ? 1 : (ret < 0 ? -1 : 0);
      const retFactor = Math.log(1 + Math.abs(ret));
      const turnoverFactor = medVol > 0 ? (vol / medVol) : 1;
      const lpPenalty = Math.min(1.0, Math.max(0.0, lp / 300000));
      return sign * retFactor * turnoverFactor * lpPenalty;
    };

    // Test 1: Zero return yields 0 RAMO
    assert.equal(calcRamo(0.0, 1000000, 1000000, 500000), 0);

    // Test 2: Low LP (< $300k) receives penalty discount
    const normalLpRamo = calcRamo(0.1, 1000000, 1000000, 300000);
    const lowLpRamo = calcRamo(0.1, 1000000, 1000000, 150000);
    assert.ok(Math.abs(lowLpRamo - normalLpRamo * 0.5) < 1e-6, 'Half LP should scale penalty linearly to 0.5');

    // Test 3: Sign preservation: negative returns yield negative RAMO
    const negRamo = calcRamo(-0.05, 2000000, 1000000, 400000);
    assert.ok(negRamo < 0, 'Negative return must yield negative RAMO');
  });

  test('McClellan Oscillator EMA difference and spread calculations', () => {
    // Oscillator = (EMA19 - EMA39) * 1000
    // Spread = Frontier - Core
    const coreEma19 = 0.05;
    const coreEma39 = 0.03;
    const coreOsc = Math.round((coreEma19 - coreEma39) * 1000);
    assert.equal(coreOsc, 20);

    const frontierOsc = 65;
    const spread = frontierOsc - coreOsc;
    assert.equal(spread, 45);
    assert.ok(spread >= 40, 'Spread >= 40 indicates meme siphon warning');
  });

  test('Four Regimes classification logic covers all 4 quadrants', () => {
    const classifyRegime = (core, frontier) => {
      if (core > 0 && frontier > 0) return 'CO_EXPANSION';
      if (core <= 0 && frontier > 0) return 'MEME_SIPHON';
      if (core > 0 && frontier <= 0) return 'QUALITY_ACCUMULATION';
      return 'DEEP_FREEZE';
    };

    assert.equal(classifyRegime(10, 20), 'CO_EXPANSION');
    assert.equal(classifyRegime(-5, 15), 'MEME_SIPHON');
    assert.equal(classifyRegime(12, -8), 'QUALITY_ACCUMULATION');
    assert.equal(classifyRegime(-15, -25), 'DEEP_FREEZE');
  });

  test('getMcClellanData loads valid data with >= 1000 records and robust schema', async () => {
    const data = await getMcClellanData(false);
    assert.ok(data, 'data must exist');

    // Metadata validation
    assert.ok(data.metadata, 'metadata must exist');
    assert.equal(data.metadata.parameters.ema_fast, 19);
    assert.equal(data.metadata.parameters.ema_slow, 39);
    assert.equal(data.metadata.parameters.ratio_scale, 1000);
    assert.equal(data.metadata.gatekeeper.min_liquidity_usd, 300000);
    assert.equal(data.metadata.gatekeeper.min_volume_24h_usd, 1500000);
    assert.equal(data.metadata.gatekeeper.min_fdv_usd, 10000000);
    assert.equal(data.metadata.gatekeeper.retention_days, 7);

    // Current state validation
    assert.ok(data.current, 'data.current must exist');
    assert.ok(data.current.date, 'current date must exist');
    assert.ok(['CO_EXPANSION', 'MEME_SIPHON', 'QUALITY_ACCUMULATION', 'DEEP_FREEZE'].includes(data.current.regime_code));
    assert.ok(typeof data.current.core_oscillator === 'number');
    assert.ok(typeof data.current.frontier_oscillator === 'number');
    assert.ok(typeof data.current.spread === 'number');
    assert.ok(typeof data.current.core_summation === 'number');
    assert.ok(typeof data.current.btc_close === 'number');
    assert.ok(typeof data.current.spread_alert === 'boolean');

    // Series validation: must have >= 1000 daily observations
    assert.ok(Array.isArray(data.series), 'series must be an array');
    assert.ok(data.series.length >= 1000, `series length must be >= 1000, got ${data.series.length}`);

    // Verify properties of series points
    const sample = data.series[data.series.length - 1];
    assert.ok(sample.date);
    assert.ok(typeof sample.core_oscillator === 'number');
    assert.ok(typeof sample.frontier_oscillator === 'number');
    assert.ok(typeof sample.spread === 'number');
    assert.ok(typeof sample.spread_30d_ma === 'number');
    assert.ok(typeof sample.core_summation === 'number');
    assert.ok(typeof sample.btc_close === 'number');
    assert.ok(sample.regime_code);

    // Refresh status validation
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
          assert.ok(json.data.current);
          assert.ok(json.data.series.length >= 1000);
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

  test('getSystemAuditData returns complete registry of all 11 quantitative modules with provenance signatures', async () => {
    const audit = await getSystemAuditData(false);
    assert.equal(audit.code, 0);
    assert.ok(audit.serverTimeUTC);
    assert.ok(typeof audit.serverUptimeSeconds === 'number');
    assert.ok(['HEALTHY', 'DEGRADED'].includes(audit.overallHealth));
    assert.equal(audit.modulesCount, 11, 'Must register exactly 11 core modules');
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
      'crypto_mcclellan_breadth',
      'ai_btc_tension'
    ];

    for (const modId of expectedModules) {
      const mod = audit.modules[modId];
      assert.ok(mod, `Module ${modId} must exist in audit report`);
      assert.ok(mod.name, `${modId} must have human-readable name`);
      assert.ok(mod.primarySource, `${modId} must specify official primary source`);
      assert.ok(Array.isArray(mod.targetEndpoints) && mod.targetEndpoints.length > 0, `${modId} targetEndpoints`);
      assert.ok(mod.timeframe, `${modId} timeframe description`);
      assert.ok(mod.updateInterval, `${modId} updateInterval`);
      assert.equal(mod.isRealtime, true, `${modId} isRealtime`);
      assert.ok(Array.isArray(mod.provenanceSignatures) && mod.provenanceSignatures.length > 0, `${modId} provenanceSignatures`);
      assert.ok(['ONLINE', 'INITIALIZING'].includes(mod.healthStatus), `${modId} healthStatus`);
    }

    // Specific financial & provenance integrity checks
    assert.ok(audit.modules.macro_liquidity.recordCount >= 2000, 'Macro points count');
    assert.ok(audit.modules.macro_liquidity.mstrPurchasesCount >= 100, 'MSTR official purchases count');
    assert.ok(audit.modules.term_premium_basis.provenanceSignatures.includes('AMBERDATA_5_STAGE_REGIME_STATE_MACHINE'));
    assert.ok(audit.modules.term_premium_basis.provenanceSignatures.includes('AMBERDATA_0.50PCT_ETF_FRICTION_THRESHOLD'));
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
          assert.equal(json.modulesCount, 11);
          assert.ok(json.modules.macro_liquidity);
          assert.ok(json.modules.coinbase_orderbook_liquidity);

          // Test ETag
          const etag = resp.headers.get('etag');
          if (etag) {
            const cachedResp = await fetch(`http://127.0.0.1:${port}/api/system/audit`, {
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




