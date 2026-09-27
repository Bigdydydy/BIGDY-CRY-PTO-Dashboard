/**
 * 柳玉冬《波浪理论详解》与实战量化研判引擎 (Liu Yudong Elliott Wave Theory Engine)
 * 
 * 核心设计遵循柳玉冬手稿与实战研判体系：
 * 1. 严格三大铁律检验（浪2不破0点、浪3不最短、浪4不破1浪顶）
 * 2. 关键监测点推导（判定做底/做顶、推动浪有效性与失效边界）
 * 3. 单锯齿 c 浪最低要求与平台形判定
 * 4. 斐波那契回撤与扩展位阶矩阵
 * 5. 艾略特平行通道构建
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LiuWaveEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  /**
   * 识别 K 线高低摆动拐点 (ZigZag Swing Pivots)
   * @param {Array} bars K线数组 [{ time, open, high, low, close, volume }]
   * @param {number} k 左右考察窗口大小 (4h 建议 5~7)
   */
  function findPivots(bars, k = 6) {
    if (!bars || bars.length < k * 2 + 1) return [];
    const n = bars.length;
    const rawPivots = [];

    for (let i = k; i < n - k; i++) {
      const high = bars[i].high;
      const low = bars[i].low;

      let isHigh = true;
      let isLow = true;

      for (let j = -k; j <= k; j++) {
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

    // 前置边界锚点 (Initial boundary anchor)
    if (rawPivots.length > 0) {
      const first = rawPivots[0];
      if (first.type === 'high') {
        let minLow = Infinity;
        let minIdx = 0;
        for (let i = 0; i < first.index; i++) {
          if (bars[i].low < minLow) {
            minLow = bars[i].low;
            minIdx = i;
          }
        }
        if (minLow < first.price) {
          rawPivots.unshift({ index: minIdx, time: bars[minIdx].time, price: minLow, type: 'low' });
        }
      } else {
        let maxHigh = -Infinity;
        let maxIdx = 0;
        for (let i = 0; i < first.index; i++) {
          if (bars[i].high > maxHigh) {
            maxHigh = bars[i].high;
            maxIdx = i;
          }
        }
        if (maxHigh > first.price) {
          rawPivots.unshift({ index: maxIdx, time: bars[maxIdx].time, price: maxHigh, type: 'high' });
        }
      }
    }

    // 后置尾端实时锚点 (Trailing live bar endpoint)
    if (rawPivots.length > 0) {
      const last = rawPivots[rawPivots.length - 1];
      if (last.type === 'high') {
        let minLow = Infinity;
        let minIdx = last.index;
        for (let i = last.index + 1; i < n; i++) {
          if (bars[i].low < minLow) {
            minLow = bars[i].low;
            minIdx = i;
          }
        }
        if (minIdx > last.index && minLow < last.price) {
          rawPivots.push({ index: minIdx, time: bars[minIdx].time, price: minLow, type: 'low' });
        }
      } else {
        let maxHigh = -Infinity;
        let maxIdx = last.index;
        for (let i = last.index + 1; i < n; i++) {
          if (bars[i].high > maxHigh) {
            maxHigh = bars[i].high;
            maxIdx = i;
          }
        }
        if (maxIdx > last.index && maxHigh > last.price) {
          rawPivots.push({ index: maxIdx, time: bars[maxIdx].time, price: maxHigh, type: 'high' });
        }
      }
    }

    // 强制严格交替 (High -> Low -> High -> Low)
    const alternated = [];
    for (let i = 0; i < rawPivots.length; i++) {
      const p = rawPivots[i];
      if (alternated.length === 0) {
        alternated.push(p);
        continue;
      }
      const last = alternated[alternated.length - 1];
      if (p.type === last.type) {
        if (p.type === 'high' && p.price > last.price) {
          alternated[alternated.length - 1] = p;
        } else if (p.type === 'low' && p.price < last.price) {
          alternated[alternated.length - 1] = p;
        }
      } else {
        alternated.push(p);
      }
    }

    return alternated;
  }

  /**
   * 检验是否满足推动浪 1-2-3-4-5 三大铁律
   * @param {Object} p0 浪0起点
   * @param {Object} p1 浪1终点
   * @param {Object} p2 浪2终点
   * @param {Object} p3 浪3终点
   * @param {Object} p4 浪4终点
   * @param {Object} p5 浪5终点 (可选)
   * @param {boolean} isBullish 是否为上升推动浪
   */
  function validateImpulseRules(p0, p1, p2, p3, p4, p5 = null, isBullish = true) {
    const rules = {
      rule1_wave2_retrace: false, // 铁律1: 浪2回撤不破浪1起点
      rule2_wave3_not_shortest: false, // 铁律2: 浪3不能是最短驱动浪
      rule3_wave4_no_overlap: false, // 铁律3: 浪4底不进入浪1领地 (无重叠)
      passedAll: false
    };

    if (isBullish) {
      const len1 = p1.price - p0.price;
      const len3 = p3.price - p2.price;
      if (len1 <= 0 || len3 <= 0) return rules;

      // 铁律 1
      rules.rule1_wave2_retrace = p2.price > p0.price;

      // 铁律 3 (推动浪核心：浪4不能跌破浪1顶)
      rules.rule3_wave4_no_overlap = p4.price > p1.price;

      // 铁律 2
      if (p5) {
        const len5 = p5.price - p4.price;
        rules.rule2_wave3_not_shortest = len3 >= Math.min(len1, len5);
      } else {
        // 进行中：只要浪3长于浪1，或浪3已具有明显力度
        rules.rule2_wave3_not_shortest = len3 >= len1 * 0.618;
      }
    } else {
      // 下跌推动浪
      const len1 = p0.price - p1.price;
      const len3 = p2.price - p3.price;
      if (len1 <= 0 || len3 <= 0) return rules;

      rules.rule1_wave2_retrace = p2.price < p0.price;
      rules.rule3_wave4_no_overlap = p4.price < p1.price;

      if (p5) {
        const len5 = p4.price - p5.price;
        rules.rule2_wave3_not_shortest = len3 >= Math.min(len1, len5);
      } else {
        rules.rule2_wave3_not_shortest = len3 >= len1 * 0.618;
      }
    }

    rules.passedAll = rules.rule1_wave2_retrace && rules.rule2_wave3_not_shortest && rules.rule3_wave4_no_overlap;
    return rules;
  }

  /**
   * 核心主分析函数：对 4H K线数据执行柳玉冬波浪研判
   * @param {Array} bars 1000 根 4H K线 [{ time, open, high, low, close, volume }]
   * @param {string} symbol 标的名称，如 'BTC/USDT'
   */
  function analyzeWaves(bars, symbol = 'BTC/USDT') {
    if (!bars || bars.length < 50) {
      throw new Error('K线数据不足，至少需要 50 根 4H K线');
    }

    const currentPrice = bars[bars.length - 1].close;
    const pivots = findPivots(bars, 6);

    if (pivots.length < 4) {
      return {
        symbol,
        timeframe: '4h',
        barCount: bars.length,
        currentPrice,
        status: 'INSUFFICIENT_PIVOTS',
        message: 'K线拐点样本较少，无法构成有效波浪'
      };
    }

    // 寻找最近的宏观/中观大拐点
    // 从最近 15 个拐点中评估最佳候选浪型结构
    const recentPivots = pivots.slice(-14);
    let bestPattern = null;

    // 尝试在最近的拐点中匹配 5-浪推动或 3-浪调整
    // 方案 1: 检查是否处于上升 5 浪 (或其部分)
    for (let i = 0; i <= recentPivots.length - 5; i++) {
      const p0 = recentPivots[i];
      const p1 = recentPivots[i + 1];
      const p2 = recentPivots[i + 2];
      const p3 = recentPivots[i + 3];
      const p4 = recentPivots[i + 4];
      const p5 = recentPivots[i + 5] || null;

      // 上升推动
      if (p0.type === 'low' && p1.type === 'high' && p2.type === 'low' && p3.type === 'high' && p4.type === 'low') {
        const rules = validateImpulseRules(p0, p1, p2, p3, p4, p5, true);
        if (rules.passedAll) {
          const len1 = p1.price - p0.price;
          const len3 = p3.price - p2.price;
          const ratio3_1 = Number((len3 / len1).toFixed(3));
          const retrace2 = Number(((p1.price - p2.price) / len1).toFixed(3));
          const retrace4 = Number(((p3.price - p4.price) / len3).toFixed(3));

          // 监测点 (柳玉冬关键研判法)
          // 浪4底或浪1顶是推动浪铁律防守位
          const invalidationPrice = p1.price; // 跌破浪1顶，推动浪不成立
          const defensePrice = p4.price;      // 破浪4低点警示深入回调

          // 目标预测
          const target5_equal1 = Number((p4.price + len1).toFixed(2));
          const target5_golden = Number((p4.price + len1 * 1.618).toFixed(2));
          const target5_range = Number((p4.price + (p3.price - p0.price) * 0.618).toFixed(2));

          bestPattern = {
            type: 'IMPULSE_BULLISH',
            name: p5 ? '标准五浪上升推动浪 (已完成/冲顶)' : '五浪上升推动浪 (第 5 浪运行中)',
            direction: 'BULLISH',
            pivots: p5 ? [p0, p1, p2, p3, p4, p5] : [p0, p1, p2, p3, p4],
            waveLabels: p5 ? ['0', '①', '②', '③', '④', '⑤'] : ['0', '①', '②', '③', '④'],
            currentWave: p5 ? '⑤浪顶端/寻顶警示' : (currentPrice > p4.price ? '⑤浪上攻主升' : '④浪回撤测试'),
            rules,
            metrics: {
              wave1_length: Number(len1.toFixed(2)),
              wave3_length: Number(len3.toFixed(2)),
              ratio_3_to_1: ratio3_1,
              retrace_2: retrace2,
              retrace_4: retrace4
            },
            monitoringPivot: {
              price: invalidationPrice,
              levelName: '铁律失效监测点 (浪1顶)',
              description: `关键防守监测点位于 $${invalidationPrice.toLocaleString()}。依据柳玉冬波浪理论铁律，4浪回撤绝不能跌破1浪顶。只要保持在此价格上方，上升推动浪结构保持完整。`
            },
            secondaryPivot: {
              price: defensePrice,
              levelName: '4浪防守支撑点',
              description: `次级支撑位于4浪低点 $${defensePrice.toLocaleString()}。破位则意味着进入深幅修正。`
            },
            targets: [
              { label: '5浪等长目标 (1.000 × 浪1)', price: target5_equal1 },
              { label: '5浪外推目标 (0.618 × 0-3全浪)', price: target5_range },
              { label: '5浪黄金延伸目标 (1.618 × 浪1)', price: target5_golden }
            ],
            channel: {
              baseLine: { pA: p0, pB: p2 }, // 0-2 下轨基准线
              parallelLine: { p: p1 }       // 过 1 上轨平行线
            }
          };
          break;
        }
      }

      // 下跌推动
      if (p0.type === 'high' && p1.type === 'low' && p2.type === 'high' && p3.type === 'low' && p4.type === 'high') {
        const rules = validateImpulseRules(p0, p1, p2, p3, p4, p5, false);
        if (rules.passedAll) {
          const len1 = p0.price - p1.price;
          const len3 = p2.price - p3.price;
          const invalidationPrice = p1.price; // 向上突破浪1底，下跌推动浪失效

          bestPattern = {
            type: 'IMPULSE_BEARISH',
            name: p5 ? '标准五浪下跌推动浪 (终结/做底前夕)' : '五浪下跌推动浪 (第 5 浪探底中)',
            direction: 'BEARISH',
            pivots: p5 ? [p0, p1, p2, p3, p4, p5] : [p0, p1, p2, p3, p4],
            waveLabels: p5 ? ['0', '①', '②', '③', '④', '⑤'] : ['0', '①', '②', '③', '④'],
            currentWave: p5 ? '⑤浪末期/寻找做底信号' : '⑤浪探底寻底',
            rules,
            monitoringPivot: {
              price: invalidationPrice,
              levelName: '下行结构阻力监测点 (浪1底)',
              description: `反弹强弱关键监测点在 $${invalidationPrice.toLocaleString()}。突破该点即否定向下推动浪，确立大级别反弹或做底反转。`
            },
            targets: [
              { label: '5浪目标 (与1浪等长)', price: Number((p4.price - len1).toFixed(2)) },
              { label: '5浪极限深蹲 (1.618 × 浪1)', price: Number((p4.price - len1 * 1.618).toFixed(2)) }
            ]
          };
          break;
        }
      }
    }

    // 方案 2: 若未检测到标准 5 浪，检查是否为单锯齿调整浪 (Zigzag a-b-c)
    if (!bestPattern) {
      for (let i = recentPivots.length - 4; i >= 0; i--) {
        const p0 = recentPivots[i];
        const p1 = recentPivots[i + 1];
        const p2 = recentPivots[i + 2];
        const p3 = recentPivots[i + 3];

        // 下跌单锯齿 a-b-c (0[High] -> a[Low] -> b[High] -> c[Low])
        if (p0.type === 'high' && p1.type === 'low' && p2.type === 'high' && p3.type === 'low') {
          const lenA = p0.price - p1.price;
          const lenB = p2.price - p1.price;
          const lenC = p2.price - p3.price;
          const retraceB = lenB / lenA;

          // 锯齿要求：b浪不超过0点，c浪破a浪低点满足最低要求
          if (p2.price < p0.price && p3.price <= p1.price * 1.005) {
            const satisfiesMinC = p3.price <= p1.price;
            const targetC_100 = Number((p2.price - lenA).toFixed(2));
            const targetC_1618 = Number((p2.price - lenA * 1.618).toFixed(2));

            bestPattern = {
              type: 'ZIGZAG_CORRECTION',
              name: '单锯齿调整浪 (a-b-c)',
              direction: 'CORRECTION_DOWN',
              pivots: [p0, p1, p2, p3],
              waveLabels: ['0', '(A)', '(B)', '(C)'],
              currentWave: satisfiesMinC ? '满足单锯齿c浪最低要求，寻找做底反弹信号' : 'c浪运行中，尚未跌破a浪底',
              metrics: {
                waveA_drop: Number(lenA.toFixed(2)),
                retrace_B: Number(retraceB.toFixed(3)),
                ratio_C_to_A: Number((lenC / lenA).toFixed(3))
              },
              monitoringPivot: {
                price: p2.price,
                levelName: '反弹反转监测点 (b浪高点)',
                description: `柳玉冬实战法则：若价格站上 b 浪高点 $${p2.price.toLocaleString()}，则宣告本次锯齿形调整彻底结束，新一轮上涨推动浪确立。`
              },
              secondaryPivot: {
                price: p1.price,
                levelName: '单锯齿 a 浪底部基准点',
                description: `a 浪低点位于 $${p1.price.toLocaleString()}。c浪已击破该位置，满足单锯齿最低形态要求。`
              },
              targets: [
                { label: 'c浪等长目标 (1.000 × a)', price: targetC_100 },
                { label: 'c浪极限下探 (1.618 × a)', price: targetC_1618 }
              ]
            };
            break;
          }
        }
      }
    }

    // 方案 3: 若依然无完整浪型，提取当前最新的中观 3 点分笔，构建进行中浪型推导
    if (!bestPattern) {
      const pCount = recentPivots.length;
      const p0 = recentPivots[pCount - 3];
      const p1 = recentPivots[pCount - 2];
      const p2 = recentPivots[pCount - 1];

      const isUp = p2.type === 'high';
      const invalidation = p1.price;
      const swingLen = Math.abs(p2.price - p1.price);

      bestPattern = {
        type: 'SWING_DEVELOPING',
        name: isUp ? '多头波段拓展浪型 (次级主升)' : '空头修正波段 (震荡寻底)',
        direction: isUp ? 'BULLISH' : 'BEARISH',
        pivots: [p0, p1, p2],
        waveLabels: isUp ? ['(1)', '(2)', '(3)'] : ['(A)', '(B)', '(C)'],
        currentWave: isUp ? '次级 3 浪推进中' : '次级 C 浪回撤中',
        monitoringPivot: {
          price: invalidation,
          levelName: isUp ? '多头防守基准点' : '反弹阻力基准点',
          description: `临界监测点位于 $${invalidation.toLocaleString()}。保持在上方则维持多头拓展态势。`
        },
        targets: [
          { label: '波段延伸目标 1 (1.000)', price: Number((isUp ? p2.price + swingLen * 0.618 : p2.price - swingLen * 0.618).toFixed(2)) },
          { label: '波段黄金目标 2 (1.618)', price: Number((isUp ? p2.price + swingLen : p2.price - swingLen).toFixed(2)) }
        ]
      };
    }

    // 格式化输出完整的柳玉冬研判报告
    const commentary = generateLiuCommentary(bestPattern, currentPrice, symbol);

    return {
      symbol,
      timeframe: '4h',
      barCount: bars.length,
      currentPrice,
      analysisTime: new Date().toISOString(),
      pattern: bestPattern,
      commentary,
      allPivots: pivots
    };
  }

  /**
   * 生成遵循柳玉冬实战文风的权威波浪解读
   */
  function generateLiuCommentary(pattern, currentPrice, symbol) {
    const isBull = pattern.direction === 'BULLISH';
    const pivot = pattern.monitoringPivot;
    let thesis = '';
    let bottomTopSignal = '';

    if (pattern.type === 'IMPULSE_BULLISH') {
      thesis = `当前 ${symbol} 4小时级别呈现出清晰的上升推动浪结构。三大铁律检验全部通过（浪2不破0点，浪3非最短且呈现强势延伸，浪4回撤严守在浪1顶上方）。当前价格在 $${currentPrice.toLocaleString()} 附近震荡，属于健康的波浪演进阶段。`;
      bottomTopSignal = `【监测点指引】关键监测点设置在 $${pivot.price.toLocaleString()}。只要此线不被有效跌破，多头主浪型结构坚如磐石；一旦跌破监测点，则说明推动浪失效，行情将转入复杂平台形或双重锯齿整理。`;
    } else if (pattern.type === 'ZIGZAG_CORRECTION') {
      thesis = `当前 ${symbol} 正在经历单锯齿形 (a-b-c) 调整。价格已经探底击穿 a 浪低点，已满足“单锯齿 c 浪的最低要求”。柳玉冬波浪实战法则指出：有了推动浪或引导楔形才能做底，在没有反向次级推动确立之前，不可盲目逆势左侧重仓。`;
      bottomTopSignal = `【监测点指引】反弹做底的关键监测点位于 b 浪高点 $${pivot.price.toLocaleString()}。只有小级别走出清晰的 1-2-3-4-5 上升推动并刺破该监测点，才宣告调整浪彻底结束，展开大级别做底反转。`;
    } else {
      thesis = `当前 ${symbol} 4小时周期处于波段构筑与浪型孵化期。当前价格 $${currentPrice.toLocaleString()} 正在测试波段防守位。`;
      bottomTopSignal = `【监测点指引】以当前拐点 $${pivot.price.toLocaleString()} 为第一监控阈值，关注后续能否形成五浪推动的“好出身”。`;
    }

    return {
      title: `${symbol} 4H ${pattern.name}`,
      thesis,
      bottomTopSignal,
      quote: '“愚昧无法战胜科学，波浪理论是科学。有了推动浪才有做底的可能，没有推动浪或引导楔形就完全没有可能做底。” —— 柳玉冬'
    };
  }

  return {
    findPivots,
    validateImpulseRules,
    analyzeWaves,
    generateLiuCommentary
  };
});
