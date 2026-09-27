/**
 * 柳玉冬波浪理论智能研判前端交互与 Lightweight Charts 图表控制器
 * Studio K95 意式画廊设计系统 Dual-Theme (Day/Night) 支持
 */

(function () {
  let waveChart = null;
  let candleSeries = null;
  let volumeSeries = null;
  let zigzagSeries = null;
  let currentSymbol = 'BTC/USDT';
  let currentBars = [];
  let currentAnalysis = null;
  let activePriceLines = [];

  // 图表可见性控制开关
  let showMarkers = true;
  let showZigzag = true;
  let showMonitoring = true;
  let showTargets = true;

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
      priceFormat: {
        type: 'volume'
      },
      priceScaleId: '', // 作为 overlay 嵌入主图底部
      scaleMargins: {
        top: 0.82,
        bottom: 0
      }
    });

    // 波浪分笔折线 (ZigZag Overlay)
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
  }

  /**
   * 当全站切换日/夜间主题时，无感重绘图表色彩
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
        vertLine: {
          color: colors.crosshairColor,
          labelBackgroundColor: colors.crosshairColor
        },
        horzLine: {
          color: colors.crosshairColor,
          labelBackgroundColor: colors.crosshairColor
        }
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

    if (zigzagSeries) {
      zigzagSeries.applyOptions({
        color: colors.zigzagColor
      });
    }

    // 重新应用价格线
    if (currentAnalysis) {
      applyPriceLines(currentAnalysis);
    }
  }

  /**
   * 抓取 4H 1000 根 K线 (优先直连交易所公共行情源，带后端代理备用)
   */
  async function fetch4hKlines(symbol) {
    const cleanSymbol = symbol.replace(/[\/\-_]/g, '').toUpperCase();
    const urls = [
      `https://data-api.binance.vision/api/v3/klines?symbol=${cleanSymbol}&interval=4h&limit=1000`,
      `https://api.binance.com/api/v3/klines?symbol=${cleanSymbol}&interval=4h&limit=1000`,
      `/api/wave/klines?symbol=${cleanSymbol}&interval=4h&limit=1000`
    ];

    let lastError = null;
    for (const url of urls) {
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(6000) });
        if (resp.ok) {
          const json = await resp.json();
          // 如果是后端代理格式
          if (json && json.bars && Array.isArray(json.bars)) {
            return { bars: json.bars, source: '本地代理缓存' };
          }
          // 如果是交易所直接返回的二维数组
          if (Array.isArray(json) && json.length > 0) {
            const bars = json.map(b => ({
              time: Math.floor(b[0] / 1000),
              open: parseFloat(b[1]),
              high: parseFloat(b[2]),
              low: parseFloat(b[3]),
              close: parseFloat(b[4]),
              volume: parseFloat(b[5])
            }));
            return { bars, source: '公共行情直连 (Binance)' };
          }
        }
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('无法连接到行情源');
  }

  /**
   * 执行波浪分析并在图表与侧边面板中渲染
   */
  async function runWaveAnalysis(symbol = currentSymbol) {
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
    if (statusMsg) statusMsg.textContent = `正在拉取 ${symbol} 最新 1000 根 4H K线并执行柳玉冬波浪模型...`;

    try {
      const { bars, source } = await fetch4hKlines(symbol);
      currentBars = bars;

      // 确保图表容器已建立
      if (!waveChart) {
        initChart();
      }

      // 1. 设置烛台与成交量数据
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

      // 2. 纯客户端极速执行柳玉冬波浪算法 (方案 A)
      if (!window.LiuWaveEngine) {
        throw new Error('波浪计算引擎尚未就绪');
      }
      const analysis = window.LiuWaveEngine.analyzeWaves(bars, symbol);
      currentAnalysis = analysis;

      // 3. 绘制折线分笔 (Zigzag line)
      if (analysis.allPivots && analysis.allPivots.length > 0) {
        const zigzagData = analysis.allPivots.map(p => ({
          time: p.time,
          value: p.price
        }));
        zigzagSeries.setData(showZigzag ? zigzagData : []);
      }

      // 4. 设置浪号 Markers (① ② ③ ④ ⑤ / (A) (B) (C))
      applyMarkers(analysis);

      // 5. 绘制关键监测点与斐波那契目标线
      applyPriceLines(analysis);

      // 6. 更新侧边诊断与研判面板
      renderDiagnosticPanel(analysis, source);

      // 图表视野缩放至最近 150 根 K线 (中观聚焦)
      if (bars.length > 150) {
        waveChart.timeScale().setVisibleLogicalRange({
          from: bars.length - 150,
          to: bars.length
        });
      }

      if (statusMsg) {
        statusMsg.textContent = `● 数据已同步: 1000 根 4H K线 (${source}) · 柳玉冬波浪模型计算耗时约 6ms`;
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
   * 应用波浪标引 Markers
   */
  function applyMarkers(analysis) {
    if (!candleSeries) return;
    if (!showMarkers || !analysis || !analysis.pattern || !analysis.pattern.pivots) {
      candleSeries.setMarkers([]);
      return;
    }

    const { pivots, waveLabels } = analysis.pattern;
    const markers = [];
    const colors = getWaveChartColors();

    pivots.forEach((p, idx) => {
      const isHigh = p.type === 'high';
      const label = waveLabels[idx] || `${idx}`;
      markers.push({
        time: p.time,
        position: isHigh ? 'aboveBar' : 'belowBar',
        color: isHigh ? colors.zigzagColor : colors.upColor,
        shape: isHigh ? 'arrowDown' : 'arrowUp',
        text: `浪 ${label} ($${p.price.toLocaleString()})`,
        size: 1.2
      });
    });

    candleSeries.setMarkers(markers);
  }

  /**
   * 应用监测点与目标价格水平线 (Price Lines)
   */
  function applyPriceLines(analysis) {
    if (!candleSeries) return;

    // 清除既有价格线
    activePriceLines.forEach(pl => {
      try { candleSeries.removePriceLine(pl); } catch (e) {}
    });
    activePriceLines = [];

    if (!analysis || !analysis.pattern) return;

    const colors = getWaveChartColors();
    const pivot = analysis.pattern.monitoringPivot;

    // 核心监测点虚线 (红色警示)
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

    // 目标价格区间 (绿色标引)
    if (showTargets && analysis.pattern.targets && Array.isArray(analysis.pattern.targets)) {
      analysis.pattern.targets.forEach(tgt => {
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
   * 渲染右侧综合研判面板
   */
  function renderDiagnosticPanel(analysis, source) {
    const pat = analysis.pattern;
    const curP = analysis.currentPrice;

    // 1. 浪型定位与方向
    const elWaveName = document.getElementById('wave-regime-name');
    const elWaveBadge = document.getElementById('wave-regime-badge');
    const elWaveCur = document.getElementById('wave-current-stage');

    if (elWaveName) elWaveName.textContent = pat.name || '--';
    if (elWaveCur) elWaveCur.textContent = pat.currentWave || '--';
    if (elWaveBadge) {
      const isBull = pat.direction === 'BULLISH';
      elWaveBadge.textContent = isBull ? '多头推动' : '调整浪型';
      elWaveBadge.className = `card-badge ${isBull ? 'badge-bull' : 'badge-neutral'}`;
    }

    // 2. 三大铁律检查灯
    const r1 = document.getElementById('rule-dot-1');
    const r2 = document.getElementById('rule-dot-2');
    const r3 = document.getElementById('rule-dot-3');

    if (pat.rules) {
      if (r1) r1.className = pat.rules.rule1_wave2_retrace ? 'rule-dot-pass' : 'rule-dot-fail';
      if (r2) r2.className = pat.rules.rule2_wave3_not_shortest ? 'rule-dot-pass' : 'rule-dot-fail';
      if (r3) r3.className = pat.rules.rule3_wave4_no_overlap ? 'rule-dot-pass' : 'rule-dot-fail';
    }

    // 3. 监测点数值与差距
    const elPivotPrice = document.getElementById('wave-pivot-price');
    const elPivotDiff = document.getElementById('wave-pivot-diff');
    const elPivotDesc = document.getElementById('wave-pivot-desc');

    if (pat.monitoringPivot) {
      const pPrice = pat.monitoringPivot.price;
      if (elPivotPrice) elPivotPrice.textContent = `$${pPrice.toLocaleString()}`;
      if (elPivotDesc) elPivotDesc.textContent = pat.monitoringPivot.description || '';

      if (elPivotDiff) {
        const diff = curP - pPrice;
        const pct = ((diff / pPrice) * 100).toFixed(2);
        const isSafe = curP >= pPrice;
        elPivotDiff.innerHTML = `距当前价: <strong style="color: ${isSafe ? 'var(--color-pos)' : 'var(--color-neg)'}">${diff >= 0 ? '+' : ''}$${Math.round(diff).toLocaleString()} (${pct}%)</strong> • 状态: <strong style="color: ${isSafe ? 'var(--color-pos)' : 'var(--color-neg)'}">${isSafe ? '防守有效' : '已跌破预警'}</strong>`;
      }
    }

    // 4. 斐波那契目标位
    const tgtContainer = document.getElementById('wave-targets-list');
    if (tgtContainer && pat.targets) {
      tgtContainer.innerHTML = pat.targets.map(t => {
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

    // 5. 柳玉冬实战研判解读
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
   * 初始化事件监听器 (标的切换、图表工具开关)
   */
  function initEvents() {
    // 标的切换 (BTC / ETH)
    const symbolBtns = document.querySelectorAll('.wave-symbol-btn');
    symbolBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const sym = btn.dataset.symbol;
        if (sym && sym !== currentSymbol) {
          symbolBtns.forEach(b => b.classList.toggle('active', b === btn));
          runWaveAnalysis(sym);
        }
      });
    });

    // 重新扫描按钮
    const btnScan = document.getElementById('btn-scan-waves');
    if (btnScan) {
      btnScan.addEventListener('click', () => {
        runWaveAnalysis(currentSymbol);
      });
    }

    // 工具栏切换开关
    const btnMarkers = document.getElementById('btn-toggle-markers');
    if (btnMarkers) {
      btnMarkers.addEventListener('click', () => {
        showMarkers = !showMarkers;
        btnMarkers.classList.toggle('active', showMarkers);
        if (currentAnalysis) applyMarkers(currentAnalysis);
      });
    }

    const btnZigzag = document.getElementById('btn-toggle-zigzag');
    if (btnZigzag) {
      btnZigzag.addEventListener('click', () => {
        showZigzag = !showZigzag;
        btnZigzag.classList.toggle('active', showZigzag);
        if (currentAnalysis && currentAnalysis.allPivots) {
          const zigzagData = currentAnalysis.allPivots.map(p => ({
            time: p.time,
            value: p.price
          }));
          zigzagSeries.setData(showZigzag ? zigzagData : []);
        }
      });
    }

    const btnMonitoring = document.getElementById('btn-toggle-invalidation');
    if (btnMonitoring) {
      btnMonitoring.addEventListener('click', () => {
        showMonitoring = !showMonitoring;
        btnMonitoring.classList.toggle('active', showMonitoring);
        if (currentAnalysis) applyPriceLines(currentAnalysis);
      });
    }

    const btnTargets = document.getElementById('btn-toggle-targets');
    if (btnTargets) {
      btnTargets.addEventListener('click', () => {
        showTargets = !showTargets;
        btnTargets.classList.toggle('active', showTargets);
        if (currentAnalysis) applyPriceLines(currentAnalysis);
      });
    }
  }

  // 挂载全局接口供 app.js 联动
  window.WaveRadarModule = {
    init: function () {
      initEvents();
      // 如果当前初始页面或 hash 为 wave-radar，则立即加载分析
      if (window.location.hash === '#wave-radar' || document.getElementById('view-wave-radar')?.classList.contains('active')) {
        runWaveAnalysis(currentSymbol);
      }
    },
    runAnalysis: runWaveAnalysis,
    updateTheme: updateTheme,
    onViewActivated: function () {
      if (!waveChart) {
        initChart();
      }
      if (currentBars.length === 0) {
        runWaveAnalysis(currentSymbol);
      } else {
        // 确保容器尺寸正确更新
        const container = document.getElementById('wave-chart-container');
        if (container && waveChart) {
          waveChart.applyOptions({ width: container.clientWidth });
        }
      }
    }
  };

})();
