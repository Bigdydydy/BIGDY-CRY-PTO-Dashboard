'use strict';

/**
 * SEC EDGAR adapters for Strategy (MSTR) disclosures — pure functions, no I/O.
 *
 * Strategy files an 8-K almost every Monday (Items 7.01/8.01) carrying:
 *   - "BTC Update": aggregate holdings, aggregate cost ($B) and average cost
 *     as of the period end (purchase, sale, combined and prose layouts all
 *     occur — only the as-of triple is read, period columns are not);
 *   - "USD Reserve and USD Cash" balances;
 *   - "ATM Update" / repurchase tables: shares sold / repurchased per security;
 *   - month-end "Dividend Rate on ... Stretch Preferred Stock" announcements.
 *
 * XBRL company concepts (quarterly 10-Q/10-K) are cross-checks only: they
 * carry no per-series preferred or per-note convertible data.
 *
 * Static capital terms (convert notionals/strikes, preferred counts, dilutive
 * share components) come from data/mstr_capital_reference.json — issuer data
 * captured from strategy.com with evidence hashes — and are rolled forward
 * with the 8-K ATM/repurchase flows reported after the reference cutoff.
 *
 * Nothing here guesses: an unrecognised layout yields no record plus an
 * issue, never an inferred number.
 */

const crypto = require('crypto');

const PARSER_VERSION = 1;
const CIK = '0001050446';
const SEC_ARCHIVE_PREFIX = 'https://www.sec.gov/Archives/edgar/data/1050446/';
const XBRL_CONCEPTS = Object.freeze({
  longTermDebt: 'https://data.sec.gov/api/xbrl/companyconcept/CIK0001050446/us-gaap/LongTermDebt.json',
  optionsOutstanding: 'https://data.sec.gov/api/xbrl/companyconcept/CIK0001050446/us-gaap/'
    + 'ShareBasedCompensationArrangementByShareBasedPaymentAwardOptionsOutstandingNumber.json'
});
const TICKERS = ['STRF', 'STRC', 'STRK', 'STRD', 'STRE', 'MSTR'];
const PREF_TICKERS = ['STRC', 'STRD', 'STRE', 'STRF', 'STRK'];
const MONTHS = {
  January: 1, February: 2, March: 3, April: 4, May: 5, June: 6, July: 7,
  August: 8, September: 9, October: 10, November: 11, December: 12
};
const DATE_RE = '([A-Z][a-z]+ \\d{1,2}, \\d{4})';
// Section headings that end a block when slicing the flattened 8-K text.
const SECTION_END = /\b(?:BTC Updates?|ATM Update|USD Reserve(?: and USD Cash)? Updates?|Repurchase Program Updates?|(?:Adjustment to )?Dividend Rate on|Cash Dividend Declaration|Conditional Cash Dividend Declaration|Item \d\.\d{2})\b/g;

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const num = s => Number(String(s).replace(/,/g, ''));

/** "October 18, 2026" -> "2026-10-18"; null when not a real calendar day. */
function isoDay(text) {
  const m = /^([A-Z][a-z]+) (\d{1,2}), (\d{4})$/.exec(String(text).trim());
  if (!m || !MONTHS[m[1]]) return null;
  const iso = `${m[3]}-${String(MONTHS[m[1]]).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso ? iso : null;
}

/** Flatten filing HTML to single-spaced text (tables become token runs). */
function htmlToText(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#8217;|&rsquo;|&#x2019;/gi, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;|&#x201c;|&#x201d;|&quot;/gi, '"')
    .replace(/&#8212;|&#8211;|&mdash;|&ndash;|&#x2014;|&#x2013;/gi, '-')
    .replace(/&#?[a-z0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Text of the section starting at `start`, up to the next section heading. */
function sectionFrom(text, start, maxLen = 4000) {
  SECTION_END.lastIndex = start + 12;
  const m = SECTION_END.exec(text);
  const end = m && m.index - start < maxLen ? m.index : start + maxLen;
  return text.slice(start, end);
}

function lastDateBefore(text, pos, pattern) {
  const re = new RegExp(pattern, 'g');
  let found = null;
  let m;
  while ((m = re.exec(text)) && m.index < pos) found = isoDay(m[1]);
  return found;
}

/** Aggregate holdings triples from the BTC Update section(s). */
function parseHoldings(text, issues) {
  const out = [];
  const starts = [];
  const re = /\bBTC Updates?\b/g;
  let m;
  while ((m = re.exec(text))) starts.push(m.index);
  for (const start of starts) {
    const seg = sectionFrom(text, start, 3000);
    // Table layouts: "<holdings> $ <aggregate $B> $ <average>"
    const triple = /(\d{1,3}(?:,\d{3}){1,2})\s*\$\s*(\d{1,3}\.\d{1,2})\s*\$\s*(\d{1,3},\d{3})\b/g;
    let t;
    while ((t = triple.exec(seg))) {
      const holdings = num(t[1]);
      if (holdings < 100000) continue; // a period quantity, not aggregate holdings
      const asOf = lastDateBefore(seg, t.index, `As of ${DATE_RE}`);
      out.push({ asOf, holdingsBtc: holdings, aggregateCostUsd: Math.round(num(t[2]) * 1e9), averageCostUsd: num(t[3]) });
    }
    // Prose layout: "holds approximately N bitcoin that were acquired at an
    // aggregate purchase price of $X billion and an average purchase price of
    // approximately $Y per bitcoin"
    const prose = /holds? (?:approximately )?(\d{1,3}(?:,\d{3}){1,2}) bitcoins? (?:that were )?acquired at an aggregate purchase price of (?:approximately )?\$(\d{1,3}(?:\.\d{1,2})?) billion and an average purchase price of (?:approximately )?\$(\d{1,3},\d{3})/g;
    while ((t = prose.exec(seg))) {
      const asOf = lastDateBefore(seg, t.index, `As of ${DATE_RE}`);
      out.push({ asOf, holdingsBtc: num(t[1]), aggregateCostUsd: Math.round(num(t[2]) * 1e9), averageCostUsd: num(t[3]) });
    }
  }
  const valid = [];
  for (const h of out) {
    if (!h.asOf) { issues.push('btc_holdings_without_asof'); continue; }
    // Aggregate ($0.01B precision) and average (whole $) must agree.
    if (Math.abs(h.aggregateCostUsd - h.holdingsBtc * h.averageCostUsd) > 0.006e9 + h.holdingsBtc) {
      issues.push(`btc_cost_does_not_reconcile:${h.asOf}`);
      continue;
    }
    if (!valid.some(v => v.asOf === h.asOf && v.holdingsBtc === h.holdingsBtc)) valid.push(h);
  }
  if (starts.length && !valid.length) issues.push('btc_update_unparsed');
  return valid;
}

/** "As of <date>, the balances of the USD Reserve and USD Cash were $X billion and $Y million" */
function parseUsdBalances(text, issues) {
  const both = new RegExp(`As of ${DATE_RE}, the balances of the USD Reserve and USD Cash were \\$(\\d+(?:\\.\\d+)?) (billion|million) and \\$(\\d+(?:\\.\\d+)?) (billion|million)`, 'i');
  const scale = u => (u.toLowerCase() === 'billion' ? 1e9 : 1e6);
  const m = both.exec(text);
  if (m) {
    return {
      asOf: isoDay(m[1]),
      usdReserveUsd: Math.round(Number(m[2]) * scale(m[3])),
      usdCashUsd: Math.round(Number(m[4]) * scale(m[5]))
    };
  }
  // List layout: "were as follows: USD Reserve: $X billion USD Cash: $Y billion"
  const list = new RegExp(`As of ${DATE_RE}, the balances of the USD Reserve and USD Cash were as follows: USD Reserve: \\$(\\d+(?:\\.\\d+)?) (billion|million) USD Cash: \\$(\\d+(?:\\.\\d+)?) (billion|million)`, 'i').exec(text);
  if (list) {
    return {
      asOf: isoDay(list[1]),
      usdReserveUsd: Math.round(Number(list[2]) * scale(list[3])),
      usdCashUsd: Math.round(Number(list[4]) * scale(list[5]))
    };
  }
  // Before USD Cash was disclosed separately: reserve only.
  const reserve = new RegExp(`As of ${DATE_RE}, the balance of the USD Reserve (?:is|was) \\$(\\d+(?:\\.\\d+)?) (billion|million)`, 'i').exec(text);
  if (reserve) {
    return { asOf: isoDay(reserve[1]), usdReserveUsd: Math.round(Number(reserve[2]) * scale(reserve[3])), usdCashUsd: null };
  }
  if (/balances? of the USD Reserve/i.test(text)) issues.push('usd_balances_unparsed');
  return null;
}

/** Month-end STRC dividend-rate announcement. */
function parseStrcRate(text, issues) {
  const head = /(?:Adjustment to )?Dividend Rate on Variable Rate Series A Perpetual Stretch Preferred Stock On /.exec(text);
  if (!head) return null;
  const para = text.slice(head.index, head.index + 900).replace(/^.*?Preferred Stock (?=On )/, '');
  const announced = new RegExp(`^On ${DATE_RE}`).exec(para);
  const effective = new RegExp(`(?:commencing on or after|record dates on or after|record dates from) ${DATE_RE}`).exec(para);
  const fromTo = /from (\d{1,2}\.\d{2})% to (\d{1,2}\.\d{2})%/.exec(para);
  const at = /\b(?:at|to|will be) (\d{1,2}\.\d{2})%/.exec(para);
  const ratePct = fromTo ? Number(fromTo[2]) : (at ? Number(at[1]) : null);
  if (!announced || ratePct === null) {
    issues.push('strc_rate_unparsed');
    return null;
  }
  const action = /\bmaintain/i.test(para.slice(0, 260)) ? 'maintain'
    : /\b(?:increase|increased)\b/i.test(para.slice(0, 260)) ? 'increase'
      : /\b(?:decrease|decreased|reduce|reduced)\b/i.test(para.slice(0, 260)) ? 'decrease' : 'set';
  const out = {
    announcedOn: isoDay(announced[1]),
    effectiveFrom: effective ? isoDay(effective[1]) : null,
    ratePct,
    previousPct: fromTo ? Number(fromTo[1]) : null,
    action,
    conditional: /if the Contingent Dividend Condition/i.test(para.slice(0, 300))
  };
  if (!out.effectiveFrom) issues.push('strc_rate_without_effective_date');
  return out;
}

/** Shares sold (ATM) / repurchased per security, per reporting period. */
function parseFlows(text) {
  const flows = [];
  const blocks = [
    { kind: 'atm', start: /ATM Update/g },
    { kind: 'repurchase', start: /share repurchase programs? of the following securities/g }
  ];
  for (const { kind, start } of blocks) {
    let s;
    while ((s = start.exec(text))) {
      const seg = sectionFrom(text, s.index, 6000);
      const periods = [...seg.matchAll(new RegExp(`During Period ${DATE_RE} to ${DATE_RE}`, 'g'))];
      periods.forEach((p, i) => {
        const body = seg.slice(p.index, i + 1 < periods.length ? periods[i + 1].index : seg.length);
        const shares = {};
        const row = new RegExp(`\\b(${TICKERS.join('|')}) Stock(?: \\(\\d+\\))? (-|\\d{1,3}(?:,\\d{3})*)(?= )`, 'g');
        let r;
        while ((r = row.exec(body))) {
          if (shares[r[1]] !== undefined) continue; // first row per security
          shares[r[1]] = r[2] === '-' ? 0 : num(r[2]);
        }
        if (Object.keys(shares).length) {
          flows.push({ kind, periodStart: isoDay(p[1]), periodEnd: isoDay(p[2]), shares });
        }
      });
    }
  }
  return flows;
}

/**
 * Parse one 8-K primary document. `filing` = { accession, filedOn, documentUrl }.
 * Returns a cacheable record; documents without any recognised section are
 * valid (exec changes, earnings) and simply carry nothing.
 */
function parseSecEightK(html, filing) {
  const text = htmlToText(html);
  const issues = [];
  const holdings = parseHoldings(text, issues);
  const usd = parseUsdBalances(text, issues);
  const strcRate = parseStrcRate(text, issues);
  const flows = parseFlows(text);
  return {
    accession: filing.accession,
    filedOn: filing.filedOn,
    documentUrl: filing.documentUrl,
    sha256: sha256(String(html)),
    parserVersion: PARSER_VERSION,
    holdings,
    usd,
    strcRate: strcRate ? { ...strcRate, accession: filing.accession, documentUrl: filing.documentUrl } : null,
    flows,
    issues
  };
}

/** Latest fact from an XBRL companyconcept payload (by period end, then filing). */
function parseXbrlConcept(text, unit) {
  const json = typeof text === 'string' ? JSON.parse(text) : text;
  if (!json || Number(json.cik) !== Number(CIK) || !json.units || !Array.isArray(json.units[unit])) {
    throw new Error('XBRL concept payload malformed');
  }
  const facts = json.units[unit].filter(f => f && typeof f.end === 'string' && Number.isFinite(f.val)
    && /^10-[QK]/.test(String(f.form)));
  if (!facts.length) throw new Error('XBRL concept has no 10-Q/10-K facts');
  facts.sort((a, b) => a.end.localeCompare(b.end) || String(a.filed).localeCompare(String(b.filed)));
  const f = facts[facts.length - 1];
  return { value: f.val, periodEnd: f.end, filedOn: f.filed, form: f.form, accession: f.accn || null };
}

/**
 * STRC rate schedule from parsed 8-Ks: one entry per effective date (latest
 * announcement wins), plus the pre-history rate implied by the earliest
 * "from X% to Y%" announcement (flagged inferred).
 */
function buildStrcRateSchedule(docs) {
  const byEffective = new Map();
  for (const d of docs) {
    const r = d && d.strcRate;
    if (!r || !r.effectiveFrom) continue;
    const prev = byEffective.get(r.effectiveFrom);
    if (!prev || r.announcedOn > prev.announcedOn) byEffective.set(r.effectiveFrom, r);
  }
  const schedule = [...byEffective.values()].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const first = schedule[0];
  if (first && first.previousPct !== null) {
    schedule.unshift({
      announcedOn: null, effectiveFrom: null, ratePct: first.previousPct, previousPct: null,
      action: 'inferred_prior', conditional: false, inferred: true,
      accession: first.accession, documentUrl: first.documentUrl
    });
  }
  return schedule;
}

/** Rate in effect on `day` (YYYY-MM-DD) under a schedule; null before any data. */
function strcRateOn(schedule, day) {
  let hit = null;
  for (const e of schedule) {
    if (e.effectiveFrom === null || e.effectiveFrom <= day) hit = e;
  }
  return hit;
}

/**
 * Derive a capital snapshot from SEC filings + the issuer reference.
 * Returns null when no 8-K holdings exist. Every value names its provenance.
 */
function deriveSecCapital({ reference, docs, xbrl = {}, today }) {
  const issues = [];
  const holdings = docs.flatMap(d => d.holdings.map(h => ({ ...h, accession: d.accession, filedOn: d.filedOn, documentUrl: d.documentUrl })))
    .sort((a, b) => a.asOf.localeCompare(b.asOf) || a.filedOn.localeCompare(b.filedOn));
  if (!holdings.length) return null;
  const latest = holdings[holdings.length - 1];
  const usdAll = docs.filter(d => d.usd && d.usd.asOf).map(d => ({ ...d.usd, accession: d.accession }))
    .sort((a, b) => a.asOf.localeCompare(b.asOf));
  const usd = usdAll[usdAll.length - 1] || null;
  if (!usd) issues.push('usd_balances_missing');
  else {
    if (usd.asOf < latest.asOf) issues.push('usd_balances_lag_holdings');
    if (usd.usdCashUsd === null) issues.push('usd_cash_not_disclosed');
  }

  const schedule = buildStrcRateSchedule(docs);
  const strcNow = strcRateOn(schedule, today || latest.asOf);

  let capital = null;
  let instruments = [];
  let preferreds = [];
  let basicShares = null;
  if (!reference) {
    issues.push('capital_reference_missing');
  } else {
    // Roll the reference's share counts forward with flows reported after it.
    const counts = {};
    for (const p of reference.preferreds) counts[p.ticker] = p.sharesOutstanding;
    basicShares = reference.basicShares;
    const seen = new Set();
    let rolledPeriods = 0;
    for (const d of docs) {
      for (const f of d.flows) {
        if (!f.periodEnd || f.periodEnd <= reference.flowsCutoff) continue;
        const key = `${f.kind}:${f.periodStart}:${f.periodEnd}`;
        if (seen.has(key)) continue; // the same period re-reported by a later 8-K
        seen.add(key);
        rolledPeriods++;
        const sign = f.kind === 'atm' ? 1 : -1;
        for (const [ticker, n] of Object.entries(f.shares)) {
          if (ticker === 'MSTR') basicShares += sign * n;
          else if (counts[ticker] !== undefined) counts[ticker] += sign * n;
          else if (n) issues.push(`flow_for_unknown_series:${ticker}`);
        }
      }
    }
    instruments = reference.instruments.map(i => ({ ...i }));
    preferreds = reference.preferreds.map(p => ({
      ...p,
      sharesOutstanding: counts[p.ticker],
      dividendPct: p.ticker === 'STRC' && strcNow ? strcNow.ratePct : p.dividendPct,
      source: p.ticker === 'STRC' && strcNow ? 'sec_8k' : 'issuer_reference'
    }));
    const prefUsd = preferreds.reduce((a, p) => a + (p.sharesOutstanding || 0) * 100 * (p.ticker === 'STRE' && p.fxRate ? p.fxRate : 1), 0);
    const ageDays = (Date.parse(today || latest.asOf) - Date.parse(reference.asOf)) / 86400000;
    if (ageDays > 120) issues.push('capital_reference_stale');
    const debtUsd = instruments.reduce((a, i) => a + i.notionalUsd, 0);
    if (xbrl.longTermDebt && xbrl.longTermDebt.periodEnd > reference.asOf
        && Math.abs(xbrl.longTermDebt.value - debtUsd) > 0.02 * debtUsd) {
      issues.push('xbrl_debt_differs_from_reference');
    }
    capital = {
      id: `sec-derived:${latest.asOf}`,
      asOf: latest.asOf,
      btcHoldings: latest.holdingsBtc,
      aggregateCostUsd: latest.aggregateCostUsd,
      averageCostUsd: latest.averageCostUsd,
      usdReserveUsd: usd ? usd.usdReserveUsd : null,
      usdCashUsd: usd ? usd.usdCashUsd : null,
      // Methodology "USD Assets" = USD Reserve + USD Cash.
      cashUsd: usd ? usd.usdReserveUsd + (usd.usdCashUsd || 0) : null,
      debtUsd,
      prefUsd: Math.round(prefUsd),
      basicShares,
      sharesComponents: { ...reference.sharesComponents },
      source: 'sec_8k',
      confirmation: 'sec_filed',
      documentUrl: latest.documentUrl,
      provenance: {
        holdings: `8-K ${latest.accession} (as of ${latest.asOf})`,
        usdAssets: usd ? `8-K ${usd.accession} (as of ${usd.asOf})` : null,
        termsReference: `${reference.source} (as of ${reference.asOf})`,
        rolledForwardPeriods: rolledPeriods,
        strcRate: strcNow && strcNow.accession ? `8-K ${strcNow.accession}` : null
      },
      issues
    };
    if (capital.cashUsd === null) capital.cashUsd = 0;
  }

  // Holdings timeline as ledger-compatible events (newest last).
  const events = holdings.map((h, i) => ({
    id: `sec8k:${h.accession}:${h.asOf}`,
    type: i === 0 ? 'BTC_HOLDINGS_UPDATE'
      : h.holdingsBtc > holdings[i - 1].holdingsBtc ? 'BTC_PURCHASE'
        : h.holdingsBtc < holdings[i - 1].holdingsBtc ? 'BTC_SALE' : 'BTC_HOLDINGS_UPDATE',
    security: 'BTC',
    reportedOn: h.filedOn,
    holdingsAsOf: h.asOf,
    datePrecision: 'day',
    deltaBtc: i === 0 ? null : h.holdingsBtc - holdings[i - 1].holdingsBtc,
    transactionAverageUsd: null,
    transactionCashUsd: null,
    holdingsBtc: h.holdingsBtc,
    averageCostUsd: h.averageCostUsd,
    aggregateCostUsd: h.aggregateCostUsd,
    basicShares: null,
    source: 'sec_8k',
    sourceUrl: h.documentUrl,
    documentUrl: h.documentUrl,
    confirmation: 'sec_filed',
    secContentsVerified: true,
    issues: []
  }));

  return {
    capital,
    instruments,
    preferreds,
    shares: basicShares !== null ? { asOf: latest.asOf, basicShares, source: 'sec_8k+issuer_reference' } : null,
    events,
    strcRateSchedule: schedule,
    issues
  };
}

module.exports = {
  PARSER_VERSION, CIK, SEC_ARCHIVE_PREFIX, XBRL_CONCEPTS, PREF_TICKERS,
  isoDay, htmlToText, parseSecEightK, parseXbrlConcept,
  buildStrcRateSchedule, strcRateOn, deriveSecCapital
};
