'use strict';

// Pure adapters for public issuer disclosures. A URL to an SEC document is
// evidence *location*, not evidence that its contents were downloaded/verified.
const crypto = require('crypto');

const URLS = Object.freeze({
  ledger: 'https://www.strategy.com/ledger',
  shares: 'https://www.strategy.com/shares',
  capital: 'https://www.strategy.com/debt',
  press: 'https://www.strategy.com/press',
  submissions: 'https://data.sec.gov/submissions/CIK0001050446.json'
});
const SCHEMA_VERSION = 1;
const DAY = 86400000;
const hash = value => crypto.createHash('sha256').update(
  typeof value === 'string' ? value : JSON.stringify(value)
).digest('hex');

function requireValue(ok, message) {
  if (!ok) throw new Error(`MSTR disclosure: ${message}`);
}

function day(value, now = Date.now()) {
  requireValue(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value
    && value <= new Date(now).toISOString().slice(0, 10), `invalid/future date ${value}`);
  return value;
}

function number(value, label, { positive = false, nonnegative = false, optional = false } = {}) {
  if (optional && (value === null || value === undefined)) return null;
  requireValue(typeof value === 'number' && Number.isFinite(value)
    && (!positive || value > 0) && (!nonnegative || value >= 0), `invalid ${label}`);
  return value;
}

// Issuers may publish a disclosure dated one or two days "ahead" of the
// receipt clock (e.g. a Sunday post scanned Monday). Facts keep the issuer
// date; only absurdly forward dates are rejected.
const DISCLOSED_DAY_TOLERANCE_MS = 2 * DAY;

/** YYYY-MM-DD real calendar date with no clock restriction (maturities are
 * future by nature). */
function realDay(value, label) {
  requireValue(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString().slice(0, 10) === value,
    `invalid ${label} ${value}`);
  return value;
}

/** Optional realDay — null/undefined pass through as null. */
function optDay(value, label) {
  if (value === null || value === undefined) return null;
  return realDay(value, label);
}

/** YYYY-MM-DD date allowed to lead the receipt clock by at most 2 days. */
function disclosedDay(value, now, label) {
  const v = realDay(value, label);
  requireValue(Date.parse(v) <= now + DISCLOSED_DAY_TOLERANCE_MS, `future ${label} ${value}`);
  return v;
}

const EN_MONTHS = Object.freeze({
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
});

/** Press index dates render as 'October 12, 2026'. Parsed in UTC — never via
 * Date.parse, which would read the date in the host's local timezone. */
function englishDay(value, now) {
  const m = typeof value === 'string'
    && value.trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/);
  requireValue(m && EN_MONTHS[m[1].toLowerCase()] !== undefined, `invalid press date ${value}`);
  const year = Number(m[3]);
  const month = EN_MONTHS[m[1].toLowerCase()];
  const dom = Number(m[2]);
  const ms = Date.UTC(year, month, dom);
  const back = new Date(ms);
  requireValue(back.getUTCFullYear() === year && back.getUTCMonth() === month && back.getUTCDate() === dom
    && ms <= now + DISCLOSED_DAY_TOLERANCE_MS, `invalid/future press date ${value}`);
  return back.toISOString().slice(0, 10);
}

function nextProps(html, expectedPath) {
  requireValue(typeof html === 'string', 'HTML response missing');
  const match = html.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  requireValue(match, 'issuer page schema changed: __NEXT_DATA__ missing');
  const props = JSON.parse(match[1])?.props?.pageProps;
  requireValue(props && props.pageUrl === expectedPath, `unexpected issuer page: ${expectedPath}`);
  return props;
}

function evidenceUrl(value) {
  if (value === null || value === undefined) return null;
  let url;
  try { url = new URL(value); } catch { throw new Error('MSTR disclosure: invalid evidence URL'); }
  requireValue(url.protocol === 'https:' && !url.username && !url.password
    && (['www.sec.gov', 'www.strategy.com'].includes(url.hostname)
      || (url.hostname === 'assets.contentstack.io'
        && url.pathname.startsWith('/v3/assets/bltf8d808d9b8cebd37/'))), 'untrusted evidence URL');
  return url.href;
}

function sourceId(row, seen) {
  requireValue(row && typeof row.uid === 'string' && /^blt[a-z0-9]+$/i.test(row.uid),
    'issuer record ID missing');
  requireValue(!seen.has(row.uid), `duplicate issuer ID ${row.uid}`);
  seen.add(row.uid);
  return row.uid;
}

function parseStrategyLedger(html, now = Date.now()) {
  const rows = nextProps(html, '/ledger').bitcoinData;
  requireValue(Array.isArray(rows) && rows.length > 0, 'empty issuer ledger');
  const seen = new Set();
  const events = rows.map(row => {
    const id = `strategy-ledger:${sourceId(row, seen)}`;
    const deltaBtc = number(row.count, 'BTC transaction quantity');
    requireValue(row.sale === undefined || typeof row.sale === 'boolean', 'invalid sale flag');
    requireValue(row.sale === undefined || row.sale === (deltaBtc < 0), 'sale flag/quantity conflict');
    const transactionValue = number(row.total_purchase_price, 'transaction USD amount');
    requireValue(deltaBtc === 0 || transactionValue === 0
      || Math.sign(transactionValue) === Math.sign(deltaBtc), 'transaction amount/quantity sign conflict');
    const costMillions = number(row.total_acquisition_cost, 'aggregate cost ($M)', { optional: true, positive: true });
    const event = {
      id,
      type: deltaBtc < 0 ? 'BTC_SALE' : deltaBtc > 0 ? 'BTC_PURCHASE' : 'BTC_HOLDINGS_UPDATE',
      security: 'BTC',
      // The page labels this date "Reported". Never assume an execution date,
      // a midnight publication time, or "the preceding Sunday".
      reportedOn: day(row.date_of_purchase, now),
      holdingsAsOf: null,
      datePrecision: 'day',
      deltaBtc,
      transactionAverageUsd: number(row.purchase_price, 'transaction average price', { positive: true }),
      transactionCashUsd: Math.abs(transactionValue),
      holdingsBtc: number(row.btc_holdings, 'BTC holdings', { positive: true }),
      averageCostUsd: number(row.average_price, 'reported holding average cost', { positive: true }),
      aggregateCostUsd: costMillions === null ? null : costMillions * 1e6,
      basicShares: number(row.basic_shares_outstanding, 'ledger basic shares', { positive: true, optional: true }),
      assumedDilutedShares: number(row.assumed_diluted_shares_outstanding, 'ledger ADSO', { positive: true, optional: true }),
      source: 'strategy_ledger',
      sourceUrl: URLS.ledger,
      documentUrl: evidenceUrl(row.sec?.url),
      confirmation: 'issuer_reported',
      secContentsVerified: false,
      sourceRevision: number(row._version, 'source revision', { positive: true }),
      order: number(row.row_index, 'ledger row index', { nonnegative: true, optional: true }),
      issues: []
    };
    // The issuer rounds aggregate cost to $1M and average cost to $1.
    // Compare intervals implied by that published precision, not exact
    // floating-point products. Never replace the reported average with ours.
    if (event.aggregateCostUsd !== null) {
      const tolerance = 5e5 + event.holdingsBtc * 0.5 + event.averageCostUsd * 0.5 + 0.25;
      if (Math.abs(event.aggregateCostUsd - event.holdingsBtc * event.averageCostUsd) > tolerance) {
        event.issues.push('reported_cost_does_not_reconcile');
      }
    }
    return event;
  }).sort((a, b) => a.reportedOn.localeCompare(b.reportedOn)
    || (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));

  for (let i = 1; i < events.length; i++) {
    const event = events[i];
    // Each of the three independently published quantities is rounded to
    // whole BTC: the maximum combined rounding interval is 1.5 BTC.
    if (Math.abs(event.holdingsBtc - events[i - 1].holdingsBtc - event.deltaBtc) > 1.5) {
      event.issues.push('holdings_movement_does_not_reconcile');
    }
  }
  for (const event of events) {
    event.fingerprint = hash(event);
  }
  return { events, latest: events[events.length - 1], rawHash: hash(html) };
}

function parseStrategyShares(html, now = Date.now()) {
  const rows = nextProps(html, '/shares').shares;
  requireValue(Array.isArray(rows) && rows.length > 0, 'empty issuer share history');
  const seen = new Set();
  const snapshots = rows.map(row => {
    const id = `strategy-shares:${sourceId(row, seen)}`;
    const inShares = (key, optional = false) => {
      const v = number(row[key], key, { nonnegative: true, optional });
      return v === null ? null : v * 1000; // /shares reports '000s; /ledger reports shares.
    };
    const snapshot = {
      id,
      asOf: day(row.date, now),
      source: 'strategy_shares',
      sourceUrl: URLS.shares,
      confirmation: 'issuer_reported',
      basicShares: inShares('basic_shares_outstanding'),
      classAShares: inShares('class_a'),
      classBShares: inShares('class_b'),
      assumedDilutedShares: inShares('assumed_diluted_shares_outstanding'),
      fullyDilutedShares: null, // ADSO is not FDSO; do not substitute.
      optionsShares: inShares('options_outstanding', true),
      unvestedAwardShares: inShares('rsu_psu_unvested', true),
      holdingsBtc: number(row.total_bitcoin_holdings, 'share table BTC holdings', { positive: true }),
      sourceRevision: number(row._version, 'source revision', { positive: true }),
      issues: []
    };
    if (snapshot.basicShares <= 0 || snapshot.assumedDilutedShares < snapshot.basicShares
        || Math.abs(snapshot.classAShares + snapshot.classBShares - snapshot.basicShares) > 1500) {
      snapshot.issues.push('share_classes_do_not_reconcile');
    }
    snapshot.fingerprint = hash(snapshot);
    return snapshot;
  }).sort((a, b) => a.asOf.localeCompare(b.asOf) || a.id.localeCompare(b.id));
  return { snapshots, latest: snapshots[snapshots.length - 1], rawHash: hash(html) };
}

function parseSecSubmissions(text, now = Date.now()) {
  const json = typeof text === 'string' ? JSON.parse(text) : text;
  requireValue(json && Number(json.cik) === 1050446
    && typeof json.name === 'string' && /strategy/i.test(json.name), 'wrong SEC issuer');
  const recent = json.filings?.recent;
  const keys = ['accessionNumber', 'filingDate', 'form', 'primaryDocument', 'acceptanceDateTime'];
  requireValue(recent && keys.every(k => Array.isArray(recent[k]))
    && recent.accessionNumber.length > 0
    && keys.every(k => recent[k].length === recent.accessionNumber.length), 'SEC index columns changed');
  const seen = new Set();
  const filings = [];
  for (let i = 0; i < recent.accessionNumber.length; i++) {
    const accession = recent.accessionNumber[i];
    requireValue(typeof accession === 'string' && /^\d{10}-\d{2}-\d{6}$/.test(accession)
      && !seen.has(accession), 'invalid/duplicate SEC accession');
    seen.add(accession);
    const filedOn = day(recent.filingDate[i], now);
    const form = recent.form[i];
    requireValue(typeof form === 'string' && form.length > 0, 'SEC form missing');
    if (!/^(8-K|10-Q|10-K)(\/A)?$|^424B\d$|^S-3(ASR)?(\/A)?$/.test(form)) continue;
    const document = recent.primaryDocument[i];
    requireValue(typeof document === 'string' && /^[a-z0-9_.-]+\.(htm|html)$/i.test(document)
      && !document.includes('..'), 'unsafe SEC document name');
    const acceptedAt = recent.acceptanceDateTime[i];
    requireValue(typeof acceptedAt === 'string' && /Z$|[+-]\d{2}:\d{2}$/.test(acceptedAt)
      && Number.isFinite(Date.parse(acceptedAt)) && Date.parse(acceptedAt) <= now + 300000,
    'invalid SEC acceptance timestamp');
    filings.push({
      id: `sec:${accession}`,
      accession,
      form,
      filedOn,
      acceptedAt: new Date(acceptedAt).toISOString(),
      documentUrl: `https://www.sec.gov/Archives/edgar/data/1050446/${accession.replace(/-/g, '')}/${document}`,
      source: 'sec_submissions',
      // This adapter parses the *index*, not the financial document.
      status: 'contents_not_verified',
      isAmendment: form.endsWith('/A')
    });
  }
  filings.sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt) || b.id.localeCompare(a.id));
  return { filings, rawHash: hash(typeof text === 'string' ? text : json) };
}

// Preferred metrics keys the issuer embeds on the /debt stats row.
const CAPITAL_PREF_KEYS = Object.freeze(['strc', 'strd', 'stre', 'strf', 'strk']);

function optionalNonnegative(value, label) {
  return number(value, label, { optional: true, nonnegative: true });
}

/** One capital snapshot per mstrStats row — each row is keyed by its own
 * issuer as_of_date, so history accumulates exactly like events do. */
function capitalSnapshotFrom(row, instruments, now, isCurrent) {
  requireValue(row && typeof row === 'object', 'issuer capital stats row invalid');
  const sh = row.shares && typeof row.shares === 'object' ? row.shares : {};
  const asOf = disclosedDay(row.as_of_date, now, 'capital as_of_date');
  const snapshot = {
    id: `strategy-capital:${asOf}`,
    asOf,
    cashUsd: number(row.cash, 'capital cash', { nonnegative: true }),
    debtUsd: number(row.debt, 'capital debt', { nonnegative: true }),
    prefUsd: number(row.pref, 'capital preferred', { nonnegative: true }),
    operatingCashUsd: optionalNonnegative(row.operating_cash, 'capital operating cash'),
    // The issuer publishes annual_dividends in USD millions; stored verbatim
    // (no unit guessing) — the UI is responsible for labelling the unit.
    annualDividendsUsd: optionalNonnegative(row.annual_dividends, 'capital annual dividends'),
    commonEquityRaisedUsd: optionalNonnegative(row.common_equity_raised, 'capital common equity raised'),
    preferredEquityRaisedUsd: optionalNonnegative(row.preferred_equity_raised, 'capital preferred equity raised'),
    btcHoldings: number(row.btc_holdings, 'capital BTC holdings', { positive: true }),
    basicShares: number(row.basic_shares_outstanding, 'capital basic shares', { positive: true }),
    debtYears: optionalNonnegative(row.debt_years, 'capital debt years'),
    sharesComponents: {
      convert2028: optionalNonnegative(sh.convert_2028, 'shares convert_2028'),
      convert2029: optionalNonnegative(sh.convert_2029, 'shares convert_2029'),
      convert2030A: optionalNonnegative(sh.convert_2030_a, 'shares convert_2030_a'),
      convert2030B: optionalNonnegative(sh.convert_2030_b, 'shares convert_2030_b'),
      convert2031: optionalNonnegative(sh.convert_2031, 'shares convert_2031'),
      convert2032: optionalNonnegative(sh.convert_2032, 'shares convert_2032'),
      convertStrk: optionalNonnegative(sh.convert_strk, 'shares convert_strk'),
      optionsOutstanding: optionalNonnegative(sh.options_outstanding, 'shares options_outstanding'),
      rsuPsuUnvested: optionalNonnegative(sh.rsu_psu_unvested, 'shares rsu_psu_unvested')
    },
    source: 'strategy_capital',
    sourceUrl: URLS.capital,
    confirmation: 'issuer_reported',
    sourceRevision: number(row._version, 'capital stats revision', { positive: true }),
    issues: []
  };
  if (isCurrent) {
    const sum = instruments.reduce((a, i) => a + i.notionalUsd, 0);
    if (Math.abs(sum - snapshot.debtUsd) > Math.max(1_000_000, 0.01 * snapshot.debtUsd)) {
      snapshot.issues.push('debt_notional_reconcile_gap');
    }
  }
  snapshot.fingerprint = hash(snapshot);
  return snapshot;
}

function debtInstrumentFrom(row, seen) {
  requireValue(row && typeof row === 'object', 'issuer debt row invalid');
  const uid = sourceId(row, seen);
  requireValue(typeof row.title === 'string' && row.title.trim().length > 0, 'debt instrument title missing');
  const inst = {
    id: `strategy-debt:${uid}`,
    uid,
    name: row.title,
    notionalUsd: number(row.notional, 'debt notional', { positive: true }),
    couponPct: number(row.coupon, 'debt coupon', { nonnegative: true }),
    strikeUsd: number(row.strike_price, 'debt strike', { positive: true }),
    issueDate: realDay(row.issue_date, 'debt issue_date'),
    maturityDate: realDay(row.maturity_date, 'debt maturity_date'),
    putDate: optDay(row.put_date, 'debt put_date'),
    earliestCallDate: optDay(row.earliest_call_date, 'debt earliest_call_date'),
    lastTradedPrice: number(row.last_traded_price, 'debt last traded price', { optional: true, positive: true }),
    lastTradeDate: optDay(row.last_trade_date, 'debt last_trade_date'),
    marketValueUsd: number(row.market_value, 'debt market value', { optional: true, nonnegative: true }),
    averageBtcPriceUsd: number(row.average_bitcoin_price, 'debt average BTC price', { optional: true, nonnegative: true }),
    source: 'strategy_capital',
    sourceUrl: URLS.capital,
    confirmation: 'issuer_reported',
    sourceRevision: number(row._version, 'debt row revision', { positive: true }),
    issues: []
  };
  inst.fingerprint = hash(inst);
  return inst;
}

function preferredTermFrom(key, metrics, revision) {
  requireValue(metrics && typeof metrics === 'object', `issuer ${key} metrics invalid`);
  const ticker = key.toUpperCase();
  const pref = {
    id: `strategy-pref:${ticker}`,
    ticker,
    dividendPct: number(metrics.dividend, `${key} dividend`, { nonnegative: true }),
    nextPayoutDate: optDay(metrics.next_payout_date, `${key} next_payout_date`),
    nextRecordDate: optDay(metrics.next_record_date, `${key} next_record_date`),
    transitionDividendRate: optionalNonnegative(metrics.transition_dividend_rate, `${key} transition rate`),
    sharesOutstanding: optionalNonnegative(metrics.shares, `${key} shares`),
    // Issuer fields kept verbatim — no unit guessing. notional_intl is the
    // issuer's international notional (STRE is euro-denominated);
    // current_fx_rate is the issuer-published FX rate for that leg.
    notionalIntl: optionalNonnegative(metrics.notional_intl, `${key} notional_intl`),
    fxRate: optionalNonnegative(metrics.current_fx_rate, `${key} fx rate`),
    cumulativeNotionalUsd: optionalNonnegative(metrics.cumulative_notional, `${key} cumulative notional`),
    source: 'strategy_capital',
    sourceUrl: URLS.capital,
    confirmation: 'issuer_reported',
    sourceRevision: revision,
    issues: []
  };
  pref.fingerprint = hash(pref);
  return pref;
}

/**
 * /debt — issuer capital structure: the dated stats row(s), the convertible
 * debt table and the preferred-stock terms. All facts are issuer-reported;
 * the only derived value is the debt-notional reconciliation issue.
 */
function parseStrategyCapital(html, now = Date.now()) {
  const props = nextProps(html, '/debt');
  const stats = props.mstrStats;
  const converts = props.convertData;
  requireValue(Array.isArray(converts) && converts.length > 0, 'empty issuer debt table');
  requireValue(Array.isArray(stats) && stats.length > 0, 'issuer capital stats missing');

  const seenInst = new Set();
  const debtInstruments = converts.map(row => debtInstrumentFrom(row, seenInst))
    .sort((a, b) => a.maturityDate.localeCompare(b.maturityDate) || a.id.localeCompare(b.id));

  // The issuer flags the current stats row; without a flag the newest
  // as_of_date is the only honest fallback. Every row still validates.
  const sorted = [...stats].sort((a, b) => String(b && b.as_of_date).localeCompare(String(a && a.as_of_date)));
  const current = stats.filter(r => r && r.latest === true)
    .sort((a, b) => String(b.as_of_date).localeCompare(String(a.as_of_date)))[0] || sorted[0];

  const seenAsOf = new Set();
  const capitalSnapshots = stats.map(row => {
    const snapshot = capitalSnapshotFrom(row, debtInstruments, now, row === current);
    requireValue(!seenAsOf.has(snapshot.asOf), `duplicate capital as_of_date ${snapshot.asOf}`);
    seenAsOf.add(snapshot.asOf);
    return snapshot;
  }).sort((a, b) => a.asOf.localeCompare(b.asOf) || a.id.localeCompare(b.id));

  // Preferred terms belong to the current stats row only — they describe
  // today's capital structure, not the history of past snapshots.
  const preferredTerms = [];
  for (const key of CAPITAL_PREF_KEYS) {
    if (current[`${key}_metrics`] === undefined || current[`${key}_metrics`] === null) continue;
    preferredTerms.push(preferredTermFrom(key, current[`${key}_metrics`], current._version));
  }
  preferredTerms.sort((a, b) => a.ticker.localeCompare(b.ticker));

  return { capitalSnapshots, debtInstruments, preferredTerms, rawHash: hash(html) };
}

/** Press index URLs are relative paths on the issuer site; absolute URLs are
 * only trusted on the two issuer hosts. Anything else is dropped to null —
 * the discovery record itself stays valid. */
function pressUrl(value) {
  requireValue(typeof value === 'string' && value.length > 0, 'press release URL missing');
  if (value.startsWith('/')) {
    requireValue(!value.startsWith('//') && !/[\r\n]/.test(value), 'unsafe press release URL');
    return `https://www.strategy.com${value}`;
  }
  try {
    const u = new URL(value);
    if (u.protocol === 'https:' && !u.username && !u.password
        && (u.hostname === 'www.strategy.com' || u.hostname === 'ir.strategy.com')) {
      return u.href;
    }
  } catch (err) { /* not a URL at all */ }
  return null;
}

/**
 * Title-only event discovery. Titles are discovery signals, never facts —
 * no dollar amounts, BTC quantities or dates are extracted from them.
 */
function classifyPressTitle(title) {
  const kinds = new Set();
  if (/acquires|acquisition|purchas/i.test(title) && /btc|bitcoin/i.test(title)) {
    kinds.add('BTC_PURCHASE');
  }
  if (/repurchas|buyback/i.test(title) && /strc/i.test(title)) {
    kinds.add('STRC_REPURCHASE');
  }
  if (/(strc|strd|strf|strk|stre)\b/i.test(title)
      && /ipo|offering|pricing|at-the-market|atm|launch|proposed/i.test(title)) {
    kinds.add('PREFERRED_CAPITAL');
  }
  if (/dividend/i.test(title)) kinds.add('DIVIDEND_POLICY');
  // A repurchase whose only classification is STRC is equity capital, not debt.
  if (/debt|convertible|notes|repurchase.*debt|debt.*repurchase/i.test(title)
      && !(kinds.size === 1 && kinds.has('STRC_REPURCHASE'))) {
    kinds.add('DEBT_CAPITAL');
  }
  if (/financial results|earnings/i.test(title)) kinds.add('EARNINGS');
  if (!kinds.size && /(strc|strd|strf|strk|stre|bitcoin|btc)/i.test(title)) {
    kinds.add('OTHER_MENTION');
  }
  return [...kinds];
}

/** /press — the issuer press index. Announcements are discovery records:
 * they prove a release exists at a URL on a date, nothing more. */
function parseStrategyPress(html, now = Date.now()) {
  const list = nextProps(html, '/press').releaseList;
  requireValue(Array.isArray(list) && list.length > 0, 'empty issuer press index');
  const seen = new Set();
  const announcements = list.map(row => {
    requireValue(row && typeof row === 'object', 'issuer press row invalid');
    const uid = sourceId(row, seen);
    requireValue(typeof row.title === 'string' && row.title.trim().length > 0, 'press title missing');
    const rec = {
      id: `strategy-press:${uid}`,
      uid,
      title: row.title,
      publishedOn: englishDay(row.publication_date, now),
      type: typeof row.publication_type === 'string' && row.publication_type.length > 0
        ? row.publication_type : 'Press Release',
      url: pressUrl(row.url),
      updatedAt: typeof row.updated_at === 'string' && Number.isFinite(Date.parse(row.updated_at))
        ? row.updated_at : null,
      kinds: classifyPressTitle(row.title),
      source: 'strategy_press',
      sourceUrl: URLS.press,
      confirmation: 'issuer_reported',
      issues: []
    };
    rec.fingerprint = hash(rec);
    return rec;
  }).sort((a, b) => b.publishedOn.localeCompare(a.publishedOn) || b.id.localeCompare(a.id));
  return { announcements, rawHash: hash(html) };
}

/**
 * Cross-source reconciliation between the capital snapshot, the latest
 * ledger event and the latest share snapshot. Issues are warnings only —
 * reported figures are never rewritten.
 */
function reconcileCapital(capital, latestEvent, shares) {
  if (!capital) return [];
  const issues = [...(capital.issues || [])];
  if (latestEvent) {
    if (capital.asOf < latestEvent.reportedOn) {
      issues.push('capital_asof_lags_ledger');
    } else if (capital.btcHoldings !== latestEvent.holdingsBtc) {
      issues.push('capital_holdings_conflict');
    }
  }
  // /shares reports basic shares in thousands (exact count unavailable);
  // |diff| <= 999 is page-resolution noise, not a real conflict.
  if (shares && capital.asOf >= shares.asOf
      && Math.abs(capital.basicShares - shares.basicShares) > 999) {
    issues.push('capital_shares_conflict');
  }
  return issues;
}

function mergeRevisions(previous = [], incoming, observedAt, { requireCompleteHistory = true } = {}) {
  requireValue(Array.isArray(previous) && Array.isArray(incoming), 'invalid revision history');
  const active = new Map(previous.filter(e => !e.supersededAt).map(e => [e.id, e]));
  const incomingIds = new Set(incoming.map(e => e.id));
  if (requireCompleteHistory) {
    requireValue([...active.keys()].every(id => incomingIds.has(id)),
      'issuer history regressed or records disappeared; retain last verified snapshot');
  }
  const result = previous.map(e => ({ ...e }));
  for (const next of incoming) {
    const old = active.get(next.id);
    if (old?.fingerprint === next.fingerprint) continue;
    if (old) {
      requireValue(next.sourceRevision >= old.sourceRevision, 'source revision regressed');
      const index = result.findIndex(e => e.id === old.id && !e.supersededAt);
      result[index] = { ...result[index], supersededAt: observedAt, supersededBy: next.fingerprint };
    }
    result.push({ ...next, firstObservedAt: observedAt, supersededAt: null });
  }
  return result;
}

function latestActive(records, dateField) {
  return (records || []).filter(e => !e.supersededAt).sort((a, b) =>
    a[dateField].localeCompare(b[dateField]) || (a.order ?? 0) - (b.order ?? 0)
    || a.id.localeCompare(b.id)).pop() || null;
}

function reconcileLatest(ledger, shares) {
  if (!ledger || !shares) return [];
  // Different cutoffs normally describe different positions. Only compare
  // the latest share snapshot with the contemporaneous disclosure window;
  // still expose BOTH dates instead of silently aligning them.
  const gap = Date.parse(ledger.reportedOn) - Date.parse(shares.asOf);
  if (gap < 0 || gap > DAY) return ['share_snapshot_has_different_cutoff'];
  const issues = [];
  if (Math.abs(ledger.holdingsBtc - shares.holdingsBtc) > 1) issues.push('issuer_holdings_conflict');
  if (ledger.basicShares !== null && Math.abs(ledger.basicShares - shares.basicShares) > 500) {
    issues.push('issuer_basic_shares_conflict');
  }
  return issues;
}

module.exports = {
  URLS, SCHEMA_VERSION, hash, parseStrategyLedger, parseStrategyShares,
  parseSecSubmissions, parseStrategyCapital, parseStrategyPress,
  mergeRevisions, latestActive, reconcileLatest, reconcileCapital
};
