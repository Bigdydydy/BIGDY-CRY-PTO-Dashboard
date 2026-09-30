/**
 * 柳玉冬波浪理论智能研判前端交互与 Lightweight Charts 图表控制器
 * 支持鼠标任意拖拽选区瞬时分析、大级别嵌套小级别子浪渲染、艾略特通道模块拟合、
 * 并列候选浪型切换、出身穿透校验、阻碍诊断与多重情景推演
 * Studio K95 意式画廊设计系统 Dual-Theme (Day/Night) 支持
 */

(function () {
  let waveChart = null;
  let candleSeries = null;
  let zigzagSeries = null;
  let subwaveSeries = null;
  let channelUpperSeries = null;
  let channelLowerSeries = null;

  let currentSymbol = 'BTC/USDT';
  let currentTf = '4h';
  let currentBars = [];
  let currentAnalysis = null;
  let activeCandidateIndex = 0;
  let activePriceLines = [];
  let currentRange = null; // { startTime, endTime, barsCount }

  // 图表可见性控制开关
  let showMarkers = true;
  let showZigzag = true;
  let showSubwaves = false;
  let showChannel = false;
  let showMonitoring = true;
  let showTargets = true;

  // 两步点击选区研判模式状态 (上限 750 根 K 线)
  const MAX_SELECTION_BARS = 750;
  let isSelectingRange = false;
  let selectionStartPoint = null; // { bar, index, time }
  let selectionHoverPoint = null; // { bar, index, time, count, isCapped }

  /**
   * 获取当前 Studio K95 日夜双模配色
   */
  function getWaveChartColors() {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    return {
      isLight,
      background: isLight ? '#ffffff' : '#121217',
      textColor: isLight ? '#4b4b52' : '#a1a1aa',
      borderColor: isLight ? 'rgba(18, 18, 20, 0.12)' : 'rgba(255, 255, 255, 0.08)',
      gridColor: isLight ? 'rgba(18, 18, 20, 0.05)' : 'rgba(255, 255, 255, 0.04)',
      crosshairColor: isLight ? '#ea580c' : '#ff5722',
      upColor: isLight ? '#059669' : '#10b981',
      downColor: isLight ? '#e11d48' : '#f43f5e',
      volUpColor: isLight ? 'rgba(5, 150, 105, 0.35)' : 'rgba(16, 185, 129, 0.35)',
      volDownColor: isLight ? 'rgba(225, 29, 72, 0.35)' : 'rgba(244, 63, 94, 0.35)',
      zigzagColor: isLight ? '#ea580c' : '#ff5722',
      subwaveColor: isLight ? '#0284c7' : '#38bdf8',
      channelColor: isLight ? 'rgba(234, 88, 12, 0.5)' : 'rgba(255, 87, 34, 0.45)',
      monitoringColor: isLight ? '#dc2626' : '#f43f5e',
      targetColor: isLight ? '#059669' : '#10b981'
    };
  }

  let chartMarkersPrimitive = null;

  /**
   * 兼容 LightweightCharts v4 (chart.addCandlestickSeries) 与 v5 (chart.addSeries(CandlestickSeries))
   */
  function safeCreateSeries(chart, typeName, options) {
    if (!chart || !window.LightweightCharts) return null;
    // 1. 若支持 v4 快捷直接方法
    if (typeName === 'Candlestick' && typeof chart.addCandlestickSeries === 'function') {
      return chart.addCandlestickSeries(options);
    }
    if (typeName === 'Histogram' && typeof chart.addHistogramSeries === 'function') {
      return chart.addHistogramSeries(options);
    }
    if (typeName === 'Line' && typeof chart.addLineSeries === 'function') {
      return chart.addLineSeries(options);
    }

    // 2. 支持 v5 统一 addSeries(Constructor, options) 规范
    const SeriesConstructor = window.LightweightCharts[`${typeName}Series`];
    if (SeriesConstructor && typeof chart.addSeries === 'function') {
      return chart.addSeries(SeriesConstructor, options);
    }

    console.warn(`[Wave UI] Unable to add series type ${typeName}`);
    return null;
  }

  /**
   * 兼容 LightweightCharts v4 (series.setMarkers) 与 v5 (createSeriesMarkers)
   */
  function setChartMarkers(series, markers) {
    if (!series) return;
    const m = markers || [];
    if (typeof series.setMarkers === 'function') {
      series.setMarkers(m);
      return;
    }
    if (window.LightweightCharts && typeof window.LightweightCharts.createSeriesMarkers === 'function') {
      if (!chartMarkersPrimitive) {
        chartMarkersPrimitive = window.LightweightCharts.createSeriesMarkers(series, m);
      } else {
        chartMarkersPrimitive.setMarkers(m);
      }
    }
  }

  /**
   * 初始化 Lightweight Charts 实例
   */
  function initChart() {
    const container = document.getElementById('wave-chart-container');
    if (!container || !window.LightweightCharts) return;

    chartMarkersPrimitive = null;

    // 清空历史容器 (移除非必要的成交量副图，纯化波浪画廊视觉)
    container.innerHTML = `
      <div class="wave-hud-legend" id="wave-hud-legend">
        <div class="wave-hud-item"><span>标的:</span> <strong id="hud-sym">BTC/USDT 4H</strong></div>
        <div class="wave-hud-item"><span>开:</span> <strong id="hud-o">--</strong></div>
        <div class="wave-hud-item"><span>高:</span> <strong id="hud-h">--</strong></div>
        <div class="wave-hud-item"><span>低:</span> <strong id="hud-l">--</strong></div>
        <div class="wave-hud-item"><span>收:</span> <strong id="hud-c">--</strong></div>
      </div>
      <div class="wave-pattern-badge" id="wave-pattern-badge" style="display:none;"></div>
      <div class="wave-tv-hud" id="wave-tv-hud" style="display:none;">
        <div class="wave-tv-header">
          <div class="wave-tv-title">
            <span class="wave-tv-dot"></span>
            <span class="wave-tv-title-text">ELLIOTT WAVE · 柳玉冬实战体系</span>
            <span class="wave-tv-mtf-badge" id="wave-tv-mtf-badge">MTF AUTO</span>
          </div>
          <button class="wave-tv-min-btn" id="btn-toggle-tv-hud" title="最小化/展开HUD">−</button>
        </div>
        <div class="wave-tv-body" id="wave-tv-hud-body"></div>
      </div>
      <div id="chart-selection-overlay" class="chart-selection-overlay" style="display:none;">
        <div id="selection-range-box" class="selection-range-box"></div>
        <div id="selection-start-line" class="selection-v-line selection-start-line">
          <div class="selection-pill start-pill">起点</div>
        </div>
        <div id="selection-end-line" class="selection-v-line selection-end-line">
          <div class="selection-pill end-pill">终点</div>
        </div>
        <div id="selection-tooltip" class="selection-floating-tooltip"></div>
      </div>
    `;

    // 绑定 HUD 最小化切换
    const btnToggleHud = container.querySelector('#btn-toggle-tv-hud');
    const tvHud = container.querySelector('#wave-tv-hud');
    if (btnToggleHud && tvHud) {
      btnToggleHud.addEventListener('click', (e) => {
        e.stopPropagation();
        tvHud.classList.toggle('is-minimized');
        btnToggleHud.textContent = tvHud.classList.contains('is-minimized') ? '+' : '−';
      });
    }

    const colors = getWaveChartColors();
    const chart = LightweightCharts.createChart(container, {
      width: container.clientWidth || 800,
      height: 560,
      layout: {
        background: { type: 'solid', color: colors.background },
        textColor: colors.textColor,
        fontFamily: "'JetBrains Mono', Consolas, monospace",
        fontSize: 11
      },
      grid: {
        vertLines: { color: colors.gridColor },
        horzLines: { color: colors.gridColor }
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: {
          color: colors.crosshairColor,
          width: 1,
          style: LightweightCharts.LineStyle.Dashed,
          labelBackgroundColor: colors.crosshairColor
        },
        horzLine: {
          color: colors.crosshairColor,
          width: 1,
          style: LightweightCharts.LineStyle.Dashed,
          labelBackgroundColor: colors.crosshairColor
        }
      },
      rightPriceScale: {
        borderColor: colors.borderColor,
        scaleMargins: {
          top: 0.08,
          bottom: 0.08
        }
      },
      timeScale: {
        borderColor: colors.borderColor,
        timeVisible: true,
        secondsVisible: false
      }
    });

    // 烛台主图
    const candles = safeCreateSeries(chart, 'Candlestick', {
      upColor: colors.upColor,
      downColor: colors.downColor,
      borderUpColor: colors.upColor,
      borderDownColor: colors.downColor,
      wickUpColor: colors.upColor,
      wickDownColor: colors.downColor
    });

    // 艾略特通道模块轨线 (上轨与下轨)
    const channelUpper = safeCreateSeries(chart, 'Line', {
      color: colors.channelColor,
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Solid,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false
    });

    const channelLower = safeCreateSeries(chart, 'Line', {
      color: colors.channelColor,
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Solid,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false
    });

    // 次级嵌套子浪折线 (细虚线，天蓝色)
    const subwave = safeCreateSeries(chart, 'Line', {
      color: colors.subwaveColor,
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: true
    });

    // 大级别宏观波浪分笔折线 (主折线，亮橙色)
    const zigzag = safeCreateSeries(chart, 'Line', {
      color: colors.zigzagColor,
      lineWidth: 2,
      lineStyle: LightweightCharts.LineStyle.Solid,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: true
    });

    // Crosshair HUD 悬停监听
    chart.subscribeCrosshairMove(param => {
      const hudO = document.getElementById('hud-o');
      const hudH = document.getElementById('hud-h');
      const hudL = document.getElementById('hud-l');
      const hudC = document.getElementById('hud-c');

      if (!param || !param.time || !param.seriesData) {
        if (currentBars.length > 0) {
          const last = currentBars[currentBars.length - 1];
          if (hudO) hudO.textContent = last.open.toLocaleString();
          if (hudH) hudH.textContent = last.high.toLocaleString();
          if (hudL) hudL.textContent = last.low.toLocaleString();
          if (hudC) hudC.textContent = last.close.toLocaleString();
        }
        return;
      }

      const cData = param.seriesData.get(candles);
      if (cData) {
        if (hudO) hudO.textContent = cData.open?.toLocaleString() || '--';
        if (hudH) hudH.textContent = cData.high?.toLocaleString() || '--';
        if (hudL) hudL.textContent = cData.low?.toLocaleString() || '--';
        if (hudC) hudC.textContent = cData.close?.toLocaleString() || '--';
      }
    });

    // 自适应视口尺寸调整
    const resizeObserver = new ResizeObserver(entries => {
      if (!entries || !entries.length) return;
      const { width } = entries[0].contentRect;
      if (width > 0) {
        chart.applyOptions({ width });
      }
    });
    resizeObserver.observe(container);

    waveChart = chart;
    candleSeries = candles;
    zigzagSeries = zigzag;
    subwaveSeries = subwave;
    channelUpperSeries = channelUpper;
    channelLowerSeries = channelLower;

    // 安装两步点击选区监听器
    setupTwoClickSelection(container);
  }

  function formatBarTime(timestamp) {
    return new Date(timestamp * 1000).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function getBarByTime(time) {
    if (!currentBars || currentBars.length === 0) return null;
    let low = 0, high = currentBars.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (currentBars[mid].time === time) {
        return { bar: currentBars[mid], index: mid, time: currentBars[mid].time };
      }
      if (currentBars[mid].time < time) low = mid + 1;
      else high = mid - 1;
    }
    return null;
  }

  function getBarFromCoordinate(x) {
    if (!waveChart || !currentBars || currentBars.length === 0) return null;
    const timeScale = waveChart.timeScale();

    // 1. 尝试 coordinateToTime
    const t = timeScale.coordinateToTime(x);
    if (t !== null && t !== undefined) {
      const exact = getBarByTime(t);
      if (exact) return exact;
      let low = 0, high = currentBars.length - 1;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (currentBars[mid].time < t) low = mid + 1;
        else high = mid - 1;
      }
      low = Math.max(0, Math.min(currentBars.length - 1, low));
      high = Math.max(0, Math.min(currentBars.length - 1, high));
      const diffLow = Math.abs(currentBars[low].time - t);
      const diffHigh = Math.abs(currentBars[high].time - t);
      const bestIdx = diffLow < diffHigh ? low : high;
      return { bar: currentBars[bestIdx], index: bestIdx, time: currentBars[bestIdx].time };
    }

    // 2. 降级尝试 coordinateToLogical
    const logical = timeScale.coordinateToLogical(x);
    if (logical !== null && logical !== undefined && !isNaN(logical)) {
      const idx = Math.max(0, Math.min(currentBars.length - 1, Math.round(logical)));
      return { bar: currentBars[idx], index: idx, time: currentBars[idx].time };
    }

    return null;
  }

  function cancelRangeSelection() {
    isSelectingRange = false;
    selectionStartPoint = null;
    selectionHoverPoint = null;

    const overlay = document.getElementById('chart-selection-overlay');
    if (overlay) overlay.style.display = 'none';

    const btnDrag = document.getElementById('btn-drag-range');
    if (btnDrag) {
      btnDrag.classList.remove('active');
      btnDrag.innerHTML = '🖱️ 框选分析模式';
      btnDrag.title = '两步点击框选任意区间分析 (最大750根K线)';
    }

    const container = document.getElementById('wave-chart-container');
    if (container) {
      container.style.cursor = 'default';
    }
  }

  function updateSelectionVisuals() {
    const overlay = document.getElementById('chart-selection-overlay');
    const box = document.getElementById('selection-range-box');
    const startLine = document.getElementById('selection-start-line');
    const endLine = document.getElementById('selection-end-line');
    const tooltip = document.getElementById('selection-tooltip');
    if (!overlay || !box || !startLine || !endLine || !tooltip || !waveChart) return;

    if (!isSelectingRange || !selectionStartPoint) {
      overlay.style.display = 'none';
      return;
    }

    overlay.style.display = 'block';
    const timeScale = waveChart.timeScale();

    let startX = timeScale.timeToCoordinate(selectionStartPoint.time);
    if (startX === null || startX === undefined) {
      startX = timeScale.logicalToCoordinate(selectionStartPoint.index);
    }

    if (startX === null || startX === undefined) {
      startLine.classList.remove('visible');
      return;
    }

    startLine.classList.add('visible');
    startLine.style.left = `${startX}px`;

    // 尚未移动鼠标或未有有效预览点
    if (!selectionHoverPoint) {
      box.style.display = 'none';
      endLine.classList.remove('visible');
      tooltip.style.display = 'block';
      tooltip.style.left = `${startX}px`;
      tooltip.innerHTML = `
        <span>起点: <strong>${formatBarTime(selectionStartPoint.time)}</strong></span>
        <span style="display:block; font-size:0.68rem; color:var(--text-muted); margin-top:2px;">移动鼠标预览终点 (上限 750 根)</span>
      `;
      return;
    }

    let endX = timeScale.timeToCoordinate(selectionHoverPoint.time);
    if (endX === null || endX === undefined) {
      endX = timeScale.logicalToCoordinate(selectionHoverPoint.index);
    }

    if (endX === null || endX === undefined) return;

    const minX = Math.min(startX, endX);
    const maxX = Math.max(startX, endX);
    const width = Math.max(1, maxX - minX);

    box.style.display = 'block';
    box.style.left = `${minX}px`;
    box.style.width = `${width}px`;

    endLine.classList.add('visible');
    endLine.style.left = `${endX}px`;

    const isCapped = selectionHoverPoint.isCapped;
    box.classList.toggle('is-capped', isCapped);
    endLine.classList.toggle('is-capped', isCapped);

    const midX = minX + width / 2;
    tooltip.style.display = 'block';
    tooltip.style.left = `${midX}px`;

    if (isCapped) {
      tooltip.innerHTML = `
        <span style="color:var(--color-neg); font-weight:700;">⚠️ 选区已达最大上限 750 根 K 线 (${750 * 4}H)</span>
        <span style="display:block; font-size:0.68rem; color:var(--text-secondary); margin-top:2px;">再次点击即可完成该 750 根选区研判</span>
      `;
    } else {
      tooltip.innerHTML = `
        <span>选区预览: <strong>${selectionHoverPoint.count}</strong> 根 K 线 (${selectionHoverPoint.count * 4}H)</span>
        <span style="display:block; font-size:0.68rem; color:var(--text-muted); margin-top:2px;">点击完成选择 · Esc 取消</span>
      `;
    }
  }

  function onSelectionPointClicked(barInfo) {
    if (!isSelectingRange) return;

    if (!selectionStartPoint) {
      // 第一次点击：锁定起点，垂直线高亮
      selectionStartPoint = barInfo;
      selectionHoverPoint = null;
      updateSelectionVisuals();

      const btnDrag = document.getElementById('btn-drag-range');
      if (btnDrag) {
        btnDrag.innerHTML = '🏁 移动预览并点击终点 (Esc 取消)';
        btnDrag.classList.add('active');
      }
      const statusMsg = document.getElementById('wave-status-msg');
      if (statusMsg) {
        statusMsg.textContent = `📍 已锁定起点 [${formatBarTime(barInfo.time)}]，请移动鼠标预览选区并点击第二下确定终点 (最多 750 根 K 线)`;
      }
    } else {
      // 第二次点击：选择结束
      const rawDiff = barInfo.index - selectionStartPoint.index;
      let targetIdx = barInfo.index;

      // 限制选择范围最大 750 根 K 线
      if (Math.abs(rawDiff) + 1 > MAX_SELECTION_BARS) {
        targetIdx = rawDiff > 0
          ? Math.min(currentBars.length - 1, selectionStartPoint.index + (MAX_SELECTION_BARS - 1))
          : Math.max(0, selectionStartPoint.index - (MAX_SELECTION_BARS - 1));
      }

      const count = Math.abs(targetIdx - selectionStartPoint.index) + 1;
      if (count < 10) {
        const statusMsg = document.getElementById('wave-status-msg');
        if (statusMsg) {
          statusMsg.textContent = '⚠️ 选区过短，请框选至少 10 根 K 线的区间（引擎需足够上下文识别浪位）';
        }
        return;
      }

      const endBar = currentBars[targetIdx];
      const startTime = Math.min(selectionStartPoint.time, endBar.time);
      const endTime = Math.max(selectionStartPoint.time, endBar.time);

      cancelRangeSelection();

      currentRange = { startTime, endTime, barsCount: count };
      updateRangeBanner(startTime, endTime, count);
      runWaveAnalysis(currentSymbol, currentRange);
    }
  }

  /**
   * 两步点击选区机制：
   * 第一次点击在图表上高亮垂直线作为起点，鼠标移动时实时预览选区 (上限 750 根 K 线)，第二次点击选区结束
   */
  function setupTwoClickSelection(container) {
    let mouseDownPos = null;

    container.addEventListener('mousedown', e => {
      if (e.button === 0) {
        mouseDownPos = { x: e.clientX, y: e.clientY };
      }
    });

    container.addEventListener('mouseup', e => {
      if (!isSelectingRange || !mouseDownPos) return;
      const dist = Math.hypot(e.clientX - mouseDownPos.x, e.clientY - mouseDownPos.y);
      mouseDownPos = null;
      if (dist > 6) {
        // 用户在平移或缩放图表，忽略非单击行为
        return;
      }

      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const clicked = getBarFromCoordinate(x);
      if (clicked) {
        onSelectionPointClicked(clicked);
      }
    });

    container.addEventListener('mousemove', e => {
      if (!isSelectingRange || !selectionStartPoint) return;
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const hovered = getBarFromCoordinate(x);
      if (!hovered) return;

      const rawDiff = hovered.index - selectionStartPoint.index;
      let targetIdx = hovered.index;
      let isCapped = false;

      if (Math.abs(rawDiff) + 1 > MAX_SELECTION_BARS) {
        isCapped = true;
        targetIdx = rawDiff > 0
          ? Math.min(currentBars.length - 1, selectionStartPoint.index + (MAX_SELECTION_BARS - 1))
          : Math.max(0, selectionStartPoint.index - (MAX_SELECTION_BARS - 1));
      }

      const count = Math.abs(targetIdx - selectionStartPoint.index) + 1;
      const endBar = currentBars[targetIdx];

      selectionHoverPoint = {
        bar: endBar,
        index: targetIdx,
        time: endBar.time,
        count: count,
        isCapped: isCapped
      };

      updateSelectionVisuals();
    });

    // 视口平移缩放同步
    if (waveChart) {
      waveChart.timeScale().subscribeVisibleLogicalRangeChange(() => {
        if (isSelectingRange && selectionStartPoint) {
          updateSelectionVisuals();
        }
      });
    }
  }

  function updateRangeBanner(startTime, endTime, barsCount, extrema) {
    const banner = document.getElementById('wave-range-banner');
    const rangeText = document.getElementById('wave-range-text');
    if (!banner || !rangeText) return;

    if (startTime && endTime) {
      const d1 = new Date(startTime * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      const d2 = new Date(endTime * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      const countLabel = barsCount ? ` · 共 ${barsCount} 根 K 线` : '';
      let extLabel = '';
      if (extrema) {
        const dir = extrema.dominantDirection === 'BULLISH' ? '多头主导' : extrema.dominantDirection === 'BEARISH' ? '空头主导' : '震荡';
        extLabel = ` · 极值磁吸: L $${Number(extrema.minPrice.toFixed(1)).toLocaleString()} / H $${Number(extrema.maxPrice.toFixed(1)).toLocaleString()} (${dir})`;
      }
      rangeText.textContent = `${d1} 至 ${d2}${countLabel}${extLabel}`;
      banner.style.display = 'flex';
    } else {
      banner.style.display = 'none';
    }
  }

  /**
   * 当全站切换日/夜间主题时重绘色彩
   */
  function updateTheme() {
    if (!waveChart) return;
    const colors = getWaveChartColors();
    waveChart.applyOptions({
      layout: {
        background: { type: 'solid', color: colors.background },
        textColor: colors.textColor
      },
      grid: {
        vertLines: { color: colors.gridColor },
        horzLines: { color: colors.gridColor }
      },
      crosshair: {
        vertLine: { color: colors.crosshairColor, labelBackgroundColor: colors.crosshairColor },
        horzLine: { color: colors.crosshairColor, labelBackgroundColor: colors.crosshairColor }
      },
      rightPriceScale: { borderColor: colors.borderColor },
      timeScale: { borderColor: colors.borderColor }
    });

    if (candleSeries) {
      candleSeries.applyOptions({
        upColor: colors.upColor,
        downColor: colors.downColor,
        borderUpColor: colors.upColor,
        borderDownColor: colors.downColor,
        wickUpColor: colors.upColor,
        wickDownColor: colors.downColor
      });
    }

    if (zigzagSeries) zigzagSeries.applyOptions({ color: colors.zigzagColor });
    if (subwaveSeries) subwaveSeries.applyOptions({ color: colors.subwaveColor });
    if (channelUpperSeries) channelUpperSeries.applyOptions({ color: colors.channelColor });
    if (channelLowerSeries) channelLowerSeries.applyOptions({ color: colors.channelColor });

    if (currentAnalysis) {
      applyActiveCandidate(activeCandidateIndex);
    }
  }

  // 主图K线根数: 服务端按 endTime 分页拼接 (币安单次上限 1500)
  const WAVE_BARS = 10000;
  const TF_HOURS = { '15m': 0.25, '1h': 1, '4h': 4 };

  function parseRawKlines(rows) {
    return rows.map(b => ({
      time: Math.floor(b[0] / 1000),
      open: parseFloat(b[1]),
      high: parseFloat(b[2]),
      low: parseFloat(b[3]),
      close: parseFloat(b[4]),
      volume: parseFloat(b[5])
    }));
  }

  /** 直连币安兜底: 同样按 endTime 向前分页 */
  async function fetchDirectPaged(base, pageMax, symbol, tf, total) {
    const rows = [];
    let endTime = null;
    while (rows.length < total) {
      const lim = Math.min(pageMax, total - rows.length);
      const resp = await fetch(`${base}?symbol=${symbol}&interval=${tf}&limit=${lim}${endTime ? `&endTime=${endTime}` : ''}`, { signal: AbortSignal.timeout(8000) });
      if (!resp.ok) { if (!rows.length) throw new Error(`HTTP ${resp.status}`); break; }
      const page = await resp.json();
      if (!Array.isArray(page) || !page.length) break;
      rows.unshift(...page);
      if (page.length < lim) break;
      endTime = page[0][0] - 1;
    }
    return rows;
  }

  /**
   * 抓取指定周期 K 线 (最多 WAVE_BARS 根；优先本地服务端缓存，失败时直连币安合约/现货分页拉取)
   */
  async function fetch4hKlines(symbol, tf = currentTf) {
    const cleanSymbol = symbol.replace(/[\/\-_]/g, '').toUpperCase();
    let lastError = null;
    try {
      const resp = await fetch(`/api/wave/klines?symbol=${cleanSymbol}&interval=${tf}&limit=${WAVE_BARS}`, { signal: AbortSignal.timeout(20000) });
      if (resp.ok) {
        const json = await resp.json();
        if (json && Array.isArray(json.bars) && json.bars.length) {
          return { bars: json.bars, source: '币安 Futures (本地缓存加速)' };
        }
      }
    } catch (err) {
      lastError = err;
    }
    const direct = [
      ['https://fapi.binance.com/fapi/v1/klines', 1500, '币安合约直连 (fapi.binance.com)'],
      ['https://data-api.binance.vision/api/v3/klines', 1000, '币安现货直连'],
      ['https://api.binance.com/api/v3/klines', 1000, '币安现货直连']
    ];
    for (const [base, pageMax, label] of direct) {
      try {
        const rows = await fetchDirectPaged(base, pageMax, cleanSymbol, tf, WAVE_BARS);
        if (rows.length) return { bars: parseRawKlines(rows), source: label };
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('无法连接到币安行情源');
  }

  /** 顶部「样本」标签: 实际根数与时间跨度 */
  function updateSampleLabel(bars, tf) {
    const el = document.getElementById('wave-sample-label');
    if (!el || !bars || !bars.length) return;
    const days = Math.round((bars[bars.length - 1].time - bars[0].time) / 86400);
    const span = days >= 365 ? `约${(days / 365).toFixed(1)}年` : `约${days}天`;
    el.textContent = `${bars.length.toLocaleString()} 根 ${tf.toUpperCase()} K线 (${span})`;
  }

  /**
   * 清除波浪图层与面板状态，恢复为待框选状态
   */
  function clearWaveAnalysisState() {
    currentAnalysis = null;
    activeCandidateIndex = 0;
    currentRange = null;

    // 1. 清空图表上的所有波浪图层
    if (zigzagSeries) zigzagSeries.setData([]);
    if (subwaveSeries) subwaveSeries.setData([]);
    if (channelUpperSeries) channelUpperSeries.setData([]);
    if (channelLowerSeries) channelLowerSeries.setData([]);
    setChartMarkers(candleSeries, []);

    if (activePriceLines.length > 0 && candleSeries) {
      activePriceLines.forEach(pl => {
        try { candleSeries.removePriceLine(pl); } catch (e) {}
      });
      activePriceLines = [];
    }

    // 2. 隐藏选区横幅与浮动组件
    updateRangeBanner(null, null);
    const patternBadge = document.getElementById('wave-pattern-badge');
    if (patternBadge) patternBadge.style.display = 'none';
    const tvHud = document.getElementById('wave-tv-hud');
    if (tvHud) tvHud.style.display = 'none';

    // 3. 重置顶部徽标与 5-KPI 看板
    const headerRegime = document.getElementById('wave-header-regime-pill');
    const headerScore = document.getElementById('wave-header-score-pill');
    if (headerRegime) headerRegime.textContent = '-- 待选区';
    if (headerScore) headerScore.textContent = '最高匹配: --分';

    const kpiName = document.getElementById('kpi-wave-primary-name');
    const kpiBadge = document.getElementById('kpi-wave-primary-badge');
    const kpiCat = document.getElementById('kpi-wave-primary-cat');
    if (kpiName) kpiName.textContent = '待选区研判';
    if (kpiBadge) {
      kpiBadge.textContent = '待选区';
      kpiBadge.className = 'kpi-badge';
    }
    if (kpiCat) kpiCat.textContent = '请点击【🖱️ 框选分析模式】选取 10~750 根 K 线';

    const kpiScore = document.getElementById('kpi-wave-primary-score');
    const kpiScoreBar = document.getElementById('kpi-wave-score-bar');
    if (kpiScore) kpiScore.textContent = '-- 分';
    if (kpiScoreBar) kpiScoreBar.style.width = '0%';

    const kpiPivotPrice = document.getElementById('kpi-wave-pivot-price');
    const kpiPivotStatus = document.getElementById('kpi-wave-pivot-status');
    if (kpiPivotPrice) kpiPivotPrice.textContent = '$--,---';
    if (kpiPivotStatus) kpiPivotStatus.textContent = '等待框选区间';

    const kpiOriginStatus = document.getElementById('kpi-wave-origin-status');
    const kpiOriginDesc = document.getElementById('kpi-wave-origin-desc');
    if (kpiOriginStatus) {
      kpiOriginStatus.textContent = '待框选检测';
      kpiOriginStatus.style.color = 'var(--text-secondary)';
    }
    if (kpiOriginDesc) kpiOriginDesc.textContent = '选取波段后穿透微观 1H/15m 结构';

    const kpiScenProb = document.getElementById('kpi-wave-scenario-prob');
    const kpiScenName = document.getElementById('kpi-wave-scenario-name');
    if (kpiScenProb) kpiScenProb.textContent = '--%';
    if (kpiScenName) kpiScenName.textContent = '等待选区确认';

    // 4. 重置右侧各面板
    const countBadge = document.getElementById('candidate-count-badge');
    if (countBadge) countBadge.textContent = '待选区';

    const candList = document.getElementById('wave-candidates-list');
    if (candList) {
      candList.innerHTML = `
        <div class="wave-idle-prompt">
          <span class="idle-icon">🎯</span>
          <div class="idle-title">等待框选分析</div>
          <p class="idle-desc">
            请点击上方 <strong>【🖱️ 框选分析模式】</strong>，在图表中单击起点并移动至终点（10 ~ 750 根 K 线）。选区是观察窗口而非浪的边界——引擎会自动向左扩展上下文研判浪位。
          </p>
        </div>
      `;
    }

    const originBadge = document.getElementById('wave-origin-badge');
    const originText = document.getElementById('wave-origin-text');
    if (originBadge) {
      originBadge.textContent = '待选区';
      originBadge.className = 'card-badge badge-neutral';
    }
    if (originText) {
      originText.textContent = '尚未选取分析区间。点击图表上方【🖱️ 框选分析模式】选取 K 线范围后，将穿透检验起点第一笔的微观 1H/15m 驱动结构。';
    }

    const precBadge = document.getElementById('wave-preceding-badge');
    const precText = document.getElementById('wave-preceding-text');
    if (precBadge) {
      precBadge.textContent = '观当下必先审前身';
      precBadge.className = 'card-badge badge-neutral';
    }
    if (precText) {
      precText.textContent = '尚未选取分析区间。选取波段后，引擎将自动穿透选区前序同级别与大级别行情的驱动/调整性质，确立当前波段的顺势与反弹属性。';
    }

    const waveRegimeName = document.getElementById('wave-regime-name');
    const waveRegimeBadge = document.getElementById('wave-regime-badge');
    const waveCurrentStage = document.getElementById('wave-current-stage');
    if (waveRegimeName) waveRegimeName.textContent = '--';
    if (waveCurrentStage) waveCurrentStage.textContent = '请先在图表中框选行情范围';
    if (waveRegimeBadge) {
      waveRegimeBadge.textContent = '待选区';
      waveRegimeBadge.className = 'card-badge badge-neutral';
    }

    const r1 = document.getElementById('rule-dot-1');
    const r2 = document.getElementById('rule-dot-2');
    const r3 = document.getElementById('rule-dot-3');
    if (r1) r1.className = 'rule-dot-idle';
    if (r2) r2.className = 'rule-dot-idle';
    if (r3) r3.className = 'rule-dot-idle';

    const rs1 = document.getElementById('rule-status-1');
    const rs2 = document.getElementById('rule-status-2');
    const rs3 = document.getElementById('rule-status-3');
    if (rs1) rs1.textContent = '待检测';
    if (rs2) rs2.textContent = '待检测';
    if (rs3) rs3.textContent = '待检测';

    const pivotPrice = document.getElementById('wave-pivot-price');
    const pivotDiff = document.getElementById('wave-pivot-diff');
    const pivotDesc = document.getElementById('wave-pivot-desc');
    if (pivotPrice) pivotPrice.textContent = '$--,---';
    if (pivotDiff) pivotDiff.textContent = '等待选区...';
    if (pivotDesc) pivotDesc.textContent = '选择有效 K 线区间后，将为您计算该浪型的核心防守生命线。';

    const cardBlockers = document.getElementById('card-wave-blockers');
    if (cardBlockers) cardBlockers.style.display = 'none';

    const scenariosList = document.getElementById('wave-scenarios-list');
    if (scenariosList) {
      scenariosList.innerHTML = `<div style="font-size: 0.72rem; color: var(--text-muted); text-align: center; padding: 12px 0;">框选分析后将输出第一、第二情景推演</div>`;
    }

    const tgtContainer = document.getElementById('wave-targets-list');
    if (tgtContainer) {
      tgtContainer.innerHTML = `<div class="wave-target-row"><span class="text-secondary">等待选区测算...</span></div>`;
    }

    const thesisText = document.getElementById('wave-thesis-text');
    const bottomSignal = document.getElementById('wave-bottom-signal');
    if (thesisText) thesisText.textContent = `请使用【🖱️ 框选分析模式】选择 ${currentTf.toUpperCase()} K 线行情走势区间以生成柳玉冬实战研判结论。`;
    if (bottomSignal) bottomSignal.textContent = '';
    resetLiuSignalCards();
    renderStructureDetail(null);
  }

  /**
   * 抓取行情并挂载 K 线图表，启动实时自适应波浪理论解算
   */
  async function loadChartCandles(symbol = currentSymbol) {
    currentSymbol = symbol;
    const tfLabel = currentTf.toUpperCase();
    const hudSym = document.getElementById('hud-sym');
    const statusMsg = document.getElementById('wave-status-msg');
    if (hudSym) hudSym.textContent = `${symbol} ${tfLabel}`;
    if (statusMsg) statusMsg.textContent = `正在拉取 ${symbol} 最新 ${tfLabel} K 线走势并计算实时波浪...`;

    try {
      const { bars } = await fetch4hKlines(symbol, currentTf);
      currentBars = bars;
      updateSampleLabel(bars, currentTf);

      if (!waveChart) {
        initChart();
      }

      // 设置主图裸蜡烛 (无成交量副图，纯化主图视觉)
      const candleData = bars.map(b => ({
        time: b.time,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close
      }));
      candleSeries.setData(candleData);

      // 缩放聚焦至最新 150 根 K 线
      if (bars.length > 150) {
        waveChart.timeScale().setVisibleLogicalRange({
          from: bars.length - 150,
          to: bars.length
        });
      }

      // 入场不自动数浪：浪的起点应由用户意图决定——
      // 「框选」后按选区研判，或点「智能研判」解算全量当前浪位
      clearWaveAnalysisState();
      if (statusMsg) {
        statusMsg.textContent = `● [${symbol} ${tfLabel}] K线就绪 (${bars.length} 根) · 开启「框选分析」指定区间，或点击「智能研判」解算全量浪位`;
      }

    } catch (err) {
      console.error('[Wave Load Error]:', err);
      if (statusMsg) {
        statusMsg.textContent = `❌ 行情加载失败: ${err.message || '网络连接超时'}`;
      }
    }
  }

  /**
   * 执行波浪分析 (支持全景实时解算与 2~750 根选区切片研判)
   */
  async function runWaveAnalysis(symbol = currentSymbol, rangeOptions = currentRange) {
    currentSymbol = symbol;
    currentRange = rangeOptions;
    const btnScan = document.getElementById('btn-scan-waves');
    const statusMsg = document.getElementById('wave-status-msg');
    const hudSym = document.getElementById('hud-sym');

    const tfLabel = currentTf.toUpperCase();
    if (hudSym) hudSym.textContent = `${symbol} ${tfLabel}`;
    if (btnScan) {
      btnScan.classList.add('loading');
      const textSpan = btnScan.querySelector('span');
      if (textSpan) textSpan.textContent = '分析研判中...';
    }

    const isCustomSlice = Boolean(rangeOptions && rangeOptions.startTime && rangeOptions.endTime);
    if (statusMsg) {
      statusMsg.textContent = isCustomSlice
        ? `正在分析所选区间 [${symbol} ${tfLabel}]...`
        : `正在实时解算 [${symbol} ${tfLabel}] 宏观多级别波浪走势...`;
    }

    try {
      if (!currentBars || currentBars.length === 0) {
        const { bars } = await fetch4hKlines(symbol, currentTf);
        currentBars = bars;
        updateSampleLabel(bars, currentTf);
      }

      if (!waveChart) {
        initChart();
      }

      const candleData = currentBars.map(b => ({
        time: b.time,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close
      }));
      candleSeries.setData(candleData);

      // 调用后端 API 或本地引擎执行波浪分析
      let analysis = null;
      try {
        const queryParams = new URLSearchParams({
          symbol: symbol.replace(/[\/\-_]/g, '').toUpperCase(),
          interval: currentTf
        });
        if (isCustomSlice) {
          queryParams.append('startTime', rangeOptions.startTime);
          queryParams.append('endTime', rangeOptions.endTime);
        }
        const apiResp = await fetch(`/api/wave/analysis?${queryParams.toString()}`, {
          signal: AbortSignal.timeout(20000)
        });
        if (apiResp.ok) {
          analysis = await apiResp.json();
        }
      } catch (e) {
        // 后端若超时或不可用则降级至客户端 UMD 引擎 (极速稳定，绝不卡死页面)
      }

      if (!analysis || analysis.code !== 0) {
        if (!window.LiuWaveEngine) throw new Error('波浪计算引擎尚未就绪');
        const opts = { timeframe: currentTf };
        if (isCustomSlice) {
          opts.startTime = rangeOptions.startTime;
          opts.endTime = rangeOptions.endTime;
        }
        analysis = window.LiuWaveEngine.analyzeWaves(currentBars, symbol, opts);
      }

      currentAnalysis = analysis;
      activeCandidateIndex = 0;

      if (isCustomSlice) {
        updateRangeBanner(rangeOptions.startTime, rangeOptions.endTime, analysis.selectedRange?.barsCount || rangeOptions.barsCount, analysis.rangeExtrema);
      }

      // 渲染候选浪型并上图展示
      renderCandidatesList(analysis);
      applyActiveCandidate(0);

      // 侧边栏各板块更新
      renderDiagnosticPanel(analysis);

      // 缩放视野聚焦
      if (isCustomSlice) {
        waveChart.timeScale().setVisibleRange({
          from: rangeOptions.startTime,
          to: rangeOptions.endTime
        });
      } else if (currentBars.length > 150) {
        waveChart.timeScale().setVisibleLogicalRange({
          from: currentBars.length - 150,
          to: currentBars.length
        });
      }

      if (statusMsg) {
        const barsCount = analysis.selectedRange?.barsCount || (isCustomSlice ? rangeOptions.barsCount : currentBars.length);
        const ctxBars = analysis.selectedRange?.contextBars || 0;
        const candCount = analysis.candidates?.length || 0;
        const ctxNote = ctxBars > 0 ? `+左扩${ctxBars}根上下文` : '';
        statusMsg.textContent = `● [${symbol} ${tfLabel}] 研判就绪 (${barsCount} 根 K 线${ctxNote}) · 识别出 ${candCount} 个合规浪型 · MTF: ${analysis.mtf?.alignmentLabel || '中性'}`;
      }
    } catch (err) {
      console.error('[Wave Engine Error]:', err);
      if (statusMsg) {
        statusMsg.textContent = `❌ 分析失败: ${err.message || '网络连接超时'}`;
      }
    } finally {
      if (btnScan) {
        btnScan.classList.remove('loading');
        const textSpan = btnScan.querySelector('span');
        if (textSpan) textSpan.textContent = '智能扫描波浪';
      }
    }
  }

  const MOTIVE_CIRCLES = ['⓪', '①', '②', '③', '④', '⑤'];
  const CORRECTIVE_CIRCLES = ['⓪', 'Ⓐ', 'Ⓑ', 'Ⓒ', 'Ⓓ', 'Ⓔ'];

  /**
   * 应用当前激活的候选浪型到图表（折线、子浪、通道、价格线、标记、HUD、徽标）
   */
  function applyActiveCandidate(idx) {
    if (!currentAnalysis || !currentAnalysis.candidates || currentAnalysis.candidates.length === 0) {
      if (zigzagSeries) zigzagSeries.setData([]);
      if (subwaveSeries) subwaveSeries.setData([]);
      if (channelUpperSeries) channelUpperSeries.setData([]);
      if (channelLowerSeries) channelLowerSeries.setData([]);
      setChartMarkers(candleSeries, []);
      renderPatternBadge(null, currentAnalysis);
      renderTradingViewHUD(null, currentAnalysis);
      return;
    }
    activeCandidateIndex = Math.max(0, Math.min(idx, currentAnalysis.candidates.length - 1));
    const cand = currentAnalysis.candidates[activeCandidateIndex];
    if (!cand) return;

    const isMotive = cand.category?.includes('驱动') || cand.baseType === 'IMPULSE' || cand.baseType === 'DIAGONAL';
    const isBull = cand.direction === 'BULLISH';

    // 1. 动态自适应调整宏观波浪折线样式 (遵循 TradingView 规范：多头驱动深绿粗实线，空头驱动深红粗实线，调整浪明黄虚线)
    if (zigzagSeries) {
      const zColor = isMotive ? (isBull ? '#10b981' : '#ef4444') : '#f59e0b';
      const zStyle = isMotive ? LightweightCharts.LineStyle.Solid : LightweightCharts.LineStyle.Dashed;
      zigzagSeries.applyOptions({
        color: zColor,
        lineWidth: 2,
        lineStyle: zStyle
      });
      if (cand.pivots && cand.pivots.length > 0) {
        const zData = cand.pivots.map(p => ({ time: p.time, value: p.price }));
        zigzagSeries.setData(showZigzag ? zData : []);
      }
    }

    // 2. 绘制大级别内部嵌套的小级别次级子浪 (Subwaves: 天蓝点虚线)
    if (subwaveSeries) {
      subwaveSeries.applyOptions({
        color: '#06b6d4',
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dotted
      });
      if (cand.subPivots && cand.subPivots.length > 0) {
        const sData = cand.subPivots.map(p => ({ time: p.time, value: p.price }));
        subwaveSeries.setData(showSubwaves ? sData : []);
      } else {
        subwaveSeries.setData([]);
      }
    }

    // 3. 绘制艾略特通道模块
    applyChannel(cand.channel);

    // 4. 绘制 Markers (大浪圆形标引 + 嵌套小浪次级标签)
    applyMarkers(cand);

    // 5. 绘制核心监测点与斐波那契目标线
    applyPriceLines(cand);

    // 6. 更新激活候选浪型卡片高亮
    const cards = document.querySelectorAll('.candidate-card');
    cards.forEach((c, i) => c.classList.toggle('active', i === activeCandidateIndex));

    // 7. 更新当前主浪型基本指标面板
    updateActiveMetrics(cand);

    // 8. 更新图表居中浮动形态徽标与右上角 TradingView HUD
    renderPatternBadge(cand, currentAnalysis);
    renderTradingViewHUD(cand, currentAnalysis);
  }

  /**
   * 绘制艾略特平行/收敛通道模块
   */
  function applyChannel(channel) {
    if (!channelUpperSeries || !channelLowerSeries) return;
    if (!showChannel || !channel) {
      channelUpperSeries.setData([]);
      channelLowerSeries.setData([]);
      return;
    }

    if (channel.type === 'PARALLEL' && channel.baseLine && channel.parallelLine) {
      const pA = channel.baseLine.pA;
      const pB = channel.baseLine.pB;
      const pC = channel.parallelLine.p;

      if (!pA || !pB || !pC) return;
      const tA = pA.time, tB = pB.time;
      const vA = pA.price, vB = pB.price;
      const slope = (vB - vA) / (tB - tA);

      // 下轨
      const lower = [
        { time: tA, value: vA },
        { time: tB, value: vB }
      ];
      // 上轨 (过 pC 且斜率相同)
      const upper = [
        { time: tA, value: Number((pC.price - slope * (pC.time - tA)).toFixed(2)) },
        { time: tB, value: Number((pC.price + slope * (tB - pC.time)).toFixed(2)) }
      ];

      channelLowerSeries.setData(lower);
      channelUpperSeries.setData(upper);
    } else if (channel.type === 'CONVERGING' && channel.upperLine && channel.lowerLine) {
      channelUpperSeries.setData([
        { time: channel.upperLine.pA.time, value: channel.upperLine.pA.price },
        { time: channel.upperLine.pB.time, value: channel.upperLine.pB.price }
      ]);
      channelLowerSeries.setData([
        { time: channel.lowerLine.pA.time, value: channel.lowerLine.pA.price },
        { time: channel.lowerLine.pB.time, value: channel.lowerLine.pB.price }
      ]);
    } else {
      channelUpperSeries.setData([]);
      channelLowerSeries.setData([]);
    }
  }

  /**
   * 应用波浪标引 Markers (大浪圆标 + 嵌套小浪标引)
   */
  function applyMarkers(cand) {
    if (!candleSeries) return;
    if (!showMarkers || !cand || !cand.pivots) {
      setChartMarkers(candleSeries, []);
      return;
    }

    const markers = [];
    const isMotive = cand.category?.includes('驱动') || cand.baseType === 'IMPULSE' || cand.baseType === 'DIAGONAL';
    const isBull = cand.direction === 'BULLISH';
    const circleSymbols = isMotive ? MOTIVE_CIRCLES : CORRECTIVE_CIRCLES;
    const motiveColor = isBull ? '#10b981' : '#ef4444';
    const mainColor = isMotive ? motiveColor : '#f59e0b';

    // 宏观主浪标记
    cand.pivots.forEach((p, idx) => {
      const isHigh = p.type === 'high';
      const rawLabel = cand.waveLabels ? cand.waveLabels[idx] : `${idx}`;
      const circleLabel = circleSymbols[idx] || rawLabel;
      markers.push({
        time: p.time,
        position: isHigh ? 'aboveBar' : 'belowBar',
        color: mainColor,
        shape: isHigh ? 'arrowDown' : 'arrowUp',
        text: `${circleLabel} $${Math.round(p.price).toLocaleString()}`,
        size: 1.4
      });
    });

    // 嵌套微观子浪标记 (如果开启)
    if (showSubwaves && cand.subPivots && Array.isArray(cand.subPivots)) {
      cand.subPivots.forEach(sp => {
        markers.push({
          time: sp.time,
          position: sp.label === 'b' || sp.label === 'ii' || sp.label === 'iv' || sp.label === '2' || sp.label === '4' ? 'belowBar' : 'aboveBar',
          color: '#06b6d4',
          shape: 'circle',
          text: sp.label ? `(${sp.label})` : '',
          size: 0.8
        });
      });
    }

    // 按时间排序
    markers.sort((a, b) => a.time - b.time);
    setChartMarkers(candleSeries, markers);
  }

  /**
   * 应用关键监测点与目标水平虚线 + 斐波那契回撤与拓展
   */
  function applyPriceLines(cand) {
    if (!candleSeries) return;
    activePriceLines.forEach(pl => {
      try { candleSeries.removePriceLine(pl); } catch (e) {}
    });
    activePriceLines = [];

    if (!cand) return;
    const colors = getWaveChartColors();
    const pivot = cand.monitoringPivot;

    // 1. 核心监测点 / 关键失效止损线 (醒目红色虚线，对齐手稿生命线原则)
    if (showMonitoring && pivot && pivot.price) {
      const pLine = candleSeries.createPriceLine({
        price: pivot.price,
        color: '#ef4444',
        lineWidth: 2,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true,
        title: `【失效防守】$${pivot.price.toLocaleString()}`
      });
      activePriceLines.push(pLine);
    }

    // 2. 斐波那契回撤与拓展水平线 (TradingView 风格)
    if (showTargets && cand.fibLevels) {
      const { retracements, extensions } = cand.fibLevels;
      // 选取核心回撤位 (0.382, 0.618)
      if (Array.isArray(retracements)) {
        retracements.filter(r => Math.abs(r.ratio - 0.382) < 0.01 || Math.abs(r.ratio - 0.618) < 0.01).forEach(fib => {
          const fLine = candleSeries.createPriceLine({
            price: fib.price,
            color: '#f59e0b',
            lineWidth: 1,
            lineStyle: LightweightCharts.LineStyle.Dotted,
            axisLabelVisible: true,
            title: `Fib ${(fib.ratio * 100).toFixed(1)}%: $${fib.price.toLocaleString()}`
          });
          activePriceLines.push(fLine);
        });
      }
      // 选取核心拓展位 (1.000x, 1.618x)
      if (Array.isArray(extensions)) {
        extensions.filter(e => Math.abs(e.ratio - 1.0) < 0.01 || Math.abs(e.ratio - 1.618) < 0.01).forEach(fib => {
          const fLine = candleSeries.createPriceLine({
            price: fib.price,
            color: '#10b981',
            lineWidth: 1,
            lineStyle: LightweightCharts.LineStyle.Dotted,
            axisLabelVisible: true,
            title: `Fib ${fib.ratio.toFixed(3)}x: $${fib.price.toLocaleString()}`
          });
          activePriceLines.push(fLine);
        });
      }
    }

    // 3. 形态目标位
    if (showTargets && cand.targets && Array.isArray(cand.targets)) {
      cand.targets.slice(0, 2).forEach(tgt => {
        const tLine = candleSeries.createPriceLine({
          price: tgt.price,
          color: colors.targetColor,
          lineWidth: 1,
          lineStyle: LightweightCharts.LineStyle.Dotted,
          axisLabelVisible: true,
          title: `[目标] ${tgt.label}: $${tgt.price.toLocaleString()}`
        });
        activePriceLines.push(tLine);
      });
    }
  }

  /**
   * 渲染并列候选浪型卡片列表
   */
  function renderCandidatesList(analysis) {
    const container = document.getElementById('wave-candidates-list');
    const badge = document.getElementById('candidate-count-badge');
    if (!container) return;

    const cands = analysis.candidates || [];
    const decLvl = { HIGH: '高', MEDIUM: '中', LOW: '低' }[(analysis.decisiveness || {}).level];
    if (badge) {
      badge.textContent = decLvl
        ? `${analysis.decisiveness.shown} 个方案 · 决断度${decLvl}`
        : `${cands.length} 个候选方案`;
    }

    if (cands.length === 0) {
      container.innerHTML = '<div class="text-secondary" style="font-size:0.72rem;">当前选区暂无合规标准浪型，请查看下方阻碍诊断。</div>';
      return;
    }

    container.innerHTML = cands.map((c, i) => {
      const snapTag = c.snappedToExtreme ? '<span class="candidate-snap-tag" style="color:var(--accent-primary);font-size:0.65rem;font-weight:700;margin-left:4px;">🎯极值磁吸</span>' : '';
      const covTag = c.degreeLabel ? `<span class="candidate-cov-tag" style="font-size:0.65rem;color:var(--text-muted);margin-left:4px;">[${c.degreeLabel}·${c.coveragePct}%]</span>` : '';
      const probTag = c.probability !== undefined ? `<span class="candidate-prob-tag" style="font-size:0.65rem;color:var(--accent-primary);font-weight:700;margin-left:6px;">相对权重 ${c.probability}%</span>` : '';
      return `
      <div class="candidate-card ${i === activeCandidateIndex ? 'active' : ''}" data-idx="${i}">
        <div class="candidate-card-header">
          <span style="font-weight:600;">${c.name}</span>
          <span class="candidate-score-badge">${c.score} 分</span>${probTag}
        </div>
        <div class="candidate-sub-desc">${c.category} · ${c.currentWave} ${covTag} ${snapTag}</div>
        <div class="candidate-pivot-line">监测点: $${c.monitoringPivot?.price?.toLocaleString() || '--'} (${c.monitoringPivot?.levelName || '生命线'})</div>
      </div>
    `;
    }).join('');

    // 点击卡片切换图表与详情
    container.querySelectorAll('.candidate-card').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.idx, 10);
        applyActiveCandidate(idx);
      });
    });
  }

  /**
   * 更新当前选中的主浪型基本指标详情面板
   */
  function updateActiveMetrics(cand) {
    const curP = currentAnalysis?.currentPrice || 0;

    // 1. 同步顶部 Header 徽章与状态
    const headerRegime = document.getElementById('wave-header-regime-pill');
    const headerScore = document.getElementById('wave-header-score-pill');
    const headerTime = document.getElementById('wave-update-time');

    if (headerRegime) headerRegime.textContent = `${cand.name} (${cand.category})`;
    if (headerScore) headerScore.textContent = `匹配得分: ${cand.score}分`;
    if (headerTime) {
      headerTime.textContent = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' (UTC+8)';
    }

    // 2. 同步顶部 5-KPI 标准看板 (对齐 Studio K95 设计规范)
    const kpiName = document.getElementById('kpi-wave-primary-name');
    const kpiBadge = document.getElementById('kpi-wave-primary-badge');
    const kpiCat = document.getElementById('kpi-wave-primary-cat');
    if (kpiName) kpiName.textContent = cand.name;
    if (kpiBadge) kpiBadge.textContent = cand.category || '形态已确认';
    if (kpiCat) kpiCat.textContent = cand.currentWave || '波浪演化中';

    const kpiScore = document.getElementById('kpi-wave-primary-score');
    const kpiScoreBar = document.getElementById('kpi-wave-score-bar');
    if (kpiScore) kpiScore.textContent = `${cand.score} 分`;
    if (kpiScoreBar) kpiScoreBar.style.width = `${Math.min(100, Math.max(10, cand.score))}%`;

    const kpiPivotPrice = document.getElementById('kpi-wave-pivot-price');
    const kpiPivotStatus = document.getElementById('kpi-wave-pivot-status');
    if (cand.monitoringPivot) {
      if (kpiPivotPrice) kpiPivotPrice.textContent = `$${cand.monitoringPivot.price.toLocaleString()}`;
      if (kpiPivotStatus) kpiPivotStatus.textContent = cand.monitoringPivot.levelName || '关键生命线';
    }

    const kpiOriginStatus = document.getElementById('kpi-wave-origin-status');
    const kpiOriginDesc = document.getElementById('kpi-wave-origin-desc');
    if (currentAnalysis?.originAnalysis) {
      const orig = currentAnalysis.originAnalysis;
      if (kpiOriginStatus) {
        kpiOriginStatus.textContent = orig.originType === 'IMPULSE_5W' ? '纯正五浪推动' : '调整浪折返';
        kpiOriginStatus.style.color = orig.isImpulse ? 'var(--color-pos)' : 'var(--text-secondary)';
      }
      if (kpiOriginDesc) {
        kpiOriginDesc.textContent = orig.isImpulse ? '微观五浪分笔完备 · 驱动基因' : '微观为三浪修正 · 防假突破洗盘';
      }
    }

    const kpiScenProb = document.getElementById('kpi-wave-scenario-prob');
    const kpiScenName = document.getElementById('kpi-wave-scenario-name');
    if (currentAnalysis?.scenarios && currentAnalysis.scenarios.length > 0) {
      const topScen = currentAnalysis.scenarios[0];
      if (kpiScenProb) kpiScenProb.textContent = `概率 ${topScen.probability}%`;
      if (kpiScenName) kpiScenName.textContent = topScen.name;
    }

    // 3. 更新右侧主浪型卡片详情
    renderStructureDetail(cand);
    const elWaveName = document.getElementById('wave-regime-name');
    const elWaveBadge = document.getElementById('wave-regime-badge');
    const elWaveCur = document.getElementById('wave-current-stage');

    if (elWaveName) elWaveName.textContent = cand.name || '--';
    if (elWaveCur) elWaveCur.textContent = cand.currentWave || '--';
    if (elWaveBadge) {
      const isMotive = cand.category?.includes('驱动');
      elWaveBadge.textContent = cand.category || (isMotive ? '驱动浪' : '调整浪');
      elWaveBadge.className = `card-badge ${isMotive ? 'badge-bull' : 'badge-neutral'}`;
    }

    // 三大铁律检查
    const r1 = document.getElementById('rule-dot-1');
    const r2 = document.getElementById('rule-dot-2');
    const r3 = document.getElementById('rule-dot-3');
    const rs1 = document.getElementById('rule-status-1');
    const rs2 = document.getElementById('rule-status-2');
    const rs3 = document.getElementById('rule-status-3');
    if (cand.rules) {
      if (r1) r1.className = cand.rules.rule1_wave2_retrace !== false ? 'rule-dot-pass' : 'rule-dot-fail';
      if (r2) r2.className = cand.rules.rule2_wave3_not_shortest !== false ? 'rule-dot-pass' : 'rule-dot-fail';
      if (r3) r3.className = cand.rules.rule3_wave4_no_overlap !== false ? 'rule-dot-pass' : 'rule-dot-fail';
      if (rs1) rs1.textContent = cand.rules.rule1_wave2_retrace !== false ? '100% 达标' : '破位违规';
      if (rs2) rs2.textContent = cand.rules.rule2_wave3_not_shortest !== false ? '满足延伸' : '最短驱动违规';
      if (rs3) rs3.textContent = cand.rules.rule3_wave4_no_overlap !== false ? '严防死守' : '浪4底穿透浪1顶';
    }

    // 核心监测点
    const elPivotPrice = document.getElementById('wave-pivot-price');
    const elPivotDiff = document.getElementById('wave-pivot-diff');
    const elPivotDesc = document.getElementById('wave-pivot-desc');

    if (cand.monitoringPivot) {
      const pPrice = cand.monitoringPivot.price;
      if (elPivotPrice) elPivotPrice.textContent = `$${pPrice.toLocaleString()}`;
      if (elPivotDesc) elPivotDesc.textContent = cand.monitoringPivot.description || '';

      if (elPivotDiff && curP > 0) {
        const diff = curP - pPrice;
        const pct = ((diff / pPrice) * 100).toFixed(2);
        const isSafe = curP >= pPrice;
        elPivotDiff.innerHTML = `距当前价: <strong style="color: ${isSafe ? 'var(--color-pos)' : 'var(--color-neg)'}">${diff >= 0 ? '+' : ''}$${Math.round(diff).toLocaleString()} (${pct}%)</strong> • 状态: <strong style="color: ${isSafe ? 'var(--color-pos)' : 'var(--color-neg)'}">${isSafe ? '防守有效' : '已跌破预警'}</strong>`;
      }
    }

    // 斐波那契目标位
    const tgtContainer = document.getElementById('wave-targets-list');
    if (tgtContainer && cand.targets) {
      tgtContainer.innerHTML = cand.targets.map(t => {
        const diffPct = (((t.price - curP) / curP) * 100).toFixed(1);
        const sign = t.price >= curP ? '+' : '';
        return `
          <div class="wave-target-row">
            <span class="text-secondary">${t.label}</span>
            <div style="text-align: right;">
              <span class="wave-target-price">$${t.price.toLocaleString()}</span>
              <span style="font-size: 0.68rem; color: var(--text-muted); margin-left: 6px;">(${sign}${diffPct}%)</span>
            </div>
          </div>
        `;
      }).join('');
    }

    // 4. 同步更新底部柳玉冬实战研判解读与监测点信号
    if (window.LiuWaveEngine && typeof window.LiuWaveEngine.generateLiuCommentary === 'function') {
      const activeCommentary = window.LiuWaveEngine.generateLiuCommentary(
        cand,
        curP,
        currentAnalysis?.symbol || currentSymbol,
        currentAnalysis?.timeframe || currentTf,
        currentAnalysis
      );
      const elThesis = document.getElementById('wave-thesis-text');
      const elBottomSignal = document.getElementById('wave-bottom-signal');
      if (elThesis && activeCommentary) elThesis.textContent = activeCommentary.thesis;
      if (elBottomSignal && activeCommentary) elBottomSignal.textContent = activeCommentary.bottomTopSignal;
    }

    // 5. 动态穿透检测选中候选首浪的出身
    if (window.LiuWaveEngine && typeof window.LiuWaveEngine.analyzeOrigin === 'function' && currentBars && currentBars.length > 0) {
      const activeOrig = window.LiuWaveEngine.analyzeOrigin(cand, { bars: currentBars });
      const originBadge = document.getElementById('wave-origin-badge');
      const originText = document.getElementById('wave-origin-text');
      if (activeOrig) {
        if (originBadge) {
          originBadge.textContent = activeOrig.originType === 'IMPULSE_5W' ? '纯正五浪推动' : '调整浪折返';
          originBadge.className = `card-badge ${activeOrig.isImpulse ? 'badge-bull' : 'badge-neutral'}`;
        }
        if (originText) originText.textContent = activeOrig.text || '';
      }
    }
  }

  /**
   * 渲染图表居中浮动形态徽标 (对齐 TradingView Pattern Badge)
   */
  function renderPatternBadge(cand, analysis) {
    const badge = document.getElementById('wave-pattern-badge');
    if (!badge) return;
    if (!cand) {
      badge.style.display = 'none';
      return;
    }
    const isMotive = cand.category?.includes('驱动') || cand.baseType === 'IMPULSE' || cand.baseType === 'DIAGONAL';
    const isBull = cand.direction === 'BULLISH';
    const dirIcon = isMotive ? (isBull ? '▲ 驱动浪' : '▼ 驱动浪') : '◆ 调整浪';
    const iconColor = isMotive ? (isBull ? 'var(--color-pos)' : 'var(--color-neg)') : 'var(--color-warning)';
    const mtfTxt = analysis?.mtf?.alignmentLabel || 'MTF';
    const snapBadge = cand.snappedToExtreme ? `<span class="badge-snap" style="color:var(--accent-primary);font-weight:700;margin-left:4px;">🎯 极值磁吸</span>` : '';

    badge.innerHTML = `
      <span class="badge-icon" style="color: ${iconColor};">${dirIcon}</span>
      <span class="badge-name">${cand.name}</span>
      <span class="badge-score">${cand.score}分</span>
      <span class="badge-rules">${cand.currentWave || '进行中'}</span>
      <span class="badge-mtf">MTF: ${mtfTxt}</span>
      ${snapBadge}
    `;
    badge.style.display = 'flex';
  }

  /**
   * 渲染右上角 TradingView 风格浮动 HUD 信息面板
   */
  function renderTradingViewHUD(cand, analysis) {
    const hud = document.getElementById('wave-tv-hud');
    const hudBody = document.getElementById('wave-tv-hud-body');
    const mtfBadge = document.getElementById('wave-tv-mtf-badge');
    if (!hud || !hudBody) return;
    if (!cand || !analysis) {
      hud.style.display = 'none';
      return;
    }

    const mtf = analysis.mtf || {};
    const forecast = analysis.forecast || {};
    const isMotive = cand.category?.includes('驱动') || cand.baseType === 'IMPULSE' || cand.baseType === 'DIAGONAL';
    const isBull = cand.direction === 'BULLISH';

    if (mtfBadge) {
      mtfBadge.textContent = mtf.alignmentLabel || 'MTF AUTO';
      mtfBadge.className = `wave-tv-mtf-badge ${mtf.alignment === 'ALIGNED' ? 'badge-pos' : mtf.alignment === 'CONFLICTING' ? 'badge-neg' : 'badge-warn'}`;
    }

    const pivotP = cand.monitoringPivot?.price;
    const t1 = cand.targets && cand.targets[0] ? cand.targets[0].price : null;
    const t2 = cand.targets && cand.targets[1] ? cand.targets[1].price : null;

    const actionClass = forecast.action === 'BUY' ? 'action-buy' : forecast.action === 'SELL' ? 'action-sell' : 'action-wait';

    hudBody.innerHTML = `
      <div class="wave-tv-row">
        <span class="wave-tv-label">标的 · 周期</span>
        <span class="wave-tv-val" style="font-weight:700;">${analysis.symbol} · ${analysis.timeframe.toUpperCase()}</span>
      </div>
      <div class="wave-tv-row">
        <span class="wave-tv-label">最优浪型</span>
        <span class="wave-tv-val" style="color: ${isMotive ? (isBull ? 'var(--color-pos)' : 'var(--color-neg)') : 'var(--color-warning)'}; font-weight:700;">${cand.name}</span>
      </div>
      <div class="wave-tv-row">
        <span class="wave-tv-label">形态属性</span>
        <span class="wave-tv-val">
          <span class="wave-action-tag ${isBull ? 'action-buy' : 'action-sell'}">${cand.category}</span>
          <span style="font-size:0.68rem; margin-left:4px; opacity:0.8;">(${cand.score}分)</span>
        </span>
      </div>
      <div class="wave-tv-row">
        <span class="wave-tv-label">选区极值</span>
        <span class="wave-tv-val" style="font-size:0.68rem;">
          ${analysis.rangeExtrema ? `L $${Number(analysis.rangeExtrema.minPrice.toFixed(0)).toLocaleString()} / H $${Number(analysis.rangeExtrema.maxPrice.toFixed(0)).toLocaleString()} <strong style="color:var(--accent-primary);">(${analysis.rangeExtrema.dominantDirection === 'BULLISH' ? '多' : '空'})</strong>` : '全图极值'}
        </span>
      </div>
      <div class="wave-tv-row">
        <span class="wave-tv-label">前序承接</span>
        <span class="wave-tv-val" style="font-size:0.68rem; color:var(--text-secondary);">
          ${analysis.precedingContext?.hasPrecedingData ? `${analysis.precedingContext.character || '前序'} · ${analysis.precedingContext.dominantTrend === 'BEARISH' ? '顺跌反弹' : analysis.precedingContext.dominantTrend === 'BULLISH' ? '顺涨洗盘' : '箱体'}` : '首段起点'}
        </span>
      </div>
      <div class="wave-tv-row">
        <span class="wave-tv-label">当前阶段</span>
        <span class="wave-tv-val" style="color:var(--text-primary); font-size:0.70rem;">${cand.currentWave}</span>
      </div>
      <div class="wave-tv-row">
        <span class="wave-tv-label">大势共振</span>
        <span class="wave-tv-val" style="font-size:0.70rem; color:${mtf.alignment === 'ALIGNED' ? 'var(--color-pos)' : mtf.alignment === 'CONFLICTING' ? 'var(--color-neg)' : 'var(--text-secondary)'};">
          ${mtf.htf1?.label || '--'} · <strong>${mtf.alignmentLabel || '中性'}</strong>
        </span>
      </div>
      <div class="wave-tv-divider">── 监测防守 & 斐波目标 ──</div>
      <div class="wave-tv-row">
        <span class="wave-tv-label">失效防守</span>
        <span class="wave-tv-val" style="color:var(--color-neg); font-weight:700;">$${pivotP ? pivotP.toLocaleString() : '--'}</span>
      </div>
      <div class="wave-tv-row">
        <span class="wave-tv-label">目标 1 / 2</span>
        <span class="wave-tv-val" style="color:var(--accent-primary); font-weight:600;">$${t1 ? t1.toLocaleString() : '--'} / $${t2 ? t2.toLocaleString() : '--'}</span>
      </div>
      <div class="wave-tv-row">
        <span class="wave-tv-label">推演指引</span>
        <span class="wave-tv-val">
          <span class="wave-action-tag ${actionClass}">
            ${forecast.nextWave || '观望确认'}
          </span>
          <span class="wave-tv-stars" style="margin-left:4px;">${forecast.stars || ''}</span>
        </span>
      </div>
    `;
    hud.style.display = 'block';
  }

  /**
   * 渲染右侧综合研判面板 (出身、阻碍诊断、情景推演)
   */
  function renderDiagnosticPanel(analysis) {
    // 1. 出身决定命运卡片
    const originBadge = document.getElementById('wave-origin-badge');
    const originText = document.getElementById('wave-origin-text');
    if (analysis.originAnalysis) {
      if (originBadge) {
        const isPure = analysis.originAnalysis.originType === 'IMPULSE_5W';
        originBadge.textContent = isPure ? '纯正五浪推动' : '调整浪折返';
        originBadge.className = `card-badge ${isPure ? 'badge-bull' : 'badge-neutral'}`;
      }
      if (originText) originText.textContent = analysis.originAnalysis.text || '';
    }

    // 1.5 前序浪型大级别脉络卡片 (观当下必先审前身)
    const precBadge = document.getElementById('wave-preceding-badge');
    const precText = document.getElementById('wave-preceding-text');
    if (analysis.precedingContext && analysis.precedingContext.hasPrecedingData) {
      const ctx = analysis.precedingContext;
      if (precBadge) {
        precBadge.textContent = ctx.dominantTrend === 'BEARISH' ? '承接顺跌' : ctx.dominantTrend === 'BULLISH' ? '承接顺涨' : '承接震荡';
        precBadge.className = `card-badge ${ctx.dominantTrend === 'BULLISH' ? 'badge-bull' : ctx.dominantTrend === 'BEARISH' ? 'badge-bear' : 'badge-neutral'}`;
      }
      if (precText) {
        const resTxt = ctx.keyResistance ? `$${Math.round(ctx.keyResistance).toLocaleString()}` : '--';
        const supTxt = ctx.keySupport ? `$${Math.round(ctx.keySupport).toLocaleString()}` : '--';
        precText.innerHTML = `
          <div style="display:flex; justify-content:space-between; margin-bottom:6px; font-size:0.71rem; color:var(--text-muted);">
            <span>性质: <strong style="color:var(--text-primary);">${ctx.character}</strong></span>
            <span>前序振幅: <strong style="color:var(--text-primary);">${ctx.amplitudePct}%</strong></span>
            <span>关键参照: <strong>${resTxt} / ${supTxt}</strong></span>
          </div>
          <div style="line-height:1.5;">${ctx.liuDeduction}</div>
        `;
      }
    }

    // 2. 阻碍诊断卡片 (为什么排除？)
    const cardBlockers = document.getElementById('card-wave-blockers');
    const blockersList = document.getElementById('wave-blockers-list');
    if (cardBlockers && blockersList) {
      const blockers = analysis.blockers || [];
      if (blockers.length > 0) {
        cardBlockers.style.display = 'block';
        blockersList.innerHTML = blockers.map(b => `
          <div class="blocker-item">${b}</div>
        `).join('');
      } else {
        cardBlockers.style.display = 'none';
      }
    }

    // 3. 发展可能性讨论 (情景分析)
    const scenariosList = document.getElementById('wave-scenarios-list');
    if (scenariosList) {
      const scenarios = analysis.scenarios || [];
      scenariosList.innerHTML = scenarios.map(s => `
        <div class="scenario-card">
          <div class="scenario-header">
            <span>情景 ${s.rank || ''}: ${s.name}</span>
            <span class="scenario-prob">概率 ${s.probability}%</span>
          </div>
          <div class="scenario-desc">${s.rationale || s.description || ''}</div>
          <div class="scenario-pivots">
            <div><span>确认触发点:</span> <strong>$${s.confirmTrigger ? s.confirmTrigger.toLocaleString() : '--'}</strong></div>
            <div><span>失效临界位:</span> <strong>$${s.invalidationLevel ? s.invalidationLevel.toLocaleString() : '--'}</strong></div>
          </div>
        </div>
      `).join('');
    }

    // 4. 柳玉冬实战研判解读
    const elThesis = document.getElementById('wave-thesis-text');
    const elBottomSignal = document.getElementById('wave-bottom-signal');
    const elQuote = document.getElementById('wave-quote-text');

    if (analysis.commentary) {
      if (elThesis) elThesis.textContent = analysis.commentary.thesis;
      if (elBottomSignal) {
        const extra = (analysis.commentary.liuLines || []).map(t => `· ${t}`).join('\n');
        elBottomSignal.style.whiteSpace = 'pre-line';
        elBottomSignal.textContent = analysis.commentary.bottomTopSignal + (extra ? `\n${extra}` : '');
      }
      if (elQuote) elQuote.textContent = analysis.commentary.quote;
    }

    // 5. v3 柳氏实战信号 & 级别阶梯
    renderLiuSignals(analysis);
    renderDegreeLadder(analysis);
  }

  // ---------------------------------------------------------------------------
  // v3 · 柳氏实战信号 / 级别阶梯 / 柳玉冬波浪脉络 (按标的时间串联)
  // ---------------------------------------------------------------------------



  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtP(v) {
    if (v === null || v === undefined || !isFinite(v)) return '--';
    const a = Math.abs(v);
    return Number(v).toLocaleString('en-US', { maximumFractionDigits: a >= 1000 ? 1 : a >= 10 ? 2 : 4 });
  }

  function resetLiuSignalCards() {
    const body = document.getElementById('wave-liu-signals-body');
    const badge = document.getElementById('wave-liu-signal-badge');
    const ladder = document.getElementById('wave-degree-ladder-body');
    if (body) body.innerHTML = '<p class="liu-idle">研判后显示：监测点战法、最大回撤判据、吃掉前段0.618/0.7、调整分部投射与出身检验。</p>';
    if (badge) { badge.textContent = '待研判'; badge.className = 'card-badge badge-neutral'; }
    if (ladder) ladder.innerHTML = '<p class="liu-idle">研判后显示高一级别、本级别与当前段小级别的嵌套关系。</p>';
  }

  function renderLiuSignals(analysis) {
    const body = document.getElementById('wave-liu-signals-body');
    const badge = document.getElementById('wave-liu-signal-badge');
    if (!body) return;
    const ls = analysis && analysis.liuSignals;
    if (!ls) { resetLiuSignalCards(); return; }
    const bull = ls.direction === 'BULLISH';
    const mp = ls.monitorPoint;
    const stTxt = mp.status === 'HOLDING' ? (bull ? '上涨延续中' : '下跌延续中')
      : mp.status === 'BROKEN' ? (bull ? '小级别见顶' : '小级别见底') : '本段已结束';
    if (badge) {
      badge.textContent = stTxt;
      badge.className = `card-badge ${mp.status === 'HOLDING' ? (bull ? 'badge-bull' : 'badge-bear') : 'badge-neutral'}`;
    }
    const eat = ls.eatBack;
    const pctW = eat.ratio === null ? 0 : Math.min(100, eat.ratio / 1.2 * 100);
    const ticks = [0.618, 0.7, 1].map(k => `<div class="liu-eat-tick${k === 0.7 ? ' up' : ''}" style="left:${(k / 1.2 * 100).toFixed(1)}%"><span>${k}</span></div>`).join('');
    const parts = (ls.partsProjector || []).map(r => `
      <tr class="${r.alive ? '' : 'dead'}">
        <td>${esc(r.pattern)} <span style="color:var(--text-muted)">${esc(r.role)}浪</span></td>
        <td class="num">${fmtP(r.minPrice)}</td>
        <td>${r.alive ? (r.reachedMin ? '<span class="liu-chip pos">满足</span>' : '<span class="liu-chip">未到</span>') : '<span class="liu-chip neg">否决</span>'}</td>
      </tr>`).join('');
    const origin = ls.origin || {};
    body.innerHTML = `
      <div class="liu-signal-row">
        <div class="liu-signal-title"><span>监测点战法</span><span class="liu-chip ${mp.status === 'HOLDING' ? 'pos' : 'warn'}">${fmtP(mp.price)}</span></div>
        ${esc(mp.text)}
      </div>
      <div class="liu-signal-row">
        <div class="liu-signal-title"><span>最大回撤判据</span><span class="liu-chip ${ls.largestCounterMove.exceeded ? 'warn' : ''}">段内最大 ${fmtP(ls.largestCounterMove.innerMax)}</span></div>
        ${esc(ls.largestCounterMove.text)}
      </div>
      <div class="liu-signal-row">
        <div class="liu-signal-title"><span>吃掉前段比例</span><span class="liu-chip info">${eat.ratio === null ? '--' : (eat.ratio * 100).toFixed(0) + '%'}</span></div>
        <div class="liu-eat-bar"><div class="liu-eat-fill" style="width:${pctW.toFixed(1)}%"></div>${ticks}</div>
        ${esc(eat.verdict)}
      </div>
      <div class="liu-signal-row">
        <div class="liu-signal-title"><span>调整分部投射（前段作第一部分时，第二部分最低要求）</span></div>
        ${(ls.partsProjector || []).some(r => r.alive) ? '' : '<div style="color:var(--text-muted);margin-bottom:2px">当前段已远超前段（超过各浪型上限），前段不再是本级别调整的第一部分，投射仅作参考。</div>'}
        <table class="liu-parts-table"><tbody>${parts}</tbody></table>
      </div>
      <div class="liu-signal-row">
        <div class="liu-signal-title"><span>出身 · 当前段结构</span><span class="liu-chip ${origin.structure === '5' ? 'pos' : origin.structure === '3' ? 'neg' : ''}">${origin.structure === '5' ? '五浪' : origin.structure === '3' ? '非五浪' : '待定'}</span></div>
        ${esc(origin.text || '')}
        ${ls.threeLegWarning ? `<div style="margin-top:4px;color:var(--color-warn)">${esc(ls.threeLegWarning)}</div>` : ''}
        ${origin.leadingDiagonal ? `<div style="margin-top:4px;color:var(--text-muted)">${esc(origin.leadingDiagonal.text)}</div>` : ''}
      </div>`;
  }

  /** 主浪型卡片: 浪2/浪4 交替原则 与 联合形组成部分 */
  function renderStructureDetail(cand) {
    const el = document.getElementById('wave-structure-detail');
    if (!el) return;
    const rows = [];
    const alt = cand && cand.alternation;
    if (alt) {
      const chip = alt.pass === true ? '<span class="liu-chip pos">符合交替</span>'
        : alt.pass === false ? '<span class="liu-chip warn">未交替</span>' : '<span class="liu-chip">待确认</span>';
      const cls = w => w && w.class ? esc(w.class.text) : '结构未识别';
      rows.push(`<div class="liu-signal-title"><span>交替原则 · 浪2 vs 浪4</span>${chip}</div>`);
      rows.push(`<div>浪2：${cls(alt.wave2)} · 回撤 ${(alt.wave2.retrace * 100).toFixed(0)}%</div>`);
      if (alt.wave4) rows.push(`<div>浪4：${cls(alt.wave4)} · 回撤 ${(alt.wave4.retrace * 100).toFixed(0)}%</div>`);
      rows.push(`<div style="margin-top:3px;color:var(--text-muted)">${esc(alt.text)}</div>`);
    }
    const comps = cand && cand.components;
    if (comps && comps.length) {
      rows.push(`<div class="liu-signal-title" style="margin-top:${alt ? 8 : 0}px"><span>组成部分识别</span></div>`);
      rows.push(comps.map(c => `<div>${esc(c.label)} 浪：${esc(c.text)}${c.developing ? '（运行中）' : ''}</div>`).join(''));
    }
    const tws = (cand && cand.timeWindows) || [];
    if (tws.length) {
      rows.push(`<div class="liu-signal-title" style="margin-top:${rows.length ? 8 : 0}px"><span>时间规则 · 截止日期</span></div>`);
      rows.push(tws.map(w => `<div style="${w.overdue ? 'color:var(--color-warn)' : ''}">${esc(w.text)}</div>`).join(''));
    }
    el.style.display = rows.length ? 'block' : 'none';
    el.innerHTML = rows.join('');
  }

  function renderDegreeLadder(analysis) {
    const el = document.getElementById('wave-degree-ladder-body');
    if (!el) return;
    const dl = analysis && analysis.degreeLadder;
    if (!dl || !dl.levels || !dl.levels.length) {
      el.innerHTML = '<p class="liu-idle">无可用的级别阶梯。</p>';
      return;
    }
    const cls = { HIGHER: 'higher', MAIN: 'main', LOWER: 'lower' };
    const rows = dl.levels.map(l => {
      let txt;
      if (l.count) {
        const pts = l.count.pivots.map((p, i) => `${esc(l.count.waveLabels[i] || '')}:${fmtP(p.price)}`).join(' → ');
        txt = `<strong>${esc(l.count.name)}</strong><div style="font-family:var(--font-mono);font-size:0.64rem;color:var(--text-muted);margin-top:2px">${pts}</div>`;
      } else if (l.degree === 'LOWER') {
        txt = esc(l.text || '');
      } else {
        txt = '<span style="color:var(--text-muted)">该级别暂无合规计数</span>';
      }
      const meta = l.pivotCount ? `<div style="font-size:0.6rem;color:var(--text-muted);font-weight:500">${l.pivotCount} 拐点</div>` : '';
      return `<div class="liu-ladder-row ${cls[l.degree] || ''}"><div class="deg">${esc(l.label)}${meta}</div><div>${txt}</div></div>`;
    }).join('');
    el.innerHTML = rows + (dl.nesting ? `<div class="liu-nesting">${esc(dl.nesting.text)}</div>` : '');
  }


  /**
   * 初始化事件监听器 (标的切换、图表工具开关、框选交互)
   */
  function initEvents() {
    // 标的切换 (BTC / ETH) - 切换标的并触发实时波浪解算
    const symbolBtns = document.querySelectorAll('.wave-symbol-btn:not(.wave-tf-btn)');
    symbolBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const sym = btn.dataset.symbol;
        if (sym && sym !== currentSymbol) {
          symbolBtns.forEach(b => b.classList.toggle('active', b === btn));
          cancelRangeSelection();
          currentRange = null;
          updateRangeBanner(null, null);
          loadChartCandles(sym);
        }
      });
    });


    // 周期切换 (15m / 1H / 4H) - 重新拉取周期 K 线并实时重新解算波浪
    const tfBtns = document.querySelectorAll('.wave-tf-btn');
    tfBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const tf = btn.dataset.interval;
        if (tf && tf !== currentTf) {
          currentTf = tf;
          tfBtns.forEach(b => b.classList.toggle('active', b === btn));
          const tfLabelEl = document.getElementById('wave-tf-label');
          if (tfLabelEl) tfLabelEl.textContent = tf === '15m' ? '15m (15分钟)' : tf === '1h' ? '1H (1小时)' : '4H (4小时)';
          cancelRangeSelection();
          currentRange = null;
          updateRangeBanner(null, null);
          loadChartCandles(currentSymbol);
        }
      });
    });

    // 智能扫描按钮 (有选区扫选区，无选区扫全量当前周期走势)
    const btnScan = document.getElementById('btn-scan-waves');
    if (btnScan) {
      btnScan.addEventListener('click', () => {
        runWaveAnalysis(currentSymbol, currentRange);
      });
    }

    // 框选分析模式开关 (两步点击选区：第一次点设起点，移动预览，第二次点结束，上限750根K线)
    const btnDrag = document.getElementById('btn-drag-range');
    const container = document.getElementById('wave-chart-container');
    if (btnDrag) {
      btnDrag.addEventListener('click', () => {
        if (isSelectingRange) {
          cancelRangeSelection();
          const statusMsg = document.getElementById('wave-status-msg');
          if (statusMsg) statusMsg.textContent = '已退出框选分析模式';
        } else {
          isSelectingRange = true;
          selectionStartPoint = null;
          selectionHoverPoint = null;
          btnDrag.classList.add('active');
          btnDrag.innerHTML = '📍 点击图表设定起点';
          if (container) {
            container.style.cursor = 'crosshair';
          }
          const statusMsg = document.getElementById('wave-status-msg');
          if (statusMsg) {
            statusMsg.textContent = `🖱️ 选区模式：请在 ${currentTf.toUpperCase()} 图表上单击设定【分析起点】（支持最大 750 根 K 线，Esc 取消）`;
          }
        }
      });
    }

    // Esc 快捷键取消正在进行的选区操作
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape' && isSelectingRange) {
        cancelRangeSelection();
        const statusMsg = document.getElementById('wave-status-msg');
        if (statusMsg) statusMsg.textContent = '已取消选区操作';
      }
    });

    // 完全重置图表按钮 - 清空所有波浪预设与选区，恢复纯净K线，准备选取新的K线区域
    const btnResetRange = document.getElementById('btn-reset-range');
    if (btnResetRange) {
      btnResetRange.addEventListener('click', () => {
        cancelRangeSelection();
        currentRange = null;
        updateRangeBanner(null, null);
        clearWaveAnalysisState();
        if (waveChart && currentBars && currentBars.length > 0) {
          if (currentBars.length > 150) {
            waveChart.timeScale().setVisibleLogicalRange({
              from: currentBars.length - 150,
              to: currentBars.length
            });
          } else {
            waveChart.timeScale().fitContent();
          }
        }
        const statusMsg = document.getElementById('wave-status-msg');
        if (statusMsg) {
          statusMsg.textContent = `● [${currentSymbol} ${currentTf.toUpperCase()}] 图表已完全重置（无任何波浪预设）· 请点击【🖱️ 框选分析模式】选取待研判的 K 线区域`;
        }
      });
    }

    const btnCancelRange = document.getElementById('btn-cancel-range');
    if (btnCancelRange) {
      btnCancelRange.addEventListener('click', () => {
        cancelRangeSelection();
        currentRange = null;
        updateRangeBanner(null, null);
        clearWaveAnalysisState();
        if (waveChart && currentBars && currentBars.length > 0) {
          if (currentBars.length > 150) {
            waveChart.timeScale().setVisibleLogicalRange({
              from: currentBars.length - 150,
              to: currentBars.length
            });
          } else {
            waveChart.timeScale().fitContent();
          }
        }
        const statusMsg = document.getElementById('wave-status-msg');
        if (statusMsg) {
          statusMsg.textContent = `● [${currentSymbol} ${currentTf.toUpperCase()}] 已退出选区并完全重置 · 请点击【🖱️ 框选分析模式】选取待研判的 K 线区域`;
        }
      });
    }

    // 大浪嵌套小浪开关
    const btnSubwaves = document.getElementById('btn-toggle-subwaves');
    if (btnSubwaves) {
      btnSubwaves.addEventListener('click', () => {
        showSubwaves = !showSubwaves;
        btnSubwaves.classList.toggle('active', showSubwaves);
        applyActiveCandidate(activeCandidateIndex);
      });
    }

    // 艾略特通道开关
    const btnChannel = document.getElementById('btn-toggle-channel');
    if (btnChannel) {
      btnChannel.addEventListener('click', () => {
        showChannel = !showChannel;
        btnChannel.classList.toggle('active', showChannel);
        applyActiveCandidate(activeCandidateIndex);
      });
    }

    // 工具栏切换开关
    const btnMarkers = document.getElementById('btn-toggle-markers');
    if (btnMarkers) {
      btnMarkers.addEventListener('click', () => {
        showMarkers = !showMarkers;
        btnMarkers.classList.toggle('active', showMarkers);
        applyActiveCandidate(activeCandidateIndex);
      });
    }

    const btnZigzag = document.getElementById('btn-toggle-zigzag');
    if (btnZigzag) {
      btnZigzag.addEventListener('click', () => {
        showZigzag = !showZigzag;
        btnZigzag.classList.toggle('active', showZigzag);
        applyActiveCandidate(activeCandidateIndex);
      });
    }

    const btnMonitoring = document.getElementById('btn-toggle-invalidation');
    if (btnMonitoring) {
      btnMonitoring.addEventListener('click', () => {
        showMonitoring = !showMonitoring;
        btnMonitoring.classList.toggle('active', showMonitoring);
        applyActiveCandidate(activeCandidateIndex);
      });
    }

    const btnTargets = document.getElementById('btn-toggle-targets');
    if (btnTargets) {
      btnTargets.addEventListener('click', () => {
        showTargets = !showTargets;
        btnTargets.classList.toggle('active', showTargets);
        applyActiveCandidate(activeCandidateIndex);
      });
    }
  }

  // 挂载全局接口供 app.js 联动
  window.WaveRadarModule = {
    init: function () {
      initEvents();
      if (window.location.hash === '#wave-radar' || document.getElementById('view-wave-radar')?.classList.contains('active')) {
        loadChartCandles(currentSymbol);
      }
    },
    runAnalysis: runWaveAnalysis,
    loadCandles: loadChartCandles,
    clearState: clearWaveAnalysisState,
    updateTheme: updateTheme,
    onViewActivated: function () {
      if (!waveChart) {
        initChart();
      }
      if (currentBars.length === 0) {
        loadChartCandles(currentSymbol);
      } else {
        const container = document.getElementById('wave-chart-container');
        if (container && waveChart) {
          waveChart.applyOptions({ width: container.clientWidth });
        }
      }
    }
  };

})();
