# MSTR Official Disclosures (Milestones 2–3)

Scope: the official Strategy BTC ledger, the separately dated issuer share
baseline, the issuer capital-structure page, the issuer press index, SEC
filing *discovery*, and the versioned official mNAV overlay (methodology
`2026-07-23`) — connected to Module 1 health monitoring. It does **not**
implement SEC document body extraction or press-release body verification.
Announcement kinds are title-level heuristics only; no amounts are extracted
from headlines. Those limits are explicitly reported in the payload
`coverage` block (`announcements_only` / `index_only` / `not_computed` /
`computed`) and in the UI captions.

## Sources

| id | URL | content |
|---|---|---|
| `mstr_official_ledger` | https://strategy.com/ledger | issuer-reported BTC buy/sell events |
| `mstr_official_shares` | https://strategy.com/shares | issuer-reported share counts (page units = thousands) |
| `mstr_official_capital` | https://strategy.com/debt | issuer capital snapshot, convertible debt instruments, preferred-stock terms |
| `mstr_official_press` | https://strategy.com/press | press-release discovery only; titles are signals, never facts |
| `mstr_sec_index` | https://data.sec.gov/submissions/CIK0001050446.json | filing discovery only; bodies not verified |
| `mstr_mnav_inputs` | Yahoo `v8/finance/chart/MSTR` + Coinbase Exchange `BTC-USD` ticker | market inputs for the derived official-mNAV overlay (no evidence body) |

Every successful response body is written *before parsing is accepted* as
immutable evidence `data/mstr_disclosure_evidence/<sha256>.json`
(`{sourceUrl, receivedAt, sha256, body}`). If evidence or state cannot be
persisted, the attempt is recorded as failed — a good-looking parse is
never reported against uncommitted state.

## Clocks: received vs disclosed

The health receipt clock (`lastAttemptAt` / `lastSuccessAt` in
`dataHealth`) tracks when the collector verified the upstream pages. It is
never used as a business date. `reportedOn` (ledger), `asOf` (shares and
capital snapshots), `publishedOn` (press) and `filingDate` (SEC) are
issuer-provided dates and are the only dates shown against the facts. A
scan that finds unchanged holdings is still a legitimate success — the
receipt advances, the disclosed dates do not.

## Collection cadence

- The in-process collector (`server/mstr_disclosures.js`) refreshes at most
  every 5 minutes (`POLL_MS`), started only in the background-enabled
  server path. It does not depend on an open browser tab, but it cannot run
  while the hosting service sleeps (e.g. a free-tier dyno that idles out).
- The scheduled producer step `mstr_disclosures` runs inside the six-hourly
  `macro_snapshot` GitHub Actions job and records its own heartbeat step.
  Failed steps fail the job monitor like any other producer step.
- The read-only `/api/system/health` audit never triggers a collection.

## SEC_USER_AGENT

SEC requires an honest identifying User-Agent with a real contact email.
The workflow reads it from the repository Actions variable (or same-named
secret) `SEC_USER_AGENT`, e.g.
`BIGDY-CRY-PTO/1.0 (contact: ops@example.com)`.

- Missing or invalid (no email): the SEC source is recorded as failed with
  `SEC_USER_AGENT must identify the application and a real contact email`
  and **no request is made**. Other sources still succeed.
- The value is never logged.
- This is not an API key — it identifies our traffic per SEC fair-access
  policy; no bypass of access controls is attempted. Direct SEC requests
  from this codebase previously returned 403; the fix is a truthful UA,
  not evasion.

## Evidence retention

`macro_snapshot` uploads `data/mstr_disclosure_evidence/` as the
`mstr-disclosure-evidence` artifact with 14-day retention. Raw evidence is
gitignored and never committed; only `data/mstr_disclosures.json`
(processed state) is committed by the job.

## Failure semantics

- Any fetch/parse/merge/persist failure leaves previously verified events,
  share snapshots, capital records, announcements and filings untouched
  and does not advance the success clock. The source reports
  STALE/FALLBACK/UNAVAILABLE per the shared health policy.
- A revision that regresses (`_version` downgrade, truncated history,
  NaN fields, future/impossible dates, wrong page header) is rejected
  wholesale; the newer accepted revision stays active.
- Cross-source reconciliation (ledger latest vs shares baseline vs capital
  snapshot) reports issues like `issuer_holdings_conflict`,
  `capital_holdings_conflict`, `capital_asof_lags_ledger` and
  `capital_shares_conflict` as warnings — it never rewrites either
  reported figure. The `debt_notional_reconcile_gap` issue attaches to the
  capital snapshot when the instrument notional sum drifts from the issuer
  debt headline beyond tolerance.
- Historical anomalies (e.g. the 2025-08-18 reported aggregate cost that
  does not reconcile with holdings * average) stay attached to the event
  and are flagged in the UI.

## Official mNAV — methodology 2026-07-23 (milestone 3)

`server/mstr_mnav.js` implements the issuer's own formula verbatim (per the
official notes at https://www.strategy.com/notes):

- **mNAV** = MSTR market price per share (Nasdaq class A) ÷ Net BPS ($)
- **Net BPS ($)** = Net BTC ($) ÷ Fully Diluted Shares Outstanding (FDSO)
- **Net BTC ($)** = BTC Reserve USD − OTM convertibles notional − preferred
  notional (excluding *in-the-money* STRK) + USD Assets, where
  BTC Reserve USD = `btcHoldings` × BTC price. The methodology prices BTC on
  **Coinbase** at measurement time; our input leg reads the Coinbase Exchange
  `BTC-USD` ticker (`btcSource: 'coinbase'` is recorded verbatim — any other
  venue would have to be labelled via its own `btcSource`).
- **Net BTC (BTC)** = the same expressed in BTC terms.
- **FDSO** = basic shares + options exercised + RSU/PSU settled + shares from
  in-the-money converts + shares from ITM STRK conversion.

**Moneyness.** An instrument is in-the-money when its conversion price is at
or below the MSTR market price at measurement. OTM converts do not enter
FDSO; their notional instead deducts from Net BTC. Instrument names map to
issuer `sharesComponents` keys (`Convert 2028`→`convert2028`, `Convert 2029`→
`convert2029`, `Convert 2030 A`→`convert2030A`, `Convert 2030 B`→
`convert2030B`, `Convert 2031`→`convert2031`, `Convert 2032`→`convert2032`);
an unmapped instrument contributes zero shares when ITM and still contributes
notional when OTM, flagged `unmapped_instrument:<name>`.

**Preferreds.** Notional = outstanding preferred shares × $100 liquidation
preference. STRE is EUR-denominated: notional USD = shares × 100 × the
issuer-published `current_fx_rate` (the methodology fixes FX at the most
recent Friday 12:30pm NY — we take the issuer field verbatim and never fetch
our own FX; a missing rate is flagged `stre_fx_missing`). STRK is the only
convertible preferred: its conversion price derives from issuer fields as
`(strkSharesOutstanding × 100) / convertStrk` (~$1000 by inspection); if
derivation is impossible the strike falls back to $1000 and the result is
flagged `strk_strike_fallback`. STRC/STRF/STRD/STRE are always standing
notional claims.

**Inputs.** `capital` (USD assets = `cashUsd`, `btcHoldings`,
`sharesComponents`), `shares` (`basicShares` only — ADSO is *not* FDSO),
active `debtInstruments`, active `preferredTerms`, plus market prices.
Missing required inputs make the compute return `null` with
`missing_input:*` issues; non-positive/non-finite prices reject with
`invalid_mstr_price`/`invalid_btc_price`; `fdso_nonpositive` rejects;
`net_bps_nonpositive` is returned *with* the value attached.

**Plumbing.** `createDisclosureService` accepts an injectable `prices`
provider `async () => ({mstrPriceUsd, btcPriceUsd, btcSource, mstrSource,
priceAsOfIso})`; the default fetches MSTR from the repo's Yahoo chart shape
and BTC via `coinbase_fetcher`'s Coinbase ticker. Prices are fetched only
inside `collect()`, after the five evidence scans, inside their own
try/catch — a price failure never fails the disclosure sources. The record
is persisted as `state.mnav` (`{computedAt, priceAsOf, mstrPriceUsd,
btcPriceUsd, btcSource, mstrSource, result, issues}`), validated as an
optional object on load, **never fingerprinted and never added to evidence**
— it is a derived overlay, recomputed on the next scan. Source id
`mstr_mnav_inputs` reports success only when both prices are finite and a
value was produced; `dataAsOf` is the price receipt.

**Version boundary.** Pre-2026-07-23 mNAV (the EV-based metric rendered on
the macro chart) is a *different* measure — the two series must never be
merged or compared; every result carries `methodologyVersion: '2026-07-23'`
so the boundary is machine-checkable, and the UI prints a 新旧口径不可比
note next to the official line.

## Not yet implemented (explicit)

- SEC filing body verification: filings are labelled
  `contents_not_verified` / `申报已发现 · 正文待核验`. No business numbers
  are read from filing bodies.
- Press-release body verification: announcements are labelled
  `标题级，正文未核验`. Kinds (BTC买入 / STRC回购 / 优先股融资 / 股息政策 /
  债务资本 / 业绩 / 提及) are conservative title heuristics; titles never
  yield amounts, and the index only proves a release exists.
- ~~Official mNAV~~ — implemented in milestone 3 (methodology `2026-07-23`,
  see the section above). The legacy EV-based mNAV series on the macro chart
  stays labelled as the old, non-comparable 口径.
