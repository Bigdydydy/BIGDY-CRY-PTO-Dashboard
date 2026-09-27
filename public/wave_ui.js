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
  let currentBars = [];
  let currentAnalysis = null;
  let activeCandidateIndex = 0;
  let activePriceLines = [];
  let currentRange = null; // { startTime, endTime, barsCount }

  // 图表可见性控制开关
  let showMarkers = true;
  let showZigzag = true;
  let showSubwaves = true;
  let showChannel = true;
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
      if (count < 2) {
        const statusMsg = document.getElementById('wave-status-msg');
        if (statusMsg) {
          statusMsg.textContent = '⚠️ 起点与终点不能相同，请选择包含至少 2 根 K 线的有效区间';
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

  function updateRangeBanner(startTime, endTime, barsCount) {
    const banner = document.getElementById('wave-range-banner');
    const rangeText = document.getElementById('wave-range-text');
    if (!banner || !rangeText) return;

    if (startTime && endTime) {
      const d1 = new Date(startTime * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      const d2 = new Date(endTime * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      const countLabel = barsCount ? ` · 共 ${barsCount} 根 K 线 (${barsCount * 4}小时)` : '';
      rangeText.textContent = `${d1} 至 ${d2}${countLabel}`;
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

  /**
   * 抓取 4H 1000 根 K线 (优先币安 Futures 合约源)
   */
  async function fetch4hKlines(symbol) {
    const cleanSymbol = symbol.replace(/[\/\-_]/g, '').toUpperCase();
    const urls = [
      `/api/wave/klines?symbol=${cleanSymbol}&interval=4h&limit=1000`,
      `https://fapi.binance.com/fapi/v1/klines?symbol=${cleanSymbol}&interval=4h&limit=1000`,
      `https://data-api.binance.vision/api/v3/klines?symbol=${cleanSymbol}&interval=4h&limit=1000`,
      `https://api.binance.com/api/v3/klines?symbol=${cleanSymbol}&interval=4h&limit=1000`
    ];

    let lastError = null;
    for (const url of urls) {
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(6000) });
        if (resp.ok) {
          const json = await resp.json();
          if (json && json.bars && Array.isArray(json.bars)) {
            return { bars: json.bars, source: '币安 Futures (本地缓存加速)' };
          }
          if (Array.isArray(json) && json.length > 0) {
            const bars = json.map(b => ({
              time: Math.floor(b[0] / 1000),
              open: parseFloat(b[1]),
              high: parseFloat(b[2]),
              low: parseFloat(b[3]),
              close: parseFloat(b[4]),
              volume: parseFloat(b[5])
            }));
            return { bars, source: '币安合约直连 (fapi.binance.com)' };
          }
        }
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('无法连接到币安行情源');
  }

  /**
   * 执行波浪分析 (支持全量与自定义选区)
   */
  async function runWaveAnalysis(symbol = currentSymbol, rangeOptions = currentRange) {
    currentSymbol = symbol;
    const btnScan = document.getElementById('btn-scan-waves');
    const statusMsg = document.getElementById('wave-status-msg');
    const hudSym = document.getElementById('hud-sym');

    if (hudSym) hudSym.textContent = `${symbol} 4H`;
    if (btnScan) {
      btnScan.classList.add('loading');
      const textSpan = btnScan.querySelector('span');
      if (textSpan) textSpan.textContent = '分析研判中...';
    }
    if (statusMsg) {
      statusMsg.textContent = rangeOptions ? `正在分析选定区间 [${symbol} 4H]...` : `正在拉取 ${symbol} 最新 4H K线并执行柳玉冬波浪模型...`;
    }

    try {
      const { bars, source } = await fetch4hKlines(symbol);
      currentBars = bars;

      if (!waveChart) {
        initChart();
      }

      // 1. 设置主图蜡烛 (不显示成交量，提升画廊级研判纯粹度)
      const candleData = bars.map(b => ({
        time: b.time,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close
      }));
      candleSeries.setData(candleData);

      // 2. 调用后端或本地引擎执行全量与选区分析
      let analysis = null;
      try {
        const queryParams = new URLSearchParams({
          symbol: symbol.replace(/[\/\-_]/g, '').toUpperCase()
        });
        if (rangeOptions?.startTime && rangeOptions?.endTime) {
          queryParams.append('startTime', rangeOptions.startTime);
          queryParams.append('endTime', rangeOptions.endTime);
        }
        const apiResp = await fetch(`/api/wave/analysis?${queryParams.toString()}`);
        if (apiResp.ok) {
          analysis = await apiResp.json();
        }
      } catch (e) {
        // 后端若不可用则降级至客户端 UMD 引擎
      }

      if (!analysis || analysis.code !== 0) {
        if (!window.LiuWaveEngine) throw new Error('波浪计算引擎尚未就绪');
        analysis = window.LiuWaveEngine.analyzeWaves(bars, symbol, rangeOptions || {});
      }

      currentAnalysis = analysis;
      activeCandidateIndex = 0;

      // 3. 渲染候选浪型并上图展示
      renderCandidatesList(analysis);
      applyActiveCandidate(0);

      // 4. 侧边栏各板块更新
      renderDiagnosticPanel(analysis, source);

      // 5. 缩放视野：若有选区则聚焦到选区，否则聚焦最近 150 根
      if (rangeOptions?.startTime && rangeOptions?.endTime) {
        waveChart.timeScale().setVisibleRange({
          from: rangeOptions.startTime,
          to: rangeOptions.endTime
        });
      } else if (bars.length > 150) {
        waveChart.timeScale().setVisibleLogicalRange({
          from: bars.length - 150,
          to: bars.length
        });
      }

      if (statusMsg) {
        const rangeDesc = rangeOptions ? `选定区间 (${analysis.selectedRange?.barsCount || 0} 根K线)` : '全量宏观';
        statusMsg.textContent = `● 已完成 [${symbol} 4H] ${rangeDesc} 深度扫描 · 匹配出 ${analysis.candidates?.length || 0} 个合规浪型`;
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

  /**
   * 应用当前激活的候选浪型到图表（折线、子浪、通道、价格线、标记）
   */
  function applyActiveCandidate(idx) {
    if (!currentAnalysis || !currentAnalysis.candidates || currentAnalysis.candidates.length === 0) return;
    activeCandidateIndex = Math.max(0, Math.min(idx, currentAnalysis.candidates.length - 1));
    const cand = currentAnalysis.candidates[activeCandidateIndex];
    if (!cand) return;

    // 1. 绘制大级别宏观波浪折线 (Zigzag)
    if (zigzagSeries && cand.pivots && cand.pivots.length > 0) {
      const zData = cand.pivots.map(p => ({ time: p.time, value: p.price }));
      zigzagSeries.setData(showZigzag ? zData : []);
    }

    // 2. 绘制大级别内部嵌套的小级别次级子浪 (Subwaves)
    if (subwaveSeries && cand.subPivots && cand.subPivots.length > 0) {
      const sData = cand.subPivots.map(p => ({ time: p.time, value: p.price }));
      subwaveSeries.setData(showSubwaves ? sData : []);
    } else if (subwaveSeries) {
      subwaveSeries.setData([]);
    }

    // 3. 绘制艾略特通道模块
    applyChannel(cand.channel);

    // 4. 绘制 Markers (大浪标签 + 嵌套小浪标签)
    applyMarkers(cand);

    // 5. 绘制核心监测点与斐波那契目标线
    applyPriceLines(cand);

    // 6. 更新激活候选浪型卡片高亮
    const cards = document.querySelectorAll('.candidate-card');
    cards.forEach((c, i) => c.classList.toggle('active', i === activeCandidateIndex));

    // 7. 更新当前主浪型基本指标面板
    updateActiveMetrics(cand);
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
   * 应用波浪标引 Markers (大浪 + 嵌套小浪)
   */
  function applyMarkers(cand) {
    if (!candleSeries) return;
    if (!showMarkers || !cand || !cand.pivots) {
      setChartMarkers(candleSeries, []);
      return;
    }

    const markers = [];
    const colors = getWaveChartColors();

    // 宏观主浪标记
    cand.pivots.forEach((p, idx) => {
      const isHigh = p.type === 'high';
      const label = cand.waveLabels ? cand.waveLabels[idx] : `${idx}`;
      markers.push({
        time: p.time,
        position: isHigh ? 'aboveBar' : 'belowBar',
        color: isHigh ? colors.zigzagColor : colors.upColor,
        shape: isHigh ? 'arrowDown' : 'arrowUp',
        text: `浪 ${label} ($${p.price.toLocaleString()})`,
        size: 1.3
      });
    });

    // 嵌套微观子浪标记 (如果开启)
    if (showSubwaves && cand.subPivots && Array.isArray(cand.subPivots)) {
      cand.subPivots.forEach(sp => {
        markers.push({
          time: sp.time,
          position: sp.label === 'b' || sp.label === 'ii' || sp.label === 'iv' ? 'belowBar' : 'aboveBar',
          color: colors.subwaveColor,
          shape: 'circle',
          text: `${sp.label}`,
          size: 0.8
        });
      });
    }

    // 按时间排序
    markers.sort((a, b) => a.time - b.time);
    setChartMarkers(candleSeries, markers);
  }

  /**
   * 应用关键监测点与目标水平虚线
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

    if (showMonitoring && pivot && pivot.price) {
      const pLine = candleSeries.createPriceLine({
        price: pivot.price,
        color: colors.monitoringColor,
        lineWidth: 2,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true,
        title: `【核心监测点】$${pivot.price.toLocaleString()}`
      });
      activePriceLines.push(pLine);
    }

    if (showTargets && cand.targets && Array.isArray(cand.targets)) {
      cand.targets.forEach(tgt => {
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
    if (badge) badge.textContent = `${cands.length} 个候选方案`;

    if (cands.length === 0) {
      container.innerHTML = '<div class="text-secondary" style="font-size:0.72rem;">当前选区暂无合规标准浪型，请查看下方阻碍诊断。</div>';
      return;
    }

    container.innerHTML = cands.map((c, i) => `
      <div class="candidate-card ${i === activeCandidateIndex ? 'active' : ''}" data-idx="${i}">
        <div class="candidate-card-header">
          <span>${c.name}</span>
          <span class="candidate-score-badge">${c.score} 分</span>
        </div>
        <div class="candidate-sub-desc">${c.category} · ${c.currentWave}</div>
        <div class="candidate-pivot-line">监测点: $${c.monitoringPivot?.price?.toLocaleString() || '--'} (${c.monitoringPivot?.levelName || '生命线'})</div>
      </div>
    `).join('');

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
    if (cand.rules) {
      if (r1) r1.className = cand.rules.rule1_wave2_retrace !== false ? 'rule-dot-pass' : 'rule-dot-fail';
      if (r2) r2.className = cand.rules.rule2_wave3_not_shortest !== false ? 'rule-dot-pass' : 'rule-dot-fail';
      if (r3) r3.className = cand.rules.rule3_wave4_no_overlap !== false ? 'rule-dot-pass' : 'rule-dot-fail';
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
      if (elBottomSignal) elBottomSignal.textContent = analysis.commentary.bottomTopSignal;
      if (elQuote) elQuote.textContent = analysis.commentary.quote;
    }
  }

  /**
   * 初始化事件监听器 (标的切换、图表工具开关、框选交互)
   */
  function initEvents() {
    // 标的切换 (BTC / ETH)
    const symbolBtns = document.querySelectorAll('.wave-symbol-btn');
    symbolBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const sym = btn.dataset.symbol;
        if (sym && sym !== currentSymbol) {
          symbolBtns.forEach(b => b.classList.toggle('active', b === btn));
          cancelRangeSelection();
          currentRange = null;
          updateRangeBanner(null, null);
          runWaveAnalysis(sym, null);
        }
      });
    });

    // 重新扫描按钮
    const btnScan = document.getElementById('btn-scan-waves');
    if (btnScan) {
      btnScan.addEventListener('click', () => {
        cancelRangeSelection();
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
            statusMsg.textContent = '🖱️ 选区模式：请在 4H 图表上单击设定【分析起点】（支持最大 750 根 K 线，Esc 取消）';
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

    // 重置全量分析按钮
    const btnResetRange = document.getElementById('btn-reset-range');
    if (btnResetRange) {
      btnResetRange.addEventListener('click', () => {
        cancelRangeSelection();
        currentRange = null;
        updateRangeBanner(null, null);
        runWaveAnalysis(currentSymbol, null);
      });
    }

    const btnCancelRange = document.getElementById('btn-cancel-range');
    if (btnCancelRange) {
      btnCancelRange.addEventListener('click', () => {
        cancelRangeSelection();
        currentRange = null;
        updateRangeBanner(null, null);
        runWaveAnalysis(currentSymbol, null);
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
        runWaveAnalysis(currentSymbol, currentRange);
      }
    },
    runAnalysis: runWaveAnalysis,
    updateTheme: updateTheme,
    onViewActivated: function () {
      if (!waveChart) {
        initChart();
      }
      if (currentBars.length === 0) {
        runWaveAnalysis(currentSymbol, currentRange);
      } else {
        const container = document.getElementById('wave-chart-container');
        if (container && waveChart) {
          waveChart.applyOptions({ width: container.clientWidth });
        }
      }
    }
  };

})();
