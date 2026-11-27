/**
 * BTC 30D 25Δ 风险逆转 (RR = IV(25Δ Call) − IV(25Δ Put)) 日度重建档案 —— Card 05 偏斜"贵贱"的历史基准
 *
 * 为什么重建：Deribit 不提供历史波动率曲面，服务器本地档案 (vol_surface_history) 只从 2026-10 开始累积。
 * 这里用期权逐笔成交重建：每天 04:00–08:00 UTC 窗口内各合约成交 IV 的中位数，取 14–60 天到期、虚值一侧，
 * 按 Call Delta x 拟合 iv = a + b(x−0.5) + c(x−0.5)²，权重偏向 30 天；RR = −0.5·b，ATM = a。
 * 远期近似为指数价 (忽略基差)，Delta 用 Black-76、r = 0。与线上 RR30 重叠 16 天：相关 0.85、平均偏差 −0.7 点，
 * 所以分位只拿"重建值"比"重建历史"，不拿线上实时值去比。
 *
 * 档案：data/skew_history_BTC.json，由 scripts/skew_history.js 在 option_flow_daily.yml 每日追加并提交；
 * 线上从 GitHub raw 读取 (30 分钟缓存)，失败时读磁盘。
 * 研究出处：docs/reports/skew-dvol-event-study-2026-11-25.md
 */
const fs = require('fs');
const path = require('path');
const { fetchWithTimeout } = require('./http_client');
const { atomicWriteJson } = require('./data_health_cache');

const DAY = 86400000;
const HISTORY_FILE = path.join(__dirname, '..', 'data', 'skew_history_BTC.json');
const REMOTE_URL = process.env.SKEW_HISTORY_URL
  || 'https://raw.githubusercontent.com/Bigdydydy/BIGDY-CRY-PTO-Dashboard/main/data/skew_history_BTC.json';
const REMOTE_TTL_MS = 30 * 60 * 1000;
const HIST_BASE = 'https://history.deribit.com/api/v2/public';
const LOOKBACK_DAYS = 365;
const MIN_HISTORY = 120;
const STALE_DAYS = 3;
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
const REPORT_URL = 'https://github.com/Bigdydydy/BIGDY-CRY-PTO-Dashboard/blob/main/docs/reports/skew-dvol-event-study-2026-11-25.md';

/**
 * 事件研究的历史基准率 (2021-04 → 2026-11，1899 个可评估日，18 次 DVOL 跳升事件)。
 * 跳升 = DVOL 5 日变化 ≥ 全样本 95 分位 (9.1 点)；"下跌型 / 上涨型"按同期 5 日收益正负划分；
 * 概率 = 信号日之后 28 天内出现跳升的日子占比。信号日高度成簇，episodes 为连续段数。
 * 由 scripts/research/skew_dvol_study.js 生成；改口径后需重跑并更新这里。
 */
const STUDY = {
  sample: '2021-04 → 2026-11',
  events: 18,
  horizonDays: 28,
  base: { down: 21.0, up: 14.4 },
  putRich: { down: 24.5, up: 5.5, days: 494, episodes: 47 },
  callRich: { down: 9.0, up: 27.1, days: 377, episodes: 39 },
  normal: { down: 23.7, up: 14.0, days: 1028, episodes: 88 },
  // 按事前 28 日涨跌分层后 Put 偏贵对下跌型跳升无增量 (下跌趋势 26.3% vs 27.5%，上涨趋势 17.8% vs 15.2%)
  putRichTrendAdjusted: true,
  reportUrl: REPORT_URL
};

function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

function parseInst(name) {
  const m = /^BTC-(\d{1,2})([A-Z]{3})(\d{2})-(\d+)-([CP])$/.exec(name);
  if (!m) return null;
  return { expiry: Date.UTC(2000 + Number(m[3]), MONTHS[m[2]], Number(m[1]), 8), strike: Number(m[4]), type: m[5] };
}

/** 加权最小二乘拟合 y = a + b·u + c·u²，返回 [a, b, c]；矩阵奇异时返回 null */
function wls(pts) {
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const v = [0, 0, 0];
  for (const { u, y, w } of pts) {
    const f = [1, u, u * u];
    for (let i = 0; i < 3; i++) {
      v[i] += w * f[i] * y;
      for (let j = 0; j < 3; j++) S[i][j] += w * f[i] * f[j];
    }
  }
  const A = S.map((r, i) => [...r, v[i]]);
  for (let i = 0; i < 3; i++) {
    let p = i;
    for (let r = i + 1; r < 3; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]];
    if (Math.abs(A[i][i]) < 1e-12) return null;
    for (let r = 0; r < 3; r++) {
      if (r === i) continue;
      const f = A[r][i] / A[i][i];
      for (let c = i; c < 4; c++) A[r][c] -= f * A[i][c];
    }
  }
  return A.map((r, i) => r[3] / r[i]);
}

/**
 * 由一天的合约 IV 中位数拟合 30D 附近的 25Δ 微笑。
 * @param {{day:string, index:number, insts:Object<string,[number,number]>}} rec  insts: 合约 → [IV 中位数 %, 成交笔数]
 * @returns {{atm:number, rr:number, rrn:number, bf:number, n:number}|null}
 */
function fitDay(rec) {
  const t0 = Date.parse(`${rec.day}T08:00:00Z`);
  const F = rec.index;
  if (!Number.isFinite(F) || !rec.insts) return null;
  const pts = [];
  for (const [name, [iv, n]] of Object.entries(rec.insts)) {
    const p = parseInst(name);
    if (!p || !(iv > 0)) continue;
    const days = (p.expiry - t0) / DAY;
    if (days < 14 || days > 60) continue;
    if (p.type === 'C' ? p.strike < F : p.strike > F) continue; // 只用虚值一侧
    const T = days / 365;
    const s = iv / 100;
    const x = normCdf((Math.log(F / p.strike) + 0.5 * s * s * T) / (s * Math.sqrt(T)));
    if (x < 0.08 || x > 0.92) continue;
    pts.push({ u: x - 0.5, y: iv, w: Math.sqrt(n) / (1 + Math.abs(days - 30) / 15), x });
  }
  // 两翼各至少 3 个点，避免外推
  const enough = ps => ps.filter(p => p.x >= 0.10 && p.x <= 0.40).length >= 3 && ps.filter(p => p.x >= 0.60 && p.x <= 0.90).length >= 3;
  if (!enough(pts)) return null;
  let coef = wls(pts);
  if (!coef) return null;
  const res = pts.map(p => p.y - (coef[0] + coef[1] * p.u + coef[2] * p.u * p.u));
  const absr = res.map(Math.abs).sort((a, b) => a - b);
  const mad = absr[absr.length >> 1] * 1.4826;
  const keep = pts.filter((p, i) => Math.abs(res[i]) <= Math.max(2, 3 * mad));
  if (!enough(keep)) return null;
  coef = wls(keep);
  if (!coef) return null;
  const [a, b, c] = coef;
  const rr = -0.5 * b;
  return { atm: a, rr, rrn: rr / a, bf: c * 0.0625, n: keep.length };
}

const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function getJson(url, fetcher) {
  for (let a = 1; ; a++) {
    try {
      const res = await fetcher(url, { timeout: 20000, retries: 0 });
      if (res.ok === false) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (j.error) throw new Error(JSON.stringify(j.error));
      return j.result;
    } catch (err) {
      if (a >= 6) throw err;
      await new Promise(r => setTimeout(r, Math.min(30000, 1000 * 2 ** a)));
    }
  }
}

/** 抓取某天 04:00–08:00 UTC 的期权成交，按合约取 IV 中位数 */
async function fetchDayInsts(day, { fetcher = fetchWithTimeout, sleepMs = 120 } = {}) {
  const start = Date.parse(`${day}T04:00:00Z`);
  const end = Date.parse(`${day}T08:00:00Z`);
  const ivs = {};
  const seen = new Set();
  let cursor = start;
  let index = null;
  let trades = 0;
  for (let page = 0; page < 40; page++) {
    const r = await getJson(`${HIST_BASE}/get_last_trades_by_currency_and_time?currency=BTC&kind=option&start_timestamp=${cursor}&end_timestamp=${end - 1}&count=1000&sorting=asc`, fetcher);
    const list = r.trades || [];
    for (const t of list) {
      if (seen.has(t.trade_id)) continue;
      seen.add(t.trade_id);
      trades++;
      if (Number.isFinite(t.index_price)) index = t.index_price;
      if (Number.isFinite(t.iv) && t.iv > 1 && t.iv < 400) (ivs[t.instrument_name] ||= []).push(t.iv);
    }
    if (!r.has_more || !list.length) break;
    const lastTs = list[list.length - 1].timestamp;
    if (!(lastTs > cursor)) break;
    cursor = lastTs;
    if (sleepMs) await new Promise(res => setTimeout(res, sleepMs));
  }
  const insts = {};
  for (const [k, v] of Object.entries(ivs)) insts[k] = [Math.round(median(v) * 100) / 100, v.length];
  return { day, index, trades, insts };
}

const round = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

/** 日内合约 IV → 档案记录；拟合失败时 rr/atm 为 null (保留当天，标明缺口) */
function recordFromInsts(rec) {
  const fit = fitDay(rec);
  return { day: rec.day, spot: round(rec.index, 0), rr: round(fit?.rr), atm: round(fit?.atm), n: fit ? fit.n : 0 };
}

function upsertRecords(records, incoming) {
  const map = new Map((records || []).map(r => [r.day, r]));
  for (const r of incoming) map.set(r.day, r);
  return [...map.values()].sort((a, b) => a.day.localeCompare(b.day));
}

function validHistory(json) {
  return Boolean(json && Array.isArray(json.records) && json.records.every(r => r && typeof r.day === 'string'));
}

function readHistory(file = HISTORY_FILE) {
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    return validHistory(json) ? json.records : [];
  } catch (err) {
    return [];
  }
}

function writeHistory(file, records) {
  atomicWriteJson(file, {
    currency: 'BTC',
    version: 1,
    method: '04:00–08:00 UTC 成交 IV 合约中位数 → 14–60 天虚值合约按 Call Delta 二次拟合；RR = IV(25Δ Call) − IV(25Δ Put)',
    records
  });
}

let remoteCache = { records: null, at: 0 };

async function getHistory({ now = Date.now(), fetcher = fetchWithTimeout, file = HISTORY_FILE } = {}) {
  if (remoteCache.records && now - remoteCache.at < REMOTE_TTL_MS) return remoteCache.records;
  let records = null;
  try {
    const res = await fetcher(REMOTE_URL, { headers: { Accept: 'application/json' }, timeout: 8000, retries: 0 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (validHistory(json) && json.records.length) records = json.records;
  } catch (err) {
    // 远端不可用时读磁盘
  }
  if (!records) records = readHistory(file);
  remoteCache = { records, at: now };
  return records;
}

/** 因果 3 日中位数平滑 (单日重建噪声约 ±1.5 点) */
function smoothed(records) {
  const out = [];
  for (let i = 0; i < records.length; i++) {
    const xs = records.slice(Math.max(0, i - 2), i + 1).map(r => r.rr).filter(Number.isFinite);
    out.push({ day: records[i].day, rr: xs.length >= 2 ? median(xs) : null });
  }
  return out;
}

/**
 * 最新重建值在此前 365 天中的分位 (因果：不含当天)。
 * @returns {{verdict:'put_rich'|'call_rich'|'normal'|'insufficient_history'|'stale', percentile:number|null, value:number|null,
 *            asOf:string|null, n:number, basis:'reconstructed'}}
 */
function richnessFromHistory(records, { now = Date.now() } = {}) {
  const empty = verdict => ({ verdict, percentile: null, value: null, asOf: null, n: 0, basis: 'reconstructed' });
  if (!Array.isArray(records) || !records.length) return empty('insufficient_history');
  const sm = smoothed(records);
  let i = sm.length - 1;
  while (i >= 0 && !Number.isFinite(sm[i].rr)) i--;
  if (i < 0) return empty('insufficient_history');
  const last = sm[i];
  const cutoff = Date.parse(last.day) - LOOKBACK_DAYS * DAY;
  const hist = sm.slice(0, i).filter(r => Number.isFinite(r.rr) && Date.parse(r.day) >= cutoff).map(r => r.rr);
  if (hist.length < MIN_HISTORY) return { ...empty('insufficient_history'), value: round(last.rr), asOf: last.day, n: hist.length };
  let below = 0;
  for (const v of hist) below += v < last.rr ? 1 : (v === last.rr ? 0.5 : 0);
  const pct = below / hist.length * 100;
  const ageDays = (now - Date.parse(`${last.day}T08:00:00Z`)) / DAY;
  let verdict = 'normal';
  if (pct <= 20) verdict = 'put_rich';
  else if (pct >= 80) verdict = 'call_rich';
  if (ageDays > STALE_DAYS) verdict = 'stale';
  return { verdict, percentile: Math.round(pct), value: round(last.rr), asOf: last.day, n: hist.length, basis: 'reconstructed', ageDays: round(ageDays, 1) };
}

module.exports = {
  HISTORY_FILE,
  STUDY,
  fitDay,
  fetchDayInsts,
  recordFromInsts,
  upsertRecords,
  readHistory,
  writeHistory,
  getHistory,
  smoothed,
  richnessFromHistory,
  _resetCache: () => { remoteCache = { records: null, at: 0 }; }
};
