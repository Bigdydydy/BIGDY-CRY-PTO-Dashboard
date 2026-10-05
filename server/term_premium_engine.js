/**
 * Module 2: Futures Basis Term Structure & Carry Radar (schema v2)
 *
 * Term structure built only from tenors that actually trade on Binance COIN-M:
 *   0D perp funding (7-day average) → current quarter (dropped < 7D to expiry) → next quarter, plus a 90D
 *   constant maturity interpolated between the real points that bracket it.
 * Spreads:
 *   spreadShort    = CQ APR − funding APR       (short end: futures carry vs perp leverage cost)
 *   spreadCalendar = NQ APR − CQ APR            (quarterly calendar slope)
 *   spreadTerm     = 90D APR − funding APR      (overall term slope, always defined)
 * Benchmarks: FRED DGS3MO 3M T-Bill (dynamic) and hurdle = T-Bill + 3.5%.
 */

const fs = require('fs');
const {
  getHistoricalBasisData,
  fetchLiveBinanceCurve,
  applyCarryMetrics,
  calculateCarryScore,
  scoreTier,
  CACHE_FILE,
  HURDLE_SPREAD
} = require('./basis_fetcher');

// Spot ETF + short futures carry: annual sponsor fee and one-off round-trip costs
// (creation/redemption 0.10% + execution slippage 0.15%), amortized over a 90D hold.
const ETF_MGMT_FEE_ANNUAL = 0.25;
const ETF_ROUND_TRIP_COST = 0.25;
const ETF_HOLD_DAYS = 90;

function etfCarryMetrics(row) {
  if (row.apr90d == null || row.tbill == null) {
    return { etfNetCarry: null, etfArbitrageStatus: 'UNKNOWN' };
  }
  const costAnnualized = ETF_MGMT_FEE_ANNUAL + ETF_ROUND_TRIP_COST * 365 / ETF_HOLD_DAYS;
  const net = row.apr90d - row.tbill - costAnnualized;
  return {
    etfNetCarry: Number(net.toFixed(2)),
    etfCostAnnualized: Number(costAnnualized.toFixed(2)),
    etfArbitrageStatus: net >= 0 ? 'COVERED' : 'UNWIND_RISK'
  };
}

function readDiskSeries() {
  if (!fs.existsSync(CACHE_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (e) {
    console.warn('[TermPremiumEngine] Error reading CACHE_FILE:', e.message);
    return [];
  }
}

/**
 * Load the daily Binance history and attach the live Binance point (same exchange, same formulas).
 * Today's 00:00 UTC snapshot is replaced by the live point so the chart always ends on "now".
 */
async function loadHistoricalBasisSeries(liveOverride) {
  let baseSeries = [];
  try {
    baseSeries = await getHistoricalBasisData();
  } catch (err) {
    console.warn('[TermPremiumEngine] Fallback reading disk cache:', err.message);
    baseSeries = readDiskSeries();
  }
  const series = (baseSeries || []).map(item => ({ ...item }));
  if (!series.length) return series;

  // undefined → fetch live; false → history only (tests / offline); object → use as given
  let live = liveOverride;
  if (live === undefined) {
    live = null;
    try {
      live = await fetchLiveBinanceCurve(series[series.length - 1].tbill);
    } catch (err) {
      console.warn('[TermPremiumEngine] Live Binance curve unavailable:', err.message);
    }
  }

  if (live) {
    const todayStr = new Date(live.timestamp).toISOString().slice(0, 10);
    const point = { ...live, date: todayStr };
    if (series[series.length - 1].date === todayStr) series[series.length - 1] = point;
    else series.push(point);
    // Recompute rolling vol / momentum / score so the live point is scored on the same basis
    applyCarryMetrics(series);
  }

  for (const row of series) Object.assign(row, etfCarryMetrics(row));
  return series;
}

/**
 * Carry regime state machine on real tenors (checked in priority order)
 */
function evaluateCarryRegime(latest) {
  const {
    fundingApr, cqApr, nqApr, apr90d, tbill, hurdle,
    spreadShort, spreadTerm, excessOverTBill, excessOverHurdle, carryScore
  } = latest;
  const fmt = v => (v == null ? '--' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`);
  const tb = tbill ?? 4.0;
  const hd = hurdle ?? tb + HURDLE_SPREAD;

  if (apr90d < 1.0 || (cqApr != null && cqApr < 0) || (nqApr != null && nqApr < 0)) {
    return {
      regimeCode: 'CRISIS_COMPRESSION',
      regimeName: '基差断崖压缩 / 贴水 (Compression Cascade)',
      regimeBadgeClass: 'badge-neg',
      statusSummary: `90D 基差仅 ${fmt(apr90d)}，交割合约接近平水甚至贴水。套利头寸的展期收益消失，存量套利盘被迫平仓（卖现货/ETF、买回期货），对现货形成额外卖压。`,
      keyPointers: [
        `套利反噬：基差跌破 1% 后持有成本远超收益，期现多头集中解体。`,
        `资金费率 ${fmt(fundingApr)}：观察永续是否同步转负，确认杠杆多头是否已出清。`,
        `ETF 联动：此阶段 ETF 流出与 CME 杠杆基金回补空头往往同步发生（见下方联动验证）。`
      ]
    };
  }

  if (fundingApr != null && fundingApr > 15 && spreadTerm != null && spreadTerm < -5) {
    return {
      regimeCode: 'OVERCROWDED_INVERSION',
      regimeName: '永续杠杆拥挤 / 短端倒挂 (Perp Overcrowding)',
      regimeBadgeClass: 'badge-neg',
      statusSummary: `永续资金费率年化 ${fmt(fundingApr)} 显著高于 90D 交割基差 ${fmt(apr90d)}（期限斜率 ${fmt(spreadTerm)}）。杠杆多头集中在永续端支付高额资金费，交割曲线未跟随，结构脆弱。`,
      keyPointers: [
        `短端过热：资金费率远高于季度合约年化，说明需求来自高杠杆永续而非期限套利。`,
        `回落风险：资金费率均值回归时常伴随多头集中止损，引发局部踩踏。`,
        `套利视角：做空永续收资金费 + 现货多头的短期收益高于季度合约，但须承受资金费骤降风险。`
      ]
    };
  }

  if (excessOverTBill < 0) {
    return {
      regimeCode: 'SUB_TBILL_DRAIN',
      regimeName: '跌破美债基准 / 资金外流 (Sub-TBill Drain)',
      regimeBadgeClass: 'badge-neg',
      statusSummary: `90D 基差 ${fmt(apr90d)} 低于 3M 美债 ${tb.toFixed(2)}%（超额 ${fmt(excessOverTBill)}），期现套利的机会成本为负，资金倾向回流国债。`,
      keyPointers: [
        `机会成本劣势：无风险利率即可覆盖套利收益，基差交易缺乏经济合理性。`,
        `头寸逐步解体：关注 CME 杠杆基金净空头是否下降、ETF 是否同步流出。`,
        `现货买盘：缺少套利多头支撑，价格发现更依赖方向性资金。`
      ]
    };
  }

  if (excessOverHurdle < 0) {
    return {
      regimeCode: 'MARGINAL_CARRY',
      regimeName: '微利观望 / 低于机构门槛 (Marginal Carry)',
      regimeBadgeClass: 'badge-warning',
      statusSummary: `90D 基差 ${fmt(apr90d)} 高于 3M 美债但低于机构门槛 ${hd.toFixed(2)}%（美债 + ${HURDLE_SPREAD}%），仅低成本资金的加密原生套利可运转。`,
      keyPointers: [
        `机构门槛未达：超额收益 ${fmt(excessOverTBill)} 不足以补偿保证金占用与交易对手风险。`,
        `短端利差 ${fmt(spreadShort)}：季度合约相对永续的溢价决定展期优先级。`,
        `等待触发：需现货需求或杠杆多头推动 90D 基差重新越过门槛线。`
      ]
    };
  }

  return {
    regimeCode: 'NORMAL_CONTANGO',
    regimeName: '标准正向升水 (Healthy Contango)',
    regimeBadgeClass: 'badge-pos',
    statusSummary: `90D 基差 ${fmt(apr90d)} 超过机构门槛 ${hd.toFixed(2)}%（超额美债 ${fmt(excessOverTBill)}），期限斜率 ${fmt(spreadTerm)}，套利评分 ${carryScore ?? '--'}。期现套利具备稳定吸引力。`,
    keyPointers: [
      `正向升水：远月稳定溢价，合规长钱的期现套利（ETF 多 + CME 空）收益覆盖资金成本。`,
      `ETF 联动：此阶段 ETF 流入中套利对冲占比通常上升，需与方向性需求区分。`,
      `注意拥挤：评分持续高位时关注资金费率是否抢跑，防止短端过热反转。`
    ]
  };
}

/**
 * Main Engine API. `futuresList` / `spotPrice` are accepted for call-site compatibility only:
 * the curve is now sourced from Binance so history and the live point share one exchange.
 */
async function analyzeTermPremium(futuresList, spotPrice, options = {}) {
  const historicalSeries = await loadHistoricalBasisSeries(options.live);
  const latest = historicalSeries[historicalSeries.length - 1];
  if (!latest) throw new Error('Term premium history unavailable');
  const regime = evaluateCarryRegime(latest);
  const tier = scoreTier(latest.carryScore);

  return {
    spotPrice: latest.btcPrice || spotPrice,
    tBillRate: latest.tbill,
    hurdleRate: latest.hurdle,
    hurdleSpread: HURDLE_SPREAD,
    metadata: {
      dataSource: 'Binance COIN-M BTCUSD 永续资金费率 + 当季/次季交割基差 (2024.01 ~ 至今真实日线) + Binance 实时盘口；3M 美债 FRED DGS3MO',
      timeRange: `${historicalSeries[0].date} 至 ${latest.date}`,
      tenorMethod: '仅用真实可交易期限点：0D 永续资金费率 (7 日均值年化) / 当季 (距交割 <7 天剔除) / 次季；90D 在相邻真实点间线性插值，不做外推',
      scoreMethod: '套利评分 0-100 = 60% 套利夏普 ((90D−美债)/基差盯市年化波动) + 25% 期限结构 (90D−资金费率) + 15% 30 日基差动量',
      isRealHistorical: true
    },
    current: {
      ...latest,
      scoreTierLabel: tier.label,
      timestamp: latest.timestamp,
      date: latest.date
    },
    contracts: latest.contracts || [],
    regime,
    series: historicalSeries.map(({ contracts, ...row }) => row)
  };
}

module.exports = {
  loadHistoricalBasisSeries,
  evaluateCarryRegime,
  analyzeTermPremium,
  calculateCarryScore,
  etfCarryMetrics,
  ETF_MGMT_FEE_ANNUAL,
  ETF_ROUND_TRIP_COST
};
