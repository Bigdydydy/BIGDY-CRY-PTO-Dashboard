/**
 * 柳玉冬《波浪理论详解》与实战量化研判引擎 (Liu Yudong Elliott Wave Theory Engine)
 * 全谱系波浪分类、分形嵌套穿透、并列候选打分、阻碍诊断与监测点推演
 *
 * 核心架构遵循柳玉冬手稿（1~378页）与实战体系，并对标 TradingView 艾略特波浪指标的
 * 工程实践（ZigZag 摆动骨架 + 双级别嵌套 + 规则校验 + 备选计数）：
 * 1. ATR 自适应 ZigZag 拐点引擎（偏离阈值 + 最小深度 + 尾段未确认标记）
 * 2. 驱动浪检验 (标准推动浪 1-2-3-5、引导楔形 LD、终结楔形 ED、延伸与第5浪_truncation_)
 * 3. 调整浪检验 (单锯齿 5-3-5 双向、平台形 3-3-5 [常规/扩散/顺势] 双向、
 *    收缩/扩散三角形、双锯齿 W-X-Y 双向)
 * 4. “出身决定命运”量化校验 —— 逐候选穿透 1H/15m 检验其第一段是否为纯正 5 浪
 * 5. 真实次级别子浪嵌套（细粒度 ZigZag 标注 i~v / a~c；数据不足标记 unresolved，不伪造拐点）
 * 6. 并列候选浪型穷举 + 量化评分 (铁律门槛 + 斐波那契 + 交替准则 + 通道 + 量能 + 时间 + 出身)
 * 7. 每个候选给出柳玉冬式三点位：确认点、失效点（监测点）、防守点与斐波那契位阶表
 * 8. 阻碍诊断引擎与双情景推演
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LiuWaveEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  // ============================================================
  // 基础工具
  // ============================================================

  /**
   * 平均真实波幅 (ATR) —— 用于自适应 ZigZag 偏离阈值与“最小浪腿”噪声过滤
   * @returns {number} 全样本均值口径的 ATR
   */
  function computeATR(bars, period = 14) {
    if (!bars || bars.length < 2) return 0;
    const trs = [];
    for (let i = 1; i < bars.length; i++) {
      const h = bars[i].high;
      const l = bars[i].low;
      const pc = bars[i - 1].close;
      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    if (trs.length === 0) return 0;
    // 全样本均值比“最后14根”更稳：选区任意截取后都能代表该区间波动率
    const tail = trs.slice(-Math.max(period, Math.floor(trs.length / 2)));
    return tail.reduce((a, b) => a + b, 0) / tail.length;
  }

  /**
   * 识别 K 线高低摆动拐点 (分形窗口 Pivots)
   * 保留为微观结构检验与兼容层使用；主分析改由 zigzagPivots 驱动
   */
  function findPivots(bars, k = 5) {
    if (!bars || bars.length < 4) return [];
    const n = bars.length;
    const effectiveK = Math.max(2, Math.min(k, Math.floor(n / 6)));
    const rawPivots = [];

    for (let i = effectiveK; i < n - effectiveK; i++) {
      const high = bars[i].high;
      const low = bars[i].low;

      let isHigh = true;
      let isLow = true;

      for (let j = -effectiveK; j <= effectiveK; j++) {
        if (j === 0) continue;
        if (bars[i + j].high > high) isHigh = false;
        if (bars[i + j].low < low) isLow = false;
      }

      if (isHigh && !isLow) {
        rawPivots.push({ index: i, time: bars[i].time, price: high, type: 'high' });
      } else if (isLow && !isHigh) {
        rawPivots.push({ index: i, time: bars[i].time, price: low, type: 'low' });
      } else if (isHigh && isLow) {
        if (bars[i].close >= bars[i].open) {
          rawPivots.push({ index: i, time: bars[i].time, price: high, type: 'high' });
        } else {
          rawPivots.push({ index: i, time: bars[i].time, price: low, type: 'low' });
        }
      }
    }

    anchorEdges(bars, rawPivots);
    return enforceAlternation(rawPivots);
  }

  /**
   * 为拐点序列补首尾边界锚点（含“尾段实时锚点”，标记 live:true 表示未确认）
   */
  function anchorEdges(bars, rawPivots) {
    const n = bars.length;
    if (rawPivots.length > 0) {
      const first = rawPivots[0];
      if (first.type === 'high') {
        let minLow = Infinity, minIdx = 0;
        for (let i = 0; i < first.index; i++) {
          if (bars[i].low < minLow) { minLow = bars[i].low; minIdx = i; }
        }
        if (minLow < first.price) {
          rawPivots.unshift({ index: minIdx, time: bars[minIdx].time, price: minLow, type: 'low' });
        }
      } else {
        let maxHigh = -Infinity, maxIdx = 0;
        for (let i = 0; i < first.index; i++) {
          if (bars[i].high > maxHigh) { maxHigh = bars[i].high; maxIdx = i; }
        }
        if (maxHigh > first.price) {
          rawPivots.unshift({ index: maxIdx, time: bars[maxIdx].time, price: maxHigh, type: 'high' });
        }
      }
    } else if (n >= 2) {
      let minLow = Infinity, minIdx = 0;
      let maxHigh = -Infinity, maxIdx = 0;
      for (let i = 0; i < n; i++) {
        if (bars[i].low < minLow) { minLow = bars[i].low; minIdx = i; }
        if (bars[i].high > maxHigh) { maxHigh = bars[i].high; maxIdx = i; }
      }
      if (minIdx < maxIdx) {
        rawPivots.push({ index: minIdx, time: bars[minIdx].time, price: minLow, type: 'low' });
        rawPivots.push({ index: maxIdx, time: bars[maxIdx].time, price: maxHigh, type: 'high' });
      } else {
        rawPivots.push({ index: maxIdx, time: bars[maxIdx].time, price: maxHigh, type: 'high' });
        rawPivots.push({ index: minIdx, time: bars[minIdx].time, price: minLow, type: 'low' });
      }
    }

    if (rawPivots.length > 0) {
      const last = rawPivots[rawPivots.length - 1];
      if (last.type === 'high') {
        let minLow = Infinity, minIdx = last.index;
        for (let i = last.index + 1; i < n; i++) {
          if (bars[i].low < minLow) { minLow = bars[i].low; minIdx = i; }
        }
        if (minIdx > last.index && minLow < last.price) {
          rawPivots.push({ index: minIdx, time: bars[minIdx].time, price: minLow, type: 'low', live: true });
        }
      } else {
        let maxHigh = -Infinity, maxIdx = last.index;
        for (let i = last.index + 1; i < n; i++) {
          if (bars[i].high > maxHigh) { maxHigh = bars[i].high; maxIdx = i; }
        }
        if (maxIdx > last.index && maxHigh > last.price) {
          rawPivots.push({ index: maxIdx, time: bars[maxIdx].time, price: maxHigh, type: 'high', live: true });
        }
      }
    }
  }

  /**
   * 强制严格交替 (High -> Low -> High -> Low)，同型相邻保留更极端者
   */
  function enforceAlternation(rawPivots) {
    const alternated = [];
    for (const p of rawPivots) {
      if (alternated.length === 0) {
        alternated.push(p);
        continue;
      }
      const prev = alternated[alternated.length - 1];
      if (p.type === prev.type) {
        if (p.type === 'high' && p.price > prev.price) {
          alternated[alternated.length - 1] = p;
        } else if (p.type === 'low' && p.price < prev.price) {
          alternated[alternated.length - 1] = p;
        }
      } else {
        alternated.push(p);
      }
    }
    return alternated;
  }

  /**
   * ZigZag 摆动骨架引擎（对标 TradingView ZigZag/艾略特指标的摆动提取层）
   *
   * 算法：分形拐点 → 反复剔除“最小且低于偏离阈值”的浪腿 → 同型合并保留极值。
   * 偏离阈值 devPct 默认自适应：dev = clamp(2.0 × ATR/price, 1.5%, 9%)。
   * 若所得拐点过少则自动放宽阈值重试，保证窄选区也能出骨架。
   *
   * @param {Array} bars K线数组
   * @param {Object} opts { devPct, depth }
   * @returns {Array} 严格交替拐点 [{index,time,price,type,live?,devPct}]
   */
  function zigzagPivots(bars, opts = {}) {
    if (!bars || bars.length < 4) return [];
    const price = bars[bars.length - 1].close;
    const atr = computeATR(bars);
    const autoDev = atr > 0 ? (2.5 * atr) / price : 0.03;
    let baseDev = opts.devPct || Math.min(0.10, Math.max(0.018, autoDev));
    if (opts.devPctScale) baseDev = Math.max(0.004, baseDev * opts.devPctScale);
    const depth = opts.depth || 3;

    // 自适应放宽：阈值逐级缩小直到骨架足够丰富
    let dev = baseDev;
    for (let attempt = 0; attempt < 6; attempt++) {
      const fractal = findPivots(bars, depth);
      const filtered = filterByDeviation(fractal, dev, price);
      if (filtered.length >= 6 || dev <= 0.004) {
        return filtered.map(p => ({ ...p, live: !!p.live }));
      }
      dev *= 0.7;
    }
    return filterByDeviation(findPivots(bars, depth), 0.003, price);
  }

  /**
   * 偏离阈值过滤：反复删除幅度最小且低于阈值的浪腿，保持交替
   */
  function filterByDeviation(pivots, devPct, refPrice) {
    if (!pivots || pivots.length <= 2) return (pivots || []).slice();
    const arr = pivots.map(p => ({ ...p }));
    let guard = 0;
    while (arr.length > 2 && guard++ < 500) {
      // 找幅度最小的浪腿；末腿为未确认实时腿，始终保留以呈现当前浪位
      let minLeg = Infinity, minIdx = -1;
      const lastLegIdx = arr.length - 2;
      for (let i = 0; i < arr.length - 1; i++) {
        if (i === lastLegIdx) continue;
        const leg = Math.abs(arr[i + 1].price - arr[i].price) / refPrice;
        if (leg < minLeg) { minLeg = leg; minIdx = i; }
      }
      if (minIdx === -1 || minLeg >= devPct) break;

      // 剔除该浪腿两个端点；邻接同型合并保留更极端者
      const i = minIdx;
      const left = i > 0 ? arr[i - 1] : null;
      const right = i + 2 < arr.length ? arr[i + 2] : null;
      arr.splice(i, 2);
      if (left && right && left.type === right.type) {
        const keep = left.type === 'high'
          ? (left.price >= right.price ? left : right)
          : (left.price <= right.price ? left : right);
        const drop = keep === left ? right : left;
        arr.splice(arr.indexOf(drop), 1);
      }
      // 重新保证交替
      for (let j = arr.length - 1; j > 0; j--) {
        if (arr[j].type === arr[j - 1].type) {
          const keepIdx = arr[j].type === 'high'
            ? (arr[j].price >= arr[j - 1].price ? j : j - 1)
            : (arr[j].price <= arr[j - 1].price ? j : j - 1);
          arr.splice(keepIdx === j ? j - 1 : j, 1);
        }
      }
    }
    return arr;
  }

  // ============================================================
  // 驱动浪规则检验
  // ============================================================

  /**
   * 检验是否满足标准推动浪 1-2-3-4-5 铁律
   * 新增 rule0：浪3必须超越浪1终点（艾略特定义规则，原版漏检）
   */
  function validateImpulseRules(p0, p1, p2, p3, p4, p5 = null, isBullish = true) {
    const rules = {
      rule0_wave3_beyond_wave1: false, // 铁律0: 浪3必须超过浪1终点
      rule1_wave2_retrace: false,      // 铁律1: 浪2回撤不破浪1起点
      rule2_wave3_not_shortest: false, // 铁律2: 浪3不能是最短驱动浪
      rule3_wave4_no_overlap: false,   // 铁律3: 浪4底不进入浪1领地 (无重叠)
      passedAll: false
    };

    if (isBullish) {
      const len1 = p1.price - p0.price;
      const len3 = p3.price - p2.price;
      if (len1 <= 0 || len3 <= 0) return rules;

      rules.rule0_wave3_beyond_wave1 = p3.price > p1.price;
      rules.rule1_wave2_retrace = p2.price > p0.price;
      rules.rule3_wave4_no_overlap = p4.price > p1.price;

      if (p5) {
        const len5 = p5.price - p4.price;
        rules.rule2_wave3_not_shortest = len3 >= Math.min(len1, len5);
      } else {
        rules.rule2_wave3_not_shortest = len3 >= len1 * 0.618;
      }
    } else {
      const len1 = p0.price - p1.price;
      const len3 = p2.price - p3.price;
      if (len1 <= 0 || len3 <= 0) return rules;

      rules.rule0_wave3_beyond_wave1 = p3.price < p1.price;
      rules.rule1_wave2_retrace = p2.price < p0.price;
      rules.rule3_wave4_no_overlap = p4.price < p1.price;

      if (p5) {
        const len5 = p4.price - p5.price;
        rules.rule2_wave3_not_shortest = len3 >= Math.min(len1, len5);
      } else {
        rules.rule2_wave3_not_shortest = len3 >= len1 * 0.618;
      }
    }

    rules.passedAll = rules.rule0_wave3_beyond_wave1 && rules.rule1_wave2_retrace &&
      rules.rule2_wave3_not_shortest && rules.rule3_wave4_no_overlap;
    return rules;
  }

  /**
   * 楔形（倾斜三角形）检验：重叠 + 收缩 + 浪2不破起点
   * 返回 { isDiagonal, contracting, subtype }
   */
  function validateDiagonal(p0, p1, p2, p3, p4, isBullish) {
    const len1 = Math.abs(p1.price - p0.price);
    const len2 = Math.abs(p2.price - p1.price);
    const len3 = Math.abs(p3.price - p2.price);
    const len4 = Math.abs(p4.price - p3.price);

    let overlap, w2Ok, w3Beyond;
    if (isBullish) {
      overlap = p4.price <= p1.price && p4.price > p0.price;
      w2Ok = p2.price > p0.price;
      w3Beyond = p3.price > p1.price;
    } else {
      overlap = p4.price >= p1.price && p4.price < p0.price;
      w2Ok = p2.price < p0.price;
      w3Beyond = p3.price < p1.price;
    }

    const contracting = len1 > len3 && len2 > len4;
    const isDiagonal = overlap && contracting && w2Ok && w3Beyond;
    return { isDiagonal, contracting, overlap, w2Ok, w3Beyond };
  }

  /**
   * “出身决定命运”量化校验器 (Origin Evaluation)
   * 穿透至 1H / 15m 高频周期，严格检视指定波段是否为纯正 5 浪驱动
   */
  function evaluateOrigin(p0, p1, subBars = [], isBullish = true) {
    if (!subBars || subBars.length < 6) {
      return {
        originType: 'UNKNOWN',
        isImpulse: true,
        score: 10,
        text: '小级别微观数据不足，默认兼容推动浪与调整浪'
      };
    }

    const tStart = Math.min(p0.time, p1.time);
    const tEnd = Math.max(p0.time, p1.time);
    const legBars = subBars.filter(b => b.time >= tStart && b.time <= tEnd);

    if (legBars.length < 6) {
      return {
        originType: 'UNKNOWN',
        isImpulse: true,
        score: 10,
        text: '第一子浪持续时间短，微观拐点自洽'
      };
    }

    const microPivots = findPivots(legBars, 2);
    if (microPivots.length >= 5) {
      const subRules = validateImpulseRules(
        microPivots[0], microPivots[1], microPivots[2],
        microPivots[3], microPivots[4], microPivots[5] || null, isBullish
      );

      if (subRules.passedAll) {
        return {
          originType: 'IMPULSE_5W',
          isImpulse: true,
          score: 15,
          text: '“出身纯正”：起步微观周期（1H/15m）走出标准5波推动浪，具备大级别主升或做底/做顶的合法资格。'
        };
      }
    }

    return {
      originType: 'CORRECTIVE_3W',
      isImpulse: false,
      score: 5,
      text: '“出身为调整”：起步微观周期呈现3波折返或重叠整理，定性为反弹/回撤，无法反转原有大趋势，后市仍将回归原趋势。'
    };
  }

  /**
   * 分形子浪嵌套分解器（真实次级别 ZigZag 标注，不伪造理论拐点）
   * 在大级别波段内部，用细粒度 ZigZag 拐点打上小级别标签；
   * 若某驱动腿无法分解出 5 个子浪，标记 unresolved —— 诚实的缺失胜过自信的错误。
   *
   * @returns {Object} { subPivots, unresolvedLegs, legSubdivision }
   */
  function extractSubPivotsForLegs(macroPivots, minorPivots = [], waveType = 'IMPULSE', macroBars = null) {
    const subPivots = [];
    const unresolvedLegs = [];
    const legSubdivision = {};
    if (!macroPivots || macroPivots.length < 2) {
      return { subPivots, unresolvedLegs, legSubdivision };
    }

    // 兼容旧签名：若传入的是 K 线数组则先提取次级别拐点
    let minors = minorPivots;
    if (minorPivots.length > 0 && minorPivots[0].open !== undefined) {
      minors = zigzagPivots(minorPivots, { depth: 2 });
    } else if (minorPivots.length === 0 && macroBars) {
      minors = zigzagPivots(macroBars, { depth: 2 });
    }

    for (let legIdx = 0; legIdx < macroPivots.length - 1; legIdx++) {
      const startP = macroPivots[legIdx];
      const endP = macroPivots[legIdx + 1];
      const tA = Math.min(startP.time, endP.time);
      const tB = Math.max(startP.time, endP.time);

      const inside = (minors || []).filter(p => p.time > tA && p.time <= tB);
      const legPivots = [{ time: startP.time, price: startP.price, type: startP.type }, ...inside];

      const isMotiveLeg = (waveType.includes('IMPULSE') && legIdx % 2 === 0) ||
                          (waveType.includes('DIAGONAL')) ||
                          (waveType.includes('ZIGZAG') && (legIdx === 0 || legIdx === 2)) ||
                          (waveType.includes('FLAT') && legIdx === 2);

      const expectedCount = isMotiveLeg ? 5 : 3;
      // inside 拐点数 + 起点 ≈ 子浪个数
      const subCount = legPivots.length;

      if (subCount >= expectedCount) {
        const chosen = legPivots.slice(0, expectedCount);
        for (let sIdx = 0; sIdx < chosen.length; sIdx++) {
          const lbl = isMotiveLeg
            ? ['i', 'ii', 'iii', 'iv', 'v'][sIdx]
            : ['a', 'b', 'c'][sIdx];
          subPivots.push({
            time: chosen[sIdx].time,
            price: chosen[sIdx].price,
            label: lbl || `.${sIdx + 1}`,
            legIndex: legIdx,
            degree: 'minor'
          });
        }
        legSubdivision[legIdx] = isMotiveLeg ? 'fives' : 'threes';
      } else {
        // 数据不足/无法分解：标记 unresolved，仅绘制实际存在的次级别拐点
        if (subCount > 1) {
          for (let sIdx = 1; sIdx < legPivots.length; sIdx++) {
            subPivots.push({
              time: legPivots[sIdx].time,
              price: legPivots[sIdx].price,
              label: `·${sIdx}`,
              legIndex: legIdx,
              degree: 'minor'
            });
          }
        }
        unresolvedLegs.push(legIdx);
        legSubdivision[legIdx] = 'unresolved';
      }
    }

    return { subPivots, unresolvedLegs, legSubdivision };
  }

  /**
   * 艾略特通道模块计算器
   */
  function buildChannel(macroPivots, patternType) {
    if (!macroPivots || macroPivots.length < 3) return null;

    if (patternType.includes('IMPULSE')) {
      const p0 = macroPivots[0];
      const p1 = macroPivots[1];
      const p2 = macroPivots[2];
      const p3 = macroPivots[3] || null;
      const p4 = macroPivots[4] || null;

      if (p2 && p4 && p3) {
        return {
          type: 'PARALLEL',
          name: '2-4 基准轨道模块',
          baseLine: { pA: p2, pB: p4 },
          parallelLine: { p: p3 }
        };
      }
      return {
        type: 'PARALLEL',
        name: '0-2 基准轨道模块',
        baseLine: { pA: p0, pB: p2 },
        parallelLine: { p: p1 }
      };
    }

    if (patternType.includes('TRIANGLE') || patternType.includes('DIAGONAL')) {
      const p0 = macroPivots[0];
      const p1 = macroPivots[1];
      const p2 = macroPivots[2];
      const p3 = macroPivots[3];
      return {
        type: 'CONVERGING',
        name: '收敛艾略特通道模块',
        upperLine: { pA: p1, pB: p3 },
        lowerLine: { pA: p0, pB: p2 }
      };
    }

    const p0 = macroPivots[0];
    const p1 = macroPivots[1];
    const p2 = macroPivots[2];
    return {
      type: 'PARALLEL',
      name: '0-B 调整浪通道模块',
      baseLine: { pA: p0, pB: p2 },
      parallelLine: { p: p1 }
    };
  }

  // ============================================================
  // 评分辅助
  // ============================================================

  /** 波段成交量特性：驱动浪第3浪放量为佳，调整浪应缩量 */
  function volumeScore(bars, pivots, isMotiveThirdWave) {
    if (!bars || !pivots || pivots.length < 4) return 0;
    const segVol = (a, b) => {
      const lo = Math.min(a.index, b.index);
      const hi = Math.max(a.index, b.index);
      let s = 0, c = 0;
      for (let i = lo; i <= hi && i < bars.length; i++) {
        if (bars[i] && bars[i].volume != null) { s += bars[i].volume; c++; }
      }
      return c > 0 ? s / c : 0;
    };
    const v1 = segVol(pivots[0], pivots[1]);
    const v3 = segVol(pivots[2], pivots[3]);
    if (v1 <= 0 || v3 <= 0) return 0;
    if (isMotiveThirdWave) {
      return v3 >= v1 * 1.1 ? 5 : (v3 >= v1 * 0.8 ? 2 : 0);
    }
    return v3 < v1 ? 3 : 0;
  }

  /** 时间对称性：浪4耗时与浪2耗时之比 (文档指引：0.5~2.0 为佳) */
  function timeSymmetryScore(p2s, p4s) {
    if (!p2s || !p4s || p2s <= 0) return 0;
    const r = p4s / p2s;
    return r >= 0.5 && r <= 2.2 ? 4 : (r <= 3.5 ? 2 : 0);
  }

  /** 交替准则：浪2深则浪4宜浅（锯齿 vs 平台），浪2浅则浪4宜深 */
  function alternationScore(retrace2, retrace4) {
    if (retrace2 == null || retrace4 == null) return 0;
    const w2Deep = retrace2 >= 0.5;
    const w4Deep = retrace4 >= 0.5;
    if (w2Deep !== w4Deep) return 6;
    return 0;
  }

  /** 通道契合：浪3触及/穿越 0-2→1 平行通道顶（强势延伸佐证） */
  function channelFitScore(p0, p1, p2, p3, isBullish) {
    if (!p0 || !p1 || !p2 || !p3) return 0;
    const slope = (p2.price - p0.price) / Math.max(1, p2.index - p0.index);
    const channelTopAt3 = p1.price + slope * (p3.index - p1.index);
    if (isBullish) {
      return p3.price >= channelTopAt3 * 0.985 ? 5 : 0;
    }
    const channelBottomAt3 = p1.price + slope * (p3.index - p1.index);
    return p3.price <= channelBottomAt3 * 1.015 ? 5 : 0;
  }

  function fibZone(value, zones) {
    for (const z of zones) {
      if (value >= z[0] && value <= z[1]) return z[2];
    }
    return 0;
  }

  // ============================================================
  // 核心主分析引擎
  // ============================================================

  /**
   * @param {Array} bars 4H K线数组
   * @param {string} symbol 标的，如 'BTC/USDT'
   * @param {Object} options { bars_1h, bars_15m, startTime, endTime }
   */
  function analyzeWaves(bars, symbol = 'BTC/USDT', options = {}) {
    if (!bars || bars.length < 4) {
      throw new Error('K线数据不足，至少需要 4 根 K 线');
    }

    const opts = options || {};
    const startTime = opts.startTime ? Number(opts.startTime) : null;
    const endTime = opts.endTime ? Number(opts.endTime) : null;

    let activeBars = bars;
    if (startTime && endTime) {
      activeBars = bars.filter(b => b.time >= startTime && b.time <= endTime);
      if (activeBars.length < 4) {
        return {
          symbol,
          timeframe: '4h',
          barCount: activeBars.length,
          status: 'RANGE_TOO_NARROW',
          message: '选取的 K 线范围过窄（少于 4 根），无法构成有效波浪拐点，请在图表上扩大框选区域。',
          candidates: [],
          blockers: ['选定区间 K 线数量不足（最低需要 4 根 4H K线）'],
          scenarios: []
        };
      }
    }

    const currentPrice = activeBars[activeBars.length - 1].close;
    const atr = computeATR(activeBars);

    // 主级别摆动骨架（ZigZag，波浪数浪级别）与次级别骨架（大浪嵌套小浪）
    const pivots = zigzagPivots(activeBars, { depth: 4 });
    const minorPivots = zigzagPivots(activeBars, { depth: 2, devPctScale: 0.45 });

    if (pivots.length < 3) {
      return {
        symbol,
        timeframe: '4h',
        barCount: activeBars.length,
        currentPrice,
        status: 'INSUFFICIENT_PIVOTS',
        message: '选定区间内拐点不足，无法构建有效浪型。',
        candidates: [],
        blockers: ['区间内摆动幅度过小，未形成交替的高低分形拐点'],
        scenarios: [
          {
            name: '极窄幅箱体震荡',
            probability: 80,
            description: '行情在极小振幅内运行，暂无方向性浪型展开，等待突破箱体上下沿。'
          }
        ],
        allPivots: pivots,
        minorPivots
      };
    }

    const subBars_1h = opts.bars_1h || [];
    const subBars_15m = opts.bars_15m || [];
    const subBars = subBars_1h.length > 0 ? subBars_1h : (subBars_15m.length > 0 ? subBars_15m : activeBars);

    // 选区全幅与拐点定位（供覆盖度/贴近性评分）
    let rangeHigh = -Infinity, rangeLow = Infinity;
    for (const b of activeBars) {
      if (b.high > rangeHigh) rangeHigh = b.high;
      if (b.low < rangeLow) rangeLow = b.low;
    }

    const ctx = {
      bars: activeBars,
      subBars,
      minorPivots,
      atr,
      currentPrice,
      symbol,
      rangeHigh,
      rangeLow,
      totalRange: Math.max(1e-9, rangeHigh - rangeLow),
      pivotCount: pivots.length,
      lastPivotIndex: pivots.length - 1
    };
    const candidates = [];
    const blockers = [];

    // ==========================================
    // 穷举所有拐点窗口的合规浪型
    // ==========================================
    enumerateImpulses(pivots, ctx, candidates, blockers);
    enumerateDiagonals(pivots, ctx, candidates, blockers);
    enumerateZigzags(pivots, ctx, candidates, blockers);
    enumerateFlats(pivots, ctx, candidates, blockers);
    enumerateTriangles(pivots, ctx, candidates, blockers);
    enumerateDoubleZigzags(pivots, ctx, candidates, blockers);

    // ==========================================
    // 去重与排序：同族同起点保留最优
    // ==========================================
    const dedup = new Map();
    for (const c of candidates) {
      const key = `${c.family}_${c.pivots[0].index}`;
      const prev = dedup.get(key);
      if (!prev || c.score > prev.score) dedup.set(key, c);
    }
    const sorted = Array.from(dedup.values()).sort((a, b) => b.score - a.score);
    // 多样性配额：先保证每个已识别形态族的首席候选入榜（驱动浪解读永远可见），
    // 再按分数填充剩余名额，同族最多 3 个
    const familyBest = new Map();
    for (const c of sorted) {
      const fam = c.family || 'OTHER';
      if (!familyBest.has(fam)) familyBest.set(fam, c);
    }
    const ranked = [];
    const picked = new Set();
    const reps = Array.from(familyBest.values()).sort((a, b) => b.score - a.score);
    for (const c of reps) {
      if (ranked.length >= 8) break;
      ranked.push(c);
      picked.add(c);
    }
    const familyCount = {};
    for (const c of ranked) familyCount[c.family || 'OTHER'] = 1;
    for (const c of sorted) {
      if (picked.has(c)) continue;
      const fam = c.family || 'OTHER';
      if ((familyCount[fam] || 0) >= 3) continue;
      familyCount[fam] = (familyCount[fam] || 0) + 1;
      ranked.push(c);
      picked.add(c);
      if (ranked.length >= 8) break;
    }
    ranked.sort((a, b) => b.score - a.score);

    // 兜底：进行中波段推导
    if (ranked.length === 0) {
      ranked.push(buildDevelopingSwing(pivots, ctx));
    }

    const bestPattern = ranked[0];

    // 全局出身字段（以最优候选的第一腿为准，供既有面板渲染）
    const originAnalysis = bestPattern.originAnalysis || {
      originType: 'UNKNOWN', isImpulse: true, score: 10, text: ''
    };

    // ==========================================
    // 发展可能性讨论 (双情景推演)
    // ==========================================
    const scenarios = buildScenarios(ranked, currentPrice);

    const commentary = generateLiuCommentary(bestPattern, currentPrice, symbol);

    return {
      symbol,
      timeframe: '4h',
      barCount: activeBars.length,
      currentPrice,
      analysisTime: new Date().toISOString(),
      selectedRange: {
        startTime: activeBars[0].time,
        endTime: activeBars[activeBars.length - 1].time,
        barsCount: activeBars.length
      },
      originAnalysis,
      pattern: bestPattern,
      primaryCandidate: bestPattern,
      candidates: ranked,
      blockers: Array.from(new Set(blockers)).slice(0, 8),
      scenarios,
      commentary,
      allPivots: pivots,
      minorPivots
    };
  }

  // ============================================================
  // 形态穷举器
  // ============================================================

  /** 候选收尾：评分 + 出身穿透 + 次级别嵌套 + 通道 + 位阶 */
  function finalizeCandidate(cand, ctx) {
    const { subBars, minorPivots, bars } = ctx;

    // 逐候选出身校验：穿透该候选第一腿的微观结构
    if (cand.pivots.length >= 2) {
      const isBull = cand.pivots[1].price > cand.pivots[0].price;
      cand.originAnalysis = evaluateOrigin(cand.pivots[0], cand.pivots[1], subBars, isBull);
      if (cand.originAnalysis.isImpulse && cand.originAnalysis.originType === 'IMPULSE_5W') {
        cand.score += 8; // 出身纯正加分
      } else if (cand.originAnalysis.originType === 'CORRECTIVE_3W' &&
                 (cand.family === 'IMPULSE' || cand.family === 'DIAGONAL')) {
        cand.score -= 10; // 驱动浪出身却为调整结构 → 减分
      }
    }

    // 覆盖度加分：捕捉越大幅度走势的计数优先（TradingView 指标口径）
    const prices = cand.pivots.map(p => p.price);
    const amplitude = Math.max(...prices) - Math.min(...prices);
    cand.score += Math.round(6 * (amplitude / ctx.totalRange));

    // 贴近性加分：计数末端越接近选区最新价格，研判价值越高
    const lastP = cand.pivots[cand.pivots.length - 1];
    const totalBarIdx = Math.max(1, ctx.bars.length - 1);
    cand.score += Math.round(8 * (lastP.index / totalBarIdx));

    cand.score = Math.max(25, Math.min(100, Math.round(cand.score)));

    // 真实次级别子浪嵌套
    const sub = extractSubPivotsForLegs(cand.pivots, minorPivots, cand.family || cand.type);
    cand.subPivots = sub.subPivots;
    cand.unresolvedLegs = sub.unresolvedLegs;
    cand.legSubdivision = sub.legSubdivision;
    // 驱动腿子浪完整性进入评分
    const motiveLegs = Object.keys(sub.legSubdivision).filter(
      k => (cand.family === 'IMPULSE' || cand.family === 'DIAGONAL') && Number(k) % 2 === 0
    );
    const resolvedMotive = motiveLegs.filter(k => sub.legSubdivision[k] === 'fives').length;
    if (motiveLegs.length > 0) {
      cand.subdivisionScore = Math.round((resolvedMotive / motiveLegs.length) * 8);
      cand.score = Math.max(30, Math.min(100, cand.score + cand.subdivisionScore));
    }

    cand.channel = buildChannel(cand.pivots, cand.family || cand.type);
    return cand;
  }

  /**
   * 推动浪穷举：6 拐点为完整五浪；5 拐点为第⑤浪进行中
   */
  function enumerateImpulses(P, ctx, candidates, blockers) {
    const nearMisses = { bull: [], bear: [] };

    for (let i = 0; i + 4 < P.length; i++) {
      const w = P.slice(i, i + 6); // p0..p5 (p5 可缺省)
      const [p0, p1, p2, p3, p4] = w;
      const p5 = w[5] || null;

      // 上升形态 L-H-L-H-L(-H)
      if (p0.type === 'low' && p1.type === 'high' && p2.type === 'low' && p3.type === 'high' && p4.type === 'low') {
        const rules = validateImpulseRules(p0, p1, p2, p3, p4, p5, true);
        if (rules.passedAll) {
          candidates.push(buildImpulse(w, true, ctx, p5 != null));
        } else {
          collectImpulseBlocker(nearMisses.bull, rules, w, true);
        }
      }

      // 下跌形态 H-L-H-L-H(-L)
      if (p0.type === 'high' && p1.type === 'low' && p2.type === 'high' && p3.type === 'low' && p4.type === 'high') {
        const rules = validateImpulseRules(p0, p1, p2, p3, p4, p5, false);
        if (rules.passedAll) {
          candidates.push(buildImpulse(w, false, ctx, p5 != null));
        } else {
          collectImpulseBlocker(nearMisses.bear, rules, w, false);
        }
      }
    }

    // 只输出最有信息量的阻碍诊断（每个方向至多保留最具代表性的 2 条）
    for (const dir of ['bull', 'bear']) {
      for (const msg of nearMisses[dir].slice(0, 2)) blockers.push(msg);
    }
  }

  function collectImpulseBlocker(list, rules, w, isBull) {
    const [p0, p1, , p3, p4] = w;
    const dirName = isBull ? '上升' : '下跌';
    if (!rules.rule3_wave4_no_overlap && p1 && p4) {
      list.push(`【${dirName}推动浪被否决】：第 4 浪 (${fmtP(p4.price)}) 刺入第 1 浪顶点 (${fmtP(p1.price)})，存在价格重叠，违背柳玉冬推动浪第 4 浪不得切入第 1 浪领地的核心铁律。`);
    } else if (!rules.rule0_wave3_beyond_wave1 && p1 && p3) {
      list.push(`【${dirName}推动浪被否决】：第 3 浪未能超越第 1 浪终点 (${fmtP(p1.price)})，驱动结构不成立 —— 更可能属于调整浪或楔形。`);
    } else if (!rules.rule2_wave3_not_shortest) {
      list.push(`【${dirName}推动浪被否决】：第 3 浪幅度过小，成为各驱动浪中最短一浪，违背浪 3 绝非最短浪铁律。`);
    } else if (!rules.rule1_wave2_retrace) {
      list.push(`【${dirName}推动浪被否决】：第 2 浪越过第 1 浪起点，波浪基础不成立。`);
    }
  }

  function buildImpulse(w, isBull, ctx, completed) {
    const [p0, p1, p2, p3, p4] = w;
    const p5 = w[5] || null;

    const len1 = Math.abs(p1.price - p0.price);
    const len3 = Math.abs(p3.price - p2.price);
    const len5 = p5 ? Math.abs(p5.price - p4.price) : 0;
    const retrace2 = Math.abs(p2.price - p1.price) / len1;
    const retrace4 = Math.abs(p4.price - p3.price) / len3;
    const ratio3_1 = len3 / len1;

    // ---- 柳玉冬复合评分 ----
    let score = 50; // 铁律全过硬性门槛分（驱动浪为信息含量最高的计数）

    // 斐波那契质量（浪3延伸为常见形态，单独设高档区）
    score += fibZone(ratio3_1, [[1.5, 2.8, 14], [2.8, 7.5, 12], [1.0, 4.5, 8], [0.8, 8, 4]]);
    score += fibZone(retrace2, [[0.5, 0.786, 8], [0.382, 0.886, 5], [0.236, 1.0, 2]]);
    score += fibZone(retrace4, [[0.236, 0.5, 8], [0.5, 0.618, 4], [0.1, 0.236, 4]]);

    // 指导方针
    score += alternationScore(retrace2, retrace4);
    score += channelFitScore(p0, p1, p2, p3, isBull);
    score += volumeScore(ctx.bars, w, true);
    const t2 = p2.index - p1.index;
    const t4 = p4.index - p3.index;
    score += timeSymmetryScore(t2, t4);

    // 延伸标注：浪3为最长驱动浪 → 标记延伸
    let extension = null;
    if (p5) {
      const lens = [len1, len3, len5];
      const maxLen = Math.max(...lens);
      if (maxLen === len3 && len3 > len1 * 1.618) extension = 'WAVE3_EXTENDED';
      else if (maxLen === len5 && len5 > len1 * 1.618) extension = 'WAVE5_EXTENDED';
      else if (maxLen === len1 && len1 > len3 * 1.618) extension = 'WAVE1_EXTENDED';
    }
    // 第5浪_truncation_（衰竭）检测
    let truncation = false;
    if (p5) {
      const beyond3 = isBull ? p5.price > p3.price : p5.price < p3.price;
      if (!beyond3) truncation = true;
    }
    if (truncation) score -= 8;

    const macroP = p5 ? [p0, p1, p2, p3, p4, p5] : [p0, p1, p2, p3, p4];
    const dir = isBull ? '上升' : '下跌';
    const extTag = extension === 'WAVE3_EXTENDED' ? ' · ③浪延伸' : extension === 'WAVE5_EXTENDED' ? ' · ⑤浪延伸' : '';
    const truncTag = truncation ? ' · ⑤浪衰竭' : '';
    const name = completed
      ? `五浪${dir}推动浪 (已完成${extTag}${truncTag})`
      : `五浪${dir}推动浪 (第 ⑤ 浪推进中)`;

    // 柳玉冬三点位：失效监测点 = 浪1顶（重叠铁律），防守点 = 浪4极值，确认点 = 浪3终点
    const invalidation = {
      price: p1.price,
      levelName: `铁律失效监测点 (①浪${isBull ? '顶' : '底'})`,
      description: `柳玉冬铁律：4浪回撤绝不能${isBull ? '跌破' : '升破'}1浪${isBull ? '顶' : '底'} ${fmtP(p1.price)}。一旦触及，该推动浪结构立即作废。`
    };
    const defense = {
      price: p4.price,
      levelName: '④浪防守位',
      description: `次级防守位于4浪${isBull ? '低' : '高'}点 ${fmtP(p4.price)}。破位预警调整级别扩大。`
    };
    const confirmation = {
      price: p3.price,
      levelName: completed ? '⑤浪后趋势延续确认点 (③浪端)' : '⑤浪延伸确认点 (③浪端)',
      description: `${isBull ? '突破' : '跌破'} ③浪端 ${fmtP(p3.price)} 确认主升浪延续；未完成⑤浪前此为运行方向。`
    };

    const targets = isBull
      ? [
          { label: '5浪等长目标 (1.000 × 浪1)', price: r2(p4.price + len1) },
          { label: '5浪黄金延伸目标 (1.618 × 浪1)', price: r2(p4.price + len1 * 1.618) },
          { label: '5浪常见收敛位 (0.618 × 0→3全程)', price: r2(p4.price + (p3.price - p0.price) * 0.618) }
        ]
      : [
          { label: '5浪等长目标 (1.000 × 浪1)', price: r2(p4.price - len1) },
          { label: '5浪极限深探 (1.618 × 浪1)', price: r2(p4.price - len1 * 1.618) },
          { label: '5浪常见收敛位 (0.618 × 0→3全程)', price: r2(p4.price - (p0.price - p3.price) * 0.618) }
        ];

    // 完成后补反转位阶
    const fibLevels = buildImpulseFibLevels(p0, p1, p2, p3, p4, p5, isBull, completed);

    const cand = {
      id: `impulse_${isBull ? 'bull' : 'bear'}_${p0.index}`,
      type: isBull ? 'IMPULSE_BULLISH' : 'IMPULSE_BEARISH',
      family: 'IMPULSE',
      category: '驱动浪 (Motive)',
      name,
      direction: isBull ? 'BULLISH' : 'BEARISH',
      score: Math.min(100, Math.round(score)),
      pivots: macroP,
      waveLabels: p5 ? ['0', '①', '②', '③', '④', '⑤'] : ['0', '①', '②', '③', '④'],
      currentWave: completed
        ? (truncation ? '⑤浪衰竭完成，警惕深度回撤' : '⑤浪完成，警惕同级别 A-B-C 调整展开')
        : '⑤浪冲刺推进中（以③浪端为确认方向）',
      position: completed
        ? { wave: 'POST_5', description: '五浪结构已完整，下一大概率事件为同级别调整浪 (a-b-c)。' }
        : { wave: 'WAVE_5', description: '当前疑似运行在上升推动浪第 ⑤ 浪。' },
      rules: { ...validateImpulseRules(p0, p1, p2, p3, p4, p5, isBull) },
      metrics: {
        wave1_length: r2(len1),
        wave3_length: r2(len3),
        wave5_length: r2(len5),
        ratio_3_to_1: Number(ratio3_1.toFixed(3)),
        retrace_2: Number(retrace2.toFixed(3)),
        retrace_4: Number(retrace4.toFixed(3)),
        extension,
        truncation
      },
      monitoringPivot: invalidation,
      invalidation,
      secondaryPivot: defense,
      defense,
      confirmPivot: confirmation,
      targets,
      fibLevels
    };
    return finalizeCandidate(cand, ctx);
  }

  function buildImpulseFibLevels(p0, p1, p2, p3, p4, p5, isBull, completed) {
    const s = isBull ? 1 : -1;
    const levels = [];
    const len1 = Math.abs(p1.price - p0.price);
    // 浪5 终点测算簇
    for (const m of [0.618, 1.0, 1.618]) {
      levels.push({
        kind: 'wave5_projection',
        label: `⑤浪 ${m} × ①浪`,
        price: r2(p4.price + s * len1 * m)
      });
    }
    if (completed && p5) {
      // 五浪完成后调整位阶：整体 0→5 的回撤带
      const whole = Math.abs(p5.price - p0.price);
      for (const m of [0.382, 0.5, 0.618]) {
        levels.push({
          kind: 'correction_retrace',
          label: `同级调整回撤 ${m}`,
          price: r2(p5.price - s * whole * m)
        });
      }
    }
    return levels;
  }

  /**
   * 楔形穷举（引导楔形 LD / 终结楔形 ED），双向
   */
  function enumerateDiagonals(P, ctx, candidates, blockers) {
    for (let i = 0; i + 4 < P.length; i++) {
      const w = P.slice(i, i + 6);
      const [p0, p1, p2, p3, p4] = w;
      const p5 = w[5] || null;

      for (const isBull of [true, false]) {
        const shape = isBull
          ? (p0.type === 'low' && p1.type === 'high' && p2.type === 'low' && p3.type === 'high' && p4.type === 'low')
          : (p0.type === 'high' && p1.type === 'low' && p2.type === 'high' && p3.type === 'low' && p4.type === 'high');
        if (!shape) continue;

        const d = validateDiagonal(p0, p1, p2, p3, p4, isBull);
        if (!d.isDiagonal) continue;

        // 若同时满足推动浪铁律，则不是楔形（推动浪优先，避免重复计数）
        const impRules = validateImpulseRules(p0, p1, p2, p3, p4, p5, isBull);
        if (impRules.passedAll) continue;

        // 引导 vs 终结：楔形出现在趋势末端（此前已有同向运行段）→ 终结楔形
        const isEnding = i >= 2;
        const subtype = isEnding ? 'ENDING_DIAGONAL' : 'LEADING_DIAGONAL';

        const len3 = Math.abs(p3.price - p2.price);
        const macroP = p5 ? [p0, p1, p2, p3, p4, p5] : [p0, p1, p2, p3, p4];
        const dir = isBull ? '上升' : '下跌';

        let score = 58 + (d.contracting ? 8 : 0);
        score += volumeScore(ctx.bars, w, false);

        const cand = {
          id: `${subtype.toLowerCase()}_${isBull ? 'bull' : 'bear'}_${p0.index}`,
          type: subtype,
          family: 'DIAGONAL',
          category: '驱动浪 (Motive)',
          name: `${dir}${isEnding ? '终结' : '引导'}楔形 (收敛型驱动浪${p5 ? '已完成' : '第(5)浪进行中'})`,
          direction: isBull ? 'BULLISH' : 'BEARISH',
          score: Math.min(100, Math.round(score)),
          pivots: macroP,
          waveLabels: p5 ? ['0', '(1)', '(2)', '(3)', '(4)', '(5)'] : ['0', '(1)', '(2)', '(3)', '(4)'],
          currentWave: isEnding
            ? '终结楔形为趋势末期结构，完成后多为急速反转'
            : '楔形收敛整理中，等待第(5)浪完成后的方向选择',
          position: { wave: 'DIAGONAL_5', description: `疑似${isEnding ? '终结' : '引导'}楔形第(5)浪构筑。` },
          rules: {
            rule1_wave2_retrace: true,
            rule3_overlap_present: true,
            rule4_contracting: d.contracting,
            passedAll: true
          },
          monitoringPivot: {
            price: p4.price,
            levelName: '楔形下轨监测点 ((4)浪端)',
            description: `临界${isBull ? '支撑' : '阻力'}在 ${fmtP(p4.price)}。保持在楔形边界内则形态有效；终结楔形破位即快速反转。`
          },
          invalidation: {
            price: p0.price,
            levelName: '楔形起点失效位',
            description: `穿越楔形起点 ${fmtP(p0.price)} 则该计数彻底失效。`
          },
          confirmPivot: {
            price: p3.price,
            levelName: '楔形第(5)浪确认点 ((3)浪端)',
            description: `越出 (3)浪端 ${fmtP(p3.price)} 确认第(5)浪展开。`
          },
          targets: [
            { label: '楔形(5)浪收缩目标 (0.618 × (3)浪)', price: r2(p4.price + (isBull ? 1 : -1) * len3 * 0.618) },
            { label: isEnding ? '终结楔形反转回楔形起点' : '引导楔形后趋势延伸位', price: r2(p0.price) }
          ]
        };
        candidates.push(finalizeCandidate(cand, ctx));
      }
    }
  }

  /**
   * 单锯齿调整浪穷举（双向）：A-B-C 5-3-5
   * 规则（对齐 TradingView 艾略特指标）：b 浪短于 a 浪（不超 a 起点）；c 浪越过 a 终点方为完成
   */
  function enumerateZigzags(P, ctx, candidates, blockers) {
    const nearMiss = [];
    for (let i = 0; i + 3 < P.length; i++) {
      const [p0, p1, p2, p3] = P.slice(i, i + 4);

      for (const down of [true, false]) {
        const shape = down
          ? (p0.type === 'high' && p1.type === 'low' && p2.type === 'high' && p3.type === 'low')
          : (p0.type === 'low' && p1.type === 'high' && p2.type === 'low' && p3.type === 'high');
        if (!shape) continue;

        const lenA = Math.abs(p1.price - p0.price);
        const lenB = Math.abs(p2.price - p1.price);
        const lenC = Math.abs(p3.price - p2.price);
        const retraceB = lenB / lenA;
        const s = down ? -1 : 1;

        // 硬规则：B 不得超过 A 起点
        const bValid = down ? p2.price < p0.price : p2.price > p0.price;
        if (!bValid || lenA <= 0) {
          if (retraceB >= 0.95 && retraceB <= 2.2) {
            nearMiss.push(`【${down ? '下跌' : '反弹'}锯齿被否决】：B 浪已${down ? '升至' : '跌破'} A 浪起点，结构更接近平台形或顺势形态。`);
          }
          continue;
        }

        // C 是否已越过 A 终点（满足单锯齿最低完成要求）
        const cComplete = down ? p3.price <= p1.price : p3.price >= p1.price;
        const ratioC_A = lenC / lenA;

        let score = 46;
        score += fibZone(retraceB, [[0.382, 0.786, 16], [0.236, 0.886, 8]]);
        score += fibZone(ratioC_A, [[0.9, 1.15, 10], [1.5, 1.7, 12], [0.55, 0.7, 8], [0.3, 2.7, 4]]);
        if (retraceB > 0.86) score -= 15; // 柳玉冬指引：>0.86 更像平台形
        if (!cComplete) score -= 6;       // c 浪未完成，降级为进行中计数
        score += volumeScore(ctx.bars, [p0, p1, p2, p3], false);

        const dirText = down ? '下跌' : '反弹';
        const macroP = [p0, p1, p2, p3];

        const cand = {
          id: `zigzag_${down ? 'down' : 'up'}_${p0.index}`,
          type: down ? 'ZIGZAG_CORRECTION' : 'ZIGZAG_RALLY',
          family: 'ZIGZAG',
          category: '调整浪 (Corrective)',
          name: `单锯齿${dirText}调整浪 (A-B-C 5-3-5${cComplete ? '，C浪达标' : '，C浪未竟'})`,
          direction: down ? 'CORRECTION_DOWN' : 'CORRECTION_UP',
          score: Math.min(100, Math.max(35, Math.round(score))),
          pivots: macroP,
          waveLabels: ['0', '(A)', '(B)', '(C)'],
          currentWave: cComplete
            ? `已满足单锯齿 (C) 浪最低要求，等待新驱动浪的“好出身”`
            : `(C) 浪运行中，尚未${down ? '跌破' : '升破'} (A) 浪终点`,
          position: cComplete
            ? { wave: 'POST_C', description: '锯齿调整最低形态要求已满足，其后常接新驱动浪或演化为 W-X-Y。' }
            : { wave: 'WAVE_C', description: '(C) 浪推进中。' },
          metrics: {
            waveA_length: r2(lenA),
            retrace_B: Number(retraceB.toFixed(3)),
            ratio_C_to_A: Number(ratioC_A.toFixed(3)),
            c_complete: cComplete
          },
          monitoringPivot: {
            price: p2.price,
            levelName: `反转监测点 ((B)浪${down ? '顶' : '底'})`,
            description: `柳玉冬实战法则：${down ? '站上' : '跌破'} (B) 浪${down ? '高点' : '低点'} ${fmtP(p2.price)}，宣告本次锯齿调整彻底结束。`
          },
          invalidation: {
            price: p2.price,
            levelName: '(B)浪端失效位',
            description: `(B) 浪端 ${fmtP(p2.price)} 为调整计数失效位。`
          },
          secondaryPivot: {
            price: p1.price,
            levelName: '(A)浪端基准点',
            description: `(A) 浪终点 ${fmtP(p1.price)}，越过即满足单锯齿最低形态。`
          },
          confirmPivot: {
            price: p0.price,
            levelName: '调整结束确认点 (0点)',
            description: `${down ? '收复' : '跌破'} 0 点 ${fmtP(p0.price)} 确认同级别调整完全结束、原趋势重启。`
          },
          targets: [
            { label: 'C浪等长目标 (1.000 × A)', price: r2(p2.price + s * lenA) },
            { label: 'C浪黄金扩展 (1.618 × A)', price: r2(p2.price + s * lenA * 1.618) },
            { label: 'C浪弱势收敛 (0.618 × A)', price: r2(p2.price + s * lenA * 0.618) }
          ],
          fibLevels: [0.618, 1.0, 1.618].map(m => ({
            kind: 'wave_c_projection',
            label: `(C)浪 ${m} × (A)浪`,
            price: r2(p2.price + s * lenA * m)
          }))
        };
        candidates.push(finalizeCandidate(cand, ctx));
      }
    }
    for (const m of nearMiss.slice(0, 2)) blockers.push(m);
  }

  /**
   * 平台形调整浪穷举（双向）：B 浪 ≥ 70% × A 浪 (柳玉冬手稿硬性指标)
   * 子型：常规 (B 0.7~1.05) / 扩散 (B > 1.05 且 C 超越 A 端) / 顺势 (B > 1.05 且 C 不达 A 端)
   */
  function enumerateFlats(P, ctx, candidates, blockers) {
    const nearMiss = [];
    for (let i = 0; i + 3 < P.length; i++) {
      const [p0, p1, p2, p3] = P.slice(i, i + 4);

      for (const down of [true, false]) {
        const shape = down
          ? (p0.type === 'high' && p1.type === 'low' && p2.type === 'high' && p3.type === 'low')
          : (p0.type === 'low' && p1.type === 'high' && p2.type === 'low' && p3.type === 'high');
        if (!shape) continue;

        const lenA = Math.abs(p1.price - p0.price);
        const lenB = Math.abs(p2.price - p1.price);
        const lenC = Math.abs(p3.price - p2.price);
        const retraceB = lenB / lenA;
        const s = down ? -1 : 1;
        if (lenA <= 0) continue;

        if (retraceB < 0.70) {
          if (retraceB >= 0.45) {
            nearMiss.push(`【平台形被排除】：B浪回撤仅达 A 浪的 ${(retraceB * 100).toFixed(1)}%，未满足柳玉冬《验证手册》B 浪回撤 ≥ 70% 硬性指标，更接近锯齿形。`);
          }
          continue;
        }
        if (retraceB > 2.2) continue; // 超出平台形容忍度

        // C 端相对 A 端的位置
        const cBeyond = down ? p3.price < p1.price : p3.price > p1.price;
        let flatSubtype, flatName, score;
        if (retraceB > 1.05) {
          if (cBeyond) {
            flatSubtype = 'EXPANDED_FLAT';
            flatName = '扩散平台形 (Expanded Flat · 假突破洗盘)';
            score = 74;
          } else {
            flatSubtype = 'RUNNING_FLAT';
            flatName = '顺势平台形 (Running Flat · 顺大势极强)';
            score = 72;
          }
        } else {
          flatSubtype = 'REGULAR_FLAT';
          flatName = '常规平台形 (Regular Flat)';
          score = 66;
        }
        score += fibZone(lenC / lenA, [[0.9, 1.15, 8], [1.5, 1.7, 6], [0.55, 0.75, 5]]);
        score += volumeScore(ctx.bars, [p0, p1, p2, p3], false);

        const dirText = down ? '下跌' : '反弹';
        const macroP = [p0, p1, p2, p3];

        const cand = {
          id: `flat_${flatSubtype.toLowerCase()}_${down ? 'down' : 'up'}_${p0.index}`,
          type: flatSubtype,
          family: 'FLAT',
          category: '调整浪 (Corrective)',
          name: `${flatName} — ${dirText}向`,
          direction: down ? 'CORRECTION_DOWN' : 'CORRECTION_UP',
          score: Math.min(100, Math.round(score)),
          pivots: macroP,
          waveLabels: ['0', '(A)', '(B)', '(C)'],
          currentWave: flatSubtype === 'RUNNING_FLAT'
            ? '顺势平台形收尾，随时展开顺大趋势单边行情'
            : '平台形 (C) 浪探底/冲顶阶段',
          position: { wave: 'WAVE_C', description: '平台形调整 (C) 浪阶段。' },
          metrics: {
            waveA_length: r2(lenA),
            retrace_B: Number(retraceB.toFixed(3)),
            ratio_C_to_A: Number((lenC / lenA).toFixed(3))
          },
          monitoringPivot: {
            price: p2.price,
            levelName: '平台形反转突破点 ((B)浪端)',
            description: `突破 (B) 浪端 ${fmtP(p2.price)}，宣告平台形调整结构全面结束。`
          },
          invalidation: {
            price: down ? p2.price + lenA * 0.3 : p2.price - lenA * 0.3,
            levelName: 'B浪超限失效位',
            description: `(B) 浪若过度延伸越过 ${fmtP(down ? p2.price + lenA * 0.3 : p2.price - lenA * 0.3)}，平台形计数失效。`
          },
          secondaryPivot: {
            price: p1.price,
            levelName: '(A)浪端基准位',
            description: `(A) 浪端位于 ${fmtP(p1.price)}。`
          },
          confirmPivot: {
            price: p0.price,
            levelName: '调整结束确认点 (0点)',
            description: `${down ? '收复' : '跌破'} 0 点 ${fmtP(p0.price)} 确认平台形完结、原趋势重启。`
          },
          targets: [
            { label: 'C浪等长位 (1.000 × A)', price: r2(p2.price + s * lenA) },
            { label: 'C浪扩展位 (1.272 × A)', price: r2(p2.price + s * lenA * 1.272) },
            { label: 'C浪深扩展 (1.618 × A)', price: r2(p2.price + s * lenA * 1.618) }
          ],
          fibLevels: [1.0, 1.272, 1.618].map(m => ({
            kind: 'wave_c_projection',
            label: `(C)浪 ${m} × (A)浪`,
            price: r2(p2.price + s * lenA * m)
          }))
        };
        candidates.push(finalizeCandidate(cand, ctx));
      }
    }
    for (const m of nearMiss.slice(0, 2)) blockers.push(m);
  }

  /**
   * 三角形穷举：收缩（柳玉冬“0.5,0.5,0.5,0.25”口诀）与扩散
   */
  function enumerateTriangles(P, ctx, candidates, blockers) {
    for (let i = 0; i + 5 < P.length; i++) {
      const w = P.slice(i, i + 6);
      const [p0, p1, p2, p3, p4, p5] = w;

      const lenA = Math.abs(p1.price - p0.price);
      const lenB = Math.abs(p2.price - p1.price);
      const lenC = Math.abs(p3.price - p2.price);
      const lenD = Math.abs(p4.price - p3.price);
      const lenE = Math.abs(p5.price - p4.price);

      // 收缩三角形：逐腿递减 + 手稿口诀地板
      const contracting =
        lenB < lenA * 1.02 && lenC < lenB * 1.02 && lenD < lenC * 1.02 && lenE < lenD * 1.02;
      const liuFloors =
        lenB >= 0.48 * lenA && lenC >= 0.48 * lenB && lenD >= 0.48 * lenC && lenE >= 0.24 * lenD;

      // 收缩上下轨收敛检查（高点降低、低点抬高）
      const highs = [p0, p1, p2, p3, p4, p5].filter(p => p.type === 'high').map(p => p.price);
      const lows = [p0, p1, p2, p3, p4, p5].filter(p => p.type === 'low').map(p => p.price);
      const converging = highs.length >= 2 && lows.length >= 2 &&
        highs[highs.length - 1] <= highs[0] * 1.005 &&
        lows[lows.length - 1] >= lows[0] * 0.995;

      // 扩散三角形：逐腿递增
      const expanding =
        lenB > lenA * 1.02 && lenC > lenB * 1.02 && lenD > lenC * 1.02 && lenE > lenD * 1.02;

      if (contracting && liuFloors && converging) {
        const macroP = [p0, p1, p2, p3, p4, p5];
        const isBullBase = p0.price < p1.price;
        let score = 68;
        score += volumeScore(ctx.bars, w, false);
        // 三角形突破测量：最宽浪腿自突破方向投射
        const thrustTarget = isBullBase ? p5.price + lenA : p5.price - lenA;

        candidates.push(finalizeCandidate({
          id: `triangle_contracting_${p0.index}`,
          type: 'CONTRACTING_TRIANGLE',
          family: 'TRIANGLE',
          category: '调整浪 (Corrective)',
          name: '收缩三角形调整浪 (a-b-c-d-e 3-3-3-3-3)',
          direction: isBullBase ? 'BULLISH_CONSOLIDATION' : 'BEARISH_CONSOLIDATION',
          score: Math.min(100, Math.round(score)),
          pivots: macroP,
          waveLabels: ['0', 'a', 'b', 'c', 'd', 'e'],
          currentWave: 'e浪收官区域，等待放量突破三角形边界（警惕假突破）',
          position: { wave: 'WAVE_E', description: '三角形末段，突破后常走急速“推力”行情。' },
          rules: { ratio_rule_passed: true, ratio_formula: '满足柳玉冬手稿 0.5-0.5-0.5-0.25 黄金口诀' },
          metrics: { legs_ratio: [lenB / lenA, lenC / lenB, lenD / lenC, lenE / lenD].map(x => Number(x.toFixed(3))) },
          monitoringPivot: {
            price: p4.price,
            levelName: '三角形突破触发点 (d点)',
            description: `突破 d 浪极值 ${fmtP(p4.price)} 将确认三角形完成并展开迅猛突破。`
          },
          invalidation: {
            price: isBullBase ? Math.min(p0.price, p2.price) : Math.max(p0.price, p2.price),
            levelName: '三角形结构失效位',
            description: `跌破 ${fmtP(isBullBase ? Math.min(p0.price, p2.price) : Math.max(p0.price, p2.price))} 则三角形计数作废。`
          },
          confirmPivot: {
            price: p4.price,
            levelName: '突破确认点 (d点)',
            description: `越出 d 点 ${fmtP(p4.price)} 为突破确认。`
          },
          targets: [
            { label: '三角形推力等宽测量目标', price: r2(thrustTarget) },
            { label: '保守推力位 (0.618 × 最宽腿)', price: r2(isBullBase ? p5.price + lenA * 0.618 : p5.price - lenA * 0.618) }
          ]
        }, ctx));
      } else if (expanding && lenE <= lenA * 4) {
        const macroP = [p0, p1, p2, p3, p4, p5];
        const isBullBase = p0.price < p1.price;
        candidates.push(finalizeCandidate({
          id: `triangle_expanding_${p0.index}`,
          type: 'EXPANDING_TRIANGLE',
          family: 'TRIANGLE',
          category: '调整浪 (Corrective)',
          name: '扩散三角形调整浪 (a-b-c-d-e，喇叭形)',
          direction: isBullBase ? 'BULLISH_CONSOLIDATION' : 'BEARISH_CONSOLIDATION',
          score: 66,
          pivots: macroP,
          waveLabels: ['0', 'a', 'b', 'c', 'd', 'e'],
          currentWave: '扩散喇叭形态末端，波动极端化，等待 e 浪完成后的反转',
          position: { wave: 'WAVE_E', description: '扩散三角形末段。' },
          rules: { ratio_rule_passed: true, ratio_formula: '逐腿递增扩散形态' },
          monitoringPivot: {
            price: p5.price,
            levelName: '扩散三角形 e 点反转监测',
            description: `e 浪完成后通常向相反方向急速回归，盯紧 ${fmtP(p5.price)}。`
          },
          targets: [
            { label: '扩散三角形回中轨目标', price: r2((p0.price + p5.price) / 2) }
          ]
        }, ctx));
      }
    }
  }

  /**
   * 双锯齿 W-X-Y 穷举（双向）：8 拐点窗口 = W(4) + X(1腿) + Y(4)，或 7 拐点 Y 未竟
   */
  function enumerateDoubleZigzags(P, ctx, candidates, blockers) {
    for (let i = 0; i + 6 < P.length; i++) {
      const w8 = P.slice(i, i + 8);
      const w7 = P.slice(i, i + 7);

      for (const down of [true, false]) {
        // down 双锯齿形状: H-L-H-L | H | L-H-L(-H?) → W=H0,L1,H2,L3; X=L3→H4; Y=H4,L5,H6,L7
        const shapeOk = (seq) => {
          const t = seq.map(p => p.type);
          const need = down ? ['high', 'low', 'high', 'low', 'high', 'low', 'high'] : ['low', 'high', 'low', 'high', 'low', 'high', 'low'];
          for (let j = 0; j < need.length && j < t.length; j++) {
            if (t[j] !== need[j]) return false;
          }
          return true;
        };

        const seq = w8.length === 8 ? w8 : w7;
        if (seq.length < 7 || !shapeOk(seq)) continue;

        const W = seq.slice(0, 4);
        const X = seq.slice(3, 5); // L3..H4
        const Y = seq.slice(4);    // H4..L7

        const lenW = Math.abs(W[3].price - W[0].price);
        const lenX = Math.abs(X[1].price - X[0].price);
        const lenY = Math.abs(Y[Y.length - 1].price - Y[0].price);
        const s = down ? -1 : 1;

        // X 回撤 W 的一部分（典型 0.382~0.786）
        const xRetrace = lenX / (lenW + 1e-9);
        if (xRetrace < 0.2 || xRetrace > 0.95) continue;

        // Y 与 W 等长为典型 (0.9~1.15)，进行中允许 Y < W
        const yRatio = lenY / (lenW + 1e-9);
        const yComplete = Y.length >= 4;
        if (yComplete && (yRatio < 0.3)) continue;

        let score = 56;
        score += fibZone(xRetrace, [[0.382, 0.786, 14], [0.2, 0.95, 6]]);
        score += fibZone(yRatio, [[0.9, 1.15, 12], [1.2, 1.7, 8], [0.5, 0.9, 6]]);

        const dirText = down ? '下跌' : '反弹';
        const macroP = seq;

        candidates.push(finalizeCandidate({
          id: `double_zigzag_${down ? 'down' : 'up'}_${seq[0].index}`,
          type: down ? 'DOUBLE_ZIGZAG_DOWN' : 'DOUBLE_ZIGZAG_UP',
          family: 'DOUBLE_ZIGZAG',
          category: '调整浪 (Corrective)',
          name: `双锯齿${dirText}调整浪 (W-X-Y 复式结构${yComplete ? '' : '，Y浪未竟'})`,
          direction: down ? 'CORRECTION_DOWN' : 'CORRECTION_UP',
          score: Math.min(100, Math.round(score)),
          pivots: macroP,
          waveLabels: down
            ? ['0', '(A)', '(B)', '(C)/W', '(X)', 'a', 'b', 'c/Y'].slice(0, macroP.length)
            : ['0', '(A)', '(B)', '(C)/W', '(X)', 'a', 'b', 'c/Y'].slice(0, macroP.length),
          currentWave: yComplete ? 'Y 浪结构完整，复式调整濒临尾声' : 'Y 浪推进中，复式调整未完',
          position: { wave: 'WAVE_Y', description: '复式三浪 Y 段运行，整体调整级别大于单锯齿。' },
          metrics: {
            x_retrace_of_W: Number(xRetrace.toFixed(3)),
            y_to_W_ratio: Number(yRatio.toFixed(3)),
            y_complete: yComplete
          },
          monitoringPivot: {
            price: X[1].price,
            levelName: '复式反转监测点 (X浪端)',
            description: `柳玉冬实战法则：${down ? '站上' : '跌破'} X 浪端 ${fmtP(X[1].price)} 即否定复式下跌计数。`
          },
          invalidation: {
            price: X[1].price,
            levelName: 'X浪端失效位',
            description: `X 浪端 ${fmtP(X[1].price)} 为复式调整失效位。`
          },
          confirmPivot: {
            price: seq[0].price,
            levelName: '调整结束确认点 (0点)',
            description: `${down ? '收复' : '跌破'} 0 点 ${fmtP(seq[0].price)} 确认复式调整结束。`
          },
          targets: [
            { label: 'Y浪等长目标 (1.000 × W)', price: r2(X[1].price + s * lenW) },
            { label: 'Y浪扩展目标 (1.272 × W)', price: r2(X[1].price + s * lenW * 1.272) },
            { label: 'Y浪深扩展 (1.618 × W)', price: r2(X[1].price + s * lenW * 1.618) }
          ],
          fibLevels: [1.0, 1.272, 1.618].map(m => ({
            kind: 'wave_y_projection',
            label: `Y浪 ${m} × W`,
            price: r2(X[1].price + s * lenW * m)
          }))
        }, ctx));
      }
    }
  }

  /**
   * 兜底：进行中波段推导
   */
  function buildDevelopingSwing(pivots, ctx) {
    const pCount = pivots.length;
    const p0 = pivots[pCount - 3];
    const p1 = pivots[pCount - 2];
    const p2 = pivots[pCount - 1];

    const isUp = p2.type === 'high';
    const invalidation = p1.price;
    const swingLen = Math.abs(p2.price - p1.price);

    const cand = {
      id: 'swing_developing',
      type: 'SWING_DEVELOPING',
      family: 'SWING',
      category: '孵化未定型',
      name: isUp ? '多头延伸波段 (次级主升推进中)' : '空头修正波段 (震荡寻底中)',
      direction: isUp ? 'BULLISH' : 'BEARISH',
      score: 45,
      pivots: [p0, p1, p2],
      waveLabels: isUp ? ['(1)', '(2)', '(3)'] : ['(A)', '(B)', '(C)'],
      currentWave: isUp ? '次级 3 浪推进中' : '次级 C 浪回撤中',
      position: { wave: 'DEVELOPING', description: '浪型孵化期，暂无可定级结构。' },
      monitoringPivot: {
        price: invalidation,
        levelName: isUp ? '多头防守基准点' : '反弹阻力基准点',
        description: `临界监测点位于 ${fmtP(invalidation)}。保持在上方则维持多头拓展态势。`
      },
      invalidation: {
        price: invalidation,
        levelName: isUp ? '多头防守基准点' : '反弹阻力基准点',
        description: `临界监测点位于 ${fmtP(invalidation)}。`
      },
      targets: [
        { label: '波段延伸目标 1 (0.618)', price: r2(isUp ? p2.price + swingLen * 0.618 : p2.price - swingLen * 0.618) },
        { label: '波段黄金目标 2 (1.000)', price: r2(isUp ? p2.price + swingLen : p2.price - swingLen) }
      ]
    };
    return finalizeCandidate(cand, ctx);
  }

  // ============================================================
  // 情景推演
  // ============================================================

  function buildScenarios(ranked, currentPrice) {
    const scenarios = [];
    if (ranked.length >= 2) {
      scenarios.push({
        rank: 1,
        name: ranked[0].name,
        probability: Math.min(85, ranked[0].score),
        category: ranked[0].category,
        confirmTrigger: ranked[0].confirmPivot?.price || ranked[0].monitoringPivot?.price,
        invalidationLevel: ranked[0].invalidation?.price || ranked[0].monitoringPivot?.price,
        rationale: `作为主推方案，匹配度得分 ${ranked[0].score} 分，核心波浪比率与微观出身最吻合手稿标准。`
      });
      scenarios.push({
        rank: 2,
        name: ranked[1].name,
        probability: Math.max(15, Math.min(60, 100 - ranked[0].score)),
        category: ranked[1].category,
        confirmTrigger: ranked[1].confirmPivot?.price || ranked[1].monitoringPivot?.price,
        invalidationLevel: ranked[1].invalidation?.price || ranked[1].monitoringPivot?.price,
        rationale: `备选对冲方案（${ranked[1].score} 分）：若价格触及主方案失效位，立即切换至该形态计数运行。`
      });
    } else {
      const best = ranked[0];
      scenarios.push({
        rank: 1,
        name: best.name,
        probability: 70,
        confirmTrigger: best.confirmPivot?.price || best.monitoringPivot?.price,
        invalidationLevel: best.invalidation?.price || best.monitoringPivot?.price,
        rationale: '当前走势处于形态主线演进中，需盯紧监测点生命线。'
      });
      scenarios.push({
        rank: 2,
        name: '复杂双重三浪 (W-X-Y) 或横向收缩三角形',
        probability: 30,
        confirmTrigger: currentPrice * 1.02,
        invalidationLevel: currentPrice * 0.98,
        rationale: '若在当前监测点附近久盘不决，需警惕演变为更高级别的复杂横盘形态。'
      });
    }
    return scenarios;
  }

  // ============================================================
  // 研判文风
  // ============================================================

  function generateLiuCommentary(pattern, currentPrice, symbol) {
    const pivot = pattern.monitoringPivot || { price: currentPrice };
    const posText = pattern.position ? `【当前浪位】${pattern.position.description}` : '';
    let thesis = '';
    let bottomTopSignal = '';

    if (pattern.family === 'IMPULSE' || pattern.type.includes('IMPULSE')) {
      const ext = pattern.metrics?.extension === 'WAVE3_EXTENDED' ? '，且③浪呈延伸态势（三个驱动浪中最长）' : '';
      thesis = `当前 ${symbol} 4小时级别呈现出清晰的推动浪结构${ext}。三大铁律检验全部通过（浪2不破0点，浪3超越浪1终点且非最短，浪4回撤严守在浪1顶上方）。当前价格在 $${currentPrice.toLocaleString()} 附近运行。${posText}`;
      bottomTopSignal = `【监测点指引】铁律失效监测点设置在 $${pivot.price.toLocaleString()}（①浪端）。只要此线不被有效${pattern.direction === 'BULLISH' ? '跌破' : '升破'}，推动浪计数坚如磐石；一旦破位，计数立即作废，行情转入复杂平台形或复式锯齿整理。`;
    } else if (pattern.family === 'DIAGONAL' || pattern.type.includes('DIAGONAL')) {
      const ending = pattern.type === 'ENDING_DIAGONAL';
      thesis = `当前 ${symbol} 走出${ending ? '终结' : '引导'}楔形（倾斜三角形）：4浪切入1浪领地形成重叠，同时浪腿向右收敛 —— ${ending ? '此为趋势末期衰竭结构，完成后多为急速反转，切勿恋战。' : '此为新趋势的开路先锋结构，完成后往往展开凌厉主升浪。'}${posText}`;
      bottomTopSignal = `【监测点指引】楔形边界监测点位于 $${pivot.price.toLocaleString()}。${ending ? '终结楔形破位即是反转扳机。' : '引导楔形破位则计数作废。'}`;
    } else if (pattern.family === 'FLAT' || pattern.type.includes('FLAT')) {
      thesis = `当前 ${symbol} 正在经历教科书级的平台形调整浪 (${pattern.name})。B浪回撤达到手稿 70% 硬性指标以上，震荡洗盘剧烈。柳玉冬手稿指出：扩散平台形常伴随多空双杀，顺势平台形则预示原方向趋势极为暴烈。${posText}`;
      bottomTopSignal = `【监测点指引】关键监测点位于 $${pivot.price.toLocaleString()}。不破监测点不可轻言调整结束，一旦突破将迎来雷霆万钧的顺势行情！`;
    } else if (pattern.family === 'TRIANGLE' || pattern.type.includes('TRIANGLE')) {
      thesis = `当前 ${symbol} 走出${pattern.type === 'EXPANDING_TRIANGLE' ? '扩散' : '收缩'}三角形整理。${pattern.type === 'EXPANDING_TRIANGLE' ? '波幅向右逐级放大，多空分歧极端化。' : '内部五条腿严格遵循柳玉冬“0.5, 0.5, 0.5, 0.25”黄金口诀，震荡幅度向右逐级递减，两条艾略特通道线明显收敛。'}${posText}`;
      bottomTopSignal = `【监测点指引】三角形突破前常有假突破骗线，务必盯紧 d 浪监测点 $${pivot.price.toLocaleString()}，有效突破即是真金白银的爆发奇点。`;
    } else if (pattern.family === 'DOUBLE_ZIGZAG') {
      thesis = `当前 ${symbol} 正在运行双锯齿 (W-X-Y) 复式调整 —— 单锯齿不足以消化趋势时，市场以两组 a-b-c 串联放大调整级别。${posText}`;
      bottomTopSignal = `【监测点指引】复式计数失效位位于 X 浪端 $${pivot.price.toLocaleString()}。未破位前不可轻言调整结束。`;
    } else if (pattern.family === 'ZIGZAG' || pattern.type.includes('ZIGZAG')) {
      thesis = `当前 ${symbol} 正在经历单锯齿形 (a-b-c) 调整。${pattern.metrics?.c_complete ? '价格已满足“单锯齿 c 浪的最低要求”。' : '(C) 浪尚未越过 (A) 浪终点，调整未达标。'}柳玉冬波浪实战法则指出：有了推动浪或引导楔形才能做底，在没有反向次级推动确立之前，不可盲目逆势左侧重仓。${posText}`;
      bottomTopSignal = `【监测点指引】反转监测点位于 (B) 浪端 $${pivot.price.toLocaleString()}。只有小级别走出清晰的 1-2-3-4-5 推动并刺破该监测点，才宣告调整浪彻底结束。`;
    } else {
      thesis = `当前 ${symbol} 4小时周期处于波段构筑与浪型孵化期。当前价格 $${currentPrice.toLocaleString()} 正在测试波段防守位。${posText}`;
      bottomTopSignal = `【监测点指引】以当前拐点 $${pivot.price.toLocaleString()} 为第一监控阈值，关注后续能否形成五浪推动的“好出身”。`;
    }

    return {
      title: `${symbol} 4H ${pattern.name}`,
      thesis,
      bottomTopSignal,
      quote: '“愚昧无法战胜科学，波浪理论是科学。有了推动浪才有做底的可能，没有推动浪或引导楔形就完全没有可能做底。” —— 柳玉冬'
    };
  }

  function r2(x) { return Number(x.toFixed(2)); }
  function fmtP(x) { return `$${Number(x).toLocaleString()}`; }

  return {
    computeATR,
    findPivots,
    zigzagPivots,
    validateImpulseRules,
    validateDiagonal,
    evaluateOrigin,
    extractSubPivotsForLegs,
    buildChannel,
    analyzeWaves,
    generateLiuCommentary
  };
});
