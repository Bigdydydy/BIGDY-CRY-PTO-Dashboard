/**
 * DataHealthUI — per-card data health banners + live-conclusion gating.
 *
 * Contract with data loaders:
 *   DataHealthUI.update(moduleId, health)   after every API payload (health = the
 *                                           payload's dataHealth / analysisHealth[key]
 *                                           summary, or a single-source health object)
 *   DataHealthUI.fail(moduleId, error)      inside every catch handler
 *   DataHealthUI.refresh()                  after renderers rebuild DOM nodes
 *
 * Rendering:
 *   - Every registered card gets one `.dh-banner` injected under its header.
 *   - "Live conclusion" containers (selectors in `live`, or elements tagged
 *     data-live-analysis="moduleId") are marked [data-health-blocked] whenever
 *     the module is not locally verifiable as usable — that includes UNKNOWN
 *     and any missing source/policy/clock metadata. A `.dh-pause-note`
 *     explains the pause. Historical curves/records stay visible — the card
 *     itself is flagged data-historical-only.
 *   - A 10s local tick re-evaluates expiry against the policy windows the API
 *     already embeds in each source's `policy` — no network polling — so a tab
 *     left open ages data out on its own. Warn windows degrade a card to
 *     STALE locally; recovery removes the blocked state.
 *
 * XSS note: all dynamic text (source ids, errors, dates) is written via
 * textContent only — never innerHTML.
 */
(function () {
  'use strict';

  var TICK_MS = 10000;

  var STATE_TEXT = {
    OK: '正常',
    DEGRADED: '备用源',
    FALLBACK: '备用源',
    STALE: '旧缓存',
    UNAVAILABLE: '过期不可用于当前研判',
    UNKNOWN: '未核验'
  };

  // moduleId -> card + live-conclusion containers. `live` selectors are matched
  // via document.querySelectorAll each render so renderer-replaced nodes are
  // re-locked. Elements may also self-tag data-live-analysis="moduleId".
  // Only CURRENT conclusions belong in `live` — historical charts, records and
  // archives must stay browsable while conclusions are paused.
  var DEFAULT_MODULES = [
    { id: 'options.atmIv',       card: '#module-atm-iv',            live: ['#iv-regime-badge', '#module-atm-iv .metrics-row', '#module-atm-iv .card-body > .metric-pill-box', '#iv-percentile-label', '#iv-narrative-box'] },
    { id: 'options.ivSmile',     card: '#module-iv-smile',          live: ['#smile-shape-badge', '#module-iv-smile .metrics-row', '#strikes-strip-container', '#smile-narrative-box'] },
    { id: 'options.delta25Skew', card: '#module-25d-skew',          live: ['#skew-regime-badge', '#module-25d-skew .skew-term-grid', '#module-25d-skew .metric-pill-box', '#skew-narrative-box'] },
    { id: 'options.gex',         card: '#module-gex',               live: ['#gex-summary-row', '#gex-cards-container', '#gex-narrative-box'] },
    { id: 'options.blockTrades', card: '#module-block-trades',      live: ['#block-narrative-box', '#module-block-trades .flow-summary-bar'] },
    { id: 'term_premium',        card: '#module-term-premium',      live: ['#tp-header-regime-pill', '#tp-header-score-pill', '#tp-header-excess-pill', '#tp-regime-tag', '#tp-score-value', '#tp-score-tier', '#tp-excess-val', '#tp-sharpe-val', '#tp-insights-summary', '#tp-insights-list'] },
    { id: 'etf',                 card: '#module-etf-linkage',       live: ['#el-verdict-pill', '#el-verdict-count', '#el-verdict-summary', '#el-check-list', '#el-status', '#module-etf-linkage .el-kpi'] },
    { id: 'leverage',            card: '#module-leverage-norm',     live: ['#module-leverage-norm .el-kpi', '#ln-headline-funding', '#ln-headline-oi', '#ln-headline-etf', '#ln-headline-options'] },
    { id: 'macro',               card: '#module-macro-chart',       live: ['#module-macro-chart > .card-body > .macro-metrics-row'] },
    { id: 'preferreds',          card: '#mstr-pref-section',        live: ['#mstr-pref-section .macro-metrics-row'] },
    { id: 'cdri',                card: '#module-cdri',              live: ['#cdri-header-score-pill', '#cdri-gauge-svg', '#cdri-gauge-score', '#cdri-gauge-badge'] },
    { id: 'ssro',                card: '#module-ssro-chart',        live: ['#card-ssro-btc', '#card-ssro-stable', '#card-ssro-ssr', '#card-ssro-zscore', '#card-ssro-status'] },
    { id: 'flow',                card: '#module-flow-force',        live: ['#flow-leader-val', '#flow-leader-chip', '#flow-leader-sub', '#flow-region-val', '#flow-region-chip', '#flow-prem-val', '#flow-prem-sub', '#flow-basis-val', '#flow-status'] },
    { id: 'coinbase',            card: '#module-coinbase-liquidity', live: ['#cb-header-regime-pill', '#cb-header-bid-pill', '#cb-header-spread-pill', '#cb-pyr-eval-text', '#cb-insights-list'] },
    { id: 'liquidity_history',   card: '#cb-history',               live: ['#cb-history-kpis', '#cb-history-notice'] },
    { id: 'gold',                card: '#module-gold-correlation',  live: ['#gold-header-regime-pill', '#gold-tag-corr-regime', '#gold-side-regime-tag', '#gold-side-regime-name', '#gold-side-regime-summary'] },
    { id: 'block_insight',       card: '#view-block-insight',       live: ['#insight-coverage', '#insight-flow-note', '#insight-zones', '#insight-walls', '#insight-smart-kpis'] },
    { id: 'option_marks',        card: '#pnl-modal-card',           live: ['#pnl-modal-card .pnl-kpi-grid', '#pnl-modal-card .pnl-chart-wrapper'] },
    { id: 'mcclellan',           card: '#module-crypto-mcclellan',  live: ['#module-crypto-mcclellan .mcclellan-kpi-grid'] },
    { id: 'wave',                card: '#module-wave-radar',        live: ['#wave-user-eval-badge', '#wave-user-eval-body'] }
  ];

  var modules = new Map();

  function parseTs(v) {
    if (v === null || v === undefined) return null;
    var t = v instanceof Date ? v.getTime() : Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }

  /** Accepts summarizeHealth-shaped objects and single-source health objects. */
  function normalizeHealth(h) {
    var out = { state: 'UNKNOWN', analysisAllowed: false, stale: false, sources: {} };
    if (!h || typeof h !== 'object') return out;
    out.state = h.state || 'UNKNOWN';
    out.stale = !!h.stale;
    out.sources = (h.sources && typeof h.sources === 'object') ? h.sources : {};
    if (typeof h.analysisAllowed === 'boolean') {
      out.analysisAllowed = h.analysisAllowed;
    } else if (typeof h.usable === 'boolean') {
      out.analysisAllowed = h.usable;
    } else {
      out.analysisAllowed = out.state === 'OK' || out.state === 'FALLBACK' ||
        (out.state === 'STALE' && h.expired !== true);
    }
    if (h.id && !out.sources[h.id]) out.sources[h.id] = h; // single-source health
    return out;
  }

  /**
   * Local re-check of a source against its API-provided policy windows.
   * Missing metadata — no receipt clock, no data clock, no policy windows —
   * fails closed: a source whose freshness cannot be bounded is never usable.
   */
  function sourceStillUsable(s, now) {
    if (!s || typeof s !== 'object') return false;
    if (s.available === false || s.usable === false) return false;
    var suc = parseTs(s.lastSuccessAt);
    var asof = parseTs(s.dataAsOf);
    if (suc === null || asof === null) return false;
    var p = s.policy;
    if (!p || typeof p !== 'object') return false;
    if (!Number.isFinite(p.fetchBlockMs) && !Number.isFinite(p.dataBlockMs)) return false;
    if (Number.isFinite(p.fetchBlockMs) && now - suc > p.fetchBlockMs) return false;
    if (Number.isFinite(p.dataBlockMs) && now - asof > p.dataBlockMs) return false;
    return true;
  }

  /** Warn-window check: past warn (but not block) reads STALE, never green. */
  function sourceWarned(s, now) {
    if (!s || typeof s !== 'object') return false;
    if (s.stale === true || s.state === 'STALE' || s.state === 'FALLBACK') return true;
    var p = s.policy || {};
    var suc = parseTs(s.lastSuccessAt);
    var asof = parseTs(s.dataAsOf);
    if (Number.isFinite(p.fetchWarnMs) && suc !== null && now - suc > p.fetchWarnMs) return true;
    if (Number.isFinite(p.dataWarnMs) && asof !== null && now - asof > p.dataWarnMs) return true;
    return false;
  }

  function isUsable(mod, now) {
    var h = mod.health;
    if (!h) return false;
    if (!h.analysisAllowed) return false;
    var ids = Object.keys(h.sources);
    // A naked aggregate OK with zero per-source detail cannot be trusted —
    // there is no clock or policy to bound its freshness, so fail closed.
    if (!ids.length) return false;
    for (var i = 0; i < ids.length; i++) {
      if (!sourceStillUsable(h.sources[ids[i]], now)) return false;
    }
    return true;
  }

  function displayState(mod, now) {
    if (!mod.health) return mod.error ? 'UNAVAILABLE' : 'UNKNOWN';
    if (!isUsable(mod, now)) {
      if (mod.health.state === 'UNKNOWN' && !mod.error) return 'UNKNOWN';
      return 'UNAVAILABLE';
    }
    if (mod.error) return 'FALLBACK'; // fetch failed but prior payload still usable
    var ids = Object.keys(mod.health.sources);
    for (var i = 0; i < ids.length; i++) {
      if (sourceWarned(mod.health.sources[ids[i]], now)) return 'STALE';
    }
    return mod.health.state;
  }

  /** Oldest input data date + oldest successful receipt across required sources. */
  function clocksOf(mod) {
    var srcs = (mod.health && mod.health.sources) || {};
    var dataAsOf = null, lastSuccessAt = null;
    Object.keys(srcs).forEach(function (id) {
      var a = parseTs(srcs[id].dataAsOf);
      var u = parseTs(srcs[id].lastSuccessAt);
      if (a !== null && (dataAsOf === null || a < dataAsOf)) dataAsOf = a;
      if (u !== null && (lastSuccessAt === null || u < lastSuccessAt)) lastSuccessAt = u;
    });
    return { dataAsOf: dataAsOf, lastSuccessAt: lastSuccessAt };
  }

  function firstError(mod) {
    if (mod.error) return String(mod.error);
    var srcs = (mod.health && mod.health.sources) || {};
    var ids = Object.keys(srcs);
    for (var i = 0; i < ids.length; i++) {
      if (srcs[ids[i]].lastError) return ids[i] + ': ' + srcs[ids[i]].lastError;
    }
    return null;
  }

  function fmtTime(ms) {
    if (!Number.isFinite(ms)) return '--';
    var d = new Date(ms);
    var p = n => String(n).padStart(2, '0');
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function cardEl(mod) {
    return mod.cardSel ? document.querySelector(mod.cardSel) : null;
  }

  function liveEls(mod) {
    var els = [];
    mod.liveSels.forEach(function (sel) {
      try {
        document.querySelectorAll(sel).forEach(function (el) {
          if (!els.includes(el)) els.push(el);
        });
      } catch (e) { /* bad selector in an older DOM — skip */ }
    });
    try {
      document.querySelectorAll('[data-live-analysis="' + mod.id + '"]').forEach(function (el) {
        if (!els.includes(el)) els.push(el);
      });
    } catch (e) { /* ignore */ }
    return els;
  }

  function ensureBanner(mod) {
    var card = cardEl(mod);
    if (!card) return null;
    var b = mod.banner;
    if (!b || !b.isConnected || b.parentNode !== card) {
      b = document.createElement('div');
      b.className = 'dh-banner';
      b.setAttribute('data-dh-module', mod.id);
      var header = card.querySelector(':scope > .card-header, :scope > .pref-section-head, :scope > .modal-header, :scope > .insight-backbar');
      if (header && header.parentNode === card) {
        header.parentNode.insertBefore(b, header.nextSibling);
      } else {
        card.insertBefore(b, card.firstChild);
      }
      mod.banner = b;
    }
    return b;
  }

  function pauseText(mod) {
    var c = clocksOf(mod);
    var t = '数据过期或不可用，暂停当前研判';
    if (c.dataAsOf !== null) t += '（仅历史数据，数据日期 ' + fmtTime(c.dataAsOf) + '）';
    return t;
  }

  function renderModule(mod) {
    var now = Date.now();
    var state = displayState(mod, now);
    // Blocked = locally unusable, not merely state === 'UNAVAILABLE': UNKNOWN
    // and any missing metadata lock live conclusions too.
    var blocked = !isUsable(mod, now);
    var card = cardEl(mod);

    if (card) {
      card.dataset.healthState = blocked ? 'blocked' : state.toLowerCase();
      if (blocked) card.setAttribute('data-historical-only', '');
      else card.removeAttribute('data-historical-only');
    }

    // Banner — one per card, recreated if a renderer wiped it.
    var banner = ensureBanner(mod);
    if (banner) {
      banner.className = 'dh-banner dh-' + (blocked ? 'blocked' : state.toLowerCase());
      banner.textContent = '';
      var label = document.createElement('span');
      label.className = 'dh-banner-state';
      label.textContent = STATE_TEXT[state] || STATE_TEXT.UNKNOWN;
      banner.appendChild(label);
      // Real clocks + errors show on every state — a green banner still tells
      // the user which data date and receipt back the conclusions.
      var c = clocksOf(mod);
      var detail = document.createElement('span');
      detail.className = 'dh-banner-detail';
      var parts = [];
      var err = firstError(mod);
      if (c.dataAsOf !== null) parts.push('数据 ' + fmtTime(c.dataAsOf));
      var suc = c.lastSuccessAt !== null ? c.lastSuccessAt : mod.lastGoodAt;
      if (suc !== null) parts.push('最后成功 ' + fmtTime(suc));
      if (err) parts.push(err);
      detail.textContent = parts.length ? ' · ' + parts.join(' · ') : '';
      banner.appendChild(detail);
    }

    // Lock/unlock live-conclusion containers (never let a renderer resurrect
    // conclusions under us — selectors are re-resolved every render).
    var els = liveEls(mod);
    els.forEach(function (el) {
      if (blocked) el.setAttribute('data-health-blocked', '');
      else el.removeAttribute('data-health-blocked');
    });

    // Pause reason in place of the hidden conclusions. The note lives inside
    // the card body — compare parentNode with that ACTUAL parent, not the
    // card, or every tick would recreate it.
    if (blocked && card) {
      var body = card.querySelector('.card-body, .el-body, .modal-body, .pref-section');
      var parent = body || (els[0] && els[0].parentNode) || card;
      var note = mod.pauseNote;
      if (!note || !note.isConnected || note.parentNode !== parent) {
        if (note && note.isConnected) note.remove();
        note = document.createElement('div');
        note.className = 'dh-pause-note';
        parent.insertBefore(note, parent.firstChild);
        mod.pauseNote = note;
      }
      note.textContent = pauseText(mod);
    } else if (mod.pauseNote && mod.pauseNote.isConnected) {
      mod.pauseNote.remove();
      mod.pauseNote = null;
    }
  }

  function ensureModule(id) {
    var mod = modules.get(id);
    if (!mod) {
      mod = { id: id, cardSel: null, liveSels: [], health: null, error: null, lastGoodAt: null, banner: null, pauseNote: null };
      modules.set(id, mod);
    }
    return mod;
  }

  function register(id, spec) {
    var mod = ensureModule(id);
    if (spec) {
      if (spec.card) mod.cardSel = spec.card;
      if (Array.isArray(spec.live)) mod.liveSels = spec.live.slice();
    }
    renderModule(mod);
    return mod;
  }

  function update(id, health) {
    var mod = ensureModule(id);
    mod.health = normalizeHealth(health);
    mod.error = null;
    // lastGoodAt = the payload's REAL oldest successful receipt. A missing or
    // unverifiable receipt clock is never replaced with Date.now().
    var c = clocksOf(mod);
    if (mod.health.analysisAllowed && c.lastSuccessAt !== null) mod.lastGoodAt = c.lastSuccessAt;
    renderModule(mod);
  }

  function fail(id, error) {
    var mod = ensureModule(id);
    // Keep lastGoodAt untouched — a failure never renews the last-good clock.
    mod.error = error && error.message ? error.message : String(error || 'fetch failed');
    renderModule(mod);
  }

  function renderAll() {
    modules.forEach(renderModule);
  }

  DEFAULT_MODULES.forEach(function (m) { register(m.id, m); });
  setInterval(renderAll, TICK_MS);

  window.DataHealthUI = {
    register: register,
    update: update,
    fail: fail,
    refresh: renderAll,
    STATE_TEXT: STATE_TEXT,
    _modules: modules,
    _tick: renderAll
  };
})();
