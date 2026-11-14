//@lang=wrun-ts
// Coinbase 急单雷达 + TWAP 侦测（BTC 本位）
// A 急单（1 秒插针）：把每根 K 线里的成交按秒切成"伪 1s K 线"，三个条件同时满足才算：
//   1. 推出：这一秒相对上一秒收盘被推出 min_sweep_bps 以上；
//   2. 放量：这一秒同方向的主动成交 ≥ 周围 vol_window_s 秒平均每秒成交的 vol_mult 倍；
//   3. 插针：推出后 revert_s 秒内价格回撤推出幅度的 revert_pct 以上（单边推动不算）。
//   因为要等回撤，标记和报警会比插针晚 revert_s 秒。
// B TWAP：同方向、数量相近、按固定周期（1m / 5m）反复出现的单 = 拆单执行的 TWAP。和 A 一样防随机凑数：
//   1. 数量：新子单要和整条链的平均数量相近（不只是和上一张比，避免数量一路漂移也被串起来）；
//   2. 相位对照：同样宽度的窗口放在半个周期前，若那里也有同方向、数量相近的单，说明这种单本来就多，
//      "正好一个周期前有一张"只是巧合，这一环不接；
//   3. 子单数量在 twap_min_btc..twap_max_btc 之间才算（默认只统计 ≥ 10 BTC，与 A 一致）。
// 用法：COINBASE BTC-USD 的 1m 图（tape 不支持 1s 图，报警最细也只支持 1m）。

section("A · 急单");
param.number("min_print_btc", 0.01, { min: 0.01, max: 100, step: 0.01, description: "单笔成交最低数量（BTC）；历史数据只保留约 $10K 以上的成交，实时数据完整" });
param.number("min_order_btc", 10, { min: 0.01, max: 1000, step: 0.5, description: "只统计这 1 秒同方向主动成交量 ≥ 此值的插针（BTC）" });
param.number("vol_mult", 10, { min: 1, max: 200, step: 0.5, description: "放量：这 1 秒同方向成交 ≥ 周围平均每秒成交量的倍数" });
param.number("vol_window_s", 300, { min: 30, max: 3600, step: 30, description: "放量：计算周围平均成交量的时间窗（秒）" });
param.number("min_sweep_bps", 6, { min: 0, max: 200, step: 0.5, description: "推出：这 1 秒相对上一秒收盘被推出的幅度（基点）" });
param.number("revert_s", 10, { min: 1, max: 120, step: 1, description: "插针：推出后多少秒内看回撤（秒）" });
param.number("revert_pct", 50, { min: 0, max: 100, step: 5, description: "插针：价格至少回撤推出幅度的百分之多少" });

section("B · TWAP");
param.number("merge_ms", 50, { min: 0, max: 1000, step: 10, description: "同方向成交合并为一张子单的时间窗（毫秒）" });
param.bool("twap_1m", true, { description: "侦测 1 分钟周期的 TWAP" });
param.bool("twap_5m", true, { description: "侦测 5 分钟周期的 TWAP" });
param.number("twap_min_btc", 10, { min: 0.01, max: 1000, step: 0.5, description: "只统计数量 ≥ 此值的 TWAP 子单（BTC）" });
param.number("twap_max_btc", 200, { min: 0.01, max: 5000, step: 1, description: "TWAP 子单最大数量（BTC）" });
param.number("twap_size_tol", 20, { min: 1, max: 100, step: 1, description: "相邻两张子单的数量允许差异（%）" });
param.number("twap_jitter_s", 3, { min: 0, max: 60, step: 0.5, description: "周期间隔允许的误差（秒）" });
param.int("twap_min_hits", 4, { min: 3, max: 50, description: "按周期连续出现几次判定为 TWAP" });
param.int("twap_noise_max", 0, { min: 0, max: 20, description: "相位对照：半个周期前的同宽窗口里，最多允许几张同类单" });

section("显示");
param.int("tz_hours", 8, { min: -12, max: 14, description: "报警消息时间的 UTC 偏移小时" });

chart.interval_sec();

// 第一输入保持为跟随当前图表的标量行情；tape 的 size 单位是 BTC。
input("close", ohlcv.close);
input("prints", tape.cells, { max_cells: 20000, min_size: 0.01, history: "7d" });

// 价格图：A 急单为实心气泡，B TWAP 子单为空心圆环，都画在自己的成交时间上。
plot.marks({ name: "urgent", slots: 6, size: { law: "sqrt", unit: "@min_order_btc", scale: 5 }, opacity_pct: 45, look: 0, text: { mode: 1, field: "qty", format: "compact", min_px: 22 }, x: 1, colors: ["#F05351", "#27A69A"], tooltip: "{{side}} wick {{qty:compact}} BTC in 1s, {{fills}} fills, tip {{price}}", panel: "overlay" });
plot.marks({ name: "twap", slots: 16, size: { law: "sqrt", unit: "@twap_min_btc", scale: 3 }, opacity_pct: 30, look: 2, text: { mode: 0 }, x: 1, colors: ["#FF9800", "#4FC3F7"], tooltip: "TWAP {{side}} {{qty:compact}} BTC, hit #{{fills}}", panel: "overlay" });

// 下方同一个面板：A 的急买 / 急卖数量柱，B 的 TWAP 累计执行量折线（买为正、卖为负）。
output("urgent_buy", histogram, lower, { color: "#27A69A", label: "急买 BTC", unit: "BTC", format: "0.00" });
output("urgent_sell", histogram, lower, { color: "#F05351", label: "急卖 BTC", unit: "BTC", format: "0.00" });
output("twap_flow", line, lower, { color: "#B388FF", width: 2, label: "TWAP 累计 BTC", unit: "BTC", format: "0.00" });
output("max_sweep_bps", none, lower, { label: "最大冲击 bps", format: "0.0" });
const hitBuy = output("hit_buy", none, lower);
const hitSell = output("hit_sell", none, lower);
const hitTwap = output("hit_twap", none, lower);
const buyWords = string("buy_words", { max_bytes: 200 });
const sellWords = string("sell_words", { max_bytes: 200 });
const twapWords = string("twap_words", { max_bytes: 200 });
alert("urgent_buy_alert", { when: hitBuy, text: buyWords, every_bar: true, message: "Coinbase 急买单：{{symbol}} {{close}}", description: "1 秒内放量主动买入把价格推高、随后回落的上插针" });
alert("urgent_sell_alert", { when: hitSell, text: sellWords, every_bar: true, message: "Coinbase 急卖单：{{symbol}} {{close}}", description: "1 秒内放量主动卖出把价格压低、随后回升的下插针" });
alert("twap_alert", { when: hitTwap, text: twapWords, every_bar: true, message: "Coinbase TWAP：{{symbol}} {{close}}", description: "同方向、数量相近的单按固定周期连续出现" });

// ---- A 的状态 ----
const MAX_PRINTS: i32 = 20000;
const MAX_GROUPS: i32 = 512;
const order = new StaticArray<i32>(MAX_PRINTS);
const gQty = new StaticArray<f64>(MAX_GROUPS);
const gPx = new StaticArray<f64>(MAX_GROUPS);
const gBps = new StaticArray<f64>(MAX_GROUPS);
const gSide = new StaticArray<i32>(MAX_GROUPS);
const gFills = new StaticArray<i32>(MAX_GROUPS);
const gOff = new StaticArray<f64>(MAX_GROUPS);
const gUsed = new StaticArray<bool>(MAX_GROUPS);
const gRatio = new StaticArray<f64>(MAX_GROUPS);
const gRet = new StaticArray<f64>(MAX_GROUPS);
// 等待回撤确认的候选插针
const P_MAX: i32 = 32;
const pSide = new StaticArray<i32>(P_MAX);
const pQty = new StaticArray<f64>(P_MAX);
const pPx = new StaticArray<f64>(P_MAX);
const pRef = new StaticArray<f64>(P_MAX);
const pBps = new StaticArray<f64>(P_MAX);
const pFills = new StaticArray<i32>(P_MAX);
const pT = new StaticArray<f64>(P_MAX);
const pDeadline = new StaticArray<f64>(P_MAX);
const pRatio = new StaticArray<f64>(P_MAX);
let pCount: i32 = 0;

// ---- B 的状态：最近的候选子单，按时间顺序的环形缓冲；每个周期各记一条链 ----
const RING: i32 = 8192;
const rT = new StaticArray<f64>(RING);       // 绝对时间（毫秒）
const rQ = new StaticArray<f64>(RING);       // 数量（BTC）
const rPx = new StaticArray<f64>(RING);      // 成交价
const rSide = new StaticArray<i32>(RING);
const rLen = new StaticArray<i32>(RING * 2); // [idx * 2 + 周期]：链长
const rCum = new StaticArray<f64>(RING * 2); // 链上累计数量（BTC）
const rStart = new StaticArray<f64>(RING * 2);
const TW_MAX: i32 = 64;
const twIdx = new StaticArray<i32>(TW_MAX);  // 本根 K 线里属于 TWAP 链的子单
const twHit = new StaticArray<i32>(TW_MAX);

let minPrintBtc = 0.1;
let mergeMs = 50.0;
let minOrder = 3.0;
let minSweepBps = 3.0;
let volMult = 10.0;
let volTauS = 300.0;
let revertMs = 10000.0;
let revertFrac = 0.5;
let tzSec = 28800.0;
let intervalMs = 60000.0;
let twapOn0 = true;
let twapOn1 = true;
let twapMin = 0.1;
let twapMax = 5.0;
let sizeTol = 0.2;
let jitterMs = 3000.0;
let minHits: i32 = 4;
let noiseMax: i32 = 0;

let curOpen = false;
let curSide: i32 = 0;
let curStart = 0.0;
let curQty = 0.0;
let curFirst = 0.0;
let curExt = 0.0;
let curFills: i32 = 0;
let groupCount: i32 = 0;
// 伪 1s K 线
let secIdx: i32 = -1;
let sOpen = 0.0;
let sHigh = 0.0;
let sLow = 0.0;
let sClose = 0.0;
let sHighOff = 0.0;
let sLowOff = 0.0;
let sBuy = 0.0;
let sSell = 0.0;
let sBuyN: i32 = 0;
let sSellN: i32 = 0;
let refPx = 0.0; // 上一个有成交的秒的收盘价，跨 K 线保留
let refT = 0.0;  // 那一秒的开始时间（毫秒）
let lastPx = 0.0; // 最新成交价，跨 K 线保留
// 周围平均每秒成交量（BTC/秒）：按时间指数衰减的成交速率，时间常数 vol_window_s
let rate = 0.0;
let rateT = 0.0;
let firstT = 0.0;
const REF_MAX_GAP_MS = 5000.0; // 参考价超过 5 秒就过期，改用这一秒自己的开盘价
let buyQty = 0.0;
let sellQty = 0.0;
let maxBps = 0.0;
let barMs = 0.0;

let ringTotal: i32 = 0;
let twCount: i32 = 0;
// 本根 K 线里新确认的 TWAP（链长刚到 min_hits）中累计最大的一条，用于报警
let nbFound = false;
let nbSide: i32 = 0;
let nbK: i32 = 0;
let nbLen: i32 = 0;
let nbCum = 0.0;
let nbQ = 0.0;
let nbT = 0.0;
// 当前活跃的 TWAP 链，用于下方折线
let actAlive = false;
let actSide: i32 = 0;
let actK: i32 = 0;
let actLen: i32 = 0;
let actCum = 0.0;
let actLastT = 0.0;

function onStart(): void {
  minPrintBtc = p_min_print_btc();
  mergeMs = p_merge_ms();
  minOrder = p_min_order_btc();
  minSweepBps = p_min_sweep_bps();
  volMult = p_vol_mult();
  volTauS = p_vol_window_s();
  revertMs = p_revert_s() * 1000.0;
  revertFrac = p_revert_pct() / 100.0;
  tzSec = f64(p_tz_hours()) * 3600.0;
  intervalMs = p_chart_interval_sec() * 1000.0;
  twapOn0 = pb_twap_1m();
  twapOn1 = pb_twap_5m();
  twapMin = p_twap_min_btc();
  twapMax = p_twap_max_btc();
  sizeTol = p_twap_size_tol() / 100.0;
  jitterMs = p_twap_jitter_s() * 1000.0;
  minHits = i32(p_twap_min_hits());
  noiseMax = i32(p_twap_noise_max());
}

function periodMs(k: i32): f64 {
  return k == 0 ? 60000.0 : 300000.0;
}

// 环形缓冲里第一个时间 >= t 的序号
function firstAtOrAfter(t: f64): i32 {
  let lo = ringTotal > RING ? ringTotal - RING : 0;
  let hi = ringTotal;
  while (lo < hi) {
    const mid = lo + (hi - lo) / 2;
    if (rT[mid % RING] < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function onChain(idx: i32, k: i32, len: i32, cum: f64, t: f64, q: f64, side: i32): void {
  if (twCount < TW_MAX && (twCount == 0 || twIdx[twCount - 1] != idx)) {
    twIdx[twCount] = idx;
    twHit[twCount] = len;
    twCount += 1;
  }
  if (len == minHits && (!nbFound || cum > nbCum)) {
    nbFound = true;
    nbSide = side;
    nbK = k;
    nbLen = len;
    nbCum = cum;
    nbQ = q;
    nbT = t;
  }
  const stale = !actAlive || t - actLastT > periodMs(actK) + jitterMs;
  if (stale || (side == actSide && k == actK) || len >= actLen) {
    actAlive = true;
    actSide = side;
    actK = k;
    actLen = len;
    actCum = cum;
    actLastT = t;
  }
}

// B：[lo, hi] 时间窗里同方向、数量与 q 相近的单有几张
function countSimilar(lo: f64, hi: f64, side: i32, q: f64): i32 {
  let c: i32 = 0;
  let s = firstAtOrAfter(lo);
  while (s < ringTotal) {
    const ii = s % RING;
    if (rT[ii] > hi) break;
    if (rSide[ii] == side && Math.abs(rQ[ii] - q) <= sizeTol * Math.max(rQ[ii], q)) c += 1;
    s += 1;
  }
  return c;
}

// B：把一张合并后的单放进环形缓冲，并接到一个周期前、同方向、数量相近的那张单的链上
function twapPush(t: f64, q: f64, px: f64, side: i32): void {
  if (q < twapMin || q > twapMax) return;
  const idx = ringTotal % RING;
  rT[idx] = t;
  rQ[idx] = q;
  rPx[idx] = px;
  rSide[idx] = side;
  for (let k: i32 = 0; k < 2; k++) {
    let len: i32 = 1;
    let cum = q;
    let start = t;
    const on = k == 0 ? twapOn0 : twapOn1;
    // 半个周期前的对照窗口太"热闹"，说明这种单本来就多，不接链
    const noisy = on && countSimilar(t - periodMs(k) * 0.5 - jitterMs, t - periodMs(k) * 0.5 + jitterMs, side, q) > noiseMax;
    if (on && !noisy) {
      const p = periodMs(k);
      const hiT = t - p + jitterMs;
      let s = firstAtOrAfter(t - p - jitterMs);
      while (s < ringTotal) {
        const ii = s % RING;
        if (rT[ii] > hiT) break;
        const pl = rLen[ii * 2 + k];
        const avg = rCum[ii * 2 + k] / f64(pl);
        if (rSide[ii] == side && Math.abs(rQ[ii] - q) <= sizeTol * Math.max(rQ[ii], q) && Math.abs(avg - q) <= sizeTol * Math.max(avg, q)) {
          if (pl + 1 > len) {
            len = pl + 1;
            cum = rCum[ii * 2 + k] + q;
            start = rStart[ii * 2 + k];
          }
        }
        s += 1;
      }
    }
    rLen[idx * 2 + k] = len;
    rCum[idx * 2 + k] = cum;
    rStart[idx * 2 + k] = start;
    if (on && !noisy && len >= minHits) onChain(idx, k, len, cum, t, q, side);
  }
  ringTotal += 1;
}

// B：子单合并结束，送去 TWAP 侦测
function closeGroup(): void {
  if (!curOpen) return;
  curOpen = false;
  twapPush(barMs + curStart, curQty, curFirst, curSide);
}

function recordEvent(side: i32, qty: f64, px: f64, bps: f64, fills: i32, off: f64, ratio: f64, ret: f64): void {
  if (side > 0) buyQty += qty; else sellQty += qty;
  if (bps > maxBps) maxBps = bps;
  let slot = groupCount;
  if (groupCount < MAX_GROUPS) {
    groupCount += 1;
  } else {
    let smallest = 0;
    for (let g: i32 = 1; g < MAX_GROUPS; g++) {
      if (gQty[g] < gQty[smallest]) smallest = g;
    }
    if (qty <= gQty[smallest]) return;
    slot = smallest;
  }
  gQty[slot] = qty;
  gPx[slot] = px;
  gBps[slot] = bps;
  gSide[slot] = side;
  gFills[slot] = fills;
  gOff[slot] = off > 0.0 ? off : 0.0;
  gUsed[slot] = false;
  gRatio[slot] = ratio;
  gRet[slot] = ret;
}

function addPending(side: i32, qty: f64, px: f64, ref: f64, bps: f64, fills: i32, t: f64, deadline: f64, ratio: f64): void {
  if (pCount >= P_MAX) return;
  pSide[pCount] = side;
  pQty[pCount] = qty;
  pPx[pCount] = px;
  pRef[pCount] = ref;
  pBps[pCount] = bps;
  pFills[pCount] = fills;
  pT[pCount] = t;
  pDeadline[pCount] = deadline;
  pRatio[pCount] = ratio;
  pCount += 1;
}

// 到期的候选：用此刻的最新价看回撤了多少；回撤够 = 插针，否则是单边推动，丢弃
function confirmDue(now: f64): void {
  let w: i32 = 0;
  for (let i: i32 = 0; i < pCount; i++) {
    if (pDeadline[i] <= now) {
      const push = Math.abs(pPx[i] - pRef[i]);
      const back = pSide[i] > 0 ? pPx[i] - lastPx : lastPx - pPx[i];
      const ret = push > 0.0 ? back / push : 0.0;
      if (ret >= revertFrac) recordEvent(pSide[i], pQty[i], pPx[i], pBps[i], pFills[i], pT[i] - barMs, pRatio[i], ret);
    } else {
      if (w != i) {
        pSide[w] = pSide[i];
        pQty[w] = pQty[i];
        pPx[w] = pPx[i];
        pRef[w] = pRef[i];
        pBps[w] = pBps[i];
        pFills[w] = pFills[i];
        pT[w] = pT[i];
        pDeadline[w] = pDeadline[i];
        pRatio[w] = pRatio[i];
      }
      w += 1;
    }
  }
  pCount = w;
}

// A：一秒结束，相对上一秒收盘量出向上 / 向下被推出的幅度
function closeSecond(): void {
  if (secIdx < 0) return;
  const secStart = barMs + f64(secIdx) * 1000.0;
  const ref = refPx > 0.0 && secStart - refT <= REF_MAX_GAP_MS ? refPx : sOpen;
  const upBps = ref > 0.0 ? ((sHigh - ref) / ref) * 10000.0 : 0.0;
  const dnBps = ref > 0.0 ? ((ref - sLow) / ref) * 10000.0 : 0.0;

  // 周围平均每秒成交量：先衰减到这一秒之前，不含这一秒自己
  if (rateT > 0.0) rate *= Math.exp(-(secStart - rateT) / (volTauS * 1000.0));
  else firstT = secStart;
  const warm = rateT > 0.0 && secStart - firstT >= volTauS * 1000.0;
  if (warm) {
    const deadline = secStart + 1000.0 + revertMs;
    const buyRatio = rate > 0.0 ? sBuy / rate : 0.0;
    const sellRatio = rate > 0.0 ? sSell / rate : 0.0;
    if (sBuy >= minOrder && upBps >= minSweepBps && sBuy >= volMult * rate) {
      addPending(1, sBuy, sHigh, ref, upBps, sBuyN, barMs + sHighOff, deadline, buyRatio);
    }
    if (sSell >= minOrder && dnBps >= minSweepBps && sSell >= volMult * rate) {
      addPending(-1, sSell, sLow, ref, dnBps, sSellN, barMs + sLowOff, deadline, sellRatio);
    }
  }
  rate += (sBuy + sSell) / volTauS;
  rateT = secStart;

  refPx = sClose;
  refT = secStart;
  secIdx = -1;
}

function pad2(v: i32): void {
  if (v < 10) sb_text("0");
  sb_int(v);
}

function writeClock(epochSec: f64): void {
  const t = epochSec + tzSec;
  const secOfDay = i32(t - Math.floor(t / 86400.0) * 86400.0);
  pad2(secOfDay / 3600);
  sb_text(":");
  pad2((secOfDay % 3600) / 60);
  sb_text(":");
  pad2(secOfDay % 60);
}

// 例："急卖 2.10 BTC | 量 14x | 冲击 9.2bps 回撤 70% | 针尖 80410.00 | 20:17:03"
function writeWords(g: i32): void {
  sb_clear();
  sb_text(gSide[g] > 0 ? "急买 " : "急卖 ");
  sb_f64(gQty[g], 2);
  sb_text(" BTC | 量 ");
  sb_f64(gRatio[g], 0);
  sb_text("x | 冲击 ");
  sb_f64(gBps[g], 1);
  sb_text("bps 回撤 ");
  sb_int(i32(Math.round(gRet[g] * 100.0)));
  sb_text("% | 针尖 ");
  sb_f64(gPx[g], 2);
  sb_text(" | ");
  writeClock(bar.time() + gOff[g] / 1000.0);
}

// 例："TWAP 买 | 60s | 每笔 0.50 BTC | 已 4 次 累计 2.01 BTC | 下次约 14:05:27"
function writeTwapWords(): void {
  sb_clear();
  sb_text(nbSide > 0 ? "TWAP 买 | " : "TWAP 卖 | ");
  sb_text(nbK == 0 ? "60s" : "300s");
  sb_text(" | 每笔 ");
  sb_f64(nbQ, 2);
  sb_text(" BTC | 已 ");
  sb_int(nbLen);
  sb_text(" 次 累计 ");
  sb_f64(nbCum, 2);
  sb_text(" BTC | 下次约 ");
  writeClock((nbT + periodMs(nbK)) / 1000.0);
}

function onBar(): void {
  groupCount = 0;
  buyQty = 0.0;
  sellQty = 0.0;
  maxBps = 0.0;
  curOpen = false;
  secIdx = -1;
  twCount = 0;
  nbFound = false;
  barMs = bar.time() * 1000.0;

  const n = in_prints_cells();
  if (n > 0) {
    const cells = in_prints_view();
    const m = i32(n / 4);
    let sorted = true;
    for (let i: i32 = 0; i < m; i++) {
      order[i] = i;
      if (i > 0 && cells[i * 4] < cells[(i - 1) * 4]) sorted = false;
    }
    if (!sorted) {
      let gap = i32(m / 2);
      while (gap > 0) {
        let i = gap;
        while (i < m) {
          const key = order[i];
          const keyOff = cells[key * 4];
          let j = i;
          while (j >= gap && cells[order[j - gap] * 4] > keyOff) {
            order[j] = order[j - gap];
            j -= gap;
          }
          order[j] = key;
          i += 1;
        }
        gap = i32(gap / 2);
      }
    }

    for (let k: i32 = 0; k < m; k++) {
      const j = order[k] * 4;
      const off = cells[j];
      const px = cells[j + 1];
      const qty = cells[j + 2];
      if (qty < minPrintBtc) continue;
      const side = cells[j + 3] > 0.0 ? 1 : -1;
      // A：先用这笔之前的最新价确认已到期的候选
      if (pCount > 0) confirmDue(barMs + off);

      // A：按秒切桶
      const sec = i32(Math.floor(off / 1000.0));
      if (sec != secIdx) {
        closeSecond();
        secIdx = sec;
        sOpen = px;
        sHigh = px;
        sLow = px;
        sHighOff = off;
        sLowOff = off;
        sBuy = 0.0;
        sSell = 0.0;
        sBuyN = 0;
        sSellN = 0;
      }
      if (px > sHigh) { sHigh = px; sHighOff = off; }
      if (px < sLow) { sLow = px; sLowOff = off; }
      sClose = px;
      lastPx = px;
      if (side > 0) { sBuy += qty; sBuyN += 1; } else { sSell += qty; sSellN += 1; }

      // B：同方向、merge_ms 内的成交合并成一张子单
      if (curOpen && side == curSide && off - curStart <= mergeMs) {
        curQty += qty;
        curFills += 1;
        curExt = side > 0 ? Math.max(curExt, px) : Math.min(curExt, px);
      } else {
        closeGroup();
        curOpen = true;
        curSide = side;
        curStart = off;
        curQty = qty;
        curFirst = px;
        curExt = px;
        curFills = 1;
      }
    }
    closeGroup();
    closeSecond();
  }
  // 已收盘的 K 线：收盘前到期的候选用收盘时的最新价确认；进行中的 K 线等后续成交
  if (pCount > 0 && !bar.isLast()) confirmDue(barMs + intervalMs);

  // A：每根 K 线最多画数量最大的 6 次插针
  const slots = groupCount < 6 ? groupCount : 6;
  for (let s: i32 = 0; s < slots; s++) {
    let best = -1;
    for (let g: i32 = 0; g < groupCount; g++) {
      if (gUsed[g]) continue;
      if (best < 0 || gQty[g] > gQty[best]) best = g;
    }
    if (best >= 0) {
      gUsed[best] = true;
      out_urgent_mark(s, gPx[best], gQty[best], gSide[best] > 0 ? 1 : 0, gFills[best], i32(gOff[best]));
    }
  }

  // B：每根 K 线最多画最近的 16 张 TWAP 子单
  const twFrom = twCount > 16 ? twCount - 16 : 0;
  for (let s: i32 = twFrom; s < twCount; s++) {
    const ii = twIdx[s];
    const offMs = rT[ii] - barMs;
    out_twap_mark(s - twFrom, rPx[ii], rQ[ii], rSide[ii] > 0 ? 1 : 0, twHit[s], i32(offMs > 0.0 ? offMs : 0.0));
  }

  let bestBuy = -1;
  let bestSell = -1;
  for (let g: i32 = 0; g < groupCount; g++) {
    if (gSide[g] > 0) {
      if (bestBuy < 0 || gQty[g] > gQty[bestBuy]) bestBuy = g;
    } else {
      if (bestSell < 0 || gQty[g] > gQty[bestSell]) bestSell = g;
    }
  }

  // TWAP 链超过一个周期加误差还没有下一张子单，视为结束
  const barEndMs = barMs + intervalMs;
  if (actAlive && barEndMs - actLastT > periodMs(actK) + jitterMs + intervalMs) actAlive = false;

  out_urgent_buy(buyQty);
  out_urgent_sell(-sellQty);
  out_twap_flow(actAlive ? (actSide > 0 ? actCum : -actCum) : NaN);
  out_max_sweep_bps(maxBps);
  out_hit_buy(bestBuy >= 0 ? 1.0 : 0.0);
  out_hit_sell(bestSell >= 0 ? 1.0 : 0.0);
  out_hit_twap(nbFound ? 1.0 : 0.0);

  if (bestBuy >= 0) {
    writeWords(bestBuy);
    str_buy_words_sb();
  }
  if (bestSell >= 0) {
    writeWords(bestSell);
    str_sell_words_sb();
  }
  if (nbFound) {
    writeTwapWords();
    str_twap_words_sb();
  }
}
