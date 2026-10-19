/**
 * http_client resilience tests — all fetches stubbed, no network.
 *
 * Covers: network-throw recovery, 5xx/429 retry, capped Retry-After, 404
 * non-retry, body-read deadline for native Response AND plain test fakes,
 * caller abort (never retried), and no process-live timers for unread fakes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fetchWithTimeout,
  isRetryableStatus,
  parseRetryAfter
} = require('../server/http_client');

function withFetch(t, impl) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    calls.push({ url, opts });
    return impl(url, opts, calls.length);
  };
  t.after(() => { globalThis.fetch = orig; });
  return calls;
}

const plainOk = (body, extra = {}) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  headers: { get: () => null },
  json: async () => body,
  text: async () => JSON.stringify(body),
  ...extra
});

const plainStatus = (status, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: String(status),
  headers: { get: k => headers[k] ?? headers[k.toLowerCase?.()] ?? null },
  json: async () => ({}),
  text: async () => ''
});

test('network throw recovers on retry', async (t) => {
  const calls = withFetch(t, (url, opts, n) => {
    if (n === 1) return Promise.reject(new Error('ECONNRESET'));
    return Promise.resolve(plainOk({ hello: 1 }));
  });
  const resp = await fetchWithTimeout('https://x/', { timeout: 1000, retries: 1, backoffMs: 1 });
  assert.equal(resp.status, 200);
  assert.deepEqual(await resp.json(), { hello: 1 });
  assert.equal(calls.length, 2);
});

test('503 is retried and the final successful response is returned', async (t) => {
  const calls = withFetch(t, (url, opts, n) =>
    Promise.resolve(n === 1 ? plainStatus(503) : plainOk({ ok2: true })));
  const resp = await fetchWithTimeout('https://x/', { timeout: 1000, retries: 2, backoffMs: 1 });
  assert.equal(resp.status, 200);
  assert.equal(calls.length, 2);
});

test('final 503 response is returned (not thrown) when retries exhausted', async (t) => {
  withFetch(t, () => Promise.resolve(plainStatus(503)));
  const resp = await fetchWithTimeout('https://x/', { timeout: 1000, retries: 1, backoffMs: 1 });
  assert.equal(resp.status, 503);
});

test('429 with Retry-After retries; Retry-After parses seconds/HTTP-date and caps at 5s', async (t) => {
  const calls = withFetch(t, (url, opts, n) =>
    Promise.resolve(n === 1 ? plainStatus(429, { 'retry-after': '0' }) : plainOk({ done: 1 })));
  const resp = await fetchWithTimeout('https://x/', { timeout: 1000, retries: 1, backoffMs: 1 });
  assert.equal(resp.status, 200);
  assert.equal(calls.length, 2);

  // Unit checks on the cap itself
  assert.equal(parseRetryAfter({ get: () => '10' }), 5000); // 10s -> capped
  assert.equal(parseRetryAfter({ get: () => '2' }), 2000);
  const in20s = new Date(Date.now() + 20000).toUTCString();
  assert.equal(parseRetryAfter({ get: () => in20s }), 5000); // HTTP-date -> capped
  assert.equal(parseRetryAfter({ get: () => null }), null);
});

test('404 is NOT retried', async (t) => {
  const calls = withFetch(t, () => Promise.resolve(plainStatus(404)));
  const resp = await fetchWithTimeout('https://x/', { timeout: 1000, retries: 3, backoffMs: 1 });
  assert.equal(resp.status, 404);
  assert.equal(calls.length, 1);
});

test('isRetryableStatus: 408/429/5xx only', () => {
  assert.equal(isRetryableStatus(408), true);
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(500), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(400), false);
  assert.equal(isRetryableStatus(404), false);
  assert.equal(isRetryableStatus(200), false);
});

test('native Response body hang after headers times out', async (t) => {
  const hanging = new Response(new ReadableStream({ start() { /* never enqueues */ } }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
  withFetch(t, () => Promise.resolve(hanging));
  await assert.rejects(
    () => fetchWithTimeout('https://x/', { timeout: 60, retries: 0 }),
    /timeout|aborted/i
  );
});

test('fake/plain response body hang times out', async (t) => {
  const fake = {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => null },
    json: () => new Promise(() => {}) // never resolves
  };
  withFetch(t, () => Promise.resolve(fake));
  const resp = await fetchWithTimeout('https://x/', { timeout: 60, retries: 0 });
  await assert.rejects(() => resp.json(), /timeout|aborted/i);
});

test('caller abort is honored and never retried', async (t) => {
  const ac = new AbortController();
  let aborted = false;
  const calls = withFetch(t, (url, opts) => new Promise((_, reject) => {
    opts.signal.addEventListener('abort', () => { aborted = true; reject(opts.signal.reason || new Error('Aborted')); });
  }));
  const p = fetchWithTimeout('https://x/', { timeout: 5000, retries: 3, backoffMs: 1, signal: ac.signal });
  setTimeout(() => ac.abort(new Error('user cancel')), 10);
  await assert.rejects(p, /user cancel|Aborted/i);
  assert.equal(aborted, true);
  assert.equal(calls.length, 1); // no retry after caller abort
});

test('caller abort during retry backoff interrupts the sleep and is never retried', async (t) => {
  const ac = new AbortController();
  const calls = withFetch(t, () => Promise.reject(new Error('ECONNRESET')));
  const p = fetchWithTimeout('https://x/', { timeout: 1000, retries: 3, backoffMs: 10000, signal: ac.signal });
  setTimeout(() => ac.abort(new Error('user cancel during backoff')), 30);
  const started = Date.now();
  await assert.rejects(p, /user cancel|Aborted/i);
  assert.ok(Date.now() - started < 5000, 'backoff sleep was not interrupted by the abort');
  assert.equal(calls.length, 1); // no retry after caller abort
});

test('referenced backoff keeps a CLI process alive until the retry runs (spawned child)', () => {
  // Regression guard for the snapshot-script bug: with an unref'd sleep timer
  // the child would exit "successfully" during backoff and never print
  // RECOVERED. A referenced timer keeps it alive for the retry.
  const { spawnSync } = require('node:child_process');
  const script = `
    const { fetchWithTimeout } = require(process.env.HTTP_CLIENT_PATH);
    let n = 0;
    globalThis.fetch = () => (++n === 1
      ? Promise.reject(new Error('ECONNRESET'))
      : Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: 1 }) }));
    fetchWithTimeout('https://x/', { timeout: 1000, retries: 1, backoffMs: 150 })
      .then(() => console.log('RECOVERED'))
      .catch(e => console.log('FAILED:' + e.message));
  `;
  const res = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, HTTP_CLIENT_PATH: require.resolve('../server/http_client') },
    encoding: 'utf8',
    timeout: 15000
  });
  assert.match(res.stdout || '', /RECOVERED/);
  assert.equal(res.status, 0);
});

test('unread fake response leaves no referenced timer (process can exit)', async (t) => {
  const timeoutsBefore = process._getActiveHandles().filter(h => h?.constructor?.name === 'Timeout').length;
  withFetch(t, () => Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => new Promise(() => {}) // never read by caller
  }));
  const resp = await fetchWithTimeout('https://x/', { timeout: 30000, retries: 0 });
  assert.equal(resp.status, 200);
  // The deadline timer for the unread fake must be unref'd: referenced
  // Timeout handle count must not grow because of it.
  const timeoutsAfter = process._getActiveHandles().filter(h => h?.constructor?.name === 'Timeout').length;
  assert.ok(timeoutsAfter <= timeoutsBefore,
    `leaked referenced timer (before=${timeoutsBefore} after=${timeoutsAfter})`);
});
