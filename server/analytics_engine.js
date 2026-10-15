/**
 * Analytics Engine for Greeks.live DataLab and Block Trades
 * Enhanced with Black-Scholes Greeks, Trade Intent Classification, IV Smile & 25D Skew
 */

const { profileFromItems } = require('./option_oi_history');

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
 * 加密资产 24/7 交易：年化按 365 个日历日，日波动 = 年化 / √365 ≈ 年化 / 19.1。
 * Natenberg 的 σ/16 对应股票一年约 256 个交易日，直接搬到 BTC 会把日振幅高估约 19%。
 */
const CRYPTO_DAYS_PER_YEAR = 365;
const FRONT_EVENT_MAX_DTE = 7;          // 只在一周内到期的合约里找事件溢价
const FRONT_EVENT_MIN_DTE = 1;          // 不足 1 天的合约 IV 受离散报价噪声主导，跳空拆分公式也要求 T ≥ 1 天
const FRONT_EVENT_MIN_PREMIUM = 5;      // 近端 IV 高出扩散基准 ≥5 个波动率点才视为事件定价
const VRP_CHEAP_MAX = 1;                // IV − HV30 ≤ +1 点：期权相对已实现波动不贵
const VRP_RICH_MIN = 3;                 // IV − HV30 ≥ +3 点：期权相对已实现波动明显溢价

/** 经验分位 (≤ 当前值的样本占比)，0~100 */
function percentileOf(series, value) {
  if (!Array.isArray(series) || !series.length || !Number.isFinite(value)) return null;
  return series.filter(v => v <= value).length / series.length * 100;
}

/**
 * 按总方差 (σ²·T) 对期限线性插值 (Bennett 加性方差法则)，而不是直接对 IV 线性插值。
 * points: 按 dte 升序的 [{ dte, iv }]
 */
function interpolateTotalVariance(points, targetDte) {
  if (!points.length) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (targetDte <= first.dte) return first.iv;
  if (targetDte >= last.dte) return last.iv;
  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];
    if (targetDte < p1.dte || targetDte > p2.dte) continue;
    if (p2.dte === p1.dte) return p1.iv;
    const weight = (targetDte - p1.dte) / (p2.dte - p1.dte);
    const w1 = p1.iv * p1.iv * p1.dte;
    const w2 = p2.iv * p2.iv * p2.dte;
    const w = w1 + weight * (w2 - w1);
    const iv = w > 0 ? Math.sqrt(w / targetDte) : p1.iv + weight * (p2.iv - p1.iv);
    return Number(iv.toFixed(2));
  }
  return last.iv;
}

/** 两个期限之间的远期波动率 √((σ2²T2 − σ1²T1)/(T2 − T1))；总方差倒挂时返回 null */
function forwardVol(p1, p2) {
  if (!p1 || !p2 || p2.dte <= p1.dte) return null;
  const fwdVar = (p2.iv * p2.iv * p2.dte - p1.iv * p1.iv * p1.dte) / (p2.dte - p1.dte);
  return fwdVar > 0 ? Math.sqrt(fwdVar) : null;
}

/**
 * 近端事件溢价 (Bennett Ch5 跳空波动率提取)：σ_T²·T = σ_J² + σ_D²·(T − 1)，T 以天计。
 * 扩散基准 σ_D 取一周以后前两个期限之间的远期波动率 (事件之后的平滑扩散)，取不到时用 1M ATM。
 * 事件日期望绝对涨跌幅 E|e^r − 1| = e^{σ_J²/2}·[2N(σ_J) − 1]。
 */
function detectFrontEvent(termPoints, iv1m) {
  if (!Array.isArray(termPoints) || !termPoints.length) return null;
  const front = termPoints.filter(p => p.dte >= FRONT_EVENT_MIN_DTE && p.dte <= FRONT_EVENT_MAX_DTE);
  if (!front.length) return null;
  const after = termPoints.filter(p => p.dte > FRONT_EVENT_MAX_DTE);
  let baseIv = after.length >= 2 ? forwardVol(after[0], after[1]) : null;
  let baseSource = '一周后两期限间远期波动率';
  if (!Number.isFinite(baseIv)) {
    baseIv = iv1m;
    baseSource = '1M ATM';
  }
  if (!Number.isFinite(baseIv)) return null;

  const peak = front.reduce((a, b) => (b.iv > a.iv ? b : a));
  const premium = peak.iv - baseIv;
  if (premium < FRONT_EVENT_MIN_PREMIUM) return null;

  const T = peak.dte;
  const s = peak.iv / 100;
  const d = baseIv / 100;
  const jumpVar = (s * s * T - d * d * Math.max(T - 1, 0)) / CRYPTO_DAYS_PER_YEAR;
  if (!(jumpVar > 0)) return null;
  const sj = Math.sqrt(jumpVar);
  const expectedAbsMovePct = Math.exp(jumpVar / 2) * (2 * cnd(sj) - 1) * 100;
  const normalDayAbsMovePct = Math.sqrt(2 / Math.PI) * d / Math.sqrt(CRYPTO_DAYS_PER_YEAR) * 100;

  return {
    expiry: peak.expiry,
    dte: peak.dte,
    iv: peak.iv,
    baseIv: Number(baseIv.toFixed(2)),
    baseSource,
    premium: Number(premium.toFixed(2)),
    jumpStdPct: Number((sj * 100).toFixed(2)),
    expectedAbsMovePct: Number(expectedAbsMovePct.toFixed(2)),
    normalDayAbsMovePct: Number(normalDayAbsMovePct.toFixed(2))
  };
}

/** Greeks.live iv_history 最新一行的已实现波动率期限 { 7: hv, 30: hv, ... } */
function latestHvTerm(ivHistory) {
  if (!Array.isArray(ivHistory) || !ivHistory.length) return null;
  const rows = ivHistory[ivHistory.length - 1]?.data;
  if (!Array.isArray(rows)) return null;
  const out = {};
  for (const r of rows) {
    if (r && Number.isFinite(r.day) && Number.isFinite(r.hv)) out[r.day] = r.hv;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Module 1: ATM IV Term Structure & Volatility Valuation
 * - 分位：DVOL 与 DVOL 自身 2 年历史比较 (DVOL 为 VIX 式 30D 方差口径，结构性高于 ATM，不能拿 ATM 去比)
 * - 贵贱：隐含 vs 已实现 (VRP = 1M ATM − HV30)，Natenberg Ch4/14、Bennett Ch3
 * - 振幅：√365 年化；近端事件溢价单独提取
 */
function analyzeAtmIv(ivHistory, dvolStats, atmData = null) {
  let iv1m = null;
  let iv2m = null;
  let iv3m = null;
  let iv6m = null;
  let iv1y = null;
  let termPoints = [];
  let isRealtime = false;

  // 1. 实时各期限 ATM IV (atm_data)
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
          atmObj = list.reduce((best, cur) => {
            if (!best) return cur;
            const diffCur = Math.abs((cur.delta || 0.5) - 0.5);
            const diffBest = Math.abs((best.delta || 0.5) - 0.5);
            return diffCur < diffBest ? cur : best;
          }, null);
        }
      }

      // 优先用剩余小时数，近端合约 (<1 天) 的期限精度决定事件溢价能否算准
      const dte = (typeof expItem.hour === 'number' && expItem.hour > 0)
        ? Number((expItem.hour / 24).toFixed(3))
        : ((typeof expItem.day === 'number' && expItem.day > 0) ? expItem.day : 0);

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
      iv1m = interpolateTotalVariance(rawPoints, 30);
      iv2m = interpolateTotalVariance(rawPoints, 60);
      iv3m = interpolateTotalVariance(rawPoints, 90);
      iv6m = interpolateTotalVariance(rawPoints, 180);
      iv1y = interpolateTotalVariance(rawPoints, 365);
      isRealtime = true;
    }
  }

  // 2. 回退到 iv_history 最新行
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

  const frontEvent = detectFrontEvent(termPoints, iv1m);
  if (frontEvent) {
    curveDesc = `一周内事件倒挂 + 1M 起${curveDesc}`;
  }

  // √T 法则 (加密 365 日历日)：日 = σ/√365，周 = σ/√52
  const ivForMove = iv1m || 35.0;
  const dailyExpectedMovePct = Number((ivForMove / Math.sqrt(CRYPTO_DAYS_PER_YEAR)).toFixed(2));
  const weeklyExpectedMovePct = Number((ivForMove / Math.sqrt(52)).toFixed(2));
  // ATM 跨式 ≈ 0.8·σ·√T (Bennett：单腿 ≈ 0.4·σ·√T)
  const atmStraddleEstPct = Number((0.8 * (ivForMove / 100.0) * Math.sqrt(30 / CRYPTO_DAYS_PER_YEAR) * 100).toFixed(2));

  // 已实现波动率与方差风险溢价
  const hvTerm = latestHvTerm(ivHistory);
  const hv30 = hvTerm && Number.isFinite(hvTerm[30]) ? hvTerm[30] : null;
  const vrp30 = (hv30 !== null && Number.isFinite(iv1m)) ? Number((iv1m - hv30).toFixed(2)) : null;

  // DVOL 与自身历史比较
  const dvolLatest = Number.isFinite(dvolStats?.latest) ? dvolStats.latest : null;
  const percentileRaw = dvolLatest !== null ? percentileOf(dvolStats.historicalSeries, dvolLatest) : null;

  let regime = 'Normal';
  let regimeTag = '历史合理区间';
  let extremeAlert = false;
  let recommendation = '';
  let volView = 'neutral';

  const vrpText = vrp30 === null
    ? '已实现波动率缺失，无法判断隐含相对已实现的贵贱'
    : `1M ATM ${iv1m.toFixed(1)}% 对 HV30 ${hv30.toFixed(1)}%，方差风险溢价 VRP ${vrp30 >= 0 ? '+' : ''}${vrp30.toFixed(1)} 点`;

  if (percentileRaw !== null) {
    const pct = percentileRaw;
    if (pct <= 5) { regime = 'Extreme Low'; regimeTag = '🚨 DVOL 历史极端低位'; extremeAlert = true; }
    else if (pct <= 20) { regime = 'Low Volatility'; regimeTag = '📉 DVOL 偏低压缩区间'; }
    else if (pct >= 90) { regime = 'Extreme High'; regimeTag = '🔥 DVOL 历史极端高位'; extremeAlert = true; }
    else if (pct >= 75) { regime = 'High Volatility'; regimeTag = '📈 DVOL 偏高溢价区间'; }
    else { regime = 'Normal'; regimeTag = '⚖️ DVOL 历史中性区间'; }

    const isLow = pct <= 20;
    const isHigh = pct >= 75;
    if (isLow && vrp30 !== null && vrp30 <= VRP_CHEAP_MAX) {
      volView = 'cheap';
      recommendation = `DVOL 处于低分位，且${vrpText}，隐含已不高于已实现，期权在绝对位置与相对已实现两个维度上都便宜。可考虑买入平值跨式/宽跨式（正 Gamma、正 Vega，付 Theta 换取变盘弹性）；若只想押波动率均值回归而不愿支付近端 Theta，可单独买入远月期权做多 Vega（注意：卖近买远的日历价差是负 Gamma，与做多 Gamma 是两种不同的押注）。`;
    } else if (isLow) {
      volView = 'low_but_not_cheap';
      recommendation = `DVOL 处于低分位，但${vrpText}${vrp30 === null ? '' : '，隐含仍高于已实现'}。分位低本身不构成买方优势：买跨式需要未来实现波动高于买入的隐含才能盈利（Natenberg Ch4/14）。更稳妥的是用借方价差（买平值、卖虚值）表达方向，或等待已实现波动回升、VRP 收窄后再做多波动率。`;
    } else if (isHigh && vrp30 !== null && vrp30 >= VRP_RICH_MIN) {
      volView = 'rich';
      recommendation = `DVOL 处于高分位，且${vrpText}，隐含相对已实现明显溢价。可用风险完全锁定的结构卖出波动率（蝶式、铁鹰），收 Theta 的同时封住尾部；不建议裸卖跨式，跳空风险无法被连续对冲消除（Natenberg Ch18）。`;
    } else if (isHigh) {
      volView = 'high_but_realized_higher';
      recommendation = `DVOL 处于高分位，但${vrpText}${vrp30 === null ? '' : '，已实现波动同样很高'}。隐含高是因为市场确实在剧烈波动，此时做空波动率没有统计优势；方向性需求优先用贷方价差（卖平值、买虚值）或领口策略。`;
    } else {
      volView = 'neutral';
      recommendation = `DVOL 处于历史中位区间，${vrpText}。波动率定价没有明显错位，适合结合方向观点构建垂直价差。`;
    }
  } else if (iv1m !== null && iv1m !== undefined) {
    // 无 DVOL 历史时仅给绝对值参考，不作极值判定
    regimeTag = '参考绝对值 (缺 DVOL 历史)';
    recommendation = `缺少 DVOL 历史分布，无法评估分位；${vrpText}。`;
  }

  const percentileText = percentileRaw !== null ? `${percentileRaw.toFixed(1)}%` : '参考常模';
  const eventText = frontEvent
    ? `【近端事件溢价】${frontEvent.expiry}（剩 ${frontEvent.dte < 1 ? `${Math.round(frontEvent.dte * 24)} 小时` : `${frontEvent.dte} 天`}）ATM IV ${frontEvent.iv.toFixed(1)}%，高出扩散基准 ${frontEvent.baseIv.toFixed(1)}%（${frontEvent.baseSource}）${frontEvent.premium.toFixed(1)} 点；按 Bennett 跳空波动率拆分，隐含事件窗口绝对涨跌幅约 ${frontEvent.expectedAbsMovePct}%（常态单日约 ${frontEvent.normalDayAbsMovePct}%）。`
    : '';
  const dvolText = dvolLatest !== null
    ? `DVOL ${dvolLatest.toFixed(1)} 处于近 2 年 ${percentileText} 分位（${regimeTag}）。`
    : '';
  const paragraph = `当下 Bitcoin ATM 隐含波动率呈现【${curveDesc}】期限结构（1M: ${iv1m?.toFixed(1)}%, 3M: ${iv3m?.toFixed(1)}%, 6M: ${iv6m?.toFixed(1)}%），按 365 日历日的时间平方根法则对应【日均预期振幅 ±${dailyExpectedMovePct}%】（周 ±${weeklyExpectedMovePct}%，1M 跨式约 ${atmStraddleEstPct}%）。${eventText}${extremeAlert ? '【极值预警】' : ''}${dvolText}${recommendation}`;

  return {
    iv1m,
    iv2m,
    iv3m,
    iv6m,
    iv1y,
    curveType,
    curveDesc,
    frontEvent,
    percentile: percentileRaw !== null ? Math.round(percentileRaw * 10) / 10 : null,
    percentileBasis: percentileRaw !== null ? 'dvol_vs_dvol' : null,
    dvolLatest,
    hv30,
    hvTerm,
    vrp30,
    volView,
    dailyExpectedMovePct,
    weeklyExpectedMovePct,
    atmStraddleEstPct,
    dvolMin: dvolStats?.min ?? null,
    dvolMax: dvolStats?.max ?? null,
    dvolMedian: dvolStats?.median ?? null,
    isRealtime,
    termPoints,
    regime,
    regimeTag,
    extremeAlert,
    recommendation,
    paragraph
  };
}

const GEX_NEAR_TERM_DAYS = 10; // 近端到期：Gamma ∝ 1/(σ√T)，对冲流主要来自 10 天内到期的合约
const GEX_NEUTRAL_SHARE = 0.1;  // 全部到期净额不足各到期日绝对敞口之和的 10%：整体体制视为中性，由近端主导
const GEX_FLIP_MAX_DIST = 0.2;  // 翻转位距现货超过 20%：对近期对冲流参考意义有限

/**
 * 按行权价合计 GEX，找出累计净 GEX (由低行权价向高累加) 变号的位置，取离现货最近的一个作为零 Gamma 翻转位近似。
 * 严格的翻转位需在假想现货价下重估全部合约 Gamma；数据源只给按行权价汇总的 GEX，因此这里只是常用代理。
 */
function estimateGammaFlip(strikeRows, spot) {
  const rows = (strikeRows || [])
    .filter(r => Number.isFinite(r?.strike) && Number.isFinite(r?.number))
    .sort((a, b) => a.strike - b.strike);
  if (rows.length < 2) return null;
  const crossings = [];
  let cum = 0;
  for (let i = 0; i < rows.length; i++) {
    const prev = cum;
    cum += rows[i].number;
    if (i > 0 && prev !== 0 && Math.sign(prev) !== Math.sign(cum) && cum !== 0) {
      // 在相邻两个行权价之间按累计值线性插值
      const k1 = rows[i - 1].strike;
      const k2 = rows[i].strike;
      const w = Math.abs(prev) / (Math.abs(prev) + Math.abs(cum));
      crossings.push({ strike: Math.round(k1 + w * (k2 - k1)), from: Math.sign(prev), to: Math.sign(cum) });
    }
  }
  if (!crossings.length) return null;
  const ref = Number.isFinite(spot) ? spot : crossings[0].strike;
  return crossings.reduce((best, c) => (Math.abs(c.strike - ref) < Math.abs(best.strike - ref) ? c : best));
}

/** 全部到期日按行权价合计 (优先用数据源 by_strike，缺失时由 by_expiry 汇总) */
function aggregateByStrike(gexData) {
  if (Array.isArray(gexData.by_strike) && gexData.by_strike.length) return gexData.by_strike;
  const map = new Map();
  for (const rows of Object.values(gexData.by_expiry || {})) {
    for (const r of rows || []) {
      if (!Number.isFinite(r?.strike) || !Number.isFinite(r?.number)) continue;
      map.set(r.strike, (map.get(r.strike) || 0) + r.number);
    }
  }
  return [...map.entries()].map(([strike, number]) => ({ strike, number }));
}

function wallsOf(rows) {
  let callWall = null;
  let putWall = null;
  let maxPos = -Infinity;
  let minNeg = Infinity;
  for (const r of rows || []) {
    if (r.number > maxPos) { maxPos = r.number; callWall = r.strike; }
    if (r.number < minNeg) { minNeg = r.number; putWall = r.strike; }
  }
  return { callWall, putWall };
}

const fmtGexM = v => `${v >= 0 ? '+' : '-'}$${Math.abs(v / 1e6).toFixed(1)}M`;

/**
 * Module 2: Dynamic GEX by Expiration & Dealer Gamma Regime
 * - 卡片聚焦月末/季末/年末交割，但 Gamma 体制按全部到期日 (含周度) 合计判定：近端合约 Gamma 最大，不能被过滤掉
 * - 正负号沿用数据源惯例 (Call 记正、Put 记负 = 假设做市商持有客户卖出的 Call 与买入的 Put 的对手盘)，
 *   这是 SqueezeMetrics 式的未经验证假设，叙述中如实披露
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

  const focusedList = [];
  const allList = [];

  for (const exp of Object.keys(gexData.by_expiry)) {
    const strikeList = gexData.by_expiry[exp] || [];
    const totalGex = strikeList.reduce((acc, item) => acc + (Number(item.number) || 0), 0);
    const { callWall, putWall } = wallsOf(strikeList);

    const isCurMonth = exp === curMonthEndExpiryStr;
    const isQuarter = quarterExpiries.includes(exp);
    const isYearEnd = exp === yearEndExpiryStr;

    let categoryTag = '普通周期';
    if (isCurMonth && isQuarter) categoryTag = `${frontMonthLabel.replace('交割', '')} & 季度交割`;
    else if (isCurMonth) categoryTag = frontMonthLabel;
    else if (isYearEnd) categoryTag = '年度最终交割';
    else if (isQuarter) categoryTag = '主季度交割';

    const expDate = parseDeribitExpiry(exp);
    const dte = expDate ? (expDate.getTime() - now.getTime()) / 86400000 : null;
    const isNearTerm = dte !== null && dte >= 0 && dte <= GEX_NEAR_TERM_DAYS;
    if (isNearTerm && categoryTag === '普通周期') categoryTag = '近端周度';

    const itemData = {
      expiry: exp,
      expiryDate: expDate ? expDate.toISOString().slice(0, 10) : exp,
      dte: dte !== null ? Number(dte.toFixed(2)) : null,
      categoryTag,
      totalGex,
      totalGexM: totalGex / 1e6,
      callWall,
      putWall,
      strikeCount: strikeList.length,
      isFocused: allowedFocusSet.has(exp),
      isNearTerm
    };

    allList.push(itemData);
    if (allowedFocusSet.has(exp)) focusedList.push(itemData);
  }

  const sortByDate = (a, b) => {
    const da = parseDeribitExpiry(a.expiry)?.getTime() || 0;
    const db = parseDeribitExpiry(b.expiry)?.getTime() || 0;
    return da - db;
  };
  focusedList.sort(sortByDate);
  allList.sort(sortByDate);

  const spotPrice = gexData.index_price || null;
  const strikeRows = aggregateByStrike(gexData);
  const totalAllGex = allList.reduce((acc, c) => acc + c.totalGex, 0);
  const nearTermList = allList.filter(e => e.isNearTerm);
  const totalNearGex = nearTermList.reduce((acc, c) => acc + c.totalGex, 0);
  const totalFocusedGex = focusedList.reduce((acc, c) => acc + c.totalGex, 0);
  const aggregateWalls = wallsOf(strikeRows);
  const gammaFlip = estimateGammaFlip(strikeRows, spotPrice);
  if (gammaFlip && Number.isFinite(spotPrice)) {
    gammaFlip.farFromSpot = Math.abs(gammaFlip.strike - spotPrice) / spotPrice > GEX_FLIP_MAX_DIST;
  }

  let marketMakerRegime = 'Neutral';
  let paragraph = '';
  if (allList.length) {
    const grossGex = allList.reduce((acc, c) => acc + Math.abs(c.totalGex), 0);
    const netShare = grossGex > 0 ? Math.abs(totalAllGex) / grossGex : 0;
    const isNeutral = netShare < GEX_NEUTRAL_SHARE;
    const isLong = totalAllGex > 0;
    marketMakerRegime = isNeutral
      ? 'Neutral (Mixed Expiries)'
      : (isLong ? 'Long Gamma (Stabilizing / Pinning)' : 'Short Gamma (Volatility Accelerating)');

    const regimeText = isNeutral
      ? `全部到期日合计净 GEX ${fmtGexM(totalAllGex)}，仅占各到期日绝对敞口之和的 ${(netShare * 100).toFixed(0)}%，正负相互抵消，整体 Gamma 体制不明确，短期对冲方向以近端到期为准。`
      : isLong
      ? `全部到期日合计净 GEX ${fmtGexM(totalAllGex)}，做市商整体处于【正 Gamma】：现货上涨卖出、下跌买入以维持 Delta 中性，对现货起减震作用，临近到期的大持仓行权价附近有钉盘 (Pinning) 倾向。`
      : `全部到期日合计净 GEX ${fmtGexM(totalAllGex)}，做市商整体处于【负 Gamma】：现货上涨被迫追买、下跌被迫追卖，对冲流会放大单边波动，不应期待钉盘。`;

    let nearText = '';
    if (nearTermList.length) {
      const nearLong = totalNearGex > 0;
      nearText = `${GEX_NEAR_TERM_DAYS} 天内到期的 ${nearTermList.length} 个合约合计 ${fmtGexM(totalNearGex)}（${nearLong ? '正' : '负'} Gamma）；近端合约 Gamma 最大，决定未来几天的对冲方向。`;
      if (focusedList.length && Math.sign(totalFocusedGex) !== Math.sign(totalNearGex) && totalNearGex !== 0) {
        nearText += `注意：卡片聚焦的主力交割合计 ${fmtGexM(totalFocusedGex)}，与近端周度方向相反，只看主力交割会得出相反结论。`;
      }
    }

    const flipText = gammaFlip
      ? `累计 GEX 由${gammaFlip.from > 0 ? '正' : '负'}转${gammaFlip.to > 0 ? '正' : '负'}的翻转位约在 $${gammaFlip.strike.toLocaleString()}（按行权价累计的近似值${Number.isFinite(spotPrice) ? `，现货 ~$${Math.round(spotPrice).toLocaleString()} 位于其${spotPrice >= gammaFlip.strike ? '上方' : '下方'}` : ''}）${gammaFlip.farFromSpot ? `，距现货超过 ${GEX_FLIP_MAX_DIST * 100}%，对近期对冲流参考意义有限` : ''}。`
      : `按行权价累计的净 GEX 在全部行权价区间内未变号（${totalAllGex >= 0 ? '全程为正' : '整体为负'}），无法用累计法近似零 Gamma 翻转位。`;

    const wallText = (aggregateWalls.callWall && aggregateWalls.putWall)
      ? `全部到期合计的最大正 GEX 行权价 $${aggregateWalls.callWall.toLocaleString()}（Call Wall），最大负 GEX 行权价 $${aggregateWalls.putWall.toLocaleString()}（Put Wall）。`
      : '';

    const gammaThetaText = `【Gamma-Theta 平衡】做市商持仓 P&L ≈ ½(ΔS)²·Γ + Θ·Δt：跳空收益随 ΔS² 增长，2% 跳空的 Gamma 损益是 1% 的 4 倍。`;

    const assumptionText = `【口径说明】正负号沿用数据源惯例：Call 记正、Put 记负，即假设做市商是客户卖 Call、买 Put 的对手方；公开 OI 不区分做市商与客户方向，该假设未经 Deribit 实际成交方向验证，可结合大宗雷达的主动方向与 OI 开平仓交叉核对。GEX 数值按数据源口径展示。`;

    paragraph = `${regimeText}${nearText}${flipText}${wallText}${gammaThetaText}${assumptionText}`;
  }

  const curDateStr = formatUTC8(now).slice(0, 10);
  return {
    indexPrice: spotPrice,
    focusedExpiries: focusedList,
    allExpiries: allList,
    totalAllGexM: Number((totalAllGex / 1e6).toFixed(2)),
    totalNearGexM: Number((totalNearGex / 1e6).toFixed(2)),
    totalFocusedGexM: Number((totalFocusedGex / 1e6).toFixed(2)),
    nearTermDays: GEX_NEAR_TERM_DAYS,
    gammaFlip,
    aggregateCallWall: aggregateWalls.callWall,
    aggregatePutWall: aggregateWalls.putWall,
    marketMakerRegime,
    dynamicRuleDescription: `当前日期基准（${curDateStr} UTC+8）：卡片默认聚焦${isRolledToNextMonth ? '次月月底（当月交割已过，自动滚动至' : '当月月底（'}${curMonthEndExpiryStr}）、季末交割及年底交割（${yearEndExpiryStr}）；Gamma 体制与翻转位按全部到期日（含周度）合计判定。`,
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
// OI-based opening / closing estimate for a set of legs (null when no OI history is available)
function oiProfileOf(oiSnapshots, legs) {
  if (!oiSnapshots || !oiSnapshots.length) return null;
  return profileFromItems(oiSnapshots, legs.map(l => ({
    instrument: l.instrument,
    ts: l.timestamp,
    amount: l.amount,
    expiryMs: l.expiryMs
  })));
}

/**
 * @param {Array} oiSnapshots - optional Deribit OI daily snapshots (server/option_oi_history.js) used to
 *   estimate whether each block / iceberg opened or closed positions
 */
function analyzeBlockTrades(rawTrades, notionalThresholdUSD = 30000000, timeRange = 'all', spotPrice = 77250, oiSnapshots = null) {
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
        timestamp: leg.timestamp,
        expiryMs: inst ? expDate.getTime() : null,
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
      const oiProfile = oiProfileOf(oiSnapshots, processedLegs);
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
        oiProfile,
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

      const oiProfile = oiProfileOf(oiSnapshots, group.flatMap(b => b.legs));
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
        startTimestamp: group[0].timestamp,
        endTimestamp: group[group.length - 1].timestamp,
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
        oiProfile,
        ...intent
      });
    }
  }
  // Latest execution first (the UI can re-sort by cumulative notional)
  icebergClusters.sort((a, b) => (b.endTimestamp - a.endTimestamp) || (b.clusterNotionalUSD - a.clusterNotionalUSD));

  // 3. Statistical synthesis
  // 单笔巨鲸与冰山组会重叠 (一笔 ≥ 门槛的大单也可能是某组拆单的一片)，
  // 总名义与多空倾向按两者的并集 (blockId 去重) 统计，各自的口径另行给出
  const totalWhaleVolume = whaleBlocks.reduce((acc, b) => acc + b.notionalUSD, 0);
  const whaleIdSet = new Set(whaleBlocks.map(b => b.blockId));
  const clusteredIdSet = new Set();
  for (const c of icebergClusters) (c.blockIds || []).forEach(id => clusteredIdSet.add(id));
  const dedupedUnits = blockUnits.filter(u => whaleIdSet.has(u.blockId) || clusteredIdSet.has(u.blockId));
  const dedupedTotal = dedupedUnits.reduce((acc, u) => acc + u.totalNotional, 0);
  const overlapUnits = dedupedUnits.filter(u => whaleIdSet.has(u.blockId) && clusteredIdSet.has(u.blockId));
  const whaleInClusterUSD = overlapUnits.reduce((acc, u) => acc + u.totalNotional, 0);
  const icebergOnlyUSD = dedupedUnits
    .filter(u => !whaleIdSet.has(u.blockId))
    .reduce((acc, u) => acc + u.totalNotional, 0);

  let callBuyNotional = 0;
  let callSellNotional = 0;
  let putBuyNotional = 0;
  let putSellNotional = 0;

  for (const b of dedupedUnits) {
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

  // 资金聚集画像：对冰山组与独立大单按「到期日 × 策略构型」做名义额加权归集；
  // 冰山组优先统计，其内部若含有单笔巨鲸则以 blockId 去重，避免双重计入
  const MONTH_CN = { JAN: '1月', FEB: '2月', MAR: '3月', APR: '4月', MAY: '5月', JUN: '6月', JUL: '7月', AUG: '8月', SEP: '9月', OCT: '10月', NOV: '11月', DEC: '12月' };
  const fmtExpiryCn = e => {
    const m = /^(\d{1,2})([A-Z]{3})(\d{2})$/.exec(e || '');
    return m ? `${MONTH_CN[m[2]]}${+m[1]}日交割（${e}）` : e;
  };
  const dominantExpiry = (legs, fallbackName) => {
    const w = {};
    for (const l of legs || []) {
      let exp = l.expiryStr && l.expiryStr !== 'UNKNOWN' ? l.expiryStr : null;
      if (!exp) { const m = /-(\d{1,2}[A-Z]{3}\d{2})-/.exec(l.instrument || ''); exp = m && m[1]; }
      if (!exp) continue;
      w[exp] = (w[exp] || 0) + (l.notionalM || 1);
    }
    const top = Object.entries(w).sort((a, b) => b[1] - a[1])[0];
    if (top) return top[0];
    const m = /-(\d{1,2}[A-Z]{3}\d{2})-/.exec(fallbackName || '');
    return m ? m[1] : null;
  };
  const clusteredIds = clusteredIdSet;
  const concItems = [];
  for (const c of icebergClusters) {
    concItems.push({ usd: c.clusterNotionalUSD || 0, name: c.strategyNameZh || '未识别构型', expiry: dominantExpiry(c.legs, c.instrument) });
  }
  for (const b of whaleBlocks) {
    if (clusteredIds.has(b.blockId)) continue;
    concItems.push({ usd: b.notionalUSD || 0, name: b.strategyNameZh || '未识别构型', expiry: dominantExpiry(b.legs) });
  }
  const concTotal = concItems.reduce((s, x) => s + x.usd, 0);
  let concentrationText = '样本过少，暂无法归集大资金构型意图。';
  if (concTotal > 0) {
    const topBy = key => {
      const m = {};
      for (const x of concItems) { const k = key(x); if (!k) continue; m[k] = (m[k] || 0) + x.usd; }
      return Object.entries(m).sort((a, b) => b[1] - a[1])[0] || null;
    };
    const topE = topBy(x => x.expiry);
    const topS = topBy(x => x.name);
    const ePct = topE ? Math.round((topE[1] / concTotal) * 100) : 0;
    const sPct = topS ? Math.round((topS[1] / concTotal) * 100) : 0;
    const expPart = topE && ePct >= 40
      ? `到期日集中于 ${fmtExpiryCn(topE[0])}（占名义额 ${ePct}%）`
      : '到期日分布分散';
    const stratPart = topS && sPct >= 25
      ? `构型以【${topS[0]}】为主（占 ${sPct}%）`
      : `构型分散，最大单一构型仅占 ${sPct}%，未见一致性意图`;
    concentrationText = `大资金名义额${expPart}，${stratPart}。`;
  }

  const rangeLabel = timeRange === '24h' ? '近 24 小时' : (timeRange === '3d' ? '近 3 天 (72小时)' : (timeRange === '7d' ? '近 7 天' : '过去 30 天历史沉淀'));
  const M = v => (v / 1e6).toFixed(1);
  const overlapText = overlapUnits.length
    ? `，其中 ${overlapUnits.length} 笔（$${M(whaleInClusterUSD)}M）同属冰山组`
    : '';
  const oiCounts = { opening: 0, closing: 0, mixed: 0, pending: 0 };
  for (const x of [...icebergClusters, ...whaleBlocks.filter(b => !clusteredIdSet.has(b.blockId))]) {
    if (x.oiProfile && oiCounts[x.oiProfile.status] !== undefined) oiCounts[x.oiProfile.status]++;
  }
  const oiJudged = oiCounts.opening + oiCounts.closing + oiCounts.mixed;
  const oiText = oiJudged
    ? `按 Deribit 未平仓量变化验证（冰山组与独立大单）：开仓 ${oiCounts.opening} 组，平仓 ${oiCounts.closing} 组，开平混合 ${oiCounts.mixed} 组${oiCounts.pending ? `，另 ${oiCounts.pending} 组待次日快照确认` : ''}。`
    : '';
  const paragraph = `在【${rangeLabel}】窗口内，单笔巨鲸大单与冰山拆单组合去重后的大宗资金总名义为 $${M(dedupedTotal)}M：名义价值超 $${Math.round(notionalThresholdUSD / 1e6)}M 的单笔巨鲸 ${whaleBlocks.length} 笔、合计 $${M(totalWhaleVolume)}M${overlapText}；智能冰山算法捕获 ${icebergClusters.length} 组机构级时间切片拆单与组合价差聚合，另含 $${M(icebergOnlyUSD)}M 单笔未达门槛的拆单切片。整体大宗资金流向呈现【${flowBias}】特征（按去重后全集，多头倾向占比约 ${bullRatio}%）。${oiText}单笔巨鲸按成交特征的规则推断：全新建仓 ${openCount} 笔，平仓离场 ${closeCount} 笔，跨期展期 ${rollCount} 笔${zeroDteCount > 0 ? `；另检测到 ${zeroDteCount} 笔距结算不足 16 小时的末日 0DTE 极限博弈` : '；近端暂无 0DTE 末日穿透扰动'}。${concentrationText}`;

  return {
    whaleBlocks,
    icebergClusters,
    totalWhaleVolumeM: totalWhaleVolume / 1e6,
    dedupedTotalM: dedupedTotal / 1e6,
    dedupedBlockCount: dedupedUnits.length,
    whaleInClusterCount: overlapUnits.length,
    whaleInClusterM: whaleInClusterUSD / 1e6,
    icebergOnlyM: icebergOnlyUSD / 1e6,
    oiVerified: oiJudged > 0 ? oiCounts : null,
    bullRatio,
    flowBias,
    paragraph
  };
}

// 25Δ 期权的 d1 ≈ ±0.674，两侧行权价在对数虚实值上相距约 1.349·σ·√T
const DELTA25_LOGK_SPAN = 2 * 0.6745;
const SKEW_SIDE_THRESHOLD = 1.2;     // |25Δ RR| > 1.2 个波动率点视为明显单侧偏斜
const SKEW_SIGN_THRESHOLD = 0.3;     // 期限桶情绪判定阈值
const SKEW_HISTORY_MIN_DAYS = 30;    // 偏度贵贱判定所需最少日度样本
const SPOT_VOL_LOOKBACK_DAYS = 90;
const SPOT_VOL_MIN_R2 = 0.05;        // 回归解释度低于 5% 时视为联动不显著，不判定机制

/** 在按 key 升序的点列上线性插值 valueKey；超出范围返回 null */
function interpolateOn(points, key, target, valueKey) {
  if (!points.length) return null;
  if (target < points[0][key] || target > points[points.length - 1][key]) return null;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (target < a[key] || target > b[key]) continue;
    if (b[key] === a[key]) return a[valueKey];
    const w = (target - a[key]) / (b[key] - a[key]);
    return a[valueKey] + w * (b[valueKey] - a[valueKey]);
  }
  return points[points.length - 1][valueKey];
}

function dteOfUnderlying(underlyingIndex, now) {
  const exp = parseDeribitExpiry(String(underlyingIndex || '').split('-')[1]);
  return exp ? Math.max(0, (exp.getTime() - now.getTime()) / 86400000) : null;
}

const round2 = v => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const signed1 = v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;

/**
 * 单个到期日的微笑度量：ATM 取远期价处插值 IV；两翼按固定 Delta 取 25Δ/10Δ (市场惯例)，
 * 不再用列表里最低/最高行权价 (两侧虚实值距离不对称，且随数据商给出的行权价范围漂移)。
 * iv_list 的 delta 为 Call Delta：25Δ Put ↔ Call Delta 0.75。
 */
function smileMetricsFor(m, now) {
  if (!m || !Array.isArray(m.iv_list)) return null;
  const sorted = m.iv_list
    .filter(s => Number.isFinite(s?.strike) && Number.isFinite(s?.iv))
    .sort((a, b) => a.strike - b.strike);
  if (sorted.length < 3) return null;

  const price = Number(m.underlying_price) > 0 ? m.underlying_price : m.fallbackPrice;
  const dte = dteOfUnderlying(m.underlying_index, now);
  const atmItem = sorted.reduce((best, s) => (Math.abs(s.strike - price) < Math.abs(best.strike - price) ? s : best));
  const atmIv = interpolateOn(sorted, 'strike', price, 'iv') ?? atmItem.iv;

  const byDelta = sorted.filter(s => Number.isFinite(s.delta)).sort((a, b) => a.delta - b.delta);
  const atDelta = callDelta => {
    const iv = interpolateOn(byDelta, 'delta', callDelta, 'iv');
    const strike = interpolateOn(byDelta, 'delta', callDelta, 'strike');
    return iv === null ? null : { iv, strike };
  };

  let basis = 'delta';
  let put25 = atDelta(0.75);
  let call25 = atDelta(0.25);
  if (!put25 || !call25) {
    // 无 Delta 时按 25Δ 对应的对称对数虚实值距离取点
    basis = 'moneyness';
    const T = (dte || 30) / 365;
    const half = 0.6745 * (atmIv / 100) * Math.sqrt(T);
    const kp = price * Math.exp(-half);
    const kc = price * Math.exp(half);
    const ivp = interpolateOn(sorted, 'strike', kp, 'iv');
    const ivc = interpolateOn(sorted, 'strike', kc, 'iv');
    put25 = ivp === null ? null : { iv: ivp, strike: kp };
    call25 = ivc === null ? null : { iv: ivc, strike: kc };
  }
  if (!put25 || !call25) return null;

  const put10 = basis === 'delta' ? atDelta(0.90) : null;
  const call10 = basis === 'delta' ? atDelta(0.10) : null;

  const rr25 = call25.iv - put25.iv;
  const bf25 = (call25.iv + put25.iv) / 2 - atmIv;
  return {
    underlying: m.underlying_index,
    underlyingPrice: price,
    dte: dte !== null ? Number(dte.toFixed(2)) : null,
    basis,
    atmStrike: atmItem.strike,
    atmIv,
    put25: { strike: Math.round(put25.strike), iv: round2(put25.iv) },
    call25: { strike: Math.round(call25.strike), iv: round2(call25.iv) },
    rr25: round2(rr25),
    bf25: round2(bf25),
    rr10: put10 && call10 ? round2(call10.iv - put10.iv) : null,
    bf10: put10 && call10 ? round2((call10.iv + put10.iv) / 2 - atmIv) : null,
    // √T 法则下固定 Delta 的 RR/σ_ATM 跨期限应近似不变 (行权价偏斜 ∝ 1/√T，而 25Δ 间距 ∝ σ√T)
    rrPerVol: atmIv > 0 ? round2(rr25 / atmIv) : null,
    strikes: sorted
  };
}

/**
 * Module 4: IV Smile (25Δ Risk Reversal & Butterfly)
 * Bennett Ch6：三阶矩 ↔ 风险逆转 (Vanna)，四阶矩 ↔ 蝶式 (Volga)；近端由峰度主导、远端由偏斜主导
 */
function analyzeIvSmile(ivSkewMonth, spotPrice = 77250, referenceDate = new Date()) {
  if (!ivSkewMonth || !ivSkewMonth.month1) {
    return {
      status: 'insufficient_data',
      summaryText: '暂无 IV 微笑曲线数据。'
    };
  }

  const front = smileMetricsFor({ ...ivSkewMonth.month1, fallbackPrice: spotPrice }, referenceDate);
  if (!front) {
    return {
      status: 'insufficient_data',
      summaryText: '微笑曲线行权价列表为空或无法定位 25Δ 两翼。'
    };
  }
  const back = ivSkewMonth.month3 ? smileMetricsFor({ ...ivSkewMonth.month3, fallbackPrice: spotPrice }, referenceDate) : null;

  const rr = front.rr25;
  const bf = front.bf25;
  let skewShape;
  let skewBias;
  let momentText;
  if (rr > SKEW_SIDE_THRESHOLD) {
    skewShape = '右偏微笑 / 上行追涨溢价 (Call Skew / Upside Smirk)';
    skewBias = '25Δ Call 隐含波动率高于 25Δ Put，上行尾部定价更贵。';
    momentText = `【三阶矩 / 风险逆转】25Δ RR ${signed1(rr)} 点，右翼更贵，与股指常年的左偏相反，反映对上行跳空的凸性需求。`;
  } else if (rr < -SKEW_SIDE_THRESHOLD) {
    skewShape = '左偏倒斜 / 下行避险溢价 (Put Skew / Fear Smirk)';
    skewBias = '25Δ Put 隐含波动率高于 25Δ Call，下行保护需求占优。';
    momentText = `【三阶矩 / 风险逆转】25Δ RR ${signed1(rr)} 点，左翼更贵：持有 OTM Put 的一方为每单位 Gamma 支付更高的 Skew Theta（Bennett Ch6）。`;
  } else {
    skewShape = '对称标准微笑 (Symmetric Smile)';
    skewBias = '25Δ 两翼定价接近，多空尾部预期均衡。';
    momentText = `【三阶矩 / 风险逆转】25Δ RR ${signed1(rr)} 点，两翼基本对称。`;
  }
  const kurtText = bf >= 0
    ? `【四阶矩 / 蝶式】25Δ BF ${signed1(bf)} 点：两翼相对平值${bf >= 1 ? '明显' : '略微'}抬升，对应肥尾定价，两翼 Volga 敏感。`
    : `【四阶矩 / 蝶式】25Δ BF ${signed1(bf)} 点：两翼低于平值，市场没有为肥尾付溢价。`;
  const tenText = (front.rr10 !== null && front.bf10 !== null)
    ? `10Δ 两翼 RR ${signed1(front.rr10)} / BF ${signed1(front.bf10)} 点。`
    : '';

  let termText = '';
  if (back && front.rrPerVol !== null && back.rrPerVol !== null) {
    termText = `与 ${back.underlying}（剩 ${back.dte} 天，RR ${signed1(back.rr25)} / BF ${signed1(back.bf25)}）相比：按 √T 法则固定 Delta 的 RR/σ 应近似不变，当前近月 ${front.rrPerVol.toFixed(3)} 对远月 ${back.rrPerVol.toFixed(3)}；近月 BF ${front.bf25 >= back.bf25 ? '高于' : '低于'}远月，${front.bf25 >= back.bf25 ? '符合' : '不符合'}"近端峰度主导、远端偏斜主导"的常态（Bennett Ch6）。`;
  }

  const basisText = front.basis === 'delta' ? '固定 Delta' : '对称对数虚实值（无 Delta 时的近似）';
  const paragraph = `${front.underlying}（剩 ${front.dte} 天，远期价 $${Math.round(front.underlyingPrice).toLocaleString()}）按${basisText}口径度量：ATM IV ${front.atmIv.toFixed(1)}%，25Δ Put（$${front.put25.strike.toLocaleString()}）${front.put25.iv.toFixed(1)}%，25Δ Call（$${front.call25.strike.toLocaleString()}）${front.call25.iv.toFixed(1)}%，呈【${skewShape}】。${momentText}${kurtText}${tenText}${termText}`;

  return {
    underlying: front.underlying,
    underlyingPrice: front.underlyingPrice,
    dte: front.dte,
    basis: front.basis,
    atmStrike: front.atmStrike,
    atmIv: front.atmIv,
    put25: front.put25,
    call25: front.call25,
    putWingPremium: round2(front.put25.iv - front.atmIv),
    callWingPremium: round2(front.call25.iv - front.atmIv),
    rr25: front.rr25,
    bf25: front.bf25,
    rr10: front.rr10,
    bf10: front.bf10,
    asymmetryDiff: front.rr25,
    smileCurvature: front.bf25,
    skewShape,
    skewBias,
    backMonth: back ? {
      underlying: back.underlying,
      dte: back.dte,
      atmIv: round2(back.atmIv),
      rr25: back.rr25,
      bf25: back.bf25
    } : null,
    strikes: front.strikes.map(s => ({
      strike: s.strike,
      iv: Math.round(s.iv * 10) / 10,
      delta: Number.isFinite(s.delta) ? Math.round(s.delta * 100) / 100 : null
    })),
    paragraph
  };
}

/**
 * 现货-波动率联动：日度 ΔDVOL 对 Δln(S) 回归，β 单位为"波动率点 / 单位对数收益"
 * DVOL 是 30D 方差口径，作为 ATM 波动率变动的代理
 */
function estimateSpotVolBeta(chrono, lookbackDays = SPOT_VOL_LOOKBACK_DAYS) {
  const pts = (chrono || []).filter(p => Number.isFinite(p?.spot) && p.spot > 0 && Number.isFinite(p?.dvol));
  const win = pts.slice(-(lookbackDays + 1));
  if (win.length < 31) return null;
  const xs = [];
  const ys = [];
  for (let i = 1; i < win.length; i++) {
    xs.push(Math.log(win[i].spot / win[i - 1].spot));
    ys.push(win[i].dvol - win[i - 1].dvol);
  }
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  if (sxx === 0) return null;
  const beta = sxy / sxx;
  const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
  return { beta, r2, n };
}

/**
 * Bennett Ch6 偏度实现机制：比较"现货变动 1 单位对数收益时 ATM 波动率的实际变动 β"与"隐含偏斜斜率 s"
 *   β/s ≈ 0 黏性 Delta；≈ 1 黏性行权价；≈ 2 黏性局部波动率 (偏斜公允，长偏斜盈亏平衡)；> 2 跳跃；< 0 反向
 * 这是时间序列判断，不能从单个截面的期限形态推断
 */
function classifySkewRegime(beta, slope) {
  if (!Number.isFinite(beta) || !Number.isFinite(slope) || Math.abs(slope) < 1e-9) {
    return { key: 'undetermined', name: '无法判定 (Undetermined)', ratio: null };
  }
  const ratio = beta / slope;
  if (ratio < 0) return { key: 'inverse', name: '反向联动 (Inverse)', ratio };
  if (ratio < 0.5) return { key: 'sticky_delta', name: '黏性 Delta (Sticky Delta)', ratio };
  if (ratio < 1.5) return { key: 'sticky_strike', name: '黏性行权价 (Sticky Strike)', ratio };
  if (ratio <= 2.5) return { key: 'sticky_local_vol', name: '黏性局部波动率 (Sticky Local Vol)', ratio };
  return { key: 'jumpy', name: '跳跃波动率 (Jumpy Vol)', ratio };
}

function sentimentOf(values) {
  const vals = values.filter(Number.isFinite);
  if (!vals.length) return '数据缺失';
  if (vals.every(v => v < -SKEW_SIGN_THRESHOLD)) return 'Put 溢价';
  if (vals.every(v => v > SKEW_SIGN_THRESHOLD)) return 'Call 溢价';
  if (vals.every(v => Math.abs(v) <= SKEW_SIGN_THRESHOLD)) return '平水均衡';
  return '多空分歧';
}

const fmtSkew = v => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;

/**
 * Module 5: 25Δ Skew 期限结构
 * ctx:
 *   atm      analyzeAtmIv 结果 (termPoints / iv1m，用于把 RR 换算到 RR/σ 与偏斜斜率)
 *   dvolStats 含 chrono [{ ts, dvol, spot }]，用于估计现货-波动率实际联动
 *   history  本地累积的日度 25Δ 记录 [{ day, rr30 }]，用于判断偏度贵贱
 */
function analyze25DeltaSkew(skewChart, ctx = {}) {
  if (!skewChart || !skewChart.length) {
    return {
      status: 'insufficient_data',
      summaryText: '暂无 25Δ Skew 数据。'
    };
  }

  const latest = skewChart[skewChart.length - 1];
  const pick = k => (Number.isFinite(latest[k]) ? latest[k] : null);
  const d1 = pick('day1');
  const d7 = pick('days7');
  const d15 = pick('days15');
  const d30 = pick('days30');
  const d60 = pick('days60');
  const d90 = pick('days90');
  const d180 = pick('days180');
  const d365 = pick('days365');

  // RR / σ_ATM(T)：√T 法则下跨期限近似不变
  const atm = ctx.atm || null;
  const atmAt = dte => {
    if (atm && Array.isArray(atm.termPoints) && atm.termPoints.length >= 2) return interpolateTotalVariance(atm.termPoints, dte);
    return Number.isFinite(atm?.iv1m) ? atm.iv1m : null;
  };
  const perVol = (rr, dte) => {
    const v = atmAt(dte);
    return (Number.isFinite(rr) && v > 0) ? Number((rr / v).toFixed(4)) : null;
  };
  const normalized = {
    d1: perVol(d1, 1),
    d7: perVol(d7, 7),
    d30: perVol(d30, 30),
    d90: perVol(d90, 90),
    d180: perVol(d180, 180),
    d365: perVol(d365, 365)
  };

  // √T 一致性：短端 RR/σ 相对 30D
  let termConsistency = { verdict: 'unknown', ratio7: null, ratio1: null };
  let termText = '';
  if (normalized.d30 !== null && Math.abs(normalized.d30) > 0.005) {
    const ratio7 = normalized.d7 !== null ? normalized.d7 / normalized.d30 : null;
    const ratio1 = normalized.d1 !== null ? normalized.d1 / normalized.d30 : null;
    let verdict = 'consistent';
    if (ratio7 !== null && ratio7 > 1.5) verdict = 'front_steeper';
    else if (ratio7 !== null && ratio7 < 0.5) verdict = 'front_flatter';
    termConsistency = { verdict, ratio7: round2(ratio7), ratio1: round2(ratio1) };
    const verdictText = verdict === 'front_steeper'
      ? '短端偏斜明显陡于 √T 法则，近端正在为单侧尾部重新定价（常见于事件前）'
      : verdict === 'front_flatter'
        ? (ratio7 < 0 ? '短端偏斜方向与 30D 相反，近端情绪与中期结构背离' : '短端偏斜明显平于 √T 法则，近端尾部定价相对平静')
        : '短端与 30D 的偏斜符合 √T 法则，期限上没有错位';
    termText = `按 √T 法则固定 Delta 的 RR/σ 跨期限应近似不变：7D/30D 比值 ${ratio7 !== null ? ratio7.toFixed(2) : '--'}${ratio1 !== null ? `（1D/30D ${ratio1.toFixed(2)}，1D 报价噪声大，仅作参考）` : ''}，${verdictText}。`;
  }

  // 实现机制：β (ΔDVOL / Δln S) 对比 30D 偏斜斜率 s = RR / (1.349·σ·√T)
  let realizedRegime = { key: 'undetermined', name: '无法判定 (Undetermined)', ratio: null, beta: null, slope: null, r2: null, n: 0 };
  const sigma30 = atmAt(30);
  const spotVol = estimateSpotVolBeta(ctx.dvolStats?.chrono);
  if (Number.isFinite(d30) && sigma30 > 0 && Math.abs(d30) >= SKEW_SIGN_THRESHOLD) {
    const slope = d30 / (DELTA25_LOGK_SPAN * (sigma30 / 100) * Math.sqrt(30 / 365));
    let cls = { key: 'undetermined', name: '无法判定 (Undetermined)', ratio: null };
    if (spotVol && spotVol.r2 < SPOT_VOL_MIN_R2) cls = { key: 'insignificant', name: '联动不显著 (Insignificant)', ratio: null };
    else if (spotVol) cls = classifySkewRegime(spotVol.beta, slope);
    realizedRegime = {
      ...cls,
      ratio: round2(cls.ratio),
      beta: spotVol ? round2(spotVol.beta) : null,
      slope: round2(slope),
      r2: spotVol ? round2(spotVol.r2) : null,
      n: spotVol ? spotVol.n : 0
    };
  }

  const richSide = Number.isFinite(d30) ? (d30 < 0 ? 'put' : 'call') : null;
  let regimeText;
  let skewRegimeDesc;
  if (realizedRegime.ratio !== null) {
    const wing = richSide === 'put' ? 'OTM Put' : 'OTM Call';
    const longSkewWins = realizedRegime.ratio > 2;
    skewRegimeDesc = realizedRegime.key === 'inverse'
      ? `近 ${realizedRegime.n} 日现货与波动率的联动方向与当前偏斜相反（β/s = ${realizedRegime.ratio.toFixed(2)}，β = ${realizedRegime.beta} 波动率点/单位对数收益，R² ${realizedRegime.r2}）：偏斜押注的尾部方向上波动率并没有被实际抬升，持有较贵一翼 (${wing}) 的一方难以靠曲面重估回本。`
      : `近 ${realizedRegime.n} 日 β/s = ${realizedRegime.ratio.toFixed(2)}（β = ${realizedRegime.beta} 波动率点/单位对数收益，s = ${realizedRegime.slope}，R² ${realizedRegime.r2}）。Bennett：只有 β/s > 2 时持有较贵一翼 (${wing}) 的曲面重估收益才能覆盖 Skew Theta；当前${longSkewWins ? '高于 2，较贵一翼的持有方占优' : '低于 2，较贵一翼的持有方在付租金，卖出较贵一翼的一方收取 Skew Theta'}。`;
    regimeText = `【实现机制：${realizedRegime.name}】${skewRegimeDesc}DVOL 作为 ATM 代理，且 BTC 现货-波动率相关性在不同阶段可正可负，需随样本滚动复核。`;
  } else {
    if (realizedRegime.key === 'insignificant') {
      skewRegimeDesc = `近 ${realizedRegime.n} 日 DVOL 变动与现货收益的回归 R² 仅 ${realizedRegime.r2}，现货-波动率联动不显著，无法判定偏斜实现机制。`;
    } else {
      skewRegimeDesc = !Number.isFinite(d30) || Math.abs(d30) < SKEW_SIGN_THRESHOLD
        ? '30D 偏斜接近零，偏斜斜率太小，无法换算实现机制。'
        : '缺少足够的 DVOL 与现货日线样本，无法估计现货-波动率实际联动。';
    }
    regimeText = `【实现机制：${realizedRegime.name}】${skewRegimeDesc}`;
  }

  // 偏度贵贱：与本地累积的 30D RR 日度历史比较
  const histVals = (ctx.history || []).map(h => h?.rr30).filter(Number.isFinite);
  let richness = { verdict: 'insufficient_history', percentile: null, n: histVals.length };
  if (histVals.length >= SKEW_HISTORY_MIN_DAYS && Number.isFinite(d30)) {
    const pct = percentileOf(histVals, d30);
    let verdict = 'normal';
    if (pct <= 20) verdict = 'put_rich';        // RR 处于历史最负区间：Put 侧相对自身历史偏贵
    else if (pct >= 80) verdict = 'call_rich';  // RR 处于历史最正区间：Call 侧相对自身历史偏贵
    richness = { verdict, percentile: Math.round(pct * 10) / 10, n: histVals.length };
  }
  const richnessText = richness.verdict === 'insufficient_history'
    ? `本地偏度日度样本 ${richness.n}/${SKEW_HISTORY_MIN_DAYS} 天，不足以判断 30D 偏度相对自身历史的贵贱。`
    : `30D RR 处于本地 ${richness.n} 日样本的 ${richness.percentile}% 分位${richness.verdict === 'put_rich' ? '（Put 侧相对历史偏贵）' : richness.verdict === 'call_rich' ? '（Call 侧相对历史偏贵）' : '（处于历史常态）'}。`;

  // 交易倾向：需要"偏度贵"与"实现机制不支持较贵一翼"同时成立
  const sellsRichWing = realizedRegime.ratio !== null && realizedRegime.key !== 'jumpy';
  let institutionalAction;
  if (richness.verdict === 'put_rich' && sellsRichWing) {
    institutionalAction = '【偏度交易倾向】Put 侧相对历史偏贵，且实现机制不支持持有 OTM Put 回本：可考虑牛市风险逆转（卖 25Δ Put、买 25Δ Call）做空偏斜，收取 Skew Theta。该组合 Vega 近似中性但 Delta 为正、Vanna 为空，下跌加速时亏损会放大；只想交易偏斜需用永续对冲 Delta。';
  } else if (richness.verdict === 'call_rich' && sellsRichWing) {
    institutionalAction = '【偏度交易倾向】Call 侧相对历史偏贵，且实现机制不支持持有 OTM Call 回本：可考虑熊市风险逆转（卖 25Δ Call、买 25Δ Put）或备兑看涨收取上行溢价；Delta 为负，需按观点决定是否对冲。';
  } else if (richness.verdict === 'insufficient_history') {
    institutionalAction = '【偏度交易倾向】偏度贵贱尚无历史基准，暂不建议据偏斜方向开风险逆转；可先参考实现机制判断持有哪一翼更吃亏。';
  } else {
    institutionalAction = '【偏度交易倾向】偏度相对历史与实现机制没有形成一致的错价信号，方向性需求用垂直价差表达即可。';
  }

  const near = sentimentOf([d1, d7]);
  const mid = sentimentOf([d30, d90]);
  const far = sentimentOf([d180, d365]);
  const fmt = v => (v === null ? '--' : fmtSkew(v));
  const paragraph = `当下 Bitcoin 25Δ 风险逆转（Call − Put）期限结构：短端 1D ${fmt(d1)} / 7D ${fmt(d7)}【${near}】，中端 30D ${fmt(d30)} / 90D ${fmt(d90)}【${mid}】，远端 180D ${fmt(d180)} / 365D ${fmt(d365)}【${far}】。${termText}${regimeText}${richnessText}${institutionalAction}`;

  return {
    latestTimestamp: latest.timestamps,
    d1,
    d7,
    d15,
    d30,
    d60,
    d90,
    d180,
    d365,
    normalized,
    termConsistency,
    realizedRegime,
    richness,
    nearTermSentiment: near,
    midTermSentiment: mid,
    farTermSentiment: far,
    skewRegime: realizedRegime.name,
    skewRegimeKey: realizedRegime.key,
    skewRegimeDesc,
    institutionalAction,
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
  interpolateTotalVariance,
  detectFrontEvent,
  estimateGammaFlip,
  estimateSpotVolBeta,
  classifySkewRegime,
  calcGreeks,
  parseInstrument,
  parseDeribitExpiry,
  identifyInstitutionalStrategy,
  evaluate0DTEBehavior,
  evaluateTradeAction
};

