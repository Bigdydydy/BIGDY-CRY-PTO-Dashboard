/**
 * Module 9: 柳玉冬波浪理论智能研判引擎 v2
 * -----------------------------------------------------------------------------
 * 依据: 《波浪理论详解》手稿 OCR 第 1-378 页 + 柳玉冬微博实战研判体系。
 *
 * 手稿覆盖章节: 驱动浪基础(Ch1) / 斐波那契系统比率(Ch3) /
 * 单锯齿(Ch4) / 平台形(Ch5) / 收缩三角形(Ch6) / 双锯齿与三锯齿(Ch7, 至P378止)。
 * 联合形(双重/三重横向整理)取手稿散见条文: P50-52 定义与回撤规则、P131-132 取点表、
 * P158/P272-276 内部结构限制、P297 时间上限、P301 x浪总量上限。
 * 说明: 艾略特通道仅作为图表辅助参考线输出，不作为判定或制定波浪的标准。
 * 手稿缺失章节: Ch8 联合形专章(主体以散见条文实现), Ch9 推动浪验证手册,
 * Ch10-11 引导/终结楔形——楔形校验补充主流艾略特(EWI)条则并标注「通用」。
 *
 * 架构:
 *   1. 多级别 ATR-自适应 Zigzag 拐点提取 (确认拐点与尾部未确认拐点分离)
 *   2. 规则库 RULE_BOOK: 每条规则带 类别(六类) / 手稿页码 / 软硬标记 / 端点需求
 *   3. 假设搜索: 跨拐点组合浪的终点 -> 硬规则剪枝 -> 指引打分 -> 结构复核
 *   4. 子浪结构: 优先用低周期 K 线, 否则更细 Zigzag; 数据不足如实标记, 不编造
 *   5. 输出: 主备方案 + 监测点(失效位) + 手稿取点表斐波那契目标 + 辅助通道(非波浪制定标准)
 *
 * 验证顺序 (手稿方法论): 浪型规则 -> 比率规则 -> 时间规则 -> 指引(不否决只调分)
 * 关键术语 (手稿): 「价格」=起点到终点; 「运行总量」=含所有子浪的最高最低区间。
 *   本引擎中浪的端点即拐点极值, 故单腿两者一致; 子浪越线由 bar 级扫描检验。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LiuWaveEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '2.0.0';
  const EPS = 1e-9;

  const C_PRICE = 'price_rule';        // 价格(比率)规则 - 硬性
  const C_TIME = 'time_rule';          // 时间规则 - 硬性
  const C_STRUCT = 'pattern_rule';     // 浪型(内部结构)规则 - 软判
  const C_G_PAT = 'pattern_guideline';
  const C_G_RATIO = 'ratio_guideline';
  const C_G_TIME = 'time_guideline';
  const CAT_NAMES = {
    [C_PRICE]: '价格规则', [C_TIME]: '时间规则', [C_STRUCT]: '浪型规则',
    [C_G_PAT]: '浪型指引', [C_G_RATIO]: '比率指引', [C_G_TIME]: '时间指引'
  };

  const TF_SEC = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '2h': 7200, '4h': 14400, '6h': 21600, '8h': 28800, '12h': 43200, '1d': 86400, '3d': 259200, '1w': 604800 };

  // 候选排序/裁剪配置: 数据驱动的可变候选数 (可被 options.ranking 浅覆盖)
  const RANKING = { temperature: 5, minRel: 0.15, maxCands: 5, minCands: 1 };

  function fmtNum(n) {
    if (n === null || n === undefined || isNaN(n)) return '--';
    return Number(n.toFixed(2)).toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  function near(v, targets, tol) {
    return targets.some(t => Math.abs(v - t) <= tol * Math.max(Math.abs(t), 1e-9));
  }
  function avgTR(bars) {
    if (!bars || bars.length < 2) return 0;
    let s = 0;
    for (let i = 1; i < bars.length; i++) {
      const b = bars[i], pc = bars[i - 1].close;
      s += Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    }
    return s / (bars.length - 1);
  }
  function lineVal(x0, y0, x1, y1, x) {
    if (x1 === x0) return y1;
    return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
  }

  // ---------------------------------------------------------------------------
  // 1. Zigzag 拐点提取 (ATR/阈值驱动, 尾部拐点标记为未确认 open)
  // ---------------------------------------------------------------------------

  function zigzagPivots(bars, thr) {
    const n = bars.length;
    if (!n) return [];
    if (!(thr > 0)) thr = (avgTR(bars) || Math.abs(bars[n - 1].close - bars[0].open) / n || 1) * 1e-6;

    let hiIdx = 0, loIdx = 0;
    let runHi = bars[0].high, runLo = bars[0].low;
    let side = 0; // 0 未定, 1 上行中(追踪高点), -1 下行中(追踪低点)
    const out = [];

    for (let i = 1; i < n; i++) {
      const b = bars[i];
      if (b.high > runHi) { runHi = b.high; hiIdx = i; }
      if (b.low < runLo) { runLo = b.low; loIdx = i; }

      if (side === 1) {
        if (runHi - b.low >= thr) {
          out.push({ idx: hiIdx, time: bars[hiIdx].time, price: runHi, type: 'high', confirmed: true });
          side = -1; runLo = b.low; loIdx = i;
        }
      } else if (side === -1) {
        if (b.high - runLo >= thr) {
          out.push({ idx: loIdx, time: bars[loIdx].time, price: runLo, type: 'low', confirmed: true });
          side = 1; runHi = b.high; hiIdx = i;
        }
      } else {
        // 首个被确认的反向极值即序列起点拐点 (另一端若未达阈值则只是噪声)
        if (b.high - runLo >= thr) {
          out.push({ idx: loIdx, time: bars[loIdx].time, price: runLo, type: 'low', confirmed: true });
          side = 1; runHi = b.high; hiIdx = i;
        } else if (runHi - b.low >= thr) {
          out.push({ idx: hiIdx, time: bars[hiIdx].time, price: runHi, type: 'high', confirmed: true });
          side = -1; runLo = b.low; loIdx = i;
        }
      }
    }
    // 尾部未确认极值 (open=发展中)
    if (side === 1) out.push({ idx: hiIdx, time: bars[hiIdx].time, price: runHi, type: 'high', confirmed: false, open: true });
    else if (side === -1) out.push({ idx: loIdx, time: bars[loIdx].time, price: runLo, type: 'low', confirmed: false, open: true });
    return out;
  }

  const DEGREE_MULTS = [0.75, 1.1, 1.5, 2, 2.6, 3.2, 4];
  const MAX_MAIN_PIVOTS = 34;

  function buildPivotDegrees(bars) {
    const atr = avgTR(bars);
    const levels = [];
    for (const m of DEGREE_MULTS) {
      const pivots = zigzagPivots(bars, atr * m);
      if (!levels.length || levels[levels.length - 1].pivots.length !== pivots.length) {
        levels.push({ mult: m, thr: atr * m, pivots, count: pivots.length });
      }
    }
    let main = null;
    for (const l of levels) {
      if (l.pivots.length >= 4 && l.pivots.length <= MAX_MAIN_PIVOTS) { main = l; break; }
    }
    if (!main && levels.length) {
      for (let i = levels.length - 1; i >= 0; i--) {
        if (levels[i].pivots.length >= 4) { main = levels[i]; break; }
      }
      if (!main) main = levels[levels.length - 1];
    }
    return { atr, levels, main };
  }

  /**
   * 兼容旧签名: findPivots(bars, k)。内部改为 ATR-自适应 Zigzag,
   * 返回严格高低交替的拐点序列 (含起点锚定与尾部 open 拐点)。
   */
  function findPivots(bars) {
    if (!bars || !bars.length) return [];
    const atr = avgTR(bars) || 1e-9;
    let best = [];
    for (const m of [4, 3.2, 2.6, 2, 1.5, 1.1, 0.75, 0.5]) {
      const zp = zigzagPivots(bars, m * atr);
      if (zp.length > best.length) best = zp;
      if (zp.length >= 5 && zp.length <= 140) return zp;
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // 2. 几何工具
  // ---------------------------------------------------------------------------

  /** g: {p:拐点序列, l:各腿价格长度, t:各腿时间(K线数), d:首腿方向 ±1} */
  function mkGeom(pts) {
    const p = pts;
    const l = [], t = [];
    for (let i = 1; i < p.length; i++) {
      l.push(Math.abs(p[i].price - p[i - 1].price));
      t.push(Math.max(1, p[i].idx - p[i - 1].idx));
    }
    return { p, l, t, d: p.length >= 2 ? (Math.sign(p[1].price - p[0].price) || 1) : 1 };
  }

  /** 柱体越过直线的最大超出量。side=+1 须在线下方(超额=high-line), -1 须在线上方 */
  function lineOvershoot(highs, lows, i0, i1, x0, y0, x1, y1, side) {
    let m = 0;
    for (let i = i0; i <= i1 && i < highs.length; i++) {
      const lv = lineVal(x0, y0, x1, y1, i);
      const ov = side > 0 ? highs[i] - lv : lv - lows[i];
      if (ov > m) m = ov;
    }
    return m;
  }

  /** 腿表: pivots[i]->pivots[j] 可作为「一浪」 当且仅当奇数间隔且两端点为区间极值 */
  function buildLegTable(pivs) {
    const N = pivs.length;
    const ok = Array.from({ length: N }, () => new Array(N).fill(false));
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        if (((j - i) & 1) === 0) continue;
        const a = pivs[i], b = pivs[j];
        if (a.type === b.type) continue;
        let good = true;
        for (let k = i + 1; k < j; k++) {
          const q = pivs[k].price;
          if (b.type === 'high' ? q >= b.price - EPS : q <= b.price + EPS) { good = false; break; }
        }
        ok[i][j] = good;
      }
    }
    return ok;
  }

  // ---------------------------------------------------------------------------
  // 3. 规则库 (每条: id, cat, hard, pending, need, page, text, w, test, struct)
  //    pending='min': 属最低要求类, 末端拐点未确认(open)时暂不否决
  //    slow=true: 需逐根K线扫描, 仅在落盘假设终评时执行
  // ---------------------------------------------------------------------------

  function rg(id, cat, hard, pending, need, page, text, w, test, extra) {
    return Object.assign({ id, cat, hard, pending, need, page, text, w: w || 1, test }, extra || {});
  }
  const fmtPct = v => (v * 100).toFixed(1) + '%';

  // 驱动浪通则 (推动浪与楔形共用; 手稿 Ch1 P32-56 及散见条文)
  const MOTIVE_RULES = [
    rg('M1', C_PRICE, true, null, 3, 'P32/P36', '浪2回撤小于浪1的100%（触及浪1起点即否决）', 1,
      g => ({ pass: g.d * (g.p[2].price - g.p[0].price) > 0, detail: `浪2终点 ${fmtNum(g.p[2].price)} vs 浪1起点 ${fmtNum(g.p[0].price)}` })),
    rg('M2', C_PRICE, true, 'min', 3, 'P34', '浪2回撤不小于浪1的20%', 1,
      g => ({ pass: g.l[1] >= 0.2 * g.l[0] - EPS, detail: `回撤 ${fmtPct(g.l[1] / g.l[0])}` })),
    rg('M3', C_PRICE, true, 'min', 4, 'P32/P40', '浪3必须超过浪1终点', 1,
      g => ({ pass: g.d * (g.p[3].price - g.p[1].price) > 0, detail: `浪3终点 ${fmtNum(g.p[3].price)} vs 浪1终点 ${fmtNum(g.p[1].price)}` })),
    rg('M4', C_PRICE, true, null, 5, 'P32/P42', '浪4回撤小于浪3的100%（不触及浪2终点）', 1,
      g => ({ pass: g.d * (g.p[4].price - g.p[2].price) > 0, detail: `浪4终点 ${fmtNum(g.p[4].price)} vs 浪2终点 ${fmtNum(g.p[2].price)}` })),
    rg('M5', C_PRICE, true, null, 6, 'P32/P44', '浪3不能是浪1/3/5中最短（价格与涨跌百分比双口径）', 1,
      g => {
        const shortPrice = g.l[2] >= Math.min(g.l[0], g.l[4]) - EPS;
        const pc = k => Math.abs(g.p[k].price / g.p[k - 1].price - 1);
        const shortPct = pc(3) >= Math.min(pc(1), pc(5)) - EPS;
        return { pass: shortPrice && shortPct, detail: `价格 1:${fmtNum(g.l[0])} 3:${fmtNum(g.l[2])} 5:${fmtNum(g.l[4])}` };
      }),
    rg('M6', C_PRICE, true, 'min', 6, 'P204/P366', '衰竭5浪价格不得小于浪4的70%', 1,
      g => (g.d * (g.p[5].price - g.p[3].price) > 0)
        ? { pass: true, detail: '浪5超越浪3终点，非衰竭' }
        : { pass: g.l[4] >= 0.7 * g.l[3] - EPS, detail: `衰竭5浪为浪4的 ${fmtPct(g.l[4] / g.l[3])}` }),
    rg('M7', C_TIME, true, null, 3, 'P34', '浪2时间不超过浪1的9倍', 1,
      g => ({ pass: g.t[1] <= 9 * g.t[0], detail: `浪2用时 ${g.t[1]} vs 浪1×9=${9 * g.t[0]}` })),
    rg('M8', C_TIME, true, null, 5, 'P43', '浪4时间超过浪3的2倍则否决原数浪', 1,
      g => ({ pass: g.t[3] <= 2 * g.t[2], detail: `浪4用时 ${g.t[3]} vs 浪3×2=${2 * g.t[2]}` })),
    rg('M9', C_STRUCT, false, null, 2, 'P9-16', '出身检验：浪1内部应为五浪（驱动浪或引导楔形）', 2, null,
      { struct: true, legs: [0], expect: ['5'] }),
    rg('G1', C_G_RATIO, false, null, 3, 'P34/P94', '浪2常见回撤为浪1的0.382~0.618倍', 1,
      g => { const r = g.l[1] / g.l[0]; return { pass: r >= 0.3 && r <= 0.7, detail: `回撤 ${fmtPct(r)}` }; }),
    rg('G2', C_G_RATIO, false, null, 3, 'P34', '浪2回撤超过浪1的80%则存疑', 1,
      g => ({ pass: g.l[1] <= 0.8 * g.l[0] + EPS, detail: `回撤 ${fmtPct(g.l[1] / g.l[0])}` })),
    rg('G3', C_G_RATIO, false, 'min', 4, 'P41/P180', '浪3常见为浪1的1~2.618倍', 1,
      g => { const r = g.l[2] / g.l[0]; return { pass: r >= 0.9 && r <= 2.8, detail: `浪3=浪1×${r.toFixed(2)}` }; }),
    rg('G4', C_G_RATIO, false, null, 5, 'P42', '浪4常见回撤为浪3的0.236~0.5倍', 1,
      g => { const r = g.l[3] / g.l[2]; return { pass: r >= 0.15 && r <= 0.55, detail: `浪4回撤 ${fmtPct(r)}` }; }),
    rg('G5', C_G_RATIO, false, null, 6, 'P96/P181', '浪5常为浪1的0.618/1/1.618倍', 1,
      g => { const r = g.l[4] / g.l[0]; return { pass: (r > 0.5 && r < 1.8) || near(r, [2.618], 0.15), detail: `浪5=浪1×${r.toFixed(2)}` }; }),
    rg('G8', C_G_PAT, false, null, 3, '通用（EWI同级别显著性/right look）', '同级别显著性：驱动浪内部的逆向回撤不应大于相邻的同级别调整浪（浪2/浪4）', 1.5,
      (g, ev) => {
        if (!ev || !ev.highs || !ev.lows) return { pass: true, neutral: true, detail: '无K线数据未验' };
        const parts = [];
        let allPass = true, anyEval = false;
        for (const k of [0, 2, 4]) {
          if (k >= g.l.length) continue;
          const neigh = [k - 1, k + 1].filter(j => j >= 0 && j < g.l.length);
          if (!neigh.length) continue;
          anyEval = true;
          const neighMax = Math.max.apply(null, neigh.map(j => g.l[j]));
          const i0 = g.p[k].idx, i1 = g.p[k + 1].idx;
          const up = g.p[k + 1].price > g.p[k].price;
          let inner = 0;
          if (up) {
            let runHigh = ev.highs[i0];
            for (let i = i0; i <= i1 && i < ev.highs.length; i++) {
              if (ev.highs[i] > runHigh) runHigh = ev.highs[i];
              const dd = runHigh - ev.lows[i];
              if (dd > inner) inner = dd;
            }
          } else {
            let runLow = ev.lows[i0];
            for (let i = i0; i <= i1 && i < ev.lows.length; i++) {
              if (ev.lows[i] < runLow) runLow = ev.lows[i];
              const dd = ev.highs[i] - runLow;
              if (dd > inner) inner = dd;
            }
          }
          const ok = inner <= neighMax + EPS;
          if (!ok) allPass = false;
          parts.push(`浪${k + 1}内回撤${fmtNum(inner)}${ok ? '≤' : '>'}${fmtNum(neighMax)}${ok ? '' : '✗'}`);
        }
        if (!anyEval) return { pass: true, neutral: true, detail: '无K线数据未验' };
        return { pass: allPass, detail: parts.join(' · ') };
      })
  ];

  const IMPULSE_RULES = [
    rg('I1', C_PRICE, true, null, 5, 'P48-50', '推动浪浪4及其子浪不能切入浪1价格区', 1,
      (g, ev) => {
        if (!ev || !ev.highs) {
          return { pass: g.d * (g.p[4].price - g.p[1].price) > 0, detail: `浪4终点 ${fmtNum(g.p[4].price)} vs 浪1终点 ${fmtNum(g.p[1].price)}` };
        }
        // 子浪也不可切入: 扫描浪4区间每根K线的反向极值
        const i0 = g.p[3].idx, i1 = g.p[4].idx;
        let worst = 0;
        for (let i = i0; i <= i1; i++) {
          const ext = g.d > 0 ? ev.lows[i] : ev.highs[i];
          const pen = g.d * (g.p[1].price - ext);
          if (pen > worst) worst = pen;
        }
        return { pass: worst <= EPS, detail: worst > EPS ? `浪4子浪切入浪1区 ${fmtNum(worst)}` : `浪4终点 ${fmtNum(g.p[4].price)} vs 浪1终点 ${fmtNum(g.p[1].price)}` };
      }, { slow: true }),
    rg('I2', C_G_PAT, false, null, 4, 'P85/P88', '交替原则：浪2与浪4形态宜一陡一横', 0.5, null, { manual: true }),
    rg('G7', C_G_PAT, false, null, 6, '通用（EWI延长浪惯例）', '浪3通常是三个驱动浪中最长的（至少一浪延长）', 0.5,
      g => ({ pass: g.l[2] >= Math.max(g.l[0], g.l[4]) - EPS, detail: `1:${fmtNum(g.l[0])} 3:${fmtNum(g.l[2])} 5:${fmtNum(g.l[4])}` }))
  ];

  const DIAGONAL_RULES = [
    rg('D1', C_PRICE, true, 'min', 5, 'P48（楔形反向）', '楔形浪4必须切入浪1价格区', 1,
      g => ({ pass: g.d * (g.p[4].price - g.p[1].price) <= EPS, detail: `浪4终点 ${fmtNum(g.p[4].price)} vs 浪1终点 ${fmtNum(g.p[1].price)}` })),
    rg('D2', C_G_PAT, false, null, 5, '通用（手稿楔形章缺失）', '楔形边界线（1-3 与 2-4）应收敛或发散，不宜平行', 1,
      g => {
        const sA = (g.p[3].price - g.p[1].price) / (g.p[3].idx - g.p[1].idx);
        const sB = (g.p[4].price - g.p[2].price) / (g.p[4].idx - g.p[2].idx);
        const scale = g.l[0] / Math.max(1, g.p[3].idx - g.p[0].idx);
        return { pass: Math.abs(sA - sB) > 0.1 * scale, detail: `上轨斜率 ${sA.toFixed(4)} vs 下轨 ${sB.toFixed(4)}` };
      }),
    rg('D3', C_G_RATIO, false, null, 6, '通用（EWI楔形条则）', '收缩楔形：浪3<浪1、浪4<浪2、浪5<浪3；扩散楔形反向且须一致', 1.5,
      g => {
        const contracting = g.l[2] < g.l[0];
        const ok = contracting
          ? (g.l[3] < g.l[1] + EPS && g.l[4] < g.l[2] + EPS)
          : (g.l[3] > g.l[1] - EPS && g.l[4] > g.l[2] - EPS);
        return { pass: ok, detail: `${contracting ? '收缩' : '扩散'}一致性 4/2=${(g.l[3] / g.l[1]).toFixed(2)} 5/3=${(g.l[4] / g.l[2]).toFixed(2)}` };
      })
  ];

  const ZIGZAG_RULES = [
    rg('Z0', C_STRUCT, false, null, 2, 'P216', '出身检验：浪a内部应为五浪（驱动浪或引导楔形）', 2, null,
      { struct: true, legs: [0], expect: ['5'] }),
    rg('Z1', C_PRICE, true, 'min', 3, 'P213', 'b浪不小于a浪的20%', 1,
      g => ({ pass: g.l[1] >= 0.2 * g.l[0] - EPS, detail: `b/a=${fmtPct(g.l[1] / g.l[0])}` })),
    rg('Z2', C_PRICE, true, null, 3, 'P213', 'b浪不能超过a浪起点', 1,
      g => ({ pass: g.d * (g.p[2].price - g.p[0].price) > 0, detail: `b终点 ${fmtNum(g.p[2].price)} vs a起点 ${fmtNum(g.p[0].price)}` })),
    rg('Z3', C_PRICE, true, 'min', 4, 'P213', 'c浪不小于b浪的0.9倍（否则视为b浪未完）', 1,
      g => ({ pass: g.l[2] >= 0.9 * g.l[1] - EPS, detail: `c/b=${fmtPct(g.l[2] / g.l[1])}` })),
    rg('Z4', C_PRICE, true, null, 4, 'P213', 'c浪小于b浪的5倍', 1,
      g => ({ pass: g.l[2] < 5 * g.l[1], detail: `c/b=${(g.l[2] / g.l[1]).toFixed(2)}` })),
    rg('Z5', C_TIME, true, null, 3, 'P215', 'b浪时间不超过a浪的10倍', 1,
      g => ({ pass: g.t[1] <= 10 * g.t[0], detail: `b用时 ${g.t[1]} vs a×10=${10 * g.t[0]}` })),
    rg('Z6', C_TIME, true, null, 4, 'P215', 'c浪时间不超过a、b中较短者的10倍', 1,
      g => { const mt = g.l[0] <= g.l[1] ? g.t[0] : g.t[1]; return { pass: g.t[2] <= 10 * mt, detail: `c用时 ${g.t[2]} vs 上限 ${10 * mt}` }; }),
    rg('ZG1', C_G_RATIO, false, null, 3, 'P214', 'b浪常见回撤a浪的0.382/0.5/0.618倍', 1,
      g => { const r = g.l[1] / g.l[0]; return { pass: (r > 0.3 && r < 0.72) || near(r, [0.236], 0.08), detail: `b/a=${fmtPct(r)}` }; }),
    rg('ZG2', C_G_RATIO, false, null, 3, 'P214', 'b浪>0.618a 应怀疑、>0.86a 高度存疑单锯齿', 1,
      g => ({ pass: g.l[1] <= 0.86 * g.l[0] + EPS, detail: `b/a=${fmtPct(g.l[1] / g.l[0])}` })),
    rg('ZG3', C_G_RATIO, false, 'min', 4, 'P214', 'c浪常见：等于a、0.618a、1.618a，或a终点±0.618a', 1,
      g => {
        const r = g.l[2] / g.l[0];
        const ext = g.d * (g.p[3].price - g.p[1].price) / g.l[0];
        return { pass: near(r, [0.618, 1, 1.618], 0.18) || near(ext, [0.618], 0.2), detail: `c/a=${r.toFixed(2)}，超a终点 ${fmtPct(ext)}` };
      }),
    rg('ZG4', C_G_RATIO, false, null, 4, 'P214', 'c浪若远超a浪，更可能是推动浪而非c浪', 1,
      g => ({ pass: g.l[2] <= 3 * g.l[0], detail: `c/a=${(g.l[2] / g.l[0]).toFixed(2)}` })),
    rg('ZG5', C_G_RATIO, false, 'min', 4, 'P216', 'c浪通常超过a浪终点（失败c浪极少见）', 0.5,
      g => ({ pass: g.d * (g.p[3].price - g.p[1].price) > 0, detail: `c终点 ${fmtNum(g.p[3].price)} vs a终点 ${fmtNum(g.p[1].price)}` })),
    rg('ZG6', C_G_TIME, false, null, 3, 'P215', 'b浪时间常为a浪的0.618~1.618倍', 1,
      g => { const r = g.t[1] / g.t[0]; return { pass: r <= 2.618, detail: `b/a时间=${r.toFixed(2)}` }; }),
    rg('ZG7', C_G_TIME, false, null, 4, 'P215', 'c浪时间常见范围：0.618×a ~ 1.618×较短浪', 1,
      g => { const mt = g.l[0] <= g.l[1] ? g.t[0] : g.t[1]; return { pass: g.t[2] <= 2.618 * mt, detail: `c用时 ${g.t[2]}` }; })
  ];

  const FLAT_RULES = [
    rg('F0', C_STRUCT, false, null, 2, 'P236/P251/P158', '出身检验：浪a内部应为三浪（调整浪结构）', 2, null,
      { struct: true, legs: [0], expect: ['3'] }),
    rg('F1', C_PRICE, true, 'min', 3, 'P234-235', 'b浪运行总量回撤不少于a浪运行总量的70%', 1,
      g => ({ pass: g.l[1] >= 0.7 * g.l[0] - EPS, detail: `b总量/a总量=${fmtPct(g.l[1] / g.l[0])}` })),
    rg('F2', C_PRICE, true, null, 3, 'P235', 'b浪运行总量小于a浪运行总量的2倍', 1,
      g => ({ pass: g.l[1] < 2 * g.l[0], detail: `b/a=${(g.l[1] / g.l[0]).toFixed(2)}` })),
    rg('F3', C_PRICE, true, 'min', 4, 'P235', 'c浪必须与a浪重叠', 1,
      g => {
        const lo = Math.min(g.p[0].price, g.p[1].price), hi = Math.max(g.p[0].price, g.p[1].price);
        const clo = Math.min(g.p[2].price, g.p[3].price), chi = Math.max(g.p[2].price, g.p[3].price);
        return { pass: clo < hi && chi > lo, detail: `c区[${fmtNum(clo)},${fmtNum(chi)}] vs a区[${fmtNum(lo)},${fmtNum(hi)}]` };
      }),
    rg('F4', C_PRICE, true, null, 4, 'P236', 'c浪运行总量不超过a、b较大者的2倍', 1,
      g => ({ pass: g.l[2] <= 2 * Math.max(g.l[0], g.l[1]) + EPS, detail: `c=${(g.l[2] / Math.max(g.l[0], g.l[1])).toFixed(2)}×较大者` })),
    rg('F5', C_PRICE, true, null, 4, 'P236', 'c浪运行总量不超过a浪价格的3倍', 1,
      g => ({ pass: g.l[2] <= 3 * g.l[0] + EPS, detail: `c/a=${(g.l[2] / g.l[0]).toFixed(2)}` })),
    rg('F6', C_TIME, true, null, 3, 'P236', 'b浪时间不超过a浪的10倍', 1,
      g => ({ pass: g.t[1] <= 10 * g.t[0], detail: `b用时 ${g.t[1]}` })),
    rg('F7', C_TIME, true, null, 4, 'P236', 'c浪时间不超过a、b中较短者的10倍', 1,
      g => { const mt = g.l[0] <= g.l[1] ? g.t[0] : g.t[1]; return { pass: g.t[2] <= 10 * mt, detail: `c用时 ${g.t[2]}` }; }),
    rg('FG1', C_G_RATIO, false, null, 3, 'P234', 'b浪价格常见为a浪的0.95~1.4倍', 1,
      g => { const r = g.l[1] / g.l[0]; return { pass: r >= 0.9 && r <= 1.45, detail: `b/a=${r.toFixed(2)}` }; }),
    rg('FG2', C_G_RATIO, false, 'min', 4, 'P237-238/P245/P255', 'c浪常见：等于a、a终点附近、1.618a、超a终点0.618a', 1,
      g => {
        const r = g.l[2] / g.l[0];
        const ext = g.d * (g.p[3].price - g.p[1].price) / g.l[0];
        return { pass: near(r, [1, 1.618], 0.18) || Math.abs(ext) <= 0.15 || near(ext, [0.618], 0.2), detail: `c/a=${r.toFixed(2)}，超a终点 ${fmtPct(ext)}` };
      }),
    rg('FG3', C_G_RATIO, false, null, 4, 'P237', 'c浪常超过b浪的1.618倍（顺势平台除外）', 0.5,
      g => ({ pass: g.l[2] >= 1.3 * g.l[1], detail: `c/b=${(g.l[2] / g.l[1]).toFixed(2)}` })),
    rg('FG4', C_G_TIME, false, null, 4, 'P236', 'c浪时间常为a、b较短者的0.618~1.618倍', 1,
      g => { const mt = g.l[0] <= g.l[1] ? g.t[0] : g.t[1]; return { pass: g.t[2] <= 2.618 * mt, detail: `c用时 ${g.t[2]}` }; })
  ];

  const TRIANGLE_RULES = [
    rg('T0', C_STRUCT, false, null, 2, 'P272-276/P303', '出身检验：浪a内部应为三浪（调整浪结构）', 2, null,
      { struct: true, legs: [0], expect: ['3'] }),
    rg('T1', C_PRICE, true, 'min', 3, 'P302', 'b浪不小于a浪的50%', 1,
      g => ({ pass: g.l[1] >= 0.5 * g.l[0] - EPS, detail: `b/a=${fmtPct(g.l[1] / g.l[0])}` })),
    rg('T2', C_PRICE, true, null, 3, 'P302/P310', 'b浪不大于a浪的1.5倍', 1,
      g => ({ pass: g.l[1] <= 1.5 * g.l[0] + EPS, detail: `b/a=${(g.l[1] / g.l[0]).toFixed(2)}` })),
    rg('T3', C_PRICE, true, 'min', 4, 'P302', 'c浪不小于b浪的50%', 1,
      g => ({ pass: g.l[2] >= 0.5 * g.l[1] - EPS, detail: `c/b=${fmtPct(g.l[2] / g.l[1])}` })),
    rg('T4', C_PRICE, true, null, 4, 'P299', 'c浪必须严格小于b浪（等于也不允许，即c浪不能到达a浪终点）', 1,
      g => ({ pass: g.l[2] < g.l[1] - EPS, detail: `c=${fmtNum(g.l[2])} vs b=${fmtNum(g.l[1])}` })),
    rg('T5', C_PRICE, true, 'min', 5, 'P302', 'd浪不小于c浪的50%', 1,
      g => ({ pass: g.l[3] >= 0.5 * g.l[2] - EPS, detail: `d/c=${fmtPct(g.l[3] / g.l[2])}` })),
    rg('T6', C_PRICE, true, null, 5, 'P302', 'd浪不能大于c浪', 1,
      g => ({ pass: g.l[3] <= g.l[2] + EPS, detail: `d=${fmtNum(g.l[3])} vs c=${fmtNum(g.l[2])}` })),
    rg('T7', C_PRICE, true, 'min', 6, 'P302/P345', 'e浪不小于d浪的25%，且须进入a浪价格区间', 1,
      g => {
        const lo = Math.min(g.p[0].price, g.p[1].price), hi = Math.max(g.p[0].price, g.p[1].price);
        const inA = g.p[5].price > lo && g.p[5].price < hi;
        return { pass: g.l[4] >= 0.25 * g.l[3] - EPS && inA, detail: `e/d=${fmtPct(g.l[4] / g.l[3])}，e终点 ${fmtNum(g.p[5].price)} vs a区[${fmtNum(lo)},${fmtNum(hi)}]` };
      }),
    rg('T8', C_PRICE, true, null, 6, 'P302', 'e浪不能大于d浪', 1,
      g => ({ pass: g.l[4] <= g.l[3] + EPS, detail: `e=${fmtNum(g.l[4])} vs d=${fmtNum(g.l[3])}` })),
    rg('T9', C_PRICE, true, null, 5, 'P301/P307', '收敛三角形：边界线 a-c 与 b-d 必须收敛（仅 b-d 可水平，a-c 不可水平）', 1,
      g => {
        const w = x => (lineVal(g.p[1].idx, g.p[1].price, g.p[3].idx, g.p[3].price, x) -
          lineVal(g.p[2].idx, g.p[2].price, g.p[4].idx, g.p[4].price, x)) * g.d;
        const wAt4 = w(g.p[4].idx), wAt2 = w(g.p[2].idx);
        const acFlat = Math.abs(g.p[3].price - g.p[1].price) <= 0.02 * Math.max(g.l[0], g.l[1]);
        return { pass: wAt4 > EPS && wAt4 < wAt2 - EPS && !acFlat, detail: `边界宽 b→${fmtNum(wAt2)} d→${fmtNum(wAt4)}${acFlat ? '，a-c水平(违规)' : ''}` };
      }),
    rg('T10', C_PRICE, true, null, 6, 'P307', '收敛三角形：边界线交点须在e浪终点右侧且不超出最长浪时间范围', 1,
      g => {
        const sAc = (g.p[3].price - g.p[1].price) / (g.p[3].idx - g.p[1].idx);
        const sBd = (g.p[4].price - g.p[2].price) / (g.p[4].idx - g.p[2].idx);
        if (Math.abs(sAc - sBd) < 1e-12) return { pass: false, detail: '两线平行无交点' };
        const iAc = g.p[1].price - sAc * g.p[1].idx, iBd = g.p[2].price - sBd * g.p[2].idx;
        const tA = (iBd - iAc) / (sAc - sBd);
        const maxT = Math.max.apply(null, g.t);
        return { pass: tA > g.p[5].idx && tA <= g.p[5].idx + maxT, detail: `交点距e ${Math.round(tA - g.p[5].idx)} 根K线 vs 上限 ${maxT}` };
      }),
    rg('T11', C_PRICE, true, null, 5, 'P308', '收敛三角形：c/d浪子浪越过边界线不得超过前浪总量的10%', 1,
      (g, ev) => {
        if (!ev || !ev.highs) return { pass: true, neutral: true, detail: '无K线数据未验' };
        const ac = [g.p[1].idx, g.p[1].price, g.p[3].idx, g.p[3].price];
        const bd = [g.p[2].idx, g.p[2].price, g.p[4].idx, g.p[4].price];
        const o1 = Math.max(
          lineOvershoot(ev.highs, ev.lows, g.p[2].idx, g.p[3].idx, ac[0], ac[1], ac[2], ac[3], g.d),
          lineOvershoot(ev.highs, ev.lows, g.p[2].idx, g.p[3].idx, bd[0], bd[1], bd[2], bd[3], -g.d)) / (g.l[1] || 1);
        const o2 = Math.max(
          lineOvershoot(ev.highs, ev.lows, g.p[3].idx, g.p[4].idx, ac[0], ac[1], ac[2], ac[3], g.d),
          lineOvershoot(ev.highs, ev.lows, g.p[3].idx, g.p[4].idx, bd[0], bd[1], bd[2], bd[3], -g.d)) / (g.l[2] || 1);
        return { pass: o1 <= 0.1 + EPS && o2 <= 0.1 + EPS, detail: `c越线${fmtPct(o1)} d越线${fmtPct(o2)}` };
      }, { slow: true }),
    rg('T12', C_PRICE, true, null, 6, 'P308', '收敛三角形：e浪子浪越过边界线不得超过d浪总量的10%', 1,
      (g, ev) => {
        if (!ev || !ev.highs) return { pass: true, neutral: true, detail: '无K线数据未验' };
        const ac = [g.p[1].idx, g.p[1].price, g.p[3].idx, g.p[3].price];
        const bd = [g.p[2].idx, g.p[2].price, g.p[4].idx, g.p[4].price];
        const o = Math.max(
          lineOvershoot(ev.highs, ev.lows, g.p[4].idx, g.p[5].idx, ac[0], ac[1], ac[2], ac[3], g.d),
          lineOvershoot(ev.highs, ev.lows, g.p[4].idx, g.p[5].idx, bd[0], bd[1], bd[2], bd[3], -g.d)) / (g.l[3] || 1);
        return { pass: o <= 0.1 + EPS, detail: `e越线${fmtPct(o)}` };
      }, { slow: true }),
    rg('T13', C_TIME, true, null, 5, 'P302', 'd浪时间不大于c浪的4倍', 1,
      g => ({ pass: g.t[3] <= 4 * g.t[2], detail: `d用时 ${g.t[3]} vs c×4=${4 * g.t[2]}` })),
    rg('T14', C_TIME, true, null, 6, 'P302', 'e浪时间不大于d浪的4倍', 1,
      g => ({ pass: g.t[4] <= 4 * g.t[3], detail: `e用时 ${g.t[4]} vs d×4=${4 * g.t[3]}` })),
    rg('TG1', C_G_RATIO, false, null, 3, 'P302', 'b浪常达a浪0.618倍以上（顺势形b>a约1.382倍）', 1,
      g => { const r = g.l[1] / g.l[0]; return { pass: r >= 0.55 || near(r, [1.382], 0.15), detail: `b/a=${r.toFixed(2)}` }; }),
    rg('TG2', C_G_RATIO, false, 'min', 4, 'P302/P327', '规则形c浪常≈0.618×a浪', 1,
      g => { const r = g.l[2] / g.l[0]; return { pass: r <= 0.9, detail: `c/a=${r.toFixed(2)}` }; }),
    rg('TG3', C_G_RATIO, false, 'min', 5, 'P302/P327', 'd浪常为b浪的0.618~0.786倍', 1,
      g => { const r = g.l[3] / g.l[1]; return { pass: r >= 0.45 && r <= 0.95, detail: `d/b=${r.toFixed(2)}` }; }),
    rg('TG4', C_G_RATIO, false, 'min', 6, 'P327', 'e浪常为d浪的0.7倍或c浪的0.618倍', 1,
      g => { const r1 = g.l[4] / g.l[3], r2 = g.l[4] / g.l[2]; return { pass: near(r1, [0.7], 0.25) || near(r2, [0.618], 0.25) || r1 < 0.9, detail: `e/d=${r1.toFixed(2)} e/c=${r2.toFixed(2)}` }; })
  ];

  const DOUBLE_ZIGZAG_RULES = [
    rg('W0', C_STRUCT, false, null, 2, 'P362', '出身检验：浪w内部应为三浪（调整浪结构）', 2, null,
      { struct: true, legs: [0], expect: ['3'] }),
    rg('W1', C_PRICE, true, 'min', 3, 'P362', 'x浪不小于w浪的20%', 1,
      g => ({ pass: g.l[1] >= 0.2 * g.l[0] - EPS, detail: `x/w=${fmtPct(g.l[1] / g.l[0])}` })),
    rg('W2', C_PRICE, true, null, 3, 'P362', 'x浪终点不能超过w浪起点', 1,
      g => ({ pass: g.d * (g.p[2].price - g.p[0].price) > 0, detail: `x终点 ${fmtNum(g.p[2].price)} vs w起点 ${fmtNum(g.p[0].price)}` })),
    rg('W3', C_PRICE, true, null, 3, 'P362', 'x浪所有子浪价格不能超过w浪起点', 1,
      (g, ev) => {
        if (!ev || !ev.highs) return { pass: true, neutral: true, detail: '无K线数据未验' };
        const tol = 0.005 * g.l[0];
        let worst = 0;
        for (let i = g.p[0].idx + 1; i <= g.p[2].idx; i++) {
          const ext = g.d > 0 ? ev.lows[i] : ev.highs[i];
          const ov = -g.d * (ext - g.p[0].price);
          if (ov > worst) worst = ov;
        }
        return { pass: worst <= tol, detail: worst > tol ? `x子浪越过w起点 ${fmtNum(worst)}` : 'x子浪未越w起点' };
      }, { slow: true }),
    rg('W4', C_PRICE, true, 'min', 4, 'P372', 'y浪大于w浪的0.9倍', 1,
      g => ({ pass: g.l[2] > 0.9 * g.l[0] - EPS, detail: `y/w=${(g.l[2] / g.l[0]).toFixed(2)}` })),
    rg('W5', C_PRICE, true, null, 4, 'P362', 'y浪所有子浪不能越过 0-x 基线', 1,
      (g, ev) => {
        if (!ev || !ev.highs) return { pass: true, neutral: true, detail: '无K线数据未验' };
        const tol = 0.005 * g.l[0];
        let worst = 0;
        for (let i = g.p[2].idx + 1; i <= g.p[3].idx; i++) {
          const lv = lineVal(g.p[0].idx, g.p[0].price, g.p[2].idx, g.p[2].price, i);
          const ext = g.d > 0 ? ev.lows[i] : ev.highs[i];
          const ov = -g.d * (ext - lv);
          if (ov > worst) worst = ov;
        }
        return { pass: worst <= tol, detail: worst > tol ? `y子浪越0-x基线 ${fmtNum(worst)}` : 'y子浪未越基线' };
      }, { slow: true }),
    rg('W6', C_TIME, true, null, 3, 'P362', 'x浪时间不超过w浪的5倍', 1,
      g => ({ pass: g.t[1] <= 5 * g.t[0], detail: `x用时 ${g.t[1]} vs w×5=${5 * g.t[0]}` })),
    rg('W7', C_TIME, true, null, 4, 'P364', 'y浪时间不超过w浪的5倍', 1,
      g => ({ pass: g.t[2] <= 5 * g.t[0], detail: `y用时 ${g.t[2]} vs w×5=${5 * g.t[0]}` })),
    rg('W8', C_PRICE, true, null, 4, 'P387', 'y浪不能同时大于x浪的价格与时间', 1,
      g => ({ pass: !(g.l[2] > g.l[1] && g.t[2] > g.t[1]), detail: `y/x 价格${(g.l[2] / g.l[1]).toFixed(2)} 时间${(g.t[2] / g.t[1]).toFixed(2)}` })),
    rg('WG1', C_G_RATIO, false, null, 3, 'P363', 'x浪常见回撤w浪的0.3~0.7倍（0.382/0.5/0.618）', 1,
      g => { const r = g.l[1] / g.l[0]; return { pass: r >= 0.28 && r <= 0.72, detail: `x/w=${fmtPct(r)}` }; }),
    rg('WG2', C_G_RATIO, false, 'min', 4, 'P372/P377', 'y浪常见为w浪的1或1.618倍', 1,
      g => { const r = g.l[2] / g.l[0]; return { pass: near(r, [1, 1.618], 0.2), detail: `y/w=${r.toFixed(2)}` }; }),
    rg('WG3', C_G_TIME, false, null, 3, 'P363', 'x浪时间常见为w浪的0.618~1.618倍', 1,
      g => { const r = g.t[1] / g.t[0]; return { pass: r <= 2.618, detail: `x/w时间=${r.toFixed(2)}` }; }),
    rg('WG4', C_G_TIME, false, null, 4, 'P365', 'y浪时间常见w浪的0.618~1.618倍', 1,
      g => { const r = g.t[2] / g.t[0]; return { pass: r <= 2.618, detail: `y/w时间=${r.toFixed(2)}` }; })
  ];

  // 联合形（横向整理）— 手稿 P50-52/P131-132/P158/P297/P301 散见条文
  const COMBINATION_RULES = [
    rg('C0', C_STRUCT, false, null, 2, 'P50/P158', '出身检验：浪w内部应为三浪（调整浪结构）', 2, null,
      { struct: true, legs: [0], expect: ['3'] }),
    rg('C1', C_PRICE, true, 'min', 3, 'P50', 'x浪必须回撤w浪的70%以上', 1,
      g => ({ pass: g.l[1] >= 0.7 * g.l[0] - EPS, detail: `x/w=${fmtPct(g.l[1] / g.l[0])}` })),
    rg('C2', C_PRICE, true, null, 3, 'P301', 'x浪运行总量不得超过w浪的1.5倍', 1,
      g => ({ pass: g.l[1] <= 1.5 * g.l[0] + EPS, detail: `x/w=${(g.l[1] / g.l[0]).toFixed(2)}` })),
    rg('C3', C_TIME, true, null, 3, 'P297', 'x浪时间不超过w浪的10倍', 1,
      g => ({ pass: g.t[1] <= 10 * g.t[0], detail: `x用时 ${g.t[1]} vs w×10` })),
    rg('C4', C_TIME, true, null, 4, 'P297（类推x浪条则）', 'y浪时间不超过w浪的10倍', 1,
      g => ({ pass: g.t[2] <= 10 * g.t[0], detail: `y用时 ${g.t[2]} vs w×10` })),
    rg('CG1', C_G_RATIO, false, 'min', 4, 'P131', 'y浪常见为w浪的1倍（扩展取点0-w-x）', 1,
      g => { const r = g.l[2] / g.l[0]; return { pass: near(r, [0.786, 1, 1.272], 0.22), detail: `y/w=${r.toFixed(2)}` }; }),
    rg('CG2', C_G_PAT, false, null, 4, 'P50', '外观应接近箱型/平缓平行四边形（横向整理）', 1,
      g => { const drift = Math.abs(g.p[3].price - g.p[0].price) / (g.l[0] + g.l[1] + g.l[2] || 1); return { pass: drift <= 0.45, detail: `净漂移占比 ${fmtPct(drift)}` }; })
  ];

  const TRIPLE_COMBINATION_RULES = [
    rg('C0', C_STRUCT, false, null, 2, 'P51/P158', '出身检验：浪w内部应为三浪（调整浪结构）', 2, null,
      { struct: true, legs: [0], expect: ['3'] }),
    rg('C1', C_PRICE, true, 'min', 3, 'P51', 'x浪必须回撤w浪的70%以上', 1,
      g => ({ pass: g.l[1] >= 0.7 * g.l[0] - EPS, detail: `x/w=${fmtPct(g.l[1] / g.l[0])}` })),
    rg('C2', C_PRICE, true, null, 3, 'P301', 'x浪运行总量不得超过w浪的1.5倍', 1,
      g => ({ pass: g.l[1] <= 1.5 * g.l[0] + EPS, detail: `x/w=${(g.l[1] / g.l[0]).toFixed(2)}` })),
    rg('C3', C_TIME, true, null, 3, 'P297', 'x浪时间不超过w浪的10倍', 1,
      g => ({ pass: g.t[1] <= 10 * g.t[0], detail: `x用时 ${g.t[1]} vs w×10` })),
    rg('C4', C_TIME, true, null, 4, 'P297（类推x浪条则）', 'y浪时间不超过w浪的10倍', 1,
      g => ({ pass: g.t[2] <= 10 * g.t[0], detail: `y用时 ${g.t[2]}` })),
    rg('C5', C_PRICE, true, 'min', 5, 'P51', 'xx浪必须回撤y浪的70%以上', 1,
      g => ({ pass: g.l[3] >= 0.7 * g.l[2] - EPS, detail: `xx/y=${fmtPct(g.l[3] / g.l[2])}` })),
    rg('C6', C_PRICE, true, null, 5, 'P301（类推x浪条则）', 'xx浪运行总量不得超过y浪的1.5倍', 1,
      g => ({ pass: g.l[3] <= 1.5 * g.l[2] + EPS, detail: `xx/y=${(g.l[3] / g.l[2]).toFixed(2)}` })),
    rg('C7', C_TIME, true, null, 5, 'P297（类推）', 'xx浪时间不超过y浪的10倍', 1,
      g => ({ pass: g.t[3] <= 10 * g.t[2], detail: `xx用时 ${g.t[3]}` })),
    rg('C8', C_TIME, true, null, 6, 'P297（类推）', 'z浪时间不超过y浪的10倍', 1,
      g => ({ pass: g.t[4] <= 10 * g.t[2], detail: `z用时 ${g.t[4]}` })),
    rg('CG3', C_G_RATIO, false, 'min', 6, 'P132', 'z浪常见为y浪的1倍（扩展取点x-y-xx）', 1,
      g => { const r = g.l[4] / g.l[2]; return { pass: near(r, [0.786, 1, 1.272], 0.22), detail: `z/y=${r.toFixed(2)}` }; }),
    rg('CG4', C_G_PAT, false, null, 6, 'P51', '外观应接近箱型/平缓平行四边形（横向整理）', 1,
      g => { const drift = Math.abs(g.p[5].price - g.p[0].price) / (g.l.reduce((s, x) => s + x, 0) || 1); return { pass: drift <= 0.35, detail: `净漂移占比 ${fmtPct(drift)}` }; })
  ];

  const TRIPLE_ZIGZAG_RULES = DOUBLE_ZIGZAG_RULES.concat([
    rg('X1', C_PRICE, true, 'min', 5, 'P385', 'xx浪不小于y浪的20%', 1,
      g => ({ pass: g.l[3] >= 0.2 * g.l[2] - EPS, detail: `xx/y=${fmtPct(g.l[3] / g.l[2])}` })),
    rg('X2', C_PRICE, true, null, 5, 'P385', 'xx浪终点不能超过y浪起点', 1,
      g => ({ pass: g.d * (g.p[4].price - g.p[2].price) > 0, detail: `xx终点 ${fmtNum(g.p[4].price)} vs y起点 ${fmtNum(g.p[2].price)}` })),
    rg('X3', C_PRICE, true, null, 5, 'P385', 'xx浪所有子浪不能超过y浪起点', 1,
      (g, ev) => {
        if (!ev || !ev.highs) return { pass: true, neutral: true, detail: '无K线数据未验' };
        const tol = 0.005 * g.l[2];
        let worst = 0;
        for (let i = g.p[3].idx + 1; i <= g.p[4].idx; i++) {
          const ext = g.d > 0 ? ev.lows[i] : ev.highs[i];
          const ov = -g.d * (ext - g.p[2].price);
          if (ov > worst) worst = ov;
        }
        return { pass: worst <= tol, detail: worst > tol ? `xx子浪越过y起点 ${fmtNum(worst)}` : 'xx子浪未越y起点' };
      }, { slow: true }),
    rg('X4', C_PRICE, true, 'min', 6, 'P388', 'z浪不小于x浪的0.9倍', 1,
      g => ({ pass: g.l[4] >= 0.9 * g.l[1] - EPS, detail: `z/x=${(g.l[4] / g.l[1]).toFixed(2)}` })),
    rg('X5', C_TIME, true, null, 5, 'P385', 'xx浪时间不超过y浪的5倍', 1,
      g => ({ pass: g.t[3] <= 5 * g.t[2], detail: `xx用时 ${g.t[3]}` })),
    rg('X6', C_TIME, true, null, 6, 'P365', 'z浪时间不超过y浪的5倍', 1,
      g => ({ pass: g.t[4] <= 5 * g.t[2], detail: `z用时 ${g.t[4]}` })),
    rg('X7', C_TIME, true, null, 6, 'P365', 'z浪时间不超过w浪的5倍', 1,
      g => ({ pass: g.t[4] <= 5 * g.t[0], detail: `z用时 ${g.t[4]}` })),
    rg('X8', C_PRICE, true, null, 6, 'P387', 'z浪价格不能同时大于x浪与xx浪', 1,
      g => ({ pass: !(g.l[4] > g.l[1] && g.l[4] > g.l[3]), detail: `z=${fmtNum(g.l[4])} x=${fmtNum(g.l[1])} xx=${fmtNum(g.l[3])}` })),
    rg('X9', C_TIME, true, null, 6, 'P387', 'z浪时间不能同时大于x浪与xx浪', 1,
      g => ({ pass: !(g.t[4] > g.t[1] && g.t[4] > g.t[3]), detail: `z=${g.t[4]} x=${g.t[1]} xx=${g.t[3]}` }))
  ]);

  const PATTERNS = {
    IMPULSE: { pts: 6, minDev: 3, name: '推动浪', category: '驱动浪', rules: MOTIVE_RULES.concat(IMPULSE_RULES), labels: ['0', '1', '2', '3', '4', '5'] },
    DIAGONAL: { pts: 6, minDev: 5, name: '对角楔形', category: '驱动浪', rules: MOTIVE_RULES.concat(DIAGONAL_RULES), labels: ['0', '1', '2', '3', '4', '5'] },
    ZIGZAG: { pts: 4, minDev: 3, name: '单锯齿调整浪', category: '调整浪', rules: ZIGZAG_RULES, labels: ['0', 'a', 'b', 'c'] },
    FLAT: { pts: 4, minDev: 3, name: '平台形调整浪', category: '调整浪', rules: FLAT_RULES, labels: ['0', 'a', 'b', 'c'] },
    TRIANGLE: { pts: 6, minDev: 4, name: '收缩三角形', category: '调整浪', rules: TRIANGLE_RULES, labels: ['0', 'a', 'b', 'c', 'd', 'e'] },
    DOUBLE_ZIGZAG: { pts: 4, minDev: 4, name: '双锯齿调整浪', category: '联合调整', rules: DOUBLE_ZIGZAG_RULES, labels: ['0', 'w', 'x', 'y'] },
    TRIPLE_ZIGZAG: { pts: 6, minDev: 5, name: '三锯齿调整浪', category: '联合调整', rules: TRIPLE_ZIGZAG_RULES, labels: ['0', 'w', 'x', 'y', 'xx', 'z'] },
    COMBINATION: { pts: 4, minDev: 3, name: '双重横向整理', category: '联合调整', rules: COMBINATION_RULES, labels: ['0', 'w', 'x', 'y'] },
    TRIPLE_COMBINATION: { pts: 6, minDev: 5, name: '三重横向整理', category: '联合调整', rules: TRIPLE_COMBINATION_RULES, labels: ['0', 'w', 'x', 'y', 'xx', 'z'] }
  };

  /**
   * 同级别比例硬规则（各浪型通用）：
   * 反向腿（第2/4段：浪2/浪4、b/d、x/xx）用时不得少于前一同向腿的8%，否则视为级别错配。
   * pending='min': 末端拐点未确认(open)时暂不否决。
   */
  function degreeRules(pts) {
    const rules = [];
    for (const k of [1, 3]) {
      if (pts <= k + 1) continue;
      rules.push(rg(`L${k + 1}`, C_TIME, true, 'min', k + 2, '通用（EWI同级别比例）',
        `同级别比例：第${k + 1}段用时不得少于前一段的8%（级别错配）`, 1,
        g => ({ pass: g.t[k] >= 0.08 * g.t[k - 1], detail: `第${k + 1}段用时 ${g.t[k]}根 vs 前段 ${g.t[k - 1]}根（${fmtPct(g.t[k] / g.t[k - 1])}）` })));
    }
    return rules;
  }
  for (const type of Object.keys(PATTERNS)) {
    const def = PATTERNS[type];
    def.rules = def.rules.concat(degreeRules(def.pts));
  }

  // ---------------------------------------------------------------------------
  // 4. 子浪结构判定: 某段腿内部是「5」还是「3」
  //    优先用更低周期K线; 数据不足如实返回 unknown, 绝不编造拐点
  // ---------------------------------------------------------------------------

  function anchorZigzag(zp, pStart, pEnd) {
    const better = (a, b) => (a.type === 'high' ? a.price >= b.price : a.price <= b.price) ? a : b;
    const out = [pStart];
    for (const q of zp) {
      if (q.idx <= pStart.idx || q.idx >= pEnd.idx) continue;
      const last = out[out.length - 1];
      if (q.type === last.type) { if (better(q, last) === q) out[out.length - 1] = q; }
      else out.push(q);
    }
    const last = out[out.length - 1];
    if (pEnd.type === last.type) { if (better(pEnd, last) === pEnd) out[out.length - 1] = pEnd; }
    else out.push(pEnd);
    return out;
  }

  /** 驱动浪价格+时间硬规则快检 (子结构计数用, 跳过结构/慢速规则) */
  function motiveRulesOK(pts, kind) {
    const g = mkGeom(pts);
    const rules = kind === 'IMPULSE' ? MOTIVE_RULES.concat([IMPULSE_RULES[0]]) : MOTIVE_RULES.concat([DIAGONAL_RULES[0]]);
    for (const r of rules) {
      if (r.struct || r.slow || (r.cat !== C_PRICE && r.cat !== C_TIME)) continue;
      if (pts.length < r.need) continue;
      const res = r.test(g, null) || {};
      if (res.pass === false) {
        const open = !!pts[pts.length - 1].open;
        if (!(open && r.pending === 'min')) return false;
      }
    }
    return true;
  }

  /** 在交替拐点序列 zp 上寻找覆盖全段的合规五浪计数 (允许跳点，严控防爆搜预算) */
  function findMotiveCount(zp) {
    const N = zp.length;
    if (N < 6) return false;
    let arr = zp;
    if (N > 24) {
      const inner = zp.slice(1, N - 1);
      inner.sort((a, b) => Math.abs(b.price - zp[0].price) - Math.abs(a.price - zp[0].price));
      const chosen = [zp[0]].concat(inner.slice(0, 22)).concat([zp[N - 1]]);
      chosen.sort((a, b) => a.time - b.time);
      arr = chosen;
    }
    const len = arr.length;
    const last = len - 1;
    const path = [0];
    let budget = 2000;

    function rec(cur) {
      if (--budget <= 0) return false;
      if (path.length === 5) {
        if (((last - cur) & 1) === 0) return false;
        const pts = path.concat([last]).map(i => arr[i]);
        return motiveRulesOK(pts, 'IMPULSE') || motiveRulesOK(pts, 'DIAGONAL');
      }
      for (let j = cur + 1; j < last; j++) {
        if (((j - cur) & 1) === 0) continue;
        path.push(j);
        const pts = path.map(i => arr[i]);
        if (motiveRulesOK(pts, 'IMPULSE') || motiveRulesOK(pts, 'DIAGONAL')) {
          if (rec(j)) return true;
        }
        path.pop();
        if (budget <= 0) return false;
      }
      return false;
    }
    return rec(0);
  }

  /**
   * 判定腿 p[i]->p[i+1] 的内部结构: '5'(可数为驱动五浪) / '3'(非五浪, 调整浪) / 'unknown'
   */
  function legStructure(g, legIdx, ev) {
    const pA = g.p[legIdx], pB = g.p[legIdx + 1];
    const key = pA.idx + '_' + pB.idx;
    if (ev.structCache.has(key)) return ev.structCache.get(key);
    const res = computeLegStructure(pA, pB, ev);
    ev.structCache.set(key, res);
    return res;
  }

  function computeLegStructure(pA, pB, ev) {
    const t0 = pA.time, t1 = pB.time;
    let seg = null, srcName = null;
    if (ev.sources) {
      for (const s of ev.sources) {
        if (s.isMain) continue;
        const b = s.bars.filter(x => x.time >= t0 && x.time <= t1);
        if (b.length >= 12 && b.length <= 900 &&
          (b[b.length - 1].time - b[0].time) >= 0.6 * (t1 - t0)) { seg = b; srcName = s.name; break; }
      }
    }
    if (!seg) { seg = ev.bars.slice(pA.idx, pB.idx + 1); srcName = null; }
    if (!seg || seg.length < 6) return { label: 'unknown', subPivots: [], source: srcName };

    const range = Math.abs(pB.price - pA.price);
    if (!(range > 0)) return { label: 'unknown', subPivots: [], source: srcName };
    const sAtr = avgTR(seg) || range / seg.length;
    const ps = { idx: 0, time: seg[0].time, price: pA.price, type: pA.type, confirmed: true };
    const pe = { idx: seg.length - 1, time: seg[seg.length - 1].time, price: pB.price, type: pB.type, confirmed: true };

    for (const m of [0.10, 0.07, 0.05, 0.035]) {
      const thr = Math.max(range * m, 1.2 * sAtr);
      const anchored = anchorZigzag(zigzagPivots(seg, thr), ps, pe);
      if (anchored.length - 1 < 3) continue;
      const is5 = anchored.length >= 6 && findMotiveCount(anchored);
      return { label: is5 ? '5' : '3', subPivots: anchored, source: srcName };
    }
    return { label: 'unknown', subPivots: [], source: srcName };
  }

  function evalStructRule(r, g, ev) {
    if (!ev || !ev.bars) return { pass: true, neutral: true, detail: '无K线数据未验' };
    const parts = [];
    let allPass = true, anyEval = false;
    for (let k = 0; k < r.legs.length; k++) {
      const li = r.legs[k];
      if (li + 1 >= g.p.length) continue;
      const st = legStructure(g, li, ev);
      const expect = r.expect[k];
      if (st.label !== 'unknown') anyEval = true;
      const ok = st.label === 'unknown' || st.label === expect;
      if (!ok) allPass = false;
      const legName = (g.p.length === 4) ? 'abc'[li] : (g.p.length === 6 ? '12345'[li] : `${li + 1}`);
      parts.push(`浪${legName}:${st.label === '5' ? '五浪' : st.label === '3' ? '非五浪' : '级别不足'}${st.source ? `(${st.source})` : ''}`);
    }
    if (!anyEval) return { pass: true, neutral: true, detail: '小级别数据不足，结构未验证' };
    return { pass: allPass, detail: parts.join(' ') };
  }

  // ---------------------------------------------------------------------------
  // 5. 假设求值
  // ---------------------------------------------------------------------------

  /**
   * 对一条候选路径执行该浪型全部适用规则。
   * 返回 {g, checks, hardFails, pending, guide:{pass,fail,weight,weightGot}, complete}
   */
  function evaluatePattern(type, points, ev) {
    const def = PATTERNS[type];
    const g = mkGeom(points);
    const checks = [], hardFails = [], pending = [];
    const guide = { pass: 0, fail: 0, weight: 0, weightGot: 0 };
    const lastOpen = !!points[points.length - 1].open;

    for (const r of def.rules) {
      if (points.length < r.need) {
        // 未评估指引按中性计分（避免发展中计数因检验项少而获得偏高指引分）
        if (!r.hard) { guide.weight += r.w; guide.weightGot += 0.5 * r.w; }
        continue;
      }
      let res;
      if (r.struct) res = evalStructRule(r, g, ev || {});
      else if (r.manual) res = { pass: true, neutral: true, detail: '人工指引项，自动判定从略' };
      else res = r.test(g, ev) || {};

      const openSuppressed = lastOpen && r.pending === 'min' && res.pass === false;
      const check = {
        id: r.id, cat: r.cat, page: r.page, text: r.text, hard: !!r.hard,
        pass: res.pass !== false, pending: !!res.pending, neutral: !!res.neutral,
        detail: res.detail || ''
      };
      if (openSuppressed) { check.pass = true; check.pending = true; }
      checks.push(check);

      if (r.hard) {
        if (check.pending || check.neutral) { if (check.pending) pending.push(check); }
        else if (!check.pass) hardFails.push(check);
      } else {
        guide.weight += r.w;
        if (check.neutral || check.pending) guide.weightGot += r.w * 0.5;
        else if (check.pass) { guide.pass++; guide.weightGot += r.w; }
        else guide.fail++;
      }
    }
    return { g, checks, hardFails, pending, guide, complete: points.length === def.pts };
  }

  /** 增量剪枝: 路径末端新增 pivot 后, 只运行 need===n 的快速硬规则 */
  function pruneCheck(def, pts, ev) {
    const n = pts.length;
    const g = mkGeom(pts);
    const lastOpen = !!pts[n - 1].open;
    for (const r of def.rules) {
      if (!r.hard || r.need !== n || r.struct || r.slow || r.manual) continue;
      const res = r.test(g, ev) || {};
      if (res.pass === false && !(lastOpen && r.pending === 'min')) return { rule: r, res, g };
    }
    return null;
  }

  const DFS_BUDGET = 120000;

  function searchPattern(type, pivs, legOk, ev, blockMap) {
    const def = PATTERNS[type];
    const N = pivs.length;
    const out = [];
    const path = [];
    let nodes = 0;

    function recordBlocker(bad) {
      const key = type + '|' + bad.rule.id;
      const span = path[path.length - 1] - path[0];
      const prev = blockMap.get(key);
      if (!prev || span > prev.span) {
        blockMap.set(key, { pattern: def.name, rule: bad.rule, detail: bad.res.detail, span });
      }
    }

    function dfs(idx) {
      if (++nodes > DFS_BUDGET) return;
      path.push(idx);
      const n = path.length;
      if (n >= 2) {
        const pts = path.map(i => pivs[i]);
        const bad = pruneCheck(def, pts, ev);
        if (bad) {
          if (idx >= N - 2 && n >= 3) recordBlocker(bad);
          path.pop();
          return;
        }
        const isLast = idx === N - 1;
        const isPrev = idx === N - 2;
        const full = n === def.pts;
        if ((full && (isLast || isPrev)) || (!full && isLast && n >= def.minDev)) {
          out.push({
            type, idxs: path.slice(),
            status: full ? (pivs[idx].open ? 'RUNNING' : 'COMPLETED') : 'DEVELOPING'
          });
        }
        if (full || isLast) { path.pop(); return; }
      }
      for (let j = idx + 1; j < N; j++) {
        if (((j - idx) & 1) === 0) continue;
        if (!legOk[idx][j]) continue;
        dfs(j);
        if (nodes > DFS_BUDGET) return;
      }
      path.pop();
    }

    for (let i = 0; i < N - 1; i++) dfs(i);
    return out;
  }

  // ---------------------------------------------------------------------------
  // 6. 监测点 / 目标位 / 通道 构建
  // ---------------------------------------------------------------------------

  function lvl(price, levelName, description) {
    return { price, levelName, description };
  }
  function tgt(price, label, ratio) {
    return { price: Math.round(price * 100) / 100, label, ratio };
  }

  function buildLevels(type, g, status, ev) {
    const p = g.p, l = g.l, d = g.d, n = p.length;
    const lastIdx = p[n - 1].idx;
    const targets = [];
    let monitoringPivot = null, secondaryPivot = null;

    if (type === 'IMPULSE' || type === 'DIAGONAL') {
      const diag = type === 'DIAGONAL';
      if (n === 3) {
        [0.382, 0.5, 0.618].forEach(r => targets.push(tgt(p[1].price - d * r * l[0], `浪2回撤浪1×${r}`, r)));
        targets.push(tgt(p[0].price, '浪2绝对边界: 浪1起点（铁律）', 1));
        monitoringPivot = lvl(p[0].price, '浪1起点·铁律红线', '手稿P32: 浪2回撤达到浪1的100%即否决该计数');
      } else if (n === 4) {
        targets.push(tgt(p[1].price, '浪3最低要求: 超越浪1终点', null));
        [1, 1.618, 2.618].forEach(r => targets.push(tgt(p[2].price + d * r * l[0], `浪3=浪1×${r}`, r)));
        monitoringPivot = lvl(p[2].price, '浪2终点·浪3计数防线', '跌破则“浪3运行中”计数失效（浪2尚未结束）');
        secondaryPivot = lvl(p[1].price, diag ? '浪1终点·浪4须切入(P48楔形)' : '浪1终点·浪4禁区边界(P48)', diag ? '楔形浪4必须切入浪1价格区' : '推动浪浪4不可切入浪1价格区');
      } else if (n === 5) {
        [0.236, 0.382, 0.5].forEach(r => targets.push(tgt(p[3].price - d * r * l[2], `浪4回撤浪3×${r}`, r)));
        targets.push(tgt(p[1].price, diag ? '浪4须切入浪1区（楔形）' : '浪4禁区: 浪1价格区上沿', null));
        if (diag) {
          monitoringPivot = lvl(p[2].price, '浪2终点·浪4不可完全回撤浪3', '手稿P42: 浪4回撤达到浪3的100%即否决');
          secondaryPivot = lvl(p[1].price, '浪1终点·浪4切入要求', '楔形浪4终点应进入浪1价格区');
        } else {
          monitoringPivot = lvl(p[1].price, '浪1终点·浪4禁区', '手稿P48: 推动浪浪4任何子浪不得切入浪1价格区');
          secondaryPivot = lvl(p[2].price, '浪2终点·最后防线', '手稿P42: 浪4不得完全回撤浪3');
        }
      } else if (status === 'COMPLETED') {
        [0.382, 0.5, 0.618].forEach(r => targets.push(tgt(p[5].price - d * r * (l[0] + l[2] + l[4] || l[2]), `整体回撤×${r}`, r)));
        monitoringPivot = lvl(p[5].price, '浪5终点·趋势延续线', '突破则浪5延长或更大级别趋势延续，需重估计数');
        secondaryPivot = lvl(p[4].price, '浪4终点·同级调整目标区', '调整浪常以浪4价格区为回撤目标');
      } else {
        [0.618, 1, 1.618].forEach(r => targets.push(tgt(p[4].price + d * r * l[0], `浪5=浪1×${r}`, r)));
        if (l[2] < l[0]) targets.push(tgt(p[4].price + d * 0.382 * l[2], '浪5上限≈0.382×浪3（浪3非最短约束）', 0.382));
        targets.push(tgt(p[4].price + d * 0.7 * l[3], '衰竭5浪最低: 0.7×浪4 (P204)', 0.7));
        monitoringPivot = lvl(p[4].price, '浪4终点·浪5防线', '跌破则浪5可能结束或计数失效');
        secondaryPivot = lvl(p[3].price, '浪3终点·衰竭判定线', '未过此线且不足浪4×0.7则浪型违规（P204）');
      }
    } else if (type === 'ZIGZAG' || type === 'FLAT') {
      const flat = type === 'FLAT';
      if (n === 3) {
        if (flat) {
          targets.push(tgt(p[1].price - d * 0.7 * l[0], 'b浪最低要求: 0.7×a浪总量(P234)', 0.7));
          [0.95, 1.236, 1.382].forEach(r => targets.push(tgt(p[1].price - d * r * l[0], `b浪=a浪×${r}`, r)));
          monitoringPivot = lvl(p[1].price - d * 2 * l[0], 'b浪上限: 2×a浪总量(P235)', 'b浪运行总量不得超过a浪2倍');
          secondaryPivot = lvl(p[0].price, 'a浪起点·参照位', 'b浪越过a起点即进入扩散/顺势形态讨论');
        } else {
          targets.push(tgt(p[1].price - d * 0.2 * l[0], 'b浪最低要求: 0.2×a浪(P213)', 0.2));
          [0.382, 0.5, 0.618].forEach(r => targets.push(tgt(p[1].price - d * r * l[0], `b浪回撤a浪×${r}`, r)));
          monitoringPivot = lvl(p[0].price, 'a浪起点·b浪禁区', '手稿P213: b浪不能超过a浪起点');
        }
      } else if (status === 'COMPLETED') {
        const total = Math.abs(p[3].price - p[0].price);
        [0.382, 0.5, 0.618].forEach(r => targets.push(tgt(p[3].price - d * r * total, `调整整体回撤×${r}`, r)));
        monitoringPivot = lvl(p[3].price, 'c浪终点·结构防线', '被同向突破则c浪延长或整体计数重估');
        secondaryPivot = lvl(p[2].price, 'b浪终点·调整结束确认线', '反向收复b浪起点则调整大概率结束');
      } else {
        targets.push(tgt(p[2].price + d * 0.9 * l[1], 'c浪最低要求: 0.9×b浪(P213)', 0.9));
        targets.push(tgt(p[1].price, 'a浪终点（c浪通常越过）', null));
        [0.618, 1, 1.618].forEach(r => targets.push(tgt(p[2].price + d * r * l[0], `c=a×${r}`, r)));
        targets.push(tgt(p[1].price + d * 0.618 * l[0], 'a终点+0.618×a (P214)', 0.618));
        monitoringPivot = lvl(p[2].price, 'b浪终点·c浪起点防线', '反向收复则调整大概率结束（监测点战法）');
        secondaryPivot = lvl(p[0].price, 'a浪起点·反转确认线', '反向收复a浪起点则确认趋势反转');
      }
    } else if (type === 'TRIANGLE') {
      if (n === 4) {
        targets.push(tgt(p[2].price + d * 0.618 * l[0], 'c浪≈0.618×a浪(P327)', 0.618));
        targets.push(tgt(p[2].price + d * 0.786 * l[0], 'c浪≈0.786×a浪', 0.786));
        monitoringPivot = lvl(p[1].price, 'b浪起点·c浪禁区', '手稿P302: c浪不能大于b浪');
      } else if (n === 5) {
        [0.618, 0.786].forEach(r => targets.push(tgt(p[3].price - d * r * l[1], `d浪≈${r}×b浪`, r)));
        monitoringPivot = lvl(p[2].price, 'c浪终点·d浪禁区', '手稿P302: d浪不能超过c浪起点');
      } else if (status !== 'COMPLETED') {
        targets.push(tgt(p[4].price + d * 0.7 * l[3], 'e浪≈0.7×d浪(P327)', 0.7));
        targets.push(tgt(p[4].price + d * 0.618 * l[2], 'e浪≈0.618×c浪(P327)', 0.618));
        monitoringPivot = lvl(p[3].price, 'd浪起点·e浪禁区', '手稿P302: e浪不能超过d浪起点');
        secondaryPivot = lvl(p[1].price, 'a浪终点·e浪区间边界', '手稿P345: e浪须进入a浪价格区间');
      } else {
        const bdNow = lineVal(p[2].idx, p[2].price, p[4].idx, p[4].price, lastIdx);
        const height = Math.abs(lineVal(p[1].idx, p[1].price, p[3].idx, p[3].price, p[0].idx) -
          lineVal(p[2].idx, p[2].price, p[4].idx, p[4].price, p[0].idx));
        targets.push(tgt(p[5].price - d * height, '突破目标=三角形高度(P349)', null));
        monitoringPivot = lvl(bdNow, 'b-d趋势线·突破确认', '手稿P349-350: 突破须顺原趋势；反扑回到区间内即判误');
        secondaryPivot = lvl(p[5].price, 'e浪终点·下一浪起点', '手稿P352: 三角形后下一浪必须从e浪终点起步');
      }
    } else if (type === 'COMBINATION' || type === 'TRIPLE_COMBINATION') {
      const triple = type === 'TRIPLE_COMBINATION';
      if (!triple && n === 3) {
        targets.push(tgt(p[1].price - d * 0.7 * l[0], 'x浪最低要求: 0.7×w浪(P50)', 0.7));
        [1.0, 1.382].forEach(r => targets.push(tgt(p[1].price - d * r * l[0], `x=w×${r}`, r)));
        monitoringPivot = lvl(p[1].price - d * 1.5 * l[0], 'x浪上限: 1.5×w浪总量(P301)', 'x浪运行总量超过w浪1.5倍则联合形假设作废');
        secondaryPivot = lvl(p[0].price, 'w浪起点·参照位', 'x浪越过w起点进入顺势联合形讨论');
      } else if (!triple && status !== 'COMPLETED') {
        [0.786, 1, 1.272].forEach(r => targets.push(tgt(p[2].price + d * r * l[0], `y=w×${r}(扩展取点0-w-x, P131)`, r)));
        monitoringPivot = lvl(p[2].price, 'x浪终点·y浪起点防线', 'y浪自x浪终点起步');
        secondaryPivot = lvl(p[0].price, 'w浪起点·箱型边界', '横向整理应维持箱型外观（P50）');
      } else if (triple && n === 5) {
        targets.push(tgt(p[3].price - d * 0.7 * l[2], 'xx浪最低要求: 0.7×y浪(P51)', 0.7));
        targets.push(tgt(p[3].price - d * 1.0 * l[2], 'xx=y×1', 1));
        monitoringPivot = lvl(p[3].price - d * 1.5 * l[2], 'xx浪上限: 1.5×y浪总量(P301类推)', 'xx浪总量超过y浪1.5倍则三重横向整理假设作废');
      } else if (triple && status !== 'COMPLETED') {
        targets.push(tgt(p[4].price + d * 1.0 * l[2], 'z=y×1（扩展取点x-y-xx, P132)', 1));
        targets.push(tgt(p[4].price + d * 0.786 * l[2], 'z=y×0.786', 0.786));
        monitoringPivot = lvl(p[4].price, 'xx浪终点·z浪起点防线', 'z浪自xx浪终点起步');
        secondaryPivot = lvl(p[2].price, 'y浪起点·参照位', '');
      } else {
        const end = p[n - 1].price, total = Math.abs(end - p[0].price);
        [0.382, 0.5, 0.618].forEach(r => targets.push(tgt(end - d * r * total, `整体回撤×${r}`, r)));
        monitoringPivot = lvl(end, `${triple ? 'z' : 'y'}浪终点·结构防线`, '被同向突破则横向整理延长或计数重估');
        secondaryPivot = lvl(p[n - 2].price, `${triple ? 'xx' : 'x'}浪终点·确认线`, '反向收复则调整大概率结束');
      }
    } else if (type === 'DOUBLE_ZIGZAG' || type === 'TRIPLE_ZIGZAG') {
      const triple = type === 'TRIPLE_ZIGZAG';
      if (!triple && n === 4 && status !== 'COMPLETED') {
        targets.push(tgt(p[2].price + d * 0.9 * l[0], 'y浪最低要求: 0.9×w浪(P372)', 0.9));
        [1, 1.618].forEach(r => targets.push(tgt(p[2].price + d * r * l[0], `y=w×${r}`, r)));
        monitoringPivot = lvl(p[2].price, 'x浪终点·y浪禁区', '手稿P372: y浪不可越过x浪起点');
        secondaryPivot = lvl(lineVal(p[0].idx, p[0].price, p[2].idx, p[2].price, lastIdx), '0-x基线', '手稿P362: y浪子浪不能越过0-x基线');
      } else if (triple && n === 5) {
        [0.3, 0.5, 0.618].forEach(r => targets.push(tgt(p[3].price - d * r * l[2], `xx浪回撤y浪×${r}`, r)));
        monitoringPivot = lvl(p[2].price, 'y浪起点·xx禁区', '手稿P385: xx浪不能越过y浪起点');
      } else if (triple && status !== 'COMPLETED') {
        targets.push(tgt(p[4].price + d * 0.9 * l[1], 'z浪最低要求: 0.9×x浪', 0.9));
        [1, 1.618].forEach(r => targets.push(tgt(p[4].price + d * r * l[2], `z=y×${r}`, r)));
        monitoringPivot = lvl(p[4].price, 'xx终点·z浪防线', 'z浪运行中以xx终点为结构防线');
        secondaryPivot = lvl(p[2].price, 'y浪起点', 'xx/y结构参照位');
      } else {
        const end = p[n - 1].price, total = Math.abs(end - p[0].price);
        [0.382, 0.5, 0.618].forEach(r => targets.push(tgt(end - d * r * total, `整体回撤×${r}`, r)));
        monitoringPivot = lvl(end, `${triple ? 'z' : 'y'}浪终点·结构防线`, '被同向突破则联合调整延长或计数重估');
        secondaryPivot = lvl(p[n - 2].price, `${triple ? 'xx' : 'x'}浪终点·确认线`, '反向收复则调整大概率结束');
      }
    }
    return { monitoringPivot, secondaryPivot, targets };
  }

  function buildChannel(type, g) {
    // 艾略特通道：仅作为视觉辅助参照物与投射辅助线输出，不作为制定或裁决波浪有效性的标准
    const p = g.p, n = p.length;
    const pt = q => ({ time: q.time, price: q.price });
    if (type === 'IMPULSE' || type === 'DIAGONAL') {
      if (type === 'DIAGONAL' && n >= 5) {
        return {
          type: 'CONVERGING',
          upperLine: { pA: pt(p[1]), pB: pt(p[3]) },
          lowerLine: { pA: pt(p[2]), pB: pt(p[4]) },
          note: '楔形边界参考线: 1-3 与 2-4（仅供视觉参考，非波浪判定标准）'
        };
      }
      if (n >= 5) {
        return { type: 'PARALLEL', baseLine: { pA: pt(p[2]), pB: pt(p[4]) }, parallelLine: { p: pt(p[3]) }, note: '推动浪辅助通道: 2-4 基线过浪3平行轨（仅供视觉参考，非波浪判定标准）' };
      }
      return { type: 'PARALLEL', baseLine: { pA: pt(p[0]), pB: pt(p[2]) }, parallelLine: { p: pt(p[1]) }, note: '早期辅助通道: 0-2 基线过浪1平行轨（仅供视觉参考，非波浪判定标准）' };
    }
    if (type === 'TRIANGLE' && n >= 5) {
      return {
        type: 'CONVERGING',
        upperLine: { pA: pt(p[1]), pB: pt(p[3]) },
        lowerLine: { pA: pt(p[2]), pB: pt(p[4]) },
        note: '三角形边界收敛线: a-c 与 b-d（仅供视觉参考，非波浪判定标准）'
      };
    }
    if (n >= 3) {
      return { type: 'PARALLEL', baseLine: { pA: pt(p[0]), pB: pt(p[2]) }, parallelLine: { p: pt(p[1]) }, note: '调整浪辅助通道: 0-b/x 基线过a/w平行轨（仅供视觉参考，非波浪判定标准）' };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // 7. 候选构建 / 打分 / 排序
  // ---------------------------------------------------------------------------

  function flatSubtype(g) {
    if (g.l[1] <= g.l[0] + EPS) return '规则平台形';
    return g.d * (g.p[3].price - g.p[1].price) > 0 ? '扩散平台形' : '顺势平台形';
  }
  function triSubtype(g) {
    return g.l[1] <= g.l[0] + EPS ? '规则收缩' : '顺势收缩';
  }
  function stageText(type, n, status) {
    const M = {
      IMPULSE: { 3: '浪2回撤中', 4: '浪3运行中', 5: '浪4调整中', 6: status === 'COMPLETED' ? '五浪完成·待调整' : '浪5运行中' },
      DIAGONAL: { 5: '楔形浪4运行中', 6: status === 'COMPLETED' ? '楔形完成' : '楔形浪5运行中' },
      ZIGZAG: { 3: 'b浪运行中', 4: status === 'COMPLETED' ? '锯齿完成' : 'c浪运行中' },
      FLAT: { 3: 'b浪运行中', 4: status === 'COMPLETED' ? '平台形完成' : 'c浪运行中' },
      TRIANGLE: { 4: 'c浪收敛中', 5: 'd浪收敛中', 6: status === 'COMPLETED' ? '三角形完成·等待突破' : 'e浪收敛中' },
      DOUBLE_ZIGZAG: { 4: status === 'COMPLETED' ? '双锯齿完成' : 'y浪运行中' },
      TRIPLE_ZIGZAG: { 5: 'xx浪运行中', 6: status === 'COMPLETED' ? '三锯齿完成' : 'z浪运行中' },
      COMBINATION: { 3: 'x浪运行中', 4: status === 'COMPLETED' ? '双重横向整理完成' : 'y浪运行中' },
      TRIPLE_COMBINATION: { 5: 'xx浪运行中', 6: status === 'COMPLETED' ? '三重横向整理完成' : 'z浪运行中' }
    };
    return (M[type] && M[type][n]) || '演化中';
  }

  function buildFibLevels(type, g, status) {
    const p = g.p, l = g.l, d = g.d, n = p.length;
    const retracements = [];
    const extensions = [];
    const isMotive = type === 'IMPULSE' || type === 'DIAGONAL';
    const isBull = d > 0;

    if (isMotive) {
      // 驱动浪：回撤参考段（浪3或浪1）
      const refLen = n >= 4 ? l[2] : (l[0] || 1);
      const refEnd = n >= 4 ? p[3].price : (p[1] ? p[1].price : p[0].price);
      [0.236, 0.382, 0.500, 0.618, 0.786].forEach(r => {
        const pr = isBull ? refEnd - r * refLen : refEnd + r * refLen;
        retracements.push({ ratio: r, price: Number(pr.toFixed(2)), label: `Fib ${(r * 100).toFixed(1)}%` });
      });

      // 扩展参考段（浪1起点与终点）
      const baseLen = l[0] || 1;
      const startP = n >= 3 ? p[2].price : p[0].price;
      [1.000, 1.272, 1.618, 2.000, 2.618].forEach(r => {
        const pr = isBull ? startP + r * baseLen : startP - r * baseLen;
        extensions.push({ ratio: r, price: Number(pr.toFixed(2)), label: `${r.toFixed(3)}x 目标` });
      });
    } else {
      // 调整浪：a浪回撤与c浪扩展
      const aLen = l[0] || 1;
      const aEnd = p[1] ? p[1].price : p[0].price;
      [0.382, 0.500, 0.618, 0.786].forEach(r => {
        const pr = isBull ? aEnd - r * aLen : aEnd + r * aLen;
        retracements.push({ ratio: r, price: Number(pr.toFixed(2)), label: `b浪回撤 ${(r * 100).toFixed(1)}%` });
      });

      const bEnd = n >= 3 ? p[2].price : (p[1] ? p[1].price : p[0].price);
      [0.900, 1.000, 1.272, 1.618].forEach(r => {
        const pr = isBull ? bEnd + r * aLen : bEnd - r * aLen;
        extensions.push({ ratio: r, price: Number(pr.toFixed(2)), label: `c浪目标 ${r.toFixed(3)}x` });
      });
    }

    return { retracements, extensions };
  }

  function buildCandidate(h, evalRes, ev, pivs) {
    const def = PATTERNS[h.type];
    const g = evalRes.g;
    const n = g.p.length;
    const dirTxt = g.d > 0 ? '上升' : '下跌';

    let subtype = '';
    if (h.type === 'FLAT' && n === 4) subtype = flatSubtype(g);
    if (h.type === 'TRIANGLE' && n >= 3) subtype = triSubtype(g);
    if (h.type === 'DIAGONAL') {
      const i0 = h.idxs[0];
      const sameDirBefore = i0 >= 2 && (g.d * (pivs[i0 - 1].price - pivs[i0 - 2].price) > 0);
      subtype = sameDirBefore ? '终结楔形倾向' : '引导楔形倾向';
    }

    const stage = stageText(h.type, n, h.status);
    const name = `${subtype ? subtype : def.name}（${dirTxt}·${stage}）`;

    const metrics = {};
    if (h.type === 'IMPULSE' || h.type === 'DIAGONAL') {
      metrics.retrace_2 = +(g.l[1] / g.l[0]).toFixed(3);
      if (n >= 4) metrics.ratio_3_1 = +(g.l[2] / g.l[0]).toFixed(3);
      if (n >= 5) metrics.retrace_4 = +(g.l[3] / g.l[2]).toFixed(3);
      if (n >= 6) metrics.ratio_5_1 = +(g.l[4] / g.l[0]).toFixed(3);
    } else if (h.type === 'ZIGZAG' || h.type === 'FLAT') {
      metrics.retrace_B = +(g.l[1] / g.l[0]).toFixed(3);
      if (n >= 4) metrics.ratio_C_A = +(g.l[2] / g.l[0]).toFixed(3);
    } else if (h.type === 'TRIANGLE') {
      metrics.ratio_B_A = +(g.l[1] / g.l[0]).toFixed(3);
      if (n >= 4) metrics.ratio_C_B = +(g.l[2] / g.l[1]).toFixed(3);
      if (n >= 5) metrics.ratio_D_C = +(g.l[3] / g.l[2]).toFixed(3);
      if (n >= 6) metrics.ratio_E_D = +(g.l[4] / g.l[3]).toFixed(3);
    } else {
      metrics.retrace_X = +(g.l[1] / g.l[0]).toFixed(3);
      if (n >= 4) metrics.ratio_Y_W = +(g.l[2] / g.l[0]).toFixed(3);
      if (n >= 5) metrics.retrace_XX = +(g.l[3] / g.l[2]).toFixed(3);
      if (n >= 6) metrics.ratio_Z_Y = +(g.l[4] / g.l[2]).toFixed(3);
    }

    const rules = {};
    const get = id => { const c = evalRes.checks.find(x => x.id === id); return c ? c.pass : undefined; };
    if (h.type === 'IMPULSE' || h.type === 'DIAGONAL') {
      rules.rule1_wave2_retrace = get('M1');
      rules.rule2_wave3_not_shortest = get('M5');
      rules.rule3_wave4_no_overlap = h.type === 'IMPULSE' ? get('I1') : get('D1');
    }

    const levels = buildLevels(h.type, g, h.status, ev);
    const fibLevels = buildFibLevels(h.type, g, h.status);

    // 子浪拐点: 仅使用真实检测到的更细级别拐点 (无数据则为空, 不编造)
    const subPivots = [];
    if (ev && ev.bars) {
      for (let li = 0; li + 1 < n; li++) {
        const st = legStructure(g, li, ev);
        for (const q of st.subPivots) {
          subPivots.push({ time: q.time, price: q.price, type: q.type, leg: li });
        }
      }
    }

    const waveLabels = def.labels.slice(0, n).slice();
    if (h.status !== 'COMPLETED') waveLabels[waveLabels.length - 1] += '?';

    const span = g.p[n - 1].idx - g.p[0].idx;
    return {
      id: `${h.type.toLowerCase()}_${h.idxs.join('_')}`,
      type: `${h.type}_${g.d > 0 ? 'BULLISH' : 'BEARISH'}`,
      baseType: h.type,
      name, category: def.category, direction: g.d > 0 ? 'BULLISH' : 'BEARISH',
      status: h.status, currentWave: stage,
      pivots: g.p.map(q => ({ idx: q.idx, time: q.time, price: q.price, type: q.type, confirmed: q.confirmed !== false })),
      waveLabels, subPivots,
      metrics, rules, ruleChecks: evalRes.checks.map(c => ({ id: c.id, category: CAT_NAMES[c.cat], page: c.page, text: c.text, hard: c.hard, pass: c.pass, pending: c.pending, detail: c.detail })),
      pendingCount: evalRes.pending.length,
      guidePct: evalRes.guide.weight ? Math.round(100 * evalRes.guide.weightGot / evalRes.guide.weight) : 0,
      channel: buildChannel(h.type, g),
      monitoringPivot: levels.monitoringPivot,
      secondaryPivot: levels.secondaryPivot,
      targets: levels.targets,
      fibLevels,
      span
    };
  }

  // ---------------------------------------------------------------------------
  // 7.1 选区内极值识别与磁吸锚定 (消除人工截取边界误差)
  // ---------------------------------------------------------------------------

  /**
   * 自动探测选区范围（及边界容差）内的全局真实最高点与最低点，
   * 消除人工手动点击选区时起始点/终点未落在极值波峰波谷带来的偏差。
   */
  function identifyRangeExtrema(bars, iS, iE) {
    if (!bars || bars.length === 0) return null;
    const len = bars.length;
    let s = Math.max(0, Math.min(len - 1, iS !== undefined && iS !== null ? iS : 0));
    let e = Math.max(0, Math.min(len - 1, iE !== undefined && iE !== null ? iE : len - 1));
    if (s > e) { const tmp = s; s = e; e = tmp; }

    const selLen = e - s + 1;
    // 边界容差 (至少 3 根 K 线，最多延伸至选区长度的 8% 或 8 根)，捕捉刚刚好落在选区边缘外 2~3 根的真实大极值
    const boundaryTol = Math.max(3, Math.min(8, Math.round(selLen * 0.08)));
    const searchS = Math.max(0, s - boundaryTol);
    const searchE = Math.min(len - 1, e + boundaryTol);

    let minPrice = Infinity, minIdx = s, minTime = bars[s].time;
    let maxPrice = -Infinity, maxIdx = s, maxTime = bars[s].time;

    for (let i = s; i <= e; i++) {
      const b = bars[i];
      if (b.low < minPrice) { minPrice = b.low; minIdx = i; minTime = b.time; }
      if (b.high > maxPrice) { maxPrice = b.high; maxIdx = i; maxTime = b.time; }
    }

    // 亦探测含容差的极值 (以防人工点击刚好漏掉了 1 根极值蜡烛)
    let tolMinPrice = minPrice, tolMinIdx = minIdx, tolMinTime = minTime;
    let tolMaxPrice = maxPrice, tolMaxIdx = maxIdx, tolMaxTime = maxTime;
    for (let i = searchS; i <= searchE; i++) {
      const b = bars[i];
      if (b.low < tolMinPrice) { tolMinPrice = b.low; tolMinIdx = i; tolMinTime = b.time; }
      if (b.high > tolMaxPrice) { tolMaxPrice = b.high; tolMaxIdx = i; tolMaxTime = b.time; }
    }

    const priceSpan = Math.round(Math.abs(maxPrice - minPrice) * 100) / 100;
    const priceSpanPct = minPrice > 0 ? Math.round((priceSpan / minPrice) * 10000) / 100 : 0;
    const isTroughFirst = minIdx < maxIdx;
    const dominantDirection = isTroughFirst ? 'BULLISH' : (maxIdx < minIdx ? 'BEARISH' : 'NEUTRAL');

    const primaryAnchor = isTroughFirst
      ? { type: 'low', price: minPrice, time: minTime, idx: minIdx, label: '最低谷底起跑点' }
      : { type: 'high', price: maxPrice, time: maxTime, idx: maxIdx, label: '最高见顶发端点' };

    const secondaryAnchor = isTroughFirst
      ? { type: 'high', price: maxPrice, time: maxTime, idx: maxIdx, label: '波段最高冲刺点' }
      : { type: 'low', price: minPrice, time: minTime, idx: minIdx, label: '波段最低下探点' };

    return {
      minPrice, minTime, minIdx,
      maxPrice, maxTime, maxIdx,
      tolMinPrice, tolMinIdx, tolMinTime,
      tolMaxPrice, tolMaxIdx, tolMaxTime,
      isBoundaryExtended: (tolMinIdx !== minIdx || tolMaxIdx !== maxIdx),
      priceSpan, priceSpanPct,
      timeSpanBars: Math.abs(maxIdx - minIdx),
      isTroughFirst,
      dominantDirection,
      primaryAnchor,
      secondaryAnchor,
      summary: `选区内已探测全局极值：最低点 $${fmtNum(minPrice)} (Bar ${minIdx})，最高点 $${fmtNum(maxPrice)} (Bar ${maxIdx})，结构方向偏${dominantDirection === 'BULLISH' ? '多' : '空'}，落差 ${priceSpanPct}%`
    };
  }

  // ---------------------------------------------------------------------------
  // 7.2 前序浪型脉络与大级别背景衔接 (柳玉冬：观当下必先审前身)
  // ---------------------------------------------------------------------------

  /**
   * 考察选区起点之前（或全图前段）的历史行情脉络与同级别/大级别浪型，
   * 遵循柳玉冬“判断调整还是驱动浪不能脱离前序浪型”的实战核心方法论。
   */
  function analyzePrecedingContext(bars, iS, mainPivots, timeframe, htfBars) {
    if (!bars || bars.length < 10) {
      return {
        hasPrecedingData: false,
        dominantTrend: 'NEUTRAL',
        character: 'CONSOLIDATION',
        liuDeduction: '前序数据不足，以当前选区独立结构为主要研判基准。',
        favoredWaveTypes: ['IMPULSE', 'ZIGZAG', 'FLAT']
      };
    }

    // 取选区起点之前的 K 线窗口 (最多往前看 300 根，最少 8 根)
    const endIdx = iS !== undefined && iS !== null && iS > 8 ? iS : Math.floor(bars.length * 0.4);
    const startIdx = Math.max(0, endIdx - 300);
    const precBars = bars.slice(startIdx, endIdx);

    if (precBars.length < 8) {
      return {
        hasPrecedingData: false,
        precedingBarsCount: precBars.length,
        dominantTrend: 'NEUTRAL',
        character: 'CONSOLIDATION',
        liuDeduction: '选区起点距历史开端较近，前序形态未展，重点聚焦选区内微观结构。',
        favoredWaveTypes: ['IMPULSE', 'ZIGZAG', 'FLAT']
      };
    }

    const pFirst = precBars[0].close;
    const pLast = precBars[precBars.length - 1].close;
    const netChangePct = pFirst > 0 ? ((pLast - pFirst) / pFirst) * 100 : 0;

    let swingHigh = { price: -Infinity, idx: startIdx, time: precBars[0].time };
    let swingLow = { price: Infinity, idx: startIdx, time: precBars[0].time };

    for (let i = 0; i < precBars.length; i++) {
      const b = precBars[i];
      if (b.high > swingHigh.price) { swingHigh = { price: b.high, idx: startIdx + i, time: b.time }; }
      if (b.low < swingLow.price) { swingLow = { price: b.low, idx: startIdx + i, time: b.time }; }
    }

    const amplitudePct = swingLow.price > 0 ? ((swingHigh.price - swingLow.price) / swingLow.price) * 100 : 0;

    // 前序趋势定性
    let dominantTrend = 'NEUTRAL';
    if (netChangePct > 2.0) dominantTrend = 'BULLISH';
    else if (netChangePct < -2.0) dominantTrend = 'BEARISH';
    else {
      // 若首尾变动不大，但高低点落差显著，考察最后阶段斜率
      const tailBars = precBars.slice(-Math.min(20, Math.floor(precBars.length / 2)));
      const tailChange = ((tailBars[tailBars.length - 1].close - tailBars[0].close) / tailBars[0].close) * 100;
      if (tailChange > 2.0) dominantTrend = 'BULLISH';
      else if (tailChange < -2.0) dominantTrend = 'BEARISH';
    }

    // 前序走势性质 (是急跌/急升驱动，还是重叠震荡调整)
    let character = 'CONSOLIDATION';
    const isSteep = Math.abs(netChangePct) > 6.0 || amplitudePct > 10.0;
    if (dominantTrend === 'BEARISH') {
      character = isSteep ? 'IMPULSE_DOWN' : 'CORRECTIVE_DOWN';
    } else if (dominantTrend === 'BULLISH') {
      character = isSteep ? 'IMPULSE_UP' : 'CORRECTIVE_UP';
    }

    // 柳玉冬核心理论推导与承接判语
    let liuDeduction = '';
    let favoredWaveTypes = [];
    let cautions = '';

    if (dominantTrend === 'BEARISH') {
      favoredWaveTypes = ['ZIGZAG', 'FLAT', 'COMBINATION', 'IMPULSE'];
      if (character === 'IMPULSE_DOWN') {
        liuDeduction = `前序为大级别顺势下跌驱动（区间跌幅 ${Math.abs(netChangePct).toFixed(1)}%，波峰 $${fmtNum(swingHigh.price)}）。柳玉冬体系指出：“观当下必先审前身”，在一段完备的下跌驱动之后，当前所选行情若向上展开，首要假设是次级调整浪（反弹B浪或X浪），不可盲目将其预设为主升推动浪。若要确立为新一轮牛市浪1起点，首段必须满足“有推动浪才有做底可能”，即微观能数出不重叠的五浪推动。`;
        cautions = `逢反弹受前序波峰 $${fmtNum(swingHigh.price)} 及 0.382/0.618 斐波那契回撤强烈压制；未见合规五浪前只按反弹对待。`;
      } else {
        liuDeduction = `前序为震荡下行调整。当前选区若出现向上发力，存在调整结束并孕育反转驱动浪的契机。`;
        cautions = `关注前序低点 $${fmtNum(swingLow.price)} 是否形成双底或头肩底支撑防线。`;
      }
    } else if (dominantTrend === 'BULLISH') {
      favoredWaveTypes = ['IMPULSE', 'FLAT', 'TRIANGLE', 'ZIGZAG'];
      if (character === 'IMPULSE_UP') {
        liuDeduction = `前序为大级别顺势上涨主升（区间涨幅 +${netChangePct.toFixed(1)}%，波谷 $${fmtNum(swingLow.price)}）。柳玉冬体系强调：“顺势而为，前序驱动定性后，次级波段绝大概率属于良性洗盘”。若当前选区为回落或横向整理，首选定性为第4浪或高位ABC调整；一旦选区内出现止跌信号，后市极易迎来爆发性冲顶或第5浪延续。`;
        cautions = `只要价格不有效击穿前序关键起涨点 $${fmtNum(swingLow.price)}，多头大格局未遭破坏。`;
      } else {
        liuDeduction = `前序为震荡攀升阶段，多头动能有所放缓，当前选区需警惕顶部收敛或衰竭楔形。`;
        cautions = `注意防范多头衰竭，关注量价背离与浪5不创新高的失败形态。`;
      }
    } else {
      favoredWaveTypes = ['COMBINATION', 'FLAT', 'TRIANGLE'];
      liuDeduction = `前序行情处于箱型横向密集整理（震荡振幅 ${amplitudePct.toFixed(1)}%）。依据手稿P50-52联合形指引，当前浪型以箱型震荡对待，重点防范上下假突破，等待有效突破箱体确立单边波浪方向。`;
      cautions = `箱体上轨 $${fmtNum(swingHigh.price)} 与下轨 $${fmtNum(swingLow.price)} 为核心多空分水岭。`;
    }

    return {
      hasPrecedingData: true,
      precedingBarsCount: precBars.length,
      precedingTimeRange: { start: precBars[0].time, end: precBars[precBars.length - 1].time },
      dominantTrend,
      character,
      netChangePct: Math.round(netChangePct * 100) / 100,
      amplitudePct: Math.round(amplitudePct * 100) / 100,
      swingHigh,
      swingLow,
      liuDeduction,
      favoredWaveTypes,
      cautions,
      keyResistance: swingHigh.price,
      keySupport: swingLow.price
    };
  }

  function scoreCandidate(cand, evalRes, sliceLen, rangeExtrema, precedingContext) {
    const guideScore = evalRes.guide.weight ? evalRes.guide.weightGot / evalRes.guide.weight : 0.5;
    let s = 45 + 50 * guideScore + 8 * Math.min(1, cand.span / sliceLen * 1.6);
    s -= 2.5 * evalRes.pending.length;
    if (cand.status === 'COMPLETED') s += 2;

    // 1. 选区极值磁吸锚定加分 (消除人工选区边界误差)
    if (rangeExtrema && cand.pivots && cand.pivots.length > 0) {
      const p0 = cand.pivots[0];
      const isBull = cand.direction === 'BULLISH';
      // 多头首选起点锚定最低谷底，空头首选起点锚定最高峰顶
      const targetExtremePrice = isBull ? rangeExtrema.minPrice : rangeExtrema.maxPrice;
      const targetExtremeTime = isBull ? rangeExtrema.minTime : rangeExtrema.maxTime;
      const targetExtremeIdx = isBull ? rangeExtrema.minIdx : rangeExtrema.maxIdx;

      const isExactMatch = (p0.time === targetExtremeTime) || (Math.abs(p0.price - targetExtremePrice) <= EPS);
      const isNearMatch = !isExactMatch && Math.abs((p0.idx || 0) - targetExtremeIdx) <= 2;

      if (isExactMatch) {
        s += 10;
        cand.snappedToExtreme = true;
        cand.extremeAnchor = isBull ? 'MIN_TROUGH' : 'MAX_PEAK';
      } else if (isNearMatch) {
        s += 5;
        cand.snappedToExtreme = true;
        cand.extremeAnchor = 'NEAR_EXTREME';
      }
    }

    // 2. 前序浪型脉络与大级别背景契合度加分 (承前启后·柳玉冬实战)
    if (precedingContext && precedingContext.hasPrecedingData) {
      const candMotive = cand.baseType === 'IMPULSE' || cand.baseType === 'DIAGONAL';
      const candBull = cand.direction === 'BULLISH';

      if (precedingContext.dominantTrend === 'BEARISH') {
        if (!candMotive && candBull) {
          // 前序大跌后向上反弹：次级调整浪(反弹B浪/X浪)高度契合柳玉冬手稿逻辑
          s += 6;
          cand.contextAffinity = 'BEARISH_REBOUND_CORRECTIVE';
        } else if (candMotive && candBull) {
          // 前序大跌后直接反转推动：适度加分
          s += 2;
          cand.contextAffinity = 'BEARISH_REVERSAL_IMPULSE';
        }
      } else if (precedingContext.dominantTrend === 'BULLISH') {
        if (candMotive && candBull) {
          // 前序大涨后顺势驱动延续：强趋势顺应加分
          s += 6;
          cand.contextAffinity = 'BULLISH_TREND_CONTINUATION';
        } else if (!candMotive && !candBull) {
          // 前序大涨后次回调：良性调整形态加分
          s += 5;
          cand.contextAffinity = 'BULLISH_PULLBACK_CORRECTIVE';
        }
      } else if (precedingContext.dominantTrend === 'NEUTRAL') {
        if (!candMotive) {
          // 震荡背景下调整浪优先
          s += 4;
          cand.contextAffinity = 'BOX_CONSOLIDATION_FIT';
        }
      }
    }

    cand.rawScore = s;
    cand.coveragePct = Math.min(100, Math.round((cand.span / (sliceLen || 1)) * 100));
    cand.degreeLabel = cand.coveragePct >= 60 ? '宏观主浪' : (cand.coveragePct >= 35 ? '中波段' : '末段次浪');

    return Math.max(1, Math.min(99, Math.round(s)));
  }

  // ---------------------------------------------------------------------------
  // 8. 出身判定 / 情景 / 解读
  // ---------------------------------------------------------------------------

  function analyzeOrigin(cand, ev) {
    if (!cand || !cand.pivots || cand.pivots.length < 2) return null;
    const g = mkGeom(cand.pivots);
    const st = ev && ev.bars ? legStructure(g, 0, ev) : { label: 'unknown' };
    const dirTxt = g.d > 0 ? '上升' : '下跌';
    const map = {
      '5': { originType: 'IMPULSE_5W', score: 20, text: `首段（${dirTxt}一浪）低级别可数出合规五浪——“有推动浪才有做底/做顶的可能”，出身合格。` },
      '3': { originType: 'CORRECTIVE_3W', score: -10, text: `首段（${dirTxt}一浪）低级别只能数出非五浪——按柳玉冬体系，没有推动浪或引导楔形就没有做底/做顶的可能，仅按反弹/回调对待。` },
      'unknown': { originType: 'UNKNOWN', score: 0, text: `首段（${dirTxt}一浪）内部小级别数据不足，出身待确认——不因数据缺失而默认它是推动浪。` }
    };
    return Object.assign({ structure: st.label, source: st.source || null, isImpulse: st.label === '5' }, map[st.label]);
  }

  function buildScenarios(cands) {
    const top = cands.slice(0, 3);
    return top.map((c, i) => ({
      rank: i + 1,
      name: c.name,
      probability: c.probability || 0,
      weightNote: '相对权重（按手稿指引符合度折算，非统计概率）',
      rationale: `硬规则全部通过${c.pendingCount ? `（${c.pendingCount}条待确认）` : ''}；指引符合度 ${c.guidePct}%；状态：${c.currentWave}`,
      confirmTrigger: (c.secondaryPivot && c.secondaryPivot.price) || (c.targets[0] && c.targets[0].price) || null,
      invalidationLevel: c.monitoringPivot ? c.monitoringPivot.price : null
    }));
  }

  const MTF_MAP = {
    '15m': { htf1: '1h', htf2: '4h', label: '15m (15分钟)' },
    '30m': { htf1: '2h', htf2: '4h', label: '30m (30分钟)' },
    '1h':  { htf1: '4h', htf2: '1d', label: '1H (1小时)' },
    '2h':  { htf1: '6h', htf2: '1d', label: '2H (2小时)' },
    '4h':  { htf1: '1d', htf2: '1w', label: '4H (4小时)' },
    '6h':  { htf1: '1d', htf2: '1w', label: '6H (6小时)' },
    '12h': { htf1: '1d', htf2: '1w', label: '12H (12小时)' },
    '1d':  { htf1: '1w', htf2: '1M', label: '1D (日线)' }
  };

  function analyzeHTFTrend(bars) {
    if (!bars || bars.length < 10) return { trend: 'NEUTRAL', phase: 'unknown', confidence: 0.3, label: '数据平缓' };
    const len = bars.length;
    const p0 = bars[0].close, pLast = bars[len - 1].close;
    const highs = bars.map(b => b.high), lows = bars.map(b => b.low);
    const win = Math.min(25, Math.floor(len / 3));
    const recentHigh = Math.max(...highs.slice(-win));
    const recentLow = Math.min(...lows.slice(-win));
    const prevHigh = Math.max(...highs.slice(-win * 2, -win));
    const prevLow = Math.min(...lows.slice(-win * 2, -win));

    let isBull = recentHigh > prevHigh && recentLow > prevLow;
    let isBear = recentHigh < prevHigh && recentLow < prevLow;

    if (!isBull && !isBear) {
      isBull = pLast >= p0;
      isBear = pLast < p0;
    }

    const netChangePct = (pLast - p0) / (p0 || 1);
    const isMotive = Math.abs(netChangePct) > 0.03;

    return {
      trend: isBull ? 'BULLISH' : 'BEARISH',
      phase: isMotive ? 'motive' : 'corrective',
      confidence: Math.min(0.95, 0.45 + Math.abs(netChangePct) * 2),
      label: isBull ? (isMotive ? '多头主升驱动' : '多头高位整理') : (isMotive ? '空头主跌驱动' : '超跌反弹整理')
    };
  }

  function analyzeMTF(mainCand, timeframe, htfBarsMap, currentBars) {
    const mtfConfig = MTF_MAP[timeframe] || { htf1: '1d', htf2: '1w', label: `${timeframe}` };
    htfBarsMap = htfBarsMap || {};
    const htf1Bars = htfBarsMap[mtfConfig.htf1] || null;
    const htf2Bars = htfBarsMap[mtfConfig.htf2] || null;

    const h1 = analyzeHTFTrend(htf1Bars || currentBars);
    const h2 = htf2Bars ? analyzeHTFTrend(htf2Bars) : h1;

    let alignment = 'NEUTRAL';
    let alignmentScore = 0.5;
    let alignmentText = '多周期结构中性';

    if (!mainCand) {
      return {
        enabled: true,
        currentTf: timeframe,
        htf1: { tf: mtfConfig.htf1, label: `${mtfConfig.htf1.toUpperCase()} (${h1.label})`, trend: h1.trend, phase: h1.phase },
        htf2: { tf: mtfConfig.htf2, label: `${mtfConfig.htf2.toUpperCase()} (${h2.label})`, trend: h2.trend, phase: h2.phase },
        alignment: 'NEUTRAL',
        alignmentScore: 0.5,
        alignmentLabel: '待定',
        alignmentText: '等待合规形态确立',
        forecast: { nextWave: '—', scenario: '等待形态确认', action: 'WAIT', grade: 1, stars: '★☆☆☆☆' }
      };
    }

    const candBull = mainCand.direction === 'BULLISH';
    const isMotive = mainCand.baseType === 'IMPULSE' || mainCand.baseType === 'DIAGONAL';

    if (isMotive) {
      if ((candBull && h1.trend === 'BULLISH') || (!candBull && h1.trend === 'BEARISH')) {
        alignment = 'ALIGNED';
        alignmentScore = 0.85;
        alignmentText = `高低周期共振顺势：当前 ${timeframe.toUpperCase()} 驱动浪与 ${mtfConfig.htf1.toUpperCase()} 大趋势同向，顺势推进可靠度高。`;
      } else {
        alignment = 'CONFLICTING';
        alignmentScore = -0.35;
        alignmentText = `逆大级别趋势：当前 ${timeframe.toUpperCase()} 试图形成逆向驱动，但受 ${mtfConfig.htf1.toUpperCase()} 大级别压制，谨防诱多/诱空。`;
      }
    } else {
      if (h1.trend === 'BULLISH' && !candBull) {
        alignment = 'PARTIAL';
        alignmentScore = 0.65;
        alignmentText = `牛市良性回撤：大趋势看涨背景下的次级调整，手稿P34明示“回撤不改大趋势”，关注调整到位做底。`;
      } else if (h1.trend === 'BEARISH' && candBull) {
        alignment = 'PARTIAL';
        alignmentScore = 0.40;
        alignmentText = `熊市超跌反弹：大级别偏空背景下的次级反弹，手稿P213明示“反弹性质清楚，过不去监测点仍将下行”。`;
      } else {
        alignment = 'NEUTRAL';
        alignmentScore = 0.50;
        alignmentText = `箱型横向整理：高低周期处于中继震荡，维持箱型外观（手稿P50），上下轨之间高抛低吸。`;
      }
    }

    // 构建 Forecast
    let nextWave = '—';
    let action = 'WAIT';
    let targetHigh = null, targetLow = null;

    if (mainCand.targets && mainCand.targets.length > 0) {
      targetHigh = Math.max(...mainCand.targets.map(t => t.price));
      targetLow = Math.min(...mainCand.targets.map(t => t.price));
    }
    const stopLevel = mainCand.monitoringPivot ? mainCand.monitoringPivot.price : null;

    if (isMotive) {
      if (mainCand.status === 'COMPLETED') {
        nextWave = candBull ? '同级别 ABC 调整浪回撤' : '同级别 ABC 反弹浪展开';
        action = candBull ? 'TAKE PROFIT (减仓止盈)' : 'COVER SHORT (空头平仓)';
      } else if (mainCand.currentWave && mainCand.currentWave.includes('3浪')) {
        nextWave = '4浪次级回撤（常规 0.236~0.382）';
        action = candBull ? 'BUY ZONE (持多待冲刺)' : 'SELL ZONE (顺势做空)';
      } else if (mainCand.currentWave && mainCand.currentWave.includes('4浪')) {
        nextWave = '5浪终结冲顶（目标超越浪3）';
        action = candBull ? 'BUY ZONE (逢低布局5浪)' : 'SELL ZONE (逢高做空)';
      } else {
        nextWave = '延续驱动推进';
        action = candBull ? 'BUY ZONE (逢低做多)' : 'SELL ZONE (逢高做空)';
      }
    } else {
      if (mainCand.status === 'COMPLETED') {
        nextWave = candBull ? '调整结束·恢复原上升主升' : '反弹结束·恢复原下跌主跌';
        action = candBull ? 'BUY ZONE (做底完成)' : 'SELL ZONE (反弹见顶)';
      } else if (mainCand.currentWave && mainCand.currentWave.includes('b浪')) {
        nextWave = 'c浪展开（最低要求 0.9×b浪）';
        action = candBull ? 'WAIT (等待c浪低点)' : 'WAIT (等待c浪高点)';
      } else {
        nextWave = '调整浪末段演化中';
        action = 'WAIT (观望等待)';
      }
    }

    const starsNum = Math.max(1, Math.min(5, Math.round((mainCand.score || 70) / 20)));
    const stars = '★'.repeat(starsNum) + '☆'.repeat(5 - starsNum);

    return {
      enabled: true,
      currentTf: timeframe,
      htf1: { tf: mtfConfig.htf1, label: `${mtfConfig.htf1.toUpperCase()} (${h1.label})`, trend: h1.trend, phase: h1.phase },
      htf2: { tf: mtfConfig.htf2, label: `${mtfConfig.htf2.toUpperCase()} (${h2.label})`, trend: h2.trend, phase: h2.phase },
      alignment,
      alignmentScore,
      alignmentLabel: alignment === 'ALIGNED' ? '共振顺势' : alignment === 'PARTIAL' ? '局部中继' : alignment === 'CONFLICTING' ? '逆势冲突' : '中性震荡',
      alignmentText,
      forecast: {
        nextWave,
        scenario: `${mainCand.name} · ${alignmentText}`,
        action,
        targetHigh,
        targetLow,
        stopLevel,
        grade: starsNum,
        stars
      }
    };
  }

  function generateLiuCommentary(pattern, currentPrice, symbol, timeframe, analysis) {
    const tf = (timeframe || '4h').toUpperCase();
    const quote = '「愚昧无法战胜科学，波浪理论是科学。有推动浪才有做底的可能，没有推动浪或引导楔形就完全没有可能做底。」—— 柳玉冬波浪理论实战体系';
    if (!pattern) {
      return {
        title: `${symbol} ${tf} 波浪理论研判`,
        thesis: '当前选区内没有任何浪型假设能通过手稿硬规则的全部检验（详见阻碍诊断）。按否定法原则，此时不强行数浪。',
        bottomTopSignal: `现价 ${fmtNum(currentPrice)}：暂无合规数浪给出的监测点，等待结构成熟。`,
        quote
      };
    }
    const motive = pattern.baseType === 'IMPULSE' || pattern.baseType === 'DIAGONAL' ||
      (pattern.type || '').indexOf('IMPULSE') === 0 || (pattern.type || '').indexOf('DIAGONAL') === 0;
    let ruleTxt;
    if (motive) {
      const fails = (pattern.ruleChecks || []).filter(c => c.hard && !c.pass && !c.pending);
      ruleTxt = fails.length === 0
        ? '三大铁律检验全部通过（浪2未越浪1起点、浪3非最短、浪4未切入浪1价格区）。'
        : `注意：存在未通过的硬规则——${fails.map(f => f.text).join('；')}`;
    } else {
      const hard = (pattern.ruleChecks || []).filter(c => c.hard);
      const passed = hard.filter(c => c.pass).length;
      ruleTxt = `该形态 ${hard.length} 条手稿硬性规则全部通过；指引符合度 ${pattern.guidePct || '--'}%。`;
    }
    const pendingTxt = pattern.pendingCount ? `另有 ${pattern.pendingCount} 条最低要求因末浪未确认而待验证。` : '';
    const mtfTxt = analysis?.mtf ? `【MTF大势联动: ${analysis.mtf.alignmentLabel} (${analysis.mtf.htf1.label})】` : '';

    // 智能极值与前序脉络实战解析 (消除手动选区偏差，承前启后)
    let extremaTxt = '';
    if (analysis?.rangeExtrema) {
      const ext = analysis.rangeExtrema;
      const snapTxt = pattern.snappedToExtreme ? '已自动磁吸锚定至波段结构极值点' : '锚定于选区主拐点';
      extremaTxt = `【极值磁吸】选区波谷 $${fmtNum(ext.minPrice)} / 波峰 $${fmtNum(ext.maxPrice)}，${snapTxt}，有效过滤手动划选误差。`;
    }
    let contextTxt = '';
    if (analysis?.precedingContext?.hasPrecedingData) {
      const ctx = analysis.precedingContext;
      contextTxt = `【承前启后·大级别脉络】前序呈${ctx.dominantTrend === 'BEARISH' ? '顺势下跌' : ctx.dominantTrend === 'BULLISH' ? '顺势上涨' : '箱型震荡'}（振幅 ${ctx.amplitudePct}%）。${ctx.liuDeduction} `;
    }

    const thesis = `${symbol} ${tf}：首选计数为「${pattern.name}」。${mtfTxt}${extremaTxt}${contextTxt}${ruleTxt}${pendingTxt}`;

    let bottomTopSignal;
    if (pattern.monitoringPivot) {
      const mp = pattern.monitoringPivot;
      const side = pattern.direction === 'BEARISH' ? '上破' : '跌破';
      bottomTopSignal = `监测点 $${fmtNum(mp.price)}（${mp.levelName}）：${side}则${mp.description || '当前计数失效'}。现价 ${fmtNum(currentPrice)}。`;
    } else {
      bottomTopSignal = `现价 ${fmtNum(currentPrice)}：该形态暂无明确监测点。`;
    }
    return { title: `${symbol} ${tf} 波浪理论研判`, thesis, bottomTopSignal, quote };
  }

  // ---------------------------------------------------------------------------
  // 8.5 对偶情境 (跨级别推演): 以首选计数起点O与方向极值X为锚，
  //     推演「新趋势起点(A)」与「逆势反弹(B)」两种解释并给出仲裁价位
  // ---------------------------------------------------------------------------

  /** 按 R=Slen/D (当前段/前段腿) 给出逆势反弹可容纳的调整浪角色 */
  function counterRolesForR(R) {
    if (R === null || R === undefined || isNaN(R)) return [];
    if (R < 0.2 || R >= 2) return [];
    if (R < 0.7) return [
      { role: '单锯齿b浪', rules: 'Z1/Z2' },
      { role: '双锯齿x浪', rules: 'W1/W2' }
    ];
    if (R < 1) return [
      { role: '单锯齿b浪', rules: 'Z1/Z2' },
      { role: '双锯齿x浪', rules: 'W1/W2' },
      { role: '平台形b浪', rules: 'F1' },
      { role: '联合形x浪', rules: 'C1' }
    ];
    if (R < 1.5) return [
      { role: '扩散平台形b浪', rules: 'F1/F2' },
      { role: '联合形x浪', rules: 'C1/C2' }
    ];
    return [{ role: '扩散平台形b浪', rules: 'F2' }];
  }

  function buildDualScenario(ctx) {
    const { cands, top, slice } = ctx || {};
    if (!top || !top.pivots || !top.pivots.length || !slice || !slice.length) return null;
    const d = top.direction === 'BULLISH' ? 1 : -1;
    const O = top.pivots[0];

    // X: 方向极值 (d=1 取最高 high；d=-1 取最低 low)
    let X = null;
    for (let i = O.idx; i < slice.length; i++) {
      const v = d > 0 ? slice[i].high : slice[i].low;
      if (!X || v * d > X.price * d) X = { price: v, time: slice[i].time, idx: i };
    }
    const Slen = Math.abs(X.price - O.price);
    if (!(Slen > 0)) return null;

    // 前段腿: 自O左邻向左扫描最后一根逆向越过O价位的K线，其右至O为前段腿区间
    let k = -1;
    for (let i = O.idx - 1; i >= 0; i--) {
      const beyond = d > 0 ? slice[i].low < O.price : slice[i].high > O.price;
      if (beyond) { k = i; break; }
    }
    const priorTruncated = k < 0;
    const segS = priorTruncated ? 0 : k + 1;
    const segE = O.idx - 1;

    let prior = null, H0 = null, D = null, R = null;
    if (segE >= segS) {
      for (let i = segS; i <= segE; i++) {
        const v = d > 0 ? slice[i].high : slice[i].low;
        if (!H0 || v * d > H0.price * d) H0 = { price: v, time: slice[i].time, idx: i };
      }
      if (H0) {
        prior = { H0 };
        D = Math.abs(H0.price - O.price);
        R = Slen / D;
      }
    }

    const motiveExists = (cands || []).some(c =>
      (c.baseType === 'IMPULSE' || c.baseType === 'DIAGONAL') &&
      c.direction === top.direction && c.pivots[0] && c.pivots[0].time === O.time);

    // 情境A: 新趋势起点
    const w2a = X.price - d * 0.618 * Slen, w2b = X.price - d * 0.382 * Slen;
    const scenA = {
      label: d > 0 ? '新一轮上升的第1浪（3-1浪）' : '新一轮下跌的第1浪',
      allowed: motiveExists,
      reason: motiveExists
        ? '以O为起点存在合规推动浪/楔形计数（有推动浪才有做底/做顶的可能）'
        : '以O为起点不存在合规推动浪计数——出身不合法，没有推动浪就没有做底/做顶的可能',
      expect: {
        wave2Zone: { lo: Math.min(w2a, w2b), hi: Math.max(w2a, w2b) },
        wave3Must: X.price,
        note: '浪2常见回撤0.382~0.618(G1)且不得触及O(M1)；浪3须越过S极值(M3)，常见为S的1~2.618倍(G3)'
      },
      invalidation: { price: O.price, rule: 'M1', text: `触及/${d > 0 ? '跌破' : '涨破'}O则浪2回撤达100%，情境A失效` },
      confirmation: { price: X.price, text: '浪2守住后越过S极值，确认浪3展开' }
    };

    // 情境B: 逆势反弹/回调
    const roles = counterRolesForR(R);
    const allowedB = !!prior && roles.length > 0;
    let bReason;
    if (!prior) {
      bReason = 'O之前无可用前段腿，无法衡量逆势反弹的级别';
    } else if (!roles.length) {
      bReason = R < 0.2
        ? `R=${R.toFixed(2)}<0.2：反弹段相对前段腿过短，不足本级调整浪讨论的级别`
        : `R=${R.toFixed(2)}≥2：反弹段已超平台形b浪上限(F2)，逆势反弹解释不成立`;
    } else {
      bReason = `R=${R.toFixed(2)}，可解释为：${roles.map(r => `${r.role}(${r.rules})`).join('、')}`;
    }
    const ceilings = prior ? [
      { price: H0.price, dies: '锯齿/双锯齿解释（Z2/W2）' },
      { price: O.price + d * 1.5 * D, dies: '联合形x解释（C2）' },
      { price: O.price + d * 2 * D, dies: '平台形b解释（F2），情境B整体' }
    ] : [];
    const uncrossed = ceilings
      .filter(c => (X.price - c.price) * d < 0)
      .sort((a, b) => ((a.price - X.price) * d) - ((b.price - X.price) * d));
    const scenB = {
      label: d > 0 ? '上一级别下跌中的反弹（b/x浪）' : '上一级别上涨中的回调（b/x浪）',
      allowed: allowedB,
      roles,
      reason: bReason,
      expect: {
        nextLegMin: X.price - d * 0.9 * Slen,
        dzYMin: prior ? X.price - d * 0.9 * D : null,
        note: 'c浪最低要求0.9×b(Z3)；双锯齿y浪须大于0.9×w(W4)'
      },
      invalidation: uncrossed.length
        ? { price: uncrossed[0].price, text: `${d > 0 ? '升破' : '跌破'}${fmtNum(uncrossed[0].price)}则${uncrossed[0].dies}被否决` }
        : null,
      confirmation: { price: O.price, text: `${d > 0 ? '跌破' : '涨破'}O确认${d > 0 ? '反弹' : '回调'}结束，c/y浪展开` }
    };

    // 仲裁价位
    const arb = [
      { price: O.price, effect: '否决情境A（M1）；确认情境B', rule: 'M1', soft: false, crossed: false },
      { price: X.price - d * 0.618 * Slen, effect: '情境A存疑（浪2回撤过深，G1/G2）', rule: 'G1/G2', soft: true, crossed: false }
    ];
    if (prior) {
      arb.push(
        { price: H0.price, effect: '否决情境B的锯齿/双锯齿解释（Z2/W2）', rule: 'Z2/W2', soft: false, crossed: (X.price - H0.price) * d >= 0 },
        { price: O.price + d * 1.5 * D, effect: '否决联合形x解释（C2）', rule: 'C2', soft: false, crossed: (X.price - (O.price + d * 1.5 * D)) * d >= 0 },
        { price: O.price + d * 2 * D, effect: '否决平台形b解释，情境B不成立（F2）', rule: 'F2', soft: false, crossed: (X.price - (O.price + d * 2 * D)) * d >= 0 }
      );
    }
    arb.sort((a, b) => a.price - b.price);

    const stance = scenA.allowed && scenB.allowed ? 'BOTH'
      : scenA.allowed ? 'A_ONLY' : scenB.allowed ? 'B_ONLY' : 'NEITHER';

    let lean = null;
    if (stance === 'A_ONLY') lean = { A: 100, B: 0, validated: 'rule', text: '仅情境A成立' };
    else if (stance === 'B_ONLY') lean = { A: 0, B: 100, validated: 'rule', text: '仅情境B成立' };
    else if (stance === 'BOTH') lean = { A: null, B: null, validated: 'rule', text: '两可，由分水岭裁决' };

    const dirVerb = d > 0 ? '跌破' : '涨破';
    let summary;
    if (stance === 'BOTH') {
      const parts = [`${dirVerb}O(${fmtNum(O.price)})否决情境A（M1）、确认情境B`];
      if (scenB.invalidation) parts.push(scenB.invalidation.text);
      summary = `两种情境并存：${parts.join('；')}`;
    } else if (stance === 'A_ONLY') {
      summary = `以新趋势情境为主：${dirVerb}O(${fmtNum(O.price)})即否决情境A（M1铁律）`;
    } else if (stance === 'B_ONLY') {
      const bTxt = scenB.invalidation ? `；${scenB.invalidation.text}` : '';
      summary = `以逆势${d > 0 ? '反弹' : '回调'}情境为主：${dirVerb}O(${fmtNum(O.price)})确认结束${bTxt}`;
    } else {
      summary = '两种情境均不成立：O点出身不合法且逆势反弹级别不符';
    }

    return {
      direction: top.direction,
      anchors: {
        O: { price: O.price, time: O.time },
        X: { price: X.price, time: X.time },
        H0: prior ? { price: H0.price, time: H0.time } : null,
        priorTruncated
      },
      Slen, D, R,
      motiveExists,
      scenarios: { A: scenA, B: scenB },
      arbitration: arb,
      stance, lean, summary
    };
  }

  // ---------------------------------------------------------------------------
  // 9. 主入口
  // ---------------------------------------------------------------------------

  function analyzeWaves(bars, symbol, options) {
    options = options || {};
    if (!bars || bars.length < 10) {
      throw new Error('K线数据不足，无法进行波浪理论数浪研判');
    }
    const ranking = Object.assign({}, RANKING, options.ranking || {});
    const timeframe = options.timeframe || '4h';
    let slice = bars;
    let userSel = null;
    let rangeExtrema = null;
    let precedingContext = null;
    let selMargin = 0;

    if (options.startTime || options.endTime) {
      let iS = 0, iE = bars.length - 1;
      if (options.startTime) {
        iS = bars.findIndex(b => b.time >= options.startTime);
        if (iS < 0) iS = bars.length;
      }
      if (options.endTime) {
        while (iE >= 0 && bars[iE].time > options.endTime) iE--;
      }
      const selLen = iE - iS + 1;
      if (selLen < 10) {
        throw new Error(`选区过短（仅 ${Math.max(0, selLen)} 根K线），请框选至少 10 根 K 线的区间`);
      }
      // 1. 自动探测选区范围内部全局真实极值并建立磁吸锚点
      rangeExtrema = identifyRangeExtrema(bars, iS, iE);

      // 2. 结合同级别与更大级别前序浪型脉络（观当下必先审前身）
      precedingContext = analyzePrecedingContext(bars, iS, null, timeframe, options.htfBars);

      // 选区是「观察窗口」而非浪的边界：向左扩展上下文，
      // 使浪型起点允许早于选区、终点仍锚定选区右缘
      selMargin = Math.min(300, Math.max(30, Math.round(selLen * 0.5)));
      const extStart = Math.max(0, iS - selMargin);
      userSel = {
        startTime: bars[iS].time, endTime: bars[iE].time,
        barsCount: selLen, contextBars: iS - extStart,
        contextShortfall: (iS - extStart) < selMargin,
        rangeExtrema
      };
      slice = bars.slice(extStart, iE + 1);
    } else {
      rangeExtrema = identifyRangeExtrema(bars, 0, bars.length - 1);
      precedingContext = analyzePrecedingContext(bars, Math.floor(bars.length * 0.5), null, timeframe, options.htfBars);
    }
    if (slice.length < 10) {
      throw new Error(`K线数据不足（仅 ${slice.length} 根），无法进行波浪理论数浪研判`);
    }

    const degrees = buildPivotDegrees(slice);
    const highs = slice.map(b => b.high), lows = slice.map(b => b.low);
    const currentPrice = slice[slice.length - 1].close;

    const sources = [{ name: timeframe, tfSec: TF_SEC[timeframe] || 14400, bars: slice, isMain: true }];
    const subBars = options.subBars || {};
    const subMap = Object.assign({}, subBars);
    if (options.bars_1h && !subMap['1h']) subMap['1h'] = options.bars_1h;
    if (options.bars_15m && !subMap['15m']) subMap['15m'] = options.bars_15m;
    for (const tf of Object.keys(subMap)) {
      const arr = subMap[tf];
      if (Array.isArray(arr) && arr.length >= 8) sources.push({ name: tf, tfSec: TF_SEC[tf] || 3600, bars: arr });
    }
    sources.sort((a, b) => a.tfSec - b.tfSec);

    const result = {
      symbol, timeframe, engineVersion: VERSION,
      barsCount: slice.length, currentPrice,
      analysisTime: new Date().toISOString(),
      selectedRange: userSel || {
        startTime: slice[0].time, endTime: slice[slice.length - 1].time,
        barsCount: slice.length, contextBars: 0, contextShortfall: false,
        rangeExtrema
      },
      rangeExtrema,
      precedingContext,
      pivotDegrees: degrees.levels.map(l => ({ atrMult: l.mult, threshold: Math.round(l.thr * 100) / 100, pivotCount: l.count, isMain: l === degrees.main })),
      allPivots: degrees.main ? degrees.main.pivots : [],
      candidates: [], blockers: [], scenarios: [],
      pattern: null, originAnalysis: null, commentary: null,
      decisiveness: { level: 'NONE', topShare: 0, shown: 0, text: '无合规浪型' },
      dualScenario: null,
      mtf: null, forecast: null,
      rulebookNote: '规则依据手稿P1-378（驱动浪基础/比率/单锯齿/平台形/收缩三角形/双三锯齿/联合形散见条文P50-52、P131-132、P158、P272-301）。艾略特通道仅作为辅助画线与视觉投影参考，不作为制定或裁决波浪的标准。楔形专章缺失，已按主流艾略特条则补齐并标注「通用」。'
    };

    if (userSel && userSel.contextShortfall) {
      result.blockers.push(`选区靠近已加载数据左端，前序上下文仅 ${userSel.contextBars} 根（期望 ${selMargin} 根），起点判断可信度降低`);
    }

    const main = degrees.main;
    if (!main || main.pivots.length < 4) {
      result.dualScenario = null;
      result.blockers.push('自适应 Zigzag 未提取到足够的有效拐点，无法匹配任何手稿浪型');
      result.mtf = analyzeMTF(null, timeframe, options.htfBars, slice);
      result.forecast = result.mtf.forecast;
      result.commentary = generateLiuCommentary(null, currentPrice, symbol, timeframe, result);
      return result;
    }

    const ev = { bars: slice, highs, lows, sources, structCache: new Map() };
    const legOk = buildLegTable(main.pivots);
    const blockMap = new Map();

    const hyps = [];
    for (const type of Object.keys(PATTERNS)) {
      hyps.push.apply(hyps, searchPattern(type, main.pivots, legOk, ev, blockMap));
    }

    const seen = new Set();
    let cands = [];
    for (const h of hyps) {
      const key = h.type + '|' + h.idxs.join('-');
      if (seen.has(key)) continue;
      seen.add(key);
      const pts = h.idxs.map(i => main.pivots[i]);
      const evalRes = evaluatePattern(h.type, pts, ev);
      if (evalRes.hardFails.length) {
        const f = evalRes.hardFails[0];
        const key2 = h.type + '|' + f.id;
        if (!blockMap.has(key2)) blockMap.set(key2, { pattern: PATTERNS[h.type].name, rule: f, detail: f.detail, span: h.idxs[h.idxs.length - 1] - h.idxs[0] });
        continue;
      }
      const cand = buildCandidate(h, evalRes, ev, main.pivots);
      cand.score = scoreCandidate(cand, evalRes, slice.length, rangeExtrema, precedingContext);
      cands.push(cand);
    }

    const candCmp = (a, b) => {
      // 1. rawScore 优先 (未封顶的指引加成与背景契合分；显示分已封顶不作排序键)
      if (Math.abs((b.rawScore || 0) - (a.rawScore || 0)) > EPS) return (b.rawScore || 0) - (a.rawScore || 0);
      // 2. 磁吸在真实极值锚点者绝对优先 (真底胜过假底)
      if (!!b.snappedToExtreme !== !!a.snappedToExtreme) return b.snappedToExtreme ? 1 : -1;
      // 3. 顺应选区主导方向者优先 (例如多头主导下上升推动优先)
      if (rangeExtrema && rangeExtrema.dominantDirection) {
        const bDirMatch = b.direction === rangeExtrema.dominantDirection;
        const aDirMatch = a.direction === rangeExtrema.dominantDirection;
        if (bDirMatch !== aDirMatch) return bDirMatch ? 1 : -1;
      }
      // 4. 跨度覆盖
      return b.span - a.span;
    };
    cands.sort(candCmp);

    // 指纹去重: 同名形态且首尾端点一致的孪生形态进行合并，避免挤占并列候选席位
    const seenSignatures = new Set();
    const deduped = [];
    for (const c of cands) {
      const p0Time = c.pivots[0]?.time;
      const pEndTime = c.pivots[c.pivots.length - 1]?.time;
      const sig = `${c.name}|${p0Time}|${pEndTime}`;
      if (seenSignatures.has(sig)) continue;
      seenSignatures.add(sig);
      deduped.push(c);
    }

    // 相对权重: 以首选为锚按温度指数缩放 (softmax 相对权重，非统计概率)
    const topRaw = deduped.length ? (deduped[0].rawScore || 0) : 0;
    for (const c of deduped) {
      c.relWeight = Math.exp(((c.rawScore || 0) - topRaw) / ranking.temperature);
    }
    const eligible = deduped.filter(c => c.relWeight >= ranking.minRel);

    // 席位分配: 仅在权重达标候选上按「浪型×浪位数」两轮选取 ——
    // 首轮每个键一席保证计数多样性，次轮同键至多两席，总数不超过 maxCands
    const seatKey = c => `${c.baseType}|${c.pivots.length}`;
    const keyCount = {};
    const taken = new Set();
    const final = [];
    const take = c => {
      keyCount[seatKey(c)] = (keyCount[seatKey(c)] || 0) + 1;
      taken.add(c);
      final.push(c);
    };
    for (const c of eligible) {
      if (final.length >= ranking.maxCands) break;
      if (keyCount[seatKey(c)]) continue;
      take(c);
    }
    for (const c of eligible) {
      if (final.length >= ranking.maxCands) break;
      if (taken.has(c) || (keyCount[seatKey(c)] || 0) >= 2) continue;
      take(c);
    }
    // 保底: 达标候选不足时以排序顺序补足 minCands
    for (const c of deduped) {
      if (final.length >= ranking.minCands) break;
      if (taken.has(c)) continue;
      take(c);
    }
    final.sort(candCmp);
    result.candidates = final;
    result.pattern = final[0] || null;

    // 相对概率与决断度
    const relSum = final.reduce((s, c) => s + c.relWeight, 0) || 1;
    for (const c of final) c.probability = Math.round(100 * c.relWeight / relSum);
    if (final.length) {
      const topShare = (final[0].probability || 0) / 100;
      const shown = final.length;
      const level = (shown === 1 || topShare >= 0.6) ? 'HIGH' : (topShare < 0.35 ? 'LOW' : 'MEDIUM');
      const lvlTxt = level === 'HIGH' ? '高' : level === 'LOW' ? '低' : '中';
      result.decisiveness = {
        level, topShare, shown,
        text: `决断度${lvlTxt}：主方案占相对权重 ${final[0].probability}%，共 ${shown} 个方案`
      };
    }

    result.blockers.push.apply(result.blockers, Array.from(blockMap.values())
      .sort((a, b) => b.span - a.span).slice(0, 8)
      .map(b => `「${b.pattern}」被否决：${b.rule.text}（${CAT_NAMES[b.rule.cat] || '硬规则'}·手稿${b.rule.page}）${b.detail ? ' — ' + b.detail : ''}`));

    result.scenarios = buildScenarios(final);
    result.originAnalysis = final[0] ? analyzeOrigin(final[0], ev) : null;
    result.mtf = analyzeMTF(final[0], timeframe, Object.assign({}, options.htfBars || {}, subMap), slice);
    result.dualScenario = final.length
      ? buildDualScenario({ cands, top: final[0], slice, precedingContext, mtf: result.mtf })
      : null;
    result.forecast = result.mtf.forecast;
    result.commentary = generateLiuCommentary(final[0], currentPrice, symbol, timeframe, result);
    return result;
  }

  // ---------------------------------------------------------------------------
  // 10. 兼容旧 API (测试与外部调用)
  // ---------------------------------------------------------------------------

  /**
   * 兼容旧签名 validateImpulseRules(p0..p5, isBullish)。
   * 现在执行手稿驱动浪全部价格硬规则（含浪3须超浪1终点、浪4不触浪2终点等）。
   */
  function validateImpulseRules(p0, p1, p2, p3, p4, p5, isBullish) {
    const raw = [p0, p1, p2, p3, p4, p5].filter(Boolean);
    const pts = raw.map((q, i) => ({
      idx: i, time: q.time !== undefined ? q.time : i,
      price: q.price, type: q.type || (i % 2 ? 'high' : 'low'), confirmed: true
    }));
    const g = mkGeom(pts);
    const out = { rule1_wave2_retrace: undefined, rule2_wave3_not_shortest: undefined, rule3_wave4_no_overlap: undefined, passedAll: true };
    for (const r of MOTIVE_RULES.concat([IMPULSE_RULES[0]])) {
      if (r.struct || (r.cat !== C_PRICE && r.cat !== C_TIME) || r.manual) continue;
      if (pts.length < r.need) continue;
      const res = r.test(g, null) || {};
      const pass = res.pass !== false;
      if (r.id === 'M1') out.rule1_wave2_retrace = pass;
      if (r.id === 'M5') out.rule2_wave3_not_shortest = pass;
      if (r.id === 'I1') out.rule3_wave4_no_overlap = pass;
      if (!pass) out.passedAll = false;
    }
    return out;
  }

  return {
    VERSION,
    analyzeWaves,
    findPivots,
    zigzagPivots,
    buildPivotDegrees,
    validateImpulseRules,
    evaluatePattern,
    generateLiuCommentary,
    analyzeOrigin,
    analyzeMTF,
    buildFibLevels,
    identifyRangeExtrema,
    analyzePrecedingContext,
    RANKING,
    PATTERNS,
    _internal: { mkGeom, buildLegTable, legStructure, computeLegStructure, findMotiveCount, zigzagPivots, identifyRangeExtrema, analyzePrecedingContext, buildDualScenario, counterRolesForR }
  };
});
