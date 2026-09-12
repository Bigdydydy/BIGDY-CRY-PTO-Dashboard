/**
 * Frontend Application Controller for Greeks.live Quantitative Dashboard
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
    
    // Fetch options market data, macro chart data, and CDRI data in parallel
    const [mResp] = await Promise.all([
      fetch(`/api/market-data?threshold=${threshold}&timeRange=${timeRange}`),
      loadMacroData(triggerRefresh).catch(e => console.error('[App] Macro fetch error:', e.message)),
      loadCdriData(triggerRefresh).catch(e => console.error('[App] CDRI fetch error:', e.message))
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
    elDataVersionBadge.textContent = `v${sync.dataVersion}`;
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
      const dirText = isBuy ? 'BUY 多头拆单' : 'SELL 空头拆单';

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

  // 2. Render Single Whale Blocks Table
  const blocks = data.whaleBlocks || [];
  if (!blocks.length) {
    elWhaleTableBody.innerHTML = '<tr><td colspan="8" class="text-center">在当前门槛下未检测到单笔巨鲸大单</td></tr>';
  } else {
    let tableHtml = '';
    blocks.forEach((b, idx) => {
      tableHtml += `
        <tr onclick="openWhaleDetail(${idx})">
          <td>${b.dateTimeUTC8 || b.dateTime || formatUTC8(b.timestamp)}</td>
          <td><span class="text-accent">${b.blockId}</span></td>
          <td><span class="intent-badge-pill ${b.intentBadgeClass || 'badge-neutral'}">${b.intentBadge || '--'}</span></td>
          <td><strong>$${b.notionalUSDM.toFixed(2)}M</strong></td>
          <td>${b.netDeltaBTC >= 0 ? '+' : ''}${b.netDeltaBTC.toFixed(1)} BTC</td>
          <td>${b.netVegaUSD >= 0 ? '+' : ''}$${Math.round(b.netVegaUSD).toLocaleString()}</td>
          <td>${b.legCount} 腿</td>
          <td><button class="action-btn" onclick="event.stopPropagation(); openWhaleDetail(${idx})">穿透解析</button></td>
        </tr>
      `;
    });
    elWhaleTableBody.innerHTML = tableHtml;
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

  const deltaSign = c.netDeltaBTC >= 0 ? '+' : '';
  mNetDelta.textContent = `${deltaSign}${c.netDeltaBTC.toFixed(1)} BTC`;
  mNetDeltaUSD.textContent = `${c.netDeltaUSD >= 0 ? '+' : '-'}$${Math.abs(c.netDeltaUSDM).toFixed(2)}M`;

  mNetGamma.textContent = '--';

  const vegaSign = c.netVegaUSD >= 0 ? '+' : '';
  mNetVega.textContent = `${vegaSign}$${Math.round(c.netVegaUSD).toLocaleString()}`;
  mNetVega.className = c.netVegaUSD >= 0 ? 'gkpi-val text-pos' : 'gkpi-val text-neg';

  const thetaSign = c.netThetaUSD >= 0 ? '+' : '';
  mNetTheta.textContent = `${thetaSign}$${Math.round(c.netThetaUSD).toLocaleString()}/d`;
  mNetTheta.className = c.netThetaUSD >= 0 ? 'gkpi-val text-pos' : 'gkpi-val text-neg';

  const isBuy = c.direction === 'buy';
  const dirClass = isBuy ? 'text-pos' : 'text-neg';
  mLegsBody.innerHTML = `
    <tr>
      <td class="${dirClass}"><strong>${c.direction.toUpperCase()}</strong></td>
      <td><strong>${c.instrument}</strong> (合成累计)</td>
      <td>${c.totalContracts} BTC</td>
      <td>均价: ${c.avgPrice.toFixed(4)}</td>
      <td>--</td>
      <td>${c.netDeltaBTC >= 0 ? '+' : ''}${c.netDeltaBTC.toFixed(2)}</td>
      <td>${c.netVegaUSD >= 0 ? '+' : ''}$${Math.round(c.netVegaUSD).toLocaleString()}</td>
      <td>${c.netThetaUSD >= 0 ? '+' : ''}$${Math.round(c.netThetaUSD).toLocaleString()}</td>
      <td>$${c.clusterNotionalM.toFixed(2)}M</td>
    </tr>
  `;

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

  // Preserve visibility state across re-renders for all 7 datasets
  let visibilityStates = [true, true, true, true, true, true, true];
  if (macroChartInstance) {
    for (let i = 0; i < 7; i++) {
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
    }
  ];

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
        }
      }
    }
  });
  window.macroChartInstance = macroChartInstance;

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
              <span style="color:#a1a1aa;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#f59e0b;margin-right:6px;"></span>BTC 现货价格:</span>
              <span style="font-weight:700;color:#fbbf24;">$${Number(p.value).toLocaleString()}</span>
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
        nameTextStyle: { color: '#fbbf24', fontSize: 11 },
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
          color: '#fbbf24',
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
          width: 1.2,
          color: '#f59e0b',
          opacity: 0.85
        },
        itemStyle: { color: '#f59e0b' }
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
// Application Startup Initialization
// ============================================================================
initMacroChartEvents();
initCdriEvents();
loadMarketData(false);


