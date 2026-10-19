// Archive publication checks are distinct from live-fetch deadlines. A six-hour
// scheduled snapshot must not be judged by a live quote's three-minute window.
const { SOURCE_POLICIES, JOB_POLICIES } = require('./data_health_policy');

const MONITOR_JOBS = Object.freeze([
  'macro_snapshot', 'liquidity_hourly', 'block_insight_daily', 'mcclellan_daily'
]);

const MONITOR_LIVE_MODULES = Object.freeze([
  'macro_liquidity', 'option_atm_iv', 'term_premium_basis', 'dynamic_gex',
  'whale_block_trades', 'iv_smile_and_skew', 'coinbase_orderbook_liquidity',
  'gold_btc_correlation', 'ssro_oscillator', 'crypto_mcclellan_breadth',
  'cdri', 'mstr_preferreds', 'etf_linkage', 'flow_force', 'wave_engine',
  'block_insight', 'option_marks', 'option_oi_history', 'coinbase_liquidity_history'
]);

const SNAPSHOT_CHECKS = Object.freeze([
  {
    id: 'macro_snapshot',
    file: 'macro_chart.json',
    kind: 'source_metadata',
    sources: [
      'macro', 'fred:DGS1', 'fred:DGS10', 'fred:WALCL',
      'fred:WTREGEN', 'fred:RRPONTSYD', 'macro_btc', 'yahoo:MSTR'
    ]
  },
  {
    id: 'preferreds_snapshot',
    file: 'mstr_preferreds_cache.json',
    kind: 'source_metadata',
    sources: ['preferreds', 'yahoo:STRC', 'yahoo:STRF', 'yahoo:STRD', 'fred:DGS1MO']
  },
  {
    id: 'liquidity_archive',
    file: 'coinbase_liquidity_history.json',
    kind: 'sample_times',
    arrayField: 'samples',
    timestampField: 'ts',
    sourcePolicy: 'liquidity_history'
  },
  {
    id: 'option_oi_archive',
    file: 'option_oi_history_BTC.json',
    kind: 'sample_times',
    arrayField: 'snapshots',
    timestampField: 'ts',
    sourcePolicy: 'oi_history'
  },
  {
    id: 'block_flow_archive',
    file: 'block_flow_daily_BTC.json',
    kind: 'event_archive',
    producerJob: 'block_insight_daily',
    producerStep: 'block_trades',
    collectionField: 'days'
  },
  {
    id: 'smart_money_archive',
    file: 'smart_money_BTC.json',
    kind: 'event_archive',
    producerJob: 'block_insight_daily',
    producerStep: 'marks',
    collectionField: 'structures'
  },
  {
    id: 'mcclellan_core',
    file: 'crypto_mcclellan.json',
    kind: 'breadth_track',
    track: 'core',
    seriesCountField: 'core_n',
    sourcePolicy: 'mcclellan_core'
  },
  {
    id: 'mcclellan_frontier',
    file: 'crypto_mcclellan.json',
    kind: 'breadth_track',
    track: 'frontier',
    seriesCountField: 'frontier_n',
    sourcePolicy: 'mcclellan_frontier'
  }
]);

// Event dates cannot detect a stopped collector: a successful check with no new
// trades is legitimate. Those checks use the producer step's receipt instead.
// Other archive checks use actual observations, never generated_at or file mtime.
const MONITOR_CONTRACT = Object.freeze({
  maxFutureSkewMs: 5 * 60000,
  liveTimeoutMs: 15000,
  liveRetries: 0,
  webhookTimeoutMs: 10000,
  webhookRetries: 0,
  schedule: '49 * * * *',
  jobFilePrefix: 'job_health_',
  missingHeartbeat: 'UNKNOWN',
  missingLiveUrl: 'UNKNOWN',
  warnState: 'DEGRADED',
  blockState: 'CRITICAL'
});

module.exports = {
  MONITOR_JOBS, MONITOR_LIVE_MODULES, SNAPSHOT_CHECKS,
  MONITOR_CONTRACT, SOURCE_POLICIES, JOB_POLICIES
};
