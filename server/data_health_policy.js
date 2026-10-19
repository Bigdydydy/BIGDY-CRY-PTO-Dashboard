// These are data-safety windows, not trading/model parameters. A failed refresh
// never extends either window. Daily/weekly inputs allow publication delays.
const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function policy(fetchWarnMs, fetchBlockMs, dataWarnMs, dataBlockMs) {
  return Object.freeze({ fetchWarnMs, fetchBlockMs, dataWarnMs, dataBlockMs });
}

const LIVE = policy(3 * MINUTE, 15 * MINUTE, 3 * MINUTE, 15 * MINUTE);
const DAILY_LIVE = policy(30 * MINUTE, 6 * HOUR, 3 * DAY, 7 * DAY);
const ARCHIVE = policy(2 * HOUR, DAY, 3 * DAY, 7 * DAY);

const SOURCE_POLICIES = Object.freeze({
  greeks_atm: LIVE,
  greeks_gex: LIVE,
  greeks_trades: LIVE,
  greeks_iv_history: policy(3 * MINUTE, 15 * MINUTE, 3 * DAY, 7 * DAY),
  greeks_skew: policy(3 * MINUTE, 15 * MINUTE, 3 * DAY, 7 * DAY),
  greeks_smile: LIVE,
  deribit_dvol: policy(30 * MINUTE, 6 * HOUR, 3 * DAY, 7 * DAY),
  macro: policy(30 * MINUTE, 6 * HOUR, 10 * DAY, 30 * DAY),
  macro_daily: policy(30 * MINUTE, 6 * HOUR, 5 * DAY, 14 * DAY),
  macro_weekly: policy(30 * MINUTE, 6 * HOUR, 10 * DAY, 30 * DAY),
  preferreds: policy(30 * MINUTE, 6 * HOUR, 5 * DAY, 14 * DAY),
  cdri: DAILY_LIVE,
  ssro: DAILY_LIVE,
  gold: DAILY_LIVE,
  coinbase: policy(MINUTE, 5 * MINUTE, MINUTE, 5 * MINUTE),
  basis_live: LIVE,
  basis_history: ARCHIVE,
  etf: policy(12 * HOUR, 3 * DAY, 5 * DAY, 14 * DAY),
  cot: policy(12 * HOUR, 3 * DAY, 12 * DAY, 21 * DAY),
  option_marks: policy(MINUTE, 5 * MINUTE, MINUTE, 5 * MINUTE),
  oi_history: ARCHIVE,
  block_flow: policy(2 * HOUR, DAY, 36 * HOUR, 3 * DAY),
  smart_money: policy(2 * HOUR, DAY, 36 * HOUR, 3 * DAY),
  liquidity_history: policy(30 * MINUTE, 6 * HOUR, 3 * HOUR, DAY),
  mcclellan_core: policy(2 * DAY, 7 * DAY, 2 * DAY, 7 * DAY),
  mcclellan_frontier: policy(2 * DAY, 7 * DAY, 2 * DAY, 7 * DAY),
  mcclellan_anchor: policy(2 * DAY, 7 * DAY, 2 * DAY, 7 * DAY),
  macro_btc: DAILY_LIVE,
  mstr_cost: policy(30 * MINUTE, 6 * HOUR, 30 * MINUTE, 6 * HOUR),
  mstr_treasury: policy(30 * MINUTE, 6 * HOUR, 30 * MINUTE, 6 * HOUR),
  ssro_stable: DAILY_LIVE,
  ssro_quote: LIVE,
  etf_oi: policy(12 * HOUR, 3 * DAY, 3 * DAY, 7 * DAY),
  coinbase_candles: DAILY_LIVE
});

// A forming candle is dated by its opening time. Its allowed data age includes
// one whole interval; its retrieval still has to satisfy the short fetch window.
const INTERVAL_MS = Object.freeze({
  '5m': 5 * MINUTE, '15m': 15 * MINUTE, '1h': HOUR,
  '4h': 4 * HOUR, '1d': DAY, '1w': 7 * DAY
});
const FLOW_FETCH_WARN_MS = Object.freeze({
  '15m': 3 * MINUTE, '1h': 5 * MINUTE, '4h': 10 * MINUTE,
  '1d': 20 * MINUTE, '1w': 30 * MINUTE
});

function getSourcePolicy(id) {
  const parts = String(id).split(':');
  if (parts[0] === 'fred') {
    if (!['DGS1', 'DGS10', 'DGS1MO', 'DGS3MO', 'DGS6MO', 'WALCL', 'WTREGEN', 'RRPONTSYD'].includes(parts[1])) {
      throw new Error(`Unknown FRED health source: ${id}`);
    }
    return ['WALCL', 'WTREGEN'].includes(parts[1])
      ? SOURCE_POLICIES.macro_weekly : SOURCE_POLICIES.macro_daily;
  }
  if (parts[0] === 'yahoo' && ['MSTR', 'STRC', 'STRF', 'STRD'].includes(parts[1])) {
    return parts[1] === 'MSTR' ? SOURCE_POLICIES.macro_daily : SOURCE_POLICIES.preferreds;
  }
  if (parts[0] === 'wave' || parts[0] === 'flow') {
    const interval = parts.find(part => Object.hasOwn(INTERVAL_MS, part));
    if (!interval) throw new Error(`Unknown data-health interval: ${id}`);
    const step = INTERVAL_MS[interval];
    const warn = parts[0] === 'wave' ? 3 * MINUTE : FLOW_FETCH_WARN_MS[interval];
    return policy(warn, Math.max(15 * MINUTE, warn * 3), step + 3 * MINUTE, step * 2 + 15 * MINUTE);
  }
  const result = SOURCE_POLICIES[id];
  if (!result) throw new Error(`Unknown data-health source: ${id}`);
  return result;
}

// Monitor runs are scheduled hourly. An absent file or unknown timestamp is
// unhealthy; it must never be replaced with the monitor's current time.
const JOB_POLICIES = Object.freeze({
  macro_snapshot: { warnMs: 8 * HOUR, blockMs: DAY },
  liquidity_hourly: { warnMs: 3 * HOUR, blockMs: DAY },
  block_insight_daily: { warnMs: 36 * HOUR, blockMs: 3 * DAY },
  mcclellan_daily: { warnMs: 36 * HOUR, blockMs: 3 * DAY }
});

module.exports = { SOURCE_POLICIES, JOB_POLICIES, getSourcePolicy, INTERVAL_MS };
