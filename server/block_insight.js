/**
 * Module 4B · 大宗资金深度研判 (Block Flow Insight)
 *
 * 方法 4  按天聚合：大宗成交按「OI 日 (UTC 08:00 交割起算) × 到期日 × 行权价 × Call/Put」压成一行，
 *         长期保留 (data/block_flow_daily_BTC.json)，不受 30 天成交库的限制，支撑 3 / 6 个月的判断。
 * 方法 2  期限资金流向：在日聚合上按剩余期限分桶，给出 4 / 12 / 26 周的周度净 Delta 等。
 * 方法 3  行权价热力图：单个到期日的「日期 × 行权价」净成交量、累计净成交量 + 当前 OI、
 *         「墙」以及由大额结构到期盈亏曲线推出的目标区间。
 * 方法 5  聪明钱命中率：≥ 门槛的大额结构登记入册 (data/smart_money_BTC.json)，每天按 Deribit 标记价
 *         估一次主动方盈亏，到期后按交割价结算；按 Delta/Vega 画像分组统计命中率，并据此给信号加权。
 *
 * 持久化与 OI 档案相同：GitHub Actions 每天提交权威文件；服务器用自己的 30 天成交库补上近几天的聚合，
 * 结构登记 / 盯市的本机补采写入 .local.json (gitignored)，读取时合并，仓库提交版优先。
 */

const fs = require('fs');
const path = require('path');
const { fetchWithTimeout } = require('./http_client');
const { calcGreeks, parseInstrument, parseDeribitExpiry } = require('./analytics_engine');
const { dayKey, profileFromItems } = require('./option_oi_history');
const PnLEngine = require('../public/pnl_engine');

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const YEAR_MS = 365.25 * DAY_MS;
const DATA_DIR = path.join(__dirname, '..', 'data');

const DAILY_FILE = path.join(DATA_DIR, 'block_flow_daily_BTC.json');
const SMART_FILE = path.join(DATA_DIR, 'smart_money_BTC.json');
const SMART_LOCAL_FILE = path.join(DATA_DIR, 'smart_money_BTC.local.json');

const STRUCTURE_MIN_NOTIONAL = 30e6;

/** OI 日起点 (UTC 08:00) */
function dayStartMs(key) {
  return Date.parse(`${key}T08:00:00Z`);
}

function instrumentName(expiry, strike, isCall) {
  return `BTC-${expiry}-${strike}-${isCall ? 'C' : 'P'}`;
}

function expiryMsOf(expiry) {
  const d = parseDeribitExpiry(expiry);
  return d ? d.getTime() : null;
}

const round = (v, d = 0) => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};

// ===========================================================================
// 方法 4：按天聚合
// ===========================================================================

/**
 * @param {Array} trades - raw block trades
 * @param {number} coverageStartMs - 数据源最早覆盖时刻：起点之后才开始的 OI 日才算完整
 * @returns {Object<string, {complete: boolean, rows: Array<Object>}>}
 */
function aggregateTrades(trades, coverageStartMs, nowMs = Date.now()) {
  const days = {};
  for (const t of trades || []) {
    const inst = parseInstrument(t.instrument_name || '');
    const expMs = inst && expiryMsOf(inst.expiryStr);
    const S = Number(t.index_price) || 0;
    const amt = Number(t.amount) || 0;
    if (!expMs || !(S > 0) || !(amt > 0) || !Number.isFinite(t.timestamp)) continue;

    const key = dayKey(t.timestamp);
    const day = days[key] || (days[key] = { rows: new Map() });
    const rowKey = `${inst.expiryStr}|${inst.strike}|${inst.isCall ? 'C' : 'P'}`;
    let row = day.rows.get(rowKey);
    if (!row) {
      row = { expiry: inst.expiryStr, strike: inst.strike, isCall: inst.isCall, buyQty: 0, sellQty: 0, netDeltaUSD: 0, netVegaUSD: 0, netPremiumUSD: 0, grossUSD: 0, count: 0 };
      day.rows.set(rowKey, row);
    }
    const T = Math.max(0.0005, (expMs - t.timestamp) / YEAR_MS);
    const g = calcGreeks(S, inst.strike, T, t.iv || 35.0, inst.isCall);
    const sign = t.direction === 'buy' ? 1 : -1;
    if (sign > 0) row.buyQty += amt; else row.sellQty += amt;
    row.netDeltaUSD += sign * g.delta * amt * S;
    row.netVegaUSD += sign * g.vega * amt;
    row.netPremiumUSD += sign * (Number(t.price) || 0) * amt * S;
    row.grossUSD += amt * S;
    row.count++;
  }

  const out = {};
  for (const [key, day] of Object.entries(days)) {
    const start = dayStartMs(key);
    out[key] = {
      complete: start + DAY_MS <= nowMs && coverageStartMs <= start,
      rows: [...day.rows.values()].map(r => ({
        ...r,
        buyQty: round(r.buyQty, 1),
        sellQty: round(r.sellQty, 1),
        netDeltaUSD: round(r.netDeltaUSD),
        netVegaUSD: round(r.netVegaUSD),
        netPremiumUSD: round(r.netPremiumUSD),
        grossUSD: round(r.grossUSD)
      }))
    };
  }
  return out;
}

function encodeDaily(days, currency = 'BTC') {
  const expiries = [];
  const idOf = new Map();
  const encoded = {};
  for (const key of Object.keys(days).sort()) {
    encoded[key] = {
      complete: !!days[key].complete,
      rows: days[key].rows.map(r => {
        if (!idOf.has(r.expiry)) {
          idOf.set(r.expiry, expiries.length);
          expiries.push(r.expiry);
        }
        return [idOf.get(r.expiry), r.strike, r.isCall ? 1 : 0, r.buyQty, r.sellQty, r.netDeltaUSD, r.netVegaUSD, r.netPremiumUSD, r.grossUSD, r.count];
      })
    };
  }
  return { currency, version: 1, dayBoundary: '08:00Z', expiries, days: encoded };
}

function decodeDaily(json) {
  if (!json || !Array.isArray(json.expiries) || !json.days) return {};
  const out = {};
  for (const [key, d] of Object.entries(json.days)) {
    if (!Array.isArray(d.rows)) continue;
    out[key] = {
      complete: !!d.complete,
      rows: d.rows.map(([e, strike, c, buyQty, sellQty, netDeltaUSD, netVegaUSD, netPremiumUSD, grossUSD, count]) => ({
        expiry: json.expiries[e], strike, isCall: c === 1, buyQty, sellQty, netDeltaUSD, netVegaUSD, netPremiumUSD, grossUSD, count
      })).filter(r => r.expiry)
    };
  }
  return out;
}

const tradeCount = d => d.rows.reduce((n, r) => n + r.count, 0);

/** 完整日优先于不完整日；都完整时 primary 优先；都不完整时取成交笔数多的 (更新的那份) */
function mergeDaily(primary, secondary) {
  const out = { ...(secondary || {}) };
  for (const [key, d] of Object.entries(primary || {})) {
    const other = out[key];
    if (!other || (d.complete && !other.complete)) out[key] = d;
    else if (d.complete && other.complete) out[key] = d;
    else if (!d.complete && !other.complete && tradeCount(d) >= tradeCount(other)) out[key] = d;
  }
  return out;
}

// ===========================================================================
// 方法 2：期限资金流向 (日聚合版)
// ===========================================================================

const FLOW_HORIZONS = [
  { key: 'm1', label: '本月', range: '≤ 1 个月', maxDays: 31 },
  { key: 'm3', label: '约 3 个月', range: '1–3 个月', maxDays: 100 },
  { key: 'm6', label: '约 6 个月', range: '3–6 个月', maxDays: 200 },
  { key: 'far', label: '更远', range: '> 6 个月', maxDays: Infinity }
];

/**
 * 近 N 周大宗成交按「截至 nowMs 的剩余期限」分桶 (只含仍未交割的合约)，按主动方向计正负。
 * 每个 OI 日以当日 20:00 UTC 归入周窗口；OI 开仓占比按合约 × OI 日估算。
 */
function horizonFlows(daily, nowMs, weeks = 4, oiSnapshots = null) {
  const startMs = nowMs - weeks * WEEK_MS;
  const oiAvailable = !!(oiSnapshots && oiSnapshots.length);
  const emptyWeek = () => ({ netDeltaUSD: 0, grossNotionalUSD: 0, netPremiumUSD: 0, count: 0 });
  const horizons = FLOW_HORIZONS.map(h => ({
    key: h.key, label: h.label, range: h.range,
    count: 0, grossNotionalUSD: 0, netDeltaUSD: 0, netVegaUSD: 0, netPremiumUSD: 0,
    weeks: Array.from({ length: weeks }, emptyWeek),
    expiries: {}, oiKnown: 0, oiOpen: 0
  }));
  // 整个日聚合档案的起点 (不是窗口内的第一天)：早于它的周是「无数据」而不是零流量
  const allKeys = Object.keys(daily || {}).sort();
  const firstDayMs = allKeys.length ? dayStartMs(allKeys[0]) : null;

  for (const [key, day] of Object.entries(daily || {})) {
    const start = dayStartMs(key);
    const ts = Math.min(start + 12 * HOUR_MS, nowMs);
    if (ts < startMs || start > nowMs) continue;
    const w = Math.min(weeks - 1, Math.max(0, Math.floor((ts - startMs) / WEEK_MS)));
    for (const r of day.rows) {
      const expMs = expiryMsOf(r.expiry);
      if (!expMs || expMs <= nowMs) continue;
      const daysLeft = (expMs - nowMs) / DAY_MS;
      const h = horizons[FLOW_HORIZONS.findIndex(x => daysLeft <= x.maxDays)];
      h.count += r.count;
      h.grossNotionalUSD += r.grossUSD;
      h.netDeltaUSD += r.netDeltaUSD;
      h.netVegaUSD += r.netVegaUSD;
      h.netPremiumUSD += r.netPremiumUSD;
      h.expiries[r.expiry] = (h.expiries[r.expiry] || 0) + r.grossUSD;
      const wk = h.weeks[w];
      wk.count += r.count;
      wk.netDeltaUSD += r.netDeltaUSD;
      wk.grossNotionalUSD += r.grossUSD;
      wk.netPremiumUSD += r.netPremiumUSD;
      if (oiAvailable) {
        const p = profileFromItems(oiSnapshots, [{ instrument: instrumentName(r.expiry, r.strike, r.isCall), ts: start + 12 * HOUR_MS, amount: r.buyQty + r.sellQty, expiryMs: expMs }]);
        if (p.openShare !== undefined) {
          h.oiKnown += r.grossUSD;
          h.oiOpen += p.openShare * r.grossUSD;
        }
      }
    }
  }

  return {
    weeks,
    nowMs,
    weekEnds: Array.from({ length: weeks }, (_, i) => startMs + (i + 1) * WEEK_MS),
    // 日聚合起点晚于窗口起点时，前几周是空的而不是零流量
    coverageStartMs: firstDayMs,
    oiAvailable,
    horizons: horizons.map(({ expiries, oiKnown, oiOpen, ...h }) => ({
      ...h,
      topExpiries: Object.entries(expiries).sort((a, b) => b[1] - a[1]).slice(0, 2)
        .map(([expiry, usd]) => ({ expiry, sharePct: Math.round((usd / (h.grossNotionalUSD || 1)) * 100) })),
      // OI 判定覆盖不到一半名义额时不给开仓占比，避免小样本误导
      oiOpenShare: oiKnown > 0 && oiKnown >= 0.5 * h.grossNotionalUSD ? oiOpen / oiKnown : null,
      oiCoverage: h.grossNotionalUSD > 0 ? oiKnown / h.grossNotionalUSD : 0
    }))
  };
}

// ===========================================================================
// 方法 5：大额结构登记与盯市
// ===========================================================================

const FAMILY_LABELS = {
  bull: '方向看多',
  bear: '方向看空',
  'long-vol': '买入波动率',
  'short-vol': '卖出波动率 / 区间'
};

/** 按 Delta / Vega 画像分组：|净 Delta| 超过名义额 10% 视为方向性，否则按 Vega 符号 */
function familyOf(s) {
  const ratio = (Number(s.netDeltaUSD) || 0) / (Number(s.notionalUSD) || 1);
  if (ratio > 0.1) return 'bull';
  if (ratio < -0.1) return 'bear';
  return (Number(s.netVegaUSD) || 0) >= 0 ? 'long-vol' : 'short-vol';
}

function dominantExpiry(legs) {
  const w = {};
  for (const l of legs) {
    const inst = parseInstrument(l.instrument || '');
    if (inst) w[inst.expiryStr] = (w[inst.expiryStr] || 0) + (Number(l.amount) || 0);
  }
  const top = Object.entries(w).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : null;
}

/**
 * 把 analyzeBlockTrades 的冰山组与独立大单 (按 blockId 去重) 登记入册。
 * 尚未盯过市的条目允许被更完整的版本覆盖 (例如数据窗口内冰山组又多了几片)。
 */
function registerStructures(registry, analysis, minNotional = STRUCTURE_MIN_NOTIONAL) {
  const byId = new Map(registry.map(s => [s.id, s]));
  const clustered = new Set();
  const items = [];
  for (const c of analysis.icebergClusters || []) {
    (c.blockIds || []).forEach(id => clustered.add(id));
    items.push({ id: `ICE:${c.blockIds[0]}`, kind: 'iceberg', ts: c.startTimestamp, notionalUSD: c.clusterNotionalUSD, src: c });
  }
  for (const b of analysis.whaleBlocks || []) {
    if (clustered.has(b.blockId)) continue;
    items.push({ id: `BLK:${b.blockId}`, kind: 'whale', ts: b.timestamp, notionalUSD: b.notionalUSD, src: b });
  }

  let added = 0;
  for (const it of items) {
    if (!(it.notionalUSD >= minNotional) || !Number.isFinite(it.ts)) continue;
    const prev = byId.get(it.id);
    if (prev && (prev.marks.length || prev.final || prev.notionalUSD >= it.notionalUSD)) continue;
    const legs = (it.src.legs || []).map(l => ({
      instrument: l.instrument,
      direction: l.direction,
      amount: round(Number(l.amount) || 0, 1),
      price: round(Number(l.price) || 0, 5)
    })).filter(l => l.amount > 0 && parseInstrument(l.instrument || ''));
    if (!legs.length) continue;
    const entry = {
      id: it.id,
      kind: it.kind,
      ts: it.ts,
      notionalUSD: round(it.notionalUSD),
      netDeltaUSD: round(Number(it.src.netDeltaUSD) || 0),
      netVegaUSD: round(Number(it.src.netVegaUSD) || 0),
      strategyNameZh: it.src.strategyNameZh || '未识别构型',
      entrySpot: round(Number(it.src.legs?.[0]?.indexPrice) || 0, 1),
      expiry: dominantExpiry(legs),
      legs,
      marks: prev ? prev.marks : [],
      final: null
    };
    entry.family = familyOf(entry);
    byId.set(it.id, entry);
    if (!prev) added++;
  }
  return { registry: [...byId.values()].sort((a, b) => a.ts - b.ts), added };
}

/** 交割后的单张收益 (BTC)：Call max(1 − K/D, 0)，Put max(K/D − 1, 0) */
function settledValue(inst, delivery) {
  return inst.isCall ? Math.max(1 - inst.strike / delivery, 0) : Math.max(inst.strike / delivery - 1, 0);
}

function deliveryDateOf(expMs) {
  return new Date(expMs).toISOString().slice(0, 10);
}

/**
 * 主动方视角的盯市盈亏 (BTC)。已交割的腿按交割价结算；缺标记价或交割价时返回 null。
 */
function valueStructure(s, { markByInstrument, deliveryByDate, nowMs }) {
  let pnlBtc = 0;
  let allExpired = true;
  for (const l of s.legs) {
    const inst = parseInstrument(l.instrument);
    const expMs = inst && expiryMsOf(inst.expiryStr);
    if (!expMs) return null;
    let value;
    if (expMs <= nowMs) {
      const delivery = deliveryByDate[deliveryDateOf(expMs)];
      if (!(delivery > 0)) return null;
      value = settledValue(inst, delivery);
    } else {
      allExpired = false;
      value = markByInstrument[l.instrument];
      if (!(value >= 0)) return null;
    }
    pnlBtc += (l.direction === 'buy' ? 1 : -1) * l.amount * (value - l.price);
  }
  return { pnlBtc, allExpired };
}

/**
 * 每个 OI 日给未结算的结构记一次盯市点；全部腿交割后结算。
 * 结算后只保留 1 / 7 / 30 天附近与最后一个点，控制文件体积。
 */
function markStructures(registry, { markByInstrument = {}, spot = null, deliveryByDate = {}, nowMs = Date.now() }) {
  const key = dayKey(nowMs);
  let marked = 0;
  let settled = 0;
  const out = registry.map(s => {
    if (s.final) return s;
    const v = valueStructure(s, { markByInstrument, deliveryByDate, nowMs });
    if (!v) return s;
    const next = { ...s, marks: s.marks.slice() };
    if (!next.marks.some(m => m.day === key)) {
      next.marks.push({ day: key, ts: nowMs, pnlBtc: round(v.pnlBtc, 3), spot: spot ? round(spot, 1) : null });
      marked++;
    }
    if (v.allExpired) {
      next.final = { pnlBtc: round(v.pnlBtc, 3), ts: nowMs };
      next.marks = compressMarks(next);
      settled++;
    }
    return next;
  });
  return { registry: out, marked, settled };
}

function compressMarks(s) {
  const keep = new Set();
  for (const horizon of [1, 7, 30]) {
    const m = s.marks.find(x => x.ts - s.ts >= horizon * DAY_MS);
    if (m) keep.add(m);
  }
  if (s.marks.length) keep.add(s.marks[s.marks.length - 1]);
  return s.marks.filter(m => keep.has(m));
}

/** 7 天结果只取成交后 7~10 天内的盯市点，避免回填的旧结构把 20 天后的点当成 7 天 */
function outcomeAt7d(s) {
  const m = s.marks.find(x => x.ts - s.ts >= 7 * DAY_MS && x.ts - s.ts <= 10 * DAY_MS);
  return m ? m.pnlBtc : null;
}

function mergeRegistries(primary, secondary) {
  const byId = new Map((secondary || []).map(s => [s.id, s]));
  for (const s of primary || []) {
    const other = byId.get(s.id);
    if (!other) { byId.set(s.id, s); continue; }
    const winner = s.final || !other.final ? s : other;
    const loser = winner === s ? other : s;
    const marks = new Map([...loser.marks, ...winner.marks].map(m => [m.day, m]));
    byId.set(s.id, { ...winner, marks: winner.final ? winner.marks : [...marks.values()].sort((a, b) => a.ts - b.ts) });
  }
  return [...byId.values()].sort((a, b) => a.ts - b.ts);
}

/**
 * 命中率与信号加权：p = (胜 + 1) / (样本 + 2) (拉普拉斯平滑)，优先用到期结算结果，样本不足 5 个时退回 7 天结果。
 * 加权倾向 = Σ 方向 × 名义额 × (2p − 1) / Σ 名义额，只对近 30 天内仍未结算的结构计算。
 */
function summarizeSmartMoney(registry, nowMs = Date.now()) {
  const fam = {};
  for (const k of Object.keys(FAMILY_LABELS)) {
    fam[k] = { key: k, label: FAMILY_LABELS[k], finals: 0, wins: 0, pnlBtc: 0, n7: 0, wins7: 0, open: 0 };
  }
  for (const s of registry) {
    const f = fam[s.family] || fam['short-vol'];
    if (s.final) {
      f.finals++;
      f.pnlBtc += s.final.pnlBtc;
      if (s.final.pnlBtc > 0) f.wins++;
    } else {
      f.open++;
    }
    const o7 = outcomeAt7d(s);
    if (o7 !== null) {
      f.n7++;
      if (o7 > 0) f.wins7++;
    }
  }
  const families = Object.values(fam).map(f => {
    const basis = f.finals >= 5 ? 'final' : (f.n7 >= 5 ? '7d' : null);
    const p = basis === 'final' ? (f.wins + 1) / (f.finals + 2) : (basis === '7d' ? (f.wins7 + 1) / (f.n7 + 2) : 0.5);
    return {
      ...f,
      hitRate: f.finals ? f.wins / f.finals : null,
      hitRate7d: f.n7 ? f.wins7 / f.n7 : null,
      avgPnlBtc: f.finals ? f.pnlBtc / f.finals : null,
      weight: p,
      weightBasis: basis
    };
  });
  const weightOf = Object.fromEntries(families.map(f => [f.key, f.weight]));

  let dirScore = 0;
  let dirNotional = 0;
  let volScore = 0;
  let volNotional = 0;
  for (const s of registry) {
    if (s.final || nowMs - s.ts > 30 * DAY_MS) continue;
    const edge = 2 * (weightOf[s.family] ?? 0.5) - 1;
    if (s.family === 'bull' || s.family === 'bear') {
      dirScore += (s.family === 'bull' ? 1 : -1) * s.notionalUSD * edge;
      dirNotional += s.notionalUSD;
    } else {
      volScore += (s.family === 'long-vol' ? 1 : -1) * s.notionalUSD * edge;
      volNotional += s.notionalUSD;
    }
  }

  const recent = registry.slice().sort((a, b) => b.ts - a.ts).slice(0, 30).map(s => {
    const last = s.marks[s.marks.length - 1] || null;
    return {
      id: s.id,
      kind: s.kind,
      ts: s.ts,
      strategyNameZh: s.strategyNameZh,
      family: s.family,
      familyLabel: FAMILY_LABELS[s.family],
      expiry: s.expiry,
      notionalUSD: s.notionalUSD,
      legs: s.legs,
      pnlBtc: s.final ? s.final.pnlBtc : (last ? last.pnlBtc : null),
      markedAt: s.final ? s.final.ts : (last ? last.ts : null),
      settled: !!s.final,
      familyWeight: weightOf[s.family] ?? 0.5
    };
  });

  const finals = registry.filter(s => s.final);
  return {
    tracked: registry.length,
    settled: finals.length,
    open: registry.length - finals.length,
    overallHitRate: finals.length ? finals.filter(s => s.final.pnlBtc > 0).length / finals.length : null,
    families,
    directionalBias: dirNotional ? dirScore / dirNotional : null,
    volBias: volNotional ? volScore / volNotional : null,
    recent
  };
}

// ===========================================================================
// 方法 3：行权价热力图、墙与目标区间
// ===========================================================================

/** 结构的到期盈利区间与最佳价位 (同一到期日的结构才有意义) */
function profitZone(legs, spot) {
  const pvLegs = legs.map(l => {
    const inst = parseInstrument(l.instrument);
    return { instrument: l.instrument, direction: l.direction, amount: l.amount, price: l.price, strike: inst.strike, isCall: inst.isCall };
  });
  const curve = PnLEngine.generatePnLCurve(pvLegs, spot, 240);
  if (!curve) return null;
  const ranges = [];
  let cur = null;
  let peak = curve.series[0];
  for (const p of curve.series) {
    if (p.pnlBtc > peak.pnlBtc) peak = p;
    if (p.pnlBtc > 0) {
      if (!cur) cur = [p.S, p.S];
      cur[1] = p.S;
    } else if (cur) {
      ranges.push(cur);
      cur = null;
    }
  }
  if (cur) ranges.push(cur);
  const pts = curve.series;
  const first = pts[0].S;
  const last = pts[pts.length - 1].S;
  // 最大盈利是一段延伸到采样边界的平台 (如牛市看跌价差 ≥ 卖出行权价) 时，最佳价位写成「≥ / ≤ X」
  const tol = Math.max(1e-9, Math.abs(peak.pnlBtc) * 1e-6);
  const atMax = p => Math.abs(p.pnlBtc - peak.pnlBtc) <= tol;
  let peakOpenEnded = null;
  let peakPrice = peak.S;
  if (atMax(pts[pts.length - 1])) {
    peakOpenEnded = 'up';
    peakPrice = pts.find(atMax).S;
  } else if (atMax(pts[0])) {
    peakOpenEnded = 'down';
    peakPrice = [...pts].reverse().find(atMax).S;
  }
  if (peakPrice === first || peakPrice === last) peakPrice = null;
  return {
    profitRanges: ranges.map(([lo, hi]) => ({ lo: lo === first ? null : lo, hi: hi === last ? null : hi })),
    peakPrice,
    peakOpenEnded,
    maxPnlBtc: curve.maxPnl,
    breakevens: curve.breakevens
  };
}

function strikeMap(daily, expiry, { oiLatest = null, spot = null, registry = [], nowMs = Date.now() } = {}) {
  const dayKeys = Object.keys(daily || {}).sort();
  const strikesSet = new Set();
  const cells = [];
  const cum = new Map(); // strike -> { call: {net, gross}, put: {net, gross} }
  const cumAt = k => cum.get(k) || (cum.set(k, { call: { net: 0, gross: 0 }, put: { net: 0, gross: 0 } }), cum.get(k));

  const days = [];
  for (const key of dayKeys) {
    const rows = daily[key].rows.filter(r => r.expiry === expiry);
    if (!rows.length) continue;
    days.push(key);
    for (const r of rows) {
      strikesSet.add(r.strike);
      const net = r.buyQty - r.sellQty;
      cells.push({ day: key, strike: r.strike, type: r.isCall ? 'C' : 'P', net: round(net, 1), gross: round(r.buyQty + r.sellQty, 1) });
      const c = cumAt(r.strike)[r.isCall ? 'call' : 'put'];
      c.net += net;
      c.gross += r.buyQty + r.sellQty;
    }
  }

  // OI：加入该到期日 OI 较大的行权价 (≥ 最大 OI 的 3%，价格在现价 0.5~2 倍内)
  const oi = new Map();
  if (oiLatest && oiLatest.oi) {
    const prefix = `BTC-${expiry}-`;
    let maxOi = 0;
    const raw = [];
    for (const [name, [openInterest]] of Object.entries(oiLatest.oi)) {
      if (!name.startsWith(prefix)) continue;
      const inst = parseInstrument(name);
      if (!inst) continue;
      raw.push([inst.strike, inst.isCall, openInterest]);
      maxOi = Math.max(maxOi, openInterest);
    }
    for (const [strike, isCall, openInterest] of raw) {
      const o = oi.get(strike) || { call: 0, put: 0 };
      o[isCall ? 'call' : 'put'] = openInterest;
      oi.set(strike, o);
      const inBand = !spot || (strike >= spot * 0.5 && strike <= spot * 2);
      if (inBand && openInterest >= maxOi * 0.03) strikesSet.add(strike);
    }
  }

  const strikes = [...strikesSet].sort((a, b) => a - b);
  const cumulative = strikes.map(k => {
    const c = cum.get(k) || { call: { net: 0, gross: 0 }, put: { net: 0, gross: 0 } };
    const o = oi.get(k) || { call: 0, put: 0 };
    return { strike: k, callNet: round(c.call.net, 1), putNet: round(c.put.net, 1), callGross: round(c.call.gross, 1), putGross: round(c.put.gross, 1), callOI: o.call, putOI: o.put };
  });

  // 墙：主动成交最集中的行权价 + 现价上方最大 Call OI / 下方最大 Put OI
  const flowWalls = cumulative.flatMap(c => [
    { strike: c.strike, type: 'C', net: c.callNet, gross: c.callGross, oi: c.callOI },
    { strike: c.strike, type: 'P', net: c.putNet, gross: c.putGross, oi: c.putOI }
  ]).filter(w => w.gross > 0).sort((a, b) => Math.abs(b.net) - Math.abs(a.net)).slice(0, 4);
  const callOiWalls = cumulative.filter(c => !spot || c.strike >= spot).sort((a, b) => b.callOI - a.callOI).slice(0, 2).filter(c => c.callOI > 0)
    .map(c => ({ strike: c.strike, type: 'C', oi: c.callOI }));
  const putOiWalls = cumulative.filter(c => !spot || c.strike <= spot).sort((a, b) => b.putOI - a.putOI).slice(0, 2).filter(c => c.putOI > 0)
    .map(c => ({ strike: c.strike, type: 'P', oi: c.putOI }));

  // 目标区间：同一到期日的大额结构按构型 + 行权价组合归并，用到期盈亏曲线求盈利区间与最佳价位
  const groups = new Map();
  for (const s of registry) {
    const legInsts = s.legs.map(l => parseInstrument(l.instrument));
    if (!legInsts.every(i => i && i.expiryStr === expiry)) continue;
    const sig = `${s.strategyNameZh}|${s.legs.map(l => `${l.direction[0]}${parseInstrument(l.instrument).strike}${parseInstrument(l.instrument).type}`).sort().join(',')}`;
    const g = groups.get(sig) || { strategyNameZh: s.strategyNameZh, family: s.family, notionalUSD: 0, count: 0, firstTs: s.ts, lastTs: s.ts, legsBySide: new Map() };
    g.notionalUSD += s.notionalUSD;
    g.count++;
    g.firstTs = Math.min(g.firstTs, s.ts);
    g.lastTs = Math.max(g.lastTs, s.ts);
    for (const l of s.legs) {
      const k = `${l.direction}:${l.instrument}`;
      const a = g.legsBySide.get(k) || { instrument: l.instrument, direction: l.direction, amount: 0, cost: 0 };
      a.amount += l.amount;
      a.cost += l.amount * l.price;
      g.legsBySide.set(k, a);
    }
    groups.set(sig, g);
  }
  const zoneSpot = spot || (strikes.length ? strikes[Math.floor(strikes.length / 2)] : 0);
  const targetZones = [...groups.values()]
    .sort((a, b) => b.notionalUSD - a.notionalUSD)
    .slice(0, 6)
    .map(g => {
      const legs = [...g.legsBySide.values()].map(a => ({ instrument: a.instrument, direction: a.direction, amount: round(a.amount, 1), price: a.amount ? a.cost / a.amount : 0 }));
      return {
        strategyNameZh: g.strategyNameZh,
        family: g.family,
        familyLabel: FAMILY_LABELS[g.family],
        notionalUSD: round(g.notionalUSD),
        count: g.count,
        firstTs: g.firstTs,
        lastTs: g.lastTs,
        legs: legs.map(l => ({ ...l, price: round(l.price, 5) })),
        ...(zoneSpot ? profitZone(legs, zoneSpot) : {})
      };
    });

  return { expiry, expiryMs: expiryMsOf(expiry), days, strikes, cells, cumulative, flowWalls, oiWalls: [...callOiWalls, ...putOiWalls], targetZones };
}

/** 可选的到期日：仍未交割且有大宗成交，按到期日排序，附带累计名义额 */
function liveExpiries(daily, nowMs) {
  const usd = {};
  for (const day of Object.values(daily || {})) {
    for (const r of day.rows) {
      const expMs = expiryMsOf(r.expiry);
      if (!expMs || expMs <= nowMs) continue;
      usd[r.expiry] = (usd[r.expiry] || 0) + r.grossUSD;
    }
  }
  return Object.entries(usd)
    .map(([expiry, grossUSD]) => ({ expiry, expiryMs: expiryMsOf(expiry), grossUSD: round(grossUSD) }))
    .sort((a, b) => a.expiryMs - b.expiryMs);
}

// ===========================================================================
// 读写与合并
// ===========================================================================

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;
  }
}

function readDailyFile(file = DAILY_FILE) {
  return decodeDaily(readJson(file));
}

function writeDailyFile(days, file = DAILY_FILE) {
  fs.writeFileSync(file, JSON.stringify(encodeDaily(days)));
}

function readRegistryFile(file = SMART_FILE) {
  const json = readJson(file);
  return json && Array.isArray(json.structures) ? json.structures : [];
}

function writeRegistryFile(registry, file = SMART_FILE) {
  fs.writeFileSync(file, JSON.stringify({ currency: 'BTC', version: 1, structures: registry }));
}

/** Deribit 交割价：{ 'YYYY-MM-DD': price } */
async function fetchDeliveryPrices(count = 120) {
  const url = `https://www.deribit.com/api/v2/public/get_delivery_prices?index_name=btc_usd&offset=0&count=${count}`;
  const resp = await fetchWithTimeout(url, { timeout: 8000 });
  if (!resp.ok) throw new Error(`Deribit delivery prices HTTP ${resp.status}`);
  const json = await resp.json();
  const out = {};
  for (const d of json.result?.data || []) {
    if (d.date && d.delivery_price > 0) out[d.date] = d.delivery_price;
  }
  return out;
}

function marksFromBookSummary(rows) {
  const markByInstrument = {};
  let spot = null;
  for (const r of rows || []) {
    if (r && r.instrument_name && Number.isFinite(r.mark_price)) markByInstrument[r.instrument_name] = r.mark_price;
    if (spot === null && Number(r && r.estimated_delivery_price) > 0) spot = Number(r.estimated_delivery_price);
  }
  return { markByInstrument, spot };
}

// ---- 服务器运行时：仓库提交版 (磁盘 + GitHub raw) 与本机补采合并 ----

const RAW_BASE = process.env.BLOCK_INSIGHT_RAW_BASE
  || 'https://raw.githubusercontent.com/Bigdydydy/BIGDY-CRY-PTO-Dashboard/main/data';
const REMOTE_TTL_MS = 30 * 60 * 1000;
const LIVE_RETRY_MS = 10 * 60 * 1000;
const remote = { daily: { value: null, at: 0 }, registry: { value: null, at: 0 } };
let localRegistry = null;
let liveInflight = null;
let lastLiveAttempt = 0;

async function readRemote(slot, fileName, decode, now) {
  const r = remote[slot];
  if (r.value && now - r.at < REMOTE_TTL_MS) return r.value;
  try {
    const resp = await fetchWithTimeout(`${RAW_BASE}/${fileName}`, { headers: { Accept: 'application/json' }, timeout: 8000, retries: 0 });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    remote[slot] = { value: decode(await resp.json()), at: now };
  } catch (err) {
    remote[slot] = { value: r.value || decode(null), at: now };
  }
  return remote[slot].value;
}

async function getCommittedDaily(now = Date.now()) {
  const remoteDaily = await readRemote('daily', 'block_flow_daily_BTC.json', decodeDaily, now);
  return mergeDaily(remoteDaily, readDailyFile());
}

async function getMergedRegistry(now = Date.now()) {
  if (localRegistry === null) localRegistry = readRegistryFile(SMART_LOCAL_FILE);
  const remoteRegistry = await readRemote('registry', 'smart_money_BTC.json', j => (j && Array.isArray(j.structures) ? j.structures : []), now);
  return mergeRegistries(mergeRegistries(readRegistryFile(), remoteRegistry), localRegistry);
}

/**
 * 本机补采：把成交库里的大额结构登记入册，当天还没盯市时拉 Deribit 标记价 / 交割价补一次 (后台执行)。
 */
function maybeRefreshLocalRegistry(merged, analysis, fetchRows, now = Date.now()) {
  if (liveInflight || now - lastLiveAttempt < LIVE_RETRY_MS) return liveInflight;
  const { registry: registered, added } = registerStructures(merged, analysis);
  const key = dayKey(now);
  const needsMark = registered.some(s => !s.final && !s.marks.some(m => m.day === key));
  if (!added && !needsMark) return null;
  lastLiveAttempt = now;
  liveInflight = (async () => {
    try {
      let next = registered;
      if (needsMark) {
        const [rows, deliveryByDate] = await Promise.all([fetchRows(), fetchDeliveryPrices()]);
        const { markByInstrument, spot } = marksFromBookSummary(rows);
        next = markStructures(next, { markByInstrument, spot, deliveryByDate, nowMs: Date.now() }).registry;
      }
      localRegistry = mergeRegistries(next, localRegistry || []);
      writeRegistryFile(localRegistry, SMART_LOCAL_FILE);
      console.log(`[BlockInsight] local registry: ${localRegistry.length} structures (+${added})`);
    } catch (err) {
      console.warn('[BlockInsight] local registry refresh failed:', err.message);
    } finally {
      liveInflight = null;
    }
  })();
  return liveInflight;
}

let storeCache = { key: null, daily: null, analysis: null };

/**
 * 服务器端组装 4B 数据：仓库日聚合 + 30 天成交库重算的近几天；登记册合并本机补采，并在后台补登记 / 盯市。
 * @param {{trades: Array, nowMs?: number, spot?: number, expiry?: string, oiSnapshots?: Array, fetchRows: Function}} opts
 */
async function getServerInsight({ trades, nowMs = Date.now(), spot = null, expiry = null, oiSnapshots = [], fetchRows }) {
  const { analyzeBlockTrades } = require('./analytics_engine');
  const list = trades || [];
  const latestTs = list.reduce((m, t) => Math.max(m, t.timestamp || 0), 0);
  const key = `${list.length}:${latestTs}:${oiSnapshots.length}:${dayKey(nowMs)}`;
  if (storeCache.key !== key) {
    const coverage = list.reduce((m, t) => Math.min(m, t.timestamp || Infinity), Infinity);
    storeCache = {
      key,
      daily: aggregateTrades(list, coverage, nowMs),
      analysis: analyzeBlockTrades(list, STRUCTURE_MIN_NOTIONAL, 'all', spot || 0, oiSnapshots)
    };
  }
  const daily = mergeDaily(await getCommittedDaily(nowMs), storeCache.daily);
  const merged = await getMergedRegistry(nowMs);
  if (fetchRows) maybeRefreshLocalRegistry(merged, storeCache.analysis, fetchRows, nowMs);
  // 刚出现、还没写进本机文件的结构也立即显示 (未盯市)
  const registry = registerStructures(merged, storeCache.analysis).registry;
  return buildBlockInsight({ daily, registry, oiSnapshots, nowMs, spot, expiry });
}

/**
 * 4B 页面数据
 */
function buildBlockInsight({ daily, registry, oiSnapshots = [], nowMs = Date.now(), spot = null, expiry = null }) {
  const expiries = liveExpiries(daily, nowMs);
  const selected = expiry && expiries.some(e => e.expiry === expiry)
    ? expiry
    : (expiries.slice().sort((a, b) => b.grossUSD - a.grossUSD)[0] || {}).expiry || null;
  const oiLatest = oiSnapshots.length ? oiSnapshots[oiSnapshots.length - 1] : null;
  const dayKeys = Object.keys(daily || {}).sort();
  return {
    nowMs,
    spot,
    coverage: {
      dailyFrom: dayKeys[0] || null,
      dailyTo: dayKeys[dayKeys.length - 1] || null,
      dailyDays: dayKeys.length,
      oiDays: oiSnapshots.length,
      oiLatestTs: oiLatest ? oiLatest.ts : null
    },
    flows: {
      4: horizonFlows(daily, nowMs, 4, oiSnapshots),
      12: horizonFlows(daily, nowMs, 12, oiSnapshots),
      26: horizonFlows(daily, nowMs, 26, oiSnapshots)
    },
    expiries,
    strikeMap: selected ? strikeMap(daily, selected, { oiLatest, spot, registry, nowMs }) : null,
    smartMoney: summarizeSmartMoney(registry, nowMs)
  };
}

module.exports = {
  DAILY_FILE,
  SMART_FILE,
  SMART_LOCAL_FILE,
  STRUCTURE_MIN_NOTIONAL,
  FAMILY_LABELS,
  aggregateTrades,
  encodeDaily,
  decodeDaily,
  mergeDaily,
  horizonFlows,
  familyOf,
  registerStructures,
  valueStructure,
  markStructures,
  mergeRegistries,
  summarizeSmartMoney,
  profitZone,
  strikeMap,
  liveExpiries,
  readDailyFile,
  writeDailyFile,
  readRegistryFile,
  writeRegistryFile,
  fetchDeliveryPrices,
  marksFromBookSummary,
  getCommittedDaily,
  getMergedRegistry,
  maybeRefreshLocalRegistry,
  getServerInsight,
  buildBlockInsight
};
