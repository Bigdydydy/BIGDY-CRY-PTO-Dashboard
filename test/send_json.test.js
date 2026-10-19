/**
 * sendJsonResponse wire semantics:
 * - per-call derived ages are stripped ONLY on source-health objects (the
 *   ones carrying lastSuccessAt + policy/usable/state); a business field
 *   named ageMs elsewhere in a payload is preserved verbatim.
 * - byte-identical bodies reuse the strong ETag -> 304 on If-None-Match;
 *   a real state change (health crosses a warn boundary) changes the body
 *   -> different ETag -> 200.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { sendJsonResponse } = require('../server/index.js');

const mockReq = etag => ({ headers: etag ? { 'if-none-match': etag } : {} });
const mockRes = () => {
  const r = { status: null, headers: null, body: null };
  r.writeHead = (s, h) => { r.status = s; r.headers = h; };
  r.end = (b) => { r.body = b === undefined || b === null ? null : Buffer.from(b).toString('utf8'); };
  return r;
};

const healthObj = state => ({
  id: 'x', state, usable: state === 'OK', observed: true,
  lastSuccessAt: '2026-10-18T12:00:00.000Z', dataAsOf: '2026-10-18T11:58:00.000Z',
  policy: { fetchWarnMs: 180000, fetchBlockMs: 900000, dataWarnMs: 180000, dataBlockMs: 900000 },
  ageMs: 1234, dataAgeMs: 5678, warnings: [], stale: state !== 'OK', expired: false,
  lastError: null, issues: []
});

describe('sendJsonResponse health-scoped age stripping + ETag', () => {
  test('business payload fields named ageMs/dataAgeMs are preserved', () => {
    const res = mockRes();
    sendJsonResponse(mockReq(), res, 200, { data: { ageMs: 123, dataAgeMs: 4, label: 'biz' } });
    const body = JSON.parse(res.body);
    assert.equal(body.data.ageMs, 123);
    assert.equal(body.data.dataAgeMs, 4);
  });

  test('source-health objects lose only the per-call derived ages on the wire', () => {
    const res = mockRes();
    sendJsonResponse(mockReq(), res, 200, { dataHealth: { sources: { x: healthObj('OK') } } });
    const h = JSON.parse(res.body).dataHealth.sources.x;
    assert.equal(h.ageMs, undefined);
    assert.equal(h.dataAgeMs, undefined);
    assert.equal(h.lastSuccessAt, '2026-10-18T12:00:00.000Z');
    assert.equal(h.state, 'OK');
  });

  test('identical bodies -> identical strong ETag -> 304 on revalidation', () => {
    const res1 = mockRes();
    sendJsonResponse(mockReq(), res1, 200, { dataHealth: { sources: { x: healthObj('OK') } } });
    const res2 = mockRes();
    sendJsonResponse(mockReq(), res2, 200, {
      dataHealth: { sources: { x: { ...healthObj('OK'), ageMs: 999999, dataAgeMs: 999999 } } }
    });
    assert.equal(res1.headers.ETag, res2.headers.ETag,
      'per-call age values must not churn the ETag');

    const res3 = mockRes();
    sendJsonResponse(mockReq(res1.headers.ETag), res3, 200, { dataHealth: { sources: { x: healthObj('OK') } } });
    assert.equal(res3.status, 304);
    assert.equal(res3.body, null);
  });

  test('a real health-state change (clock past warn boundary) yields a new ETag / 200', () => {
    const res1 = mockRes();
    sendJsonResponse(mockReq(), res1, 200, { dataHealth: { sources: { x: healthObj('OK') } } });
    const res2 = mockRes();
    sendJsonResponse(mockReq(res1.headers.ETag), res2, 200, { dataHealth: { sources: { x: healthObj('STALE') } } });
    assert.equal(res2.status, 200, 'state change must not be served as 304');
    assert.ok(JSON.parse(res2.body).dataHealth.sources.x.state === 'STALE');
  });
});
