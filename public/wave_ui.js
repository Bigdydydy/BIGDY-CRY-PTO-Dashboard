/**
 * Module 8 · 柳玉冬波浪理论 · 多级别画浪评估
 * 用户在 K 线图上画母浪与子浪 (可切换周期在低周期画子浪)，「评估全部」时由引擎整体评估：
 * 每个浪的手稿铁律 / 低周期子浪证伪 / 画完后的走势检验，以及母子级别之间的一致性。
 * 计算在浏览器 Web Worker 中完成，服务端只提供带缓存的 K 线 (Render 免费实例只有 0.1 CPU)。
 */

(function () {
  let waveChart = null;
  let candleSeries = null;
  let chartMarkersPrimitive = null;
  let subSeries = null;     // 所选浪在低周期探测到的子浪 (细点线)
  let activeSeries = null;  // 正在画的浪
  const sketchSeries = new Map(); // 已画的浪 id → 折线

  let currentSymbol = 'BTC/USDT';
  let currentTf = '4h';
  let currentBars = [];
  let initialLoadPromise = null;
  let mainKlineSource = null; // 服务端返回的主图行情源 (币安被拒时为 Bybit / OKX)

  let showMarkers = true;
  let showSubwaves = false;
  let showMonitoring = true;
  let showTargets = true;

  // 画浪状态
  let drawTool = null;   // 正在画的工具
  let drawPoints = [];   // 正在画的点 [{ index, time, rawPrice, type, price }]
  let drawHover = null;
  let sketch = [];       // 已画的浪 [{ id, tool, timeframe, points: [{ time, price, type }] }]
  let sketchSeq = 0;
  let sketchEval = null; // evaluateUserSketch 结果
  let selectedId = null; // 面板与价位线展示的浪
  let evalToken = 0;
  let userPriceLines = [];

  const TF_SEC = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14400 };
  const TF_NAME = { '15m': '15m (15分钟)', '1h': '1H (1小时)', '4h': '4H (4小时)' };
  // 画浪评估的子浪判定周期 (由细到粗，与服务端 WAVE_USER_SUB_INTERVALS 一致)
  const SKETCH_SUB_TFS = { '15m': ['5m'], '1h': ['15m', '5m'], '4h': ['15m', '1h'] };
  const WAVE_BARS = 10000;

  const DRAW_TOOLS = {
    IMPULSE: { name: '推动浪 12345', labels: ['0', '1', '2', '3', '4', '5'], marks: ['⓪', '①', '②', '③', '④', '⑤'], minor: ['', 'i', 'ii', 'iii', 'iv', 'v'] },
    ABC: { name: '调整浪 abc', labels: ['0', 'a', 'b', 'c'], marks: ['⓪', 'Ⓐ', 'Ⓑ', 'Ⓒ'], minor: ['', '(a)', '(b)', '(c)'] },
    WXY: { name: '调整浪 wxy', labels: ['0', 'w', 'x', 'y'], marks: ['⓪', 'Ⓦ', 'Ⓧ', 'Ⓨ'], minor: ['', '(w)', '(x)', '(y)'] },
    WXYXZ: { name: '调整浪 wxyxz', labels: ['0', 'w', 'x', 'y', 'x', 'z'], marks: ['⓪', 'Ⓦ', 'Ⓧ', 'Ⓨ', 'Ⓧ', 'Ⓩ'], minor: ['', '(w)', '(x)', '(y)', '(x)', '(z)'] },
    ABCDE: { name: '三角形 abcde', labels: ['0', 'a', 'b', 'c', 'd', 'e'], marks: ['⓪', 'Ⓐ', 'Ⓑ', 'Ⓒ', 'Ⓓ', 'Ⓔ'], minor: ['', '(a)', '(b)', '(c)', '(d)', '(e)'] }
  };
  const VERDICT_STYLE = {
    VALID: { badge: 'badge-bull', chip: 'pos', color: '#10b981' },
    DOUBT: { badge: 'badge-range', chip: 'warn', color: '#f59e0b' },
    FALSIFIED_PRICE: { badge: 'badge-bear', chip: 'neg', color: '#ef4444' },
    FALSIFIED_SUB: { badge: 'badge-bear', chip: 'neg', color: '#ef4444' },
    INVALID: { badge: 'badge-bear', chip: 'neg', color: '#ef4444' },
    ERROR: { badge: 'badge-bear', chip: 'neg', color: '#94a3b8' }
  };
  const LEG_STATUS = {
    PASS: { txt: '符合', cls: 'pos' }, FAIL: { txt: '证伪', cls: 'neg' }, DOUBT: { txt: '存疑', cls: 'warn' },
    RUNNING: { txt: '运行中', cls: 'info' }, UNKNOWN: { txt: '数据不足', cls: '' }
  };
  // 级别越低线越细：母浪 3px 实线，子浪 2px 虚线，再下一级 1px 点线 (评估后颜色表示判决，线型区分级别)
  const DEPTH_STYLE = [
    { width: 3, color: '#a855f7', style: 'Solid' },
    { width: 2, color: '#0ea5e9', style: 'Dashed' },
    { width: 1, color: '#14b8a6', style: 'Dotted' }
  ];

  // ---------------------------------------------------------------------------
  // 图表
  // ---------------------------------------------------------------------------
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
      subwaveColor: isLight ? '#0284c7' : '#38bdf8',
      targetColor: isLight ? '#059669' : '#10b981'
    };
  }

  /** 兼容 LightweightCharts v4 (chart.addXxxSeries) 与 v5 (chart.addSeries(XxxSeries)) */
  function safeCreateSeries(chart, typeName, options) {
    if (!chart || !window.LightweightCharts) return null;
    if (typeName === 'Candlestick' && typeof chart.addCandlestickSeries === 'function') return chart.addCandlestickSeries(options);
    if (typeName === 'Line' && typeof chart.addLineSeries === 'function') return chart.addLineSeries(options);
    const SeriesConstructor = window.LightweightCharts[`${typeName}Series`];
    if (SeriesConstructor && typeof chart.addSeries === 'function') return chart.addSeries(SeriesConstructor, options);
    console.warn(`[Wave UI] Unable to add series type ${typeName}`);
    return null;
  }

  /** 兼容 LightweightCharts v4 (series.setMarkers) 与 v5 (createSeriesMarkers) */
  function setChartMarkers(series, markers) {
    if (!series) return;
    const m = markers || [];
    if (typeof series.setMarkers === 'function') { series.setMarkers(m); return; }
    if (window.LightweightCharts && typeof window.LightweightCharts.createSeriesMarkers === 'function') {
      if (!chartMarkersPrimitive) chartMarkersPrimitive = window.LightweightCharts.createSeriesMarkers(series, m);
      else chartMarkersPrimitive.setMarkers(m);
    }
  }

  function lineOpts(color, width, style) {
    return {
      color, lineWidth: width, lineStyle: style !== undefined ? style : LightweightCharts.LineStyle.Solid,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false
    };
  }

  function initChart() {
    const container = document.getElementById('wave-chart-container');
    if (!container || !window.LightweightCharts) return;
    chartMarkersPrimitive = null;
    sketchSeries.clear();
    container.innerHTML = `
      <div class="wave-hud-legend" id="wave-hud-legend">
        <div class="wave-hud-item"><span>标的:</span> <strong id="hud-sym">BTC/USDT 4H</strong></div>
        <div class="wave-hud-item"><span>开:</span> <strong id="hud-o">--</strong></div>
        <div class="wave-hud-item"><span>高:</span> <strong id="hud-h">--</strong></div>
        <div class="wave-hud-item"><span>低:</span> <strong id="hud-l">--</strong></div>
        <div class="wave-hud-item"><span>收:</span> <strong id="hud-c">--</strong></div>
      </div>`;

    const colors = getWaveChartColors();
    const chart = LightweightCharts.createChart(container, {
      width: container.clientWidth || 800,
      height: 560,
      layout: { background: { type: 'solid', color: colors.background }, textColor: colors.textColor, fontFamily: "'JetBrains Mono', Consolas, monospace", fontSize: 11 },
      grid: { vertLines: { color: colors.gridColor }, horzLines: { color: colors.gridColor } },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: { color: colors.crosshairColor, width: 1, style: LightweightCharts.LineStyle.Dashed, labelBackgroundColor: colors.crosshairColor },
        horzLine: { color: colors.crosshairColor, width: 1, style: LightweightCharts.LineStyle.Dashed, labelBackgroundColor: colors.crosshairColor }
      },
      rightPriceScale: { borderColor: colors.borderColor, scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderColor: colors.borderColor, timeVisible: true, secondsVisible: false }
    });

    const candles = safeCreateSeries(chart, 'Candlestick', {
      upColor: colors.upColor, downColor: colors.downColor, borderUpColor: colors.upColor, borderDownColor: colors.downColor,
      wickUpColor: colors.upColor, wickDownColor: colors.downColor
    });
    subSeries = safeCreateSeries(chart, 'Line', lineOpts(colors.subwaveColor, 1, LightweightCharts.LineStyle.Dotted));
    activeSeries = safeCreateSeries(chart, 'Line', lineOpts('#a855f7', 2, LightweightCharts.LineStyle.Dashed));

    chart.subscribeCrosshairMove(param => {
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
      let bar = null;
      if (param && param.time && param.seriesData) bar = param.seriesData.get(candles);
      if (!bar && currentBars.length) bar = currentBars[currentBars.length - 1];
      if (!bar) return;
      set('hud-o', bar.open?.toLocaleString() || '--');
      set('hud-h', bar.high?.toLocaleString() || '--');
      set('hud-l', bar.low?.toLocaleString() || '--');
      set('hud-c', bar.close?.toLocaleString() || '--');
    });

    const resizeObserver = new ResizeObserver(entries => {
      if (!entries || !entries.length) return;
      const { width } = entries[0].contentRect;
      if (width > 0) chart.applyOptions({ width });
    });
    resizeObserver.observe(container);

    waveChart = chart;
    candleSeries = candles;
    setupDrawing(container);
  }

  function updateTheme() {
    if (!waveChart) return;
    const colors = getWaveChartColors();
    waveChart.applyOptions({
      layout: { background: { type: 'solid', color: colors.background }, textColor: colors.textColor },
      grid: { vertLines: { color: colors.gridColor }, horzLines: { color: colors.gridColor } },
      crosshair: {
        vertLine: { color: colors.crosshairColor, labelBackgroundColor: colors.crosshairColor },
        horzLine: { color: colors.crosshairColor, labelBackgroundColor: colors.crosshairColor }
      },
      rightPriceScale: { borderColor: colors.borderColor },
      timeScale: { borderColor: colors.borderColor }
    });
    if (candleSeries) {
      candleSeries.applyOptions({
        upColor: colors.upColor, downColor: colors.downColor, borderUpColor: colors.upColor, borderDownColor: colors.downColor,
        wickUpColor: colors.upColor, wickDownColor: colors.downColor
      });
    }
    if (subSeries) subSeries.applyOptions({ color: colors.subwaveColor });
    renderChart();
  }

  function getBarByTime(time) {
    let lo = 0, hi = currentBars.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (currentBars[mid].time === time) return { bar: currentBars[mid], index: mid, time };
      if (currentBars[mid].time < time) lo = mid + 1; else hi = mid - 1;
    }
    return null;
  }

  function getBarFromCoordinate(x) {
    if (!waveChart || !currentBars.length) return null;
    const timeScale = waveChart.timeScale();
    const t = timeScale.coordinateToTime(x);
    if (t !== null && t !== undefined) {
      const exact = getBarByTime(t);
      if (exact) return exact;
      const i = barIdxAtOrBefore(t);
      return { bar: currentBars[i], index: i, time: currentBars[i].time };
    }
    const logical = timeScale.coordinateToLogical(x);
    if (logical !== null && logical !== undefined && !isNaN(logical)) {
      const idx = Math.max(0, Math.min(currentBars.length - 1, Math.round(logical)));
      return { bar: currentBars[idx], index: idx, time: currentBars[idx].time };
    }
    return null;
  }

  /** 时间 t 所在的当前周期K线 (开盘时间 ≤ t 的最后一根) */
  function barIdxAtOrBefore(t) {
    let lo = 0, hi = currentBars.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (currentBars[mid].time <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  /**
   * 浪的拐点 → 当前周期K线上的显示位置。
   * 在更高周期画的点 (例如 4H 母浪在 1H 图上显示) 落到该高周期K线内创出极值的那根当前周期K线。
   */
  function displayPoint(p, tf) {
    if (!currentBars.length) return null;
    const sec = TF_SEC[tf] || 0, cur = TF_SEC[currentTf] || 0;
    let i = barIdxAtOrBefore(p.time);
    if (sec > cur) {
      let best = i;
      for (let k = i; k < currentBars.length && currentBars[k].time < p.time + sec; k++) {
        if (p.type === 'high' ? currentBars[k].high > currentBars[best].high : currentBars[k].low < currentBars[best].low) best = k;
      }
      i = best;
    }
    if (currentBars[i].time > p.time + sec || p.time < currentBars[0].time) return null; // 不在已加载的K线范围内
    return { time: currentBars[i].time, value: p.price, type: p.type };
  }

  // ---------------------------------------------------------------------------
  // 行情与计算
  // ---------------------------------------------------------------------------
  function parseRawKlines(rows) {
    return rows.map(b => ({ time: Math.floor(b[0] / 1000), open: parseFloat(b[1]), high: parseFloat(b[2]), low: parseFloat(b[3]), close: parseFloat(b[4]), volume: parseFloat(b[5]) }));
  }

  /** 直连币安兜底: 按 endTime 向前分页 */
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
   * 服务端K线 (带缓存)。Render 免费实例休眠唤醒、首次分页拉取 10000 根都较慢：放宽超时并重试一次。
   * 国内网络一般直连不了币安，所以服务端是主路径，直连只作最后兜底。
   */
  async function fetchServerBars(clean, tf, limit, onRetry) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt && onRetry) onRetry();
      try {
        const resp = await fetch(`/api/wave/klines?symbol=${clean}&interval=${tf}&limit=${limit}`, { signal: AbortSignal.timeout(45000) });
        if (resp.ok) {
          const json = await resp.json();
          if (json && Array.isArray(json.bars) && json.bars.length) {
            if (tf === currentTf) mainKlineSource = json.source || null;
            return json.bars;
          }
          lastError = new Error('服务端未返回K线');
        } else {
          lastError = new Error(`服务端 HTTP ${resp.status}`);
          if (resp.status === 400) break; // 参数错误，重试无意义
        }
      } catch (err) { lastError = err; }
    }
    throw lastError || new Error('服务端未返回K线');
  }

  /** 主图K线 (最多 WAVE_BARS 根；服务端缓存优先，失败直连币安合约/现货) */
  async function fetchKlines(symbol, tf) {
    const clean = symbol.replace(/[\/\-_]/g, '').toUpperCase();
    let lastError = null;
    try {
      return await fetchServerBars(clean, tf, WAVE_BARS, () => setWaveStatus('服务端行情响应较慢（可能正在唤醒），重试中…'));
    } catch (err) { lastError = err; }
    const serverError = lastError;
    const direct = [
      ['https://fapi.binance.com/fapi/v1/klines', 1500],
      ['https://data-api.binance.vision/api/v3/klines', 1000],
      ['https://api.binance.com/api/v3/klines', 1000]
    ];
    for (const [base, pageMax] of direct) {
      try {
        const rows = await fetchDirectPaged(base, pageMax, clean, tf, WAVE_BARS);
        if (rows.length) return parseRawKlines(rows);
      } catch (err) { lastError = err; }
    }
    throw new Error(`服务端行情不可用（${(serverError && serverError.message) || '超时'}），浏览器直连币安也失败`);
  }

  const AUX_TTL_MS = 120000;
  const auxKlineCache = new Map();

  /** 其它周期K线 (服务端缓存优先，失败直连币安)，浏览器内缓存2分钟 */
  async function fetchAuxBars(symbol, tf, limit) {
    const clean = symbol.replace(/[\/\-_]/g, '').toUpperCase();
    const key = `${clean}_${tf}_${limit}`;
    const hit = auxKlineCache.get(key);
    if (hit && Date.now() - hit.t < AUX_TTL_MS) return hit.bars;
    let bars = null;
    try { bars = await fetchServerBars(clean, tf, limit); } catch (e) { /* 降级直连 */ }
    if (!bars) {
      try {
        const rows = await fetchDirectPaged('https://fapi.binance.com/fapi/v1/klines', 1500, clean, tf, limit);
        if (rows.length) bars = parseRawKlines(rows);
      } catch (e) { bars = null; }
    }
    if (bars) auxKlineCache.set(key, { t: Date.now(), bars });
    return bars;
  }

  let waveWorker = null; // null=未创建, false=不可用
  let waveWorkerSeq = 0;
  const waveWorkerPending = new Map();

  function getWaveWorker() {
    if (waveWorker === false) return null;
    if (waveWorker) return waveWorker;
    try {
      const src = `importScripts(${JSON.stringify(location.origin + '/wave_engine.js')});
self.onmessage = function (e) {
  var d = e.data;
  var fn = d.fn === 'evaluateUserSketch' || d.fn === 'evaluateUserCount' ? d.fn : 'analyzeWaves';
  try { self.postMessage({ id: d.id, ok: true, result: self.LiuWaveEngine[fn](d.bars, d.symbol, d.opts) }); }
  catch (err) { self.postMessage({ id: d.id, ok: false, error: String(err && err.message || err), input: true }); }
};`;
      const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
      const w = new Worker(url);
      w.onmessage = e => {
        const job = waveWorkerPending.get(e.data.id);
        if (!job) return;
        waveWorkerPending.delete(e.data.id);
        if (e.data.ok) job.resolve(e.data.result);
        else { const err = new Error(e.data.error); err.input = !!e.data.input; job.reject(err); }
      };
      w.onerror = () => {
        waveWorkerPending.forEach(job => job.reject(new Error('worker error')));
        waveWorkerPending.clear();
        try { w.terminate(); } catch (e) {}
        waveWorker = false;
      };
      waveWorker = w;
      return w;
    } catch (e) {
      waveWorker = false;
      return null;
    }
  }

  function runInWorker(fn, bars, symbol, opts) {
    const w = getWaveWorker();
    if (!w) return Promise.reject(new Error('worker unavailable'));
    const id = ++waveWorkerSeq;
    return new Promise((resolve, reject) => {
      waveWorkerPending.set(id, { resolve, reject });
      w.postMessage({ id, fn, bars, symbol, opts });
      setTimeout(() => {
        if (waveWorkerPending.has(id)) { waveWorkerPending.delete(id); reject(new Error('worker timeout')); }
      }, 90000);
    });
  }

  /** 浏览器端整体评估: Worker → 主线程；返回 null 表示本地引擎不可用 (交给服务端) */
  async function evaluateSketchClientSide(symbol, drawings) {
    if (!window.LiuWaveEngine || !window.LiuWaveEngine.evaluateUserSketch) return null;
    const firstTime = Math.min(...drawings.map(d => d.points[0].time));
    const tfs = new Set();
    drawings.forEach(d => { tfs.add(d.timeframe); (SKETCH_SUB_TFS[d.timeframe] || []).forEach(t => tfs.add(t)); });
    const nowSec = Math.floor(Date.now() / 1000);
    const list = Array.from(tfs);
    const fetched = await Promise.all(list.map(tf => {
      if (tf === currentTf && currentBars.length) return currentBars;
      // 须覆盖最早的画浪点之前约 300 根 (前序检验)，按 1000 / 10000 两档取整以复用缓存
      const need = Math.ceil((nowSec - firstTime) / TF_SEC[tf]) + 400;
      return fetchAuxBars(symbol, tf, need <= 1000 ? 1000 : WAVE_BARS);
    }));
    const barsByTf = {};
    list.forEach((tf, i) => { if (fetched[i] && fetched[i].length) barsByTf[tf] = fetched[i]; });
    const opts = { drawings };
    try {
      return await runInWorker('evaluateUserSketch', barsByTf, symbol, opts);
    } catch (e) {
      if (e.input) throw e; // 点位问题 (顺序/方向/点数)
      return window.LiuWaveEngine.evaluateUserSketch(barsByTf, symbol, opts);
    }
  }

  // ---------------------------------------------------------------------------
  // K线加载
  // ---------------------------------------------------------------------------
  function setWaveStatus(text) {
    const el = document.getElementById('wave-status-msg');
    if (el) el.textContent = text;
  }

  function updateSampleLabel(bars, tf) {
    const el = document.getElementById('wave-sample-label');
    if (!el || !bars || !bars.length) return;
    const days = Math.round((bars[bars.length - 1].time - bars[0].time) / 86400);
    const span = days >= 365 ? `约${(days / 365).toFixed(1)}年` : `约${days}天`;
    el.textContent = `${bars.length.toLocaleString()} 根 ${tf.toUpperCase()} K线 (${span})`;
  }

  async function loadChartCandles(symbol = currentSymbol) {
    currentSymbol = symbol;
    const tfLabel = currentTf.toUpperCase();
    const hudSym = document.getElementById('hud-sym');
    const title = document.getElementById('wave-chart-title');
    if (hudSym) hudSym.textContent = `${symbol} ${tfLabel}`;
    if (title) title.textContent = `${tfLabel} K 线图 · 画浪`;
    setWaveStatus(`正在拉取 ${symbol} ${tfLabel} K 线…`);
    try {
      mainKlineSource = null;
      const bars = await fetchKlines(symbol, currentTf);
      currentBars = bars;
      updateSampleLabel(bars, currentTf);
      if (!waveChart) initChart();
      candleSeries.setData(bars.map(b => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })));
      focusChart();
      renderChart();
      const srcNote = mainKlineSource && !/币安/.test(mainKlineSource) ? ` · 行情源：${mainKlineSource}（币安暂不可用）` : '';
      setWaveStatus((sketch.length
        ? `● [${symbol} ${tfLabel}] K线就绪 · 已画 ${sketch.length} 个浪（其它周期画的浪按本周期K线显示），可继续画子浪`
        : `● [${symbol} ${tfLabel}] K线就绪 (${bars.length} 根) · 选择上方画浪工具，在图上从起点开始依次点击各浪端点`) + srcNote);
    } catch (err) {
      console.error('[Wave Load Error]:', err);
      setWaveStatus(`❌ 行情加载失败: ${err.message || '网络连接超时'}`);
    }
  }

  /** 有画浪时聚焦到画浪区间，否则显示最近 150 根 */
  function focusChart() {
    if (!waveChart || !currentBars.length) return;
    const ts = waveChart.timeScale();
    if (sketch.length) {
      const t0 = Math.min(...sketch.map(d => d.points[0].time));
      const t1 = Math.max(...sketch.map(d => d.points[d.points.length - 1].time));
      const i0 = barIdxAtOrBefore(t0), i1 = barIdxAtOrBefore(t1);
      const pad = Math.max(10, Math.round((i1 - i0) * 0.15));
      ts.setVisibleLogicalRange({ from: Math.max(0, i0 - pad), to: Math.min(currentBars.length + 5, i1 + pad) });
    } else if (currentBars.length > 150) {
      ts.setVisibleLogicalRange({ from: currentBars.length - 150, to: currentBars.length });
    } else ts.fitContent();
  }

  // ---------------------------------------------------------------------------
  // 画浪交互
  // ---------------------------------------------------------------------------
  function chartRect() {
    const el = waveChart && typeof waveChart.chartElement === 'function' ? waveChart.chartElement() : document.getElementById('wave-chart-container');
    return el.getBoundingClientRect();
  }

  /** 首段方向由前两点的点击价格决定，之后高低交替；价格吸附到该K线的最高/最低价 */
  function resnapDrawPoints(points) {
    if (!points.length) return points;
    const p0 = points[0];
    let firstType;
    if (points.length >= 2) firstType = points[1].rawPrice >= p0.rawPrice ? 'low' : 'high';
    else {
      const b = currentBars[p0.index];
      firstType = Math.abs(p0.rawPrice - b.high) < Math.abs(p0.rawPrice - b.low) ? 'high' : 'low';
    }
    points.forEach((p, i) => {
      const type = i % 2 === 0 ? firstType : (firstType === 'high' ? 'low' : 'high');
      const b = currentBars[p.index];
      p.type = type;
      p.price = type === 'high' ? b.high : b.low;
    });
    return points;
  }

  function hitFromEvent(e) {
    const rect = chartRect();
    const hit = getBarFromCoordinate(e.clientX - rect.left);
    const price = candleSeries ? candleSeries.coordinateToPrice(e.clientY - rect.top) : null;
    if (!hit || price === null || price === undefined || !isFinite(price)) return null;
    return { index: hit.index, time: hit.time, rawPrice: price };
  }

  function setupDrawing(container) {
    let down = null;
    container.addEventListener('mousedown', e => { if (e.button === 0) down = { x: e.clientX, y: e.clientY }; });
    container.addEventListener('mouseup', e => {
      if (!drawTool || !down) return;
      const dist = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (dist > 6) return; // 平移/缩放图表，不是点击
      const hit = hitFromEvent(e);
      if (hit) addDrawPoint(hit);
    });
    container.addEventListener('mousemove', e => {
      if (!drawTool || !drawPoints.length) return;
      const hit = hitFromEvent(e);
      if (!hit || hit.index <= drawPoints[drawPoints.length - 1].index) { drawHover = null; renderActive(); return; }
      const preview = resnapDrawPoints(drawPoints.map(p => Object.assign({}, p)).concat([Object.assign({}, hit)]));
      drawHover = preview[preview.length - 1];
      renderActive();
    });
    container.addEventListener('dblclick', () => { if (drawTool && drawPoints.length >= 3) commitDrawing(); });
    // 右键取消正在画的浪；没有在画时保留浏览器右键菜单
    container.addEventListener('contextmenu', e => {
      if (!drawTool) return;
      e.preventDefault();
      cancelDrawing('已取消正在画的浪（右键）');
    }, true);
  }

  function addDrawPoint(hit) {
    const tool = DRAW_TOOLS[drawTool];
    const last = drawPoints[drawPoints.length - 1];
    if (last && hit.index <= last.index) {
      setWaveStatus('⚠ 画浪点须从左到右依次点击，且不能与上一个点落在同一根 K 线上');
      return;
    }
    drawPoints.push(hit);
    resnapDrawPoints(drawPoints);
    drawHover = null;
    renderChart();
    updateDrawButtons();
    if (drawPoints.length === tool.labels.length) { commitDrawing(); return; }
    const next = tool.labels[drawPoints.length];
    setWaveStatus(`✏️ ${tool.name}（${currentTf.toUpperCase()}）：已点 ${drawPoints.length}/${tool.labels.length}，下一个点「${next}」` +
      `${drawPoints.length >= 3 ? ' · 双击 /「结束本浪」可提前结束（末浪按运行中）' : ''} · Backspace 撤销 · Esc / 右键取消`);
  }

  function startDrawing(tool) {
    if (!currentBars.length) { setWaveStatus('⚠ K线尚未加载完成'); return; }
    drawTool = tool;
    drawPoints = [];
    drawHover = null;
    updateDrawButtons();
    renderChart();
    setWaveStatus(`✏️ ${DRAW_TOOLS[tool].name}（${currentTf.toUpperCase()}）：从起点 0 开始依次点击各浪终点（自动吸附到 K 线最高/最低价）。` +
      `画在某个浪的一段之内即为它的子浪 · Esc / 右键取消`);
  }

  function cancelDrawing(msg) {
    drawTool = null;
    drawPoints = [];
    drawHover = null;
    updateDrawButtons();
    renderChart();
    if (msg) setWaveStatus(msg);
  }

  /** 正在画的浪加入画板 (不自动评估；画完母浪与子浪后点「评估全部」) */
  function commitDrawing() {
    if (!drawTool || drawPoints.length < 3) return;
    const tool = DRAW_TOOLS[drawTool];
    const d = {
      id: `d${++sketchSeq}`, tool: drawTool, timeframe: currentTf,
      points: drawPoints.map(p => ({ time: p.time, price: p.price, type: p.type }))
    };
    sketch.push(d);
    drawTool = null;
    drawPoints = [];
    drawHover = null;
    invalidateEval();
    const rel = relationOf(d.id);
    setWaveStatus(`✓ 已加入「${tool.name}」（${d.timeframe.toUpperCase()}${rel ? ' · ' + rel : ' · 母浪'}）。` +
      `可继续画子浪（可切换到低周期画），画完点「评估全部」或按 Enter`);
  }

  function removeDrawing(id) {
    sketch = sketch.filter(d => d.id !== id);
    invalidateEval();
    setWaveStatus(sketch.length ? `已删除一个浪，剩余 ${sketch.length} 个` : '已清空画浪');
  }

  function clearSketch(msg) {
    sketch = [];
    drawTool = null;
    drawPoints = [];
    drawHover = null;
    invalidateEval();
    if (msg) setWaveStatus(msg);
  }

  /** 画板变化后，之前的整体评估作废 */
  function invalidateEval() {
    evalToken++;
    sketchEval = null;
    selectedId = null;
    updateDrawButtons();
    renderChart();
    renderPanel();
  }

  function undo() {
    if (drawTool) {
      if (!drawPoints.length) { cancelDrawing('已取消正在画的浪'); return; }
      drawPoints.pop();
      resnapDrawPoints(drawPoints);
      drawHover = null;
      updateDrawButtons();
      renderChart();
      setWaveStatus(`✏️ ${DRAW_TOOLS[drawTool].name}：已撤销，当前 ${drawPoints.length} 个点`);
      return;
    }
    if (sketch.length) removeDrawing(sketch[sketch.length - 1].id);
  }

  function updateDrawButtons() {
    document.querySelectorAll('.draw-tool-btn').forEach(b => b.classList.toggle('active', b.dataset.tool === drawTool));
    const set = (id, disabled) => { const el = document.getElementById(id); if (el) el.disabled = disabled; };
    set('btn-draw-undo', !drawTool && !sketch.length);
    set('btn-draw-finish', !drawTool || drawPoints.length < 3);
    set('btn-draw-evaluate', !sketch.length);
    set('btn-draw-clear', !sketch.length && !drawTool);
    const container = document.getElementById('wave-chart-container');
    if (container) container.style.cursor = drawTool ? 'crosshair' : 'default';
  }

  // ---------------------------------------------------------------------------
  // 整体评估
  // ---------------------------------------------------------------------------
  async function evaluateAll() {
    if (drawTool) {
      if (drawPoints.length >= 3) commitDrawing();
      else cancelDrawing();
    }
    if (!sketch.length) return;
    const token = ++evalToken;
    const drawings = sketch.map(d => ({ id: d.id, tool: d.tool, timeframe: d.timeframe, points: d.points.map(p => ({ time: p.time, price: p.price })) }));
    setWaveStatus(`⏳ 正在整体评估 ${drawings.length} 个浪：每个浪的铁律 / 低周期子浪 / 走势检验，以及母子级别一致性…`);
    const badge = document.getElementById('wave-user-eval-badge');
    if (badge) { badge.className = 'card-badge badge-neutral'; badge.textContent = '评估中…'; }

    let res = null, err = null, tried = false;
    try {
      res = await evaluateSketchClientSide(currentSymbol, drawings);
      tried = !!res;
    } catch (e) {
      tried = true;
      err = e.message;
    }
    if (!tried) {
      try {
        const r = await fetch('/api/wave/evaluate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol: currentSymbol.replace(/[\/\-_]/g, '').toUpperCase(), drawings }),
          signal: AbortSignal.timeout(60000)
        });
        const j = await r.json();
        if (j && j.code === 0) res = j; else err = (j && j.error) || `HTTP ${r.status}`;
      } catch (e) { err = e.message || '网络连接超时'; }
    }
    if (token !== evalToken) return; // 评估期间画板已变化
    if (!res) {
      renderPanel(err);
      setWaveStatus(`❌ 评估失败：${err}`);
      return;
    }
    sketchEval = res;
    selectedId = res.roots[0] || (res.nodes[0] && res.nodes[0].id) || null;
    renderChart();
    renderPanel();
    setWaveStatus(`● 整体评估：${res.verdictLabel} · ${res.nodes.length} 个浪（${res.roots.length} 个母浪）· 点右侧列表查看每个浪的详情`);
  }

  // ---------------------------------------------------------------------------
  // 图表渲染
  // ---------------------------------------------------------------------------
  function nodeOf(id) {
    return sketchEval ? sketchEval.nodes.find(x => x.id === id) : null;
  }

  /** 未评估时用引擎的母子关系推断 (只依赖时间)，评估后用评估结果 */
  function treeInfo() {
    if (sketchEval) {
      const out = {};
      sketchEval.nodes.forEach(x => { out[x.id] = { parentId: x.parentId, depth: x.depth, legName: x.parentLegName }; });
      return out;
    }
    if (window.LiuWaveEngine && window.LiuWaveEngine.buildSketchTree && sketch.length) {
      try { return window.LiuWaveEngine.buildSketchTree(sketch).nodes; } catch (e) { /* 忽略 */ }
    }
    const out = {};
    sketch.forEach(d => { out[d.id] = { parentId: null, depth: 0 }; });
    return out;
  }

  function relationOf(id) {
    const info = treeInfo()[id];
    if (!info || !info.parentId) return '';
    const p = sketch.find(d => d.id === info.parentId);
    return p ? `「${DRAW_TOOLS[p.tool].name}」${info.legName || ''}的子浪` : '';
  }

  function toLineData(points) {
    const data = [];
    points.forEach(p => {
      if (!p) return;
      const prev = data[data.length - 1];
      if (prev && p.time <= prev.time) { prev.value = p.value; return; } // 同一根K线内的多个拐点：保留后者
      data.push({ time: p.time, value: p.value });
    });
    return data;
  }

  function removePriceLines() {
    userPriceLines.forEach(pl => { try { candleSeries.removePriceLine(pl); } catch (e) {} });
    userPriceLines = [];
  }

  function renderActive() {
    if (!activeSeries) return;
    const data = drawPoints.map(p => ({ time: p.time, value: p.price }));
    if (drawTool && drawHover && (!data.length || drawHover.time > data[data.length - 1].time)) data.push({ time: drawHover.time, value: drawHover.price });
    activeSeries.setData(data);
  }

  function renderChart() {
    if (!waveChart || !candleSeries) return;
    const info = treeInfo();
    const markers = [];

    // 1. 已画的浪 (评估后取吸附 / 固定后的拐点)
    const alive = new Set(sketch.map(d => d.id));
    sketchSeries.forEach((s, id) => { if (!alive.has(id)) { try { waveChart.removeSeries(s); } catch (e) {} sketchSeries.delete(id); } });
    sketch.forEach(d => {
      const nd = nodeOf(d.id);
      const pts = nd && nd.result ? nd.result.points : d.points;
      const depth = Math.min((info[d.id] || {}).depth || 0, DEPTH_STYLE.length - 1);
      const st = DEPTH_STYLE[depth];
      const color = nd ? (VERDICT_STYLE[nd.verdict] || VERDICT_STYLE.DOUBT).color : st.color;
      const selected = selectedId === d.id;
      let s = sketchSeries.get(d.id);
      if (!s) { s = safeCreateSeries(waveChart, 'Line', lineOpts(color, st.width)); sketchSeries.set(d.id, s); }
      s.applyOptions({
        color, lineWidth: st.width + (selected ? 1 : 0),
        lineStyle: LightweightCharts.LineStyle[st.style]
      });
      const disp = pts.map(p => displayPoint(p, d.timeframe));
      s.setData(toLineData(disp));
      if (!showMarkers) return;
      const tool = DRAW_TOOLS[d.tool];
      const labels = depth === 0 ? tool.marks : depth === 1 ? tool.labels : tool.minor;
      disp.forEach((p, i) => {
        if (!p || (depth > 0 && i === 0)) return; // 子浪起点与母浪拐点重合，不重复标注
        const isHigh = p.type === 'high';
        markers.push({
          time: p.time, position: isHigh ? 'aboveBar' : 'belowBar', color, shape: depth === 0 ? (isHigh ? 'arrowDown' : 'arrowUp') : 'circle',
          text: depth === 0 ? `${labels[i]} $${Math.round(p.value).toLocaleString()}` : labels[i], size: depth === 0 ? 1.3 : depth === 1 ? 0.8 : 0.5
        });
      });
    });

    // 2. 正在画的浪
    renderActive();
    if (drawTool && showMarkers) {
      const tool = DRAW_TOOLS[drawTool];
      drawPoints.forEach((p, i) => {
        markers.push({ time: p.time, position: p.type === 'high' ? 'aboveBar' : 'belowBar', color: '#a855f7', shape: 'circle', text: tool.labels[i], size: 0.9 });
      });
    }

    // 3. 所选浪: 低周期子浪 (没有画子浪的段) 与价位线
    const sel = nodeOf(selectedId);
    const subData = [];
    if (sel && sel.result && showSubwaves) {
      (sel.result.primary.liveLegs || []).forEach(L => {
        if (L.userChild) return;
        (L.subPoints || []).forEach((q, k) => {
          const p = displayPoint(q, '5m');
          if (!p) return;
          const prev = subData[subData.length - 1];
          if (prev && p.time <= prev.time) {
            if (p.time === prev.time && ((q.type === 'high' && q.price > prev.value) || (q.type === 'low' && q.price < prev.value))) prev.value = q.price;
            return;
          }
          subData.push({ time: p.time, value: q.price });
          if (showMarkers && q.label && q.label !== '0' && k > 0 && k < L.subPoints.length - 1) {
            markers.push({ time: p.time, position: q.type === 'high' ? 'aboveBar' : 'belowBar', color: getWaveChartColors().subwaveColor, shape: 'circle', text: `(${q.label})`, size: 0.5 });
          }
        });
      });
    }
    if (subSeries) subSeries.setData(subData);

    markers.sort((a, b) => a.time - b.time);
    setChartMarkers(candleSeries, markers);

    removePriceLines();
    if (sel && sel.result) {
      const r = sel.result, v = sel.verdict;
      const inv = r.invalidation || {};
      const tag = sketchEval.nodes.length > 1 ? `·${DRAW_TOOLS[sel.tool].labels.slice(1).join('')}` : '';
      if (showMonitoring && inv.structural && (v === 'VALID' || v === 'DOUBT')) {
        userPriceLines.push(candleSeries.createPriceLine({ price: inv.structural.price, color: '#ef4444', lineWidth: 2, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: `失效位${tag}` }));
      }
      if (showMonitoring && inv.monitor && v !== 'INVALID') {
        userPriceLines.push(candleSeries.createPriceLine({ price: inv.monitor.price, color: '#f59e0b', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: `监测点(${inv.monitor.source || sel.timeframe})` }));
      }
      if (showTargets && v !== 'INVALID' && v !== 'FALSIFIED_SUB') {
        (r.targets || []).slice(0, 3).forEach(t => {
          userPriceLines.push(candleSeries.createPriceLine({ price: t.price, color: getWaveChartColors().targetColor, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted, axisLabelVisible: true, title: `目标 ${t.label}` }));
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 面板渲染
  // ---------------------------------------------------------------------------
  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmtP(v) {
    if (v === null || v === undefined || !isFinite(v)) return '--';
    return '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: v >= 100 ? 1 : 4 });
  }

  /** 按母子关系排序 (母浪在前，子浪按时间跟在母浪之后) */
  function orderedSketch(info) {
    const kids = id => sketch.filter(d => (info[d.id] || {}).parentId === id).sort((a, b) => a.points[0].time - b.points[0].time);
    const out = [];
    const walk = d => { out.push(d); kids(d.id).forEach(walk); };
    sketch.filter(d => !(info[d.id] || {}).parentId).sort((a, b) => a.points[0].time - b.points[0].time).forEach(walk);
    sketch.forEach(d => { if (out.indexOf(d) < 0) out.push(d); });
    return out;
  }

  function renderPanel(errorMsg) {
    const list = document.getElementById('wave-sketch-list');
    const body = document.getElementById('wave-user-eval-body');
    const badge = document.getElementById('wave-user-eval-badge');
    const card = document.getElementById('card-wave-user-eval');
    if (!list || !body) return;
    const info = treeInfo();

    // 画板列表
    if (!sketch.length) {
      list.innerHTML = '';
    } else {
      list.innerHTML = `
        <div class="liu-signal-title"><span>已画的浪（${sketch.length}）</span><span>${sketchEval ? '点击查看详情' : '未评估'}</span></div>
        ${orderedSketch(info).map(d => {
          const it = info[d.id] || {};
          const nd = nodeOf(d.id);
          const st = nd ? (VERDICT_STYLE[nd.verdict] || VERDICT_STYLE.DOUBT) : null;
          const rel = it.parentId ? `${esc(it.legName || '')}子浪` : '母浪';
          return `<div class="wave-sketch-row${selectedId === d.id ? ' selected' : ''}${nd ? ' clickable' : ''}" data-id="${esc(d.id)}" style="padding-left:${8 + 16 * (it.depth || 0)}px">
            <span class="wave-sketch-name">${it.depth ? '└ ' : ''}${esc(nd ? nd.name : DRAW_TOOLS[d.tool].name)}</span>
            <span class="wave-sketch-meta">${esc(d.timeframe.toUpperCase())} · ${rel}</span>
            ${st ? `<span class="liu-chip ${st.chip}">${esc(nd.verdictLabel)}</span>` : ''}
            <button class="wave-sketch-del" data-del="${esc(d.id)}" title="删除这个浪">×</button>
          </div>`;
        }).join('')}`;
    }

    if (card) card.classList.toggle('has-result', !!sketchEval);
    if (errorMsg) {
      if (badge) { badge.className = 'card-badge badge-bear'; badge.textContent = '无法评估'; }
      body.innerHTML = `<div class="liu-signal-row">${esc(errorMsg)}</div>`;
      return;
    }
    if (!sketchEval) {
      if (badge) { badge.className = 'card-badge badge-neutral'; badge.textContent = sketch.length ? '待评估' : '待画浪'; }
      body.innerHTML = sketch.length
        ? '<p class="liu-idle">画完母浪与需要的子浪后，点「评估全部」（或按 Enter）。画在某个浪一段之内的浪自动作为那一段的子浪；可切换到 1H / 15m 画更细的子浪。</p>'
        : `<p class="liu-idle">选择上方画浪工具（推动浪 12345 / abc / wxy / wxyxz / 三角形 abcde），在图上依次点击各浪端点。<br>
           先画母浪（例如 4H 上的 12345），再在它的某一段之内画子浪（例如浪2 画 abc、浪4 画三角形，可切到 1H 画），最后「评估全部」。<br>
           引擎逐个检验手稿铁律、低周期子浪与画完后的走势，并检查子浪与母浪该段是否相符（类别、方向、位置、交替原则）。</p>`;
      return;
    }

    const ov = VERDICT_STYLE[sketchEval.verdict] || VERDICT_STYLE.DOUBT;
    if (badge) { badge.className = `card-badge ${ov.badge}`; badge.textContent = sketchEval.verdictLabel; }
    const sel = nodeOf(selectedId);
    let html = `
      <div class="liu-signal-row">
        <div class="liu-signal-title"><span>整体结论</span><span class="liu-chip ${ov.chip}">${esc(sketchEval.verdictLabel)}</span></div>
        ${sketchEval.lines.map(l => `<div class="ue-line">${esc(l)}</div>`).join('')}
      </div>`;
    if (sel) {
      const issues = sel.issues || [];
      if (issues.length) {
        html += `
          <div class="liu-signal-row">
            <div class="liu-signal-title"><span>级别关系 · ${esc(sel.name)}</span></div>
            ${issues.map(x => `<div class="ue-line">${x.severity === 'strong' ? '✗' : x.severity === 'medium' ? '?' : '·'} ${esc(x.text)}</div>`).join('')}
          </div>`;
      }
      html += sel.result ? userEvalHtml(sel.result, sel) : `<div class="liu-signal-row">无法评估：${esc(sel.error || '')}</div>`;
    }
    body.innerHTML = html;
  }

  function userEvalHtml(r, nd) {
    const st = VERDICT_STYLE[nd.verdict] || VERDICT_STYLE.DOUBT;
    const lines = (r.commentary && r.commentary.lines) || [];
    const verdictHtml = `
      <div class="liu-signal-row">
        <div class="liu-signal-title"><span>柳氏研判 · ${esc(r.primary.name)}（${esc(nd.timeframe.toUpperCase())}）</span><span class="liu-chip ${st.chip}">${esc(nd.verdictLabel)}</span></div>
        ${lines.map(l => `<div class="ue-line">${esc(l)}</div>`).join('')}
      </div>`;

    const legRows = (r.primary.legs || []).map(L => {
      const s = LEG_STATUS[L.status] || LEG_STATUS.UNKNOWN;
      const found = L.userChild ? '子浪' : L.found === '5' ? '五浪' : L.found === '3' ? `${L.swings > 13 ? '>13' : L.swings}段` : '—';
      return `<tr><td>${esc(L.name)}</td><td>${L.expect === '5' ? '五浪' : '三浪'}</td><td>${found}</td>` +
        `<td>${esc(L.source || nd.timeframe)}</td><td><span class="liu-chip ${s.cls}">${s.txt}</span></td></tr>` +
        (L.status !== 'PASS' || L.userChild ? `<tr><td colspan="5" class="ue-note">${esc(L.text)}</td></tr>` : '');
    }).join('');
    const subHtml = `
      <div class="liu-signal-row">
        <div class="liu-signal-title"><span>子浪结构 · ${esc((r.subTimeframes || []).join('/') || nd.timeframe)}</span><span>手稿 ${esc(r.primary.structurePage || '')}</span></div>
        <table class="liu-parts-table"><tr><td>段</td><td>要求</td><td>实测</td><td>来源</td><td>结论</td></tr>${legRows}</table>
      </div>`;

    const inv = r.invalidation || {};
    const lvRows = [];
    if (inv.monitor) lvRows.push(['监测点', inv.monitor.price, inv.monitor.text]);
    if (inv.confirm) lvRows.push(['确认位', inv.confirm.price, inv.confirm.text]);
    if (inv.structural) lvRows.push(['失效位', inv.structural.price, inv.structural.text]);
    if (inv.secondary) lvRows.push(['次级防线', inv.secondary.price, inv.secondary.text]);
    (r.targets || []).slice(0, 4).forEach(t => lvRows.push(['目标', t.price, t.label]));
    const lvHtml = lvRows.length ? `
      <div class="liu-signal-row">
        <div class="liu-signal-title"><span>监测点 · 失效位 · 目标</span><span>现价 ${fmtP(r.currentPrice)}</span></div>
        <table class="liu-parts-table">${lvRows.map(x => `<tr><td>${x[0]}</td><td class="num">${fmtP(x[1])}</td><td>${esc(x[2])}</td></tr>`).join('')}</table>
      </div>` : '';

    const hard = (r.primary.ruleChecks || []).filter(c => c.hard);
    const failed = hard.filter(c => !c.pass && !c.pending);
    const rulesHtml = `
      <div class="liu-signal-row">
        <div class="liu-signal-title"><span>手稿铁律</span><span class="liu-chip ${failed.length ? 'neg' : 'pos'}">${hard.length - failed.length}/${hard.length} 通过</span></div>
        ${failed.length ? failed.map(c => `<div class="ue-line">✗ ${esc(c.text)}（${esc(c.page)}）${c.detail ? '：' + esc(c.detail) : ''}</div>`).join('') : '<div class="ue-line">全部通过</div>'}
        ${(r.primary.liveHardFails || []).map(f => `<div class="ue-line">走势检验 ✗ ${esc(f.text)}（${esc(f.page)}）：${esc(f.detail)}</div>`).join('')}
      </div>`;

    const other = [];
    (r.interpretations || []).forEach(it => other.push(`${esc(it.name)}：铁律违规 ${it.hardFails} · 子浪证伪 ${it.strong} · 存疑 ${it.medium}`));
    (r.alternatives || []).forEach(a => other.push(`同样的点按「${esc(a.name)}」可成立`));
    if (r.preceding) other.push(`前序：${esc(r.preceding.text)}`);
    (r.adjustments || []).forEach(a => other.push(`「${esc(a.point)}」点已吸附：${fmtP(a.fromPrice)} → ${fmtP(a.toPrice)}${a.barsMoved ? `（移动 ${a.barsMoved} 根）` : ''}`));
    (r.endpointIssues || []).forEach(x => other.push(esc(x.text)));
    const otherHtml = other.length ? `
      <div class="liu-signal-row">
        <div class="liu-signal-title"><span>其它解读 · 取点</span></div>
        ${other.map(t => `<div class="ue-line">${t}</div>`).join('')}
      </div>` : '';

    return verdictHtml + subHtml + lvHtml + rulesHtml + otherHtml;
  }

  // ---------------------------------------------------------------------------
  // 事件
  // ---------------------------------------------------------------------------
  function waveViewVisible() {
    const el = document.getElementById('wave-chart-container');
    return !!(el && el.offsetParent !== null);
  }

  function initEvents() {
    const symbolBtns = document.querySelectorAll('.wave-symbol-btn:not(.wave-tf-btn)');
    symbolBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const sym = btn.dataset.symbol;
        if (!sym || sym === currentSymbol) return;
        symbolBtns.forEach(b => b.classList.toggle('active', b === btn));
        if (sketch.length || drawTool) clearSketch(); // 换标的: 画的浪不再适用
        loadChartCandles(sym);
      });
    });

    const tfBtns = document.querySelectorAll('.wave-tf-btn');
    tfBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const tf = btn.dataset.interval;
        if (!tf || tf === currentTf) return;
        if (drawTool) cancelDrawing(); // 正在画的浪只属于原周期；已画的浪保留
        currentTf = tf;
        tfBtns.forEach(b => b.classList.toggle('active', b === btn));
        const tfLabelEl = document.getElementById('wave-tf-label');
        if (tfLabelEl) tfLabelEl.textContent = TF_NAME[tf] || tf;
        loadChartCandles(currentSymbol);
      });
    });

    const toggle = (id, get, set) => {
      const btn = document.getElementById(id);
      if (!btn) return;
      btn.addEventListener('click', () => { set(!get()); btn.classList.toggle('active', get()); renderChart(); });
    };
    toggle('btn-toggle-markers', () => showMarkers, v => { showMarkers = v; });
    toggle('btn-toggle-subwaves', () => showSubwaves, v => { showSubwaves = v; });
    toggle('btn-toggle-invalidation', () => showMonitoring, v => { showMonitoring = v; });
    toggle('btn-toggle-targets', () => showTargets, v => { showTargets = v; });

    document.querySelectorAll('.draw-tool-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tool = btn.dataset.tool;
        if (drawTool === tool) { cancelDrawing('已取消正在画的浪'); return; }
        startDrawing(tool);
      });
    });
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
    on('btn-draw-undo', () => undo());
    on('btn-draw-finish', () => commitDrawing());
    on('btn-draw-evaluate', () => evaluateAll());
    on('btn-draw-clear', () => clearSketch('已清除全部画浪'));

    const list = document.getElementById('wave-sketch-list');
    if (list) {
      list.addEventListener('click', e => {
        const del = e.target.closest('[data-del]');
        if (del) { removeDrawing(del.dataset.del); return; }
        const row = e.target.closest('.wave-sketch-row');
        if (row && sketchEval) {
          selectedId = row.dataset.id;
          renderChart();
          renderPanel();
        }
      });
    }

    window.addEventListener('keydown', e => {
      if (!waveViewVisible()) return;
      const tag = (e.target && e.target.tagName) || '';
      if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
      if (e.key === 'Escape' && drawTool) cancelDrawing('已取消正在画的浪');
      else if (e.key === 'Enter') {
        if (drawTool && drawPoints.length >= 3) { e.preventDefault(); commitDrawing(); }
        else if (!drawTool && sketch.length) { e.preventDefault(); evaluateAll(); }
      } else if (e.key === 'Backspace' && (drawTool || sketch.length)) { e.preventDefault(); undo(); }
    });

    updateDrawButtons();
    renderPanel();
  }

  // 挂载全局接口供 app.js 联动
  window.WaveRadarModule = {
    init: initEvents,
    loadCandles: loadChartCandles,
    updateTheme: updateTheme,
    /** 只读: 当前画板与整体评估 (调试 / 自动化检查用) */
    getSketch: () => JSON.parse(JSON.stringify({ timeframe: currentTf, sketch, evaluation: sketchEval })),
    onViewActivated: function () {
      if (!waveChart) initChart();
      if (currentBars.length === 0) {
        if (!initialLoadPromise) initialLoadPromise = loadChartCandles(currentSymbol).finally(() => { initialLoadPromise = null; });
      } else {
        const container = document.getElementById('wave-chart-container');
        if (container && waveChart) waveChart.applyOptions({ width: container.clientWidth });
      }
    }
  };
})();
