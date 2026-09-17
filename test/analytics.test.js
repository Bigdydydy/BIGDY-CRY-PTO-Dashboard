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
});

describe('Phase 2: Term Premium & Real Basis Dataset Engine', () => {
  const fs = require('fs');
  const path = require('path');
  const {
    calculateConstantMaturityBasis,
    loadHistoricalBasisSeries,
    evaluateCarryRegime,
    analyzeTermPremium,
    T_BILL_RATE
  } = require('../server/term_premium_engine');

  test('Verified real historical dataset exists and is clean', () => {
    const filePath = path.join(__dirname, '..', 'data', 'term_premium_history.json');
    assert.ok(fs.existsSync(filePath), 'data/term_premium_history.json must exist');
    const series = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.ok(Array.isArray(series));
    assert.ok(series.length >= 600, `Dataset must contain >= 600 daily records, got ${series.length}`);

    // Check chronological order and validity of fields
    for (let i = 0; i < series.length; i++) {
      const row = series[i];
      assert.ok(typeof row.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date), `Row ${i} date format`);
      if (i > 0) {
        assert.ok(row.date >= series[i - 1].date, `Row ${i} date should be in ascending order`);
      }
      assert.ok(typeof row.apr7d === 'number' && !isNaN(row.apr7d), `Row ${i} apr7d`);
      assert.ok(typeof row.apr30d === 'number' && !isNaN(row.apr30d), `Row ${i} apr30d`);
      assert.ok(typeof row.apr90d === 'number' && !isNaN(row.apr90d), `Row ${i} apr90d`);
      assert.ok(typeof row.apr180d === 'number' && !isNaN(row.apr180d), `Row ${i} apr180d`);
      assert.ok(typeof row.spread90d7d === 'number' && !isNaN(row.spread90d7d), `Row ${i} spread90d7d`);
      assert.ok(typeof row.spread30d7d === 'number' && !isNaN(row.spread30d7d), `Row ${i} spread30d7d`);
      assert.ok(typeof row.excessReturn === 'number' && !isNaN(row.excessReturn), `Row ${i} excessReturn`);
      assert.ok(typeof row.carryScore === 'number' && !isNaN(row.carryScore), `Row ${i} carryScore`);
    }
  });

  test('analyzeTermPremium returns verified real metadata and current regime', async () => {
    const result = await analyzeTermPremium([], 77000);
    assert.ok(result.metadata);
    assert.equal(result.metadata.isRealHistorical, true);
    assert.ok(result.metadata.dataSource.includes('Binance'));
    assert.ok(result.series.length >= 600);
    assert.ok(result.current);
    assert.ok(result.regime);
    assert.ok(result.regime.regimeCode);
    assert.equal(result.tBillRate, T_BILL_RATE);
  });

  test('evaluateCarryRegime classifies normal contango vs overcrowded inversion', () => {
    const normalState = {
      apr7d: 8.0,
      apr30d: 9.5,
      apr90d: 11.0,
      apr180d: 12.5,
      spread90d7d: 3.0,
      spread30d7d: 1.5,
      spread180d30d: 3.0,
      excessReturn: 5.0,
      carryScore: 14.7
    };
    const r1 = evaluateCarryRegime(normalState, []);
    assert.equal(r1.regimeCode, 'NORMAL_CONTANGO');

    const invertedState = {
      apr7d: 15.0,
      apr30d: 13.0,
      apr90d: 12.0,
      apr180d: 11.0,
      spread90d7d: -3.0,
      spread30d7d: -2.0,
      spread180d30d: -2.0,
      excessReturn: 8.5,
      carryScore: -25.0
    };
    const r2 = evaluateCarryRegime(invertedState, []);
    assert.equal(r2.regimeCode, 'OVERCROWDED_INVERSION');
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
});

