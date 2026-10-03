/**
 * Module 8: 柳玉冬波浪理论智能研判引擎 v3
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
 *   6. v3 柳氏实战信号层: 监测点战法 / 最大回撤判据 / 吃掉0.618·0.7 / 调整分部投射 / 非推动浪不做底
 *      (依据 2026 年微博语料按标的时间串联提炼, 见 scripts/liu_threads)
 *   7. v3 级别阶梯: 高一级别 → 本级别 → 当前段小级别 嵌套计数
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

  const VERSION = '3.0.0';
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
    // 长样本 (如 10000 根K线) 时预设阈值仍会产生数百个拐点: 继续放大阈值直到主级别拐点数落入上限，
    // 否则假设搜索量随拐点数爆炸 (实测 459 个拐点单次分析约 100 秒)
    if (levels.length && levels[levels.length - 1].pivots.length > MAX_MAIN_PIVOTS) {
      let m = DEGREE_MULTS[DEGREE_MULTS.length - 1];
      for (let k = 0; k < 40; k++) {
        m *= 1.35;
        const pivots = zigzagPivots(bars, atr * m);
        if (pivots.length < 4) break;
        if (pivots.length !== levels[levels.length - 1].pivots.length) {
          levels.push({ mult: +m.toFixed(2), thr: atr * m, pivots, count: pivots.length });
        }
        if (pivots.length <= MAX_MAIN_PIVOTS) break;
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
    // 出身检验 (5-3-5-3-5): 浪1可为推动浪或引导楔形，浪3只能是推动浪，浪5可为推动浪或终结楔形
    rg('M9', C_STRUCT, false, null, 2, 'P9-16', '出身检验：浪1内部应为五浪（推动浪或引导楔形）', 2,
      (g, ev) => motiveLegCheck(g, ev, 0, '引导楔形')),
    rg('M10', C_STRUCT, false, 'min', 4, 'P9-16 + 通用（EWI：楔形只出现在浪1/浪5/a浪/c浪）', '浪3内部应为五浪推动（不能是楔形）', 2,
      (g, ev) => motiveLegCheck(g, ev, 2, null), { deferred: true }),
    rg('M11', C_STRUCT, false, 'min', 6, 'P9-16 + 通用（EWI终结楔形）', '浪5内部应为五浪（推动浪或终结楔形）', 2,
      (g, ev) => motiveLegCheck(g, ev, 4, '终结楔形'), { deferred: true }),
    rg('M12', C_STRUCT, false, 'min', 6, 'P204 + 通用（EWI失败第五浪）', '失败第五浪（未越过浪3终点）内部仍须走满五浪，否则是浪4未完', 2,
      (g, ev) => {
        if (!truncatedFifth(g)) return { pass: true, neutral: true, detail: '浪5已越过浪3终点，非失败第五浪' };
        return motiveLegCheck(g, ev, 4, '终结楔形');
      }, { deferred: true }),
    rg('G9', C_G_RATIO, false, null, 6, '通用（EWI失败第五浪）', '失败第五浪通常出现在特别强劲的浪3之后（浪3≥1.618×浪1）', 0.5,
      g => truncatedFifth(g) && !g.p[5].open
        ? { pass: g.l[2] >= 1.618 * g.l[0] - EPS, detail: `失败第五浪，浪3=浪1×${(g.l[2] / g.l[0]).toFixed(2)}` }
        : { pass: true, neutral: true, detail: '浪5已越过浪3终点，非失败第五浪' }),
    rg('I2', C_G_PAT, false, null, 5, 'P85/P88 + 柳玉冬实战（赣锋2026-04-10「2浪是单锯齿，4浪是三角形」）', '交替原则：浪2与浪4宜一陡一横或一简一繁', 1,
      (g, ev) => {
        const alt = alternationFor(g, ev);
        if (!alt) return { pass: true, neutral: true, detail: '无K线数据未验' };
        if (alt.pass === null) return { pass: true, pending: true, detail: alt.text };
        return { pass: alt.pass, detail: alt.text };
      }, { deferred: true }),
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
    // 收缩/扩散由浪3与浪1之比决定，其后各浪须同向一致 (EWI 列为楔形定义)
    rg('D3', C_PRICE, true, 'min', 5, '通用（EWI楔形条则）', '收缩楔形浪4<浪2、扩散楔形浪4>浪2（与浪3/浪1同向一致）', 1,
      g => {
        const contracting = g.l[2] < g.l[0];
        return { pass: contracting ? g.l[3] < g.l[1] + EPS : g.l[3] > g.l[1] - EPS, detail: `${contracting ? '收缩' : '扩散'} 3/1=${(g.l[2] / g.l[0]).toFixed(2)} 4/2=${(g.l[3] / g.l[1]).toFixed(2)}` };
      }),
    rg('D5', C_PRICE, true, 'min', 6, '通用（EWI楔形条则）', '收缩楔形浪5<浪3、扩散楔形浪5>浪3', 1,
      g => {
        const contracting = g.l[2] < g.l[0];
        return { pass: contracting ? g.l[4] < g.l[2] + EPS : g.l[4] > g.l[2] - EPS, detail: `${contracting ? '收缩' : '扩散'} 5/3=${(g.l[4] / g.l[2]).toFixed(2)}` };
      }),
    rg('D4', C_STRUCT, false, 'min', 4, '通用（EWI：引导楔形5-3-5-3-5或3-3-3-3-3；终结楔形3-3-3-3-3）', '楔形浪1/3/5结构须一致，且与所处位置相符', 2,
      (g, ev) => diagonalStructCheck(g, ev), { deferred: true })
  ];

  const ZIGZAG_RULES = [
    rg('Z0', C_STRUCT, false, null, 2, 'P216', '出身检验：浪a内部应为五浪（推动浪或引导楔形）', 2,
      (g, ev) => motiveLegCheck(g, ev, 0, '引导楔形')),
    rg('Z7', C_STRUCT, false, 'min', 4, 'P216 + 通用（EWI终结楔形）', 'c浪内部应为五浪（推动浪或终结楔形）', 1.5,
      (g, ev) => motiveLegCheck(g, ev, 2, '终结楔形'), { deferred: true }),
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
    rg('ZG8', C_G_PAT, false, null, 4, '柳玉冬实战（黄金2026-03-20）', 'c浪超过a浪1.618倍则有发展为推动浪的危险（三段可能是五浪的前三段）', 0.5,
      g => { const r = g.l[2] / g.l[0]; return { pass: r <= 1.618 + EPS, detail: `c/a=${r.toFixed(2)}${r > 1.618 ? '，警惕发展为推动浪' : ''}` }; }),
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
    rg('F8', C_STRUCT, false, 'min', 4, 'P236 + 通用（EWI终结楔形）', 'c浪内部应为五浪（推动浪或终结楔形）', 1.5,
      (g, ev) => motiveLegCheck(g, ev, 2, '终结楔形'), { deferred: true }),
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
    // 越线只看本段自己的K线: 奔向的边界不计起点K线、离开的边界不计终点K线 (端点K线的另一端属于相邻的浪)
    rg('T11', C_PRICE, true, null, 5, 'P308', '收敛三角形：c/d浪子浪越过边界线不得超过前浪总量的10%', 1,
      (g, ev) => {
        if (!ev || !ev.highs) return { pass: true, neutral: true, detail: '无K线数据未验' };
        const ac = [g.p[1].idx, g.p[1].price, g.p[3].idx, g.p[3].price];
        const bd = [g.p[2].idx, g.p[2].price, g.p[4].idx, g.p[4].price];
        const o1 = Math.max(
          lineOvershoot(ev.highs, ev.lows, g.p[2].idx + 1, g.p[3].idx, ac[0], ac[1], ac[2], ac[3], g.d),
          lineOvershoot(ev.highs, ev.lows, g.p[2].idx, g.p[3].idx - 1, bd[0], bd[1], bd[2], bd[3], -g.d)) / (g.l[1] || 1);
        const o2 = Math.max(
          lineOvershoot(ev.highs, ev.lows, g.p[3].idx, g.p[4].idx - 1, ac[0], ac[1], ac[2], ac[3], g.d),
          lineOvershoot(ev.highs, ev.lows, g.p[3].idx + 1, g.p[4].idx, bd[0], bd[1], bd[2], bd[3], -g.d)) / (g.l[2] || 1);
        return { pass: o1 <= 0.1 + EPS && o2 <= 0.1 + EPS, detail: `c越线${fmtPct(o1)} d越线${fmtPct(o2)}` };
      }, { slow: true }),
    rg('T12', C_PRICE, true, null, 6, 'P308', '收敛三角形：e浪子浪越过边界线不得超过d浪总量的10%', 1,
      (g, ev) => {
        if (!ev || !ev.highs) return { pass: true, neutral: true, detail: '无K线数据未验' };
        const ac = [g.p[1].idx, g.p[1].price, g.p[3].idx, g.p[3].price];
        const bd = [g.p[2].idx, g.p[2].price, g.p[4].idx, g.p[4].price];
        const o = Math.max(
          lineOvershoot(ev.highs, ev.lows, g.p[4].idx + 1, g.p[5].idx, ac[0], ac[1], ac[2], ac[3], g.d),
          lineOvershoot(ev.highs, ev.lows, g.p[4].idx, g.p[5].idx - 1, bd[0], bd[1], bd[2], bd[3], -g.d)) / (g.l[3] || 1);
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

  // 扩张三角形 (手稿第6章只讲收缩三角形；补主流 EWI 条则，标「通用」)：边界线 a-c 与 b-d 发散，
  // 即 c 终点越过 a 终点、d 终点越过 b 终点；各段为三浪；位置与收缩三角形相同 (浪4、b浪、x浪、联合形末段)
  const EXPANDING_TRIANGLE_RULES = [
    rg('T0', C_STRUCT, false, null, 2, '通用（EWI扩张三角形3-3-3-3-3）', '出身检验：浪a内部应为三浪（调整浪结构）', 2, null,
      { struct: true, legs: [0], expect: ['3'] }),
    rg('E1', C_PRICE, true, 'min', 4, '通用（EWI扩张三角形）', '扩张三角形：c浪须大于b浪（c终点越过a终点，a-c线发散）', 1,
      g => ({ pass: g.l[2] > g.l[1] + EPS, detail: `c/b=${(g.l[2] / g.l[1]).toFixed(2)}` })),
    rg('E2', C_PRICE, true, 'min', 5, '通用（EWI扩张三角形）', '扩张三角形：d浪须大于c浪（d终点越过b终点，b-d线发散）', 1,
      g => ({ pass: g.l[3] > g.l[2] + EPS, detail: `d/c=${(g.l[3] / g.l[2]).toFixed(2)}` })),
    rg('E3', C_PRICE, true, 'min', 6, '通用（EWI扩张三角形）', '扩张三角形：e浪不小于d浪的50%', 1,
      g => ({ pass: g.l[4] >= 0.5 * g.l[3] - EPS, detail: `e/d=${fmtPct(g.l[4] / g.l[3])}` })),
    rg('EG1', C_G_RATIO, false, null, 3, '通用（EWI扩张三角形）', '扩张三角形b浪常大于a浪（各浪依次放大）', 1,
      g => ({ pass: g.l[1] > g.l[0] - EPS, detail: `b/a=${(g.l[1] / g.l[0]).toFixed(2)}` })),
    rg('EG2', C_G_RATIO, false, 'min', 6, '通用（EWI扩张三角形）', 'e浪常越过a-c线（e>d）', 1,
      g => ({ pass: g.l[4] > g.l[3] - EPS, detail: `e/d=${(g.l[4] / g.l[3]).toFixed(2)}` })),
    rg('EG3', C_G_RATIO, false, null, 5, '通用', '相邻各浪放大倍数常在1~1.618之间（远超则更像推动浪）', 1,
      g => {
        const rs = [];
        for (let k = 1; k < g.l.length; k++) rs.push(g.l[k] / g.l[k - 1]);
        return { pass: rs.slice(1).every(r => r <= 1.9), detail: rs.map(r => r.toFixed(2)).join(' / ') };
      })
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
    rg('WG5', C_G_PAT, false, null, 4, 'P362（双锯齿=两个锯齿以x相连）', '双/三锯齿的w、y(、z)应为锯齿形（陡峭）', 1,
      (g, ev) => {
        const comps = combinationComponents('DOUBLE_ZIGZAG', g, ev, g.p[g.p.length - 1].open ? 'RUNNING' : 'COMPLETED');
        const judged = (comps || []).filter(c => !c.developing && c.class && c.class.alive.length);
        if (!judged.length) return { pass: true, neutral: true, detail: '组成部分结构不足未验' };
        const bad = judged.filter(c => !c.class.alive.some(a => a.form === 'sharp'));
        return { pass: !bad.length, detail: comps.map(c => `${c.label}=${c.text}`).join('；') };
      }, { deferred: true }),
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
    rg('CG5', C_G_PAT, false, null, 4, '通用（EWI联合形条则）', '联合形中三角形只能作为最后一个组成部分', 1,
      (g, ev) => {
        const comps = combinationComponents('COMBINATION', g, ev, g.p[g.p.length - 1].open ? 'RUNNING' : 'COMPLETED');
        if (!comps || !comps.some(c => c.class && c.class.best)) return { pass: true, neutral: true, detail: '组成部分结构不足未验' };
        const bad = comps.slice(0, -1).filter(c => c.class && c.class.best && /TRIANGLE/.test(c.class.best.type));
        return { pass: !bad.length, detail: comps.map(c => `${c.label}=${c.text}`).join('；') };
      }, { deferred: true }),
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
    rg('CG5', C_G_PAT, false, null, 6, '通用（EWI联合形条则）', '联合形中三角形只能作为最后一个组成部分', 1,
      (g, ev) => {
        const comps = combinationComponents('COMBINATION', g, ev, g.p[g.p.length - 1].open ? 'RUNNING' : 'COMPLETED');
        if (!comps || !comps.some(c => c.class && c.class.best)) return { pass: true, neutral: true, detail: '组成部分结构不足未验' };
        const bad = comps.slice(0, -1).filter(c => c.class && c.class.best && /TRIANGLE/.test(c.class.best.type));
        return { pass: !bad.length, detail: comps.map(c => `${c.label}=${c.text}`).join('；') };
      }, { deferred: true }),
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
    EXPANDING_TRIANGLE: { pts: 6, minDev: 4, name: '扩张三角形', category: '调整浪', rules: EXPANDING_TRIANGLE_RULES, labels: ['0', 'a', 'b', 'c', 'd', 'e'] },
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
      // 慢速规则 (如 I1 逐根扫描子浪) 在无K线时退化为端点检验，同样参与: 否则推动浪与楔形无从区分
      if (r.struct || (r.cat !== C_PRICE && r.cat !== C_TIME)) continue;
      if (pts.length < r.need) continue;
      const res = r.test(g, null) || {};
      if (res.pass === false) {
        const open = !!pts[pts.length - 1].open;
        if (!(open && r.pending === 'min' && r.need === pts.length)) return false;
      }
    }
    return true;
  }

  /** 在交替拐点序列 zp 上寻找覆盖全段的合规五浪计数 (允许跳点，严控防爆搜预算) */
  function findMotiveCount(zp, kinds) {
    kinds = kinds || ['IMPULSE', 'DIAGONAL'];
    const ok = pts => kinds.some(k => motiveRulesOK(pts, k));
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
    let found = null;

    function rec(cur) {
      if (--budget <= 0) return false;
      if (path.length === 5) {
        if (((last - cur) & 1) === 0) return false;
        const pts = path.concat([last]).map(i => arr[i]);
        if (ok(pts)) { found = pts; return true; }
        return false;
      }
      for (let j = cur + 1; j < last; j++) {
        if (((j - cur) & 1) === 0) continue;
        path.push(j);
        const pts = path.map(i => arr[i]);
        if (ok(pts)) {
          if (rec(j)) return true;
        }
        path.pop();
        if (budget <= 0) return false;
      }
      return false;
    }
    // 返回找到的五浪拐点 (真值) 或 false
    return rec(0) ? found : false;
  }

  /**
   * 判定腿 p[i]->p[i+1] 的内部结构: '5'(可数为驱动五浪) / '3'(非五浪, 调整浪) / 'unknown'
   */
  function legStructure(g, legIdx, ev) {
    const pA = g.p[legIdx], pB = g.p[legIdx + 1];
    const key = pA.time + '_' + pB.time;
    if (!ev.structCache) ev.structCache = new Map(); // 外部调用 (如前端 analyzeOrigin) 可能只传 {bars}
    if (ev.structCache.has(key)) return ev.structCache.get(key);
    const res = computeLegStructure(pA, pB, ev);
    ev.structCache.set(key, res);
    return res;
  }

  function computeLegStructure(pA, pB, ev) {
    const { seg, srcName } = legSegment(pA, pB, ev);
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
      const five = findMotiveTyped(anchored);
      return { label: five ? '5' : '3', motive: five ? five.kind : null, subPivots: anchored, source: srcName };
    }
    return { label: 'unknown', subPivots: [], source: srcName };
  }

  /** 五浪计数并区分推动浪 / 楔形 (推动浪优先): {points, kind:'IMPULSE'|'DIAGONAL'} 或 null */
  function findMotiveTyped(zp) {
    if (zp.length < 6) return null;
    const imp = findMotiveCount(zp, ['IMPULSE']);
    if (imp) return { points: imp, kind: 'IMPULSE' };
    const dia = findMotiveCount(zp, ['DIAGONAL']);
    return dia ? { points: dia, kind: 'DIAGONAL' } : null;
  }

  /**
   * 驱动段出身检验: 内部须为五浪。diagName 为该位置允许的楔形 ('引导楔形' / '终结楔形')，
   * null 表示该位置不允许楔形 (浪3)。
   */
  function motiveLegCheck(g, ev, li, diagName) {
    if (!ev || !ev.bars) return { pass: true, neutral: true, detail: '无K线数据未验' };
    if (li + 1 >= g.p.length) return { pass: true, neutral: true, detail: '该浪尚未出现' };
    const st = legStructure(g, li, ev);
    const nm = g.p.length <= 4 ? `${'abc'[li]}浪` : `浪${li + 1}`;
    const src = st.source ? `（${st.source}）` : '';
    if (st.label === 'unknown') return { pass: true, neutral: true, detail: `${nm}小级别数据不足，结构未验证` };
    if (st.label !== '5') return { pass: false, detail: `${nm}：非五浪${src}` };
    if (st.motive === 'DIAGONAL' && !diagName) return { pass: false, detail: `${nm}只能数成楔形${src}——浪3不能是楔形` };
    return { pass: true, detail: `${nm}：${st.motive === 'DIAGONAL' ? diagName : '五浪推动'}${src}` };
  }

  /** 失败第五浪 (截断): 浪5未越过浪3终点 */
  function truncatedFifth(g) {
    return g.p.length >= 6 && g.d * (g.p[5].price - g.p[3].price) <= 0;
  }

  /**
   * 楔形所处位置: 引导楔形只出现在浪1/a浪 (新趋势起点)，终结楔形只出现在浪5/c浪 (同向趋势末端)。
   * 取楔形起点之前 1.5 倍楔形长度 (至少 20 根) 的窗口:
   *   起点是窗口内的反向极值 (上升楔形起点为窗口最低) → 新趋势起点 → 'LEADING'
   *   窗口内已有更远的反向极值且窗口起点在起点反侧 (同向趋势已运行一段) → 'ENDING'
   *   其余 (横盘 / 数据不足) → null
   */
  function diagonalRole(g, ev) {
    const bars = ev && (ev.ctxBars || ev.bars);
    if (!bars || bars.length < 10) return null;
    const p0 = g.p[0], pN = g.p[g.p.length - 1], d = g.d;
    const idxOf = t => { let i = bars.findIndex(b => b.time >= t); return i < 0 ? bars.length - 1 : i; };
    const i0 = idxOf(p0.time), iN = idxOf(pN.time);
    const from = i0 - Math.max(20, Math.round(1.5 * (iN - i0)));
    if (from < 0) return null;
    let ext = d > 0 ? Infinity : -Infinity;
    for (let i = from; i < i0; i++) ext = d > 0 ? Math.min(ext, bars[i].low) : Math.max(ext, bars[i].high);
    if (d * (p0.price - ext) <= EPS) return 'LEADING';
    if (d * (p0.price - bars[from].close) > 0) return 'ENDING';
    return null;
  }

  /** 楔形浪1/3/5结构一致性 (全为五浪=5-3-5-3-5 引导楔形；全为三浪=3-3-3-3-3) 及与位置相符 */
  function diagonalStructCheck(g, ev) {
    if (!ev || !ev.bars) return { pass: true, neutral: true, detail: '无K线数据未验' };
    const n = g.p.length, lastOpen = !!g.p[n - 1].open;
    // 运行中的末浪内部尚未走完，不参与一致性比较
    const legs = [0, 2, 4].filter(li => li + 1 < n && !(lastOpen && li + 1 === n - 1)).map(li => ({ li, st: legStructure(g, li, ev) }));
    const known = legs.filter(x => x.st.label !== 'unknown');
    const role = diagonalRole(g, ev);
    const roleTxt = role === 'LEADING' ? '位置：新趋势起点（浪1/a浪）' : role === 'ENDING' ? '位置：同向趋势末端（浪5/c浪）' : '位置不明';
    const desc = known.map(x => `浪${x.li + 1}:${x.st.label === '5' ? '五浪' : '三浪'}`).join(' ');
    if (known.length < 2) return { pass: true, neutral: true, detail: `子浪结构不足未验；${roleTxt}` };
    const fives = known.filter(x => x.st.label === '5').length;
    if (fives && fives < known.length) return { pass: false, detail: `${desc}——浪1/3/5结构不一致；${roleTxt}` };
    if (fives && role === 'ENDING') return { pass: false, detail: `${desc}——5-3-5-3-5只能是引导楔形，但${roleTxt}` };
    return { pass: true, detail: `${desc}（${fives ? '5-3-5-3-5' : '3-3-3-3-3'}）；${roleTxt}` };
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
      parts.push(`浪${legName}:${st.label === '5' ? (st.motive === 'DIAGONAL' ? '五浪(楔形)' : '五浪') : st.label === '3' ? '非五浪' : '级别不足'}${st.source ? `(${st.source})` : ''}`);
    }
    if (!anyEval) return { pass: true, neutral: true, detail: '小级别数据不足，结构未验证' };
    return { pass: allPass, detail: parts.join(' ') };
  }

  // ---------------------------------------------------------------------------
  // 4.5 调整浪子形态识别 (浪2/浪4 交替原则、联合形组成部分)
  //     在腿内部的低级别拐点上，用本引擎同一套规则库 (硬规则全过) 匹配各调整浪型；
  //     多个子级别阈值并行尝试，保留每种浪型的最佳匹配。数据不足如实返回空，不编造。
  // ---------------------------------------------------------------------------

  const CORRECTIVE_TYPES = ['ZIGZAG', 'FLAT', 'TRIANGLE', 'EXPANDING_TRIANGLE', 'DOUBLE_ZIGZAG', 'COMBINATION', 'TRIPLE_ZIGZAG', 'TRIPLE_COMBINATION'];
  // 陡峭(sharp)=锯齿族；横向(sideways)=平台/三角/联合。简单=单一形态；复杂=双重/三重
  const CORR_FORM = { ZIGZAG: 'sharp', DOUBLE_ZIGZAG: 'sharp', TRIPLE_ZIGZAG: 'sharp', FLAT: 'sideways', TRIANGLE: 'sideways', EXPANDING_TRIANGLE: 'sideways', COMBINATION: 'sideways', TRIPLE_COMBINATION: 'sideways' };
  const CORR_COMPLEXITY = { ZIGZAG: 'simple', FLAT: 'simple', TRIANGLE: 'simple', EXPANDING_TRIANGLE: 'simple', DOUBLE_ZIGZAG: 'complex', TRIPLE_ZIGZAG: 'complex', COMBINATION: 'complex', TRIPLE_COMBINATION: 'complex' };
  const FORM_TXT = { sharp: '陡', sideways: '横' };
  const CPLX_TXT = { simple: '简单', complex: '复杂' };

  /**
   * 主周期拐点在低周期中的精确时刻: 主K线 [t, t+主周期) 内创出该极值的那根低周期K线。
   * 主周期K线时间为开盘时刻，极值可能发生在其内部任一时刻；不精化则低周期截段会漏掉终点极值。
   */
  function refineSubTime(s, p, mainTfSec) {
    const t0 = p.time, t1 = p.time + mainTfSec;
    let lo = 0, hi = s.bars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (s.bars[mid].time < t0) lo = mid + 1; else hi = mid; }
    let best = null;
    for (let i = lo; i < s.bars.length && s.bars[i].time < t1; i++) {
      const b = s.bars[i];
      if (!best || (p.type === 'high' ? b.high > best.high : b.low < best.low)) best = b;
    }
    return best ? best.time : t0;
  }

  /** 腿 pA→pB 的K线段: 优先更低周期数据源, 否则按时间截取主周期 */
  function legSegment(pA, pB, ev) {
    const t0 = pA.time, t1 = pB.time;
    if (ev.sources) {
      // 画浪评估模式 (ev.refineSubTimes): 端点精化到低周期极值时刻，放宽单段根数上限，要求低周期数据完整覆盖该段
      const refine = !!ev.refineSubTimes && ev.mainTfSec > 0;
      const maxBars = ev.maxSubBars || 900;
      for (const s of ev.sources) {
        if (s.isMain) continue;
        const a = refine ? refineSubTime(s, pA, ev.mainTfSec) : t0;
        const z = refine ? refineSubTime(s, pB, ev.mainTfSec) : t1;
        const b = s.bars.filter(x => x.time >= a && x.time <= z);
        if (b.length >= 12 && b.length <= maxBars &&
          (b[b.length - 1].time - b[0].time) >= (refine ? 0.9 : 0.6) * (z - a)) return { seg: b, srcName: s.name };
      }
    }
    // 按时间截取: 拐点 idx 相对于分析切片，调用方传入的 bars 可能是全量K线
    const i0 = ev.bars.findIndex(x => x.time >= t0);
    let i1 = i0;
    while (i1 >= 0 && i1 + 1 < ev.bars.length && ev.bars[i1 + 1].time <= t1) i1++;
    return { seg: i0 >= 0 ? ev.bars.slice(i0, i1 + 1) : null, srcName: null };
  }

  /** 在锚定的子拐点序列上匹配一种调整浪型: 起点=子序列首点, 终点=子序列末点 */
  function matchCorrectiveOn(type, sub, developing) {
    const def = PATTERNS[type];
    const last = sub.length - 1;
    const sizes = [];
    if (developing) { for (let m = 3; m <= def.pts; m++) sizes.push(m); } else sizes.push(def.pts);
    const legOk = buildLegTable(sub);
    let best = null, budget = 4000;
    const path = [0];
    function rec(cur, m) {
      if (--budget <= 0) return;
      if (path.length === m - 1) {
        if (((last - cur) & 1) === 0 || !legOk[cur][last]) return;
        const pts = path.concat([last]).map(i => sub[i]);
        const res = evaluatePattern(type, pts, null);
        if (res.hardFails.length) return;
        const score = res.guide.weight ? res.guide.weightGot / res.guide.weight : 0.5;
        const complete = pts.length === def.pts;
        // 完整形态优先于发展中形态，其次比指引符合度
        const key = (complete ? 1 : 0) + score;
        if (!best || key > best.key) best = { key, score, complete, pts };
        return;
      }
      for (let j = cur + 1; j < last; j++) {
        if (((j - cur) & 1) === 0 || !legOk[cur][j]) continue;
        path.push(j);
        rec(j, m);
        path.pop();
        if (budget <= 0) return;
      }
    }
    for (const m of sizes) {
      if (m < 2 || last < m - 1) continue;
      if (m === 2) continue;
      path.length = 1;
      rec(0, m);
    }
    return best;
  }

  /**
   * 识别腿 pA→pB 内部的调整浪子形态。developing=true 表示该腿尚在运行 (如运行中的浪4)，
   * 此时返回「仍然成立」的浪型集合 (柳玉冬: 「它或者是平台形、联合形、三角形…平台形可以否定」)。
   */
  function classifyCorrectiveLeg(pA, pB, ev, developing) {
    if (!ev || !ev.bars) return null;
    if (!ev.structCache) ev.structCache = new Map();
    const key = `cls|${pA.time}_${pB.time}|${developing ? 1 : 0}`;
    if (ev.structCache.has(key)) return ev.structCache.get(key);
    const out = computeCorrectiveClass(pA, pB, ev, developing);
    ev.structCache.set(key, out);
    return out;
  }

  function computeCorrectiveClass(pA, pB, ev, developing) {
    const empty = { alive: [], best: null, form: null, complexity: null, source: null, developing: !!developing };
    const { seg, srcName } = legSegment(pA, pB, ev);
    const range = Math.abs(pB.price - pA.price);
    if (!seg || seg.length < 6 || !(range > 0)) return empty;
    const sAtr = avgTR(seg) || range / seg.length;
    const ps = { idx: 0, time: seg[0].time, price: pA.price, type: pA.type, confirmed: true };
    const pe = { idx: seg.length - 1, time: seg[seg.length - 1].time, price: pB.price, type: pB.type, confirmed: !developing, open: !!developing };
    const bestByType = {};
    const seen = new Set();
    for (const m of [0.3, 0.2, 0.14, 0.1, 0.07, 0.05]) {
      const thr = Math.max(range * m, 1.0 * sAtr);
      const sub = anchorZigzag(zigzagPivots(seg, thr), ps, pe);
      if (sub.length < 4 || sub.length > 16) continue;
      const sig = sub.map(q => q.idx).join(',');
      if (seen.has(sig)) continue;
      seen.add(sig);
      for (const type of CORRECTIVE_TYPES) {
        const hit = matchCorrectiveOn(type, sub, developing);
        if (!hit) continue;
        const prev = bestByType[type];
        // 同一浪型取更简洁的分解(更粗级别)优先，其次指引分
        if (!prev || hit.key > prev.key + 0.05) {
          bestByType[type] = Object.assign({ subSwings: sub.length - 1 }, hit);
        }
      }
    }
    const alive = Object.keys(bestByType).map(type => {
      const h = bestByType[type];
      return {
        type, name: PATTERNS[type].name, form: CORR_FORM[type], complexity: CORR_COMPLEXITY[type],
        score: Math.round(100 * h.score), complete: h.complete, subSwings: h.subSwings,
        points: h.pts.map(q => ({ time: q.time, price: q.price, type: q.type }))
      };
    }).sort((a, b) => (Number(b.complete) - Number(a.complete)) || (b.score - a.score) ||
      (a.complexity === 'simple' ? -1 : 1) - (b.complexity === 'simple' ? -1 : 1));
    if (!alive.length) return Object.assign(empty, { source: srcName });
    const best = alive[0];
    const forms = new Set(alive.map(a => a.form));
    return {
      alive, best,
      form: developing ? (forms.size === 1 ? best.form : null) : best.form,
      complexity: developing ? null : best.complexity,
      source: srcName, developing: !!developing
    };
  }

  function describeClass(c) {
    if (!c || !c.best) return '结构未识别';
    if (c.developing) return `仍成立: ${c.alive.map(a => a.name).join('、')}`;
    return `${c.best.name}（${FORM_TXT[c.best.form]}·${CPLX_TXT[c.best.complexity]}）`;
  }

  /**
   * 交替原则 (手稿P85/P88; 柳玉冬「2浪是单锯齿，4浪是三角形。很标准」)
   * 浪2与浪4: 一陡一横 或 一简单一复杂 即为交替。结构无法识别时以回撤深度/用时作代理。
   */
  function alternationFor(g, ev) {
    if (!ev || !ev.bars || g.p.length < 4) return null;
    const p = g.p, n = p.length;
    const w2 = classifyCorrectiveLeg(p[1], p[2], ev, false);
    const r2 = g.l[1] / g.l[0];
    const tr2 = g.t[1] / g.t[0];
    const out = { wave2: { class: w2, retrace: +r2.toFixed(3), timeRatio: +tr2.toFixed(2), text: describeClass(w2) } };

    const f2 = w2 && w2.form;
    if (n === 4) {
      // 浪3运行中: 由浪2形态预判浪4
      out.expectWave4 = f2 === 'sharp'
        ? { form: 'sideways', types: ['FLAT', 'TRIANGLE', 'EXPANDING_TRIANGLE', 'COMBINATION'], text: '浪2为陡峭锯齿 → 浪4预期横向：平台形 / 三角形 / 联合形，回撤偏浅(0.236~0.382)、用时偏长' }
        : f2 === 'sideways'
          ? { form: 'sharp', types: ['ZIGZAG', 'DOUBLE_ZIGZAG'], text: '浪2为横向调整 → 浪4预期陡峭：单锯齿 / 双锯齿，回撤可较深、用时偏短' }
          : { form: null, types: [], text: r2 >= 0.5 ? '浪2回撤较深(≥0.5) → 浪4倾向浅而横' : '浪2回撤较浅 → 浪4倾向深而陡' };
      out.pass = null;
      out.text = out.expectWave4.text;
      return out;
    }

    const developing = n === 5;
    const w4 = classifyCorrectiveLeg(p[3], p[4], ev, developing);
    const r4 = g.l[3] / g.l[2];
    const tr4 = g.t[3] / g.t[2];
    out.wave4 = { class: w4, retrace: +r4.toFixed(3), timeRatio: +tr4.toFixed(2), text: describeClass(w4) };

    if (w2 && w2.best && w4 && w4.best) {
      if (developing) {
        const contrast = w4.alive.filter(a => a.form !== w2.form);
        out.basis = 'structure';
        if (!contrast.length) { out.pass = false; out.text = `浪2为${FORM_TXT[w2.form]}，浪4目前仍成立的形态全部同为${FORM_TXT[w2.form]}，暂不符合交替`; }
        else if (contrast.length === w4.alive.length) { out.pass = true; out.text = `浪2为${describeClass(w2)}；浪4仍成立的形态均为${FORM_TXT[contrast[0].form]}（${contrast.map(a => a.name).join('、')}），符合交替`; }
        else { out.pass = null; out.text = `浪2为${describeClass(w2)}；浪4尚未定型（${w4.alive.map(a => a.name).join('、')}），交替待确认，符合交替者: ${contrast.map(a => a.name).join('、')}`; }
        out.expectWave4 = { form: w2.form === 'sharp' ? 'sideways' : 'sharp', types: contrast.map(a => a.type), text: out.text };
        return out;
      }
      const formDiff = w2.form !== w4.form;
      const cplxDiff = w2.complexity !== w4.complexity;
      out.basis = 'structure';
      out.pass = formDiff || cplxDiff;
      out.text = out.pass
        ? `浪2=${describeClass(w2)}，浪4=${describeClass(w4)}：${formDiff ? '一陡一横' : ''}${formDiff && cplxDiff ? '、' : ''}${cplxDiff ? '一简一繁' : ''}，符合交替`
        : `浪2与浪4同为${describeClass(w4)}：未交替（交替是指引而非铁律，降低该计数权重）`;
      return out;
    }
    // 代理判据: 陡=回撤深且快，横=回撤浅且慢
    const depthDiff = Math.abs(r2 - r4) >= 0.15;
    const timeDiff = Math.max(tr2, tr4) / Math.max(0.01, Math.min(tr2, tr4)) >= 1.6;
    out.basis = 'proxy';
    if (developing) { out.pass = null; out.text = `子浪结构不足，浪4运行中：浪2回撤${(r2 * 100).toFixed(0)}%，浪4目前${(r4 * 100).toFixed(0)}%`; return out; }
    out.pass = depthDiff || timeDiff ? true : false;
    out.text = `子浪结构不足，以回撤/用时代理：浪2回撤${(r2 * 100).toFixed(0)}%·用时比${tr2.toFixed(2)}，浪4回撤${(r4 * 100).toFixed(0)}%·用时比${tr4.toFixed(2)}，${out.pass ? '深浅或快慢有别，视作交替' : '深浅快慢相近，未见交替'}`;
    return out;
  }

  /** 联合形 / 双三锯齿的组成部分识别 (w、y、z) */
  function combinationComponents(type, g, ev, status) {
    if (!ev || !ev.bars) return null;
    const legs = g.p.length === 6 ? [0, 2, 4] : [0, 2];
    const labels = ['w', null, 'y', null, 'z'];
    const out = [];
    for (const li of legs) {
      if (li + 1 >= g.p.length) continue;
      const lastLeg = li + 1 === g.p.length - 1;
      const developing = lastLeg && status !== 'COMPLETED';
      const c = classifyCorrectiveLeg(g.p[li], g.p[li + 1], ev, developing);
      out.push({ label: labels[li], leg: li, developing, class: c, text: describeClass(c) });
    }
    return out;
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
    const deferred = [];

    for (const r of def.rules) {
      if (points.length < r.need) {
        // 未评估指引按中性计分（避免发展中计数因检验项少而获得偏高指引分）
        if (!r.hard) { guide.weight += r.w; guide.weightGot += 0.5 * r.w; }
        continue;
      }
      if (r.deferred) { deferred.push(r); continue; }
      account(r, r.struct ? evalStructRule(r, g, ev || {})
        : r.manual ? { pass: true, neutral: true, detail: '人工指引项，自动判定从略' }
          : (r.test(g, ev) || {}));
    }
    // 延后规则: 需识别子浪形态，代价较高，只对硬规则全部通过的假设执行
    for (const r of deferred) {
      account(r, !hardFails.length && ev && ev.bars ? (r.test(g, ev) || {}) : { pass: true, neutral: true, detail: '未执行子形态识别' });
    }
    return { g, checks, hardFails, pending, guide, complete: points.length === def.pts };

    function account(r, res) {

      // 最低要求类只在其最后一个涉及点 (第 need 个点) 即未确认末点时暂缓；更早的点已确认，照常否决
      const openSuppressed = lastOpen && r.pending === 'min' && r.need === points.length && res.pass === false;
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
        monitoringPivot = lvl(p[0].price, '浪1起点·铁律红线', '浪2回撤达到浪1的100%，该计数否决（手稿P32铁律）');
      } else if (n === 4) {
        targets.push(tgt(p[1].price, '浪3最低要求: 超越浪1终点', null));
        [1, 1.618, 2.618].forEach(r => targets.push(tgt(p[2].price + d * r * l[0], `浪3=浪1×${r}`, r)));
        monitoringPivot = lvl(p[2].price, '浪2终点·浪3计数防线', '“浪3运行中”计数失效（浪2尚未结束）');
        secondaryPivot = lvl(p[1].price, diag ? '浪1终点·浪4须切入(P48楔形)' : '浪1终点·浪4禁区边界(P48)', diag ? '浪4切入浪1价格区，满足楔形要求（P48）' : '浪4切入浪1价格区，推动浪计数失效，只能改按楔形（P48）');
      } else if (n === 5) {
        [0.236, 0.382, 0.5].forEach(r => targets.push(tgt(p[3].price - d * r * l[2], `浪4回撤浪3×${r}`, r)));
        targets.push(tgt(p[1].price, diag ? '浪4须切入浪1区（楔形）' : '浪4禁区: 浪1价格区上沿', null));
        if (diag) {
          monitoringPivot = lvl(p[2].price, '浪2终点·浪4不可完全回撤浪3', '浪4完全回撤浪3，该计数否决（手稿P42）');
          secondaryPivot = lvl(p[1].price, '浪1终点·浪4切入要求', '浪4进入浪1价格区，满足楔形要求');
        } else {
          monitoringPivot = lvl(p[1].price, '浪1终点·浪4禁区', '浪4切入浪1价格区，推动浪计数失效（手稿P48）');
          secondaryPivot = lvl(p[2].price, '浪2终点·最后防线', '浪4完全回撤浪3，任何驱动浪计数均失效（手稿P42）');
        }
      } else if (status === 'COMPLETED') {
        // 回撤以整段五浪的价格(0→5)为基准；柳玉冬实战口径「正常回撤0.2~0.618，极限0.8」
        const total = Math.abs(p[5].price - p[0].price);
        [0.2, 0.382, 0.5, 0.618].forEach(r => targets.push(tgt(p[5].price - d * r * total, `整体回撤×${r}`, r)));
        targets.push(tgt(p[5].price - d * 0.8 * total, '整体回撤极限×0.8（超过则怀疑非本级别调整）', 0.8));
        monitoringPivot = lvl(p[5].price, '浪5终点·趋势延续线', '浪5仍在延长或更大级别趋势延续，“五浪已完成”需重估');
        secondaryPivot = lvl(p[4].price, '浪4终点·同级调整目标区', '进入浪4价格区，调整的常见目标已到');
      } else {
        [0.618, 1, 1.618].forEach(r => targets.push(tgt(p[4].price + d * r * l[0], `浪5=浪1×${r}`, r)));
        // 浪3已短于浪1时，浪5不得长于浪3（否则浪3成为最短，违反M5）——柳玉冬所称「上涨极限」
        if (l[2] < l[0]) targets.push(tgt(p[4].price + d * l[2], '浪5极限=浪4终点+浪3长度（浪3不能最短, P32/P44）', 1));
        targets.push(tgt(p[4].price + d * 0.7 * l[3], '衰竭5浪最低: 0.7×浪4 (P204)', 0.7));
        monitoringPivot = lvl(p[4].price, '浪4终点·浪5防线', '浪5可能已经结束或计数失效');
        secondaryPivot = lvl(p[3].price, '浪3终点·衰竭判定线', '浪5越过浪3终点、不是衰竭5浪；始终未越过则浪5至少需达浪4的0.7倍（P204）');
      }
    } else if (type === 'ZIGZAG' || type === 'FLAT') {
      const flat = type === 'FLAT';
      if (n === 3) {
        if (flat) {
          targets.push(tgt(p[1].price - d * 0.7 * l[0], 'b浪最低要求: 0.7×a浪总量(P234)', 0.7));
          [0.95, 1.236, 1.382].forEach(r => targets.push(tgt(p[1].price - d * r * l[0], `b浪=a浪×${r}`, r)));
          monitoringPivot = lvl(p[1].price - d * 2 * l[0], 'b浪上限: 2×a浪总量(P235)', 'b浪超过a浪2倍，平台形计数失效（P235）');
          secondaryPivot = lvl(p[0].price, 'a浪起点·参照位', 'b浪越过a浪起点，转入扩散/顺势平台形讨论');
        } else {
          targets.push(tgt(p[1].price - d * 0.2 * l[0], 'b浪最低要求: 0.2×a浪(P213)', 0.2));
          [0.382, 0.5, 0.618].forEach(r => targets.push(tgt(p[1].price - d * r * l[0], `b浪回撤a浪×${r}`, r)));
          monitoringPivot = lvl(p[0].price, 'a浪起点·b浪禁区', 'b浪越过a浪起点，单锯齿计数失效（手稿P213）');
        }
      } else if (status === 'COMPLETED') {
        const total = Math.abs(p[3].price - p[0].price);
        [0.382, 0.5, 0.618].forEach(r => targets.push(tgt(p[3].price - d * r * total, `调整整体回撤×${r}`, r)));
        monitoringPivot = lvl(p[3].price, 'c浪终点·结构防线', 'c浪仍在延长，“调整已完成”需重估');
        secondaryPivot = lvl(p[2].price, 'b浪终点·调整结束确认线', '该调整大概率已经结束');
      } else {
        targets.push(tgt(p[2].price + d * 0.9 * l[1], 'c浪最低要求: 0.9×b浪(P213)', 0.9));
        targets.push(tgt(p[1].price, 'a浪终点（c浪通常越过）', null));
        [0.618, 1, 1.618].forEach(r => targets.push(tgt(p[2].price + d * r * l[0], `c=a×${r}`, r)));
        targets.push(tgt(p[1].price + d * 0.618 * l[0], 'a终点+0.618×a (P214)', 0.618));
        monitoringPivot = lvl(p[2].price, 'b浪终点·c浪起点防线', 'c浪计数失效，调整大概率已结束（监测点战法）');
        secondaryPivot = lvl(p[0].price, 'a浪起点·反转确认线', '确认原趋势已经反转');
      }
    } else if (type === 'TRIANGLE') {
      if (n === 3) {
        [0.618, 0.786, 1].forEach(r => targets.push(tgt(p[1].price - d * r * l[0], `b浪≈${r}×a浪`, r)));
        targets.push(tgt(p[1].price - d * 0.5 * l[0], 'b浪最低要求: 0.5×a浪(P302)', 0.5));
        monitoringPivot = lvl(p[1].price - d * 1.5 * l[0], 'b浪上限: 1.5×a浪(P302/P310)', 'b浪超过a浪1.5倍则三角形假设作废');
      } else if (n === 4) {
        targets.push(tgt(p[2].price + d * 0.618 * l[0], 'c浪≈0.618×a浪(P327)', 0.618));
        targets.push(tgt(p[2].price + d * 0.786 * l[0], 'c浪≈0.786×a浪', 0.786));
        monitoringPivot = lvl(p[1].price, 'b浪起点·c浪禁区', 'c浪大于b浪，三角形计数失效（手稿P302）');
      } else if (n === 5) {
        [0.618, 0.786].forEach(r => targets.push(tgt(p[3].price - d * r * l[1], `d浪≈${r}×b浪`, r)));
        monitoringPivot = lvl(p[2].price, 'c浪终点·d浪禁区', 'd浪超过c浪，三角形计数失效（手稿P302）');
      } else if (status !== 'COMPLETED') {
        targets.push(tgt(p[4].price + d * 0.7 * l[3], 'e浪≈0.7×d浪(P327)', 0.7));
        targets.push(tgt(p[4].price + d * 0.618 * l[2], 'e浪≈0.618×c浪(P327)', 0.618));
        monitoringPivot = lvl(p[3].price, 'd浪起点·e浪禁区', 'e浪超过d浪，三角形计数失效（手稿P302）');
        secondaryPivot = lvl(p[1].price, 'a浪终点·e浪区间边界', 'e浪进入a浪价格区间，满足三角形要求（手稿P345）');
      } else {
        const bdNow = lineVal(p[2].idx, p[2].price, p[4].idx, p[4].price, lastIdx);
        const height = Math.abs(lineVal(p[1].idx, p[1].price, p[3].idx, p[3].price, p[0].idx) -
          lineVal(p[2].idx, p[2].price, p[4].idx, p[4].price, p[0].idx));
        targets.push(tgt(p[5].price - d * height, '突破目标=三角形高度(P349)', null));
        monitoringPivot = lvl(p[5].price, 'e浪终点·三角形防线', 'e浪仍在延长，“三角形已完成”需重估（手稿P352: 下一浪须从e浪终点起步）');
        secondaryPivot = lvl(bdNow, 'b-d趋势线·突破确认', '突破三角形，确认突破浪展开（手稿P349-350）；反扑回到区间内即判误');
      }
    } else if (type === 'EXPANDING_TRIANGLE') {
      if (n === 3) {
        [1, 1.272].forEach(r => targets.push(tgt(p[1].price - d * r * l[0], `b浪≈${r}×a浪（扩张）`, r)));
        monitoringPivot = lvl(p[1].price, 'a浪终点·c浪须越过此位', 'b浪继续延长不影响计数；c浪须越过a浪终点');
      } else if (n === 4) {
        targets.push(tgt(p[1].price, 'c浪最低要求: 越过a浪终点（扩张）', null));
        [1.272, 1.618].forEach(r => targets.push(tgt(p[2].price + d * r * l[1], `c浪≈${r}×b浪`, r)));
        monitoringPivot = lvl(p[2].price, 'b浪终点·c浪防线', '回到b浪终点之外则b浪尚未结束');
        secondaryPivot = lvl(p[1].price, 'a浪终点·发散要求', 'c浪越过a浪终点，a-c线发散');
      } else if (n === 5) {
        targets.push(tgt(p[2].price, 'd浪最低要求: 越过b浪终点（扩张）', null));
        [1.272, 1.618].forEach(r => targets.push(tgt(p[3].price - d * r * l[2], `d浪≈${r}×c浪`, r)));
        monitoringPivot = lvl(p[3].price, 'c浪终点·d浪防线', '越过c浪终点则c浪尚未结束');
        secondaryPivot = lvl(p[2].price, 'b浪终点·发散要求', 'd浪越过b浪终点，b-d线发散');
      } else if (status !== 'COMPLETED') {
        targets.push(tgt(p[4].price + d * 0.5 * l[3], 'e浪最低要求: 0.5×d浪', 0.5));
        [1, 1.272].forEach(r => targets.push(tgt(p[4].price + d * r * l[3], `e浪≈${r}×d浪（越过a-c线）`, r)));
        monitoringPivot = lvl(p[4].price, 'd浪终点·e浪防线', '越过d浪终点则d浪尚未结束');
      } else {
        monitoringPivot = lvl(p[5].price, 'e浪终点·扩张三角形防线', 'e浪仍在延长，扩张三角形已完成的判断需重估');
        secondaryPivot = lvl(p[4].price, 'd浪终点·反向确认线', '越过d浪终点，确认扩张三角形结束、下一浪展开');
      }
    } else if (type === 'COMBINATION' || type === 'TRIPLE_COMBINATION') {
      // 三重形态只画到 y 浪 (n<5) 时，与双重形态的 w-x-y 取点相同
      const triple = type === 'TRIPLE_COMBINATION' && n >= 5;
      if (type === 'TRIPLE_COMBINATION' && n === 4) status = 'RUNNING';
      if (!triple && n === 3) {
        targets.push(tgt(p[1].price - d * 0.7 * l[0], 'x浪最低要求: 0.7×w浪(P50)', 0.7));
        [1.0, 1.382].forEach(r => targets.push(tgt(p[1].price - d * r * l[0], `x=w×${r}`, r)));
        monitoringPivot = lvl(p[1].price - d * 1.5 * l[0], 'x浪上限: 1.5×w浪总量(P301)', 'x浪超过w浪1.5倍，联合形计数失效（P301）');
        secondaryPivot = lvl(p[0].price, 'w浪起点·参照位', 'x浪越过w浪起点，转入顺势联合形讨论');
      } else if (!triple && status !== 'COMPLETED') {
        [0.786, 1, 1.272].forEach(r => targets.push(tgt(p[2].price + d * r * l[0], `y=w×${r}(扩展取点0-w-x, P131)`, r)));
        monitoringPivot = lvl(p[2].price, 'x浪终点·y浪起点防线', 'y浪计数失效（x浪尚未结束）');
        secondaryPivot = lvl(p[0].price, 'w浪起点·箱型边界', '离开箱型区间，横向整理外观被破坏（P50）');
      } else if (triple && n === 5) {
        targets.push(tgt(p[3].price - d * 0.7 * l[2], 'xx浪最低要求: 0.7×y浪(P51)', 0.7));
        targets.push(tgt(p[3].price - d * 1.0 * l[2], 'xx=y×1', 1));
        monitoringPivot = lvl(p[3].price - d * 1.5 * l[2], 'xx浪上限: 1.5×y浪总量(P301类推)', 'xx浪超过y浪1.5倍，三重横向整理计数失效');
      } else if (triple && status !== 'COMPLETED') {
        targets.push(tgt(p[4].price + d * 1.0 * l[2], 'z=y×1（扩展取点x-y-xx, P132)', 1));
        targets.push(tgt(p[4].price + d * 0.786 * l[2], 'z=y×0.786', 0.786));
        monitoringPivot = lvl(p[4].price, 'xx浪终点·z浪起点防线', 'z浪计数失效（xx浪尚未结束）');
        secondaryPivot = lvl(p[2].price, 'y浪起点·参照位', '回到y浪起点，y浪被完全回撤');
      } else {
        const end = p[n - 1].price, total = Math.abs(end - p[0].price);
        [0.382, 0.5, 0.618].forEach(r => targets.push(tgt(end - d * r * total, `整体回撤×${r}`, r)));
        monitoringPivot = lvl(end, `${triple ? 'z' : 'y'}浪终点·结构防线`, '横向整理仍在延长，“已完成”需重估');
        secondaryPivot = lvl(p[n - 2].price, `${triple ? 'xx' : 'x'}浪终点·确认线`, '该调整大概率已经结束');
      }
    } else if (type === 'DOUBLE_ZIGZAG' || type === 'TRIPLE_ZIGZAG') {
      const triple = type === 'TRIPLE_ZIGZAG' && n >= 5;
      if (type === 'TRIPLE_ZIGZAG' && n === 4) status = 'RUNNING';
      if (n === 3) {
        [0.382, 0.5, 0.618].forEach(r => targets.push(tgt(p[1].price - d * r * l[0], `x浪回撤w浪×${r}`, r)));
        targets.push(tgt(p[1].price - d * 0.2 * l[0], 'x浪最低要求: 0.2×w浪(P362)', 0.2));
        monitoringPivot = lvl(p[0].price, 'w浪起点·x浪禁区', '手稿P362: x浪及其子浪不能超过w浪起点');
      } else if (!triple && n === 4 && status !== 'COMPLETED') {
        targets.push(tgt(p[2].price + d * 0.9 * l[0], 'y浪最低要求: 0.9×w浪(P372)', 0.9));
        [1, 1.618].forEach(r => targets.push(tgt(p[2].price + d * r * l[0], `y=w×${r}`, r)));
        monitoringPivot = lvl(p[2].price, 'x浪终点·y浪禁区', 'y浪计数失效（手稿P372）');
        secondaryPivot = lvl(lineVal(p[0].idx, p[0].price, p[2].idx, p[2].price, lastIdx), '0-x基线', 'y浪越过0-x基线，双锯齿计数失效（手稿P362）');
      } else if (triple && n === 5) {
        [0.3, 0.5, 0.618].forEach(r => targets.push(tgt(p[3].price - d * r * l[2], `xx浪回撤y浪×${r}`, r)));
        monitoringPivot = lvl(p[2].price, 'y浪起点·xx禁区', 'xx浪越过y浪起点，三锯齿计数失效（手稿P385）');
      } else if (triple && status !== 'COMPLETED') {
        targets.push(tgt(p[4].price + d * 0.9 * l[1], 'z浪最低要求: 0.9×x浪', 0.9));
        [1, 1.618].forEach(r => targets.push(tgt(p[4].price + d * r * l[2], `z=y×${r}`, r)));
        monitoringPivot = lvl(p[4].price, 'xx终点·z浪防线', 'z浪计数失效（xx浪尚未结束）');
        secondaryPivot = lvl(p[2].price, 'y浪起点', '回到y浪起点，y浪被完全回撤');
      } else {
        const end = p[n - 1].price, total = Math.abs(end - p[0].price);
        [0.382, 0.5, 0.618].forEach(r => targets.push(tgt(end - d * r * total, `整体回撤×${r}`, r)));
        monitoringPivot = lvl(end, `${triple ? 'z' : 'y'}浪终点·结构防线`, '联合调整仍在延长，“已完成”需重估');
        secondaryPivot = lvl(p[n - 2].price, `${triple ? 'xx' : 'x'}浪终点·确认线`, '该调整大概率已经结束');
      }
    }
    return { monitoringPivot, secondaryPivot, targets };
  }

  /**
   * 给监测点标注方向与状态。
   * side: 'below' = 价位在下方，跌破即触发；'above' = 价位在上方，上破即触发。
   * 方向以最后一个拐点那根K线的收盘价为参照 (失效位按构造尚未被越过)，
   * breached = 最后拐点之后是否已有K线越过该价位。
   */
  function annotateLevel(lv, role, g, ev) {
    if (!lv || !isFinite(lv.price)) return lv;
    const bars = ev.bars;
    const lastIdx = bars.length - 1;
    const pIdx = Math.min(lastIdx, Math.max(0, g.p[g.p.length - 1].idx));
    let ref = bars[pIdx].close;
    if (Math.abs(ref - lv.price) <= EPS) ref = bars[lastIdx].close;
    const side = lv.price < ref ? 'below' : 'above';
    let breached = false;
    for (let i = pIdx + 1; i <= lastIdx; i++) {
      if (side === 'below' ? bars[i].low < lv.price - EPS : bars[i].high > lv.price + EPS) { breached = true; break; }
    }
    const last = bars[lastIdx].close;
    return Object.assign({}, lv, {
      role, side, breached,
      verb: side === 'below' ? '跌破' : '上破',
      distancePct: +((lv.price / last - 1) * 100).toFixed(2)
    });
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
    if (type === 'EXPANDING_TRIANGLE' && n >= 5) {
      return {
        type: 'CONVERGING',
        upperLine: { pA: pt(p[1]), pB: pt(p[3]) },
        lowerLine: { pA: pt(p[2]), pB: pt(p[4]) },
        note: '扩张三角形边界发散线: a-c 与 b-d（仅供视觉参考，非波浪判定标准）'
      };
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
  // 6.5 时间窗 (把手稿时间硬规则变成前瞻截止日期)
  //     硬规则在搜索时已作过滤；这里对「运行中的那一浪」反推最晚结束时间，
  //     对应柳玉冬「b浪应该在4月7日之前结束」「三角形交叉点在8月26日，必须在此之前突破」。
  // ---------------------------------------------------------------------------

  /** 运行中的最后一浪: 由硬时间规则给出的最晚结束K线数 (相对该浪起点) */
  const TIME_DEADLINES = {
    IMPULSE: { 3: [['浪2', 'M7', 'P34', g => 9 * g.t[0], '浪2用时不超过浪1的9倍']], 5: [['浪4', 'M8', 'P43', g => 2 * g.t[2], '浪4用时不超过浪3的2倍']] },
    DIAGONAL: { 3: [['浪2', 'M7', 'P34', g => 9 * g.t[0], '浪2用时不超过浪1的9倍']], 5: [['浪4', 'M8', 'P43', g => 2 * g.t[2], '浪4用时不超过浪3的2倍']] },
    ZIGZAG: { 3: [['b浪', 'Z5', 'P215', g => 10 * g.t[0], 'b浪用时不超过a浪的10倍']], 4: [['c浪', 'Z6', 'P215', g => 10 * (g.l[0] <= g.l[1] ? g.t[0] : g.t[1]), 'c浪用时不超过a、b中较短者的10倍']] },
    FLAT: { 3: [['b浪', 'F6', 'P236', g => 10 * g.t[0], 'b浪用时不超过a浪的10倍']], 4: [['c浪', 'F7', 'P236', g => 10 * (g.l[0] <= g.l[1] ? g.t[0] : g.t[1]), 'c浪用时不超过a、b中较短者的10倍']] },
    TRIANGLE: { 5: [['d浪', 'T13', 'P302', g => 4 * g.t[2], 'd浪用时不大于c浪的4倍']], 6: [['e浪', 'T14', 'P302', g => 4 * g.t[3], 'e浪用时不大于d浪的4倍']] },
    DOUBLE_ZIGZAG: { 3: [['x浪', 'W6', 'P362', g => 5 * g.t[0], 'x浪用时不超过w浪的5倍']], 4: [['y浪', 'W7', 'P364', g => 5 * g.t[0], 'y浪用时不超过w浪的5倍']] },
    TRIPLE_ZIGZAG: { 5: [['xx浪', 'X5', 'P385', g => 5 * g.t[2], 'xx浪用时不超过y浪的5倍']], 6: [['z浪', 'X6/X7', 'P365', g => 5 * Math.min(g.t[2], g.t[0]), 'z浪用时不超过y浪、w浪的5倍']] },
    COMBINATION: { 3: [['x浪', 'C3', 'P297', g => 10 * g.t[0], 'x浪用时不超过w浪的10倍']], 4: [['y浪', 'C4', 'P297', g => 10 * g.t[0], 'y浪用时不超过w浪的10倍']] },
    TRIPLE_COMBINATION: { 5: [['xx浪', 'C7', 'P297', g => 10 * g.t[2], 'xx浪用时不超过y浪的10倍']], 6: [['z浪', 'C8', 'P297', g => 10 * g.t[2], 'z浪用时不超过y浪的10倍']] }
  };

  /** 运行中的最后一浪: 时间指引给出的常见结束窗口 (相对该浪起点的K线数 [lo, hi]) */
  const TIME_TYPICAL = {
    IMPULSE: { 4: ['浪3', '柳玉冬实战（黄金2026-02-03「3浪时间到达1浪的1.618倍是正常的」）', g => [g.t[0], 1.618 * g.t[0]]], 6: ['浪5', '通用（浪5常与浪1用时相当）', g => [0.618 * g.t[0], 1.618 * g.t[0]]] },
    ZIGZAG: { 3: ['b浪', 'ZG6 P215', g => [0.618 * g.t[0], 1.618 * g.t[0]]], 4: ['c浪', 'ZG7 P215', g => { const mt = g.l[0] <= g.l[1] ? g.t[0] : g.t[1]; return [0.618 * g.t[0], 1.618 * mt]; }] },
    FLAT: { 4: ['c浪', 'FG4 P236', g => { const mt = g.l[0] <= g.l[1] ? g.t[0] : g.t[1]; return [0.618 * mt, 1.618 * mt]; }] },
    DOUBLE_ZIGZAG: { 3: ['x浪', 'WG3 P363', g => [0.618 * g.t[0], 1.618 * g.t[0]]], 4: ['y浪', 'WG4 P365', g => [0.618 * g.t[0], 1.618 * g.t[0]]] }
  };

  function barSeconds(ev) {
    const b = ev && ev.bars;
    if (!b || b.length < 2) return 0;
    const diffs = [];
    for (let i = Math.max(1, b.length - 50); i < b.length; i++) diffs.push(b[i].time - b[i - 1].time);
    diffs.sort((x, y) => x - y);
    return diffs[Math.floor(diffs.length / 2)] || 0;
  }
  function fmtDate(sec) {
    const d = new Date(sec * 1000);
    const p = x => String(x).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  }

  function buildTimeWindows(type, g, status, ev) {
    const out = [];
    const sec = barSeconds(ev);
    if (!sec || !ev.bars) return out;
    const n = g.p.length;
    const lastIdx = ev.bars.length - 1;
    const lastTime = ev.bars[lastIdx].time;
    const legStart = g.p[n - 2];
    const running = status !== 'COMPLETED';
    const toTime = bars => legStart.time + Math.round(bars) * sec;

    if (running) {
      for (const [wave, rule, page, fn, text] of ((TIME_DEADLINES[type] || {})[n] || [])) {
        const maxBars = fn(g);
        const deadline = toTime(maxBars);
        const barsLeft = Math.round((deadline - lastTime) / sec);
        out.push({
          kind: 'deadline', wave, rule, page, maxBars: Math.round(maxBars), deadline, barsLeft,
          text: `时间规则（${rule}·手稿${page}）：${text}，${wave}须在 ${fmtDate(deadline)} 前结束（还剩约 ${Math.max(0, barsLeft)} 根K线），逾期则本计数作废`
        });
      }
      const typ = (TIME_TYPICAL[type] || {})[n];
      if (typ) {
        const [wave, src, fn] = typ;
        const [lo, hi] = fn(g);
        const overdue = lastTime > toTime(hi);
        out.push({
          kind: 'typical', wave, rule: src, from: toTime(lo), to: toTime(hi), overdue,
          text: `时间指引（${src}）：${wave}常见在 ${fmtDate(toTime(lo))} ~ ${fmtDate(toTime(hi))} 之间结束${overdue ? '；目前已超出常见窗口，该浪偏长（延长或计数需复核）' : ''}`
        });
      }
    }
    // 收缩三角形: a-c 与 b-d 交点 (柳玉冬「交叉点在8月26日，必须在此之前突破」)
    if (type === 'TRIANGLE' && n >= 5) {
      const p = g.p;
      const sAc = (p[3].price - p[1].price) / (p[3].idx - p[1].idx);
      const sBd = (p[4].price - p[2].price) / (p[4].idx - p[2].idx);
      if (Math.abs(sAc - sBd) > 1e-12) {
        const apexIdx = (p[2].price - sBd * p[2].idx - (p[1].price - sAc * p[1].idx)) / (sAc - sBd);
        const apexTime = ev.bars[Math.min(lastIdx, Math.max(0, Math.round(apexIdx)))].time + Math.max(0, Math.round(apexIdx) - lastIdx) * sec;
        if (apexIdx > p[n - 1].idx) {
          out.push({
            kind: 'apex', wave: '三角形', rule: 'T10', page: 'P307', deadline: apexTime,
            barsLeft: Math.round((apexTime - lastTime) / sec),
            text: `三角形边界交点在 ${fmtDate(apexTime)}：须在此之前突破，越晚突破力度越弱`
          });
        }
      }
    }
    return out;
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
      DIAGONAL: { 3: '楔形浪2回撤中', 4: '楔形浪3运行中', 5: '楔形浪4运行中', 6: status === 'COMPLETED' ? '楔形完成' : '楔形浪5运行中' },
      ZIGZAG: { 3: 'b浪运行中', 4: status === 'COMPLETED' ? '锯齿完成' : 'c浪运行中' },
      FLAT: { 3: 'b浪运行中', 4: status === 'COMPLETED' ? '平台形完成' : 'c浪运行中' },
      TRIANGLE: { 3: 'b浪收敛中', 4: 'c浪收敛中', 5: 'd浪收敛中', 6: status === 'COMPLETED' ? '三角形完成·等待突破' : 'e浪收敛中' },
      EXPANDING_TRIANGLE: { 3: 'b浪扩张中', 4: 'c浪扩张中', 5: 'd浪扩张中', 6: status === 'COMPLETED' ? '扩张三角形完成' : 'e浪扩张中' },
      DOUBLE_ZIGZAG: { 3: 'x浪运行中', 4: status === 'COMPLETED' ? '双锯齿完成' : 'y浪运行中' },
      TRIPLE_ZIGZAG: { 3: 'x浪运行中', 4: 'y浪运行中', 5: 'xx浪运行中', 6: status === 'COMPLETED' ? '三锯齿完成' : 'z浪运行中' },
      COMBINATION: { 3: 'x浪运行中', 4: status === 'COMPLETED' ? '双重横向整理完成' : 'y浪运行中' },
      TRIPLE_COMBINATION: { 3: 'x浪运行中', 4: 'y浪运行中', 5: 'xx浪运行中', 6: status === 'COMPLETED' ? '三重横向整理完成' : 'z浪运行中' }
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
    // 楔形角色: 5-3-5-3-5 只能是引导楔形；3-3-3-3-3 按所处位置区分引导 / 终结
    let diagRole = null;
    const structNotes = [];
    const hasEv = !!(ev && ev.bars);
    const legSt = li => (hasEv && li + 1 < n ? legStructure(g, li, ev) : null);
    if (h.type === 'DIAGONAL') {
      const pos = diagonalRole(g, ev);
      const odd = [0, 2, 4].filter(li => !(h.status !== 'COMPLETED' && li + 1 === n - 1)).map(legSt).filter(st => st && st.label !== 'unknown');
      const all5 = odd.length >= 2 && odd.every(st => st.label === '5');
      const all3 = odd.length >= 2 && odd.every(st => st.label === '3');
      diagRole = all5 ? 'LEADING' : pos;
      const shape = n >= 4 ? (g.l[2] < g.l[0] ? '收缩' : '扩散') : '';
      const base = diagRole === 'LEADING' ? '引导楔形' : diagRole === 'ENDING' ? '终结楔形' : '楔形';
      subtype = `${shape}${base}${all5 ? '（5-3-5-3-5）' : all3 ? '（3-3-3-3-3）' : ''}`;
      if (all5 && pos === 'ENDING') structNotes.push('5-3-5-3-5 只能是引导楔形，但所处位置像趋势末端');
      if (!diagRole) structNotes.push('位置不明：处于新趋势起点则为引导楔形，处于同向趋势末端则为终结楔形');
    } else if (hasEv && (h.type === 'IMPULSE' || h.type === 'ZIGZAG' || h.type === 'FLAT')) {
      const isImp = h.type === 'IMPULSE';
      const first = isImp || h.type === 'ZIGZAG' ? legSt(0) : null;
      const last = legSt(isImp ? 4 : 2);
      if (first && first.motive === 'DIAGONAL') structNotes.push(`${isImp ? '浪1' : 'a浪'}为引导楔形`);
      if (last && last.motive === 'DIAGONAL') structNotes.push(`${isImp ? '浪5' : 'c浪'}为终结楔形`);
    }
    if (h.type === 'IMPULSE' && h.status === 'COMPLETED' && truncatedFifth(g)) structNotes.push('失败第五浪');

    const stage = stageText(h.type, n, h.status);
    const noteTxt = structNotes.filter(x => !/^位置不明|^5-3-5-3-5/.test(x)).join('·');
    const name = `${subtype ? subtype : def.name}（${dirTxt}·${stage}${noteTxt ? '·' + noteTxt : ''}）`;

    const metrics = {};
    if (h.type === 'IMPULSE' || h.type === 'DIAGONAL') {
      metrics.retrace_2 = +(g.l[1] / g.l[0]).toFixed(3);
      if (n >= 4) metrics.ratio_3_1 = +(g.l[2] / g.l[0]).toFixed(3);
      if (n >= 5) metrics.retrace_4 = +(g.l[3] / g.l[2]).toFixed(3);
      if (n >= 6) metrics.ratio_5_1 = +(g.l[4] / g.l[0]).toFixed(3);
    } else if (h.type === 'ZIGZAG' || h.type === 'FLAT') {
      metrics.retrace_B = +(g.l[1] / g.l[0]).toFixed(3);
      if (n >= 4) metrics.ratio_C_A = +(g.l[2] / g.l[0]).toFixed(3);
    } else if (h.type === 'TRIANGLE' || h.type === 'EXPANDING_TRIANGLE') {
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
    if (h.status === 'COMPLETED') {
      // 终结楔形结束后通常急速回到楔形起点；引导楔形之后的浪2常深回撤 (EWI)
      const endDiagStart = h.type === 'DIAGONAL' && diagRole === 'ENDING' ? g.p[0]
        : structNotes.includes('浪5为终结楔形') ? g.p[4]
          : structNotes.includes('c浪为终结楔形') ? g.p[2] : null;
      if (endDiagStart) {
        levels.targets.unshift(tgt(endDiagStart.price, '终结楔形起点：楔形结束后常急速回到此处（EWI）', null));
      } else if (h.type === 'DIAGONAL' && diagRole === 'LEADING') {
        const total = Math.abs(g.p[n - 1].price - g.p[0].price);
        [0.618, 0.786].forEach(r => levels.targets.unshift(tgt(g.p[n - 1].price - g.d * r * total, `引导楔形后浪2常深回撤×${r}（EWI）`, r)));
      }
    }
    if (ev && ev.bars && h.status === 'COMPLETED' && !/TRIANGLE/.test(h.type)) {
      // 柳玉冬「必须跌破4944才能确认橙线结束」: 结束确认看最后一浪内部最后一个小级别回撤点，
      // 主级别结构位 (浪4 / b浪终点) 保留为更大级别确认
      const st = legStructure(g, n - 2, ev);
      const sub = st.subPivots || [];
      const startType = g.p[n - 2].type;
      let near = null;
      for (let k = sub.length - 2; k >= 1; k--) {
        if (sub[k].type === startType) { near = sub[k]; break; }
      }
      const lastLabel = /^\d/.test(def.labels[n - 1]) ? `浪${def.labels[n - 1]}` : `${def.labels[n - 1]}浪`;
      if (near && Math.abs(near.price - g.p[n - 1].price) > EPS) {
        const far = levels.secondaryPivot;
        levels.secondaryPivot = lvl(near.price, `${lastLabel}内部最后回撤点·结束确认线`,
          `确认${lastLabel}已经结束${far ? `；再越过 ${fmtNum(far.price)}（${far.levelName}）则${def.category === '驱动浪' ? '确认更大级别调整展开' : '确认整个调整结束、原趋势恢复'}` : ''}`);
        levels.structuralPivot = far || null;
      }
    }
    if (ev && ev.bars) {
      levels.monitoringPivot = annotateLevel(levels.monitoringPivot, 'invalidation', g, ev);
      levels.secondaryPivot = annotateLevel(levels.secondaryPivot, h.status === 'COMPLETED' ? 'confirmation' : 'reference', g, ev);
    }
    const timeWindows = ev && ev.bars ? buildTimeWindows(h.type, g, h.status, ev) : [];
    const fibLevels = buildFibLevels(h.type, g, h.status);
    const slimClass = c => c ? {
      text: describeClass(c), form: c.form, complexity: c.complexity, developing: c.developing, source: c.source,
      alive: c.alive.map(a => ({ type: a.type, name: a.name, form: a.form, complexity: a.complexity, score: a.score, complete: a.complete, points: a.points }))
    } : null;
    let alternation = null, components = null;
    if ((h.type === 'IMPULSE' || h.type === 'DIAGONAL') && ev && ev.bars && n >= 4) {
      const alt = alternationFor(g, ev);
      if (alt) {
        alternation = {
          pass: alt.pass === undefined ? null : alt.pass, basis: alt.basis || null, text: alt.text,
          wave2: Object.assign({}, alt.wave2, { class: slimClass(alt.wave2.class) }),
          wave4: alt.wave4 ? Object.assign({}, alt.wave4, { class: slimClass(alt.wave4.class) }) : null,
          expectWave4: alt.expectWave4 || null
        };
      }
    }
    if (/COMBINATION|ZIGZAG/.test(h.type) && h.type !== 'ZIGZAG' && ev && ev.bars) {
      const comps = combinationComponents(h.type, g, ev, h.status);
      if (comps) components = comps.map(c => ({ label: c.label, developing: c.developing, text: c.text, class: slimClass(c.class) }));
    }

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
      structureNotes: structNotes, diagonalRole: diagRole,
      metrics, rules, ruleChecks: evalRes.checks.map(c => ({ id: c.id, category: CAT_NAMES[c.cat], page: c.page, text: c.text, hard: c.hard, pass: c.pass, pending: c.pending, detail: c.detail })),
      pendingCount: evalRes.pending.length,
      guidePct: evalRes.guide.weight ? Math.round(100 * evalRes.guide.weightGot / evalRes.guide.weight) : 0,
      channel: buildChannel(h.type, g),
      monitoringPivot: levels.monitoringPivot,
      secondaryPivot: levels.secondaryPivot,
      structuralPivot: levels.structuralPivot || null,
      targets: levels.targets,
      fibLevels,
      alternation,
      components,
      timeWindows,
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
      const side = mp.verb || (mp.price < currentPrice ? '跌破' : '上破');
      bottomTopSignal = `失效位 $${fmtNum(mp.price)}（${mp.levelName}）：${side}则${mp.description || '当前计数失效'}。现价 ${fmtNum(currentPrice)}。`;
      const sp = pattern.secondaryPivot;
      if (sp && isFinite(sp.price)) bottomTopSignal += ` 确认位 $${fmtNum(sp.price)}（${sp.levelName}）${sp.description ? '：' + sp.description : ''}。`;
      const dl = (pattern.timeWindows || []).find(w => w.kind === 'deadline' || w.kind === 'apex');
      if (dl) bottomTopSignal += ` ${dl.text}。`;
    } else {
      bottomTopSignal = `现价 ${fmtNum(currentPrice)}：该形态暂无明确监测点。`;
    }
    const liuLines = analysis?.liuSignals ? analysis.liuSignals.lines.slice(0, 3) : [];
    return { title: `${symbol} ${tf} 波浪理论研判`, thesis, bottomTopSignal, liuLines, quote };
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
        { price: O.price + d * 0.618 * D, effect: '到达0.618：三角形b浪解释具备（TG1）', rule: 'TG1', soft: true, crossed: (X.price - (O.price + d * 0.618 * D)) * d >= 0 },
        { price: O.price + d * 0.7 * D, effect: '吃掉前段0.7：平台形/联合形解释成立（F1/C1），前段方向一方失败', rule: 'F1/C1', soft: true, crossed: (X.price - (O.price + d * 0.7 * D)) * d >= 0 },
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
  // 8.6 柳玉冬实战信号层 (语料 2026-01~08 按标的串联后反复出现、可形式化的判据)
  //     以主级别最后两段腿为对象，不依赖候选计数:
  //       前段 P→O (已完成)  |  当前段 O→X (X为运行中极值)  |  X之后的反向回撤
  //   1. 监测点战法: 当前段内最近一个小级别反向拐点，逐日随趋势上移/下移
  //   2. 最大回撤判据: 反向回撤量超过当前段内部最大回撤 → 小级别见顶/底
  //   3. 吃掉0.618/0.7/0.8: 当前段对前段的回撤比例 → 前段性质(锯齿 / 三角形 / 平台形·联合形)
  //   4. 调整分部投射: 若前段为调整第一部分(a/w)，各调整浪型对第二部分的要求
  //   5. 出身: 当前段非五浪 → 不作新趋势起点，只剩引导楔形可能(列出条件)
  // ---------------------------------------------------------------------------

  /**
   * 区间 (i0,i1] 内逆 d 方向的最大回撤 (bar 级)，返回 {amount, fromIdx, toIdx, toPrice}。
   * 以起点拐点价 startPrice 为初始极值: 起点K线的另一端影线发生在拐点之前，不属于本段。
   */
  function maxCounterMove(highs, lows, i0, i1, d, startPrice) {
    let best = { amount: 0, fromIdx: i0, toIdx: i0, toPrice: startPrice };
    let extIdx = i0, ext = startPrice;
    for (let i = i0 + 1; i <= i1 && i < highs.length; i++) {
      if (d > 0 ? highs[i] > ext : lows[i] < ext) { ext = d > 0 ? highs[i] : lows[i]; extIdx = i; }
      const dd = d > 0 ? ext - lows[i] : highs[i] - ext;
      if (dd > best.amount) best = { amount: dd, fromIdx: extIdx, toIdx: i, toPrice: d > 0 ? lows[i] : highs[i] };
    }
    return best;
  }

  const PARTS_TABLE = [
    { pattern: '双锯齿', role: 'x', min: 0.2, typical: 0.382, max: 1, need: 'x浪0.2~0.618即可，不必到0.618（W1/WG1）', rules: 'W1/W2' },
    { pattern: '单锯齿', role: 'b', min: 0.2, typical: 0.5, max: 1, need: 'b浪0.2~<1（Z1/Z2）', rules: 'Z1/Z2' },
    { pattern: '收缩三角形', role: 'b', min: 0.5, typical: 0.618, max: 1.5, need: 'b浪常达0.618（硬性≥0.5, ≤1.5; T1/T2/TG1）', rules: 'T1/T2' },
    { pattern: '平台形', role: 'b', min: 0.7, typical: 1, max: 2, need: 'b浪须≥0.7（F1），<2（F2）', rules: 'F1/F2' },
    { pattern: '联合形', role: 'x', min: 0.7, typical: 1, max: 1.5, need: 'x浪须≥0.7（C1），≤1.5（C2）', rules: 'C1/C2' }
  ];

  // 监测点的子浪级别候选 (本段幅度的倍数，由粗到细)
  const MONITOR_DEGREE_MULTS = [0.30, 0.236, 0.18, 0.14, 0.10, 0.07, 0.05];

  function buildLiuSignals(slice, pivs, ev) {
    const n = pivs ? pivs.length : 0;
    if (n < 3 || !slice || !slice.length) return null;
    const highs = ev.highs, lows = ev.lows;
    const lastIdx = slice.length - 1;
    const X = pivs[n - 1], O = pivs[n - 2], P = pivs[n - 3];
    const d = X.price > O.price ? 1 : -1;
    const S = Math.abs(X.price - O.price);
    const Lp = Math.abs(O.price - P.price);
    const upTxt = d > 0 ? '上涨' : '下跌';
    const dn = d > 0 ? '跌破' : '涨破';
    const lastClose = slice[lastIdx].close;
    const beyond = (price, lvl) => d * (lvl - price) > 0; // 价格是否已越过(逆当前段方向)该位

    // 1. 当前段内最大回撤 & X之后的回撤
    const inner = maxCounterMove(highs, lows, O.idx, X.idx, d, O.price);
    let after = 0, afterIdx = X.idx;
    for (let i = X.idx + 1; i <= lastIdx; i++) {
      const v = d > 0 ? X.price - lows[i] : highs[i] - X.price;
      if (v > after) { after = v; afterIdx = i; }
    }
    const thresholdLevel = X.price - d * inner.amount;
    const exceeded = inner.amount > 0 && after > inner.amount + EPS;
    const largestCounterMove = {
      innerMax: +inner.amount.toFixed(4),
      innerMaxLow: +inner.toPrice.toFixed(4),
      innerMaxTime: slice[inner.toIdx] ? slice[inner.toIdx].time : null,
      currentPullback: +after.toFixed(4),
      thresholdLevel: +thresholdLevel.toFixed(4),
      exceeded,
      text: inner.amount > 0
        ? (exceeded
          ? `自极值 ${fmtNum(X.price)} 的回撤 ${fmtNum(after)} 已大于本段内最大回撤 ${fmtNum(inner.amount)}：本段${upTxt}很小级别见${d > 0 ? '顶' : '底'}（柳氏「最大回撤」判据）`
          : `回撤量不大于 ${fmtNum(inner.amount)}（即不${dn} ${fmtNum(thresholdLevel)}）之前，本段${upTxt}仍有动力`)
        : `本段为单边推进，无内部回撤可参照`
    };

    // 2. 监测点战法: 当前段内小级别拐点(逐日上移)
    //    子浪级别取「自然子级别」: 由粗到细第一个能把本段分出 ≥3 段的阈值 (与子浪探测一致)。
    //    语料回放 (scripts/liu_threads/monitor_roles.js, 按时间前 60% 训练 / 后 40% 检验) 中，
    //    它比固定的「本段幅度 6%」更有用: 检验段有用率 47.1% → 54.9%，破位准确率 40.9% → 47.2%。
    const seg = slice.slice(O.idx, X.idx + 1);
    let monitor = null;
    if (seg.length >= 4) {
      const segAtr = avgTR(seg) || S / seg.length;
      const anchor = zp0 => anchorZigzag(zp0,
        { idx: 0, time: O.time, price: O.price, type: O.type },
        { idx: seg.length - 1, time: X.time, price: X.price, type: X.type });
      let zp = null, lastThr = null;
      for (const m of MONITOR_DEGREE_MULTS) {
        const thr = Math.max(0.8 * segAtr, m * S);
        if (thr === lastThr) continue;
        lastThr = thr;
        const cand = anchor(zigzagPivots(seg, thr));
        if (cand.length - 1 >= 3) { zp = cand; break; }
      }
      if (!zp) zp = anchor(zigzagPivots(seg, Math.max(0.8 * segAtr, 0.06 * S)));
      for (let k = zp.length - 2; k >= 1; k--) {
        if (zp[k].type === O.type) { monitor = { price: zp[k].price, time: zp[k].time, idx: O.idx + zp[k].idx }; break; }
      }
    }
    if (!monitor) monitor = { price: O.price, time: O.time, idx: O.idx };
    const monitorBroken = beyond(lastClose, monitor.price) || (d > 0 ? lows : highs).slice(X.idx + 1).some(v => beyond(v, monitor.price));
    const confirmLevel = inner.amount > 0 ? inner.toPrice : O.price;
    const confirmBroken = beyond(lastClose, confirmLevel);
    const monitorPoint = {
      price: +monitor.price.toFixed(4), time: monitor.time,
      side: d > 0 ? 'below' : 'above',
      status: confirmBroken ? 'CONFIRMED_END' : monitorBroken ? 'BROKEN' : 'HOLDING',
      confirmLevel: +confirmLevel.toFixed(4),
      text: confirmBroken
        ? `已${dn}确认位 ${fmtNum(confirmLevel)}：本段${upTxt}结束，进入针对本段的${d > 0 ? '回撤' : '反弹'}`
        : monitorBroken
          ? `监测点 ${fmtNum(monitor.price)} 已${dn}：小级别见${d > 0 ? '顶' : '底'}；须${dn} ${fmtNum(confirmLevel)} 才确认本段结束`
          : `监测点 ${fmtNum(monitor.price)}：不${dn}认为继续${d > 0 ? '涨' : '跌'}；${dn} ${fmtNum(confirmLevel)} 才确认本段结束`
    };

    // 3. 吃掉前段的比例 (0.618 / 0.7 / 0.8 / 0.9 / 1)
    const ratio = Lp > 0 ? S / Lp : null;
    const eatLevels = [0.618, 0.7, 0.8, 0.9, 1].map(k => ({
      ratio: k, price: +(O.price + d * k * Lp).toFixed(4), reached: ratio !== null && ratio >= k - EPS
    }));
    let eatVerdict;
    if (ratio === null) eatVerdict = '前段长度为零，无法衡量';
    else if (ratio >= 1) eatVerdict = `当前段已收复前段起点（${(ratio * 100).toFixed(0)}%）：前段只能是调整浪或扩散平台形b浪，前段方向一方已失败`;
    else if (ratio >= 0.7) eatVerdict = `吃掉前段 ${(ratio * 100).toFixed(0)}% ≥ 0.7：平台形/联合形条件具备，前段按调整第一部分对待，${d > 0 ? '空头' : '多头'}基本就败了`;
    else if (ratio >= 0.618) eatVerdict = `回撤前段 ${(ratio * 100).toFixed(0)}%：达到三角形b浪常见值0.618；平台形/联合形尚需0.7（${fmtNum(eatLevels[1].price)}）`;
    else eatVerdict = `回撤前段 ${(ratio * 100).toFixed(0)}% < 0.618：仅支持单/双锯齿的b/x浪，前段方向仍占优`;
    const eatBack = { priorLeg: { from: P.price, to: O.price, fromTime: P.time, toTime: O.time }, ratio: ratio === null ? null : +ratio.toFixed(3), levels: eatLevels, verdict: eatVerdict };

    // 4. 调整分部投射: 前段 P→O 作为调整第一部分(a/w)时，第二部分的要求
    const partsProjector = Lp > 0 ? PARTS_TABLE.map(row => {
      const alive = ratio <= row.max + EPS;
      return {
        pattern: row.pattern, role: row.role, rules: row.rules, need: row.need,
        minPrice: +(O.price + d * row.min * Lp).toFixed(4),
        typicalPrice: +(O.price + d * row.typical * Lp).toFixed(4),
        maxPrice: +(O.price + d * row.max * Lp).toFixed(4),
        reachedMin: ratio >= row.min - EPS,
        alive,
        status: !alive ? '已否决（超出上限）' : ratio >= row.min - EPS ? '最低要求已满足' : `尚需到达 ${fmtNum(O.price + d * row.min * Lp)}`
      };
    }) : [];

    // 5. 出身: 当前段是否可数为五浪
    const st = computeLegStructure(O, X, ev);
    const subs = st.subPivots || [];
    const segLens = [];
    for (let i = 1; i < subs.length; i++) segLens.push(Math.abs(subs[i].price - subs[i - 1].price));
    let threeLegWarning = null;
    if (st.label === '3' && segLens.length === 3 && segLens[2] > 1.618 * segLens[0]) {
      threeLegWarning = `当前段走了3段且第三段为第一段的 ${(segLens[2] / segLens[0]).toFixed(2)} 倍（>1.618）：有发展为推动浪的危险`;
    }
    const origin = {
      structure: st.label, subSwings: segLens.length, source: st.source || null,
      canStartTrend: st.label === '5',
      text: st.label === '5'
        ? `当前段可数为五浪：具备${d > 0 ? '做底' : '做顶'}后新趋势起步的资格`
        : st.label === '3'
          ? `当前段不是推动浪：不看作新的${upTxt}，按对前段的${d > 0 ? '反弹' : '回调'}（调整浪）对待`
          : '当前段内部小级别数据不足，出身待确认',
      leadingDiagonal: st.label === '3' ? {
        mustHold: O.price, mustExceed: X.price,
        text: `若要${d > 0 ? '做底' : '做顶'}只剩引导楔形可能：须不${dn} ${fmtNum(O.price)}、再创${d > 0 ? '新高' : '新低'}越过 ${fmtNum(X.price)}，走满5段且边界不扩散`
      } : null
    };

    const lines = [monitorPoint.text, largestCounterMove.text, eatVerdict, origin.text];
    if (threeLegWarning) lines.push(threeLegWarning);
    if (origin.leadingDiagonal) lines.push(origin.leadingDiagonal.text);

    return {
      direction: d > 0 ? 'BULLISH' : 'BEARISH',
      activeLeg: { from: { price: O.price, time: O.time }, extreme: { price: X.price, time: X.time, open: !!X.open }, length: +S.toFixed(4) },
      monitorPoint, largestCounterMove, eatBack, partsProjector, origin, threeLegWarning,
      lines,
      note: '依据柳玉冬2026年微博按标的串联语料提炼（监测点战法/最大回撤/吃掉0.7/调整分部/非推动浪不做底），仅讨论波浪，不构成交易建议。'
    };
  }

  /** 在给定级别的拐点序列上搜索全部浪型假设 → 硬规则终审 → 候选 (未排序) */
  function collectCandidates(pivots, ev, sliceLen, rangeExtrema, precedingContext, blockMap) {
    const legOk = buildLegTable(pivots);
    const hyps = [];
    for (const type of Object.keys(PATTERNS)) {
      hyps.push.apply(hyps, searchPattern(type, pivots, legOk, ev, blockMap));
    }
    const seen = new Set();
    const cands = [];
    for (const h of hyps) {
      const key = h.type + '|' + h.idxs.join('-');
      if (seen.has(key)) continue;
      seen.add(key);
      const pts = h.idxs.map(i => pivots[i]);
      const evalRes = evaluatePattern(h.type, pts, ev);
      if (evalRes.hardFails.length) {
        const f = evalRes.hardFails[0];
        const key2 = h.type + '|' + f.id;
        if (!blockMap.has(key2)) blockMap.set(key2, { pattern: PATTERNS[h.type].name, rule: f, detail: f.detail, span: h.idxs[h.idxs.length - 1] - h.idxs[0] });
        continue;
      }
      const cand = buildCandidate(h, evalRes, ev, pivots);
      cand.score = scoreCandidate(cand, evalRes, sliceLen, rangeExtrema, precedingContext);
      cands.push(cand);
    }
    return cands;
  }

  /**
   * 级别阶梯 (柳玉冬多色嵌套画法: 大级别 → 本级别 → 当前段小级别)
   * 高一级别取主级别之后第一个更粗的 Zigzag 层 (拐点更少) 重新计数；
   * 低一级别为当前段 (最后一腿) 内部的子浪结构。
   */
  function buildDegreeLadder(degrees, top, liuSignals, ev, sliceLen, rangeExtrema, precedingContext) {
    const summarize = c => c ? {
      name: c.name, baseType: c.baseType, direction: c.direction, status: c.status, currentWave: c.currentWave,
      waveLabels: c.waveLabels, score: c.score,
      pivots: c.pivots.map(q => ({ time: q.time, price: q.price, type: q.type }))
    } : null;
    const ladder = [];
    const main = degrees.main;
    const mi = degrees.levels.indexOf(main);
    const maxHigher = Math.max(6, Math.round(main.pivots.length * 0.6));
    let higher = degrees.levels.slice(mi + 1).find(l => l.pivots.length >= 4 && l.pivots.length <= maxHigher);
    if (!higher) {
      // 主级别已是预设最粗层: 继续放大阈值寻找更大级别
      for (const k of [1.5, 2, 2.6, 3.4, 4.5]) {
        const thr = main.thr * k;
        const pv = zigzagPivots(ev.bars, thr);
        if (pv.length < 4) break;
        if (pv.length <= maxHigher) { higher = { mult: +(main.mult * k).toFixed(2), thr, pivots: pv }; break; }
      }
    }
    if (higher) {
      const hc = collectCandidates(higher.pivots, ev, sliceLen, rangeExtrema, precedingContext, new Map());
      // 嵌套优先: 本级别首选计数恰为高一级别最后一浪 (+20) 或落在其内 (+12)
      const sameAsTop = c => !!top && c.pivots.length === top.pivots.length && c.pivots.every((q, i) => q.time === top.pivots[i].time);
      const nestBonus = c => {
        if (!top) return 0;
        if (sameAsTop(c)) return 8; // 两级重合: 同一结构在更粗级别仍成立，但优先展示真正的上级嵌套
        const n = c.pivots.length, last = c.pivots[n - 1], prev = c.pivots[n - 2];
        const t0 = top.pivots[0].time, t1 = top.pivots[top.pivots.length - 1].time;
        if (t1 > last.time) return 0;
        if (t0 === prev.time) return 20;
        return t0 >= prev.time ? 12 : 0;
      };
      hc.forEach(c => { c.nestBonus = nestBonus(c); });
      hc.sort((a, b) => ((b.rawScore || 0) + b.nestBonus) - ((a.rawScore || 0) + a.nestBonus));
      ladder.push({ degree: 'HIGHER', label: '高一级别', atrMult: higher.mult, pivotCount: higher.pivots.length, count: summarize(hc[0]) });
    }
    ladder.push({ degree: 'MAIN', label: '本级别', atrMult: main.mult, pivotCount: main.pivots.length, count: summarize(top) });
    if (liuSignals && liuSignals.origin) {
      ladder.push({
        degree: 'LOWER', label: '当前段小级别',
        structure: liuSignals.origin.structure, subSwings: liuSignals.origin.subSwings,
        text: liuSignals.origin.text
      });
    }
    // 嵌套一致性: 本级别首选计数应落在高一级别计数的最后一浪之内
    const hi = ladder[0].degree === 'HIGHER' && ladder[0].count ? ladder[0].count : null;
    let nesting = null;
    const same = hi && top && hi.pivots.length === top.pivots.length && hi.pivots.every((q, i) => q.time === top.pivots[i].time);
    if (same) {
      nesting = { inside: true, isLastLeg: false, sameCount: true, sameDirection: true,
        text: `高一级别首选计数与本级别重合：「${top.name}」在更粗的拐点层上同样成立，是当前可见的最大级别结构` };
    } else if (hi && top) {
      const hiLastStart = hi.pivots[hi.pivots.length - 2];
      const inside = top.pivots[0].time >= hiLastStart.time;
      const isLastLeg = top.pivots[0].time === hiLastStart.time;
      const hiLegDir = hi.pivots[hi.pivots.length - 1].price > hiLastStart.price ? 'BULLISH' : 'BEARISH';
      const hiLastLabel = hi.waveLabels[hi.waveLabels.length - 1];
      nesting = {
        inside, isLastLeg, sameDirection: hiLegDir === top.direction,
        text: isLastLeg
          ? `本级别「${top.name}」即高一级别「${hi.name}」的第 ${hiLastLabel} 浪（嵌套一致）`
          : inside
            ? `本级别计数位于高一级别「${hi.name}」第 ${hiLastLabel} 浪之内，${hiLegDir === top.direction ? '方向一致（顺大级别）' : '方向相反（为大级别末浪内的逆向子浪）'}`
            : `高一级别首选「${hi.name}」与本级别不嵌套（本级别起点早于其末浪）：本级别整体可能是高一级别的起始浪（1浪或a浪），需人工复核`
      };
    }
    return { levels: ladder, nesting };
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
      liuSignals: null, degreeLadder: null,
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

    const ev = { bars: slice, ctxBars: bars, highs, lows, sources, structCache: new Map() };
    const blockMap = new Map();
    result.liuSignals = buildLiuSignals(slice, main.pivots, ev);
    const cands = collectCandidates(main.pivots, ev, slice.length, rangeExtrema, precedingContext, blockMap);

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
    result.degreeLadder = buildDegreeLadder(degrees, final[0] || null, result.liuSignals, ev, slice.length, rangeExtrema, precedingContext);
    result.forecast = result.mtf.forecast;
    result.commentary = generateLiuCommentary(final[0], currentPrice, symbol, timeframe, result);
    return result;
  }

  // ---------------------------------------------------------------------------
  // 9.5 用户画浪评估: 主周期(4H)上画浪 → 手稿铁律 → 低周期(15m/1h)子浪证伪 → 走势检验
  //   柳玉冬判定一个浪型成立与否的次序:
  //     ① 手稿铁律 (价格/时间硬规则) —— 违反即否决
  //     ② 出身: 驱动段内部须为五浪、调整段内部为三浪 (「这个上涨不是推动浪，看作对黑线的反弹」
  //        「红线走势是完美的5-3-5结构」「还在4子浪调整，再冲到5子浪才形成推动」)
  //     ③ 走势检验: 画完之后是否越过终点 / 触及铁律位 (「如果不跌继续创新高，则红线不是abc反弹」)
  //     ④ 前序: 调整浪不能收复被调整的前一段 (吃掉前段比例)
  //   证伪须有确证: 期望五浪的段，任一子级别阈值能数成合规五浪即视为五浪；
  //   期望三浪的段，只以最粗一级子浪结构判定，避免噪声拐点「数出」五浪。
  // ---------------------------------------------------------------------------

  const USER_TOOLS = {
    IMPULSE: { name: '推动浪 12345', labels: ['0', '1', '2', '3', '4', '5'], types: ['IMPULSE', 'DIAGONAL'] },
    ABC: { name: '调整浪 abc', labels: ['0', 'a', 'b', 'c'], types: ['ZIGZAG', 'FLAT'] },
    WXY: { name: '调整浪 wxy', labels: ['0', 'w', 'x', 'y'], types: ['DOUBLE_ZIGZAG', 'COMBINATION'] },
    WXYXZ: { name: '调整浪 w-x-y-xx-z', labels: ['0', 'w', 'x', 'y', 'xx', 'z'], types: ['TRIPLE_ZIGZAG', 'TRIPLE_COMBINATION'] },
    ABCDE: { name: '三角形 abcde', labels: ['0', 'a', 'b', 'c', 'd', 'e'], types: ['TRIANGLE', 'EXPANDING_TRIANGLE'] }
  };

  // 各浪型逐段内部结构要求 ('5'=驱动五浪, '3'=调整三浪) 及手稿依据
  const SUB_EXPECT = {
    IMPULSE: { legs: ['5', '3', '5', '3', '5'], page: 'P9-16（5-3-5-3-5）' },
    DIAGONAL_LEADING: { legs: ['5', '3', '5', '3', '5'], page: '通用（引导楔形5-3-5-3-5）' },
    DIAGONAL_THREES: { legs: ['3', '3', '3', '3', '3'], page: '通用（终结楔形3-3-3-3-3；引导楔形亦可为3-3-3-3-3）' },
    ZIGZAG: { legs: ['5', '3', '5'], page: 'P216（5-3-5）' },
    FLAT: { legs: ['3', '3', '5'], page: 'P236（3-3-5）' },
    TRIANGLE: { legs: ['3', '3', '3', '3', '3'], page: 'P272-276（3-3-3-3-3）' },
    EXPANDING_TRIANGLE: { legs: ['3', '3', '3', '3', '3'], page: '通用（EWI扩张三角形3-3-3-3-3）' },
    DOUBLE_ZIGZAG: { legs: ['3', '3', '3'], page: 'P362（w、y为锯齿）' },
    COMBINATION: { legs: ['3', '3', '3'], page: 'P50/P158' },
    TRIPLE_ZIGZAG: { legs: ['3', '3', '3', '3', '3'], page: 'P362/P385' },
    TRIPLE_COMBINATION: { legs: ['3', '3', '3', '3', '3'], page: 'P51/P158' }
  };

  const VERDICTS = {
    INVALID: '否决（违反手稿铁律）',
    FALSIFIED_SUB: '小级别证伪（子浪结构不符）',
    FALSIFIED_PRICE: '走势证伪（画完后的走势打破计数）',
    DOUBT: '存疑',
    VALID: '成立'
  };

  const SUB_ROMAN = ['0', 'i', 'ii', 'iii', 'iv', 'v'];

  function fmtTs(t) {
    if (!t && t !== 0) return '--';
    return new Date(t * 1000).toISOString().slice(5, 16).replace('T', ' ');
  }

  function nearestBarIdx(bars, t) {
    let lo = 0, hi = bars.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (bars[mid].time < t) lo = mid + 1; else hi = mid; }
    if (lo > 0 && Math.abs(bars[lo - 1].time - t) <= Math.abs(bars[lo].time - t)) return lo - 1;
    return lo;
  }

  function legNameOf(label) {
    return /^\d$/.test(label) ? `浪${label}` : `${label}浪`;
  }

  /**
   * 手画点吸附: 每个点在 ±w 根K线内取真实极值 (高点取 high、低点取 low)，不越过相邻点。
   * 首段方向按用户点击价格判定，之后高低严格交替。
   */
  /** 时间 t 所在的K线 (开盘时间 ≤ t 的最后一根)：低周期拐点落在哪根高周期K线里 */
  function barIdxAtOrBefore(bars, t) {
    let lo = 0, hi = bars.length - 1, ans = 0;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (bars[mid].time <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }

  /**
   * pinned: { 点序号: {time, price} } —— 由子浪端点固定的拐点，不再吸附到附近极值。
   * 子浪为三角形 / 扩散平台形等时，母浪拐点的正统位置 (e浪终点 / c浪终点) 并不是附近的极值。
   */
  function snapUserPoints(bars, raw, labels, pinned) {
    const n = raw.length;
    const idx = raw.map((r, i) => pinned && pinned[i] ? barIdxAtOrBefore(bars, pinned[i].time) : nearestBarIdx(bars, r.time));
    for (let i = 1; i < n; i++) {
      if (idx[i] <= idx[i - 1]) throw new Error(`第 ${i + 1} 个点须晚于第 ${i} 个点，且相邻两点不能落在同一根 K 线上`);
    }
    const d0 = (pinned && pinned[1] ? pinned[1].price : raw[1].price) >= (pinned && pinned[0] ? pinned[0].price : raw[0].price) ? 1 : -1;
    const pts = [], adjustments = [];
    for (let i = 0; i < n; i++) {
      const type = ((i % 2 === 0) === (d0 > 0)) ? 'low' : 'high';
      if (pinned && pinned[i]) {
        pts.push({ idx: idx[i], time: bars[idx[i]].time, price: pinned[i].price, type, confirmed: true, pinned: true });
        continue;
      }
      const gapL = i > 0 ? idx[i] - idx[i - 1] : Infinity;
      const gapR = i < n - 1 ? idx[i + 1] - idx[i] : Infinity;
      const w = Math.max(1, Math.min(6, Math.round(0.3 * Math.min(gapL, gapR))));
      const lo = Math.max(i > 0 ? pts[i - 1].idx + 1 : 0, idx[i] - w);
      const hi = Math.min(i < n - 1 ? idx[i + 1] - 1 : bars.length - 1, idx[i] + w);
      let best = idx[i];
      for (let k = lo; k <= hi; k++) {
        if (type === 'high' ? bars[k].high > bars[best].high : bars[k].low < bars[best].low) best = k;
      }
      const price = type === 'high' ? bars[best].high : bars[best].low;
      pts.push({ idx: best, time: bars[best].time, price, type, confirmed: true });
      if (best !== idx[i] || Math.abs(price - raw[i].price) > 1e-6 * Math.max(1, Math.abs(price))) {
        adjustments.push({ point: labels[i], fromTime: raw[i].time, fromPrice: raw[i].price, toTime: bars[best].time, toPrice: price, barsMoved: best - idx[i] });
      }
    }
    for (let i = 1; i < n; i++) {
      const up = pts[i].type === 'high';
      if (up ? pts[i].price <= pts[i - 1].price : pts[i].price >= pts[i - 1].price) {
        throw new Error(`${legNameOf(labels[i])}方向与画浪顺序不符：吸附后终点 ${fmtNum(pts[i].price)} ${up ? '不高于' : '不低于'}起点 ${fmtNum(pts[i - 1].price)}，请按高低交替的顺序点击`);
      }
    }
    return { pts, adjustments };
  }

  /** 取点检验: 每段内部是否有K线越过该段起点/终点 (端点不是该段极值) */
  function legEndpointIssues(bars, pts, labels) {
    const issues = [];
    for (let li = 0; li + 1 < pts.length; li++) {
      const A = pts[li], B = pts[li + 1], up = B.type === 'high';
      let overEnd = null, overStart = null;
      for (let k = A.idx + 1; k < B.idx; k++) {
        const e = up ? bars[k].high : bars[k].low, s = up ? bars[k].low : bars[k].high;
        if ((up ? e > B.price : e < B.price) && (!overEnd || (up ? e > overEnd.price : e < overEnd.price))) overEnd = { idx: k, price: e };
        if ((up ? s < A.price : s > A.price) && (!overStart || (up ? s < overStart.price : s > overStart.price))) overStart = { idx: k, price: s };
      }
      const nm = legNameOf(labels[li + 1]);
      if (overEnd) {
        issues.push({ leg: li, kind: 'END_NOT_EXTREME', price: overEnd.price, time: bars[overEnd.idx].time,
          text: `${nm}内部${up ? '最高' : '最低'} ${fmtNum(overEnd.price)}（${fmtTs(bars[overEnd.idx].time)}）越过你标的终点 ${fmtNum(B.price)}：终点应取在该段真正的极值处（手稿：浪的价格=起点到终点）` });
      }
      if (overStart) {
        issues.push({ leg: li, kind: 'START_NOT_EXTREME', price: overStart.price, time: bars[overStart.idx].time,
          text: `${nm}内部${up ? '跌破' : '涨破'}了起点 ${fmtNum(A.price)}（至 ${fmtNum(overStart.price)}）：起点不是本段极值，除非为扩散平台形b浪的运行总量` });
      }
    }
    return issues;
  }

  /**
   * 子浪结构探测 (低周期优先): 返回最粗一级的结构判定 coarse、任一阈值下的合规五浪 any5，
   * 以及严格五浪 strict5 —— 自然级别(最粗一级)恰为5段且逐点满足推动浪铁律 (不跳点)。
   * 期望五浪的段用 any5 (证伪驱动段须确证其数不成五浪)；期望三浪的段用 strict5
   * (拐点一多总能「挑」出合规五浪子集，只有清晰的五段推进才足以质疑调整段)。
   */
  const PROBE_MULTS = [0.30, 0.236, 0.18, 0.14, 0.10, 0.07, 0.05];
  const PROBE_MAX_SWINGS = 13;
  // 期望五浪的段 (常有延长浪) 在超过 13 段的那一级仍尝试数五浪，上限 25 段
  const PROBE_FIVE_MAX_SWINGS = 25;

  function probeLegStructure(pA, pB, ev) {
    const { seg, srcName } = legSegment(pA, pB, ev);
    const out = { source: srcName || null, bars: seg ? seg.length : 0, coarse: null, any5: null, strict5: false, noisy: false };
    if (!seg || seg.length < 6) return out;
    const range = Math.abs(pB.price - pA.price);
    if (!(range > 0)) return out;
    const sAtr = avgTR(seg) || range / seg.length;
    const ps = { idx: 0, time: seg[0].time, price: pA.price, type: pA.type, confirmed: true };
    const pe = { idx: seg.length - 1, time: seg[seg.length - 1].time, price: pB.price, type: pB.type, confirmed: true };
    // 由粗到细寻找该段的「自然子级别」: 首个出现 ≥3 段的阈值即本段的子浪级别；
    // 超过 13 段视为噪声级别 (低周期上逆向波动已与本段幅度相当)，不再细分
    let lastThr = null;
    for (const m of PROBE_MULTS) {
      const thr = Math.max(range * m, 1.2 * sAtr);
      if (thr === lastThr) continue;
      lastThr = thr;
      const anchored = anchorZigzag(zigzagPivots(seg, thr), ps, pe);
      const swings = anchored.length - 1;
      if (swings < 3) continue;
      if (swings > PROBE_MAX_SWINGS) {
        if (!out.coarse) out.noisy = true;
        // 浪3等延长浪内部常超过 13 段：结构判定到此为止，但这一级仍可能数得出合规五浪 (BTC 2026-05-26→06-05 的浪3: 19 段)
        else if (!out.any5 && swings <= PROBE_FIVE_MAX_SWINGS) {
          const five = findMotiveTyped(anchored);
          if (five) out.any5 = { points: five.points, swings, kind: five.kind };
        }
        break;
      }
      const five = anchored.length >= 6 ? findMotiveTyped(anchored) : null;
      if (!out.coarse) {
        out.coarse = { label: five ? '5' : '3', swings, anchored, motive: five ? five.points : null };
        out.strict5 = anchored.length === 6 && motiveRulesOK(anchored, 'IMPULSE');
      }
      if (five && !out.any5) out.any5 = { points: five.points, swings, kind: five.kind };
      if (out.any5) break;
    }
    return out;
  }

  /** 运行中驱动段的小级别进度: 能否数成 0-1-2-3 (3子浪已现，尚欠4、5子浪) */
  function motivePrefix123(zp) {
    const last = zp.length - 1;
    if (last < 3) return null;
    for (let a = 1; a < last; a += 2) {
      for (let b = a + 1; b < last; b += 2) {
        const pts = [zp[0], zp[a], zp[b], Object.assign({}, zp[last], { open: true })];
        if (motiveRulesOK(pts, 'IMPULSE') || motiveRulesOK(pts, 'DIAGONAL')) return pts;
      }
    }
    return null;
  }

  function subLabeled(points, labels) {
    return (points || []).map((q, i) => ({ time: q.time, price: q.price, type: q.type, label: labels[i] || '' }));
  }

  /** 单段子浪判定 → PASS / FAIL(strong) / DOUBT(medium) / RUNNING / UNKNOWN */
  function judgeLeg(li, expect, probe, legName, running, corrClass) {
    const src = probe.source || '主周期';
    const base = { leg: li, name: legName, expect, source: probe.source, bars: probe.bars, running: !!running };
    if (!probe.coarse && probe.noisy) {
      // 即使取本段幅度的30%为阈值仍有13段以上的来回: 内部大幅重叠，这是调整浪的特征、不是推动浪的特征
      if (expect === '3' || running) {
        return Object.assign(base, { found: '3', status: running ? 'RUNNING' : 'PASS', severity: null, swings: PROBE_MAX_SWINGS + 1, subPoints: [],
          text: `${legName}${running ? '运行中' : ''}：${src} 内部反复大幅重叠（逆向波动达本段幅度30%以上的来回超过13段）${expect === '3' ? '，属调整性质 ✓' : '，目前不像推动浪'}` });
      }
      return Object.assign(base, { found: '3', status: 'DOUBT', severity: 'medium', swings: PROBE_MAX_SWINGS + 1, subPoints: [],
        text: `${legName}：${src} 内部反复大幅重叠（逆向波动达本段幅度30%以上的来回超过13段），不像推动浪，存疑` });
    }
    if (!probe.coarse) {
      return Object.assign(base, { found: 'unknown', status: 'UNKNOWN', severity: null, swings: 0, subPoints: [],
        text: `${legName}：${!probe.bars ? '低周期数据未覆盖该段，子浪无法验证' : !probe.source ? (probe.bars <= 4 ? '该段过短（低周期不足 12 根），子浪不可辨' : '低周期数据未完整覆盖该段（画浪起点过早），子浪无法在低周期验证') : probe.noisy ? `${src} 逆向波动与本段幅度相当，子浪级别不可辨（该段相对 ${src} 太小）` : `${src} 内部为单边推进，子浪不可辨`}` });
    }
    const swings = probe.coarse.swings;
    if (expect === '5') {
      if (probe.any5) {
        return Object.assign(base, { found: '5', status: 'PASS', severity: null, swings: probe.any5.swings,
          subPoints: subLabeled(probe.any5.points, SUB_ROMAN),
          text: running
            ? `${legName}运行中：${src} 已可数满五浪（i-v）✓——本段随时可能结束，以小级别监测点确认`
            : `${legName}：${src} 可数为合规五浪（i-v）✓` });
      }
      if (running) {
        const pre = motivePrefix123(probe.coarse.anchored);
        return Object.assign(base, { found: '3', status: 'RUNNING', severity: null, swings,
          subPoints: pre ? subLabeled(pre, SUB_ROMAN) : subLabeled(probe.coarse.anchored, []),
          text: pre
            ? `${legName}运行中：${src} 已现 i-ii-iii 子浪，尚欠 iv、v 子浪——「还在4子浪调整，再冲到5子浪才形成推动」`
            : `${legName}运行中：${src} 目前只有 ${swings} 段，尚不能数成五浪；若最终走不出五浪，则这一段不是推动浪` });
      }
      return Object.assign(base, { found: '3', status: 'FAIL', severity: 'strong', swings,
        subPoints: subLabeled(probe.coarse.anchored, []),
        text: swings === 3
          ? `${legName}：${src} 只走了3段，不是推动浪 ✗——按柳玉冬「不是推动浪，看作反弹/回调」，该段不能标为驱动段`
          : `${legName}：${src} 内部 ${swings} 段无法数成合规五浪 ✗（浪2越起点/浪3最短/浪4切入等铁律不过）` });
    }
    // 期望三浪 (调整段)
    const clsTxt = corrClass && corrClass.best ? `，形态：${describeClass(corrClass)}` : '';
    const clsPts = corrClass && corrClass.best ? corrClass.best.points : null;
    if (!probe.strict5) {
      return Object.assign(base, { found: '3', status: running ? 'RUNNING' : 'PASS', severity: null, swings,
        subPoints: clsPts ? subLabeled(clsPts, ['0', 'a', 'b', 'c', 'd', 'e']) : subLabeled(probe.coarse.anchored, []),
        text: `${legName}${running ? '运行中' : ''}：${src} 内部为三浪调整结构${clsTxt} ✓` });
    }
    return Object.assign(base, { found: '5', status: 'DOUBT', severity: 'medium', swings,
      subPoints: subLabeled(probe.coarse.anchored, SUB_ROMAN),
      text: running
        ? `${legName}运行中：${src} 内部已走出五浪——这只是${legName}的第一部分(a)，${legName}尚未结束`
        : `${legName}：${src} 内部清晰可数为五浪，作为调整段存疑——更可能只是更大调整的a浪（${legName}未完），或趋势已反转` });
  }

  /**
   * 走势检验: 画完之后的价格行为。
   * ① 末点之后价格越过末点 → 末浪延伸，末点后移至新极值
   * ② 末点之后的反向运动 → 未画完时视作下一浪运行中 (追加 open 点)
   */
  function projectLive(slice, pts, fullPts, atr) {
    const n = pts.length, lastBar = slice.length - 1;
    const live = pts.map(q => Object.assign({}, q));
    let last = live[n - 1];
    const d = last.type === 'high' ? 1 : -1;
    let extension = null;
    for (let i = last.idx + 1; i <= lastBar; i++) {
      const v = d > 0 ? slice[i].high : slice[i].low;
      if (d * (v - (extension ? extension.price : last.price)) > 0) extension = { idx: i, price: v };
    }
    if (extension) {
      live[n - 1] = { idx: extension.idx, time: slice[extension.idx].time, price: extension.price, type: last.type, confirmed: true };
      last = live[n - 1];
    }
    let rev = null;
    for (let i = last.idx + 1; i <= lastBar; i++) {
      const v = d > 0 ? slice[i].low : slice[i].high;
      if (!rev || d * (rev.price - v) > 0) rev = { idx: i, price: v };
    }
    const lastLeg = Math.abs(last.price - live[n - 2].price);
    const revSize = rev ? Math.abs(rev.price - last.price) : 0;
    const revSignificant = !!rev && revSize >= Math.max(2 * atr, 0.1 * lastLeg);
    let appended = false;
    if (n < fullPts && revSignificant) {
      live.push({ idx: rev.idx, time: slice[rev.idx].time, price: rev.price, type: d > 0 ? 'low' : 'high', confirmed: false, open: true });
      appended = true;
    }
    const tail = live[live.length - 1];
    if (tail.idx >= lastBar - 1) { tail.open = true; tail.confirmed = false; }
    let status;
    if (live.length < fullPts) status = 'DEVELOPING';
    else status = (tail.open || !revSignificant) ? 'RUNNING' : 'COMPLETED';
    return {
      pts: live, status, appended,
      extension: extension ? { fromPrice: pts[n - 1].price, toPrice: extension.price, time: slice[extension.idx].time } : null,
      reverse: rev ? { price: rev.price, time: slice[rev.idx].time, size: revSize, ratioOfLastLeg: lastLeg > 0 ? +(revSize / lastLeg).toFixed(3) : null, significant: revSignificant } : null
    };
  }

  /** 前序检验: 被调整的前一段 (主周期 Zigzag 上 p0 之前最近的反向拐点 → p0) */
  function precedingSwing(bars, i0, p0) {
    const from = Math.max(0, i0 - 300);
    const seg = bars.slice(from, i0 + 1);
    if (seg.length < 10) return null;
    const pv = zigzagPivots(seg, 2 * (avgTR(seg) || 0));
    for (let k = pv.length - 1; k >= 0; k--) {
      if (pv[k].type !== p0.type && pv[k].idx < seg.length - 1) {
        return { price: pv[k].price, time: pv[k].time, type: pv[k].type, length: Math.abs(p0.price - pv[k].price) };
      }
    }
    return null;
  }

  /**
   * 用户画浪评估主入口。
   * options: { tool: 'IMPULSE'|'ABC'|'WXY'|'WXYXZ'|'ABCDE', points: [{time, price}],
   *            timeframe, subBars: { '15m': [...], '1h': [...] }, htfBars, compare }
   */
  function evaluateUserCount(bars, symbol, options) {
    options = options || {};
    const tool = USER_TOOLS[options.tool];
    if (!tool) throw new Error(`未知画浪工具「${options.tool}」，可选: ${Object.keys(USER_TOOLS).join(' / ')}`);
    if (!bars || bars.length < 10) throw new Error('K线数据不足，无法评估画浪');
    const raw = (options.points || [])
      .filter(p => p && isFinite(p.time) && isFinite(p.price))
      .map(p => ({ time: +p.time, price: +p.price }));
    const fullPts = tool.labels.length;
    if (raw.length < 3) throw new Error('至少需要 3 个点（起点 + 两段浪）才能评估');
    if (raw.length > fullPts) throw new Error(`「${tool.name}」最多 ${fullPts} 个点`);

    const timeframe = options.timeframe || '4h';
    const tfSec = TF_SEC[timeframe] || 14400;
    const i0Full = nearestBarIdx(bars, raw[0].time);
    const sStart = Math.max(0, i0Full - 60);
    const slice = bars.slice(sStart);
    const highs = slice.map(b => b.high), lows = slice.map(b => b.low);
    const atr = avgTR(slice);
    const lastBar = slice.length - 1;
    const currentPrice = slice[lastBar].close;
    const labels = tool.labels;

    // 多级别画浪: legOverrides[段序号] = 用户在该段画的子浪评估结果；pinned = 由子浪端点固定的拐点
    const legOverrides = options.legOverrides || {};
    const { pts, adjustments } = snapUserPoints(slice, raw, labels, options.pinned);
    const n = pts.length;
    if (pts[n - 1].idx >= lastBar - 1) { pts[n - 1].open = true; pts[n - 1].confirmed = false; }
    const drawStatus = n < fullPts ? 'DEVELOPING' : (pts[n - 1].open ? 'RUNNING' : 'COMPLETED');
    // 画了子浪的段，其内部结构由子浪评估 (三角形 e 浪、扩散平台 b 浪本就不是该段极值)
    const endpointIssues = legEndpointIssues(slice, pts, labels).filter(x => !legOverrides[x.leg]);

    // 低周期数据源: 由细到粗 (15m → 1h)，子浪判定优先最细且完整覆盖该段者
    const sources = [{ name: timeframe, tfSec, bars: slice, isMain: true }];
    const subMap = options.subBars || {};
    for (const tf of Object.keys(subMap)) {
      const arr = subMap[tf];
      if (Array.isArray(arr) && arr.length >= 8 && (TF_SEC[tf] || 0) < tfSec) sources.push({ name: tf, tfSec: TF_SEC[tf] || 900, bars: arr });
    }
    sources.sort((a, b) => a.tfSec - b.tfSec);
    const subNames = sources.filter(s => !s.isMain).map(s => s.name);
    const mkEv = () => ({ bars: slice, ctxBars: bars, highs, lows, sources, structCache: new Map(), refineSubTimes: true, mainTfSec: tfSec, maxSubBars: 4000 });

    const live = projectLive(slice, pts, fullPts, atr);
    const lp = live.pts;

    // 逐段子浪探测 (以走势检验后的端点为准: 末浪若已延伸则量到新极值)；结果按端点缓存，各浪型解读共用
    const probeEv = mkEv();
    const probeCache = new Map();
    const probe = (a, b) => {
      const k = a.time + '_' + b.time;
      if (!probeCache.has(k)) {
        // 最细周期噪声过大时退到次细周期 (15m → 1h)
        let pr = probeLegStructure(a, b, probeEv);
        const tried = new Set();
        while (pr.noisy && pr.source && !tried.has(pr.source)) {
          tried.add(pr.source);
          const evNext = Object.assign({}, probeEv, { sources: sources.filter(s => s.isMain || !tried.has(s.name)) });
          const next = probeLegStructure(a, b, evNext);
          if (!next.source) break;
          pr = next;
        }
        probeCache.set(k, pr);
      }
      return probeCache.get(k);
    };

    function subAnalysis(type, pointsUsed) {
      let key = type;
      if (type === 'DIAGONAL') {
        let lead = 0, end = 0;
        for (const li of [0, 2, 4]) {
          if (li + 1 >= pointsUsed.length) continue;
          if (legOverrides[li]) { if (legOverrides[li].category === '5') lead++; else end++; continue; }
          const pr = probe(pointsUsed[li], pointsUsed[li + 1]);
          if (pr.any5) lead++;
          else if (pr.coarse) end++;
        }
        key = end > lead ? 'DIAGONAL_THREES' : 'DIAGONAL_LEADING';
      }
      // 各位置允许的楔形: 浪1/a浪=引导楔形，浪5/c浪=终结楔形，浪3不能是楔形
      const diagAt = { IMPULSE: { 0: '引导楔形', 4: '终结楔形' }, ZIGZAG: { 0: '引导楔形', 2: '终结楔形' }, FLAT: { 2: '终结楔形' } }[type] || null;
      const spec = SUB_EXPECT[key];
      const legs = [];
      const ev = mkEv();
      for (let li = 0; li + 1 < pointsUsed.length; li++) {
        const A = pointsUsed[li], B = pointsUsed[li + 1];
        const pr = probe(A, B);
        const expect = spec.legs[li];
        const running = li + 1 === pointsUsed.length - 1 && !!B.open;
        // 形态识别与结构判定用同一周期 (噪声段可能已退到 1h)
        const evLeg = pr.source ? Object.assign(mkEv(), { sources: sources.filter(s => s.isMain || s.name === pr.source) }) : ev;
        const corrClass = expect === '3' && pr.coarse ? classifyCorrectiveLeg(A, B, evLeg, running) : null;
        const lbl = PATTERNS[type].labels[li + 1];
        if (legOverrides[li]) {
          legs.push(overrideLeg(type, li, expect, legOverrides[li], legNameOf(lbl), running, B.price > A.price ? 1 : -1));
          continue;
        }
        const L = judgeLeg(li, expect, pr, legNameOf(lbl), running, corrClass);
        if (diagAt && L.found === '5' && pr.any5 && pr.any5.kind === 'DIAGONAL') {
          const nm = diagAt[li];
          if (nm) {
            L.diagonal = nm;
            L.text = L.text.replace('✓', `（${nm}）✓`);
          } else {
            Object.assign(L, { status: 'DOUBT', severity: 'medium',
              text: `${legNameOf(lbl)}：${pr.source || '主周期'} 只能数成楔形、数不成推动浪——浪3不能是楔形，存疑` });
          }
        }
        legs.push(L);
      }
      return { key, page: spec.page, legs };
    }

    /** 预置结构缓存: 让规则库中的出身检验(M9/Z0/F0...)与交替原则使用同一份低周期判定 */
    function evFor(sub, pointsUsed) {
      const ev = mkEv();
      sub.legs.forEach(L => {
        const A = pointsUsed[L.leg], B = pointsUsed[L.leg + 1];
        const ov = legOverrides[L.leg];
        if (ov) {
          // 子浪画浪即该段结构: 出身检验 (M9/Z0/F0…) 与楔形判定直接采用
          ev.structCache.set(A.time + '_' + B.time, { label: ov.category, motive: ov.category === '5' ? (ov.type === 'DIAGONAL' ? 'DIAGONAL' : 'IMPULSE') : null, subPivots: (ov.points || []).map(q => ({ time: q.time, price: q.price, type: q.type })), source: `子浪画浪 ${ov.timeframe}` });
          return;
        }
        const pr = probe(A, B);
        const label = !pr.coarse ? (pr.noisy ? '3' : 'unknown') : L.expect === '5' ? (pr.any5 ? '5' : '3') : (pr.strict5 ? '5' : '3');
        const subPivots = L.expect === '5' && pr.any5 ? pr.any5.points : pr.coarse ? pr.coarse.anchored : [];
        const motive = label === '5' && pr.any5 ? pr.any5.kind : null;
        ev.structCache.set(A.time + '_' + B.time, { label, motive, subPivots, source: pr.source });
      });
      return ev;
    }

    function interpret(type) {
      const def = PATTERNS[type];
      if (n > def.pts) return null;
      const idxs = pts.map((_, i) => i);
      const sub = subAnalysis(type, lp.slice(0, n));
      const evD = evFor(sub, pts);
      const drawnEval = evaluatePattern(type, pts, evD);
      const drawnCand = buildCandidate({ type, idxs, status: drawStatus }, drawnEval, evD, pts);
      let liveEval = null, liveCand = null, liveSub = sub;
      if (lp.length <= def.pts) {
        liveSub = live.appended ? subAnalysis(type, lp) : sub;
        const evL = evFor(liveSub, lp);
        liveEval = evaluatePattern(type, lp, evL);
        liveCand = buildCandidate({ type, idxs: lp.map((_, i) => i), status: live.status }, liveEval, evL, lp);
      }
      if (type === 'DIAGONAL') {
        // buildCandidate 已按结构与位置命名；用户画浪以所画各段的结构为准
        const role = sub.key === 'DIAGONAL_LEADING' ? 'LEADING' : diagonalRole(mkGeom(pts), evD);
        const shape = pts.length >= 4 ? (Math.abs(pts[3].price - pts[2].price) < Math.abs(pts[1].price - pts[0].price) ? '收缩' : '扩散') : '';
        const nm = `${shape}${role === 'LEADING' ? '引导楔形' : role === 'ENDING' ? '终结楔形' : '楔形'}${sub.key === 'DIAGONAL_LEADING' ? '（5-3-5-3-5）' : '（3-3-3-3-3）'}`;
        drawnCand.name = drawnCand.name.replace(/^.+?（(?=上升|下跌)/, nm + '（');
        if (liveCand) liveCand.name = liveCand.name.replace(/^.+?（(?=上升|下跌)/, nm + '（');
      }
      const strong = sub.legs.filter(L => L.severity === 'strong');
      const medium = sub.legs.filter(L => L.severity === 'medium');
      return {
        type, name: drawnCand.name, structureKey: sub.key, structurePage: sub.page,
        hardFails: drawnEval.hardFails.map(c => ({ id: c.id, text: c.text, page: c.page, detail: c.detail })),
        pending: drawnEval.pending.map(c => ({ id: c.id, text: c.text, page: c.page })),
        guidePct: drawnCand.guidePct,
        legs: sub.legs, liveLegs: liveSub.legs,
        strongCount: strong.length, mediumCount: medium.length,
        drawn: drawnCand,
        live: liveCand,
        // 走势检验只在画完后的计数与所画不同 (末浪延伸 / 追加下一浪) 时才有新增信息
        liveHardFails: liveEval && (live.appended || live.extension)
          ? liveEval.hardFails.map(c => ({ id: c.id, text: c.text, page: c.page, detail: c.detail })) : []
      };
    }

    const rank = (a, b) => (a.hardFails.length - b.hardFails.length) || (a.strongCount - b.strongCount) ||
      (a.liveHardFails.length - b.liveHardFails.length) || (a.mediumCount - b.mediumCount) || (b.guidePct - a.guidePct);
    // 用户可指定浪型 (例如 abc 指定为单锯齿或平台形)；未指定时在工具的各浪型中自动择优
    const forced = options.forceType && tool.types.indexOf(options.forceType) >= 0 ? options.forceType : null;
    const types = forced ? [forced] : tool.types;
    const interps = types.map(interpret).filter(Boolean).sort(rank);
    if (!interps.length) throw new Error(`「${tool.name}」无法容纳 ${n} 个点`);
    const primary = interps[0];

    // 同样的点按其它浪型解读 (柳玉冬改数: 「推动浪不成立，按楔形/三角形看」)
    const alternatives = [];
    // 画满时只与同点数浪型比较；未画满时任何能容纳这些点的浪型都可，优先更简单者 (点数少)
    for (const type of Object.keys(PATTERNS)) {
      if (types.indexOf(type) >= 0) continue;
      if (n === fullPts ? PATTERNS[type].pts !== n : PATTERNS[type].pts < n) continue;
      const it = interpret(type);
      if (it && !it.hardFails.length && !it.strongCount && !it.liveHardFails.length) alternatives.push(it);
    }
    alternatives.sort((a, b) => (PATTERNS[a.type].pts - PATTERNS[b.type].pts) || rank(a, b));

    // 前序: 调整浪不得收复被调整的前一段
    const prev = precedingSwing(bars, i0Full, Object.assign({}, pts[0], { idx: i0Full }));
    let preceding = null;
    if (prev && prev.length > 0) {
      const d = pts[1].price > pts[0].price ? 1 : -1;
      let far = pts[0].price;
      for (const q of lp) if (d * (q.price - far) > 0) far = q.price;
      const ratio = Math.abs(far - pts[0].price) / prev.length;
      const corrective = PATTERNS[primary.type].category !== '驱动浪';
      preceding = {
        from: { price: prev.price, time: prev.time }, to: { price: pts[0].price, time: pts[0].time },
        length: +prev.length.toFixed(4), ratio: +ratio.toFixed(3),
        warning: corrective && ratio >= 1,
        text: corrective
          ? (ratio >= 1
            ? `该调整已收复被调整的前一段（${fmtNum(prev.price)}→${fmtNum(pts[0].price)}）的 ${(ratio * 100).toFixed(0)}%：它不是对前一段的调整，或前一段不是同级别——要么改数为驱动浪，要么前一段只是更大调整的一部分`
            : `该调整回撤前一段 ${(ratio * 100).toFixed(0)}%（${ratio >= 0.7 ? '≥0.7，平台形/联合形条件具备' : ratio >= 0.618 ? '达0.618，三角形b浪常见值' : '<0.618，仅支持锯齿类'}）`)
          : `前一段 ${fmtNum(prev.price)}→${fmtNum(pts[0].price)}；本驱动浪已走出其 ${(ratio * 100).toFixed(0)}%${ratio >= 1 ? '（已越过前一段起点，具备新趋势的资格）' : ''}`
      };
    }

    // 判决
    const reasons = [];
    primary.hardFails.forEach(f => reasons.push(`✗ ${f.text}（手稿${f.page}）：${f.detail}`));
    primary.legs.filter(L => L.severity === 'strong').forEach(L => reasons.push(L.text));
    if (!primary.hardFails.length && primary.liveHardFails.length) {
      const L = labels[n - 1];
      if (live.extension) reasons.push(`画完后价格越过你标的${legNameOf(L)}终点 ${fmtNum(live.extension.fromPrice)}，延伸至 ${fmtNum(live.extension.toPrice)}（${fmtTs(live.extension.time)}）`);
      if (live.appended && live.reverse) reasons.push(`画完后的反向走势至 ${fmtNum(live.reverse.price)}（${fmtTs(live.reverse.time)}）按下一浪计入`);
      primary.liveHardFails.forEach(f => reasons.push(`走势检验 ✗ ${f.text}（手稿${f.page}）：${f.detail}`));
    }
    const doubts = [];
    primary.legs.filter(L => L.severity === 'medium').forEach(L => doubts.push(L.text));
    endpointIssues.forEach(x => doubts.push(x.text));
    if (preceding && preceding.warning) doubts.push(preceding.text);
    if (live.extension && !primary.liveHardFails.length) {
      doubts.push(`你标的终点 ${fmtNum(live.extension.fromPrice)} 之后价格已${pts[n - 1].type === 'high' ? '涨' : '跌'}到 ${fmtNum(live.extension.toPrice)}：末浪尚未在你标的位置结束，终点应后移`);
    }
    if (primary.guidePct < 40) doubts.push(`指引符合度仅 ${primary.guidePct}%：比率/时间与手稿常见值偏离较大`);
    const verdict = primary.hardFails.length ? 'INVALID'
      : primary.strongCount ? 'FALSIFIED_SUB'
        : primary.liveHardFails.length ? 'FALSIFIED_PRICE'
          : doubts.length ? 'DOUBT' : 'VALID';

    // 监测点与失效位 (以走势检验后的计数为准；走势已证伪时只给出证伪事实)
    const cand = primary.live || primary.drawn;
    const ev = mkEv();
    const liuSignals = lp.length >= 3 ? buildLiuSignals(slice, lp, ev) : null;
    const side = price => price < currentPrice ? '跌破' : '涨破';
    const invalidation = {};
    if (cand.monitoringPivot) {
      const mp = cand.monitoringPivot;
      const sd = side(mp.price);
      invalidation.structural = { price: mp.price, label: mp.levelName, side: sd, text: `${sd} ${fmtNum(mp.price)}（${mp.levelName}）：${(mp.description || '').replace(/^(跌破|涨破)/, sd)}` };
    }
    if (cand.secondaryPivot) {
      const sp = cand.secondaryPivot;
      invalidation.secondary = { price: sp.price, label: sp.levelName, text: `${fmtNum(sp.price)}（${sp.levelName}）：${sp.description}` };
    }
    const lastLegs = primary.liveLegs;
    const runLeg = lastLegs[lastLegs.length - 1];
    const tail = lp[lp.length - 1];
    if (runLeg && runLeg.subPoints && runLeg.subPoints.length >= 3) {
      // 小级别监测点: 当前段内最近一个与段起点同向的子浪拐点 (「监测点逐日随趋势上移」)
      const startType = lp[lp.length - 2].type;
      const cands = runLeg.subPoints.slice(1, -1).filter(q => q.type === startType);
      const m = cands[cands.length - 1];
      if (m) {
        const up = tail.type === 'high';
        invalidation.monitor = {
          price: m.price, time: m.time, source: runLeg.source,
          text: `小级别监测点 ${fmtNum(m.price)}（${runLeg.source || timeframe}）：不${up ? '跌破' : '涨破'}认为${runLeg.name}继续${up ? '涨' : '跌'}；${up ? '跌破' : '涨破'}则小级别见${up ? '顶' : '底'}`
        };
      }
    }
    if (!invalidation.monitor && liuSignals && liuSignals.monitorPoint) {
      invalidation.monitor = { price: liuSignals.monitorPoint.price, time: liuSignals.monitorPoint.time, source: timeframe, text: liuSignals.monitorPoint.text };
    }
    if (liuSignals && liuSignals.monitorPoint) {
      invalidation.confirm = { price: liuSignals.monitorPoint.confirmLevel, text: `确认位 ${fmtNum(liuSignals.monitorPoint.confirmLevel)}：越过才确认当前段结束（最大回撤判据）` };
    }

    // 引擎自动计数对照 (同一区间)
    let engineView = null;
    if (options.compare) {
      try {
        const a = analyzeWaves(bars, symbol, { startTime: pts[0].time, endTime: bars[bars.length - 1].time, timeframe, subBars: options.subBars, htfBars: options.htfBars });
        if (a.pattern) {
          engineView = {
            name: a.pattern.name, baseType: a.pattern.baseType, probability: a.pattern.probability,
            pivots: a.pattern.pivots.map(q => ({ time: q.time, price: q.price, type: q.type })), waveLabels: a.pattern.waveLabels,
            sameAsUser: tool.types.indexOf(a.pattern.baseType) >= 0
          };
        }
      } catch (e) { engineView = { error: e.message }; }
    }

    // 柳氏口吻研判
    const dirTxt = pts[1].price > pts[0].price ? '上升' : '下跌';
    const lines = [];
    lines.push(`你画的是「${tool.name}」（${dirTxt}），按「${primary.name}」评估：${VERDICTS[verdict]}。`);
    if (adjustments.length) lines.push(`已将 ${adjustments.map(a => a.point).join('、')} 点吸附到附近K线的真实高/低点。`);
    reasons.forEach(r => lines.push(r));
    const subSrc = Array.from(new Set(primary.legs.map(L => L.source).filter(Boolean)));
    lines.push(`子浪结构（${subSrc.length ? subSrc.join('/') : '低周期数据不足'}，手稿${primary.structurePage}）：` +
      primary.legs.map(L => `${L.name}${L.status === 'PASS' ? '✓' : L.status === 'FAIL' ? '✗' : L.status === 'DOUBT' ? '?' : L.status === 'RUNNING' ? '…' : '—'}`).join(' '));
    if (live.appended && runLeg) lines.push(runLeg.text);
    if (verdict !== 'VALID' && alternatives.length) lines.push(`同样的点按「${alternatives[0].name}」可以成立。`);
    // 已被铁律否决的计数不再给监测点；已被证伪的计数不再给其结构防线
    if (invalidation.monitor && verdict !== 'INVALID') lines.push(invalidation.monitor.text);
    if (invalidation.structural && (verdict === 'VALID' || verdict === 'DOUBT')) lines.push(invalidation.structural.text);
    const tgts = (cand.targets || []).slice(0, 3);
    if (tgts.length && verdict !== 'INVALID' && verdict !== 'FALSIFIED_SUB') lines.push(`目标：${tgts.map(t => `${fmtNum(t.price)}（${t.label}）`).join('；')}`);
    lines.push('只讨论波浪，没有任何交易建议，不对任何交易行为负责。');

    return {
      symbol, timeframe, engineVersion: VERSION, mode: 'USER_COUNT',
      tool: options.tool, toolName: tool.name, labels,
      forcedType: forced, toolTypes: tool.types.map(t => ({ type: t, name: PATTERNS[t].name })),
      analysisTime: new Date().toISOString(), currentPrice,
      subTimeframes: subNames,
      points: pts.map((q, i) => ({ label: labels[i], time: q.time, price: q.price, type: q.type, open: !!q.open })),
      adjustments, endpointIssues,
      drawStatus, live: {
        status: live.status, appended: live.appended, extension: live.extension, reverse: live.reverse,
        points: lp.map((q, i) => ({ label: labels[i] || '', time: q.time, price: q.price, type: q.type, open: !!q.open }))
      },
      verdict, verdictLabel: VERDICTS[verdict], reasons, doubts,
      primary: {
        type: primary.type, name: primary.name, structure: primary.structureKey, structurePage: primary.structurePage,
        hardFails: primary.hardFails, liveHardFails: primary.liveHardFails, pending: primary.pending,
        guidePct: primary.guidePct, legs: primary.legs, liveLegs: primary.liveLegs,
        ruleChecks: primary.drawn.ruleChecks, alternation: primary.drawn.alternation, components: primary.drawn.components
      },
      interpretations: interps.map(it => ({ type: it.type, name: it.name, hardFails: it.hardFails.length, strong: it.strongCount, medium: it.mediumCount, liveHardFails: it.liveHardFails.length, guidePct: it.guidePct })),
      alternatives: alternatives.slice(0, 3).map(it => ({ type: it.type, name: it.name, guidePct: it.guidePct, labels: PATTERNS[it.type].labels })),
      preceding,
      invalidation,
      targets: cand.targets || [],
      fibLevels: cand.fibLevels || null,
      candidate: cand,
      liuSignals,
      engineView,
      commentary: { title: `${symbol} ${timeframe.toUpperCase()} 画浪评估`, lines }
    };
  }

  // ---------------------------------------------------------------------------
  // 9.6 多级别画浪: 同一张图上画母浪与子浪，整体评估
  //   母子关系: 一个浪的时间跨度落在另一个浪的某一段之内 (容差为母浪周期的一根K线)，
  //   它就是那一段的子浪；有多个可选母浪时取跨度最小者 (最近一级)。
  //   评估由内向外: 先评估子浪，再把子浪的结论作为母浪该段的结构判定，并以子浪端点固定母浪拐点。
  // ---------------------------------------------------------------------------

  // 各浪型中允许三角形出现的段 (浪4、b浪、x浪、联合形最后一段；三角形 e 浪偶见三角形)
  const TRIANGLE_SLOTS = { IMPULSE: [3], DIAGONAL: [], ZIGZAG: [1], FLAT: [1], TRIANGLE: [4], EXPANDING_TRIANGLE: [4],
    DOUBLE_ZIGZAG: [1], TRIPLE_ZIGZAG: [1, 3], COMBINATION: [1, 2], TRIPLE_COMBINATION: [1, 3, 4] };
  // 各浪型中允许楔形出现的段及角色 (引导楔形: 浪1 / a浪；终结楔形: 浪5 / c浪)
  const DIAGONAL_SLOTS = { IMPULSE: { 0: 'LEADING', 4: 'ENDING' }, ZIGZAG: { 0: 'LEADING', 2: 'ENDING' }, FLAT: { 2: 'ENDING' } };
  const ZIGZAG_FAMILY = ['ZIGZAG', 'DOUBLE_ZIGZAG', 'TRIPLE_ZIGZAG'];
  const VERDICT_RANK = { VALID: 0, DOUBT: 1, FALSIFIED_PRICE: 2, FALSIFIED_SUB: 3, INVALID: 4, ERROR: 5 };
  const SKETCH_SUB_TFS = { '5m': [], '15m': ['5m'], '1h': ['15m', '5m'], '4h': ['15m', '1h'] };

  /** 母浪某段由用户画的子浪判定: 方向、类别 (五浪/三浪)、位置 (楔形/三角形) 与子浪自身判决 */
  function overrideLeg(type, li, expect, ov, legName, running, legDir) {
    const base = {
      leg: li, name: legName, expect, source: `子浪画浪 ${ov.timeframe}`, bars: 0, running: !!running,
      found: ov.category, swings: ov.category === '5' ? 5 : 3, userChild: ov.id, childType: ov.type,
      subPoints: subLabeled(ov.points, ov.labels || [])
    };
    const nm = `你画的子浪「${ov.name}」（${ov.timeframe}）`;
    const fail = text => Object.assign(base, { status: 'FAIL', severity: 'strong', text });
    const doubt = text => Object.assign(base, { status: 'DOUBT', severity: 'medium', text });
    if (ov.dir !== legDir) return fail(`${legName}：${nm}方向与该段相反 ✗`);
    if (ov.category !== expect) {
      return fail(`${legName}要求${expect === '5' ? '五浪（推动浪或楔形）' : '三浪调整'}，${nm}是${ov.category === '5' ? '驱动浪' : '调整浪'} ✗`);
    }
    if (ov.type === 'DIAGONAL') {
      const role = (DIAGONAL_SLOTS[type] || {})[li];
      if (!role) return fail(`${legName}：楔形只出现在浪1/a浪（引导楔形）或浪5/c浪（终结楔形），${nm}不能在这个位置 ✗`);
      if (ov.diagRole && ov.diagRole !== role) {
        return doubt(`${legName}应为${role === 'LEADING' ? '引导' : '终结'}楔形，${nm}按其结构与位置更像${ov.diagRole === 'LEADING' ? '引导' : '终结'}楔形，存疑`);
      }
    }
    if (/TRIANGLE/.test(ov.type) && (TRIANGLE_SLOTS[type] || []).indexOf(li) < 0) {
      return doubt(type === 'IMPULSE' && li === 1
        ? `${legName}：${nm}——三角形通常不作为浪2（只出现在浪4、b浪、x浪或联合形最后一段），存疑；可考虑改数为浪4或b浪`
        : `${legName}：${nm}——三角形通常只出现在浪4、b浪、x浪或联合形最后一段，存疑`);
    }
    if ((type === 'DOUBLE_ZIGZAG' || type === 'TRIPLE_ZIGZAG') && li % 2 === 0 && ZIGZAG_FAMILY.indexOf(ov.type) < 0) {
      return doubt(`${legName}：双/三锯齿的组成部分应为锯齿形，${nm}存疑`);
    }
    if (ov.verdict === 'VALID') return Object.assign(base, { status: running ? 'RUNNING' : 'PASS', severity: null, text: `${legName}：${nm}成立 ✓` });
    if (ov.verdict === 'DOUBT') return doubt(`${legName}：${nm}存疑${ov.reason ? '——' + ov.reason : ''}`);
    return fail(`${legName}：${nm}${VERDICTS[ov.verdict] || '不成立'} ✗${ov.reason ? '——' + ov.reason : ''}`);
  }

  /**
   * 由各浪的时间跨度推断母子关系 (只依赖用户点的时间，不依赖K线)。
   * drawings: [{id, tool, timeframe, points:[{time, price}]}]
   * 返回 { nodes: {id: {parentId, leg, depth}}, issues: {id: [{severity, text}]} }
   */
  function buildSketchTree(drawings) {
    const info = {}, issues = {};
    const span = d => d.points[d.points.length - 1].time - d.points[0].time;
    const nameOf = d => (USER_TOOLS[d.tool] || { name: d.tool }).name;
    drawings.forEach(d => { info[d.id] = { parentId: null, leg: null, depth: 0 }; issues[d.id] = []; });
    for (const c of drawings) {
      const c0 = c.points[0].time, cN = c.points[c.points.length - 1].time;
      let best = null;
      for (const p of drawings) {
        if (p === c || span(p) <= span(c)) continue;
        const tol = TF_SEC[p.timeframe] || 14400;
        for (let k = 0; k + 1 < p.points.length; k++) {
          const a = p.points[k].time, b = p.points[k + 1].time;
          if (c0 >= a - tol && cN <= b + tol && (!best || span(p) < span(best.p))) best = { p, k };
        }
      }
      if (best) {
        info[c.id].parentId = best.p.id;
        info[c.id].leg = best.k;
        const tol = TF_SEC[best.p.timeframe] || 14400;
        const a = best.p.points[best.k].time, b = best.p.points[best.k + 1].time;
        const labels = (USER_TOOLS[best.p.tool] || { labels: [] }).labels;
        const legName = legNameOf(labels[best.k + 1] || String(best.k + 1));
        info[c.id].legName = legName;
        info[c.id].pinStart = Math.abs(c0 - a) <= tol;
        const full = c.points.length === (USER_TOOLS[c.tool] || { labels: [] }).labels.length;
        info[c.id].pinEnd = full && Math.abs(cN - b) <= tol;
        if (!info[c.id].pinStart) issues[c.id].push({ severity: 'medium', text: `子浪起点与母浪「${nameOf(best.p)}」${legName}的起点不在同一根母浪K线上：子浪应从${legName}起点开始` });
        if (full && !info[c.id].pinEnd) issues[c.id].push({ severity: 'medium', text: `子浪已画满，但终点与母浪${legName}的终点不在同一根母浪K线上：子浪应覆盖${legName}全程` });
        const lastLeg = best.k + 2 === best.p.points.length;
        if (!full && !lastLeg) issues[c.id].push({ severity: 'medium', text: `母浪${legName}之后还有下一浪（${legName}已结束），但子浪只画了前 ${c.points.length - 1} 段` });
      }
    }
    // 同一段两个子浪：保留跨度较大者，其余标出
    const bySlot = {};
    drawings.forEach(d => {
      const it = info[d.id];
      if (!it.parentId) return;
      const key = it.parentId + '#' + it.leg;
      (bySlot[key] = bySlot[key] || []).push(d);
    });
    Object.keys(bySlot).forEach(key => {
      const list = bySlot[key].sort((x, y) => span(y) - span(x));
      list.slice(1).forEach(d => {
        info[d.id].duplicate = true;
        issues[d.id].push({ severity: 'medium', text: `母浪同一段（${info[d.id].legName}）已有子浪「${nameOf(list[0])}」，本浪不参与母浪判定` });
      });
    });
    // 深度
    const depthOf = id => { let dpt = 0, cur = info[id]; const seen = new Set([id]); while (cur.parentId && !seen.has(cur.parentId)) { seen.add(cur.parentId); dpt++; cur = info[cur.parentId]; } return dpt; };
    drawings.forEach(d => { info[d.id].depth = depthOf(d.id); });
    // 时间交叉却互不包含: 跨越了另一个浪的拐点，无法判定级别
    const isAncestor = (a, b) => { let cur = info[b].parentId; while (cur) { if (cur === a) return true; cur = info[cur].parentId; } return false; };
    for (let i = 0; i < drawings.length; i++) {
      for (let j = i + 1; j < drawings.length; j++) {
        const A = drawings[i], B = drawings[j];
        if (isAncestor(A.id, B.id) || isAncestor(B.id, A.id)) continue;
        const tol = Math.max(TF_SEC[A.timeframe] || 14400, TF_SEC[B.timeframe] || 14400);
        const ov = Math.min(A.points[A.points.length - 1].time, B.points[B.points.length - 1].time) - Math.max(A.points[0].time, B.points[0].time);
        if (ov > tol) {
          const small = span(A) <= span(B) ? A : B, big = small === A ? B : A;
          issues[small.id].push({ severity: 'strong', text: `与「${nameOf(big)}」时间交叉，但不在它的任何一段之内（跨越了它的拐点）：无法判定两者的级别关系` });
        }
      }
    }
    return { nodes: info, issues };
  }

  function worstVerdict(list) {
    return list.reduce((w, v) => (VERDICT_RANK[v] > VERDICT_RANK[w] ? v : w), 'VALID');
  }

  /**
   * 多级别画浪整体评估。
   * barsByTf: { '4h': [...], '1h': [...], '15m': [...], '5m': [...] }，每个画浪按自己的周期评估，子浪判定用更低周期。
   * options.drawings: [{id, tool, timeframe, points:[{time, price}]}]
   */
  function evaluateUserSketch(barsByTf, symbol, options) {
    options = options || {};
    const drawings = (options.drawings || []).map((d, i) => ({
      id: String(d.id !== undefined && d.id !== null ? d.id : i + 1), tool: d.tool, timeframe: d.timeframe || '4h', type: d.type || null,
      points: (d.points || []).filter(p => p && isFinite(p.time) && isFinite(p.price)).map(p => ({ time: +p.time, price: +p.price }))
    }));
    if (!drawings.length) throw new Error('还没有画浪');
    drawings.forEach(d => {
      if (!USER_TOOLS[d.tool]) throw new Error(`未知画浪工具「${d.tool}」`);
      if (d.points.length < 2) throw new Error(`「${USER_TOOLS[d.tool].name}」至少需要 2 个点`);
    });
    const tree = buildSketchTree(drawings);
    const nodes = drawings.map(d => Object.assign({ d, issues: tree.issues[d.id].slice(), result: null, error: null }, tree.nodes[d.id]));
    const byId = {};
    nodes.forEach(nd => { byId[nd.d.id] = nd; });

    const finalOf = nd => nd.error ? 'ERROR' : worstVerdict([nd.result.verdict].concat(nd.issues.map(x => x.severity === 'strong' ? 'FALSIFIED_SUB' : x.severity === 'medium' ? 'DOUBT' : 'VALID')));
    const evalOne = (d, extra) => {
      const bars = barsByTf[d.timeframe];
      if (!bars || !bars.length) throw new Error(`缺少 ${d.timeframe} K线`);
      const sub = {};
      (SKETCH_SUB_TFS[d.timeframe] || []).forEach(tf => { if (barsByTf[tf] && barsByTf[tf].length) sub[tf] = barsByTf[tf]; });
      return evaluateUserCount(bars, symbol, Object.assign({ tool: d.tool, points: d.points, timeframe: d.timeframe, subBars: sub, forceType: d.type }, extra));
    };

    // 由内向外: 最深的子浪先评估
    const order = nodes.slice().sort((a, b) => b.depth - a.depth);
    for (const nd of order) {
      const kids = nodes.filter(c => c.parentId === nd.d.id && !c.duplicate);
      const legOverrides = {}, pinned = {};
      kids.forEach(c => {
        if (c.error || !c.result) {
          nd.issues.push({ severity: 'medium', text: `${c.legName}的子浪无法评估（${c.error || '无结果'}），该段按低周期自动判定` });
          return;
        }
        const r = c.result, cp = r.points;
        const fv = finalOf(c);
        const reason = fv === 'VALID' ? '' : (r.reasons[0] || c.issues.map(x => x.text)[0] || r.doubts[0] || '');
        legOverrides[c.leg] = {
          id: c.d.id, timeframe: c.d.timeframe, type: r.primary.type, name: r.primary.name,
          category: PATTERNS[r.primary.type].category === '驱动浪' ? '5' : '3',
          verdict: fv, reason, dir: cp[1].price > cp[0].price ? 1 : -1,
          points: cp, labels: r.labels,
          diagRole: /引导楔形/.test(r.primary.name) ? 'LEADING' : /终结楔形/.test(r.primary.name) ? 'ENDING' : null
        };
        if (c.pinStart) pinned[c.leg] = { time: cp[0].time, price: cp[0].price };
        if (c.pinEnd && r.drawStatus !== 'DEVELOPING') pinned[c.leg + 1] = { time: cp[cp.length - 1].time, price: cp[cp.length - 1].price };
      });
      try {
        nd.result = evalOne(nd.d, { legOverrides, pinned });
      } catch (e) {
        // 固定拐点可能与母浪自身的取点冲突 (例如子浪端点落在相邻母浪K线上)：退回不固定再试
        if (Object.keys(pinned).length) {
          try {
            nd.result = evalOne(nd.d, { legOverrides });
            nd.issues.push({ severity: 'medium', text: `子浪端点无法与母浪拐点对齐（${e.message}），母浪拐点按自身取点评估` });
          } catch (e2) { nd.error = e2.message; }
        } else nd.error = e.message;
      }
      // 交替原则 (指引): 浪2与浪4的子浪一陡一横或一简一繁
      if (nd.result && /IMPULSE|DIAGONAL/.test(nd.result.primary.type) && legOverrides[1] && legOverrides[3]) {
        const a = legOverrides[1], b = legOverrides[3];
        const fa = CORR_FORM[a.type], fb = CORR_FORM[b.type], ca = CORR_COMPLEXITY[a.type], cb = CORR_COMPLEXITY[b.type];
        const ok = fa !== fb || ca !== cb;
        nd.issues.push({ severity: 'info', text: ok
          ? `交替原则：浪2「${a.name}」（${FORM_TXT[fa]}·${CPLX_TXT[ca]}）与浪4「${b.name}」（${FORM_TXT[fb]}·${CPLX_TXT[cb]}）形成交替 ✓`
          : `交替原则：浪2「${a.name}」与浪4「${b.name}」同为${FORM_TXT[fa]}·${CPLX_TXT[ca]}，没有交替（指引，P85/P88）` });
      }
    }

    const out = nodes.map(nd => {
      const fv = finalOf(nd);
      return {
        id: nd.d.id, tool: nd.d.tool, toolName: USER_TOOLS[nd.d.tool].name, timeframe: nd.d.timeframe,
        parentId: nd.parentId, parentLeg: nd.leg, parentLegName: nd.legName || null, depth: nd.depth, duplicate: !!nd.duplicate,
        issues: nd.issues, verdict: fv, verdictLabel: fv === 'ERROR' ? '无法评估' : VERDICTS[fv],
        name: nd.result ? nd.result.primary.name : USER_TOOLS[nd.d.tool].name,
        error: nd.error, result: nd.result
      };
    });
    const verdict = worstVerdict(out.map(x => x.verdict));
    const roots = out.filter(x => !x.parentId);
    const lines = [];
    out.slice().sort((a, b) => a.depth - b.depth).forEach(x => {
      const where = x.parentId ? `${byId[x.parentId] ? (USER_TOOLS[byId[x.parentId].d.tool] || {}).name : ''}·${x.parentLegName}的子浪` : '母浪';
      lines.push(`${'　'.repeat(x.depth)}${where}「${x.name}」（${x.timeframe}）：${x.verdictLabel}`);
    });
    lines.push('只讨论波浪，没有任何交易建议，不对任何交易行为负责。');
    return {
      symbol, mode: 'USER_SKETCH', engineVersion: VERSION, analysisTime: new Date().toISOString(),
      verdict, verdictLabel: verdict === 'ERROR' ? '部分无法评估' : VERDICTS[verdict],
      roots: roots.map(x => x.id), nodes: out, lines
    };
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
    evaluateUserCount,
    evaluateUserSketch,
    buildSketchTree,
    USER_TOOLS,
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
    buildLiuSignals,
    _internal: { diagonalRole, findMotiveTyped, truncatedFifth, probeLegStructure, snapUserPoints, projectLive, refineSubTime, buildTimeWindows, classifyCorrectiveLeg, alternationFor, combinationComponents, matchCorrectiveOn, buildLevels, maxCounterMove, buildDegreeLadder, collectCandidates, mkGeom, buildLegTable, legStructure, computeLegStructure, findMotiveCount, zigzagPivots, identifyRangeExtrema, analyzePrecedingContext, buildDualScenario, counterRolesForR }
  };
});
