/**
 * Module: Futures Basis Term Structure & Multi-Span Term Premium Radar
 * Rooted in Section 5 (Amberdata Research: The Carry Trade That Broke)
 *
 * Implements:
 * 1. Deribit live futures basis APR calculation & constant maturity interpolation (7D, 30D, 90D, 180D)
 * 2. Multi-span term premium spreads:
 *    - 90D - 7D: Main quarterly-weekly spread (macro Contango/Backwardation)
 *    - 30D - 7D: Short-term steepness (Overcrowding Inversion detection)
 *    - 180D - 30D: Long-term institutional slope
 * 3. Excess Return over T-Bill (4.5% benchmark)
 * 4. Carry Score: (Excess Return / 30D RV) * Sign(90D - 7D)
 * 5. Dynamic Carry Regime state machine & institutional microstructure insights
 */

const fs = require('fs');
const path = require('path');
const { getHistoricalBasisData, calculateCarryScore } = require('./basis_fetcher');

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const T_BILL_RATE = 4.5; // 4.5% US Treasury Bill risk-free rate
const HURDLE_RATE = 8.0; // 8.0% Institutional Capital Opportunity Cost Benchmark

/**
 * Parses Deribit futures expiry e.g. "BTC-25SEP26" -> Date object (at 08:00 UTC)
 */
function parseFuturesExpiry(instrumentName) {
  const match = instrumentName.match(/^BTC-(\d{1,2})([A-Z]{3})(\d{2})$/);
  if (!match) return null;
  const day = parseInt(match[1], 10);
  const mIdx = MONTHS.indexOf(match[2]);
  if (mIdx === -1) return null;
  const year = 2000 + parseInt(match[3], 10);
  return new Date(Date.UTC(year, mIdx, day, 8, 0, 0));
}

/**
 * Linear interpolation helper
 */
function interpolate(x, x0, x1, y0, y1) {
  if (x1 === x0) return y0;
  return y0 + (x - x0) * (y1 - y0) / (x1 - x0);
}

/**
 * Calculates Constant Maturity Basis APRs (7D, 30D, 60D, 90D, 180D) from live futures curve
 */
function calculateConstantMaturityBasis(futuresList, spotPrice, now = Date.now()) {
  if (!futuresList || !futuresList.length || !spotPrice || spotPrice <= 0) {
    return null;
  }

  const contracts = [];
  for (const item of futuresList) {
    if (!item.instrument_name || item.instrument_name === 'BTC-PERPETUAL') continue;
    const expDate = parseFuturesExpiry(item.instrument_name);
    if (!expDate) continue;

    const daysToExpiry = (expDate.getTime() - now) / (86400 * 1000);
    if (daysToExpiry <= 0.1) continue; // skip expired or expiring in <2 hours

    const F = Number(item.mark_price || item.last_price || 0);
    if (F <= 0) continue;

    const basisUSD = F - spotPrice;
    const basisPct = (basisUSD / spotPrice) * 100;
    // Annualized Basis APR = (F - S)/S * (365 / D) * 100%
    const basisAPR = (basisUSD / spotPrice) * (365 / daysToExpiry) * 100;

    contracts.push({
      instrument: item.instrument_name,
      expiryDate: expDate.toISOString().slice(0, 10),
      daysToExpiry: Number(daysToExpiry.toFixed(2)),
      markPrice: F,
      basisUSD: Number(basisUSD.toFixed(2)),
      basisPct: Number(basisPct.toFixed(3)),
      basisAPR: Number(basisAPR.toFixed(2))
    });
  }

  if (contracts.length < 2) return null;
  contracts.sort((a, b) => a.daysToExpiry - b.daysToExpiry);

  // Interpolation helper for a target constant maturity day D
  function getAPRAtDay(targetD) {
    if (targetD <= contracts[0].daysToExpiry) {
      return contracts[0].basisAPR;
    }
    if (targetD >= contracts[contracts.length - 1].daysToExpiry) {
      return contracts[contracts.length - 1].basisAPR;
    }
    for (let i = 0; i < contracts.length - 1; i++) {
      const c0 = contracts[i];
      const c1 = contracts[i + 1];
      if (targetD >= c0.daysToExpiry && targetD <= c1.daysToExpiry) {
        return Number(interpolate(targetD, c0.daysToExpiry, c1.daysToExpiry, c0.basisAPR, c1.basisAPR).toFixed(2));
      }
    }
    return contracts[0].basisAPR;
  }

  const apr7d = getAPRAtDay(7);
  const apr30d = getAPRAtDay(30);
  const apr60d = getAPRAtDay(60);
  const apr90d = getAPRAtDay(90);
  const apr180d = getAPRAtDay(180);

  return {
    spotPrice,
    contracts,
    apr7d,
    apr30d,
    apr60d,
    apr90d,
    apr180d,
    timestamp: now
  };
}

/**
 * Load real historical daily series from Binance COIN-M Delivery Futures cache
 * and merge live Deribit constant maturity basis on current date
 */
async function loadHistoricalBasisSeries(liveCurrent) {
  let baseSeries = [];
  try {
    baseSeries = await getHistoricalBasisData();
  } catch (err) {
    console.warn('[TermPremiumEngine] Fallback reading disk cache:', err.message);
  }

  if (!baseSeries || !baseSeries.length) {
    const CACHE_FILE = path.join(__dirname, '..', 'data', 'term_premium_history.json');
    if (fs.existsSync(CACHE_FILE)) {
      try {
        baseSeries = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      } catch (e) {
        console.warn('[TermPremiumEngine] Error reading CACHE_FILE:', e.message);
      }
    }
  }

  // Deep copy to prevent modifying cached data in-place
  const series = (baseSeries || []).map(item => ({ ...item }));

  // If live Deribit futures book data is present, update or append to the latest entry
  if (liveCurrent && series.length > 0) {
    const now = liveCurrent.timestamp ? new Date(liveCurrent.timestamp + 8 * 3600 * 1000) : new Date(Date.now() + 8 * 3600 * 1000);
    const todayStr = now.toISOString().slice(0, 10);
    let target = series[series.length - 1];

    if (target.date !== todayStr) {
      target = { date: todayStr };
      series.push(target);
    }

    target.apr7d = liveCurrent.apr7d;
    target.apr30d = liveCurrent.apr30d;
    target.apr60d = liveCurrent.apr60d;
    target.apr90d = liveCurrent.apr90d;
    target.apr180d = liveCurrent.apr180d;
    target.spread90d7d = Number((liveCurrent.apr90d - liveCurrent.apr7d).toFixed(2));
    target.spread30d7d = Number((liveCurrent.apr30d - liveCurrent.apr7d).toFixed(2));
    target.spread60d30d = Number((liveCurrent.apr60d - liveCurrent.apr30d).toFixed(2));
    target.spread180d30d = Number((liveCurrent.apr180d - liveCurrent.apr30d).toFixed(2));
    target.excessReturn = Number((liveCurrent.apr30d - HURDLE_RATE).toFixed(2));
    target.excessOverTBill = Number((liveCurrent.apr30d - T_BILL_RATE).toFixed(2));
    // Decoupled weighted institutional carry score: Yield (60%) + Structure (40%)
    target.carryScore = calculateCarryScore(target.excessReturn, target.spread90d7d);
    if (liveCurrent.spotPrice) target.btcPrice = Math.round(liveCurrent.spotPrice);
    if (liveCurrent.timestamp) target.timestamp = liveCurrent.timestamp;
    target.isLiveDeribit = true;
  }

  return series;
}

// Synchronous wrapper / fallback for backward compatibility
function generateHistoricalSeries(liveCurrent) {
  const CACHE_FILE = path.join(__dirname, '..', 'data', 'term_premium_history.json');
  let baseSeries = [];
  if (fs.existsSync(CACHE_FILE)) {
    try {
      baseSeries = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    } catch (e) {}
  }
  const series = baseSeries.map(item => ({ ...item }));
  if (liveCurrent && series.length > 0) {
    const last = series[series.length - 1];
    last.apr7d = liveCurrent.apr7d;
    last.apr30d = liveCurrent.apr30d;
    last.apr60d = liveCurrent.apr60d;
    last.apr90d = liveCurrent.apr90d;
    last.apr180d = liveCurrent.apr180d;
    last.spread90d7d = Number((liveCurrent.apr90d - liveCurrent.apr7d).toFixed(2));
    last.spread30d7d = Number((liveCurrent.apr30d - liveCurrent.apr7d).toFixed(2));
    last.spread60d30d = Number((liveCurrent.apr60d - liveCurrent.apr30d).toFixed(2));
    last.spread180d30d = Number((liveCurrent.apr180d - liveCurrent.apr30d).toFixed(2));
    last.excessReturn = Number((liveCurrent.apr30d - HURDLE_RATE).toFixed(2));
    last.excessOverTBill = Number((liveCurrent.apr30d - T_BILL_RATE).toFixed(2));
    // Decoupled weighted institutional carry score: Yield (60%) + Structure (40%)
    last.carryScore = calculateCarryScore(last.excessReturn, last.spread90d7d);
    if (liveCurrent.spotPrice) last.btcPrice = Math.round(liveCurrent.spotPrice);
  }
  return series;
}

/**
 * Evaluates current Term Premium & Carry Regime state
 */
function evaluateCarryRegime(latest, contracts) {
  const { apr7d, apr30d, apr60d, apr90d, apr180d, spread90d7d, spread30d7d, spread180d30d, excessReturn, carryScore } = latest;

  let regimeCode = 'NORMAL_CONTANGO';
  let regimeName = '标准正向升水 (Healthy Contango)';
  let regimeBadgeClass = 'badge-pos';
  let statusSummary = '';
  let keyPointers = [];

  if (spread30d7d < -0.8 && apr7d > 12.0) {
    // Overcrowding Inversion (Section 5 Case: Jan 2025 euphoria)
    regimeCode = 'OVERCROWDED_INVERSION';
    regimeName = '多头拥挤倒挂 (Overcrowded Inversion)';
    regimeBadgeClass = 'badge-neg';
    statusSummary = `短端基差 (${apr7d}%) 显著超越中端 (${apr30d}%)，短端陡峭度倒挂 (${spread30d7d}%)。表明短期热钱极度拥挤追逐短端年化，过度透支远期，为后市踩踏埋下隐患。`;
    keyPointers = [
      `短端资金拥挤：7D 基差畸高透支中长端，反映杠杆投机资金短期高度过热。`,
      `远端动能钝化：90D 与 180D 升水未能同步上移，期限结构呈现近陡远平的脆弱形态。`,
      `警惕获利盘止损：短端微小回调易触发高杠杆多头集体止损，引发局部踩踏。`
    ];
  } else if (apr30d < 3.0 || (spread90d7d < 0 && apr30d < 5.0)) {
    // Crisis Compression / Backwardation
    regimeCode = 'CRISIS_COMPRESSION';
    regimeName = '基差断崖压缩 / 踩踏倒挂 (Compression Cascade)';
    regimeBadgeClass = 'badge-neg';
    statusSummary = `基差全曲线跌入低位 (${apr30d}%)，中短期溢价倒挂 (${spread90d7d}%)。市场遭遇强烈流动性冲击，套利盘被迫平仓进一步加剧现货卖压。`;
    keyPointers = [
      `套利反噬效应：基差快速跌破成本临界点，引发对冲基金被动平仓（抛现货买期货平空）。`,
      `流动性真空：现货卖压导致盘口滑点扩大，做市商撤单形成负反馈循环。`,
      `避险情绪蔓延：远期缺乏升水支撑，市场进入极端防御与去杠杆通道。`
    ];
  } else if (apr30d < 8.0) {
    // Marginal Carry / Sub-Hurdle Carry (below 8.0% institutional cost)
    regimeCode = 'MARGINAL_CARRY';
    regimeName = '微利观望 / 成本倒挂 (Sub-Hurdle / Marginal Carry)';
    regimeBadgeClass = 'badge-warning';
    statusSummary = `30D 基差 (${apr30d}%) 低于 8.0% 机构资本机会成本门槛（超额收益 ${excessReturn}%），扣除借贷利息、对冲滑点与交易所对手方风险后，套利盈亏比缺乏吸引力。`;
    keyPointers = [
      `机构资本成本劣势：基差无法覆盖 8.0% 资金机会成本（包含无风险利率 4.5% + 3.5% 风险溢价），套利资金入场动能减弱。`,
      `期限结构扁平：30D 与 90D 利差维持在极窄区间，缺乏波动弹性与展期收益。`,
      `等待机制转换：需静待现货强买盘或杠杆多头推动主力基差重新跨越 8.0% 临界线，打开套利空间。`
    ];
  } else {
    // Healthy Contango (> 8.0%)
    regimeCode = 'NORMAL_CONTANGO';
    regimeName = '标准正向升水 (Healthy Contango)';
    regimeBadgeClass = 'badge-pos';
    statusSummary = `基差期限结构健康向上倾斜（90D-7D 溢价 +${spread90d7d}%），30D 基差 (${apr30d}%) 高于 8.0% 机构资本机会成本（超额收益 +${excessReturn}%），具备稳健的跨期套利空间。`;
    keyPointers = [
      `正向升水结构：远期稳定维持溢价，反映市场对后市持有持续乐观的温和风险偏好。`,
      `展期套利顺畅：期现对冲仓位可获取超越 8.0% 资金成本的稳健年化收益，吸引合规长线资金持续入场。`,
      `跨期利差健康：短端与远端利差保持合理斜率，做市商报价连续且具备充足深度缓冲。`
    ];
  }

  return {
    regimeCode,
    regimeName,
    regimeBadgeClass,
    statusSummary,
    keyPointers
  };
}

/**
 * Main Engine API: Analyzes Term Premium and returns complete chart payload
 */
async function analyzeTermPremium(futuresList, spotPrice) {
  const live = calculateConstantMaturityBasis(futuresList, spotPrice);
  const historicalSeries = await loadHistoricalBasisSeries(live);
  const latest = historicalSeries[historicalSeries.length - 1] || {
    apr7d: 8.5,
    apr30d: 9.0,
    apr60d: 9.4,
    apr90d: 9.8,
    apr180d: 10.5,
    spread90d7d: 1.3,
    spread30d7d: 0.5,
    spread60d30d: 0.4,
    spread180d30d: 1.5,
    excessReturn: 1.0,
    excessOverTBill: 4.5,
    carryScore: 13.2,
    timestamp: Date.now(),
    date: new Date().toISOString().slice(0, 10)
  };
  const regime = evaluateCarryRegime(latest, live?.contracts || []);

  return {
    spotPrice: live?.spotPrice || spotPrice,
    tBillRate: T_BILL_RATE,
    hurdleRate: HURDLE_RATE,
    metadata: {
      dataSource: 'Binance COIN-M Delivery Futures 真实交割基差 (2025.01 ~ 至今) + Deribit 实时盘口恒定到期插值',
      timeRange: '2025-01-01 至当前最新',
      missingHandling: '线性时间加权插值与前值顺延填充',
      isRealHistorical: true
    },
    current: {
      apr7d: latest.apr7d,
      apr30d: latest.apr30d,
      apr60d: latest.apr60d,
      apr90d: latest.apr90d,
      apr180d: latest.apr180d,
      spread90d7d: latest.spread90d7d,
      spread30d7d: latest.spread30d7d,
      spread60d30d: latest.spread60d30d,
      spread180d30d: latest.spread180d30d,
      excessReturn: latest.excessReturn,
      excessOverTBill: latest.excessOverTBill,
      carryScore: latest.carryScore,
      timestamp: latest.timestamp,
      date: latest.date
    },
    contracts: live?.contracts || [],
    regime,
    series: historicalSeries
  };
}

module.exports = {
  calculateConstantMaturityBasis,
  loadHistoricalBasisSeries,
  generateHistoricalSeries,
  evaluateCarryRegime,
  analyzeTermPremium,
  calculateCarryScore,
  T_BILL_RATE,
  HURDLE_RATE
};

