/**
 * Module 2-B: Spot ETF flows × basis-arbitrage capital linkage
 *
 * Question: how much of US spot BTC ETF flow is the long leg of a cash-and-carry trade
 * (long ETF, short CME futures), as opposed to directional demand?
 *
 * Data
 *   - ETF daily net flow (BTC & USD)        CoinGlass /api/etf/flow
 *   - CME positioning, weekly (Tue)          CFTC Traders in Financial Futures: Bitcoin (133741, 5 BTC)
 *                                            + Micro Bitcoin (133742, 0.1 BTC)
 *   - Daily OI: Binance futures, CME futures CoinGlass /api/openInterest/v3/chart
 *   - Daily OI: Deribit options               CoinGlass /api/option/oi/history
 *   - Carry: 90D basis excess over 3M T-Bill  Module 2 term structure (Binance COIN-M)
 *
 * Validation framework (weekly, aligned to COT Tuesdays, ETF flows summed Wed→Tue)
 *   1. Hedge ratio: ΔLev-funds net short = α + β·ETF flow (full sample + 12-week rolling)
 *   2. Carry dependence: β split by carry above/below T-Bill + interaction regression
 *   3. Lead-lag: corr(Δcarry_t, flow_{t+k}) and corr(Δcarry_t, ΔLF short_{t+k}), k = −4..+4
 *      (weekly carry changes, not levels: carry levels are so autocorrelated that level-on-level
 *       correlations look high at every lag and cannot tell which side leads)
 *   4. Unwind episodes: runs of sub-T-Bill weeks — do ETF outflows and short covering coincide?
 *   5. Decomposition: flow matched by new CME shorts (arbitrage) vs residual (directional)
 */

const fs = require('fs');
const path = require('path');
const { fetchWithTimeout } = require('./http_client');
const { callCoinglassEndpoint } = require('./cdri_fetcher');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'etf_linkage.json');
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const START_DATE = '2024-01-01';
const ROLLING_WEEKS = 12;
const LEAD_LAG_MAX = 4;
const DAY_MS = 86400000;
const CFTC_CONTRACTS = { '133741': 5, '133742': 0.1 }; // BTC per contract

let memoryCache = null;
let memoryCacheTime = 0;

const isoDate = ts => new Date(ts).toISOString().slice(0, 10);
const round = (v, d = 2) => (v == null || !isFinite(v) ? null : Number(Number(v).toFixed(d)));
const sum = arr => arr.reduce((s, v) => s + v, 0);
const mean = arr => (arr.length ? sum(arr) / arr.length : null);

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function pearson(xs, ys) {
  const pairs = [];
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] != null && ys[i] != null && isFinite(xs[i]) && isFinite(ys[i])) pairs.push([xs[i], ys[i]]);
  }
  if (pairs.length < 5) return { r: null, n: pairs.length };
  const mx = mean(pairs.map(p => p[0]));
  const my = mean(pairs.map(p => p[1]));
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return { r: null, n: pairs.length };
  return { r: sxy / Math.sqrt(sxx * syy), n: pairs.length };
}

/**
 * OLS with intercept. X: array of rows (regressors without the constant). Returns coefficients
 * [const, b1, ...], standard errors, t-stats and R². Solved via Gauss-Jordan on X'X.
 */
function ols(X, y) {
  const n = y.length;
  const k = X[0].length + 1;
  if (n <= k + 1) return null;
  const A = X.map(row => [1, ...row]);
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += A[i][a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += A[i][a] * A[i][b];
    }
  }
  const inv = invertMatrix(XtX);
  if (!inv) return null;
  const coef = inv.map(row => sum(row.map((v, j) => v * Xty[j])));
  const ym = mean(y);
  let sse = 0, sst = 0;
  for (let i = 0; i < n; i++) {
    const fit = sum(A[i].map((v, j) => v * coef[j]));
    sse += (y[i] - fit) ** 2;
    sst += (y[i] - ym) ** 2;
  }
  const sigma2 = sse / (n - k);
  const se = inv.map((row, i) => Math.sqrt(Math.max(0, row[i] * sigma2)));
  return {
    coef,
    se,
    t: coef.map((c, i) => (se[i] > 0 ? c / se[i] : null)),
    r2: sst > 0 ? 1 - sse / sst : null,
    n
  };
}

function invertMatrix(M) {
  const n = M.length;
  const A = M.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null;
    [A[c], A[p]] = [A[p], A[c]];
    const piv = A[c][c];
    for (let j = 0; j < 2 * n; j++) A[c][j] /= piv;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) A[r][j] -= f * A[c][j];
    }
  }
  return A.map(row => row.slice(n));
}

function simpleRegression(xs, ys) {
  const X = [];
  const Y = [];
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] != null && ys[i] != null) { X.push([xs[i]]); Y.push(ys[i]); }
  }
  const fit = ols(X, Y);
  if (!fit) return { beta: null, alpha: null, r2: null, tBeta: null, n: Y.length };
  return {
    beta: round(fit.coef[1], 3),
    alpha: round(fit.coef[0], 1),
    r2: round(fit.r2, 3),
    tBeta: round(fit.t[1], 2),
    n: fit.n
  };
}

// ---------------------------------------------------------------------------
// Data acquisition
// ---------------------------------------------------------------------------

async function fetchEtfFlows() {
  const rows = await callCoinglassEndpoint('/api/etf/flow');
  if (!Array.isArray(rows)) throw new Error('CoinGlass ETF flow payload malformed');
  return rows
    // A day is reported once at least one fund has a printed flow; trailing blank days are dropped
    .filter(r => Array.isArray(r.list) && r.list.some(f => f.changeUsd != null))
    .map(r => ({ date: isoDate(r.date), flowBtc: Number(r.change) || 0, flowUsd: Number(r.changeUsd) || 0 }))
    .filter(r => r.date >= START_DATE)
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchCftcBitcoin() {
  const codes = Object.keys(CFTC_CONTRACTS).map(c => `'${c}'`).join(',');
  const params = new URLSearchParams({
    $select: 'report_date_as_yyyy_mm_dd,cftc_contract_market_code,open_interest_all,'
      + 'lev_money_positions_long,lev_money_positions_short,asset_mgr_positions_long,asset_mgr_positions_short,'
      + 'dealer_positions_long_all,dealer_positions_short_all',
    $where: `cftc_contract_market_code in(${codes}) AND report_date_as_yyyy_mm_dd >= '${START_DATE}'`,
    $order: 'report_date_as_yyyy_mm_dd',
    $limit: '5000'
  });
  const resp = await fetchWithTimeout(`https://publicreporting.cftc.gov/resource/gpe5-46if.json?${params}`, { timeout: 20000 });
  if (!resp.ok) throw new Error(`CFTC HTTP ${resp.status}`);
  const raw = await resp.json();

  const byDate = new Map();
  for (const r of raw) {
    const mult = CFTC_CONTRACTS[r.cftc_contract_market_code];
    if (!mult) continue;
    const date = String(r.report_date_as_yyyy_mm_dd).slice(0, 10);
    const acc = byDate.get(date) || { date, oiBtc: 0, lfLongBtc: 0, lfShortBtc: 0, amLongBtc: 0, amShortBtc: 0, dealerNetBtc: 0, contracts: 0 };
    const n = key => Number(r[key]) || 0;
    acc.oiBtc += n('open_interest_all') * mult;
    acc.lfLongBtc += n('lev_money_positions_long') * mult;
    acc.lfShortBtc += n('lev_money_positions_short') * mult;
    acc.amLongBtc += n('asset_mgr_positions_long') * mult;
    acc.amShortBtc += n('asset_mgr_positions_short') * mult;
    acc.dealerNetBtc += (n('dealer_positions_long_all') - n('dealer_positions_short_all')) * mult;
    acc.contracts++;
    byDate.set(date, acc);
  }
  return [...byDate.values()]
    .filter(r => r.contracts === Object.keys(CFTC_CONTRACTS).length)
    .map(({ contracts, ...r }) => ({
      ...r,
      lfNetShortBtc: r.lfShortBtc - r.lfLongBtc,
      amNetLongBtc: r.amLongBtc - r.amShortBtc
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Daily OI panel: Binance futures, CME futures, Deribit options — each in USD and BTC
 */
async function fetchOiPanel() {
  const [futUsd, futBtc, optUsd, optBtc] = await Promise.all([
    callCoinglassEndpoint('/api/openInterest/v3/chart?symbol=BTC&timeType=0&exchangeName=&currency=USD&type=0'),
    callCoinglassEndpoint('/api/openInterest/v3/chart?symbol=BTC&timeType=0&exchangeName=&currency=COIN&type=0'),
    callCoinglassEndpoint('/api/option/oi/history?symbol=BTC&timeType=0&currency=USD'),
    callCoinglassEndpoint('/api/option/oi/history?symbol=BTC&timeType=0&currency=COIN')
  ]);

  const panel = new Map();
  const put = (payload, exchange, field) => {
    if (!payload || !Array.isArray(payload.dateList) || !payload.dataMap?.[exchange]) return;
    const values = payload.dataMap[exchange];
    payload.dateList.forEach((ts, i) => {
      const date = isoDate(ts);
      if (date < START_DATE) return;
      const row = panel.get(date) || { date };
      if (values[i] != null) row[field] = round(Number(values[i]), field.endsWith('Usd') ? 0 : 1);
      if (payload.priceList?.[i] != null && row.price == null) row.price = round(Number(payload.priceList[i]), 1);
      panel.set(date, row);
    });
  };
  put(futUsd, 'Binance', 'binanceFutOiUsd');
  put(futBtc, 'Binance', 'binanceFutOiBtc');
  put(futUsd, 'CME', 'cmeFutOiUsd');
  put(futBtc, 'CME', 'cmeFutOiBtc');
  put(optUsd, 'Deribit', 'deribitOptOiUsd');
  put(optBtc, 'Deribit', 'deribitOptOiBtc');

  return [...panel.values()]
    .filter(r => r.binanceFutOiUsd != null && r.deribitOptOiUsd != null)
    .map(r => ({
      ...r,
      offshoreHedgeOiUsd: round(r.binanceFutOiUsd + r.deribitOptOiUsd, 0),
      offshoreHedgeOiBtc: r.binanceFutOiBtc != null && r.deribitOptOiBtc != null ? round(r.binanceFutOiBtc + r.deribitOptOiBtc, 1) : null
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ---------------------------------------------------------------------------
// Weekly panel & analysis
// ---------------------------------------------------------------------------

/**
 * Align everything to COT report Tuesdays. ETF flows and carry are aggregated over (prevTue, Tue].
 */
function buildWeeklyPanel({ etfFlows, cot, oiPanel, basisSeries }) {
  const oiByDate = new Map(oiPanel.map(r => [r.date, r]));
  const basisByDate = new Map((basisSeries || []).map(r => [r.date, r]));
  const lastValueOnOrBefore = (map, date, field) => {
    for (let t = new Date(date).getTime(), i = 0; i < 7; i++, t -= DAY_MS) {
      const row = map.get(isoDate(t));
      if (row && row[field] != null) return row[field];
    }
    return null;
  };

  const weeks = [];
  for (let i = 1; i < cot.length; i++) {
    const prev = cot[i - 1];
    const cur = cot[i];
    const flows = etfFlows.filter(f => f.date > prev.date && f.date <= cur.date);
    const carry = [];
    const apr = [];
    for (let t = new Date(prev.date).getTime() + DAY_MS; t <= new Date(cur.date).getTime(); t += DAY_MS) {
      const b = basisByDate.get(isoDate(t));
      if (b && b.excessOverTBill != null) carry.push(b.excessOverTBill);
      if (b && b.apr90d != null) apr.push(b.apr90d);
    }
    const price = lastValueOnOrBefore(oiByDate, cur.date, 'price')
      ?? lastValueOnOrBefore(basisByDate, cur.date, 'btcPrice');
    const offNow = lastValueOnOrBefore(oiByDate, cur.date, 'offshoreHedgeOiBtc');
    const offPrev = lastValueOnOrBefore(oiByDate, prev.date, 'offshoreHedgeOiBtc');

    const flowBtc = sum(flows.map(f => f.flowBtc));
    const dLf = cur.lfNetShortBtc - prev.lfNetShortBtc;
    // Arbitrage-matched flow: the part of the ETF flow mirrored by same-direction CME short changes
    let arbMatchedBtc = 0;
    if (flowBtc > 0 && dLf > 0) arbMatchedBtc = Math.min(flowBtc, dLf);
    else if (flowBtc < 0 && dLf < 0) arbMatchedBtc = Math.max(flowBtc, dLf);

    weeks.push({
      weekEnd: cur.date,
      etfDays: flows.length,
      etfFlowBtc: round(flowBtc, 1),
      etfFlowUsd: round(sum(flows.map(f => f.flowUsd)), 0),
      lfNetShortBtc: round(cur.lfNetShortBtc, 1),
      dLfNetShortBtc: round(dLf, 1),
      dAmNetLongBtc: round(cur.amNetLongBtc - prev.amNetLongBtc, 1),
      cmeOiBtc: round(cur.oiBtc, 1),
      dCmeOiBtc: round(cur.oiBtc - prev.oiBtc, 1),
      dOffshoreOiBtc: offNow != null && offPrev != null ? round(offNow - offPrev, 1) : null,
      excessOverTBill: carry.length ? round(mean(carry)) : null,
      apr90d: apr.length ? round(mean(apr)) : null,
      btcPrice: price != null ? Math.round(price) : null,
      arbMatchedBtc: round(arbMatchedBtc, 1),
      directionalBtc: round(flowBtc - arbMatchedBtc, 1)
    });
  }
  return weeks.filter(w => w.etfDays > 0);
}

function analyzeLinkage(weeks, { etfFlows, oiPanel } = {}) {
  const flow = weeks.map(w => w.etfFlowBtc);
  const dLf = weeks.map(w => w.dLfNetShortBtc);
  const dCarry = weeks.map((w, i) => (i > 0 && w.excessOverTBill != null && weeks[i - 1].excessOverTBill != null
    ? w.excessOverTBill - weeks[i - 1].excessOverTBill
    : null));

  // 1. Hedge ratio
  const full = simpleRegression(flow, dLf);
  const rolling = weeks.map((w, i) => {
    if (i < ROLLING_WEEKS - 1) return { weekEnd: w.weekEnd, beta: null, r2: null, corr: null };
    const win = weeks.slice(i - ROLLING_WEEKS + 1, i + 1);
    const reg = simpleRegression(win.map(x => x.etfFlowBtc), win.map(x => x.dLfNetShortBtc));
    const c = pearson(win.map(x => x.etfFlowBtc), win.map(x => x.dLfNetShortBtc));
    return { weekEnd: w.weekEnd, beta: reg.beta, r2: reg.r2, corr: round(c.r, 3) };
  });

  // 2. Carry dependence
  const withCarry = weeks.filter(w => w.excessOverTBill != null);
  const high = withCarry.filter(w => w.excessOverTBill > 0);
  const low = withCarry.filter(w => w.excessOverTBill <= 0);
  const splitHigh = simpleRegression(high.map(w => w.etfFlowBtc), high.map(w => w.dLfNetShortBtc));
  const splitLow = simpleRegression(low.map(w => w.etfFlowBtc), low.map(w => w.dLfNetShortBtc));
  const carryMean = mean(withCarry.map(w => w.excessOverTBill));
  const inter = withCarry.length > 10
    ? ols(
      withCarry.map(w => {
        const e = w.excessOverTBill - carryMean;
        return [w.etfFlowBtc, w.etfFlowBtc * e, e];
      }),
      withCarry.map(w => w.dLfNetShortBtc)
    )
    : null;
  const interaction = inter
    ? {
      betaAtMeanCarry: round(inter.coef[1], 3),
      tBeta: round(inter.t[1], 2),
      betaPerCarryPct: round(inter.coef[2], 4),
      tInteraction: round(inter.t[2], 2),
      carryMean: round(carryMean),
      r2: round(inter.r2, 3),
      n: inter.n
    }
    : null;

  // 3. Lead-lag: positive k = carry change leads flows by k weeks
  const leadLag = [];
  for (let k = -LEAD_LAG_MAX; k <= LEAD_LAG_MAX; k++) {
    const xs = [];
    const yf = [];
    const yl = [];
    for (let i = 0; i < weeks.length; i++) {
      const j = i + k;
      if (j < 0 || j >= weeks.length) continue;
      xs.push(dCarry[i]);
      yf.push(flow[j]);
      yl.push(dLf[j]);
    }
    const cf = pearson(xs, yf);
    const cl = pearson(xs, yl);
    leadLag.push({ lag: k, corrFlow: round(cf.r, 3), corrShort: round(cl.r, 3), n: cf.n });
  }

  // 4. Unwind episodes: contiguous runs of weeks with carry below T-Bill
  const episodes = [];
  let run = null;
  for (const w of weeks) {
    if (w.excessOverTBill != null && w.excessOverTBill < 0) {
      if (!run) run = { start: w.weekEnd, weeks: [] };
      run.weeks.push(w);
    } else if (run) {
      episodes.push(run);
      run = null;
    }
  }
  if (run) episodes.push({ ...run, ongoing: true });
  const unwindEpisodes = episodes.map(ep => {
    const cumFlow = sum(ep.weeks.map(w => w.etfFlowBtc));
    const cumDLf = sum(ep.weeks.map(w => w.dLfNetShortBtc));
    return {
      start: ep.start,
      end: ep.weeks[ep.weeks.length - 1].weekEnd,
      weeks: ep.weeks.length,
      minCarry: round(Math.min(...ep.weeks.map(w => w.excessOverTBill))),
      cumFlowBtc: round(cumFlow, 0),
      cumFlowUsd: round(sum(ep.weeks.map(w => w.etfFlowUsd)), 0),
      cumDLfNetShortBtc: round(cumDLf, 0),
      jointUnwind: cumFlow < 0 && cumDLf < 0,
      ongoing: !!ep.ongoing
    };
  });
  const both = ws => (ws.length ? ws.filter(w => w.etfFlowBtc < 0 && w.dLfNetShortBtc < 0).length / ws.length : null);
  const unwindSync = {
    subTbillWeeks: low.length,
    syncShareSubTbill: round(both(low), 3),
    syncShareOther: round(both(high), 3)
  };

  // 5. Decomposition
  let cumFlow = 0, cumArb = 0, cumDir = 0;
  const decomposition = weeks.map(w => {
    cumFlow += w.etfFlowBtc;
    cumArb += w.arbMatchedBtc;
    cumDir += w.directionalBtc;
    return { weekEnd: w.weekEnd, cumFlowBtc: round(cumFlow, 0), cumArbBtc: round(cumArb, 0), cumDirectionalBtc: round(cumDir, 0) };
  });
  const recent = weeks.slice(-ROLLING_WEEKS);
  const grossFlow = sum(recent.map(w => Math.abs(w.etfFlowBtc)));
  const arbShare12w = grossFlow > 0 ? sum(recent.map(w => Math.abs(w.arbMatchedBtc))) / grossFlow : null;
  const grossAll = sum(weeks.map(w => Math.abs(w.etfFlowBtc)));
  const arbShareAll = grossAll > 0 ? sum(weeks.map(w => Math.abs(w.arbMatchedBtc))) / grossAll : null;

  // Robustness: daily ETF flow vs daily CME OI change (CoinGlass), and weekly vs offshore OI change
  let dailyCme = { r: null, n: 0 };
  if (etfFlows && oiPanel) {
    const oiMap = new Map(oiPanel.map(r => [r.date, r]));
    const xs = [];
    const ys = [];
    for (const f of etfFlows) {
      const today = oiMap.get(f.date);
      const prev = oiMap.get(isoDate(new Date(f.date).getTime() - DAY_MS));
      if (today?.cmeFutOiBtc != null && prev?.cmeFutOiBtc != null) {
        xs.push(f.flowBtc);
        ys.push(today.cmeFutOiBtc - prev.cmeFutOiBtc);
      }
    }
    dailyCme = pearson(xs, ys);
  }
  const offshoreCorr = pearson(flow, weeks.map(w => w.dOffshoreOiBtc));

  const rec = rolling[rolling.length - 1] || {};
  const lead1 = leadLag.find(l => l.lag === 1);
  const lag1 = leadLag.find(l => l.lag === -1);
  const evidence = buildVerdict({ full, splitHigh, splitLow, interaction, lead1, lag1, unwindSync, arbShare12w, recent: rec });

  return {
    hedgeRatio: { full, recent: rec, rolling },
    carryDependence: { high: { ...splitHigh, weeks: high.length }, low: { ...splitLow, weeks: low.length }, interaction },
    leadLag,
    unwindEpisodes,
    unwindSync,
    decomposition,
    arbShare12w: round(arbShare12w, 3),
    arbShareAll: round(arbShareAll, 3),
    robustness: {
      dailyEtfVsCmeOi: { r: round(dailyCme.r, 3), n: dailyCme.n },
      weeklyEtfVsOffshoreOi: { r: round(offshoreCorr.r, 3), n: offshoreCorr.n }
    },
    verdict: evidence
  };
}

function buildVerdict({ full, splitHigh, splitLow, interaction, lead1, lag1, unwindSync, arbShare12w, recent }) {
  const checks = [
    {
      key: 'hedgeRatio',
      label: '对冲比例',
      pass: full.beta != null && full.beta > 0.15 && full.tBeta != null && full.tBeta > 2,
      detail: `全样本 ΔCME 杠杆基金净空头 对 ETF 周流入回归 β = ${fmt(full.beta, 2)} (t = ${fmt(full.tBeta, 1)}, R² = ${fmt(full.r2, 2)}, n = ${full.n})`
    },
    {
      key: 'carryDependence',
      label: '随基差变化',
      pass: (interaction && interaction.betaPerCarryPct > 0 && interaction.tInteraction > 2)
        || (splitHigh.beta != null && splitLow.beta != null && splitHigh.beta - splitLow.beta > 0.1),
      detail: `基差高于美债周 β = ${fmt(splitHigh.beta, 2)} vs 低于美债周 β = ${fmt(splitLow.beta, 2)}；交互项每 1% 超额基差 β 变化 ${fmt(interaction?.betaPerCarryPct, 3)} (t = ${fmt(interaction?.tInteraction, 1)})`
    },
    {
      key: 'leadLag',
      label: '基差领先资金',
      // Forward correlation must be material and clearly stronger than the reverse direction
      pass: lead1 && lead1.corrFlow != null && lead1.corrFlow > 0.15
        && (lag1?.corrFlow == null || lead1.corrFlow - lag1.corrFlow > 0.05),
      detail: `本周基差变化 → 下周 ETF 流入相关 ${fmt(lead1?.corrFlow, 2)}（反向：上周流入 → 本周基差变化 ${fmt(lag1?.corrFlow, 2)}）；→ 下周空头增量相关 ${fmt(lead1?.corrShort, 2)}`
    },
    {
      key: 'unwindSync',
      label: '同步撤离',
      pass: unwindSync.syncShareSubTbill != null && unwindSync.syncShareOther != null
        && unwindSync.syncShareSubTbill - unwindSync.syncShareOther > 0.1,
      detail: `基差低于美债的周里 ETF 流出且空头回补同时发生的比例 ${pct(unwindSync.syncShareSubTbill)}，其他周 ${pct(unwindSync.syncShareOther)}`
    }
  ];
  const passed = checks.filter(c => c.pass).length;
  const level = passed === checks.length ? 'STRONG' : passed >= 2 ? 'MODERATE' : 'WEAK';
  const levelLabel = { STRONG: '强联动', MODERATE: '中等联动', WEAK: '弱联动' }[level];
  return {
    level,
    levelLabel,
    passed,
    total: checks.length,
    checks,
    summary: `${passed}/${checks.length} 项检验通过（${levelLabel}）。近 ${ROLLING_WEEKS} 周对冲比例 β = ${fmt(recent.beta, 2)}，ETF 毛流量中被 CME 新增空头匹配的比例约 ${pct(arbShare12w)}。`
  };
}

function fmt(v, d) {
  return v == null || !isFinite(v) ? '--' : Number(v).toFixed(d);
}
function pct(v) {
  return v == null || !isFinite(v) ? '--' : `${(v * 100).toFixed(0)}%`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function buildEtfLinkage(basisSeries) {
  const [etfFlows, cot, oiPanel] = await Promise.all([fetchEtfFlows(), fetchCftcBitcoin(), fetchOiPanel()]);
  const weeks = buildWeeklyPanel({ etfFlows, cot, oiPanel, basisSeries });
  const analysis = analyzeLinkage(weeks, { etfFlows, oiPanel });
  const latestCot = cot[cot.length - 1] || null;
  return {
    generatedAt: Date.now(),
    metadata: {
      sources: {
        etfFlows: 'CoinGlass 美国现货 BTC ETF 日净流入 (BTC/USD)',
        cme: 'CFTC Traders in Financial Futures：CME Bitcoin (5 BTC) + Micro Bitcoin (0.1 BTC)，每周二持仓',
        oi: 'CoinGlass 日度 OI：Binance 期货、CME 期货、Deribit 期权',
        carry: 'Module 2 币安 90D 恒定期限基差 − FRED 3M 美债（CME 基差的代理变量）'
      },
      weekDefinition: 'COT 报告日 (周二) 对齐；ETF 流量与基差按 (上周二, 本周二] 汇总',
      rollingWeeks: ROLLING_WEEKS,
      caveats: [
        '杠杆基金 (Leveraged Funds) 不全是期现套利盘，β 是套利占比的上限估计而非精确值。',
        '基差使用币安币本位交割合约，CME 基差通常更高，绝对水平存在偏差但方向一致。',
        '部分机构在 Binance / Deribit 对冲，CME 回归无法覆盖，离岸对冲 OI 单独展示。'
      ]
    },
    latestCot,
    weeks,
    oiPanel,
    ...analysis
  };
}

function readDiskCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (e) {
    console.warn('[EtfLinkage] Error reading cache:', e.message);
  }
  return null;
}

async function getEtfLinkageData(basisSeries, force = false) {
  const now = Date.now();
  if (!force && memoryCache && now - memoryCacheTime < CACHE_TTL_MS) return memoryCache;
  if (!force) {
    const disk = readDiskCache();
    if (disk && now - disk.generatedAt < CACHE_TTL_MS) {
      memoryCache = disk;
      memoryCacheTime = now;
      return disk;
    }
  }
  try {
    const data = await buildEtfLinkage(basisSeries);
    memoryCache = data;
    memoryCacheTime = now;
    try {
      fs.writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf8');
    } catch (e) {
      console.warn('[EtfLinkage] Error persisting cache:', e.message);
    }
    return data;
  } catch (err) {
    console.error('[EtfLinkage] Build failed, using stale cache:', err.message);
    const disk = memoryCache || readDiskCache();
    if (disk) return { ...disk, stale: true };
    throw err;
  }
}

module.exports = {
  getEtfLinkageData,
  buildWeeklyPanel,
  analyzeLinkage,
  simpleRegression,
  ols,
  pearson,
  CACHE_FILE
};
