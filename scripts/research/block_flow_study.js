#!/usr/bin/env node
/**
 * 大宗期权资金流研究 (2026-01 ~ )：事件研究、市场调整、横截面面板回归 (含样本外)、总量流向预测回归。
 * 输入全部来自仓库内档案 + Deribit 公开接口 (交割价、DVOL 小时线)；输出一份 JSON 供研究报告使用。
 *
 * 用法: node scripts/research/block_flow_study.js --out <path.json>
 */

const fs = require('fs');
const path = require('path');
const BI = require('../../server/block_insight');
const archive = require('../../server/trade_archive');
const mh = require('../../server/option_marks_history');
const mo = require('../../server/block_markouts');
const { parseInstrument, parseDeribitExpiry } = require('../../server/analytics_engine');
const { fetchWithTimeout } = require('../../server/http_client');

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const HORIZONS = Array.from({ length: 30 }, (_, i) => i + 1);
const FAMILIES = ['bull', 'bear', 'long-vol', 'short-vol'];
const SPLIT_TS = Date.parse('2026-07-01T00:00:00Z'); // 样本内 (估计) / 样本外 (检验) 分界

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

// ---------------------------------------------------------------- 线性代数 / 回归
function invert(A) {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c];
    for (let j = 0; j < 2 * n; j++) M[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (f) for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map(row => row.slice(n));
}

/**
 * OLS，标准误可选：按组聚类 (cluster) 或 Newey-West (nwLag)。
 * @returns {{beta, se, t, n, k, r2, resid, fitted}}
 */
function ols(X, y, { cluster = null, nwLag = null } = {}) {
  const n = y.length;
  const k = X[0].length;
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  const inv = invert(XtX);
  if (!inv) return null;
  const beta = inv.map(row => row.reduce((s, v, j) => s + v * Xty[j], 0));
  const fitted = X.map(x => x.reduce((s, v, j) => s + v * beta[j], 0));
  const resid = y.map((v, i) => v - fitted[i]);
  const meat = Array.from({ length: k }, () => new Array(k).fill(0));
  const addOuter = (u, v, w = 1) => { for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) meat[a][b] += w * u[a] * v[b]; };
  let scale = 1;
  if (cluster) {
    const groups = new Map();
    for (let i = 0; i < n; i++) {
      const g = cluster[i];
      if (!groups.has(g)) groups.set(g, new Array(k).fill(0));
      const s = groups.get(g);
      for (let a = 0; a < k; a++) s[a] += X[i][a] * resid[i];
    }
    for (const s of groups.values()) addOuter(s, s);
    const G = groups.size;
    scale = G > 1 ? (G / (G - 1)) * ((n - 1) / Math.max(1, n - k)) : 1;
  } else if (nwLag != null) {
    const xu = X.map((x, i) => x.map(v => v * resid[i]));
    for (let i = 0; i < n; i++) addOuter(xu[i], xu[i]);
    for (let l = 1; l <= nwLag; l++) {
      const w = 1 - l / (nwLag + 1);
      for (let i = l; i < n; i++) {
        addOuter(xu[i], xu[i - l], w);
        addOuter(xu[i - l], xu[i], w);
      }
    }
    scale = n / Math.max(1, n - k);
  } else {
    const s2 = resid.reduce((s, v) => s + v * v, 0) / Math.max(1, n - k);
    return finish(inv.map(row => row.map(v => v * s2)));
  }
  const V = inv.map((row, a) => row.map((_, b) => {
    let s = 0;
    for (let c = 0; c < k; c++) for (let d = 0; d < k; d++) s += inv[a][c] * meat[c][d] * inv[d][b];
    return s * scale;
  }));
  return finish(V);

  function finish(Vm) {
    const se = Vm.map((row, i) => Math.sqrt(Math.max(row[i], 0)));
    const ybar = y.reduce((s, v) => s + v, 0) / n;
    const sst = y.reduce((s, v) => s + (v - ybar) ** 2, 0);
    const sse = resid.reduce((s, v) => s + v * v, 0);
    return { beta, se, t: beta.map((b, i) => (se[i] > 0 ? b / se[i] : null)), n, k, r2: sst > 0 ? 1 - sse / sst : null, resid, fitted };
  }
}

const quant = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
function winsorize(values, q) {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (s.length < 20) return values;
  const lo = quant(s, q);
  const hi = quant(s, 1 - q);
  return values.map(v => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : v));
}
function pearson(a, b) {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
}
function ranks(a) {
  const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
  const r = new Array(a.length);
  idx.forEach(([, i], k) => { r[i] = k; });
  return r;
}
const spearman = (a, b) => pearson(ranks(a), ranks(b));
const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

// ---------------------------------------------------------------- 数据
async function fetchDvolHourly(fromTs, toTs) {
  const out = new Map();
  for (let s = fromTs; s < toTs; s += 30 * DAY_MS) {
    const e = Math.min(toTs, s + 30 * DAY_MS);
    const url = `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp=${s}&end_timestamp=${e}&resolution=3600`;
    const r = await fetchWithTimeout(url, { timeout: 15000, retries: 3, backoffMs: 2000 });
    const j = await r.json();
    for (const [ts, open] of (j.result && j.result.data) || []) out.set(ts, open);
  }
  return out;
}

const dayOf = ts => new Date(ts).toISOString().slice(0, 10);
const UTC_HOURS_US = ts => {
  // 美东 09:30-16:00 (按 UTC-5 / -4 粗略：取 13:30-21:00 UTC)
  const d = new Date(ts);
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  const wd = d.getUTCDay();
  return wd >= 1 && wd <= 5 && m >= 13 * 60 + 30 && m <= 21 * 60 ? 1 : 0;
};

async function main() {
  const out = argValue('--out', path.join(process.cwd(), 'block_flow_study.json'));
  const registry = BI.readRegistryFile();
  const firstDay = dayOf(Math.min(...registry.map(s => s.ts)));
  const today = dayOf(Date.now());
  const history = mh.loadRange('BTC', firstDay, today);
  const closeDays = Object.keys(history).sort();
  const lastCloseDay = closeDays[closeDays.length - 1];
  const delivery = await BI.fetchDeliveryPrices(1000);
  console.log(`[study] registry ${registry.length}, marks ${closeDays[0]} ~ ${lastCloseDay}`);

  // DVOL (08:00 UTC 取值，与 mark 快照对齐) 与成交时刻的 DVOL
  const dvol = await fetchDvolHourly(Date.parse(`${firstDay}T00:00:00Z`) - DAY_MS, Date.now());
  const dvolAt = ts => {
    for (let k = 0; k < 6; k++) {
      const v = dvol.get(Math.floor(ts / HOUR_MS) * HOUR_MS - k * HOUR_MS);
      if (v != null) return v;
    }
    return null;
  };
  console.log(`[study] DVOL ${dvol.size} hourly points`);

  // 归档：每个 block 的腿 (成交价相对 mark 的主动溢价)
  const legsByBlock = new Map();
  for (const t of archive.readArchive('BTC', { fromTs: Date.parse(`${firstDay}T00:00:00Z`) - DAY_MS })) {
    if (!t.block_trade_id) continue;
    if (!legsByBlock.has(t.block_trade_id)) legsByBlock.set(t.block_trade_id, []);
    legsByBlock.get(t.block_trade_id).push(t);
  }

  // ---------------------------------------------------------------- 1. 事件研究 (1~30 天)
  const S0close = dayIdx => history[closeDays[dayIdx]]?.index;
  // 无条件基准：任一 08:00 收盘之后 h 天的 BTC 平均收益
  const baseline = {};
  for (const h of HORIZONS) {
    const rs = [];
    for (let i = 0; i + h < closeDays.length; i++) {
      const a = S0close(i);
      const b = S0close(i + h);
      if (a > 0 && b > 0) rs.push(b / a - 1);
    }
    baseline[h] = rs.length ? rs.reduce((s, v) => s + v, 0) / rs.length : null;
  }

  const rows = []; // 每个结构的特征 + 各期 markout
  for (const s of registry) {
    const fam = s.family;
    if (!FAMILIES.includes(fam)) continue;
    const rho = (Number(s.netDeltaUSD) || 0) / (Number(s.notionalUSD) || 1); // 每 1 美元名义额的 Delta 敞口
    const marks = {};
    for (const h of HORIZONS) {
      const day = mh.closeDayOf(s.ts + h * DAY_MS);
      if (day > lastCloseDay) break;
      const m = mo.markoutAt(s, h, history, delivery);
      if (!m) continue;
      const dirBps = (m.directionalUSD / (Number(s.notionalUSD) || 1)) * 1e4;
      const dv0 = dvolAt(s.ts);
      const dv1 = dvolAt(mh.closeTsOf(day));
      marks[h] = {
        totalBps: m.totalBps,
        volPoints: m.volPoints,
        dirBps,
        excessDirBps: baseline[h] != null ? dirBps - rho * baseline[h] * 1e4 : null,
        dDvol: dv0 != null && dv1 != null ? dv1 - dv0 : null
      };
    }
    // 特征
    const legs = (s.blockIds || []).flatMap(id => legsByBlock.get(id) || []);
    let prem = 0;
    let premOk = legs.length > 0;
    for (const l of legs) {
      if (!(Number(l.mark_price) >= 0) || !(Number(l.index_price) > 0)) { premOk = false; break; }
      const sign = l.direction === 'buy' ? 1 : -1;
      prem += sign * Number(l.amount) * (Number(l.price) - Number(l.mark_price)) * Number(l.index_price);
    }
    let dteW = 0;
    let amtW = 0;
    for (const l of s.legs) {
      const inst = parseInstrument(l.instrument);
      const exp = inst && parseDeribitExpiry(inst.expiryStr)?.getTime();
      if (!exp) continue;
      dteW += Math.max(0.5, (exp - s.ts) / DAY_MS) * l.amount;
      amtW += l.amount;
    }
    rows.push({
      id: s.id,
      ts: s.ts,
      day: dayOf(s.ts),
      family: fam,
      notionalUSD: s.notionalUSD,
      rho,
      hedged: s.hedged ? 1 : 0,
      iceberg: s.kind === 'iceberg' ? 1 : 0,
      premBps: premOk ? (prem / s.notionalUSD) * 1e4 : null,
      dte: amtW ? dteW / amtW : null,
      usHours: UTC_HOURS_US(s.ts),
      weekend: [0, 6].includes(new Date(s.ts).getUTCDay()) ? 1 : 0,
      settledBtc: s.final ? s.final.pnlBtc : null,
      marks
    });
  }
  console.log(`[study] ${rows.length} structures with features`);

  const eventStudy = {};
  for (const fam of FAMILIES) {
    eventStudy[fam] = {};
    const members = rows.filter(r => r.family === fam);
    for (const h of HORIZONS) {
      const pick = f => members.filter(r => r.marks[h] && Number.isFinite(r.marks[h][f])).map(r => ({ day: r.day, v: r.marks[h][f] }));
      const st = f => {
        const vals = pick(f);
        const x = mo.clusteredStats(vals, { winsor: 0.05 });
        // 持有期重叠：相邻成交日的 h 天窗口相互重叠，按日均值序列再做 Newey-West (滞后 = h 天) 修正
        const w = winsorize(vals.map(v => v.v), 0.05);
        const byDay = new Map();
        vals.forEach((v, i) => { if (!byDay.has(v.day)) byDay.set(v.day, []); byDay.get(v.day).push(w[i]); });
        const dayMeans = [...byDay.entries()].sort((p, q) => p[0].localeCompare(q[0])).map(([, a]) => a.reduce((s2, y) => s2 + y, 0) / a.length);
        const nw = dayMeans.length > h + 5 ? ols(dayMeans.map(() => [1]), dayMeans, { nwLag: h }) : null;
        return { mean: x.mean, t: x.t, tNW: nw ? round(nw.t[0]) : null, days: x.days, n: x.n, median: x.median, se: x.t ? round(Math.abs(x.mean / x.t), 3) : null };
      };
      eventStudy[fam][h] = { totalBps: st('totalBps'), volPoints: st('volPoints'), dirBps: st('dirBps'), excessDirBps: st('excessDirBps') };
    }
  }

  // ---------------------------------------------------------------- 2. 波动率部分对照 DVOL
  const volControl = {};
  for (const fam of FAMILIES) {
    volControl[fam] = {};
    for (const h of [1, 7]) {
      const rs = rows.filter(r => r.family === fam && r.marks[h] && Number.isFinite(r.marks[h].volPoints) && Number.isFinite(r.marks[h].dDvol));
      if (rs.length < 30) continue;
      const y = winsorize(rs.map(r => r.marks[h].volPoints), 0.05);
      const X = rs.map(r => [1, r.marks[h].dDvol]);
      const fit = ols(X, y, { cluster: rs.map(r => r.day) });
      volControl[fam][h] = fit && {
        n: fit.n,
        alpha: round(fit.beta[0], 3), alphaT: round(fit.t[0]),
        betaDvol: round(fit.beta[1], 3), betaT: round(fit.t[1]),
        r2: round(fit.r2, 3),
        meanDvolMove: round(rs.reduce((s, r) => s + r.marks[h].dDvol, 0) / rs.length, 3)
      };
    }
  }

  // ---------------------------------------------------------------- 3. 横截面面板回归 (7 天)
  const H = 7;
  const NAMES = ['常数 (方向看多)', '方向看空', '买入波动率', '卖出波动率', 'log10 名义额 ($M)', '含期货对冲', '冰山拆单', '主动溢价 (bp)', 'log 到期天数', '美股时段', '周末'];
  const featurize = r => [
    1,
    r.family === 'bear' ? 1 : 0,
    r.family === 'long-vol' ? 1 : 0,
    r.family === 'short-vol' ? 1 : 0,
    Math.log10(r.notionalUSD / 1e6),
    r.hedged,
    r.iceberg,
    r.premBps,
    Math.log(r.dte),
    r.usHours,
    r.weekend
  ];
  const usable = rows.filter(r => r.marks[H] && Number.isFinite(r.marks[H].totalBps) && Number.isFinite(r.premBps) && Number.isFinite(r.dte));
  const premW = winsorize(usable.map(r => r.premBps), 0.01);
  usable.forEach((r, i) => { r.premW = premW[i]; });
  const yAll = winsorize(usable.map(r => r.marks[H].totalBps), 0.01);
  usable.forEach((r, i) => { r.yW = yAll[i]; });
  const fx = r => { const f = featurize(r); f[7] = r.premW; return f; };
  const fitPanel = subset => ols(subset.map(fx), subset.map(r => r.yW), { cluster: subset.map(r => r.day) });
  const summarize = (fit, label, subset) => fit && {
    label,
    n: fit.n,
    days: new Set(subset.map(r => r.day)).size,
    r2: round(fit.r2, 4),
    coef: NAMES.map((name, i) => ({ name, beta: round(fit.beta[i], 3), se: round(fit.se[i], 3), t: round(fit.t[i]) }))
  };
  const train = usable.filter(r => r.ts < SPLIT_TS);
  const test = usable.filter(r => r.ts >= SPLIT_TS);
  const fitAll = fitPanel(usable);
  const fitTrain = fitPanel(train);
  const fitTest = fitPanel(test);
  let oos = null;
  if (fitTrain) {
    const pred = test.map(r => fx(r).reduce((s, v, j) => s + v * fitTrain.beta[j], 0));
    const real = test.map(r => r.yW);
    const mean = real.reduce((s, v) => s + v, 0) / real.length;
    const sse = real.reduce((s, v, i) => s + (v - pred[i]) ** 2, 0);
    const sst = real.reduce((s, v) => s + (v - mean) ** 2, 0);
    // 按预测值分五组，看样本外实际 markout 是否单调
    const order = pred.map((p, i) => [p, real[i]]).sort((a, b) => a[0] - b[0]);
    const q = 5;
    const buckets = Array.from({ length: q }, (_, k) => {
      const part = order.slice(Math.floor((k * order.length) / q), Math.floor(((k + 1) * order.length) / q));
      return { bucket: k + 1, n: part.length, predMean: round(part.reduce((s, x) => s + x[0], 0) / part.length), realMean: round(part.reduce((s, x) => s + x[1], 0) / part.length) };
    });
    oos = { n: test.length, pearson: round(pearson(pred, real), 3), spearman: round(spearman(pred, real), 3), r2Oos: round(1 - sse / sst, 4), buckets };
  }
  const signStable = fitTrain && fitTest ? NAMES.map((name, i) => ({ name, train: round(fitTrain.beta[i], 2), test: round(fitTest.beta[i], 2), sameSign: Math.sign(fitTrain.beta[i]) === Math.sign(fitTest.beta[i]) })) : null;

  // 波动率家族单独：y = 波动率点
  const volRows = usable.filter(r => (r.family === 'long-vol' || r.family === 'short-vol') && Number.isFinite(r.marks[H].volPoints));
  const yVol = winsorize(volRows.map(r => r.marks[H].volPoints), 0.01);
  const VOLNAMES = ['常数 (买入波动率)', '卖出波动率', 'log10 名义额 ($M)', '含期货对冲', '冰山拆单', '主动溢价 (bp)', 'log 到期天数', '同期 DVOL 变化'];
  const fitVol = ols(volRows.map(r => [1, r.family === 'short-vol' ? 1 : 0, Math.log10(r.notionalUSD / 1e6), r.hedged, r.iceberg, r.premW, Math.log(r.dte), Number.isFinite(r.marks[H].dDvol) ? r.marks[H].dDvol : 0]), yVol, { cluster: volRows.map(r => r.day) });

  // ---------------------------------------------------------------- 4. 总量流向 -> 市场
  const daily = BI.readDailyFile();
  const flowByClose = new Map(); // close day -> flows (该 OI 日的成交，收盘于次日 08:00)
  for (const [k, d] of Object.entries(daily)) {
    if (!d.complete) continue;
    const close = dayOf(Date.parse(`${k}T08:00:00Z`) + DAY_MS);
    let vega = 0;
    let delta = 0;
    let gross = 0;
    for (const r of d.rows) {
      vega += Number(r.netVegaUSD) || 0;
      delta += Number(r.netDeltaUSD) || 0;
      gross += Number(r.grossUSD) || 0;
    }
    flowByClose.set(close, { vega, delta, gross });
  }
  // 大额结构的净流向 (登记表，含对冲)
  const bigByClose = new Map();
  for (const s of registry) {
    const close = mh.closeDayOf(s.ts);
    const v = bigByClose.get(close) || { vega: 0, delta: 0 };
    v.vega += Number(s.netVegaUSD) || 0;
    v.delta += Number(s.netDeltaUSD) || 0;
    bigByClose.set(close, v);
  }
  const series = closeDays.map((d, i) => ({ day: d, i, S: history[d].index, dv: dvolAt(mh.closeTsOf(d)), flow: flowByClose.get(d), big: bigByClose.get(d) || { vega: 0, delta: 0 } }));
  const zs = (arr, f) => {
    const v = arr.map(f);
    const m = v.reduce((s, x) => s + x, 0) / v.length;
    const sd = Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
    return v.map(x => (sd > 0 ? (x - m) / sd : 0));
  };
  const withFlow = series.filter(x => x.flow && x.S > 0 && x.dv != null);
  const zVega = zs(withFlow, x => x.flow.vega);
  const zDelta = zs(withFlow, x => x.flow.delta);
  const zBigVega = zs(withFlow, x => x.big.vega);
  const zBigDelta = zs(withFlow, x => x.big.delta);
  withFlow.forEach((x, k) => { x.zVega = zVega[k]; x.zDelta = zDelta[k]; x.zBigVega = zBigVega[k]; x.zBigDelta = zBigDelta[k]; });
  const aggregate = [];
  for (const [signal, label, target] of [
    ['zVega', '全部大宗净 Vega', 'dDvol'], ['zBigVega', '≥$30M 结构净 Vega (含对冲)', 'dDvol'],
    ['zDelta', '全部大宗净 Delta', 'ret'], ['zBigDelta', '≥$30M 结构净 Delta (含对冲)', 'ret']
  ]) {
    for (const h of [0, 1, 7]) {
      const ys = [];
      const xs = [];
      for (const x of withFlow) {
        // h = 0：同一天 (流向所在的 24 小时内) 的变化；h ≥ 1：之后 h 天
        const fromIdx = h === 0 ? x.i - 1 : x.i;
        const toIdx = h === 0 ? x.i : x.i + h;
        const a = series[fromIdx];
        const b = series[toIdx];
        if (!a || !b || !(a.S > 0) || !(b.S > 0) || a.dv == null || b.dv == null) continue;
        ys.push(target === 'dDvol' ? b.dv - a.dv : (b.S / a.S - 1) * 1e4);
        xs.push([1, x[signal]]);
      }
      const fit = ols(xs, ys, { nwLag: Math.max(1, h) });
      aggregate.push({ signal: label, target: target === 'dDvol' ? 'DVOL 变化 (点)' : 'BTC 收益 (bp)', horizon: h, n: fit.n, beta: round(fit.beta[1], 3), t: round(fit.t[1]), r2: round(fit.r2, 4) });
    }
  }

  // ---------------------------------------------------------------- 输出
  const famCount = Object.fromEntries(FAMILIES.map(f => [f, rows.filter(r => r.family === f).length]));
  const result = {
    generatedAt: new Date().toISOString(),
    sample: {
      structures: rows.length,
      byFamily: famCount,
      firstDay: rows.length ? rows.reduce((m, r) => (r.day < m ? r.day : m), rows[0].day) : null,
      lastDay: rows.length ? rows.reduce((m, r) => (r.day > m ? r.day : m), rows[0].day) : null,
      marksThrough: lastCloseDay,
      hedged: rows.filter(r => r.hedged).length,
      btc: { first: history[closeDays[0]].index, last: history[lastCloseDay].index, min: Math.min(...closeDays.map(d => history[d].index)), max: Math.max(...closeDays.map(d => history[d].index)) }
    },
    baselineBps: Object.fromEntries(HORIZONS.map(h => [h, round(baseline[h] * 1e4)])),
    btcPath: closeDays.map(d => [d, round(history[d].index, 0), round(dvolAt(mh.closeTsOf(d)), 2)]),
    eventStudy,
    volControl,
    panel: {
      horizon: H,
      split: dayOf(SPLIT_TS),
      full: summarize(fitAll, '全样本', usable),
      train: summarize(fitTrain, '样本内 (1–6 月)', train),
      test: summarize(fitTest, '样本外期间单独估计 (7–11 月)', test),
      oos,
      signStable,
      vol: fitVol && { n: fitVol.n, r2: round(fitVol.r2, 4), coef: VOLNAMES.map((name, i) => ({ name, beta: round(fitVol.beta[i], 3), se: round(fitVol.se[i], 3), t: round(fitVol.t[i]) })) }
    },
    aggregate,
    monthly: (() => {
      const m = {};
      for (const r of rows) {
        const k = r.day.slice(0, 7);
        m[k] = m[k] || { month: k, n: 0, byFamily: {} };
        m[k].n++;
        if (r.marks[7]) {
          const f = (m[k].byFamily[r.family] = m[k].byFamily[r.family] || []);
          f.push(r.family === 'bull' || r.family === 'bear' ? r.marks[7].totalBps : r.marks[7].volPoints);
        }
      }
      return Object.values(m).sort((a, b) => a.month.localeCompare(b.month)).map(x => ({
        month: x.month,
        n: x.n,
        byFamily: Object.fromEntries(Object.entries(x.byFamily).map(([f, v]) => {
          const w = winsorize(v, 0.05);
          return [f, { n: v.length, mean: round(w.reduce((s, y) => s + y, 0) / w.length) }];
        }))
      }));
    })()
  };
  fs.writeFileSync(out, JSON.stringify(result, null, 1));
  console.log(`[study] wrote ${out}`);
}

main().catch(err => {
  console.error('[study] failed:', err.stack || err.message);
  process.exit(1);
});
