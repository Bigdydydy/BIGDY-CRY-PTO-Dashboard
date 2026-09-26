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
  if (typeof cdriChartInstance !== 'undefined' && cdriChartInstance) {
    try { cdriChartInstance.dispose(); } catch (e) {}
    cdriChartInstance = null;
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
  if (typeof renderAiBtcTensionCharts === 'function' && typeof rawAiBtcTensionData !== 'undefined' && rawAiBtcTensionData) {
    renderAiBtcTensionCharts();
  }
  if (typeof renderMcClellanCharts === 'function' && typeof rawMcClellanData !== 'undefined' && rawMcClellanData) {
    renderMcClellanCharts();
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
    showToast(`已切换至 Studio K95 ${nextTheme === 'light' ? '日间画廊模式 (Gallery)' : '夜间黑曜石模式 (Noir)'}`);
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
      fetchSsroData(triggerRefresh).catch(e => console.error('[App] SSRO fetch error:', e.message)),
      loadAiBtcTensionData(triggerRefresh).catch(e => console.error('[App] AI-BTC Tension fetch error:', e.message))
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
          <span class="intent-badge-pill ${escapeHtml(c.intentBadgeClass || 'badge-neutral')}">${escapeHtml(c.intentBadge || '意图解析')}</span>
          ${c.strategyNameZh ? `<div style="font-size:0.7rem;color:#a1a1aa;margin-top:4px;text-align:right;">${escapeHtml(c.strategyNameZh)}</div>` : ''}
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
          <span class="intent-badge-pill ${escapeHtml(b.intentBadgeClass || 'badge-neutral')}">${escapeHtml(b.intentBadge || '--')}</span>
          ${b.strategyNameZh ? `<div style="font-size:0.68rem;color:#a1a1aa;margin-top:3px;">${escapeHtml(b.strategyNameZh)}</div>` : ''}
        </td>
        <td><strong>$${(Number(b.notionalUSDM) || 0).toFixed(2)}M</strong></td>
        <td>${(Number(b.netDeltaBTC) || 0) >= 0 ? '+' : ''}${(Number(b.netDeltaBTC) || 0).toFixed(1)} BTC</td>
        <td>${(Number(b.netVegaUSD) || 0) >= 0 ? '+' : ''}$${Math.round(Number(b.netVegaUSD) || 0).toLocaleString()}</td>
        <td>${Number(b.legCount) || 0} 腿</td>
        <td><button class="action-btn" onclick="event.stopPropagation(); openWhaleDetail(${Number(globalIdx)})">穿透解析</button></td>
      </tr>
    `;

    cardsHtml += `
      <div class="whale-mobile-card" onclick="openWhaleDetail(${Number(globalIdx)})">
        <div class="wmc-header">
          <div class="wmc-id-group">
            <span class="wmc-id">${escapeHtml(b.blockId)}</span>
            <span class="wmc-time">${escapeHtml((b.dateTimeUTC8 || b.dateTime || '').slice(5, 16))}</span>
          </div>
          <span class="intent-badge-pill ${escapeHtml(b.intentBadgeClass || 'badge-neutral')}">${escapeHtml(b.intentBadge || '--')}</span>
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
          <span class="wmc-tap-hint">点击穿透希腊字母与战略意图 →</span>
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

  if (mStrategyName) {
    mStrategyName.textContent = b.strategyNameZh || '机构定制结构';
  }
  if (mMaxProfit) mMaxProfit.textContent = b.riskProfile?.maxProfit || '--';
  if (mMaxLoss) mMaxLoss.textContent = b.riskProfile?.maxLoss || '--';
  if (mBreakEven) mBreakEven.textContent = b.riskProfile?.breakEven || '--';

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

  if (mStrategyName) {
    mStrategyName.textContent = c.strategyNameZh || '机构时间切片拆单 (Iceberg Synthetic)';
  }
  if (mMaxProfit) mMaxProfit.textContent = c.riskProfile?.maxProfit || '--';
  if (mMaxLoss) mMaxLoss.textContent = c.riskProfile?.maxLoss || '--';
  if (mBreakEven) mBreakEven.textContent = c.riskProfile?.breakEven || '--';

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
// Futures Basis Term Structure & Multi-Span Term Premium Radar Controller
// ============================================================================

let currentTermPremiumData = null;
let termPremiumChartInstance = null;
let currentTpTimeframe = 'all'; // '30', '90', '180', '365', 'all'
let tpVisibleSeries = {
  spread90d7d: true,
  spread30d7d: true,
  spread180d30d: true,
  apr30d: true,
  hurdle: true,
  tbill: true,
  allCurves: false
};

// DOM Elements
const elTpHeaderRegimePill = document.getElementById('tp-header-regime-pill');
const elTpHeaderScorePill = document.getElementById('tp-header-score-pill');
const elTpHeaderExcessPill = document.getElementById('tp-header-excess-pill');
const elTpUpdateTime = document.getElementById('tp-update-time');
const elTpDataSourceBadge = document.getElementById('tp-data-source-badge');
const elTpHistoryPointsBadge = document.getElementById('tp-history-points-badge');

const elTpVal7d = document.getElementById('tp-val-7d');
const elTpVal30d = document.getElementById('tp-val-30d');
const elTpVal60d = document.getElementById('tp-val-60d');
const elTpVal90d = document.getElementById('tp-val-90d');
const elTpVal180d = document.getElementById('tp-val-180d');
const elTpUnann30d = document.getElementById('tp-unann-30d');
const elTpEtfStatusBadge = document.getElementById('tp-etf-status-badge');

const elTpSpread90d7d = document.getElementById('tp-spread-90d7d');
const elTpSpread30d7d = document.getElementById('tp-spread-30d7d');
const elTpSpread180d30d = document.getElementById('tp-spread-180d30d');

const elTpRegimeTag = document.getElementById('tp-regime-tag');
const elTpScoreValue = document.getElementById('tp-score-value');
const elTpExcessVal = document.getElementById('tp-excess-val');
const elTpScoreBarFill = document.getElementById('tp-score-bar-fill');

const elTpInsightsSummary = document.getElementById('tp-insights-summary');
const elTpInsightsList = document.getElementById('tp-insights-list');

const elTpEcharts = document.getElementById('term-premium-echarts');
const tpTimeframeSelector = document.getElementById('tp-timeframe-selector');

const btnToggleSpread90d7d = document.getElementById('btn-toggle-spread90d7d');
const btnToggleSpread30d7d = document.getElementById('btn-toggle-spread30d7d');
const btnToggleSpread180d30d = document.getElementById('btn-toggle-spread180d30d');
const btnToggleApr30d = document.getElementById('btn-toggle-apr30d');
const btnToggleHurdle = document.getElementById('btn-toggle-hurdle');
const btnToggleTbill = document.getElementById('btn-toggle-tbill');
const btnToggleAllCurves = document.getElementById('btn-toggle-all-curves');

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
    elTpDataSourceBadge.title = `数据认证：${data.metadata.dataSource} | 跨度: ${data.metadata.timeRange || ''} | 缺失处理: ${data.metadata.missingHandling || ''}`;
  }
  if (elTpHistoryPointsBadge && data.series) {
    elTpHistoryPointsBadge.textContent = `${data.series.length} 条真实历史日线 (2025.01~至今)`;
  }

  if (elTpHeaderRegimePill && reg.regimeName) {
    elTpHeaderRegimePill.textContent = reg.regimeName.split(' ')[0] || '升水结构';
    if (reg.regimeBadgeClass) {
      elTpHeaderRegimePill.className = `tp-regime-pill ${reg.regimeBadgeClass}`;
    }
  }
  if (elTpHeaderScorePill && c && c.carryScore !== undefined) {
    elTpHeaderScorePill.textContent = `Carry: ${c.carryScore >= 0 ? '+' : ''}${c.carryScore.toFixed(1)}`;
    elTpHeaderScorePill.style.color = c.carryScore >= 20 ? '#10b981' : (c.carryScore >= 10 ? '#f59e0b' : '#f43f5e');
  }
  if (elTpHeaderExcessPill && c && c.excessReturn !== undefined) {
    elTpHeaderExcessPill.textContent = `超额: ${c.excessReturn >= 0 ? '+' : ''}${c.excessReturn.toFixed(2)}%`;
  }
  if (elTpUpdateTime && c) {
    elTpUpdateTime.textContent = `${formatUTC8(c.timestamp || Date.now())} (UTC+8)`;
  }

  // 1. Constant Maturity Basis Matrix
  if (c) {
    if (elTpVal7d) {
      elTpVal7d.textContent = `${c.apr7d >= 0 ? '+' : ''}${c.apr7d.toFixed(2)}%`;
      elTpVal7d.style.color = c.apr7d >= 0 ? '#10b981' : '#f43f5e';
    }
    if (elTpVal30d) {
      elTpVal30d.textContent = `${c.apr30d >= 0 ? '+' : ''}${c.apr30d.toFixed(2)}%`;
      elTpVal30d.style.color = '#f59e0b';
    }
    if (elTpVal60d) {
      elTpVal60d.textContent = `${c.apr60d !== undefined ? (c.apr60d >= 0 ? '+' : '') + c.apr60d.toFixed(2) + '%' : '--%'}`;
      elTpVal60d.style.color = '#38bdf8';
    }
    if (elTpVal90d) {
      elTpVal90d.textContent = `${c.apr90d >= 0 ? '+' : ''}${c.apr90d.toFixed(2)}%`;
      elTpVal90d.style.color = c.apr90d >= 0 ? '#38bdf8' : '#f43f5e';
    }
    if (elTpVal180d) {
      elTpVal180d.textContent = `${c.apr180d >= 0 ? '+' : ''}${c.apr180d.toFixed(2)}%`;
      elTpVal180d.style.color = c.apr180d >= 0 ? '#10b981' : '#f43f5e';
    }

    // 1-B. Amberdata 0.50% ETF Friction Audit
    if (elTpUnann30d && c.unannualizedBasis30d !== undefined) {
      elTpUnann30d.textContent = `${c.unannualizedBasis30d >= 0 ? '+' : ''}${c.unannualizedBasis30d.toFixed(2)}%`;
      elTpUnann30d.style.color = c.unannualizedBasis30d >= 0.50 ? '#10b981' : (c.unannualizedBasis30d > 0 ? '#f59e0b' : '#f43f5e');
    }
    if (elTpEtfStatusBadge) {
      const isCovered = c.etfArbitrageStatus === 'COVERED' || c.unannualizedBasis30d >= 0.50;
      const margin = c.etfArbitrageMargin !== undefined ? c.etfArbitrageMargin : (c.unannualizedBasis30d ? c.unannualizedBasis30d - 0.50 : 0);
      if (isCovered) {
        elTpEtfStatusBadge.textContent = `摩擦覆盖 (+${margin >= 0 ? margin.toFixed(2) : '0.00'}%)`;
        elTpEtfStatusBadge.className = 'tp-ef-badge profitable';
      } else {
        elTpEtfStatusBadge.textContent = `摩擦破位 (${margin.toFixed(2)}%)`;
        elTpEtfStatusBadge.className = 'tp-ef-badge unprofitable';
      }
    }

    // 2. Multi-Span Spreads Breakdown
    if (elTpSpread90d7d) {
      elTpSpread90d7d.textContent = `${c.spread90d7d >= 0 ? '+' : ''}${c.spread90d7d.toFixed(2)}%`;
      elTpSpread90d7d.className = `tp-sp-num ${c.spread90d7d >= 0 ? 'text-pos' : 'text-neg'}`;
    }
    if (elTpSpread30d7d) {
      elTpSpread30d7d.textContent = `${c.spread30d7d >= 0 ? '+' : ''}${c.spread30d7d.toFixed(2)}%`;
      elTpSpread30d7d.className = `tp-sp-num ${c.spread30d7d >= 0 ? 'text-pos' : 'text-neg'}`;
    }
    if (elTpSpread180d30d) {
      elTpSpread180d30d.textContent = `${c.spread180d30d >= 0 ? '+' : ''}${c.spread180d30d.toFixed(2)}%`;
      elTpSpread180d30d.className = `tp-sp-num ${c.spread180d30d >= 0 ? 'text-pos' : 'text-neg'}`;
    }

    // 3. Carry Score & Excess Return
    if (elTpRegimeTag && reg.regimeCode) {
      elTpRegimeTag.textContent = reg.regimeCode.replace(/_/g, ' ');
    }
    if (elTpScoreValue && c.carryScore !== undefined) {
      elTpScoreValue.textContent = `${c.carryScore >= 0 ? '+' : ''}${c.carryScore.toFixed(1)}`;
      // Amberdata 3-tier benchmark: <10 Avoid, 10-20 Marginal, >20 Excellent
      if (c.carryScore >= 20) elTpScoreValue.style.color = '#10b981';
      else if (c.carryScore >= 10) elTpScoreValue.style.color = '#f59e0b';
      else elTpScoreValue.style.color = '#f43f5e';
    }
    if (elTpExcessVal && c.excessReturn !== undefined) {
      elTpExcessVal.textContent = `${c.excessReturn >= 0 ? '+' : ''}${c.excessReturn.toFixed(2)}%`;
      elTpExcessVal.style.color = c.excessReturn >= 0 ? '#10b981' : '#f43f5e';
    }
    if (elTpScoreBarFill && c.carryScore !== undefined) {
      // Map Amberdata scale [0, 30] to [5%, 95%]
      const pct = Math.max(5, Math.min(95, (c.carryScore / 30) * 100));
      elTpScoreBarFill.style.width = `${pct}%`;
      elTpScoreBarFill.style.backgroundColor = c.carryScore >= 20 ? '#10b981' : (c.carryScore >= 10 ? '#f59e0b' : '#f43f5e');
    }
  }

  // 4. Institutional Insights
  if (elTpInsightsSummary && reg.statusSummary) {
    elTpInsightsSummary.textContent = reg.statusSummary;
  }
  if (elTpInsightsList && reg.keyPointers) {
    elTpInsightsList.innerHTML = reg.keyPointers.map(p => `<li>${escapeHtml(p)}</li>`).join('');
  }

  // Render Dual-Grid Chart only when required to prevent costly re-rendering
  const shouldRedraw = forceRedraw ||
                       !termPremiumChartInstance ||
                       prevLatestTime !== data.current?.timestamp ||
                       prevSeriesLen !== data.series?.length;
  if (shouldRedraw) {
    renderTermPremiumChart();
  }
}

/**
 * Render Dual-Grid ECharts: Constant Maturity Basis & Multi-Span Spreads
 */
function renderTermPremiumChart() {
  if (!elTpEcharts || !currentTermPremiumData || !currentTermPremiumData.series) return;

  if (!termPremiumChartInstance) {
    termPremiumChartInstance = echarts.init(elTpEcharts, getEchartsTheme());
  }

  let rawSeries = currentTermPremiumData.series;
  if (!rawSeries || !rawSeries.length) return;

  const colors = getChartThemeColors();

  // Filter series by timeframe
  let sliced = rawSeries;
  if (currentTpTimeframe === '30') sliced = rawSeries.slice(-30);
  else if (currentTpTimeframe === '90') sliced = rawSeries.slice(-90);
  else if (currentTpTimeframe === '180') sliced = rawSeries.slice(-180);
  else if (currentTpTimeframe === '365') sliced = rawSeries.slice(-365);

  const dates = sliced.map(s => s.date);
  const apr30dData = sliced.map(s => s.apr30d);
  const hurdleData = sliced.map(() => 8.0);
  const tbillData = sliced.map(() => 4.5);
  const spread90d7dData = sliced.map(s => s.spread90d7d);
  const spread30d7dData = sliced.map(s => s.spread30d7d);
  const spread180d30dData = sliced.map(s => s.spread180d30d);

  const seriesList = [];

  // Top Grid Series: 30D Basis APR
  if (tpVisibleSeries.apr30d) {
    seriesList.push({
      id: 'top-apr30d',
      name: '30D 基差 APR',
      type: 'line',
      xAxisIndex: 0,
      yAxisIndex: 0,
      showSymbol: false,
      smooth: 0.2,
      data: apr30dData,
      lineStyle: { width: 2.2, color: '#f59e0b' },
      itemStyle: { color: '#f59e0b' },
      markArea: {
        silent: true,
        data: [
          [
            {
              yAxis: -15,
              itemStyle: { color: 'rgba(244, 63, 94, 0.04)' },
              label: {
                show: true,
                position: 'insideBottomRight',
                color: 'rgba(244, 63, 94, 0.65)',
                fontSize: 10,
                formatter: '机会成本劣势区 (<8.0%)'
              }
            },
            { yAxis: 8.0 }
          ],
          [
            {
              yAxis: 8.0,
              itemStyle: { color: 'rgba(16, 185, 129, 0.03)' },
              label: {
                show: true,
                position: 'insideTopRight',
                color: 'rgba(16, 185, 129, 0.65)',
                fontSize: 10,
                formatter: '结构性套利扩张区 (>8.0%)'
              }
            },
            { yAxis: 30 }
          ]
        ]
      }
    });
  }

  // Top Grid Series: 8.0% Institutional Hurdle Rate
  if (tpVisibleSeries.hurdle) {
    seriesList.push({
      id: 'top-hurdle',
      name: '8.0% 机构资本成本',
      type: 'line',
      xAxisIndex: 0,
      yAxisIndex: 0,
      showSymbol: false,
      data: hurdleData,
      lineStyle: { width: 1.8, color: '#ec4899', type: 'dashed' },
      itemStyle: { color: '#ec4899' }
    });
  }

  // Top Grid Series: 4.5% T-Bill Cost Line
  if (tpVisibleSeries.tbill) {
    seriesList.push({
      id: 'top-tbill',
      name: '4.5% 美债机会成本',
      type: 'line',
      xAxisIndex: 0,
      yAxisIndex: 0,
      showSymbol: false,
      data: tbillData,
      lineStyle: { width: 1.5, color: '#f43f5e', type: 'dotted' },
      itemStyle: { color: '#f43f5e' }
    });
  }

  // Top Grid Series: Optional Full Curve (7D, 60D, 90D, 180D)
  if (tpVisibleSeries.allCurves) {
    seriesList.push({
      id: 'top-apr7d',
      name: '7D 超短端 APR',
      type: 'line',
      xAxisIndex: 0,
      yAxisIndex: 0,
      showSymbol: false,
      data: sliced.map(s => s.apr7d),
      lineStyle: { width: 1.2, color: '#a1a1aa', type: 'dotted' },
      itemStyle: { color: '#a1a1aa' }
    });
    seriesList.push({
      id: 'top-apr60d',
      name: '60D 中期端 APR',
      type: 'line',
      xAxisIndex: 0,
      yAxisIndex: 0,
      showSymbol: false,
      data: sliced.map(s => s.apr60d),
      lineStyle: { width: 1.4, color: '#818cf8', type: 'dotted' },
      itemStyle: { color: '#818cf8' }
    });
    seriesList.push({
      id: 'top-apr90d',
      name: '90D 季度端 APR',
      type: 'line',
      xAxisIndex: 0,
      yAxisIndex: 0,
      showSymbol: false,
      data: sliced.map(s => s.apr90d),
      lineStyle: { width: 1.5, color: '#38bdf8' },
      itemStyle: { color: '#38bdf8' }
    });
    seriesList.push({
      id: 'top-apr180d',
      name: '180D 半年端 APR',
      type: 'line',
      xAxisIndex: 0,
      yAxisIndex: 0,
      showSymbol: false,
      data: sliced.map(s => s.apr180d),
      lineStyle: { width: 1.5, color: '#10b981' },
      itemStyle: { color: '#10b981' }
    });
  }

  // Bottom Grid Series: 90D - 7D Main Spread
  if (tpVisibleSeries.spread90d7d) {
    seriesList.push({
      id: 'bot-spread90d7d',
      name: '90D - 7D 主跨度',
      type: 'line',
      xAxisIndex: 1,
      yAxisIndex: 1,
      showSymbol: false,
      smooth: 0.15,
      data: spread90d7dData,
      lineStyle: { width: 2.0, color: '#38bdf8' },
      itemStyle: { color: '#38bdf8' },
      areaStyle: {
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: 'rgba(56, 189, 248, 0.18)' },
          { offset: 1, color: 'rgba(56, 189, 248, 0.0)' }
        ])
      },
      markLine: {
        silent: true,
        symbol: 'none',
        data: [
          {
            yAxis: 0,
            lineStyle: { color: 'rgba(255, 255, 255, 0.22)', type: 'dashed', width: 1 },
            label: { show: true, position: 'end', formatter: '平水线 (0%)', color: '#71717a', fontSize: 10 }
          }
        ]
      }
    });
  }

  // Bottom Grid Series: 30D - 7D Short-term Steepness
  if (tpVisibleSeries.spread30d7d) {
    seriesList.push({
      id: 'bot-spread30d7d',
      name: '30D - 7D 短端陡峭度',
      type: 'line',
      xAxisIndex: 1,
      yAxisIndex: 1,
      showSymbol: false,
      smooth: 0.15,
      data: spread30d7dData,
      lineStyle: { width: 1.8, color: '#a855f7' },
      itemStyle: { color: '#a855f7' }
    });
  }

  // Bottom Grid Series: 180D - 30D Long-term Slope
  if (tpVisibleSeries.spread180d30d) {
    seriesList.push({
      id: 'bot-spread180d30d',
      name: '180D - 30D 远端斜率',
      type: 'line',
      xAxisIndex: 1,
      yAxisIndex: 1,
      showSymbol: false,
      smooth: 0.15,
      data: spread180d30dData,
      lineStyle: { width: 1.8, color: '#10b981' },
      itemStyle: { color: '#10b981' }
    });
  }

  const option = {
    backgroundColor: 'transparent',
    animation: false,
    grid: [
      {
        left: '4%',
        right: '3%',
        top: '6%',
        height: '42%',
        containLabel: true
      },
      {
        left: '4%',
        right: '3%',
        top: '55%',
        height: '39%',
        containLabel: true
      }
    ],
    axisPointer: {
      link: [{ xAxisIndex: 'all' }],
      label: {
        backgroundColor: colors.axisPointerBg,
        fontFamily: 'JetBrains Mono',
        fontSize: 11
      }
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
      formatter: function (params) {
        if (!params || !params.length) return '';
        const date = params[0].name;
        let html = `<div style="font-weight:600;margin-bottom:6px;color:${colors.tooltipTitle};">${date}</div>`;

        // Top grid items
        const topItems = params.filter(p => p.seriesId && p.seriesId.startsWith('top-'));
        if (topItems.length) {
          html += `<div style="font-size:11px;color:${colors.textSecondary};margin-top:2px;border-bottom:1px solid ${colors.tooltipDivider};padding-bottom:2px;">常数期限基差率 (APR):</div>`;
          topItems.forEach(p => {
            html += `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin:2px 0;">
              <span style="color:${colors.textSecondary};"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};margin-right:6px;"></span>${p.seriesName}:</span>
              <span style="font-weight:700;color:${p.color};">${Number(p.value).toFixed(2)}%</span>
            </div>`;
          });
        }

        // Bottom grid items
        const botItems = params.filter(p => p.seriesId && p.seriesId.startsWith('bot-'));
        if (botItems.length) {
          html += `<div style="font-size:11px;color:${colors.textSecondary};margin-top:6px;border-bottom:1px solid ${colors.tooltipDivider};padding-bottom:2px;">期限溢价利差 (Spreads):</div>`;
          botItems.forEach(p => {
            const val = Number(p.value);
            const sign = val >= 0 ? '+' : '';
            const col = val >= 0 ? '#38bdf8' : '#f43f5e';
            html += `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin:2px 0;">
              <span style="color:${colors.textSecondary};"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};margin-right:6px;"></span>${p.seriesName}:</span>
              <span style="font-weight:700;color:${col};">${sign}${val.toFixed(2)}%</span>
            </div>`;
          });
        }

        return html;
      }
    },
    xAxis: [
      {
        type: 'category',
        gridIndex: 0,
        data: dates,
        boundaryGap: false,
        axisLine: { lineStyle: { color: colors.axisLine } },
        axisTick: { show: false },
        axisLabel: { show: false }
      },
      {
        type: 'category',
        gridIndex: 1,
        data: dates,
        boundaryGap: false,
        axisLine: { lineStyle: { color: colors.axisLine } },
        axisTick: { show: false },
        axisLabel: {
          color: colors.tickColor,
          fontFamily: 'JetBrains Mono',
          fontSize: 11,
          showMinLabel: true,
          showMaxLabel: true
        }
      }
    ],
    yAxis: [
      {
        type: 'value',
        gridIndex: 0,
        name: '基差 APR (%)',
        nameTextStyle: { color: colors.tickColor, fontSize: 11 },
        axisLabel: {
          color: colors.tickColor,
          fontFamily: 'JetBrains Mono',
          formatter: '{value}%'
        },
        splitLine: {
          lineStyle: { color: colors.splitLine }
        }
      },
      {
        type: 'value',
        gridIndex: 1,
        name: '期限利差 (%)',
        nameTextStyle: { color: colors.tickColor, fontSize: 11 },
        axisLabel: {
          color: colors.tickColor,
          fontFamily: 'JetBrains Mono',
          formatter: '{value}%'
        },
        splitLine: {
          lineStyle: { color: colors.splitLine }
        }
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
  // Timeframe selector
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

  // Toggle buttons helper
  function setupToggle(btn, key) {
    if (!btn) return;
    btn.addEventListener('click', () => {
      tpVisibleSeries[key] = !tpVisibleSeries[key];
      if (tpVisibleSeries[key]) {
        btn.classList.add('active');
        btn.classList.remove('inactive');
      } else {
        btn.classList.remove('active');
        btn.classList.add('inactive');
      }
      renderTermPremiumChart();
    });
  }

  setupToggle(btnToggleSpread90d7d, 'spread90d7d');
  setupToggle(btnToggleSpread30d7d, 'spread30d7d');
  setupToggle(btnToggleSpread180d30d, 'spread180d30d');
  setupToggle(btnToggleApr30d, 'apr30d');
  setupToggle(btnToggleHurdle, 'hurdle');
  setupToggle(btnToggleTbill, 'tbill');

  if (btnToggleAllCurves) {
    btnToggleAllCurves.addEventListener('click', () => {
      tpVisibleSeries.allCurves = !tpVisibleSeries.allCurves;
      if (tpVisibleSeries.allCurves) {
        btnToggleAllCurves.classList.add('active');
        btnToggleAllCurves.classList.remove('inactive');
        btnToggleAllCurves.querySelector('span:last-child').textContent = '收起常数曲线';
      } else {
        btnToggleAllCurves.classList.remove('active');
        btnToggleAllCurves.classList.remove('inactive');
        btnToggleAllCurves.querySelector('span:last-child').textContent = '展开全期限曲线';
      }
      renderTermPremiumChart();
    });
  }

  // Resize handler
  window.addEventListener('resize', () => {
    if (termPremiumChartInstance) termPremiumChartInstance.resize();
  });
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
  'view-ai-btc-tension': 'AI–BTC 融资张力指数与传导检验系统',
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

  // 8. Trigger chart resizes for freshly displayed views
  setTimeout(() => {
    if (macroChartInstance) {
      macroChartInstance.resize();
    } else if (rawMacroData && (viewId === 'view-overview' || viewId === 'view-all')) {
      renderMacroChart();
    }

    if (mcclellanOscillatorChartInstance) {
      mcclellanOscillatorChartInstance.resize();
    } else if (rawMcClellanData && (viewId === 'view-overview' || viewId === 'view-all')) {
      renderMcClellanCharts();
    }
    if (mcclellanSpreadChartInstance) {
      mcclellanSpreadChartInstance.resize();
    }

    if (cdriChartInstance) cdriChartInstance.resize();
    if (termPremiumChartInstance) termPremiumChartInstance.resize();

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

    if (viewId === 'view-ai-btc-tension' || viewId === 'view-all') {
      if (rawAiBtcTensionData) {
        renderAiBtcTensionCharts();
      } else {
        loadAiBtcTensionData(false);
      }
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
}

// ============================================================================
// Module 8: AI–BTC 融资张力指数与微观传导检验系统 (AI–BTC Tension Platform)
// ============================================================================

let rawAiBtcTensionData = null;
let chartPhaseSpaceInstance = null;
let chartTensionSeriesInstance = null;
let chartResidualSeriesInstance = null;
let chartEventCarInstance = null;
let isAiBtcTensionLoading = false;

/**
 * Fetch AI-BTC Tension Platform data from server
 */
async function loadAiBtcTensionData(force = false) {
  if (isAiBtcTensionLoading) return;
  isAiBtcTensionLoading = true;

  const btnRefresh = document.getElementById('btn-refresh-tension');
  if (btnRefresh) btnRefresh.classList.add('loading');

  try {
    const url = force ? '/api/ai-btc-tension?force=1' : '/api/ai-btc-tension';
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const resJson = await resp.json();

    if (resJson && resJson.code === 0) {
      rawAiBtcTensionData = resJson.data || resJson;
      renderAiBtcTensionDashboard(rawAiBtcTensionData);
      if (force) {
        const rStatus = resJson.refreshStatus || rawAiBtcTensionData.refresh_status;
        if (rStatus?.status === 'refreshed') {
          showToast('AI–BTC 融资张力模型与正交残差已由 Python 管线全量重新解算并更新！');
        } else if (rStatus?.status === 'pipelineUnavailable') {
          showToast('当前环境未检测到 Python 运行时，已载入已核验的最新快照数据');
        } else if (rStatus?.status === 'stale') {
          showToast('Python 管线运行异常，已回退至已验证的快照数据');
        } else {
          showToast('已更新 AI–BTC 张力基准快照数据');
        }
      }
    } else {
      throw new Error(resJson?.error || '返回数据格式不符合预期');
    }
  } catch (err) {
    console.error('[AiBtcTension] Load data failed:', err);
    showToast(`AI–BTC 张力数据载入失败: ${err.message}`);
  } finally {
    isAiBtcTensionLoading = false;
    if (btnRefresh) btnRefresh.classList.remove('loading');
  }
}

/**
 * Render all components of the AI-BTC Tension Platform
 */
function renderAiBtcTensionDashboard(data) {
  if (!data) return;

  const { current, regime_stats, regression, event_study, causality, miner_hpc_basket, trajectory_180d, series } = data;

  // 1. Benchmark date
  const elCalcDate = document.getElementById('tension-calc-date');
  if (elCalcDate && current?.date) {
    elCalcDate.textContent = current.date;
  }

  // 2. KPI Cards
  const elRegimeCode = document.getElementById('kpi-regime-code');
  const elRegimeName = document.getElementById('kpi-regime-name');
  const elRegimeDesc = document.getElementById('kpi-regime-desc');
  const regimeCard = document.querySelector('.kpi-regime-card');

  if (elRegimeCode) elRegimeCode.textContent = current.regime_code || 'Q1';
  if (elRegimeName) elRegimeName.textContent = current.regime_name || '--';
  if (elRegimeDesc) elRegimeDesc.textContent = current.regime_description || '--';

  if (regimeCard) {
    regimeCard.className = 'bento-card tension-kpi-card kpi-regime-card';
    if (current.regime_code) {
      regimeCard.classList.add(`regime-${current.regime_code.toLowerCase()}`);
    }
  }

  // Layer 1 P_AI
  const elPAi = document.getElementById('kpi-p-ai');
  const elPAiBar = document.getElementById('kpi-p-ai-bar');
  if (elPAi) {
    const sign = current.p_ai >= 0 ? '+' : '';
    elPAi.textContent = `${sign}${Number(current.p_ai).toFixed(2)} σ`;
    if (elPAiBar) {
      const pct = Math.max(5, Math.min(95, ((current.p_ai + 2.5) / 5) * 100));
      elPAiBar.style.width = `${pct}%`;
    }
  }

  // Layer 2 P_BTC
  const elPBtc = document.getElementById('kpi-p-btc');
  const elPBtcBar = document.getElementById('kpi-p-btc-bar');
  if (elPBtc) {
    const sign = current.p_btc >= 0 ? '+' : '';
    elPBtc.textContent = `${sign}${Number(current.p_btc).toFixed(2)} σ`;
    if (elPBtcBar) {
      const pct = Math.max(5, Math.min(95, ((current.p_btc + 2.5) / 5) * 100));
      elPBtcBar.style.width = `${pct}%`;
    }
  }

  // Macro Plumbing Indicators (Repo Spread & Term Premium)
  const elTensionR = document.getElementById('kpi-tension-r');
  const elRepoSpread = document.getElementById('kpi-repo-spread');
  const elTermPremium = document.getElementById('kpi-term-premium');
  if (elTensionR) {
    const repoVal = Number(current.repo_spread !== undefined ? current.repo_spread : 0.0);
    const sign = repoVal >= 0 ? '+' : '';
    elTensionR.textContent = `${sign}${repoVal.toFixed(2)}%`;
    if (elRepoSpread) elRepoSpread.textContent = `${sign}${repoVal.toFixed(2)}%`;
    if (elTermPremium && current.term_premium !== undefined) {
      elTermPremium.textContent = `${Number(current.term_premium).toFixed(2)}%`;
    }
  }

  // Macro R^2
  const elMacroR2 = document.getElementById('kpi-macro-r2');
  const elResidualPct = document.getElementById('kpi-macro-residual-pct');
  if (elMacroR2 && regression) {
    const r2Pct = (regression.r_squared * 100).toFixed(2);
    elMacroR2.textContent = `${r2Pct}%`;
    if (elResidualPct) {
      elResidualPct.textContent = `${(100 - parseFloat(r2Pct)).toFixed(2)}%`;
    }
  }

  // 3. Regime Statistics Breakdown
  if (regime_stats) {
    ['Q1', 'Q2', 'Q3', 'Q4'].forEach(q => {
      const stat = regime_stats[q];
      if (stat) {
        const elPct = document.getElementById(`pct-${q.toLowerCase()}`);
        const elFill = document.getElementById(`bar-fill-${q.toLowerCase()}`);
        if (elPct) elPct.textContent = `${stat.pct}% (${stat.count}天)`;
        if (elFill) elFill.style.width = `${stat.pct}%`;
      }
    });
  }

  // 4. Render All Charts if panel is currently active
  if (currentActiveView === 'view-ai-btc-tension' || currentActiveView === 'view-all') {
    renderAiBtcTensionCharts();
  }

  // 5. Populate Econometric Parameters Table
  const tbodyOls = document.getElementById('tbody-ols-params');
  if (tbodyOls && regression?.parameters) {
    tbodyOls.innerHTML = regression.parameters.map(p => {
      let stars = '';
      if (p.p_value < 0.001) stars = '***';
      else if (p.p_value < 0.01) stars = '**';
      else if (p.p_value < 0.05) stars = '*';

      const betaFormatted = Number(p.beta).toFixed(4);
      const betaClass = p.beta > 0 ? 'text-pos' : (p.beta < 0 ? 'text-neg' : '');

      return `
        <tr>
          <td><strong>${escapeHtml(p.name)}</strong> <span class="text-muted">(${escapeHtml(p.var)})</span></td>
          <td class="${betaClass}">${betaFormatted}</td>
          <td>${Number(p.t_stat).toFixed(2)}</td>
          <td>${Number(p.p_value).toFixed(4)} <strong class="text-highlight">${stars}</strong></td>
          <td class="text-secondary">${escapeHtml(p.role)}</td>
        </tr>
      `;
    }).join('');
  }

  // 6. Q2 Hypothesis Test Details
  if (regression?.q2_hypothesis_test) {
    const q2 = regression.q2_hypothesis_test;
    const elTStat = document.getElementById('hypo-t-stat');
    const elPVal = document.getElementById('hypo-p-val');
    const elStatus = document.getElementById('hypo-status');
    const elConclusion = document.getElementById('hypo-conclusion');

    if (elTStat) elTStat.textContent = Number(q2.t_stat).toFixed(2);
    if (elPVal) elPVal.textContent = Number(q2.p_value).toFixed(4);
    if (elStatus) {
      if (q2.is_significant_5pct) {
        elStatus.textContent = '显著支持 (p < 0.05)';
        elStatus.className = 'hypo-badge text-neg';
      } else {
        elStatus.textContent = '未显著支持单边挤压 (p > 0.05)';
        elStatus.className = 'hypo-badge';
      }
    }
    if (elConclusion && q2.conclusion) {
      elConclusion.textContent = q2.conclusion;
    }
  }

  // 7. Granger Causality Details
  if (causality) {
    const elGrangerPai = document.getElementById('granger-pai-res');
    const elGrangerRes = document.getElementById('granger-res-pai');
    const elFinding = document.getElementById('granger-finding-text');

    if (elGrangerPai) {
      const pAiLags = causality.p_ai_causes_residual || {};
      const l1 = pAiLags.lag_1;
      const l2 = pAiLags.lag_2;
      const star1 = l1 && l1.p_value < 0.05 ? '*' : '';
      const star2 = l2 && l2.p_value < 0.05 ? '*' : '';
      const s1 = l1 ? `L1: F=${Number(l1.f_stat).toFixed(2)}(p=${Number(l1.p_value).toFixed(2)}${star1})` : '';
      const s2 = l2 ? `L2: F=${Number(l2.f_stat).toFixed(2)}(p=${Number(l2.p_value).toFixed(2)}${star2})` : '';
      elGrangerPai.textContent = `${s1} • ${s2}`;
    }
    if (elGrangerRes) {
      const resLags = causality.residual_causes_p_ai || {};
      const l5 = resLags.lag_5;
      const l10 = resLags.lag_10;
      const star5 = l5 && l5.p_value < 0.05 ? '*' : '';
      const star10 = l10 && l10.p_value < 0.05 ? '*' : '';
      const s5 = l5 ? `L5: F=${Number(l5.f_stat).toFixed(2)}(p=${Number(l5.p_value).toFixed(2)}${star5})` : '';
      const s10 = l10 ? `L10: F=${Number(l10.f_stat).toFixed(2)}(p=${Number(l10.p_value).toFixed(2)}${star10})` : '';
      elGrangerRes.textContent = `${s5} • ${s10}`;
    }
    if (elFinding && causality.findings && causality.findings.length > 0) {
      elFinding.textContent = causality.findings.join(' ');
    }
  }

  // 8. Populate Miner-HPC Basket Table
  const tbodyMiner = document.getElementById('tbody-miner-hpc');
  if (tbodyMiner && miner_hpc_basket) {
    tbodyMiner.innerHTML = miner_hpc_basket.map(m => `
      <tr>
        <td><strong class="text-highlight">${escapeHtml(m.ticker)}</strong></td>
        <td><strong>${escapeHtml(m.name)}</strong></td>
        <td><span class="meta-pill" style="padding:2px 6px;">${escapeHtml(m.power_mw)}</span></td>
        <td><span class="meta-pill ${m.category && m.category.includes('HPC') ? 'text-pos' : 'text-secondary'}" style="padding:2px 6px;">${escapeHtml(m.category || 'Miner')}</span></td>
        <td class="text-secondary">${escapeHtml(m.partner_mode)}</td>
        <td class="text-muted">${escapeHtml(m.financing_channel)}</td>
      </tr>
    `).join('');
  }
}

/**
 * Render all 4 Chart.js charts for AI-BTC Tension Platform
 */
function renderAiBtcTensionCharts() {
  if (!rawAiBtcTensionData) return;
  const colors = getChartThemeColors();
  const { current, trajectory_180d, series, event_study } = rawAiBtcTensionData;

  // ----------------------------------------------------
  // Chart 1: 2D Phase Space Scatter & Trajectory Chart
  // ----------------------------------------------------
  const canvasPhase = document.getElementById('chart-phase-space');
  if (canvasPhase && window.Chart) {
    if (chartPhaseSpaceInstance) {
      chartPhaseSpaceInstance.destroy();
    }

    const traj = trajectory_180d || [];
    
    // Split points into regimes for coloring
    const q1Points = traj.filter(d => d.regime_code === 'Q1').map(d => ({ x: d.p_ai, y: d.p_btc, date: d.date }));
    const q2Points = traj.filter(d => d.regime_code === 'Q2').map(d => ({ x: d.p_ai, y: d.p_btc, date: d.date }));
    const q3Points = traj.filter(d => d.regime_code === 'Q3').map(d => ({ x: d.p_ai, y: d.p_btc, date: d.date }));
    const q4Points = traj.filter(d => d.regime_code === 'Q4').map(d => ({ x: d.p_ai, y: d.p_btc, date: d.date }));

    // Trajectory path line (last 60 days for clear trajectory tracking)
    const recentTraj = traj.slice(-60).map(d => ({ x: d.p_ai, y: d.p_btc }));

    chartPhaseSpaceInstance = new Chart(canvasPhase, {
      type: 'scatter',
      data: {
        datasets: [
          {
            label: '180日演化轨迹线',
            data: recentTraj,
            showLine: true,
            borderColor: 'rgba(99, 102, 241, 0.45)',
            borderWidth: 1.5,
            borderDash: [3, 3],
            pointRadius: 0,
            fill: false,
            order: 5
          },
          {
            label: 'Q1 共振繁荣',
            data: q1Points,
            backgroundColor: 'rgba(16, 185, 129, 0.7)',
            borderColor: '#10b981',
            pointRadius: 3,
            order: 4
          },
          {
            label: 'Q2 算力分化·配对套利',
            data: q2Points,
            backgroundColor: 'rgba(239, 68, 68, 0.75)',
            borderColor: '#ef4444',
            pointRadius: 3.5,
            order: 3
          },
          {
            label: 'Q3 去杠杆',
            data: q3Points,
            backgroundColor: 'rgba(245, 158, 11, 0.7)',
            borderColor: '#f59e0b',
            pointRadius: 3,
            order: 4
          },
          {
            label: 'Q4 宏观扩张',
            data: q4Points,
            backgroundColor: 'rgba(99, 102, 241, 0.7)',
            borderColor: '#6366f1',
            pointRadius: 3,
            order: 4
          },
          {
            label: '当前实时相空间锚点',
            data: [{ x: current.p_ai, y: current.p_btc }],
            backgroundColor: '#ffffff',
            borderColor: '#f43f5e',
            borderWidth: 3,
            pointRadius: 8,
            pointHoverRadius: 10,
            order: 1
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 400 },
        scales: {
          x: {
            title: {
              display: true,
              text: 'I_Compute / P_AI: 算力重估溢价指数 Z-Score (0 为中性, >0 为资本重估扩张)',
              color: colors.tickColor,
              font: { size: 11 }
            },
            grid: {
              color: ctx => ctx.tick.value === 0 ? colors.gridLineStrong : colors.gridLine,
              lineWidth: ctx => ctx.tick.value === 0 ? 1.5 : 1
            },
            ticks: { color: colors.tickColor, font: { family: 'JetBrains Mono', size: 10 } },
            suggestedMin: -2.5,
            suggestedMax: 2.5
          },
          y: {
            title: {
              display: true,
              text: 'I_Crypto / P_BTC: 加密外生流动性压力指数 Z-Score (0 为中性, >0 为流动性承压)',
              color: colors.tickColor,
              font: { size: 11 }
            },
            grid: {
              color: ctx => ctx.tick.value === 0 ? colors.gridLineStrong : colors.gridLine,
              lineWidth: ctx => ctx.tick.value === 0 ? 1.5 : 1
            },
            ticks: { color: colors.tickColor, font: { family: 'JetBrains Mono', size: 10 } },
            suggestedMin: -2.5,
            suggestedMax: 2.5
          }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: colors.tooltipBg,
            borderColor: colors.tooltipBorder,
            borderWidth: 1,
            titleColor: colors.tooltipTitle,
            bodyColor: colors.tooltipBody,
            titleFont: { family: 'JetBrains Mono' },
            bodyFont: { family: 'JetBrains Mono', size: 11 },
            callbacks: {
              label: ctx => {
                const pt = ctx.raw;
                const dStr = pt.date ? ` (${pt.date})` : '';
                return `${ctx.dataset.label}${dStr}: P_AI=${pt.x.toFixed(2)}, P_BTC=${pt.y.toFixed(2)}`;
              }
            }
          }
        }
      }
    });
  }

  // ----------------------------------------------------
  // Chart 2: Dual Layer Time Series (P_AI vs P_BTC & r)
  // ----------------------------------------------------
  const canvasTension = document.getElementById('chart-tension-series');
  if (canvasTension && window.Chart) {
    if (chartTensionSeriesInstance) {
      chartTensionSeriesInstance.destroy();
    }

    const displaySeries = (trajectory_180d && trajectory_180d.length > 0) ? trajectory_180d : (series || []).slice(-180);
    const labels = displaySeries.map(d => d.date);
    const dataPAi = displaySeries.map(d => d.p_ai);
    const dataPBtc = displaySeries.map(d => d.p_btc);
    const dataIntensity = displaySeries.map(d => d.tension_intensity);

    chartTensionSeriesInstance = new Chart(canvasTension, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: '算力重估指数 (I_Compute)',
            data: dataPAi,
            borderColor: '#38bdf8',
            borderWidth: 2,
            pointRadius: 0,
            pointHitRadius: 5,
            tension: 0.2
          },
          {
            label: '加密流动性压力 (I_Crypto)',
            data: dataPBtc,
            borderColor: '#f87171',
            borderWidth: 2,
            pointRadius: 0,
            pointHitRadius: 5,
            tension: 0.2
          },
          {
            label: '张力强度 (r)',
            data: dataIntensity,
            borderColor: 'rgba(168, 85, 247, 0.8)',
            borderWidth: 1.5,
            borderDash: [4, 4],
            backgroundColor: 'rgba(168, 85, 247, 0.08)',
            fill: true,
            pointRadius: 0,
            tension: 0.2
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 400 },
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: {
            grid: { color: colors.gridLine },
            ticks: {
              color: colors.tickColor,
              font: { family: 'JetBrains Mono', size: 10 },
              maxTicksLimit: 8
            }
          },
          y: {
            grid: {
              color: ctx => ctx.tick.value === 0 ? colors.gridLineStrong : colors.gridLine
            },
            ticks: {
              color: colors.tickColor,
              font: { family: 'JetBrains Mono', size: 10 }
            }
          }
        },
        plugins: {
          legend: {
            display: true,
            position: 'top',
            labels: { color: colors.textSecondary, boxWidth: 12, font: { size: 11 } }
          },
          tooltip: {
            backgroundColor: colors.tooltipBg,
            borderColor: colors.tooltipBorder,
            borderWidth: 1,
            titleColor: colors.tooltipTitle,
            bodyColor: colors.tooltipBody,
            titleFont: { family: 'JetBrains Mono' },
            bodyFont: { family: 'JetBrains Mono', size: 11 }
          }
        }
      }
    });
  }

  // ----------------------------------------------------
  // Chart 3: Macro Orthogonal Residual vs BTC Price
  // ----------------------------------------------------
  const canvasResidual = document.getElementById('chart-residual-series');
  if (canvasResidual && window.Chart) {
    if (chartResidualSeriesInstance) {
      chartResidualSeriesInstance.destroy();
    }

    const displaySeries = (trajectory_180d && trajectory_180d.length > 0) ? trajectory_180d : (series || []).slice(-180);
    const labels = displaySeries.map(d => d.date);
    const dataCumRes = displaySeries.map(d => (d.cum_residual * 100).toFixed(2));
    const dataBtcPrice = displaySeries.map(d => d.btc_close);

    chartResidualSeriesInstance = new Chart(canvasResidual, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: '宏观正交累计残差 Σε_BTC (%)',
            data: dataCumRes,
            borderColor: '#10b981',
            backgroundColor: 'rgba(16, 185, 129, 0.08)',
            fill: true,
            borderWidth: 2,
            pointRadius: 0,
            pointHitRadius: 5,
            yAxisID: 'yResidual',
            tension: 0.15
          },
          {
            label: 'BTC 现货收盘价 (USD)',
            data: dataBtcPrice,
            borderColor: '#fbbf24',
            borderWidth: 1.8,
            pointRadius: 0,
            pointHitRadius: 5,
            yAxisID: 'yPrice',
            tension: 0.15
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 400 },
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: {
            grid: { color: colors.gridLine },
            ticks: {
              color: colors.tickColor,
              font: { family: 'JetBrains Mono', size: 10 },
              maxTicksLimit: 8
            }
          },
          yResidual: {
            type: 'linear',
            position: 'left',
            grid: {
              color: ctx => ctx.tick.value === 0 ? (colors.isLight ? 'rgba(16, 185, 129, 0.4)' : 'rgba(16, 185, 129, 0.3)') : colors.gridLine
            },
            ticks: {
              color: colors.isLight ? '#059669' : '#34d399',
              font: { family: 'JetBrains Mono', size: 10 },
              callback: v => `${v}%`
            },
            title: { display: true, text: '正交特异 Alpha 累计 (%)', color: colors.isLight ? '#059669' : '#34d399', font: { size: 11 } }
          },
          yPrice: {
            type: 'linear',
            position: 'right',
            grid: { drawOnChartArea: false },
            ticks: {
              color: colors.isLight ? '#b45309' : '#fbbf24',
              font: { family: 'JetBrains Mono', size: 10 },
              callback: v => `$${Math.round(v).toLocaleString()}`
            },
            title: { display: true, text: 'BTC 价格 (USD)', color: colors.isLight ? '#b45309' : '#fbbf24', font: { size: 11 } }
          }
        },
        plugins: {
          legend: {
            display: true,
            position: 'top',
            labels: { color: colors.textSecondary, boxWidth: 12, font: { size: 11 } }
          },
          tooltip: {
            backgroundColor: colors.tooltipBg,
            borderColor: colors.tooltipBorder,
            borderWidth: 1,
            titleColor: colors.tooltipTitle,
            bodyColor: colors.tooltipBody,
            titleFont: { family: 'JetBrains Mono' },
            bodyFont: { family: 'JetBrains Mono', size: 11 }
          }
        }
      }
    });
  }

  // ----------------------------------------------------
  // Chart 4: Event Study Cumulative Abnormal Return (CAR)
  // ----------------------------------------------------
  const canvasEvent = document.getElementById('chart-event-car');
  if (canvasEvent && window.Chart && event_study) {
    if (chartEventCarInstance) {
      chartEventCarInstance.destroy();
    }

    const labels = event_study.map(e => `${e.ticker} (${e.event_date.slice(5)})`);
    const car1d = event_study.map(e => e.car_1d);
    const car5d = event_study.map(e => e.car_5d);
    const car20d = event_study.map(e => e.car_20d);

    chartEventCarInstance = new Chart(canvasEvent, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'CAR [-1, +1]',
            data: car1d,
            backgroundColor: 'rgba(56, 189, 248, 0.75)',
            borderColor: '#38bdf8',
            borderWidth: 1,
            borderRadius: 3
          },
          {
            label: 'CAR [-1, +5]',
            data: car5d,
            backgroundColor: 'rgba(129, 140, 248, 0.75)',
            borderColor: '#818cf8',
            borderWidth: 1,
            borderRadius: 3
          },
          {
            label: 'CAR [-1, +20]',
            data: car20d,
            backgroundColor: 'rgba(244, 63, 94, 0.75)',
            borderColor: '#f43f5e',
            borderWidth: 1,
            borderRadius: 3
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 400 },
        scales: {
          x: {
            grid: { color: colors.gridLine },
            ticks: {
              color: colors.tickColor,
              font: { family: 'JetBrains Mono', size: 9 },
              maxRotation: 45
            }
          },
          y: {
            grid: {
              color: ctx => ctx.tick.value === 0 ? colors.gridLineStrong : colors.gridLine
            },
            ticks: {
              color: colors.tickColor,
              font: { family: 'JetBrains Mono', size: 10 },
              callback: v => `${v}%`
            },
            title: { display: true, text: '超额异常收益 CAR (%)', color: colors.tickColor, font: { size: 10 } }
          }
        },
        plugins: {
          legend: {
            display: true,
            position: 'top',
            labels: { color: colors.textSecondary, boxWidth: 10, font: { size: 10 } }
          },
          tooltip: {
            backgroundColor: colors.tooltipBg,
            borderColor: colors.tooltipBorder,
            borderWidth: 1,
            titleColor: colors.tooltipTitle,
            bodyColor: colors.tooltipBody,
            titleFont: { family: 'JetBrains Mono' },
            bodyFont: { family: 'JetBrains Mono', size: 11 },
            callbacks: {
              afterBody: items => {
                const idx = items[0].dataIndex;
                const evt = event_study[idx];
                return evt ? `\n事件说明: ${evt.description}\n类型: ${evt.event_type}` : '';
              }
            }
          }
        }
      }
    });
  }
}

/**
 * Initialize AI-BTC Tension Platform Event Listeners
 */
function initAiBtcTensionEvents() {
  const btnRefresh = document.getElementById('btn-refresh-tension');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', () => loadAiBtcTensionData(true));
  }
}

// ============================================================================
// Module 1-B: Dual-Track Crypto McClellan Oscillator & Market Breadth
// ============================================================================

let rawMcClellanData = null;
let mcclellanOscillatorChartInstance = null;
let mcclellanSpreadChartInstance = null;
let isMcClellanLoading = false;
let mcclellanActiveTimeframe = '1y';

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
          showToast('双轨加密麦克莱伦宽度指标已由 Python 全量重新解算并更新！');
        } else if (rStatus?.status === 'pipelineUnavailable') {
          showToast('当前环境未检测到 Python 运行时，已载入已核验的最新快照数据');
        } else if (rStatus?.status === 'stale') {
          showToast('Python 管线运行异常，已回退至已验证的快照数据');
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
 * Render KPI cards and header badges for Crypto McClellan
 */
function renderMcClellanDashboard(data) {
  if (!data) return;

  const { current, metadata } = data;
  if (!current) return;

  // 1. Update time and Header Regime Pill
  const elUpdateTime = document.getElementById('mcclellan-update-time');
  if (elUpdateTime && current.date) {
    elUpdateTime.textContent = `${current.date} (UTC+8)`;
  }

  const elHeaderPill = document.getElementById('mcclellan-header-regime-pill');
  if (elHeaderPill) {
    elHeaderPill.textContent = current.regime_name || current.regime_code || '--';
    elHeaderPill.className = 'mcclellan-regime-pill';
    if (current.regime_code) {
      const cls = current.regime_code.toLowerCase().replace(/_/g, '-');
      elHeaderPill.classList.add(`regime-${cls}`);
    }
  }

  // 2. KPI 1: Regime
  const elRegime = document.getElementById('kpi-mcclellan-regime');
  const elRegimeSub = document.getElementById('kpi-mcclellan-regime-sub');
  if (elRegime) {
    elRegime.textContent = current.regime_name || '--';
    if (current.regime_code === 'CO_EXPANSION') elRegime.className = 'mm-val text-pos';
    else if (current.regime_code === 'MEME_SIPHON') elRegime.className = 'mm-val text-warn';
    else if (current.regime_code === 'QUALITY_ACCUMULATION') elRegime.className = 'mm-val text-info';
    else if (current.regime_code === 'DEEP_FREEZE') elRegime.className = 'mm-val text-neg';
  }
  if (elRegimeSub) {
    if (current.regime_code === 'CO_EXPANSION') elRegimeSub.textContent = '增量充沛 · 核心与投机共振走强';
    else if (current.regime_code === 'MEME_SIPHON') elRegimeSub.textContent = '存量极端博弈 · 警惕见顶流动性抽血';
    else if (current.regime_code === 'QUALITY_ACCUMULATION') elRegimeSub.textContent = '机构稳健吸筹 · 蓝筹主导去泡沫';
    else if (current.regime_code === 'DEEP_FREEZE') elRegimeSub.textContent = '全域流动性出清 · 熊市深度严冬筑底';
  }

  // 3. KPI 2: Core McClellan Oscillator
  const elCore = document.getElementById('kpi-mcclellan-core');
  const elCoreChip = document.getElementById('kpi-mcclellan-core-chip');
  if (elCore) {
    const coreVal = Number(current.core_oscillator);
    const sign = coreVal > 0 ? '+' : '';
    elCore.textContent = `${sign}${coreVal.toFixed(2)}`;
    elCore.className = coreVal >= 0 ? 'mm-val text-cyan' : 'mm-val text-neg';
  }
  if (elCoreChip) {
    const v = Number(current.core_oscillator);
    if (v >= 50) { elCoreChip.textContent = '极度超买'; elCoreChip.className = 'mm-chip text-warn'; }
    else if (v >= 20) { elCoreChip.textContent = '强势偏多'; elCoreChip.className = 'mm-chip text-pos'; }
    else if (v <= -50) { elCoreChip.textContent = '极度超卖'; elCoreChip.className = 'mm-chip text-neg'; }
    else if (v <= -20) { elCoreChip.textContent = '弱势偏空'; elCoreChip.className = 'mm-chip text-neg'; }
    else { elCoreChip.textContent = '中性震荡'; elCoreChip.className = 'mm-chip'; }
  }

  // 4. KPI 3: Frontier Meme McClellan Oscillator
  const elFrontier = document.getElementById('kpi-mcclellan-frontier');
  const elFrontierChip = document.getElementById('kpi-mcclellan-frontier-chip');
  if (elFrontier) {
    const fVal = Number(current.frontier_oscillator);
    const sign = fVal > 0 ? '+' : '';
    elFrontier.textContent = `${sign}${fVal.toFixed(2)}`;
    elFrontier.className = fVal >= 0 ? 'mm-val text-fuchsia' : 'mm-val text-neg';
  }
  if (elFrontierChip) {
    const v = Number(current.frontier_oscillator);
    if (v >= 50) { elFrontierChip.textContent = '链上高亢'; elFrontierChip.className = 'mm-chip text-fuchsia'; }
    else if (v >= 20) { elFrontierChip.textContent = '热度上升'; elFrontierChip.className = 'mm-chip text-pos'; }
    else if (v <= -50) { elFrontierChip.textContent = '深冻出清'; elFrontierChip.className = 'mm-chip text-neg'; }
    else { elFrontierChip.textContent = '常态流动'; elFrontierChip.className = 'mm-chip'; }
  }

  // 5. KPI 4: Liquidity Divergence Spread
  const elSpread = document.getElementById('kpi-mcclellan-spread');
  const elSpreadChip = document.getElementById('kpi-mcclellan-spread-chip');
  const elSpreadSub = document.getElementById('kpi-mcclellan-spread-sub');
  if (elSpread) {
    const sVal = Number(current.spread);
    const sign = sVal > 0 ? '+' : '';
    elSpread.textContent = `${sign}${sVal.toFixed(2)}`;
    elSpread.className = sVal >= 40 ? 'mm-val text-warn' : (sVal >= 0 ? 'mm-val text-amber' : 'mm-val text-cyan');
  }
  if (elSpreadChip) {
    const sVal = Number(current.spread);
    if (sVal >= 40 || current.spread_alert) {
      elSpreadChip.textContent = '抽血预警';
      elSpreadChip.className = 'mm-chip text-warn';
    } else if (sVal >= 20) {
      elSpreadChip.textContent = '投机发散';
      elSpreadChip.className = 'mm-chip text-amber';
    } else if (sVal <= -20) {
      elSpreadChip.textContent = '核心吸筹';
      elSpreadChip.className = 'mm-chip text-cyan';
    } else {
      elSpreadChip.textContent = '利差均衡';
      elSpreadChip.className = 'mm-chip';
    }
  }
  if (elSpreadSub) {
    const sVal = Number(current.spread);
    if (sVal >= 40 || current.spread_alert) {
      elSpreadSub.textContent = '⚠️ 警报: Meme利差超限，主流失血加剧';
    } else {
      elSpreadSub.textContent = 'Frontier - Core | 阈值 40 顶背离预警';
    }
  }

  // 6. KPI 5: Core MSI Summation Index
  const elMsi = document.getElementById('kpi-mcclellan-msi');
  if (elMsi) {
    const msiVal = Number(current.core_summation);
    const sign = msiVal > 0 ? '+' : '';
    elMsi.textContent = `${sign}${msiVal.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`;
    elMsi.className = msiVal >= 0 ? 'mm-val text-green' : 'mm-val text-neg';
  }

  // 7. Alert Banner
  const alertBanner = document.getElementById('mcclellan-alert-banner');
  if (alertBanner) {
    if (current.spread_alert || Number(current.spread) >= 40) {
      alertBanner.classList.remove('hidden');
    } else {
      alertBanner.classList.add('hidden');
    }
  }

  // 8. Render Charts
  renderMcClellanCharts();
}

/**
 * Filter series according to active timeframe and render Dual Charts
 */
function renderMcClellanCharts() {
  if (!rawMcClellanData || !rawMcClellanData.series) return;
  const colors = getChartThemeColors();
  const series = rawMcClellanData.series;

  let filteredSeries = series;
  if (mcclellanActiveTimeframe === '30d') {
    filteredSeries = series.slice(-30);
  } else if (mcclellanActiveTimeframe === '90d') {
    filteredSeries = series.slice(-90);
  } else if (mcclellanActiveTimeframe === '180d') {
    filteredSeries = series.slice(-180);
  } else if (mcclellanActiveTimeframe === '1y') {
    filteredSeries = series.slice(-365);
  }

  const labels = filteredSeries.map(d => d.date);
  const coreVals = filteredSeries.map(d => d.core_oscillator);
  const frontierVals = filteredSeries.map(d => d.frontier_oscillator);
  const spreadVals = filteredSeries.map(d => d.spread);
  const spreadMaVals = filteredSeries.map(d => d.spread_30d_ma);
  const btcVals = filteredSeries.map(d => d.btc_close);

  // ----------------------------------------------------
  // Chart 1: Dual Oscillators (Core vs Frontier vs BTC)
  // ----------------------------------------------------
  const canvasOsc = document.getElementById('chart-mcclellan-oscillator');
  if (canvasOsc && window.Chart) {
    if (mcclellanOscillatorChartInstance) {
      mcclellanOscillatorChartInstance.destroy();
    }

    mcclellanOscillatorChartInstance = new Chart(canvasOsc, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Core Top 100 Oscillator',
            data: coreVals,
            borderColor: '#00f2fe',
            backgroundColor: 'rgba(0, 242, 254, 0.08)',
            borderWidth: 1.8,
            tension: 0.2,
            pointRadius: 0,
            pointHoverRadius: 4,
            yAxisID: 'y'
          },
          {
            label: 'Frontier Meme Oscillator',
            data: frontierVals,
            borderColor: '#b537f2',
            backgroundColor: 'rgba(181, 55, 242, 0.05)',
            borderWidth: 1.8,
            tension: 0.2,
            pointRadius: 0,
            pointHoverRadius: 4,
            yAxisID: 'y'
          },
          {
            label: 'BTC 价格 (USD)',
            data: btcVals,
            borderColor: 'rgba(245, 158, 11, 0.55)',
            borderWidth: 1.2,
            borderDash: [3, 3],
            pointRadius: 0,
            yAxisID: 'yBtc'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        animation: { duration: 350 },
        scales: {
          x: {
            grid: { color: colors.gridLine },
            ticks: {
              color: colors.tickColor,
              font: { family: 'JetBrains Mono', size: 9 },
              maxRotation: 0,
              maxTicksLimit: 8
            }
          },
          y: {
            position: 'left',
            grid: {
              color: ctx => ctx.tick.value === 0 ? colors.gridLineStrong : (Math.abs(ctx.tick.value) === 50 ? (colors.isLight ? 'rgba(220, 38, 38, 0.4)' : 'rgba(239, 68, 68, 0.2)') : colors.gridLine)
            },
            ticks: {
              color: colors.tickColor,
              font: { family: 'JetBrains Mono', size: 9 },
              callback: v => `${v > 0 ? '+' : ''}${v}`
            },
            title: { display: true, text: '振荡器 (EMA19 - EMA39) * 1000', color: colors.tickColor, font: { size: 9 } }
          },
          yBtc: {
            position: 'right',
            grid: { display: false },
            ticks: {
              color: colors.isLight ? '#b45309' : '#d97706',
              font: { family: 'JetBrains Mono', size: 9 },
              callback: v => `$${Math.round(v / 1000)}k`
            },
            title: { display: true, text: 'BTC (USD)', color: colors.isLight ? '#b45309' : '#d97706', font: { size: 9 } }
          }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: colors.tooltipBg,
            borderColor: colors.tooltipBorder,
            borderWidth: 1,
            titleColor: colors.tooltipTitle,
            bodyColor: colors.tooltipBody,
            titleFont: { family: 'JetBrains Mono' },
            bodyFont: { family: 'JetBrains Mono', size: 11 },
            callbacks: {
              label: item => {
                const dsLabel = item.dataset.label || '';
                const val = item.raw;
                if (dsLabel.includes('BTC')) {
                  return ` ${dsLabel}: $${Number(val).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
                }
                const sign = val > 0 ? '+' : '';
                return ` ${dsLabel}: ${sign}${Number(val).toFixed(2)}`;
              }
            }
          }
        }
      }
    });
  }

  // ----------------------------------------------------
  // Chart 2: Liquidity Divergence Spread & Regimes Bar
  // ----------------------------------------------------
  const canvasSpread = document.getElementById('chart-mcclellan-spread');
  if (canvasSpread && window.Chart) {
    if (mcclellanSpreadChartInstance) {
      mcclellanSpreadChartInstance.destroy();
    }

    // Dynamic bar colors based on regime code
    const barColors = filteredSeries.map(d => {
      if (d.regime_code === 'CO_EXPANSION') return 'rgba(16, 185, 129, 0.8)';
      if (d.regime_code === 'MEME_SIPHON') return 'rgba(245, 158, 11, 0.8)';
      if (d.regime_code === 'QUALITY_ACCUMULATION') return 'rgba(6, 182, 212, 0.8)';
      return 'rgba(239, 68, 68, 0.8)';
    });

    mcclellanSpreadChartInstance = new Chart(canvasSpread, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            type: 'line',
            label: '30D 移动均线',
            data: spreadMaVals,
            borderColor: '#60a5fa',
            borderWidth: 1.8,
            pointRadius: 0,
            pointHoverRadius: 3,
            tension: 0.2,
            order: 1
          },
          {
            type: 'bar',
            label: '背离利差 (Frontier - Core)',
            data: spreadVals,
            backgroundColor: barColors,
            borderRadius: 2,
            order: 2
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        animation: { duration: 350 },
        scales: {
          x: {
            grid: { color: colors.gridLine },
            ticks: {
              color: colors.tickColor,
              font: { family: 'JetBrains Mono', size: 9 },
              maxRotation: 0,
              maxTicksLimit: 8
            }
          },
          y: {
            grid: {
              color: ctx => ctx.tick.value === 0 ? colors.gridLineStrong : (ctx.tick.value === 40 ? (colors.isLight ? 'rgba(217, 119, 6, 0.5)' : 'rgba(245, 158, 11, 0.4)') : colors.gridLine)
            },
            ticks: {
              color: colors.tickColor,
              font: { family: 'JetBrains Mono', size: 9 },
              callback: v => `${v > 0 ? '+' : ''}${v}`
            },
            title: { display: true, text: '背离利差 Spread (阈值: 40)', color: colors.tickColor, font: { size: 9 } }
          }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: colors.tooltipBg,
            borderColor: colors.tooltipBorder,
            borderWidth: 1,
            titleColor: colors.tooltipTitle,
            bodyColor: colors.tooltipBody,
            titleFont: { family: 'JetBrains Mono' },
            bodyFont: { family: 'JetBrains Mono', size: 11 },
            callbacks: {
              afterBody: items => {
                const idx = items[0].dataIndex;
                const point = filteredSeries[idx];
                if (!point) return '';
                const regMap = {
                  CO_EXPANSION: '全域共振繁荣 (Co-Expansion)',
                  MEME_SIPHON: 'Meme 流动性抽血 (Meme Siphon)',
                  QUALITY_ACCUMULATION: '核心价值蓄势 (Quality Accumulation)',
                  DEEP_FREEZE: '流动性严冬深冻 (Deep Freeze)'
                };
                const regName = regMap[point.regime_code] || point.regime_code;
                const alertText = point.spread >= 40 ? '\n⚠️ 达到 40 警戒线，抽血风险高' : '';
                return `\n当前体制: ${regName}${alertText}`;
              }
            }
          }
        }
      }
    });
  }
}

/**
 * Initialize event handlers for McClellan module
 */
function initMcClellanEvents() {
  const btnRefresh = document.getElementById('btn-refresh-mcclellan');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', () => loadMcClellanData(true));
  }

  // Timeframe selector
  const tfContainer = document.getElementById('mcclellan-timeframe-switch');
  if (tfContainer) {
    tfContainer.querySelectorAll('.switch-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        tfContainer.querySelectorAll('.switch-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        mcclellanActiveTimeframe = btn.dataset.range || '1y';
        renderMcClellanCharts();
      });
    });
  }

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
// Application Startup Initialization
// ============================================================================
initThemeController();
initMacroChartEvents();
initCdriEvents();
initTermPremiumEvents();
initSsroEvents();
initCoinbaseLiquidityEvents();
initGoldCorrelationEvents();
initAiBtcTensionEvents();
initMcClellanEvents();
initNavigation();
loadMarketData(false);
fetchSsroData(false);
fetchCoinbaseLiquidityData(false);
loadGoldCorrelationData(false);
loadAiBtcTensionData(false);
loadMcClellanData(false);
