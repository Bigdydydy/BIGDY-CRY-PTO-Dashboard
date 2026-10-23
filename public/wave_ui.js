/**
 * Module 8 · 柳玉冬波浪理论 · 多级别画浪评估
 * 用户在 K 线图上画母浪与子浪 (可切换周期在低周期画子浪)，「评估全部」时由引擎整体评估：
 * 每个浪的手稿铁律 / 低周期子浪证伪 / 画完后的走势检验，以及母子级别之间的一致性。
 * 计算在浏览器 Web Worker 中完成，服务端只提供带缓存的 K 线 (Render 免费实例只有 0.1 CPU)。
 */

(function () {
  let waveChart = null;
  let candleSeries = null;
  let subSeries = null;     // 所选浪在低周期探测到的子浪 (细点线)
  let activeSeries = null;  // 正在画的浪
  const sketchSeries = new Map(); // 已画的浪 id → 折线

  let currentSymbol = 'BTC/USDT';
  let currentTf = '4h';
  let currentBars = [];
  let initialLoadPromise = null;
  let mainKlineSource = null; // 服务端返回的主图行情源 (币安被拒时为 Bybit / OKX)
  // 主图K线对应的数据健康: { symbol, tf, entry: {bars, health, t} }。
  // entry.bars 与 currentBars 一致；加载失败时 entry.bars=null，防止拿上一个标的/周期的旧柱做当前评价。
  let mainBarsMeta = null;

  let showMarkers = true;
  let showSubwaves = false;
  let showMonitoring = true;
  let showTargets = true;
  let showProjection = true;
  let projSeries = null;
  let channelSeries = null; // 所选楔形的 2-4 通道线   // 所选浪的假设推演路径 (橙色虚线，可延伸到未来)

  // 画浪状态
  let drawTool = null;   // 正在画的工具
  let drawPoints = [];   // 正在画的点 [{ index, time, rawPrice, type, price }]
  let drawHover = null;
  let sketch = [];       // 已画的浪 [{ id, tool, timeframe, points: [{ time, price, type }] }]
  let sketchSeq = 0;
  let sketchEval = null; // evaluateUserSketch 结果
  let selectedId = null; // 面板与价位线展示的浪
  let previewSug = null;  // 图上预览的替代计数 { id, k }
  // 框选分析: boxMode 等待框选；boxDrag 正在拖；boxSel 选区 {t0, t1, tf}；boxResult 分析结果；boxPreview 图上预览第几个
  let boxMode = false, boxDrag = null, boxSel = null, boxResult = null, boxPreview = null, boxToken = 0;
  let previewSeries = null;
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
    WXYXZ: { name: '调整浪 w-x-y-xx-z', labels: ['0', 'w', 'x', 'y', 'xx', 'z'], marks: ['⓪', 'Ⓦ', 'Ⓧ', 'Ⓨ', 'ⓍⓍ', 'Ⓩ'], minor: ['', '(w)', '(x)', '(y)', '(xx)', '(z)'] },
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
      background: 'rgba(0, 0, 0, 0)', // 透明：由 Atelier 玻璃卡片提供底色
      textColor: isLight ? '#4b4b52' : '#a1a1aa',
      borderColor: isLight ? 'rgba(18, 18, 20, 0.12)' : 'rgba(255, 255, 255, 0.08)',
      gridColor: isLight ? 'rgba(18, 18, 20, 0.05)' : 'rgba(255, 255, 255, 0.04)',
      crosshairColor: isLight ? '#8a5a14' : '#e6c27f',
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
  const markerPrimitives = new Map();
  function setChartMarkers(series, markers) {
    if (!series) return;
    const m = markers || [];
    if (typeof series.setMarkers === 'function') { series.setMarkers(m); return; }
    if (window.LightweightCharts && typeof window.LightweightCharts.createSeriesMarkers === 'function') {
      const prim = markerPrimitives.get(series);
      if (!prim) markerPrimitives.set(series, window.LightweightCharts.createSeriesMarkers(series, m));
      else prim.setMarkers(m);
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
    markerPrimitives.clear();
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
    previewSeries = safeCreateSeries(chart, 'Line', lineOpts('#10b981', 2, LightweightCharts.LineStyle.LargeDashed));
    projSeries = safeCreateSeries(chart, 'Line', lineOpts('#f59e0b', 2, LightweightCharts.LineStyle.Dashed));
    channelSeries = safeCreateSeries(chart, 'Line', lineOpts('#a855f7', 1, LightweightCharts.LineStyle.Dashed));

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
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => positionBox());
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
  const FUTURE_SKEW_MS = 5 * 60 * 1000; // 与服务端 validateKlineRows 的 5 分钟未来容忍一致
  // 与服务端波浪K线策略窗口一致的本地可用性判定：接收侧15分钟、数据侧2*周期+15分钟。
  const WAVE_FETCH_BLOCK_MS = 15 * 60 * 1000;
  const WAVE_DATA_SLACK_MS = 15 * 60 * 1000;
  const WAVE_FETCH_WARN_MS = 3 * 60 * 1000; // 与服务端 wave policy warn 一致

  /** 直连返回的原始K线逐行校验: 有限正OHLC、volume>=0、时间升序、无未来；坏行直接抛错，绝不进缓存/评估 */
  function validateRawKlineRows(rows) {
    const nowMs = Date.now() + FUTURE_SKEW_MS;
    // null / '' / 布尔值不许被 Number() 静默变成 0/1
    const strictNum = x => (x === null || x === undefined || typeof x === 'boolean' ||
      (typeof x === 'string' && x.trim() === '')) ? NaN : Number(x);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!Array.isArray(r) || r.length < 6) throw new Error('直连K线格式不完整');
      const t = strictNum(r[0]), o = strictNum(r[1]), h = strictNum(r[2]), l = strictNum(r[3]), c = strictNum(r[4]), v = strictNum(r[5]);
      const bad = [t, o, h, l, c, v].some(n => !Number.isFinite(n));
      if (bad || t <= 0 || o <= 0 || h <= 0 || l <= 0 || c <= 0 || v < 0) throw new Error('直连K线包含非法数值');
      if (h < Math.max(o, c, l) || l > Math.min(o, c, h)) throw new Error('直连K线OHLC关系非法');
      if (t > nowMs) throw new Error('直连K线含未来时间');
      if (i && t <= Number(rows[i - 1][0])) throw new Error('直连K线时间顺序异常');
    }
  }

  function parseRawKlines(rows) {
    validateRawKlineRows(rows);
    return rows.map(b => ({ time: Math.floor(b[0] / 1000), open: parseFloat(b[1]), high: parseFloat(b[2]), low: parseFloat(b[3]), close: parseFloat(b[4]), volume: parseFloat(b[5]) }));
  }

  /** 服务端 /api/wave/klines 响应 → 缓存条目健康快照（沿用其策略窗口做本地到期判定） */
  function serverEntryHealth(json) {
    const summary = json && json.dataHealth && typeof json.dataHealth === 'object' ? json.dataHealth : null;
    const src = summary && summary.sources ? Object.values(summary.sources)[0] : null;
    return {
      state: (src && src.state) || (summary && summary.state) || 'UNKNOWN',
      usable: src ? src.usable !== false : json.usable !== false,
      lastSuccessAt: json.lastSuccessAt || (src && src.lastSuccessAt) || null,
      dataAsOf: json.dataAsOf || (src && src.dataAsOf) || null,
      policy: (src && src.policy) || null,
      source: json.source || null,
      stale: json.stale || null
    };
  }

  /** 与服务端 getSourcePolicy('wave:*') 一致的本地策略窗口 */
  function waveLocalPolicy(tfSec) {
    return {
      fetchWarnMs: WAVE_FETCH_WARN_MS,
      fetchBlockMs: WAVE_FETCH_BLOCK_MS,
      dataWarnMs: tfSec * 1000 + WAVE_FETCH_WARN_MS,
      dataBlockMs: 2 * tfSec * 1000 + WAVE_DATA_SLACK_MS
    };
  }

  /** 浏览器直连取得的真实新K线: receipt=收到时刻，dataAsOf=最后一根开盘时间，附完整策略窗口 */
  function clientBarsHealth(bars, source, tfSec) {
    return {
      state: 'OK',
      usable: true,
      lastSuccessAt: new Date().toISOString(),
      dataAsOf: new Date(bars[bars.length - 1].time * 1000).toISOString(),
      policy: waveLocalPolicy(tfSec),
      source: source || '浏览器直连币安',
      stale: null
    };
  }

  /** 缓存条目此刻是否仍可用于当前研判 (接收/数据两个时钟都未过期；服务端已标不可用则直接 false) */
  function waveEntryUsable(entry, tfSec, nowMs) {
    if (!entry || !Array.isArray(entry.bars) || !entry.bars.length) return false;
    const h = entry.health;
    // 缺 health / 可用性未知 / 缺接收或数据时钟 → 一律 fail closed；
    // 缓存命中时间 (entry.t) 只是读取时刻，不能充当真实回执。
    if (!h || typeof h !== 'object') return false;
    if (h.usable !== true || h.available === false) return false;
    const recv = Date.parse(h.lastSuccessAt);
    const asof = Date.parse(h.dataAsOf);
    if (!Number.isFinite(recv) || !Number.isFinite(asof)) return false;
    const p = h.policy && typeof h.policy === 'object' ? h.policy : null;
    if (!p || (!Number.isFinite(p.fetchBlockMs) && !Number.isFinite(p.dataBlockMs))) return false;
    const fetchBlock = Number.isFinite(p.fetchBlockMs) ? p.fetchBlockMs : WAVE_FETCH_BLOCK_MS;
    const dataBlock = Number.isFinite(p.dataBlockMs) ? p.dataBlockMs : (2 * tfSec * 1000 + WAVE_DATA_SLACK_MS);
    return (nowMs - recv <= fetchBlock) && (nowMs - asof <= dataBlock);
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
            // Return the source in-band: assigning mainKlineSource here would
            // race a symbol/tf switch that already superseded this request.
            return { bars: json.bars, health: serverEntryHealth(json), source: json.source || null };
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

  /** 主图K线 (最多 WAVE_BARS 根；服务端缓存优先，失败直连币安合约/现货)。返回 {bars, health} */
  async function fetchKlines(symbol, tf) {
    const clean = symbol.replace(/[\/\-_]/g, '').toUpperCase();
    let lastError = null;
    try {
      return await fetchServerBars(clean, tf, WAVE_BARS, () => setWaveStatus('服务端行情响应较慢（可能正在唤醒），重试中…'));
    } catch (err) { lastError = err; }
    const serverError = lastError;
    const direct = [
      ['https://fapi.binance.com/fapi/v1/klines', 1500, '浏览器直连币安合约'],
      ['https://data-api.binance.vision/api/v3/klines', 1000, '浏览器直连币安现货'],
      ['https://api.binance.com/api/v3/klines', 1000, '浏览器直连币安现货']
    ];
    for (const [base, pageMax, label] of direct) {
      try {
        const rows = await fetchDirectPaged(base, pageMax, clean, tf, WAVE_BARS);
        if (rows.length) {
          const bars = parseRawKlines(rows); // 内部先严格校验原始schema与时间
          return { bars, health: clientBarsHealth(bars, label, TF_SEC[tf]) };
        }
      } catch (err) { lastError = err; }
    }
    throw new Error(`服务端行情不可用（${(serverError && serverError.message) || '超时'}），浏览器直连币安也失败`);
  }

  const AUX_TTL_MS = 120000;
  const auxKlineCache = new Map();

  /** 其它周期K线 (服务端缓存优先，失败直连币安)，浏览器内缓存2分钟；返回 {bars, health} 携带对应健康 */
  async function fetchAuxBars(symbol, tf, limit) {
    const clean = symbol.replace(/[\/\-_]/g, '').toUpperCase();
    const key = `${clean}_${tf}_${limit}`;
    const hit = auxKlineCache.get(key);
    if (hit && Date.now() - hit.t < AUX_TTL_MS) return hit;
    let entry = null;
    try { entry = await fetchServerBars(clean, tf, limit); } catch (e) { /* 降级直连 */ }
    if (!entry) {
      try {
        const rows = await fetchDirectPaged('https://fapi.binance.com/fapi/v1/klines', 1500, clean, tf, limit);
        if (rows.length) {
          const bars = parseRawKlines(rows);
          entry = { bars, health: clientBarsHealth(bars, '浏览器直连币安合约', TF_SEC[tf]) };
        }
      } catch (e) { entry = null; }
    }
    if (entry) { entry.t = Date.now(); auxKlineCache.set(key, entry); }
    return entry;
  }

  const PAGE_LOADED_AT = Date.now();
  let waveWorker = null; // null=未创建, false=不可用
  let waveWorkerSeq = 0;
  const waveWorkerPending = new Map();

  function getWaveWorker() {
    if (waveWorker === false) return null;
    if (waveWorker) return waveWorker;
    try {
      // 带页面加载时刻: Worker 的 importScripts 走浏览器缓存，部署后可能仍拿到旧引擎
      const src = `importScripts(${JSON.stringify(location.origin + '/wave_engine.js?b=' + PAGE_LOADED_AT)});
self.onmessage = function (e) {
  var d = e.data;
  var fn = d.fn === 'evaluateUserSketch' || d.fn === 'evaluateUserCount' || d.fn === 'analyzeRange' ? d.fn : 'analyzeWaves';
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
    const requiredTfs = new Set(drawings.map(d => d.timeframe));
    const fetched = await Promise.all(list.map(async tf => {
      if (tf === currentTf && mainBarsMeta && mainBarsMeta.symbol === symbol && mainBarsMeta.tf === currentTf) {
        return { tf, entry: mainBarsMeta.entry };
      }
      // 须覆盖最早的画浪点之前约 300 根 (前序检验)，按 1000 / 10000 两档取整以复用缓存
      const need = Math.ceil((nowSec - firstTime) / TF_SEC[tf]) + 400;
      return { tf, entry: await fetchAuxBars(symbol, tf, need <= 1000 ? 1000 : WAVE_BARS) };
    }));
    // 健康门禁：必需周期数据过期/不可用 → 暂停当前研判；过期辅助周期不传给引擎
    const barsByTf = {};
    const staleAux = [];
    const nowMs = Date.now();
    for (const { tf, entry } of fetched) {
      const usable = entry && waveEntryUsable(entry, TF_SEC[tf], nowMs);
      if (requiredTfs.has(tf)) {
        if (!usable) {
          const src = entry && entry.health && entry.health.source ? `（行情源：${entry.health.source}）` : '';
          const e = new Error(`${tf.toUpperCase()} K线数据过期或不可用，暂停当前研判${src}`);
          e.dataUnavailable = true;
          throw e;
        }
        barsByTf[tf] = entry.bars;
      } else if (usable) {
        barsByTf[tf] = entry.bars;
      } else if (entry) {
        staleAux.push(tf.toUpperCase());
      }
    }
    if (staleAux.length) setWaveStatus(`⚠ ${staleAux.join('/')} 辅助周期K线已过期，子浪证伪仅按可用周期`);
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

  let loadSeq = 0; // 标的/周期切换令牌：只有最新一次加载允许落地状态

  async function loadChartCandles(symbol = currentSymbol) {
    const seq = ++loadSeq;
    const tf = currentTf;
    currentSymbol = symbol;
    const tfLabel = tf.toUpperCase();
    const hudSym = document.getElementById('hud-sym');
    const title = document.getElementById('wave-chart-title');
    if (hudSym) hudSym.textContent = `${symbol} ${tfLabel}`;
    if (title) title.textContent = `${tfLabel} K 线图 · 画浪`;
    setWaveStatus(`正在拉取 ${symbol} ${tfLabel} K 线…`);
    try {
      mainKlineSource = null;
      const entry = await fetchKlines(symbol, tf);
      if (seq !== loadSeq) return; // 已切换标的/周期：旧响应不得覆盖新状态与健康
      const bars = entry.bars;
      entry.t = Date.now();
      mainBarsMeta = { symbol, tf, entry };
      currentBars = bars;
      mainKlineSource = entry.source || (entry.health && entry.health.source) || null;
      const usable = waveEntryUsable(entry, TF_SEC[tf], Date.now());
      if (window.DataHealthUI) {
        const h = entry.health || {};
        window.DataHealthUI.update('wave', {
          state: usable ? (h.state || 'OK') : 'STALE',
          usable,
          lastSuccessAt: h.lastSuccessAt,
          dataAsOf: h.dataAsOf,
          sources: { kline: h }
        });
      }
      updateSampleLabel(bars, tf);
      if (!waveChart) initChart();
      candleSeries.setData(bars.map(b => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })));
      focusChart();
      renderChart();
      const srcNote = mainKlineSource && !/币安/.test(mainKlineSource) ? ` · 行情源：${mainKlineSource}（币安暂不可用）` : '';
      const staleNote = entry.health && entry.health.stale && entry.health.stale.staleReason ? ` · ${entry.health.stale.staleReason}` : '';
      if (!usable) {
        // 历史曲线仍可浏览/画浪，但不能产出当前研判
        setWaveStatus(`⏸ [${symbol} ${tfLabel}] 历史K线 (${bars.length} 根)，暂停当前研判${srcNote}${staleNote}`);
      } else {
        setWaveStatus((sketch.length
          ? `● [${symbol} ${tfLabel}] K线就绪 · 已画 ${sketch.length} 个浪（其它周期画的浪按本周期K线显示），可继续画子浪`
          : `● [${symbol} ${tfLabel}] K线就绪 (${bars.length} 根) · 选择上方画浪工具，在图上从起点开始依次点击各浪端点`) + srcNote + staleNote);
      }
    } catch (err) {
      if (seq !== loadSeq) return; // 已被新加载取代，旧的失败不得污染当前状态
      console.error('[Wave Load Error]:', err);
      // 失败不沿用其它标的/周期的旧柱做评价；图上旧K线仅作历史展示
      mainBarsMeta = { symbol, tf, entry: { bars: null, health: { usable: false, state: 'UNAVAILABLE', lastError: err && err.message }, t: Date.now() } };
      if (window.DataHealthUI) window.DataHealthUI.fail('wave', err);
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

  /** 拖动端点时暂停图表自身的平移 / 缩放 */
  function lockChart(on) {
    if (waveChart) waveChart.applyOptions({ handleScroll: !on, handleScale: !on });
  }

  /** 光标附近 (10px 内) 已画浪的端点；只有画在当前周期的浪可以拖动 */
  function pointNear(e) {
    if (!waveChart || !candleSeries || !currentBars.length) return null;
    const rect = chartRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const ts = waveChart.timeScale();
    let best = null;
    sketch.forEach(d => {
      // 与图上显示一致: 评估后为引擎吸附后的拐点
      const nd = nodeOf(d.id);
      const shown = nd && nd.result && nd.result.points && nd.result.points.length === d.points.length ? nd.result.points : d.points;
      shown.forEach((p, i) => {
        const dp = displayPoint(p, d.timeframe);
        if (!dp) return;
        const px = ts.timeToCoordinate(dp.time), py = candleSeries.priceToCoordinate(p.price);
        if (px === null || py === null) return;
        const dist = Math.hypot(px - x, py - y);
        if (dist <= 10 && (!best || dist < best.dist)) best = { d, i, dist, movable: d.timeframe === currentTf };
      });
    });
    return best;
  }

  let drag = null;
  /** 开始拖动: 已评估的浪先采用引擎吸附后的拐点，与图上显示一致；与它重合的其它浪端点 (母浪 / 子浪共用的拐点) 一起移动 */
  function startDrag(hp, x) {
    const nd = nodeOf(hp.d.id);
    const hadEval = !!sketchEval;
    if (nd && nd.result && nd.result.points && nd.result.points.length === hp.d.points.length) {
      hp.d.points = nd.result.points.map((q, k) => ({ time: q.time, price: q.price, type: q.type, fixed: !!hp.d.points[k].fixed }));
    }
    const p = hp.d.points[hp.i];
    const linked = [];
    sketch.forEach(d => {
      if (d.timeframe !== currentTf) return;
      d.points.forEach((q, k) => { if (q.time === p.time && Math.abs(q.price - p.price) < 1e-9) linked.push({ d, i: k }); });
    });
    const pIdx = barIdxAtOrBefore(p.time);
    drag = { linked, hadEval, before: linked.map(L => Object.assign({}, L.d.points[L.i])), pIdx, x0: x };
    evalToken++;
    sketchEval = null;
    // 端点按光标的像素位移 ÷ 每根K线宽度移动，不会先跳到光标处
    lockChart(true);
    setWaveStatus('✋ 拖动端点：左右移动换K线（不越过相邻点），价格取该K线的高/低点；松开后固定在这根K线上，不再自动吸附 · Esc 取消');
  }
  function moveDrag(e) {
    const ts = waveChart.timeScale();
    const v = ts.getVisibleLogicalRange();
    if (!v) return;
    const spacing = ts.width() / Math.max(1, v.to - v.from);
    const hit = { index: drag.pIdx + Math.round((e.clientX - chartRect().left - drag.x0) / spacing) };
    let lo = 0, hi = currentBars.length - 1;
    drag.linked.forEach(L => {
      const pts = L.d.points;
      if (L.i > 0) lo = Math.max(lo, barIdxAtOrBefore(pts[L.i - 1].time) + 1);
      if (L.i < pts.length - 1) hi = Math.min(hi, barIdxAtOrBefore(pts[L.i + 1].time) - 1);
    });
    if (lo > hi) return;
    const k = Math.max(lo, Math.min(hi, hit.index));
    const b = currentBars[k];
    drag.linked.forEach(L => {
      const q = L.d.points[L.i];
      L.d.points[L.i] = { time: b.time, price: q.type === 'high' ? b.high : b.low, type: q.type, fixed: true };
    });
    renderChart();
  }
  function endDrag(cancel) {
    const dr = drag;
    drag = null;
    lockChart(false);
    if (cancel) dr.linked.forEach((L, k) => { L.d.points[L.i] = dr.before[k]; });
    const moved = dr.linked.some((L, k) => L.d.points[L.i].time !== dr.before[k].time);
    invalidateEval();
    if (cancel || !moved) {
      setWaveStatus(cancel ? '已取消拖动' : '端点没有移动');
      if (dr.hadEval) evaluateAll(); // 恢复拖动前的评估
      return;
    }
    const p = dr.linked[0].d.points[dr.linked[0].i];
    setWaveStatus(`✓ 端点已移到 ${fmtP(p.price)}，固定在这根K线上${dr.hadEval ? '，正在重新评估…' : '，点「评估全部」评估'}`);
    if (dr.hadEval) evaluateAll();
  }
  function cancelDrag() { if (drag) endDrag(true); }

  // ---------------------------------------------------------------------------
  // 框选分析: 在图上拖动框选一段K线 (至少 10 根)，引擎列出最符合手稿规则的数法
  // ---------------------------------------------------------------------------
  const BOX_MIN_BARS = 10;
  function setBoxMode(on, msg) {
    boxMode = on;
    if (on && drawTool) cancelDrawing();
    const btn = document.getElementById('btn-box-analyze');
    if (btn) btn.classList.toggle('active', on);
    const container = document.getElementById('wave-chart-container');
    if (container) container.style.cursor = on ? 'crosshair' : (drawTool ? 'crosshair' : 'default');
    if (msg) setWaveStatus(msg);
  }
  /** 选区色块: 按当前周期的K线位置画，图表平移 / 缩放 / 换周期后跟着移动 */
  function positionBox() {
    const container = document.getElementById('wave-chart-container');
    if (!container) return;
    let el = document.getElementById('wave-box-overlay');
    const sel = boxSel;
    if (!sel || !waveChart || !currentBars.length) { if (el) el.style.display = 'none'; return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'wave-box-overlay';
      el.className = 'wave-box-overlay';
      container.appendChild(el);
    }
    const ts = waveChart.timeScale();
    const i0 = barIdxAtOrBefore(Math.min(sel.t0, sel.t1)), i1 = barIdxAtOrBefore(Math.max(sel.t0, sel.t1) + (TF_SEC[sel.tf] || 0) - 1);
    // logicalToCoordinate 只接受整数位置 (lightweight-charts 5.x 对小数位置返回 0)：取两端K线中心，再各向外扩半根
    const xa = ts.logicalToCoordinate(i0), xb = ts.logicalToCoordinate(i1);
    if (xa === null || xb === null) { el.style.display = 'none'; return; }
    const spacing = i1 > i0 ? (xb - xa) / (i1 - i0) : (ts.options().barSpacing || 6);
    const offset = chartRect().left - container.getBoundingClientRect().left;
    el.style.display = 'block';
    el.style.left = `${offset + xa - spacing / 2}px`;
    el.style.width = `${Math.max(2, xb - xa + spacing)}px`;
    el.dataset.bars = String(i1 - i0 + 1);
  }
  function boxBars() {
    if (!boxSel) return 0;
    return barIdxAtOrBefore(Math.max(boxSel.t0, boxSel.t1)) - barIdxAtOrBefore(Math.min(boxSel.t0, boxSel.t1)) + 1;
  }
  function clearBox(msg) {
    boxToken++;
    boxSel = null; boxResult = null; boxPreview = null; boxDrag = null;
    lockChart(false);
    positionBox();
    renderChart();
    renderBoxResult();
    if (msg) setWaveStatus(msg);
  }
  async function runBoxAnalysis() {
    const t0 = Math.min(boxSel.t0, boxSel.t1), t1 = Math.max(boxSel.t0, boxSel.t1), tf = currentTf, symbol = currentSymbol;
    const token = ++boxToken;
    boxPreview = null;
    boxResult = { tf, t0, t1, busy: true };
    renderBoxResult();
    setWaveStatus(`🔍 正在分析框选的 ${boxBars()} 根 ${tf.toUpperCase()} K线（逐个浪型做画浪评估，约需几秒）…`);
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const subs = SKETCH_SUB_TFS[tf] || [];
      const fetched = await Promise.all(subs.map(k => {
        const need = Math.ceil((nowSec - t0) / TF_SEC[k]) + 400;
        return fetchAuxBars(symbol, k, need <= 1000 ? 1000 : WAVE_BARS).catch(() => null);
      }));
      const barsByTf = { [tf]: currentBars };
      subs.forEach((k, i) => { if (fetched[i] && fetched[i].length) barsByTf[k] = fetched[i]; });
      const opts = { timeframe: tf, startTime: t0, endTime: t1, maxOut: 3 };
      let res;
      try { res = await runInWorker('analyzeRange', barsByTf, symbol, opts); } catch (e) {
        if (e.input) throw e;
        if (!window.LiuWaveEngine || !window.LiuWaveEngine.analyzeRange) throw new Error('本地波浪引擎不可用');
        res = window.LiuWaveEngine.analyzeRange(barsByTf, symbol, opts);
      }
      if (token !== boxToken) return;
      boxResult = { tf, t0, t1, res };
      const top = res.candidates[0];
      setWaveStatus(top ? `✓ 框选分析完成：最符合手稿规则的是「${top.name}」（${top.verdictLabel}），共 ${res.total} 种成立 / 存疑的数法` : '框选分析完成：框内没有铁律都通过的数法');
    } catch (err) {
      if (token !== boxToken) return;
      boxResult = { tf, t0, t1, error: err.message || String(err) };
      setWaveStatus(`❌ 框选分析失败：${boxResult.error}`);
    }
    renderBoxResult();
    renderChart();
  }
  function finishBox() {
    boxDrag = null;
    lockChart(false);
    setBoxMode(false);
    const n = boxBars();
    if (n < BOX_MIN_BARS) {
      boxSel = null;
      positionBox();
      setWaveStatus(`框选区间只有 ${n} 根K线，请框选至少 ${BOX_MIN_BARS} 根`);
      return;
    }
    runBoxAnalysis();
  }
  function renderBoxResult() {
    const el = document.getElementById('wave-box-result');
    if (!el) return;
    const b = boxResult;
    if (!b) { el.innerHTML = ''; return; }
    const head = `<div class="liu-signal-title"><span>框选分析 · ${esc(b.tf.toUpperCase())} · ${esc(fmtT(b.t0).slice(5))} ~ ${esc(fmtT(b.t1).slice(5))}</span><span><button class="chart-tool-btn" data-box-close title="关闭框选结果">关闭</button></span></div>`;
    let body;
    if (b.busy) body = '<div class="ue-note">正在分析：在框内的起点与终点之间，对每种浪型重新数浪并做画浪评估…</div>';
    else if (b.error) body = `<div class="ue-note">无法分析：${esc(b.error)}</div>`;
    else {
      const r = b.res;
      const dirs = r.directions.map(x => `${x.dir === 'UP' ? '上涨' : '下跌'} ${fmtP(x.start.price)} → ${fmtP(x.end.price)}`).join(' / ');
      const cards = r.candidates.map((c, k) => {
        const st = VERDICT_STYLE[c.verdict] || VERDICT_STYLE.DOUBT;
        const on = boxPreview === k;
        const meta = [k === 0 ? '最符合手稿规则' : `第 ${k + 1}`, c.guidePct != null ? `指引符合度 ${c.guidePct}%` : '', c.unusual ? '非常规浪型' : ''].filter(Boolean).join(' · ');
        return `<div class="ue-sug${on ? ' active' : ''}">
          <div class="liu-signal-title"><span>${esc(c.name)}</span><span class="liu-chip ${st.chip}">${esc(c.verdictLabel)}</span></div>
          <div class="ue-note">${esc(meta)}</div>
          <div class="ue-line">${c.points.map(p => `${esc(p.label || '')} ${fmtP(p.price)}（${esc(fmtT(p.time).slice(5, 10))}）`).join(' → ')}</div>
          ${c.doubt ? `<div class="ue-note">存疑：${esc(c.doubt)}</div>` : ''}
          <div class="wave-type-switch">
            <button class="chart-tool-btn${on ? ' active' : ''}" data-box-preview="${k}" title="在图上用绿色虚线显示这个数法">${on ? '取消预览' : '预览'}</button>
            <button class="chart-tool-btn" data-box-adopt="${k}" title="把这个数法加入画板并整体评估">采用</button>
          </div>
        </div>`;
      }).join('');
      body = `<div class="ue-note">${r.barsCount} 根K线 · ${esc(dirs)} · 共 ${r.total} 种成立 / 存疑的数法${r.total > r.candidates.length ? `，显示前 ${r.candidates.length} 种` : ''}</div>` +
        (cards || '<div class="ue-note">框内没有铁律都通过的数法</div>') +
        (r.notes && r.notes.length ? `<div class="ue-note">${esc(r.notes.join('；'))}</div>` : '') +
        `<div class="ue-note">${esc(r.basis)}</div>`;
    }
    el.innerHTML = `<div class="liu-signal-row">${head}${body}</div>`;
  }

  function setupDrawing(container) {
    let down = null;
    // 捕获阶段: 先于图表自身的平移处理，抓住端点时关掉平移
    container.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      const x = e.clientX - chartRect().left;
      if (boxMode) {
        const hit = getBarFromCoordinate(x);
        if (!hit) return;
        e.preventDefault();
        e.stopPropagation();
        lockChart(true);
        boxDrag = { i0: hit.index };
        boxResult = null; boxPreview = null;
        boxSel = { t0: hit.time, t1: hit.time, tf: currentTf };
        positionBox();
        renderBoxResult();
        return;
      }
      if (drawTool) { down = { x: e.clientX, y: e.clientY }; return; }
      const hp = pointNear(e);
      if (!hp) return;
      if (!hp.movable) { setWaveStatus(`该浪画在 ${hp.d.timeframe.toUpperCase()}，切换到 ${hp.d.timeframe.toUpperCase()} 后才能拖动它的端点`); return; }
      e.preventDefault();
      e.stopPropagation();
      startDrag(hp, x);
    }, true);
    window.addEventListener('mouseup', e => {
      if (boxDrag) { finishBox(); return; }
      if (drag) { endDrag(false); return; }
      if (!down) return;
      const dist = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (!drawTool || !(e.target instanceof Node) || !container.contains(e.target) || dist > 6) return; // 平移 / 缩放图表，不是点击
      const hit = hitFromEvent(e);
      if (hit) addDrawPoint(hit);
    });
    container.addEventListener('mousemove', e => {
      if (boxDrag) {
        const hit = getBarFromCoordinate(e.clientX - chartRect().left);
        if (hit) { boxSel.t1 = hit.time; positionBox(); setWaveStatus(`框选中：${boxBars()} 根 ${currentTf.toUpperCase()} K线（至少 ${BOX_MIN_BARS} 根），松开左键开始分析`); }
        return;
      }
      if (boxMode) return;
      if (drag) { moveDrag(e); return; }
      if (!drawTool) {
        const hp = pointNear(e);
        container.style.cursor = hp ? (hp.movable ? 'grab' : 'not-allowed') : 'default';
        return;
      }
      if (!drawPoints.length) return;
      const hit = hitFromEvent(e);
      if (!hit || hit.index <= drawPoints[drawPoints.length - 1].index) { drawHover = null; renderActive(); return; }
      const preview = resnapDrawPoints(drawPoints.map(p => Object.assign({}, p)).concat([Object.assign({}, hit)]));
      drawHover = preview[preview.length - 1];
      renderActive();
    });
    container.addEventListener('dblclick', () => { if (drawTool && drawPoints.length >= 3) commitDrawing(); });
    // 右键取消正在画的浪；没有在画时保留浏览器右键菜单
    container.addEventListener('contextmenu', e => {
      if (drag) { e.preventDefault(); cancelDrag(); return; }
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
      `画在某个浪的一段之内即为它的子浪 · 画完后可拖动端点修改 · Esc / 右键取消`);
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
      id: `d${++sketchSeq}`, tool: drawTool, timeframe: currentTf, type: null, // type: 用户指定的浪型 (null = 自动)
      points: drawPoints.map(p => ({ time: p.time, price: p.price, type: p.type }))
    };
    sketch.push(d);
    drawTool = null;
    drawPoints = [];
    drawHover = null;
    invalidateEval();
    const rel = relationOf(d.id);
    const partial = d.points.length < tool.labels.length ? `未画满（画到「${tool.labels[d.points.length - 1]}」），末浪按运行中，评估后可看其余各浪的假设推演。` : '';
    setWaveStatus(`✓ 已加入「${tool.name}」（${d.timeframe.toUpperCase()}${rel ? ' · ' + rel : ' · 母浪'}）。${partial}` +
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
    saveSketch();
    previewSug = null;
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
  // 本机保存: 每个标的一份画板；每个画法 (标的 + 周期 + 工具 + 指定浪型 + 各点) 一份评估快照与改判记录
  // ---------------------------------------------------------------------------
  const STORE_SKETCH = 'wave8.sketch.v1';
  const STORE_LIFE = 'wave8.lifecycle.v1';
  function storeGet(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function storeSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 隐私模式 / 存储已满 */ } }
  function saveSketch() {
    const all = storeGet(STORE_SKETCH) || {};
    all[currentSymbol] = { seq: sketchSeq, drawings: sketch };
    storeSet(STORE_SKETCH, all);
  }
  function restoreSketch(symbol) {
    const s = (storeGet(STORE_SKETCH) || {})[symbol];
    sketch = s && Array.isArray(s.drawings)
      ? s.drawings.filter(d => d && DRAW_TOOLS[d.tool] && TF_SEC[d.timeframe] && Array.isArray(d.points) && d.points.length >= 2) : [];
    sketchSeq = Math.max((s && s.seq) || 0, 0, ...sketch.map(d => +String(d.id).replace(/\D/g, '') || 0));
  }
  function drawKey(d) {
    return [currentSymbol, d.timeframe, d.tool, d.type || '', d.points.map(p => `${p.time}:${p.price}`).join(',')].join('|');
  }
  function lifeOf(d) { return d ? (storeGet(STORE_LIFE) || {})[drawKey(d)] || null : null; }
  /** 记下本次评估: 有新K线才更新快照，改判事件追加到该画法的记录里 */
  function recordLife(res) {
    const all = storeGet(STORE_LIFE) || {};
    res.nodes.forEach(nd => {
      const d = sketch.find(x => x.id === nd.id);
      if (!d || !nd.snapshot) return;
      const k = drawKey(d);
      const cur = all[k] || { first: nd.snapshot.at, log: [] };
      cur.seen = Date.now();
      all[k] = cur;
      if (cur.snap && !(nd.snapshot.at > cur.snap.at)) return;
      if (nd.lifecycle && nd.lifecycle.events.length) cur.log.push({ at: nd.snapshot.at, since: nd.lifecycle.since, events: nd.lifecycle.events });
      cur.log = cur.log.slice(-30);
      cur.snap = nd.snapshot;
    });
    Object.keys(all).sort((a, b) => (all[b].seen || 0) - (all[a].seen || 0)).slice(60).forEach(k => { delete all[k]; });
    storeSet(STORE_LIFE, all);
  }
  function fmtT(t) {
    const d = new Date(t * 1000), z = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
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
    const drawings = sketch.map(d => ({ id: d.id, tool: d.tool, timeframe: d.timeframe, type: d.type || null, points: d.points.map(p => ({ time: p.time, price: p.price, fixed: !!p.fixed })),
      prev: (lifeOf(d) || {}).snap || null }));
    setWaveStatus(`⏳ 正在整体评估 ${drawings.length} 个浪：每个浪的铁律 / 低周期子浪 / 走势检验，以及母子级别一致性…`);
    const badge = document.getElementById('wave-user-eval-badge');
    if (badge) { badge.className = 'card-badge badge-neutral'; badge.textContent = '评估中…'; }

    let res = null, err = null, tried = false, dataBlocked = false;
    try {
      res = await evaluateSketchClientSide(currentSymbol, drawings);
      tried = !!res;
    } catch (e) {
      tried = true;
      err = e.message;
      dataBlocked = !!e.dataUnavailable;
    }
    if (!tried) {
      try {
        const r = await fetch('/api/wave/evaluate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol: currentSymbol.replace(/[\/\-_]/g, '').toUpperCase(), drawings }),
          signal: AbortSignal.timeout(60000)
        });
        const j = await r.json();
        if (j && j.code === 0) res = j;
        else {
          dataBlocked = j && j.status === 'data_unavailable';
          err = dataBlocked ? '数据过期或不可用，暂停当前研判' : ((j && j.error) || `HTTP ${r.status}`);
        }
      } catch (e) { err = e.message || '网络连接超时'; }
    }
    if (token !== evalToken) return; // 评估期间画板已变化
    if (!res) {
      // 评估失败/被健康门禁：先清掉旧结论——上一次的目标位/置信度不得
      // 以当前结论继续显示，renderChart 也不得复活旧 prediction。
      sketchEval = null;
      selectedId = null;
      renderChart();
      renderPanel(err);
      if (dataBlocked && window.DataHealthUI) window.DataHealthUI.fail('wave', new Error(err));
      setWaveStatus(`❌ 评估失败：${err}`);
      return;
    }
    recordLife(res);
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

    // 1.5 预览的替代计数 (绿色长虚线)
    const pv = previewSug && nodeOf(previewSug.id);
    let sg = pv && pv.suggestions && pv.suggestions[previewSug.k];
    let sgTf = pv ? pv.timeframe : null;
    if (!sg && boxPreview !== null && boxResult && boxResult.res) { sg = boxResult.res.candidates[boxPreview]; sgTf = boxResult.tf; }
    if (previewSeries) {
      const disp = sg ? sg.points.map(p => displayPoint(p, sgTf)) : [];
      previewSeries.setData(sg ? toLineData(disp) : []);
      if (sg && showMarkers) {
        disp.forEach((p, i) => {
          if (!p || !i) return;
          markers.push({ time: p.time, position: p.type === 'high' ? 'aboveBar' : 'belowBar', color: '#10b981', shape: 'circle', text: sg.points[i].label, size: 0.9 });
        });
      }
    }

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

    // 3.5 所选楔形的 2-4 通道线: 从浪2 经浪4 延伸到最新K线之后几根
    if (channelSeries) {
      const ch = sel && sel.result && sel.result.invalidation && sel.result.invalidation.channel;
      const cd = [];
      if (ch && showMonitoring && currentBars.length) {
        const sec = TF_SEC[currentTf] || 14400;
        const priceAt = t => ch.from.price + ch.slopePerBar * (t - ch.from.time) / (ch.tfSec || sec);
        const t0 = currentBars[barIdxAtOrBefore(ch.from.time)].time;
        const t1 = currentBars[currentBars.length - 1].time + 6 * sec;
        cd.push({ time: t0, value: priceAt(ch.from.time) }, { time: t1, value: priceAt(t1) });
      }
      channelSeries.setData(cd);
    }

    // 4. 所选浪的假设推演: 中值路径 (可延伸到最新K线之后)，各浪标注常见区间
    const proj = sel && sel.result && sel.result.projection;
    if (projSeries) {
      const data = [], pm = [];
      if (proj && showProjection && currentBars.length) {
        const sec = TF_SEC[currentTf] || 14400;
        const lastT = currentBars[currentBars.length - 1].time;
        proj.path.forEach((p, i) => {
          // 已有K线之内落到所在K线，之后按周期对齐
          const t = p.time <= lastT + sec ? currentBars[barIdxAtOrBefore(p.time)].time : Math.floor(p.time / sec) * sec;
          const prev = data[data.length - 1];
          if (prev && t <= prev.time) { prev.value = p.price; return; }
          data.push({ time: t, value: p.price });
          const w = i > 0 ? proj.waves[i - 1] : null;
          if (w && showMarkers) {
            const up = w.zone.mid > w.start.price;
            pm.push({ time: t, position: up ? 'aboveBar' : 'belowBar', color: '#f59e0b', shape: 'circle', size: 0.8,
              text: `${w.label}? ${w.min && !w.min.reached ? `最低 ${Math.round(w.min.price).toLocaleString()} · ` : ''}常见 ${(w.common || []).map(c => Math.round(c.price).toLocaleString()).join(' / ')}` });
          }
        });
      }
      projSeries.setData(data);
      setChartMarkers(projSeries, pm);
    }

    markers.sort((a, b) => a.time - b.time);
    setChartMarkers(candleSeries, markers);
    positionBox();

    removePriceLines();
    if (sel && sel.result) {
      const r = sel.result, v = sel.verdict;
      const inv = r.invalidation || {};
      const tag = sketchEval.nodes.length > 1 ? `·${DRAW_TOOLS[sel.tool].labels.slice(1).join('')}` : '';
      if (showMonitoring && inv.structural && (v === 'VALID' || v === 'DOUBT')) {
        userPriceLines.push(candleSeries.createPriceLine({ price: inv.structural.price, color: '#ef4444', lineWidth: 2, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: `计数否定位${tag}` }));
      }
      if (showMonitoring && inv.leg && (v === 'VALID' || v === 'DOUBT')) {
        userPriceLines.push(candleSeries.createPriceLine({ price: inv.leg.price, color: '#fb923c', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: `${inv.leg.kind === 'continuation' ? '延续线' : '本段防线'}${tag}` }));
      }
      if (showMonitoring && inv.ceiling && (v === 'VALID' || v === 'DOUBT')) {
        userPriceLines.push(candleSeries.createPriceLine({ price: inv.ceiling.price, color: '#ef4444', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: `顺势否定位${tag}` }));
      }
      if (showMonitoring && inv.warn && (v === 'VALID' || v === 'DOUBT')) {
        userPriceLines.push(candleSeries.createPriceLine({ price: inv.warn.price, color: '#eab308', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted, axisLabelVisible: true, title: `警戒位${tag}` }));
      }
      if (showMonitoring && inv.monitor && v !== 'INVALID') {
        userPriceLines.push(candleSeries.createPriceLine({ price: inv.monitor.price, color: '#f59e0b', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: `柳氏监测点(${inv.monitor.source || sel.timeframe})` }));
      }
      if (showMonitoring && inv.completion) {
        userPriceLines.push(candleSeries.createPriceLine({ price: inv.completion.price, color: '#0ea5e9', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: inv.completion.broken ? '完成确认位（已越过）' : '完成确认位' }));
      }
      if (showMonitoring && inv.completionLiu) {
        userPriceLines.push(candleSeries.createPriceLine({ price: inv.completionLiu.price, color: '#7dd3fc', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted, axisLabelVisible: true, title: inv.completionLiu.broken ? '柳氏确认位（已越过）' : '柳氏确认位' }));
      }
      if (showMonitoring && inv.diagLimit && v !== 'INVALID') {
        userPriceLines.push(candleSeries.createPriceLine({ price: inv.diagLimit.price, color: '#a855f7', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: inv.diagLimit.expandingByLength ? '楔形浪4分歧位' : '楔形浪4上限' }));
      }
      if (proj && showProjection && proj.invalidation) {
        userPriceLines.push(candleSeries.createPriceLine({ price: proj.invalidation.price, color: '#f59e0b', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: '推演失效' }));
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
            <span class="wave-sketch-name">${it.depth ? '└ ' : ''}${esc(nd ? nd.name : DRAW_TOOLS[d.tool].name)}${d.type ? '（指定）' : ''}</span>
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
        : `<p class="liu-idle">选择上方画浪工具（推动浪 12345 / abc / wxy / w-x-y-xx-z / 三角形 abcde），在图上依次点击各浪端点。同一种画法可对应多种浪型（abc 可以是单锯齿或平台形），评估后可在详情里指定。<br>
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

  // 历史命中率比随机游走高 (低) 不到 5 个百分点时没有区分度，不显示
  const trackTxt = tr => tr && Math.abs(tr.hitPct - tr.expectedPct) >= 5 ? `历史上同类计数先到目标 ${tr.hitPct}%（随机 ${tr.expectedPct}%）` : '';

  function userEvalHtml(r, nd) {
    const st = VERDICT_STYLE[nd.verdict] || VERDICT_STYLE.DOUBT;
    const lines = ((r.commentary && r.commentary.lines) || []).filter(l => !/^只讨论波浪/.test(l));
    const verdictHtml = `
      <div class="liu-signal-row">
        <div class="liu-signal-title"><span>柳氏研判 · ${esc(r.primary.name)}（${esc(nd.timeframe.toUpperCase())}）</span><span class="liu-chip ${st.chip}">${esc(nd.verdictLabel)}</span></div>
        ${lines.map(l => `<div class="ue-line">${esc(l)}</div>`).join('')}
      </div>`;

    // 判定浪型: 同一画法可对应多种浪型 (abc=单锯齿/平台形，wxy=双锯齿/联合形…)，自动择优或由用户指定
    const opts = r.toolTypes || [];
    // 锯齿类 / 横向整理 的区分依据 (wxy、w-x-y-xx-z)
    const dsc = r.discrimination;
    const typeHtml = opts.length > 1 ? `
      <div class="liu-signal-row">
        <div class="liu-signal-title"><span>判定浪型</span><span>${r.forcedType ? '已指定' : '自动择优'}</span></div>
        <div class="wave-type-switch">
          <button class="chart-tool-btn${!r.forcedType ? ' active' : ''}" data-force="" data-node="${esc(nd.id)}" title="在各浪型中按铁律、子浪结构、指引符合度自动选择">自动</button>
          ${opts.map(o => `<button class="chart-tool-btn${r.forcedType === o.type ? ' active' : ''}" data-force="${esc(o.type)}" data-node="${esc(nd.id)}" title="只按「${esc(o.name)}」评估">${esc(o.name)}</button>`).join('')}
        </div>
        ${!r.forcedType && r.primary ? `<div class="ue-note">自动选择了「${esc(r.primary.name)}」。若你画的是另一种，点上面的按钮指定后会重新整体评估。</div>` : ''}
        ${dsc ? `<div class="ue-note">区分依据（锯齿类 vs 横向整理）：</div>
          ${dsc.steps.map(x => `<div class="ue-line">${x.decisive ? '✗' : '·'} ${esc(x.basis)} → ${x.supportsName ? esc(x.supportsName) : '两者皆可'}</div>`).join('')}
          <div class="ue-note">${esc(dsc.reason)}</div>` : ''}
      </div>` : '';

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
    if (inv.monitor) lvRows.push(['监测点（柳氏）', inv.monitor.price, inv.monitor.text]);
    if (inv.confirm) lvRows.push([inv.confirm.crossed ? '确认位（柳氏，已越过）' : '确认位（柳氏）', inv.confirm.price, inv.confirm.text]);
    if (inv.leg) lvRows.push([inv.leg.kind === 'continuation' ? '延续线' : '本段防线', inv.leg.price, inv.leg.text]);
    if (inv.structural) lvRows.push(['计数否定位', inv.structural.price, inv.structural.text]);
    if (inv.ceiling) lvRows.push(['顺势否定位', inv.ceiling.price, inv.ceiling.text]);
    if (inv.warn) lvRows.push(['警戒位', inv.warn.price, inv.warn.text]);
    if (inv.secondary) lvRows.push(['次级防线', inv.secondary.price, inv.secondary.text]);
    if (inv.channel) lvRows.push(['2-4 通道线', inv.channel.price, inv.channel.text]);
    if (inv.diagLimit) lvRows.push([inv.diagLimit.expandingByLength ? '楔形浪4分歧位' : '楔形浪4上限', inv.diagLimit.price, inv.diagLimit.text]);
    if (inv.completion) lvRows.push([inv.completion.broken ? '完成确认位（已越过）' : '完成确认位', inv.completion.price, inv.completion.text]);
    if (inv.completionLiu) lvRows.push([inv.completionLiu.broken ? '柳氏确认位（已越过）' : '柳氏确认位', inv.completionLiu.price, inv.completionLiu.text]);
    (r.targets || []).slice(0, 4).forEach(t => lvRows.push(['目标', t.price, t.label]));
    const lvHtml = lvRows.length ? `
      <div class="liu-signal-row">
        <div class="liu-signal-title"><span>监测点 · 防线 · 否定位 · 目标</span><span>现价 ${fmtP(r.currentPrice)}</span></div>
        <table class="liu-parts-table">${lvRows.map(x => `<tr><td>${x[0]}</td><td class="num">${fmtP(x[1])}</td><td>${esc(x[2])}</td></tr>`).join('')}</table>
      </div>` : '';

    const hard = (r.primary.ruleChecks || []).filter(c => c.hard);
    const failed = hard.filter(c => !c.pass && !c.pending && !c.near);
    const nearly = hard.filter(c => c.near);
    const rulesHtml = `
      <div class="liu-signal-row">
        <div class="liu-signal-title"><span>手稿铁律</span><span class="liu-chip ${failed.length ? 'neg' : nearly.length ? 'warn' : 'pos'}">${hard.length - failed.length - nearly.length}/${hard.length} 通过</span></div>
        ${failed.length || nearly.length ? '' : '<div class="ue-line">全部通过</div>'}
        ${failed.map(c => `<div class="ue-line">✗ ${esc(c.text)}（${esc(c.page)}）${c.detail ? '：' + esc(c.detail) : ''}</div>`).join('')}
        ${nearly.map(c => `<div class="ue-line">≈ ${esc(c.text)}（${esc(c.page)}）${c.detail ? '：' + esc(c.detail) : ''}${c.margin != null ? `，只差阈值的 ${(100 * c.margin).toFixed(1)}%（容差带内，判存疑）` : ''}</div>`).join('')}
        ${(r.primary.liveHardFails || []).map(f => `<div class="ue-line">走势检验 ✗ ${esc(f.text)}（${esc(f.page)}）：${esc(f.detail)}</div>`).join('')}
      </div>`;

    const other = [];
    (r.interpretations || []).forEach(it => other.push(`${esc(it.name)}：铁律违规 ${it.hardFails} · 子浪证伪 ${it.strong} · 存疑 ${it.medium}`));
    if (nd.verdict === 'VALID') (r.alternatives || []).forEach(a => other.push(`同样的点按「${esc(a.name)}」可成立`));
    if (r.preceding && !r.preceding.warning) other.push(`前序：${esc(r.preceding.text)}`);
    if (r.reclassify && r.reclassify.weak) other.push(`提示（回测无区分度）：${esc(r.reclassify.text.replace(/（[^（]*(区分度不显著|无预测力)[^）]*）$/, ''))}`);
    (r.adjustments || []).forEach(a => other.push(`「${esc(a.point)}」点已吸附：${fmtP(a.fromPrice)} → ${fmtP(a.toPrice)}${a.barsMoved ? `（移动 ${a.barsMoved} 根）` : ''}`));
    (r.endpointIssues || []).forEach(x => other.push(esc(x.text)));
    const otherHtml = other.length ? `
      <div class="liu-signal-row">
        <div class="liu-signal-title"><span>其它解读 · 取点</span></div>
        ${other.map(t => `<div class="ue-line">${t}</div>`).join('')}
      </div>` : '';

    // 计数记录: 同一画法历次评估之间的改判与触发它的价格事件 (本机保存)
    const life = lifeOf(sketch.find(x => x.id === nd.id));
    const log = life ? life.log.slice().reverse() : [];
    const lifeHtml = !log.length && !(life && life.snap && life.snap.at !== life.first) ? '' : `
      <div class="liu-signal-row">
        <div class="liu-signal-title"><span>计数记录</span><span>${life ? `首次评估 ${esc(fmtT(life.first))} · 本机保存` : '本机保存'}</span></div>
        ${log.length ? log.map(x => x.events.map(e => `<div class="ue-line">${esc(fmtT(x.at))} · ${esc(e.text)}</div>`).join('')).join('')
          : `<div class="ue-note">${life && life.snap && life.snap.at !== life.first ? `自 ${esc(fmtT(life.first))} 以来浪型、判决都没有变化` : '首次评估。之后再评估同一画法时，会记下上次预测的结局、浪型或判决的改变，以及触发改变的价格事件'}</div>`}
      </div>`;

    // 更可能的浪型: 所画计数存疑 / 否决时，引擎在所画起点、终点之间找到的其它数法
    const sugs = nd.suggestions || [];
    const sugHtml = nd.verdict !== 'VALID' && nd.verdict !== 'ERROR' ? `
      <div class="liu-signal-row">
        <div class="liu-signal-title"><span>更可能的浪型</span><span>${sugs.length ? '按画浪规则重新验证' : ''}</span></div>
        ${sugs.length ? sugs.map((sg, k) => {
          const on = previewSug && previewSug.id === nd.id && previewSug.k === k;
          const st = VERDICT_STYLE[sg.verdict] || VERDICT_STYLE.DOUBT;
          const meta = [sg.source === 'SAME_POINTS' ? '同样的点换浪型' : sg.source === 'REGROUP' ? '起点不变、升一级重数' : '中间重新数', sg.unusual ? '非常规浪型' : '',
            sg.guidePct != null ? `指引符合度 ${sg.guidePct}%` : '',
            trackTxt(sg.trackRecord)].filter(Boolean).join(' · ');
          return `<div class="ue-sug${on ? ' active' : ''}">
            <div class="liu-signal-title"><span>${esc(sg.name)}</span><span class="liu-chip ${st.chip}">${esc(sg.verdictLabel)}</span></div>
            <div class="ue-note" title="指引符合度：比率、时间与手稿常见值的吻合程度；BTC / ETH 回放中它对后续走势没有可证实的预测力，不是命中概率">${esc(meta)}</div>
            <div class="ue-line">${sg.points.map(p => `${esc(p.label)} ${fmtP(p.price)}（${esc(fmtT(p.time).slice(5, 10))}）`).join(' → ')}</div>
            ${sg.doubt ? `<div class="ue-note">存疑：${esc(sg.doubt)}</div>` : ''}
            ${sg.forecast ? `<div class="ue-note">${esc(sg.forecast)}</div>` : ''}
            <div class="wave-type-switch">
              <button class="chart-tool-btn${on ? ' active' : ''}" data-sg-preview="${k}" data-node="${esc(nd.id)}" title="在图上用绿色虚线显示这个计数">${on ? '取消预览' : '预览'}</button>
              <button class="chart-tool-btn" data-sg-adopt="${k}" data-node="${esc(nd.id)}" title="用这个计数替换你画的浪，并重新整体评估">采用</button>
            </div>
          </div>`;
        }).join('') : '<div class="ue-note">在你画的起点和终点之间，没有找到判决比你的计数更好、且结构干净的其它数法</div>'}
      </div>` : '';

    // 假设推演: 提前结束或末浪运行中时，其余各浪的常见区间与时间窗口
    const pj = r.projection;
    const projHtml = pj ? `
      <div class="liu-signal-row">
        <div class="liu-signal-title"><span>假设推演 · ${esc(pj.name)}</span><span>手稿常见比率 · 中值衔接</span></div>
        <table class="liu-parts-table"><tr><td>浪</td><td>价格</td><td>常见结束时间</td></tr>
          ${pj.waves.map(w => `<tr><td>${esc(w.label)}${w.running ? '（运行中）' : ''}</td><td>${w.min ? `<div>最低 <span class="num">${fmtP(w.min.price)}</span>${w.min.reached ? '（已达到）' : ''} · ${esc(w.min.text)}</div>` : ''}${w.need ? `<div>${esc(w.need.text)}：<span class="num">${fmtP(w.need.price)}</span></div>` : ''}<div>常见 ${(w.common || []).map(c => `<span class="num">${fmtP(c.price)}</span>（${esc(c.label)}）`).join(' / ')}</div></td><td>${esc(fmtT(w.window.from).slice(5))} ~ ${esc(fmtT(w.window.to).slice(5))}</td></tr>
            <tr><td colspan="3" class="ue-note">${esc(w.basis)}${w.inv ? `；失效 ${fmtP(w.inv.price)}：${esc(w.inv.text)}` : ''}${w.note ? `；${esc(w.note)}` : ''}</td></tr>`).join('')}
        </table>
        <div class="ue-note">「最低」是手稿硬规则，「常见」是常见比率（不是最低要求）。每一浪按前一浪的中值推出，越往后越不确定；图上橙色虚线为中值路径（工具栏「假设推演」可隐藏）。这是在你的计数成立的假设下的常见走法，不是预测。</div>
      </div>` : '';

    // 并列假设: 同样的点的并列解读 (调整浪 / 驱动浪前三浪；双锯齿 / 横向整理)，及区分条件
    const hyps = r.hypotheses || [];
    const hypHtml = hyps.length ? `
      <div class="liu-signal-row">
        <div class="liu-signal-title"><span>并列假设</span><span>同样的点 · 并列解读</span></div>
        ${hyps.map((h, k) => {
          const st = VERDICT_STYLE[h.verdict] || VERDICT_STYLE.DOUBT;
          const meta = [h.isPrimary ? '当前评估' : '', h.guidePct != null ? `指引符合度 ${h.guidePct}%` : '',
            trackTxt(h.trackRecord)].filter(Boolean).join(' · ');
          return `<div class="ue-sug">
            <div class="liu-signal-title"><span>${esc(h.name)}</span><span class="liu-chip ${st.chip}">${esc(h.verdictLabel)}</span></div>
            <div class="ue-note" title="指引符合度：比率、时间与手稿常见值的吻合程度；BTC / ETH 回放中它对后续走势没有可证实的预测力，不是命中概率">${esc(meta)}</div>
            ${h.conditions.map(c => `<div class="ue-line">· ${esc(c)}</div>`).join('')}
            ${h.isPrimary ? '' : `<div class="wave-type-switch"><button class="chart-tool-btn" data-hyp-adopt="${k}" data-node="${esc(nd.id)}" title="用同样的点按这种解读重新评估">按此评估</button></div>`}
          </div>`;
        }).join('')}
      </div>` : '';

    return verdictHtml + sugHtml + hypHtml + projHtml + typeHtml + subHtml + lvHtml + rulesHtml + lifeHtml + otherHtml;
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
        // 换标的: 当前画板已保存，换成该标的上次的画板
        if (drawTool) cancelDrawing();
        if (boxSel || boxResult) clearBox();
        currentSymbol = sym;
        restoreSketch(sym);
        invalidateEval();
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
    toggle('btn-toggle-projection', () => showProjection, v => { showProjection = v; });

    document.querySelectorAll('.draw-tool-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tool = btn.dataset.tool;
        if (drawTool === tool) { cancelDrawing('已取消正在画的浪'); return; }
        if (boxMode) setBoxMode(false);
        startDrawing(tool);
      });
    });
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
    on('btn-draw-undo', () => undo());
    on('btn-draw-finish', () => commitDrawing());
    on('btn-draw-evaluate', () => evaluateAll());
    on('btn-draw-clear', () => clearSketch('已清除全部画浪'));
    on('btn-box-analyze', () => {
      if (boxMode) { setBoxMode(false, '已取消框选'); return; }
      setBoxMode(true, `🔍 框选分析：在图上按住左键拖动，框选至少 ${BOX_MIN_BARS} 根K线，松开后开始分析 · Esc 取消`);
    });
    const boxEl = document.getElementById('wave-box-result');
    if (boxEl) {
      boxEl.addEventListener('click', e => {
        if (e.target.closest('[data-box-close]')) { clearBox('已关闭框选结果'); return; }
        const pvBtn = e.target.closest('[data-box-preview]');
        if (pvBtn) {
          const k = +pvBtn.dataset.boxPreview;
          boxPreview = boxPreview === k ? null : k;
          previewSug = null;
          renderChart();
          renderBoxResult();
          return;
        }
        const adBtn = e.target.closest('[data-box-adopt]');
        if (adBtn && boxResult && boxResult.res) {
          const c = boxResult.res.candidates[+adBtn.dataset.boxAdopt];
          if (!c) return;
          const d = { id: `d${++sketchSeq}`, tool: c.tool, timeframe: boxResult.tf, type: c.type,
            points: c.points.map(p => ({ time: p.time, price: p.price, type: p.type, fixed: true })) };
          sketch.push(d);
          boxPreview = null;
          invalidateEval();
          renderBoxResult();
          setWaveStatus(`✓ 已把「${c.name}」加入画板，正在整体评估…`);
          evaluateAll().then(() => { if (nodeOf(d.id)) { selectedId = d.id; renderChart(); renderPanel(); } });
        }
      });
    }

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

    // 指定 / 取消指定某个浪的浪型 (例如 abc 按单锯齿或平台形)，然后重新整体评估
    const evalBody = document.getElementById('wave-user-eval-body');
    if (evalBody) {
      evalBody.addEventListener('click', e => {
        const pvBtn = e.target.closest('[data-sg-preview]');
        if (pvBtn) {
          const k = +pvBtn.dataset.sgPreview, id = pvBtn.dataset.node;
          previewSug = previewSug && previewSug.id === id && previewSug.k === k ? null : { id, k };
          renderChart();
          renderPanel();
          return;
        }
        const hyBtn = e.target.closest('[data-hyp-adopt]');
        if (hyBtn) {
          const nd = nodeOf(hyBtn.dataset.node);
          const h = nd && nd.result && nd.result.hypotheses && nd.result.hypotheses[+hyBtn.dataset.hypAdopt];
          const d = sketch.find(x => x.id === hyBtn.dataset.node);
          if (!h || !d) return;
          d.tool = h.tool;
          d.type = h.type;
          const keep = d.id;
          invalidateEval();
          setWaveStatus(`✓ 改按「${h.name.replace(/（.*$/, '')}」评估同样的点…`);
          evaluateAll().then(() => { if (nodeOf(keep)) { selectedId = keep; renderChart(); renderPanel(); } });
          return;
        }
        const adBtn = e.target.closest('[data-sg-adopt]');
        if (adBtn) {
          const nd = nodeOf(adBtn.dataset.node);
          const sg = nd && nd.suggestions && nd.suggestions[+adBtn.dataset.sgAdopt];
          const d = sketch.find(x => x.id === adBtn.dataset.node);
          if (!sg || !d) return;
          d.tool = sg.tool;
          d.type = sg.type;
          d.points = sg.points.map(p => ({ time: p.time, price: p.price, type: p.type, fixed: true }));
          const keep = d.id;
          invalidateEval();
          setWaveStatus(`✓ 已采用「${sg.name}」，正在重新整体评估…`);
          evaluateAll().then(() => { if (nodeOf(keep)) { selectedId = keep; renderChart(); renderPanel(); } });
          return;
        }
        const btn = e.target.closest('[data-force]');
        if (!btn) return;
        const d = sketch.find(x => x.id === btn.dataset.node);
        if (!d) return;
        const next = btn.dataset.force || null;
        if ((d.type || null) === next) return;
        d.type = next;
        saveSketch();
        const keep = d.id;
        evaluateAll().then(() => { if (nodeOf(keep)) { selectedId = keep; renderChart(); renderPanel(); } });
      });
    }

    // 使用说明
    const guide = document.getElementById('wave-guide-backdrop');
    const setGuide = open => {
      if (!guide) return;
      guide.classList.toggle('open', open);
      guide.setAttribute('aria-hidden', open ? 'false' : 'true');
    };
    const guideBtn = document.getElementById('btn-wave-guide');
    if (guideBtn) guideBtn.addEventListener('click', () => setGuide(true));
    const guideClose = document.getElementById('btn-wave-guide-close');
    if (guideClose) guideClose.addEventListener('click', () => setGuide(false));
    if (guide) {
      guide.addEventListener('click', e => { if (e.target === guide) setGuide(false); });
      guide.querySelectorAll('.wave-guide-tab').forEach(tab => tab.addEventListener('click', () => {
        const k = tab.dataset.guide;
        guide.querySelectorAll('.wave-guide-tab').forEach(t => t.classList.toggle('active', t === tab));
        guide.querySelectorAll('.wave-guide-pane').forEach(p => p.classList.toggle('active', p.dataset.guide === k));
      }));
    }

    window.addEventListener('keydown', e => {
      if (guide && guide.classList.contains('open')) { if (e.key === 'Escape') setGuide(false); return; }
      if (!waveViewVisible()) return;
      const tag = (e.target && e.target.tagName) || '';
      if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
      if (e.key === 'Escape' && (boxMode || boxDrag)) { boxDrag = null; lockChart(false); boxSel = null; positionBox(); setBoxMode(false, '已取消框选'); }
      else if (e.key === 'Escape' && drag) cancelDrag();
      else if (e.key === 'Escape' && drawTool) cancelDrawing('已取消正在画的浪');
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
    /** 只读: 图表当前可见的K线序号范围与绘图区宽度 (调试用) */
    getView: x => waveChart ? Object.assign({ width: waveChart.timeScale().width(), logicalAtX: x !== undefined ? waveChart.timeScale().coordinateToLogical(x) : undefined }, waveChart.timeScale().getVisibleLogicalRange()) : null,
    onViewActivated: function () {
      if (!waveChart) {
        restoreSketch(currentSymbol);
        initChart();
        updateDrawButtons();
        renderPanel();
      }
      if (currentBars.length === 0) {
        if (!initialLoadPromise) initialLoadPromise = loadChartCandles(currentSymbol).finally(() => { initialLoadPromise = null; });
      } else {
        const container = document.getElementById('wave-chart-container');
        if (container && waveChart) waveChart.applyOptions({ width: container.clientWidth });
      }
    }
  };
})();
