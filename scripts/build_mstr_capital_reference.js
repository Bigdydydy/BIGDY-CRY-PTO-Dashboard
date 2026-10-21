#!/usr/bin/env node
/**
 * Build data/mstr_capital_reference.json from captured strategy.com pages.
 *
 * strategy.com blocks non-browser clients (Akamai 403), so the slow-moving
 * capital terms SEC filings do not carry per series — convertible notionals
 * and conversion prices, preferred shares outstanding, dilutive share
 * components, STRE FX — are pinned from the last captured issuer pages.
 * mstr_sec_model.deriveSecCapital rolls the share counts forward with the
 * ATM/repurchase flows that 8-Ks report after `flowsCutoff`.
 *
 * Usage: node scripts/build_mstr_capital_reference.js [debt.html] [shares.html]
 * (defaults: the captured fixtures under test/fixtures/mstr/). Re-run with a
 * fresh browser capture whenever the convertible lineup changes.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseStrategyCapital, latestActive } = require('../server/mstr_disclosure_model');

const ROOT = path.join(__dirname, '..');
const debtFile = process.argv[2] || path.join(ROOT, 'test', 'fixtures', 'mstr', 'strategy-debt.html');
const OUT = path.join(ROOT, 'data', 'mstr_capital_reference.json');

const html = fs.readFileSync(debtFile, 'utf8');
const parsed = parseStrategyCapital(html, Date.now());
const capital = latestActive(parsed.capitalSnapshots, 'asOf');
const strip = ({ fingerprint, issues, sourceRevision, ...rest }) => rest;

const reference = {
  schemaVersion: 1,
  asOf: capital.asOf,
  // The issuer stats row carries BTC holdings 848,517 — the 8-K holdings as of
  // 2026-10-18 — so flows for periods ending on or before that day are already
  // reflected in these counts.
  flowsCutoff: '2026-10-18',
  source: 'strategy.com/debt (captured issuer page)',
  evidence: { file: path.relative(ROOT, debtFile).replace(/\\/g, '/'), sha256: crypto.createHash('sha256').update(html).digest('hex') },
  btcHoldings: capital.btcHoldings,
  basicShares: capital.basicShares,
  sharesComponents: capital.sharesComponents,
  instruments: parsed.debtInstruments.map(i => strip({ ...i, source: 'issuer_reference' })),
  preferreds: parsed.preferredTerms.map(p => strip({ ...p, source: 'issuer_reference' }))
};

fs.writeFileSync(OUT, JSON.stringify(reference, null, 2) + '\n');
console.log(`[mstr_capital_reference] wrote ${path.relative(ROOT, OUT)} as of ${reference.asOf}: `
  + `${reference.instruments.length} converts, ${reference.preferreds.length} preferreds, basic ${reference.basicShares}`);
