/**
 * Daily spot closes (UTC-aligned) with venue fallback.
 *
 * Binance answers the Render host with 418/451 (shared egress IPs are banned), which froze the
 * Gold/BTC and SSRO modules online. Sources are tried in order and every symbol of one request
 * comes from the same venue, so ratios never mix quotes from two exchanges:
 *   1. Binance spot (api.binance.com, then the data-api.binance.vision mirror) — USDT
 *   2. OKX spot (1Dutc bars) — USDT, closes within ~0.02% of Binance
 *   3. Coinbase Exchange — USD
 */

const { fetchWithTimeout } = require('./http_client');

const DAY_MS = 86400000;
const isoDate = ts => new Date(ts).toISOString().slice(0, 10);

async function getJson(url) {
  const res = await fetchWithTimeout(url, { timeout: 12000, retries: 1 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function binanceVenue(name, host) {
  return {
    name,
    quote: 'USDT',
    async daily(symbol, startMs) {
      const rows = [];
      let start = startMs;
      for (let guard = 0; guard < 10 && start < Date.now(); guard++) {
        const data = await getJson(`${host}/api/v3/klines?symbol=${symbol}USDT&interval=1d&startTime=${start}&limit=1000`);
        if (!Array.isArray(data) || !data.length) break;
        for (const k of data) rows.push({ openTime: k[0], close: Number(k[4]) });
        const last = data[data.length - 1][0];
        if (data.length < 1000 || last <= start) break;
        start = last + DAY_MS;
      }
      return rows;
    }
  };
}

const okxVenue = {
  name: 'OKX',
  quote: 'USDT',
  async daily(symbol, startMs) {
    const rows = [];
    let after = null; // OKX pages backwards: `after` returns bars older than this timestamp
    for (let guard = 0; guard < 40; guard++) {
      const url = `https://www.okx.com/api/v5/market/history-candles?instId=${symbol}-USDT&bar=1Dutc&limit=100${after ? `&after=${after}` : ''}`;
      const json = await getJson(url);
      if (json.code !== '0' || !Array.isArray(json.data)) throw new Error(`code ${json.code}`);
      if (!json.data.length) break;
      for (const k of json.data) rows.push({ openTime: Number(k[0]), close: Number(k[4]) });
      after = Number(json.data[json.data.length - 1][0]);
      if (after <= startMs || json.data.length < 100) break;
    }
    return rows.filter(r => r.openTime >= startMs);
  }
};

const coinbaseVenue = {
  name: 'Coinbase',
  quote: 'USD',
  async daily(symbol, startMs) {
    const rows = [];
    // Coinbase rejects windows holding more than 300 candles
    for (let s = startMs; s < Date.now(); s += 299 * DAY_MS) {
      const e = Math.min(Date.now(), s + 299 * DAY_MS);
      const data = await getJson(`https://api.exchange.coinbase.com/products/${symbol}-USD/candles?granularity=86400&start=${new Date(s).toISOString()}&end=${new Date(e).toISOString()}`);
      if (!Array.isArray(data)) throw new Error('non-array response');
      for (const k of data) rows.push({ openTime: k[0] * 1000, close: Number(k[4]) });
    }
    return rows;
  }
};

const VENUES = [
  binanceVenue('Binance', 'https://api.binance.com'),
  binanceVenue('Binance (vision mirror)', 'https://data-api.binance.vision'),
  okxVenue,
  coinbaseVenue
];

const COVERAGE_SLACK_MS = 7 * DAY_MS;

/**
 * Daily closes for several base assets from the first venue that serves all of them back to
 * startMs. A venue whose history starts later (e.g. a pair listed recently) is kept as a
 * candidate; if no venue covers the full window, the one reaching furthest back is returned
 * with partial: true and coverageStart, so the caller can splice in older cached history.
 * Returns { venue, quote, series: { [symbol]: [{ date, openTime, close }] }, errors, partial, coverageStart }.
 */
async function fetchSpotDailyCloses(symbols, startMs, venues = VENUES) {
  const errors = [];
  let best = null;
  for (const venue of venues) {
    try {
      const results = await Promise.all(symbols.map(sym => venue.daily(sym, startMs)));
      const series = {};
      symbols.forEach((sym, i) => {
        const byDate = new Map();
        for (const r of results[i]) {
          if (r.close > 0) byDate.set(isoDate(r.openTime), { date: isoDate(r.openTime), openTime: r.openTime, close: r.close });
        }
        series[sym] = [...byDate.values()].sort((a, b) => a.openTime - b.openTime);
      });
      const empty = symbols.filter(sym => !series[sym].length);
      if (empty.length) throw new Error(`no data for ${empty.join(', ')}`);

      const coverageStart = Math.max(...symbols.map(sym => series[sym][0].openTime));
      const result = { venue: venue.name, quote: venue.quote, series, errors, partial: false, coverageStart: isoDate(coverageStart) };
      if (coverageStart <= startMs + COVERAGE_SLACK_MS) return result;
      errors.push(`${venue.name}: history only from ${isoDate(coverageStart)}`);
      if (!best || coverageStart < Date.parse(best.coverageStart)) best = { ...result, partial: true };
    } catch (err) {
      errors.push(`${venue.name}: ${err.message}`);
    }
  }
  if (best) return { ...best, errors };
  throw new Error(`All spot venues failed — ${errors.join(' | ')}`);
}

module.exports = {
  fetchSpotDailyCloses,
  VENUES
};
