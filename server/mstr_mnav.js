'use strict';

/**
 * Official, versioned mNAV — methodology "2026-07-23" (the issuer's own notes
 * published alongside the July 2026 preferred-stock disclosures).
 *
 *   mNAV          = MSTR market price per share (Nasdaq class A) / Net BPS ($)
 *   Net BPS ($)   = Net BTC ($) / Fully Diluted Shares Outstanding (FDSO)
 *   Net BTC ($)   = BTC Reserve USD − OTM convertibles notional
 *                   − preferred notional (excluding ITM STRK) + USD Assets
 *   BTC Reserve   = btcHoldings × BTC price (Coinbase at measurement time)
 *   Net BTC (BTC) = the same expressed in BTC terms
 *   FDSO          = basic shares + options exercised + RSU/PSU settled
 *                   + shares from in-the-money converts + ITM STRK shares
 *
 * Moneyness: a convertible instrument is in-the-money when its conversion
 * price <= the MSTR market price at measurement. OTM instruments do not
 * contribute shares; their notional deducts from Net BTC instead.
 *
 * Preferred notional = outstanding preferred shares × $100 liquidation
 * preference. STRE is EUR-denominated: notional USD = shares × 100 × the
 * issuer-published fxRate (fixed Fridays 12:30pm NY — we take the issuer's
 * current_fx_rate field verbatim and never fetch our own FX).
 * STRK is the only convertible preferred; STRC/STRD/STRE/STRF are standing
 * notional claims.
 *
 * The pre-2026-07-23 EV-based mNAV is a different metric; consumers must
 * never merge this series with the legacy one (methodologyVersion is stamped
 * on every result so the boundary is machine-checkable).
 *
 * Pure module: no I/O, no clocks, no network.
 */

const METHODOLOGY_VERSION = '2026-07-23';
const PREF_LIQ_PREF_USD = 100;
const STRK_FALLBACK_STRIKE_USD = 1000; // issuer-published approx. conversion price

// Debt-table display name -> capital.sharesComponents key holding the
// shares the instrument adds to FDSO when it is in the money.
const CONVERT_COMPONENT = Object.freeze({
  'Convert 2028': 'convert2028',
  'Convert 2029': 'convert2029',
  'Convert 2030 A': 'convert2030A',
  'Convert 2030 B': 'convert2030B',
  'Convert 2031': 'convert2031',
  'Convert 2032': 'convert2032'
});

const round = (v, digits) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isPos = v => isNum(v) && v > 0;

/**
 * computeOfficialMnav({ mstrPriceUsd, btcPriceUsd, capital, instruments,
 *                       preferreds, shares, issues }) -> result | null
 *
 * Returns null when required inputs are absent or a hard guard rejects
 * (non-positive prices, non-positive FDSO); every rejection is explained by
 * an entry pushed into the caller-supplied `issues` array (optional). On the
 * happy path the returned object carries the same `issues` list — warnings
 * such as 'strk_strike_fallback', 'unmapped_instrument:<name>' or
 * 'net_bps_nonpositive' never silently disappear.
 */
function computeOfficialMnav({
  mstrPriceUsd,
  btcPriceUsd,
  capital,
  instruments,
  preferreds,
  shares,
  issues
} = {}) {
  const issueList = Array.isArray(issues) ? issues : [];
  const before = issueList.length;

  // --- required structural inputs --------------------------------------
  if (!capital || typeof capital !== 'object') {
    issueList.push('missing_input:capital');
  } else {
    if (!isNum(capital.cashUsd) || capital.cashUsd < 0) issueList.push('missing_input:capital.cashUsd');
    if (!isNum(capital.btcHoldings) || capital.btcHoldings < 0) issueList.push('missing_input:capital.btcHoldings');
    if (!capital.sharesComponents || typeof capital.sharesComponents !== 'object') {
      issueList.push('missing_input:capital.sharesComponents');
    }
  }
  if (!shares || typeof shares !== 'object') {
    issueList.push('missing_input:shares');
  } else if (!isNum(shares.basicShares) || shares.basicShares < 0) {
    issueList.push('missing_input:shares.basicShares');
  }
  if (issueList.length > before) return null;

  // --- price guards -----------------------------------------------------
  if (!isPos(mstrPriceUsd)) { issueList.push('invalid_mstr_price'); return null; }
  if (!isPos(btcPriceUsd)) { issueList.push('invalid_btc_price'); return null; }

  const comp = capital.sharesComponents;
  const componentShares = key => (isNum(comp[key]) && comp[key] >= 0 ? comp[key] : 0);

  // --- convertible debt moneyness ---------------------------------------
  const itmConverts = [];
  const otmConverts = [];
  let convertShares = 0;
  let otmConvertNotional = 0;
  for (const inst of Array.isArray(instruments) ? instruments : []) {
    if (!inst || typeof inst !== 'object') continue;
    const name = typeof inst.name === 'string' ? inst.name : '?';
    const key = CONVERT_COMPONENT[name];
    if (key === undefined) {
      issueList.push(`unmapped_instrument:${name}`);
    }
    const itm = isPos(inst.strikeUsd) && inst.strikeUsd <= mstrPriceUsd;
    if (itm) {
      itmConverts.push(name);
      convertShares += key === undefined ? 0 : componentShares(key);
    } else {
      otmConverts.push(name);
      if (isNum(inst.notionalUsd) && inst.notionalUsd > 0) otmConvertNotional += inst.notionalUsd;
    }
  }

  // --- preferred stock: notional claims; STRK is the only convertible ---
  let preferredNotional = 0;
  let strkPref = null;
  for (const p of Array.isArray(preferreds) ? preferreds : []) {
    if (!p || typeof p !== 'object') continue;
    if (p.ticker === 'STRK') { strkPref = p; continue; } // handled below
    const out = isNum(p.sharesOutstanding) && p.sharesOutstanding > 0 ? p.sharesOutstanding : 0;
    if (p.ticker === 'STRE') {
      // EUR-denominated: USD notional = shares × €100 × issuer fxRate.
      if (isPos(p.fxRate)) {
        preferredNotional += out * PREF_LIQ_PREF_USD * p.fxRate;
      } else {
        preferredNotional += out * PREF_LIQ_PREF_USD;
        if (out > 0) issueList.push('stre_fx_missing');
      }
    } else {
      preferredNotional += out * PREF_LIQ_PREF_USD;
    }
  }

  // STRK conversion price = (sharesOutstanding × $100) / convertStrk shares.
  let strkConversionPrice = null;
  let strkItm = false;
  let strkShares = 0;
  if (strkPref) {
    const strkSharesOut = isPos(strkPref.sharesOutstanding) ? strkPref.sharesOutstanding : null;
    const conv = isPos(comp.convertStrk) ? comp.convertStrk : null;
    if (strkSharesOut !== null && conv !== null) {
      strkConversionPrice = (strkSharesOut * PREF_LIQ_PREF_USD) / conv;
    } else {
      strkConversionPrice = STRK_FALLBACK_STRIKE_USD;
      issueList.push('strk_strike_fallback');
    }
    strkItm = strkConversionPrice <= mstrPriceUsd;
    if (strkItm) {
      strkShares = conv !== null
        ? conv
        : (strkSharesOut !== null ? (strkSharesOut * PREF_LIQ_PREF_USD) / strkConversionPrice : 0);
    } else {
      // OTM STRK remains a plain preferred notional claim.
      preferredNotional += (strkSharesOut || 0) * PREF_LIQ_PREF_USD;
    }
  }

  // --- FDSO -------------------------------------------------------------
  const basic = shares.basicShares;
  const options = componentShares('optionsOutstanding');
  const rsu = componentShares('rsuPsuUnvested');
  const fdso = basic + options + rsu + convertShares + strkShares;
  if (!(fdso > 0)) {
    issueList.push('fdso_nonpositive');
    return null;
  }

  // --- Net BTC / Net BPS / mNAV ------------------------------------------
  const usdAssetsUsd = capital.cashUsd;
  const btcReserveUsd = capital.btcHoldings * btcPriceUsd;
  const claimsUsd = otmConvertNotional + preferredNotional;
  const netBtcUsd = btcReserveUsd - claimsUsd + usdAssetsUsd;
  const netBtcBtc = netBtcUsd / btcPriceUsd;
  const netBpsUsd = netBtcUsd / fdso;
  if (netBpsUsd <= 0) issueList.push('net_bps_nonpositive');
  const mnav = mstrPriceUsd / netBpsUsd;

  return {
    mnav: round(mnav, 4),
    netBtcUsd: Math.round(netBtcUsd),
    netBtcBtc: round(netBtcBtc, 4),
    netBpsUsd: round(netBpsUsd, 2),
    fdso,
    usdAssetsUsd: Math.round(usdAssetsUsd),
    claimsUsd: Math.round(claimsUsd),
    methodologyVersion: METHODOLOGY_VERSION,
    itmConverts,
    otmConverts,
    strkItm,
    strkConversionPrice: strkConversionPrice === null ? null : round(strkConversionPrice, 4),
    fdsoBreakdown: { basic, options, rsu, converts: convertShares, strk: strkShares },
    inputs: {
      mstrPriceUsd,
      btcPriceUsd,
      capitalAsOf: typeof capital.asOf === 'string' ? capital.asOf : null
    },
    issues: issueList
  };
}

module.exports = {
  METHODOLOGY_VERSION,
  STRK_FALLBACK_STRIKE_USD,
  CONVERT_COMPONENT,
  computeOfficialMnav
};
