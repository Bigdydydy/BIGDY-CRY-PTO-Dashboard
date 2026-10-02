/**
 * Deribit Coin-Margined Inverse Option PnL Payoff Engine (BTC Standard)
 * 
 * Deribit options are inverted and settled in Bitcoin.
 * Terminal Payoffs (in BTC per contract):
 *   Call: max(1 - K / S, 0)
 *   Put:  max(K / S - 1, 0)
 * 
 * Net PnL (in BTC):
 *   Buyer:  (Payoff - Premium_btc) * Amount
 *   Seller: (Premium_btc - Payoff) * Amount
 */
(function(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PnLEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  /**
   * Calculate single leg net PnL in BTC at underlying spot price S
   * @param {Object} leg - Option leg { strike, price, amount, direction, isCall, instrument }
   * @param {number} S - Terminal spot price in USD
   * @returns {number} Net PnL in BTC
   */
  function calculateLegPnLBTC(leg, S) {
    if (!S || S <= 0) return 0;
    const K = Number(leg.strike);
    const P = Number(leg.price || 0); // Premium in BTC
    const Q = Number(leg.amount || 0); // Amount in BTC
    const isCall = leg.isCall ?? (String(leg.instrument).endsWith('-C') || String(leg.type).toLowerCase() === 'call');
    const isBuy = String(leg.direction).toLowerCase() === 'buy';

    let payoffPerContract = 0;
    if (isCall) {
      payoffPerContract = S > K ? (1 - K / S) : 0;
    } else {
      payoffPerContract = S < K ? (K / S - 1) : 0;
    }

    const netPerContract = isBuy ? (payoffPerContract - P) : (P - payoffPerContract);
    return netPerContract * Q;
  }

  /**
   * Calculate total portfolio PnL in BTC at spot price S
   * @param {Array} legs 
   * @param {number} S 
   * @returns {number}
   */
  function calculatePortfolioPnLBTC(legs, S) {
    if (!legs || !legs.length) return 0;
    return legs.reduce((sum, leg) => sum + calculateLegPnLBTC(leg, S), 0);
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

    const sortedPrices = Array.from(priceSet).sort((a, b) => a - b);
    const series = sortedPrices.map(S => {
      const pnlBtc = calculatePortfolioPnLBTC(legs, S);
      const pnlUsd = pnlBtc * S;
      return { S, pnlBtc, pnlUsd };
    });

    // Detect Breakeven Points (zero-crossings via linear interpolation)
    const breakevens = [];
    for (let i = 0; i < series.length - 1; i++) {
      const p1 = series[i];
      const p2 = series[i + 1];
      if ((p1.pnlBtc <= 0 && p2.pnlBtc >= 0) || (p1.pnlBtc >= 0 && p2.pnlBtc <= 0)) {
        if (p2.pnlBtc !== p1.pnlBtc) {
          const bepS = p1.S + (0 - p1.pnlBtc) * (p2.S - p1.S) / (p2.pnlBtc - p1.pnlBtc);
          breakevens.push(Math.round(bepS));
        }
      }
    }

    // Initial Net Premium Cash Flow (BTC)
    const initialCashFlowBTC = legs.reduce((sum, l) => {
      const isBuy = String(l.direction).toLowerCase() === 'buy';
      const amount = Number(l.amount || 0);
      const price = Number(l.price || 0);
      return sum + (isBuy ? -price * amount : price * amount);
    }, 0);

    // Current Spot PnL if expired at current price
    const currentSpotPnLBTC = calculatePortfolioPnLBTC(legs, S0);

    // Sampled min/max
    const pnlValues = series.map(d => d.pnlBtc);
    const minPnl = Math.min(...pnlValues);
    const maxPnl = Math.max(...pnlValues);

    // Check bounded vs unbounded characteristics
    // In Deribit BTC standard:
    // A net short Call has theoretically unbounded loss as S -> infinity (payoff -> 1, but USD equivalent grows)
    // A net long Put has maximum payout approaching (K/S - 1) -> huge BTC as S -> 0
    // Spread strategies (e.g. Iron Condor, Vertical Spreads) have strictly defined max profit and loss
    let isCappedUpside = true;
    let isCappedDownside = true;
    let netCallContracts = 0;
    let netPutContracts = 0;
    legs.forEach(l => {
      const isBuy = String(l.direction).toLowerCase() === 'buy';
      const isCall = l.isCall ?? (String(l.instrument).endsWith('-C') || String(l.type).toLowerCase() === 'call');
      const amt = Number(l.amount || 0);
      const sign = isBuy ? 1 : -1;
      if (isCall) netCallContracts += sign * amt;
      else netPutContracts += sign * amt;
    });

    if (netCallContracts < -0.01) isCappedUpside = false; // Net short call
    if (netPutContracts < -0.01) isCappedDownside = false; // Net short put

    return {
      series,
      breakevens,
      initialCashFlowBTC,
      currentSpotPnLBTC,
      minPnl,
      maxPnl,
      isCappedUpside,
      isCappedDownside,
      spotPrice: S0,
      minS,
      maxS
    };
  }

  return {
    calculateLegPnLBTC,
    calculatePortfolioPnLBTC,
    generatePnLCurve
  };
});
