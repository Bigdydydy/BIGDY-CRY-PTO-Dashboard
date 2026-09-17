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

module.exports = {
  fetchWithTimeout
};
