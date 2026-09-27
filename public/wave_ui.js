/**
 * 柳玉冬波浪理论智能研判前端交互与 Lightweight Charts 图表控制器
 * 支持鼠标任意拖拽选区瞬时分析、大级别嵌套小级别子浪渲染、艾略特通道模块拟合、
 * 并列候选浪型切换、出身穿透校验、阻碍诊断与多重情景推演
 * Studio K95 意式画廊设计系统 Dual-Theme (Day/Night) 支持
 */

(function () {
  let waveChart = null;
  let candleSeries = null;
  let volumeSeries = null;
  let zigzagSeries = null;
  let subwaveSeries = null;
  let channelUpperSeries = null;
  let channelLowerSeries = null;

  let currentSymbol = 'BTC/USDT';
  let currentBars = [];
  let currentAnalysis = null;
  let activeCandidateIndex = 0;
  let activePriceLines = [];
  let currentRange = null; // { startTime, endTime }

  // 图表可见性控制开关
  let showMarkers = true;
  let showZigzag = true;
  let showSubwaves = true;
  let showChannel = true;
  let showMonitoring = true;
  let showTargets = true;
  let isDragSelectMode = false;

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

  /**
   * 初始化 Lightweight Charts 实例
   */
  function initChart() {
    const container = document.getElementById('wave-chart-container');
    if (!container || !window.LightweightCharts) return;

    // 清空历史容器
    container.innerHTML = `
      <div class="wave-hud-legend" id="wave-hud-legend">
        <div class="wave-hud-item"><span>标的:</span> <strong id="hud-sym">BTC/USDT 4H</strong></div>
        <div class="wave-hud-item"><span>开:</span> <strong id="hud-o">--</strong></div>
        <div class="wave-hud-item"><span>高:</span> <strong id="hud-h">--</strong></div>
        <div class="wave-hud-item"><span>低:</span> <strong id="hud-l">--</strong></div>
        <div class="wave-hud-item"><span>收:</span> <strong id="hud-c">--</strong></div>
        <div class="wave-hud-item"><span>量:</span> <strong id="hud-v">--</strong></div>
      </div>
      <div id="chart-selection-box" style="display:none; position:absolute; top:0; bottom:0; background:rgba(234, 88, 12, 0.16); border-left:2px dashed #ea580c; border-right:2px dashed #ea580c; pointer-events:none; z-index:15;"></div>
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
          bottom: 0.22
        }
      },
      timeScale: {
        borderColor: colors.borderColor,
        timeVisible: true,
        secondsVisible: false
      }
    });

    // 烛台主图
    const candles = chart.addCandlestickSeries({
      upColor: colors.upColor,
      downColor: colors.downColor,
      borderUpColor: colors.upColor,
      borderDownColor: colors.downColor,
      wickUpColor: colors.upColor,
      wickDownColor: colors.downColor
    });

    // 成交量副图 (位于底部)
    const volume = chart.addHistogramSeries({
      color: colors.volUpColor,
      priceFormat: { type: 'volume' },
      priceScaleId: '', // overlay
      scaleMargins: { top: 0.82, bottom: 0 }
    });

    // 艾略特通道模块轨线 (上轨与下轨)
    const channelUpper = chart.addLineSeries({
      color: colors.channelColor,
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Solid,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false
    });

    const channelLower = chart.addLineSeries({
      color: colors.channelColor,
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Solid,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false
    });

    // 次级嵌套子浪折线 (细虚线，天蓝色)
    const subwave = chart.addLineSeries({
      color: colors.subwaveColor,
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: true
    });

    // 大级别宏观波浪分笔折线 (主折线，亮橙色)
    const zigzag = chart.addLineSeries({
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
      const hudV = document.getElementById('hud-v');

      if (!param || !param.time || !param.seriesData) {
        if (currentBars.length > 0) {
          const last = currentBars[currentBars.length - 1];
          if (hudO) hudO.textContent = last.open.toLocaleString();
          if (hudH) hudH.textContent = last.high.toLocaleString();
          if (hudL) hudL.textContent = last.low.toLocaleString();
          if (hudC) hudC.textContent = last.close.toLocaleString();
          if (hudV) hudV.textContent = last.volume ? Math.round(last.volume).toLocaleString() : '--';
        }
        return;
      }

      const cData = param.seriesData.get(candles);
      const vData = param.seriesData.get(volume);
      if (cData) {
        if (hudO) hudO.textContent = cData.open?.toLocaleString() || '--';
        if (hudH) hudH.textContent = cData.high?.toLocaleString() || '--';
        if (hudL) hudL.textContent = cData.low?.toLocaleString() || '--';
        if (hudC) hudC.textContent = cData.close?.toLocaleString() || '--';
      }
      if (vData && hudV) {
        hudV.textContent = Math.round(vData.value || 0).toLocaleString();
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
    volumeSeries = volume;
    zigzagSeries = zigzag;
    subwaveSeries = subwave;
    channelUpperSeries = channelUpper;
    channelLowerSeries = channelLower;

    // 安装交互式拖拽选区监听器
    setupDragSelection(container);
  }

  /**
   * 鼠标拖拽框选任意 K 线区域交互监听
   */
  function setupDragSelection(container) {
    let isDragging = false;
    let startX = 0;
    const box = document.getElementById('chart-selection-box');

    container.addEventListener('mousedown', e => {
      // 当处于框选模式或者按住 Shift 键时触发框选
      if (!isDragSelectMode && !e.shiftKey) return;
      if (e.button !== 0) return; // 仅左键

      const rect = container.getBoundingClientRect();
      startX = e.clientX - rect.left;
      isDragging = true;
      if (box) {
        box.style.left = `${startX}px`;
        box.style.width = '0px';
        box.style.display = 'block';
      }
      e.preventDefault();
    });

    window.addEventListener('mousemove', e => {
      if (!isDragging || !box) return;
      const rect = container.getBoundingClientRect();
      const currentX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const left = Math.min(startX, currentX);
      const width = Math.abs(currentX - startX);
      box.style.left = `${left}px`;
      box.style.width = `${width}px`;
    });

    window.addEventListener('mouseup', e => {
      if (!isDragging) return;
      isDragging = false;
      if (!box) return;

      const rect = container.getBoundingClientRect();
      const endX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const width = Math.abs(endX - startX);
      box.style.display = 'none';

      // 选区有效宽度阈值 (至少拖动超过 20 像素)
      if (width >= 20 && waveChart) {
        const leftX = Math.min(startX, endX);
        const rightX = Math.max(startX, endX);

        let time1 = waveChart.timeScale().coordinateToTime(leftX);
        let time2 = waveChart.timeScale().coordinateToTime(rightX);

        if (!time1 && currentBars && currentBars.length > 0) time1 = currentBars[0].time;
        if (!time2 && currentBars && currentBars.length > 0) time2 = currentBars[currentBars.length - 1].time;

        if (time1 && time2) {
          const startTime = Math.min(time1, time2);
          const endTime = Math.max(time1, time2);
          currentRange = { startTime, endTime };
          updateRangeBanner(startTime, endTime);
          runWaveAnalysis(currentSymbol, currentRange);
        }
      }
    });
  }

  function updateRangeBanner(startTime, endTime) {
    const banner = document.getElementById('wave-range-banner');
    const rangeText = document.getElementById('wave-range-text');
    if (!banner || !rangeText) return;

    if (startTime && endTime) {
      const d1 = new Date(startTime * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      const d2 = new Date(endTime * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      rangeText.textContent = `${d1} 至 ${d2}`;
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

      // 1. 设置主图蜡烛与量能
      const candleData = bars.map(b => ({
        time: b.time,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close
      }));
      candleSeries.setData(candleData);

      const colors = getWaveChartColors();
      const volData = bars.map(b => ({
        time: b.time,
        value: b.volume,
        color: b.close >= b.open ? colors.volUpColor : colors.volDownColor
      }));
      volumeSeries.setData(volData);

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
      candleSeries.setMarkers([]);
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
    candleSeries.setMarkers(markers);
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
        runWaveAnalysis(currentSymbol, currentRange);
      });
    }

    // 框选分析模式开关
    const btnDrag = document.getElementById('btn-drag-range');
    const container = document.getElementById('wave-chart-container');
    if (btnDrag) {
      btnDrag.addEventListener('click', () => {
        isDragSelectMode = !isDragSelectMode;
        btnDrag.classList.toggle('active', isDragSelectMode);
        if (container) {
          container.style.cursor = isDragSelectMode ? 'crosshair' : 'default';
        }
      });
    }

    // 重置全量分析按钮
    const btnResetRange = document.getElementById('btn-reset-range');
    if (btnResetRange) {
      btnResetRange.addEventListener('click', () => {
        currentRange = null;
        updateRangeBanner(null, null);
        runWaveAnalysis(currentSymbol, null);
      });
    }

    const btnCancelRange = document.getElementById('btn-cancel-range');
    if (btnCancelRange) {
      btnCancelRange.addEventListener('click', () => {
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
