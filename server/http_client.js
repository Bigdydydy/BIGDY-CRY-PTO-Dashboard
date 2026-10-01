/**
 * Resilient HTTP Client with AbortSignal timeout, retries, and error handling
 */

async function fetchWithTimeout(url, options = {}) {
  const {
    timeout = 10000,
    retries = 1,
    backoffMs = 500,
    ...fetchOptions
  } = options;

  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`Request timeout of ${timeout}ms exceeded`)), timeout);

    try {
      const resp = await fetch(url, {
        ...fetchOptions,
        signal: controller.signal
      });
      clearTimeout(timer);
      return resp;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      if (attempt < retries) {
        const delay = backoffMs * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delay));
      }
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
  fetchBinanceSpot
};
