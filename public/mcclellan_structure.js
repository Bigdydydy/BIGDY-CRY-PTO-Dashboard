/**
 * Module 1-B structural breadth panel (Core track only).
 *
 * Renders the descriptive `structure` block exported by the Python pipeline:
 * same-universe EW/CW price indices, their full 52-calendar-week drawdowns,
 * the EW−CW drawdown gap, median constituent drawdown, % above SMA200,
 * EW realized vol and the Alt/BTC correlation. Everything here is formatting
 * of precomputed values — no finance is calculated in this file, no network
 * calls are made, and there is deliberately no fixed danger threshold.
 *
 * Loaded before app.js: exposes window.McClellanStructure in the browser and
 * module.exports under Node for VM tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.McClellanStructure = api;
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const STATUS_LABEL = {
    ready: '就绪',
    warming_up: '52 周窗口预热中',
    incomplete_quotes: '报价不完整'
  };

  const DISCLAIMER = '结构宽度是描述性统计：不是资金流指标，也不是市场崩盘预测。' +
    '回撤使用完整 52 周日历窗口，缺失报价或日历缺口会重置指数段；' +
    '早期日期的采样时刻未经核验，历史候选池存在幸存者偏差，成分覆盖不足时读数不稳定。';

  function isNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  /** Percentage points, signed; 0 renders '0.0 pp', never '--'. */
  function fmtPp(v, digits = 1) {
    if (!isNum(v)) return '--';
    return `${v > 0 ? '+' : ''}${v.toFixed(digits)} pp`;
  }

  function fmtPct(v, digits = 1) {
    if (!isNum(v)) return '--';
    return `${v.toFixed(digits)}%`;
  }

  function fmtNum(v, digits = 2) {
    if (!isNum(v)) return '--';
    return v.toFixed(digits);
  }

  function statusText(point) {
    if (!point || !point.status) return '无数据';
    return STATUS_LABEL[point.status] || point.status;
  }

  /** Minimum prior ready observations the percentile needs (payload-declared). */
  function pctMinObs(methodology) {
    const v = methodology && methodology.gap_percentile_min_observations;
    return isNum(v) ? v : 60;
  }

  /**
   * KPI descriptors for the current structure point. Null-safe: a missing
   * point or null field yields '--' placeholders, never crashes.
   */
  function buildKpis(cur, methodology) {
    const meta = methodology || {};
    const windowDays = isNum(meta.drawdown_calendar_days) ? meta.drawdown_calendar_days : 364;
    const consec = cur && isNum(cur.consecutive_days) ? cur.consecutive_days : 0;
    const has = k => cur && isNum(cur[k]);
    const gapChip = () => {
      if (!cur || !cur.ready) return statusText(cur);
      if (isNum(cur.gap_percentile)) return `历史分位 P${Math.round(cur.gap_percentile)}`;
      return '分位样本不足';
    };
    return [
      {
        id: 'gap',
        label: '等权−市值加权 52周回撤差',
        value: fmtPp(cur && cur.drawdown_gap_pp),
        chip: gapChip(),
        sub: 'EW 与 CW 指数各自 52 周回撤之差（百分点）；描述性宽度，无固定危险阈值'
      },
      {
        id: 'window',
        label: '52 周窗口 / 覆盖',
        value: statusText(cur),
        chip: cur && cur.ready ? '窗口完整' : `${consec}/${windowDays} 天`,
        sub: has('coverage_pct')
          ? `当日覆盖 ${fmtPct(cur.coverage_pct)} · 成分 ${cur.constituents ?? '--'}/${cur.expected_constituents ?? '--'}`
          : '覆盖 --'
      },
      {
        id: 'median_dd',
        label: '成分 52 周回撤中位数',
        value: fmtPct(cur && cur.median_constituent_drawdown_52w),
        chip: `可评估 ${(cur && cur.drawdown_eligible) || 0}/${(cur && cur.constituents) || 0}`,
        sub: '仅统计各自拥有完整 52 周连续报价的成分'
      },
      {
        id: 'sma200',
        label: '成分高于 200 日均线',
        value: fmtPct(cur && cur.pct_above_sma200),
        chip: `可评估 ${(cur && cur.sma200_eligible) || 0}/${(cur && cur.constituents) || 0}`,
        sub: '每个成分需自身 200 个连续日线报价'
      },
      {
        id: 'rv30',
        label: 'Core EW 已实现波动 30d',
        value: fmtPct(cur && cur.realized_vol_30d),
        chip: `${(cur && cur.volatility_observations) || 0}/30 日`,
        sub: '等权篮子日收益年化（√365），已实现量非隐含波动率'
      },
      {
        id: 'corr',
        label: 'Alt/BTC 30 日相关',
        value: fmtNum(cur && cur.alt_btc_corr_30d),
        chip: `${(cur && cur.volatility_observations) || 0}/30 日`,
        sub: 'Core 除 BTC 成分等权日收益 与 BTC 日收益的相关性'
      }
    ];
  }

  /** Warmup / gap / percentile-calibration notice text; null when fully ready. */
  function noticeText(structure) {
    if (!structure || !structure.current) {
      return '结构宽度数据尚未生成：本快照不含结构块，重新运行导出管线后显示。';
    }
    const cur = structure.current;
    const meta = structure.methodology || {};
    const windowDays = isNum(meta.drawdown_calendar_days) ? meta.drawdown_calendar_days : 364;
    if (cur.status === 'warming_up') {
      const consec = isNum(cur.consecutive_days) ? cur.consecutive_days : 0;
      return `52 周窗口预热中：当前连续段 ${consec}/${windowDays} 天，` +
        'EW/CW 指数已发布，回撤与回撤差在窗口填满后发布；' +
        `回撤差分位还需额外 ${pctMinObs(meta)} 个先验就绪观测。`;
    }
    if (cur.status === 'incomplete_quotes') {
      return '当日成分报价不完整或存在日历缺口：指数段重置，结构指标暂停更新，' +
        '待连续完整报价恢复后从 100 重建。';
    }
    if (!isNum(cur.gap_percentile)) {
      const priorReady = Math.max(0,
        (Array.isArray(structure.series) ? structure.series : [])
          .filter(p => p && p.ready === true).length - 1);
      return `回撤差历史分位样本不足：需 ${pctMinObs(meta)} 个先验就绪观测` +
        `（当前 ${priorReady} 个），52 周窗口与指数均已就绪。`;
    }
    return null;
  }

  /**
   * Static pointer to Module 1 for implied-vol context. This panel is outside
   * Module 1's health gate, so it never repeats a live IV/DVOL number: a
   * blocked refresh upstream could otherwise leave a stale figure on screen.
   */
  function dvolLabel(marketData) {
    const atm = marketData && marketData.atmIv;
    if (atm && atm.status === 'data_unavailable') {
      return 'BTC DVOL / ATM 隐含波动率数据不可用（见 Module 1 数据健康条）；' +
        'Core 篮子已实现波动与相关性不是篮子隐含波动率，也不能直接等同 VIX。';
    }
    return 'BTC DVOL / ATM 隐含波动率见上方 Module 1；' +
      'Core 篮子已实现波动与相关性不是篮子隐含波动率，也不能直接等同 VIX。';
  }

  /**
   * Three stacked panels aligned by date:
   *   EW/CW rebased indices / each 52-week drawdown / the EW−CW gap.
   * Nulls are passed through so gaps break the lines; the only guide drawn is
   * the gap's zero line — no fixed danger threshold exists.
   */
  /**
   * Series rows expanded with {date}-only placeholders for every missing UTC
   * calendar day between observations. core_breadth simply skips absent
   * dates; without the placeholders the chart would draw a straight segment
   * across a gap that actually reset the index. Presentation only — no
   * observation is invented: every field on a placeholder is undefined, so it
   * renders as a line break.
   */
  function expandCalendarRows(series) {
    const src = Array.isArray(series) ? series : [];
    const out = [];
    for (let i = 0; i < src.length; i++) {
      if (i > 0) {
        const prev = Date.parse(`${src[i - 1].date}T00:00:00Z`);
        const cur = Date.parse(`${src[i].date}T00:00:00Z`);
        if (Number.isFinite(prev) && Number.isFinite(cur)) {
          for (let t = prev + 86400000; t < cur; t += 86400000) {
            out.push({ date: new Date(t).toISOString().slice(0, 10) });
          }
        }
      }
      out.push(src[i]);
    }
    return out;
  }

  /**
   * opts.zoomSlider(cfg) returns the app's shared time-window slider component for
   * cfg = { xAxisIndex, win }; without it (Node tests) the chart has no slider.
   */
  function buildChartOption(structure, colors, opts) {
    const c = colors || {};
    const zoomSlider = opts && typeof opts.zoomSlider === 'function' ? opts.zoomSlider : null;
    const rows = expandCalendarRows(structure && structure.series);
    const dates = rows.map(r => r.date);
    const vals = k => rows.map(r => (isNum(r[k]) ? r[k] : null));
    const axisLabel = { color: c.tickColor, fontSize: 10, fontFamily: 'monospace' };
    const line = (name, k, yAxisIndex, color, extra) => Object.assign({
      name, type: 'line', xAxisIndex: yAxisIndex === 0 ? 0 : yAxisIndex, yAxisIndex,
      showSymbol: false, connectNulls: false,
      data: vals(k),
      lineStyle: { width: 1.6, color },
      itemStyle: { color }
    }, extra || {});
    const statusAt = i => statusText(rows[i] || null);

    return {
      backgroundColor: 'transparent',
      animation: false,
      legend: {
        top: 0, left: 'center', itemWidth: 14, itemHeight: 8,
        textStyle: { color: c.textSecondary, fontSize: 11 }
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross', lineStyle: { color: c.crossColor } },
        backgroundColor: c.tooltipBg,
        borderColor: c.tooltipBorder,
        textStyle: { color: c.tooltipText, fontSize: 11, fontFamily: 'monospace' },
        formatter: params => {
          if (!params || !params.length) return '';
          const i = params[0].dataIndex;
          const r = rows[i] || {};
          const l = (label, v) =>
            `<div style="display:flex; justify-content:space-between; gap:14px;">` +
            `<span>${label}</span><span style="font-weight:700;">${v}</span></div>`;
          let html = `<div style="font-weight:700; margin-bottom:4px; color:${c.tooltipTitle};">${r.date || ''}</div>`;
          html += l('状态', statusAt(i));
          html += l('EW / CW 指数', `${fmtNum(r.ew_index, 1)} / ${fmtNum(r.cw_index, 1)}`);
          html += l('EW / CW 52周回撤', `${fmtPct(r.ew_drawdown_52w)} / ${fmtPct(r.cw_drawdown_52w)}`);
          html += l('回撤差', fmtPp(r.drawdown_gap_pp));
          html += l('回撤中位 / SMA200 上', `${fmtPct(r.median_constituent_drawdown_52w)} / ${fmtPct(r.pct_above_sma200)}`);
          html += l('覆盖', fmtPct(r.coverage_pct));
          return html;
        }
      },
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      grid: [
        { left: 60, right: 20, top: '8%', height: '30%' },
        { left: 60, right: 20, top: '44%', height: '22%' },
        { left: 60, right: 20, top: '70%', height: '16%' }
      ],
      dataZoom: zoomSlider ? [zoomSlider({ xAxisIndex: [0, 1, 2], win: opts.win || null })] : [],
      xAxis: [0, 1, 2].map(i => ({
        type: 'category', data: dates, gridIndex: i,
        axisLine: { lineStyle: { color: c.axisLine } },
        axisTick: { show: false },
        axisLabel: i === 2 ? { ...axisLabel, formatter: v => String(v).slice(2) } : { show: false }
      })),
      yAxis: [
        {
          type: 'value', gridIndex: 0, scale: true, name: '指数 (基期 100)',
          nameTextStyle: axisLabel, splitNumber: 3,
          splitLine: { lineStyle: { color: c.gridLine } }, axisLabel
        },
        {
          type: 'value', gridIndex: 1, name: '52周回撤 %', nameTextStyle: axisLabel,
          min: 0, max: 100,
          splitLine: { lineStyle: { color: c.gridLine } },
          axisLabel: { ...axisLabel, formatter: v => `${v}%` }
        },
        {
          type: 'value', gridIndex: 2, scale: true, name: '回撤差 pp', nameTextStyle: axisLabel,
          splitNumber: 2, splitLine: { lineStyle: { color: c.gridLine } },
          axisLabel: { ...axisLabel, formatter: v => `${v > 0 ? '+' : ''}${v}` }
        }
      ],
      series: [
        line('EW 指数 (日再平衡)', 'ew_index', 0, '#06b6d4'),
        line('CW 指数 (前市值加权)', 'cw_index', 0, '#8b5cf6'),
        line('EW 52 周回撤', 'ew_drawdown_52w', 1, '#06b6d4', { areaStyle: { opacity: 0.10 } }),
        line('CW 52 周回撤', 'cw_drawdown_52w', 1, '#8b5cf6', { areaStyle: { opacity: 0.10 } }),
        line('EW−CW 回撤差 (pp)', 'drawdown_gap_pp', 2, '#f59e0b', {
          markLine: {
            silent: true, symbol: 'none',
            data: [{ yAxis: 0, lineStyle: { color: c.gridLineStrong, type: 'solid', width: 1 }, label: { show: false } }]
          }
        })
      ]
    };
  }

  // ------------------------------------------------------------------
  // DOM rendering (browser); pure builders above stay testable in Node.
  // ------------------------------------------------------------------
  let chartInst = null;

  function setText(doc, id, text) {
    const el = doc && doc.getElementById ? doc.getElementById(id) : null;
    if (el) el.textContent = text;
  }

  /**
   * render({ data, deps })
   *   data            full McClellan payload (structure block optional)
   *   deps.echarts    echarts global when present; chart is skipped without it
   *   deps.colors     getChartThemeColors() result from app.js
   *   deps.marketData currentMarketData from app.js for the guarded IV label
   *   deps.zoomSlider timeZoomSlider bound to the theme colors (optional)
   *   deps.document   document override for tests
   */
  function render(opts) {
    const deps = (opts && opts.deps) || {};
    const doc = (opts && opts.document) || deps.document
      || (typeof document !== 'undefined' ? document : null);
    if (!doc) return;
    const structure = opts && opts.data ? opts.data.structure : null;

    const kpis = buildKpis(structure && structure.current, structure && structure.methodology);
    for (const k of kpis) {
      setText(doc, `kpi-ms-${k.id}`, k.value);
      setText(doc, `kpi-ms-${k.id}-chip`, k.chip);
      setText(doc, `kpi-ms-${k.id}-sub`, k.sub);
    }

    const notice = doc.getElementById && doc.getElementById('mcclellan-structure-notice');
    const text = noticeText(structure);
    if (notice) {
      if (text) {
        notice.textContent = text;
        if (notice.classList && notice.classList.remove) notice.classList.remove('hidden');
      } else if (notice.classList && notice.classList.add) {
        notice.classList.add('hidden');
      }
    }

    setText(doc, 'mcclellan-structure-dvol', dvolLabel(deps.marketData));
    setText(doc, 'mcclellan-structure-disclaimer', DISCLAIMER);

    const dom = doc.getElementById && doc.getElementById('mcclellan-structure-echarts');
    const echarts = deps.echarts;
    if (!dom || !echarts || !structure || !Array.isArray(structure.series) || !structure.series.length) {
      // Missing/empty block on a refresh: wipe the old chart rather than
      // leave a stale series looking live.
      if (chartInst && chartInst.clear) chartInst.clear();
      return;
    }
    if (!chartInst) {
      chartInst = echarts.init(dom, deps.echartsTheme || null);
    }
    // Keep the user's slider window across refreshes (the notMerge setOption would reset it)
    const kept = chartInst.getOption ? ((chartInst.getOption() || {}).dataZoom || [])[0] : null;
    const win = kept && kept.start != null && kept.end != null ? { start: kept.start, end: kept.end } : null;
    chartInst.setOption(buildChartOption(structure, deps.colors, { zoomSlider: deps.zoomSlider, win }), true);
  }

  function resize() {
    if (chartInst && chartInst.resize) chartInst.resize();
  }

  function dispose() {
    if (chartInst && chartInst.dispose) chartInst.dispose();
    chartInst = null;
  }

  // Self-contained resize hook in real browsers; skipped under VM sandboxes.
  if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
    window.addEventListener('resize', resize);
  }

  return {
    render, resize, dispose,
    buildKpis, buildChartOption, noticeText, dvolLabel,
    expandCalendarRows, pctMinObs,
    fmtPp, fmtPct, fmtNum, statusText,
    DISCLAIMER, STATUS_LABEL
  };
});
