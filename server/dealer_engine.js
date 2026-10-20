/**
 * 做市商敞口引擎 (第一阶段：惯例口径)
 *
 * 输入：Deribit get_book_summary_by_currency 全链快照 (option_marks 压缩后的 marks：
 *       markIv / markPrice / underlyingPrice(该到期远期价) / openInterest)，约 800 个合约。
 * 方法：逐合约 Black-76 (r = 0，以到期远期价 F 为标的) 计算 Delta / Gamma / Vanna / Charm，
 *       按做市商持仓符号聚合为 DEX / GEX / VEX / CEX；情景分析一律全链重估，不用泰勒近似。
 *
 * 【惯例口径假设】做市商持仓符号：Call = +1 (做市商多 Call)，Put = −1 (做市商空 Put)，
 *   即 SqueezeMetrics 式假设"客户卖 Call、买 Put"。公开 OI 不区分做市商与客户方向，
 *   BTC 客户买 Call 的情况并不少见，因此所有结论都依赖这个未经验证的假设；
 *   第二阶段再用成交方向修正每个合约的符号。
 *
 * 单位：Deribit BTC 期权 1 张 = 1 BTC，OI 以 BTC 计。
 *   DEX  做市商期权组合 Delta (BTC 与 USD)；做市商若完全对冲，现货/永续对冲仓 = −DEX
 *   GEX  现货 +1% 时 DEX 的变化 (USD)
 *   VEX  全曲面 IV +1 个波动率点时 DEX 的变化 (USD)
 *   CEX  时间流逝 1 天时 DEX 的变化 (USD)
 *   对冲流 = −ΔDEX：正值表示做市商需买入 BTC，负值表示需卖出。
 */

const DAY_MS = 86400000;
const YEAR_DAYS = 365;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const CONVENTION_SIGN = { call: 1, put: -1 };
const SLIDE_RANGE = 0.2;          // 现货滑动 ±20%
const SLIDE_STEP = 0.01;          // 网格步长 1%，变号区间内再二分
const NEAR_TERM_DAYS = 10;        // 近端到期 (含日度合约)
const MIN_SIGMA = 0.01;
const FLIP_NEAR_PCT = 3;           // 翻转位距现货 3% 以内时提示

const STRESS_SCENARIOS = [
  { key: 'crash', label: '下行恐慌共振', spotPct: -3, volPts: 5, days: 0 },
  { key: 'spot_down', label: '现货 −3%（IV 不变）', spotPct: -3, volPts: 0, days: 0 },
  { key: 'squeeze', label: '上行逼空共振', spotPct: 3, volPts: 2, days: 0 },
  { key: 'spot_up', label: '现货 +3%（IV 不变）', spotPct: 3, volPts: 0, days: 0 },
  { key: 'vol_crush', label: '事件落地消波', spotPct: 0, volPts: -5, days: 1 },
  { key: 'decay', label: '时间流逝 1 天', spotPct: 0, volPts: 0, days: 1 }
];

// Abramowitz-Stegun 7.1.26，误差 < 1.5e-7
function normCdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erf = 1 - poly * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

function normPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Black-76 (r = 0)：F 远期价，K 行权价，T 年，sigma 小数
 * price 为每 BTC 名义的 USD 价值；vanna = ∂Δ/∂σ (每 1.00 波动率)；
 * charm = dΔ/dt (日历时间流逝方向，每年) = φ(d1)·d2 / (2T)，Call 与 Put 相同
 */
function black76(F, K, T, sigma, isCall) {
  const sqrtT = Math.sqrt(T);
  const sd = sigma * sqrtT;
  const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * T) / sd;
  const d2 = d1 - sd;
  const pdf = normPdf(d1);
  const nd1 = normCdf(d1);
  const price = isCall ? F * nd1 - K * normCdf(d2) : K * normCdf(-d2) - F * normCdf(-d1);
  return {
    price,
    delta: isCall ? nd1 : nd1 - 1,
    gamma: pdf / (F * sd),
    vanna: -pdf * d2 / sigma,
    charm: pdf * d2 / (2 * T)
  };
}

function parseExpiry(str) {
  const m = /^(\d{1,2})([A-Z]{3})(\d{2})$/.exec(str || '');
  if (!m) return null;
  const month = MONTHS.indexOf(m[2]);
  if (month < 0) return null;
  return Date.UTC(2000 + Number(m[3]), month, Number(m[1]), 8, 0, 0); // Deribit 08:00 UTC 交割
}

/** marks 快照 -> 可计算的合约列表 (剔除已到期、无 OI、IV/远期非法的合约) */
function contractsFromMarks(marks, nowMs) {
  const out = [];
  for (const [name, m] of Object.entries(marks || {})) {
    const parts = name.split('-');
    if (parts.length < 4) continue;
    const [, expiry, strikeStr, type] = parts;
    const expiryMs = parseExpiry(expiry);
    const strike = Number(strikeStr);
    const oi = Number(m?.openInterest);
    const iv = Number(m?.markIv);
    const forward = Number(m?.underlyingPrice);
    if (!expiryMs || !(strike > 0) || !(oi > 0) || !(iv > 0) || !(forward > 0)) continue;
    const T = (expiryMs - nowMs) / (YEAR_DAYS * DAY_MS);
    if (!(T > 0)) continue;
    const isCall = type === 'C';
    if (!isCall && type !== 'P') continue;
    out.push({
      name,
      expiry,
      expiryMs,
      strike,
      isCall,
      oi,
      sigma: iv / 100,
      forward,
      T,
      sign: isCall ? CONVENTION_SIGN.call : CONVENTION_SIGN.put
    });
  }
  return out;
}

/**
 * 在给定情景下重估做市商组合：spotMult 现货倍数 (各到期远期价同比例移动)，
 * volShift 全曲面平移 (小数)，dtDays 时间流逝。剩余期限 ≤ 0 的合约视为已交割、对冲已解除。
 * 返回 BTC 口径的 delta / 1% gamma / 1 点 vanna / 1 天 charm 与权利金调整 Delta。
 */
function evaluateBook(contracts, { spotMult = 1, volShift = 0, dtDays = 0 } = {}) {
  let delta = 0;
  let deltaPremAdj = 0;
  let gamma1pct = 0;
  let vannaPt = 0;
  let charmDay = 0;
  for (const c of contracts) {
    const T = c.T - dtDays / YEAR_DAYS;
    if (T <= 0) continue;
    const F = c.forward * spotMult;
    const sigma = Math.max(MIN_SIGMA, c.sigma + volShift);
    const g = black76(F, c.strike, T, sigma, c.isCall);
    const pos = c.sign * c.oi;
    delta += pos * g.delta;
    // 币本位权利金调整 Delta：Δ* = Δ − V/F (期权价值本身以 BTC 计价)
    deltaPremAdj += pos * (g.delta - g.price / F);
    gamma1pct += pos * g.gamma * F * 0.01;
    vannaPt += pos * g.vanna * 0.01;
    charmDay += pos * g.charm / YEAR_DAYS;
  }
  return { delta, deltaPremAdj, gamma1pct, vannaPt, charmDay };
}

/** 现货滑动 GEX 曲线 (USD / 1%)，曲面按黏性行权价 (各合约 IV 不变) */
function gexAt(contracts, spot, mult) {
  return evaluateBook(contracts, { spotMult: mult }).gamma1pct * spot * mult;
}

/**
 * 真正的零 Gamma 翻转位：在 ±20% 网格上重估全链 GEX，变号区间内二分求根，取离现货最近的一个
 */
function spotSlide(contracts, spot) {
  const curve = [];
  const steps = Math.round(SLIDE_RANGE / SLIDE_STEP);
  for (let i = -steps; i <= steps; i++) {
    const mult = 1 + i * SLIDE_STEP;
    const book = evaluateBook(contracts, { spotMult: mult });
    curve.push({
      mult: Number(mult.toFixed(4)),
      price: Math.round(spot * mult),
      gexUsd: book.gamma1pct * spot * mult,
      dexUsd: book.delta * spot * mult
    });
  }

  const flips = [];
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1];
    const b = curve[i];
    if (a.gexUsd === 0 || Math.sign(a.gexUsd) === Math.sign(b.gexUsd)) continue;
    let lo = a.mult;
    let hi = b.mult;
    let gLo = a.gexUsd;
    for (let k = 0; k < 30; k++) {
      const mid = (lo + hi) / 2;
      const gMid = gexAt(contracts, spot, mid);
      if (Math.sign(gMid) === Math.sign(gLo)) { lo = mid; gLo = gMid; } else { hi = mid; }
    }
    const mult = (lo + hi) / 2;
    flips.push({
      price: Math.round(spot * mult),
      distancePct: Number(((mult - 1) * 100).toFixed(2)),
      from: Math.sign(a.gexUsd),
      to: Math.sign(b.gexUsd)
    });
  }
  const nearest = flips.length
    ? flips.reduce((best, f) => (Math.abs(f.distancePct) < Math.abs(best.distancePct) ? f : best))
    : null;
  return { curve, flips, gammaFlip: nearest };
}

function isMonthEnd(expiryMs) {
  const d = new Date(expiryMs);
  const next = new Date(expiryMs + 7 * DAY_MS);
  return d.getUTCDay() === 5 && next.getUTCMonth() !== d.getUTCMonth();
}

/**
 * 到期脱落：每个到期日的 OI 占比、做市商 Delta/Gamma，以及交割后解除对冲带来的流量。
 * 做市商对冲仓 = −D_e；交割时期权 Delta 消失，需反向平掉对冲仓，即交易 +D_e。
 * 用当前 Delta 估计 (临近交割时实值合约 Delta 会趋向 ±1，估计会随之变化)。
 */
function expiryRollOff(contracts, spot, nowMs) {
  const totalOi = contracts.reduce((acc, c) => acc + c.oi, 0);
  const byExpiry = new Map();
  for (const c of contracts) {
    if (!byExpiry.has(c.expiry)) byExpiry.set(c.expiry, []);
    byExpiry.get(c.expiry).push(c);
  }
  const rows = [];
  for (const [expiry, list] of byExpiry) {
    const book = evaluateBook(list);
    const oi = list.reduce((acc, c) => acc + c.oi, 0);
    const expiryMs = list[0].expiryMs;
    const quarter = isMonthEnd(expiryMs) && [2, 5, 8, 11].includes(new Date(expiryMs).getUTCMonth());
    rows.push({
      expiry,
      expiryDate: new Date(expiryMs).toISOString().slice(0, 10),
      dte: Number(((expiryMs - nowMs) / DAY_MS).toFixed(2)),
      kind: quarter ? '季度' : (isMonthEnd(expiryMs) ? '月度' : (new Date(expiryMs).getUTCDay() === 5 ? '周度' : '日度')),
      oiBtc: Number(oi.toFixed(1)),
      oiShare: totalOi > 0 ? Number((oi / totalOi * 100).toFixed(1)) : 0,
      dealerDeltaUsd: book.delta * spot,
      gexUsd: book.gamma1pct * spot,
      rollOffFlowUsd: book.delta * spot
    });
  }
  rows.sort((a, b) => a.dte - b.dte);
  return { totalOiBtc: Number(totalOi.toFixed(1)), expiries: rows };
}

/** 压力情景：全链重估得到对冲流，同时给出 Gamma / Vanna / Charm 一阶分解便于解释 */
function stressMatrix(contracts, spot, base) {
  return STRESS_SCENARIOS.map(sc => {
    const mult = 1 + sc.spotPct / 100;
    const book = evaluateBook(contracts, { spotMult: mult, volShift: sc.volPts / 100, dtDays: sc.days });
    const flowUsd = -(book.delta - base.delta) * spot * mult;
    return {
      ...sc,
      flowUsd,
      flowBtc: -(book.delta - base.delta),
      approx: {
        gammaUsd: -base.gamma1pct * sc.spotPct * spot,
        vannaUsd: -base.vannaPt * sc.volPts * spot,
        charmUsd: -base.charmDay * sc.days * spot
      }
    };
  });
}

/** 单位持仓 (符号 +1) 的 GEX，用于按 Gamma 加权统计 */
function unitGexUsd(c, spot) {
  return evaluateBook([{ ...c, oi: 1, sign: 1 }]).gamma1pct * spot;
}

/**
 * 大宗校正：30 天大宗成交按合约求客户净买入量 (主动方视为客户)，覆盖部分的做市商符号取客户方向的反面，
 * 覆盖量封顶为该合约 OI，未覆盖部分沿用惯例符号。
 * 局限：主动方不一定是客户；30 天净卖出可能是平掉旧多头而非新开空头；更早开的持仓无法覆盖。
 */
function applyBlockFlow(contracts, blockTrades, spot) {
  const net = new Map();
  let tradeCount = 0;
  for (const t of blockTrades || []) {
    const amt = Number(t?.amount);
    if (!t?.instrument_name || !(amt > 0) || (t.direction !== 'buy' && t.direction !== 'sell')) continue;
    tradeCount++;
    net.set(t.instrument_name, (net.get(t.instrument_name) || 0) + (t.direction === 'buy' ? amt : -amt));
  }

  const adjusted = [];
  let oiAll = 0;
  let oiCov = 0;
  let gAll = 0;
  let gCov = 0;
  let gAgree = 0;
  let netCallBtc = 0;
  let netPutBtc = 0;
  for (const c of contracts) {
    const n = net.get(c.name) || 0;
    const cov = Math.min(Math.abs(n), c.oi);
    const g = unitGexUsd(c, spot);
    oiAll += c.oi;
    gAll += g * c.oi;
    if (c.isCall) netCallBtc += n; else netPutBtc += n;
    if (cov > 0) {
      const sign = n > 0 ? -1 : 1;
      adjusted.push({ ...c, oi: cov, sign });
      oiCov += cov;
      gCov += g * cov;
      if (sign === c.sign) gAgree += g * cov;
    }
    if (c.oi - cov > 0) adjusted.push({ ...c, oi: c.oi - cov });
  }
  return {
    contracts: adjusted,
    coverage: {
      tradeCount,
      oiShare: oiAll > 0 ? Number((oiCov / oiAll * 100).toFixed(1)) : 0,
      gammaShare: gAll > 0 ? Number((gCov / gAll * 100).toFixed(1)) : 0,
      agreeShare: gCov > 0 ? Number((gAgree / gCov * 100).toFixed(1)) : null,
      netCallBtc: Number(netCallBtc.toFixed(1)),
      netPutBtc: Number(netPutBtc.toFixed(1))
    }
  };
}

/**
 * 翻号阈值：惯例口径净 GEX 为正时，要把多少比例的 Call 侧 Gamma 改划为"客户买入 (做市商空)"才会归零；
 * 为负时，要把多少比例的 Put 侧 Gamma 改划为"客户卖出 (做市商多)"。比例 = |净值| / (2 × 同号一侧 Gamma)，恒 ≤ 50%。
 */
function flipThreshold(contracts, spot) {
  let callG = 0;
  let putG = 0;
  for (const c of contracts) {
    const g = unitGexUsd(c, spot) * c.oi;
    if (c.isCall) callG += g; else putG += g;
  }
  const net = callG * CONVENTION_SIGN.call + putG * CONVENTION_SIGN.put;
  const side = net >= 0 ? 'call' : 'put';
  const sideGamma = side === 'call' ? callG : putG;
  const share = sideGamma > 0 ? Math.abs(net) / (2 * sideGamma) : null;
  return {
    side,
    sharePct: share === null ? null : Number((share * 100).toFixed(1)),
    callGammaUsd: callG,
    putGammaUsd: putG,
    netShareOfGrossPct: callG + putG > 0 ? Number((Math.abs(net) / (callG + putG) * 100).toFixed(1)) : null
  };
}

const SCREEN_WEIGHTS = [0, 0.25, 0.5, 0.75, 1];
const LEDGER_STALE_MS = 3 * DAY_MS;

/**
 * 全成交校正：每个合约从上市起的客户净买入 = 大宗 + 强平 + 屏幕 × screenWeight (台账见 option_flow_ledger.js)，
 * 覆盖量封顶为 OI，覆盖部分的做市商符号取客户方向的反面，其余沿用惯例。
 * OI 封顶自检：理论上 |客户净持仓| ≤ OI，超出说明"主动方≈客户"失真 (做市商主动吃单、客户挂单)。
 */
function applyFlowLedger(contracts, ledger, spot, screenWeight = 1, nowMs = Date.now()) {
  const rows = ledger?.instruments || {};
  const adjusted = [];
  let oiAll = 0;
  let oiCov = 0;
  let gAll = 0;
  let gCov = 0;
  let gAgree = 0;
  let oiNoRow = 0;
  let flowCount = 0;
  let overCapCount = 0;
  let gFlow = 0;
  let gOverCap = 0;
  let absNet = 0;
  let excess = 0;
  let netCallBtc = 0;
  let netPutBtc = 0;
  const gross = { screen: 0, block: 0, liq: 0 };
  for (const c of contracts) {
    const g = unitGexUsd(c, spot);
    oiAll += c.oi;
    gAll += g * c.oi;
    const row = rows[c.name];
    if (!row) {
      oiNoRow += c.oi;
      adjusted.push(c);
      continue;
    }
    gross.screen += row[3];
    gross.block += row[4];
    gross.liq += row[5];
    const net = row[1] + row[2] + screenWeight * row[0];
    if (c.isCall) netCallBtc += net; else netPutBtc += net;
    if (net !== 0) {
      flowCount++;
      gFlow += g * c.oi;
      absNet += Math.abs(net);
      if (Math.abs(net) > c.oi) {
        overCapCount++;
        gOverCap += g * c.oi;
        excess += Math.abs(net) - c.oi;
      }
    }
    const cov = Math.min(Math.abs(net), c.oi);
    if (cov > 0) {
      const sign = net > 0 ? -1 : 1;
      adjusted.push({ ...c, oi: cov, sign });
      oiCov += cov;
      gCov += g * cov;
      if (sign === c.sign) gAgree += g * cov;
    }
    if (c.oi - cov > 0) adjusted.push({ ...c, oi: c.oi - cov });
  }
  const grossAll = gross.screen + gross.block + gross.liq;
  const pct = (a, b) => (b > 0 ? Number((a / b * 100).toFixed(1)) : 0);
  const syncedThrough = Number(ledger?.syncedThrough) || null;
  return {
    contracts: adjusted,
    coverage: {
      source: 'ledger',
      screenWeight,
      syncedThrough: syncedThrough ? new Date(syncedThrough).toISOString() : null,
      stale: !syncedThrough || nowMs - syncedThrough > LEDGER_STALE_MS,
      oiShare: pct(oiCov, oiAll),
      gammaShare: pct(gCov, gAll),
      agreeShare: gCov > 0 ? pct(gAgree, gCov) : null,
      noLedgerOiShare: pct(oiNoRow, oiAll),
      volumeMix: { screen: pct(gross.screen, grossAll), block: pct(gross.block, grossAll), liq: pct(gross.liq, grossAll) },
      capCheck: {
        flowInstruments: flowCount,
        overCapInstruments: overCapCount,
        overCapGammaShare: pct(gOverCap, gFlow),
        overshootPct: pct(excess, absNet)
      },
      netCallBtc: Number(netCallBtc.toFixed(1)),
      netPutBtc: Number(netPutBtc.toFixed(1))
    }
  };
}

function scenarioOf(key, label, book, spot, withCurve = false) {
  const gexUsd = evaluateBook(book).gamma1pct * spot;
  const slide = spotSlide(book, spot);
  const out = {
    key,
    label,
    gexUsd,
    regime: gexUsd > 0 ? 'long_gamma' : 'short_gamma',
    gammaFlip: slide.gammaFlip
  };
  // 现货滑动曲线只给惯例与全成交校正两条，供前端画图
  if (withCurve) out.curve = slide.curve.map(p => ({ price: p.price, gexUsd: p.gexUsd, dexUsd: p.dexUsd }));
  return out;
}

const sameSign = list => {
  const signs = new Set(list.map(s => Math.sign(s.gexUsd)));
  return signs.size === 1 && !signs.has(0);
};

/**
 * 符号敏感性：同一份全链快照在不同持仓符号口径下的净 GEX 与翻转位。
 *   convention       惯例：做市商多 Call、空 Put
 *   otm_call_bought  虚值 Call (行权价高于到期远期价) 改为客户买入、做市商空，其余惯例
 *   flow_adjusted    全成交校正 (台账可用时)，另给屏幕成交折扣系数 0 ~ 1 的敏感性
 *   block_adjusted   台账不可用时退回 30 天大宗校正
 * robust：所有口径 (含各折扣系数) 净 GEX 同号；flowRobust：订单流口径内部 (各折扣系数) 同号。
 */
function signSensitivity(contracts, spot, { ledger = null, blockTrades = null, now = Date.now() } = {}) {
  const scenarios = [
    scenarioOf('convention', '惯例（做市商多 Call、空 Put）', contracts, spot, true),
    scenarioOf('otm_call_bought', '虚值 Call 客户买入',
      contracts.map(c => (c.isCall && c.strike > c.forward ? { ...c, sign: -1 } : c)), spot)
  ];
  let coverage = null;
  let screenWeights = [];
  let flowBook = null;
  if (ledger && ledger.instruments && Object.keys(ledger.instruments).length) {
    const full = applyFlowLedger(contracts, ledger, spot, 1, now);
    coverage = full.coverage;
    scenarios.push(scenarioOf('flow_adjusted', '全成交校正（上市以来）', full.contracts, spot, true));
    flowBook = full.contracts;
    screenWeights = SCREEN_WEIGHTS.map(w => {
      const adj = w === 1 ? full : applyFlowLedger(contracts, ledger, spot, w, now);
      return { screenWeight: w, ...scenarioOf(`flow_w${w}`, `屏幕成交折扣 ${w}`, adj.contracts, spot), coverageGammaShare: adj.coverage.gammaShare };
    });
  } else if (Array.isArray(blockTrades) && blockTrades.length) {
    const adj = applyBlockFlow(contracts, blockTrades, spot);
    coverage = { source: 'block_trades', ...adj.coverage };
    scenarios.push(scenarioOf('block_adjusted', '30 天大宗校正（台账不可用）', adj.contracts, spot));
  }
  const result = {
    scenarios,
    screenWeights,
    robust: sameSign([...scenarios, ...screenWeights]),
    flowRobust: screenWeights.length ? sameSign(screenWeights) : null,
    threshold: flipThreshold(contracts, spot),
    coverage
  };
  // 全成交校正后的合约账本，供主口径的情景与状态判定使用；不可枚举，不进入 API 输出
  Object.defineProperty(result, 'flowBook', { value: flowBook, enumerable: false });
  return result;
}

const fmtUsdM = v => `${v >= 0 ? '+' : '-'}$${Math.abs(v / 1e6).toFixed(1)}M`;
const fmtAbsUsdM = v => `$${Math.abs(v / 1e6).toFixed(1)}M`;
const flowWord = v => (v >= 0 ? '买入' : '卖出');
const sideWord = s => (s > 0 ? '正' : '负');

/**
 * 过去 hours 小时已触发的对冲流：用当前账本 (OI 视为不变) 回到 hours 小时前的现货、DVOL 与剩余期限重估 Delta，
 * 对冲流 = −(DEX_now − DEX_then)。期间已交割合约的解除对冲不在其中。
 */
function realizedFlow(book, spot, recent) {
  if (!book || !recent) return null;
  const { spotNow, spotThen, dvolNow, dvolThen, hours } = recent;
  if (![spotNow, spotThen, dvolNow, dvolThen, hours].every(Number.isFinite) || !(spotNow > 0) || !(spotThen > 0)) return null;
  const dvolChange = dvolNow - dvolThen;
  const now = evaluateBook(book);
  const then = evaluateBook(book, { spotMult: spotThen / spotNow, volShift: -dvolChange / 100, dtDays: -hours / 24 });
  const spotPct = (spotNow / spotThen - 1) * 100;
  return {
    hours,
    spotPct: Number(spotPct.toFixed(2)),
    dvolChange: Number(dvolChange.toFixed(2)),
    flowUsd: -(now.delta - then.delta) * spot,
    approx: {
      gammaUsd: -now.gamma1pct * spotPct * spot,
      vannaUsd: -now.vannaPt * dvolChange * spot,
      charmUsd: -now.charmDay * (hours / 24) * spot
    },
    asOf: recent.asOf || null
  };
}

/**
 * 做市商对冲状态：正 Gamma 为逆周期缓冲；负 Gamma 时看两个压力情景的对冲方向
 * (下行 −3% 且 IV +5 点时卖出 = 助跌；上行 +3% 且 IV +2 点时买入 = 助涨)。
 */
function hedgingState(gexUsd, crashFlowUsd, squeezeFlowUsd) {
  const sellsDown = crashFlowUsd < 0;
  const buysUp = squeezeFlowUsd > 0;
  if (gexUsd > 0) {
    // 当前为正 Gamma，但压力情景跨过翻转位 (或 Vanna 主导) 后对冲方向转为顺势
    if (sellsDown && buysUp) return { key: 'buffer_fragile_both', label: '缓冲态 · 双向破位转加速', desc: '当前正 Gamma，但下跌或上涨 3% 的情景下做市商都转为顺势对冲。' };
    if (sellsDown) return { key: 'buffer_fragile_down', label: '缓冲态 · 下破转助跌', desc: '当前正 Gamma 高抛低吸，但下跌 3% 且 IV 上升的情景下做市商转为卖出。' };
    if (buysUp) return { key: 'buffer_fragile_up', label: '缓冲态 · 上破转助涨', desc: '当前正 Gamma 高抛低吸，但上涨 3% 的情景下做市商转为追买。' };
    return { key: 'buffer', label: '逆周期缓冲态', desc: '正 Gamma：做市商高抛低吸，对冲流抑制波动。' };
  }
  if (sellsDown && buysUp) return { key: 'two_way_accel', label: '双向加速态', desc: '负 Gamma：下跌时被迫卖出、上涨时被迫买入，两个方向都会放大波动。' };
  if (sellsDown) return { key: 'downside_accel', label: '顺周期助跌踩踏高危', desc: '负 Gamma：下跌叠加 IV 上升时做市商被迫卖出，放大下跌。' };
  if (buysUp) return { key: 'upside_squeeze', label: '上行逼空加速态', desc: '负 Gamma：上涨时做市商被迫追买，放大上涨。' };
  return { key: 'mixed', label: '负 Gamma · 情景对冲逆向', desc: '净 Gamma 为负，但两个压力情景下 Vanna/Charm 抵消了 Gamma 的助涨助跌。' };
}

/** 25Δ 偏度信号：优先用偏度相对自身历史的贵贱，历史不足时用 30D RR 绝对值 (≤ −3 / ≥ +2 个波动率点) */
function skewSignal(skew) {
  const verdict = skew?.richness?.verdict;
  if (verdict === 'put_rich') return { side: 'put', extreme: true, basis: '相对历史', d30: skew.d30 };
  if (verdict === 'call_rich') return { side: 'call', extreme: true, basis: '相对历史', d30: skew.d30 };
  const d30 = Number(skew?.d30);
  if (!Number.isFinite(d30)) return { side: null, extreme: false, basis: null, d30: null };
  if (d30 <= -3) return { side: 'put', extreme: true, basis: '绝对值', d30 };
  if (d30 >= 2) return { side: 'call', extreme: true, basis: '绝对值', d30 };
  return { side: d30 < 0 ? 'put' : 'call', extreme: false, basis: verdict === 'normal' ? '相对历史' : '绝对值', d30 };
}

/**
 * 做市商对冲流 vs 盘口深度：压力情景的对冲量占 ±band 买/卖盘深度的比例。
 * 只说明量级：深度来自单一现货场所，做市商多在永续/期货对冲，且对冲随价格逐步执行而非一次性市价成交。
 */
function depthComparison(crashFlowUsd, squeezeFlowUsd, depth) {
  if (!depth || !(depth.bidUsd > 0) || !(depth.askUsd > 0)) return null;
  const sell = crashFlowUsd < 0 ? -crashFlowUsd : 0;
  const buy = squeezeFlowUsd > 0 ? squeezeFlowUsd : 0;
  return {
    venue: depth.venue || 'Coinbase',
    band: depth.band || '±2%',
    asOf: depth.asOf || null,
    bidUsd: depth.bidUsd,
    askUsd: depth.askUsd,
    downsideSellUsd: sell,
    downsideRatioPct: Number((sell / depth.bidUsd * 100).toFixed(1)),
    upsideBuyUsd: buy,
    upsideRatioPct: Number((buy / depth.askUsd * 100).toFixed(1))
  };
}

/**
 * 结构化预警：负 Gamma 状态 + 偏度极端 + Vanna 方向一致时升为高优先级；持仓符号结论不稳健时降一级。
 */
function buildAlerts({ state, vexUsd, skew, robust, depth, crashFlowUsd, squeezeFlowUsd, basisLabel, gammaFlip = null }) {
  const out = [];
  // 翻转位贴近现货：跨过后转为负 Gamma
  if (gammaFlip && Math.abs(gammaFlip.distancePct) <= FLIP_NEAR_PCT) {
    const spotAbove = gammaFlip.distancePct < 0;
    const crossSide = spotAbove ? gammaFlip.from : gammaFlip.to;
    if (crossSide < 0) {
      out.push({
        key: 'flip_proximity',
        level: 'low',
        title: '零 Gamma 翻转位贴近现货',
        detail: `${basisLabel}：翻转位 $${gammaFlip.price.toLocaleString()} 距现货 ${gammaFlip.distancePct >= 0 ? '+' : ''}${gammaFlip.distancePct}%，现货${spotAbove ? '跌破' : '升破'}后做市商转为负 Gamma`
      });
    }
  }
  const downgrade = level => (robust ? level : (level === 'high' ? 'medium' : 'low'));
  const sk = skewSignal(skew);
  const robustNote = robust ? '' : '（持仓符号结论不稳健，已降一级）';
  if (state.key === 'downside_accel' || state.key === 'two_way_accel') {
    const vannaSells = vexUsd > 0; // IV 上升时做市商需卖出
    const level = sk.side === 'put' && sk.extreme && vannaSells ? 'high' : 'medium';
    const depthText = depth ? `，约为 ${depth.venue} ${depth.band} 买盘深度的 ${depth.downsideRatioPct}%` : '';
    out.push({
      key: 'downside_cascade',
      level: downgrade(level),
      title: '下行踩踏加速器',
      detail: `${basisLabel}：做市商负 Gamma，现货 −3% 且 IV +5 点时需卖出 ${fmtAbsUsdM(crashFlowUsd)}${depthText}；`
        + `IV 每升 1 点需${vannaSells ? '卖出' : '买入'} ${fmtAbsUsdM(vexUsd)}；`
        + `25Δ RR ${sk.d30 !== null ? sk.d30.toFixed(2) : '--'}${sk.side === 'put' && sk.extreme ? `（Put 侧极端，${sk.basis}）` : '（Put 侧未到极端）'}${robustNote}`
    });
  }
  if (state.key === 'upside_squeeze' || state.key === 'two_way_accel') {
    const level = sk.side === 'call' && sk.extreme ? 'high' : 'medium';
    const depthText = depth ? `，约为 ${depth.venue} ${depth.band} 卖盘深度的 ${depth.upsideRatioPct}%` : '';
    out.push({
      key: 'upside_squeeze',
      level: downgrade(level),
      title: '上行 Gamma 逼空',
      detail: `${basisLabel}：做市商负 Gamma，现货 +3% 且 IV +2 点时需买入 ${fmtAbsUsdM(squeezeFlowUsd)}${depthText}；`
        + `25Δ RR ${sk.d30 !== null ? sk.d30.toFixed(2) : '--'}${sk.side === 'call' && sk.extreme ? `（Call 侧极端，${sk.basis}）` : ''}${robustNote}`
    });
  }
  return out;
}

/**
 * 惯例口径下，同一到期、同一行权价的 Call 多头 + Put 空头构成合成远期多头 (r = 0 时 Δc − Δp = 1，无 Gamma)。
 * 这部分 Delta 完全由持仓符号假设产生，单独列出，避免把 DEX 水平误读为真实方向敞口。
 */
function syntheticForwardBtc(contracts) {
  const pairs = new Map();
  for (const c of contracts) {
    const key = `${c.expiry}|${c.strike}`;
    const p = pairs.get(key) || { call: 0, put: 0 };
    if (c.isCall) p.call += c.oi; else p.put += c.oi;
    pairs.set(key, p);
  }
  let total = 0;
  for (const p of pairs.values()) total += Math.min(p.call, p.put);
  return total;
}

/**
 * @param {{indexPrice:number, marks:Object, timestamp?:number, stale?:boolean}} snapshot option_marks 快照
 * @param {{now?:number, gexReference?:{totalAllGexM?:number}, flowLedger?:Object, blockTrades?:Array}} [opts]
 *   gexReference 为数据源 GEX 分析结果，用于口径对照；flowLedger 为全成交累计净额台账 (符号敏感性的全成交校正)；
 *   blockTrades 为 30 天大宗成交库，台账不可用时退回大宗校正
 *   recent24h  { hours, spotNow, spotThen, dvolNow, dvolThen } 过去 24 小时变化 (已触发对冲流)
 *   depth      { venue, band, bidUsd, askUsd } 现货盘口深度 (对冲流量级对比)
 *   skew       analyze25DeltaSkew 结果 (预警中的偏度条件)
 */
function analyzeDealerExposure(snapshot, opts = {}) {
  const nowMs = opts.now ?? Date.now();
  const spot = Number(snapshot?.indexPrice);
  if (!snapshot || !(spot > 0)) {
    return { status: 'insufficient_data', summaryText: '缺少 Deribit 全链快照或指数价格，无法计算做市商敞口。' };
  }
  const contracts = contractsFromMarks(snapshot.marks, nowMs);
  if (contracts.length < 10) {
    return { status: 'insufficient_data', summaryText: `可计算的期权合约仅 ${contracts.length} 个（需含 OI、IV 与远期价），无法计算做市商敞口。` };
  }

  const base = evaluateBook(contracts);
  const syntheticBtc = syntheticForwardBtc(contracts);
  const exposures = {
    dexBtc: base.delta,
    dexUsd: base.delta * spot,
    dexPremAdjUsd: base.deltaPremAdj * spot,
    syntheticForwardBtc: syntheticBtc,
    syntheticForwardUsd: syntheticBtc * spot,
    hedgeUsd: -base.delta * spot,
    gexUsd: base.gamma1pct * spot,
    vexUsd: base.vannaPt * spot,
    cexUsd: base.charmDay * spot
  };
  const slide = spotSlide(contracts, spot);
  const rollOff = expiryRollOff(contracts, spot, nowMs);
  const stress = stressMatrix(contracts, spot, base);
  const sensitivity = signSensitivity(contracts, spot, { ledger: opts.flowLedger, blockTrades: opts.blockTrades, now: nowMs });

  // 主口径：台账可用时用全成交校正后的账本，否则用惯例口径
  const flowBook = sensitivity.flowBook;
  const primaryBasis = flowBook ? 'flow_adjusted' : 'convention';
  const primaryLabel = flowBook ? '全成交校正口径' : '惯例口径';
  const primaryBook = flowBook || contracts;
  const primaryBase = flowBook ? evaluateBook(flowBook) : base;
  const primaryExposures = {
    dexUsd: primaryBase.delta * spot,
    gexUsd: primaryBase.gamma1pct * spot,
    vexUsd: primaryBase.vannaPt * spot,
    cexUsd: primaryBase.charmDay * spot
  };
  const primaryStress = flowBook ? stressMatrix(flowBook, spot, primaryBase) : stress;
  const pCrash = primaryStress.find(s => s.key === 'crash');
  const pSqueeze = primaryStress.find(s => s.key === 'squeeze');
  const primaryRobust = flowBook ? sensitivity.flowRobust : sensitivity.robust;
  const state = hedgingState(primaryExposures.gexUsd, pCrash.flowUsd, pSqueeze.flowUsd);
  const realized24h = {
    convention: realizedFlow(contracts, spot, opts.recent24h),
    primary: flowBook ? realizedFlow(primaryBook, spot, opts.recent24h) : null
  };
  const depth = depthComparison(pCrash.flowUsd, pSqueeze.flowUsd, opts.depth);
  const alerts = buildAlerts({
    state,
    vexUsd: primaryExposures.vexUsd,
    skew: opts.skew,
    robust: Boolean(primaryRobust),
    depth,
    crashFlowUsd: pCrash.flowUsd,
    squeezeFlowUsd: pSqueeze.flowUsd,
    basisLabel: primaryLabel,
    gammaFlip: flowBook ? sensitivity.scenarios.find(x => x.key === 'flow_adjusted').gammaFlip : slide.gammaFlip
  });

  const grossGex = rollOff.expiries.reduce((acc, e) => acc + Math.abs(e.gexUsd), 0);
  for (const e of rollOff.expiries) {
    e.gexShare = grossGex > 0 ? Number((Math.abs(e.gexUsd) / grossGex * 100).toFixed(1)) : 0;
  }
  const nearTerm = rollOff.expiries.filter(e => e.dte <= NEAR_TERM_DAYS);
  const nearOiShare = nearTerm.reduce((acc, e) => acc + e.oiShare, 0);
  const nearGexUsd = nearTerm.reduce((acc, e) => acc + e.gexUsd, 0);
  const nextMajor = rollOff.expiries.find(e => e.kind === '月度' || e.kind === '季度') || null;

  const isLongGamma = exposures.gexUsd > 0;
  // 叙述以主口径为准 (台账可用时为全成交校正)，惯例口径数字并列
  const pGex = primaryExposures.gexUsd;
  const pLong = pGex > 0;
  const robustPrefix = primaryRobust
    ? ''
    : (flowBook ? '【结论不稳健：净 GEX 随屏幕成交折扣系数变号】' : '【结论不稳健：净 GEX 随持仓符号口径变号，以下为惯例口径结果】');
  const convNote = flowBook ? `（惯例口径 ${fmtUsdM(exposures.gexUsd)}）` : '';
  const regimeText = robustPrefix + (pLong
    ? `${primaryLabel}净 GEX ${fmtUsdM(pGex)}/1%${convNote}：做市商为正 Gamma，现货每涨 1% 需卖出约 ${fmtAbsUsdM(pGex)} 的 BTC、每跌 1% 需买入，对冲流起减震作用。`
    : `${primaryLabel}净 GEX ${fmtUsdM(pGex)}/1%${convNote}：做市商为负 Gamma，现货每涨 1% 需追买约 ${fmtAbsUsdM(pGex)} 的 BTC、每跌 1% 需追卖，对冲流放大波动。`);

  // 翻转位两侧：低于翻转位为 from 侧，高于为 to 侧
  const flip = slide.gammaFlip;
  const pFlip = flowBook ? sensitivity.scenarios.find(s => s.key === 'flow_adjusted').gammaFlip : flip;
  let flipText;
  if (pFlip) {
    const spotAbove = pFlip.distancePct < 0;
    const crossSide = spotAbove ? pFlip.from : pFlip.to;
    flipText = `按现货滑动全链重估，零 Gamma 翻转位约在 $${pFlip.price.toLocaleString()}（距现货 ${pFlip.distancePct >= 0 ? '+' : ''}${pFlip.distancePct}%）：低于该价位 GEX 为${sideWord(pFlip.from)}、高于为${sideWord(pFlip.to)}，现货${spotAbove ? '跌破' : '升破'}后做市商转为${sideWord(crossSide)} Gamma。`;
  } else {
    flipText = `现货在 ±${SLIDE_RANGE * 100}% 区间内滑动，${primaryLabel}的 GEX 始终${pLong ? '为正' : '为负'}，区间内没有零 Gamma 翻转位。`;
  }

  const vexText = `Vanna：全曲面 IV 每升 1 点，做市商需${flowWord(-primaryExposures.vexUsd)} ${fmtAbsUsdM(primaryExposures.vexUsd)}；Charm：每过 1 天需${flowWord(-primaryExposures.cexUsd)} ${fmtAbsUsdM(primaryExposures.cexUsd)}。`;

  const rollText = nextMajor
    ? `${NEAR_TERM_DAYS} 天内到期的合约占全链 OI ${nearOiShare.toFixed(1)}%（惯例口径 GEX ${fmtUsdM(nearGexUsd)}）；下一个大交割 ${nextMajor.expiry}（${nextMajor.kind}，剩 ${nextMajor.dte} 天）占 OI ${nextMajor.oiShare}%、占全链 Gamma 绝对量 ${nextMajor.gexShare}%，交割后这部分 Gamma 消失。`
    : '';

  const crush = primaryStress.find(s => s.key === 'vol_crush');
  const stressText = `压力情景（${primaryLabel}，全链重估）：现货 −3% 且 IV +5 点时需${flowWord(pCrash.flowUsd)} ${fmtAbsUsdM(pCrash.flowUsd)}；+3% 且 IV +2 点时需${flowWord(pSqueeze.flowUsd)} ${fmtAbsUsdM(pSqueeze.flowUsd)}；IV −5 点并过 1 天时需${flowWord(crush.flowUsd)} ${fmtAbsUsdM(crush.flowUsd)}。IV 情景为全曲面平移，未计偏斜随现货的变形。`;

  let referenceText = '';
  const ref = opts.gexReference;
  if (ref && Number.isFinite(ref.totalAllGexM)) {
    const agree = Math.sign(ref.totalAllGexM) === Math.sign(exposures.gexUsd);
    referenceText = `对照：数据源（Greeks.live）全部到期净 GEX ${fmtUsdM(ref.totalAllGexM * 1e6)}，与自算${agree ? '方向一致' : '方向相反（数据源未公开计算口径与单位，两者共用同一个持仓符号假设）'}。`;
  }

  const syntheticShare = Math.abs(base.delta) > 0 ? syntheticBtc / Math.abs(base.delta) * 100 : 0;
  const assumptionText = `【惯例口径】持仓符号假设做市商多 Call、空 Put（客户卖 Call、买 Put），未用成交方向校正；BTC 客户净买 Call 时，Call 侧实际为做市商负 Gamma，正 Gamma 结论会被高估。该假设下做市商期权 Delta ${fmtUsdM(exposures.dexUsd)}，其中约 ${syntheticShare.toFixed(0)}% 来自同行权价 Call 多 + Put 空构成的合成多头（Delta≈1、无 Gamma），由假设本身产生，DEX 水平与交割解除对冲量只作参考，应看 Gamma / Vanna / Charm 与情景变化量。Greeks 按 Black-76（r = 0、到期远期价、Deribit 标记 IV），对冲流正为做市商买入、负为卖出。`;

  const scenarioText = sensitivity.scenarios
    .map(s => `${s.label} ${fmtUsdM(s.gexUsd)}（${s.gammaFlip ? `翻转位 $${s.gammaFlip.price.toLocaleString()}` : '±20% 内无翻转位'}）`)
    .join('、');
  const th = sensitivity.threshold;
  const thresholdText = th.sharePct === null
    ? ''
    : `惯例口径的净 GEX 只占 Call/Put 总 Gamma 的 ${th.netShareOfGrossPct}%，把${th.side === 'call' ? ' Call 侧约' : ' Put 侧约'} ${th.sharePct}% 的 Gamma 改划为${th.side === 'call' ? '客户买入' : '客户卖出'}即会翻号。`;
  const cov = sensitivity.coverage;
  let coverageText;
  if (cov && cov.source === 'ledger') {
    const cap = cov.capCheck;
    const ws = sensitivity.screenWeights;
    const w0 = ws.find(w => w.screenWeight === 0);
    const w1 = ws.find(w => w.screenWeight === 1);
    coverageText = `全成交校正用各合约上市以来的累计净额（主动方视为客户，强平按被强平方计；截至 ${cov.syncedThrough ? cov.syncedThrough.slice(0, 10) : '--'}${cov.stale ? '，台账已超过 3 天未更新' : ''}），覆盖 OI ${cov.oiShare}%、Gamma ${cov.gammaShare}%，覆盖部分与惯例符号一致 ${cov.agreeShare ?? '--'}%。`
      + `OI 封顶自检：${cap.flowInstruments} 个有成交的合约中 ${cap.overCapInstruments} 个累计净额超过 OI（占这些合约 Gamma 的 ${cap.overCapGammaShare}%，超出量占净额 ${cap.overshootPct}%），超出越多说明"主动方≈客户"越失真。`
      + (w0 && w1 ? `屏幕成交折扣系数从 0（只信大宗与强平）到 1（屏幕主动方全算客户），净 GEX 从 ${fmtUsdM(w0.gexUsd)} 变到 ${fmtUsdM(w1.gexUsd)}，${sensitivity.flowRobust ? '订单流口径内部同号' : '订单流口径内部也会变号'}。` : '')
      + (cov.netCallBtc < 0
        ? `订单流显示客户上市以来累计净卖出 Call ${Math.abs(cov.netCallBtc).toFixed(0)} BTC，与"虚值 Call 客户买入"假设相反，该情景只作压力参照。`
        : `订单流显示客户上市以来累计净买入 Call ${cov.netCallBtc.toFixed(0)} BTC，"虚值 Call 客户买入"情景有现实依据。`)
      + `未被净额覆盖的 OI（${(100 - cov.oiShare).toFixed(1)}%）多为客户之间或做市商之间的对手盘，仍按惯例符号计。`;
  } else if (cov) {
    coverageText = `成交台账不可用，退回 30 天大宗校正：${cov.tradeCount} 笔大宗成交，覆盖 OI ${cov.oiShare}%、Gamma ${cov.gammaShare}%，覆盖部分与惯例符号一致 ${cov.agreeShare ?? '--'}%。`;
  } else {
    coverageText = '缺少成交台账与大宗成交数据，未做订单流校正。';
  }
  const sensitivityText = `【符号敏感性】${scenarioText}，${sensitivity.robust ? '各口径同号，Gamma 方向结论稳健' : '各口径不同号，Gamma 方向结论不稳健'}。${thresholdText}${coverageText}`;

  const alertText = alerts.length
    ? alerts.map(a => `【${a.level === 'high' ? '高优先级预警' : (a.level === 'medium' ? '预警' : '提示')}·${a.title}】${a.detail}。`).join('')
    : '';
  const stateText = `【对冲状态·${primaryLabel}】${state.label}：${state.desc}${primaryRobust ? '' : '（持仓符号结论不稳健）'}`;
  const rp = realized24h.primary || realized24h.convention;
  const realizedText = rp
    ? `过去 ${rp.hours} 小时现货 ${rp.spotPct >= 0 ? '+' : ''}${rp.spotPct}%、DVOL ${rp.dvolChange >= 0 ? '+' : ''}${rp.dvolChange} 点，按${realized24h.primary ? primaryLabel : '惯例口径'}估计做市商已被动${flowWord(rp.flowUsd)} ${fmtAbsUsdM(rp.flowUsd)}（Gamma ${fmtUsdM(rp.approx.gammaUsd)}、Vanna ${fmtUsdM(rp.approx.vannaUsd)}、Charm ${fmtUsdM(rp.approx.charmUsd)}，OI 视为不变）。`
    : '';
  const depthText = depth
    ? `对冲流与盘口深度：${primaryLabel}下行情景需卖出 ${fmtAbsUsdM(depth.downsideSellUsd)}，为 ${depth.venue} ${depth.band} 买盘深度的 ${depth.downsideRatioPct}%；上行情景需买入 ${fmtAbsUsdM(depth.upsideBuyUsd)}，为卖盘深度的 ${depth.upsideRatioPct}%（单一现货场所，做市商多在永续/期货上分批对冲，比值只说明量级）。`
    : '';

  const paragraph = `${alertText}${stateText}${regimeText}${flipText}${realizedText}${depthText}${sensitivityText}${vexText}${rollText}${stressText}${referenceText}${assumptionText}`;

  return {
    status: 'ok',
    convention: 'dealer_long_calls_short_puts',
    asOf: snapshot.timestamp ? new Date(snapshot.timestamp).toISOString() : null,
    stale: Boolean(snapshot.stale),
    spot,
    contractCount: contracts.length,
    totalOiBtc: rollOff.totalOiBtc,
    exposures,
    regime: isLongGamma ? 'long_gamma' : 'short_gamma',
    primaryRegime: primaryExposures.gexUsd > 0 ? 'long_gamma' : 'short_gamma',
    robust: sensitivity.robust,
    sensitivity,
    gammaFlip: flip,
    gammaFlips: slide.flips,
    slideCurve: slide.curve,
    nearTermDays: NEAR_TERM_DAYS,
    nearTermOiShare: Number(nearOiShare.toFixed(1)),
    nearTermGexUsd: nearGexUsd,
    expiries: rollOff.expiries,
    nextMajorExpiry: nextMajor,
    stress,
    primaryBasis,
    primaryExposures,
    primaryStress,
    primaryRobust,
    state,
    alerts,
    realized24h,
    depth,
    paragraph
  };
}

module.exports = {
  CONVENTION_SIGN,
  STRESS_SCENARIOS,
  black76,
  contractsFromMarks,
  evaluateBook,
  spotSlide,
  expiryRollOff,
  stressMatrix,
  applyBlockFlow,
  flipThreshold,
  signSensitivity,
  applyFlowLedger,
  realizedFlow,
  hedgingState,
  skewSignal,
  depthComparison,
  buildAlerts,
  SCREEN_WEIGHTS,
  analyzeDealerExposure
};
