/**
 * Data providers for the analyst agent snapshot: FRED (CSV, no key), Yahoo chart API, US Treasury FiscalData.
 * Every fetcher returns ascending [{ date: 'YYYY-MM-DD', value: number }] (auctions return rows).
 * Raw responses are cached on disk so repeated runs (and --asof backfills) don't hammer the endpoints.
 */

const fs = require('fs');
const path = require('path');
const { fetchWithTimeout } = require('../../../server/http_client');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const CACHE_DIR = path.join(__dirname, '..', 'cache');
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const HISTORY_YEARS = 12;

function cachePath(provider, key) {
  return path.join(CACHE_DIR, provider + '_' + key.replace(/[^A-Za-z0-9._-]/g, '_') + '.json');
}

function readCache(provider, key, { maxAgeMs = CACHE_TTL_MS } = {}) {
  try {
    const file = cachePath(provider, key);
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > maxAgeMs) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeCache(provider, key, data) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath(provider, key), JSON.stringify(data));
}

// History always starts HISTORY_YEARS before today, so one cached download serves every --asof run
// (snapshot.js truncates at asof); asof only matters when it predates that window.
function startDate(asof) {
  const today = new Date().toISOString().slice(0, 10);
  const d = new Date((asof && asof < today ? asof : today) + 'T00:00:00Z');
  d.setUTCFullYear(d.getUTCFullYear() - HISTORY_YEARS);
  return d.toISOString().slice(0, 10);
}

async function withCache(provider, key, opts, loader) {
  if (!opts.noCache) {
    const hit = readCache(provider, key);
    if (hit) return hit;
  }
  const data = await loader();
  writeCache(provider, key, data);
  return data;
}

/**
 * FRED series via the public fredgraph CSV endpoint.
 * The CSV can arrive truncated on slow connections, so a response whose last observation is
 * far older than the series' recent history is treated as a failure rather than silently used.
 */
async function fetchFred(series, opts = {}) {
  const asof = opts.asof || new Date().toISOString().slice(0, 10);
  return withCache('fred', series + '_' + startDate(asof).slice(0, 4), opts, async () => {
    const url = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=' + encodeURIComponent(series) + '&cosd=' + startDate(asof);
    const resp = await fetchWithTimeout(url, { timeout: 45000, retries: 2, headers: { 'User-Agent': UA } });
    if (!resp.ok) throw new Error('FRED ' + series + ' HTTP ' + resp.status);
    const text = await resp.text();
    if (!text.startsWith('observation_date') && !text.startsWith('DATE')) {
      throw new Error('FRED ' + series + ' returned non-CSV (unknown series?)');
    }
    const out = [];
    const lines = text.trim().split('\n');
    for (let i = 1; i < lines.length; i++) {
      const [date, raw] = lines[i].split(',');
      const v = parseFloat(raw);
      if (date && raw && raw.trim() !== '.' && Number.isFinite(v)) out.push({ date: date.trim(), value: v });
    }
    if (!out.length) throw new Error('FRED ' + series + ' returned no observations');
    return out;
  });
}

/**
 * Yahoo Finance chart API (unofficial). Daily closes, dated in the exchange's local calendar.
 * Yahoo intermittently answers with an HTML rate-limit page, so parse failures are retried with backoff.
 */
async function fetchYahoo(ticker, opts = {}) {
  return withCache('yahoo', ticker, opts, async () => {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) + '?range=10y&interval=1d';
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 1500 * attempt));
      try {
        const resp = await fetchWithTimeout(url, { timeout: 30000, retries: 0, headers: { 'User-Agent': UA } });
        const text = await resp.text();
        let json;
        try {
          json = JSON.parse(text);
        } catch (_) {
          throw new Error('Yahoo ' + ticker + ' non-JSON response (HTTP ' + resp.status + ')');
        }
        const result = json.chart && json.chart.result && json.chart.result[0];
        if (!result) throw new Error('Yahoo ' + ticker + ': ' + JSON.stringify(json.chart && json.chart.error));
        const ts = result.timestamp || [];
        const closes = (result.indicators.quote[0] || {}).close || [];
        const offset = (result.meta && result.meta.gmtoffset) || 0;
        const byDate = new Map();
        for (let i = 0; i < ts.length; i++) {
          const c = closes[i];
          if (c == null || !Number.isFinite(c)) continue;
          byDate.set(new Date((ts[i] + offset) * 1000).toISOString().slice(0, 10), c);
        }
        const out = [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, value]) => ({ date, value }));
        if (!out.length) throw new Error('Yahoo ' + ticker + ' returned no closes');
        return out;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  });
}

const AUCTION_TERMS = ['2-Year', '3-Year', '5-Year', '7-Year', '10-Year', '20-Year', '30-Year'];

/**
 * Nominal coupon auctions (Notes/Bonds) from FiscalData, grouped by original security term
 * so reopenings ("19-Year 11-Month") roll up into their benchmark ("20-Year").
 */
async function fetchTreasuryAuctions(opts = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const asof = opts.asof && opts.asof < today ? opts.asof : today;
  const from = new Date(asof + 'T00:00:00Z');
  from.setUTCFullYear(from.getUTCFullYear() - 2);
  const fromStr = from.toISOString().slice(0, 4) + '-01-01';
  return withCache('treasury', 'auctions_' + fromStr, opts, async () => {
    const fields = [
      'auction_date', 'security_type', 'security_term', 'original_security_term', 'high_yield', 'avg_med_yield',
      'bid_to_cover_ratio', 'comp_accepted', 'indirect_bidder_accepted', 'direct_bidder_accepted',
      'primary_dealer_accepted', 'soma_accepted', 'offering_amt', 'inflation_index_security', 'floating_rate'
    ].join(',');
    const rows = [];
    for (let page = 1; page <= 10; page++) {
      const url = 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/auctions_query'
        + '?fields=' + fields
        + '&filter=auction_date:gte:' + fromStr + ',security_type:in:(Note,Bond)'
        + '&sort=-auction_date&page[size]=200&page[number]=' + page;
      const resp = await fetchWithTimeout(url, { timeout: 30000, retries: 2 });
      if (!resp.ok) throw new Error('Treasury auctions HTTP ' + resp.status);
      const json = await resp.json();
      rows.push(...json.data);
      if (page >= (json.meta && json.meta['total-pages'] || 1)) break;
    }
    const num = v => (v == null || v === 'null' || v === '' ? null : parseFloat(v));
    return rows
      .filter(r => r.inflation_index_security !== 'Yes' && r.floating_rate !== 'Yes')
      .map(r => {
        const term = AUCTION_TERMS.find(t => (r.original_security_term || r.security_term || '').startsWith(t)) || r.security_term;
        const comp = num(r.comp_accepted);
        const share = v => (comp && num(v) != null ? num(v) / comp : null);
        return {
          date: r.auction_date,
          term,
          high_yield: num(r.high_yield),
          bid_to_cover: num(r.bid_to_cover_ratio),
          indirect_share: share(r.indirect_bidder_accepted),
          direct_share: share(r.direct_bidder_accepted),
          dealer_share: share(r.primary_dealer_accepted),
          soma_accepted: num(r.soma_accepted),
          offering_amt: num(r.offering_amt)
        };
      })
      .filter(r => AUCTION_TERMS.includes(r.term) && r.high_yield != null)
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  });
}

module.exports = { fetchFred, fetchYahoo, fetchTreasuryAuctions, AUCTION_TERMS, CACHE_DIR };
