/**
 * LoadVeil — 取数等待层。
 *
 * 问题：各 module 的数据由独立的 /api/* 请求取回，缓存过期或服务器冷启动时一次请求
 * 要等数秒到一分钟，期间卡片只有空骨架，看上去像死机。
 *
 * 做法：包一层 window.fetch，只观察同源 /api/* 请求 (不改请求、不改响应内容)，
 * 按下方 ROUTES 把请求映射到卡片：
 *   - 卡片所需的接口还没全部成功过 → 盖一层「潮线」等待层：进度、已等时长、通常耗时；
 *   - 卡片已有数据、只是在刷新 → 仅在卡片顶沿走一条细线，不遮内容；
 *     服务器先回了旧数据、仍在后台刷新 (载荷带 revalidating) 时，细线一直走到新数据到手；
 *   - 页面顶端一条总进度线，汇总本轮所有在途请求。
 * 快于 SHOW_DELAY_MS 的请求不出现任何等待层，热缓存下界面与原来完全一致。
 *
 * 进度是估算：服务器对单个请求不回报进度，这里用「该接口过去慢请求的耗时」(本机
 * localStorage 记忆，指数平滑) 作参照，按 1 − e^(−1.6·t/典型耗时) 逼近但永不到 100%。
 * 文案里同时给出真实的已等秒数，估算条不冒充精确值。
 *
 * 必须在 app.js 之前加载。所有动态文本一律 textContent，不拼 innerHTML。
 */
(function (global) {
  'use strict';

  var SHOW_DELAY_MS = 250;     // 首次取数超过此时长才盖等待层
  var REFRESH_DELAY_MS = 800;  // 已有数据的卡片刷新超过此时长才走顶沿细线
  var BAR_DELAY_MS = 400;      // 总进度线出现的延迟
  var SETTLE_MS = 80;          // 响应体解析完后留给渲染器的时间
  var BODY_FALLBACK_MS = 5000; // 调用方没读响应体时的兜底收尾
  var TICK_MS = 120;
  var WAKE_HINT_MS = 12000;    // 等这么久仍无响应 → 提示可能是冷启动
  var SLOW_SAMPLE_MS = 1000;   // 只有慢请求才计入「通常耗时」
  var GRACE_MS = 600;          // 串行取数 (A 回来才发 B) 的间隙里，等待层留这么久不撤
  var REVALIDATE_HOLD_MS = 45000; // 服务器说「后台刷新中」后细线最多走这么久，免得跟进取数停了还挂着
  var DEFAULT_TYPICAL_MS = 4000;
  var TIDE_CELLS = 28;
  var STORE_KEY = 'bigdy_lv_typical';

  // 接口 → 卡片。typical 是本地冷缓存实测的量级，之后由本机实际耗时修正。
  // 一张卡片挂在多个接口下时，要这些接口各成功过一次才算取到数据：
  // #module-term-premium 的 /api/term-premium 由 app.js 在 market-data 回来后才发出。
  var ROUTES = {
    '/api/market-data': { label: '期权全链', typical: 5000, cards: ['#module-atm-iv', '#module-iv-smile', '#module-25d-skew', '#module-gex', '#module-dealer-exposure', '#module-block-trades', '#module-term-premium'] },
    '/api/term-premium': { label: '基差与期限溢价', typical: 4000, cards: ['#module-term-premium'] },
    '/api/term-curve': { label: '期限结构曲线', typical: 9000, cards: ['#tc-panel'] },
    '/api/etf-linkage': { label: 'ETF 联动', typical: 6000, cards: ['#module-etf-linkage'] },
    '/api/leverage-norm': { label: '杠杆归一化', typical: 4000, cards: ['#module-leverage-norm'] },
    '/api/macro-chart': { label: '宏观与流动性', typical: 6000, cards: ['#module-macro-chart', '#module-mstr-financing'] },
    '/api/mstr-preferreds': { label: 'MSTR 优先股', typical: 3000, cards: ['#mstr-pref-section'] },
    '/api/mstr-disclosures': { label: '官方披露', typical: 4000, cards: ['#mstr-disclosures'] },
    '/api/cdri': { label: 'CDRI', typical: 3000, cards: ['#module-cdri'] },
    '/api/ssro': { label: 'SSRO', typical: 3000, cards: ['#module-ssro-chart'] },
    '/api/flow-force': { label: '主导力量', typical: 5000, cards: ['#module-flow-force'] },
    '/api/coinbase-liquidity': { label: 'Coinbase 深度', typical: 3000, cards: ['#module-coinbase-liquidity'] },
    '/api/coinbase-liquidity-history': { label: '深度历史', typical: 3000, cards: ['#cb-history'] },
    '/api/gold-correlation': { label: '金 / BTC', typical: 3000, cards: ['#module-gold-correlation'] },
    '/api/crypto-mcclellan': { label: '麦克莱伦宽度', typical: 3000, cards: ['#module-crypto-mcclellan'] },
    '/api/block-insight': { label: '4B 研判', typical: 5000, cards: ['#module-insight-flow', '#module-insight-strikes', '#module-insight-smart'] }
  };

  var NEEDS = {}; // 卡片 → 它依赖的全部接口
  Object.keys(ROUTES).forEach(function (route) {
    ROUTES[route].cards.forEach(function (sel) { (NEEDS[sel] = NEEDS[sel] || []).push(route); });
  });

  // 自检 / 探活接口不算取数
  var IGNORED = { '/api/health': 1, '/api/system/health': 1, '/api/system/audit': 1, '/api/audit': 1 };

  // ---------------------------------------------------------------------------
  // 纯函数 (test/load_veil.test.js 直接覆盖)
  // ---------------------------------------------------------------------------

  /** 同源 /api/* 请求返回其 pathname，其余返回 null。 */
  function routeOf(input, base) {
    var raw = typeof input === 'string' ? input : (input && (input.url || input.href)) || '';
    if (!raw) return null;
    var path;
    if (raw.charAt(0) === '/' && raw.charAt(1) !== '/') {
      path = raw;
    } else {
      try {
        var u = new URL(raw, base);
        if (base && u.origin !== new URL(base).origin) return null;
        path = u.pathname;
      } catch (e) {
        return null;
      }
    }
    path = path.split('?')[0].split('#')[0];
    if (path.indexOf('/api/') !== 0 || IGNORED[path]) return null;
    return path;
  }

  /** 0 → 0.97 的估算进度：到「通常耗时」时约 80%，之后越来越慢，永不到 1。 */
  function estimateProgress(elapsedMs, typicalMs) {
    var t = Math.max(0, Number(elapsedMs) || 0);
    var typical = Math.max(200, Number(typicalMs) || DEFAULT_TYPICAL_MS);
    return Math.min(0.97, 1 - Math.exp(-1.6 * t / typical));
  }

  function fmtSeconds(ms) {
    var s = Math.max(0, ms) / 1000;
    return (s < 10 ? s.toFixed(1) : String(Math.round(s))) + 's';
  }

  /** 等待层第二行：先给参照耗时，再说明为什么慢。措辞只陈述已知事实与可能性。 */
  function phaseText(elapsedMs, typicalMs) {
    if (elapsedMs >= WAKE_HINT_MS) return '服务器可能刚从休眠醒来 · 首次取数约 30–60 秒';
    if (elapsedMs >= typicalMs * 1.5) return '比平时慢 · 仍在等上游';
    return '通常约 ' + fmtSeconds(typicalMs);
  }

  /** 慢请求耗时的指数平滑；首个样本直接采用。 */
  function blendTypical(prevMs, sampleMs) {
    if (!(prevMs > 0)) return Math.round(sampleMs);
    return Math.round(prevMs * 0.6 + sampleMs * 0.4);
  }

  var DENSE = '@%#8&0';
  var MID = '$Oo*+=';
  var THIN = '~-:.';

  /**
   * 潮线：n 个字符，已涨到的部分用密字符，潮头用中等字符，前方只有稀疏的波纹。
   * 字符梯度与背景画作的 ASCII 层同源。返回 { filled, rest }，两段拼起来恒为 n 个字符。
   */
  function tideLine(progress, tSec, n) {
    var cells = n || TIDE_CELLS;
    var p = Math.min(1, Math.max(0, Number(progress) || 0));
    var front = p * cells;
    var cut = Math.round(front);
    var filled = '';
    var rest = '';
    for (var i = 0; i < cells; i++) {
      var w = Math.sin(i * 0.9 - tSec * 4.2) * 0.5 + Math.sin(i * 0.37 + tSec * 2.3) * 0.5; // [-1, 1]
      var d = front - i + w * 1.4; // 该格在潮头身后多远
      var ch;
      if (d > 3) ch = DENSE.charAt(Math.min(5, Math.floor((w + 1) / 2 * 6)));
      else if (d > 0) ch = MID.charAt(Math.min(5, Math.floor((3 - d) / 3 * 6)));
      else if (d > -4) ch = THIN.charAt(Math.min(3, Math.floor(-d)));
      else ch = w > 0.6 ? ':' : '.';
      if (i < cut) filled += ch; else rest += ch;
    }
    return { filled: filled, rest: rest };
  }

  // ---------------------------------------------------------------------------
  // 状态
  // ---------------------------------------------------------------------------

  var doc = global.document || null;
  var reduceMotion = !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var now = function () { return Date.now(); };

  var typicalStore = {};
  try {
    var saved = JSON.parse(global.localStorage.getItem(STORE_KEY) || '{}');
    if (saved && typeof saved === 'object') typicalStore = saved;
  } catch (e) { /* 无痕模式等：只用默认值 */ }

  function typicalOf(route) {
    var learned = Number(typicalStore[route]);
    if (learned > 0) return learned;
    return (ROUTES[route] && ROUTES[route].typical) || DEFAULT_TYPICAL_MS;
  }

  function learnTypical(route, durationMs) {
    if (durationMs < SLOW_SAMPLE_MS) return;
    typicalStore[route] = blendTypical(Number(typicalStore[route]) || 0, durationMs);
    try { global.localStorage.setItem(STORE_KEY, JSON.stringify(typicalStore)); } catch (e) { /* ignore */ }
  }

  var hosts = new Map();   // selector → host
  var pending = [];        // 在途请求，按发出顺序
  var batch = null;        // { startedAt, total, done }：从第一个请求发出到全部回来算一轮
  var tickTimer = null;
  var seq = 0;

  function hostFor(sel) {
    var host = hosts.get(sel);
    if (!host) {
      host = { sel: sel, el: null, got: {}, loaded: false, pending: [], idleSince: 0, reval: {}, veil: null, hair: null };
      hosts.set(sel, host);
    }
    if (doc && (!host.el || !host.el.isConnected)) {
      host.el = doc.querySelector(sel);
      if (host.el && host.el.classList) {
        host.el.classList.add('lv-host');
        // 等待层要相对卡片定位；卡片本身已定位时不动它
        var pos = global.getComputedStyle ? global.getComputedStyle(host.el).position : 'relative';
        if (pos === 'static') host.el.classList.add('lv-host-rel');
      }
    }
    return host;
  }

  // ---------------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------------

  function el(tag, cls, text) {
    var node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
  }

  function buildVeil(rec) {
    var veil = el('div', 'lv-veil');
    var plate = el('div', 'lv-plate');
    var tide = el('div', 'lv-tide');
    tide.setAttribute('aria-hidden', 'true');
    var filled = el('b');
    var rest = el('span');
    tide.appendChild(filled);
    tide.appendChild(rest);
    var line = el('div', 'lv-line');
    var what = el('span', 'lv-what', '取数中 · ' + rec.label);
    what.setAttribute('role', 'status');
    var clock = el('span', 'lv-clock');
    clock.setAttribute('aria-hidden', 'true');
    line.appendChild(what);
    line.appendChild(clock);
    var sub = el('div', 'lv-sub');
    plate.appendChild(tide);
    plate.appendChild(line);
    plate.appendChild(sub);
    veil.appendChild(plate);
    veil._lv = { filled: filled, rest: rest, what: what, clock: clock, sub: sub };
    return veil;
  }

  function showVeil(host, rec, t) {
    if (!host.el) return;
    if (!host.veil || host.veil.parentNode !== host.el) {
      if (host.veil) host.veil.remove();
      host.veil = buildVeil(rec);
      host.el.appendChild(host.veil);
      host.el.classList.add('lv-veiled');
      host.el.setAttribute('aria-busy', 'true');
      var veil = host.veil;
      // 下一帧再加 is-on，让淡入过渡生效
      global.setTimeout(function () { if (veil.isConnected) veil.classList.add('is-on'); }, 20);
    }
    var parts = host.veil._lv;
    var elapsed = t - rec.startedAt;
    var typical = typicalOf(rec.route);
    var line = tideLine(estimateProgress(elapsed, typical), reduceMotion ? 0 : t / 1000, TIDE_CELLS);
    parts.filled.textContent = line.filled;
    parts.rest.textContent = line.rest;
    parts.what.textContent = '取数中 · ' + rec.label;
    parts.clock.textContent = fmtSeconds(elapsed);
    parts.sub.textContent = phaseText(elapsed, typical);
  }

  function hideVeil(host) {
    var veil = host.veil;
    if (!veil) return;
    host.veil = null;
    if (host.el) {
      host.el.classList.remove('lv-veiled');
      host.el.removeAttribute('aria-busy');
    }
    veil.classList.remove('is-on');
    global.setTimeout(function () { veil.remove(); }, reduceMotion ? 0 : 380);
  }

  function showHair(host) {
    if (!host.el || (host.hair && host.hair.parentNode === host.el)) return;
    host.hair = el('i', 'lv-hair');
    host.hair.setAttribute('aria-hidden', 'true');
    host.el.appendChild(host.hair);
  }

  function hideHair(host) {
    if (!host.hair) return;
    host.hair.remove();
    host.hair = null;
  }

  var bar = null;
  function renderBar(t) {
    if (!doc || !doc.body) return;
    if (!batch) {
      if (bar) bar.classList.remove('is-on');
      return;
    }
    if (t - batch.startedAt < BAR_DELAY_MS) return;
    if (!bar) {
      bar = el('div', 'lv-bar');
      bar.setAttribute('aria-hidden', 'true');
      bar.appendChild(el('span'));
      doc.body.appendChild(bar);
    }
    var inFlight = 0;
    pending.forEach(function (rec) { inFlight += estimateProgress(t - rec.startedAt, typicalOf(rec.route)); });
    var p = batch.total ? (batch.done + inFlight) / batch.total : 0;
    bar.firstChild.style.transform = 'scaleX(' + Math.min(1, p).toFixed(4) + ')';
    bar.classList.add('is-on');
  }

  /** 该卡片是否有接口刚回了「旧数据 + 后台刷新中」。 */
  function isRevalidating(host, t) {
    for (var route in host.reval) {
      if (host.reval[route] > t) return true;
    }
    return false;
  }

  function render() {
    if (!doc) return;
    var t = now();
    hosts.forEach(function (host) {
      var rec = host.pending[0];
      if (!rec) {
        // 还差接口没回来的卡片：等待层多留一会儿，接上串行的下一个请求，免得闪一下
        var holding = host.veil && !host.loaded && t - host.idleSince < GRACE_MS;
        if (!holding) hideVeil(host);
        if (host.loaded && isRevalidating(host, t)) showHair(host); else hideHair(host);
        return;
      }
      var elapsed = t - rec.startedAt;
      if (!host.loaded) {
        if (host.veil || elapsed >= SHOW_DELAY_MS) showVeil(host, rec, t);
      } else {
        hideVeil(host);
        if (elapsed >= REFRESH_DELAY_MS || isRevalidating(host, t)) showHair(host);
      }
    });
    renderBar(t);
    if (!pending.length) {
      var anyVeil = false;
      hosts.forEach(function (host) { if (host.veil) anyVeil = true; });
      if (!anyVeil) stopTick();
    }
  }

  function startTick() {
    if (tickTimer || !doc) return;
    tickTimer = global.setInterval(render, TICK_MS);
  }

  function stopTick() {
    if (!tickTimer) return;
    global.clearInterval(tickTimer);
    tickTimer = null;
  }

  // ---------------------------------------------------------------------------
  // 请求生命周期
  // ---------------------------------------------------------------------------

  function begin(route) {
    var def = ROUTES[route] || null;
    var rec = {
      id: ++seq,
      route: route,
      label: def ? def.label : route.replace('/api/', ''),
      startedAt: now(),
      hosts: def ? def.cards.map(hostFor) : [],
      done: false
    };
    pending.push(rec);
    rec.hosts.forEach(function (host) { host.pending.push(rec); });
    if (!batch) batch = { startedAt: rec.startedAt, total: 0, done: 0 };
    batch.total++;
    startTick();
    return rec;
  }

  function finish(rec, ok) {
    if (rec.done) return;
    rec.done = true;
    var i = pending.indexOf(rec);
    if (i >= 0) pending.splice(i, 1);
    var t = now();
    rec.hosts.forEach(function (host) {
      var j = host.pending.indexOf(rec);
      if (j >= 0) host.pending.splice(j, 1);
      if (!host.pending.length) host.idleSince = t;
      if (ok) {
        host.got[rec.route] = true;
        host.loaded = (NEEDS[host.sel] || []).every(function (route) { return host.got[route]; });
      }
      if (ok && rec.revalidating) host.reval[rec.route] = t + REVALIDATE_HOLD_MS;
      else delete host.reval[rec.route];
    });
    if (ok && rec.revalidating) global.setTimeout(render, REVALIDATE_HOLD_MS + 50);
    if (ok) learnTypical(rec.route, t - rec.startedAt);
    if (batch) batch.done++;
    if (!pending.length) {
      // 本轮结束：总进度线先走满，稍后淡出。tick 继续跑到所有等待层撤完 (见 render)
      if (bar) bar.firstChild.style.transform = 'scaleX(1)';
      var ended = batch;
      global.setTimeout(function () { if (batch === ended && !pending.length) { batch = null; render(); } }, 260);
    }
    render();
  }

  /** 响应体被调用方读完 (json/text) 才算取数结束，这样等待层撤掉时渲染器已经画完。 */
  function watchBody(rec, resp) {
    if (!resp || !resp.ok) {
      finish(rec, false);
      return;
    }
    var settled = false;
    var fallback = null;
    var settle = function (ok) {
      if (settled) return;
      settled = true;
      if (fallback) global.clearTimeout(fallback);
      global.setTimeout(function () { finish(rec, ok); }, SETTLE_MS);
    };
    ['json', 'text'].forEach(function (method) {
      if (typeof resp[method] !== 'function') return;
      var orig = resp[method].bind(resp);
      try {
        resp[method] = function () {
          return orig().then(function (value) {
            // 本站约定：{ code: 0 } 才是成功载荷
            var bad = method === 'json' && value && typeof value.code === 'number' && value.code !== 0;
            if (method === 'json' && value && value.revalidating === true) rec.revalidating = true;
            settle(!bad);
            return value;
          }, function (err) {
            settle(false);
            throw err;
          });
        };
      } catch (e) { /* 只读 Response：走下面的兜底 */ }
    });
    fallback = global.setTimeout(function () { settle(true); }, BODY_FALLBACK_MS);
  }

  var nativeFetch = global.fetch;
  if (typeof nativeFetch === 'function') {
    global.fetch = function (input, init) {
      var route = null;
      try { route = routeOf(input, global.location && global.location.href); } catch (e) { route = null; }
      var promise = nativeFetch.call(global, input, init);
      if (!route) return promise;
      var rec = begin(route);
      return promise.then(function (resp) {
        try { watchBody(rec, resp); } catch (e) { finish(rec, false); }
        return resp;
      }, function (err) {
        finish(rec, false);
        throw err;
      });
    };
  }

  global.LoadVeil = {
    /** 当前在途请求与各卡片是否已取到过数据 (调试 / 测试用)。 */
    snapshot: function () {
      var loaded = {};
      hosts.forEach(function (host, sel) { loaded[sel] = host.loaded; });
      var revalidating = {};
      hosts.forEach(function (host, sel) { if (isRevalidating(host, now())) revalidating[sel] = true; });
      return {
        revalidating: revalidating,
        pending: pending.map(function (rec) { return { route: rec.route, label: rec.label, elapsedMs: now() - rec.startedAt }; }),
        batch: batch ? { total: batch.total, done: batch.done } : null,
        loaded: loaded
      };
    },
    ROUTES: ROUTES,
    _pure: {
      routeOf: routeOf,
      estimateProgress: estimateProgress,
      fmtSeconds: fmtSeconds,
      phaseText: phaseText,
      blendTypical: blendTypical,
      tideLine: tideLine
    },
    _setClock: function (fn) { now = fn; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
