/**
 * Deribit Coin-Margined Inverse Option PnL Payoff Engine (BTC Standard)
 *
 * Deribit options are inverted and settled in Bitcoin.
 * Terminal Payoffs (in BTC per contract):
 *   Call: max(1 - K / S, 0)
 *   Put:  max(K / S - 1, 0)
 *
 * Before expiry, a contract is worth its Black-Scholes USD value divided by S (r = 0),
 * which is what Deribit marks options at; this drives the "Simulated" (T+n) curve and Greeks
 * of the Position Visualization (PV) view.
 *
 * Net PnL (in BTC):
 *   Buyer:  (Value - Premium_btc) * Amount
 *   Seller: (Premium_btc - Value) * Amount
 */
(function(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PnLEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  const MS_PER_DAY = 24 * 3600 * 1000;
  const MS_PER_YEAR = 365 * MS_PER_DAY;
  const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

  function isCallLeg(leg) {
    return leg.isCall ?? (String(leg.instrument).endsWith('-C') || String(leg.type).toLowerCase() === 'call');
  }

  function legSign(leg) {
    return String(leg.direction).toLowerCase() === 'buy' ? 1 : -1;
  }

  /**
   * Parse a Deribit option instrument name, e.g. BTC-30OCT26-100000-C.
   * Deribit options expire at 08:00 UTC on the expiry date.
   * @param {string} name
   * @returns {{currency: string, expiryMs: number, strike: number, isCall: boolean}|null}
   */
  function parseInstrument(name) {
    const m = String(name || '').match(/^([A-Z]+)-(\d{1,2})([A-Z]{3})(\d{2})-(\d+(?:\.\d+)?)-([CP])$/);
    if (!m || MONTHS[m[3]] === undefined) return null;
    return {
      currency: m[1],
      expiryMs: Date.UTC(2000 + Number(m[4]), MONTHS[m[3]], Number(m[2]), 8, 0, 0),
      strike: Number(m[5]),
      isCall: m[6] === 'C'
    };
  }

  // Abramowitz & Stegun 7.1.26 erf approximation (|error| < 1.5e-7)
  function normCdf(x) {
    const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
    const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
    const erf = 1 - poly * Math.exp(-x * x / 2);
    return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
  }

  function normPdf(x) {
    return Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
  }

  /**
   * Annualized carry implied by an expiry's forward vs the index: F = S * exp(carry * T).
   * @param {number} forward - Deribit `underlying_price` of the expiry
   * @param {number} index
   * @param {number} expiryMs
   * @param {number} nowMs
   */
  function impliedCarry(forward, index, expiryMs, nowMs) {
    const T = (expiryMs - nowMs) / MS_PER_YEAR;
    if (!(forward > 0) || !(index > 0) || !(T > 1 / 365 / 24)) return 0;
    return Math.log(forward / index) / T;
  }

  /**
   * Per-contract theoretical value (BTC) and Greeks of one leg at index S and time evalMs.
   * Matches Deribit's mark: BS USD value on the expiry's forward F, divided by F (r = 0), where
   * F = S * exp(carry * T) so the basis decays to zero at expiry.
   * Expired legs, legs without a parseable expiry or without IV are valued at intrinsic.
   * Delta is the BS delta (BTC per contract), Vega is USD per 1 vol point, Theta is USD per day.
   * @param {Object} leg - { strike, isCall, iv (percent), expiryMs, carry? }
   * @param {number} S
   * @param {number} evalMs
   * @param {number} ivShiftPct - relative IV shift, e.g. +20 means IV * 1.2
   */
  function legTheo(leg, S, evalMs, ivShiftPct = 0) {
    const K = Number(leg.strike);
    const isCall = isCallLeg(leg);
    const baseIv = Number(leg.iv) / 100;
    const sigma = Math.max(0.01, baseIv * (1 + (Number(ivShiftPct) || 0) / 100));
    const T = leg.expiryMs ? (leg.expiryMs - evalMs) / MS_PER_YEAR : 0;

    if (!(S > 0) || !(K > 0) || !(T > 0) || !(baseIv > 0)) {
      const itm = isCall ? S > K : S < K;
      const valueBtc = S > 0 ? (isCall ? Math.max(1 - K / S, 0) : Math.max(K / S - 1, 0)) : 0;
      return { valueBtc, delta: itm ? (isCall ? 1 : -1) : 0, gamma: 0, vegaUsd: 0, thetaUsd: 0, sigma, expired: T <= 0 };
    }

    const F = S * Math.exp((Number(leg.carry) || 0) * T);
    const sqrtT = Math.sqrt(T);
    const d1 = (Math.log(F / K) + sigma * sigma * T / 2) / (sigma * sqrtT);
    const d2 = d1 - sigma * sqrtT;
    const usd = isCall
      ? F * normCdf(d1) - K * normCdf(d2)
      : K * normCdf(-d2) - F * normCdf(-d1);
    const pdf = normPdf(d1);
    return {
      valueBtc: Math.max(usd, 0) / F,
      delta: isCall ? normCdf(d1) : normCdf(d1) - 1,
      gamma: pdf / (F * sigma * sqrtT),
      vegaUsd: F * pdf * sqrtT / 100,
      thetaUsd: -F * pdf * sigma / (2 * sqrtT) / 365,
      sigma,
      expired: false
    };
  }

  /**
   * Calculate single leg net PnL in BTC at underlying spot price S (at expiry)
   * @param {Object} leg - Option leg { strike, price, amount, direction, isCall, instrument }
   * @param {number} S - Terminal spot price in USD
   * @returns {number} Net PnL in BTC
   */
  function calculateLegPnLBTC(leg, S) {
    if (!S || S <= 0) return 0;
    const K = Number(leg.strike);
    const P = Number(leg.price || 0); // Premium in BTC
    const Q = Number(leg.amount || 0); // Amount in BTC
    const payoffPerContract = isCallLeg(leg)
      ? (S > K ? (1 - K / S) : 0)
      : (S < K ? (K / S - 1) : 0);
    return legSign(leg) * (payoffPerContract - P) * Q;
  }

  /**
   * Calculate total portfolio PnL in BTC at spot price S (at expiry)
   * @param {Array} legs
   * @param {number} S
   * @returns {number}
   */
  function calculatePortfolioPnLBTC(legs, S) {
    if (!legs || !legs.length) return 0;
    return legs.reduce((sum, leg) => sum + calculateLegPnLBTC(leg, S), 0);
  }

  /**
   * Portfolio value, PnL and Greeks at spot S and time evalMs (Simulated / T+n view).
   * @returns {{pnlBtc: number, legs: Array, totals: Object}}
   */
  function evaluatePortfolio(legs, S, evalMs, ivShiftPct = 0) {
    const totals = { pnlBtc: 0, delta: 0, netDelta: 0, gamma: 0, vegaUsd: 0, thetaUsd: 0 };
    const rows = (legs || []).map(leg => {
      const th = legTheo(leg, S, evalMs, ivShiftPct);
      const q = legSign(leg) * Number(leg.amount || 0);
      const row = {
        ...th,
        pnlBtc: q * (th.valueBtc - Number(leg.price || 0)),
        posDelta: q * th.delta,
        // Δ* (premium-adjusted delta): an inverse option's value is itself held in BTC
        posNetDelta: q * (th.delta - th.valueBtc),
        posGamma: q * th.gamma,
        posVegaUsd: q * th.vegaUsd,
        posThetaUsd: q * th.thetaUsd
      };
      totals.pnlBtc += row.pnlBtc;
      totals.delta += row.posDelta;
      totals.netDelta += row.posNetDelta;
      totals.gamma += row.posGamma;
      totals.vegaUsd += row.posVegaUsd;
      totals.thetaUsd += row.posThetaUsd;
      return row;
    });
    return { pnlBtc: totals.pnlBtc, legs: rows, totals };
  }

  function buildPriceGrid(legs, spotPrice, numPoints) {
    const strikes = legs.map(l => Number(l.strike)).filter(k => k > 0);
    const S0 = Number(spotPrice) || (strikes.length > 0 ? strikes[0] : 85000);
    const minK = Math.min(...strikes, S0);
    const maxK = Math.max(...strikes, S0);

    // Dynamic price span around min/max strike & current spot
    const minS = Math.max(1000, Math.floor((minK * 0.65) / 1000) * 1000);
    const maxS = Math.ceil((maxK * 1.35) / 1000) * 1000;

    // Build discrete evaluation points including strikes & spot
    const priceSet = new Set();
    const step = (maxS - minS) / numPoints;
    for (let i = 0; i <= numPoints; i++) {
      priceSet.add(Math.round(minS + i * step));
    }
    strikes.forEach(k => priceSet.add(Math.round(k)));
    if (S0 >= minS && S0 <= maxS) priceSet.add(Math.round(S0));

    return { S0, minS, maxS, prices: Array.from(priceSet).sort((a, b) => a - b) };
  }

  // Zero-crossings via linear interpolation
  function findBreakevens(points, key) {
    const breakevens = [];
    for (let i = 0; i < points.length - 1; i++) {
      const y1 = points[i][key];
      const y2 = points[i + 1][key];
      if (((y1 <= 0 && y2 >= 0) || (y1 >= 0 && y2 <= 0)) && y2 !== y1) {
        const bep = Math.round(points[i].S + (0 - y1) * (points[i + 1].S - points[i].S) / (y2 - y1));
        if (breakevens[breakevens.length - 1] !== bep) breakevens.push(bep);
      }
    }
    return breakevens;
  }

  function initialCashFlow(legs) {
    return legs.reduce((sum, l) => sum - legSign(l) * Number(l.price || 0) * Number(l.amount || 0), 0);
  }

  // Tail behaviour in BTC terms (inverse payoffs):
  //   S -> infinity: call value -> 1 BTC, put value -> 0, so PnL converges to a finite limit.
  //   S -> 0:        put value ~ K/S - 1 diverges, so net long puts = unbounded profit,
  //                  net short puts = unbounded loss; calls contribute only their premium.
  // This holds both at expiry and before it, since BS values share these limits.
  function tailProfile(legs) {
    let netPutContracts = 0;
    let pnlAtInfinity = 0;
    legs.forEach(l => {
      const isCall = isCallLeg(l);
      const signedAmt = legSign(l) * Number(l.amount || 0);
      pnlAtInfinity += signedAmt * ((isCall ? 1 : 0) - Number(l.price || 0));
      if (!isCall) netPutContracts += signedAmt;
    });
    return {
      pnlAtInfinity,
      isProfitCapped: netPutContracts <= 0.01, // net long puts -> profit diverges as S -> 0
      isLossCapped: netPutContracts >= -0.01   // net short puts -> loss diverges as S -> 0
    };
  }

  /**
   * Generate continuous PnL curve data points across adaptive price range
   * @param {Array} legs
   * @param {number} spotPrice
   * @param {number} numPoints
   * @returns {Object}
   */
  function generatePnLCurve(legs, spotPrice, numPoints = 160) {
    if (!legs || legs.length === 0) return null;

    const { S0, minS, maxS, prices } = buildPriceGrid(legs, spotPrice, numPoints);
    const series = prices.map(S => {
      const pnlBtc = calculatePortfolioPnLBTC(legs, S);
      return { S, pnlBtc, pnlUsd: pnlBtc * S };
    });

    // The sampled range stops at ~1.35x the top strike, so fold the S -> infinity limit into min/max.
    const tail = tailProfile(legs);
    const pnlValues = series.map(d => d.pnlBtc);

    return {
      series,
      breakevens: findBreakevens(series, 'pnlBtc'),
      initialCashFlowBTC: initialCashFlow(legs),
      currentSpotPnLBTC: calculatePortfolioPnLBTC(legs, S0),
      minPnl: Math.min(...pnlValues, tail.pnlAtInfinity),
      maxPnl: Math.max(...pnlValues, tail.pnlAtInfinity),
      ...tail,
      spotPrice: S0,
      minS,
      maxS
    };
  }

  /**
   * Position Visualization data: an "Expiry" curve (valued at the nearest unexpired expiry; later
   * expiries keep their BS time value, as Deribit / Greeks.live PV do) and a "Simulated" curve at
   * evalMs (T+n). Legs need `expiryMs` and `iv` (percent) for time value; others settle at intrinsic.
   * @param {Array} legs
   * @param {{spotPrice: number, nowMs?: number, evalMs?: number, ivShiftPct?: number, numPoints?: number}} opts
   */
  function generatePnLView(legs, opts = {}) {
    if (!legs || legs.length === 0) return null;
    const nowMs = Number(opts.nowMs) || Date.now();
    const ivShiftPct = Number(opts.ivShiftPct) || 0;

    const futureExpiries = legs.map(l => Number(l.expiryMs)).filter(t => t > nowMs);
    const nearestExpiryMs = futureExpiries.length ? Math.min(...futureExpiries) : null;
    const expiryEvalMs = nearestExpiryMs || nowMs;
    const evalMs = Math.min(Math.max(Number(opts.evalMs) || nowMs, nowMs), expiryEvalMs);

    const { S0, minS, maxS, prices } = buildPriceGrid(legs, opts.spotPrice, opts.numPoints || 200);
    const series = prices.map(S => ({
      S,
      simBtc: evaluatePortfolio(legs, S, evalMs, ivShiftPct).pnlBtc,
      expBtc: evaluatePortfolio(legs, S, expiryEvalMs, ivShiftPct).pnlBtc
    }));

    const tail = tailProfile(legs);
    const expValues = series.map(d => d.expBtc);

    return {
      series,
      breakevens: findBreakevens(series, 'expBtc'),
      simBreakevens: findBreakevens(series, 'simBtc'),
      initialCashFlowBTC: initialCashFlow(legs),
      minPnl: Math.min(...expValues, tail.pnlAtInfinity),
      maxPnl: Math.max(...expValues, tail.pnlAtInfinity),
      ...tail,
      nowMs,
      evalMs,
      nearestExpiryMs,
      maxDays: nearestExpiryMs ? (nearestExpiryMs - nowMs) / MS_PER_DAY : 0,
      spotPrice: S0,
      minS,
      maxS
    };
  }

  return {
    MS_PER_DAY,
    parseInstrument,
    impliedCarry,
    normCdf,
    legTheo,
    calculateLegPnLBTC,
    calculatePortfolioPnLBTC,
    evaluatePortfolio,
    generatePnLCurve,
    generatePnLView
  };
});
