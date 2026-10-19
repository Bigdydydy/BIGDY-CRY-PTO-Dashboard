/**
 * Resilient HTTP Client with AbortSignal deadline, retries, and error handling.
 *
 * - `timeout` covers the whole request: headers AND body consumption. Native
 *   Response bodies are buffered inside the deadline and the Response is
 *   rebuilt; plain test fakes get their body readers wrapped instead.
 * - Retries: network errors, timeouts, HTTP 408 / 429 / 5xx. The final HTTP
 *   response is returned (not thrown) so callers can inspect the status.
 * - Non-retryable statuses (other 4xx) return immediately.
 * - A caller-supplied `signal` is merged in; caller abort never retries.
 * - `Retry-After` (seconds or HTTP-date) and exponential backoff cap at 5s.
 */

const RETRY_BACKOFF_CAP_MS = 5000;

/**
 * Referenced (non-unref'd) retry delay, abortable via `signal`. The timer MUST
 * keep the process alive: for CLI snapshot scripts this backoff is often the
 * only remaining event-loop handle — an unref'd timer would let the process
 * exit "successfully" before the retry ever runs.
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(signal.reason || new Error('Aborted'));
      return;
    }
    const removeListener = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const timer = setTimeout(() => {
      removeListener();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      removeListener();
      reject(signal.reason || new Error('Aborted'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 408 Request Timeout, 429 Too Many Requests, and all 5xx are transient. */
function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

/** Parse Retry-After (seconds delta or HTTP-date), capped at the backoff cap. */
function parseRetryAfter(headers) {
  if (!headers) return null;
  const raw = typeof headers.get === 'function' ? headers.get('retry-after') : headers['retry-after'];
  if (raw === null || raw === undefined || raw === '') return null;
  const sec = Number(raw);
  let ms;
  if (Number.isFinite(sec) && String(raw).trim() !== '') {
    ms = sec * 1000;
  } else {
    const at = Date.parse(raw);
    if (!Number.isFinite(at)) return null;
    ms = at - Date.now();
  }
  return Math.min(Math.max(ms, 0), RETRY_BACKOFF_CAP_MS);
}

/** Race a promise against an abort signal. */
function withAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason || new Error('Aborted'));
      return;
    }
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason || new Error('Aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      v => { signal.removeEventListener('abort', onAbort); resolve(v); },
      e => { signal.removeEventListener('abort', onAbort); reject(e); }
    );
  });
}

/**
 * Ensure the response body is consumed within the armed deadline so the
 * timeout covers the full transfer, then hand the caller a readable response.
 *
 * Native Response bodies are read into an ArrayBuffer inside the deadline.
 * Plain test fakes can't be force-read — their known body readers are wrapped
 * instead so whichever one the caller invokes still races the deadline. The
 * caller signals via `onPending` so the retry loop keeps the (unref'd) timer
 * armed until a reader settles, when `cleanup` disarms it; a fake whose body
 * is never read leaves only an unref'd timer that cannot keep the process
 * alive.
 */
async function consumeBodyWithinDeadline(resp, signal, onPending, cleanup) {
  if (typeof Response !== 'undefined' && resp instanceof Response) {
    // No-body statuses cannot carry a payload (Response ctor would throw).
    if (resp.status === 204 || resp.status === 205 || resp.status === 304) return resp;
    const buf = await withAbort(resp.arrayBuffer(), signal);
    return new Response(buf, {
      status: resp.status,
      statusText: resp.statusText,
      headers: resp.headers
    });
  }
  if (resp && typeof resp === 'object') {
    let wrapped = false;
    for (const method of ['json', 'text', 'arrayBuffer']) {
      if (typeof resp[method] === 'function') {
        const orig = resp[method].bind(resp);
        resp[method] = () => withAbort(orig(), signal).finally(cleanup);
        wrapped = true;
      }
    }
    if (wrapped && onPending) onPending();
  }
  return resp;
}

async function fetchWithTimeout(url, options = {}) {
  const {
    timeout = 10000,
    retries = 1,
    backoffMs = 500,
    signal: callerSignal,
    ...fetchOptions
  } = options;

  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (callerSignal?.aborted) {
      throw callerSignal.reason || new Error('Aborted');
    }
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort(callerSignal.reason || new Error('Aborted'));
    if (callerSignal) callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
    };
    // When the deadline expires the attempt is over — drop this attempt's
    // caller listener even if a plain-fake body is never read.
    const timer = setTimeout(() => {
      controller.abort(new Error(`Request timeout of ${timeout}ms exceeded`));
      if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
    }, timeout);
    if (timer.unref) timer.unref();
    // A plain-fake response's body reader may still be in flight after we
    // return it — the deadline must stay armed until that reader settles.
    let bodyPending = false;

    try {
      const resp = await fetch(url, {
        ...fetchOptions,
        signal: controller.signal
      });
      const finalResp = await consumeBodyWithinDeadline(
        resp, controller.signal, () => { bodyPending = true; }, cleanup
      );

      if (isRetryableStatus(finalResp.status) && attempt < retries) {
        cleanup(); // discarded response — this attempt's deadline is over
        const wait = parseRetryAfter(finalResp.headers)
          ?? Math.min(backoffMs * Math.pow(2, attempt), RETRY_BACKOFF_CAP_MS);
        await sleep(wait, callerSignal);
        continue;
      }
      return finalResp;
    } catch (err) {
      if (callerSignal && callerSignal.aborted) {
        throw callerSignal.reason || err; // caller abort: never retried
      }
      lastError = err;
      if (attempt < retries) {
        cleanup(); // attempt fully consumed — disarm before backing off
        await sleep(Math.min(backoffMs * Math.pow(2, attempt), RETRY_BACKOFF_CAP_MS), callerSignal);
      }
    } finally {
      if (!bodyPending) cleanup();
    }
  }

  throw lastError;
}

const BINANCE_SPOT_HOSTS = ['https://api.binance.com', 'https://data-api.binance.vision'];

/**
 * Fetch a Binance spot public market-data path (e.g. `/api/v3/klines?...`),
 * falling back to the official data-api.binance.vision mirror when the primary
 * host is unreachable or geo-blocked (HTTP 451/403).
 */
async function fetchBinanceSpot(pathAndQuery, options = {}) {
  let lastResp = null;
  let lastError = null;
  for (const host of BINANCE_SPOT_HOSTS) {
    try {
      const resp = await fetchWithTimeout(host + pathAndQuery, options);
      if (resp.ok) return resp;
      lastResp = resp;
    } catch (err) {
      lastError = err;
    }
  }
  if (lastResp) return lastResp;
  throw lastError;
}

module.exports = {
  fetchWithTimeout,
  fetchBinanceSpot,
  isRetryableStatus,
  parseRetryAfter
};
