/**
 * 大宗结构的 markout 评估 —— 取代「胜率」作为聪明钱的检验口径
 *
 * 每个登记结构在成交后 +1 天 / +7 天的 08:00 UTC 快照 (server/option_marks_history.js) 上按 mark 估值：
 *   总盈亏 (USD) = Σ 期权腿 sign × 张数 × (mark_D × S_D − 成交价 × S_0) + 期货 / 永续对冲腿盈亏
 *   方向部分     = 成交时含对冲的净 Delta (BTC) × (S_D − S_0)
 *   波动率部分   = 总盈亏 − 方向部分 (静态 Delta 对冲后的盈亏)，再除以成交时的总 Vega (各腿 |Vega| 之和) 折成波动率点
 *   —— 用总 Vega 而不是净 Vega：日历价差、风险逆转等结构净 Vega 接近 0，除下来会被放大成几百个点
 * mark 观测早于收盘时：用观测时的 mark 反推隐含波动率，再按收盘指数重新定价 (消除时滞期间的币价变动)；
 * 到期日早于估值日的期权腿按交割价的内在价值计。
 *
 * 统计：同一天的结构共享同一段行情，不是独立样本 —— 先按成交日求均值，再在「日」之间求均值与 t 值 (按日聚类)；
 * 单笔取值先截尾到 5% / 95% 分位，避免近到期小 Vega 结构的极端值主导均值。
 * 方向家族 (看多 / 看空) 的主指标是总盈亏 (占名义额 bp)；波动率家族的主指标是波动率部分 (波动率点)。
 */

const { parseInstrument, parseDeribitExpiry } = require('./analytics_engine');
const marksHistory = require('./option_marks_history');

const DAY_MS = 86400000;
const YEAR_MS = 365.25 * DAY_MS;
const HORIZONS = [1, 7];
const MAX_STALE_DAYS = 2;
const MIN_COVERAGE = 0.9;          // 按张数计至少 90% 的期权腿有 mark 才给出该期的 markout
const STAR_MIN_T = 2;
const STAR_MIN_DAYS = 15;
const WINSOR = 0.05;               // 截尾到 5% / 95% 分位

function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

/** Black-76 (USD)，F 取指数价，不计利率 */
function bsUSD(F, K, T, sigma, isCall) {
  if (T <= 0 || sigma <= 0) return Math.max(isCall ? F - K : K - F, 0);
  const sd = sigma * Math.sqrt(T);
  const d1 = (Math.log(F / K) + 0.5 * sd * sd) / sd;
  const d2 = d1 - sd;
  return isCall ? F * normCdf(d1) - K * normCdf(d2) : K * normCdf(-d2) - F * normCdf(-d1);
}

/** 由价格反推隐含波动率 (二分)；价格低于内在价值或高于上界时返回 null */
function impliedVol(priceUSD, F, K, T, isCall) {
  const intrinsic = Math.max(isCall ? F - K : K - F, 0);
  if (!(T > 0) || !(priceUSD > intrinsic + 1e-9)) return null;
  let lo = 0.01;
  let hi = 5;
  if (bsUSD(F, K, T, hi, isCall) < priceUSD) return null;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (bsUSD(F, K, T, mid, isCall) > priceUSD) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

/**
 * 一条期权腿在快照日 day 的 USD 价值 (每张)。
 * @returns {null|{usd: number, staleDays: number, settled: boolean}}
 */
function legValueUSD(leg, day, history, delivery) {
  const inst = parseInstrument(leg.instrument);
  if (!inst) return null;
  const expMs = parseDeribitExpiry(inst.expiryStr)?.getTime();
  const closeTs = marksHistory.closeTsOf(day);
  if (Number.isFinite(expMs) && expMs <= closeTs) {
    const D = delivery[new Date(expMs).toISOString().slice(0, 10)];
    if (!(D > 0)) return null;
    return { usd: Math.max(inst.isCall ? D - inst.strike : inst.strike - D, 0), staleDays: 0, settled: true };
  }
  const m = marksHistory.markAt(history, leg.instrument, day, { maxStaleDays: MAX_STALE_DAYS });
  const S = history[day]?.index;
  if (!m || !(S > 0)) return null;
  let usd = m.mark * S;
  if (m.indexAtObs > 0 && Number.isFinite(expMs)) {
    const iv = impliedVol(m.mark * m.indexAtObs, m.indexAtObs, inst.strike, (expMs - m.observedTs) / YEAR_MS, inst.isCall);
    if (iv) usd = bsUSD(S, inst.strike, (expMs - closeTs) / YEAR_MS, iv, inst.isCall);
  }
  return { usd, staleDays: m.staleDays, settled: false };
}

/** 结构成交时的总 Vega (USD / 1 个波动率点)：由成交价反推各腿隐含波动率 */
function grossVegaUSD(s) {
  const S0 = Number(s.entrySpot);
  if (!(S0 > 0)) return null;
  let total = 0;
  for (const leg of s.legs || []) {
    const inst = parseInstrument(leg.instrument);
    const expMs = inst ? parseDeribitExpiry(inst.expiryStr)?.getTime() : null;
    if (!inst || !Number.isFinite(expMs)) continue;
    const T = (expMs - s.ts) / YEAR_MS;
    if (!(T > 0)) continue;
    const iv = impliedVol(Number(leg.price) * S0, S0, inst.strike, T, inst.isCall) || 0.5;
    const sd = iv * Math.sqrt(T);
    const d1 = (Math.log(S0 / inst.strike) + 0.5 * sd * sd) / sd;
    const vega = S0 * Math.sqrt(T) * Math.exp(-d1 * d1 / 2) / Math.sqrt(2 * Math.PI) * 0.01;
    total += Math.abs(Number(leg.amount) || 0) * vega;
  }
  return total > 0 ? total : null;
}

/** 期货 / 永续对冲腿在指数 S1 时的盈亏 (USD)；反向合约 amount 为美元面值，线性合约为 BTC */
function hedgePnlUSD(h, S1) {
  const sign = h.direction === 'buy' ? 1 : -1;
  const P0 = Number(h.price);
  if (!(P0 > 0) || !(S1 > 0)) return 0;
  if (/_(USDC|USDT)/.test(h.instrument)) return sign * Number(h.amount) * (S1 - P0);
  return sign * Number(h.amount) * (1 / P0 - 1 / S1) * S1;
}

/** 一个结构在 +h 天的 markout；数据不足时返回 null */
function markoutAt(s, h, history, delivery) {
  const day = marksHistory.closeDayOf(s.ts + h * DAY_MS);
  const S1 = history[day]?.index;
  const S0 = Number(s.entrySpot);
  if (!(S1 > 0) || !(S0 > 0)) return null;
  let total = 0;
  let covered = 0;
  let amount = 0;
  let maxStale = 0;
  for (const leg of s.legs) {
    const amt = Number(leg.amount) || 0;
    amount += amt;
    const v = legValueUSD(leg, day, history, delivery);
    if (!v) continue;
    covered += amt;
    maxStale = Math.max(maxStale, v.staleDays);
    const sign = leg.direction === 'buy' ? 1 : -1;
    total += sign * amt * (v.usd - Number(leg.price) * S0);
  }
  if (!amount || covered / amount < MIN_COVERAGE) return null;
  // 缺 mark 的少量腿按已覆盖部分等比放大，避免系统性低估
  total *= amount / covered;
  for (const hg of s.hedges || []) total += hedgePnlUSD(hg, S1);
  const deltaBTC = (Number(s.netDeltaUSD) || 0) / S0;
  const directional = deltaBTC * (S1 - S0);
  const vol = total - directional;
  const vega = grossVegaUSD(s);
  const r = v => Math.round(v * 100) / 100;
  return {
    day,
    spotMove: r((S1 / S0 - 1) * 1e4) / 1e4,
    totalUSD: Math.round(total),
    totalBps: r(total / (Number(s.notionalUSD) || 1) * 1e4),
    directionalUSD: Math.round(directional),
    volUSD: Math.round(vol),
    volPoints: vega > 0 ? r(vol / vega) : null,
    grossVegaUSD: vega ? Math.round(vega) : null,
    coverage: r(covered / amount),
    maxStaleDays: maxStale
  };
}

/**
 * 为登记表里的每个结构补算 markout (只补已有快照覆盖的期限；已算过的不重算)。
 * @returns {{registry: Array, computed: number}}
 */
function computeMarkouts(registry, history, delivery, { recompute = false } = {}) {
  const lastDay = Object.keys(history).sort().pop();
  let computed = 0;
  const out = registry.map(s => {
    const mk = { ...(s.markouts || {}) };
    let changed = false;
    for (const h of HORIZONS) {
      const key = `d${h}`;
      if (mk[key] && !recompute) continue;
      const day = marksHistory.closeDayOf(s.ts + h * DAY_MS);
      if (!lastDay || day > lastDay) continue;
      const m = markoutAt(s, h, history, delivery);
      if (m) {
        mk[key] = m;
        computed++;
        changed = true;
      }
    }
    return changed ? { ...s, markouts: mk } : s;
  });
  return { registry: out, computed };
}

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];

/**
 * 按成交日聚类的均值与 t 值。winsor > 0 时先把单笔取值截到 [winsor, 1 − winsor] 分位
 * (近到期、Vega 很小的结构会产生极端的波动率点，不能让几笔离群值决定均值)；同时给出未截尾的中位数。
 */
function clusteredStats(values, { winsor = 0 } = {}) {
  const finite = values.filter(x => Number.isFinite(x.v));
  const sorted = finite.map(x => x.v).sort((a, b) => a - b);
  const lo = winsor > 0 && sorted.length >= 20 ? quantile(sorted, winsor) : -Infinity;
  const hi = winsor > 0 && sorted.length >= 20 ? quantile(sorted, 1 - winsor) : Infinity;
  const byDay = new Map();
  for (const x of finite) {
    const day = x.day;
    const v = Math.min(hi, Math.max(lo, x.v));
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(v);
  }
  const dayMeans = [...byDay.values()].map(a => a.reduce((s, x) => s + x, 0) / a.length);
  const n = values.filter(x => Number.isFinite(x.v)).length;
  const k = dayMeans.length;
  if (!k) return { n, days: 0, mean: null, t: null, hitRate: null };
  const mean = dayMeans.reduce((s, x) => s + x, 0) / k;
  const sd = k > 1 ? Math.sqrt(dayMeans.reduce((s, x) => s + (x - mean) ** 2, 0) / (k - 1)) : null;
  const t = sd > 0 ? mean / (sd / Math.sqrt(k)) : null;
  const hits = finite.filter(x => x.v > 0).length;
  const r = v => (v == null ? null : Math.round(v * 100) / 100);
  return { n, days: k, mean: r(mean), t: r(t), median: sorted.length ? r(quantile(sorted, 0.5)) : null, hitRate: n ? r(hits / n) : null, winsor };
}

const DIRECTIONAL = new Set(['bull', 'bear']);

/**
 * 家族 × 期限的 markout 统计。方向家族主指标 = 总盈亏 bp；波动率家族主指标 = 波动率点。
 * signal：主指标 7 日期限按日聚类 t ≥ 2 且样本日 ≥ 15 时为 'positive'，t ≤ −2 为 'negative'。
 */
function summarizeMarkouts(registry, families) {
  const out = {};
  for (const fam of families) {
    const members = registry.filter(s => s.family === fam);
    const primary = DIRECTIONAL.has(fam) ? 'totalBps' : 'volPoints';
    const horizons = {};
    for (const h of HORIZONS) {
      const key = `d${h}`;
      const rows = members.filter(s => s.markouts && s.markouts[key]);
      const pick = field => rows.map(s => ({ day: new Date(s.ts).toISOString().slice(0, 10), v: s.markouts[key][field] }));
      horizons[key] = {
        primary: clusteredStats(pick(primary), { winsor: WINSOR }),
        totalBps: clusteredStats(pick('totalBps'), { winsor: WINSOR }),
        volPoints: clusteredStats(pick('volPoints'), { winsor: WINSOR })
      };
    }
    const p7 = horizons.d7.primary;
    let signal = 'insufficient';
    if (p7.days >= STAR_MIN_DAYS && p7.t != null) {
      signal = p7.t >= STAR_MIN_T ? 'positive' : (p7.t <= -STAR_MIN_T ? 'negative' : 'not_significant');
    }
    out[fam] = { primaryMetric: primary, horizons, signal };
  }
  return out;
}

module.exports = {
  HORIZONS,
  STAR_MIN_T,
  STAR_MIN_DAYS,
  bsUSD,
  impliedVol,
  legValueUSD,
  hedgePnlUSD,
  grossVegaUSD,
  markoutAt,
  computeMarkouts,
  clusteredStats,
  summarizeMarkouts
};
