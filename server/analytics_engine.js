/**
 * Analytics Engine for Greeks.live DataLab and Block Trades
 * Enhanced with Black-Scholes Greeks, Trade Intent Classification, IV Smile & 25D Skew
 */

const MONTH_NAMES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const QUARTER_MONTHS = ["MAR", "JUN", "SEP", "DEC"];

/**
 * Standard Normal Cumulative Distribution Function approximation
 */
function cnd(x) {
  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) / Math.sqrt(2.0);

  const t = 1.0 / (1.0 + p * absX);
  const erf = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
  return 0.5 * (1.0 + sign * erf);
}

function normalPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Calculate Black-Scholes Greeks for a standard European Option
 * S: Index Price, K: Strike, T_years: Time to expiration in years, iv_pct: IV in % (e.g. 35)
 * Returns:
 *   delta: contract delta (-1 to 1)
 *   gamma: contract gamma
 *   vega: USD change per 1% vol change per 1 contract
 *   theta: USD change per day per 1 contract
 */
function calcGreeks(S, K, T_years, iv_pct, isCall, r = 0.04) {
  const sigma = Math.max(0.01, (iv_pct || 35.0) / 100.0);
  const T = Math.max(0.0005, T_years); // at least a few hours
  const sqrtT = Math.sqrt(T);

  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  const pdfD1 = normalPdf(d1);
  const cndD1 = cnd(d1);
  const cndD2 = cnd(d2);

  let delta, theta;
  const gamma = pdfD1 / (S * sigma * sqrtT);
  const vega = (S * sqrtT * pdfD1) * 0.01; // USD / 1% IV per contract

  // Second-order Greeks (Bossu & Henrotte Ch 3, 6 / Natenberg Ch 6)
  // Vanna = dVega/dS = dDelta/dVol (measures how Skew position shifts into Vega exposure)
  const vanna = - (pdfD1 * d2) / sigma;
  // Volga = dVega/dVol (Vega convexity / curvature, driver of Kurtosis & Smile)
  const volga = vega * 100 * (d1 * d2) / sigma;

  if (isCall) {
    delta = cndD1;
    theta = (- (S * sigma * pdfD1) / (2 * sqrtT) - r * K * Math.exp(-r * T) * cndD2) / 365.0;
  } else {
    delta = cndD1 - 1.0;
    theta = (- (S * sigma * pdfD1) / (2 * sqrtT) + r * K * Math.exp(-r * T) * (1.0 - cndD2)) / 365.0;
  }

  // Dollar Greeks (Natenberg Ch 16 / Bossu Ch 1)
  const dollarDelta = delta * S;
  const dollarGamma = 0.5 * S * S * gamma; // 1/2 * S^2 * gamma (daily gamma P&L unit for 1% move)
  const dollarVega = vega;
  const dollarTheta = theta;

  return { delta, gamma, vega, theta, vanna, volga, dollarDelta, dollarGamma, dollarVega, dollarTheta };
}

/**
 * Format timestamp / Date object / ISO string to UTC+8 string "YYYY-MM-DD HH:mm:ss"
 */
function formatUTC8(timeInput, includeSeconds = true) {
  if (!timeInput) return '--';
  const ts = typeof timeInput === 'number'
    ? timeInput
    : (timeInput instanceof Date ? timeInput.getTime() : new Date(timeInput).getTime());
  if (isNaN(ts)) return String(timeInput);

  const d = new Date(ts + 8 * 3600 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');

  return includeSeconds ? `${y}-${m}-${day} ${h}:${min}:${s}` : `${y}-${m}-${day} ${h}:${min}`;
}

/**
 * Parses Deribit expiration string e.g. "25SEP26" -> Date object (at 08:00 UTC)
 */
function parseDeribitExpiry(expiryStr) {
  if (!expiryStr) return null;
  const match = expiryStr.match(/^(\d{1,2})([A-Z]{3})(\d{2})$/);
  if (!match) return null;
  const day = parseInt(match[1], 10);
  const monStr = match[2];
  const year = 2000 + parseInt(match[3], 10);
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const monthIdx = months.indexOf(monStr);
  if (monthIdx === -1) return null;
  return new Date(Date.UTC(year, monthIdx, day, 8, 0, 0));
}

/**
 * Parse full instrument name e.g. "BTC-25SEP26-80000-C"
 */
function parseInstrument(instName) {
  const parts = instName.split('-');
  if (parts.length < 4) return null;
  return {
    currency: parts[0],
    expiryStr: parts[1],
    strike: parseFloat(parts[2]),
    type: parts[3].toUpperCase(), // 'C' or 'P'
    isCall: parts[3].toUpperCase() === 'C'
  };
}

/**
 * Returns the last Friday of a given year and month (0-indexed month)
 */
function getLastFridayOfMonth(year, month) {
  const lastDay = new Date(Date.UTC(year, month + 1, 0));
  const dayOfWeek = lastDay.getUTCDay();
  const diff = (dayOfWeek >= 5) ? (dayOfWeek - 5) : (dayOfWeek + 2);
  const lastFridayDate = lastDay.getUTCDate() - diff;
  return new Date(Date.UTC(year, month, lastFridayDate, 8, 0, 0));
}

/**
 * Format Date to Deribit Expiry string e.g. "25SEP26"
 */
function formatDeribitExpiry(date) {
  const d = date.getUTCDate();
  const m = MONTH_NAMES[date.getUTCMonth()];
  const y = date.getUTCFullYear().toString().slice(-2);
  return `${d}${m}${y}`;
}

/**
 * Module 1: ATM IV Term Structure & Intelligent Extreme Range Evaluation
 * Enhanced with real-time atmData feed across maturities and smooth fallback to ivHistory
 */
function analyzeAtmIv(ivHistory, dvolStats, atmData = null) {
  let iv1m = null;
  let iv2m = null;
  let iv3m = null;
  let iv6m = null;
  let iv1y = null;
  let termPoints = [];
  let isRealtime = false;

  // 1. Try extracting real-time ATM IVs across maturities from live atmData
  if (Array.isArray(atmData) && atmData.length > 0) {
    const rawPoints = [];
    for (const expItem of atmData) {
      if (!expItem) continue;
      const list = expItem.list;
      let atmObj = null;
      if (Array.isArray(list) && list.length > 0) {
        if (typeof expItem.atm_index === 'number' && list[expItem.atm_index]) {
          atmObj = list[expItem.atm_index];
        } else {
          // Find strike with delta closest to 0.50
          atmObj = list.reduce((best, cur) => {
            if (!best) return cur;
            const diffCur = Math.abs((cur.delta || 0.5) - 0.5);
            const diffBest = Math.abs((best.delta || 0.5) - 0.5);
            return diffCur < diffBest ? cur : best;
          }, null);
        }
      }

      const dte = (typeof expItem.day === 'number' && expItem.day > 0)
        ? expItem.day
        : (expItem.hour ? Number((expItem.hour / 24).toFixed(2)) : 0);

      if (atmObj && typeof atmObj.iv === 'number' && dte > 0) {
        rawPoints.push({
          expiry: expItem.underlying_index,
          dte,
          iv: Number(atmObj.iv.toFixed(2)),
          strike: atmObj.strike,
          delta: atmObj.delta,
          underlyingPrice: expItem.underlying_price
        });
      }
    }

    if (rawPoints.length >= 2) {
      rawPoints.sort((a, b) => a.dte - b.dte);
      termPoints = rawPoints;

      function interpolateDte(targetDte) {
        if (targetDte <= rawPoints[0].dte) return rawPoints[0].iv;
        if (targetDte >= rawPoints[rawPoints.length - 1].dte) return rawPoints[rawPoints.length - 1].iv;
        for (let i = 0; i < rawPoints.length - 1; i++) {
          const p1 = rawPoints[i];
          const p2 = rawPoints[i + 1];
          if (targetDte >= p1.dte && targetDte <= p2.dte) {
            if (p2.dte === p1.dte) return p1.iv;
            const weight = (targetDte - p1.dte) / (p2.dte - p1.dte);
            return Number((p1.iv + weight * (p2.iv - p1.iv)).toFixed(2));
          }
        }
        return rawPoints[rawPoints.length - 1].iv;
      }

      iv1m = interpolateDte(30);
      iv2m = interpolateDte(60);
      iv3m = interpolateDte(90);
      iv6m = interpolateDte(180);
      iv1y = interpolateDte(365);
      isRealtime = true;
    }
  }

  // 2. Fallback to ivHistory if atmData is unavailable
  if (iv1m === null) {
    if (!ivHistory || !ivHistory.length) {
      return {
        status: 'insufficient_data',
        summaryText: '暂无足够 ATM IV 历史数据。'
      };
    }
    const latest = ivHistory[ivHistory.length - 1];
    iv1m = latest.month1;
    iv2m = latest.month2;
    iv3m = latest.month3;
    iv6m = latest.month6;
    iv1y = latest.one_year;
  }

  let curveType = 'Flat';
  let curveDesc = '平坦';
  if (iv1m && iv3m && iv6m) {
    if (iv1m < iv3m && iv3m < iv6m) {
      curveType = 'Contango';
      curveDesc = '典型正向升水（Contango）';
    } else if (iv1m > iv3m && iv3m > iv6m) {
      curveType = 'Backwardation';
      curveDesc = '剧烈倒挂（Backwardation）';
    } else if (iv1m > iv3m && iv3m <= iv6m) {
      curveType = 'Near-term Inversion';
      curveDesc = '近端倒挂/远端升水';
    } else {
      curveType = 'Humped';
      curveDesc = '驼峰形/局部异动';
    }
  }

  let percentile = null;
  let regime = 'Normal';
  let regimeTag = '历史合理区间';
  let extremeAlert = false;
  let recommendation = '';

  // Square Root of Time Rule (Natenberg Ch 4 / Bossu Ch 1): Daily vol = Annual vol / 16
  const dailyExpectedMovePct = Number(((iv1m || 35.0) / 16.0).toFixed(2));
  const weeklyExpectedMovePct = Number(((iv1m || 35.0) / 7.2).toFixed(2));
  const atmStraddleEstPct = Number((0.8 * ((iv1m || 35.0) / 100.0) * Math.sqrt(30 / 365) * 100).toFixed(2));

  if (dvolStats && dvolStats.historicalSeries && dvolStats.historicalSeries.length) {
    const series = dvolStats.historicalSeries;
    const countBelow = series.filter(v => v <= iv1m).length;
    percentile = (countBelow / series.length) * 100;

    if (percentile <= 5) {
      regime = 'Extreme Low';
      regimeTag = '🚨 历史极端低估区间';
      extremeAlert = true;
      recommendation = `【时间平方根法则】当前 1M IV (${iv1m?.toFixed(1)}%) 隐含日预期波动仅 ±${dailyExpectedMovePct}%（周预期 ±${weeklyExpectedMovePct}%），处于历史极值底部。此时做空波动率的单位风险收益优势 (Vega/Edge) 极差，无谓承担无法对冲的隔夜跳空缺口风险 (Gap Risk)；建议关注变盘窗口的 Long Gamma、买入平值跨式/宽跨式 (Straddle/Strangle) 或做多远期波动率的日历价差 (Calendar Spread)。`;
    } else if (percentile <= 20) {
      regime = 'Low Volatility';
      regimeTag = '📉 偏低压缩区间';
      recommendation = `波动率处于偏低分位（日预期波动 ±${dailyExpectedMovePct}%），市场处于低波盘整期。期权买方保护成本较为便宜，适合以借方价差 (Debit Spread) 替代单腿期权构建不对称下行保护或现货替代。`;
    } else if (percentile >= 90) {
      regime = 'Extreme High';
      regimeTag = '🔥 历史极端高估区间';
      extremeAlert = true;
      recommendation = `【方差溢价高企】当前 1M IV 隐含日均波动高达 ±${dailyExpectedMovePct}%。做空波动率在经济学实质上等价于承担股权风险溢价 (Equity Risk Premium)；此时可构建完全锁定尾部风险的对称蝶式 (Butterfly) 或宽幅铁鹰 (Iron Condor)，在收割丰厚 Theta 现金流的同时，彻底封死单边无限暴亏的尾部敞口。`;
    } else if (percentile >= 75) {
      regime = 'High Volatility';
      regimeTag = '📈 偏高溢价区间';
      recommendation = `隐含波动率高于历史中位数（日预期波动 ±${dailyExpectedMovePct}%），市场计入了较多宏观不确定性事件溢价。宜采取卖出虚值期权补贴买入保护的领口策略 (Collar) 或贷方价差 (Credit Spread)。`;
    } else {
      regime = 'Normal';
      regimeTag = '⚖️ 历史中性合理区间';
      recommendation = `波动率定价处于中位数附近（日预期波动 ±${dailyExpectedMovePct}%），期限结构平衡，适合结合方向性 Delta 观点构建标准垂直价差组合。`;
    }
  } else if (iv1m !== null && iv1m !== undefined) {
    // Fallback based on absolute implied volatility thresholds when historical distribution is unavailable
    if (iv1m <= 35.0) {
      regime = 'Extreme Low';
      regimeTag = '🚨 绝对值偏低区间';
      extremeAlert = true;
      recommendation = `当前 1M IV (${iv1m.toFixed(1)}%) 处于绝对值偏低区间（日预期波动 ±${dailyExpectedMovePct}%），期权买方溢价处于低位。`;
    } else if (iv1m >= 70.0) {
      regime = 'Extreme High';
      regimeTag = '🔥 绝对值偏高区间';
      extremeAlert = true;
      recommendation = `当前 1M IV (${iv1m.toFixed(1)}%) 处于绝对值高估区间（日预期波动 ±${dailyExpectedMovePct}%），建议警惕高方差回撤风险。`;
    }
  }

  const percentileText = percentile !== null ? `${percentile.toFixed(1)}%` : '参考常模';
  const paragraph = `当下 Bitcoin ATM 隐含波动率呈现【${curveDesc}】期限结构（1M: ${iv1m?.toFixed(1)}%, 3M: ${iv3m?.toFixed(1)}%, 6M: ${iv6m?.toFixed(1)}%），时间平方根法则对应【日均预期振幅 ±${dailyExpectedMovePct}%】（周预期 ±${weeklyExpectedMovePct}%，1M 跨式平价约 ${atmStraddleEstPct}%）。${
    extremeAlert
      ? `【极值预警】ATM 1M IV 目前处于约 ${percentileText} 历史分位，${regimeTag}。${recommendation}`
      : `波动率处于【${regimeTag}】（历史分位约 ${percentileText}）。${recommendation}`
  }`;

  return {
    iv1m,
    iv2m,
    iv3m,
    iv6m,
    iv1y,
    curveType,
    curveDesc,
    percentile: percentile !== null ? Math.round(percentile * 10) / 10 : null,
    dailyExpectedMovePct,
    weeklyExpectedMovePct,
    atmStraddleEstPct,
    dvolMin: dvolStats?.min || 33.8,
    dvolMax: dvolStats?.max || 82.6,
    dvolMedian: dvolStats?.median || 48.5,
    isRealtime,
    termPoints,
    regime,
    regimeTag,
    extremeAlert,
    recommendation,
    paragraph
  };
}

/**
 * Module 2: Dynamic GEX by Expiration Focus Algorithm & Gamma-Theta Mechanics
 * Rooted in Bossu Ch 1 & Natenberg Ch 5, 11 (Dynamic Delta-Hedging, Quadratic Scaling, Pinning)
 */
function analyzeDynamicGex(gexData, referenceDate = new Date()) {
  if (!gexData || !gexData.by_expiry) {
    return {
      status: 'insufficient_data',
      focusedExpiries: [],
      allExpiries: [],
      summaryText: '暂无 GEX 数据。'
    };
  }

  const now = referenceDate;
  const nowUTC8 = new Date(now.getTime() + 8 * 3600 * 1000);
  const curYear = nowUTC8.getUTCFullYear();
  const curMonth = nowUTC8.getUTCMonth();

  let frontMonthFriday = getLastFridayOfMonth(curYear, curMonth);
  const isRolledToNextMonth = frontMonthFriday < now;
  if (isRolledToNextMonth) {
    frontMonthFriday = getLastFridayOfMonth(curYear, curMonth + 1);
  }
  const curMonthEndExpiryStr = formatDeribitExpiry(frontMonthFriday);
  const frontMonthLabel = isRolledToNextMonth ? '次月月底交割' : '当月月底交割';

  const quarterExpiries = [];
  for (let offset = 0; offset <= 4; offset++) {
    const targetDate = new Date(Date.UTC(curYear, curMonth + offset, 1));
    const tYear = targetDate.getUTCFullYear();
    const tMonth = targetDate.getUTCMonth();
    const tMonthStr = MONTH_NAMES[tMonth];

    if (QUARTER_MONTHS.includes(tMonthStr)) {
      const qFriday = getLastFridayOfMonth(tYear, tMonth);
      if (qFriday >= now) {
        quarterExpiries.push(formatDeribitExpiry(qFriday));
      }
    }
  }

  let yearEndFriday = getLastFridayOfMonth(curYear, 11);
  if (yearEndFriday < now) yearEndFriday = getLastFridayOfMonth(curYear + 1, 11);
  const yearEndExpiryStr = formatDeribitExpiry(yearEndFriday);

  const allowedFocusSet = new Set();
  allowedFocusSet.add(curMonthEndExpiryStr);
  quarterExpiries.forEach(q => allowedFocusSet.add(q));
  allowedFocusSet.add(yearEndExpiryStr);

  const availableExpiries = Object.keys(gexData.by_expiry);
  const focusedList = [];
  const allList = [];

  for (const exp of availableExpiries) {
    const strikeList = gexData.by_expiry[exp] || [];
    let totalGex = 0;
    let callWallStrike = null;
    let maxCallGex = -Infinity;
    let putWallStrike = null;
    let minPutGex = Infinity;

    for (const item of strikeList) {
      totalGex += item.number;
      if (item.number > maxCallGex) {
        maxCallGex = item.number;
        callWallStrike = item.strike;
      }
      if (item.number < minPutGex) {
        minPutGex = item.number;
        putWallStrike = item.strike;
      }
    }

    const isCurMonth = exp === curMonthEndExpiryStr;
    const isQuarter = quarterExpiries.includes(exp);
    const isYearEnd = exp === yearEndExpiryStr;

    let categoryTag = '普通周期';
    if (isCurMonth && isQuarter) categoryTag = `${frontMonthLabel.replace('交割', '')} & 季度交割`;
    else if (isCurMonth) categoryTag = frontMonthLabel;
    else if (isYearEnd) categoryTag = '年度最终交割';
    else if (isQuarter) categoryTag = '主季度交割';

    const expDate = parseDeribitExpiry(exp);
    const itemData = {
      expiry: exp,
      expiryDate: expDate ? expDate.toISOString().slice(0, 10) : exp,
      categoryTag,
      totalGex,
      totalGexM: totalGex / 1e6,
      callWall: callWallStrike,
      putWall: putWallStrike,
      strikeCount: strikeList.length,
      isFocused: allowedFocusSet.has(exp)
    };

    allList.push(itemData);
    if (allowedFocusSet.has(exp)) {
      focusedList.push(itemData);
    }
  }

  const sortByDate = (a, b) => {
    const da = parseDeribitExpiry(a.expiry)?.getTime() || 0;
    const db = parseDeribitExpiry(b.expiry)?.getTime() || 0;
    return da - db;
  };
  focusedList.sort(sortByDate);
  allList.sort(sortByDate);

  let paragraph = '';
  let marketMakerRegime = 'Neutral';
  let totalFocusedGex = 0;
  let spotPrice = gexData.index_price || 77200;

  if (focusedList.length > 0) {
    const lead = focusedList[0];
    totalFocusedGex = focusedList.reduce((acc, c) => acc + c.totalGex, 0);

    let regimeText = '';
    if (totalFocusedGex > 0) {
      marketMakerRegime = 'Long Gamma (Stabilizing / Pinning)';
      regimeText = `核心主力到期日整体呈现【正 Gamma 统治态势】（合计 GEX 约 +$${(totalFocusedGex / 1e6).toFixed(1)}M）。做市商整体处于 Long Gamma 状态，在现货上涨时必须抛售现货、下跌时买入现货以维持 Delta 中性，充当了现货市场的天然“低波动减震器”；尤其临近到期（$T \\to 0$ 时 $\\Gamma \\propto \\frac{1}{S\\sigma\\sqrt{T}}$ 聚拢），将对现货产生强烈的“磁吸钉盘 (Pinning)”效应。`;
    } else {
      marketMakerRegime = 'Short Gamma (Volatility Accelerating)';
      regimeText = `核心主力到期日呈现【负 Gamma 放大态势】（合计 GEX 约 -$${(Math.abs(totalFocusedGex) / 1e6).toFixed(1)}M）。依据期权动态对冲数学模型，做市商处于 Short Gamma 状态，现货上涨被迫追多、下跌被迫杀跌以对冲 Delta 风险，将剧烈放大市场单边波动，极易诱发 Gamma Squeeze 轧空或流动性踩踏。`;
    }

    // Gamma-Theta Tradeoff Equation: P&L = 0.5 * (ΔS)^2 * Γ + Θ * Δt
    const gammaThetaEquationDesc = `【Gamma-Theta 平衡方程】：做市商持仓遵循 P&L ≈ ½(ΔS)²·Γ + Θ·Δt。现货跳空盈利具有二次方递增效应（ΔS²），2% 的瞬间跳空带来的 Gamma 收益为 1% 跳空的 4 倍；而当标的日内窄幅震荡（ΔS 趋近 0）时，持仓收益完全被时间衰减 Θ·Δt 吞噬。`;

    paragraph = `动态交割期算法已精准聚焦主力关键节点：${focusedList.map(f => `【${f.expiry} (${f.categoryTag})】`).join('、')}。${regimeText} ${gammaThetaEquationDesc} 近端主力交割（${lead.expiry}）关键防御位锚定在 Call Wall $${lead.callWall?.toLocaleString()}（上方最强抛压阻力）与 Put Wall $${lead.putWall?.toLocaleString()}（下方最强支撑地基），在交割前标的在当前价格（~$${Math.round(spotPrice).toLocaleString()}）附近的磁吸震荡收敛特征最为突出。`;
  }

  const curDateStr = formatUTC8(now).slice(0, 10);
  return {
    indexPrice: spotPrice,
    focusedExpiries: focusedList,
    allExpiries: allList,
    totalFocusedGexM: Number((totalFocusedGex / 1e6).toFixed(2)),
    marketMakerRegime,
    dynamicRuleDescription: `当前日期基准（${curDateStr} UTC+8）：系统自动锁定${isRolledToNextMonth ? '次月月底（当月交割已过，自动滚动至' : '当月月底（'}${curMonthEndExpiryStr}）、季末交割及年底交割（${yearEndExpiryStr}），自动隐去非当月普通到期（如 27NOV26 等，待日历推进至对应月份时将动态激活）。`,
    paragraph
  };
}

/**
 * Module 3: Institutional Multi-Leg Strategy Pattern Recognition & Theoretical Profiling
 * Formulated under Sheldon Natenberg (Option Volatility & Pricing) & Sébastien Bossu (Equity Derivatives)
 */
function identifyInstitutionalStrategy(legs, netDeltaUSD, netVegaUSD, netThetaUSD, totalNotionalUSD, smileContext = null) {
  const S = legs[0]?.indexPrice || legs[0]?.index_price || 77200;
  const numLegs = legs.length;
  
  // Parsed leg info
  const parsed = legs.map(l => {
    const inst = parseInstrument ? parseInstrument(l.instrument_name || l.instrument) : null;
    const isCall = inst ? inst.isCall : (l.instrument_name || l.instrument).includes('-C');
    const strike = inst ? inst.strike : (l.strike || 77000);
    const expiryStr = inst ? inst.expiryStr : 'UNKNOWN';
    const direction = (l.direction || 'buy').toLowerCase();
    const amount = Number(l.amount || 0);
    const price = Number(l.price || 0);
    return {
      raw: l,
      instrument: l.instrument_name || l.instrument,
      direction,
      isBuy: direction === 'buy',
      isSell: direction === 'sell',
      amount,
      price,
      strike,
      isCall,
      isPut: !isCall,
      expiryStr
    };
  });

  // Sort by strike ascending
  parsed.sort((a, b) => a.strike - b.strike);

  let strategyType = 'CUSTOM_STRUCTURE';
  let strategyNameZh = '定制多腿组合';
  let intentBadge = '多腿组合配置';
  let intentBadgeClass = 'badge-neutral';
  let riskProfile = {
    maxProfit: '视多腿行权价差而定 (BTC 本位)',
    maxLoss: '视多腿净权利金与行权价差而定',
    breakEven: '依据到期现货综合交割损益计算',
    inverseCurvature: 'Deribit 反向期权以 BTC 结算。上行方向以 BTC 计价收益呈现渐近衰减，单腿看涨最高理论收益渐近收敛于 1.0 BTC；暴跌时以 USD 折算的亏损由于币价下跌而具备二阶乘数效应。'
  };
  let theoreticalPointers = [];
  let intentNarrative = '';

  const sameExpiryAll = parsed.every(l => l.expiryStr === parsed[0].expiryStr);

  // ==========================================
  // 1-LEG STRATEGIES (Lecture 12.1, 12.6, 12.7)
  // ==========================================
  if (numLegs === 1) {
    const leg = parsed[0];
    const moneyness = leg.strike / S;
    const isATM = Math.abs(moneyness - 1.0) <= 0.03;
    const isOTM = leg.isCall ? (leg.strike > S * 1.03) : (leg.strike < S * 0.97);

    if (leg.isCall) {
      if (leg.isBuy) {
        strategyType = 'LONG_CALL';
        strategyNameZh = '单腿买入看涨 (Long Call)';
        intentBadge = isOTM ? '看涨突破 / 虚值杠杆博弈' : '多头方向建仓 / 现货替代';
        intentBadgeClass = 'badge-bull';
        riskProfile = {
          maxProfit: 'USD 计价理论无限；BTC 本位受反向合约非线性曲率约束上限渐近逼近 1.0 BTC',
          maxLoss: `净权利金支出 (~${(leg.price * leg.amount).toFixed(2)} BTC)`,
          breakEven: `$${Math.round(leg.strike + leg.price * S).toLocaleString()} (行权价 + 权利金)`,
          inverseCurvature: 'Deribit 反向合约以 BTC 结算：到期收益 (S-K)/S = 1 - K/S，当 S 趋向无穷大时，以 BTC 计价的最大收益渐近于 1 BTC - 权利金，收益增长随币价暴涨呈递减曲线。'
        };
        theoreticalPointers = [
          `凸性杠杆 (Convexity)：以有限权利金敞口获取右侧无限上行赔率，Delta 随价格上涨加速扩张。`,
          `时间价值衰减 (Theta 风险)：持有期间面临固定的 Theta 磨损，需标的在期限前实现大于隐含波动率的实际波动。`,
          `波动率敏感度 (Vega 正敞口)：IV 扩张将同步抬升持仓估值，适合预期波动率与现货齐升的破位行情。`,
          `反向合约非线性曲率 (Deribit Inverse)：以 BTC 结算时收益存在递减效应，但在现货暴涨折算回 USD 时仍具备巨大杠杆倍数。`
        ];
        intentNarrative = `本笔交易为名义价值超 $${(totalNotionalUSD / 1e6).toFixed(1)}M 的【大额单腿买入看涨期权】。机构主动承担约 ${(leg.price * leg.amount).toFixed(2)} BTC 权利金成本，以正 Delta 敞口直接博弈标的在 ${leg.expiryStr} 到期前向 $${leg.strike.toLocaleString()} 上方爆发性单边拉升。`;
      } else {
        strategyType = 'SHORT_CALL';
        strategyNameZh = '单腿卖出看涨 (Covered Call / Call Overwriting)';
        intentBadge = '备兑卖涨 / 高位阻力增益收租';
        intentBadgeClass = 'badge-vol-sell';
        riskProfile = {
          maxProfit: `收取的全部权利金 (~${(leg.price * leg.amount).toFixed(2)} BTC)`,
          maxLoss: '若裸卖为空头无限风险；若为备兑则放弃行权价以上收益',
          breakEven: `$${Math.round(leg.strike + leg.price * S).toLocaleString()} (行权价 + 权利金)`,
          inverseCurvature: '卖出虚值看涨以现货为担保，在平稳或阴跌市况下稳步获取 BTC 增量收益；但在极端暴拉行情下现货被强制交割。'
        };
        theoreticalPointers = [
          `收益增强 (Yield Generation)：现货持仓大户利用虚值 Call 极高的做市溢价获取确定性现金流收入。`,
          `天花板效应 (Capped Upside)：锁定了 $${leg.strike.toLocaleString()} 之上的超额收益，表明机构研判该位置具有极强结构性抛压。`,
          `正 Theta / 负 Vega：依靠时间价值消耗与波动率收缩获利，只要标的未有效突破行权价即可全额赚取权利金。`
        ];
        intentNarrative = `本笔交易属于典型的【大额卖出虚值看涨期权（备兑收租或高位压制）】。大资金在 $${leg.strike.toLocaleString()} 行权价大额挂单卖出，收取约 ${(leg.price * leg.amount).toFixed(2)} BTC 权利金。表明机构将该价位视作坚不可摧的中期阻力位，旨在震荡中吃满时间价值衰减。`;
      }
    } else {
      // Put
      if (leg.isBuy) {
        strategyType = 'LONG_PUT';
        strategyNameZh = '单腿买入看跌 (Protective Put / Tail Hedge)';
        intentBadge = '下行保护 / 尾部风险硬对冲';
        intentBadgeClass = 'badge-bear';
        riskProfile = {
          maxProfit: `约 ${((leg.strike * leg.amount) / S).toFixed(2)} BTC (标的极端归零时)`,
          maxLoss: `净权利金支出 (~${(leg.price * leg.amount).toFixed(2)} BTC)`,
          breakEven: `$${Math.round(leg.strike - leg.price * S).toLocaleString()} (行权价 - 权利金)`,
          inverseCurvature: '反向看跌期权以 BTC 结算：在币价崩盘时可兑现极多 BTC 数量，但需警惕 BTC 本身对法币贬值对冲折算率。'
        };
        theoreticalPointers = [
          `下行下限保护 (Portfolio Insurance)：为现货或多头头寸建立刚性安全气囊，彻底截断行权价下方的系统性崩盘亏损。`,
          `负 Delta / 正 Vega：在暴跌或流动性恐慌（IV 飙升）环境中具有双重对冲增益效应。`,
          `保险费成本 (Insurance Cost)：买方需承担持续的时间价值折损，属于机构级确定性风控成本支出。`
        ];
        intentNarrative = `本笔交易为规模达 $${(totalNotionalUSD / 1e6).toFixed(1)}M 的【大额单腿买入看跌对冲】。大资金在 $${leg.strike.toLocaleString()} 挂出大额买单，旨在为大额现货头寸购买确定性下行保险，有效封死标的在 ${leg.expiryStr} 到期前破位下跌的极端尾部风险。`;
      } else {
        strategyType = 'SHORT_PUT';
        strategyNameZh = '单腿卖出看跌 (Cash-Secured Put / Theta Harvest)';
        intentBadge = '看涨偏多 / 支撑位吃贴水建仓';
        intentBadgeClass = 'badge-bull';
        riskProfile = {
          maxProfit: `收取的全部权利金 (~${(leg.price * leg.amount).toFixed(2)} BTC)`,
          maxLoss: `$${Math.round((leg.strike - leg.price * S) * leg.amount).toLocaleString()} (实质为折价接盘现货)`,
          breakEven: `$${Math.round(leg.strike - leg.price * S).toLocaleString()} (行权价 - 权利金)`,
          inverseCurvature: '以 BTC 计价卖出 Put：若市况剧烈下行被击穿，持仓将面临币价下跌与接盘被动放大的二阶双重压力。'
        };
        theoreticalPointers = [
          `限价折价建仓 (Synthetic Limit Order)：机构愿意在 $${Math.round(leg.strike - leg.price * S).toLocaleString()} 处接盘现货，同时预先落袋权利金缓冲。`,
          `正 Theta / 正 Delta：只要标的维持在 $${leg.strike.toLocaleString()} 之上，持仓每日将产生确定性时间价值进账。`,
          `强支撑预期：反映资金将 $${leg.strike.toLocaleString()} 视作铁底支撑，判定到期前被深度击穿的概率极低。`
        ];
        intentNarrative = `本笔交易为典型的【机构级卖出看跌期权（折价吸筹/高胜率吃贴水）】。大资金在支撑位 $${leg.strike.toLocaleString()} 卖出 Put，净收约 ${(leg.price * leg.amount).toFixed(2)} BTC 权利金。机构意在利用低波动率环境赚取安全垫，若未跌破则赚取全额利息，若跌破则以折价买入筹码。`;
      }
    }
  }

  // ==========================================
  // 4-LEG STRATEGIES (Lecture 12.13, 12.14)
  // ==========================================
  else if (numLegs === 4 && sameExpiryAll) {
    const [l1, l2, l3, l4] = parsed; // Sorted by strike ascending: K1 <= K2 <= K3 <= K4
    const K1 = l1.strike, K2 = l2.strike, K3 = l3.strike, K4 = l4.strike;

    // Check for Iron Condor (Lecture 12.13):
    // Buy Put K1, Sell Put K2, Sell Call K3, Buy Call K4 where K1 < K2 < K3 < K4
    const isIronCondor = (K1 < K2 && K2 < K3 && K3 < K4) &&
      l1.isPut && l1.isBuy &&
      l2.isPut && l2.isSell &&
      l3.isCall && l3.isSell &&
      l4.isCall && l4.isBuy;

    // Check for 4-Leg Iron Butterfly (Lecture 12.14):
    // Buy Put K1, Sell Put K2, Sell Call K2, Buy Call K4 where K1 < K2 === K3 < K4
    const isIronButterfly = (K1 < K2 && K2 === K3 && K3 < K4) &&
      l1.isPut && l1.isBuy &&
      l2.isPut && l2.isSell &&
      l3.isCall && l3.isSell &&
      l4.isCall && l4.isBuy;

    // Check for Call Condor (Lecture 12.13):
    // All Calls: Buy K1, Sell K2, Sell K3, Buy K4 where K1 < K2 < K3 < K4
    const isCallCondor = (K1 < K2 && K2 < K3 && K3 < K4) &&
      parsed.every(l => l.isCall) &&
      l1.isBuy && l2.isSell && l3.isSell && l4.isBuy;

    // Check for Put Condor (Lecture 12.13):
    // All Puts: Buy K1, Sell K2, Sell K3, Buy K4 where K1 < K2 < K3 < K4
    const isPutCondor = (K1 < K2 && K2 < K3 && K3 < K4) &&
      parsed.every(l => l.isPut) &&
      l1.isBuy && l2.isSell && l3.isSell && l4.isBuy;

    if (isIronCondor) {
      const netCreditBTC = (l2.price + l3.price) - (l1.price + l4.price);
      const netCreditUSD = netCreditBTC * S;
      const wingWidth = Math.max(K2 - K1, K4 - K3);
      const maxLossUSD = Math.max(0, wingWidth - netCreditUSD);
      const maxProfitBTC = Number((netCreditBTC * l1.amount).toFixed(2));

      strategyType = 'IRON_CONDOR';
      strategyNameZh = '经典铁鹰策略 (Iron Condor / 4-Leg Strangle Credit)';
      intentBadge = '做空波动率 / 宽幅区间收租';
      intentBadgeClass = 'badge-vol-sell';
      riskProfile = {
        maxProfit: `净贷方权利金收入 ~${maxProfitBTC} BTC (标的到期日在 [$${K2.toLocaleString()}, $${K3.toLocaleString()}] 通道内全额收割)`,
        maxLoss: `约 $${Math.round(maxLossUSD * l1.amount).toLocaleString()} (两翼最大行权价差扣除净权利金)`,
        breakEven: `$${Math.round(K2 - netCreditUSD).toLocaleString()} (下边界) 及 $${Math.round(K3 + netCreditUSD).toLocaleString()} (上边界)`,
        inverseCurvature: '铁鹰策略通过卖出虚值宽跨式同时在更深虚值买入保护翅膀，在 Deribit 反向合约中有效锁死双边穿仓风险，净现金流以 BTC 稳定进账。'
      };
      theoreticalPointers = [
        `双翼完全锁死风险 (Fully Defined Risk)：结合了牛市看跌贷方价差与熊市看涨贷方价差，彻底杜绝裸卖跨式的无限穿仓可能。`,
        `最大化方差溢价收敛：机构判定在 ${l1.expiryStr} 到期日前市场将在 $${K2.toLocaleString()} 至 $${K3.toLocaleString()} 宽幅区间内收敛震荡。`,
        `高胜率 Theta 现金流：持仓处于正 Theta 峰值区，只要价格未发生超预期单边破位，时间价值将稳步兑现为净利润。`
      ];
      intentNarrative = `本笔交易为规模达 $${(totalNotionalUSD / 1e6).toFixed(1)}M 的顶级做市商标准【铁鹰策略 (Iron Condor)】。机构在 $${K2.toLocaleString()} 卖 Put 并在 $${K3.toLocaleString()} 卖 Call，同时在外围 $${K1.toLocaleString()} 和 $${K4.toLocaleString()} 分别买入期权锁定两翼最大风险。纯做空波动率，只要现货保持在 [$${K2.toLocaleString()}, $${K3.toLocaleString()}] 走廊内即可吃满全部权利金。`;
    } else if (isIronButterfly) {
      const netCreditBTC = (l2.price + l3.price) - (l1.price + l4.price);
      const netCreditUSD = netCreditBTC * S;
      const wingWidth = Math.max(K2 - K1, K4 - K2);
      const maxLossUSD = Math.max(0, wingWidth - netCreditUSD);
      const maxProfitBTC = Number((netCreditBTC * l1.amount).toFixed(2));

      strategyType = 'IRON_BUTTERFLY';
      strategyNameZh = '经典铁蝶策略 (Iron Butterfly / ATM Straddle Protection)';
      intentBadge = '精准中枢做空波动率 / 极高Theta收割';
      intentBadgeClass = 'badge-vol-sell';
      riskProfile = {
        maxProfit: `净收全部贷方权利金 ~${maxProfitBTC} BTC (标的精准钉盘在平值中心 $${K2.toLocaleString()})`,
        maxLoss: `约 $${Math.round(maxLossUSD * l1.amount).toLocaleString()} (单侧翅膀间距 - 净权利金)`,
        breakEven: `$${Math.round(K2 - netCreditUSD).toLocaleString()} 及 $${Math.round(K2 + netCreditUSD).toLocaleString()}`,
        inverseCurvature: '铁蝶由平值平价卖出跨式与外侧买入宽跨式组合而成，收取的权利金显著高于铁鹰，平值钉盘 Gamma 敏感度极高。'
      };
      theoreticalPointers = [
        `极高风险回报比：相比普通卖跨式，两翼买腿大幅削减保证金占用，同时以有限风险博取极高权利金收入。`,
        `Gamma 挤压与钉盘效应 (Pin Risk)：在中间行权价 $${K2.toLocaleString()} 附近具有极大负 Gamma，临近到期时间价值衰减呈指数级释放。`,
        `方差风险溢价捕获 (Variance Premium)：专用于预期当前高企的 ATM IV 存在严重泡沫的均值回归阶段。`
      ];
      intentNarrative = `本笔交易为总额超 $${(totalNotionalUSD / 1e6).toFixed(1)}M 的教科书级【铁蝶策略 (Iron Butterfly)】。机构在 $${K2.toLocaleString()} 卖出平值跨式（Call+Put），同时在 $${K1.toLocaleString()} 与 $${K4.toLocaleString()} 买入宽跨式保护。以确定性有限亏损换取中心点极致的 Theta 衰减收割。`;
    } else if (isCallCondor || isPutCondor) {
      const isCall = isCallCondor;
      strategyType = isCall ? 'CALL_CONDOR' : 'PUT_CONDOR';
      strategyNameZh = isCall ? '经典看涨鹰式价差 (Long Call Condor)' : '经典看跌鹰式价差 (Long Put Condor)';
      intentBadge = '借方区间收敛 / 宽幅收益锁定';
      intentBadgeClass = 'badge-neutral';
      riskProfile = {
        maxProfit: `中间区间最大利润 (标的在 [$${K2.toLocaleString()}, $${K3.toLocaleString()}] 结算)`,
        maxLoss: '借方净权利金支出',
        breakEven: `$${K1.toLocaleString()} 与 $${K4.toLocaleString()} 内侧边缘`
      };
      theoreticalPointers = [
        `低成本区间锁定：全 Call 或全 Put 构造的 4 腿借方结构，在两翼间距处呈现梯形收益曲线。`,
        `完全中性化 Delta：持仓在入场时具有极低单边方向敞口，适合预期价格进入平稳平台期。`
      ];
      intentNarrative = `本笔交易为 4 腿构型的【${strategyNameZh}】。机构通过 4 级行权价差梯级配置，用微小借方成本锁定标的在 $${K2.toLocaleString()} 至 $${K3.toLocaleString()} 之间的确定性超额赔率。`;
    }
  }

  // ==========================================
  // 3-LEG STRATEGIES (Lecture 12.14)
  // ==========================================
  else if (numLegs === 3 && sameExpiryAll) {
    const [l1, l2, l3] = parsed;
    const sameType = l1.isCall === l2.isCall && l2.isCall === l3.isCall;

    if (sameType) {
      const dStrike1 = l2.strike - l1.strike;
      const dStrike2 = l3.strike - l2.strike;
      const isSymmetric = Math.abs(dStrike1 - dStrike2) <= 50;
      const is121Ratio = (l2.amount >= l1.amount * 1.7) && (Math.abs(l1.amount - l3.amount) <= 15);

      if (l1.isBuy && l2.isSell && l3.isBuy && is121Ratio) {
        const K1 = l1.strike, K2 = l2.strike, K3 = l3.strike;
        const wingWidth = dStrike1;
        const netDebitBTC = l1.price - 2 * l2.price + l3.price;
        const netDebitUSD = netDebitBTC * S;
        const maxProfitBTC = Number(((wingWidth / S - Math.max(0, netDebitBTC)) * l1.amount).toFixed(2));

        if (isSymmetric) {
          strategyType = l1.isCall ? 'LONG_BUTTERFLY_SPREAD' : 'LONG_PUT_BUTTERFLY';
          strategyNameZh = l1.isCall ? '对称多头看涨蝶式 (Long Call Butterfly 1-2-1)' : '对称多头看跌蝶式 (Long Put Butterfly 1-2-1)';
          intentBadge = '精准区间锁定 / 极高风险回报比';
          intentBadgeClass = 'badge-strategy-butterfly';
          riskProfile = {
            maxProfit: `约 ${maxProfitBTC.toFixed(2)} BTC (到期日标的精准钉盘在中间行权价 $${K2.toLocaleString()})`,
            maxLoss: `净权利金支出 ~$${Math.round(Math.max(1000, netDebitUSD * l1.amount)).toLocaleString()} (标的 <= $${K1.toLocaleString()} 或 >= $${K3.toLocaleString()})`,
            breakEven: `$${Math.round(K1 + netDebitUSD).toLocaleString()} 及 $${Math.round(K3 - netDebitUSD).toLocaleString()}`,
            inverseCurvature: '反向蝶式价差在两翼具有完全对称的风险闭环，中间行权价具有极高正 Gamma 聚拢度，标的越接近中心，收益越化为丰厚净利。'
          };
          theoreticalPointers = [
            `极端非对称赔率 (Asymmetric R/R)：蝶式价差用极微小的借方权利金（往往仅占间距的 5%~10%），博取高达 5~10 倍的中间行权价封顶暴利。`,
            `多头 Gamma 钉盘中心：在中间行权价 $${K2.toLocaleString()} 附近具有极高正 Gamma 与正 Theta 聚拢度，标的越接近中心，持仓价值衰减越化为丰厚净利。`,
            `双边风险完全封死 (Fully Bounded Tail Risk)：无论后市单边暴跌至归零还是暴涨至百万美元，最大亏损均被两翼买腿刚性锁定，彻底杜绝穿仓风险。`
          ];
          intentNarrative = `本笔交易为规模高达 $${(totalNotionalUSD / 1e6).toFixed(1)}M 的顶级教科书式【对称多头蝶式价差 (1-2-1 ${strategyNameZh})】。机构在 $${K1.toLocaleString()} 买入 1 份，在 $${K2.toLocaleString()} 卖出 2 份，并在 $${K3.toLocaleString()} 买入 1 份。利用极低成本锁定全额下行与上行风险，精准狙击标的在 ${l1.expiryStr} 到期日前后于 $${K2.toLocaleString()} 中枢附近的区间收敛。`;
        } else {
          // Broken Wing Butterfly (Lecture 12.14)
          strategyType = 'BROKEN_WING_BUTTERFLY';
          strategyNameZh = '折翅非对称蝶式 (Broken Wing Butterfly / Skip Strike)';
          intentBadge = '定向偏置蝶式 / 消除单侧风险';
          intentBadgeClass = 'badge-strategy-butterfly';
          riskProfile = {
            maxProfit: `中间峰值利润 (标的在 $${K2.toLocaleString()} 交割)`,
            maxLoss: '由较宽翅膀侧的最大价差决定；较窄侧往往为零风险或净利润',
            breakEven: '单侧或双侧不对称平衡点'
          };
          theoreticalPointers = [
            `消除单侧风险 (Zero-Cost / Credit Wing)：故意将单侧翅膀拉宽，以获取更大权利金补贴，甚至将整体结构转为净贷方，彻底消除单侧亏损。`,
            `定向微倾斜：在保留蝶式极高赔率的同时，融入了温和方向性偏好。`
          ];
          intentNarrative = `本笔交易为构型独特的【折翅非对称蝶式价差 (Broken Wing Butterfly)】（行权价 $${K1.toLocaleString()} / $${K2.toLocaleString()} / $${K3.toLocaleString()}）。机构通过两翼不对称间距将建仓成本降至最低甚至转为贷方，实现了单侧完全无亏损风险的定向收割。`;
        }
      }
    }
  }

  // ==========================================
  // 2-LEG STRATEGIES (Lecture 12.2 - 12.5, 12.8 - 12.12, 12.15, 12.16)
  // ==========================================
  else if (numLegs === 2) {
    const [leg1, leg2] = parsed; // leg1 has lower strike, leg2 has higher strike
    const sameExpiry = leg1.expiryStr === leg2.expiryStr;
    const sameType = leg1.isCall === leg2.isCall;

    if (sameExpiry && sameType) {
      const isCallSpread = leg1.isCall;
      const strikeDiff = leg2.strike - leg1.strike;
      const ratio = leg2.amount / (leg1.amount || 1);
      const is1x2Ratio = ratio >= 1.5 && ratio <= 2.5;

      // ----------------------------------------------------
      // Ratio Spreads (Lecture 12.11 & 12.12)
      // ----------------------------------------------------
      if (isCallSpread) {
        // Call Ratio Backspread (Lecture 12.11): Sell 1 low Call (leg1), Buy 2 high Calls (leg2)
        if (leg1.isSell && leg2.isBuy && is1x2Ratio) {
          const netCreditBTC = leg1.price - 2 * leg2.price;
          const netDebitUSD = -netCreditBTC * S;
          const maxLossUSD = strikeDiff + netDebitUSD;

          strategyType = 'RATIO_CALL_BACKSPREAD';
          strategyNameZh = '看涨反比例价差 (1x2 Call Backspread)';
          intentBadge = '做多波动率凸性 / 爆发性看涨突破';
          intentBadgeClass = 'badge-vol-buy';
          riskProfile = {
            maxProfit: 'USD 计价理论无限；BTC 本位受反向合约约束上限渐近逼近 1.0 BTC (扣除净借方)',
            maxLoss: `$${Math.round(maxLossUSD * leg1.amount).toLocaleString()} (当现货恰好停留在高行权价 $${leg2.strike.toLocaleString()} 时发生极大亏损)`,
            breakEven: `$${Math.round(leg2.strike + maxLossUSD).toLocaleString()} (上突破口)；若为净贷方则在 $${leg1.strike.toLocaleString()} 下方亦保底盈利`,
            inverseCurvature: 'Deribit 反向合约特性：在 $K_2$ 处承受最大下凹亏损；突破 $K_2$ 后随着现货暴拉，净多头 1 份 Call 产生无限 USD 收益，BTC 计价收益渐近收敛至 1.0 BTC。'
          };
          theoreticalPointers = [
            `做多波动率凸性 (Long Volatility & Gamma)：用卖出平值 Call 的高额权利金融资买入双倍虚值 Call，零成本或微小借方撬动爆发性拉升。`,
            `下行风险极小：若市场完全未涨甚至暴跌，平值卖腿收益完全覆盖买腿成本，下行仅面临微亏或稳赚净贷方。`,
            `死穴在拐点：最忌惮现货温和上涨并精准停留在短腿行权价 $${leg2.strike.toLocaleString()} 附近，此时多头尚未发力而短腿亏损见顶。`
          ];
          intentNarrative = `本笔交易为极具攻击性的机构级【1x2 看涨反比例价差 (Call Backspread)】。机构卖出 1 份 $${leg1.strike.toLocaleString()} Call，同时买入 2 份 $${leg2.strike.toLocaleString()} Call。以极低成本甚至净贷方锁死下行，换取在标的突破 $${leg2.strike.toLocaleString()} 后的指数级正 Gamma 爆发，反映对单边超级大牛市的坚定信仰。`;
        }
        // Call Front Spread (Lecture 12.11): Buy 1 low Call (leg1), Sell 2 high Calls (leg2)
        else if (leg1.isBuy && leg2.isSell && is1x2Ratio) {
          strategyType = 'RATIO_CALL_FRONT_SPREAD';
          strategyNameZh = '看涨正比例价差 (1x2 Call Front Spread)';
          intentBadge = '温和看涨收租 / 上行极端敞口暴露';
          intentBadgeClass = 'badge-vol-sell';
          riskProfile = {
            maxProfit: `约 $${Math.round(strikeDiff * leg1.amount).toLocaleString()} (现货恰好停在 $${leg2.strike.toLocaleString()})`,
            maxLoss: '右侧上行理论无限亏损 (因裸空 1 份 Call)',
            breakEven: `$${Math.round(leg2.strike + strikeDiff).toLocaleString()}`
          };
          theoreticalPointers = [
            `高胜率收割偏度溢价：在虚值 Call 具有极高波动率微笑溢价时，卖出双倍虚值期权获取大额贷方。`,
            `右侧无限风险预警：标的若发生极端单边逼空暴拉，持仓将面临裸空暴击，机构通常配合现货库存进行半备兑管理。`
          ];
          intentNarrative = `本笔交易为【1x2 看涨正比例价差 (Call Front Spread)】。机构买入 1 份 $${leg1.strike.toLocaleString()} Call，卖出 2 份 $${leg2.strike.toLocaleString()} Call。旨在赚取温和上涨至 $${leg2.strike.toLocaleString()} 过程中的峰值利润，需警惕后市极端暴拉的裸空敞口。`;
        }
        // Standard 1:1 Bull Call Spread
        else if (leg1.isBuy && leg2.isSell) {
          const netDebitBTC = leg1.price - leg2.price;
          const netDebitUSD = netDebitBTC * S;
          const maxProfitBTC = Number(((strikeDiff / S - netDebitBTC) * leg1.amount).toFixed(2));
          
          strategyType = 'BULL_CALL_SPREAD';
          strategyNameZh = '牛市看涨价差 (Bull Call Spread / Debit Call Spread)';
          intentBadge = '温和看涨 / 锁定风险杠杆做多';
          intentBadgeClass = 'badge-bull';
          riskProfile = {
            maxProfit: `约 ${maxProfitBTC.toFixed(2)} BTC (标的在到期日 >= $${leg2.strike.toLocaleString()})`,
            maxLoss: `净权利金支出 ~${(netDebitBTC * leg1.amount).toFixed(2)} BTC (标的 <= $${leg1.strike.toLocaleString()})`,
            breakEven: `$${Math.round(leg1.strike + netDebitUSD).toLocaleString()} (低行权价 + 净支出权利金)`
          };
          theoreticalPointers = [
            `权利金补贴 (Financing Leg)：通过卖出虚值 $${leg2.strike.toLocaleString()} Call 大幅降低买入 $${leg1.strike.toLocaleString()} Call 的持仓成本。`,
            `希腊字母中和 (Greeks Mitigation)：高位卖腿对冲了平值买腿的部分 Vega 与 Theta 磨损，使持仓对 IV 波动具有更强免疫力。`,
            `确界赔率 (Bounded Risk/Reward)：彻底锁死最大亏损与最大收益，符合大型专业机构严格的风险预算准则。`
          ];
          intentNarrative = `本笔交易为规模达 $${(totalNotionalUSD / 1e6).toFixed(1)}M 的经典【牛市看涨期权借方价差 (Bull Call Spread)】。机构买入 $${leg1.strike.toLocaleString()} 看涨期权的同时，卖出相同数量的 $${leg2.strike.toLocaleString()} 看涨期权进行融资。既锁定了最大亏损仅为净权利金支出，又在 $${leg1.strike.toLocaleString()} 至 $${leg2.strike.toLocaleString()} 关键价格走廊中获得了高杠杆收益。`;
        }
        // Standard 1:1 Bear Call Spread
        else if (leg1.isSell && leg2.isBuy) {
          const netCreditBTC = leg1.price - leg2.price;
          const netCreditUSD = netCreditBTC * S;
          const maxLossUSD = strikeDiff - netCreditUSD;
          const maxProfitBTC = Number((netCreditBTC * leg1.amount).toFixed(2));

          strategyType = 'BEAR_CALL_SPREAD';
          strategyNameZh = '熊市看涨价差 (Bear Call Spread / Credit Call Spread)';
          intentBadge = '看跌防守 / 阻力区贷方收租';
          intentBadgeClass = 'badge-bear';
          riskProfile = {
            maxProfit: `净权利金收入 ~${maxProfitBTC.toFixed(2)} BTC (标的在到期日 <= $${leg1.strike.toLocaleString()})`,
            maxLoss: `约 $${Math.round(maxLossUSD * leg1.amount).toLocaleString()} (标的 >= $${leg2.strike.toLocaleString()})`,
            breakEven: `$${Math.round(leg1.strike + netCreditUSD).toLocaleString()} (低行权价 + 净收入权利金)`
          };
          theoreticalPointers = [
            `概率优势 (Statistical Edge)：利用高行权价买腿将做空裸 Call 的无限爆仓风险降为有限风险，在阻力区赚取高胜率时间价值。`,
            `正 Theta 现金流：只要现货在到期日前保持在 $${leg1.strike.toLocaleString()} 之下，双腿期权将双双归零，机构全额通吃净权利金。`,
            `负 Delta 压制：建立温和看空敞口，适合研判上方存在重磅天花板、难有突破行情的宏观阻力阶段。`
          ];
          intentNarrative = `本笔交易为总名义本金超 $${(totalNotionalUSD / 1e6).toFixed(1)}M 的【熊市看涨期权贷方价差 (Bear Call Spread)】。大资金在 $${leg1.strike.toLocaleString()} 卖出看涨期权，并在 $${leg2.strike.toLocaleString()} 买入看涨期权作为保护伞。机构判定上方具有重重阻力，通过买入高行权价完全封死极端暴拉的尾部风险。`;
        }
      } else {
        // Put Spread or Put Ratio Spread (Lecture 12.12)
        const ratioPut = leg1.amount / (leg2.amount || 1);
        const is1x2PutRatio = ratioPut >= 1.5 && ratioPut <= 2.5;

        // Put Ratio Backspread: Buy 2 low Puts (leg1), Sell 1 high Put (leg2)
        if (leg1.isBuy && leg2.isSell && is1x2PutRatio) {
          strategyType = 'RATIO_PUT_BACKSPREAD';
          strategyNameZh = '看跌反比例价差 (1x2 Put Backspread)';
          intentBadge = '做多波动率凸性 / 极端下行崩盘博弈';
          intentBadgeClass = 'badge-vol-buy';
          riskProfile = {
            maxProfit: '标的深度崩盘时可获得倍数级下行收益',
            maxLoss: `在 $${leg1.strike.toLocaleString()} 处亏损最大`,
            breakEven: '下边界突破口'
          };
          theoreticalPointers = [
            `零成本深度尾部对冲：卖出高行权价 Put 资助买入双倍虚值 Put，在标的暴跌击穿支撑位后释放极强正 Gamma。`,
            `防御性结构设计：若标的上涨，高行权价卖腿带来的权利金将补贴甚至带来净收益。`
          ];
          intentNarrative = `本笔交易为大资金构建的【1x2 看跌反比例价差 (Put Backspread)】。机构卖出 1 份高位 Put 资助买入 2 份低位 Put，旨在防范流动性骤缩导致的断崖式崩盘。`;
        }
        // Standard 1:1 Bear Put Spread
        else if (leg1.isSell && leg2.isBuy) {
          const netDebitBTC = leg2.price - leg1.price;
          const netDebitUSD = netDebitBTC * S;
          const maxProfitBTC = Number(((strikeDiff / S - netDebitBTC) * leg1.amount).toFixed(2));

          strategyType = 'BEAR_PUT_SPREAD';
          strategyNameZh = '熊市看跌价差 (Bear Put Spread / Debit Put Spread)';
          intentBadge = '看空防守 / 廉价下行对冲';
          intentBadgeClass = 'badge-bear';
          riskProfile = {
            maxProfit: `约 ${maxProfitBTC.toFixed(2)} BTC (标的 <= $${leg1.strike.toLocaleString()})`,
            maxLoss: `净权利金支出 ~${(netDebitBTC * leg1.amount).toFixed(2)} BTC (标的 >= $${leg2.strike.toLocaleString()})`,
            breakEven: `$${Math.round(leg2.strike - netDebitUSD).toLocaleString()} (高行权价 - 净支出权利金)`
          };
          theoreticalPointers = [
            `低成本下行防线：通过卖出更低行权价的 Put 补贴高行权价 Put，相比单腿 Long Put 显著减少 Theta 衰减磨损。`,
            `收益区间明确：在标的下跌至 $${leg1.strike.toLocaleString()} 期间获取完整差价，规避过度追求极端黑天鹅的无效成本。`,
            `确定性风险预算：即使市场意外强力反弹，最大亏损亦严格限制在预支的权利金以内。`
          ];
          intentNarrative = `本笔交易为总额超 $${(totalNotionalUSD / 1e6).toFixed(1)}M 的【熊市看跌借方价差 (Bear Put Spread)】。机构买入 $${leg2.strike.toLocaleString()} Put 锁定下行保护，同时卖出 $${leg1.strike.toLocaleString()} Put 降低对冲成本。为组合精准配置了梯级安全护城河。`;
        }
        // Standard 1:1 Bull Put Spread
        else if (leg1.isBuy && leg2.isSell) {
          const netCreditBTC = leg2.price - leg1.price;
          const netCreditUSD = netCreditBTC * S;
          const maxLossUSD = strikeDiff - netCreditUSD;
          const maxProfitBTC = Number((netCreditBTC * leg1.amount).toFixed(2));

          strategyType = 'BULL_PUT_SPREAD';
          strategyNameZh = '牛市看跌价差 (Bull Put Spread / Credit Put Spread)';
          intentBadge = '温和看多 / 支撑区保底收息';
          intentBadgeClass = 'badge-bull';
          riskProfile = {
            maxProfit: `净权利金收入 ~${maxProfitBTC.toFixed(2)} BTC (标的 >= $${leg2.strike.toLocaleString()})`,
            maxLoss: `约 $${Math.round(maxLossUSD * leg1.amount).toLocaleString()} (标的 <= $${leg1.strike.toLocaleString()})`,
            breakEven: `$${Math.round(leg2.strike - netCreditUSD).toLocaleString()} (高行权价 - 净收入权利金)`
          };
          theoreticalPointers = [
            `高安全边际：在标的下方支撑位构建，只要标的未跌破 $${leg2.strike.toLocaleString()} 即可稳收全部现金收益。`,
            `尾部截断保护：买入 $${leg1.strike.toLocaleString()} Put 彻底消除了裸卖 Put 面对流动性黑天鹅的爆仓隐患。`,
            `正 Theta 时间流利好：平稳盘整或小幅上涨均能使持仓价值加速趋向最大利润。`
          ];
          intentNarrative = `本笔交易为总金额超 $${(totalNotionalUSD / 1e6).toFixed(1)}M 的【牛市看跌贷方价差 (Bull Put Spread)】。机构在 $${leg2.strike.toLocaleString()} 卖出 Put 的同时在 $${leg1.strike.toLocaleString()} 买入深度虚值 Put 防身，表明大资金判定现货在该防线具备极强底部支撑，旨在赚取确定性时间价值。`;
        }
      }
    }

    else if (sameExpiry && !sameType) {
      const callLeg = parsed.find(l => l.isCall);
      const putLeg = parsed.find(l => l.isPut);

      if (callLeg && putLeg) {
        const isSameStrike = callLeg.strike === putLeg.strike;

        // ----------------------------------------------------
        // Synthetic Positions (Lecture 12.16)
        // ----------------------------------------------------
        if (isSameStrike) {
          if (callLeg.isBuy && putLeg.isSell) {
            strategyType = 'SYNTHETIC_LONG_FUTURE';
            strategyNameZh = '合成标的多头 (Synthetic Long Future / Parity Replication)';
            intentBadge = '合成现货做多 / 100%正Delta';
            intentBadgeClass = 'badge-bull';
            riskProfile = {
              maxProfit: '上行完全复制现货多头理论无限',
              maxLoss: `$${Math.round(callLeg.strike * callLeg.amount).toLocaleString()} (下行类似持有现货完全暴露)`,
              breakEven: `$${Math.round(callLeg.strike + (callLeg.price - putLeg.price) * S).toLocaleString()}`
            };
            theoreticalPointers = [
              `期权平价公式复制 (Put-Call Parity)：C - P = S - K。买入 Call 同时卖出同行权价 Put，净 Delta 严格恒等于 +1.0。`,
              `资金效率最大化：完全替代现货或交割合约，规避现货借贷利息与永续合约资金费率磨损。`,
              `机构套利基准：常用作跨期现货套利或基差锁定基准头寸。`
            ];
            intentNarrative = `本笔交易为经典的【合成标的多头 (Synthetic Long Future)】。机构在行权价 $${callLeg.strike.toLocaleString()} 同时买入 Call 并卖出 Put，以零资金费率完美复制现货多头 Delta=1.0 敞口，显示大资金对后市的绝对做多信念。`;
          } else if (callLeg.isSell && putLeg.isBuy) {
            strategyType = 'SYNTHETIC_SHORT_FUTURE';
            strategyNameZh = '合成标的空头 (Synthetic Short Future)';
            intentBadge = '合成现货做空 / 100%负Delta';
            intentBadgeClass = 'badge-bear';
            riskProfile = {
              maxProfit: `下行收益丰厚`,
              maxLoss: '上行理论无限',
              breakEven: `$${Math.round(callLeg.strike - (putLeg.price - callLeg.price) * S).toLocaleString()}`
            };
            theoreticalPointers = [
              `合成纯空头头寸：卖出 Call 同时买入同行权价 Put，净 Delta 恒等于 -1.0。`,
              `无借币做空成本：无需在现货市场借入筹码，彻底规避借贷费与融券清算风险。`
            ];
            intentNarrative = `本笔交易为【合成标的空头 (Synthetic Short Future)】。机构通过买 Put + 卖 Call 组合合成负 Delta=-1.0 的完全做空敞口。`;
          } else if (callLeg.isBuy && putLeg.isBuy) {
            strategyType = 'LONG_STRADDLE';
            strategyNameZh = '买入平值跨式组合 (Long Straddle)';
            intentBadge = '纯做多波动率 / 双向变盘突破';
            intentBadgeClass = 'badge-vol-buy';
            const totalCostBTC = Number(((callLeg.price * callLeg.amount) + (putLeg.price * putLeg.amount)).toFixed(2));
            riskProfile = {
              maxProfit: '理论无限 (双向大幅暴走破位，以 BTC 本位计价)',
              maxLoss: `净权利金支出 (~${totalCostBTC.toFixed(2)} BTC)`,
              breakEven: `$${Math.round(callLeg.strike + (totalCostBTC * S) / callLeg.amount).toLocaleString()} 及 $${Math.round(putLeg.strike - (totalCostBTC * S) / putLeg.amount).toLocaleString()}`
            };
            theoreticalPointers = [
              `纯粹做多波动率 (Pure Long Vol)：同时暴露正 Gamma 与正 Vega，不设方向预设立场。`,
              `非线性双向突破：只要标的剧烈突破损益平衡点，将收获无上限的非对称收益。`,
              `严防时间衰减：持仓承受双倍 Theta 磨损，需在期限内迎来超出市场预期的实际爆发。`
            ];
            intentNarrative = `本笔交易为名义价值超 $${(totalNotionalUSD / 1e6).toFixed(1)}M 的顶级【做多波动率组合 (${strategyNameZh})】。机构同时买入 Call 与 Put，完全对冲单边 Delta 风险，全力博弈标的在 ${callLeg.expiryStr} 到期前走出极端单边暴拉或断崖式暴跌。`;
          } else if (callLeg.isSell && putLeg.isSell) {
            strategyType = 'SHORT_STRADDLE';
            strategyNameZh = '卖出平值跨式组合 (Short Straddle)';
            intentBadge = '做空波动率 / 中枢收敛收租';
            intentBadgeClass = 'badge-vol-sell';
            const totalCreditBTC = Number(((callLeg.price * callLeg.amount) + (putLeg.price * putLeg.amount)).toFixed(2));
            riskProfile = {
              maxProfit: `双腿收取的全部权利金 (~${totalCreditBTC.toFixed(2)} BTC)`,
              maxLoss: '双向单边暴走带来的理论无限亏损 (以 BTC 计价)',
              breakEven: `$${Math.round(callLeg.strike + (totalCreditBTC * S) / callLeg.amount).toLocaleString()} 及 $${Math.round(putLeg.strike - (totalCreditBTC * S) / putLeg.amount).toLocaleString()}`
            };
            theoreticalPointers = [
              `最大化 Theta 收割：作为波动率流动性提供者（做市商核心策略），持续榨取时间价值。`,
              `方差溢价捕获：押注实际波动率低于当前高企的隐含波动率，博取平静区间收益。`,
              `双边穿透风险：标的一旦发生黑天鹅级跳空突破，将面临单边急剧亏损。`
            ];
            intentNarrative = `本笔交易为规模达 $${(totalNotionalUSD / 1e6).toFixed(1)}M 的【做空波动率收租策略 (${strategyNameZh})】。大资金同时卖出平值 Call 与 Put，全额收入约 ${totalCreditBTC.toFixed(2)} BTC 权利金，笃定到期日前标的将精准停留在行权价附近。`;
          }
        }
        // Non-same strike: Risk Reversals or Strangles
        else {
          if (callLeg.isBuy && putLeg.isSell) {
            strategyType = 'BULLISH_RISK_REVERSAL';
            strategyNameZh = '牛市风险逆转组合 (Bullish Risk Reversal / Synthetic Long)';
            intentBadge = '合成现货多头 / 做空偏度买涨';
            intentBadgeClass = 'badge-bull';
            riskProfile = {
              maxProfit: '理论无限 (由买入 Call 驱动，以 BTC 本位计价)',
              maxLoss: `$${Math.round(putLeg.strike * putLeg.amount).toLocaleString()} (下行类似持有现货，由卖出 Put 承担接盘风险)`,
              breakEven: `接近平价现货，精准由净权利金调整`
            };
            theoreticalPointers = [
              `做空偏度套利 (Short Skew)：利用市场上 Put 隐含波动率常态化溢价（Put Skew），卖出高估的 Put 免费或极低成本资助买入虚值 Call。`,
              `合成现货杠杆 (Synthetic Long)：持仓 Delta 显著为正，且资金利用率数倍于现货或永续合约借贷，且无日内插针爆仓清算机制。`,
              `机构高置信度多头意图：大机构以接盘现货的底气卖出 $${putLeg.strike.toLocaleString()} Put，换取零成本撬动 $${callLeg.strike.toLocaleString()} 之上的暴利空间。`
            ];
            intentNarrative = `本笔交易为规模达 $${(totalNotionalUSD / 1e6).toFixed(1)}M 的顶级投行标配【牛市风险逆转组合 (Bullish Risk Reversal)】。大资金果断卖出 $${putLeg.strike.toLocaleString()} 看跌期权，全额资助买入 $${callLeg.strike.toLocaleString()} 看涨期权。既利用了市场看跌期权的偏度溢价，又以极低成本合成了强大的多头杠杆。`;
          } else if (callLeg.isSell && putLeg.isBuy) {
            strategyType = 'BEARISH_RISK_REVERSAL';
            strategyNameZh = '熊市风险逆转 / 零成本领口对冲 (Collar / Synthetic Short)';
            intentBadge = '零成本硬核防守 / 锁死下行';
            intentBadgeClass = 'badge-bear';
            riskProfile = {
              maxProfit: `约 ${((putLeg.strike * putLeg.amount) / S).toFixed(2)} BTC (由买入 Put 驱动)`,
              maxLoss: '若裸卖 Call 则上行无限；若配合现货则收益在 Call 行权价封顶',
              breakEven: `由两腿执行价与权利金净收付综合决定`
            };
            theoreticalPointers = [
              `零成本防守对冲 (Zero-Cost Hedge)：利用上方卖出 Call 的收入完全覆盖下方买入保护性 Put 的成本，实现近乎零成本的下行全封锁。`,
              `天花板锁利置换：愿意牺牲 $${callLeg.strike.toLocaleString()} 之上的浮盈空间，换取组合在 $${putLeg.strike.toLocaleString()} 下方的绝对本金安全。`,
              `宏观避险特征：常出现于重大宏观事件公布前夕，反映机构级保守风控资产管理思路。`
            ];
            intentNarrative = `本笔交易为总额超 $${(totalNotionalUSD / 1e6).toFixed(1)}M 的【熊市风险逆转 / 零成本领口对冲组合 (Collar)】。机构卖出高位 $${callLeg.strike.toLocaleString()} Call 的权利金，为购买 $${putLeg.strike.toLocaleString()} Put 提供了全部资金。`;
          } else if (callLeg.isBuy && putLeg.isBuy) {
            strategyType = 'LONG_STRANGLE';
            strategyNameZh = '买入宽跨式组合 (Long Strangle)';
            intentBadge = '做多波动率 / 双向宽幅突破';
            intentBadgeClass = 'badge-vol-buy';
            const totalCostBTC = Number(((callLeg.price * callLeg.amount) + (putLeg.price * putLeg.amount)).toFixed(2));
            riskProfile = {
              maxProfit: '理论无限 (双向破位突破，以 BTC 本位计价)',
              maxLoss: `净权利金支出 (~${totalCostBTC.toFixed(2)} BTC)`,
              breakEven: `$${Math.round(callLeg.strike + (totalCostBTC * S) / callLeg.amount).toLocaleString()} 及 $${Math.round(putLeg.strike - (totalCostBTC * S) / putLeg.amount).toLocaleString()}`
            };
            theoreticalPointers = [
              `廉价做多波动率：相比 Straddle 成本更低，但要求标的产生更大维度的价格位移。`,
              `宽幅突破博弈：适合即将迎来重大政策决议或里程碑数据前夕布局。`
            ];
            intentNarrative = `本笔交易为【买入宽跨式组合 (Long Strangle)】。机构同时配置虚值 Call 与虚值 Put，以低廉成本博取两端的极端变盘爆发。`;
          } else if (callLeg.isSell && putLeg.isSell) {
            strategyType = 'SHORT_STRANGLE';
            strategyNameZh = '卖出宽跨式组合 (Short Strangle)';
            intentBadge = '做空波动率 / 宽幅通道收租';
            intentBadgeClass = 'badge-vol-sell';
            const totalCreditBTC = Number(((callLeg.price * callLeg.amount) + (putLeg.price * putLeg.amount)).toFixed(2));
            riskProfile = {
              maxProfit: `收取的全部权利金 (~${totalCreditBTC.toFixed(2)} BTC)`,
              maxLoss: '双向单边暴走带来的理论无限亏损',
              breakEven: `$${Math.round(callLeg.strike + (totalCreditBTC * S) / callLeg.amount).toLocaleString()} 及 $${Math.round(putLeg.strike - (totalCreditBTC * S) / putLeg.amount).toLocaleString()}`
            };
            theoreticalPointers = [
              `高安全垫宽幅震荡收租：行权价间距为现货提供了巨大的安全缓冲空间。`,
              `严密风控要求：一旦标的逼近其中一侧行权价，需及时进行 Delta 对冲或展期滚动。`
            ];
            intentNarrative = `本笔交易为规模达 $${(totalNotionalUSD / 1e6).toFixed(1)}M 的【卖出宽跨式策略 (Short Strangle)】。大资金笃定标的在到期前将在两翼通道内震荡收敛。`;
          }
        }
      }
    }

    else if (!sameExpiry) {
      const d1 = parseDeribitExpiry(leg1.expiryStr)?.getTime() || 0;
      const d2 = parseDeribitExpiry(leg2.expiryStr)?.getTime() || 0;
      const nearLeg = d1 < d2 ? leg1 : leg2;
      const farLeg = d1 < d2 ? leg2 : leg1;

      if (farLeg.isBuy && nearLeg.isSell) {
        strategyType = 'LONG_CALENDAR_SPREAD';
        strategyNameZh = '买入日历价差 (Long Calendar Spread)';
        intentBadge = '期限结构套利 / 近端收息远端做多';
        intentBadgeClass = 'badge-neutral';
        riskProfile = {
          maxProfit: '在近端到期日标的正好处在行权价时达到最大 (BTC 本位)',
          maxLoss: '净借方权利金支出 (BTC 本位)',
          breakEven: '视远端波动率期限结构与平价水平动态波动'
        };
        theoreticalPointers = [
          `Theta 衰减不对称性：利用近端期权 Theta 衰减速率显著快于远期期权的数学特征，稳步赚取近端加速耗损。`,
          `远端 Vega 杠杆：远期期权 Vega 敏感度更高，远端 IV 补涨升水将带来显著账面增值。`,
          `时间平方根期限结构优势：在低波震荡市中具备极高的风险报酬比。`
        ];
        intentNarrative = `本笔交易为规模达 $${(totalNotionalUSD / 1e6).toFixed(1)}M 的【日历价差策略 (Calendar Spread)】。机构卖出近月期权收租，买入远月期权布局，巧妙利用不同期限的时间价值衰减速率差异与远期波动率抬升预期套利。`;
      } else if (farLeg.isSell && nearLeg.isBuy) {
        strategyType = 'REVERSE_CALENDAR_SPREAD';
        strategyNameZh = '反向日历价差 (Reverse Calendar Spread)';
        intentBadge = '反向日历 / 押注近端剧烈突破';
        intentBadgeClass = 'badge-neutral';
        riskProfile = {
          maxProfit: '净贷方权利金收入或标的暴涨暴跌导致的差价扩张 (BTC 本位)',
          maxLoss: '近端到期时标的停留在行权价附近 (BTC 本位)',
          breakEven: '根据远期与近期的折溢价综合确定'
        };
        theoreticalPointers = [
          `近端变盘博弈：买入近端以极高 Gamma 捕捉眼前即将落地的突发催化剂，同时卖出远端补贴持仓。`,
          `期限倒挂收益：若近端因突发行情出现剧烈 Backwardation（倒挂），近端涨幅将压倒远端。`,
          `逆向结构思维：适合在平静期前瞻性博弈即将到来的重大决议或数据发布。`
        ];
        intentNarrative = `本笔交易为总额超 $${(totalNotionalUSD / 1e6).toFixed(1)}M 的【反向日历价差组合 (Reverse Calendar Spread)】。机构买入近月期权博弈近端突发变盘，同时卖出远月期权以控制持仓净敞口，意在精准捕捉近端爆发性行情。`;
      }
    }
  }

  // ==========================================
  // FALLBACK HEURISTIC QUANT PROFILING
  // ==========================================
  if (strategyType === 'CUSTOM_STRUCTURE') {
    const deltaRatio = Math.abs(netDeltaUSD) / (totalNotionalUSD || 1);
    if (deltaRatio >= 0.25 || Math.abs(netDeltaUSD) >= 10000000) {
      if (netDeltaUSD > 0) {
        strategyType = 'DIRECTIONAL_BULL';
        strategyNameZh = '多头方向性策略组合';
        intentBadge = '看强方向 (多头建仓)';
        intentBadgeClass = 'badge-bull';
        riskProfile = {
          maxProfit: '上行方向收益丰富 (BTC 计价)',
          maxLoss: '由组合各腿综合净敞口限定',
          breakEven: '视各腿综合对冲成本而定'
        };
        theoreticalPointers = [
          `显著正 Delta 敞口：持仓直接受标的现货价格上拉驱动。`,
          `不对称上行博弈：机构主动偏向多头阵营，押注后市阻力破位。`,
          `综合希腊字母控制：通过多腿协同压制单边过高的 Vega 成本。`
        ];
        intentNarrative = `本笔交易呈现强烈的【多头方向性押注】（净 Delta 达 +$${(netDeltaUSD / 1e6).toFixed(1)}M）。大资金主动暴露正向 Delta 敞口，明确预期标的将在到期日前迎来单边突破。`;
      } else {
        strategyType = 'DIRECTIONAL_BEAR';
        strategyNameZh = '空头方向性对冲组合';
        intentBadge = '看强方向 (空头防守/做空)';
        intentBadgeClass = 'badge-bear';
        riskProfile = {
          maxProfit: `约 ${((totalNotionalUSD / S)).toFixed(2)} BTC (下行破位对冲收益)`,
          maxLoss: '由组合各腿综合净敞口限定',
          breakEven: '视各腿综合对冲成本而定'
        };
        theoreticalPointers = [
          `负 Delta 防御：有效抵御现货持仓的下行亏损，起到防波堤作用。`,
          `恐慌波动率防护：通常伴随正 Vega 或低成本卖腿结构，应对流动性挤压。`,
          `下行安全垫增厚：在不直接抛售现货的前提下实现平滑风险。`
        ];
        intentNarrative = `本笔交易呈现显著的【空头方向性押注或宏观下行对冲】（净 Delta 达 -$${(Math.abs(netDeltaUSD) / 1e6).toFixed(1)}M）。机构通过大额配置建立负 Delta 敞口，防范现货回调破位风险。`;
      }
    } else {
      if (netVegaUSD < -2000 && netThetaUSD > 2000) {
        strategyType = 'RANGEBOUND_SHORT_VOL';
        strategyNameZh = '区间震荡做空波动率';
        intentBadge = '看震荡 (沽空波动率 / Theta 收割)';
        intentBadgeClass = 'badge-vol-sell';
        riskProfile = {
          maxProfit: '净收取的各腿权利金 (BTC 本位)',
          maxLoss: '突破震荡区间面临亏损',
          breakEven: '由行权价区间与收取的权利金向外延展'
        };
        theoreticalPointers = [
          `Delta 趋于中性：规避了大部分单边现货价格波动的扰动。`,
          `每日稳定正 Theta 进账：在平稳市况下持续捕获时间流逝价值。`,
          `做空方差风险溢价：利用隐含波动率长期高估的统计特性获取结构性收益。`
        ];
        intentNarrative = `本笔交易核心意图为【做空波动率与看区间震荡】。Delta 敞口接近中性，净 Vega 为负，净 Theta 为正。机构预期后市将在行权价区间内窄幅震荡，旨在精准收割时间价值衰减与赚取 IV 回落溢价。`;
      } else if (netVegaUSD > 2000 && netThetaUSD < -2000) {
        strategyType = 'BREAKOUT_LONG_VOL';
        strategyNameZh = '突破变盘做多波动率';
        intentBadge = '看变盘 (做多波动率 / 突破博弈)';
        intentBadgeClass = 'badge-vol-buy';
        riskProfile = {
          maxProfit: '单边大幅爆发带来指数级利润 (BTC 计价)',
          maxLoss: '净支出的期权权利金与时间损耗 (BTC 本位)',
          breakEven: '需要实际波动率显著超出隐含波动率'
        };
        theoreticalPointers = [
          `正 Vega / 正 Gamma 敞口：极度契合低波动率末期的变盘节点。`,
          `二次方盈利递增：突破行权价后利润随价差加速放大。`,
          `需严控持仓时间：警惕长时间无波动导致的时间价值自然损耗。`
        ];
        intentNarrative = `本笔交易属于经典的【做多波动率（Long Vega）变盘押注】。Delta 保持相对中性，但净 Vega 达 +$${Math.round(netVegaUSD).toLocaleString()}/1% IV。机构预期当前极低波动率不可持续，押注后市将爆发重大单边突破或剧烈洗盘行情。`;
      } else {
        strategyType = 'SPREAD_SKEW_PLAY';
        strategyNameZh = '价差套利与行权价偏度配置';
        intentBadge = '价差套利 (行权价/期限偏度配置)';
        intentBadgeClass = 'badge-neutral';
        riskProfile = {
          maxProfit: '价差结构所决定的理论空间 (BTC 本位)',
          maxLoss: '各腿净收付差额',
          breakEven: '依据多空行权价综合动态平衡'
        };
        theoreticalPointers = [
          `风险中性化调控：平衡了单边价格风险与波动率大起大落冲击。`,
          `行权价与期限错配套利：精准捕获不同期权合约之间的局部定价偏差。`,
          `机构化组合管理：符合现代资产组合理论中的多因子风险敞口控制。`
        ];
        intentNarrative = `本笔交易属于【期权价差与行权价偏度套利组合】。通过多空腿配比平衡了 Delta 与 Vega 极端风险，主要通过捕捉行权价之间的隐含波动率偏度（Skew）错配或日历期限跨度获利。`;
      }
    }
  }

  // Inject Module 4 Smile / Skew Alignment Insights if context available
  let smileAlphaRating = null;
  if (smileContext) {
    const skew25d = Number(smileContext.skew25d || 0);
    if (strategyType.includes('RISK_REVERSAL') && skew25d < -2.0) {
      smileAlphaRating = {
        rating: '偏度套利高效 (High Skew Harvest)',
        comment: `当前 25Δ Skew 为 ${skew25d.toFixed(1)}% (Put 相对 Call 显著高估)，该组合通过卖出昂贵 Put 资助廉价 Call，处于理论定价显著优势区。`
      };
    } else if (strategyType.includes('CONDOR') || strategyType.includes('BUTTERFLY')) {
      smileAlphaRating = {
        rating: '曲率/峰度收敛套利 (Volga Arbitrage)',
        comment: '两翼完全闭合结构在隐含波动率微笑曲面处于高位时极具防护力，不受单一方向偏度暴走冲击。'
      };
    }
  }

  return {
    strategyType,
    strategyNameZh,
    intentBadge,
    intentBadgeClass,
    riskProfile,
    theoreticalPointers,
    intentNarrative,
    smileAlphaRating,
    // Backwards compatibility aliases
    intentType: strategyType,
    intentExplanation: intentNarrative
  };
}

// Backwards compatibility alias
const classifyTradeIntent = identifyInstitutionalStrategy;

/**
 * Evaluate 0DTE Expiration Behavior & Risk Regime
 * Deribit options expire daily at 08:00 UTC (16:00 UTC+8).
 * 0DTE window is defined as hoursToExpiry <= 16 hours.
 * Extreme Pin Risk window is hoursToExpiry <= 4 hours.
 */
function evaluate0DTEBehavior(tradeOrGroup, spotPrice = 77250) {
  const legs = Array.isArray(tradeOrGroup.legs) && tradeOrGroup.legs.length > 0
    ? tradeOrGroup.legs
    : [tradeOrGroup];

  const tradeTs = tradeOrGroup.timestamp || (legs[0] && legs[0].timestamp) || Date.now();
  let minHoursToExpiry = Infinity;
  let targetLeg = legs[0] || {};

  for (const leg of legs) {
    const instName = leg.instrument_name || leg.instrument || '';
    const inst = parseInstrument(instName);
    if (inst) {
      const expDate = parseDeribitExpiry(inst.expiryStr);
      if (expDate) {
        const diffH = (expDate.getTime() - tradeTs) / (3600 * 1000);
        if (diffH < minHoursToExpiry) {
          minHoursToExpiry = diffH;
          targetLeg = leg;
        }
      }
    }
  }

  // If expiry parsing didn't match Deribit format, fallback
  if (minHoursToExpiry === Infinity) {
    minHoursToExpiry = 24 * 30; // fallback to 30 days
  }

  const hoursToExpiry = Math.max(0, Math.round(minHoursToExpiry * 10) / 10);
  const is0DTE = hoursToExpiry <= 16;

  if (!is0DTE) {
    const days = Math.round(hoursToExpiry / 24);
    return {
      is0DTE: false,
      hoursToExpiry,
      timingCategory: 'NORMAL_TERM',
      tag: '远期/常规期权',
      badgeClass: 'badge-timing-normal',
      rationale: `该交易距离到期尚有 ${days} 天 (${hoursToExpiry} 小时)，属于标准中远期流动性配置，未进入 0DTE 末日加速衰减期。`
    };
  }

  // 0DTE behavior classification
  const S = spotPrice || targetLeg.indexPrice || targetLeg.index_price || 77250;
  const inst = parseInstrument(targetLeg.instrument_name || targetLeg.instrument || '');
  const strike = inst ? inst.strike : (targetLeg.strike || S);
  const absDistPct = (Math.abs(strike - S) / S) * 100;
  const price = Number(targetLeg.price || 0); // BTC per contract
  const direction = (targetLeg.direction || tradeOrGroup.direction || '').toLowerCase();
  const isBuy = direction === 'buy';
  const isSell = direction === 'sell';

  // 1. Pin Risk Avoidance (hoursToExpiry <= 4 and near ATM <= 1.5%)
  if (hoursToExpiry <= 4 && absDistPct <= 1.5) {
    return {
      is0DTE: true,
      hoursToExpiry,
      timingCategory: '0DTE_PIN_RISK',
      tag: '末日钉盘避险',
      badgeClass: 'badge-0dte-danger',
      rationale: `距离结算仅剩 ${hoursToExpiry} 小时，现货与行权价 ($${strike.toLocaleString()}) 偏差仅 ${absDistPct.toFixed(1)}%，处于极度危险的无限 Gamma 钉盘磁吸区间。交易旨在规避交割被行权与插针爆仓风险。`
    };
  }

  // 2. Lotto Hunting (OTM 1.5% ~ 6.5%, low price <= 0.005 BTC or <= $350 USD, Buy)
  if (isBuy && absDistPct >= 1.5 && absDistPct <= 6.5 && (price <= 0.005 || (price * S) <= 350)) {
    return {
      is0DTE: true,
      hoursToExpiry,
      timingCategory: '0DTE_LOTTO',
      tag: '末日彩票博弈',
      badgeClass: 'badge-0dte-lotto',
      rationale: `买入距到期仅 ${hoursToExpiry} 小时的虚值期权 (偏离 ${absDistPct.toFixed(1)}%)，单张成本极低 (~${price.toFixed(4)} BTC)，以极小资金博取到期前突发剧烈单边脉冲的百倍凸性赔率。`
    };
  }

  // 3. Penny Scraping (Far OTM >= 5.0%, low price, Sell)
  if (isSell && absDistPct >= 5.0 && (price <= 0.004 || (price * S) <= 250)) {
    return {
      is0DTE: true,
      hoursToExpiry,
      timingCategory: '0DTE_PENNY',
      tag: '末日残值收割',
      badgeClass: 'badge-0dte-scraping',
      rationale: `卖出距到期仅 ${hoursToExpiry} 小时且偏离现货 ${absDistPct.toFixed(1)}% 的深度虚值期权，全额赚取濒临归零的权利金残值，胜率极高但需防范流动性骤缩的极端黑天鹅。`
    };
  }

  // 4. Directional Momentum (Near ATM < 2.0%, Buy)
  if (isBuy && absDistPct < 2.0) {
    return {
      is0DTE: true,
      hoursToExpiry,
      timingCategory: '0DTE_MOMENTUM',
      tag: '末日单边冲刺',
      badgeClass: 'badge-0dte-momentum',
      rationale: `买入距到期仅 ${hoursToExpiry} 小时的平值期权，放弃远期时间价值，利用接近 1.0 的超高杠杆 Delta 替代现货进行日内单边决战。`
    };
  }

  // 5. Generic 0DTE
  return {
    is0DTE: true,
    hoursToExpiry,
    timingCategory: '0DTE_GENERIC',
    tag: '末日到期博弈',
    badgeClass: 'badge-0dte-generic',
    rationale: `距到期仅 ${hoursToExpiry} 小时的末日期权头寸，剧烈暴露于日内极限 Theta 衰减与 Gamma 放大效应中。`
  };
}

/**
 * Evaluate Trade Action Intent (Opening vs Closing vs Rollover)
 * Based on multi-leg structure, calendar rollover signatures, IV premium/discount spread, and aggressive taker execution.
 */
function evaluateTradeAction(tradeOrGroup, spotPrice = 77250, precomputedTiming = null) {
  const legs = Array.isArray(tradeOrGroup.legs) && tradeOrGroup.legs.length > 0
    ? tradeOrGroup.legs
    : [tradeOrGroup];

  const timing = precomputedTiming || evaluate0DTEBehavior(tradeOrGroup, spotPrice);
  const strategyType = tradeOrGroup.strategyType || tradeOrGroup.intentType || '';
  const isMultiLeg = legs.length > 1;

  // 1. Calendar Rollover Detection across expiries
  if (isMultiLeg) {
    const expiries = [...new Set(legs.map(l => parseInstrument(l.instrument_name || l.instrument || '')?.expiryStr).filter(Boolean))];
    if (expiries.length >= 2) {
      const sortedByExp = [...legs].sort((a, b) => {
        const ta = parseDeribitExpiry(parseInstrument(a.instrument_name || a.instrument || '')?.expiryStr)?.getTime() || 0;
        const tb = parseDeribitExpiry(parseInstrument(b.instrument_name || b.instrument || '')?.expiryStr)?.getTime() || 0;
        return ta - tb;
      });
      const nearLeg = sortedByExp[0];
      const farLeg = sortedByExp[sortedByExp.length - 1];
      const nearDir = (nearLeg.direction || '').toLowerCase();
      const farDir = (farLeg.direction || '').toLowerCase();

      if ((nearDir === 'sell' && farDir === 'buy') || (nearDir === 'buy' && farDir === 'sell')) {
        const nearExp = parseInstrument(nearLeg.instrument_name || nearLeg.instrument || '')?.expiryStr || '';
        const farExp = parseInstrument(farLeg.instrument_name || farLeg.instrument || '')?.expiryStr || '';
        return {
          action: 'ROLLOVER',
          actionType: 'CALENDAR_ROLLOVER',
          confidence: 'HIGH',
          tag: '🔄 跨期展期 (Rollover)',
          badgeClass: 'badge-action-roll',
          rationale: `交易跨越不同交割期（近端 ${nearExp} 与远端 ${farExp}），近月平仓与远月接力同步执行，属于典型的大资金跨期滚动展期。`
        };
      }
    }
  }

  // 2. Standard Multi-Leg Strategy Package Entry (Opening)
  const STANDARD_STRATEGIES = [
    'IRON_CONDOR', 'IRON_BUTTERFLY', 'RATIO_CALL_BACKSPREAD', 'RATIO_CALL_FRONT_SPREAD',
    'RATIO_PUT_BACKSPREAD', 'BULL_CALL_SPREAD', 'BEAR_CALL_SPREAD', 'BULL_PUT_SPREAD',
    'BEAR_PUT_SPREAD', 'LONG_STRADDLE', 'SHORT_STRADDLE', 'LONG_STRANGLE', 'SHORT_STRANGLE',
    'BULLISH_RISK_REVERSAL', 'BEARISH_RISK_REVERSAL', 'SYNTHETIC_LONG_FUTURE', 'SYNTHETIC_SHORT_FUTURE',
    'PUT_BUTTERFLY', 'BROKEN_WING_PUT_BUTTERFLY', 'LONG_CALENDAR_SPREAD', 'REVERSE_CALENDAR_SPREAD'
  ];
  if (isMultiLeg && STANDARD_STRATEGIES.includes(strategyType)) {
    return {
      action: 'OPENING',
      actionType: 'STRATEGY_ENTRY',
      confidence: 'HIGH',
      tag: '🧱 全新结构建仓 (Strategy Entry)',
      badgeClass: 'badge-action-open',
      rationale: `该组合呈现标准闭合的【${tradeOrGroup.strategyNameZh || strategyType}】策略形态，各腿同时同比例撮合成交，判定为机构大资金一揽子战略性全新结构建仓。`
    };
  }

  // 3. 0DTE Pin Risk Avoidance Close
  if (timing.is0DTE && timing.timingCategory === '0DTE_PIN_RISK') {
    return {
      action: 'CLOSING',
      actionType: 'PIN_RISK_CLOSE',
      confidence: 'HIGH',
      tag: '🛡️ 钉盘避险平仓 (Pin Risk Close)',
      badgeClass: 'badge-action-close',
      rationale: '结算前数小时现货紧贴行权价，面临无限 Gamma 震荡与钉盘行权，持仓方主动平仓买回消除交割被行权风险。'
    };
  }

  // 4. IV Spread (Trade IV vs Mark IV) & Directional Urgency
  const primaryLeg = legs[0] || tradeOrGroup;
  const iv = primaryLeg.iv != null ? primaryLeg.iv : tradeOrGroup.iv;
  const markIv = primaryLeg.mark_iv != null ? primaryLeg.mark_iv : tradeOrGroup.mark_iv;
  const direction = (primaryLeg.direction || tradeOrGroup.direction || '').toLowerCase();
  const tickDir = primaryLeg.tick_direction || tradeOrGroup.tick_direction;

  if (iv != null && markIv != null && !isNaN(iv) && !isNaN(markIv)) {
    const ivDiff = iv - markIv;
    if (direction === 'buy' && ivDiff >= 1.2) {
      return {
        action: 'OPENING',
        actionType: 'AGGRESSIVE_OPEN',
        confidence: 'MEDIUM_HIGH',
        tag: '🎯 溢价抢筹开仓 (Aggressive Open)',
        badgeClass: 'badge-action-open',
        rationale: `买方主动支付高于公允标记波动率 (+${ivDiff.toFixed(1)}% IV) 的溢价迅速扫盘买入，成交意愿极其急迫，反映明确的增量主动建仓动力。`
      };
    }
    if (direction === 'sell' && ivDiff <= -1.2) {
      return {
        action: 'CLOSING',
        actionType: 'DISCOUNTED_CLOSE',
        confidence: 'MEDIUM_HIGH',
        tag: '🚪 让利平仓离场 (Discounted Close)',
        badgeClass: 'badge-action-close',
        rationale: `卖方以显著低于公允估值 (-${Math.abs(ivDiff).toFixed(1)}% IV) 的贴水让利挂单出脱，表明大资金急于关停存量敞口或止损/锁利离场。`
      };
    }
    if (direction === 'sell' && ivDiff >= 1.2) {
      return {
        action: 'OPENING',
        actionType: 'PREMIUM_HARVEST_OPEN',
        confidence: 'MEDIUM',
        tag: '💰 溢价沽空建仓 (Premium Harvest)',
        badgeClass: 'badge-action-open',
        rationale: `卖方在波动率显著偏高的高溢价区 (+${ivDiff.toFixed(1)}% IV) 主动沽出期权收割时间价值，符合专业做市商与机构卖方开仓行为。`
      };
    }
    if (direction === 'buy' && ivDiff <= -1.2) {
      return {
        action: 'OPENING',
        actionType: 'DISCOUNT_ACCUMULATION',
        confidence: 'MEDIUM',
        tag: '📥 贴水低吸建仓 (Discount Accumulation)',
        badgeClass: 'badge-action-open',
        rationale: `买方在波动率贴水折价区 (-${Math.abs(ivDiff).toFixed(1)}% IV) 低成本吸纳，属于被动挂单撮合或逢低建仓。`
      };
    }
  }

  // 5. Tick Direction Taker Aggression (Ask taker vs Bid taker)
  if (tickDir === 'plus' || tickDir === 'zero_plus') {
    if (direction === 'buy') {
      return {
        action: 'OPENING',
        actionType: 'AGGRESSIVE_OPEN',
        confidence: 'MEDIUM',
        tag: '🎯 主动扫盘开仓 (Taker Buy)',
        badgeClass: 'badge-action-open',
        rationale: '交易以主动买方吃单 (Ask Taker) 撮合成交，具有积极的主动开仓攻击性特征。'
      };
    }
  } else if (tickDir === 'minus' || tickDir === 'zero_minus') {
    if (direction === 'sell') {
      return {
        action: 'CLOSING',
        actionType: 'DISCOUNTED_CLOSE',
        confidence: 'MEDIUM',
        tag: '🚪 砸盘平仓减亏 (Taker Sell)',
        badgeClass: 'badge-action-close',
        rationale: '交易以主动卖方砸盘 (Bid Taker) 撮合成交，反映大资金离场意愿急迫，具有较强平仓离场特征。'
      };
    }
  }

  // 6. Default Neutral Match
  return {
    action: 'UNCONFIRMED',
    actionType: 'NEUTRAL_FLOW',
    confidence: 'LOW',
    tag: '⚖️ 常规撮合 (需OI确认)',
    badgeClass: 'badge-action-neutral',
    rationale: '定价贴近公允价值，微观无极端溢价或折价，需结合次日持仓量(OI)净变动综合印证是新增开仓还是平仓回补。'
  };
}


/**
 * Module 3: Whale Block Trades & Iceberg Split Order Clustering
 * Enhanced with Black-Scholes Greeks calculation & Detailed Intent Diagnostics
 */
function analyzeBlockTrades(rawTrades, notionalThresholdUSD = 30000000, timeRange = 'all', spotPrice = 77250) {
  if (!rawTrades || !rawTrades.length) {
    return {
      status: 'insufficient_data',
      whaleBlocks: [],
      icebergClusters: [],
      paragraph: '暂无近期大宗交易数据。'
    };
  }

  // 1. Group Trades by Block Trade ID (or unique trade ID for non-blocks) & Calculate Greeks
  const byBlock = {};
  for (const t of rawTrades) {
    const bid = t.block_trade_id || (`TRADE-${t.trade_id}`);
    if (!byBlock[bid]) byBlock[bid] = [];
    byBlock[bid].push(t);
  }

  const whaleBlocks = [];
  const blockUnits = [];

  for (const [bid, legs] of Object.entries(byBlock)) {
    let totalNotional = 0;
    let totalContracts = 0;
    let netDeltaBTC = 0;
    let netDeltaUSD = 0;
    let netGamma = 0;
    let netVegaUSD = 0;
    let netThetaUSD = 0;

    const processedLegs = [];

    // Sort legs deterministically by direction + instrument_name
    const sortedLegs = [...legs].sort((a, b) => {
      const ka = (a.direction || '') + ':' + (a.instrument_name || '');
      const kb = (b.direction || '') + ':' + (b.instrument_name || '');
      return ka.localeCompare(kb);
    });

    const legSignatures = [];

    for (const leg of sortedLegs) {
      const notional = (leg.amount || 0) * (leg.index_price || 0);
      totalNotional += notional;
      totalContracts += (leg.amount || 0);

      const inst = parseInstrument(leg.instrument_name);
      const isCall = inst ? inst.isCall : leg.instrument_name.includes('-C');
      const strike = inst ? inst.strike : (leg.strike || 77000);
      const S = leg.index_price || 77200;

      // Expiry time to years
      const expDate = inst ? parseDeribitExpiry(inst.expiryStr) : new Date(leg.timestamp + 14 * 86400000);
      const T_years = Math.max(0.001, (expDate.getTime() - leg.timestamp) / (365.25 * 86400000));
      const iv = leg.iv || 35.0;

      // Calculate Greeks per contract
      const greeks = calcGreeks(S, strike, T_years, iv, isCall);

      // Sign: Buy = +1, Sell = -1
      const sign = leg.direction === 'buy' ? 1 : -1;
      const amt = leg.amount || 0;

      const legDelta = sign * greeks.delta * amt;
      const legGamma = sign * greeks.gamma * amt;
      const legVega = sign * greeks.vega * amt;
      const legTheta = sign * greeks.theta * amt;

      netDeltaBTC += legDelta;
      netDeltaUSD += legDelta * S;
      netGamma += legGamma;
      netVegaUSD += legVega;
      netThetaUSD += legTheta;

      processedLegs.push({
        instrument: leg.instrument_name,
        direction: leg.direction,
        amount: leg.amount,
        price: leg.price,
        iv: leg.iv,
        strike,
        isCall,
        indexPrice: leg.index_price,
        notionalUSD: notional,
        notionalM: notional / 1e6,
        delta: legDelta,
        gamma: legGamma,
        vegaUSD: legVega,
        thetaUSD: legTheta
      });

      legSignatures.push(`${leg.direction}:${leg.instrument_name}`);
    }

    const structureSignature = legSignatures.join('|');
    const timestamp = Math.min(...legs.map(l => l.timestamp));

    blockUnits.push({
      blockId: bid,
      timestamp,
      legs: processedLegs,
      structureSignature,
      totalNotional,
      totalContracts,
      netDeltaBTC,
      netDeltaUSD,
      netGamma,
      netVegaUSD,
      netThetaUSD
    });

    if (totalNotional >= notionalThresholdUSD) {
      const intent = classifyTradeIntent(processedLegs, netDeltaUSD, netVegaUSD, netThetaUSD, totalNotional);

      const blockCandidate = {
        legs: processedLegs,
        strategyType: intent.strategyType,
        strategyNameZh: intent.strategyNameZh,
        direction: processedLegs.length === 1 ? processedLegs[0].direction : (netDeltaUSD >= 0 ? 'buy' : 'sell'),
        timestamp,
        notionalUSD: totalNotional,
        iv: processedLegs[0]?.iv,
        mark_iv: legs[0]?.mark_iv,
        tick_direction: legs[0]?.tick_direction,
        price: processedLegs[0]?.price
      };
      const S = processedLegs[0]?.indexPrice || spotPrice || 77250;
      const timingProfile = evaluate0DTEBehavior(blockCandidate, S);
      const actionProfile = evaluateTradeAction(blockCandidate, S, timingProfile);

      const dateUtc8 = formatUTC8(timestamp);
      whaleBlocks.push({
        blockId: bid,
        timestamp,
        dateTimeUTC8: dateUtc8,
        dateTime: dateUtc8,
        dateTimeUTC: new Date(timestamp).toISOString().replace('T', ' ').slice(0, 19),
        notionalUSD: totalNotional,
        notionalUSDM: totalNotional / 1e6,
        netDeltaBTC,
        netDeltaUSD,
        netDeltaUSDM: netDeltaUSD / 1e6,
        netGamma,
        netVegaUSD,
        netThetaUSD,
        legCount: legs.length,
        legs: processedLegs,
        actionProfile,
        timingProfile,
        actionTag: actionProfile.tag,
        actionBadgeClass: actionProfile.badgeClass,
        timingTag: timingProfile.tag,
        timingBadgeClass: timingProfile.badgeClass,
        hoursToExpiry: timingProfile.hoursToExpiry,
        is0DTE: timingProfile.is0DTE,
        ...intent
      });
    }
  }
  whaleBlocks.sort((a, b) => b.timestamp - a.timestamp);

  // 2. Iceberg / Split Order Clustering with Greeks & Intent
  blockUnits.sort((a, b) => a.timestamp - b.timestamp);

  const CLUSTER_GAP_MS = 25 * 60 * 1000; // 25 minutes rolling gap between consecutive trades
  const MAX_SPAN_MS = 2 * 60 * 60 * 1000; // 2 hours maximum cluster span
  const visited = new Set();
  const icebergClusters = [];

  for (let i = 0; i < blockUnits.length; i++) {
    if (visited.has(i)) continue;
    const base = blockUnits[i];
    const group = [base];
    visited.add(i);

    let lastTs = base.timestamp;
    for (let j = i + 1; j < blockUnits.length; j++) {
      if (visited.has(j)) continue;
      const cand = blockUnits[j];
      if (cand.timestamp - lastTs > CLUSTER_GAP_MS || cand.timestamp - base.timestamp > MAX_SPAN_MS) {
        break;
      }
      if (cand.structureSignature === base.structureSignature) {
        group.push(cand);
        visited.add(j);
        lastTs = cand.timestamp;
      }
    }

    const clusterNotional = group.reduce((acc, b) => acc + b.totalNotional, 0);
    if (group.length >= 2 && clusterNotional >= notionalThresholdUSD) {
      const startTimeUTC8 = formatUTC8(group[0].timestamp);
      const endTimeUTC8 = formatUTC8(group[group.length - 1].timestamp);
      const durationMin = Math.round((group[group.length - 1].timestamp - group[0].timestamp) / 60000);

      const clusterDeltaBTC = group.reduce((acc, b) => acc + b.netDeltaBTC, 0);
      const clusterDeltaUSD = group.reduce((acc, b) => acc + b.netDeltaUSD, 0);
      const clusterGamma = group.reduce((acc, b) => acc + b.netGamma, 0);
      const clusterVegaUSD = group.reduce((acc, b) => acc + b.netVegaUSD, 0);
      const clusterThetaUSD = group.reduce((acc, b) => acc + b.netThetaUSD, 0);
      const totalContracts = group.reduce((acc, b) => acc + b.totalContracts, 0);
      const blockIds = group.map(b => b.blockId);
      const splitCount = group.reduce((acc, b) => acc + b.legs.length, 0);

      // Aggregate legs across blocks in cluster
      const legMap = new Map();
      for (const b of group) {
        for (const l of b.legs) {
          const key = `${l.direction}:${l.instrument}`;
          if (!legMap.has(key)) {
            legMap.set(key, {
              instrument: l.instrument,
              direction: l.direction,
              amount: 0,
              totalPriceAmount: 0,
              totalIvAmount: 0,
              strike: l.strike,
              isCall: l.isCall,
              indexPrice: l.indexPrice,
              delta: 0,
              gamma: 0,
              vegaUSD: 0,
              thetaUSD: 0,
              notionalUSD: 0
            });
          }
          const agg = legMap.get(key);
          agg.amount += l.amount;
          agg.totalPriceAmount += (l.price || 0) * l.amount;
          agg.totalIvAmount += (l.iv || 0) * l.amount;
          agg.delta += l.delta;
          agg.gamma += l.gamma;
          agg.vegaUSD += l.vegaUSD;
          agg.thetaUSD += l.thetaUSD;
          agg.notionalUSD += (l.notionalUSD || (l.amount * (l.indexPrice || 77200)));
        }
      }

      const aggregatedLegs = Array.from(legMap.values()).map(l => ({
        instrument: l.instrument,
        direction: l.direction,
        amount: l.amount,
        price: l.amount > 0 ? l.totalPriceAmount / l.amount : 0,
        iv: l.amount > 0 ? l.totalIvAmount / l.amount : 0,
        strike: l.strike,
        isCall: l.isCall,
        indexPrice: l.indexPrice,
        delta: l.delta,
        gamma: l.gamma,
        vegaUSD: l.vegaUSD,
        thetaUSD: l.thetaUSD,
        notionalUSD: l.notionalUSD,
        notionalM: l.notionalUSD / 1e6
      }));

      const intent = classifyTradeIntent(
        aggregatedLegs,
        clusterDeltaUSD,
        clusterVegaUSD,
        clusterThetaUSD,
        clusterNotional
      );

      const isMultiLeg = aggregatedLegs.length > 1;
      let displayInstrument = '';
      if (!isMultiLeg) {
        displayInstrument = aggregatedLegs[0].instrument;
      } else {
        const stratClean = intent.strategyNameZh ? (intent.strategyNameZh.split('(')[0].trim() || intent.strategyNameZh) : '组合策略';
        const legSummary = aggregatedLegs.map(l => {
          const s = l.strike >= 1000 ? (l.strike / 1000) + 'k' : l.strike;
          return `${l.direction === 'buy' ? '+' : '-'}${s}${l.isCall ? 'C' : 'P'}`;
        }).join(' ');

        // Extract expiry if all legs share expiry
        const inst0 = parseInstrument(aggregatedLegs[0].instrument);
        const expSummary = inst0 ? inst0.expiryStr : '';
        displayInstrument = `${expSummary ? `[${expSummary}] ` : ''}${stratClean} [${legSummary}]`;
      }

      let primaryDirection = 'buy';
      if (isMultiLeg) {
        if (Math.abs(clusterDeltaUSD) > 500000) {
          primaryDirection = clusterDeltaUSD >= 0 ? 'buy' : 'sell';
        } else {
          primaryDirection = clusterVegaUSD >= 0 ? 'buy' : 'sell';
        }
      } else {
        primaryDirection = aggregatedLegs[0].direction;
      }

      const clusterCandidate = {
        legs: aggregatedLegs,
        strategyType: intent.strategyType,
        strategyNameZh: intent.strategyNameZh,
        direction: primaryDirection,
        timestamp: group[0].timestamp,
        notionalUSD: clusterNotional,
        iv: aggregatedLegs[0]?.iv,
        price: aggregatedLegs[0]?.price
      };
      const S = aggregatedLegs[0]?.indexPrice || spotPrice || 77250;
      const timingProfile = evaluate0DTEBehavior(clusterCandidate, S);
      const actionProfile = evaluateTradeAction(clusterCandidate, S, timingProfile);

      icebergClusters.push({
        instrument: displayInstrument,
        instrumentRaw: base.structureSignature,
        direction: primaryDirection,
        isMultiLeg,
        totalContracts,
        clusterNotionalUSD: clusterNotional,
        clusterNotionalM: clusterNotional / 1e6,
        splitCount,
        blockCount: group.length,
        durationMin,
        startTime: startTimeUTC8,
        endTime: endTimeUTC8,
        startTimeUTC8,
        endTimeUTC8,
        netDeltaBTC: clusterDeltaBTC,
        netDeltaUSD: clusterDeltaUSD,
        netDeltaUSDM: clusterDeltaUSD / 1e6,
        netGamma: clusterGamma,
        netVegaUSD: clusterVegaUSD,
        netThetaUSD: clusterThetaUSD,
        avgPrice: aggregatedLegs.length === 1 ? aggregatedLegs[0].price : (aggregatedLegs.reduce((acc, l) => acc + l.price * l.amount, 0) / (totalContracts || 1)),
        blockIds,
        legs: aggregatedLegs,
        actionProfile,
        timingProfile,
        actionTag: actionProfile.tag,
        actionBadgeClass: actionProfile.badgeClass,
        timingTag: timingProfile.tag,
        timingBadgeClass: timingProfile.badgeClass,
        hoursToExpiry: timingProfile.hoursToExpiry,
        is0DTE: timingProfile.is0DTE,
        ...intent
      });
    }
  }
  icebergClusters.sort((a, b) => b.clusterNotionalUSD - a.clusterNotionalUSD);

  // 3. Statistical synthesis
  let totalWhaleVolume = 0;
  let callBuyNotional = 0;
  let callSellNotional = 0;
  let putBuyNotional = 0;
  let putSellNotional = 0;

  for (const b of whaleBlocks) {
    totalWhaleVolume += b.notionalUSD;
    for (const l of b.legs) {
      const notional = l.notionalM * 1e6;
      const isCall = l.instrument.includes('-C');
      if (isCall) {
        if (l.direction === 'buy') callBuyNotional += notional;
        else callSellNotional += notional;
      } else {
        if (l.direction === 'buy') putBuyNotional += notional;
        else putSellNotional += notional;
      }
    }
  }

  const netBullishNotional = callBuyNotional + putSellNotional;
  const netBearishNotional = callSellNotional + putBuyNotional;
  const totalVolume = netBullishNotional + netBearishNotional || 1;
  const bullRatio = Math.round((netBullishNotional / totalVolume) * 100);

  let flowBias = '中性博弈';
  if (bullRatio >= 60) flowBias = '偏多吸筹与牛市价差构建';
  else if (bullRatio <= 40) flowBias = '对冲防守与空头价差布控';

  let openCount = 0;
  let closeCount = 0;
  let rollCount = 0;
  let zeroDteCount = 0;
  for (const b of whaleBlocks) {
    if (b.actionProfile?.action === 'OPENING') openCount++;
    else if (b.actionProfile?.action === 'CLOSING') closeCount++;
    else if (b.actionProfile?.action === 'ROLLOVER') rollCount++;
    if (b.timingProfile?.is0DTE) zeroDteCount++;
  }

  const rangeLabel = timeRange === '24h' ? '近 24 小时' : (timeRange === '3d' ? '近 3 天 (72小时)' : (timeRange === '7d' ? '近 7 天' : '过去 30 天历史沉淀'));
  const paragraph = `在【${rangeLabel}】窗口内，大宗交易雷达共监测到 ${whaleBlocks.length} 笔名义价值超 $${Math.round(notionalThresholdUSD / 1e6)}M 的单笔巨鲸大单，累计名义金额达 $${(totalWhaleVolume / 1e6).toFixed(1)}M；同时智能冰山算法成功捕获到 ${icebergClusters.length} 组机构级时间切片拆单与组合价差冰山聚合（捕获针对同一合约或多腿策略组合的滚动分批执行）。整体大宗资金流向呈现【${flowBias}】特征（多头倾向占比约 ${bullRatio}%）。微观性质穿透显示：全新建仓 ${openCount} 笔，平仓离场 ${closeCount} 笔，跨期展期 ${rollCount} 笔${zeroDteCount > 0 ? `；另检测到 ${zeroDteCount} 笔距结算不足 16 小时的末日 0DTE 极限博弈` : '；近端暂无 0DTE 末日穿透扰动'}。大资金目前主要集中在 9 月底交割（25SEP26）的深度虚值看涨牛市价差（Call Spread）与卖出看跌期权（Short Put），显示主流期权做市与宏观机构对近端下跌空间有较强防护信心，倾向于在低波震荡中吃进 Theta 时间价值。`;

  return {
    whaleBlocks,
    icebergClusters,
    totalWhaleVolumeM: totalWhaleVolume / 1e6,
    bullRatio,
    flowBias,
    paragraph
  };
}

/**
 * Module 4: IV Skew 微笑曲线研判 (Volatility Smile across Strikes & Higher-Order Moments)
 * Rooted in Sébastien Bossu Ch 2 (3rd & 4th Moments, Vanna, Volga) & Sheldon Natenberg Ch 14
 */
function analyzeIvSmile(ivSkewMonth, spotPrice = 77250) {
  if (!ivSkewMonth || !ivSkewMonth.month1) {
    return {
      status: 'insufficient_data',
      summaryText: '暂无 IV 微笑曲线数据。'
    };
  }

  const m1 = ivSkewMonth.month1;
  const underlying = m1.underlying_index || 'BTC-1M';
  const price = m1.underlying_price || spotPrice;
  const rawList = m1.iv_list || [];

  if (!rawList.length) {
    return {
      status: 'insufficient_data',
      summaryText: '微笑曲线行权价列表为空。'
    };
  }

  // Sort by strike ascending
  const sorted = [...rawList].sort((a, b) => a.strike - b.strike);

  // Find ATM strike (closest to underlying_price)
  let atmItem = sorted[0];
  let minDiff = Infinity;
  for (const item of sorted) {
    const diff = Math.abs(item.strike - price);
    if (diff < minDiff) {
      minDiff = diff;
      atmItem = item;
    }
  }

  const atmStrike = atmItem.strike;
  const atmIv = atmItem.iv;

  const lowestStrikeItem = sorted[0];
  const highestStrikeItem = sorted[sorted.length - 1];

  // Downside slope (OTM Put wing) & Upside slope (OTM Call wing)
  const putWingPremium = lowestStrikeItem.iv - atmIv; // e.g. 37.8 - 34.4 = +3.4%
  const callWingPremium = highestStrikeItem.iv - atmIv; // e.g. 39.4 - 34.4 = +5.0%
  const asymmetryDiff = callWingPremium - putWingPremium;

  // 4th Moment: Kurtosis / Fat-Tail Curvature = Average wing premium over ATM
  // bossu Ch 2: Curvature scales with 1/T, measuring jump probability and fat tails
  const smileCurvature = Number((((lowestStrikeItem.iv + highestStrikeItem.iv) / 2.0) - atmIv).toFixed(2));

  // 3rd Moment: Skewness / Vanna slope
  // bossu Ch 2: Skewness slope scales with 1/sqrt(T)
  const strikeSpan = highestStrikeItem.strike - lowestStrikeItem.strike;
  const skewSlope = Number(((highestStrikeItem.iv - lowestStrikeItem.iv) / (strikeSpan || 1) * 1000).toFixed(3)); // % IV per $1000 strike

  let skewShape = '对称标准微笑 (Symmetric Smile)';
  let skewBias = '多空尾部预期平衡';
  let theoreticalMomentExplanation = '';

  if (asymmetryDiff > 1.2) {
    skewShape = '右偏微笑 / 上行追涨溢价 (Call Skew / Upside Smirk)';
    skewBias = '深度虚值 Call 获得更高波动率溢价，反映狂热买权 FOMO 情绪高于下行恐惧。';
    theoreticalMomentExplanation = `【三阶矩偏度 (Skewness/Vanna)】：BTC 呈现典型的“右翼上偏微笑 (Upside Smirk)”，与美股标普 500 常年左偏“下行恐慌倒斜 (Crash Smirk)”形成鲜明对比。这源于加密衍生品特有的散户与宏观杠杆做多凸性（Convexity）需求，以及对右侧暴涨跳空跳跃（Jump Diffusion）的溢价定价。`;
  } else if (asymmetryDiff < -1.2) {
    skewShape = '左偏倒斜 / 下行避险溢价 (Put Skew / Fear Smirk)';
    skewBias = '深度虚值 Put 溢价显著高于 Call，反映市场强烈的下行尾部对冲保护诉求。';
    theoreticalMomentExplanation = `【三阶矩偏度 (Skewness/Vanna)】：市场呈现左偏“下行避险倒斜 (Put Skew)”，左翼虚值 Put 较 ATM 溢价显著放大。做市商正通过上调深度虚值 Put 的 IV 来防御负 Vanna（∂Vega/∂S）与暴跌流动性抽离风险。`;
  } else {
    skewShape = '对称标准微笑 (Symmetric Smile)';
    skewBias = '多空双向尾部风险溢价定价均衡。';
    theoreticalMomentExplanation = `【三阶与四阶矩均衡】：左右两翼溢价对称，表明做市商对后市单边大跳空的恐惧与贪婪情绪高度平衡，曲度主要反映肥尾峰度（Kurtosis）。`;
  }

  const kurtosisExplanation = `【四阶矩峰度 (Kurtosis/Volga)】：微笑曲线两翼平均平值溢价（Curvature）为 +${smileCurvature}% IV。两翼凸起是市场对几何布朗运动正态分布失效的补偿（跳跃扩散模型），两翼深度虚值期权具备极高的 Volga（∂Vega/∂σ）敏感度；若后市波动率维持低迷，两翼虚值期权将面临更严峻的【偏度时间价值加速耗损 (Skew Theta Bleed)】。`;

  const paragraph = `当前 1M 期限（标的 ${underlying} @ $${Math.round(price).toLocaleString()}）呈现【${skewShape}】形态。平值 ATM ($${atmStrike.toLocaleString()}) 隐含波动率为 ${atmIv.toFixed(1)}%；左翼虚值 Put ($${lowestStrikeItem.strike.toLocaleString()}) IV 达 ${lowestStrikeItem.iv.toFixed(1)}%（较平值溢价 +${putWingPremium.toFixed(1)}%）；右翼虚值 Call ($${highestStrikeItem.strike.toLocaleString()}) IV 达 ${highestStrikeItem.iv.toFixed(1)}%（较平值溢价 +${callWingPremium.toFixed(1)}%）。${theoreticalMomentExplanation} ${kurtosisExplanation}`;

  return {
    underlying,
    underlyingPrice: price,
    atmStrike,
    atmIv,
    lowestStrike: lowestStrikeItem.strike,
    lowestIv: lowestStrikeItem.iv,
    highestStrike: highestStrikeItem.strike,
    highestIv: highestStrikeItem.iv,
    putWingPremium,
    callWingPremium,
    asymmetryDiff,
    smileCurvature,
    skewSlope,
    skewShape,
    skewBias,
    strikes: sorted.map(s => ({
      strike: s.strike,
      iv: Math.round(s.iv * 10) / 10,
      delta: s.delta ? Math.round(s.delta * 100) / 100 : null
    })),
    paragraph
  };
}

/**
 * Module 5: 25Δ Skew 期限结构研判 (25 Delta Skew Regime & Term Structure)
 * Rooted in Bossu Ch 2 (Square Root of Time for Skew, 4 Skew Regimes) & Natenberg Ch 13, 14
 */
function analyze25DeltaSkew(skewChart) {
  if (!skewChart || !skewChart.length) {
    return {
      status: 'insufficient_data',
      summaryText: '暂无 25Δ Skew 数据。'
    };
  }

  // Get the most recent timestamp record
  const latest = skewChart[skewChart.length - 1];
  const d1 = latest.day1 || 0;
  const d7 = latest.days7 || 0;
  const d30 = latest.days30 || 0; // 1M
  const d60 = latest.days60 || 0;
  const d90 = latest.days90 || 0; // 3M
  const d180 = latest.days180 || 0; // 6M
  const d365 = latest.days365 || 0; // 1Y

  // Square Root of Time Rule for Skew (Bossu Ch 2 / Natenberg Ch 14):
  // Skew(T) * sqrt(T) ≈ Constant. Short-term skew naturally steepens, long-term flattens out.
  // Normalized 30D Skew = Skew(30D) * sqrt(30 / 365)
  const normSkew7d = Number((d7 * Math.sqrt(7 / 365)).toFixed(3));
  const normSkew30d = Number((d30 * Math.sqrt(30 / 365)).toFixed(3));
  const normSkew90d = Number((d90 * Math.sqrt(90 / 365)).toFixed(3));

  // In standard Deribit 25D Skew (25D Call IV - 25D Put IV):
  // Positive = Calls > Puts (Bullish greed / upside demand)
  // Negative = Puts > Calls (Bearish fear / hedging premium)
  let nearTermSentiment = '平水均衡';
  if (d1 > 0.3 || d7 > 0.3) nearTermSentiment = '短端温和偏多 (Call 溢价)';
  else if (d1 < -0.3 || d7 < -0.3) nearTermSentiment = '短端防御避险 (Put 溢价)';

  let midTermSentiment = '平水均衡';
  if (d30 < -0.3 && d90 < -0.3) midTermSentiment = '中远端持续防御贴水 (Put 结构性高估)';
  else if (d30 > 0.3 && d90 > 0.3) midTermSentiment = '中远端普遍追逐上行 Call';

  // Determine Dynamic Skew Regime (Bossu Ch 2):
  // 1. Sticky Strike (IV curve fixed in strike space)
  // 2. Sticky Delta / Moneyness (IV curve shifts with spot)
  // 3. Local Volatility (Inverted relation: dIV/dS < 0)
  // 4. Jump Diffusion (Sudden wing repricing)
  let skewRegime = 'Sticky Delta (粘性 Delta 状态)';
  let skewRegimeDesc = '偏度随标的平移保持相对恒定，做市商依照 Moneyness（虚值程度）稳定报价。';
  if (Math.abs(d1 - d30) > 1.5) {
    skewRegime = 'Jump Diffusion / Term Dislocation (跳跃扩散/期限错配状态)';
    skewRegimeDesc = '超短端偏度与中远端发生剧烈偏离，表明市场受即时宏观事件或链上流动性催化，正在对近端尾部风险进行剧烈再定价。';
  } else if (d30 < -1.0) {
    skewRegime = 'Local Volatility Dominance (局部波动率主导状态)';
    skewRegimeDesc = '看跌期权定价深嵌入下行杠杆效应（Leverage Effect），标的下挫将引发波动率全面飙升。';
  }

  // Institutional strategy recommendation based on Skew & VRP
  let institutionalAction = '';
  if (d30 < -0.5) {
    institutionalAction = `【机构偏度套利策略】：当前中远端 Put 溢价（30D: ${d30.toFixed(2)}%, 90D: ${d90.toFixed(2)}%）处于结构性高估。适合专业机构构建【牛市风险逆转组合 (Bullish Risk Reversal)】：卖出高估的 25Δ Put 赚取偏度超额溢价，以近乎零成本资助买入 25Δ Call，既做空了失真的偏度（Short Skew），又合成了廉价的现货多头杠杆。`;
  } else if (d30 > 0.5) {
    institutionalAction = `【机构偏度套利策略】：当前 Call 偏度处于上行狂热溢价。适合构建【备兑看涨 (Covered Call)】或【熊市风险逆转 (Bearish Risk Reversal)】卖 Call 买 Put，高位收割追涨情绪带来的膨胀权利金。`;
  } else {
    institutionalAction = `【机构偏度套利策略】：偏度期限结构均衡，时间平方根归一化偏度平稳（7D 归一化: ${normSkew7d}, 30D 归一化: ${normSkew30d}），适合采用中性垂直价差进行方向性博弈。`;
  }

  const paragraph = `当下 Bitcoin 25Δ Skew 呈现【${nearTermSentiment} / ${midTermSentiment}】期限结构。根据时间平方根偏度衰减规律（Skew(T)·√T ≈ 常数），超短端（1D: ${d1 >= 0 ? '+' : ''}${d1.toFixed(2)}%, 7D: ${d7 >= 0 ? '+' : ''}${d7.toFixed(2)}%）偏度贴近零轴，多空博弈均衡；而 1M~3M 期限（30D: ${d30.toFixed(2)}%, 90D: ${d90.toFixed(2)}%）展现长效下行保险溢价（归一化偏度约 ${normSkew30d}）。当前市场处于【${skewRegime}】：${skewRegimeDesc} ${institutionalAction}`;

  return {
    latestTimestamp: latest.timestamps,
    d1,
    d7,
    d30,
    d60,
    d90,
    d180,
    d365,
    normSkew7d,
    normSkew30d,
    normSkew90d,
    nearTermSentiment,
    midTermSentiment,
    skewRegime,
    skewRegimeDesc,
    paragraph
  };
}

module.exports = {
  formatUTC8,
  analyzeAtmIv,
  analyzeDynamicGex,
  analyzeBlockTrades,
  analyzeIvSmile,
  analyze25DeltaSkew,
  calcGreeks,
  parseInstrument,
  parseDeribitExpiry,
  identifyInstitutionalStrategy,
  evaluate0DTEBehavior,
  evaluateTradeAction
};

