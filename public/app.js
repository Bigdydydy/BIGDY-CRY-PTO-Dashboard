/**
 * Frontend Application Controller for BIGDY Quantitative Dashboard
 * Includes Update Detection, Analysis Re-computation verification, and Greeks Modal
 */

/**
 * Robust HTML escaping utility to prevent XSS attacks across dynamic DOM injections
 */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================================================
// Studio K95 Day/Night Dual-Theme Architecture & Controller
// ============================================================================

/**
 * Get current application theme ('light' or 'dark')
 */
function getAppTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

/**
 * Returns null for ECharts light mode, 'dark' for dark mode
 */
function getEchartsTheme() {
  return getAppTheme() === 'light' ? null : 'dark';
}

/**
 * Dynamic theme palette for Chart.js and ECharts
 */
function getChartThemeColors() {
  const isLight = getAppTheme() === 'light';
  return {
    isLight,
    gridLine: isLight ? 'rgba(0, 0, 0, 0.06)' : 'rgba(255, 255, 255, 0.04)',
    gridLineStrong: isLight ? 'rgba(0, 0, 0, 0.28)' : 'rgba(255, 255, 255, 0.25)',
    axisLine: isLight ? 'rgba(0, 0, 0, 0.12)' : 'rgba(255, 255, 255, 0.08)',
    tickColor: isLight ? '#52525b' : '#71717a',
    textPrimary: isLight ? '#121214' : '#fafafa',
    textSecondary: isLight ? '#4b4b52' : '#a1a1aa',
    textMuted: isLight ? '#71717a' : '#71717a',
    tooltipBg: isLight ? 'rgba(255, 255, 255, 0.96)' : 'rgba(18, 18, 24, 0.94)',
    tooltipBorder: isLight ? 'rgba(0, 0, 0, 0.12)' : 'rgba(255, 255, 255, 0.12)',
    tooltipText: isLight ? '#121214' : '#e4e4e7',
    tooltipTitle: isLight ? '#121214' : '#fafafa',
    tooltipBody: isLight ? '#27272a' : '#e4e4e7',
    tooltipDivider: isLight ? 'rgba(0, 0, 0, 0.08)' : 'rgba(255, 255, 255, 0.08)',
    axisPointerBg: isLight ? '#e4e4e7' : '#27272a',
    crossColor: isLight ? '#94a3b8' : '#64748b'
  };
}

/**
 * Synchronize UI state across all theme switcher pills on page
 */
function syncThemeSwitchers(theme) {
  const pills = document.querySelectorAll('.theme-switch-pill');
  pills.forEach(pill => {
    pill.setAttribute('data-active', theme);
    const darkBtn = pill.querySelector('[data-theme-val="dark"]');
    const lightBtn = pill.querySelector('[data-theme-val="light"]');
    if (darkBtn) darkBtn.classList.toggle('active', theme === 'dark');
    if (lightBtn) lightBtn.classList.toggle('active', theme === 'light');
  });
}

/**
 * Dispose and re-render all visible charts for the active theme
 */
function reloadAllChartsForTheme() {
  // Dispose all existing ECharts instances so they re-initialize with the matching theme palette
  if (typeof termPremiumChartInstance !== 'undefined' && termPremiumChartInstance) {
    try { termPremiumChartInstance.dispose(); } catch (e) {}
    termPremiumChartInstance = null;
  }
  if (typeof disposeEtfLinkageCharts === 'function') disposeEtfLinkageCharts();
  if (typeof ssroChartInstance !== 'undefined' && ssroChartInstance) {
    try { ssroChartInstance.dispose(); } catch (e) {}
    ssroChartInstance = null;
  }
  if (typeof cbDepthChartInstance !== 'undefined' && cbDepthChartInstance) {
    try { cbDepthChartInstance.dispose(); } catch (e) {}
    cbDepthChartInstance = null;
  }
  if (typeof cbSlippageChartInstance !== 'undefined' && cbSlippageChartInstance) {
    try { cbSlippageChartInstance.dispose(); } catch (e) {}
    cbSlippageChartInstance = null;
  }
  if (typeof goldChartInstance !== 'undefined' && goldChartInstance) {
    try { goldChartInstance.dispose(); } catch (e) {}
    goldChartInstance = null;
  }
  if (typeof mcclellanChartInstance !== 'undefined' && mcclellanChartInstance) {
    try { mcclellanChartInstance.dispose(); } catch (e) {}
    mcclellanChartInstance = null;
  }
  if (typeof cdriChartInstance !== 'undefined' && cdriChartInstance) {
    try { cdriChartInstance.dispose(); } catch (e) {}
    cdriChartInstance = null;
  }
  if (typeof pnlChartInstance !== 'undefined' && pnlChartInstance) {
    try { pnlChartInstance.dispose(); } catch (e) {}
    pnlChartInstance = null;
  }
  if (typeof pnlViewState !== 'undefined' && pnlViewState && document.getElementById('pnl-modal-backdrop')?.classList.contains('open')) {
    renderPnLView({ resetChart: true });
  }

  // Trigger all module chart re-renders
  if (typeof renderMacroChart === 'function' && typeof rawMacroData !== 'undefined' && rawMacroData) {
    renderMacroChart();
  }
  if (typeof renderCdriChart === 'function' && typeof rawCdriData !== 'undefined' && rawCdriData) {
    renderCdriChart();
  }
  if (typeof renderTermPremiumChart === 'function' && typeof currentTermPremiumData !== 'undefined' && currentTermPremiumData) {
    renderTermPremiumChart();
  }
  if (typeof renderEtfLinkage === 'function' && typeof rawEtfLinkageData !== 'undefined' && rawEtfLinkageData) {
    renderEtfLinkage();
  }
  if (typeof renderSsroChart === 'function' && typeof rawSsroData !== 'undefined' && rawSsroData) {
    renderSsroChart();
  }
  if (typeof renderCbDepthChart === 'function' && typeof rawCoinbaseData !== 'undefined' && rawCoinbaseData) {
    renderCbDepthChart(rawCoinbaseData);
    renderCbSlippageChart(rawCoinbaseData);
  }
  if (typeof renderGoldChart === 'function' && typeof rawGoldData !== 'undefined' && rawGoldData) {
    renderGoldChart();
  }
  if (typeof renderMcClellanCharts === 'function' && typeof rawMcClellanData !== 'undefined' && rawMcClellanData) {
    renderMcClellanCharts();
  }
  if (window.WaveRadarModule && typeof window.WaveRadarModule.updateTheme === 'function') {
    window.WaveRadarModule.updateTheme();
  }
}

/**
 * Set application theme and persist preference
 */
function setTheme(theme, isUserAction = true) {
  if (theme !== 'light' && theme !== 'dark') theme = 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  if (isUserAction) {
    try {
      localStorage.setItem('bigdy_theme', theme);
    } catch (e) {}
  }
  syncThemeSwitchers(theme);
  reloadAllChartsForTheme();
}

/**
 * Toggle between light and dark themes
 */
function toggleTheme() {
  const nextTheme = getAppTheme() === 'light' ? 'dark' : 'light';
  setTheme(nextTheme, true);
  if (typeof showToast === 'function') {
    showToast(`已切换至 ${nextTheme === 'light' ? '日间 · 画廊光' : '夜间 · 暗室光'}`);
  }
}

/**
 * Initialize theme controller, event bindings, and hotkeys
 */
function initThemeController() {
  // Determine initial theme
  let initialTheme = 'dark';
  try {
    const saved = localStorage.getItem('bigdy_theme');
    if (saved === 'light' || saved === 'dark') {
      initialTheme = saved;
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      initialTheme = 'light';
    }
  } catch (e) {}

  document.documentElement.setAttribute('data-theme', initialTheme);
  syncThemeSwitchers(initialTheme);

  // Bind clicks on all .theme-btn inside .theme-switch-pill
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.theme-btn');
    if (btn && btn.dataset.themeVal) {
      e.preventDefault();
      setTheme(btn.dataset.themeVal, true);
    }
  });

  // Global hotkey: Alt+T toggles theme
  window.addEventListener('keydown', (e) => {
    if (e.altKey && (e.key === 't' || e.key === 'T')) {
      e.preventDefault();
      toggleTheme();
    }
  });

  // Watch for system color scheme change if user hasn't explicitly set localStorage
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
      try {
        if (!localStorage.getItem('bigdy_theme')) {
          setTheme(e.matches ? 'light' : 'dark', false);
        }
      } catch (err) {}
    });
  }
}

let currentMarketData = null;
let currentGexMode = 'focused'; // 'focused' or 'all'
let currentBlockTab = 'icebergs'; // 'icebergs' or 'singles'
let lastDataVersion = null;

// Header & Sync Elements
const elIndexPrice = document.getElementById('index-price');
const elDataVersionBadge = document.getElementById('data-version-badge');
const elLastSync = document.getElementById('last-sync-time');
const elLastChange = document.getElementById('last-change-time');
const elSyncMsg = document.getElementById('sync-msg');
const elSyncPulseDot = document.getElementById('sync-pulse-dot');
const btnRefresh = document.getElementById('btn-refresh');
const elRefreshBtnText = document.getElementById('refresh-btn-text');
const elToast = document.getElementById('toast-notification');

// Module 1 Elements (ATM IV)
const elIv1m = document.getElementById('iv-1m');
const elIv1mSub = document.getElementById('iv-1m-sub');
const elIv3m = document.getElementById('iv-3m');
const elIv3mSub = document.getElementById('iv-3m-sub');
const elIv6m = document.getElementById('iv-6m');
const elIv6mSub = document.getElementById('iv-6m-sub');
const elIvCurveType = document.getElementById('iv-curve-type');
const elIvCurveSub = document.getElementById('iv-curve-sub');
const elIvRegimeBadge = document.getElementById('iv-regime-badge');
const elIvPercentileLabel = document.getElementById('iv-percentile-label');
const elIvGaugeFill = document.getElementById('iv-gauge-fill');
const elIvNarrativeText = document.getElementById('iv-narrative-text');

// Module 2 Elements (GEX)
const btnGexFocused = document.getElementById('btn-gex-focused');
const btnGexAll = document.getElementById('btn-gex-all');
const elGexRuleText = document.getElementById('gex-rule-text');
const elGexCardsContainer = document.getElementById('gex-cards-container');
const elGexNarrativeText = document.getElementById('gex-narrative-text');

// Module 4 Elements (IV Smile)
const elSmileShapeBadge = document.getElementById('smile-shape-badge');
const elSmileAtmIv = document.getElementById('smile-atm-iv');
const elSmileAtmStrike = document.getElementById('smile-atm-strike');
const elSmilePutWing = document.getElementById('smile-put-wing');
const elSmilePutSub = document.getElementById('smile-put-sub');
const elSmileCallWing = document.getElementById('smile-call-wing');
const elSmileCallSub = document.getElementById('smile-call-sub');
const elSmileSmirkDiff = document.getElementById('smile-smirk-diff');
const elSmileSmirkDesc = document.getElementById('smile-smirk-desc');
const elStrikesStripContainer = document.getElementById('strikes-strip-container');
const elSmileNarrativeText = document.getElementById('smile-narrative-text');

// Module 5 Elements (25D Skew)
const elSkew1d = document.getElementById('skew-1d');
const elSkew7d = document.getElementById('skew-7d');
const elSkew30d = document.getElementById('skew-30d');
const elSkew60d = document.getElementById('skew-60d');
const elSkew90d = document.getElementById('skew-90d');
const elSkew180d = document.getElementById('skew-180d');
const elSkew365d = document.getElementById('skew-365d');
const elSkewNarrativeText = document.getElementById('skew-narrative-text');

// Module 3 Elements (Block Trades)
const thresholdSelect = document.getElementById('threshold-select');
const timeRangeSelect = document.getElementById('time-range-select');
const elStoreText = document.getElementById('store-text');
const elStoreSpanBadge = document.getElementById('store-span-badge');
const elBlockNarrativeText = document.getElementById('block-narrative-text');
const elWhaleTotalVol = document.getElementById('whale-total-vol');
const elWhaleSingleCount = document.getElementById('whale-single-count');
const elIcebergClusterCount = document.getElementById('iceberg-cluster-count');
const elFlowBiasLabel = document.getElementById('flow-bias-label');
const btnTabIcebergs = document.getElementById('tab-icebergs');
const btnTabSingles = document.getElementById('tab-singles');
const contentIcebergs = document.getElementById('content-icebergs');
const contentSingles = document.getElementById('content-singles');
const badgeIcebergs = document.getElementById('badge-icebergs');
const badgeSingles = document.getElementById('badge-singles');
const elClusterCardsContainer = document.getElementById('cluster-cards-container');
const elWhaleTableBody = document.getElementById('whale-table-body');

// Module 3: Block Trades Pagination State & DOM Elements
const BLOCK_PAGE_SIZE = 20;
let icebergCurrentPage = 1;
let whaleCurrentPage = 1;

const btnIcebergsPrev = document.getElementById('btn-icebergs-prev');
const btnIcebergsNext = document.getElementById('btn-icebergs-next');
const elIcebergsPageIndicator = document.getElementById('icebergs-page-indicator');

const btnSinglesPrev = document.getElementById('btn-singles-prev');
const btnSinglesNext = document.getElementById('btn-singles-next');
const elSinglesPageIndicator = document.getElementById('singles-page-indicator');

// Modal Elements
const tradeModalBackdrop = document.getElementById('trade-modal-backdrop');
const btnCloseModal = document.getElementById('btn-close-modal');
const mBlockType = document.getElementById('m-block-type');
const mBlockTitle = document.getElementById('m-block-title');
const mIntentBanner = document.getElementById('m-intent-banner');
const mIntentBadge = document.getElementById('m-intent-badge');
const mIntentNarrative = document.getElementById('m-intent-narrative');
const mNetDelta = document.getElementById('m-net-delta');
const mNetDeltaUSD = document.getElementById('m-net-delta-usd');
const mNetGamma = document.getElementById('m-net-gamma');
const mNetVega = document.getElementById('m-net-vega');
const mNetTheta = document.getElementById('m-net-theta');
const mLegsBody = document.getElementById('m-legs-body');
const mBlockTime = document.getElementById('m-block-time');
const mStrategyName = document.getElementById('m-strategy-name');
const mMaxProfit = document.getElementById('m-max-profit');
const mMaxLoss = document.getElementById('m-max-loss');
const mBreakEven = document.getElementById('m-break-even');
const mInverseCurvature = document.getElementById('m-inverse-curvature');
const mInverseBadge = document.getElementById('m-inverse-badge');
const mPointersList = document.getElementById('m-pointers-list');

/**
 * Format timestamp or ISO string to UTC+8 "YYYY-MM-DD HH:mm:ss"
 */
function formatUTC8(timeInput, includeSeconds = true) {
  if (!timeInput) return '--';
  const ts = typeof timeInput === 'number'
    ? timeInput
    : (timeInput instanceof Date ? timeInput.getTime() : new Date(timeInput).getTime());
  if (isNaN(ts)) return String(timeInput);

  const d = new Date(ts + 8 * 3600 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');

  return includeSeconds ? `${y}-${m}-${day} ${h}:${min}:${s}` : `${y}-${m}-${day} ${h}:${min}`;
}

/**
 * Format timestamp to UTC+8 time only "HH:mm:ss"
 */
function formatUTC8TimeOnly(timeInput) {
  if (!timeInput) return '--:--:--';
  const ts = typeof timeInput === 'number'
    ? timeInput
    : (timeInput instanceof Date ? timeInput.getTime() : new Date(timeInput).getTime());
  if (isNaN(ts)) return String(timeInput);
  const d = new Date(ts + 8 * 3600 * 1000);
  const h = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  return `${h}:${min}:${s}`;
}

/**
 * Format a time interval to UTC+8 string
 */
function formatTimeWindowUTC8(startInput, endInput, durationMin) {
  const start = formatUTC8(startInput);
  const end = formatUTC8(endInput);
  if (start === '--' || end === '--') return '--';
  const startDay = start.slice(0, 10);
  const endDay = end.slice(0, 10);
  const startTime = start.slice(11, 19);
  const endTime = end.slice(11, 19);
  const windowStr = startDay === endDay ? `${startDay} ${startTime} ~ ${endTime}` : `${start} ~ ${end}`;
  return `${windowStr} (UTC+8) (${durationMin} 分钟内连续拆单)`;
}

/**
 * Show Toast
 */
function showToast(message, duration = 3000) {
  elToast.textContent = message;
  elToast.classList.add('show');
  setTimeout(() => {
    elToast.classList.remove('show');
  }, duration);
}

/**
 * Flash cards to visually confirm re-computation
 */
function triggerRecomputedAnimation() {
  const cards = document.querySelectorAll('.bento-card, .quant-card');
  cards.forEach(card => {
    card.classList.add('recomputed');
    setTimeout(() => card.classList.remove('recomputed'), 1200);
  });
}

/**
 * Fetch market data from server
 */
async function loadMarketData(triggerRefresh = false) {
  try {
    btnRefresh.classList.add('loading');
    btnRefresh.disabled = true;
    elRefreshBtnText.textContent = '校验同步中...';
    elSyncPulseDot.classList.add('pulse');

    let refreshReport = null;
    if (triggerRefresh) {
      const rResp = await fetch('/api/refresh', { method: 'POST' });
      refreshReport = await rResp.json();
    }

    const threshold = thresholdSelect ? thresholdSelect.value : 30000000;
    const timeRange = timeRangeSelect ? timeRangeSelect.value : 'all';
    
    // Fetch options market data, macro chart data, CDRI, and SSRO data in parallel
    const [mResp] = await Promise.all([
      fetch(`/api/market-data?threshold=${threshold}&timeRange=${timeRange}`),
      loadMacroData(triggerRefresh).catch(e => console.error('[App] Macro fetch error:', e.message)),
      loadCdriData(triggerRefresh).catch(e => console.error('[App] CDRI fetch error:', e.message)),
      fetchSsroData(triggerRefresh).catch(e => console.error('[App] SSRO fetch error:', e.message))
    ]);

    if (!mResp.ok) throw new Error(`Server returned ${mResp.status}`);
    const json = await mResp.json();

    if (json.code !== 0) throw new Error(json.error || 'Unknown API error');

    const previousVersion = lastDataVersion;
    currentMarketData = json;
    lastDataVersion = json.syncStatus?.dataVersion || 1;

    // Check if new data was detected
    const isNewData = (refreshReport && refreshReport.hasAnyUpdate) || 
                      (json.syncStatus?.hasAnyUpdate && previousVersion !== null && previousVersion !== lastDataVersion);

    renderAll();

    // Visual feedback for re-computation
    if (isNewData) {
      triggerRecomputedAnimation();
      showToast(`⚡ 检测到新数据变动！所有 5 大量化模块已全量重新计算（版本 v${lastDataVersion}）`);
    } else if (triggerRefresh) {
      showToast(`✓ 各数据源已完成校验，当前数据已是最新状态`);
    }
  } catch (err) {
    console.error('Failed to load market data:', err);
    showToast(`❌ 同步失败: ${err.message}`);
  } finally {
    btnRefresh.classList.remove('loading');
    btnRefresh.disabled = false;
    elRefreshBtnText.textContent = '实时同步';
    elSyncPulseDot.classList.remove('pulse');
  }
}

/**
 * Main Render Dispatcher
 */
function renderAll() {
  if (!currentMarketData) return;

  // Header
  elIndexPrice.textContent = `$${Math.round(currentMarketData.indexPrice || 0).toLocaleString()}`;
  
  const sync = currentMarketData.syncStatus;
  if (sync) {
    if (elDataVersionBadge) elDataVersionBadge.textContent = `v${sync.dataVersion}`;
    elSyncMsg.textContent = sync.summary || '数据已校验';
    if (sync.hasAnyUpdate) elSyncMsg.className = 'sync-msg updated';
    else elSyncMsg.className = 'sync-msg';

    if (sync.lastSyncCheckTime) {
      elLastSync.textContent = formatUTC8TimeOnly(sync.lastSyncCheckTime);
    }
    if (sync.lastDataChangeTime) {
      elLastChange.textContent = formatUTC8TimeOnly(sync.lastDataChangeTime);
    } else {
      elLastChange.textContent = elLastSync.textContent;
    }
  }

  renderAtmIv(currentMarketData.atmIv);
  renderGex(currentMarketData.gex);
  renderIvSmile(currentMarketData.ivSmile);
  render25DeltaSkew(currentMarketData.delta25Skew);
  renderBlockTrades(currentMarketData.blockTrades);
  if (currentMarketData.termPremium) {
    const shouldForce = !termPremiumChartInstance || !!(currentMarketData.syncStatus && currentMarketData.syncStatus.hasAnyUpdate);
    renderTermPremium(currentMarketData.termPremium, shouldForce);
  } else {
    loadTermPremiumData();
  }

  if (currentMarketData.goldCorrelation) {
    const shouldForce = !goldChartInstance || !!(currentMarketData.syncStatus && currentMarketData.syncStatus.hasAnyUpdate);
    renderGoldCorrelation(currentMarketData.goldCorrelation, shouldForce);
  } else {
    loadGoldCorrelationData();
  }

  if (rawMacroData) {
    renderMacroSummary(rawMacroData.summary);
    if (!macroChartInstance) {
      renderMacroChart();
    }
  }
}

/**
 * Render Module 1: ATM IV
 */
function renderAtmIv(data) {
  if (!data) return;

  elIv1m.textContent = data.iv1m ? `${data.iv1m.toFixed(1)}%` : '--%';
  elIv1mSub.textContent = data.percentile !== null ? `历史 ${data.percentile.toFixed(1)}% 分位` : '--';

  elIv3m.textContent = data.iv3m ? `${data.iv3m.toFixed(1)}%` : '--%';
  elIv3mSub.textContent = data.iv1m && data.iv3m ? `1M-3M Spread: ${(data.iv1m - data.iv3m).toFixed(1)}%` : '--';

  elIv6m.textContent = data.iv6m ? `${data.iv6m.toFixed(1)}%` : '--%';
  elIv6mSub.textContent = data.iv3m && data.iv6m ? `3M-6M Spread: ${(data.iv3m - data.iv6m).toFixed(1)}%` : '--';

  elIvCurveType.textContent = data.curveType || '--';
  elIvCurveSub.textContent = data.curveDesc || '--';

  elIvRegimeBadge.textContent = data.regimeTag;
  if (data.extremeAlert) {
    elIvRegimeBadge.className = 'card-badge badge-extreme';
  } else {
    elIvRegimeBadge.className = 'card-badge badge-normal';
  }

  if (data.percentile !== null) {
    elIvPercentileLabel.textContent = `当前处于历史 ${data.percentile.toFixed(1)}% 分位 (近2年)`;
    elIvGaugeFill.style.width = `${Math.min(100, Math.max(0, data.percentile))}%`;
  }

  const elIvExpectedMove = document.getElementById('iv-expected-move');
  const elIvStraddleSub = document.getElementById('iv-straddle-sub');
  if (elIvExpectedMove && data.dailyExpectedMovePct) {
    elIvExpectedMove.textContent = `日 ±${data.dailyExpectedMovePct}% | 周 ±${data.weeklyExpectedMovePct}%`;
  }
  if (elIvStraddleSub && data.atmStraddleEstPct) {
    elIvStraddleSub.textContent = `1M 跨式平价约 ${data.atmStraddleEstPct}% (时间平方根估值)`;
  }

  elIvNarrativeText.textContent = data.paragraph || '计算完成。';
}

/**
 * Render Module 2: GEX
 */
function renderGex(data) {
  if (!data) return;

  elGexRuleText.textContent = data.dynamicRuleDescription || '';
  elGexNarrativeText.textContent = data.paragraph || '';

  const list = currentGexMode === 'focused' ? data.focusedExpiries : data.allExpiries;
  if (!list || !list.length) {
    elGexCardsContainer.innerHTML = '<div class="loading-placeholder">暂无可展示的交割期数据</div>';
    return;
  }

  let html = '';
  for (const exp of list) {
    const isPos = exp.totalGex >= 0;
    const signStr = isPos ? '+' : '-';
    const gexColor = isPos ? 'text-pos' : 'text-neg';

    html += `
      <div class="gex-card">
        <div class="gex-card-header">
          <span class="gex-expiry">${escapeHtml(exp.expiry)}</span>
          <span class="gex-tag ${exp.isFocused ? 'tag-lead' : ''}">${escapeHtml(exp.categoryTag)}</span>
        </div>
        <div class="gex-details">
          <div class="gex-detail-row">
            <span class="gex-d-label">净 GEX 敞口:</span>
            <span class="gex-d-val ${gexColor}">${signStr}$${Math.abs(Number(exp.totalGexM) || 0).toFixed(2)}M</span>
          </div>
          <div class="gex-detail-row">
            <span class="gex-d-label">Call Wall (阻力位):</span>
            <span class="gex-d-val text-pos">$${exp.callWall ? Number(exp.callWall).toLocaleString() : '--'}</span>
          </div>
          <div class="gex-detail-row">
            <span class="gex-d-label">Put Wall (支撑位):</span>
            <span class="gex-d-val text-neg">$${exp.putWall ? Number(exp.putWall).toLocaleString() : '--'}</span>
          </div>
          <div class="gex-detail-row">
            <span class="gex-d-label">覆盖行权价数:</span>
            <span class="gex-d-val">${Number(exp.strikeCount) || 0} 个 Strikes</span>
          </div>
        </div>
      </div>
    `;
  }
  elGexCardsContainer.innerHTML = html;
}

/**
 * Render Module 4: IV Smile (微笑曲线)
 */
function renderIvSmile(data) {
  if (!data || data.status === 'insufficient_data') {
    elSmileNarrativeText.textContent = '暂无行权价 IV 微笑曲线数据。';
    return;
  }

  elSmileShapeBadge.textContent = data.skewShape ? data.skewShape.split('/')[0].trim() : '标准微笑';
  elSmileAtmIv.textContent = `${Number(data.atmIv || 0).toFixed(1)}%`;
  elSmileAtmStrike.textContent = `行权价: $${data.atmStrike?.toLocaleString()}`;

  elSmilePutWing.textContent = `+${Number(data.putWingPremium || 0).toFixed(1)}%`;
  elSmilePutSub.textContent = `行权价: $${data.lowestStrike?.toLocaleString()} (IV: ${Number(data.lowestIv || 0).toFixed(1)}%)`;

  elSmileCallWing.textContent = `+${Number(data.callWingPremium || 0).toFixed(1)}%`;
  elSmileCallSub.textContent = `行权价: $${data.highestStrike?.toLocaleString()} (IV: ${Number(data.highestIv || 0).toFixed(1)}%)`;

  const diff = Number(data.asymmetryDiff) || 0;
  elSmileSmirkDiff.textContent = `${diff >= 0 ? '+' : ''}${diff.toFixed(1)}%`;
  elSmileSmirkDesc.textContent = diff >= 0 ? 'Call 溢价高于 Put (追涨倾斜)' : 'Put 溢价高于 Call (避险倾斜)';

  const elSmileKurtosisVal = document.getElementById('smile-kurtosis-curv');
  if (elSmileKurtosisVal && typeof data.smileCurvature === 'number') {
    elSmileKurtosisVal.textContent = `+${data.smileCurvature.toFixed(1)}% IV`;
  }

  const strikes = data.strikes || [];
  if (strikes.length) {
    let stripHtml = '';
    for (const s of strikes) {
      const isAtm = s.strike === data.atmStrike;
      stripHtml += `
        <div class="strike-pill ${isAtm ? 'is-atm' : ''}">
          <span class="sp-strike">$${((Number(s.strike) || 0) / 1000).toFixed(0)}k</span>
          <span class="sp-iv ${isAtm ? 'text-accent' : ''}">${(Number(s.iv) || 0).toFixed(1)}%</span>
          <span class="sp-delta">${isAtm ? 'ATM' : (s.delta !== null ? `Δ ${escapeHtml(s.delta)}` : '')}</span>
        </div>
      `;
    }
    elStrikesStripContainer.innerHTML = stripHtml;
  }

  elSmileNarrativeText.textContent = data.paragraph || '';
}

/**
 * Render Module 5: 25Δ Skew 期限结构
 */
function render25DeltaSkew(data) {
  if (!data || data.status === 'insufficient_data') {
    elSkewNarrativeText.textContent = '暂无 25Δ Skew 期限结构数据。';
    return;
  }

  function formatSkewVal(el, val) {
    if (typeof val !== 'number') {
      el.textContent = '--';
      return;
    }
    const sign = val >= 0 ? '+' : '';
    el.textContent = `${sign}${val.toFixed(2)}%`;
    if (val > 0.2) el.className = 'term-val text-pos';
    else if (val < -0.2) el.className = 'term-val text-neg';
    else el.className = 'term-val';
  }

  formatSkewVal(elSkew1d, data.d1);
  formatSkewVal(elSkew7d, data.d7);
  formatSkewVal(elSkew30d, data.d30);
  formatSkewVal(elSkew60d, data.d60);
  formatSkewVal(elSkew90d, data.d90);
  formatSkewVal(elSkew180d, data.d180);
  formatSkewVal(elSkew365d, data.d365);

  const elSkewRegimeName = document.getElementById('skew-regime-name');
  const elSkewRegimeSub = document.getElementById('skew-regime-sub');
  const elSkewRegimeBadge = document.getElementById('skew-regime-badge');
  if (elSkewRegimeName && data.skewRegime) {
    elSkewRegimeName.textContent = data.skewRegime.split('(')[0].trim();
  }
  if (elSkewRegimeSub && data.skewRegimeDesc) {
    elSkewRegimeSub.textContent = data.skewRegimeDesc;
  }
  if (elSkewRegimeBadge && data.skewRegime) {
    elSkewRegimeBadge.textContent = data.skewRegime.includes('Jump') ? '⚡ 状态异动' : (data.skewRegime.includes('Local') ? '📉 负相关主导' : '🎯 Sticky Delta');
  }

  elSkewNarrativeText.textContent = data.paragraph || '';
}

/**
 * Render Module 3: Block Trades & Icebergs
 */
function renderBlockTrades(data) {
  if (!data) return;

  elBlockNarrativeText.textContent = data.paragraph || '';
  elWhaleTotalVol.textContent = `$${(data.totalWhaleVolumeM || 0).toFixed(1)}M`;
  elWhaleSingleCount.textContent = `${data.whaleBlocks?.length || 0} 笔`;
  elIcebergClusterCount.textContent = `${data.icebergClusters?.length || 0} 组`;
  elFlowBiasLabel.textContent = `${data.flowBias || '--'} (${data.bullRatio || 50}% 多)`;

  badgeIcebergs.textContent = data.icebergClusters?.length || 0;
  badgeSingles.textContent = data.whaleBlocks?.length || 0;

  // Render 30-Day Persistent Store Stats
  if (data.tradeStoreStats) {
    const s = data.tradeStoreStats;
    if (elStoreText) {
      elStoreText.innerHTML = `本地历史沉淀数据库：已累计安全归档 <strong>${Number(s.totalStored || 0).toLocaleString()}</strong> 笔大宗成交流水（沉淀区间: <strong>${escapeHtml(s.earliestTimeUTC8)}</strong> ~ <strong>${escapeHtml(s.latestTimeUTC8)}</strong> UTC+8，至多滚动保存 <strong>30 天</strong>，已突破官方 72h 上限）`;
    }
    if (elStoreSpanBadge) {
      elStoreSpanBadge.textContent = `已沉淀: ${s.historySpanDays} 天 / 30天`;
    }
  }

  // 1. Render Iceberg Clusters with pagination (20 per page)
  renderIcebergsList(data.icebergClusters || []);

  // 2. Render Single Whale Blocks with pagination (20 per page)
  renderWhaleSinglesList(data.whaleBlocks || []);
}

/**
 * Paginated Render for Iceberg Clusters (20 items / page)
 */
function renderIcebergsList(clusters) {
  if (!elClusterCardsContainer) return;
  const totalCount = clusters.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / BLOCK_PAGE_SIZE));
  if (icebergCurrentPage > totalPages) icebergCurrentPage = totalPages;
  if (icebergCurrentPage < 1) icebergCurrentPage = 1;

  if (!totalCount) {
    elClusterCardsContainer.innerHTML = '<div class="loading-placeholder">在当前门槛下未发现明显拆单聚合模式</div>';
    if (elIcebergsPageIndicator) {
      elIcebergsPageIndicator.innerHTML = '第 <span class="page-num-highlight">1</span> / 1 页 <span class="page-total-badge">共 0 组拆单</span>';
    }
    if (btnIcebergsPrev) btnIcebergsPrev.disabled = true;
    if (btnIcebergsNext) btnIcebergsNext.disabled = true;
    return;
  }

  const startIdx = (icebergCurrentPage - 1) * BLOCK_PAGE_SIZE;
  const endIdx = Math.min(startIdx + BLOCK_PAGE_SIZE, totalCount);
  const pageClusters = clusters.slice(startIdx, endIdx);

  let clusterHtml = '';
  pageClusters.forEach((c, idx) => {
    const globalIdx = startIdx + idx;
    const isBuy = c.direction === 'buy';
    const dirClass = isBuy ? 'dir-buy' : 'dir-sell';
    const dirText = c.isMultiLeg ? (isBuy ? 'BULL 多头策略拆单' : 'BEAR 空头策略拆单') : (isBuy ? 'BUY 多头拆单' : 'SELL 空头拆单');

    clusterHtml += `
      <div class="cluster-card" onclick="openIcebergDetail(${Number(globalIdx)})">
        <div class="cluster-info">
          <span class="cluster-dir-badge ${dirClass}">${dirText}</span>
          <div>
            <div class="cluster-inst">${escapeHtml(c.instrument)}</div>
            <div class="cluster-meta">时间窗: ${escapeHtml(formatTimeWindowUTC8(c.startTimeUTC8 || c.startTime, c.endTimeUTC8 || c.endTime, c.durationMin))}</div>
          </div>
        </div>
        <div>
          <div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px;">
            <div style="display:flex; gap:4px; flex-wrap:wrap; justify-content:flex-end;">
              ${c.actionTag ? `<span class="intent-badge-pill ${escapeHtml(c.actionBadgeClass || 'badge-neutral')}">${escapeHtml(c.actionTag)}</span>` : ''}
              ${c.is0DTE ? `<span class="intent-badge-pill ${escapeHtml(c.timingBadgeClass || 'badge-0dte-generic')}">⚡ 0DTE: ${escapeHtml(c.timingTag)}</span>` : ''}
              <span class="intent-badge-pill ${escapeHtml(c.intentBadgeClass || 'badge-neutral')}">${escapeHtml(c.intentBadge || '意图解析')}</span>
            </div>
            ${c.strategyNameZh ? `<div style="font-size:0.7rem;color:#a1a1aa;text-align:right;">${escapeHtml(c.strategyNameZh)}</div>` : ''}
          </div>
        </div>
        <div class="cluster-stats">
          <div class="cluster-stat-item">
            <span class="stat-label">拆单笔数 / 块数</span>
            <span class="c-val">${Number(c.splitCount) || 0} 笔 (${Number(c.blockCount) || 0} 个 Block)</span>
          </div>
          <div class="cluster-stat-item">
            <span class="stat-label">累计张数</span>
            <span class="c-val text-accent">${Number(c.totalContracts || 0).toLocaleString()} BTC</span>
          </div>
          <div class="cluster-stat-item">
            <span class="stat-label">累计名义价值</span>
            <span class="c-val text-highlight">$${(Number(c.clusterNotionalM) || 0).toFixed(2)}M</span>
          </div>
        </div>
        <div class="cluster-card-actions">
          <span class="cluster-tap-hint">点击卡片穿透分腿明细 →</span>
          <button class="btn-pv-action-pill" onclick="event.stopPropagation(); openPnLViewModal('iceberg', ${Number(globalIdx)})" title="模拟该组拆单合成头寸在到期日的 BTC 币本位盈亏曲线 (PnL View)">
            📊 PV 收益曲线
          </button>
        </div>
      </div>
    `;
  });
  elClusterCardsContainer.innerHTML = clusterHtml;

  if (elIcebergsPageIndicator) {
    elIcebergsPageIndicator.innerHTML = `第 <span class="page-num-highlight">${icebergCurrentPage}</span> / ${totalPages} 页 <span class="page-total-badge">共 ${totalCount} 组拆单</span>`;
  }
  if (btnIcebergsPrev) btnIcebergsPrev.disabled = icebergCurrentPage <= 1;
  if (btnIcebergsNext) btnIcebergsNext.disabled = icebergCurrentPage >= totalPages;
}

/**
 * Paginated Render for Single Whale Blocks (20 items / page)
 */
function renderWhaleSinglesList(blocks) {
  if (!elWhaleTableBody) return;
  const elWhaleMobileCards = document.getElementById('whale-mobile-cards');
  const totalCount = blocks.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / BLOCK_PAGE_SIZE));
  if (whaleCurrentPage > totalPages) whaleCurrentPage = totalPages;
  if (whaleCurrentPage < 1) whaleCurrentPage = 1;

  if (!totalCount) {
    elWhaleTableBody.innerHTML = '<tr><td colspan="8" class="text-center">在当前门槛下未检测到单笔巨鲸大单</td></tr>';
    if (elWhaleMobileCards) {
      elWhaleMobileCards.innerHTML = '<div style="text-align:center;padding:24px;color:#71717a;font-size:0.75rem;">在当前门槛下未检测到单笔巨鲸大单</div>';
    }
    if (elSinglesPageIndicator) {
      elSinglesPageIndicator.innerHTML = '第 <span class="page-num-highlight">1</span> / 1 页 <span class="page-total-badge">共 0 笔大单</span>';
    }
    if (btnSinglesPrev) btnSinglesPrev.disabled = true;
    if (btnSinglesNext) btnSinglesNext.disabled = true;
    return;
  }

  const startIdx = (whaleCurrentPage - 1) * BLOCK_PAGE_SIZE;
  const endIdx = Math.min(startIdx + BLOCK_PAGE_SIZE, totalCount);
  const pageBlocks = blocks.slice(startIdx, endIdx);

  let tableHtml = '';
  let cardsHtml = '';
  pageBlocks.forEach((b, idx) => {
    const globalIdx = startIdx + idx;
    tableHtml += `
      <tr onclick="openWhaleDetail(${Number(globalIdx)})">
        <td>${escapeHtml(b.dateTimeUTC8 || b.dateTime || formatUTC8(b.timestamp))}</td>
        <td><span class="text-accent">${escapeHtml(b.blockId)}</span></td>
        <td>
          <div style="display:flex; flex-wrap:wrap; gap:4px; margin-bottom:4px;">
            ${b.actionTag ? `<span class="intent-badge-pill ${escapeHtml(b.actionBadgeClass || 'badge-neutral')}">${escapeHtml(b.actionTag)}</span>` : ''}
            ${b.is0DTE ? `<span class="intent-badge-pill ${escapeHtml(b.timingBadgeClass || 'badge-0dte-generic')}">⚡ 0DTE ${escapeHtml(b.timingTag)}</span>` : ''}
          </div>
          <span class="intent-badge-pill ${escapeHtml(b.intentBadgeClass || 'badge-neutral')}">${escapeHtml(b.intentBadge || '--')}</span>
          ${b.strategyNameZh ? `<div style="font-size:0.68rem;color:#a1a1aa;margin-top:3px;">${escapeHtml(b.strategyNameZh)}</div>` : ''}
        </td>
        <td><strong>$${(Number(b.notionalUSDM) || 0).toFixed(2)}M</strong></td>
        <td>${(Number(b.netDeltaBTC) || 0) >= 0 ? '+' : ''}${(Number(b.netDeltaBTC) || 0).toFixed(1)} BTC</td>
        <td>${(Number(b.netVegaUSD) || 0) >= 0 ? '+' : ''}$${Math.round(Number(b.netVegaUSD) || 0).toLocaleString()}</td>
        <td>${Number(b.legCount) || 0} 腿</td>
        <td>
          <button class="btn-pv-action" onclick="event.stopPropagation(); openPnLViewModal('whale', ${Number(globalIdx)})" title="模拟该大单在到期日的 BTC 币本位盈亏曲线 (PnL View)">
            📊 PV 曲线
          </button>
        </td>
      </tr>
    `;

    cardsHtml += `
      <div class="whale-mobile-card" onclick="openWhaleDetail(${Number(globalIdx)})">
        <div class="wmc-header">
          <div class="wmc-id-group">
            <span class="wmc-id">${escapeHtml(b.blockId)}</span>
            <span class="wmc-time">${escapeHtml((b.dateTimeUTC8 || b.dateTime || '').slice(5, 16))}</span>
          </div>
          <div style="display:flex; flex-wrap:wrap; gap:4px; justify-content:flex-end;">
            ${b.actionTag ? `<span class="intent-badge-pill ${escapeHtml(b.actionBadgeClass || 'badge-neutral')}">${escapeHtml(b.actionTag)}</span>` : ''}
            ${b.is0DTE ? `<span class="intent-badge-pill ${escapeHtml(b.timingBadgeClass || 'badge-0dte-generic')}">⚡ 0DTE</span>` : ''}
            <span class="intent-badge-pill ${escapeHtml(b.intentBadgeClass || 'badge-neutral')}">${escapeHtml(b.intentBadge || '--')}</span>
          </div>
        </div>
        <div class="wmc-strategy">${escapeHtml(b.strategyNameZh || '机构定制结构')}</div>
        <div class="wmc-grid">
          <div class="wmc-stat">
            <span class="wmc-lbl">名义价值</span>
            <span class="wmc-val text-highlight">$${(Number(b.notionalUSDM) || 0).toFixed(1)}M</span>
          </div>
          <div class="wmc-stat">
            <span class="wmc-lbl">最大理论盈利</span>
            <span class="wmc-val text-accent">${escapeHtml(b.riskProfile?.maxProfit || '--')}</span>
          </div>
          <div class="wmc-stat">
            <span class="wmc-lbl">净 Delta</span>
            <span class="wmc-val">${(Number(b.netDeltaBTC) || 0) >= 0 ? '+' : ''}${(Number(b.netDeltaBTC) || 0).toFixed(1)} BTC</span>
          </div>
          <div class="wmc-stat">
            <span class="wmc-lbl">结构腿数</span>
            <span class="wmc-val">${Number(b.legCount) || 0} 腿</span>
          </div>
        </div>
        <div class="wmc-footer">
          <span class="wmc-tap-hint">点击穿透意图 →</span>
          <button class="btn-pv-action-pill" onclick="event.stopPropagation(); openPnLViewModal('whale', ${Number(globalIdx)})" title="模拟到期 BTC 盈亏曲线">
            📊 PV 曲线
          </button>
        </div>
      </div>
    `;
  });
  elWhaleTableBody.innerHTML = tableHtml;
  if (elWhaleMobileCards) {
    elWhaleMobileCards.innerHTML = cardsHtml;
  }

  if (elSinglesPageIndicator) {
    elSinglesPageIndicator.innerHTML = `第 <span class="page-num-highlight">${whaleCurrentPage}</span> / ${totalPages} 页 <span class="page-total-badge">共 ${totalCount} 笔大单</span>`;
  }
  if (btnSinglesPrev) btnSinglesPrev.disabled = whaleCurrentPage <= 1;
  if (btnSinglesNext) btnSinglesNext.disabled = whaleCurrentPage >= totalPages;
}

/**
 * Helper to populate Action Intent and 0DTE Behavior Profiling in Modal Drawer
 */
function populateActionTimingDrawer(item) {
  const elActionBadge = document.getElementById('m-action-badge');
  const elTimingBadge = document.getElementById('m-timing-badge');
  const elActionName = document.getElementById('m-action-name');
  const elActionRationale = document.getElementById('m-action-rationale');
  const elTimingName = document.getElementById('m-timing-name');
  const elTimingRationale = document.getElementById('m-timing-rationale');

  const action = item.actionProfile || {};
  const timing = item.timingProfile || {};

  if (elActionBadge) {
    elActionBadge.textContent = action.tag || item.actionTag || '常规撮合';
    elActionBadge.className = `intent-badge-pill ${action.badgeClass || item.actionBadgeClass || 'badge-neutral'}`;
  }
  if (elTimingBadge) {
    const is0D = timing.is0DTE ?? item.is0DTE;
    elTimingBadge.textContent = is0D ? `⚡ 0DTE: ${timing.tag || item.timingTag || '末日期权'}` : (timing.tag || item.timingTag || '常规期权');
    elTimingBadge.className = `intent-badge-pill ${timing.badgeClass || item.timingBadgeClass || 'badge-timing-normal'}`;
  }
  if (elActionName) {
    elActionName.textContent = action.tag ? `${action.tag} [置信度: ${action.confidence || 'MEDIUM'}]` : (item.actionTag || '常规撮合 (需OI确认)');
  }
  if (elActionRationale) {
    elActionRationale.textContent = action.rationale || '成交价贴近理论公允价值，无极端微观定价偏离。';
  }
  if (elTimingName) {
    const is0D = timing.is0DTE ?? item.is0DTE;
    const hours = timing.hoursToExpiry ?? item.hoursToExpiry ?? '--';
    const dteTitle = is0D ? `【⚡ 0DTE 末日期权】(距交割剩 ${hours}h)` : `【常规远期期权】(距交割剩 ${hours}h)`;
    elTimingName.textContent = `${dteTitle} · ${timing.tag || item.timingTag || '标准交割'}`;
  }
  if (elTimingRationale) {
    elTimingRationale.textContent = timing.rationale || '属于标准期权流动性配置。';
  }
}

/**
 * Modal Drawer Functions
 */
window.openWhaleDetail = function(idx) {
  const blocks = currentMarketData?.blockTrades?.whaleBlocks || [];
  const b = blocks[idx];
  if (!b) return;

  mBlockType.textContent = 'SINGLE WHALE BLOCK';
  mBlockTitle.textContent = `${b.blockId} 希腊字母与战略意图穿透`;
  if (mBlockTime) {
    mBlockTime.textContent = `成交时间: ${b.dateTimeUTC8 || b.dateTime || formatUTC8(b.timestamp)} (UTC+8) • 名义价值: $${b.notionalUSDM.toFixed(2)}M`;
  }

  mIntentBadge.textContent = b.intentBadge || '交易意图';
  mIntentBadge.className = `intent-badge-large ${b.intentBadgeClass || ''}`;
  mIntentNarrative.textContent = b.intentNarrative || '交易意图解析生成中...';

  populateActionTimingDrawer(b);

  if (mStrategyName) {
    mStrategyName.textContent = b.strategyNameZh || '机构定制结构';
  }
  if (mMaxProfit) mMaxProfit.textContent = b.riskProfile?.maxProfit || '--';
  if (mMaxLoss) mMaxLoss.textContent = b.riskProfile?.maxLoss || '--';
  if (mBreakEven) mBreakEven.textContent = b.riskProfile?.breakEven || '--';
  if (mInverseCurvature) mInverseCurvature.textContent = b.riskProfile?.inverseCurvature || '以结算币种波动率曲面损益模型计量';
  if (mInverseBadge) {
    const invText = b.riskProfile?.inverseCurvature || '以结算币种波动率曲面损益模型计量';
    mInverseBadge.title = `⚡ Deribit 币本位结算特性:\n${invText}`;
  }

  if (mPointersList) {
    const pointers = b.theoreticalPointers || [];
    if (pointers.length) {
      mPointersList.innerHTML = pointers.map(p => `<li>${escapeHtml(p)}</li>`).join('');
    } else {
      mPointersList.innerHTML = '<li>暂无研判要点</li>';
    }
  }

  const deltaSign = b.netDeltaBTC >= 0 ? '+' : '';
  mNetDelta.textContent = `${deltaSign}${b.netDeltaBTC.toFixed(1)} BTC`;
  mNetDeltaUSD.textContent = `${b.netDeltaUSD >= 0 ? '+' : '-'}$${Math.abs(b.netDeltaUSDM).toFixed(2)}M`;

  mNetGamma.textContent = `${b.netGamma.toFixed(4)}`;

  const vegaSign = b.netVegaUSD >= 0 ? '+' : '';
  mNetVega.textContent = `${vegaSign}$${Math.round(b.netVegaUSD).toLocaleString()}`;
  mNetVega.className = b.netVegaUSD >= 0 ? 'gkpi-val text-pos' : 'gkpi-val text-neg';

  const thetaSign = b.netThetaUSD >= 0 ? '+' : '';
  mNetTheta.textContent = `${thetaSign}$${Math.round(b.netThetaUSD).toLocaleString()}/d`;
  mNetTheta.className = b.netThetaUSD >= 0 ? 'gkpi-val text-pos' : 'gkpi-val text-neg';

  let legsHtml = '';
  for (const leg of b.legs) {
    const isBuy = leg.direction === 'buy';
    const dirClass = isBuy ? 'text-pos' : 'text-neg';
    legsHtml += `
      <tr>
        <td class="${dirClass}"><strong>${escapeHtml(leg.direction).toUpperCase()}</strong></td>
        <td><strong>${escapeHtml(leg.instrument)}</strong></td>
        <td>${Number(leg.amount) || 0} BTC</td>
        <td>${escapeHtml(leg.price)}</td>
        <td>${leg.iv ? (Number(leg.iv) || 0).toFixed(1) + '%' : '--'}</td>
        <td>${(Number(leg.delta) || 0) >= 0 ? '+' : ''}${(Number(leg.delta) || 0).toFixed(2)}</td>
        <td>${(Number(leg.vegaUSD) || 0) >= 0 ? '+' : ''}$${Math.round(Number(leg.vegaUSD) || 0).toLocaleString()}</td>
        <td>${(Number(leg.thetaUSD) || 0) >= 0 ? '+' : ''}$${Math.round(Number(leg.thetaUSD) || 0).toLocaleString()}</td>
        <td>$${(Number(leg.notionalM) || 0).toFixed(2)}M</td>
      </tr>
    `;
  }
  mLegsBody.innerHTML = legsHtml;

  tradeModalBackdrop.classList.add('open');
};

window.openIcebergDetail = function(idx) {
  const clusters = currentMarketData?.blockTrades?.icebergClusters || [];
  const c = clusters[idx];
  if (!c) return;

  mBlockType.textContent = 'ICEBERG SPLIT CLUSTER';
  mBlockTitle.textContent = `${c.instrument} 机构拆单组合穿透`;
  if (mBlockTime) {
    mBlockTime.textContent = `时间窗: ${formatTimeWindowUTC8(c.startTimeUTC8 || c.startTime, c.endTimeUTC8 || c.endTime, c.durationMin)} • 累计名义: $${c.clusterNotionalM.toFixed(2)}M`;
  }

  mIntentBadge.textContent = c.intentBadge || '拆单意图';
  mIntentBadge.className = `intent-badge-large ${c.intentBadgeClass || ''}`;
  mIntentNarrative.textContent = c.intentNarrative || '拆单意图分析生成中...';

  populateActionTimingDrawer(c);

  if (mStrategyName) {
    mStrategyName.textContent = c.strategyNameZh || '机构时间切片拆单 (Iceberg Synthetic)';
  }
  if (mMaxProfit) mMaxProfit.textContent = c.riskProfile?.maxProfit || '--';
  if (mMaxLoss) mMaxLoss.textContent = c.riskProfile?.maxLoss || '--';
  if (mBreakEven) mBreakEven.textContent = c.riskProfile?.breakEven || '--';
  if (mInverseCurvature) mInverseCurvature.textContent = c.riskProfile?.inverseCurvature || '以结算币种波动率曲面损益模型计量';
  if (mInverseBadge) {
    const invText = c.riskProfile?.inverseCurvature || '以结算币种波动率曲面损益模型计量';
    mInverseBadge.title = `⚡ Deribit 币本位结算特性:\n${invText}`;
  }

  if (mPointersList) {
    const pointers = c.theoreticalPointers || [];
    if (pointers.length) {
      mPointersList.innerHTML = pointers.map(p => `<li>${escapeHtml(p)}</li>`).join('');
    } else {
      mPointersList.innerHTML = '<li>暂无拆单研判要点</li>';
    }
  }

  const deltaSign = c.netDeltaBTC >= 0 ? '+' : '';
  mNetDelta.textContent = `${deltaSign}${c.netDeltaBTC.toFixed(1)} BTC`;
  mNetDeltaUSD.textContent = `${c.netDeltaUSD >= 0 ? '+' : '-'}$${Math.abs(c.netDeltaUSDM).toFixed(2)}M`;

  mNetGamma.textContent = c.netGamma != null ? (c.netGamma >= 0 ? '+' : '') + c.netGamma.toFixed(4) : '--';

  const vegaSign = c.netVegaUSD >= 0 ? '+' : '';
  mNetVega.textContent = `${vegaSign}$${Math.round(c.netVegaUSD).toLocaleString()}`;
  mNetVega.className = c.netVegaUSD >= 0 ? 'gkpi-val text-pos' : 'gkpi-val text-neg';

  const thetaSign = c.netThetaUSD >= 0 ? '+' : '';
  mNetTheta.textContent = `${thetaSign}$${Math.round(c.netThetaUSD).toLocaleString()}/d`;
  mNetTheta.className = c.netThetaUSD >= 0 ? 'gkpi-val text-pos' : 'gkpi-val text-neg';

  if (c.legs && c.legs.length > 0) {
    mLegsBody.innerHTML = c.legs.map(l => {
      const legBuy = l.direction === 'buy';
      const legClass = legBuy ? 'text-pos' : 'text-neg';
      return `
        <tr>
          <td class="${legClass}"><strong>${escapeHtml(l.direction).toUpperCase()}</strong></td>
          <td><strong>${escapeHtml(l.instrument)}</strong></td>
          <td>${Number(l.amount) || 0} BTC</td>
          <td>均价: ${(Number(l.price) || 0).toFixed(4)}</td>
          <td>${l.iv ? (Number(l.iv) || 0).toFixed(1) + '%' : '--'}</td>
          <td>${(Number(l.delta) || 0) >= 0 ? '+' : ''}${(Number(l.delta) || 0).toFixed(2)}</td>
          <td>${(Number(l.vegaUSD) || 0) >= 0 ? '+' : ''}$${Math.round(Number(l.vegaUSD) || 0).toLocaleString()}</td>
          <td>${(Number(l.thetaUSD) || 0) >= 0 ? '+' : ''}$${Math.round(Number(l.thetaUSD) || 0).toLocaleString()}</td>
          <td>$${(Number(l.notionalM) || 0).toFixed(2)}M</td>
        </tr>
      `;
    }).join('');
  } else {
    const isBuy = c.direction === 'buy';
    const dirClass = isBuy ? 'text-pos' : 'text-neg';
    mLegsBody.innerHTML = `
      <tr>
        <td class="${dirClass}"><strong>${escapeHtml(c.direction).toUpperCase()}</strong></td>
        <td><strong>${escapeHtml(c.instrument)}</strong> (合成累计)</td>
        <td>${Number(c.totalContracts) || 0} BTC</td>
        <td>均价: ${(Number(c.avgPrice) || 0).toFixed(4)}</td>
        <td>--</td>
        <td>${(Number(c.netDeltaBTC) || 0) >= 0 ? '+' : ''}${(Number(c.netDeltaBTC) || 0).toFixed(2)}</td>
        <td>${(Number(c.netVegaUSD) || 0) >= 0 ? '+' : ''}$${Math.round(Number(c.netVegaUSD) || 0).toLocaleString()}</td>
        <td>${(Number(c.netThetaUSD) || 0) >= 0 ? '+' : ''}$${Math.round(Number(c.netThetaUSD) || 0).toLocaleString()}</td>
        <td>$${(Number(c.clusterNotionalM) || 0).toFixed(2)}M</td>
      </tr>
    `;
  }

  tradeModalBackdrop.classList.add('open');
};


function closeModal() {
  tradeModalBackdrop.classList.remove('open');
}

btnCloseModal.addEventListener('click', closeModal);
tradeModalBackdrop.addEventListener('click', (e) => {
  if (e.target === tradeModalBackdrop) closeModal();
});

// ==========================================
// Dedicated Module 4 PnL Payoff View Controller (BTC Standard)
// ==========================================
let pnlChartInstance = null;

function closePnLModal() {
  const elModal = document.getElementById('pnl-modal-backdrop');
  if (elModal) elModal.classList.remove('open');
}

window.closePnLModal = closePnLModal;

const btnClosePnlModal = document.getElementById('btn-close-pnl-modal');
const pnlModalBackdrop = document.getElementById('pnl-modal-backdrop');
if (btnClosePnlModal) btnClosePnlModal.addEventListener('click', closePnLModal);
if (pnlModalBackdrop) {
  pnlModalBackdrop.addEventListener('click', (e) => {
    if (e.target === pnlModalBackdrop) closePnLModal();
  });
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeModal();
    closePnLModal();
  }
});

// PV view state: legs are fixed per opened block; days / IV shift / unit come from the controls.
let pnlViewState = null;
let pnlRenderPending = false;

function normalizePnLLeg(l, fallbackIv) {
  const parsed = window.PnLEngine.parseInstrument(l.instrument);
  return {
    instrument: l.instrument,
    direction: l.direction,
    amount: Number(l.amount || 0),
    price: Number(l.price || 0),
    strike: Number(l.strike) || parsed?.strike || 0,
    isCall: l.isCall ?? parsed?.isCall ?? String(l.instrument).endsWith('-C'),
    expiryMs: parsed?.expiryMs || null,
    iv: Number(l.iv) || fallbackIv,
    tradeIv: Number(l.iv) || null,
    markPrice: null,
    carry: 0
  };
}

/**
 * Swap in live Deribit marks: mark IV drives the curves / Greeks and each expiry's forward basis
 * (carry) makes T+0 theoretical prices line up with Deribit's mark price.
 * Falls back to trade-time IV when the request fails or a leg has no mark (e.g. expired).
 */
async function loadPnLLiveMarks(state) {
  const names = [...new Set(state.legs.map(l => l.instrument))];
  state.ivSource = { kind: 'loading' };
  try {
    const resp = await fetch(`/api/option-marks?currency=BTC&instruments=${encodeURIComponent(names.join(','))}`);
    const json = await resp.json();
    if (!resp.ok || json.code !== 0) throw new Error(json.error || `HTTP ${resp.status}`);
    if (pnlViewState !== state) return; // modal re-opened on another block meanwhile

    const indexNow = Number(json.indexPrice) || state.spotNow;
    let matched = 0;
    state.legs.forEach(leg => {
      const m = json.marks?.[leg.instrument];
      if (!m) return;
      matched++;
      leg.iv = m.markIv;
      leg.markPrice = m.markPrice;
      leg.carry = leg.expiryMs ? window.PnLEngine.impliedCarry(m.underlyingPrice, indexNow, leg.expiryMs, state.nowMs) : 0;
    });
    if (Number(json.indexPrice) > 0) state.spotNow = Number(json.indexPrice);
    state.ivSource = { kind: matched ? 'live' : 'trade', matched, total: state.legs.length, timestamp: json.timestamp, stale: !!json.stale };
  } catch (err) {
    if (pnlViewState !== state) return;
    console.warn('[PV] live option marks unavailable, using trade IV:', err.message);
    state.ivSource = { kind: 'error' };
  }
  renderPnLView();
}

function describePnLIvSource(src) {
  if (!src || src.kind === 'loading') return 'IV: 成交时 (正在获取 Deribit 实时 mark IV…)';
  if (src.kind === 'error') return 'IV: 成交时 (实时 mark IV 获取失败)';
  if (src.kind === 'trade') return 'IV: 成交时 (合约无实时报价)';
  const partial = src.matched < src.total ? `，${src.total - src.matched} 腿无报价用成交 IV` : '';
  return `IV: Deribit 实时 mark ${formatUTC8TimeOnly(src.timestamp)}${src.stale ? ' (缓存)' : ''}${partial}`;
}

function formatPnLValue(v, unit, digits = 4) {
  const sign = v >= 0 ? '+' : '-';
  if (unit === 'USD') return `${sign}$${Math.round(Math.abs(v)).toLocaleString()}`;
  return `${sign}${Math.abs(v).toFixed(digits)} ₿`;
}

function formatPnLAxis(v, unit) {
  const abs = Math.abs(v);
  const sign = v > 0 ? '+' : (v < 0 ? '-' : '');
  if (unit === 'USD') {
    if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
    if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
    return `${sign}$${abs.toFixed(0)}`;
  }
  return `${sign}${abs.toFixed(abs >= 100 ? 0 : 2)} ₿`;
}

function setPnLText(id, text, className) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  if (className !== undefined) el.className = className;
}

function schedulePnLRender() {
  if (pnlRenderPending) return;
  pnlRenderPending = true;
  requestAnimationFrame(() => {
    pnlRenderPending = false;
    renderPnLView();
  });
}

function syncPnLControls() {
  const s = pnlViewState;
  if (!s) return;
  const elDays = document.getElementById('pnl-days-slider');
  const elIv = document.getElementById('pnl-iv-slider');
  if (elDays) elDays.value = String(s.days);
  if (elIv) elIv.value = String(s.ivShift);
  document.querySelectorAll('#pnl-unit-toggle button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.unit === s.unit);
  });
}

(function wirePnLControls() {
  const elDays = document.getElementById('pnl-days-slider');
  const elIv = document.getElementById('pnl-iv-slider');
  const elReset = document.getElementById('pnl-reset-btn');
  if (elDays) elDays.addEventListener('input', () => {
    if (!pnlViewState) return;
    pnlViewState.days = Number(elDays.value) || 0;
    schedulePnLRender();
  });
  if (elIv) elIv.addEventListener('input', () => {
    if (!pnlViewState) return;
    pnlViewState.ivShift = Number(elIv.value) || 0;
    schedulePnLRender();
  });
  if (elReset) elReset.addEventListener('click', () => {
    if (!pnlViewState) return;
    pnlViewState.days = 0;
    pnlViewState.ivShift = 0;
    syncPnLControls();
    renderPnLView();
  });
  document.querySelectorAll('#pnl-unit-toggle button').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!pnlViewState) return;
      pnlViewState.unit = btn.dataset.unit === 'USD' ? 'USD' : 'BTC';
      syncPnLControls();
      renderPnLView();
    });
  });
})();

window.openPnLViewModal = function(type, idx) {
  const isIceberg = (type === 'iceberg');
  const item = isIceberg
    ? (currentMarketData?.blockTrades?.icebergClusters || [])[idx]
    : (currentMarketData?.blockTrades?.whaleBlocks || [])[idx];
  const elModal = document.getElementById('pnl-modal-backdrop');
  if (!item || !elModal) return;
  if (!window.PnLEngine) {
    console.error('PnLEngine not loaded');
    return;
  }

  // 1. Normalized legs (expiry parsed from the instrument name, IV from the trade)
  const fallbackIv = Number(currentMarketData?.atmIv?.iv1m) || 50;
  const rawLegs = (item.legs && item.legs.length > 0)
    ? item.legs
    : [{
        instrument: item.instrumentRaw || item.instrument,
        direction: item.direction,
        amount: item.totalContracts,
        price: item.avgPrice,
        strike: item.strike,
        iv: item.iv
      }];
  const legs = rawLegs.map(l => normalizePnLLeg(l, fallbackIv)).filter(l => l.strike > 0 && l.amount > 0);
  if (!legs.length) return;

  // 2. Spot: cost basis stays at the trade, the view is anchored at the current index
  const entrySpot = Number(item.legs?.[0]?.indexPrice) || Number(item.indexPrice) || 0;
  const spotNow = Number(currentMarketData?.indexPrice) || entrySpot || 85000;

  pnlViewState = {
    legs,
    spotNow,
    nowMs: Date.now(),
    days: 0,
    ivShift: 0,
    unit: pnlViewState?.unit || 'BTC',
    ivSource: { kind: 'loading' }
  };

  // 3. Header title and time metadata
  const idText = isIceberg ? `${item.instrument} 机构拆单` : item.blockId;
  const stratText = item.strategyNameZh || '期权组合结构';
  setPnLText('pnl-modal-title', `${idText} • ${stratText} 收益结构模拟`);

  const timeText = isIceberg
    ? `时间窗: ${formatTimeWindowUTC8(item.startTimeUTC8 || item.startTime, item.endTimeUTC8 || item.endTime, item.durationMin)}`
    : `成交时间: ${item.dateTimeUTC8 || item.dateTime || formatUTC8(item.timestamp)} (UTC+8)`;
  const notionalVal = Number(item.notionalUSDM || item.clusterNotionalM) || 0;
  const entryText = entrySpot ? ` • 成交时指数: $${Math.round(entrySpot).toLocaleString()}` : '';
  setPnLText('pnl-modal-meta', `${timeText} • 名义价值: $${notionalVal.toFixed(2)}M${entryText} • 当前指数: $${Math.round(spotNow).toLocaleString()} • 共 ${legs.length} 腿`);

  // 4. Date slider spans today -> nearest unexpired expiry
  const probe = window.PnLEngine.generatePnLView(legs, { spotPrice: spotNow, nowMs: pnlViewState.nowMs, numPoints: 10 });
  pnlViewState.maxDays = probe.maxDays;
  const elDays = document.getElementById('pnl-days-slider');
  if (elDays) {
    elDays.max = String(Math.max(probe.maxDays, 0.01));
    elDays.step = 'any';
    elDays.disabled = !(probe.maxDays > 0);
  }
  setPnLText('pnl-days-expiry-lbl', probe.nearestExpiryMs ? `到期 ${formatUTC8(probe.nearestExpiryMs, false).slice(5)}` : '已全部到期');
  syncPnLControls();

  elModal.classList.add('open');
  renderPnLView({ resetChart: true });
  loadPnLLiveMarks(pnlViewState);
};

function renderPnLView({ resetChart = false } = {}) {
  const s = pnlViewState;
  const E = window.PnLEngine;
  if (!s || !E) return;

  const evalMs = s.nowMs + s.days * E.MS_PER_DAY;
  const view = E.generatePnLView(s.legs, { spotPrice: s.spotNow, nowMs: s.nowMs, evalMs, ivShiftPct: s.ivShift });
  if (!view) return;
  const spotPrice = s.spotNow;

  // 1. Control labels
  const atExpiry = view.nearestExpiryMs && view.evalMs >= view.nearestExpiryMs;
  const evalDate = formatUTC8(view.evalMs, false);
  let daysLabel = '今天 (T+0)';
  if (atExpiry) daysLabel = `到期 · ${evalDate}`;
  else if (s.days > 0) daysLabel = `T+${s.days.toFixed(s.days < 10 ? 1 : 0)} 天 · ${evalDate}`;
  setPnLText('pnl-days-label', daysLabel);
  setPnLText('pnl-iv-label', `${s.ivShift >= 0 ? '+' : ''}${s.ivShift}%`);

  // 2. KPI cards (expiry curve, BTC with USD reference at current spot)
  if (view.isProfitCapped) {
    const profitUsd = view.maxPnl * spotPrice;
    setPnLText('pnl-kpi-max-profit', `${view.maxPnl >= 0 ? '+' : ''}${view.maxPnl.toFixed(3)} BTC`);
    setPnLText('pnl-kpi-max-profit-usd', `≈ ${profitUsd >= 0 ? '+' : '-'}$${Math.abs(Math.round(profitUsd)).toLocaleString()}`);
  } else {
    setPnLText('pnl-kpi-max-profit', '理论无上限');
    setPnLText('pnl-kpi-max-profit-usd', '净买入 Put：币价趋零时 BTC 收益发散');
  }

  if (view.isLossCapped) {
    const lossUsd = view.minPnl * spotPrice;
    setPnLText('pnl-kpi-max-loss', `${view.minPnl.toFixed(3)} BTC`);
    setPnLText('pnl-kpi-max-loss-usd', `≈ ${lossUsd >= 0 ? '+' : '-'}$${Math.abs(Math.round(lossUsd)).toLocaleString()}`);
  } else {
    setPnLText('pnl-kpi-max-loss', '理论深度亏损');
    setPnLText('pnl-kpi-max-loss-usd', '净卖出 Put：币价趋零时 BTC 亏损发散');
  }

  if (view.breakevens.length > 0) {
    setPnLText('pnl-kpi-bep', view.breakevens.map(b => `$${b.toLocaleString()}`).join(' / '));
    const distStrs = view.breakevens.map(b => {
      const diff = ((b - spotPrice) / spotPrice) * 100;
      return `${diff >= 0 ? '+' : ''}${diff.toFixed(1)}%`;
    });
    setPnLText('pnl-kpi-bep-distance', `较现价 ($${Math.round(spotPrice).toLocaleString()}): ${distStrs.join(' / ')}`);
  } else {
    setPnLText('pnl-kpi-bep', view.minPnl >= 0 ? '全域盈利' : '全域亏损');
    setPnLText('pnl-kpi-bep-distance', '区间内无零轴交叉点');
  }

  const cfBtc = view.initialCashFlowBTC;
  const cfUsd = Math.round(cfBtc * spotPrice);
  setPnLText('pnl-kpi-cashflow', `${cfBtc >= 0 ? '+' : ''}${cfBtc.toFixed(4)} BTC`, cfBtc >= 0 ? 'pnl-kpi-val text-pos' : 'pnl-kpi-val text-neg');
  setPnLText('pnl-kpi-cashflow-desc', `${cfBtc >= 0 ? '净收入权利金 (Net Credit)' : '净支付权利金 (Net Debit)'} ≈ ${cfUsd >= 0 ? '+' : '-'}$${Math.abs(cfUsd).toLocaleString()}`);

  // 3. Virtual positions & Greeks at the current index, simulated date and IV shift
  renderPnLPositions(s, view);

  // 4. Chart
  renderPnLChart(s, view, resetChart);
}

function renderPnLPositions(s, view) {
  const elBody = document.getElementById('pnl-positions-body');
  const elFoot = document.getElementById('pnl-positions-foot');
  if (!elBody || !elFoot) return;
  const pf = window.PnLEngine.evaluatePortfolio(s.legs, s.spotNow, view.evalMs, s.ivShift);
  const pnlCls = v => (v >= 0 ? 'text-pos' : 'text-neg');
  const signed = (v, d) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;

  elBody.innerHTML = s.legs.map((leg, i) => {
    const r = pf.legs[i];
    const isBuy = String(leg.direction).toLowerCase() === 'buy';
    const expiredTag = r.expired ? '<span class="pnl-expired-tag">已到期</span>' : '';
    const ivText = r.expired ? '--' : `${(r.sigma * 100).toFixed(1)}%`;
    const ivTitle = leg.tradeIv ? `成交时 IV ${leg.tradeIv.toFixed(1)}%` : '';
    const markText = leg.markPrice != null ? leg.markPrice.toFixed(4) : '--';
    return `
      <tr>
        <td>${escapeHtml(leg.instrument)}${expiredTag}</td>
        <td><span class="pnl-dir-badge ${isBuy ? 'leg-buy' : 'leg-sell'}">${isBuy ? 'BUY' : 'SELL'}</span></td>
        <td>${leg.amount.toLocaleString()}</td>
        <td>${leg.price.toFixed(4)}</td>
        <td>${markText}</td>
        <td title="${ivTitle}">${ivText}</td>
        <td>${r.valueBtc.toFixed(4)}</td>
        <td class="${pnlCls(r.pnlBtc)}">${signed(r.pnlBtc, 4)}</td>
        <td>${signed(r.posDelta, 2)}</td>
        <td>${signed(r.posNetDelta, 2)}</td>
        <td>${signed(r.posGamma, 5)}</td>
        <td>${signed(r.posVegaUsd, 0)}</td>
        <td>${signed(r.posThetaUsd, 0)}</td>
      </tr>
    `;
  }).join('');

  const t = pf.totals;
  elFoot.innerHTML = `
    <tr>
      <td colspan="7">组合合计 (≈ ${formatPnLValue(t.pnlBtc * s.spotNow, 'USD')})</td>
      <td class="${pnlCls(t.pnlBtc)}">${signed(t.pnlBtc, 4)}</td>
      <td>${signed(t.delta, 2)}</td>
      <td>${signed(t.netDelta, 2)}</td>
      <td>${signed(t.gamma, 5)}</td>
      <td>${signed(t.vegaUsd, 0)}</td>
      <td>${signed(t.thetaUsd, 0)}</td>
    </tr>
  `;

  const ivText = s.ivShift ? ` · IV ${s.ivShift > 0 ? '+' : ''}${s.ivShift}%` : '';
  setPnLText('pnl-greeks-meta', `按现价 $${Math.round(s.spotNow).toLocaleString()} · ${formatUTC8(view.evalMs, false)} (UTC+8)${ivText} · ${describePnLIvSource(s.ivSource)}`);
}

function renderPnLChart(s, view, resetChart) {
  const elChartDom = document.getElementById('pnl-chart-container');
  if (!elChartDom || !window.echarts) return;

  if (!pnlChartInstance) {
    pnlChartInstance = echarts.init(elChartDom, getEchartsTheme());
    resetChart = true;
    window.addEventListener('resize', () => {
      if (pnlChartInstance) pnlChartInstance.resize();
    });
  }

  const unit = s.unit;
  const themeColors = getChartThemeColors();
  const simColor = themeColors.isLight ? '#7c3aed' : '#a78bfa';
  const toUnit = (btc, S) => (unit === 'USD' ? Number((btc * S).toFixed(2)) : Number(btc.toFixed(6)));
  // Value x-axis with [S, pnl] pairs: markLine xAxis values (spot / BEP) are prices that are not
  // necessarily sampled points, which a category axis can't resolve (ECharts throws on 'coord').
  const expData = view.series.map(p => [p.S, toUnit(p.expBtc, p.S)]);
  const simData = view.series.map(p => [p.S, toUnit(p.simBtc, p.S)]);
  const expVals = expData.map(d => d[1]);
  const spotPrice = s.spotNow;

  const markLineData = [
    {
      yAxis: 0,
      lineStyle: { color: themeColors.gridLineStrong, type: 'dashed', width: 1.5 },
      label: { show: true, formatter: `0 ${unit === 'USD' ? 'USD' : 'BTC'} 损益平衡基准`, position: 'insideEndTop', color: themeColors.textSecondary, fontSize: 11 }
    },
    {
      xAxis: Math.round(spotPrice),
      lineStyle: { color: '#38bdf8', type: 'dotted', width: 2 },
      label: { show: true, formatter: `现价 $${Math.round(spotPrice).toLocaleString()}`, position: 'start', color: '#38bdf8', fontSize: 11 }
    }
  ];
  view.breakevens.forEach((bep, i) => {
    markLineData.push({
      xAxis: bep,
      lineStyle: { color: '#eab308', type: 'dashed', width: 1.5 },
      label: { show: true, formatter: `BEP${view.breakevens.length > 1 ? (i + 1) : ''}: $${bep.toLocaleString()}`, position: 'end', color: '#eab308', fontSize: 11 }
    });
  });

  const simName = view.evalMs > view.nowMs ? `模拟 (${formatUTC8(view.evalMs, false).slice(5)})` : '模拟 (T+0)';

  const option = {
    backgroundColor: 'transparent',
    animation: false,
    grid: { top: 30, left: 76, right: 40, bottom: 72, containLabel: false },
    tooltip: {
      trigger: 'axis',
      backgroundColor: themeColors.tooltipBg,
      borderColor: themeColors.tooltipBorder,
      textStyle: { color: themeColors.tooltipText, fontSize: 12 },
      formatter: function(params) {
        if (!params || !params.length) return '';
        const S = Number(params[0].data[0]);
        const rows = params.map(pt => {
          const v = Number(pt.data[1]);
          const col = v >= 0 ? '#4ade80' : '#f87171';
          const other = unit === 'USD' ? formatPnLValue(v / S, 'BTC') : formatPnLValue(v * S, 'USD');
          return `
            <div style="display: flex; justify-content: space-between; gap: 14px; margin-bottom: 3px;">
              <span style="color: ${themeColors.textSecondary};">${pt.marker}${pt.seriesName}:</span>
              <span><strong style="color: ${col};">${formatPnLValue(v, unit)}</strong>
                <span style="color: ${themeColors.textMuted}; margin-left: 6px;">${other}</span></span>
            </div>
          `;
        }).join('');
        return `
          <div style="font-family: var(--font-mono); padding: 4px 6px;">
            <div style="font-size: 0.8rem; font-weight: 600; color: ${themeColors.tooltipTitle}; margin-bottom: 6px;">
              标的价格: <span style="color: #38bdf8;">$${S.toLocaleString()}</span>
              <span style="color: ${themeColors.textMuted}; font-weight: 400;">(${S >= spotPrice ? '+' : ''}${(((S - spotPrice) / spotPrice) * 100).toFixed(1)}%)</span>
            </div>
            ${rows}
          </div>
        `;
      }
    },
    legend: { show: false },
    xAxis: {
      type: 'value',
      min: view.minS,
      max: view.maxS,
      axisLine: { lineStyle: { color: themeColors.axisLine } },
      axisLabel: {
        color: themeColors.textSecondary,
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        formatter: val => `$${Number(val).toLocaleString()}`
      },
      splitLine: { show: false }
    },
    yAxis: {
      type: 'value',
      axisLine: { lineStyle: { color: themeColors.axisLine } },
      axisLabel: {
        color: themeColors.textSecondary,
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        formatter: val => formatPnLAxis(val, unit)
      },
      splitLine: { show: true, lineStyle: { color: themeColors.gridLine, type: 'dashed' } }
    },
    dataZoom: [
      // Slider only: an 'inside' dataZoom swallows wheel events (even with zoomOnMouseWheel: 'ctrl'),
      // which would stop the modal body from scrolling while the cursor is over the chart
      { type: 'slider', xAxisIndex: 0, filterMode: 'filter', height: 18, bottom: 12, labelFormatter: val => `$${Math.round(val).toLocaleString()}` }
    ],
    visualMap: {
      show: false,
      seriesIndex: 0,
      dimension: 1,
      // Pieces must have finite bounds: ECharts 5.5 throws ('coord' of undefined) when building the
      // line gradient from open-ended (-Infinity/Infinity) pieces, which leaves the chart blank.
      pieces: [
        { gte: Math.min(...expVals, 0) - 1, lte: 0, color: '#ef4444' },
        { gt: 0, lte: Math.max(...expVals, 0) + 1, color: '#22c55e' }
      ]
    },
    series: [
      {
        name: '到期',
        type: 'line',
        smooth: false,
        showSymbol: false,
        data: expData,
        lineStyle: { width: 2 },
        areaStyle: { opacity: 0.12 },
        markLine: { symbol: ['none', 'none'], silent: true, data: markLineData },
        z: 2
      },
      {
        name: simName,
        type: 'line',
        smooth: false,
        showSymbol: false,
        data: simData,
        lineStyle: { width: 2.5, color: simColor },
        itemStyle: { color: simColor },
        z: 3
      }
    ]
  };

  if (resetChart) {
    pnlChartInstance.setOption(option, true);
    setTimeout(() => {
      if (pnlChartInstance) pnlChartInstance.resize();
    }, 60);
  } else {
    // Keep the user's zoom window while sliders move
    pnlChartInstance.setOption(option, { replaceMerge: ['series'] });
  }
}

// Event Listeners
btnRefresh.addEventListener('click', () => {
  loadMarketData(true);
});

thresholdSelect.addEventListener('change', () => {
  icebergCurrentPage = 1;
  whaleCurrentPage = 1;
  loadMarketData(false);
});

if (timeRangeSelect) {
  timeRangeSelect.addEventListener('change', () => {
    icebergCurrentPage = 1;
    whaleCurrentPage = 1;
    loadMarketData(false);
  });
}

// Module 3: Block Trades Pagination Button Listeners
if (btnIcebergsPrev) {
  btnIcebergsPrev.addEventListener('click', () => {
    if (icebergCurrentPage > 1) {
      icebergCurrentPage--;
      renderIcebergsList(currentMarketData?.blockTrades?.icebergClusters || []);
    }
  });
}

if (btnIcebergsNext) {
  btnIcebergsNext.addEventListener('click', () => {
    const clusters = currentMarketData?.blockTrades?.icebergClusters || [];
    const totalPages = Math.max(1, Math.ceil(clusters.length / BLOCK_PAGE_SIZE));
    if (icebergCurrentPage < totalPages) {
      icebergCurrentPage++;
      renderIcebergsList(clusters);
    }
  });
}

if (btnSinglesPrev) {
  btnSinglesPrev.addEventListener('click', () => {
    if (whaleCurrentPage > 1) {
      whaleCurrentPage--;
      renderWhaleSinglesList(currentMarketData?.blockTrades?.whaleBlocks || []);
    }
  });
}

if (btnSinglesNext) {
  btnSinglesNext.addEventListener('click', () => {
    const blocks = currentMarketData?.blockTrades?.whaleBlocks || [];
    const totalPages = Math.max(1, Math.ceil(blocks.length / BLOCK_PAGE_SIZE));
    if (whaleCurrentPage < totalPages) {
      whaleCurrentPage++;
      renderWhaleSinglesList(blocks);
    }
  });
}

btnGexFocused.addEventListener('click', () => {
  currentGexMode = 'focused';
  btnGexFocused.classList.add('active');
  btnGexAll.classList.remove('active');
  if (currentMarketData) renderGex(currentMarketData.gex);
});

btnGexAll.addEventListener('click', () => {
  currentGexMode = 'all';
  btnGexAll.classList.add('active');
  btnGexFocused.classList.remove('active');
  if (currentMarketData) renderGex(currentMarketData.gex);
});

btnTabIcebergs.addEventListener('click', () => {
  currentBlockTab = 'icebergs';
  btnTabIcebergs.classList.add('active');
  btnTabSingles.classList.remove('active');
  contentIcebergs.classList.remove('hidden');
  contentSingles.classList.add('hidden');
});

btnTabSingles.addEventListener('click', () => {
  currentBlockTab = 'singles';
  btnTabSingles.classList.add('active');
  btnTabIcebergs.classList.remove('active');
  contentSingles.classList.remove('hidden');
  contentIcebergs.classList.add('hidden');
});

// Auto-refresh every 30 seconds
setInterval(() => {
  loadMarketData(false);
}, 30000);

// ============================================================================
// Macro & On-Chain Cost Chart Controller
// ============================================================================

let rawMacroData = null;
let macroChartInstance = null;
let currentMacroTimeframe = '1y';

// DOM Elements
const elMacroBtcVal = document.getElementById('macro-btc-val');
const elMacroMstrVal = document.getElementById('macro-mstr-val');
const elMacroMstrMult = document.getElementById('macro-mstr-mult');
const elMacro1yVal = document.getElementById('macro-1y-val');
const elMacro10yVal = document.getElementById('macro-10y-val');
const elMacroSpreadVal = document.getElementById('macro-spread-val');
const elMacroSpreadBadge = document.getElementById('macro-spread-badge');
const elMacroSpreadSub = document.getElementById('macro-spread-sub');
const elMacroVelocityVal = document.getElementById('macro-velocity-val');
const elMacroVelocityChip = document.getElementById('macro-velocity-chip');
const elMacroVelocitySub = document.getElementById('macro-velocity-sub');
const elMacroMnavVal = document.getElementById('macro-mnav-val');
const elMacroMnavChip = document.getElementById('macro-mnav-chip');
const elMacroMnavSub = document.getElementById('macro-mnav-sub');
const elMacroNetliqVal = document.getElementById('macro-netliq-val');
const elMacroNetliqChip = document.getElementById('macro-netliq-chip');
const elMacroNetliqSub = document.getElementById('macro-netliq-sub');
const macroTimeframeSwitch = document.getElementById('macro-timeframe-switch');
const macroLegendGroup = document.getElementById('macro-legend-group');

/**
 * Load Macro Chart Data from API
 */
async function loadMacroData(forceRefresh = false) {
  try {
    const url = forceRefresh ? '/api/macro-chart?refresh=true' : '/api/macro-chart';
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (json.code !== 0) throw new Error(json.error || 'Failed to load macro data');

    rawMacroData = json;
    renderMacroSummary(json.summary);
    renderMacroChart();
  } catch (err) {
    console.error('[MacroChart] Error loading macro data:', err);
  }
}

/**
 * Render Macro Summary Top Cards
 */
function renderMacroSummary(summary) {
  if (!summary) return;

  if (elMacroBtcVal && summary.currentBtc) {
    elMacroBtcVal.textContent = `$${Math.round(summary.currentBtc).toLocaleString()}`;
  }

  if (elMacroMstrVal && summary.currentMstrCost) {
    elMacroMstrVal.textContent = `$${Math.round(summary.currentMstrCost).toLocaleString()}`;
  }

  if (elMacroMstrMult && summary.mstrProfitMultiplier) {
    const pnlPct = ((summary.mstrProfitMultiplier - 1) * 100).toFixed(1);
    const isGain = summary.mstrProfitMultiplier >= 1;
    elMacroMstrMult.textContent = `${summary.mstrProfitMultiplier}x (${isGain ? '+' : ''}${pnlPct}%)`;
    elMacroMstrMult.className = `mm-chip ${isGain ? 'chip-positive' : 'chip-negative'}`;
  }

  if (elMacro1yVal && summary.current1y !== null) {
    elMacro1yVal.textContent = `${summary.current1y.toFixed(2)}%`;
  }

  if (elMacro10yVal && summary.current10y !== null) {
    elMacro10yVal.textContent = `${summary.current10y.toFixed(2)}%`;
  }

  if (elMacroSpreadVal && summary.currentSpread !== null) {
    const sign = summary.currentSpread >= 0 ? '+' : '';
    elMacroSpreadVal.textContent = `${sign}${summary.currentSpread.toFixed(2)}%`;
    elMacroSpreadVal.className = `mm-val ${summary.currentSpread >= 0 ? 'text-green' : 'text-rose'}`;
  }

  if (elMacroSpreadBadge) {
    if (summary.isCurveInverted) {
      elMacroSpreadBadge.textContent = '曲线倒挂 (衰退警报)';
      elMacroSpreadBadge.className = 'mm-chip chip-negative';
    } else {
      elMacroSpreadBadge.textContent = '正常走陡';
      elMacroSpreadBadge.className = 'mm-chip chip-positive';
    }
  }

  if (elMacroSpreadSub && summary.currentSpread !== null) {
    if (summary.isCurveInverted) {
      elMacroSpreadSub.textContent = `10Y-1Y 倒挂 ${Math.abs(summary.currentSpread).toFixed(2)}%（短期流动性偏紧）`;
    } else {
      elMacroSpreadSub.textContent = `10Y-1Y 利差扩张至 +${summary.currentSpread.toFixed(2)}%（期限溢价修复）`;
    }
  }

  if (elMacroVelocityVal) {
    const vel = summary.currentMstrVelocity30d || 0;
    elMacroVelocityVal.textContent = vel > 0 ? `+${vel.toLocaleString()} BTC/d` : `0.0 BTC/d`;
  }

  if (elMacroVelocityChip && summary.peakVelocity30d) {
    elMacroVelocityChip.textContent = `峰值 ${Math.round(summary.peakVelocity30d).toLocaleString()} BTC/d`;
  }

  if (elMacroVelocitySub) {
    const vel = summary.currentMstrVelocity30d || 0;
    if (vel >= 1000) {
      elMacroVelocitySub.textContent = `强力吸筹中 (对现货市场形成明显供给冲击)`;
    } else if (vel > 0) {
      elMacroVelocitySub.textContent = `稳步加仓中 (近30天日均 +${vel.toLocaleString()} BTC)`;
    } else {
      elMacroVelocitySub.textContent = `近30天暂未披露新增购入 (蓄势观望)`;
    }
  }

  // Render MSTR mNAV
  if (elMacroMnavVal && summary.currentMnav !== null && summary.currentMnav !== undefined) {
    elMacroMnavVal.textContent = `${summary.currentMnav.toFixed(2)}×`;
  }

  if (elMacroMnavChip && summary.currentMnav !== null && summary.currentMnav !== undefined) {
    const diff = summary.currentMnav - 1;
    const diffPct = (Math.abs(diff) * 100).toFixed(1);
    if (diff > 0.005) {
      elMacroMnavChip.textContent = `溢价 +${diffPct}%`;
      elMacroMnavChip.className = 'mm-chip chip-positive';
    } else if (diff < -0.005) {
      elMacroMnavChip.textContent = `折价 -${diffPct}%`;
      elMacroMnavChip.className = 'mm-chip chip-negative';
    } else {
      elMacroMnavChip.textContent = `平价 1.00×`;
      elMacroMnavChip.className = 'mm-chip';
    }
  }

  if (elMacroMnavSub && summary.minMnav !== null && summary.maxMnav !== null) {
    elMacroMnavSub.textContent = `历史全域: ${summary.minMnav.toFixed(2)}× ~ ${summary.maxMnav.toFixed(2)}× (EV mNAV)`;
  }

  // 8. FED Net Liquidity (WALCL - TGA - RRP)
  if (elMacroNetliqVal && summary.currentFedNetLiquidity !== null && summary.currentFedNetLiquidity !== undefined) {
    elMacroNetliqVal.textContent = `$${summary.currentFedNetLiquidity.toFixed(2)}T`;
  }
  if (elMacroNetliqChip && summary.currentFedNetLiquidity !== null && summary.currentFedNetLiquidity !== undefined) {
    const diff20d = summary.fedNetLiqChange20d;
    const isExp = diff20d !== null ? diff20d >= 0 : (summary.currentFedNetLiquidity >= (summary.currentFedNetLiqSma20 || summary.currentFedNetLiquidity));
    const diffB = diff20d !== null ? Math.round(Math.abs(diff20d) * 1000) : 0;
    if (isExp) {
      elMacroNetliqChip.textContent = `20D 扩张 +$${diffB}B`;
      elMacroNetliqChip.className = 'mm-chip chip-positive';
    } else {
      elMacroNetliqChip.textContent = `20D 紧缩 -$${diffB}B`;
      elMacroNetliqChip.className = 'mm-chip chip-negative';
    }
  }
  if (elMacroNetliqSub && summary.currentFedWalcl !== null && summary.currentFedTga !== null && summary.currentFedRrp !== null) {
    const rrpStr = summary.currentFedRrp < 0.01 ? `$${(summary.currentFedRrp * 1000).toFixed(1)}B` : `$${summary.currentFedRrp.toFixed(2)}T`;
    elMacroNetliqSub.textContent = `WALCL $${summary.currentFedWalcl.toFixed(2)}T - TGA $${summary.currentFedTga.toFixed(2)}T - RRP ${rrpStr}`;
  }
}

/**
 * Filter points by selected timeframe
 */
function getFilteredMacroPoints() {
  if (!rawMacroData || !rawMacroData.points) return [];
  const points = rawMacroData.points;
  switch (currentMacroTimeframe) {
    case '3m':
      return points.slice(-90);
    case '6m':
      return points.slice(-180);
    case '1y':
      return points.slice(-365);
    case '3y':
      return points.slice(-1095);
    case 'all':
    default:
      return points;
  }
}

/**
 * Render Macro Chart with Chart.js
 */
function renderMacroChart() {
  const canvas = document.getElementById('macro-chart-canvas');
  if (!canvas || typeof Chart === 'undefined') return;

  const points = getFilteredMacroPoints();
  if (points.length === 0) return;

  const labels = points.map(p => p.date);
  const btcPrices = points.map(p => p.btcPrice);
  const mstrCosts = points.map(p => p.mstrCost);
  const us1yYields = points.map(p => p.us1y);
  const us10yYields = points.map(p => p.us10y);
  const spreads = points.map(p => p.yieldSpread);
  const velocities = points.map(p => p.mstrBuyVelocity30d || 0);
  const mnavs = points.map(p => (p.mnav !== null && p.mnav !== undefined) ? p.mnav : null);
  const netLiqs = points.map(p => (p.fedNetLiquidity !== null && p.fedNetLiquidity !== undefined) ? p.fedNetLiquidity : null);
  const netLiqSmas = points.map(p => (p.fedNetLiqSma20 !== null && p.fedNetLiqSma20 !== undefined) ? p.fedNetLiqSma20 : null);

  // Preserve visibility state across re-renders for all 9 datasets
  let visibilityStates = [true, true, true, true, true, true, true, true, true];
  if (macroChartInstance) {
    for (let i = 0; i < 9; i++) {
      visibilityStates[i] = macroChartInstance.isDatasetVisible(i);
    }
    macroChartInstance.destroy();
  }

  const ctx = canvas.getContext('2d');
  const colors = getChartThemeColors();

  // Gradient for BTC Price line
  const btcGradient = ctx.createLinearGradient(0, 0, 0, 350);
  btcGradient.addColorStop(0, 'rgba(245, 158, 11, 0.14)');
  btcGradient.addColorStop(1, 'rgba(245, 158, 11, 0.00)');

  // Gradient for Spread
  const spreadGradient = ctx.createLinearGradient(0, 0, 0, 350);
  spreadGradient.addColorStop(0, 'rgba(244, 63, 94, 0.08)');
  spreadGradient.addColorStop(1, 'rgba(244, 63, 94, 0.00)');

  // Gradient for MSTR Velocity
  const velGradient = ctx.createLinearGradient(0, 0, 0, 350);
  velGradient.addColorStop(0, 'rgba(236, 72, 153, 0.12)');
  velGradient.addColorStop(1, 'rgba(236, 72, 153, 0.00)');

  // Gradient for Net Liquidity
  const netLiqGradient = ctx.createLinearGradient(0, 0, 0, 350);
  netLiqGradient.addColorStop(0, 'rgba(59, 130, 246, 0.14)');
  netLiqGradient.addColorStop(1, 'rgba(59, 130, 246, 0.00)');

  const datasets = [
    {
      label: 'BTC 价格 (USD)',
      data: btcPrices,
      borderColor: '#f59e0b',
      backgroundColor: btcGradient,
      fill: true,
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 5,
      pointHoverBackgroundColor: '#f59e0b',
      pointHoverBorderColor: '#ffffff',
      pointHoverBorderWidth: 2,
      yAxisID: 'yUSD',
      tension: 0.12,
      hidden: !visibilityStates[0]
    },
    {
      label: 'MSTR Average Cost (USD)',
      data: mstrCosts,
      borderColor: '#8b5cf6',
      backgroundColor: 'transparent',
      borderWidth: 2,
      stepped: 'before',
      pointRadius: 0,
      pointHoverRadius: 5,
      pointHoverBackgroundColor: '#8b5cf6',
      pointHoverBorderColor: '#ffffff',
      pointHoverBorderWidth: 2,
      yAxisID: 'yUSD',
      hidden: !visibilityStates[1]
    },
    {
      label: 'US 1Y T-Bill (%)',
      data: us1yYields,
      borderColor: '#06b6d4',
      backgroundColor: 'transparent',
      borderWidth: 1.8,
      borderDash: [4, 3],
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHoverBackgroundColor: '#06b6d4',
      pointHoverBorderColor: '#ffffff',
      pointHoverBorderWidth: 2,
      yAxisID: 'yYield',
      tension: 0.1,
      hidden: !visibilityStates[2]
    },
    {
      label: 'US 10Y T-Note (%)',
      data: us10yYields,
      borderColor: '#10b981',
      backgroundColor: 'transparent',
      borderWidth: 1.8,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHoverBackgroundColor: '#10b981',
      pointHoverBorderColor: '#ffffff',
      pointHoverBorderWidth: 2,
      yAxisID: 'yYield',
      tension: 0.1,
      hidden: !visibilityStates[3]
    },
    {
      label: '(US 10Y - US 1Y) 利差 (%)',
      data: spreads,
      borderColor: '#f43f5e',
      backgroundColor: spreadGradient,
      fill: false,
      borderWidth: 1.8,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHoverBackgroundColor: '#f43f5e',
      pointHoverBorderColor: '#ffffff',
      pointHoverBorderWidth: 2,
      yAxisID: 'yYield',
      tension: 0.12,
      hidden: !visibilityStates[4]
    },
    {
      label: 'MSTR 购买速度 (30D 导数, BTC/天)',
      data: velocities,
      borderColor: '#ec4899',
      backgroundColor: velGradient,
      fill: false,
      borderWidth: 1.8,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHoverBackgroundColor: '#ec4899',
      pointHoverBorderColor: '#ffffff',
      pointHoverBorderWidth: 2,
      yAxisID: 'yVelocity',
      tension: 0.15,
      hidden: !visibilityStates[5]
    },
    {
      label: 'MSTR mNAV (EV 倍数)',
      data: mnavs,
      borderColor: '#6366f1',
      backgroundColor: 'transparent',
      borderWidth: 1.8,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHoverBackgroundColor: '#6366f1',
      pointHoverBorderColor: '#ffffff',
      pointHoverBorderWidth: 2,
      yAxisID: 'yMNAV',
      tension: 0.12,
      hidden: !visibilityStates[6]
    },
    {
      label: 'FED 净流动性 ($T)',
      data: netLiqs,
      borderColor: '#3b82f6',
      backgroundColor: netLiqGradient,
      fill: true,
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHoverBackgroundColor: '#3b82f6',
      pointHoverBorderColor: '#ffffff',
      pointHoverBorderWidth: 2,
      yAxisID: 'yLiquidity',
      tension: 0.15,
      hidden: !visibilityStates[7]
    },
    {
      label: '净流动性 20D SMA ($T)',
      data: netLiqSmas,
      borderColor: '#60a5fa',
      backgroundColor: 'transparent',
      borderWidth: 1.6,
      borderDash: [4, 4],
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHoverBackgroundColor: '#60a5fa',
      pointHoverBorderColor: '#ffffff',
      pointHoverBorderWidth: 2,
      yAxisID: 'yLiquidity',
      tension: 0.15,
      hidden: !visibilityStates[8]
    }
  ];

  try {
    macroChartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: datasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        interaction: {
          mode: 'index',
          intersect: false
        },
        plugins: {
          legend: {
            display: false // Custom external interactive legend
          },
          tooltip: {
            enabled: true,
            backgroundColor: colors.tooltipBg,
            borderColor: colors.tooltipBorder,
            borderWidth: 1,
            titleColor: colors.tooltipTitle,
            titleFont: { family: 'JetBrains Mono', size: 12, weight: '600' },
            bodyColor: colors.tooltipBody,
            bodyFont: { family: 'JetBrains Mono', size: 11 },
            padding: 12,
            boxPadding: 6,
            usePointStyle: true,
            callbacks: {
              title: function(items) {
                if (!items.length) return '';
                return `${items[0].label} (UTC+8)`;
              },
              label: function(context) {
                const label = context.dataset.label || '';
                const val = context.parsed.y;
                if (val === null || val === undefined || isNaN(val)) return ` ${label}: --`;
                if (context.dataset.yAxisID === 'yUSD') {
                  return ` ${label}: $${Number(val).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
                } else if (context.dataset.yAxisID === 'yVelocity') {
                  return ` ${label}: +${Number(val).toLocaleString()} BTC/d`;
                } else if (context.dataset.yAxisID === 'yMNAV') {
                  const premiumPct = ((val - 1) * 100).toFixed(1);
                  const status = val >= 1 ? `溢价 +${premiumPct}%` : `折价 ${premiumPct}%`;
                  return ` ${label}: ${val.toFixed(2)}× (${status})`;
                } else if (context.dataset.yAxisID === 'yLiquidity') {
                  return ` ${label}: $${val.toFixed(3)}T ($${Math.round(val * 1000).toLocaleString()}B)`;
                } else {
                  const sign = (label.includes('利差') && val >= 0) ? '+' : '';
                  return ` ${label}: ${sign}${val.toFixed(2)}%`;
                }
              }
            }
          }
        },
        scales: {
          x: {
            grid: {
              color: colors.gridLine,
              borderColor: colors.axisLine
            },
            ticks: {
              color: colors.tickColor,
              font: { family: 'JetBrains Mono', size: 10 },
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 10
            }
          },
          yUSD: {
            type: 'linear',
            position: 'left',
            grid: {
              color: colors.gridLine,
              borderColor: colors.axisLine
            },
            ticks: {
              color: colors.isLight ? '#b45309' : '#fbbf24',
              font: { family: 'JetBrains Mono', size: 10 },
              callback: function(v) {
                if (v >= 1000) return '$' + Math.round(v / 1000) + 'k';
                return '$' + v;
              }
            },
            title: {
              display: true,
              text: 'BTC & MSTR Cost (USD)',
              color: colors.isLight ? '#b45309' : '#fbbf24',
              font: { family: 'Inter', size: 10, weight: '500' }
            }
          },
          yYield: {
            type: 'linear',
            position: 'right',
            grid: {
              drawOnChartArea: false,
              borderColor: colors.axisLine
            },
            ticks: {
              color: colors.isLight ? '#0284c7' : '#38bdf8',
              font: { family: 'JetBrains Mono', size: 10 },
              callback: function(v) {
                return v.toFixed(1) + '%';
              }
            },
            title: {
              display: true,
              text: '美债利率与利差 (%)',
              color: colors.isLight ? '#0284c7' : '#38bdf8',
              font: { family: 'Inter', size: 10, weight: '500' }
            }
          },
          yVelocity: {
            type: 'linear',
            position: 'right',
            grid: {
              drawOnChartArea: false,
              borderColor: colors.isLight ? 'rgba(219, 39, 119, 0.25)' : 'rgba(236, 72, 153, 0.15)'
            },
            ticks: {
              color: colors.isLight ? '#db2777' : '#f472b6',
              font: { family: 'JetBrains Mono', size: 10 },
              callback: function(v) {
                if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
                return v;
              }
            },
            title: {
              display: true,
              text: 'MSTR 速度 (BTC/天)',
              color: colors.isLight ? '#db2777' : '#f472b6',
              font: { family: 'Inter', size: 10, weight: '500' }
            },
            suggestedMin: 0
          },
          yMNAV: {
            type: 'linear',
            position: 'right',
            grid: {
              drawOnChartArea: false,
              borderColor: colors.isLight ? 'rgba(79, 70, 229, 0.25)' : 'rgba(99, 102, 241, 0.18)'
            },
            ticks: {
              color: colors.isLight ? '#4f46e5' : '#818cf8',
              font: { family: 'JetBrains Mono', size: 10 },
              callback: function(v) {
                return v.toFixed(1) + '×';
              }
            },
            title: {
              display: true,
              text: 'MSTR mNAV (倍数)',
              color: colors.isLight ? '#4f46e5' : '#818cf8',
              font: { family: 'Inter', size: 10, weight: '500' }
            },
            suggestedMin: 0.5,
            suggestedMax: 3.5
          },
          yLiquidity: {
            type: 'linear',
            position: 'right',
            grid: {
              drawOnChartArea: false,
              borderColor: colors.isLight ? 'rgba(37, 99, 235, 0.25)' : 'rgba(59, 130, 246, 0.18)'
            },
            ticks: {
              color: colors.isLight ? '#2563eb' : '#60a5fa',
              font: { family: 'JetBrains Mono', size: 10 },
              callback: function(v) {
                return '$' + v.toFixed(1) + 'T';
              }
            },
            title: {
              display: true,
              text: 'Fed 净流动性 ($T)',
              color: colors.isLight ? '#2563eb' : '#60a5fa',
              font: { family: 'Inter', size: 10, weight: '500' }
            },
            suggestedMin: 4.8,
            suggestedMax: 7.5
          }
        }
      }
    });
    window.macroChartInstance = macroChartInstance;
  } catch (err) {
    console.error('[MacroChart] Chart creation error:', err);
  }

  // Sync custom legend button active/inactive states
  if (macroLegendGroup) {
    const buttons = macroLegendGroup.querySelectorAll('.legend-pill');
    buttons.forEach(btn => {
      const idx = parseInt(btn.dataset.dataset, 10);
      const isVisible = macroChartInstance.isDatasetVisible(idx);
      if (isVisible) {
        btn.classList.add('active');
        btn.classList.remove('inactive');
      } else {
        btn.classList.remove('active');
        btn.classList.add('inactive');
      }
    });
  }
}

/**
 * Initialize Event Listeners for Macro Chart (Interactive Legend & Timeframe Switcher)
 */
function initMacroChartEvents() {
  // Custom Interactive Legend Pills Click
  if (macroLegendGroup) {
    macroLegendGroup.addEventListener('click', (e) => {
      const btn = e.target.closest('.legend-pill');
      if (!btn || !macroChartInstance) return;

      const datasetIndex = parseInt(btn.dataset.dataset, 10);
      const isVisible = macroChartInstance.isDatasetVisible(datasetIndex);
      macroChartInstance.setDatasetVisibility(datasetIndex, !isVisible);
      macroChartInstance.update();

      if (isVisible) {
        btn.classList.remove('active');
        btn.classList.add('inactive');
      } else {
        btn.classList.remove('inactive');
        btn.classList.add('active');
      }
    });
  }

  // Timeframe Switch Buttons (3M, 6M, 1Y, 3Y, ALL)
  if (macroTimeframeSwitch) {
    macroTimeframeSwitch.addEventListener('click', (e) => {
      const btn = e.target.closest('.switch-btn');
      if (!btn) return;

      const range = btn.dataset.range;
      if (!range || range === currentMacroTimeframe) return;

      currentMacroTimeframe = range;
      macroTimeframeSwitch.querySelectorAll('.switch-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      renderMacroChart();
    });
  }
}

// ============================================================================
// CoinGlass CDRI (Crypto Derivatives Risk Index) Controller
// ============================================================================

let rawCdriData = null;
let cdriChartInstance = null;
let currentCdriTimeframe = 'all'; // '30', '90', '180', '365', 'all'
let isCdriBtcVisible = true;

// DOM Elements
const elCdriHeaderScorePill = document.getElementById('cdri-header-score-pill');
const elCdriUpdateTime = document.getElementById('cdri-update-time');
const elCdriGaugeScore = document.getElementById('cdri-gauge-score');
const elCdriGaugeBadge = document.getElementById('cdri-gauge-badge');
const elGaugeNeedleGroup = document.getElementById('gauge-needle-group');
const elGaugeArc1 = document.getElementById('gauge-arc-1');
const elGaugeArc2 = document.getElementById('gauge-arc-2');
const elGaugeArc3 = document.getElementById('gauge-arc-3');
const elGaugeArc4 = document.getElementById('gauge-arc-4');
const elCdriHistYesterday = document.getElementById('cdri-hist-yesterday');
const elCdriHistWeek = document.getElementById('cdri-hist-week');
const elCdriHistMonth = document.getElementById('cdri-hist-month');
const elCdriYearHigh = document.getElementById('cdri-year-high');
const elCdriYearHighDate = document.getElementById('cdri-year-high-date');
const elCdriYearLow = document.getElementById('cdri-year-low');
const elCdriYearLowDate = document.getElementById('cdri-year-low-date');
const elCdriEcharts = document.getElementById('cdri-echarts');
const cdriTimeframeSelector = document.getElementById('cdri-timeframe-selector');
const btnToggleCdriBtc = document.getElementById('btn-toggle-cdri-btc');
const btnToggleCdriDrawer = document.getElementById('btn-toggle-cdri-drawer');
const cdriDrawerContent = document.getElementById('cdri-drawer-content');
const cdriDrawerArrow = document.getElementById('cdri-drawer-arrow');

/**
 * Describe SVG circular arc path
 */
function describeSvgArc(cx, cy, r, startAngleDeg, endAngleDeg) {
  // startAngleDeg = 0 is left (180 deg), 180 is right (0 deg)
  const startRad = (180 - startAngleDeg) * Math.PI / 180;
  const endRad = (180 - endAngleDeg) * Math.PI / 180;
  const x1 = cx + r * Math.cos(startRad);
  const y1 = cy - r * Math.sin(startRad);
  const x2 = cx + r * Math.cos(endRad);
  const y2 = cy - r * Math.sin(endRad);
  const largeArcFlag = (endAngleDeg - startAngleDeg) <= 180 ? 0 : 1;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArcFlag} 1 ${x2} ${y2}`;
}

/**
 * Draw semicircle gauge tracks
 */
function setupGaugeArcs() {
  if (!elGaugeArc1) return;
  // 0-30 -> 0 to 54 deg
  elGaugeArc1.setAttribute('d', describeSvgArc(140, 135, 115, 0, 54));
  // 30-60 -> 54 to 108 deg
  elGaugeArc2.setAttribute('d', describeSvgArc(140, 135, 115, 54, 108));
  // 60-80 -> 108 to 144 deg
  elGaugeArc3.setAttribute('d', describeSvgArc(140, 135, 115, 108, 144));
  // 80-100 -> 144 to 180 deg
  elGaugeArc4.setAttribute('d', describeSvgArc(140, 135, 115, 144, 180));
}

/**
 * Load CDRI data from API
 */
async function loadCdriData(forceRefresh = false) {
  try {
    const url = forceRefresh ? '/api/cdri?refresh=true' : '/api/cdri';
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (json.code !== 0) throw new Error(json.error || 'Failed to load CDRI data');

    rawCdriData = json;
    renderCdriMetrics(json);
    renderCdriChart();
  } catch (err) {
    console.error('[CDRI] Error loading CDRI data:', err);
  }
}

/**
 * Helper to render pill HTML
 */
function createRiskPillHtml(score, riskInfo) {
  if (score === null || score === undefined) return '<span class="cdri-num-pill">--</span>';
  const info = riskInfo || { color: '#93ea2a', bg: 'rgba(147,234,42,0.15)', border: '#93ea2a', level: '中性波动' };
  return `<span class="cdri-num-pill" style="color:${escapeHtml(info.color)}; background:${escapeHtml(info.bg)}; border:1px solid ${escapeHtml(info.border)};">${Number(score) || 0} ${escapeHtml(info.level)}</span>`;
}

/**
 * Render CDRI Gauge & Metrics
 */
function renderCdriMetrics(data) {
  if (!data || !data.performance) return;
  const p = data.performance;

  // Header pill & update time
  if (elCdriHeaderScorePill && p.price !== null) {
    elCdriHeaderScorePill.textContent = `${p.price} ${p.level}`;
    elCdriHeaderScorePill.style.color = p.color;
    elCdriHeaderScorePill.style.borderColor = p.color;
    elCdriHeaderScorePill.style.background = `${p.color}22`;
  }
  if (elCdriUpdateTime && data.updatedAt) {
    elCdriUpdateTime.textContent = `${data.updatedAt} (UTC+8)`;
  }

  // Semicircle gauge
  setupGaugeArcs();
  if (elCdriGaugeScore && p.price !== null) {
    elCdriGaugeScore.textContent = p.price;
  }
  if (elCdriGaugeBadge && p.level) {
    elCdriGaugeBadge.textContent = `${p.level} (${p.levelEn})`;
    elCdriGaugeBadge.style.color = p.color;
    elCdriGaugeBadge.style.borderColor = p.color;
    elCdriGaugeBadge.style.background = `${p.color}20`;
    elCdriGaugeBadge.style.border = `1px solid ${p.color}`;
  }
  if (elGaugeNeedleGroup && p.price !== null) {
    // Needle rotation: 0 -> -90deg, 50 -> 0deg, 100 -> +90deg
    const angle = -90 + (Math.min(100, Math.max(0, p.price)) / 100) * 180;
    elGaugeNeedleGroup.setAttribute('transform', `rotate(${angle}, 140, 135)`);
  }

  // History comparisons
  if (elCdriHistYesterday) elCdriHistYesterday.innerHTML = createRiskPillHtml(p.yesterday, p.yesterdayRisk);
  if (elCdriHistWeek) elCdriHistWeek.innerHTML = createRiskPillHtml(p.week, p.weekRisk);
  if (elCdriHistMonth) elCdriHistMonth.innerHTML = createRiskPillHtml(p.month, p.monthRisk);

  // Yearly Extrema
  if (elCdriYearHigh) elCdriYearHigh.innerHTML = createRiskPillHtml(p.yearHigh, p.yearHighRisk);
  if (elCdriYearHighDate) elCdriYearHighDate.textContent = p.yearHighDateStr ? `(${p.yearHighDateStr})` : '';
  if (elCdriYearLow) elCdriYearLow.innerHTML = createRiskPillHtml(p.yearLow, p.yearLowRisk);
  if (elCdriYearLowDate) elCdriYearLowDate.textContent = p.yearLowDateStr ? `(${p.yearLowDateStr})` : '';
}

/**
 * Filter CDRI history data by selected timeframe
 */
function getFilteredCdriPoints() {
  if (!rawCdriData || !rawCdriData.history) return { dates: [], values: [], prices: [] };
  const h = rawCdriData.history;
  const total = h.dates.length;
  if (!total) return { dates: [], values: [], prices: [] };

  let sliceCount = total;
  if (currentCdriTimeframe === '30') sliceCount = Math.min(30, total);
  else if (currentCdriTimeframe === '90') sliceCount = Math.min(90, total);
  else if (currentCdriTimeframe === '180') sliceCount = Math.min(180, total);
  else if (currentCdriTimeframe === '365') sliceCount = Math.min(365, total);

  const startIdx = total - sliceCount;
  return {
    dates: h.dates.slice(startIdx),
    values: h.valueList.slice(startIdx),
    prices: h.priceList.slice(startIdx)
  };
}

/**
 * Render ECharts CDRI Chart
 */
function renderCdriChart() {
  if (!elCdriEcharts || typeof echarts === 'undefined') return;

  if (!cdriChartInstance) {
    cdriChartInstance = echarts.init(elCdriEcharts, getEchartsTheme(), { renderer: 'canvas' });
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => {
        if (cdriChartInstance) cdriChartInstance.resize();
      });
      ro.observe(elCdriEcharts);
    }
  }

  const { dates, values, prices } = getFilteredCdriPoints();
  if (!dates.length) return;

  const colors = getChartThemeColors();

  const option = {
    backgroundColor: 'transparent',
    animation: true,
    grid: {
      left: '3%',
      right: '4%',
      top: '10%',
      bottom: '14%',
      containLabel: true
    },
    tooltip: {
      trigger: 'axis',
      confine: true,
      backgroundColor: colors.tooltipBg,
      borderColor: colors.tooltipBorder,
      borderWidth: 1,
      padding: [10, 14],
      textStyle: {
        color: colors.tooltipText,
        fontFamily: 'JetBrains Mono',
        fontSize: 12
      },
      formatter: function(params) {
        if (!params || !params.length) return '';
        const date = params[0].name;
        let html = `<div style="font-weight:600;margin-bottom:6px;color:${colors.tooltipTitle};">${date} (UTC+8)</div>`;
        params.forEach(p => {
          if (p.seriesName === 'CDRI') {
            const val = p.value;
            let tier = '低风险';
            let col = '#22ab94';
            if (val > 80) { tier = '极端风险'; col = '#f23645'; }
            else if (val > 60) { tier = '高风险'; col = '#ffc800'; }
            else if (val > 30) { tier = '中性波动'; col = '#93ea2a'; }
            html += `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin:3px 0;">
              <span style="color:${colors.textSecondary};"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${col};margin-right:6px;"></span>CDRI 风险指数:</span>
              <span style="font-weight:700;color:${col};">${val} (${tier})</span>
            </div>`;
          } else if (p.seriesName === 'BTC 现货') {
            html += `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin:3px 0;">
              <span style="color:${colors.textSecondary};"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#38bdf8;margin-right:6px;"></span>BTC 现货价格:</span>
              <span style="font-weight:700;color:#38bdf8;">$${Number(p.value).toLocaleString()}</span>
            </div>`;
          }
        });
        return html;
      }
    },
    xAxis: {
      type: 'category',
      data: dates,
      boundaryGap: false,
      axisLine: { lineStyle: { color: colors.axisLine } },
      axisTick: { show: false },
      axisLabel: {
        color: colors.tickColor,
        fontFamily: 'JetBrains Mono',
        fontSize: 11
      }
    },
    yAxis: [
      {
        type: 'value',
        name: 'CDRI 指数',
        nameTextStyle: { color: colors.tickColor, fontSize: 11 },
        min: 0,
        max: 100,
        interval: 20,
        axisLabel: {
          color: colors.tickColor,
          fontFamily: 'JetBrains Mono',
          formatter: '{value}'
        },
        splitLine: {
          lineStyle: {
            color: colors.splitLine
          }
        }
      },
      {
        type: 'value',
        name: 'BTC 现货 (USD)',
        nameTextStyle: { color: '#38bdf8', fontSize: 11 },
        show: isCdriBtcVisible,
        min: (value) => {
          if (!isFinite(value.min) || isNaN(value.min)) return 0;
          return Math.floor(value.min * 0.9 / 1000) * 1000;
        },
        max: (value) => {
          if (!isFinite(value.max) || isNaN(value.max)) return 100000;
          return Math.ceil(value.max * 1.05 / 1000) * 1000;
        },
        axisLabel: {
          color: '#38bdf8',
          fontFamily: 'JetBrains Mono',
          formatter: (v) => `$${Math.round(v / 1000)}k`
        },
        splitLine: { show: false }
      }
    ],
    visualMap: {
      show: false,
      seriesIndex: 0,
      dimension: 1,
      pieces: [
        { gt: 0, lte: 30, color: '#22ab94' },
        { gt: 30, lte: 60, color: '#93ea2a' },
        { gt: 60, lte: 80, color: '#ffc800' },
        { gt: 80, lte: 100, color: '#f23645' }
      ],
      outOfRange: { color: '#999' }
    },
    dataZoom: [
      {
        type: 'inside',
        start: 0,
        end: 100
      },
      {
        type: 'slider',
        bottom: '2%',
        height: 18,
        borderColor: 'rgba(255, 255, 255, 0.08)',
        backgroundColor: 'rgba(0, 0, 0, 0.25)',
        fillerColor: 'rgba(255, 255, 255, 0.08)',
        handleStyle: {
          color: '#38bdf8',
          borderColor: '#0284c7'
        },
        textStyle: {
          color: '#71717a',
          fontFamily: 'JetBrains Mono',
          fontSize: 10
        }
      }
    ],
    series: [
      {
        name: 'CDRI',
        type: 'line',
        yAxisIndex: 0,
        showSymbol: false,
        data: values,
        lineStyle: { width: 2 },
        markArea: {
          silent: true,
          data: [
            [
              { name: '低风险 (0-30)', yAxis: 0, itemStyle: { color: 'rgba(34, 171, 148, 0.07)' } },
              { yAxis: 30 }
            ],
            [
              { name: '中性波动 (30-60)', yAxis: 30, itemStyle: { color: 'rgba(147, 234, 42, 0.07)' } },
              { yAxis: 60 }
            ],
            [
              { name: '高风险 (60-80)', yAxis: 60, itemStyle: { color: 'rgba(255, 200, 0, 0.07)' } },
              { yAxis: 80 }
            ],
            [
              { name: '极端风险 (80-100)', yAxis: 80, itemStyle: { color: 'rgba(242, 54, 69, 0.07)' } },
              { yAxis: 100 }
            ]
          ],
          label: {
            position: 'insideLeft',
            color: 'rgba(255, 255, 255, 0.22)',
            fontSize: 11,
            fontFamily: 'Inter',
            padding: [0, 0, 0, 8]
          }
        }
      },
      {
        name: 'BTC 现货',
        type: 'line',
        yAxisIndex: 1,
        showSymbol: false,
        data: isCdriBtcVisible ? prices : [],
        lineStyle: {
          width: 1.5,
          color: '#38bdf8',
          opacity: 0.92
        },
        itemStyle: { color: '#38bdf8' }
      }
    ]
  };

  cdriChartInstance.setOption(option, true);
  setTimeout(() => {
    if (cdriChartInstance) cdriChartInstance.resize();
  }, 50);
}

/**
 * Initialize CDRI UI event listeners
 */
function initCdriEvents() {
  // Timeframe switch buttons (1M, 3M, 6M, 1Y, ALL)
  if (cdriTimeframeSelector) {
    cdriTimeframeSelector.addEventListener('click', (e) => {
      const btn = e.target.closest('.timeframe-btn');
      if (!btn) return;
      const days = btn.dataset.days;
      if (!days || days === currentCdriTimeframe) return;

      currentCdriTimeframe = days;
      cdriTimeframeSelector.querySelectorAll('.timeframe-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderCdriChart();
    });
  }

  // BTC line toggle button
  if (btnToggleCdriBtc) {
    btnToggleCdriBtc.addEventListener('click', () => {
      isCdriBtcVisible = !isCdriBtcVisible;
      if (isCdriBtcVisible) {
        btnToggleCdriBtc.classList.add('active');
        btnToggleCdriBtc.classList.remove('inactive');
      } else {
        btnToggleCdriBtc.classList.remove('active');
        btnToggleCdriBtc.classList.add('inactive');
      }
      renderCdriChart();
    });
  }

  // Collapsible accordion drawer toggle
  if (btnToggleCdriDrawer && cdriDrawerContent && cdriDrawerArrow) {
    btnToggleCdriDrawer.addEventListener('click', () => {
      const isHidden = cdriDrawerContent.style.display === 'none';
      cdriDrawerContent.style.display = isHidden ? 'flex' : 'none';
      cdriDrawerArrow.textContent = isHidden ? '收起规则与核心指标 ▲' : '展开规则与核心指标 ▼';
    });
  }

  // Window resize handler for ECharts
  window.addEventListener('resize', () => {
    if (cdriChartInstance) cdriChartInstance.resize();
  });
}

// ============================================================================
// Futures Basis Term Structure (real tenors) & Carry Score Controller
// ============================================================================

let currentTermPremiumData = null;
let termPremiumChartInstance = null;
let currentTpTimeframe = 'all'; // '30', '90', '180', '365', 'all'
let tpVisibleSeries = {
  spreadTerm: true,
  spreadShort: true,
  spreadCalendar: true,
  apr90d: true,
  hurdle: true,
  tbill: true,
  carryScore: true,
  btcPrice: true,
  allCurves: false
};

// Carry score tiers (0-100), mirrored from server/basis_fetcher.js scoreTier()
function tpScoreColor(score) {
  if (score == null) return '#71717a';
  if (score >= 65) return '#10b981';
  if (score >= 45) return '#38bdf8';
  if (score >= 30) return '#f59e0b';
  return '#f43f5e';
}
function tpScoreTierLabel(score) {
  if (score == null) return '--';
  if (score >= 65) return '优质';
  if (score >= 45) return '合格';
  if (score >= 30) return '边际';
  return '回避';
}
function tpPct(v, digits = 2) {
  if (v == null || !isFinite(v)) return '--';
  return `${v >= 0 ? '+' : ''}${Number(v).toFixed(digits)}%`;
}

// DOM Elements
const elTpHeaderRegimePill = document.getElementById('tp-header-regime-pill');
const elTpHeaderScorePill = document.getElementById('tp-header-score-pill');
const elTpHeaderExcessPill = document.getElementById('tp-header-excess-pill');
const elTpUpdateTime = document.getElementById('tp-update-time');
const elTpDataSourceBadge = document.getElementById('tp-data-source-badge');
const elTpHistoryPointsBadge = document.getElementById('tp-history-points-badge');

const elTpValFunding = document.getElementById('tp-val-funding');
const elTpValCq = document.getElementById('tp-val-cq');
const elTpLblCq = document.getElementById('tp-lbl-cq');
const elTpValNq = document.getElementById('tp-val-nq');
const elTpLblNq = document.getElementById('tp-lbl-nq');
const elTpVal90d = document.getElementById('tp-val-90d');
const elTpValTbill = document.getElementById('tp-val-tbill');
const elTpEtfNet = document.getElementById('tp-etf-net');
const elTpEtfStatusBadge = document.getElementById('tp-etf-status-badge');

const elTpSpreadTerm = document.getElementById('tp-spread-term');
const elTpSpreadShort = document.getElementById('tp-spread-short');
const elTpSpreadCalendar = document.getElementById('tp-spread-calendar');

const elTpRegimeTag = document.getElementById('tp-regime-tag');
const elTpScoreValue = document.getElementById('tp-score-value');
const elTpScoreTier = document.getElementById('tp-score-tier');
const elTpExcessVal = document.getElementById('tp-excess-val');
const elTpSharpeVal = document.getElementById('tp-sharpe-val');
const elTpScoreBarFill = document.getElementById('tp-score-bar-fill');
const elTpScoreComponents = document.getElementById('tp-score-components');

const elTpInsightsSummary = document.getElementById('tp-insights-summary');
const elTpInsightsList = document.getElementById('tp-insights-list');

const elTpEcharts = document.getElementById('term-premium-echarts');
const tpTimeframeSelector = document.getElementById('tp-timeframe-selector');

/**
 * Fallback independent fetcher for Term Premium
 */
async function loadTermPremiumData() {
  try {
    const resp = await fetch('/api/term-premium');
    if (!resp.ok) return;
    const json = await resp.json();
    if (json.code === 0) {
      renderTermPremium(json);
    }
  } catch (err) {
    console.error('[Term Premium] Error loading data:', err);
  }
}

function tpSetSigned(el, v, { neutralColor = null, nullText = '--%' } = {}) {
  if (!el) return;
  if (v == null || !isFinite(v)) {
    el.textContent = nullText;
    el.style.color = '';
    return;
  }
  el.textContent = tpPct(v);
  el.style.color = neutralColor || (v >= 0 ? '#10b981' : '#f43f5e');
}

/**
 * Render all Term Premium metrics and chart
 */
function renderTermPremium(data, forceRedraw = false) {
  if (!data) return;
  const prevLatestTime = currentTermPremiumData?.current?.timestamp;
  const prevSeriesLen = currentTermPremiumData?.series?.length;
  currentTermPremiumData = data;

  const c = data.current;
  const reg = data.regime || {};

  // Header pills & provenance badges
  if (elTpDataSourceBadge && data.metadata?.dataSource) {
    elTpDataSourceBadge.title = `数据源：${data.metadata.dataSource} | 区间: ${data.metadata.timeRange || ''} | 期限: ${data.metadata.tenorMethod || ''} | 评分: ${data.metadata.scoreMethod || ''}`;
  }
  if (elTpHistoryPointsBadge && data.series?.length) {
    // Daily snapshots are stamped 00:00 UTC (08:00 UTC+8); flag the badge when the feed has stalled
    const feed = data.metadata?.feed || {};
    const stale = feed.upToDate === false || feed.liveOk === false;
    const dailyText = feed.latestDate ? `日线截至 ${feed.latestDate}` : `${data.series.length} 条日线`;
    const liveText = feed.liveOk === false ? ' · 实时盘口失败' : ' · 实时 ✓';
    elTpHistoryPointsBadge.textContent = `${dailyText}${liveText}`;
    elTpHistoryPointsBadge.style.color = stale ? '#f43f5e' : '';
    elTpHistoryPointsBadge.style.borderColor = stale ? 'rgba(244, 63, 94, 0.35)' : '';
    elTpHistoryPointsBadge.style.background = stale ? 'rgba(244, 63, 94, 0.1)' : '';
    elTpHistoryPointsBadge.title = [
      `${data.series.length} 条真实日线（${data.series[0].date} 起），每日快照为 00:00 UTC（北京时间 08:00）`,
      feed.expectedDate ? `应有最新日线：${feed.expectedDate}` : '',
      feed.lastSuccessAt ? `上次成功拉取：${formatUTC8(feed.lastSuccessAt)} (UTC+8)` : '',
      feed.lastError ? `日线拉取失败：${feed.lastError}` : '',
      feed.liveError ? `实时盘口失败：${feed.liveError}` : ''
    ].filter(Boolean).join('\n');
  }

  if (elTpHeaderRegimePill && reg.regimeName) {
    elTpHeaderRegimePill.textContent = reg.regimeName.split(' ')[0] || '升水结构';
    if (reg.regimeBadgeClass) {
      elTpHeaderRegimePill.className = `tp-regime-pill ${reg.regimeBadgeClass}`;
    }
  }
  if (elTpHeaderScorePill && c && c.carryScore != null) {
    elTpHeaderScorePill.textContent = `Carry: ${c.carryScore.toFixed(1)} ${tpScoreTierLabel(c.carryScore)}`;
    elTpHeaderScorePill.style.color = tpScoreColor(c.carryScore);
  }
  if (elTpHeaderExcessPill && c && c.excessOverTBill != null) {
    elTpHeaderExcessPill.textContent = `超额美债: ${tpPct(c.excessOverTBill)}`;
  }
  if (elTpUpdateTime && c) {
    elTpUpdateTime.textContent = `${formatUTC8(c.timestamp || Date.now())} (UTC+8)`;
  }

  if (c) {
    // 1. Real tenor points
    tpSetSigned(elTpValFunding, c.fundingApr);
    if (elTpValFunding) elTpValFunding.title = c.fundingApr24h != null ? `过去 24h 资金费率年化: ${tpPct(c.fundingApr24h)}` : '';
    if (elTpLblCq) elTpLblCq.textContent = c.cqDays != null ? `当季 (${Math.round(c.cqDays)}D)` : '当季';
    tpSetSigned(elTpValCq, c.cqApr, { nullText: '末周剔除' });
    if (elTpLblNq) elTpLblNq.textContent = c.nqDays != null ? `次季 (${Math.round(c.nqDays)}D)` : '次季';
    tpSetSigned(elTpValNq, c.nqApr);
    tpSetSigned(elTpVal90d, c.apr90d, { neutralColor: '#f59e0b' });
    if (elTpValTbill) elTpValTbill.textContent = c.tbill != null ? `${c.tbill.toFixed(2)}%` : '--%';

    // ETF cash-and-carry net yield
    if (elTpEtfNet) {
      tpSetSigned(elTpEtfNet, c.etfNetCarry);
    }
    if (elTpEtfStatusBadge) {
      const covered = c.etfArbitrageStatus === 'COVERED';
      elTpEtfStatusBadge.textContent = covered ? '成本覆盖' : '成本未覆盖';
      elTpEtfStatusBadge.className = `tp-ef-badge ${covered ? 'profitable' : 'unprofitable'}`;
      elTpEtfStatusBadge.title = c.etfCostAnnualized != null
        ? `90D 基差 − 3M 美债 − 年化成本 ${c.etfCostAnnualized}%（管理费 0.25%/年 + 申赎与滑点 0.25% 按 90 天摊销）`
        : '';
    }

    // 2. Spreads
    tpSetSigned(elTpSpreadTerm, c.spreadTerm);
    tpSetSigned(elTpSpreadShort, c.spreadShort, { nullText: '当季末周' });
    tpSetSigned(elTpSpreadCalendar, c.spreadCalendar, { nullText: '当季末周' });

    // 3. Carry score
    if (elTpRegimeTag && reg.regimeCode) {
      elTpRegimeTag.textContent = reg.regimeCode.replace(/_/g, ' ');
    }
    const score = c.carryScore;
    const scoreColor = tpScoreColor(score);
    if (elTpScoreValue) {
      elTpScoreValue.textContent = score != null ? score.toFixed(1) : '--';
      elTpScoreValue.style.color = scoreColor;
    }
    if (elTpScoreTier) {
      elTpScoreTier.textContent = tpScoreTierLabel(score);
      elTpScoreTier.style.color = scoreColor;
    }
    tpSetSigned(elTpExcessVal, c.excessOverTBill);
    if (elTpSharpeVal) {
      elTpSharpeVal.textContent = c.carrySharpe != null
        ? `${c.carrySharpe.toFixed(2)} / ${c.basisVolAnn != null ? c.basisVolAnn.toFixed(2) + '%' : '--'}`
        : '--';
    }
    if (elTpScoreBarFill && score != null) {
      elTpScoreBarFill.style.width = `${Math.max(3, Math.min(100, score))}%`;
    }
    if (elTpScoreComponents && c.scoreComponents) {
      ['sharpe', 'structure', 'momentum'].forEach(key => {
        const v = c.scoreComponents[key];
        const fill = elTpScoreComponents.querySelector(`[data-comp="${key}"]`);
        const val = elTpScoreComponents.querySelector(`[data-comp-val="${key}"]`);
        if (fill) {
          fill.style.width = `${v != null ? v : 0}%`;
          fill.style.background = tpScoreColor(v);
        }
        if (val) val.textContent = v != null ? v.toFixed(0) : '--';
      });
    }
  }

  // 4. Institutional Insights
  if (elTpInsightsSummary && reg.statusSummary) {
    elTpInsightsSummary.textContent = reg.statusSummary;
  }
  if (elTpInsightsList && reg.keyPointers) {
    elTpInsightsList.innerHTML = reg.keyPointers.map(p => `<li>${escapeHtml(p)}</li>`).join('');
  }

  const shouldRedraw = forceRedraw ||
                       !termPremiumChartInstance ||
                       prevLatestTime !== data.current?.timestamp ||
                       prevSeriesLen !== data.series?.length;
  if (shouldRedraw) {
    renderTermPremiumChart();
  }
}

/**
 * Render Dual-Grid ECharts: 90D basis / benchmarks / score / price on top, real-tenor spreads below
 */
function renderTermPremiumChart() {
  if (!elTpEcharts || !currentTermPremiumData || !currentTermPremiumData.series) return;

  if (!termPremiumChartInstance) {
    termPremiumChartInstance = echarts.init(elTpEcharts, getEchartsTheme());
  }

  const rawSeries = currentTermPremiumData.series;
  if (!rawSeries || !rawSeries.length) return;

  const colors = getChartThemeColors();

  let sliced = rawSeries;
  if (currentTpTimeframe !== 'all') sliced = rawSeries.slice(-Number(currentTpTimeframe));

  const dates = sliced.map(s => (s.isLive ? `${s.date} 实时` : s.date));
  const pick = key => sliced.map(s => (s[key] != null ? s[key] : null));
  const seriesList = [];
  const line = (id, name, key, color, extra = {}) => ({
    id,
    name,
    type: 'line',
    xAxisIndex: id.startsWith('bot-') ? 1 : 0,
    yAxisIndex: id.startsWith('bot-') ? 1 : 0,
    showSymbol: false,
    connectNulls: false,
    data: pick(key),
    lineStyle: { width: 1.6, color },
    itemStyle: { color },
    ...extra
  });

  if (tpVisibleSeries.apr90d) {
    seriesList.push(line('top-apr90d', '90D 基差 APR', 'apr90d', '#f59e0b', { smooth: 0.2, lineStyle: { width: 2.2, color: '#f59e0b' } }));
  }
  if (tpVisibleSeries.hurdle) {
    seriesList.push(line('top-hurdle', '机构门槛 (美债+3.5%)', 'hurdle', '#ec4899', { lineStyle: { width: 1.6, color: '#ec4899', type: 'dashed' } }));
  }
  if (tpVisibleSeries.tbill) {
    seriesList.push(line('top-tbill', '3M 美债', 'tbill', '#f43f5e', { lineStyle: { width: 1.4, color: '#f43f5e', type: 'dotted' } }));
  }
  if (tpVisibleSeries.allCurves) {
    seriesList.push(line('top-funding', '0D 资金费率 (7D均) APR', 'fundingApr', '#a1a1aa', { lineStyle: { width: 1, color: '#a1a1aa', opacity: 0.7 } }));
    seriesList.push(line('top-cq', '当季 APR', 'cqApr', '#38bdf8', { lineStyle: { width: 1.3, color: '#38bdf8' } }));
    seriesList.push(line('top-nq', '次季 APR', 'nqApr', '#10b981', { lineStyle: { width: 1.3, color: '#10b981' } }));
  }
  if (tpVisibleSeries.carryScore) {
    seriesList.push({
      ...line('top-carryScore', '套利评分 (0-100)', 'carryScore', '#818cf8', { smooth: 0.25, lineStyle: { width: 2, color: '#818cf8' } }),
      yAxisIndex: 2,
      markLine: {
        silent: true,
        symbol: 'none',
        data: [
          { yAxis: 65, lineStyle: { color: 'rgba(16, 185, 129, 0.45)', type: 'dashed', width: 1 }, label: { show: true, position: 'insideEndTop', formatter: '优质 65', color: '#10b981', fontSize: 10 } },
          { yAxis: 45, lineStyle: { color: 'rgba(56, 189, 248, 0.4)', type: 'dashed', width: 1 }, label: { show: true, position: 'insideEndTop', formatter: '合格 45', color: '#38bdf8', fontSize: 10 } },
          { yAxis: 30, lineStyle: { color: 'rgba(245, 158, 11, 0.4)', type: 'dashed', width: 1 }, label: { show: true, position: 'insideEndTop', formatter: '边际 30', color: '#f59e0b', fontSize: 10 } }
        ]
      }
    });
  }
  if (tpVisibleSeries.btcPrice) {
    seriesList.push({
      ...line('top-btcPrice', 'BTC 价格 (USD)', 'btcPrice', '#94a3b8', { z: 1, lineStyle: { width: 1.4, color: '#94a3b8', opacity: 0.85 } }),
      yAxisIndex: 3
    });
  }

  if (tpVisibleSeries.spreadTerm) {
    seriesList.push(line('bot-spreadTerm', '90D − 资金费率 期限斜率', 'spreadTerm', '#38bdf8', {
      lineStyle: { width: 1.8, color: '#38bdf8' },
      areaStyle: {
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: 'rgba(56, 189, 248, 0.18)' },
          { offset: 1, color: 'rgba(56, 189, 248, 0.0)' }
        ])
      },
      markLine: {
        silent: true,
        symbol: 'none',
        data: [{ yAxis: 0, lineStyle: { color: colors.gridLineStrong, type: 'dashed', width: 1 }, label: { show: true, position: 'end', formatter: '0%', color: '#71717a', fontSize: 10 } }]
      }
    }));
  }
  if (tpVisibleSeries.spreadShort) {
    seriesList.push(line('bot-spreadShort', '当季 − 资金费率 短端利差', 'spreadShort', '#a855f7'));
  }
  if (tpVisibleSeries.spreadCalendar) {
    seriesList.push(line('bot-spreadCalendar', '次季 − 当季 跨期斜率', 'spreadCalendar', '#10b981'));
  }

  const tooltipRow = (p, valueHtml) => `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin:2px 0;">
    <span style="color:${colors.textSecondary};"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};margin-right:6px;"></span>${p.seriesName}:</span>
    ${valueHtml}
  </div>`;

  // Fixed pixel margins (no containLabel) so both grids share the same plot width
  const tpGridRight = 24 + (tpVisibleSeries.carryScore ? 44 : 0) + (tpVisibleSeries.btcPrice ? 52 : 0);
  const option = {
    backgroundColor: 'transparent',
    animation: false,
    grid: [
      { left: 64, right: tpGridRight, top: '6%', height: '42%' },
      { left: 64, right: tpGridRight, top: '55%', height: '39%' }
    ],
    axisPointer: {
      link: [{ xAxisIndex: 'all' }],
      label: { backgroundColor: colors.axisPointerBg, fontFamily: 'JetBrains Mono', fontSize: 11 }
    },
    tooltip: {
      trigger: 'axis',
      confine: true,
      backgroundColor: colors.tooltipBg,
      borderColor: colors.tooltipBorder,
      borderWidth: 1,
      padding: [10, 14],
      textStyle: { color: colors.tooltipText, fontFamily: 'JetBrains Mono', fontSize: 12 },
      formatter: function (params) {
        if (!params || !params.length) return '';
        const row = sliced[params[0].dataIndex] || {};
        let html = `<div style="font-weight:600;margin-bottom:6px;color:${colors.tooltipTitle};">${params[0].name}</div>`;

        const topItems = params.filter(p => p.seriesId && p.seriesId.startsWith('top-') && p.value != null);
        if (topItems.length) {
          html += `<div style="font-size:11px;color:${colors.textSecondary};border-bottom:1px solid ${colors.tooltipDivider};padding-bottom:2px;">基差与套利评分:</div>`;
          topItems.forEach(p => {
            const v = Number(p.value);
            if (p.seriesId === 'top-btcPrice') {
              html += tooltipRow(p, `<span style="font-weight:700;color:${p.color};">$${Math.round(v).toLocaleString('en-US')}</span>`);
            } else if (p.seriesId === 'top-carryScore') {
              const col = tpScoreColor(v);
              html += tooltipRow(p, `<span style="font-weight:700;color:${col};">${v.toFixed(1)} <span style="font-size:10px;padding:1px 5px;border-radius:3px;background:${col}22;">${tpScoreTierLabel(v)}</span></span>`);
            } else {
              html += tooltipRow(p, `<span style="font-weight:700;color:${p.color};">${v.toFixed(2)}%</span>`);
            }
          });
          if (row.cqValid === false) {
            html += `<div style="font-size:10px;color:${colors.textMuted};margin-top:2px;">当季距交割 ${row.cqDays}D (&lt;7D)，已从曲线剔除</div>`;
          }
        }

        const botItems = params.filter(p => p.seriesId && p.seriesId.startsWith('bot-') && p.value != null);
        if (botItems.length) {
          html += `<div style="font-size:11px;color:${colors.textSecondary};margin-top:6px;border-bottom:1px solid ${colors.tooltipDivider};padding-bottom:2px;">真实期限利差:</div>`;
          botItems.forEach(p => {
            const v = Number(p.value);
            html += tooltipRow(p, `<span style="font-weight:700;color:${v >= 0 ? '#38bdf8' : '#f43f5e'};">${tpPct(v)}</span>`);
          });
        }
        return html;
      }
    },
    xAxis: [
      {
        type: 'category', gridIndex: 0, data: dates, boundaryGap: false,
        axisLine: { lineStyle: { color: colors.axisLine } }, axisTick: { show: false }, axisLabel: { show: false }
      },
      {
        type: 'category', gridIndex: 1, data: dates, boundaryGap: false,
        axisLine: { lineStyle: { color: colors.axisLine } }, axisTick: { show: false },
        axisLabel: { color: colors.tickColor, fontFamily: 'JetBrains Mono', fontSize: 11, showMinLabel: true, showMaxLabel: true }
      }
    ],
    yAxis: [
      {
        type: 'value', gridIndex: 0, name: '基差 APR (%)',
        nameTextStyle: { color: colors.tickColor, fontSize: 11 },
        axisLabel: { color: colors.tickColor, fontFamily: 'JetBrains Mono', formatter: '{value}%' },
        splitLine: { lineStyle: { color: colors.gridLine } }
      },
      {
        type: 'value', gridIndex: 1, name: '期限利差 (%)',
        nameTextStyle: { color: colors.tickColor, fontSize: 11 },
        axisLabel: { color: colors.tickColor, fontFamily: 'JetBrains Mono', formatter: '{value}%' },
        splitLine: { lineStyle: { color: colors.gridLine } }
      },
      {
        type: 'value', gridIndex: 0, position: 'right', min: 0, max: 100, name: '评分',
        nameTextStyle: { color: '#818cf8', fontSize: 10, fontFamily: 'JetBrains Mono' },
        axisLabel: { color: '#818cf8', fontFamily: 'JetBrains Mono', fontSize: 10 },
        splitLine: { show: false },
        show: tpVisibleSeries.carryScore
      },
      {
        type: 'value', gridIndex: 0, position: 'right', offset: tpVisibleSeries.carryScore ? 48 : 0, scale: true, name: 'BTC (USD)',
        nameTextStyle: { color: '#94a3b8', fontSize: 10, fontFamily: 'JetBrains Mono' },
        axisLabel: { color: '#94a3b8', fontFamily: 'JetBrains Mono', fontSize: 10, formatter: v => `$${Math.round(v / 1000)}k` },
        splitLine: { show: false },
        show: tpVisibleSeries.btcPrice
      }
    ],
    series: seriesList
  };

  termPremiumChartInstance.setOption(option, true);
  setTimeout(() => {
    if (termPremiumChartInstance) termPremiumChartInstance.resize();
  }, 50);
}

/**
 * Initialize Term Premium UI event listeners
 */
function initTermPremiumEvents() {
  if (tpTimeframeSelector) {
    tpTimeframeSelector.addEventListener('click', (e) => {
      const btn = e.target.closest('.timeframe-btn');
      if (!btn) return;
      const days = btn.dataset.days;
      if (!days || days === currentTpTimeframe) return;

      currentTpTimeframe = days;
      tpTimeframeSelector.querySelectorAll('.timeframe-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderTermPremiumChart();
    });
  }

  function setupToggle(id, key) {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener('click', () => {
      tpVisibleSeries[key] = !tpVisibleSeries[key];
      btn.classList.toggle('active', tpVisibleSeries[key]);
      btn.classList.toggle('inactive', !tpVisibleSeries[key] && key !== 'allCurves');
      if (key === 'allCurves') {
        btn.querySelector('span:last-child').textContent = tpVisibleSeries.allCurves ? '收起真实期限点' : '展开真实期限点';
      }
      renderTermPremiumChart();
    });
  }

  setupToggle('btn-toggle-spread-term', 'spreadTerm');
  setupToggle('btn-toggle-spread-short', 'spreadShort');
  setupToggle('btn-toggle-spread-calendar', 'spreadCalendar');
  setupToggle('btn-toggle-apr90d', 'apr90d');
  setupToggle('btn-toggle-hurdle', 'hurdle');
  setupToggle('btn-toggle-tbill', 'tbill');
  setupToggle('btn-toggle-carry-score', 'carryScore');
  setupToggle('btn-toggle-btc-price', 'btcPrice');
  setupToggle('btn-toggle-all-curves', 'allCurves');

  window.addEventListener('resize', () => {
    if (termPremiumChartInstance) termPremiumChartInstance.resize();
  });
}

// ============================================================================
// Module 2-B: ETF flows × basis-arbitrage capital linkage Controller
// ============================================================================

let rawEtfLinkageData = null;
let elWeeklyChartInstance = null;
let elDecompChartInstance = null;
let elLeadLagChartInstance = null;
let elOiChartInstance = null;
let elScatterChartInstance = null;
let elFlowUnit = 'btc';
let elOiUnit = 'usd';
let elShowCmeOi = false;

function elFmtBtc(v, signed = true) {
  if (v == null || !isFinite(v)) return '--';
  const sign = signed && v > 0 ? '+' : '';
  const abs = Math.abs(v);
  const body = abs >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0);
  return `${sign}${body} BTC`;
}
function elFmtUsd(v, signed = true) {
  if (v == null || !isFinite(v)) return '--';
  const sign = signed && v > 0 ? '+' : (v < 0 ? '-' : '');
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(0)}M`;
  return `${sign}$${abs.toFixed(0)}`;
}
function elFmtNum(v, d = 2) {
  return v == null || !isFinite(v) ? '--' : Number(v).toFixed(d);
}
function elFmtShare(v) {
  return v == null || !isFinite(v) ? '--' : `${(v * 100).toFixed(0)}%`;
}

function elInitChart(instance, id) {
  if (instance) return instance;
  const dom = document.getElementById(id);
  return dom ? echarts.init(dom, getEchartsTheme()) : null;
}

async function loadEtfLinkageData(force = false) {
  const status = document.getElementById('el-status');
  try {
    const resp = await fetch(`/api/etf-linkage${force ? '?force=1' : ''}`);
    const json = await resp.json();
    if (json.code !== 0) throw new Error(json.error || `HTTP ${resp.status}`);
    rawEtfLinkageData = json;
    if (status) {
      status.textContent = json.stale ? '⚠ 上游数据暂不可用，显示最近一次缓存结果' : '';
      status.classList.toggle('error', !!json.stale);
    }
    renderEtfLinkage();
  } catch (err) {
    console.error('[ETF Linkage] Failed to load:', err);
    if (status) {
      status.textContent = `ETF 联动数据加载失败：${err.message}`;
      status.classList.add('error');
    }
  }
}

function renderEtfLinkage() {
  const d = rawEtfLinkageData;
  if (!d) return;
  const setText = (id, text, color) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    if (color !== undefined) el.style.color = color || '';
  };

  // Header
  const pill = document.getElementById('el-verdict-pill');
  if (pill && d.verdict) {
    pill.textContent = `${d.verdict.levelLabel} ${d.verdict.passed}/${d.verdict.total}`;
    pill.className = `el-verdict-pill ${d.verdict.level.toLowerCase()}`;
  }
  const lastWeek = d.weeks?.[d.weeks.length - 1];
  setText('el-update-time', `COT 截至 ${lastWeek?.weekEnd || '--'} · 生成 ${formatUTC8(d.generatedAt, false)}`);

  // KPIs
  const full = d.hedgeRatio?.full || {};
  const rec = d.hedgeRatio?.recent || {};
  const betaColor = b => (b == null ? '' : b >= 0.3 ? '#10b981' : b >= 0.15 ? '#f59e0b' : '#f43f5e');
  setText('el-kpi-beta', elFmtNum(full.beta), betaColor(full.beta));
  setText('el-kpi-beta-sub', `t=${elFmtNum(full.tBeta, 1)} · R²=${elFmtNum(full.r2)} · n=${full.n ?? '--'}`);
  setText('el-kpi-beta12', elFmtNum(rec.beta), betaColor(rec.beta));
  setText('el-kpi-beta12-sub', `R²=${elFmtNum(rec.r2)} · 相关=${elFmtNum(rec.corr)}`);
  setText('el-kpi-arbshare', elFmtShare(d.arbShare12w));
  setText('el-kpi-arbshare-sub', `全样本 ${elFmtShare(d.arbShareAll)}`);
  const cd = d.carryDependence || {};
  setText('el-kpi-split', `${elFmtNum(cd.high?.beta)} / ${elFmtNum(cd.low?.beta)}`);
  setText('el-kpi-split-sub', `${cd.high?.weeks ?? '--'} 周 / ${cd.low?.weeks ?? '--'} 周 · 交互 t=${elFmtNum(cd.interaction?.tInteraction, 1)}`);
  const us = d.unwindSync || {};
  setText('el-kpi-sync', elFmtShare(us.syncShareSubTbill));
  setText('el-kpi-sync-sub', `低于美债周 vs 其他周 ${elFmtShare(us.syncShareOther)}`);
  const lead1 = (d.leadLag || []).find(l => l.lag === 1);
  const lag1 = (d.leadLag || []).find(l => l.lag === -1);
  setText('el-kpi-lead', elFmtNum(lead1?.corrFlow));
  setText('el-kpi-lead-sub', `反向（流入 → 基差变化）${elFmtNum(lag1?.corrFlow)}`);
  if (lastWeek) {
    setText('el-kpi-lf', elFmtBtc(lastWeek.lfNetShortBtc, false));
    setText('el-kpi-lf-sub', `周变化 ${elFmtBtc(lastWeek.dLfNetShortBtc)} · ETF ${elFmtBtc(lastWeek.etfFlowBtc)}`);
  }

  // Verdict checks
  setText('el-verdict-count', d.verdict ? `${d.verdict.passed}/${d.verdict.total} 通过` : '--');
  setText('el-verdict-summary', d.verdict?.summary || '--');
  const list = document.getElementById('el-check-list');
  if (list && d.verdict?.checks) {
    const marks = ['①', '②', '③', '④', '⑤'];
    list.innerHTML = d.verdict.checks.map((c, i) => `<li class="${c.pass ? 'pass' : 'fail'}">
      <span class="el-check-mark">${marks[i] || ''} ${c.pass ? '✓' : '✗'}</span>
      <span class="el-check-label">${escapeHtml(c.label)}</span>
      <span class="el-check-detail">${escapeHtml(c.detail)}</span>
    </li>`).join('');
  }

  // Episodes
  const body = document.getElementById('el-episode-body');
  if (body) {
    const eps = d.unwindEpisodes || [];
    setText('el-episode-count', `${eps.length} 段`);
    body.innerHTML = eps.length
      ? eps.map(ep => {
        const tag = ep.jointUnwind
          ? '<span class="el-tag pos">ETF 流出 + 空头回补</span>'
          : '<span class="el-tag neutral">未同步</span>';
        return `<tr>
          <td>${escapeHtml(ep.start)} → ${escapeHtml(ep.end)}${ep.ongoing ? ' (进行中)' : ''}</td>
          <td>${ep.weeks}</td>
          <td style="color:#f43f5e;">${tpPct(ep.minCarry)}</td>
          <td style="color:${ep.cumFlowBtc >= 0 ? '#10b981' : '#f43f5e'};">${elFmtBtc(ep.cumFlowBtc)} (${elFmtUsd(ep.cumFlowUsd)})</td>
          <td style="color:${ep.cumDLfNetShortBtc >= 0 ? '#10b981' : '#f43f5e'};">${elFmtBtc(ep.cumDLfNetShortBtc)}</td>
          <td>${tag}</td>
        </tr>`;
      }).join('')
      : '<tr><td colspan="6">样本期内基差未低于美债</td></tr>';
  }

  // Caveats
  const cav = document.getElementById('el-caveats');
  if (cav && d.metadata) {
    const src = d.metadata.sources || {};
    cav.innerHTML = [
      `<span><strong class="text-cyan">数据:</strong> ${escapeHtml(src.etfFlows || '')} · ${escapeHtml(src.cme || '')}</span>`,
      `<span><strong class="text-cyan">对齐:</strong> ${escapeHtml(d.metadata.weekDefinition || '')}</span>`,
      ...(d.metadata.caveats || []).map(t => `<span>· ${escapeHtml(t)}</span>`)
    ].join('');
  }

  renderElWeeklyChart();
  renderElScatterChart();
  renderElLeadLagChart();
  renderElDecompChart();
  renderElOiChart();
}

function elTooltipBase(colors) {
  return {
    trigger: 'axis',
    confine: true,
    backgroundColor: colors.tooltipBg,
    borderColor: colors.tooltipBorder,
    borderWidth: 1,
    padding: [8, 12],
    textStyle: { color: colors.tooltipText, fontFamily: 'JetBrains Mono', fontSize: 12 }
  };
}

function elAxisCommon(colors) {
  return {
    axisLine: { lineStyle: { color: colors.axisLine } },
    axisTick: { show: false },
    axisLabel: { color: colors.tickColor, fontFamily: 'JetBrains Mono', fontSize: 10 },
    splitLine: { lineStyle: { color: colors.gridLine } }
  };
}

function renderElWeeklyChart() {
  const d = rawEtfLinkageData;
  if (!d?.weeks?.length) return;
  elWeeklyChartInstance = elInitChart(elWeeklyChartInstance, 'el-weekly-echarts');
  if (!elWeeklyChartInstance) return;
  const colors = getChartThemeColors();
  const weeks = d.weeks;
  const usd = elFlowUnit === 'usd';
  const flow = weeks.map(w => (usd ? w.etfFlowUsd : w.etfFlowBtc));
  const dLf = weeks.map(w => (usd ? (w.btcPrice ? w.dLfNetShortBtc * w.btcPrice : null) : w.dLfNetShortBtc));
  const fmtAxis = v => (usd ? elFmtUsd(v, false) : `${Math.round(v / 1000)}k`);
  const rolling = d.hedgeRatio?.rolling || [];
  const common = elAxisCommon(colors);

  elWeeklyChartInstance.setOption({
    backgroundColor: 'transparent',
    animation: false,
    grid: [
      { left: 64, right: 108, top: 30, height: '52%' },
      { left: 64, right: 108, top: '72%', height: '20%' }
    ],
    legend: {
      top: 0,
      textStyle: { color: colors.textSecondary, fontSize: 11 },
      data: ['ETF 周净流入', 'CME 杠杆基金净空头 Δ', '90D 超额美债', 'BTC 价格', '12 周滚动 β', '12 周 R²']
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    tooltip: {
      ...elTooltipBase(colors),
      formatter: params => {
        const w = weeks[params[0].dataIndex];
        const r = rolling[params[0].dataIndex] || {};
        if (!w) return '';
        return `<div style="font-weight:600;margin-bottom:4px;">周截至 ${w.weekEnd}（${w.etfDays} 个交易日）</div>
          <div>ETF 净流入: <b>${elFmtBtc(w.etfFlowBtc)}</b> (${elFmtUsd(w.etfFlowUsd)})</div>
          <div>杠杆基金净空头 Δ: <b>${elFmtBtc(w.dLfNetShortBtc)}</b>（存量 ${elFmtBtc(w.lfNetShortBtc, false)}）</div>
          <div>资管净多头 Δ: ${elFmtBtc(w.dAmNetLongBtc)} · CME OI Δ: ${elFmtBtc(w.dCmeOiBtc)}</div>
          <div>套利匹配: ${elFmtBtc(w.arbMatchedBtc)} · 方向性: ${elFmtBtc(w.directionalBtc)}</div>
          <div>90D 超额美债: ${tpPct(w.excessOverTBill)} · BTC $${w.btcPrice ? w.btcPrice.toLocaleString('en-US') : '--'}</div>
          <div style="margin-top:4px;color:${colors.textSecondary};">12 周 β ${elFmtNum(r.beta)} · R² ${elFmtNum(r.r2)}</div>`;
      }
    },
    xAxis: [
      { type: 'category', gridIndex: 0, data: weeks.map(w => w.weekEnd), ...common, axisLabel: { show: false }, splitLine: { show: false } },
      { type: 'category', gridIndex: 1, data: weeks.map(w => w.weekEnd), ...common, splitLine: { show: false } }
    ],
    yAxis: [
      { type: 'value', gridIndex: 0, ...common, axisLabel: { ...common.axisLabel, formatter: fmtAxis }, name: usd ? 'USD' : 'BTC', nameTextStyle: { color: colors.tickColor, fontSize: 10 } },
      { type: 'value', gridIndex: 0, position: 'right', ...common, splitLine: { show: false }, axisLabel: { ...common.axisLabel, color: '#f59e0b', formatter: '{value}%' }, name: '超额', nameTextStyle: { color: '#f59e0b', fontSize: 10 } },
      { type: 'value', gridIndex: 0, position: 'right', offset: 48, scale: true, ...common, splitLine: { show: false }, axisLabel: { ...common.axisLabel, color: '#94a3b8', formatter: v => `$${Math.round(v / 1000)}k` } },
      { type: 'value', gridIndex: 1, ...common, name: 'β / R²', nameTextStyle: { color: colors.tickColor, fontSize: 10 } }
    ],
    series: [
      {
        name: 'ETF 周净流入', type: 'bar', xAxisIndex: 0, yAxisIndex: 0, barMaxWidth: 8,
        data: flow.map(v => ({ value: v, itemStyle: { color: v >= 0 ? 'rgba(16,185,129,0.75)' : 'rgba(244,63,94,0.75)' } })),
        itemStyle: { color: '#10b981' }
      },
      {
        name: 'CME 杠杆基金净空头 Δ', type: 'line', xAxisIndex: 0, yAxisIndex: 0, showSymbol: false,
        data: dLf, lineStyle: { width: 1.8, color: '#a855f7' }, itemStyle: { color: '#a855f7' }
      },
      {
        name: '90D 超额美债', type: 'line', xAxisIndex: 0, yAxisIndex: 1, showSymbol: false, connectNulls: false,
        data: weeks.map(w => w.excessOverTBill), lineStyle: { width: 1.6, color: '#f59e0b' }, itemStyle: { color: '#f59e0b' },
        markLine: { silent: true, symbol: 'none', data: [{ yAxis: 0, lineStyle: { color: 'rgba(245,158,11,0.35)', type: 'dashed' }, label: { show: false } }] }
      },
      {
        name: 'BTC 价格', type: 'line', xAxisIndex: 0, yAxisIndex: 2, showSymbol: false, z: 1,
        data: weeks.map(w => w.btcPrice), lineStyle: { width: 1.2, color: '#94a3b8', opacity: 0.8 }, itemStyle: { color: '#94a3b8' }
      },
      {
        name: '12 周滚动 β', type: 'line', xAxisIndex: 1, yAxisIndex: 3, showSymbol: false, connectNulls: false,
        data: rolling.map(r => r.beta), lineStyle: { width: 1.8, color: '#818cf8' }, itemStyle: { color: '#818cf8' },
        markLine: { silent: true, symbol: 'none', data: [{ yAxis: 0, lineStyle: { color: colors.gridLineStrong, type: 'dashed' }, label: { show: false } }] }
      },
      {
        name: '12 周 R²', type: 'line', xAxisIndex: 1, yAxisIndex: 3, showSymbol: false, connectNulls: false,
        data: rolling.map(r => r.r2), lineStyle: { width: 1.2, color: '#38bdf8', type: 'dotted' }, itemStyle: { color: '#38bdf8' }
      }
    ]
  }, true);
}

/**
 * ② Weekly ETF flow (x) vs ΔCME leveraged-fund net short (y), split by carry above / below T-Bill.
 * Each fitted line's slope is that group's β, so a steeper high-carry line would mean hedging
 * intensifies when the basis trade pays.
 */
function renderElScatterChart() {
  const d = rawEtfLinkageData;
  if (!d?.weeks?.length) return;
  elScatterChartInstance = elInitChart(elScatterChartInstance, 'el-scatter-echarts');
  if (!elScatterChartInstance) return;
  const colors = getChartThemeColors();
  const common = elAxisCommon(colors);
  const weeks = d.weeks.filter(w => w.excessOverTBill != null);
  const point = w => ({ value: [w.etfFlowBtc, w.dLfNetShortBtc], week: w });
  const high = weeks.filter(w => w.excessOverTBill > 0).map(point);
  const low = weeks.filter(w => w.excessOverTBill <= 0).map(point);
  const xs = weeks.map(w => w.etfFlowBtc);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const fitLine = fit => (fit?.beta != null && fit?.alpha != null
    ? [[xMin, fit.alpha + fit.beta * xMin], [xMax, fit.alpha + fit.beta * xMax]]
    : []);
  const cd = d.carryDependence || {};
  const full = d.hedgeRatio?.full || {};
  const kFmt = v => `${Math.round(v / 1000)}k`;

  elScatterChartInstance.setOption({
    backgroundColor: 'transparent',
    animation: false,
    grid: { left: 56, right: 16, top: 58, bottom: 42 },
    legend: { top: 0, textStyle: { color: colors.textSecondary, fontSize: 11 } },
    tooltip: {
      ...elTooltipBase(colors),
      trigger: 'item',
      formatter: p => {
        if (!p.data?.week) return `${p.seriesName}`;
        const w = p.data.week;
        return `<div style="font-weight:600;">周截至 ${w.weekEnd}</div>
          <div>ETF 净流入: ${elFmtBtc(w.etfFlowBtc)}</div>
          <div>杠杆基金净空头 Δ: ${elFmtBtc(w.dLfNetShortBtc)}</div>
          <div>超额基差: ${tpPct(w.excessOverTBill)}</div>`;
      }
    },
    xAxis: {
      type: 'value', name: 'ETF 周净流入 (BTC)', nameLocation: 'middle', nameGap: 26,
      nameTextStyle: { color: colors.tickColor, fontSize: 10 },
      ...common, axisLabel: { ...common.axisLabel, formatter: kFmt }
    },
    yAxis: {
      type: 'value', name: 'Δ 净空头 (BTC)', nameTextStyle: { color: colors.tickColor, fontSize: 10 },
      ...common, axisLabel: { ...common.axisLabel, formatter: kFmt }
    },
    series: [
      { name: `超额基差 > 0（${high.length} 周）`, type: 'scatter', symbolSize: 6, data: high, itemStyle: { color: 'rgba(16,185,129,0.65)' } },
      { name: `超额基差 ≤ 0（${low.length} 周）`, type: 'scatter', symbolSize: 6, data: low, itemStyle: { color: 'rgba(244,63,94,0.7)' } },
      { name: `高基差 β=${elFmtNum(cd.high?.beta)}`, type: 'line', showSymbol: false, data: fitLine(cd.high), lineStyle: { width: 2, color: '#10b981' }, itemStyle: { color: '#10b981' }, tooltip: { show: false } },
      { name: `低基差 β=${elFmtNum(cd.low?.beta)}`, type: 'line', showSymbol: false, data: fitLine(cd.low), lineStyle: { width: 2, color: '#f43f5e' }, itemStyle: { color: '#f43f5e' }, tooltip: { show: false } },
      { name: `全样本 β=${elFmtNum(full.beta)}`, type: 'line', showSymbol: false, data: fitLine(full), lineStyle: { width: 1.4, color: colors.crossColor, type: 'dashed' }, itemStyle: { color: colors.crossColor }, tooltip: { show: false } }
    ]
  }, true);
}

function renderElDecompChart() {
  const d = rawEtfLinkageData;
  if (!d?.decomposition?.length) return;
  elDecompChartInstance = elInitChart(elDecompChartInstance, 'el-decomp-echarts');
  if (!elDecompChartInstance) return;
  const colors = getChartThemeColors();
  const rows = d.decomposition;
  const common = elAxisCommon(colors);
  elDecompChartInstance.setOption({
    backgroundColor: 'transparent',
    animation: false,
    grid: { left: 60, right: 16, top: 34, bottom: 28 },
    legend: { top: 0, textStyle: { color: colors.textSecondary, fontSize: 11 } },
    tooltip: {
      ...elTooltipBase(colors),
      valueFormatter: v => elFmtBtc(v)
    },
    xAxis: { type: 'category', data: rows.map(r => r.weekEnd), ...common, splitLine: { show: false } },
    yAxis: { type: 'value', ...common, axisLabel: { ...common.axisLabel, formatter: v => `${Math.round(v / 1000)}k` }, name: 'BTC', nameTextStyle: { color: colors.tickColor, fontSize: 10 } },
    series: [
      { name: 'ETF 累计净流入', type: 'line', showSymbol: false, data: rows.map(r => r.cumFlowBtc), lineStyle: { width: 2.2, color: '#f59e0b' }, itemStyle: { color: '#f59e0b' } },
      { name: '套利匹配 (CME 新增空头)', type: 'line', showSymbol: false, data: rows.map(r => r.cumArbBtc), lineStyle: { width: 1.8, color: '#a855f7' }, itemStyle: { color: '#a855f7' } },
      { name: '方向性剩余', type: 'line', showSymbol: false, data: rows.map(r => r.cumDirectionalBtc), lineStyle: { width: 1.8, color: '#10b981' }, itemStyle: { color: '#10b981' } }
    ]
  }, true);
}

function renderElLeadLagChart() {
  const d = rawEtfLinkageData;
  if (!d?.leadLag?.length) return;
  elLeadLagChartInstance = elInitChart(elLeadLagChartInstance, 'el-leadlag-echarts');
  if (!elLeadLagChartInstance) return;
  const colors = getChartThemeColors();
  const common = elAxisCommon(colors);
  const rows = d.leadLag;
  elLeadLagChartInstance.setOption({
    backgroundColor: 'transparent',
    animation: false,
    grid: { left: 48, right: 16, top: 34, bottom: 42 },
    legend: { top: 0, textStyle: { color: colors.textSecondary, fontSize: 11 } },
    tooltip: { ...elTooltipBase(colors), valueFormatter: v => elFmtNum(v, 3) },
    xAxis: {
      type: 'category',
      data: rows.map(r => (r.lag > 0 ? `+${r.lag}` : `${r.lag}`)),
      name: 'k (周)，正 = 基差变化领先',
      nameLocation: 'middle',
      nameGap: 26,
      nameTextStyle: { color: colors.tickColor, fontSize: 10 },
      ...common,
      splitLine: { show: false }
    },
    yAxis: { type: 'value', min: -1, max: 1, ...common },
    series: [
      { name: '与 ETF 流入相关', type: 'bar', barMaxWidth: 14, data: rows.map(r => r.corrFlow), itemStyle: { color: '#f59e0b' } },
      { name: '与 CME 空头增量相关', type: 'bar', barMaxWidth: 14, data: rows.map(r => r.corrShort), itemStyle: { color: '#a855f7' } }
    ]
  }, true);
}

function renderElOiChart() {
  const d = rawEtfLinkageData;
  if (!d?.oiPanel?.length) return;
  elOiChartInstance = elInitChart(elOiChartInstance, 'el-oi-echarts');
  if (!elOiChartInstance) return;
  const colors = getChartThemeColors();
  const common = elAxisCommon(colors);
  const usd = elOiUnit === 'usd';
  const rows = d.oiPanel;
  const field = base => rows.map(r => r[`${base}${usd ? 'Usd' : 'Btc'}`] ?? null);
  const fmtAxis = v => (usd ? `$${(v / 1e9).toFixed(0)}B` : `${Math.round(v / 1000)}k`);
  const fmtVal = v => (usd ? elFmtUsd(v, false) : elFmtBtc(v, false));
  const series = [
    { name: 'Binance 期货 OI', type: 'line', showSymbol: false, data: field('binanceFutOi'), lineStyle: { width: 1.6, color: '#f59e0b' }, itemStyle: { color: '#f59e0b' } },
    { name: 'Deribit 期权 OI', type: 'line', showSymbol: false, data: field('deribitOptOi'), lineStyle: { width: 1.6, color: '#38bdf8' }, itemStyle: { color: '#38bdf8' } },
    { name: '离岸对冲合计', type: 'line', showSymbol: false, data: field('offshoreHedgeOi'), lineStyle: { width: 2.4, color: '#a855f7' }, itemStyle: { color: '#a855f7' } }
  ];
  if (elShowCmeOi) {
    series.push({ name: 'CME 期货 OI', type: 'line', showSymbol: false, data: field('cmeFutOi'), lineStyle: { width: 1.4, color: '#f97316', type: 'dashed' }, itemStyle: { color: '#f97316' } });
  }
  elOiChartInstance.setOption({
    backgroundColor: 'transparent',
    animation: false,
    grid: { left: 64, right: 16, top: 34, bottom: 28 },
    legend: { top: 0, textStyle: { color: colors.textSecondary, fontSize: 11 } },
    tooltip: { ...elTooltipBase(colors), valueFormatter: fmtVal },
    xAxis: { type: 'category', data: rows.map(r => r.date), ...common, splitLine: { show: false } },
    yAxis: { type: 'value', ...common, axisLabel: { ...common.axisLabel, formatter: fmtAxis } },
    series
  }, true);
}

function disposeEtfLinkageCharts() {
  [elWeeklyChartInstance, elScatterChartInstance, elDecompChartInstance, elLeadLagChartInstance, elOiChartInstance].forEach(ch => {
    if (ch) { try { ch.dispose(); } catch (e) {} }
  });
  elWeeklyChartInstance = elScatterChartInstance = elDecompChartInstance = elLeadLagChartInstance = elOiChartInstance = null;
}

function resizeEtfLinkageCharts() {
  [elWeeklyChartInstance, elScatterChartInstance, elDecompChartInstance, elLeadLagChartInstance, elOiChartInstance].forEach(ch => {
    if (ch) ch.resize();
  });
}

function initEtfLinkageEvents() {
  const bindSegment = (id, onPick) => {
    const seg = document.getElementById(id);
    if (!seg) return;
    seg.addEventListener('click', e => {
      const btn = e.target.closest('.timeframe-btn');
      if (!btn) return;
      seg.querySelectorAll('.timeframe-btn').forEach(b => b.classList.toggle('active', b === btn));
      onPick(btn.dataset.unit);
    });
  };
  bindSegment('el-unit-selector', unit => { elFlowUnit = unit; renderElWeeklyChart(); });
  bindSegment('el-oi-unit-selector', unit => { elOiUnit = unit; renderElOiChart(); });
  const cmeBtn = document.getElementById('el-toggle-cme-oi');
  if (cmeBtn) {
    cmeBtn.addEventListener('click', () => {
      elShowCmeOi = !elShowCmeOi;
      cmeBtn.classList.toggle('active', elShowCmeOi);
      renderElOiChart();
    });
  }
  window.addEventListener('resize', resizeEtfLinkageCharts);
}

// ============================================================================
// Module: Stablecoin Supply Ratio Oscillator (SSRO) Controller
// ============================================================================

let rawSsroData = null;
let ssroChartInstance = null;
let ssroTimeframe = 'all'; // '3m' | '6m' | '1y' | '3y' | 'all'
let ssroLen = 200; // 200 (macro) or 50 (tactical)

/**
 * Fetch SSRO dataset from backend /api/ssro
 */
async function fetchSsroData(force = false) {
  try {
    const url = `/api/ssro${force ? '?force=1' : ''}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.code !== 0) throw new Error(data.error || 'Failed to load SSRO');

    rawSsroData = data;
    updateSsroKpiCards(data);
    renderSsroChart();
  } catch (err) {
    console.error('[SSRO] Failed to load data:', err);
  }
}

/**
 * Update top KPI Metric cards
 */
function updateSsroKpiCards(data) {
  if (!data || !data.latest) return;
  const latest = data.latest;

  const elBtc = document.getElementById('ssro-btc-val');
  const elStable = document.getElementById('ssro-stable-val');
  const elStableChange = document.getElementById('ssro-stable-change');
  const elSsr = document.getElementById('ssro-ssr-val');
  const elSsrMa = document.getElementById('ssro-ssr-ma');
  const elZscore = document.getElementById('ssro-zscore-val');
  const elZscoreBadge = document.getElementById('ssro-zscore-badge');
  const elZoneLabel = document.getElementById('ssro-zone-label');
  const elStatusBadge = document.getElementById('ssro-current-status-badge');

  if (elBtc) elBtc.textContent = `$${Math.round(latest.btcPrice).toLocaleString()}`;
  if (elStable) elStable.textContent = `$${latest.stableCapBillions}B`;

  if (elStableChange && latest.tvQuote) {
    const ch = latest.tvQuote.change24h;
    if (ch !== null && !isNaN(ch)) {
      const isPos = ch >= 0;
      elStableChange.textContent = `${isPos ? '+' : ''}${ch.toFixed(2)}%`;
      elStableChange.className = `mm-chip ${isPos ? 'chip-green' : 'chip-red'}`;
    }
  }

  if (elSsr) elSsr.textContent = latest.ssr?.toFixed(3) || '--';

  const lastPt = data.points && data.points.length > 0 ? data.points[data.points.length - 1] : null;
  const currentSma = ssroLen === 200 ? lastPt?.sma200 : lastPt?.sma50;
  if (elSsrMa) elSsrMa.textContent = currentSma ? `MA: ${currentSma.toFixed(3)}` : 'MA: --';

  const z = ssroLen === 200 ? latest.ssro200 : latest.ssro50;
  if (elZscore) {
    const zFormatted = z !== null ? (z > 0 ? '+' : '') + z.toFixed(2) : '--';
    elZscore.textContent = zFormatted;
    if (z <= -2.0) elZscore.className = 'mm-val text-green';
    else if (z >= 2.0) elZscore.className = 'mm-val text-red';
    else elZscore.className = 'mm-val text-cyan';
  }

  if (elZscoreBadge) {
    if (z <= -2.0) {
      elZscoreBadge.textContent = '超卖底背离';
      elZscoreBadge.className = 'mm-chip chip-green';
    } else if (z >= 2.0) {
      elZscoreBadge.textContent = '购买力透支';
      elZscoreBadge.className = 'mm-chip chip-red';
    } else {
      elZscoreBadge.textContent = '常态均衡';
      elZscoreBadge.className = 'mm-chip';
    }
  }

  if (elZoneLabel && latest.quantEvaluation) {
    elZoneLabel.textContent = latest.quantEvaluation.label;
    elZoneLabel.className = `mm-val ${latest.quantEvaluation.colorClass || ''}`;
  }

  if (elStatusBadge && latest.quantEvaluation) {
    elStatusBadge.textContent = latest.quantEvaluation.label;
    if (z <= -2.0) {
      elStatusBadge.style.color = '#34d399';
      elStatusBadge.style.background = 'rgba(16, 185, 129, 0.15)';
      elStatusBadge.style.borderColor = 'rgba(16, 185, 129, 0.3)';
    } else if (z >= 2.0) {
      elStatusBadge.style.color = '#f87171';
      elStatusBadge.style.background = 'rgba(239, 68, 68, 0.15)';
      elStatusBadge.style.borderColor = 'rgba(239, 68, 68, 0.3)';
    } else {
      elStatusBadge.style.color = '#38bdf8';
      elStatusBadge.style.background = 'rgba(56, 189, 248, 0.15)';
      elStatusBadge.style.borderColor = 'rgba(56, 189, 248, 0.3)';
    }
  }
}

/**
 * Render Dual-Pane ECharts: Upper BTC Price, Lower SSRO Oscillator
 */
function renderSsroChart() {
  const dom = document.getElementById('ssro-echart-dom');
  if (!dom || !rawSsroData || !Array.isArray(rawSsroData.points)) return;

  if (!ssroChartInstance) {
    ssroChartInstance = echarts.init(dom, getEchartsTheme());
  }

  let filtered = [...rawSsroData.points];
  if (ssroTimeframe === '3m') {
    filtered = filtered.slice(-90);
  } else if (ssroTimeframe === '6m') {
    filtered = filtered.slice(-180);
  } else if (ssroTimeframe === '1y') {
    filtered = filtered.slice(-365);
  } else if (ssroTimeframe === '3y') {
    filtered = filtered.slice(-1095);
  }

  const dates = filtered.map(p => p.date);
  const btcPrices = filtered.map(p => p.btcPrice);
  const ssroVals = filtered.map(p => ssroLen === 200 ? p.ssro200 : p.ssro50);

  const validZ = ssroVals.filter(v => v !== null && !isNaN(v));
  const minZ = validZ.length > 0 ? Math.min(-2.5, Math.floor(Math.min(...validZ) - 0.5)) : -3;
  const maxZ = validZ.length > 0 ? Math.max(2.5, Math.ceil(Math.max(...validZ) + 0.5)) : 3;

  const colors = getChartThemeColors();

  const option = {
    backgroundColor: 'transparent',
    animation: true,
    animationDuration: 400,
    tooltip: {
      trigger: 'axis',
      axisPointer: {
        type: 'cross',
        crossStyle: { color: colors.crossColor },
        lineStyle: { color: colors.crossColor, type: 'dashed' }
      },
      backgroundColor: colors.tooltipBg,
      borderColor: colors.tooltipBorder,
      borderWidth: 1,
      textStyle: { color: colors.tooltipText, fontSize: 12 },
      formatter: function(params) {
        if (!params || params.length === 0) return '';
        const idx = params[0].dataIndex;
        const pt = filtered[idx];
        if (!pt) return '';
        const zVal = ssroLen === 200 ? pt.ssro200 : pt.ssro50;
        let zoneText = '均衡博弈';
        let zoneColor = '#38bdf8';
        if (zVal !== null) {
          if (zVal <= -2.0) { zoneText = '极度充沛 (高胜率大底)'; zoneColor = '#34d399'; }
          else if (zVal >= 2.0) { zoneText = '购买力透支 (顶部警戒)'; zoneColor = '#f87171'; }
          else if (zVal > 1.0) { zoneText = '偏热警戒'; zoneColor = '#fbbf24'; }
          else if (zVal < -1.0) { zoneText = '充裕健康'; zoneColor = '#6ee7b7'; }
        }

        return `
          <div style="font-weight:700; border-bottom: 1px solid ${colors.tooltipDivider}; padding-bottom:4px; margin-bottom:6px; color:${colors.tooltipTitle};">
            📅 ${pt.date}
          </div>
          <div style="display:flex; justify-content:space-between; gap:16px; margin-bottom:4px;">
            <span style="color:#f59e0b;">🪙 BTC 现货价格:</span>
            <strong style="color:${colors.tooltipTitle};">$${Math.round(pt.btcPrice).toLocaleString()}</strong>
          </div>
          <div style="display:flex; justify-content:space-between; gap:16px; margin-bottom:4px;">
            <span style="color:#38bdf8;">💵 稳定币市值 (STABLE.C):</span>
            <strong style="color:${colors.tooltipTitle};">$${(pt.stableCap / 1e9).toFixed(2)}B</strong>
          </div>
          <div style="display:flex; justify-content:space-between; gap:16px; margin-bottom:4px;">
            <span style="color:#a855f7;">📊 原始 SSR (BTC/STABLE):</span>
            <strong style="color:${colors.textSecondary};">${pt.ssr?.toFixed(3) || '--'}</strong>
          </div>
          <div style="display:flex; justify-content:space-between; gap:16px; margin-bottom:4px;">
            <span style="color:${zoneColor};">⚡ SSRO Z-Score (len=${ssroLen}):</span>
            <strong style="color:${zoneColor};">${zVal !== null ? (zVal > 0 ? '+' : '') + zVal.toFixed(2) + 'σ' : '--'}</strong>
          </div>
          <div style="display:flex; justify-content:space-between; gap:16px; padding-top:4px; border-top:1px dashed ${colors.tooltipDivider};">
            <span style="color:${colors.textMuted};">🎯 流动性研判:</span>
            <strong style="color:${zoneColor};">${zoneText}</strong>
          </div>
        `;
      }
    },
    axisPointer: {
      link: [{ xAxisIndex: 'all' }]
    },
    grid: [
      {
        left: 65,
        right: 35,
        top: '6%',
        height: '42%'
      },
      {
        left: 65,
        right: 35,
        top: '56%',
        height: '34%'
      }
    ],
    xAxis: [
      {
        type: 'category',
        gridIndex: 0,
        data: dates,
        axisLine: { lineStyle: { color: colors.axisLine } },
        axisLabel: { show: false },
        axisTick: { show: false }
      },
      {
        type: 'category',
        gridIndex: 1,
        data: dates,
        axisLine: { lineStyle: { color: colors.axisLine } },
        axisLabel: { color: colors.tickColor, fontSize: 11 },
        axisTick: { alignWithLabel: true }
      }
    ],
    yAxis: [
      {
        type: 'value',
        gridIndex: 0,
        scale: true,
        axisLine: { show: false },
        splitLine: { lineStyle: { color: colors.splitLine } },
        axisLabel: {
          color: '#f59e0b',
          fontSize: 11,
          formatter: function(val) {
            return `$${Math.round(val / 1000)}k`;
          }
        }
      },
      {
        type: 'value',
        gridIndex: 1,
        min: minZ,
        max: maxZ,
        splitLine: { lineStyle: { color: colors.splitLine } },
        axisLabel: {
          color: '#38bdf8',
          fontSize: 11,
          formatter: '{value}σ'
        }
      }
    ],
    series: [
      {
        name: 'BTC 现货价格',
        type: 'line',
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: btcPrices,
        smooth: 0.2,
        symbol: 'none',
        lineStyle: {
          color: '#f59e0b',
          width: 2.2,
          shadowColor: 'rgba(245, 158, 11, 0.35)',
          shadowBlur: 8
        },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(245, 158, 11, 0.22)' },
            { offset: 1, color: 'rgba(245, 158, 11, 0.01)' }
          ])
        }
      },
      {
        name: 'SSRO 震荡指标',
        type: 'line',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: ssroVals,
        smooth: 0.15,
        symbol: 'none',
        lineStyle: {
          color: '#38bdf8',
          width: 2.2,
          shadowColor: 'rgba(56, 189, 248, 0.4)',
          shadowBlur: 6
        },
        markLine: {
          silent: true,
          symbol: 'none',
          data: [
            {
              yAxis: 0,
              lineStyle: { color: 'rgba(255, 255, 255, 0.25)', width: 1, type: 'solid' },
              label: { position: 'end', formatter: '0 轴基线', color: '#94a3b8', fontSize: 10 }
            },
            {
              yAxis: 2.0,
              lineStyle: { color: '#ef4444', width: 1.5, type: 'dashed' },
              label: { position: 'end', formatter: '+2.0σ 衰竭区', color: '#f87171', fontSize: 10 }
            },
            {
              yAxis: -2.0,
              lineStyle: { color: '#10b981', width: 1.5, type: 'dashed' },
              label: { position: 'end', formatter: '-2.0σ 充沛区', color: '#34d399', fontSize: 10 }
            }
          ]
        },
        markArea: {
          silent: true,
          data: [
            [
              { yAxis: 2.0, itemStyle: { color: 'rgba(239, 68, 68, 0.08)' } },
              { yAxis: maxZ }
            ],
            [
              { yAxis: minZ, itemStyle: { color: 'rgba(16, 185, 129, 0.08)' } },
              { yAxis: -2.0 }
            ]
          ]
        }
      }
    ]
  };

  ssroChartInstance.setOption(option);
}

/**
 * Initialize SSRO UI Event Listeners
 */
function initSsroEvents() {
  const tfSwitch = document.getElementById('ssro-timeframe-switch');
  if (tfSwitch) {
    tfSwitch.querySelectorAll('.switch-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        tfSwitch.querySelectorAll('.switch-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        ssroTimeframe = btn.dataset.range || 'all';
        renderSsroChart();
      });
    });
  }

  const lenSwitch = document.getElementById('ssro-len-switch');
  if (lenSwitch) {
    lenSwitch.querySelectorAll('.switch-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        lenSwitch.querySelectorAll('.switch-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        ssroLen = parseInt(btn.dataset.len, 10) || 200;
        if (rawSsroData) updateSsroKpiCards(rawSsroData);
        renderSsroChart();
      });
    });
  }

  window.addEventListener('resize', () => {
    if (ssroChartInstance) ssroChartInstance.resize();
  });
}

// ============================================================================
// Module 6: Coinbase BTC Micro-Liquidity & Depth Engine
// ============================================================================

let rawCoinbaseData = null;
let cbDepthChartInstance = null;
let cbSlippageChartInstance = null;

// DOM references
const elCbHeaderRegimePill = document.getElementById('cb-header-regime-pill');
const elCbHeaderBidPill = document.getElementById('cb-header-bid-pill');
const elCbHeaderSpreadPill = document.getElementById('cb-header-spread-pill');
const elCbUpdateTime = document.getElementById('cb-update-time');

const elCbPctlPrice = document.getElementById('cb-pctl-price');
const elCbBadgePrice = document.getElementById('cb-badge-price');
const elCbBarPrice = document.getElementById('cb-bar-price');

const elCbPctlVol24h = document.getElementById('cb-pctl-vol24h');
const elCbBadgeVol24h = document.getElementById('cb-badge-vol24h');
const elCbBarVol24h = document.getElementById('cb-bar-vol24h');

const elCbPctlVol7d = document.getElementById('cb-pctl-vol7d');
const elCbBadgeVol7d = document.getElementById('cb-badge-vol7d');
const elCbBarVol7d = document.getElementById('cb-bar-vol7d');

const elCbPctlBid10 = document.getElementById('cb-pctl-bid10');
const elCbBadgeBid10 = document.getElementById('cb-badge-bid10');
const elCbBarBid10 = document.getElementById('cb-bar-bid10');

const elCbPyr100_10 = document.getElementById('cb-pyr-100-10');
const elCbPyr50_10 = document.getElementById('cb-pyr-50-10');
const elCbValMid = document.getElementById('cb-val-mid');
const elCbPyrEvalText = document.getElementById('cb-pyr-eval-text');

const elCbDepthTableBody = document.getElementById('cb-depth-table-body');
const elCbInsightsList = document.getElementById('cb-insights-list');

const elCbDepthEcharts = document.getElementById('cb-depth-echarts');
const elCbSlippageEcharts = document.getElementById('cb-slippage-echarts');

/**
 * Fetch Coinbase Liquidity dataset from backend
 */
async function fetchCoinbaseLiquidityData(forceRefresh = false) {
  try {
    const url = forceRefresh ? '/api/coinbase-liquidity?force=1' : '/api/coinbase-liquidity';
    const resp = await fetch(url);
    if (!resp.ok) return;
    const json = await resp.json();
    if (json.code === 0) {
      rawCoinbaseData = json;
      renderCoinbaseLiquidity(json);
    }
  } catch (err) {
    console.error('[Coinbase Liquidity] Fetch error:', err);
  }
}

/**
 * Render all metrics and charts for Coinbase Liquidity
 */
function renderCoinbaseLiquidity(data) {
  if (!data) return;

  // Header badges
  if (elCbHeaderRegimePill && data.regime) {
    elCbHeaderRegimePill.textContent = data.regime.label || '诊断完成';
    if (data.regime.color) {
      elCbHeaderRegimePill.style.color = data.regime.color;
      elCbHeaderRegimePill.style.borderColor = `${data.regime.color}44`;
      elCbHeaderRegimePill.style.background = `${data.regime.color}15`;
    }
  }

  const d10 = data.depthProfile ? data.depthProfile['10'] : null;
  if (elCbHeaderBidPill && d10) {
    elCbHeaderBidPill.textContent = `10bp买盘: ${d10.bidPct}%`;
    elCbHeaderBidPill.style.color = d10.bidPct >= 50 ? '#10b981' : '#f43f5e';
  }

  if (elCbHeaderSpreadPill && data.spreadBps !== undefined) {
    elCbHeaderSpreadPill.textContent = `价差: ${data.spreadBps} bps ($${data.spreadUsd})`;
  }

  if (elCbUpdateTime && data.updatedAt) {
    const timeStr = new Date(data.updatedAt).toLocaleTimeString('zh-CN', { hour12: false });
    elCbUpdateTime.textContent = `${timeStr} (UTC+8)`;
  }

  // 1. Percentile Heatmap
  const p = data.percentiles || {};
  if (elCbPctlPrice && p.pricePctl !== undefined) {
    elCbPctlPrice.textContent = `${p.pricePctl}%`;
    if (elCbBarPrice) elCbBarPrice.style.width = `${p.pricePctl}%`;
    if (elCbBadgePrice) {
      if (p.pricePctl >= 75) {
        elCbBadgePrice.textContent = '高位偏热';
        elCbBadgePrice.style.color = '#f43f5e';
      } else if (p.pricePctl <= 25) {
        elCbBadgePrice.textContent = '低位低估';
        elCbBadgePrice.style.color = '#10b981';
      } else {
        elCbBadgePrice.textContent = '常态中枢';
        elCbBadgePrice.style.color = '#f59e0b';
      }
    }
  }

  if (elCbPctlVol24h && p.volume24hPctl !== undefined) {
    elCbPctlVol24h.textContent = `${p.volume24hPctl}%`;
    if (elCbBarVol24h) elCbBarVol24h.style.width = `${Math.max(5, p.volume24hPctl)}%`;
    if (elCbBadgeVol24h) {
      if (p.volume24hPctl <= 15) {
        elCbBadgeVol24h.textContent = '❄️ 极度冰封';
        elCbBadgeVol24h.style.color = '#38bdf8';
      } else if (p.volume24hPctl >= 75) {
        elCbBadgeVol24h.textContent = '放量活跃';
        elCbBadgeVol24h.style.color = '#10b981';
      } else {
        elCbBadgeVol24h.textContent = '中性温和';
        elCbBadgeVol24h.style.color = '#a1a1aa';
      }
    }
  }

  if (elCbPctlVol7d && p.volume7dPctl !== undefined) {
    elCbPctlVol7d.textContent = `${p.volume7dPctl}%`;
    if (elCbBarVol7d) elCbBarVol7d.style.width = `${Math.max(5, p.volume7dPctl)}%`;
    if (elCbBadgeVol7d) {
      if (p.volume7dPctl <= 30) {
        elCbBadgeVol7d.textContent = '周度低迷';
        elCbBadgeVol7d.style.color = '#f59e0b';
      } else {
        elCbBadgeVol7d.textContent = '稳健';
        elCbBadgeVol7d.style.color = '#10b981';
      }
    }
  }

  if (elCbPctlBid10 && d10) {
    elCbPctlBid10.textContent = `${d10.bidPct}%`;
    if (elCbBarBid10) elCbBarBid10.style.width = `${d10.bidPct}%`;
    if (elCbBadgeBid10) {
      if (d10.bidPct < 48) {
        elCbBadgeBid10.textContent = '卖方压制';
        elCbBadgeBid10.style.color = '#f43f5e';
      } else if (d10.bidPct > 52) {
        elCbBadgeBid10.textContent = '买方承接';
        elCbBadgeBid10.style.color = '#10b981';
      } else {
        elCbBadgeBid10.textContent = '买卖均衡';
        elCbBadgeBid10.style.color = '#a1a1aa';
      }
    }
  }

  // 2. Pyramid Ratios
  const pyr = data.pyramidRatios || {};
  if (elCbPyr100_10 && pyr.ratio100_10) {
    elCbPyr100_10.textContent = `${pyr.ratio100_10}x`;
    elCbPyr100_10.style.color = pyr.ratio100_10 > 6.0 ? '#f59e0b' : '#10b981';
  }
  if (elCbPyr50_10 && pyr.ratio50_10) {
    elCbPyr50_10.textContent = `${pyr.ratio50_10}x`;
  }
  if (elCbValMid && data.midPrice) {
    elCbValMid.textContent = `$${Math.round(data.midPrice).toLocaleString()}`;
  }
  if (elCbPyrEvalText && pyr.ratio100_10) {
    const ratioVal = Number(pyr.ratio100_10) || 0;
    if (ratioVal >= 6.0) {
      elCbPyrEvalText.innerHTML = `⚠️ <strong>近端薄弱，防线下移</strong>：100bp/10bp 比率达 <strong>${ratioVal}x</strong>（显著偏离 3.1x 基准），做市商挂单大幅后撤至远端，即时缓冲层相对中空。`;
    } else {
      elCbPyrEvalText.innerHTML = `🟢 <strong>金字塔结构稳健</strong>：阶梯倍数维持在 <strong>${ratioVal}x</strong>（贴合 3.1x 理论中枢），具备良好的逐级缓冲吸收能力。`;
    }
  }

  // 3. Multi-tier Depth Table
  if (elCbDepthTableBody && data.depthProfile) {
    const tiers = [5, 10, 20, 50, 100, 200];
    let html = '';
    tiers.forEach(t => {
      const item = data.depthProfile[t];
      if (!item) return;
      const bidClass = (Number(item.bidPct) || 0) >= 50 ? 'text-pos' : 'text-neg';
      html += `<tr>
        <td style="font-weight:600; color:#fafafa;">${escapeHtml(item.label)}</td>
        <td style="color:#10b981;">$${Number(item.bidUsdM) || 0}M <span style="color:#71717a; font-size:10px;">(${Number(item.bidBtc) || 0} ₿)</span></td>
        <td style="color:#f43f5e;">$${Number(item.askUsdM) || 0}M <span style="color:#71717a; font-size:10px;">(${Number(item.askBtc) || 0} ₿)</span></td>
        <td class="${bidClass}" style="font-weight:700;">${Number(item.bidPct) || 0}%</td>
      </tr>`;
    });
    elCbDepthTableBody.innerHTML = html;
  }

  // 4. Institutional Insights List
  if (elCbInsightsList && Array.isArray(data.insights)) {
    elCbInsightsList.innerHTML = data.insights.map(str => `<li>${escapeHtml(str)}</li>`).join('');
  }

  // Render Charts
  renderCbDepthChart(data);
  renderCbSlippageChart(data);
}

/**
 * Render Butterfly Depth Chart with dual horizontal bars
 */
function renderCbDepthChart(data) {
  if (!elCbDepthEcharts || !data || !data.depthProfile) return;

  if (!cbDepthChartInstance) {
    cbDepthChartInstance = echarts.init(elCbDepthEcharts, getEchartsTheme());
  }

  const tiers = [5, 10, 20, 50, 100, 200];
  const categories = tiers.map(t => `±${t} bps`);
  const bidUsdVals = tiers.map(t => -(data.depthProfile[t].bidUsdM || 0)); // negative for left bar
  const askUsdVals = tiers.map(t => (data.depthProfile[t].askUsdM || 0));   // positive for right bar

  const colors = getChartThemeColors();

  const option = {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      backgroundColor: colors.tooltipBg,
      borderColor: colors.tooltipBorder,
      textStyle: { color: colors.tooltipText, fontFamily: 'JetBrains Mono', fontSize: 12 },
      formatter: function(params) {
        if (!params || !params.length) return '';
        const tierName = params[0].name;
        const tierNum = parseInt(tierName.replace(/[^0-9]/g, ''), 10) || 5;
        const item = data.depthProfile[tierNum] || {};
        return `<div style="font-weight:700;margin-bottom:6px;color:${colors.tooltipTitle};">Coinbase 深度切片: ${tierName}</div>
          <div style="display:flex;justify-content:space-between;gap:16px;margin:2px 0;">
            <span style="color:#10b981;">🟢 买单深度 (Bid):</span>
            <span style="font-weight:700;color:#10b981;">$${item.bidUsdM}M (${item.bidBtc} ₿)</span>
          </div>
          <div style="display:flex;justify-content:space-between;gap:16px;margin:2px 0;">
            <span style="color:#f43f5e;">🔴 卖单深度 (Ask):</span>
            <span style="font-weight:700;color:#f43f5e;">$${item.askUsdM}M (${item.askBtc} ₿)</span>
          </div>
          <div style="display:flex;justify-content:space-between;gap:16px;margin:4px 0 0 0;padding-top:4px;border-top:1px solid ${colors.tooltipDivider};">
            <span style="color:#a855f7;">🟣 买单占比 (Bid %):</span>
            <span style="font-weight:700;color:${item.bidPct >= 50 ? '#10b981' : '#f43f5e'};">${item.bidPct}%</span>
          </div>`;
      }
    },
    grid: {
      left: '3%',
      right: '4%',
      top: '12%',
      bottom: '6%',
      containLabel: true
    },
    xAxis: [
      {
        type: 'value',
        name: '买盘 ← 挂单金额 ($M) → 卖盘',
        nameLocation: 'middle',
        nameGap: 24,
        nameTextStyle: { color: colors.tickColor, fontSize: 11 },
        axisLabel: {
          color: colors.tickColor,
          fontFamily: 'JetBrains Mono',
          fontSize: 10,
          formatter: function(val) {
            return Math.abs(val) + 'M';
          }
        },
        splitLine: { lineStyle: { color: colors.splitLine } }
      }
    ],
    yAxis: {
      type: 'category',
      data: categories,
      axisLine: { lineStyle: { color: colors.axisLine } },
      axisTick: { show: false },
      axisLabel: { color: colors.tickColor, fontFamily: 'JetBrains Mono', fontSize: 11 }
    },
    series: [
      {
        name: '买盘挂单 ($M)',
        type: 'bar',
        stack: 'total',
        data: bidUsdVals,
        itemStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
            { offset: 0, color: 'rgba(16, 185, 129, 0.85)' },
            { offset: 1, color: 'rgba(16, 185, 129, 0.35)' }
          ]),
          borderRadius: [4, 0, 0, 4]
        }
      },
      {
        name: '卖盘挂单 ($M)',
        type: 'bar',
        stack: 'total',
        data: askUsdVals,
        itemStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
            { offset: 0, color: 'rgba(244, 63, 94, 0.35)' },
            { offset: 1, color: 'rgba(244, 63, 94, 0.85)' }
          ]),
          borderRadius: [0, 4, 4, 0]
        }
      }
    ]
  };

  cbDepthChartInstance.setOption(option);
}

/**
 * Render Simulated Institutional Slippage Curve
 */
function renderCbSlippageChart(data) {
  if (!elCbSlippageEcharts || !data || !Array.isArray(data.slippageSimulation)) return;

  if (!cbSlippageChartInstance) {
    cbSlippageChartInstance = echarts.init(elCbSlippageEcharts, getEchartsTheme());
  }

  const colors = getChartThemeColors();
  const sim = data.slippageSimulation;
  const labels = sim.map(s => s.sizeLabel);
  const buySlippage = sim.map(s => s.buy.slippageBps);
  const sellSlippage = sim.map(s => s.sell.slippageBps);

  const option = {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      backgroundColor: colors.tooltipBg,
      borderColor: colors.tooltipBorder,
      textStyle: { color: colors.tooltipText, fontFamily: 'JetBrains Mono', fontSize: 12 },
      formatter: function(params) {
        if (!params || !params.length) return '';
        const idx = params[0].dataIndex;
        const item = sim[idx];
        if (!item) return '';

        return `<div style="font-weight:700;margin-bottom:6px;color:${colors.tooltipTitle};">市价冲击模拟规模: ${item.sizeLabel}</div>
          <div style="display:flex;justify-content:space-between;gap:16px;margin:2px 0;">
            <span style="color:#10b981;">🟢 买入滑点:</span>
            <span style="font-weight:700;color:#10b981;">+${item.buy.slippageBps} bps (均价 $${item.buy.avgPrice.toLocaleString()})</span>
          </div>
          <div style="display:flex;justify-content:space-between;gap:16px;margin:2px 0;">
            <span style="color:#f43f5e;">🔴 卖出滑点:</span>
            <span style="font-weight:700;color:#f43f5e;">+${item.sell.slippageBps} bps (均价 $${item.sell.avgPrice.toLocaleString()})</span>
          </div>
          <div style="margin-top:4px;padding-top:4px;border-top:1px solid ${colors.tooltipDivider};font-size:11px;color:${colors.isLight ? '#b45309' : '#f59e0b'};">
            ⚠️ 下行惩罚比率: <strong>${item.asymmetryRatio}x</strong> (卖出比买入多承受 ${item.penaltyBps} bps 滑点)
          </div>`;
      }
    },
    grid: {
      left: '3%',
      right: '4%',
      top: '12%',
      bottom: '8%',
      containLabel: true
    },
    xAxis: {
      type: 'category',
      data: labels,
      axisLine: { lineStyle: { color: colors.axisLine } },
      axisTick: { show: false },
      axisLabel: { color: colors.tickColor, fontFamily: 'JetBrains Mono', fontSize: 11 }
    },
    yAxis: {
      type: 'value',
      name: '执行滑点 (bps)',
      nameTextStyle: { color: colors.tickColor, fontSize: 11 },
      axisLabel: {
        color: colors.tickColor,
        fontFamily: 'JetBrains Mono',
        formatter: '{value} bps'
      },
      splitLine: { lineStyle: { color: colors.gridLine } }
    },
    series: [
      {
        name: '市价买入滑点 (Lifting Asks)',
        type: 'line',
        smooth: 0.2,
        data: buySlippage,
        lineStyle: { width: 2.2, color: '#10b981' },
        itemStyle: { color: '#10b981' },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(16, 185, 129, 0.18)' },
            { offset: 1, color: 'rgba(16, 185, 129, 0.0)' }
          ])
        }
      },
      {
        name: '市价卖出滑点 (Hitting Bids)',
        type: 'line',
        smooth: 0.2,
        data: sellSlippage,
        lineStyle: { width: 2.2, color: '#f43f5e' },
        itemStyle: { color: '#f43f5e' },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(244, 63, 94, 0.25)' },
            { offset: 1, color: 'rgba(244, 63, 94, 0.0)' }
          ])
        }
      }
    ]
  };

  cbSlippageChartInstance.setOption(option);
}

/**
 * Initialize Coinbase Liquidity UI Event Listeners
 */
function initCoinbaseLiquidityEvents() {
  window.addEventListener('resize', () => {
    if (cbDepthChartInstance) cbDepthChartInstance.resize();
    if (cbSlippageChartInstance) cbSlippageChartInstance.resize();
  });

  // Auto-refresh Coinbase order book liquidity every 15 seconds when viewing
  setInterval(() => {
    if (currentActiveView === 'view-coinbase-liquidity' || currentActiveView === 'view-all') {
      fetchCoinbaseLiquidityData(false);
    }
  }, 15000);
}

// ============================================================================
// Multi-View & Responsive Navigation Controller
// ============================================================================

const VIEW_TITLES = {
  'view-overview': '宏观与风控总览',
  'view-term-premium': '期现基差与期限溢价',
  'view-options': '期权微观结构套件',
  'view-block-trades': '大宗巨鲸战略雷达',
  'view-ssro': '稳定币比率震荡指标 (SSRO)',
  'view-coinbase-liquidity': 'Coinbase 深度雷达',
  'view-gold-correlation': '金/BTC 比率与相关性',
  'view-wave-radar': '柳玉冬波浪理论 · 多级别画浪评估',
  'view-all': '全模块平铺画卷'
};

let currentActiveView = 'view-overview';

/**
 * Switch active view panel and synchronize desktop sidebar and mobile navigation
 */
function switchView(viewId, updateHash = true) {
  if (!VIEW_TITLES[viewId]) {
    viewId = 'view-overview';
  }
  currentActiveView = viewId;

  const mainViewport = document.getElementById('main-viewport');
  const viewPanels = document.querySelectorAll('.view-panel');
  const sidebarNavItems = document.querySelectorAll('.sidebar-nav-item');
  const mobNavItems = document.querySelectorAll('.mob-nav-item');
  const activeViewName = document.getElementById('active-view-name');
  const appSidebar = document.getElementById('app-sidebar');
  const sidebarBackdrop = document.getElementById('sidebar-backdrop');

  // 1. Toggle view panels display
  if (viewId === 'view-all') {
    if (mainViewport) mainViewport.classList.add('view-mode-all');
    viewPanels.forEach(p => p.classList.add('active'));
  } else {
    if (mainViewport) mainViewport.classList.remove('view-mode-all');
    viewPanels.forEach(p => {
      p.classList.toggle('active', p.id === viewId);
    });
  }

  // 2. Update sidebar navigation items
  sidebarNavItems.forEach(item => {
    item.classList.toggle('active', item.dataset.view === viewId);
  });

  // 3. Update mobile bottom navigation items
  mobNavItems.forEach(item => {
    item.classList.toggle('active', item.dataset.view === viewId);
  });

  // 4. Update header view title
  if (activeViewName) {
    activeViewName.textContent = VIEW_TITLES[viewId] || '宏观与风控总览';
  }

  // 5. Close mobile drawer and backdrop if open
  if (appSidebar) appSidebar.classList.remove('open');
  if (sidebarBackdrop) sidebarBackdrop.classList.remove('active');

  // 6. Update URL hash
  if (updateHash) {
    const hashTag = viewId.replace('view-', '');
    if (window.location.hash !== `#${hashTag}`) {
      window.history.replaceState(null, '', `#${hashTag}`);
    }
  }

  // 7. Scroll to top smoothly
  window.scrollTo({ top: 0, behavior: 'instant' });

  // 7b. 通知 Atelier 设计层（头图、侧栏高亮、入场编排）
  document.dispatchEvent(new CustomEvent('bigdy:viewchange', { detail: { viewId } }));

  // 8. Trigger chart resizes for freshly displayed views
  setTimeout(() => {
    if (macroChartInstance) {
      macroChartInstance.resize();
    } else if (rawMacroData && (viewId === 'view-overview' || viewId === 'view-all')) {
      renderMacroChart();
    }

    if (mcclellanChartInstance) {
      mcclellanChartInstance.resize();
    } else if (rawMcClellanData && (viewId === 'view-overview' || viewId === 'view-all')) {
      renderMcClellanCharts();
    }

    if (cdriChartInstance) cdriChartInstance.resize();
    if (termPremiumChartInstance) termPremiumChartInstance.resize();
    resizeEtfLinkageCharts();

    if (ssroChartInstance) {
      ssroChartInstance.resize();
    } else if (rawSsroData && (viewId === 'view-ssro' || viewId === 'view-all')) {
      renderSsroChart();
    }

    if (cbDepthChartInstance) {
      cbDepthChartInstance.resize();
    } else if (rawCoinbaseData && (viewId === 'view-coinbase-liquidity' || viewId === 'view-all')) {
      renderCbDepthChart(rawCoinbaseData);
    }

    if (cbSlippageChartInstance) {
      cbSlippageChartInstance.resize();
    } else if (rawCoinbaseData && (viewId === 'view-coinbase-liquidity' || viewId === 'view-all')) {
      renderCbSlippageChart(rawCoinbaseData);
    }

    if (goldChartInstance) {
      goldChartInstance.resize();
    } else if (rawGoldData && (viewId === 'view-gold-correlation' || viewId === 'view-all')) {
      renderGoldChart();
    }

    if (viewId === 'view-wave-radar' || viewId === 'view-all') {
      ensureWaveModule()
        .then(m => m.onViewActivated())
        .catch(e => console.warn('[WaveRadar] 模块加载失败:', e.message));
    }

    window.dispatchEvent(new Event('resize'));
  }, 60);
}

/**
 * Initialize Navigation Listeners (Sidebar, Mobile Drawer, Bottom Bar, Hash Routing)
 */
function initNavigation() {
  const appSidebar = document.getElementById('app-sidebar');
  const sidebarBackdrop = document.getElementById('sidebar-backdrop');
  const btnMobileMenu = document.getElementById('btn-mobile-menu');
  const btnCloseSidebar = document.getElementById('btn-close-sidebar');

  // Sidebar item click handlers
  document.querySelectorAll('.sidebar-nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      if (view) switchView(view);
    });
  });

  // Mobile bottom nav click handlers
  document.querySelectorAll('.mob-nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      if (view) switchView(view);
    });
  });

  // Mobile hamburger menu toggle
  if (btnMobileMenu) {
    btnMobileMenu.addEventListener('click', () => {
      if (appSidebar) appSidebar.classList.toggle('open');
      if (sidebarBackdrop) sidebarBackdrop.classList.toggle('active');
    });
  }

  // Mobile drawer close button
  if (btnCloseSidebar) {
    btnCloseSidebar.addEventListener('click', () => {
      if (appSidebar) appSidebar.classList.remove('open');
      if (sidebarBackdrop) sidebarBackdrop.classList.remove('active');
    });
  }

  // Backdrop click closes drawer
  if (sidebarBackdrop) {
    sidebarBackdrop.addEventListener('click', () => {
      if (appSidebar) appSidebar.classList.remove('open');
      if (sidebarBackdrop) sidebarBackdrop.classList.remove('active');
    });
  }

  // Hash change routing
  window.addEventListener('hashchange', () => {
    const hash = window.location.hash.replace('#', '');
    if (hash) {
      const viewId = `view-${hash}`;
      if (VIEW_TITLES[viewId] && currentActiveView !== viewId) {
        switchView(viewId, false);
      }
    }
  });

  // Initial load from URL hash
  const initialHash = window.location.hash.replace('#', '');
  if (initialHash && VIEW_TITLES[`view-${initialHash}`]) {
    switchView(`view-${initialHash}`, false);
  } else {
    switchView('view-overview', false);
  }
}

// ============================================================================
// Module 7: Gold & Bitcoin Correlation & Ratio Controller (Newhedge Benchmark)
// ============================================================================

let rawGoldData = null;
let goldChartInstance = null;
let currentGoldTimeframe = 'all';
const goldVisibleSeries = {
  ratio: true,
  corr: true,
  btcPrice: false,
  goldPrice: false
};

// DOM Elements
const elGoldDataSourceBadge = document.getElementById('gold-data-source-badge');
const elGoldHeaderRegimePill = document.getElementById('gold-header-regime-pill');
const elGoldUpdateTime = document.getElementById('gold-update-time');

const elGoldValBtcGold = document.getElementById('gold-val-btc-gold');
const elGoldSubBtcGold = document.getElementById('gold-sub-btc-gold');
const elGoldValGoldPrice = document.getElementById('gold-val-gold-price');
const elGoldSubGoldPrice = document.getElementById('gold-sub-gold-price');
const elGoldValCorr30d = document.getElementById('gold-val-corr30d');
const elGoldTagCorrRegime = document.getElementById('gold-tag-corr-regime');
const elGoldCorrBar = document.getElementById('gold-corr-bar');
const elGoldValMcapShare = document.getElementById('gold-val-mcap-share');
const elGoldSubMcapShare = document.getElementById('gold-sub-mcap-share');

const elGoldEcharts = document.getElementById('gold-correlation-echarts');
const goldTimeframeSelector = document.getElementById('gold-timeframe-selector');
const elGoldHistoryPointsBadge = document.getElementById('gold-history-points-badge');

const btnGoldToggleRatio = document.getElementById('btn-gold-toggle-ratio');
const btnGoldToggleCorr = document.getElementById('btn-gold-toggle-corr');
const btnGoldToggleBtc = document.getElementById('btn-gold-toggle-btc');
const btnGoldToggleGold = document.getElementById('btn-gold-toggle-gold');

const elGoldSideBtcGold = document.getElementById('gold-side-btc-gold');
const elGoldSideGoldBtc = document.getElementById('gold-side-gold-btc');
const elGoldSideMcapShare = document.getElementById('gold-side-mcap-share');
const elGoldSideCorr = document.getElementById('gold-side-corr');
const elGoldSideRegimeTag = document.getElementById('gold-side-regime-tag');
const elGoldSideRegimeName = document.getElementById('gold-side-regime-name');
const elGoldSideRegimeSummary = document.getElementById('gold-side-regime-summary');
const elGoldInsightsList = document.getElementById('gold-insights-list');

async function loadGoldCorrelationData(force = false) {
  try {
    const resp = await fetch(`/api/gold-correlation${force ? '?refresh=true' : ''}`);
    if (!resp.ok) return;
    const json = await resp.json();
    if (json.code === 0 && json.series) {
      renderGoldCorrelation(json, force);
    }
  } catch (err) {
    console.error('[GoldCorrelation] Error fetching data:', err);
  }
}

function renderGoldCorrelation(data, forceRedraw = false) {
  if (!data) return;
  const prevTimestamp = rawGoldData?.current?.timestamp;
  const prevLen = rawGoldData?.series?.length;
  rawGoldData = data;

  const c = data.current || {};
  const reg = data.regime || {};
  const meta = data.metadata || {};

  // Header badges
  if (elGoldHeaderRegimePill && reg.regimeName) {
    elGoldHeaderRegimePill.textContent = reg.regimeName.split(' ')[0] || '宏观联动';
    if (reg.badgeClass) {
      elGoldHeaderRegimePill.className = `tp-regime-pill ${reg.badgeClass}`;
    }
  }
  if (elGoldDataSourceBadge && meta.dataSource) {
    elGoldDataSourceBadge.title = `数据基准：${meta.dataSource} | 跨度: ${meta.timeRange} | 对标: ${meta.targetReference}`;
  }
  if (elGoldUpdateTime && c.timestamp) {
    elGoldUpdateTime.textContent = `${formatUTC8(c.timestamp)} (UTC+8)`;
  }
  if (elGoldHistoryPointsBadge && data.series) {
    elGoldHistoryPointsBadge.textContent = `${data.series.length} 连续日线 (2023~至今)`;
  }

  // Top KPIs
  if (elGoldValBtcGold && c.btcGoldRatio !== undefined) {
    elGoldValBtcGold.textContent = `${c.btcGoldRatio.toFixed(2)} oz`;
  }
  if (elGoldSubBtcGold && c.ratioChange24h !== undefined) {
    const sign = c.ratioChange24h >= 0 ? '+' : '';
    elGoldSubBtcGold.textContent = `24h 比率涨跌: ${sign}${c.ratioChange24h.toFixed(2)}%`;
    elGoldSubBtcGold.style.color = c.ratioChange24h >= 0 ? '#10b981' : '#f43f5e';
  }
  if (elGoldValGoldPrice && c.goldPrice !== undefined) {
    elGoldValGoldPrice.textContent = `$${c.goldPrice.toLocaleString()}`;
  }
  if (elGoldSubGoldPrice && c.btcPrice !== undefined) {
    elGoldSubGoldPrice.textContent = `BTC 报价: $${c.btcPrice.toLocaleString()}`;
  }
  if (elGoldValCorr30d && c.rollingCorr30d !== undefined) {
    const sign = c.rollingCorr30d >= 0 ? '+' : '';
    elGoldValCorr30d.textContent = `r = ${sign}${c.rollingCorr30d.toFixed(3)}`;
    if (c.rollingCorr30d >= 0.5) elGoldValCorr30d.style.color = '#10b981';
    else if (c.rollingCorr30d >= 0.1) elGoldValCorr30d.style.color = '#38bdf8';
    else if (c.rollingCorr30d >= -0.2) elGoldValCorr30d.style.color = '#f59e0b';
    else elGoldValCorr30d.style.color = '#f43f5e';
  }
  if (elGoldTagCorrRegime && reg.regimeCode) {
    elGoldTagCorrRegime.textContent = reg.regimeCode.replace(/_/g, ' ');
  }
  if (elGoldCorrBar && c.rollingCorr30d !== undefined) {
    const pct = Math.max(5, Math.min(95, ((c.rollingCorr30d + 1) / 2) * 100));
    elGoldCorrBar.style.width = `${pct}%`;
  }
  if (elGoldValMcapShare && c.marketCapShare !== undefined) {
    elGoldValMcapShare.textContent = `${c.marketCapShare.toFixed(2)}%`;
  }

  // Side Matrix & Insights
  if (elGoldSideBtcGold && c.btcGoldRatio !== undefined) {
    elGoldSideBtcGold.textContent = `${c.btcGoldRatio.toFixed(2)} oz/BTC`;
  }
  if (elGoldSideGoldBtc && c.goldBtcRatio !== undefined) {
    elGoldSideGoldBtc.textContent = `${c.goldBtcRatio.toFixed(5)} BTC/oz`;
  }
  if (elGoldSideMcapShare && c.marketCapShare !== undefined) {
    elGoldSideMcapShare.textContent = `${c.marketCapShare.toFixed(2)}%`;
  }
  if (elGoldSideCorr && c.rollingCorr30d !== undefined) {
    const sign = c.rollingCorr30d >= 0 ? '+' : '';
    elGoldSideCorr.textContent = `${sign}${c.rollingCorr30d.toFixed(3)}`;
    elGoldSideCorr.style.color = elGoldValCorr30d?.style?.color || '#38bdf8';
  }
  if (elGoldSideRegimeTag && reg.regimeCode) {
    elGoldSideRegimeTag.textContent = reg.regimeCode;
  }
  if (elGoldSideRegimeName && reg.regimeName) {
    elGoldSideRegimeName.textContent = reg.regimeName;
    elGoldSideRegimeName.style.color = reg.color || '#10b981';
  }
  if (elGoldSideRegimeSummary && reg.summary) {
    elGoldSideRegimeSummary.textContent = reg.summary;
  }
  if (elGoldInsightsList && reg.keyPointers) {
    elGoldInsightsList.innerHTML = reg.keyPointers.map(p => `<li>${escapeHtml(p)}</li>`).join('');
  }

  // Render chart conditionally
  const shouldRedraw = forceRedraw ||
                       !goldChartInstance ||
                       prevTimestamp !== c.timestamp ||
                       prevLen !== data.series?.length;
  if (shouldRedraw) {
    renderGoldChart();
  }
}

function renderGoldChart() {
  if (!elGoldEcharts || !rawGoldData || !rawGoldData.series) return;

  if (!goldChartInstance) {
    goldChartInstance = echarts.init(elGoldEcharts, getEchartsTheme());
  }

  const colors = getChartThemeColors();
  let seriesData = rawGoldData.series;
  if (currentGoldTimeframe === '30') seriesData = seriesData.slice(-30);
  else if (currentGoldTimeframe === '90') seriesData = seriesData.slice(-90);
  else if (currentGoldTimeframe === '180') seriesData = seriesData.slice(-180);
  else if (currentGoldTimeframe === '365') seriesData = seriesData.slice(-365);

  const dates = seriesData.map(s => s.date);
  const ratioData = seriesData.map(s => s.btcGoldRatio);
  const corrData = seriesData.map(s => s.rollingCorr30d);
  const btcPrices = seriesData.map(s => s.btcPrice);
  const goldPrices = seriesData.map(s => s.goldPrice);

  const chartSeries = [];

  // 1. BTC / Gold Ratio (Top Grid, primary Y)
  if (goldVisibleSeries.ratio) {
    chartSeries.push({
      id: 'series-gold-ratio',
      name: 'BTC/Gold 比率 (oz)',
      type: 'line',
      xAxisIndex: 0,
      yAxisIndex: 0,
      showSymbol: false,
      smooth: 0.15,
      data: ratioData,
      lineStyle: { width: 2.5, color: '#eab308' },
      itemStyle: { color: '#eab308' },
      areaStyle: {
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: 'rgba(234, 179, 8, 0.22)' },
          { offset: 1, color: 'rgba(234, 179, 8, 0.00)' }
        ])
      }
    });
  }

  // 2. BTC Price (Top Grid, secondary Y)
  if (goldVisibleSeries.btcPrice) {
    chartSeries.push({
      id: 'series-gold-btc-price',
      name: 'BTC 现货 ($)',
      type: 'line',
      xAxisIndex: 0,
      yAxisIndex: 1,
      showSymbol: false,
      smooth: 0.15,
      data: btcPrices,
      lineStyle: { width: 1.5, color: '#f7931a', type: 'dashed' },
      itemStyle: { color: '#f7931a' }
    });
  }

  // 3. Gold Price (Top Grid, secondary Y)
  if (goldVisibleSeries.goldPrice) {
    chartSeries.push({
      id: 'series-gold-paxg-price',
      name: '金价 XAU ($/oz)',
      type: 'line',
      xAxisIndex: 0,
      yAxisIndex: 1,
      showSymbol: false,
      smooth: 0.15,
      data: goldPrices,
      lineStyle: { width: 1.5, color: '#38bdf8', type: 'dotted' },
      itemStyle: { color: '#38bdf8' }
    });
  }

  // 4. 30D Rolling Correlation (Bottom Grid)
  if (goldVisibleSeries.corr) {
    chartSeries.push({
      id: 'series-gold-corr',
      name: '30D 滚动相关性 r',
      type: 'line',
      xAxisIndex: 1,
      yAxisIndex: 2,
      showSymbol: false,
      smooth: 0.2,
      data: corrData,
      lineStyle: { width: 2.0, color: '#10b981' },
      itemStyle: { color: '#10b981' },
      areaStyle: {
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: 'rgba(16, 185, 129, 0.25)' },
          { offset: 1, color: 'rgba(16, 185, 129, 0.02)' }
        ])
      },
      markLine: {
        silent: true,
        symbol: 'none',
        lineStyle: { type: 'dashed', width: 1 },
        data: [
          { yAxis: 0.5, lineStyle: { color: 'rgba(16, 185, 129, 0.5)' }, label: { formatter: '+0.5 强共振', position: 'end', fontSize: 10, color: '#10b981' } },
          { yAxis: 0, lineStyle: { color: colors.gridLineStrong }, label: { formatter: '0 脱钩线', position: 'end', fontSize: 10, color: colors.tickColor } },
          { yAxis: -0.2, lineStyle: { color: 'rgba(244, 63, 94, 0.5)' }, label: { formatter: '-0.2 负相关轮动', position: 'end', fontSize: 10, color: '#f43f5e' } }
        ]
      }
    });
  }

  const option = {
    backgroundColor: 'transparent',
    animation: false,
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross', lineStyle: { color: colors.crossColor } },
      backgroundColor: colors.tooltipBg,
      borderColor: colors.tooltipBorder,
      textStyle: { color: colors.tooltipText, fontSize: 11, fontFamily: 'monospace' },
      formatter: function (params) {
        if (!params || !params.length) return '';
        let dateStr = params[0].axisValue || '';
        let html = `<div style="font-weight:700; margin-bottom:4px; color:${colors.tooltipTitle};">${dateStr}</div>`;
        params.forEach(p => {
          let val = p.value;
          let label = p.seriesName;
          if (val === null || val === undefined) return;
          if (label.includes('比率')) val = `${val.toFixed(2)} oz/BTC`;
          else if (label.includes('相关性')) val = `${val >= 0 ? '+' : ''}${val.toFixed(3)}`;
          else if (label.includes('$')) val = `$${Math.round(val).toLocaleString()}`;
          html += `<div style="display:flex; justify-content:space-between; gap:12px; font-size:11px;">
            <span style="color:${p.color};">${label}:</span>
            <span style="font-weight:700;">${val}</span>
          </div>`;
        });
        return html;
      }
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: [
      { left: '4%', right: '4%', top: '5%', height: '54%' },
      { left: '4%', right: '4%', top: '69%', height: '24%' }
    ],
    xAxis: [
      {
        type: 'category',
        data: dates,
        gridIndex: 0,
        axisLine: { lineStyle: { color: colors.axisLine } },
        axisLabel: { show: false },
        axisTick: { show: false }
      },
      {
        type: 'category',
        data: dates,
        gridIndex: 1,
        axisLine: { lineStyle: { color: colors.axisLine } },
        axisLabel: {
          color: colors.tickColor,
          fontSize: 10,
          fontFamily: 'monospace',
          formatter: v => v.slice(5)
        }
      }
    ],
    yAxis: [
      // Y0: Top Grid, Left - BTC/Gold Ratio
      {
        type: 'value',
        gridIndex: 0,
        name: 'BTC/Gold Ratio (oz)',
        nameTextStyle: { color: colors.isLight ? '#b45309' : '#eab308', fontSize: 10, fontFamily: 'monospace' },
        splitLine: { lineStyle: { color: colors.gridLine } },
        axisLabel: { color: colors.isLight ? '#b45309' : '#eab308', fontSize: 10, fontFamily: 'monospace', formatter: v => `${v.toFixed(1)} oz` }
      },
      // Y1: Top Grid, Right - USD Price
      {
        type: 'value',
        gridIndex: 0,
        name: 'USD Price',
        nameTextStyle: { color: colors.tickColor, fontSize: 10, fontFamily: 'monospace' },
        splitLine: { show: false },
        axisLabel: { color: colors.tickColor, fontSize: 10, fontFamily: 'monospace', formatter: v => `$${Math.round(v)}` }
      },
      // Y2: Bottom Grid - Correlation r
      {
        type: 'value',
        gridIndex: 1,
        name: '30D Correlation (r)',
        min: -1.0,
        max: 1.0,
        interval: 0.5,
        nameTextStyle: { color: '#10b981', fontSize: 10, fontFamily: 'monospace' },
        splitLine: { lineStyle: { color: colors.gridLine } },
        axisLabel: { color: '#10b981', fontSize: 10, fontFamily: 'monospace', formatter: v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}` }
      }
    ],
    series: chartSeries
  };

  goldChartInstance.setOption(option, true);
}

function initGoldCorrelationEvents() {
  window.addEventListener('resize', () => {
    if (goldChartInstance) goldChartInstance.resize();
  });

  // Timeframe selector buttons
  if (goldTimeframeSelector) {
    goldTimeframeSelector.addEventListener('click', e => {
      const btn = e.target.closest('.timeframe-btn');
      if (!btn) return;
      goldTimeframeSelector.querySelectorAll('.timeframe-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentGoldTimeframe = btn.dataset.days;
      renderGoldChart();
    });
  }

  // Legend toggle pills
  const setupToggle = (btn, key) => {
    if (!btn) return;
    btn.addEventListener('click', () => {
      goldVisibleSeries[key] = !goldVisibleSeries[key];
      btn.classList.toggle('active', goldVisibleSeries[key]);
      renderGoldChart();
    });
  };

  setupToggle(btnGoldToggleRatio, 'ratio');
  setupToggle(btnGoldToggleCorr, 'corr');
  setupToggle(btnGoldToggleBtc, 'btcPrice');
  setupToggle(btnGoldToggleGold, 'goldPrice');

  // Auto-refresh gold correlation every 60 seconds when viewing (server-side cache TTL is 10 min)
  setInterval(() => {
    if (currentActiveView === 'view-gold-correlation' || currentActiveView === 'view-all') {
      loadGoldCorrelationData(false);
    }
  }, 60000);
}


// ============================================================================
// Module 1-B: Crypto McClellan Oscillator (Core Top 100 vs On-chain Meme)
// ============================================================================

let rawMcClellanData = null;
let mcclellanChartInstance = null;
let isMcClellanLoading = false;
let mcclellanActiveTimeframe = '1y';
let mcclellanActiveTrack = 'core';

const MC_TRACKS = {
  core: { label: 'Core Top 100', color: '#06b6d4' },
  frontier: { label: '链上 Meme', color: '#ec4899' }
};
const MC_CHAIN_LABELS = { solana: 'SOL', bsc: 'BSC', robinhood: 'HOOD' };

function mcFmtSigned(v, digits = 1) {
  if (v === null || v === undefined || !isFinite(v)) return '--';
  const n = Number(v);
  return `${n > 0 ? '+' : ''}${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/**
 * Fetch Crypto McClellan data from server
 */
async function loadMcClellanData(force = false) {
  if (isMcClellanLoading) return;
  isMcClellanLoading = true;

  const btnRefresh = document.getElementById('btn-refresh-mcclellan');
  if (btnRefresh) btnRefresh.classList.add('loading');

  try {
    const url = force ? '/api/crypto-mcclellan?force=1' : '/api/crypto-mcclellan';
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const resJson = await resp.json();

    if (resJson && resJson.code === 0) {
      rawMcClellanData = resJson.data || resJson;
      renderMcClellanDashboard(rawMcClellanData);
      if (force) {
        const rStatus = resJson.refreshStatus || rawMcClellanData.refresh_status;
        if (rStatus?.status === 'refreshed') {
          showToast('麦克莱伦宽度数据已重新采集并解算');
        } else if (rStatus?.status === 'pipelineUnavailable') {
          showToast('当前环境未检测到 Python 运行时，已载入最新快照数据');
        } else if (rStatus?.status === 'stale') {
          showToast('Python 管线运行异常，已回退至快照数据');
        } else {
          showToast('已更新加密麦克莱伦市场宽度数据');
        }
      }
    } else {
      throw new Error(resJson?.error || '返回数据格式不符合预期');
    }
  } catch (err) {
    console.error('[CryptoMcClellan] Load data failed:', err);
    showToast(`麦克莱伦数据载入失败: ${err.message}`);
  } finally {
    isMcClellanLoading = false;
    if (btnRefresh) btnRefresh.classList.remove('loading');
  }
}

/**
 * Oscillator chip: position against the track's own 10% / 90% percentile bands
 */
function mcOscillatorChip(el, cur, bands) {
  if (!el) return;
  el.className = 'mm-chip';
  if (!cur || cur.oscillator === null || cur.oscillator === undefined) {
    el.textContent = '--';
    return;
  }
  const pct = cur.percentile !== null && cur.percentile !== undefined ? `P${cur.percentile}` : '';
  let zone = '中性';
  if (bands && cur.oscillator >= bands.high) { zone = '超买区'; el.classList.add('text-amber'); }
  else if (bands && cur.oscillator <= bands.low) { zone = '超卖区'; el.classList.add('text-neg'); }
  el.textContent = pct ? `${pct} · ${zone}` : zone;
}

function mcAdvDecText(cur) {
  if (!cur || cur.advances === undefined) return '';
  return `涨 ${cur.advances} / 跌 ${cur.declines} · RAMO ${mcFmtSigned(cur.ramo, 0)}`;
}

function mcChangeChip(v) {
  if (v === null || v === undefined) return ['--', 'mm-chip'];
  return [`10日 ${mcFmtSigned(v, 0)}`, `mm-chip ${v > 0 ? 'text-pos' : (v < 0 ? 'text-neg' : '')}`];
}

/**
 * Render KPI cards for Crypto McClellan
 */
function renderMcClellanDashboard(data) {
  if (!data || !data.current) return;
  const { current, bands = {}, metadata = {} } = data;
  const core = current.core || {};
  const fr = current.frontier || {};
  const setText = (id, text, cls) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    if (cls !== undefined) el.className = cls;
  };

  setText('mcclellan-update-time', current.date ? `${current.date} (UTC 收盘)` : '--');

  // Core oscillator & summation
  setText('kpi-mc-core-osc', mcFmtSigned(core.oscillator, 1),
    `mm-val ${core.oscillator >= 0 ? 'text-cyan' : 'text-neg'}`);
  mcOscillatorChip(document.getElementById('kpi-mc-core-osc-chip'), core, bands.core);
  setText('kpi-mc-core-osc-sub', mcAdvDecText(core) || 'EMA19 − EMA39 of RAMO');

  setText('kpi-mc-core-sum', mcFmtSigned(core.summation, 0),
    `mm-val ${core.summation >= 0 ? 'text-pos' : 'text-neg'}`);
  setText('kpi-mc-core-sum-chip', ...mcChangeChip(core.summation_change_10d));
  setText('kpi-mc-core-sum-sub', `${core.constituents ?? '--'} 个成分 · 数据始于 ${metadata.core?.history_start || '--'}`);

  // Frontier: accumulated forward only, so it may still be warming up
  const warmup = fr.warmup_days || metadata.parameters?.warmup_days || 40;
  if (fr.ready) {
    setText('kpi-mc-fr-osc', mcFmtSigned(fr.oscillator, 1),
      `mm-val ${fr.oscillator >= 0 ? 'text-fuchsia' : 'text-neg'}`);
    mcOscillatorChip(document.getElementById('kpi-mc-fr-osc-chip'), fr, bands.frontier);
    setText('kpi-mc-fr-sum', mcFmtSigned(fr.summation, 0),
      `mm-val ${fr.summation >= 0 ? 'text-pos' : 'text-neg'}`);
    setText('kpi-mc-fr-sum-chip', ...mcChangeChip(fr.summation_change_10d));
  } else {
    setText('kpi-mc-fr-osc', '预热中', 'mm-val text-fuchsia');
    setText('kpi-mc-fr-osc-chip', `${fr.breadth_days || 0}/${warmup} 天`, 'mm-chip');
    setText('kpi-mc-fr-sum', '--', 'mm-val');
    setText('kpi-mc-fr-sum-chip', '预热', 'mm-chip');
  }
  const anchorText = fr.anchor_corr !== null && fr.anchor_corr !== undefined
    ? ` · DEX 动量 r=${fr.anchor_corr.toFixed(2)}` : '';
  setText('kpi-mc-fr-osc-sub', (mcAdvDecText(fr) + anchorText)
    || (fr.started ? `${fr.started} 开始采集 · 次日起统计涨跌` : 'Solana · BSC · Robinhood 热门池'));

  const byChain = fr.tracked_by_chain || {};
  const chainText = Object.keys(byChain).map(c => `${MC_CHAIN_LABELS[c] || c} ${byChain[c]}`).join(' · ');
  const deadText = fr.dead ? ` · 撤池 ${fr.dead}` : '';
  setText('kpi-mc-fr-sum-sub', fr.tracked_today !== undefined ? `跟踪 ${fr.tracked_today} · ${chainText}${deadText}` : '--');

  renderMcClellanCharts();
}

function mcFilterSeries(series) {
  if (mcclellanActiveTimeframe === 'all' || !series.length) return series;
  const days = { '90d': 90, '180d': 180, '1y': 365 }[mcclellanActiveTimeframe] || 365;
  const last = new Date(`${series[series.length - 1].date}T00:00:00Z`);
  const cutoff = new Date(last.getTime() - days * 86400000).toISOString().slice(0, 10);
  return series.filter(d => d.date > cutoff);
}

/**
 * Three stacked panels on a shared time axis:
 *   BTC price  /  McClellan Oscillator  /  Summation Index
 */
function renderMcClellanCharts() {
  const dom = document.getElementById('mcclellan-echarts');
  if (!dom || !rawMcClellanData || !rawMcClellanData.series || typeof echarts === 'undefined') return;

  if (!mcclellanChartInstance) {
    mcclellanChartInstance = echarts.init(dom, getEchartsTheme());
  }

  const colors = getChartThemeColors();
  const data = rawMcClellanData;
  const rows = mcFilterSeries(data.series);
  const dates = rows.map(d => d.date);
  const track = mcclellanActiveTrack;
  const tracks = track === 'compare' ? ['core', 'frontier'] : [track];
  const fr = data.current?.frontier || {};
  const posColor = '#10b981';
  const negColor = '#f43f5e';
  const axisLabel = { color: colors.tickColor, fontSize: 10, fontFamily: 'monospace' };

  // Warm-up notice for the forward-accumulated Meme track
  const notice = document.getElementById('mcclellan-warmup-notice');
  if (notice) {
    const showNotice = track !== 'core' && !fr.ready;
    notice.classList.toggle('hidden', !showNotice);
    if (showNotice) {
      const warmup = fr.warmup_days || 40;
      notice.textContent = fr.started
        ? `链上 Meme 轨从 ${fr.started} 开始逐日累积（链上热度无法回填历史），需 ${warmup} 个交易日预热后才发布振荡器，目前 ${fr.breadth_days || 0}/${warmup}。`
        : '链上 Meme 轨尚未开始采集。';
    }
  }

  const zeroLine = { yAxis: 0, lineStyle: { color: colors.gridLineStrong, type: 'solid', width: 1 }, label: { show: false } };

  const series = [{
    name: 'BTC',
    type: 'line',
    xAxisIndex: 0,
    yAxisIndex: 0,
    showSymbol: false,
    data: rows.map(d => d.btc_close),
    lineStyle: { width: 1.6, color: '#f7931a' },
    itemStyle: { color: '#f7931a' }
  }];

  const showAnchor = track !== 'core';
  if (showAnchor) {
    series.push({
      name: 'DEX 成交额动量',
      type: 'line',
      xAxisIndex: 0,
      yAxisIndex: 3,
      showSymbol: false,
      data: rows.map(d => d.dex_momentum),
      lineStyle: { width: 1.3, color: '#8b5cf6', type: 'dashed' },
      itemStyle: { color: '#8b5cf6' },
      markLine: { silent: true, symbol: 'none', data: [{ yAxis: 0, lineStyle: { color: 'rgba(139, 92, 246, 0.35)', type: 'dotted' }, label: { show: false } }] }
    });
  }

  tracks.forEach((t, idx) => {
    const meta = MC_TRACKS[t];
    const oscData = rows.map(d => d[`${t}_oscillator`]);
    const sumData = rows.map(d => d[`${t}_summation`]);

    if (track === 'compare') {
      series.push({
        name: `${meta.label} 振荡器`,
        type: 'line',
        xAxisIndex: 1,
        yAxisIndex: 1,
        showSymbol: false,
        data: oscData,
        lineStyle: { width: 1.6, color: meta.color },
        itemStyle: { color: meta.color },
        markLine: idx === 0 ? { silent: true, symbol: 'none', data: [zeroLine] } : undefined
      });
    } else {
      const bands = data.bands?.[t];
      const bandLines = [zeroLine];
      if (bands) {
        bandLines.push(
          { yAxis: bands.high, lineStyle: { color: 'rgba(245, 158, 11, 0.75)', type: 'dashed' }, label: { formatter: `P90 ${mcFmtSigned(bands.high, 0)}`, position: 'insideEndTop', fontSize: 10, color: '#f59e0b' } },
          { yAxis: bands.low, lineStyle: { color: 'rgba(244, 63, 94, 0.75)', type: 'dashed' }, label: { formatter: `P10 ${mcFmtSigned(bands.low, 0)}`, position: 'insideEndBottom', fontSize: 10, color: negColor } }
        );
      }
      series.push({
        name: `${meta.label} 振荡器`,
        type: 'bar',
        xAxisIndex: 1,
        yAxisIndex: 1,
        barCategoryGap: '20%',
        data: oscData.map(v => (v === null || v === undefined ? null : { value: v, itemStyle: { color: v >= 0 ? posColor : negColor } })),
        itemStyle: { color: meta.color },
        markLine: { silent: true, symbol: 'none', data: bandLines }
      });
    }

    series.push({
      name: `${meta.label} 累加指数`,
      type: 'line',
      xAxisIndex: 2,
      yAxisIndex: 2,
      showSymbol: false,
      data: sumData,
      lineStyle: { width: 1.8, color: meta.color },
      itemStyle: { color: meta.color },
      areaStyle: track === 'compare' ? undefined : { color: meta.color, opacity: 0.12 },
      markLine: idx === 0 ? { silent: true, symbol: 'none', data: [zeroLine] } : undefined
    });
  });

  // Hint in the empty oscillator panel while the selected track is still warming up
  const hasOsc = tracks.some(t => rows.some(d => d[`${t}_oscillator`] !== null && d[`${t}_oscillator`] !== undefined));
  const graphic = hasOsc ? [] : [{
    type: 'text',
    left: 'center',
    top: '50%',
    silent: true,
    style: { text: 'Meme 振荡器预热中', fill: colors.textMuted, fontSize: 13, fontFamily: 'monospace' }
  }];

  const option = {
    backgroundColor: 'transparent',
    animation: false,
    graphic,
    legend: {
      top: 0,
      left: 'center',
      itemWidth: 14,
      itemHeight: 8,
      textStyle: { color: colors.textSecondary, fontSize: 11 },
      data: series.map(s => s.name)
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross', lineStyle: { color: colors.crossColor } },
      backgroundColor: colors.tooltipBg,
      borderColor: colors.tooltipBorder,
      textStyle: { color: colors.tooltipText, fontSize: 11, fontFamily: 'monospace' },
      formatter: params => {
        if (!params || !params.length) return '';
        const d = rows[params[0].dataIndex];
        if (!d) return '';
        const line = (label, val, color) => `<div style="display:flex; justify-content:space-between; gap:14px;"><span style="color:${color || colors.tooltipText};">${label}</span><span style="font-weight:700;">${val}</span></div>`;
        let html = `<div style="font-weight:700; margin-bottom:4px; color:${colors.tooltipTitle};">${d.date}</div>`;
        if (d.btc_close) html += line('BTC', `$${Math.round(d.btc_close).toLocaleString('en-US')}`, '#f7931a');
        if (showAnchor && d.dex_momentum !== null && d.dex_momentum !== undefined) {
          html += line('DEX 成交额 / 动量', `$${d.dex_volume.toFixed(2)}B / ${mcFmtSigned(d.dex_momentum, 1)}%`, '#8b5cf6');
        }
        tracks.forEach(t => {
          const meta = MC_TRACKS[t];
          if (d[`${t}_adv`] === null || d[`${t}_adv`] === undefined) return;
          html += `<div style="margin-top:4px; border-top:1px solid ${colors.tooltipDivider}; padding-top:3px; color:${meta.color}; font-weight:700;">${meta.label}</div>`;
          html += line('振荡器', mcFmtSigned(d[`${t}_oscillator`], 1));
          html += line('累加指数', mcFmtSigned(d[`${t}_summation`], 0));
          html += line('涨 / 跌 (成分)', `${d[`${t}_adv`]} / ${d[`${t}_dec`]} (${d[`${t}_n`]})`);
          html += line(t === 'frontier' ? 'RAMO (按链等权)' : 'RAMO', mcFmtSigned(d[`${t}_ramo`], 0));
          if (t === 'frontier' && d.frontier_ramo_pooled !== undefined) {
            html += line('合并 RAMO (诊断)', mcFmtSigned(d.frontier_ramo_pooled, 0));
          }
          if (t === 'frontier' && d.frontier_dead !== undefined) {
            // Churn diagnostics: rugs counted as declines, basket turnover and age
            html += line('撤池 / 新进 / 移出', `${d.frontier_dead} / ${d.frontier_entries} / ${d.frontier_exits}`);
            html += line('成分年龄中位', d.frontier_age_median === null ? '--' : `${d.frontier_age_median} 天`);
            if (d.frontier_low_sample) html += line('⚠ 样本不足', `< ${data.metadata?.frontier?.min_constituents || 20}`, '#f59e0b');
          }
        });
        return html;
      }
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: [
      { left: 60, right: showAnchor ? 52 : 20, top: '7%', height: '27%' },
      { left: 60, right: showAnchor ? 52 : 20, top: '39%', height: '25%' },
      { left: 60, right: showAnchor ? 52 : 20, top: '69%', height: '17%' }
    ],
    xAxis: [0, 1, 2].map(i => ({
      type: 'category',
      data: dates,
      gridIndex: i,
      axisLine: { lineStyle: { color: colors.axisLine } },
      axisTick: { show: false },
      axisLabel: i === 2 ? { ...axisLabel, formatter: v => v.slice(2) } : { show: false }
    })),
    yAxis: [
      {
        type: 'value', gridIndex: 0, scale: true, name: 'BTC', nameTextStyle: { ...axisLabel, color: '#f7931a' },
        splitNumber: 3,
        splitLine: { lineStyle: { color: colors.gridLine } },
        axisLabel: { ...axisLabel, formatter: v => `$${Math.round(v / 1000)}k` }
      },
      {
        type: 'value', gridIndex: 1, name: '振荡器', nameTextStyle: axisLabel,
        splitLine: { lineStyle: { color: colors.gridLine } },
        axisLabel: { ...axisLabel, formatter: v => mcFmtSigned(v, 0) }
      },
      {
        type: 'value', gridIndex: 2, scale: true, name: '累加指数', nameTextStyle: axisLabel,
        splitNumber: 3,
        splitLine: { lineStyle: { color: colors.gridLine } },
        axisLabel: { ...axisLabel, formatter: v => mcFmtSigned(v, 0) }
      },
      {
        type: 'value', gridIndex: 0, position: 'right', show: showAnchor,
        name: 'DEX 动量', nameTextStyle: { ...axisLabel, color: '#8b5cf6' },
        splitNumber: 3,
        splitLine: { show: false },
        axisLabel: { ...axisLabel, color: '#8b5cf6', formatter: v => `${v}%` }
      }
    ],
    dataZoom: [{
      type: 'slider',
      xAxisIndex: [0, 1, 2],
      bottom: 8,
      height: 18,
      borderColor: colors.axisLine,
      textStyle: { color: colors.tickColor, fontSize: 10 }
    }],
    series
  };

  mcclellanChartInstance.setOption(option, true);
}

/**
 * Initialize event handlers for McClellan module
 */
function initMcClellanEvents() {
  const btnRefresh = document.getElementById('btn-refresh-mcclellan');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', () => loadMcClellanData(true));
  }

  const bindSwitch = (containerId, attr, apply) => {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.querySelectorAll('.switch-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('.switch-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        apply(btn.dataset[attr]);
        renderMcClellanCharts();
      });
    });
  };
  bindSwitch('mcclellan-track-switch', 'track', v => { mcclellanActiveTrack = v || 'core'; });
  bindSwitch('mcclellan-timeframe-switch', 'range', v => { mcclellanActiveTimeframe = v || '1y'; });

  window.addEventListener('resize', () => {
    if (mcclellanChartInstance) mcclellanChartInstance.resize();
  });

  // Collapsible methodology accordion
  const btnAccordion = document.getElementById('btn-mcclellan-methodology-toggle');
  const accContent = document.getElementById('mcclellan-methodology-content');
  if (btnAccordion && accContent) {
    btnAccordion.addEventListener('click', () => {
      const isExpanded = btnAccordion.getAttribute('aria-expanded') === 'true';
      btnAccordion.setAttribute('aria-expanded', !isExpanded);
      accContent.classList.toggle('hidden', isExpanded);
    });
  }
}

// ============================================================================
// Module 8 按需加载: 只有进入波浪研判 (或全模块平铺) 时才下载其脚本 (~440 KB)
// ============================================================================
const WAVE_MODULE_SCRIPTS = ['/lightweight-charts.min.js', '/wave_engine.js', '/wave_ui.js'];
let waveModulePromise = null;

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error(`无法加载 ${src}`));
    document.head.appendChild(el);
  });
}

function ensureWaveModule() {
  if (window.WaveRadarModule) return Promise.resolve(window.WaveRadarModule);
  if (!waveModulePromise) {
    waveModulePromise = WAVE_MODULE_SCRIPTS
      .reduce((chain, src) => chain.then(() => loadScriptOnce(src)), Promise.resolve())
      .then(() => {
        window.WaveRadarModule.init();
        return window.WaveRadarModule;
      })
      .catch(e => {
        waveModulePromise = null; // 允许下次进入时重试
        throw e;
      });
  }
  return waveModulePromise;
}

// ============================================================================
// Application Startup Initialization
// ============================================================================
initThemeController();
initMacroChartEvents();
initCdriEvents();
initTermPremiumEvents();
initEtfLinkageEvents();
initSsroEvents();
initCoinbaseLiquidityEvents();
initGoldCorrelationEvents();
initMcClellanEvents();
initNavigation();
loadMarketData(false);
loadEtfLinkageData(false);
fetchSsroData(false);
fetchCoinbaseLiquidityData(false);
loadGoldCorrelationData(false);
loadMcClellanData(false);
