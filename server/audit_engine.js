/**
 * Module: System Data Provenance & Freshness Audit Engine
 *
 * Read-only snapshot inspection over the data-health registry plus the
 * in-memory market cache. It never calls a data-fetching getter and performs
 * no network I/O unless a live probe is explicitly requested (doProbe).
 *
 * Health semantics come from data_health.js per-source windows:
 *   ONLINE       - every mapped source is OK
 *   DEGRADED     - some mapped source usable but not OK (fallback/stale)
 *   OFFLINE      - at least one source observed and none usable
 *   INITIALIZING - nothing observed yet (never seen, not a failure)
 */

const { getSourceHealth, listSources } = require('./data_health');
const { getCachedData } = require('./data_fetcher');
const { fetchWithTimeout } = require('./http_client');

/**
 * Probe upstream endpoints latency AND response shape.
 * Opt-in only (doProbe); never recorded as a business success.
 */
async function probeUpstreamTargets() {
  const targets = [
    {
      name: 'Coinbase Public API',
      url: 'https://api.exchange.coinbase.com/products/BTC-USD/ticker',
      check: j => Number(j?.price) > 0
    },
    {
      name: 'Deribit Public API',
      url: 'https://www.deribit.com/api/v2/public/test',
      check: j => j && typeof j === 'object' && j.result !== undefined && j.result !== null
    },
    {
      name: 'Binance Public API',
      url: 'https://api.binance.com/api/v3/ping',
      check: j => j && typeof j === 'object' && !Array.isArray(j) && Object.keys(j).length === 0
    },
    {
      name: 'DefiLlama Stablecoins',
      url: 'https://stablecoins.llama.fi/stablecoincharts/all',
      check: j => Array.isArray(j) && j.length > 0
    }
  ];

  const results = {};
  await Promise.all(
    targets.map(async t => {
      const start = Date.now();
      try {
        const resp = await fetchWithTimeout(t.url, { timeout: 3000, retries: 0 });
        const latency = Date.now() - start;
        if (!resp.ok) {
          results[t.name] = { url: t.url, status: `HTTP_${resp.status}`, httpCode: resp.status, latencyMs: latency, valid: false };
          return;
        }
        let json;
        try {
          json = await resp.json();
        } catch (e) {
          results[t.name] = { url: t.url, status: 'INVALID_JSON', httpCode: resp.status, latencyMs: latency, valid: false };
          return;
        }
        const valid = t.check(json);
        results[t.name] = {
          url: t.url,
          status: valid ? 'REACHABLE' : 'INVALID_SHAPE',
          httpCode: resp.status,
          latencyMs: latency,
          valid
        };
      } catch (err) {
        results[t.name] = {
          url: t.url,
          status: 'UNREACHABLE',
          error: err.message,
          latencyMs: Date.now() - start,
          valid: false
        };
      }
    })
  );
  return results;
}

/**
 * Human-readable elapsed seconds and display string. No implicit now-fallback:
 * unknown timestamps display as 未捕获.
 */
function getElapsedMetrics(isoOrTs) {
  if (!isoOrTs) return { secondsAgo: null, display: '未捕获' };
  const ts = typeof isoOrTs === 'number' ? isoOrTs : new Date(isoOrTs).getTime();
  if (isNaN(ts)) return { secondsAgo: null, display: '格式异常' };

  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return { secondsAgo: diffSec, display: `${diffSec} 秒前` };
  if (diffSec < 3600) return { secondsAgo: diffSec, display: `${Math.floor(diffSec / 60)} 分钟前` };
  return { secondsAgo: diffSec, display: `${Math.floor(diffSec / 3600)} 小时前` };
}

/**
 * Strategy disclosures gate on the capital path in use: the SEC path (index +
 * 8-K bodies + mNAV) when the 8-K scan is healthy and the issuer /debt page is
 * not; otherwise the issuer path. The other path's sources stay ancillary.
 */
function mstrDisclosureSourceIds(now = Date.now()) {
  const issuer = ['mstr_official_ledger', 'mstr_official_shares', 'mstr_official_capital',
    'mstr_official_press', 'mstr_sec_index', 'mstr_mnav_inputs'];
  const secPath = ['mstr_sec_index', 'mstr_sec_filings', 'mstr_mnav_inputs'];
  const onSec = getSourceHealth('mstr_sec_filings', now).state === 'OK'
    && getSourceHealth('mstr_official_capital', now).state !== 'OK';
  return onSec
    ? { sourceIds: secPath, ancillaryIds: issuer.filter(id => !secPath.includes(id)) }
    : { sourceIds: issuer, ancillaryIds: ['mstr_sec_filings'] };
}

/**
 * Aggregate registry health for a module's mapped source ids.
 * ancillary ids are reported in `sources` but never gate the status.
 */
function aggregateSourceHealth(sourceIds, ancillaryIds, now) {
  const sources = {};
  const gating = [...sourceIds];
  for (const id of gating.concat(ancillaryIds)) {
    sources[id] = getSourceHealth(id, now);
  }
  const hs = gating.map(id => sources[id]);

  // INITIALIZING = every required source is UNKNOWN, even if attempts or
  // half-invalid seeds touched the registry — nothing trustworthy observed.
  const allUnknown = hs.length > 0 && hs.every(h => h.state === 'UNKNOWN');
  let healthStatus;
  if (!hs.length || allUnknown) healthStatus = 'INITIALIZING';
  else if (hs.every(h => h.state === 'OK')) healthStatus = 'ONLINE';
  else if (hs.some(h => h.usable)) healthStatus = 'DEGRADED';
  else healthStatus = 'OFFLINE';

  let freshnessStatus;
  if (!hs.length || allUnknown) freshnessStatus = 'UNKNOWN';
  else if (hs.some(h => h.freshnessStatus === 'STALE')) freshnessStatus = 'STALE';
  else if (hs.every(h => h.freshnessStatus === 'FRESH')) freshnessStatus = 'FRESH';
  else freshnessStatus = 'UNKNOWN';

  // Freshness is the weakest link: oldest required dataAsOf. Any required
  // source without a data timestamp makes the module's lastUpdated unknown.
  let lastUpdated = null;
  if (hs.length && hs.every(h => h.dataAsOf)) {
    lastUpdated = hs.map(h => h.dataAsOf).sort()[0];
  }
  let latestDataAsOf = null;
  for (const h of gating.concat(ancillaryIds).map(id => sources[id])) {
    if (h.dataAsOf && (!latestDataAsOf || h.dataAsOf > latestDataAsOf)) latestDataAsOf = h.dataAsOf;
  }

  return {
    healthStatus,
    freshnessStatus,
    lastUpdated,
    latestDataAsOf,
    analysisAllowed: hs.length > 0 && hs.every(h => h.usable),
    blockedSources: gating.filter((id, i) => !hs[i].usable),
    sources,
    sourceIds: gating,
    ancillaryIds
  };
}

function decorateModule(mod, sourceIds, ancillaryIds, now) {
  const agg = aggregateSourceHealth(sourceIds, ancillaryIds, now);
  const elapsed = getElapsedMetrics(agg.lastUpdated);
  return {
    ...mod,
    sourceIds: agg.sourceIds,
    ancillarySourceIds: agg.ancillaryIds,
    sources: agg.sources,
    healthStatus: agg.healthStatus,
    freshnessStatus: agg.freshnessStatus,
    lastUpdated: agg.lastUpdated,
    latestDataAsOf: agg.latestDataAsOf,
    analysisAllowed: agg.analysisAllowed,
    blockedSources: agg.blockedSources,
    updatedSecondsAgo: elapsed.secondsAgo,
    updatedTimeDisplay: elapsed.display,
    stale: agg.freshnessStatus === 'STALE'
  };
}

/** Observed dynamic ids for wave/flow sources; nothing invented when unobserved. */
function observedIds(prefix) {
  return listSources(prefix).map(r => r.id);
}

/**
 * Central Audit Inspection Method. Read-only: registry + in-memory cache only.
 */
async function getSystemAuditData(doProbe = false) {
  const now = Date.now();
  // Quantize timestamp to 5s window to ensure stable ETag for client caching
  const quantizedSec = Math.floor(now / 5000) * 5;
  const serverTimeUTC = new Date(quantizedSec * 1000).toISOString();
  const uptimeQuantized = Math.floor(process.uptime() / 5) * 5;

  const cache = getCachedData() || {};

  const moduleSpecs = [
    {
      id: 'macro_liquidity',
      name: '宏观流动性、美债利差与 MSTR 持仓成本',
      viewId: 'view-overview',
      primarySource: 'FRED CSV (圣路易斯联储) + Binance BTC 日线 + Yahoo MSTR + bitcointreasuries.net + Coinglass',
      targetEndpoints: [
        'https://fred.stlouisfed.org/graph/fredgraph.csv (DGS1, DGS10, WALCL, WTREGEN, RRPONTSYD)',
        'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d',
        'https://query1.finance.yahoo.com/v8/finance/chart/MSTR',
        'https://bitcointreasuries.net (official MSTR purchases)',
        'https://capi.coinglass.com/api/escape/index/microStrategyCostV2'
      ],
      timeframe: '宏观长线日频 (FRED 美债) + 周频 (WALCL 联储资产) + 30秒动态现货注入',
      updateInterval: '5m 后台常驻轮询',
      isRealtime: true,
      provenanceSignatures: [
        'FRED_DGS1_1Y_YIELD',
        'FRED_DGS10_10Y_YIELD',
        'FRED_WALCL_TOTAL_ASSETS',
        'MSTR_OFFICIAL_PURCHASES_SEC_8K',
        'DYNAMIC_SPOT_PROFIT_MULTIPLIER'
      ],
      sourceIds: ['macro', 'fred:DGS1', 'fred:DGS10', 'fred:WALCL', 'fred:WTREGEN', 'fred:RRPONTSYD', 'macro_btc', 'yahoo:MSTR'],
      ancillaryIds: ['mstr_cost', 'mstr_treasury']
    },
    {
      id: 'option_atm_iv',
      name: '期权 ATM IV 期限结构与极值分位数雷达',
      viewId: 'view-options',
      primarySource: 'Greeks.live DataLab + Deribit DVOL 官方收盘历史',
      targetEndpoints: [
        'https://api.greeks.live/api/v1/deribit/datalab/atm_data',
        'https://www.deribit.com/api/v2/public/get_volatility_index_data'
      ],
      timeframe: '30秒实时 Tick 级插值 (1M/2M/3M/6M/1Y) + 2年 DVOL 历史 ECDF',
      updateInterval: '30s 自动轮询',
      isRealtime: true,
      maturitiesTracked: Array.isArray(cache.atmData) ? cache.atmData.length : null,
      provenanceSignatures: [
        'DERIBIT_DVOL_2Y_ECDF_PERCENTILES',
        'REALTIME_DTE_FORWARD_INTERPOLATION',
        'GREEKS_DATALAB_ATM_MATRIX'
      ],
      sourceIds: ['greeks_atm', 'greeks_iv_history', 'deribit_dvol']
    },
    {
      id: 'term_premium_basis',
      name: '期现基差期限结构、套利评分与 ETF × 套利资金联动',
      viewId: 'view-term-premium',
      primarySource: 'Deribit 当季/次季季度合约 (2024.01~至今) + CoinGlass 全市场 OI 加权资金费率 (备用 Deribit 永续) + FRED DGS3MO + CoinGlass ETF 流量/OI + CFTC TFF',
      targetEndpoints: [
        'https://www.deribit.com/api/v2/public/get_tradingview_chart_data',
        'https://www.deribit.com/api/v2/public/get_funding_rate_history?instrument_name=BTC-PERPETUAL',
        'https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=future',
        'https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS3MO',
        'https://capi.coinglass.com/api/etf/flow',
        'https://publicreporting.cftc.gov/resource/gpe5-46if.json'
      ],
      timeframe: '2024.01 至今基差日线 (08:00 UTC) + 60s 实时 Deribit 曲线；ETF/COT 周度联动',
      updateInterval: '30s 自动轮询 (实时曲线 60s 缓存，联动数据 6h)',
      isRealtime: true,
      provenanceSignatures: [
        'REAL_TENOR_CURVE_FUNDING_CQ_NQ',
        'CQ_FINAL_WEEK_EXCLUSION',
        'CARRY_SHARPE_BASIS_MTM_VOL_SCORE',
        'DYNAMIC_3M_TBILL_HURDLE',
        'ETF_CME_HEDGE_RATIO_REGRESSION'
      ],
      sourceIds: ['basis_live', 'basis_history', 'fred:DGS3MO']
    },
    {
      id: 'dynamic_gex',
      name: '动态 Gamma 暴露 (GEX) 矩阵与多空防线',
      viewId: 'view-options',
      primarySource: 'Greeks.live DataLab (聚合 Deribit 全品种期权未平仓 OI 逐档 Greeks)',
      targetEndpoints: ['https://api.greeks.live/api/v1/deribit/datalab/gex'],
      timeframe: '30秒盘口做市商 Delta 对冲重估',
      updateInterval: '30s 自动轮询',
      isRealtime: true,
      spotPrice: cache.gex?.index_price || null,
      provenanceSignatures: [
        'CALL_WALL_OI_DISTRIBUTION',
        'PUT_WALL_OI_DISTRIBUTION',
        'GAMMA_FLIP_ZERO_POINT'
      ],
      sourceIds: ['greeks_gex']
    },
    {
      id: 'whale_block_trades',
      name: '大宗巨鲸与冰山聚集战略雷达',
      viewId: 'view-block-trades',
      primarySource: 'Greeks.live 官方 `/api/v1/block_trade` (Deribit 场外大宗与大单撮合记录)',
      targetEndpoints: ['https://api.greeks.live/api/v1/block_trade'],
      timeframe: '30秒增量捕获 + 本地 30 天滑动窗口持久化',
      updateInterval: '30s 自动轮询',
      isRealtime: true,
      storedTradesCount: Array.isArray(cache.blockTrades) ? cache.blockTrades.length : null,
      provenanceSignatures: [
        'GLOBAL_TRADE_ID_HASH_DEDUPLICATION',
        'MULTI_LEG_DERIBIT_GREEKS_STRATEGY',
        'ICEBERG_5MIN_CLUSTER_DETECTION'
      ],
      sourceIds: ['greeks_trades']
    },
    {
      id: 'iv_smile_and_skew',
      name: 'IV 波动率微笑与 25Δ 偏斜偏度',
      viewId: 'view-options',
      primarySource: 'Greeks.live DataLab 偏斜曲线与月份切片',
      targetEndpoints: [
        'https://api.greeks.live/api/v1/deribit/datalab/skew_chart',
        'https://api.greeks.live/api/v1/deribit/datalab/iv_skew_month'
      ],
      timeframe: '30秒盘口无套利凸性检验',
      updateInterval: '30s 自动轮询',
      isRealtime: true,
      provenanceSignatures: [
        'BLACK_76_OPTION_PRICING_MODEL',
        '25_DELTA_SKEW_STRUCTURE_7D_30D_60D_90D_180D'
      ],
      sourceIds: ['greeks_smile', 'greeks_skew']
    },
    {
      id: 'coinbase_orderbook_liquidity',
      name: 'Coinbase 订单簿微观深度与滑点雷达',
      viewId: 'view-coinbase-liquidity',
      primarySource: 'Coinbase Exchange 官方 L2 深度盘口与日 K 线',
      targetEndpoints: [
        'https://api.exchange.coinbase.com/products/BTC-USD/book?level=2',
        'https://api.exchange.coinbase.com/products/BTC-USD/candles',
        'https://api.exchange.coinbase.com/products/BTC-USD/ticker'
      ],
      timeframe: '15秒高频订单簿级联步进 (Order Book Walk)',
      updateInterval: '15s 高频轮询 (当前视口激活)',
      isRealtime: true,
      provenanceSignatures: [
        'COINBASE_L2_50_BID_ASK_LEVELS',
        'ORDER_BOOK_WALK_SLIPPAGE_ESTIMATION',
        'MID_RANK_ECDF_PERCENTILES'
      ],
      sourceIds: ['coinbase', 'coinbase_candles']
    },
    {
      id: 'gold_btc_correlation',
      name: '黄金与比特币比率及滚动相关性引擎',
      viewId: 'view-gold-correlation',
      primarySource: 'PAXG + BTC 现货日线：Binance 优先，被拒 (418/451) 时改用 OKX / Coinbase',
      targetEndpoints: ['https://api.binance.com/api/v3/klines'],
      timeframe: '1,000 天完整日线 + 30秒实时现货相关性联动',
      updateInterval: '30s 自动轮询',
      isRealtime: true,
      provenanceSignatures: [
        'BINANCE_PAXGUSDT_1000D_DAILY_KLINES',
        'PEARSON_ROLLING_30D_90D_180D_MATRIX'
      ],
      sourceIds: ['gold']
    },
    {
      id: 'ssro_oscillator',
      name: '稳定币比率震荡指标 (SSRO)',
      viewId: 'view-ssro',
      primarySource: 'DefiLlama 全网稳定币总市值 + BTC 现货日线 (Binance 优先，备用 OKX / Coinbase)',
      targetEndpoints: [
        'https://stablecoins.llama.fi/stablecoincharts/all',
        'https://api.binance.com/api/v3/klines?symbol=BTCUSDT'
      ],
      timeframe: '全网 3,221 天历史日频 + 200DMA 布林带',
      updateInterval: '日频 / 手动强制刷新',
      isRealtime: true,
      provenanceSignatures: [
        'DEFILLAMA_ALL_STABLECOIN_SUPPLY',
        '200DMA_BOLLINGER_BANDS_OSCILLATOR'
      ],
      sourceIds: ['ssro', 'ssro_stable'],
      ancillaryIds: ['ssro_quote']
    },
    {
      id: 'crypto_mcclellan_breadth',
      name: '加密麦克莱伦市场宽度振荡器 (Core Top 100 vs 链上 Meme)',
      viewId: 'view-overview',
      primarySource: 'CoinGecko Top 100 (按当日市值) + GeckoTerminal / DexScreener 链上 Meme (Solana · BSC · Robinhood)',
      targetEndpoints: ['Python 计算流水线 (scripts/crypto_mcclellan/export_to_json.py)'],
      timeframe: 'UTC 日收盘 · 比率调整 RAMO 的 EMA(19/39) 差值与累加指数',
      updateInterval: '每日 UTC 23:30 (GitHub Actions)',
      isRealtime: false,
      provenanceSignatures: [
        'RATIO_ADJUSTED_MCCLELLAN_EMA19_EMA39',
        'POINT_IN_TIME_TOP100_EX_ANTE_UNIVERSE'
      ],
      sourceIds: ['mcclellan_core', 'mcclellan_frontier'],
      ancillaryIds: ['mcclellan_anchor']
    },
    {
      id: 'cdri',
      name: 'CDRI 加密衍生品风险指数',
      viewId: 'view-overview',
      primarySource: 'CoinGlass / Deribit 衍生品聚合风险指标管线',
      targetEndpoints: ['server/cdri_fetcher.js 上游管线'],
      timeframe: '日频风险指数',
      updateInterval: '后台轮询 / 手动强制刷新',
      isRealtime: false,
      provenanceSignatures: ['CDRI_DAILY_DERIVATIVES_RISK'],
      sourceIds: ['cdri']
    },
    {
      id: 'mstr_preferreds',
      name: 'MSTR 优先股资本结构与持仓成本',
      viewId: 'view-overview',
      primarySource: 'Yahoo Finance (STRC / STRF / STRD 优先股报价) + FRED DGS1MO',
      targetEndpoints: [
        'https://query1.finance.yahoo.com/v8/finance/chart/STRC',
        'https://query1.finance.yahoo.com/v8/finance/chart/STRF',
        'https://query1.finance.yahoo.com/v8/finance/chart/STRD',
        'https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS1MO'
      ],
      timeframe: '事件驱动 + 日频核对',
      updateInterval: '后台轮询 / 手动强制刷新',
      isRealtime: false,
      provenanceSignatures: ['YAHOO_STRC_STRF_STRD_QUOTES', 'FRED_DGS1MO_1M_TBILL'],
      sourceIds: ['preferreds', 'yahoo:STRC', 'yahoo:STRF', 'yahoo:STRD', 'fred:DGS1MO']
    },
    {
      id: 'etf_linkage',
      name: 'ETF 资金流 × 期现套利联动引擎',
      viewId: 'view-term-premium',
      primarySource: 'CoinGlass ETF 流量/OI + CFTC TFF COT 周度仓位',
      targetEndpoints: [
        'https://capi.coinglass.com/api/etf/flow',
        'https://publicreporting.cftc.gov/resource/gpe5-46if.json'
      ],
      timeframe: 'ETF 日频 + COT 周度',
      updateInterval: '6h 联动刷新',
      isRealtime: false,
      provenanceSignatures: ['ETF_CME_HEDGE_RATIO_REGRESSION'],
      sourceIds: ['etf', 'cot', 'etf_oi'],
      ancillaryIds: ['basis_live', 'basis_history']
    },
    {
      id: 'leverage_norm',
      name: '杠杆与资金归一化 (资金费×OI / OI 按币计 / ETF 流入÷成交额 / 期权÷期货)',
      viewId: 'view-term-premium',
      primarySource: 'CoinGlass 全场所期货/期权 OI 与 OI 加权资金费率 + CoinGlass ETF 流量 × Yahoo ETF 日成交额',
      targetEndpoints: [
        'https://capi.coinglass.com/api/openInterest/v3/chart',
        'https://capi.coinglass.com/api/option/oi/history',
        'https://capi.coinglass.com/api/priceAndIndicator?index=avg_fr_kline',
        'https://capi.coinglass.com/api/etf/flow',
        'https://query1.finance.yahoo.com/v8/finance/chart/IBIT'
      ],
      timeframe: '日频：OI 2020 起，资金费约 1000 天，ETF 2024-01 起',
      updateInterval: '1h 缓存 / 按需刷新',
      isRealtime: false,
      provenanceSignatures: ['CHAIN_LINKED_ALL_VENUE_OI', 'FUNDING_X_PERP_OI_30D_USD', 'ETF_FLOW_TO_DOLLAR_VOLUME_20D'],
      sourceIds: ['lev_oi', 'lev_funding'],
      ancillaryIds: ['lev_etf_flow', 'etf_volume']
    },
    {
      id: 'flow_force',
      name: '多场所资金流向力度 (Flow Force)',
      viewId: 'view-ssro',
      primarySource: '各交易所现货/期货成交量压力合成',
      targetEndpoints: ['server/flow_force.js 上游管线'],
      timeframe: '多周期 K 线成交量',
      updateInterval: '实时计算 / 按需',
      isRealtime: true,
      provenanceSignatures: ['MULTI_VENUE_VOLUME_PRESSURE'],
      // Gate only aggregate ids (flow:<tf>); venue/FX leaves are ancillary.
      sourceIds: observedIds('flow:').filter(id => id.split(':').length === 2),
      ancillaryIds: observedIds('flow:').filter(id => id.split(':').length > 2)
    },
    {
      id: 'wave_engine',
      name: 'Elliott 波浪引擎 (多周期研判)',
      viewId: 'view-wave-radar',
      primarySource: 'Binance/Bybit/OKX K 线多源回退',
      targetEndpoints: ['https://fapi.binance.com/fapi/v1/klines', 'server/wave_engine.js'],
      timeframe: '15m / 1h / 4h 研判 + 子浪/高周期背景',
      updateInterval: '按需拉取 + 档位缓存',
      isRealtime: true,
      provenanceSignatures: ['ELLIOTT_WAVE_MULTI_TF'],
      sourceIds: observedIds('wave:')
    },
    {
      id: 'block_insight',
      name: '大宗交易资金流日聚合与聪明钱命中率 (4B)',
      viewId: 'view-block-insight',
      primarySource: '本地大宗成交持久化 + Deribit OI 快照',
      targetEndpoints: ['server/block_insight.js 聚合管线'],
      timeframe: '日聚合资金流向 / OI 日快照',
      updateInterval: '日频 + 按需',
      isRealtime: false,
      provenanceSignatures: ['BLOCK_FLOW_DAILY_AGGREGATION', 'SMART_MONEY_HIT_RATE'],
      sourceIds: ['block_flow', 'smart_money']
    },
    {
      id: 'mstr_disclosures',
      name: 'Strategy 官方披露采集',
      viewId: 'view-overview',
      primarySource: 'Strategy 官方 BTC 账本与股数表 + 资本结构页 + 公告索引 + SEC submissions 申报索引 + 官方 mNAV 输入 (Yahoo MSTR / Coinbase BTC)',
      targetEndpoints: [
        'https://www.strategy.com/ledger',
        'https://www.strategy.com/shares',
        'https://www.strategy.com/debt',
        'https://www.strategy.com/press',
        'https://data.sec.gov/submissions/CIK0001050446.json',
        'https://www.sec.gov/Archives/edgar/data/1050446/ (8-K)',
        'https://data.sec.gov/api/xbrl/companyconcept/CIK0001050446/',
        'https://query1.finance.yahoo.com/v8/finance/chart/MSTR',
        'https://api.exchange.coinbase.com/products/BTC-USD/ticker'
      ],
      timeframe: '事件披露与资本结构；strategy.com 可用时为主，否则由 SEC 8-K 正文 (持仓、美元资产、增发/回购、STRC 股息率) 与官网参考条款推导；XBRL 仅作交叉核对；官方 mNAV 按 2026-07-23 方法由披露输入推算',
      updateInterval: '常驻实例每 5 分钟检查',
      isRealtime: false,
      provenanceSignatures: [
        'STRATEGY_ISSUER_LEDGER',
        'STRATEGY_REPORTED_SHARES',
        'STRATEGY_CAPITAL_SNAPSHOT',
        'STRATEGY_PRESS_INDEX',
        'SEC_FILING_DISCOVERY_ONLY',
        'SEC_8K_PARSED',
        'STRATEGY_MNAV_2026_07_23'
      ],
      ...mstrDisclosureSourceIds()
    },
    {
      id: 'option_marks',
      name: 'Deribit 期权标记价 (mark IV / forward)',
      viewId: 'view-options',
      primarySource: 'Deribit book_summary 实时标记',
      targetEndpoints: ['https://www.deribit.com/api/v2/public/get_book_summary_by_currency'],
      timeframe: '30s 标记价快照',
      updateInterval: '按需拉取 (30s 内存缓存)',
      isRealtime: true,
      provenanceSignatures: ['DERIBIT_MARK_IV_FORWARD'],
      sourceIds: ['option_marks']
    },
    {
      id: 'option_oi_history',
      name: '期权未平仓 OI 日快照历史',
      viewId: 'view-options',
      primarySource: 'Deribit book_summary OI 每日快照持久化',
      targetEndpoints: ['server/option_oi_history.js 持久化管线'],
      timeframe: '日频 OI 快照',
      updateInterval: '日频后台补采',
      isRealtime: false,
      provenanceSignatures: ['OI_DAILY_SNAPSHOT_ARCHIVE'],
      sourceIds: ['oi_history']
    },
    {
      id: 'coinbase_liquidity_history',
      name: 'Coinbase 深度逐小时档案',
      viewId: 'view-coinbase-liquidity',
      primarySource: 'GitHub Actions 逐小时采样 + 在线补充采样',
      targetEndpoints: ['server/liquidity_history.js 档案管线'],
      timeframe: '逐小时订单簿深度档案',
      updateInterval: '逐小时 (外部工作流) + 5min 在线采样',
      isRealtime: false,
      provenanceSignatures: ['COINBASE_L2_HOURLY_ARCHIVE'],
      sourceIds: ['liquidity_history']
    }
  ];

  const modules = {};
  for (const spec of moduleSpecs) {
    const { sourceIds, ancillaryIds, ...meta } = spec;
    modules[spec.id] = decorateModule(meta, sourceIds, ancillaryIds || [], now);
  }

  // Aggregate module-level verdicts
  const allModulesList = Object.values(modules);
  const onlineCount = allModulesList.filter(m => m.healthStatus === 'ONLINE').length;
  const totalCount = allModulesList.length;
  const staleModules = allModulesList.filter(m => m.freshnessStatus !== 'FRESH').map(m => m.id);
  const offlineModules = allModulesList.filter(m => m.healthStatus === 'OFFLINE').map(m => m.id);
  const unknownModules = allModulesList.filter(m => m.healthStatus === 'INITIALIZING').map(m => m.id);
  const degradedModules = allModulesList.filter(m => m.healthStatus === 'DEGRADED').map(m => m.id);

  // Truthful overall: HEALTHY only when every module is ONLINE; CRITICAL when
  // at least one observed module is fully unusable; UNKNOWN when nothing has
  // ever been observed; otherwise DEGRADED.
  let overallHealth;
  if (onlineCount === totalCount) overallHealth = 'HEALTHY';
  else if (offlineModules.length) overallHealth = 'CRITICAL';
  else if (unknownModules.length === totalCount) overallHealth = 'UNKNOWN';
  else overallHealth = 'DEGRADED';

  const auditReport = {
    code: 0,
    serverTimeUTC,
    serverUptimeSeconds: uptimeQuantized,
    overallHealth,
    summary: `全系统 ${totalCount} 大量化板块与微观子模块：${onlineCount} 在线、${degradedModules.length} 降级、${offlineModules.length} 离线、${unknownModules.length} 未观测。`
      + (offlineModules.length ? ` 离线: ${offlineModules.join(', ')}。` : '')
      + (degradedModules.length ? ` 降级: ${degradedModules.join(', ')}。` : ''),
    modulesCount: totalCount,
    onlineModulesCount: onlineCount,
    degradedModulesCount: degradedModules.length,
    offlineModulesCount: offlineModules.length,
    unknownModulesCount: unknownModules.length,
    staleModulesCount: staleModules.length,
    staleModules,
    offlineModules,
    unknownModules,
    modules
  };

  // Explicit opt-in live connectivity probe only; results never register as
  // business-data success, and probe failures downgrade the overall verdict.
  if (doProbe) {
    auditReport.probeResults = await probeUpstreamTargets();
    const probeFailed = Object.values(auditReport.probeResults).some(r => r.status !== 'REACHABLE');
    auditReport.probeOk = !probeFailed;
    if (probeFailed && (overallHealth === 'HEALTHY' || overallHealth === 'UNKNOWN')) {
      auditReport.overallHealth = 'DEGRADED';
    }
  }

  return auditReport;
}

module.exports = {
  getSystemAuditData,
  probeUpstreamTargets
};
