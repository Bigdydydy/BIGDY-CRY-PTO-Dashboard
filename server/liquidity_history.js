/**
 * Coinbase BTC-USD 订单簿深度历史档案 (Depth & Resilience History)
 *
 * Coinbase 不提供历史订单簿，因此深度时间序列只能自己逐小时记录：
 *  - 每次 L2 快照按 UTC 小时分桶，桶内做滚动均值 (n = 快照数)，10bps 另记桶内最低值；
 *  - data/coinbase_liquidity_history.json 由 GitHub Actions 每小时采样并提交 (权威序列)；
 *  - 本地/线上服务器的实时快照只写入 .local.json (gitignored)，读取时两者合并，避免与 Actions 的提交冲突；
 *  - 线上实例的磁盘只是部署时的快照，因此优先从 GitHub raw 拉取最新提交的档案 (10 分钟缓存)。
 *
 * 指标口径参照 Amberdata《凭空蒸发的流动性》：
 *  - 10 / 50 / 100 bps 双边深度 (USD)，7 天滚动均值；
 *  - 流动性韧性评分 = 100bps 深度 / 24h 现货成交额 × 100 (7D MA)；
 *  - 全阶梯撤单 vs 近端撤单：三档深度相对 7 日基线是否等比例坍塌；
 *  - 深度较峰值回撤、48h 深度变化、评分虚高 (分母缩量) 与止损失灵预警。
 * 韧性阈值完全由 Coinbase 自身数据决定：近 365 天日均评分的 75% / 25% 分位
 * (对应研报"前 25% / 后 25%"的分档方式，但不使用其多交易所合计的绝对数值)。
 * 满 7 个有效日开始给出阈值，满 30 天前标记为暂定。
 */

const fs = require('fs');
const path = require('path');
const { fetchWithTimeout } = require('./http_client');

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_HISTORY_DAYS = 1100; // 约 3 年，按小时 ≈ 26k 行 / 4MB

const COMMITTED_FILE = path.join(__dirname, '..', 'data', 'coinbase_liquidity_history.json');
const LOCAL_FILE = path.join(__dirname, '..', 'data', 'coinbase_liquidity_history.local.json');

const PYRAMID_BASELINE = 3.1;
const THRESHOLD_MIN_DAYS = 7;       // 有效日 (≥12 个小时样本) 少于此数不给阈值
const THRESHOLD_STABLE_DAYS = 30;   // 少于此数标记为暂定
const THRESHOLD_LOOKBACK_DAYS = 365;

const round = (v, d = 2) => (Number.isFinite(v) ? parseFloat(v.toFixed(d)) : null);

/**
 * 从 processCoinbaseData 的结果中提取一条快照 (金额单位: $M)
 */
function snapshotFromLiquidity(result) {
  if (!result || !result.depthProfile) return null;
  const dp = result.depthProfile;
  const toM = usd => (Number.isFinite(usd) ? usd / 1e6 : null);
  const slip = size => {
    const row = (result.slippageSimulation || []).find(s => s.sizeUsd === size);
    return row ? row.sell.slippageBps : null;
  };
  const vol24Usd = result.volume24h?.usd
    ?? ((result.percentiles?.volume24hBtc || 0) * (result.midPrice || 0));

  const snap = {
    mid: result.midPrice,
    spr: result.spreadBps,
    d10: toM(dp[10]?.totalUsd),
    d50: toM(dp[50]?.totalUsd),
    d100: toM(dp[100]?.totalUsd),
    b10: dp[10]?.bidPct,
    vol24: vol24Usd > 0 ? vol24Usd / 1e6 : null,
    s5: slip(5000000),
    s10: slip(10000000)
  };
  if (!Number.isFinite(snap.d10) || !Number.isFinite(snap.d100) || snap.d10 <= 0) return null;
  return snap;
}

const AVG_FIELDS = ['mid', 'spr', 'd10', 'd50', 'd100', 'b10', 'vol24', 's5', 's10'];
const FIELD_DECIMALS = { mid: 2, spr: 3, d10: 3, d50: 3, d100: 3, b10: 1, vol24: 1, s5: 2, s10: 2 };

function finalizeSample(s) {
  const out = { ts: s.ts, n: s.n };
  for (const f of AVG_FIELDS) out[f] = round(s[f], FIELD_DECIMALS[f]);
  out.d10min = round(s.d10min, 3);
  return out;
}

/**
 * 把一条快照并入小时桶 (桶内滚动均值)，返回新的有序数组
 */
function mergeSnapshot(samples, snap, ts = Date.now()) {
  if (!snap) return samples;
  const bucket = Math.floor(ts / HOUR_MS) * HOUR_MS;
  const list = samples.slice();
  const idx = list.findIndex(s => s.ts === bucket);

  if (idx === -1) {
    const fresh = { ts: bucket, n: 1, ...snap, d10min: snap.d10 };
    list.push(finalizeSample(fresh));
    list.sort((a, b) => a.ts - b.ts);
  } else {
    const cur = list[idx];
    const n = cur.n || 1;
    const merged = { ts: bucket, n: n + 1 };
    for (const f of AVG_FIELDS) {
      const a = cur[f];
      const b = snap[f];
      if (Number.isFinite(a) && Number.isFinite(b)) merged[f] = (a * n + b) / (n + 1);
      else merged[f] = Number.isFinite(a) ? a : b;
    }
    merged.d10min = Math.min(cur.d10min ?? cur.d10, snap.d10);
    list[idx] = finalizeSample(merged);
  }

  const cutoff = bucket - MAX_HISTORY_DAYS * DAY_MS;
  return list.filter(s => s.ts >= cutoff);
}

/**
 * ts 所在小时桶已有的快照数 (没有该桶时为 0)
 */
function hourSampleCount(samples, ts = Date.now()) {
  const bucket = Math.floor(ts / HOUR_MS) * HOUR_MS;
  const cur = samples.find(s => s.ts === bucket);
  return cur ? (cur.n || 1) : 0;
}

/**
 * 合并两份序列：同一小时取快照数更多的那份
 */
function mergeSampleSets(a = [], b = []) {
  const byTs = new Map();
  for (const s of [...a, ...b]) {
    if (!s || !Number.isFinite(s.ts)) continue;
    const prev = byTs.get(s.ts);
    if (!prev || (s.n || 0) > (prev.n || 0)) byTs.set(s.ts, s);
  }
  return [...byTs.values()].sort((x, y) => x.ts - y.ts);
}

function readHistoryFile(file) {
  try {
    if (!fs.existsSync(file)) return [];
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(json.samples) ? json.samples : [];
  } catch (err) {
    console.warn(`[LiquidityHistory] Failed to read ${path.basename(file)}:`, err.message);
    return [];
  }
}

/**
 * 每行一个样本，便于 git diff 只显示新增的小时
 */
function writeHistoryFile(file, samples) {
  const header = {
    schema: 1,
    source: 'Coinbase Exchange BTC-USD L2 order book',
    interval: '1h',
    units: 'depth / vol24 in $M (two-sided), spread & slippage in bps, b10 = 10bps bid share %'
  };
  const body = samples.map(s => '    ' + JSON.stringify(s)).join(',\n');
  const text = JSON.stringify(header, null, 2).replace(/\n}$/, `,\n  "samples": [\n${body}\n  ]\n}\n`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

// ---------------------------------------------------------------------------
// 派生指标
// ---------------------------------------------------------------------------

function scoreOf(s) {
  return Number.isFinite(s.d100) && Number.isFinite(s.vol24) && s.vol24 > 0
    ? (s.d100 / s.vol24) * 100
    : null;
}

function mean(arr) {
  const v = arr.filter(Number.isFinite);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function median(arr) {
  const v = arr.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function quantile(arr, q) {
  const v = arr.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

function percentRank(arr, val) {
  const v = arr.filter(Number.isFinite);
  if (!v.length || !Number.isFinite(val)) return null;
  const below = v.filter(x => x < val).length;
  const equal = v.filter(x => x === val).length;
  return ((below + 0.5 * equal) / v.length) * 100;
}

/**
 * 按时间窗 (非样本数) 的尾随均值，缺口小时不会被错误地压缩进窗口
 */
function trailingMean(samples, field, windowMs) {
  const out = new Array(samples.length).fill(null);
  let start = 0;
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = typeof field === 'function' ? field(samples[i]) : samples[i][field];
    if (Number.isFinite(v)) { sum += v; cnt++; }
    while (samples[start].ts <= samples[i].ts - windowMs) {
      const old = typeof field === 'function' ? field(samples[start]) : samples[start][field];
      if (Number.isFinite(old)) { sum -= old; cnt--; }
      start++;
    }
    out[i] = cnt > 0 ? sum / cnt : null;
  }
  return out;
}

function windowValues(samples, field, fromTs, toTs) {
  return samples
    .filter(s => s.ts >= fromTs && s.ts < toTs)
    .map(s => (typeof field === 'function' ? field(s) : s[field]));
}

function dailyAggregate(samples) {
  const byDay = new Map();
  for (const s of samples) {
    const day = new Date(s.ts).toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(s);
  }
  return [...byDay.entries()].map(([date, rows]) => ({
    date,
    hours: rows.length,
    d10: round(mean(rows.map(r => r.d10)), 3),
    d10min: round(Math.min(...rows.map(r => r.d10min ?? r.d10)), 3),
    d50: round(mean(rows.map(r => r.d50)), 3),
    d100: round(mean(rows.map(r => r.d100)), 3),
    score: round(mean(rows.map(scoreOf)), 2),
    mid: round(mean(rows.map(r => r.mid)), 0)
  }));
}

function classifyWithdrawal(c10, c50, c100) {
  if (![c10, c50, c100].every(Number.isFinite)) {
    return { code: 'INSUFFICIENT', label: '样本累积中', severity: 'neutral' };
  }
  const changes = [c10, c50, c100];
  const spread = Math.max(...changes) - Math.min(...changes);
  if (changes.every(c => c <= -25) && spread <= 15) {
    return { code: 'WHOLESALE_WITHDRAWAL', label: '全阶梯撤单', severity: 'critical' };
  }
  if (c10 <= -25 && c100 > -10) {
    return { code: 'NEAR_TOUCH_THINNING', label: '近端撤单 · 价差拉宽', severity: 'warning' };
  }
  if (changes.every(c => c >= -10)) {
    return { code: 'STABLE', label: '阶梯完整', severity: 'success' };
  }
  return { code: 'PARTIAL_THINNING', label: '局部收缩', severity: 'warning' };
}

function zoneOf(score, thresholds) {
  if (!thresholds || !Number.isFinite(score)) return null;
  if (score > thresholds.high) return { code: 'RESILIENT', label: '充裕强韧', severity: 'success' };
  if (score < thresholds.low) return { code: 'FRAGILE', label: '极度枯竭 · 高危脆断', severity: 'critical' };
  return { code: 'NORMAL', label: '常态运行', severity: 'neutral' };
}

/**
 * Coinbase 自身韧性阈值：近一年有效日的日均评分四分位
 */
function computeThresholds(daily, lastTs) {
  const from = lastTs - THRESHOLD_LOOKBACK_DAYS * DAY_MS;
  const scores = daily
    .filter(d => d.hours >= 12 && Date.parse(d.date) >= from)
    .map(d => d.score)
    .filter(Number.isFinite);
  if (scores.length < THRESHOLD_MIN_DAYS) return null;
  const q25 = quantile(scores, 0.25);
  const q75 = quantile(scores, 0.75);
  if (!(q75 > q25)) return null;
  return {
    high: round(q75, 2),
    low: round(q25, 2),
    days: scores.length,
    provisional: scores.length < THRESHOLD_STABLE_DAYS
  };
}

const pct = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b > 0 ? round((a / b - 1) * 100, 1) : null);

/**
 * 计算图表序列与当前研判
 * @param {Array} samples 全部小时样本 (升序)
 * @param {Object} opts { rangeDays: number|null, now: ms }
 */
function buildHistoryView(samples, opts = {}) {
  const now = opts.now || Date.now();
  const all = (samples || []).filter(s => Number.isFinite(s.ts) && Number.isFinite(s.d10));

  const coverage = {
    samples: all.length,
    firstTs: all.length ? all[0].ts : null,
    lastTs: all.length ? all[all.length - 1].ts : null,
    spanDays: all.length ? round((all[all.length - 1].ts - all[0].ts) / DAY_MS + 1 / 24, 1) : 0
  };

  if (!all.length) {
    return { coverage, series: [], daily: [], indicators: null, thresholds: null };
  }

  const scoreMa7 = trailingMean(all, scoreOf, 7 * DAY_MS);
  const d10Ma7 = trailingMean(all, 'd10', 7 * DAY_MS);
  const d100Ma7 = trailingMean(all, 'd100', 7 * DAY_MS);

  const daily = dailyAggregate(all);

  const thresholds = computeThresholds(daily, all[all.length - 1].ts);

  // --- 当前研判 ---
  const last = all[all.length - 1];
  const lastIdx = all.length - 1;
  const recentFrom = last.ts - 6 * HOUR_MS + 1;
  const recent = f => mean(windowValues(all, f, recentFrom, last.ts + 1));
  const baseFrom = recentFrom - 7 * DAY_MS;
  const baseRows = all.filter(s => s.ts >= baseFrom && s.ts < recentFrom);
  const baseEnough = baseRows.length >= 24;
  const base = f => (baseEnough ? mean(baseRows.map(s => s[f])) : null);

  const r10 = recent('d10');
  const r50 = recent('d50');
  const r100 = recent('d100');
  const c10 = pct(r10, base('d10'));
  const c50 = pct(r50, base('d50'));
  const c100 = pct(r100, base('d100'));

  // 48h 变化：最近 3h 均值 vs 48h 前同长度窗口
  const ago = last.ts - 48 * HOUR_MS;
  const past48 = mean(windowValues(all, 'd10', ago - 3 * HOUR_MS + 1, ago + 1));
  const now3 = mean(windowValues(all, 'd10', last.ts - 3 * HOUR_MS + 1, last.ts + 1));

  // 峰值回撤：近 365 天日均 10bps 深度峰值 vs 当前 7D 均值
  const yearDaily = daily.filter(d => Date.parse(d.date) >= last.ts - 365 * DAY_MS && d.hours >= 6);
  let peak = null;
  for (const d of yearDaily) if (!peak || d.d10 > peak.d10) peak = d;

  // 评分 7 日变化 vs 100bps 深度 7 日变化 (分子不涨、评分上涨 = 分母缩量)
  const idx7ago = all.findIndex(s => s.ts >= last.ts - 7 * DAY_MS);
  const hasWeek = idx7ago >= 0 && last.ts - all[0].ts >= 7 * DAY_MS;
  const scoreChg7d = hasWeek ? pct(scoreMa7[lastIdx], scoreMa7[idx7ago]) : null;
  const depthChg7d = hasWeek ? pct(d100Ma7[lastIdx], d100Ma7[idx7ago]) : null;
  const inflatedScore = Number.isFinite(scoreChg7d) && Number.isFinite(depthChg7d)
    && scoreChg7d >= 20 && depthChg7d <= 0;

  // 止损失灵：10bps 深度落入历史后 10% 且成交额处于前 25%
  const histEnough = coverage.spanDays >= 7;
  const d10Rank = histEnough ? percentRank(all.map(s => s.d10), r10) : null;
  const volRank = histEnough ? percentRank(all.map(s => s.vol24), recent('vol24')) : null;
  const stopLossCaution = Number.isFinite(d10Rank) && Number.isFinite(volRank) && d10Rank <= 10 && volRank >= 75;

  // 大单滑点：$10M 市价卖出 vs 30 日中位数
  const s10Med30 = median(windowValues(all, 's10', last.ts - 30 * DAY_MS, recentFrom));
  const s10Now = recent('s10');

  const scoreNow = scoreMa7[lastIdx];

  const indicators = {
    asOf: last.ts,
    depthNow: { d10: round(r10, 2), d50: round(r50, 2), d100: round(r100, 2) },
    depthMa7: { d10: round(d10Ma7[lastIdx], 2), d100: round(d100Ma7[lastIdx], 2) },
    pyramid: { ratio: round(r100 / r10, 2), baseline: PYRAMID_BASELINE },
    vsBaseline7d: { d10: c10, d50: c50, d100: c100 },
    withdrawal: classifyWithdrawal(c10, c50, c100),
    change48h: pct(now3, past48),
    peak: peak ? { date: peak.date, d10: peak.d10, drawdownPct: pct(d10Ma7[lastIdx], peak.d10) } : null,
    resilience: {
      score: round(scoreOf(last), 2),
      ma7: round(scoreNow, 2),
      zone: zoneOf(scoreNow, thresholds),
      chg7dPct: scoreChg7d,
      depthChg7dPct: depthChg7d,
      inflated: inflatedScore
    },
    stopLoss: { caution: stopLossCaution, d10Pctl: round(d10Rank, 1), volPctl: round(volRank, 1) },
    slippage10m: {
      nowBps: round(s10Now, 2),
      median30dBps: round(s10Med30, 2),
      excessPct: pct(s10Now, s10Med30)
    }
  };

  // --- 图表序列 (按区间裁剪，均线基于全量计算) ---
  const fromTs = Number.isFinite(opts.rangeDays) ? now - opts.rangeDays * DAY_MS : -Infinity;
  const series = [];
  for (let i = 0; i < all.length; i++) {
    const s = all[i];
    if (s.ts < fromTs) continue;
    series.push({
      ts: s.ts,
      mid: s.mid,
      d10: s.d10,
      d50: s.d50,
      d100: s.d100,
      d10min: s.d10min,
      score: round(scoreOf(s), 2),
      scoreMa7: round(scoreMa7[i], 2),
      s10: s.s10,
      n: s.n
    });
  }

  return { coverage, series, daily, indicators, thresholds };
}

// ---------------------------------------------------------------------------
// 服务器端记录 (仅写 .local.json)
// ---------------------------------------------------------------------------

let localSamples = null;
let lastLocalWrite = 0;
const LOCAL_WRITE_THROTTLE_MS = 60 * 1000;

function recordLiveSnapshot(result, ts = Date.now()) {
  const snap = snapshotFromLiquidity(result);
  if (!snap) return;
  if (localSamples === null) localSamples = readHistoryFile(LOCAL_FILE);
  localSamples = mergeSnapshot(localSamples, snap, ts);
  if (ts - lastLocalWrite >= LOCAL_WRITE_THROTTLE_MS) {
    lastLocalWrite = ts;
    try {
      writeHistoryFile(LOCAL_FILE, localSamples);
    } catch (err) {
      console.warn('[LiquidityHistory] Failed to persist local history:', err.message);
    }
  }
}

const REMOTE_URL = process.env.LIQUIDITY_HISTORY_URL
  || 'https://raw.githubusercontent.com/Bigdydydy/BIGDY-CRY-PTO-Dashboard/main/data/coinbase_liquidity_history.json';
const REMOTE_TTL_MS = 10 * 60 * 1000;
let remoteCache = { samples: null, at: 0 };

async function readCommittedHistory() {
  const now = Date.now();
  if (remoteCache.samples && now - remoteCache.at < REMOTE_TTL_MS) return remoteCache.samples;
  try {
    const resp = await fetchWithTimeout(REMOTE_URL, { headers: { Accept: 'application/json' }, timeout: 8000, retries: 0 });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (!Array.isArray(json.samples)) throw new Error('malformed history');
    remoteCache = { samples: json.samples, at: now };
  } catch (err) {
    // 尚未推送或网络不可达：退回仓库里随部署带上的版本
    remoteCache = { samples: remoteCache.samples || readHistoryFile(COMMITTED_FILE), at: now };
  }
  return remoteCache.samples;
}

async function getMergedHistory() {
  if (localSamples === null) localSamples = readHistoryFile(LOCAL_FILE);
  const committed = await readCommittedHistory();
  return mergeSampleSets(mergeSampleSets(readHistoryFile(COMMITTED_FILE), committed), localSamples);
}

module.exports = {
  COMMITTED_FILE,
  snapshotFromLiquidity,
  mergeSnapshot,
  hourSampleCount,
  mergeSampleSets,
  readHistoryFile,
  writeHistoryFile,
  buildHistoryView,
  classifyWithdrawal,
  recordLiveSnapshot,
  getMergedHistory,
  _internal: { trailingMean, dailyAggregate, computeThresholds, scoreOf, quantile, percentRank }
};
