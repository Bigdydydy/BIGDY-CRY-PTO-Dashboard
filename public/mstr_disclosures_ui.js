/**
 * MstrDisclosuresUI — Module 1 "Strategy 官方披露账本" panel.
 *
 * Renders the issuer-reported BTC ledger, the issuer share table, the issuer
 * capital-structure snapshot, the press-release discovery index, and the SEC
 * filing-discovery index from /api/mstr-disclosures. Purely presentational:
 * no NAV/mNAV math, no STRC inference, no provider HTML injection.
 *
 * Truth rules mirrored from the server:
 *  - dates shown are issuer-reported / filing dates; receipt clocks are shown
 *    separately and never replaced by "now" on failure;
 *  - a fetch failure keeps previously rendered rows and says so;
 *  - local 10s re-render ages receipts against the per-source policy embedded
 *    in the payload — no network polling for freshness;
 *  - announcements are title-level discovery: kinds are heuristics on the
 *    headline only and no amounts are ever read out of titles;
 *  - links are only ever https on the SEC / Strategy / Contentstack evidence
 *    hosts; unsafe URLs render as plain text;
 *  - official mNAV (payload.officialMnav) is the issuer's 2026-07-23
 *    methodology computed server-side from disclosed inputs; it is labelled
 *    as an estimate and is never merged with the legacy EV-based mNAV.
 */
(function () {
  'use strict';

  var FETCH_MS = 60000;
  var TICK_MS = 10000;
  var MAX_EVENTS = 10;
  var MAX_ANNOUNCEMENTS = 10;
  var SOURCE_IDS = [
    'mstr_official_ledger', 'mstr_official_shares', 'mstr_official_capital',
    'mstr_official_press', 'mstr_sec_index', 'mstr_mnav_inputs'
  ];
  var SOURCE_NAMES = {
    mstr_official_ledger: '官方 BTC 账本',
    mstr_official_shares: '官方股数表',
    mstr_official_capital: '官方资本结构',
    mstr_official_press: '官方公告索引',
    mstr_sec_index: 'SEC 申报索引',
    mstr_mnav_inputs: '官方 mNAV 输入'
  };
  var ALLOWED_LINK_HOSTS = {
    'www.sec.gov': true, 'www.strategy.com': true, 'ir.strategy.com': true, 'data.sec.gov': true
  };
  var KIND_LABELS = {
    BTC_PURCHASE: 'BTC买入',
    STRC_REPURCHASE: 'STRC回购',
    PREFERRED_CAPITAL: '优先股融资',
    DIVIDEND_POLICY: '股息政策',
    DEBT_CAPITAL: '债务资本',
    EARNINGS: '业绩',
    OTHER_MENTION: '提及'
  };

  var lastPayload = null;
  var lastFetchError = null;
  var inflight = null;

  function el(id) {
    var byId = typeof document.getElementById === 'function' ? document.getElementById(id) : null;
    return byId || document.querySelector('#' + id);
  }

  function node(tag, text) {
    var n = document.createElement(tag);
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function fmtInt(v) {
    return (v === null || v === undefined || !isFinite(v)) ? '--' : Math.round(v).toLocaleString('en-US');
  }
  function fmtUsd(v) {
    return (v === null || v === undefined || !isFinite(v)) ? '--' : '$' + Math.round(v).toLocaleString('en-US');
  }
  function fmtUsdB(v) {
    return (v === null || v === undefined || !isFinite(v)) ? '--' : '$' + (v / 1e9).toFixed(2) + 'B';
  }
  function fmtUsd2(v) {
    if (v === null || v === undefined || !isFinite(v)) return '--';
    var n = Number(v);
    return (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // computeOfficialMnav 的问题代码 -> 中文说明；带参数的代码形如 'unmapped_instrument:Convert 2033'
  var MNAV_ISSUE_TEXT = {
    net_bps_nonpositive: 'Net BPS ≤ 0，倍数无经济含义',
    strk_strike_fallback: 'STRK 转股价缺少披露数据，按约 $1,000 近似',
    stre_fx_missing: 'STRE 缺少官方欧元汇率，按 1:1 计入',
    fdso_nonpositive: '完全稀释股数异常 (≤ 0)',
    invalid_mstr_price: 'MSTR 价格无效',
    invalid_btc_price: 'BTC 价格无效'
  };
  var MNAV_ISSUE_PREFIX = {
    unmapped_instrument: '未识别的可转债 (仅计入名义本金，未计转股股数)',
    missing_input: '缺少输入'
  };
  function describeMnavIssues(codes) {
    return codes.map(function (code) {
      if (MNAV_ISSUE_TEXT[code]) return MNAV_ISSUE_TEXT[code];
      var i = String(code).indexOf(':');
      if (i > 0 && MNAV_ISSUE_PREFIX[code.slice(0, i)]) {
        return MNAV_ISSUE_PREFIX[code.slice(0, i)] + '：' + code.slice(i + 1);
      }
      return String(code);
    }).join('；');
  }
  function fmtHmUtc(v) {
    if (!v) return '--';
    var d = new Date(v);
    return isFinite(d.getTime()) ? d.toISOString().slice(11, 16) + ' UTC' : '--';
  }
  function fmtIso(v) {
    if (!v) return '--';
    var d = new Date(v);
    return isFinite(d.getTime()) ? d.toISOString().replace('T', ' ').slice(0, 19) + 'Z' : '--';
  }

  /** Only https on the three evidence hosts may become a link. */
  function safeLink(url, label) {
    var ok = false;
    try {
      var u = new URL(url);
      ok = u.protocol === 'https:' && !u.username && !u.password &&
        (ALLOWED_LINK_HOSTS[u.hostname] ||
          (u.hostname === 'assets.contentstack.io' &&
            u.pathname.indexOf('/v3/assets/bltf8d808d9b8cebd37/') === 0));
    } catch (e) { ok = false; }
    if (!ok) return node('span', '证据链接不可用');
    var a = node('a', label || '查看来源');
    a.setAttribute('href', u.href);
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
    return a;
  }

  var SEVERITY = { OK: 0, FALLBACK: 1, STALE: 2, DEGRADED: 3, UNAVAILABLE: 4, UNKNOWN: 5 };

  /**
   * Locally age a payload-bound source receipt: the server-sent state applies
   * at payload time; after the fetch warn/block windows the local status
   * degrades on its own — never the other way.
   */
  function agedSource(src, now) {
    if (!src || typeof src !== 'object') return { state: 'UNKNOWN' };
    var receipt = src.lastSuccessAt ? Date.parse(src.lastSuccessAt) : NaN;
    if (!isFinite(receipt)) return { state: src.lastError ? 'UNAVAILABLE' : 'UNKNOWN', src: src };
    var p = src.policy || {};
    var age = now - receipt;
    var aged = 'OK';
    if (isFinite(p.fetchBlockMs) && age > p.fetchBlockMs) aged = 'UNAVAILABLE';
    else if (isFinite(p.fetchWarnMs) && age > p.fetchWarnMs) aged = 'STALE';
    var recorded = src.state || 'UNKNOWN';
    var state = SEVERITY[aged] > SEVERITY[recorded] ? aged : recorded;
    if (state === 'OK' && src.lastError) state = 'DEGRADED';
    return { state: state, src: src, ageMs: age };
  }

  function renderStatus() {
    var statusEl = el('mstr-disclosure-status');
    if (!statusEl) return;
    var now = Date.now();
    if (lastFetchError) {
      var bits = ['读取失败，保留上次披露；当前覆盖未核验'];
      if (lastPayload && lastPayload.lastCompletedAt) bits.push('上次完成回执 ' + fmtIso(lastPayload.lastCompletedAt));
      if (lastPayload && lastPayload.latest && lastPayload.latest.reportedOn) bits.push('披露日 ' + lastPayload.latest.reportedOn);
      statusEl.textContent = bits.join(' · ');
      statusEl.className = 'pref-section-asof md-status-bad';
      return;
    }
    if (!lastPayload) {
      statusEl.textContent = '尚未获取披露数据';
      statusEl.className = 'pref-section-asof';
      return;
    }
    var sources = (lastPayload.dataHealth && lastPayload.dataHealth.sources) || {};
    var parts = [];
    var allOk = true;
    for (var i = 0; i < SOURCE_IDS.length; i++) {
      var id = SOURCE_IDS[i];
      var a = agedSource(sources[id], now);
      var label = SOURCE_NAMES[id];
      if (a.state === 'OK') {
        parts.push(label + ' 回执 ' + fmtIso(a.src.lastSuccessAt));
      } else {
        allOk = false;
        var why = a.src && a.src.lastError ? ' (' + a.src.lastError + ')' : '';
        parts.push(label + ' ' + a.state + why);
      }
    }
    var issues = lastPayload.reconciliationIssues || [];
    var conflicted = (lastPayload.events || []).filter(function (e) { return (e.issues || []).length; });
    var head;
    if (allOk && !issues.length && !conflicted.length) {
      head = '已检查';
    } else if (!allOk) {
      head = '覆盖未完全核验';
    } else {
      head = '已检查 · 存在差异';
    }
    var lines = [head];
    if (lastPayload.lastCompletedAt) lines.push('上次完成回执 ' + fmtIso(lastPayload.lastCompletedAt));
    if (lastPayload.latest && lastPayload.latest.reportedOn) lines.push('最新披露日 ' + lastPayload.latest.reportedOn);
    if (conflicted.length) lines.push('历史成本对账差异 ' + conflicted.length + ' 条');
    if (issues.length) lines.push('账本/股数对账差异: ' + issues.join(', '));
    statusEl.textContent = lines.join(' · ') + ' — ' + parts.join('；');
    statusEl.className = 'pref-section-asof' + (allOk && !issues.length && !conflicted.length ? '' : ' md-status-bad');
  }

  function renderSummary() {
    var box = el('mstr-disclosure-summary');
    if (!box) return;
    box.textContent = '';
    if (!lastPayload) return;
    var latest = lastPayload.latest;
    var shares = lastPayload.shares;
    if (latest) {
      var line = '披露日 ' + latest.reportedOn + ' · 报告持仓 ' + fmtInt(latest.holdingsBtc) + ' BTC' +
        ' · 报告持仓均价 ' + fmtUsd(latest.averageCostUsd);
      if (latest.aggregateCostUsd !== null && latest.aggregateCostUsd !== undefined) {
        line += ' · 报告累计成本 ' + fmtUsd(latest.aggregateCostUsd);
      }
      box.appendChild(node('div', line));
    } else {
      box.appendChild(node('div', '暂无发行人披露持仓记录'));
    }
    if (shares) {
      box.appendChild(node('div',
        '股数基线 asOf ' + shares.asOf + ' · basic ' + fmtInt(shares.basicShares) +
        ' · ADSO ' + fmtInt(shares.assumedDilutedShares)));
      box.appendChild(node('div', 'ADSO 不是 FDSO；不用于推算当前官方 mNAV。'));
    }
    var capital = lastPayload.capital;
    if (capital) {
      // 发行人 annualDividendsUsd 以百万美元口径披露，UI 仅标注单位，不改写数值。
      var capLine = '资本结构 (asOf ' + capital.asOf + ')：债务 ' + fmtUsdB(capital.debtUsd) +
        ' · 优先股 ' + fmtUsdB(capital.prefUsd) + ' · 美元资产 ' + fmtUsdB(capital.cashUsd);
      if (capital.annualDividendsUsd !== null && capital.annualDividendsUsd !== undefined) {
        capLine += ' · 年化优先股股息 $' + fmtInt(capital.annualDividendsUsd) + 'M';
      }
      box.appendChild(node('div', capLine));
    }
    var prefs = lastPayload.preferreds || [];
    if (prefs.length) {
      var prefParts = prefs.map(function (p) {
        var seg = p.ticker + ' ' + (typeof p.dividendPct === 'number' ? p.dividendPct.toFixed(1) : '--') + '%';
        if (p.nextPayoutDate) seg += ' · 下次派息 ' + p.nextPayoutDate;
        if (typeof p.sharesOutstanding === 'number') seg += ' · ' + fmtInt(p.sharesOutstanding) + ' 股';
        return seg;
      });
      box.appendChild(node('div', '优先股条款：' + prefParts.join('；')));
    }
    // Milestone 3: official mNAV per the issuer's 2026-07-23 methodology.
    // Values are estimates derived from disclosed inputs — labelled as such —
    // and the 2026-07-23 series is never comparable with the legacy EV mNAV.
    var mnavWrap = lastPayload.officialMnav;
    var mnavRes = mnavWrap && mnavWrap.result;
    var mnavVal = mnavRes && mnavRes.mnav;
    var mnavIssueList = (mnavRes && mnavRes.issues) || (mnavWrap && mnavWrap.issues) || [];
    // Net BPS <= 0 时 mNAV 数值在数学上有定义但没有经济含义 (负数或无穷大)，不能当倍数展示
    var netBpsNonPositive = mnavRes && (mnavIssueList.indexOf('net_bps_nonpositive') >= 0
      || (typeof mnavRes.netBpsUsd === 'number' && mnavRes.netBpsUsd <= 0));
    if (netBpsNonPositive) {
      box.appendChild(node('div',
        '官方口径 mNAV：不适用 — 净债权超过 BTC 储备与美元资产之和 (Net BPS ' +
        fmtUsd2(mnavRes.netBpsUsd) + ' ≤ 0)，倍数没有经济含义'));
      var restIssues = mnavIssueList.filter(function (c) { return c !== 'net_bps_nonpositive'; });
      if (restIssues.length) box.appendChild(node('div', '官方 mNAV 注记: ' + describeMnavIssues(restIssues)));
    } else if (typeof mnavVal === 'number' && isFinite(mnavVal)) {
      var px = mnavRes.inputs || {};
      var line = '官方口径 mNAV (' + (mnavRes.methodologyVersion || '--') + ' 方法) ' +
        mnavVal.toFixed(2) + '× · Net BPS ' + fmtUsd2(mnavRes.netBpsUsd) +
        ' · FDSO ' + (isFinite(mnavRes.fdso) ? (mnavRes.fdso / 1e6).toFixed(1) + 'M' : '--') +
        ' · 输入: MSTR ' + fmtUsd2(px.mstrPriceUsd) + ' / BTC ' + fmtUsd2(px.btcPriceUsd) +
        ' (' + (mnavWrap.btcSource || '--') + ', ' + fmtHmUtc(mnavWrap.priceAsOf || mnavWrap.computedAt) + ')' +
        ' · 披露输入推算估计值';
      box.appendChild(node('div', line));
      if (mnavIssueList.length) {
        box.appendChild(node('div', '官方 mNAV 注记: ' + describeMnavIssues(mnavIssueList)));
      }
      box.appendChild(node('div',
        '新旧口径不可比：官方 mNAV 自 2026-07-23 改用 Net BPS/FDSO 方法，' +
        '与旧 EV 口径历史/估算序列不可直接拼接或比较。'));
    } else {
      box.appendChild(node('div',
        '官方口径 mNAV：输入不足，未计算' + (mnavIssueList.length ? '（' + describeMnavIssues(mnavIssueList) + '）' : '')));
    }
    var rc = lastPayload.revisionCount || 0;
    if (rc > 0) box.appendChild(node('div', '历史修订记录 ' + rc + ' 条（保留原始版本）'));
    box.appendChild(node('div', 'SEC 当前仅发现申报，正文待核验；' +
      (capital ? '资本结构 已接入官方快照' : '资本结构 官方快照不可用') +
      '；STRC 仅公告发现（标题级，正文未核验）。'));
  }

  function renderEvents() {
    var tbody = el('mstr-disclosure-events');
    if (!tbody) return;
    tbody.textContent = '';
    var events = (lastPayload && lastPayload.events || []).slice(0, MAX_EVENTS);
    events.forEach(function (ev) {
      var tr = node('tr');
      if ((ev.issues || []).length) {
        tr.className = 'md-row-flagged';
        tr.setAttribute('title', '对账差异: ' + ev.issues.join(', '));
      }
      tr.appendChild(node('td', ev.reportedOn));
      var delta = ev.deltaBtc;
      var deltaText = (delta < 0 ? '卖出 ' : delta > 0 ? '买入 +' : '更新 ') + fmtInt(delta);
      tr.appendChild(node('td', deltaText));
      tr.appendChild(node('td', fmtUsd(ev.transactionAverageUsd)));
      tr.appendChild(node('td', fmtInt(ev.holdingsBtc)));
      tr.appendChild(node('td', fmtUsd(ev.averageCostUsd)));
      var linkTd = node('td');
      linkTd.appendChild(safeLink(ev.documentUrl || ev.sourceUrl, ev.documentUrl ? '申报文件' : '来源页'));
      tr.appendChild(linkTd);
      tbody.appendChild(tr);
    });
  }

  function renderFilings() {
    var list = el('mstr-disclosure-filings-list');
    if (!list) return;
    list.textContent = '';
    var filings = (lastPayload && lastPayload.filings) || [];
    if (!filings.length) {
      list.appendChild(node('li', '尚无 SEC 申报索引记录'));
      return;
    }
    filings.forEach(function (f) {
      var li = node('li');
      li.appendChild(node('span', '申报已发现 · 正文待核验 — ' + f.form + ' · ' + f.filedOn + ' '));
      li.appendChild(safeLink(f.documentUrl, '查看申报'));
      list.appendChild(li);
    });
  }

  /** Press-index discovery rows: date + title-level kind chip + safe link.
   * Kinds are headline heuristics only — the block is labelled as such. */
  function renderAnnouncements() {
    var list = el('mstr-disclosure-announcements');
    if (!list) return;
    list.textContent = '';
    var items = (lastPayload && lastPayload.announcements || []).slice(0, MAX_ANNOUNCEMENTS);
    if (!items.length) {
      list.appendChild(node('li', '尚无官方公告发现记录'));
      return;
    }
    items.forEach(function (a) {
      var li = node('li');
      li.appendChild(node('span', (a.publishedOn || '--') + ' '));
      (a.kinds || []).forEach(function (k) {
        var chip = node('span', KIND_LABELS[k] || k);
        chip.className = 'md-kind';
        li.appendChild(chip);
        li.appendChild(node('span', ' '));
      });
      li.appendChild(node('span', a.title + ' '));
      li.appendChild(safeLink(a.url, '公告原文'));
      list.appendChild(li);
    });
  }

  function applyPayload(payload) {
    if (payload && typeof payload === 'object') {
      lastPayload = payload;
      lastFetchError = null;
    }
    renderSummary();
    renderEvents();
    renderFilings();
    renderAnnouncements();
    renderStatus();
  }

  function load(force) {
    if (inflight) return inflight;
    inflight = fetch('/api/mstr-disclosures' + (force ? '?force=1' : ''), {
      headers: { Accept: 'application/json' }
    }).then(function (r) {
      if (!r || !r.ok) throw new Error('HTTP ' + (r ? r.status : 'no response'));
      return r.json();
    }).then(function (json) {
      applyPayload(json);
    }).catch(function (e) {
      // Failure never removes already-rendered rows/facts.
      lastFetchError = e;
      renderStatus();
    }).finally(function () { inflight = null; });
    return inflight;
  }

  function init() {
    if (!el('mstr-disclosures')) return;
    var btn = el('mstr-disclosure-refresh');
    if (btn) btn.onclick = function () { load(true); };
    load(false);
    // 60s refresh only while the tab is visible; 10s status re-render is local.
    setInterval(function () { if (document.hidden !== true) load(false); }, FETCH_MS);
    setInterval(renderStatus, TICK_MS);
  }

  window.MstrDisclosuresUI = {
    load: load,
    applyPayload: applyPayload,
    renderStatus: renderStatus,
    init: init
  };

  init();
})();
