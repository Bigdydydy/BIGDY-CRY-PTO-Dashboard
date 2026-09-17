/**
 * Frontend Application Controller for BIGDY Quantitative Dashboard
 * Includes Update Detection, Analysis Re-computation verification, and Greeks Modal
 */

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
    renderTermPremium(currentMarketData.termPremium);
  } else {
    loadTermPremiumData();
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
          <span class="gex-expiry">${exp.expiry}</span>
          <span class="gex-tag ${exp.isFocused ? 'tag-lead' : ''}">${exp.categoryTag}</span>
        </div>
        <div class="gex-details">
          <div class="gex-detail-row">
            <span class="gex-d-label">净 GEX 敞口:</span>
            <span class="gex-d-val ${gexColor}">${signStr}$${Math.abs(exp.totalGexM).toFixed(2)}M</span>
          </div>
          <div class="gex-detail-row">
            <span class="gex-d-label">Call Wall (阻力位):</span>
            <span class="gex-d-val text-pos">$${exp.callWall ? exp.callWall.toLocaleString() : '--'}</span>
          </div>
          <div class="gex-detail-row">
            <span class="gex-d-label">Put Wall (支撑位):</span>
            <span class="gex-d-val text-neg">$${exp.putWall ? exp.putWall.toLocaleString() : '--'}</span>
          </div>
          <div class="gex-detail-row">
            <span class="gex-d-label">覆盖行权价数:</span>
            <span class="gex-d-val">${exp.strikeCount} 个 Strikes</span>
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
  elSmileAtmIv.textContent = `${data.atmIv.toFixed(1)}%`;
  elSmileAtmStrike.textContent = `行权价: $${data.atmStrike?.toLocaleString()}`;

  elSmilePutWing.textContent = `+${data.putWingPremium.toFixed(1)}%`;
  elSmilePutSub.textContent = `行权价: $${data.lowestStrike?.toLocaleString()} (IV: ${data.lowestIv.toFixed(1)}%)`;

  elSmileCallWing.textContent = `+${data.callWingPremium.toFixed(1)}%`;
  elSmileCallSub.textContent = `行权价: $${data.highestStrike?.toLocaleString()} (IV: ${data.highestIv.toFixed(1)}%)`;

  const diff = data.asymmetryDiff || 0;
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
          <span class="sp-strike">$${(s.strike / 1000).toFixed(0)}k</span>
          <span class="sp-iv ${isAtm ? 'text-accent' : ''}">${s.iv.toFixed(1)}%</span>
          <span class="sp-delta">${isAtm ? 'ATM' : (s.delta !== null ? `Δ ${s.delta}` : '')}</span>
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
      elStoreText.innerHTML = `本地历史沉淀数据库：已累计安全归档 <strong>${s.totalStored.toLocaleString()}</strong> 笔大宗成交流水（沉淀区间: <strong>${s.earliestTimeUTC8}</strong> ~ <strong>${s.latestTimeUTC8}</strong> UTC+8，至多滚动保存 <strong>30 天</strong>，已突破官方 72h 上限）`;
    }
    if (elStoreSpanBadge) {
      elStoreSpanBadge.textContent = `已沉淀: ${s.historySpanDays} 天 / 30天`;
    }
  }

  // 1. Render Iceberg Clusters
  const clusters = data.icebergClusters || [];
  if (!clusters.length) {
    elClusterCardsContainer.innerHTML = '<div class="loading-placeholder">在当前门槛下未发现明显拆单聚合模式</div>';
  } else {
    let clusterHtml = '';
    clusters.forEach((c, idx) => {
      const isBuy = c.direction === 'buy';
      const dirClass = isBuy ? 'dir-buy' : 'dir-sell';
      const dirText = c.isMultiLeg ? (isBuy ? 'BULL 多头策略拆单' : 'BEAR 空头策略拆单') : (isBuy ? 'BUY 多头拆单' : 'SELL 空头拆单');

      clusterHtml += `
        <div class="cluster-card" onclick="openIcebergDetail(${idx})">
          <div class="cluster-info">
            <span class="cluster-dir-badge ${dirClass}">${dirText}</span>
            <div>
              <div class="cluster-inst">${c.instrument}</div>
              <div class="cluster-meta">时间窗: ${formatTimeWindowUTC8(c.startTimeUTC8 || c.startTime, c.endTimeUTC8 || c.endTime, c.durationMin)}</div>
            </div>
          </div>
          <div>
            <span class="intent-badge-pill ${c.intentBadgeClass || 'badge-neutral'}">${c.intentBadge || '意图解析'}</span>
            ${c.strategyNameZh ? `<div style="font-size:0.7rem;color:#a1a1aa;margin-top:4px;text-align:right;">${c.strategyNameZh}</div>` : ''}
          </div>
          <div class="cluster-stats">
            <div class="cluster-stat-item">
              <span class="stat-label">拆单笔数 / 块数</span>
              <span class="c-val">${c.splitCount} 笔 (${c.blockCount} 个 Block)</span>
            </div>
            <div class="cluster-stat-item">
              <span class="stat-label">累计张数</span>
              <span class="c-val text-accent">${c.totalContracts.toLocaleString()} BTC</span>
            </div>
            <div class="cluster-stat-item">
              <span class="stat-label">累计名义价值</span>
              <span class="c-val text-highlight">$${c.clusterNotionalM.toFixed(2)}M</span>
            </div>
          </div>
        </div>
      `;
    });
    elClusterCardsContainer.innerHTML = clusterHtml;
  }

  // 2. Render Single Whale Blocks Table & Mobile Cards
  const blocks = data.whaleBlocks || [];
  const elWhaleMobileCards = document.getElementById('whale-mobile-cards');
  if (!blocks.length) {
    elWhaleTableBody.innerHTML = '<tr><td colspan="8" class="text-center">在当前门槛下未检测到单笔巨鲸大单</td></tr>';
    if (elWhaleMobileCards) {
      elWhaleMobileCards.innerHTML = '<div style="text-align:center;padding:24px;color:#71717a;font-size:0.75rem;">在当前门槛下未检测到单笔巨鲸大单</div>';
    }
  } else {
    let tableHtml = '';
    let cardsHtml = '';
    blocks.forEach((b, idx) => {
      tableHtml += `
        <tr onclick="openWhaleDetail(${idx})">
          <td>${b.dateTimeUTC8 || b.dateTime || formatUTC8(b.timestamp)}</td>
          <td><span class="text-accent">${b.blockId}</span></td>
          <td>
            <span class="intent-badge-pill ${b.intentBadgeClass || 'badge-neutral'}">${b.intentBadge || '--'}</span>
            ${b.strategyNameZh ? `<div style="font-size:0.68rem;color:#a1a1aa;margin-top:3px;">${b.strategyNameZh}</div>` : ''}
          </td>
          <td><strong>$${b.notionalUSDM.toFixed(2)}M</strong></td>
          <td>${b.netDeltaBTC >= 0 ? '+' : ''}${b.netDeltaBTC.toFixed(1)} BTC</td>
          <td>${b.netVegaUSD >= 0 ? '+' : ''}$${Math.round(b.netVegaUSD).toLocaleString()}</td>
          <td>${b.legCount} 腿</td>
          <td><button class="action-btn" onclick="event.stopPropagation(); openWhaleDetail(${idx})">穿透解析</button></td>
        </tr>
      `;

      cardsHtml += `
        <div class="whale-mobile-card" onclick="openWhaleDetail(${idx})">
          <div class="wmc-header">
            <div class="wmc-id-group">
              <span class="wmc-id">${b.blockId}</span>
              <span class="wmc-time">${(b.dateTimeUTC8 || b.dateTime || '').slice(5, 16)}</span>
            </div>
            <span class="intent-badge-pill ${b.intentBadgeClass || 'badge-neutral'}">${b.intentBadge || '--'}</span>
          </div>
          <div class="wmc-strategy">${b.strategyNameZh || '机构定制结构'}</div>
          <div class="wmc-grid">
            <div class="wmc-stat">
              <span class="wmc-lbl">名义价值</span>
              <span class="wmc-val text-highlight">$${b.notionalUSDM.toFixed(1)}M</span>
            </div>
            <div class="wmc-stat">
              <span class="wmc-lbl">最大理论盈利</span>
              <span class="wmc-val text-accent">${b.riskProfile?.maxProfit || '--'}</span>
            </div>
            <div class="wmc-stat">
              <span class="wmc-lbl">净 Delta</span>
              <span class="wmc-val">${b.netDeltaBTC >= 0 ? '+' : ''}${b.netDeltaBTC.toFixed(1)} BTC</span>
            </div>
            <div class="wmc-stat">
              <span class="wmc-lbl">结构腿数</span>
              <span class="wmc-val">${b.legCount} 腿</span>
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

  if (mStrategyName) {
    mStrategyName.textContent = b.strategyNameZh || '机构定制结构';
  }
  if (mMaxProfit) mMaxProfit.textContent = b.riskProfile?.maxProfit || '--';
  if (mMaxLoss) mMaxLoss.textContent = b.riskProfile?.maxLoss || '--';
  if (mBreakEven) mBreakEven.textContent = b.riskProfile?.breakEven || '--';

  if (mPointersList) {
    const pointers = b.theoreticalPointers || [];
    if (pointers.length) {
      mPointersList.innerHTML = pointers.map(p => `<li>${p}</li>`).join('');
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
        <td class="${dirClass}"><strong>${leg.direction.toUpperCase()}</strong></td>
        <td><strong>${leg.instrument}</strong></td>
        <td>${leg.amount} BTC</td>
        <td>${leg.price}</td>
        <td>${leg.iv ? leg.iv.toFixed(1) + '%' : '--'}</td>
        <td>${leg.delta >= 0 ? '+' : ''}${leg.delta.toFixed(2)}</td>
        <td>${leg.vegaUSD >= 0 ? '+' : ''}$${Math.round(leg.vegaUSD).toLocaleString()}</td>
        <td>${leg.thetaUSD >= 0 ? '+' : ''}$${Math.round(leg.thetaUSD).toLocaleString()}</td>
        <td>$${leg.notionalM.toFixed(2)}M</td>
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
      mPointersList.innerHTML = pointers.map(p => `<li>${p}</li>`).join('');
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
          <td class="${legClass}"><strong>${l.direction.toUpperCase()}</strong></td>
          <td><strong>${l.instrument}</strong></td>
          <td>${l.amount} BTC</td>
          <td>均价: ${(l.price || 0).toFixed(4)}</td>
          <td>${l.iv ? l.iv.toFixed(1) + '%' : '--'}</td>
          <td>${(l.delta || 0) >= 0 ? '+' : ''}${(l.delta || 0).toFixed(2)}</td>
          <td>${(l.vegaUSD || 0) >= 0 ? '+' : ''}$${Math.round(l.vegaUSD || 0).toLocaleString()}</td>
          <td>${(l.thetaUSD || 0) >= 0 ? '+' : ''}$${Math.round(l.thetaUSD || 0).toLocaleString()}</td>
          <td>$${(l.notionalM || 0).toFixed(2)}M</td>
        </tr>
      `;
    }).join('');
  } else {
    const isBuy = c.direction === 'buy';
    const dirClass = isBuy ? 'text-pos' : 'text-neg';
    mLegsBody.innerHTML = `
      <tr>
        <td class="${dirClass}"><strong>${c.direction.toUpperCase()}</strong></td>
        <td><strong>${c.instrument}</strong> (合成累计)</td>
        <td>${c.totalContracts} BTC</td>
        <td>均价: ${(c.avgPrice || 0).toFixed(4)}</td>
        <td>--</td>
        <td>${c.netDeltaBTC >= 0 ? '+' : ''}${c.netDeltaBTC.toFixed(2)}</td>
        <td>${c.netVegaUSD >= 0 ? '+' : ''}$${Math.round(c.netVegaUSD).toLocaleString()}</td>
        <td>${c.netThetaUSD >= 0 ? '+' : ''}$${Math.round(c.netThetaUSD).toLocaleString()}</td>
        <td>$${c.clusterNotionalM.toFixed(2)}M</td>
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
  loadMarketData(false);
});

if (timeRangeSelect) {
  timeRangeSelect.addEventListener('change', () => {
    loadMarketData(false);
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
            backgroundColor: 'rgba(18, 18, 24, 0.94)',
            borderColor: 'rgba(255, 255, 255, 0.12)',
            borderWidth: 1,
            titleColor: '#fafafa',
            titleFont: { family: 'JetBrains Mono', size: 12, weight: '600' },
            bodyColor: '#e4e4e7',
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
              color: 'rgba(255, 255, 255, 0.04)',
              borderColor: 'rgba(255, 255, 255, 0.08)'
            },
            ticks: {
              color: '#71717a',
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
              color: 'rgba(255, 255, 255, 0.04)',
              borderColor: 'rgba(255, 255, 255, 0.08)'
            },
            ticks: {
              color: '#fbbf24',
              font: { family: 'JetBrains Mono', size: 10 },
              callback: function(v) {
                if (v >= 1000) return '$' + Math.round(v / 1000) + 'k';
                return '$' + v;
              }
            },
            title: {
              display: true,
              text: 'BTC & MSTR Cost (USD)',
              color: '#fbbf24',
              font: { family: 'Inter', size: 10, weight: '500' }
            }
          },
          yYield: {
            type: 'linear',
            position: 'right',
            grid: {
              drawOnChartArea: false,
              borderColor: 'rgba(255, 255, 255, 0.08)'
            },
            ticks: {
              color: '#38bdf8',
              font: { family: 'JetBrains Mono', size: 10 },
              callback: function(v) {
                return v.toFixed(1) + '%';
              }
            },
            title: {
              display: true,
              text: '美债利率与利差 (%)',
              color: '#38bdf8',
              font: { family: 'Inter', size: 10, weight: '500' }
            }
          },
          yVelocity: {
            type: 'linear',
            position: 'right',
            grid: {
              drawOnChartArea: false,
              borderColor: 'rgba(236, 72, 153, 0.15)'
            },
            ticks: {
              color: '#f472b6',
              font: { family: 'JetBrains Mono', size: 10 },
              callback: function(v) {
                if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
                return v;
              }
            },
            title: {
              display: true,
              text: 'MSTR 速度 (BTC/天)',
              color: '#f472b6',
              font: { family: 'Inter', size: 10, weight: '500' }
            },
            suggestedMin: 0
          },
          yMNAV: {
            type: 'linear',
            position: 'right',
            grid: {
              drawOnChartArea: false,
              borderColor: 'rgba(99, 102, 241, 0.18)'
            },
            ticks: {
              color: '#818cf8',
              font: { family: 'JetBrains Mono', size: 10 },
              callback: function(v) {
                return v.toFixed(1) + '×';
              }
            },
            title: {
              display: true,
              text: 'MSTR mNAV (倍数)',
              color: '#818cf8',
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
              borderColor: 'rgba(59, 130, 246, 0.18)'
            },
            ticks: {
              color: '#60a5fa',
              font: { family: 'JetBrains Mono', size: 10 },
              callback: function(v) {
                return '$' + v.toFixed(1) + 'T';
              }
            },
            title: {
              display: true,
              text: 'Fed 净流动性 ($T)',
              color: '#60a5fa',
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
  return `<span class="cdri-num-pill" style="color:${info.color}; background:${info.bg}; border:1px solid ${info.border};">${score} ${info.level}</span>`;
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
    cdriChartInstance = echarts.init(elCdriEcharts, null, { renderer: 'canvas' });
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => {
        if (cdriChartInstance) cdriChartInstance.resize();
      });
      ro.observe(elCdriEcharts);
    }
  }

  const { dates, values, prices } = getFilteredCdriPoints();
  if (!dates.length) return;

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
      backgroundColor: 'rgba(18, 18, 24, 0.94)',
      borderColor: 'rgba(255, 255, 255, 0.12)',
      borderWidth: 1,
      padding: [10, 14],
      textStyle: {
        color: '#e4e4e7',
        fontFamily: 'JetBrains Mono',
        fontSize: 12
      },
      formatter: function(params) {
        if (!params || !params.length) return '';
        const date = params[0].name;
        let html = `<div style="font-weight:600;margin-bottom:6px;color:#fafafa;">${date} (UTC+8)</div>`;
        params.forEach(p => {
          if (p.seriesName === 'CDRI') {
            const val = p.value;
            let tier = '低风险';
            let col = '#22ab94';
            if (val > 80) { tier = '极端风险'; col = '#f23645'; }
            else if (val > 60) { tier = '高风险'; col = '#ffc800'; }
            else if (val > 30) { tier = '中性波动'; col = '#93ea2a'; }
            html += `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin:3px 0;">
              <span style="color:#a1a1aa;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${col};margin-right:6px;"></span>CDRI 风险指数:</span>
              <span style="font-weight:700;color:${col};">${val} (${tier})</span>
            </div>`;
          } else if (p.seriesName === 'BTC 现货') {
            html += `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin:3px 0;">
              <span style="color:#a1a1aa;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#38bdf8;margin-right:6px;"></span>BTC 现货价格:</span>
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
      axisLine: { lineStyle: { color: 'rgba(255, 255, 255, 0.08)' } },
      axisTick: { show: false },
      axisLabel: {
        color: '#71717a',
        fontFamily: 'JetBrains Mono',
        fontSize: 11
      }
    },
    yAxis: [
      {
        type: 'value',
        name: 'CDRI 指数',
        nameTextStyle: { color: '#71717a', fontSize: 11 },
        min: 0,
        max: 100,
        interval: 20,
        axisLabel: {
          color: '#71717a',
          fontFamily: 'JetBrains Mono',
          formatter: '{value}'
        },
        splitLine: {
          lineStyle: {
            color: 'rgba(255, 255, 255, 0.04)'
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
  tbill: true,
  allCurves: false
};

// DOM Elements
const elTpHeaderRegimePill = document.getElementById('tp-header-regime-pill');
const elTpHeaderScorePill = document.getElementById('tp-header-score-pill');
const elTpHeaderExcessPill = document.getElementById('tp-header-excess-pill');
const elTpUpdateTime = document.getElementById('tp-update-time');

const elTpVal7d = document.getElementById('tp-val-7d');
const elTpVal30d = document.getElementById('tp-val-30d');
const elTpVal90d = document.getElementById('tp-val-90d');
const elTpVal180d = document.getElementById('tp-val-180d');

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
function renderTermPremium(data) {
  if (!data) return;
  currentTermPremiumData = data;

  const c = data.current;
  const reg = data.regime || {};

  // Header pills
  if (elTpHeaderRegimePill && reg.regimeName) {
    elTpHeaderRegimePill.textContent = reg.regimeName.split(' ')[0] || '升水结构';
    if (reg.regimeBadgeClass) {
      elTpHeaderRegimePill.className = `tp-regime-pill ${reg.regimeBadgeClass}`;
    }
  }
  if (elTpHeaderScorePill && c && c.carryScore !== undefined) {
    elTpHeaderScorePill.textContent = `Carry: ${c.carryScore >= 0 ? '+' : ''}${c.carryScore.toFixed(1)}`;
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
    if (elTpVal90d) {
      elTpVal90d.textContent = `${c.apr90d >= 0 ? '+' : ''}${c.apr90d.toFixed(2)}%`;
      elTpVal90d.style.color = c.apr90d >= 0 ? '#38bdf8' : '#f43f5e';
    }
    if (elTpVal180d) {
      elTpVal180d.textContent = `${c.apr180d >= 0 ? '+' : ''}${c.apr180d.toFixed(2)}%`;
      elTpVal180d.style.color = c.apr180d >= 0 ? '#10b981' : '#f43f5e';
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
      if (c.carryScore > 15) elTpScoreValue.style.color = '#10b981';
      else if (c.carryScore > 5) elTpScoreValue.style.color = '#f59e0b';
      else elTpScoreValue.style.color = '#f43f5e';
    }
    if (elTpExcessVal && c.excessReturn !== undefined) {
      elTpExcessVal.textContent = `${c.excessReturn >= 0 ? '+' : ''}${c.excessReturn.toFixed(2)}%`;
      elTpExcessVal.style.color = c.excessReturn >= 0 ? '#10b981' : '#f43f5e';
    }
    if (elTpScoreBarFill && c.carryScore !== undefined) {
      const pct = Math.max(5, Math.min(95, ((c.carryScore + 10) / 40) * 100));
      elTpScoreBarFill.style.width = `${pct}%`;
    }
  }

  // 4. Institutional Insights
  if (elTpInsightsSummary && reg.statusSummary) {
    elTpInsightsSummary.textContent = reg.statusSummary;
  }
  if (elTpInsightsList && reg.keyPointers) {
    elTpInsightsList.innerHTML = reg.keyPointers.map(p => `<li>${p}</li>`).join('');
  }

  // Render Dual-Grid Chart
  renderTermPremiumChart();
}

/**
 * Render Dual-Grid ECharts: Constant Maturity Basis & Multi-Span Spreads
 */
function renderTermPremiumChart() {
  if (!elTpEcharts || !currentTermPremiumData || !currentTermPremiumData.series) return;

  if (!termPremiumChartInstance) {
    termPremiumChartInstance = echarts.init(elTpEcharts, 'dark');
  }

  let rawSeries = currentTermPremiumData.series;
  if (!rawSeries || !rawSeries.length) return;

  // Filter series by timeframe
  let sliced = rawSeries;
  if (currentTpTimeframe === '30') sliced = rawSeries.slice(-30);
  else if (currentTpTimeframe === '90') sliced = rawSeries.slice(-90);
  else if (currentTpTimeframe === '180') sliced = rawSeries.slice(-180);
  else if (currentTpTimeframe === '365') sliced = rawSeries.slice(-365);

  const dates = sliced.map(s => s.date);
  const apr30dData = sliced.map(s => s.apr30d);
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
        data: [[
          {
            yAxis: -15,
            itemStyle: { color: 'rgba(244, 63, 94, 0.05)' },
            label: {
              show: true,
              position: 'insideBottomRight',
              color: 'rgba(244, 63, 94, 0.65)',
              fontSize: 10,
              formatter: '美债机会成本劣势区 (<5%)'
            }
          },
          { yAxis: 5.0 }
        ]]
      }
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
      lineStyle: { width: 1.8, color: '#f43f5e', type: 'dashed' },
      itemStyle: { color: '#f43f5e' }
    });
  }

  // Top Grid Series: Optional Full Curve (7D, 90D, 180D)
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
        backgroundColor: '#27272a',
        fontFamily: 'JetBrains Mono',
        fontSize: 11
      }
    },
    tooltip: {
      trigger: 'axis',
      confine: true,
      backgroundColor: 'rgba(18, 18, 24, 0.94)',
      borderColor: 'rgba(255, 255, 255, 0.12)',
      borderWidth: 1,
      padding: [10, 14],
      textStyle: {
        color: '#e4e4e7',
        fontFamily: 'JetBrains Mono',
        fontSize: 12
      },
      formatter: function (params) {
        if (!params || !params.length) return '';
        const date = params[0].name;
        let html = `<div style="font-weight:600;margin-bottom:6px;color:#fafafa;">${date}</div>`;

        // Top grid items
        const topItems = params.filter(p => p.seriesId && p.seriesId.startsWith('top-'));
        if (topItems.length) {
          html += `<div style="font-size:11px;color:#a1a1aa;margin-top:2px;border-bottom:1px solid rgba(255,255,255,0.08);padding-bottom:2px;">常数期限基差率 (APR):</div>`;
          topItems.forEach(p => {
            html += `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin:2px 0;">
              <span style="color:#a1a1aa;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};margin-right:6px;"></span>${p.seriesName}:</span>
              <span style="font-weight:700;color:${p.color};">${Number(p.value).toFixed(2)}%</span>
            </div>`;
          });
        }

        // Bottom grid items
        const botItems = params.filter(p => p.seriesId && p.seriesId.startsWith('bot-'));
        if (botItems.length) {
          html += `<div style="font-size:11px;color:#a1a1aa;margin-top:6px;border-bottom:1px solid rgba(255,255,255,0.08);padding-bottom:2px;">期限溢价利差 (Spreads):</div>`;
          botItems.forEach(p => {
            const val = Number(p.value);
            const sign = val >= 0 ? '+' : '';
            const col = val >= 0 ? '#38bdf8' : '#f43f5e';
            html += `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin:2px 0;">
              <span style="color:#a1a1aa;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};margin-right:6px;"></span>${p.seriesName}:</span>
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
        axisLine: { lineStyle: { color: 'rgba(255, 255, 255, 0.08)' } },
        axisTick: { show: false },
        axisLabel: { show: false }
      },
      {
        type: 'category',
        gridIndex: 1,
        data: dates,
        boundaryGap: false,
        axisLine: { lineStyle: { color: 'rgba(255, 255, 255, 0.08)' } },
        axisTick: { show: false },
        axisLabel: {
          color: '#71717a',
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
        nameTextStyle: { color: '#71717a', fontSize: 11 },
        axisLabel: {
          color: '#71717a',
          fontFamily: 'JetBrains Mono',
          formatter: '{value}%'
        },
        splitLine: {
          lineStyle: { color: 'rgba(255, 255, 255, 0.04)' }
        }
      },
      {
        type: 'value',
        gridIndex: 1,
        name: '期限利差 (%)',
        nameTextStyle: { color: '#71717a', fontSize: 11 },
        axisLabel: {
          color: '#71717a',
          fontFamily: 'JetBrains Mono',
          formatter: '{value}%'
        },
        splitLine: {
          lineStyle: { color: 'rgba(255, 255, 255, 0.04)' }
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
    ssroChartInstance = echarts.init(dom, 'dark');
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

  const option = {
    backgroundColor: 'transparent',
    animation: true,
    animationDuration: 400,
    tooltip: {
      trigger: 'axis',
      axisPointer: {
        type: 'cross',
        crossStyle: { color: '#64748b' },
        lineStyle: { color: '#475569', type: 'dashed' }
      },
      backgroundColor: 'rgba(15, 23, 42, 0.95)',
      borderColor: 'rgba(56, 189, 248, 0.3)',
      borderWidth: 1,
      textStyle: { color: '#f8fafc', fontSize: 12 },
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
          <div style="font-weight:700; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom:4px; margin-bottom:6px; color:#94a3b8;">
            📅 ${pt.date}
          </div>
          <div style="display:flex; justify-content:space-between; gap:16px; margin-bottom:4px;">
            <span style="color:#f59e0b;">🪙 BTC 现货价格:</span>
            <strong style="color:#f8fafc;">$${Math.round(pt.btcPrice).toLocaleString()}</strong>
          </div>
          <div style="display:flex; justify-content:space-between; gap:16px; margin-bottom:4px;">
            <span style="color:#38bdf8;">💵 稳定币市值 (STABLE.C):</span>
            <strong style="color:#f8fafc;">$${(pt.stableCap / 1e9).toFixed(2)}B</strong>
          </div>
          <div style="display:flex; justify-content:space-between; gap:16px; margin-bottom:4px;">
            <span style="color:#a855f7;">📊 原始 SSR (BTC/STABLE):</span>
            <strong style="color:#e2e8f0;">${pt.ssr?.toFixed(3) || '--'}</strong>
          </div>
          <div style="display:flex; justify-content:space-between; gap:16px; margin-bottom:4px;">
            <span style="color:${zoneColor};">⚡ SSRO Z-Score (len=${ssroLen}):</span>
            <strong style="color:${zoneColor};">${zVal !== null ? (zVal > 0 ? '+' : '') + zVal.toFixed(2) + 'σ' : '--'}</strong>
          </div>
          <div style="display:flex; justify-content:space-between; gap:16px; padding-top:4px; border-top:1px dashed rgba(255,255,255,0.1);">
            <span style="color:#94a3b8;">🎯 流动性研判:</span>
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
        axisLine: { lineStyle: { color: 'rgba(255, 255, 255, 0.1)' } },
        axisLabel: { show: false },
        axisTick: { show: false }
      },
      {
        type: 'category',
        gridIndex: 1,
        data: dates,
        axisLine: { lineStyle: { color: 'rgba(255, 255, 255, 0.15)' } },
        axisLabel: { color: '#94a3b8', fontSize: 11 },
        axisTick: { alignWithLabel: true }
      }
    ],
    yAxis: [
      {
        type: 'value',
        gridIndex: 0,
        scale: true,
        axisLine: { show: false },
        splitLine: { lineStyle: { color: 'rgba(255, 255, 255, 0.05)' } },
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
        splitLine: { lineStyle: { color: 'rgba(255, 255, 255, 0.05)' } },
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
    if (pyr.ratio100_10 >= 6.0) {
      elCbPyrEvalText.innerHTML = `⚠️ <strong>近端薄弱，防线下移</strong>：100bp/10bp 比率达 <strong>${pyr.ratio100_10}x</strong>（显著偏离 3.1x 基准），做市商挂单大幅后撤至远端，即时缓冲层相对中空。`;
    } else {
      elCbPyrEvalText.innerHTML = `🟢 <strong>金字塔结构稳健</strong>：阶梯倍数维持在 <strong>${pyr.ratio100_10}x</strong>（贴合 3.1x 理论中枢），具备良好的逐级缓冲吸收能力。`;
    }
  }

  // 3. Multi-tier Depth Table
  if (elCbDepthTableBody && data.depthProfile) {
    const tiers = [5, 10, 20, 50, 100, 200];
    let html = '';
    tiers.forEach(t => {
      const item = data.depthProfile[t];
      if (!item) return;
      const bidClass = item.bidPct >= 50 ? 'text-pos' : 'text-neg';
      html += `<tr>
        <td style="font-weight:600; color:#fafafa;">${item.label}</td>
        <td style="color:#10b981;">$${item.bidUsdM}M <span style="color:#71717a; font-size:10px;">(${item.bidBtc} ₿)</span></td>
        <td style="color:#f43f5e;">$${item.askUsdM}M <span style="color:#71717a; font-size:10px;">(${item.askBtc} ₿)</span></td>
        <td class="${bidClass}" style="font-weight:700;">${item.bidPct}%</td>
      </tr>`;
    });
    elCbDepthTableBody.innerHTML = html;
  }

  // 4. Institutional Insights List
  if (elCbInsightsList && Array.isArray(data.insights)) {
    elCbInsightsList.innerHTML = data.insights.map(str => `<li>${str}</li>`).join('');
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
    cbDepthChartInstance = echarts.init(elCbDepthEcharts, 'dark');
  }

  const tiers = [5, 10, 20, 50, 100, 200];
  const categories = tiers.map(t => `±${t} bps`);
  const bidUsdVals = tiers.map(t => -(data.depthProfile[t].bidUsdM || 0)); // negative for left bar
  const askUsdVals = tiers.map(t => (data.depthProfile[t].askUsdM || 0));   // positive for right bar

  const option = {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      backgroundColor: 'rgba(18, 18, 24, 0.94)',
      borderColor: 'rgba(255, 255, 255, 0.12)',
      textStyle: { color: '#e4e4e7', fontFamily: 'JetBrains Mono', fontSize: 12 },
      formatter: function(params) {
        if (!params || !params.length) return '';
        const tierName = params[0].name;
        const tierNum = parseInt(tierName.replace(/[^0-9]/g, ''), 10) || 5;
        const item = data.depthProfile[tierNum] || {};
        return `<div style="font-weight:700;margin-bottom:6px;color:#fafafa;">Coinbase 深度切片: ${tierName}</div>
          <div style="display:flex;justify-content:space-between;gap:16px;margin:2px 0;">
            <span style="color:#10b981;">🟢 买单深度 (Bid):</span>
            <span style="font-weight:700;color:#10b981;">$${item.bidUsdM}M (${item.bidBtc} ₿)</span>
          </div>
          <div style="display:flex;justify-content:space-between;gap:16px;margin:2px 0;">
            <span style="color:#f43f5e;">🔴 卖单深度 (Ask):</span>
            <span style="font-weight:700;color:#f43f5e;">$${item.askUsdM}M (${item.askBtc} ₿)</span>
          </div>
          <div style="display:flex;justify-content:space-between;gap:16px;margin:4px 0 0 0;padding-top:4px;border-top:1px solid rgba(255,255,255,0.08);">
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
        nameTextStyle: { color: '#71717a', fontSize: 11 },
        axisLabel: {
          color: '#71717a',
          fontFamily: 'JetBrains Mono',
          fontSize: 10,
          formatter: function(val) {
            return Math.abs(val) + 'M';
          }
        },
        splitLine: { lineStyle: { color: 'rgba(255, 255, 255, 0.05)' } }
      }
    ],
    yAxis: {
      type: 'category',
      data: categories,
      axisLine: { lineStyle: { color: 'rgba(255, 255, 255, 0.1)' } },
      axisTick: { show: false },
      axisLabel: { color: '#a1a1aa', fontFamily: 'JetBrains Mono', fontSize: 11 }
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
    cbSlippageChartInstance = echarts.init(elCbSlippageEcharts, 'dark');
  }

  const sim = data.slippageSimulation;
  const labels = sim.map(s => s.sizeLabel);
  const buySlippage = sim.map(s => s.buy.slippageBps);
  const sellSlippage = sim.map(s => s.sell.slippageBps);

  const option = {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(18, 18, 24, 0.94)',
      borderColor: 'rgba(255, 255, 255, 0.12)',
      textStyle: { color: '#e4e4e7', fontFamily: 'JetBrains Mono', fontSize: 12 },
      formatter: function(params) {
        if (!params || !params.length) return '';
        const idx = params[0].dataIndex;
        const item = sim[idx];
        if (!item) return '';

        return `<div style="font-weight:700;margin-bottom:6px;color:#fafafa;">市价冲击模拟规模: ${item.sizeLabel}</div>
          <div style="display:flex;justify-content:space-between;gap:16px;margin:2px 0;">
            <span style="color:#10b981;">🟢 买入滑点:</span>
            <span style="font-weight:700;color:#10b981;">+${item.buy.slippageBps} bps (均价 $${item.buy.avgPrice.toLocaleString()})</span>
          </div>
          <div style="display:flex;justify-content:space-between;gap:16px;margin:2px 0;">
            <span style="color:#f43f5e;">🔴 卖出滑点:</span>
            <span style="font-weight:700;color:#f43f5e;">+${item.sell.slippageBps} bps (均价 $${item.sell.avgPrice.toLocaleString()})</span>
          </div>
          <div style="margin-top:4px;padding-top:4px;border-top:1px solid rgba(255,255,255,0.08);font-size:11px;color:#f59e0b;">
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
      axisLine: { lineStyle: { color: 'rgba(255, 255, 255, 0.08)' } },
      axisTick: { show: false },
      axisLabel: { color: '#a1a1aa', fontFamily: 'JetBrains Mono', fontSize: 11 }
    },
    yAxis: {
      type: 'value',
      name: '执行滑点 (bps)',
      nameTextStyle: { color: '#71717a', fontSize: 11 },
      axisLabel: {
        color: '#71717a',
        fontFamily: 'JetBrains Mono',
        formatter: '{value} bps'
      },
      splitLine: { lineStyle: { color: 'rgba(255, 255, 255, 0.04)' } }
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
// Application Startup Initialization
// ============================================================================
initMacroChartEvents();
initCdriEvents();
initTermPremiumEvents();
initSsroEvents();
initCoinbaseLiquidityEvents();
initNavigation();
loadMarketData(false);
fetchSsroData(false);
fetchCoinbaseLiquidityData(false);


