'use strict';
/**
 * Cash-and-carry backtest on the archived Deribit term structure
 * (data/term_premium_history.json, one 08:00 UTC record per day, see basis_fetcher.js).
 *
 * Two trade families:
 *   quarterly  long spot BTC + short a Deribit quarterly future. P&L per BTC hedged is the change in
 *              the dollar basis (F − S); at expiry the basis converges to 0. Rolling keeps the spot leg,
 *              so only the futures leg pays fees on a roll. Modelled as a linear future: the inverse
 *              contract's convexity is second order for a delta-hedged position and is ignored.
 *   perp       long spot + short perpetual, earning the realized funding of each 24h window
 *              (fundingApr24h). The archived funding is market-wide OI-weighted (CoinGlass) when
 *              available, so it approximates, not replicates, a single venue's cash flows.
 *
 * Point-in-time discipline:
 *   - A decision uses only the record of day d and is executed at the prices of day d + lag (lag ≥ 0).
 *   - The T-Bill in a decision is the one from day d − 1: FRED publishes DGS3MO for a date on the
 *     following US afternoon, after that date's 08:00 UTC snapshot.
 *   - Contract marks come from the stored annualized basis: basis$ = S × APR × days / 365. Inside a
 *     contract's final week the archive drops its mark (cqValid = false); a position held there is
 *     carried unmarked and booked at expiry, where the basis is 0 by construction.
 *   - While flat the capital earns the T-Bill; while in a carry trade it is tied up in BTC and does not.
 *
 * Pure functions only: no I/O, so the CLI (scripts/carry_backtest.js) and the tests share this module.
 */

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const MIN_DAYS = 7; // never open a contract inside its final week (the archive has no marks there)
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// Per-side costs in basis points of notional. Order-of-magnitude retail/pro taker levels; check
// them against the venues' current fee schedules before reading the results as tradable.
const DEFAULT_COSTS = Object.freeze({
  spotFeeBps: 10,   // spot buy / sell
  futFeeBps: 5,     // quarterly future open / close
  perpFeeBps: 5,    // perpetual open / close
  slipBps: 2,       // per leg per execution
  settleBps: 2.5    // futures delivery at expiry
});

const bps = v => v / 1e4;

function contractName(expiryTs) {
  const d = new Date(expiryTs);
  return `BTC-${d.getUTCDate()}${MONTHS[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(2)}`;
}

/** Expiry of a tenor, from the record's timestamp and its (2-decimal) days to expiry */
function expiryOf(ts, days) {
  return Math.round((ts + days * DAY_MS) / HOUR_MS) * HOUR_MS;
}

/** Tradable quarterly legs of one record: [{ tenor, expiryTs, days, apr }] */
function legsOf(row) {
  const legs = [];
  if (row.cqApr != null && row.cqValid !== false && row.cqDays > 0) {
    legs.push({ tenor: 'CQ', expiryTs: expiryOf(row.timestamp, row.cqDays), days: row.cqDays, apr: row.cqApr });
  }
  if (row.nqApr != null && row.nqDays > 0) {
    legs.push({ tenor: 'NQ', expiryTs: expiryOf(row.timestamp, row.nqDays), days: row.nqDays, apr: row.nqApr });
  }
  return legs;
}

/** Dollar basis (F − S) per BTC of the contract expiring at expiryTs; 0 once expired, null if unmarked */
function basisUsdAt(row, expiryTs) {
  if (row.timestamp >= expiryTs) return 0;
  const leg = legsOf(row).find(l => l.expiryTs === expiryTs);
  return leg ? row.btcPrice * leg.apr / 100 * leg.days / 365 : null;
}

/**
 * Contracts that can be opened at execRow given the signal in sigRow, best first.
 * netApr amortizes the futures round trip over the remaining life (spot fees are not
 * tenor-dependent and do not affect the choice).
 */
function candidates(sigRow, execRow, costs, minDays = MIN_DAYS) {
  const roundTripPct = 2 * (costs.futFeeBps + costs.slipBps) / 100;
  return legsOf(sigRow)
    .filter(l => l.days >= minDays && execRow.timestamp < l.expiryTs && basisUsdAt(execRow, l.expiryTs) != null)
    .map(l => ({ ...l, netApr: l.apr - roundTripPct * 365 / l.days }))
    .sort((a, b) => b.netApr - a.netApr);
}

// ── Rules ────────────────────────────────────────────────────────────────────────────────────────
// enter(sig, best, tbill) → open / roll into `best`;  keep(sig, held, tbill) → keep the held contract.

/** Enter when the best net APR clears T-Bill + entrySpread; exit early when the held contract's
 *  remaining APR drops below T-Bill + exitSpread (exitSpread null = always hold to expiry). */
function hurdleRule(entrySpread, exitSpread = null) {
  return {
    enter: (sig, best, tbill) => best.netApr >= tbill + entrySpread,
    keep: (sig, held, tbill) => exitSpread == null || held.apr >= tbill + exitSpread
  };
}

/** The dashboard's carry score (basis_fetcher.calculateCarryScore) as the gate */
function scoreRule(enterScore = 45, keepScore = 30) {
  return {
    enter: (sig, best, tbill) => sig.carryScore != null && sig.carryScore >= enterScore && best.netApr > tbill,
    keep: (sig, held, tbill) => sig.carryScore != null && sig.carryScore >= keepScore && held.apr >= tbill
  };
}

/** Perp carry: enter when trailing 7d funding clears T-Bill + entrySpread, exit below T-Bill + exitSpread */
function perpRule(entrySpread, exitSpread = 0) {
  return {
    enter: (sig, tbill) => sig.fundingApr != null && sig.fundingApr >= tbill + entrySpread,
    keep: (sig, tbill) => sig.fundingApr != null && sig.fundingApr >= tbill + exitSpread
  };
}

const ALWAYS_QUARTERLY = { enter: () => true, keep: () => true };
const ALWAYS_PERP = { enter: () => true, keep: () => true };

/** T-Bill visible to a decision taken on day d (the previous record's value) */
function decisionTbill(rows, d) {
  return d > 0 ? rows[d - 1].tbill : rows[d].tbill;
}

// ── Simulators ───────────────────────────────────────────────────────────────────────────────────

function newTrade(row, kind, extra) {
  return { kind, entryDate: row.date, entryTs: row.timestamp, exitDate: null, contracts: [], peakEquity: null, ddPct: 0, entryEquity: null, ...extra };
}

/** Peak-to-trough drawdown inside one trade (basis mark-to-market), in % */
function track(trade, equity) {
  trade.peakEquity = Math.max(trade.peakEquity ?? equity, equity);
  trade.ddPct = Math.min(trade.ddPct, (equity / trade.peakEquity - 1) * 100);
}

function closeTrade(trade, row, equity, open = false) {
  trade.exitDate = row.date;
  trade.holdDays = Math.round((row.timestamp - trade.entryTs) / DAY_MS);
  trade.returnPct = (equity / trade.entryEquity - 1) * 100;
  track(trade, equity);
  trade.open = open;
  return trade;
}

/** Long spot / short quarterly. Returns { daily: [{date, ts, equity, held, cashRet}], trades } */
function runQuarterly(rows, rule, opts = {}) {
  const costs = { ...DEFAULT_COSTS, ...(opts.costs || {}) };
  const lag = opts.lag ?? 1;
  const minDays = opts.minDays ?? MIN_DAYS;
  let equity = 1;
  let pos = null; // { expiryTs, qty (BTC), basisUsd (last mark), trade }
  const daily = [];
  const trades = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let cashRet = 0;
    const held = !!pos;
    if (i > 0) {
      const prev = rows[i - 1];
      cashRet = prev.tbill / 100 / 365 * (row.timestamp - prev.timestamp) / DAY_MS;
      if (pos) {
        const mark = basisUsdAt(row, pos.expiryTs);
        if (mark != null) {
          equity += pos.qty * (pos.basisUsd - mark);
          pos.basisUsd = mark;
        }
      } else {
        equity *= 1 + cashRet;
      }
    }

    // Delivery: the future settles against the index; the spot leg stays until the decision below
    let settled = false;
    if (pos && row.timestamp >= pos.expiryTs) {
      equity -= pos.qty * row.btcPrice * bps(costs.settleBps);
      settled = true;
    }
    if (pos) track(pos.trade, equity);

    let action = null;
    const d = i - lag;
    if (d >= 0) {
      const sig = rows[d];
      const tbill = decisionTbill(rows, d);
      const best = candidates(sig, row, costs, minDays)[0] || null;
      if (pos && !settled) {
        const heldLeg = legsOf(sig).find(l => l.expiryTs === pos.expiryTs);
        // No mark for the held contract in the signal (its final week) → hold to delivery
        if (heldLeg && !rule.keep(sig, heldLeg, tbill)) {
          action = best && best.expiryTs !== pos.expiryTs && rule.enter(sig, best, tbill)
            ? { roll: best } : { close: true };
        }
      } else if (best && rule.enter(sig, best, tbill)) {
        action = pos ? { roll: best } : { open: best };
      } else if (pos) {
        action = { close: true };
      }
    } else if (settled) {
      action = { close: true };
    }

    if (action?.open) {
      const t = newTrade(row, 'quarterly', { entryApr: action.open.apr, entryNetApr: action.open.netApr });
      equity -= equity * bps(costs.spotFeeBps + costs.futFeeBps + 2 * costs.slipBps);
      t.entryEquity = equity;
      track(t, equity);
      t.contracts.push(contractName(action.open.expiryTs));
      pos = { expiryTs: action.open.expiryTs, qty: equity / row.btcPrice, basisUsd: basisUsdAt(row, action.open.expiryTs), trade: t };
    } else if (action?.roll) {
      const legBps = settled ? costs.futFeeBps + costs.slipBps : 2 * (costs.futFeeBps + costs.slipBps);
      equity -= equity * bps(legBps);
      pos.expiryTs = action.roll.expiryTs;
      pos.qty = equity / row.btcPrice;
      pos.basisUsd = basisUsdAt(row, action.roll.expiryTs);
      pos.trade.contracts.push(contractName(action.roll.expiryTs));
      track(pos.trade, equity);
    } else if (action?.close) {
      const legBps = settled ? costs.spotFeeBps + costs.slipBps : costs.spotFeeBps + costs.futFeeBps + 2 * costs.slipBps;
      equity -= equity * bps(legBps);
      trades.push(closeTrade(pos.trade, row, equity));
      pos = null;
    }

    daily.push({ date: row.date, ts: row.timestamp, equity, held, cashRet });
  }
  if (pos) trades.push(closeTrade(pos.trade, rows[rows.length - 1], equity, true));
  return { daily, trades };
}

/** Long spot / short perpetual, earning realized 24h funding while in position */
function runPerp(rows, rule, opts = {}) {
  const costs = { ...DEFAULT_COSTS, ...(opts.costs || {}) };
  const lag = opts.lag ?? 1;
  const legBps = costs.spotFeeBps + costs.perpFeeBps + 2 * costs.slipBps;
  let equity = 1;
  let trade = null;
  const daily = [];
  const trades = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let cashRet = 0;
    const held = !!trade;
    if (i > 0) {
      const prev = rows[i - 1];
      const dt = (row.timestamp - prev.timestamp) / DAY_MS;
      cashRet = prev.tbill / 100 / 365 * dt;
      equity *= 1 + (trade ? (row.fundingApr24h ?? 0) / 100 / 365 * dt : cashRet);
    }
    if (trade) track(trade, equity);

    const d = i - lag;
    if (d >= 0) {
      const sig = rows[d];
      const tbill = decisionTbill(rows, d);
      if (!trade && rule.enter(sig, tbill)) {
        trade = newTrade(row, 'perp', { entryApr: sig.fundingApr });
        trade.contracts.push('BTC-PERPETUAL');
        equity -= equity * bps(legBps);
        trade.entryEquity = equity;
        track(trade, equity);
      } else if (trade && !rule.keep(sig, tbill)) {
        equity -= equity * bps(legBps);
        trades.push(closeTrade(trade, row, equity));
        trade = null;
      }
    }
    daily.push({ date: row.date, ts: row.timestamp, equity, held, cashRet });
  }
  if (trade) trades.push(closeTrade(trade, rows[rows.length - 1], equity, true));
  return { daily, trades };
}

/** Capital in T-Bills only — the hurdle every carry rule has to beat */
function runCash(rows) {
  let equity = 1;
  const daily = rows.map((row, i) => {
    const cashRet = i > 0 ? rows[i - 1].tbill / 100 / 365 * (row.timestamp - rows[i - 1].timestamp) / DAY_MS : 0;
    equity *= 1 + cashRet;
    return { date: row.date, ts: row.timestamp, equity, held: false, cashRet };
  });
  return { daily, trades: [] };
}

// ── Metrics ──────────────────────────────────────────────────────────────────────────────────────

function std(xs) {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, v) => s + v, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1));
}

function metrics({ daily, trades }) {
  const n = daily.length;
  const years = (daily[n - 1].ts - daily[0].ts) / DAY_MS / 365;
  const rets = [];
  const excess = [];
  let cashEq = 1;
  let peak = daily[0].equity;
  let maxDD = 0;
  let heldDays = 0;
  for (let i = 1; i < n; i++) {
    const r = daily[i].equity / daily[i - 1].equity - 1;
    rets.push(r);
    excess.push(r - daily[i].cashRet);
    cashEq *= 1 + daily[i].cashRet;
    peak = Math.max(peak, daily[i].equity);
    maxDD = Math.min(maxDD, daily[i].equity / peak - 1);
    if (daily[i].held) heldDays++;
  }
  const equity = daily[n - 1].equity / daily[0].equity;
  const cagr = equity ** (1 / years) - 1;
  const cashCagr = cashEq ** (1 / years) - 1;
  const exStd = std(excess);
  const exMean = excess.reduce((s, v) => s + v, 0) / excess.length;
  const closed = trades.filter(t => !t.open);
  const pct = v => v * 100;
  return {
    years,
    totalReturnPct: pct(equity - 1),
    cagrPct: pct(cagr),
    cashCagrPct: pct(cashCagr),
    excessCagrPct: pct(cagr - cashCagr),
    volAnnPct: pct(std(rets) * Math.sqrt(365)),
    // Excess over T-Bill; null when the strategy never deviates from cash
    sharpe: exStd > 1e-12 ? exMean / exStd * Math.sqrt(365) : null,
    maxDrawdownPct: pct(maxDD),
    exposurePct: pct(heldDays / (n - 1)),
    trades: trades.length,
    winRatePct: closed.length ? pct(closed.filter(t => t.returnPct > 0).length / closed.length) : null,
    avgHoldDays: trades.length ? trades.reduce((s, t) => s + t.holdDays, 0) / trades.length : null,
    worstTradeDdPct: trades.length ? Math.min(...trades.map(t => t.ddPct)) : null
  };
}

/** Calendar-year strategy vs cash returns (%), using the last record of the prior year as the base */
function yearlyReturns({ daily }) {
  const out = [];
  let base = daily[0];
  let cash = 1;
  let year = daily[0].date.slice(0, 4);
  for (let i = 1; i < daily.length; i++) {
    const y = daily[i].date.slice(0, 4);
    if (y !== year) {
      out.push({ year, returnPct: (daily[i - 1].equity / base.equity - 1) * 100, cashPct: (cash - 1) * 100, partial: false });
      base = daily[i - 1];
      cash = 1;
      year = y;
    }
    cash *= 1 + daily[i].cashRet;
  }
  const last = daily[daily.length - 1];
  out.push({ year, returnPct: (last.equity / base.equity - 1) * 100, cashPct: (cash - 1) * 100, partial: !last.date.endsWith('12-31') });
  if (daily[0].date.slice(5) !== '01-01') out[0].partial = true;
  return out;
}

module.exports = {
  DEFAULT_COSTS,
  MIN_DAYS,
  contractName,
  expiryOf,
  legsOf,
  basisUsdAt,
  candidates,
  hurdleRule,
  scoreRule,
  perpRule,
  ALWAYS_QUARTERLY,
  ALWAYS_PERP,
  decisionTbill,
  runQuarterly,
  runPerp,
  runCash,
  metrics,
  yearlyReturns
};
