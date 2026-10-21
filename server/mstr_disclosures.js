'use strict';

/**
 * MSTR official disclosure collector (Module 1 milestone 2).
 *
 * Reads five sources sequentially, on demand:
 *   - Strategy issuer BTC ledger   (/ledger page, issuer-reported events)
 *   - Strategy issuer share table  (/shares page, basic/ADSO — never FDSO)
 *   - Strategy issuer capital page (/debt page — capital snapshot, convertible
 *                                  debt instruments, preferred-stock terms)
 *   - Strategy issuer press index  (/press page — title-level release
 *                                  discovery only; bodies are NOT fetched or
 *                                  verified and no amounts are read from titles)
 *   - SEC submissions index        (filing *discovery* only — document bodies
 *                                  are NOT fetched or verified here)
 *
 * Truth rules:
 *   - Evidence first: every response body is hashed and persisted under
 *     data/mstr_disclosure_evidence/<sha256>.json BEFORE its parsed result is
 *     accepted. If evidence or state persistence fails, the attempt is a
 *     failure — the health registry only gets recordSuccess after the
 *     snapshot commit lands.
 *   - Revisioned records: mergeRevisions keeps superseded copies; a regressed
 *     source revision or truncated history rejects the whole update, keeping
 *     the previously verified snapshot.
 *   - Clocks: receipts are scan RECEIPT times (asOfKind 'received'); reported
 *     holdings/shares dates stay on the facts themselves and are never moved
 *     to now. Disk loads only seedCachedHealth (FALLBACK-bound), never
 *     recordSuccess.
 *   - Fail-closed: HTTP errors (incl. 403 — never retried/spoofed), schema
 *     drift, oversized bodies and a missing SEC identity all leave prior
 *     events/shares/filings and their success clocks untouched.
 *   - Official mNAV (methodology 2026-07-23, server/mstr_mnav.js): after the
 *     five evidence scans, market inputs (Yahoo MSTR share price + Coinbase
 *     BTC-USD ticker — the methodology's specified BTC venue) are fetched in
 *     an isolated failure domain and the derived result is stored under
 *     state.mnav. A price-input failure never fails the disclosure sources;
 *     mnav is derived output, not evidence — it is persisted with the state
 *     but is never fingerprinted or added to the evidence map.
 *   - No timers/fetches at import time; no background loop here — the owning
 *     runtime schedules get().
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fetchWithTimeout } = require('./http_client');
const { fetchCoinbaseTickerAndStats } = require('./coinbase_fetcher');
const { atomicWriteJson, withDataHealth, seedCachedHealth } = require('./data_health_cache');
const { recordAttempt, recordSuccess, recordFailure } = require('./data_health');
const { computeOfficialMnav } = require('./mstr_mnav');
const {
  URLS, SCHEMA_VERSION, hash,
  parseStrategyLedger, parseStrategyShares, parseSecSubmissions,
  parseStrategyCapital, parseStrategyPress,
  mergeRevisions, latestActive, reconcileLatest, reconcileCapital
} = require('./mstr_disclosure_model');

const {
  PARSER_VERSION: SEC_PARSER_VERSION, XBRL_CONCEPTS, SEC_ARCHIVE_PREFIX,
  parseSecEightK, parseXbrlConcept, deriveSecCapital
} = require('./mstr_sec_model');

const SOURCE_IDS = [
  'mstr_official_ledger', 'mstr_official_shares', 'mstr_official_capital',
  'mstr_official_press', 'mstr_sec_index', 'mstr_mnav_inputs'
];
const MNAV_ID = 'mstr_mnav_inputs';
// SEC 8-K bodies (+ XBRL cross-checks). Kept out of SOURCE_IDS, which remains
// the issuer-path contract; ALL_SOURCE_IDS covers persistence/health seeding.
const SEC_FILINGS_ID = 'mstr_sec_filings';
const ALL_SOURCE_IDS = [...SOURCE_IDS, SEC_FILINGS_ID];
// When the SEC path supplies the capital snapshot, these are the sources the
// payload actually depends on; issuer pages become optional.
const SEC_PATH_IDS = ['mstr_sec_index', SEC_FILINGS_ID, MNAV_ID];
const REFERENCE_FILE = path.join(__dirname, '..', 'data', 'mstr_capital_reference.json');
const SEC_RECENT_8K = 20;          // newest weekly 8-Ks (holdings, USD, flows)
const SEC_RATE_LOOKBACK_DAYS = 460; // month-end 8-Ks carry STRC rate announcements
const SEC_MAX_NEW_DOCS = 40;       // bound one scan's EDGAR requests
const SEC_SPACING_MS = 150;        // well under SEC's 10 requests/second
const XBRL_REFRESH_MS = 24 * 60 * 60 * 1000;
const POLL_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const STRATEGY_UA = 'BIGDY-Dashboard/1.0 (+https://github.com/Bigdydydy/BIGDY-CRY-PTO-Dashboard)';
const SEC_UA_MESSAGE = 'SEC_USER_AGENT must identify the application and a real contact email';
const SEC_UA_SHAPE = /\S+@\S+\.\S+/;

// Official-mNAV market inputs. MSTR share price comes from the same Yahoo
// Finance chart endpoint macro_fetcher/mstr_preferreds already poll; BTC is
// priced on Coinbase Exchange — the venue the issuer methodology specifies.
const YAHOO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
const YAHOO_MSTR_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/MSTR?range=5d&interval=1d';

const iso = ms => new Date(ms).toISOString();
const sha256 = body => crypto.createHash('sha256').update(body).digest('hex');
const isIso = v => typeof v === 'string' && Number.isFinite(Date.parse(v));

/** The fetched sources, in collection order. SEC + press are discovery-only. */
const SOURCES = [
  { id: SOURCE_IDS[0], url: URLS.ledger, parse: parseStrategyLedger, sec: false },
  { id: SOURCE_IDS[1], url: URLS.shares, parse: parseStrategyShares, sec: false },
  { id: SOURCE_IDS[2], url: URLS.capital, parse: parseStrategyCapital, sec: false },
  { id: SOURCE_IDS[3], url: URLS.press, parse: parseStrategyPress, sec: false },
  { id: SOURCE_IDS[4], url: URLS.submissions, parse: parseSecSubmissions, sec: true }
];

function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    events: [],
    shareSnapshots: [],
    capitalSnapshots: [],
    debtInstruments: [],
    preferredTerms: [],
    announcements: [],
    filings: [],
    evidence: {},
    mnav: null, // derived official-mNAV record — never evidence, never fingerprinted
    secDocs: {}, // accession -> parsed 8-K record (body sha256 kept; body itself is evidence)
    secXbrl: null, // { fetchedAt, longTermDebt, optionsOutstanding } cross-check facts
    dataHealth: { sources: {} },
    lastAttemptAt: null,
    lastCompletedAt: null
  };
}

/** Recompute a record fingerprint: hash of the record minus the four
 * service-managed fields (mirrors the model's record hash). */
function fingerprintOf(record) {
  const c = { ...record };
  delete c.fingerprint;
  delete c.firstObservedAt;
  delete c.supersededAt;
  delete c.supersededBy;
  return hash(c);
}

/**
 * Validate a persisted snapshot before trusting it. Returns null when valid,
 * else a reason string — an invalid cache is rejected, never healed.
 */
function validatePersisted(state, nowMs) {
  if (!state || typeof state !== 'object') return 'snapshot not an object';
  if (state.schemaVersion !== SCHEMA_VERSION) return 'unsupported schemaVersion';
  // Milestone-2 record groups are absent from v1-era snapshots; backfill to
  // empty so an older verified file still loads instead of being discarded.
  for (const key of ['capitalSnapshots', 'debtInstruments', 'preferredTerms', 'announcements']) {
    if (state[key] === undefined) state[key] = [];
  }
  for (const key of ['events', 'shareSnapshots', 'filings',
    'capitalSnapshots', 'debtInstruments', 'preferredTerms', 'announcements']) {
    if (!Array.isArray(state[key])) return `${key} is not an array`;
  }
  if (state.lastAttemptAt !== null && !isIso(state.lastAttemptAt)) return 'invalid lastAttemptAt';
  if (state.lastCompletedAt !== null && !isIso(state.lastCompletedAt)) return 'invalid lastCompletedAt';
  if (state.evidence !== undefined && (state.evidence === null || typeof state.evidence !== 'object')) {
    return 'evidence map invalid';
  }
  // mnav is a derived record, not evidence: optional; when present it must be
  // a plain object. Recomputed on the next scan, so no deeper validation.
  if (state.mnav !== undefined && state.mnav !== null
      && (typeof state.mnav !== 'object' || Array.isArray(state.mnav))) {
    return 'mnav record invalid';
  }
  // SEC 8-K records arrived after v1 snapshots: backfill, then validate shape.
  if (state.secDocs === undefined) state.secDocs = {};
  if (state.secXbrl === undefined) state.secXbrl = null;
  if (!state.secDocs || typeof state.secDocs !== 'object' || Array.isArray(state.secDocs)) return 'secDocs invalid';
  for (const [acc, d] of Object.entries(state.secDocs)) {
    if (!/^\d{10}-\d{2}-\d{6}$/.test(acc) || !d || d.accession !== acc
        || !Array.isArray(d.holdings) || !Array.isArray(d.flows) || !Array.isArray(d.issues)
        || typeof d.filedOn !== 'string' || typeof d.documentUrl !== 'string'
        || !d.documentUrl.startsWith(SEC_ARCHIVE_PREFIX)) {
      return `secDocs record ${acc} invalid`;
    }
  }
  if (state.secXbrl !== null && (typeof state.secXbrl !== 'object' || !isIso(state.secXbrl.fetchedAt))) {
    return 'secXbrl record invalid';
  }
  if (state.requiredSources !== undefined && (!Array.isArray(state.requiredSources)
      || !state.requiredSources.every(id => ALL_SOURCE_IDS.includes(id)))) {
    return 'requiredSources invalid';
  }
  const sources = state.dataHealth && state.dataHealth.sources;
  if (!sources || typeof sources !== 'object') return 'dataHealth.sources missing';
  for (const id of ALL_SOURCE_IDS) {
    const r = sources[id];
    if (r === undefined) continue;
    if (!r || typeof r !== 'object') return `source record ${id} invalid`;
    for (const f of ['lastSuccessAt', 'dataAsOf', 'lastAttemptAt']) {
      const v = r[f];
      if (v === undefined || v === null) continue;
      if (!isIso(v) || Date.parse(v) > nowMs + 300000) return `source record ${id}.${f} untrusted`;
    }
  }
  for (const key of ['events', 'shareSnapshots',
    'capitalSnapshots', 'debtInstruments', 'preferredTerms', 'announcements']) {
    const active = new Set();
    for (const rec of state[key]) {
      if (!rec || typeof rec.fingerprint !== 'string' || fingerprintOf(rec) !== rec.fingerprint) {
        return `${key} record hash mismatch`;
      }
      if (!rec.supersededAt) {
        if (active.has(rec.id)) return `${key} duplicate active revision ${rec.id}`;
        active.add(rec.id);
      }
    }
  }
  for (const f of state.filings) {
    if (!f || typeof f.accession !== 'string' || !/^\d{10}-\d{2}-\d{6}$/.test(f.accession)) {
      return 'filing record invalid';
    }
  }
  return null;
}

/** Failure text must never carry the endpoint URL or any identity header. */
function sanitizeError(err, url, ua) {
  let msg = err && err.message ? String(err.message) : String(err);
  if (url && msg.includes(url)) msg = msg.split(url).join('<endpoint>');
  if (ua && msg.includes(ua)) msg = msg.split(ua).join('<identity>');
  return msg;
}

const isPosNum = v => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * Default market-input provider for the official mNAV overlay.
 *  - MSTR: latest positive close from the Yahoo Finance daily chart endpoint
 *    — the same fetch shape macro_fetcher/mstr_preferreds use (module-level
 *    `mstrSource: 'yahoo'` records that provenance verbatim).
 *  - BTC: the Coinbase Exchange BTC-USD ticker via the shared
 *    coinbase_fetcher helper — the venue named by the issuer methodology.
 * Both legs must succeed for the provider to return at all; leg failures
 * throw so the caller records a single mnav-input failure.
 */
async function defaultMnavPrices() {
  const [mstrResp, coinbase] = await Promise.all([
    fetchWithTimeout(YAHOO_MSTR_CHART_URL, {
      timeout: 15000,
      retries: 1,
      headers: { Accept: 'application/json', 'User-Agent': YAHOO_UA }
    }),
    fetchCoinbaseTickerAndStats()
  ]);
  if (!mstrResp || !mstrResp.ok) {
    throw new Error(`Yahoo MSTR HTTP ${mstrResp ? mstrResp.status : 'no response'}`);
  }
  const chart = await mstrResp.json();
  const res0 = chart && chart.chart && Array.isArray(chart.chart.result)
    ? chart.chart.result[0] : null;
  const ts = res0 && res0.timestamp;
  const closes = res0 && res0.indicators && res0.indicators.quote
    && res0.indicators.quote[0] && res0.indicators.quote[0].close;
  let mstrPriceUsd = null;
  let mstrMs = null;
  if (Array.isArray(ts) && Array.isArray(closes)) {
    for (let i = Math.min(ts.length, closes.length) - 1; i >= 0; i--) {
      if (isPosNum(closes[i]) && Number.isFinite(ts[i])) {
        mstrPriceUsd = closes[i];
        mstrMs = ts[i] * 1000;
        break;
      }
    }
  }
  const ticker = coinbase && coinbase.ticker;
  const btcPriceUsd = ticker ? Number(ticker.price) : NaN;
  const btcMs = ticker && Number.isFinite(Date.parse(ticker.time))
    ? Date.parse(ticker.time) : null;
  const stamps = [mstrMs, btcMs].filter(Number.isFinite);
  return {
    mstrPriceUsd,
    btcPriceUsd: Number.isFinite(btcPriceUsd) ? btcPriceUsd : null,
    btcSource: 'coinbase',
    mstrSource: 'yahoo',
    priceAsOfIso: stamps.length ? iso(Math.max(...stamps)) : null
  };
}

function createDisclosureService({
  dataDir = path.join(__dirname, '..', 'data'),
  request = fetchWithTimeout,
  clock = Date.now,
  secUserAgent = () => process.env.SEC_USER_AGENT || '',
  prices = defaultMnavPrices,
  capitalReference = () => {
    try { return JSON.parse(fs.readFileSync(REFERENCE_FILE, 'utf8')); } catch (err) { return null; }
  },
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  const stateFile = path.join(dataDir, 'mstr_disclosures.json');
  const evidenceDir = path.join(dataDir, 'mstr_disclosure_evidence');

  let loaded = false;
  let inflight = null;
  let state = emptyState();
  const cacheIssues = [];

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch (err) {
      return; // missing/unreadable file -> cold start, no complaint
    }
    const invalid = validatePersisted(parsed, clock());
    if (invalid) {
      cacheIssues.push(`mstr_disclosures.json rejected: ${invalid}`);
      return; // cold state; never seed health from an untrusted file
    }
    state = parsed;
    for (const id of ALL_SOURCE_IDS) {
      const rec = state.dataHealth.sources[id];
      if (rec) state.dataHealth.sources[id] = { ...rec, source: 'disk' }; // disk-bound receipt -> FALLBACK, never fresh
      seedCachedHealth(state, id);
    }
  }

  function writeEvidence(digest, record) {
    fs.mkdirSync(evidenceDir, { recursive: true });
    const file = path.join(evidenceDir, `${digest}.json`);
    if (fs.existsSync(file)) {
      try {
        const prior = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (prior && prior.sha256 === digest) return; // immutable, already held
      } catch (err) { /* corrupt evidence for this hash — rewrite below */ }
    }
    atomicWriteJson(file, record, 0);
  }

  function issuesFor(records, dateField) {
    return records.filter(r => !r.supersededAt)
      .flatMap(r => (r.issues || []).map(i => `${r.id} ${r[dateField]}: ${i}`));
  }

  /** Fold a parsed source result into a staged next state (no mutation). */
  function applyParsed(prev, src, parsed, digest, observedAt) {
    const next = { ...prev, dataHealth: { ...prev.dataHealth, sources: { ...prev.dataHealth.sources } },
      evidence: { ...prev.evidence } };
    let issues = [];
    if (src.id === SOURCE_IDS[0]) {
      next.events = mergeRevisions(prev.events, parsed.events, observedAt, { requireCompleteHistory: true });
      for (const e of parsed.events) {
        if (!next.evidence[e.fingerprint]) {
          next.evidence[e.fingerprint] = { sourceUrl: src.url, sha256: digest, firstObservedAt: observedAt };
        }
      }
      issues = issuesFor(next.events, 'reportedOn');
    } else if (src.id === SOURCE_IDS[1]) {
      next.shareSnapshots = mergeRevisions(prev.shareSnapshots, parsed.snapshots, observedAt, { requireCompleteHistory: true });
      for (const s of parsed.snapshots) {
        if (!next.evidence[s.fingerprint]) {
          next.evidence[s.fingerprint] = { sourceUrl: src.url, sha256: digest, firstObservedAt: observedAt };
        }
      }
      issues = issuesFor(next.shareSnapshots, 'asOf');
    } else if (src.id === SOURCE_IDS[2]) {
      // Capital snapshots keep full history (keyed on asOf, like events);
      // instruments and preferred terms may legitimately disappear from the
      // page when redeemed/matured, so they are not required to be a
      // superset of the previously verified rows.
      next.capitalSnapshots = mergeRevisions(prev.capitalSnapshots, parsed.capitalSnapshots, observedAt, { requireCompleteHistory: true });
      next.debtInstruments = mergeRevisions(prev.debtInstruments, parsed.debtInstruments, observedAt, { requireCompleteHistory: false });
      next.preferredTerms = mergeRevisions(prev.preferredTerms, parsed.preferredTerms, observedAt, { requireCompleteHistory: false });
      for (const r of [...parsed.capitalSnapshots, ...parsed.debtInstruments, ...parsed.preferredTerms]) {
        if (!next.evidence[r.fingerprint]) {
          next.evidence[r.fingerprint] = { sourceUrl: src.url, sha256: digest, firstObservedAt: observedAt };
        }
      }
      issues = [
        ...issuesFor(next.capitalSnapshots, 'asOf'),
        ...issuesFor(next.debtInstruments, 'maturityDate'),
        ...issuesFor(next.preferredTerms, 'ticker')
      ];
    } else if (src.id === SOURCE_IDS[3]) {
      // The press index is a sliding discovery window like the SEC index:
      // union by uid — releases that age out of the index stay in history.
      const byUid = new Map(prev.announcements.map(a => [a.uid, a]));
      for (const a of parsed.announcements) byUid.set(a.uid, a);
      next.announcements = [...byUid.values()]
        .sort((a, b) => b.publishedOn.localeCompare(a.publishedOn) || b.id.localeCompare(a.id));
      for (const a of parsed.announcements) {
        if (!next.evidence[a.fingerprint]) {
          next.evidence[a.fingerprint] = { sourceUrl: src.url, sha256: digest, firstObservedAt: observedAt };
        }
      }
      issues = issuesFor(next.announcements, 'publishedOn');
    } else {
      // SEC recent index is a sliding discovery window: union by accession;
      // filings that age out of `recent` stay in our history.
      const byAccession = new Map(prev.filings.map(f => [f.accession, f]));
      for (const f of parsed.filings) byAccession.set(f.accession, f);
      next.filings = [...byAccession.values()]
        .sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt) || b.id.localeCompare(a.id));
      issues = [];
    }
    return { next, issues };
  }

  function successRecord(nowIso, url, issues) {
    return {
      lastAttemptAt: nowIso, lastSuccessAt: nowIso, dataAsOf: nowIso,
      asOfKind: 'received', source: url, lastError: null,
      consecutiveFailures: 0, issues, available: true
    };
  }

  function failureRecord(prev, nowIso, message) {
    return {
      lastAttemptAt: nowIso,
      lastSuccessAt: prev && prev.lastSuccessAt !== undefined ? prev.lastSuccessAt : null,
      dataAsOf: prev && prev.dataAsOf !== undefined ? prev.dataAsOf : null,
      asOfKind: prev && prev.asOfKind !== undefined ? prev.asOfKind : null,
      source: prev && prev.source !== undefined ? prev.source : null,
      lastError: message,
      consecutiveFailures: (prev && prev.consecutiveFailures || 0) + 1,
      issues: prev && Array.isArray(prev.issues) ? prev.issues : [],
      available: prev && prev.available !== undefined ? prev.available : false
    };
  }

  /** Persist a state object; callers decide whether failure aborts the step. */
  function commitState(next) {
    atomicWriteJson(stateFile, next, 2);
    state = next;
  }

  async function collectSource(src, nowMs) {
    const nowIso = iso(nowMs);
    recordAttempt(src.id, { now: nowMs });
    let ua = null;
    try {
      if (src.sec) {
        ua = secUserAgent();
        if (typeof ua !== 'string' || !SEC_UA_SHAPE.test(ua)) {
          throw new Error(SEC_UA_MESSAGE); // never request without a real identity
        }
      }
      const resp = await request(src.url, {
        timeout: 15000,
        retries: 1,
        headers: {
          Accept: 'text/html,application/json',
          'User-Agent': src.sec ? ua : STRATEGY_UA
        }
      });
      if (!resp || !resp.ok) throw new Error(`HTTP ${resp ? resp.status : 'no response'}`);
      const declared = resp.headers && typeof resp.headers.get === 'function'
        ? Number(resp.headers.get('content-length')) : NaN;
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        throw new Error('response exceeds 5 MB limit');
      }
      const body = await resp.text();
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
        throw new Error('response exceeds 5 MB limit');
      }
      const digest = sha256(body);
      // Evidence lands before the parsed result is accepted.
      writeEvidence(digest, { sourceUrl: src.url, receivedAt: nowIso, sha256: digest, body });
      const parsed = src.parse(body, nowMs);
      const { next, issues } = applyParsed(state, src, parsed, digest, nowIso);
      next.dataHealth.sources[src.id] = successRecord(nowIso, src.url, issues);
      // Publish the registry success only after the snapshot commit lands.
      commitState(next);
      recordSuccess(src.id, { now: nowMs, dataAsOf: nowIso, asOfKind: 'received', source: src.url, issues });
      return true;
    } catch (err) {
      const message = sanitizeError(err, src.url, ua);
      recordFailure(src.id, message, { now: nowMs });
      // Persist the failed metadata if disk permits; never rejuvenate the
      // source's old success clock in file or memory.
      const next = { ...state, dataHealth: { ...state.dataHealth, sources: { ...state.dataHealth.sources } } };
      next.dataHealth.sources[src.id] = failureRecord(state.dataHealth.sources[src.id], nowIso, message);
      // Persist the failed metadata if disk permits; the in-memory failure is
      // kept either way so the view never silently rejuvenates.
      try { commitState(next); } catch (e) { state = next; }
      return false;
    }
  }

  /**
   * 8-K bodies discovered by the SEC index. Picks the newest weekly 8-Ks plus
   * month-end 8-Ks (STRC rate announcements) not yet parsed with the current
   * parser, fetches them sequentially with SEC_SPACING_MS between requests,
   * hashes each body into evidence, and stores the parsed record. Already
   * parsed accessions are never refetched. XBRL cross-check concepts refresh
   * at most daily; their failure is an issue, not a source failure.
   */
  function sec8kCandidates(nowMs) {
    const eightKs = state.filings.filter(f => /^8-K(\/A)?$/.test(f.form)
      && typeof f.documentUrl === 'string' && f.documentUrl.startsWith(SEC_ARCHIVE_PREFIX));
    const recent = eightKs.slice(0, SEC_RECENT_8K);
    const cutoff = iso(nowMs - SEC_RATE_LOOKBACK_DAYS * 86400000).slice(0, 10);
    const monthEnd = eightKs.filter(f => {
      const d = Number(f.filedOn.slice(8, 10));
      return f.filedOn >= cutoff && (d >= 28 || d <= 2);
    });
    const picked = new Map();
    for (const f of [...recent, ...monthEnd]) picked.set(f.accession, f);
    return [...picked.values()].filter(f => {
      const have = state.secDocs[f.accession];
      return !have || have.parserVersion !== SEC_PARSER_VERSION;
    }).slice(0, SEC_MAX_NEW_DOCS);
  }

  async function secGet(url, ua, accept) {
    const resp = await request(url, { timeout: 20000, retries: 1, headers: { Accept: accept, 'User-Agent': ua } });
    if (!resp || !resp.ok) throw new Error(`HTTP ${resp ? resp.status : 'no response'}`);
    const body = await resp.text();
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) throw new Error('response exceeds 5 MB limit');
    return body;
  }

  async function collectSecFilings(nowMs) {
    const nowIso = iso(nowMs);
    recordAttempt(SEC_FILINGS_ID, { now: nowMs });
    let ua = null;
    try {
      ua = secUserAgent();
      if (typeof ua !== 'string' || !SEC_UA_SHAPE.test(ua)) throw new Error(SEC_UA_MESSAGE);
      const secDocs = { ...state.secDocs };
      const failures = [];
      let first = true;
      for (const f of sec8kCandidates(nowMs)) {
        if (!first) await sleep(SEC_SPACING_MS);
        first = false;
        try {
          const body = await secGet(f.documentUrl, ua, 'text/html');
          const digest = sha256(body);
          writeEvidence(digest, { sourceUrl: f.documentUrl, receivedAt: nowIso, sha256: digest, body });
          secDocs[f.accession] = parseSecEightK(body, f);
        } catch (err) {
          failures.push(`${f.accession}: ${sanitizeError(err, f.documentUrl, ua)}`);
        }
      }
      const issues = [];
      let secXbrl = state.secXbrl;
      if (!secXbrl || nowMs - Date.parse(secXbrl.fetchedAt) >= XBRL_REFRESH_MS) {
        try {
          await sleep(SEC_SPACING_MS);
          const longTermDebt = parseXbrlConcept(await secGet(XBRL_CONCEPTS.longTermDebt, ua, 'application/json'), 'USD');
          await sleep(SEC_SPACING_MS);
          const optionsOutstanding = parseXbrlConcept(await secGet(XBRL_CONCEPTS.optionsOutstanding, ua, 'application/json'), 'shares');
          secXbrl = { fetchedAt: nowIso, longTermDebt, optionsOutstanding };
        } catch (err) {
          issues.push(`xbrl_unavailable: ${sanitizeError(err, null, ua)}`);
        }
      }
      const next = { ...state, secDocs, secXbrl, dataHealth: { ...state.dataHealth, sources: { ...state.dataHealth.sources } } };
      for (const d of Object.values(secDocs)) for (const i of d.issues) issues.push(`${d.accession}: ${i}`);
      if (failures.length) {
        // Parsed documents are still kept (each is evidence-backed); the
        // source records the failure so the success clock never advances.
        const message = `8-K fetch failed for ${failures.length} document(s): ${failures.slice(0, 3).join('; ')}`;
        next.dataHealth.sources[SEC_FILINGS_ID] = failureRecord(state.dataHealth.sources[SEC_FILINGS_ID], nowIso, message);
        try { commitState(next); } catch (e) { state = next; }
        recordFailure(SEC_FILINGS_ID, message, { now: nowMs });
        return false;
      }
      next.dataHealth.sources[SEC_FILINGS_ID] = successRecord(nowIso, URLS.submissions, issues);
      commitState(next);
      recordSuccess(SEC_FILINGS_ID, { now: nowMs, dataAsOf: nowIso, asOfKind: 'received', source: URLS.submissions, issues });
      return true;
    } catch (err) {
      const message = sanitizeError(err, null, ua);
      recordFailure(SEC_FILINGS_ID, message, { now: nowMs });
      const next = { ...state, dataHealth: { ...state.dataHealth, sources: { ...state.dataHealth.sources } } };
      next.dataHealth.sources[SEC_FILINGS_ID] = failureRecord(state.dataHealth.sources[SEC_FILINGS_ID], nowIso, message);
      try { commitState(next); } catch (e) { state = next; }
      return false;
    }
  }

  /**
   * Capital path: the issuer /debt snapshot when it is at least as recent as
   * the SEC-derived one, else the SEC path (8-K facts + issuer reference
   * terms rolled forward). Pure over current state.
   */
  function capitalPath(nowMs) {
    const sec = deriveSecCapital({
      reference: capitalReference(),
      docs: Object.values(state.secDocs || {}),
      xbrl: state.secXbrl || {},
      today: iso(nowMs).slice(0, 10)
    });
    const issuerCapital = latestActive(state.capitalSnapshots, 'asOf');
    const useSec = !!(sec && sec.capital) && (!issuerCapital || sec.capital.asOf > issuerCapital.asOf);
    if (useSec) {
      return {
        source: 'sec', sec,
        capital: sec.capital, instruments: sec.instruments, preferreds: sec.preferreds, shares: sec.shares
      };
    }
    return {
      source: issuerCapital ? 'issuer' : 'none', sec,
      capital: issuerCapital,
      instruments: state.debtInstruments.filter(i => !i.supersededAt),
      preferreds: state.preferredTerms.filter(x => !x.supersededAt),
      shares: latestActive(state.shareSnapshots, 'asOf')
    };
  }

  /**
   * Milestone 3 overlay: fetch market inputs and compute the official
   * (2026-07-23) mNAV from the currently accepted disclosures. This is an
   * isolated failure domain — a price-feed outage or an incomplete capital
   * snapshot records `mstr_mnav_inputs` as failed and leaves every
   * disclosure source and any previously stored mnav record untouched.
   * The derived record is persisted with state but is not evidence and is
   * never fingerprinted.
   */
  async function collectMnavInputs(nowMs) {
    const nowIso = iso(nowMs);
    recordAttempt(MNAV_ID, { now: nowMs });
    try {
      const px = await prices();
      const p = px && typeof px === 'object' ? px : {};
      const mstrPriceUsd = isPosNum(p.mstrPriceUsd) ? p.mstrPriceUsd : null;
      const btcPriceUsd = isPosNum(p.btcPriceUsd) ? p.btcPriceUsd : null;
      const priceAsOf = isIso(p.priceAsOfIso)
        && Date.parse(p.priceAsOfIso) <= nowMs + 300000 ? p.priceAsOfIso : null;
      const issues = [];
      const pathIn = capitalPath(nowMs);
      // Methodology "USD Assets" = USD Reserve + USD Cash. The issuer stats
      // row reports the reserve as `cash` and USD Cash as `operating_cash`
      // (8-K 2026-10-19: reserve $4.83B, cash $447.3M); the SEC path already
      // sums both into cashUsd.
      let capitalIn = pathIn.capital;
      if (capitalIn && pathIn.source === 'issuer' && isPosNum(capitalIn.operatingCashUsd)) {
        capitalIn = { ...capitalIn, cashUsd: capitalIn.cashUsd + capitalIn.operatingCashUsd };
      }
      const result = computeOfficialMnav({
        mstrPriceUsd,
        btcPriceUsd,
        capital: capitalIn,
        instruments: pathIn.instruments,
        preferreds: pathIn.preferreds,
        shares: pathIn.shares,
        issues
      });
      const sourceLabel = [p.mstrSource, p.btcSource]
        .filter(s => typeof s === 'string' && s.length > 0).join('+') || null;
      const mnav = {
        computedAt: nowIso,
        priceAsOf,
        mstrPriceUsd,
        btcPriceUsd,
        btcSource: typeof p.btcSource === 'string' ? p.btcSource : null,
        mstrSource: typeof p.mstrSource === 'string' ? p.mstrSource : null,
        capitalSource: pathIn.source,
        capitalAsOf: pathIn.capital ? pathIn.capital.asOf : null,
        result,
        issues: [...issues]
      };
      const ok = result !== null && mstrPriceUsd !== null && btcPriceUsd !== null;
      const next = { ...state, mnav, dataHealth: { ...state.dataHealth, sources: { ...state.dataHealth.sources } } };
      if (ok) {
        next.dataHealth.sources[MNAV_ID] = successRecord(nowIso, sourceLabel, issues);
        // Publish the registry success only after the snapshot commit lands.
        commitState(next);
        recordSuccess(MNAV_ID, {
          now: nowMs, dataAsOf: priceAsOf || nowIso, asOfKind: 'received',
          source: sourceLabel, issues
        });
      } else {
        const message = issues.join('; ') || 'official mNAV inputs incomplete';
        next.dataHealth.sources[MNAV_ID] = failureRecord(state.dataHealth.sources[MNAV_ID], nowIso, message);
        try { commitState(next); } catch (e) { state = next; }
        recordFailure(MNAV_ID, message, { now: nowMs });
      }
      return ok;
    } catch (err) {
      const message = sanitizeError(err, null, null);
      recordFailure(MNAV_ID, message, { now: nowMs });
      const next = { ...state, dataHealth: { ...state.dataHealth, sources: { ...state.dataHealth.sources } } };
      next.dataHealth.sources[MNAV_ID] = failureRecord(state.dataHealth.sources[MNAV_ID], nowIso, message);
      try { commitState(next); } catch (e) { state = next; }
      return false;
    }
  }

  async function collect() {
    const started = clock();
    state = { ...state, lastAttemptAt: iso(started) };
    const results = [];
    for (const src of SOURCES) results.push(await collectSource(src, started));
    // 8-K bodies need the freshly merged SEC index; skipped (and recorded as
    // failed) without an SEC identity, exactly like the index itself.
    const secOk = await collectSecFilings(started);
    // Derived mNAV runs after the evidence scans; its failure does not gate
    // lastCompletedAt, which remains the evidence-scan receipt.
    await collectMnavInputs(started);
    // Completion follows the capital path in use: the five issuer+index
    // scans on the issuer path, or the SEC index + 8-K scan on the SEC path.
    const secIndexOk = results[SOURCES.findIndex(s => s.sec)];
    const onSecPath = capitalPath(started).source === 'sec';
    const complete = onSecPath ? secIndexOk && secOk : results.every(Boolean);
    const requiredSources = onSecPath ? SEC_PATH_IDS : SOURCE_IDS;
    state = { ...state, requiredSources: [...requiredSources] };
    try { commitState(state); } catch (e) { /* in-memory marker still set */ }
    if (complete) {
      // lastCompletedAt = last FULLY accepted scan — doubles as the
      // success-bound aggregate clock the producer step consumes.
      const next = { ...state, lastCompletedAt: iso(clock()) };
      try { commitState(next); } catch (e) { /* in-memory marker still set */
        state = next;
      }
    }
    return view();
  }

  function view() {
    const events = state.events.filter(e => !e.supersededAt)
      .sort((a, b) => b.reportedOn.localeCompare(a.reportedOn)
        || (b.order ?? 0) - (a.order ?? 0) || b.id.localeCompare(a.id));
    const filings = [...state.filings]
      .sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt) || b.id.localeCompare(a.id));
    const cp = capitalPath(clock());
    const sec = cp.sec;
    const issuerLatest = latestActive(state.events, 'reportedOn');
    const secLatest = sec && sec.events.length ? sec.events[sec.events.length - 1] : null;
    // Holdings: the issuer ledger when it is at least as new as the 8-Ks.
    const useSecEvents = !!secLatest && (!issuerLatest || secLatest.reportedOn > issuerLatest.reportedOn);
    const latest = useSecEvents ? secLatest : issuerLatest;
    const viewEvents = useSecEvents ? [...sec.events].reverse() : events;
    const shares = cp.shares;
    const capital = cp.capital;
    const instruments = [...(cp.instruments || [])]
      .sort((a, b) => a.maturityDate.localeCompare(b.maturityDate) || a.id.localeCompare(b.id));
    const preferreds = [...(cp.preferreds || [])]
      .sort((a, b) => a.ticker.localeCompare(b.ticker) || a.id.localeCompare(b.id));
    const announcements = [...state.announcements]
      .sort((a, b) => b.publishedOn.localeCompare(a.publishedOn) || b.id.localeCompare(a.id))
      .slice(0, 60);
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      lastAttemptAt: state.lastAttemptAt,
      lastCompletedAt: state.lastCompletedAt,
      latest,
      shares,
      capital,
      instruments,
      preferreds,
      events: viewEvents,
      capitalSource: cp.source,
      holdingsSource: useSecEvents ? 'sec_8k' : (issuerLatest ? 'issuer' : 'none'),
      // STRC regular-rate schedule from 8-K announcements (oldest first).
      strcRateSchedule: sec ? sec.strcRateSchedule : [],
      sec: {
        documentsParsed: Object.keys(state.secDocs || {}).length,
        capitalIssues: sec ? sec.issues : [],
        provenance: sec && sec.capital ? sec.capital.provenance : null,
        xbrl: state.secXbrl || null
      },
      revisionCount: state.events.filter(e => e.supersededAt).length,
      filings: filings.slice(0, 30),
      announcements,
      officialMnav: state.mnav || null,
      reconciliationIssues: [
        ...reconcileLatest(latest, shares),
        ...reconcileCapital(capital, latest, shares)
      ],
      coverage: {
        btc: !latest ? 'unavailable' : useSecEvents ? 'sec_8k' : 'issuer_reported',
        shares: !shares ? 'unavailable' : cp.source === 'sec' ? 'sec_8k_rolled_reference' : 'issuer_reported',
        sec: Object.keys(state.secDocs || {}).length ? '8k_parsed' : (state.filings.length ? 'index_only' : 'unavailable'),
        strc: sec && sec.strcRateSchedule.length ? 'sec_8k_rate_schedule' : 'announcements_only',
        capitalStructure: !capital ? 'unavailable' : cp.source === 'sec' ? 'sec_8k+issuer_reference' : 'issuer_reported',
        officialMnav: state.mnav && state.mnav.result && state.mnav.result.mnav != null
          ? 'computed' : 'not_computed'
      },
      evidence: state.evidence || {},
      cacheIssues: cacheIssues.length ? [...cacheIssues] : undefined,
      dataHealth: { sources: state.dataHealth.sources }
    };
    // Health follows the capital path in use. On the SEC path the issuer
    // pages are optional: reported separately, never degrading the payload.
    const required = cp.source === 'sec' ? SEC_PATH_IDS : SOURCE_IDS;
    const optional = ALL_SOURCE_IDS.filter(id => !required.includes(id));
    // Bound to this payload's persisted receipts — never borrows a fresher
    // sibling registry clock for an older accepted snapshot.
    const out = withDataHealth(payload, required);
    out.optionalSources = withDataHealth({ dataHealth: { sources: state.dataHealth.sources } }, optional).dataHealth.sources;
    return out;
  }

  async function get(force = false) {
    ensureLoaded();
    const nowMs = clock();
    const lastAttempt = state.lastAttemptAt ? Date.parse(state.lastAttemptAt) : null;
    const cooling = lastAttempt !== null && nowMs - lastAttempt < POLL_MS;
    if (!force && cooling) return view();
    if (!inflight) {
      inflight = collect().finally(() => { inflight = null; });
    }
    return inflight;
  }

  async function peek() {
    ensureLoaded();
    return view();
  }

  return { get, peek };
}

const service = createDisclosureService();

module.exports = {
  SOURCE_IDS,
  SEC_FILINGS_ID,
  ALL_SOURCE_IDS,
  SEC_PATH_IDS,
  POLL_MS,
  createDisclosureService,
  getMstrDisclosures: service.get,
  peekMstrDisclosures: service.peek
};
