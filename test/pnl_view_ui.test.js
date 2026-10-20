/**
 * Module 4 PV (PnL View) modal — first-open health-gating regression tests.
 *
 * Bug: #pnl-chart-wrapper is locked by the option_marks health gate at UNKNOWN
 * (display:none via [data-health-blocked]), so the first renderPnLView ran
 * echarts.init on a zero-size container. The only recovery was a 60ms resize
 * timer — a mark response slower than that left a permanently blank chart
 * until another card's open happened to reset it.
 *
 * Harness: extracts the REAL PV controller from public/app.js between the
 * "Dedicated Module 4 PnL Payoff View Controller" heading and the "Module 4B"
 * heading, plus the real helper functions it calls, and runs them in a VM with
 * a light fake DOM, the REAL public/data_health_ui.js (to exercise the actual
 * option_marks lock/unlock), the REAL public/pnl_engine.js, and an ECharts spy
 * recording init geometry, resize calls and setOption args.
 *
 * PNL_VIEW_APP_JS env var overrides the app.js under test (used to replay the
 * regression against a captured pre-fix copy).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP_JS = process.env.PNL_VIEW_APP_JS || path.join(__dirname, '..', 'public', 'app.js');
const APP_SRC = fs.readFileSync(APP_JS, 'utf8');
const DH_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'data_health_ui.js'), 'utf8');
const ENGINE_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'pnl_engine.js'), 'utf8');

const NOW = Date.UTC(2026, 11, 1, 4, 0, 0); // 2026-12-01 — fixtures expire 2026-12-26

// ---------------------------------------------------------------------------
// app.js source extraction (structural — no substring assertions on behavior)
// ---------------------------------------------------------------------------

function extractFunction(src, name) {
  const re = new RegExp(`function ${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) throw new Error(`helper function ${name} not found in app.js`);
  const open = src.indexOf('{', m.index);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) return src.slice(m.index, i + 1); }
  }
  throw new Error(`function ${name} body not closed`);
}

function extractPvController(src) {
  const headMark = '// Dedicated Module 4 PnL Payoff View Controller';
  const tailMark = '// Module 4B:';
  const hi = src.indexOf(headMark);
  const ti = src.indexOf(tailMark);
  if (hi < 0 || ti < 0 || ti <= hi) throw new Error('PV controller heading markers not found in app.js');
  const start = src.lastIndexOf('// ===', hi);
  const end = src.lastIndexOf('// ===', ti);
  return src.slice(start, end);
}

const PV_BLOCK = extractPvController(APP_SRC);
const PRELUDE = [
  'let dhRetickQueued = false;',
  'let currentMarketData = null;',
  'function closeModal() {}',
  ...['scheduleDhRetick', 'dhUpdate', 'dhFail', 'escapeHtml', 'getAppTheme',
      'getEchartsTheme', 'getChartThemeColors', 'formatUTC8',
      'formatUTC8TimeOnly', 'formatTimeWindowUTC8']
    .map(n => extractFunction(APP_SRC, n))
].join('\n');

// ---------------------------------------------------------------------------
// Light fake DOM
// ---------------------------------------------------------------------------

function descendants(el) {
  const out = [];
  for (const c of el.children) { out.push(c); out.push(...descendants(c)); }
  return out;
}

function simpleMatch(el, tok) {
  if (tok.startsWith('#')) return el.id === tok.slice(1);
  if (tok.startsWith('.')) return el.classList.contains(tok.slice(1));
  if (tok.startsWith('[')) {
    const m = tok.match(/^\[([a-zA-Z-]+)="?([^"\]]*)"?\]$/);
    return m ? el._attrs[m[1]] === m[2] : false;
  }
  return el.tagName === tok.toUpperCase();
}

function elIsHidden(el) {
  // Mirrors style.css: [data-health-blocked] { display: none !important; }
  for (let n = el; n; n = n.parentNode) {
    if (n._attrs && Object.prototype.hasOwnProperty.call(n._attrs, 'data-health-blocked')) return true;
  }
  return false;
}

function makeEl(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(),
    id: '',
    children: [],
    parentNode: null,
    _connected: true,
    textContent: '',
    innerHTML: '',
    className: '',
    dataset: {},
    _attrs: {},
    _handlers: {},
    _w: 0,
    _h: 0,
    get isConnected() { return el._connected; },
    get firstChild() { return el.children[0] || null; },
    get nextSibling() {
      if (!el.parentNode) return null;
      const i = el.parentNode.children.indexOf(el);
      return el.parentNode.children[i + 1] || null;
    },
    get classList() {
      const set = () => new Set(el.className.split(/\s+/).filter(Boolean));
      return {
        add: (...cs) => { const s = set(); cs.forEach(c => s.add(c)); el.className = [...s].join(' '); },
        remove: (...cs) => { const s = set(); cs.forEach(c => s.delete(c)); el.className = [...s].join(' '); },
        toggle: (c, force) => {
          const s = set();
          const want = force === undefined ? !s.has(c) : !!force;
          if (want) s.add(c); else s.delete(c);
          el.className = [...s].join(' ');
          return want;
        },
        contains: c => set().has(c)
      };
    },
    get clientWidth() { return elIsHidden(el) ? 0 : el._w; },
    get clientHeight() { return elIsHidden(el) ? 0 : el._h; },
    setAttribute(k, v) { el._attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(el._attrs, k) ? el._attrs[k] : null; },
    removeAttribute(k) { delete el._attrs[k]; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(el._attrs, k); },
    appendChild(n) { n.parentNode = el; el.children.push(n); return n; },
    insertBefore(n, ref) {
      n.parentNode = el;
      const i = ref ? el.children.indexOf(ref) : -1;
      if (i < 0) el.children.push(n); else el.children.splice(i, 0, n);
      return n;
    },
    remove() {
      if (el.parentNode) {
        const i = el.parentNode.children.indexOf(el);
        if (i >= 0) el.parentNode.children.splice(i, 1);
        el.parentNode = null;
      }
      el._connected = false;
    },
    addEventListener(t, fn) { (el._handlers[t] = el._handlers[t] || []).push(fn); },
    _fire(t, ev = {}) { (el._handlers[t] || []).forEach(f => f({ target: el, stopPropagation() {}, ...ev })); },
    querySelector(sel) {
      for (const part of sel.split(',')) {
        const p = part.trim();
        if (!p) continue;
        if (p.startsWith(':scope')) {
          const rest = p.replace(/^:scope\s*>\s*/, '');
          const hit = el.children.find(c => simpleMatch(c, rest));
          if (hit) return hit;
        } else {
          const hit = descendants(el).find(c => simpleMatch(c, p));
          if (hit) return hit;
        }
      }
      return null;
    },
    querySelectorAll(sel) {
      const out = [];
      for (const part of sel.split(',')) {
        const p = part.trim();
        if (!p) continue;
        if (p.startsWith(':scope')) {
          const rest = p.replace(/^:scope\s*>\s*/, '');
          out.push(...el.children.filter(c => simpleMatch(c, rest)));
        } else {
          out.push(...descendants(el).filter(c => simpleMatch(c, p)));
        }
      }
      return out;
    }
  };
  return el;
}

function buildPnlDom() {
  const root = makeEl('div');
  const byId = new Map();
  const reg = el => { if (el.id) byId.set(el.id, el); return el; };
  const child = (parent, el) => { parent.appendChild(el); return el; };

  const backdrop = reg(child(root, makeEl('div')));
  backdrop.id = 'pnl-modal-backdrop';
  backdrop.className = 'modal-backdrop';
  byId.set(backdrop.id, backdrop);

  const card = child(backdrop, makeEl('div'));
  card.id = 'pnl-modal-card';
  card.className = 'modal-card pnl-modal-card';
  byId.set(card.id, card);

  const header = child(card, makeEl('div'));
  header.className = 'modal-header';
  const closeBtn = child(header, makeEl('button'));
  closeBtn.id = 'btn-close-pnl-modal';
  byId.set(closeBtn.id, closeBtn);

  const body = child(card, makeEl('div'));
  body.className = 'modal-body pnl-modal-body';

  const kpiGrid = child(body, makeEl('div'));
  kpiGrid.className = 'pnl-kpi-grid';

  const unitToggle = child(body, makeEl('div'));
  unitToggle.id = 'pnl-unit-toggle';
  byId.set(unitToggle.id, unitToggle);
  const btnBtc = child(unitToggle, makeEl('button'));
  btnBtc.dataset.unit = 'BTC';
  btnBtc.className = 'active';
  const btnUsd = child(unitToggle, makeEl('button'));
  btnUsd.dataset.unit = 'USD';

  const daysSlider = child(body, makeEl('input'));
  daysSlider.id = 'pnl-days-slider';
  daysSlider.value = '0';
  byId.set(daysSlider.id, daysSlider);
  const ivSlider = child(body, makeEl('input'));
  ivSlider.id = 'pnl-iv-slider';
  ivSlider.value = '0';
  byId.set(ivSlider.id, ivSlider);
  const resetBtn = child(body, makeEl('button'));
  resetBtn.id = 'pnl-reset-btn';
  byId.set(resetBtn.id, resetBtn);

  const wrapper = child(body, makeEl('div'));
  wrapper.className = 'pnl-chart-wrapper';
  const container = child(wrapper, makeEl('div'));
  container.id = 'pnl-chart-container';
  container._w = 900;
  container._h = 400;
  byId.set(container.id, container);

  const positions = child(body, makeEl('div'));
  positions.className = 'pnl-positions';
  const posBody = child(positions, makeEl('tbody'));
  posBody.id = 'pnl-positions-body';
  byId.set(posBody.id, posBody);
  const posFoot = child(positions, makeEl('tfoot'));
  posFoot.id = 'pnl-positions-foot';
  byId.set(posFoot.id, posFoot);

  for (const id of [
    'pnl-modal-title', 'pnl-modal-meta', 'pnl-days-label', 'pnl-days-expiry-lbl',
    'pnl-iv-label', 'pnl-kpi-max-profit', 'pnl-kpi-max-profit-usd',
    'pnl-kpi-max-loss', 'pnl-kpi-max-loss-usd', 'pnl-kpi-bep',
    'pnl-kpi-bep-distance', 'pnl-kpi-cashflow', 'pnl-kpi-cashflow-desc',
    'pnl-greeks-meta'
  ]) {
    const e = child(body, makeEl('span'));
    e.id = id;
    byId.set(id, e);
  }

  const resolveAll = sel => {
    const out = [];
    for (const part of sel.split(',')) {
      const toks = part.trim().split(/\s+/).filter(Boolean);
      if (!toks.length) continue;
      let candidates;
      if (toks[0].startsWith('#')) {
        const first = byId.get(toks[0].slice(1));
        candidates = first ? [first] : [];
      } else {
        candidates = descendants(root).filter(e => simpleMatch(e, toks[0]));
      }
      for (let i = 1; i < toks.length; i++) {
        candidates = candidates.flatMap(c => descendants(c)).filter(e => simpleMatch(e, toks[i]));
      }
      out.push(...candidates);
    }
    return out;
  };

  const document = {
    documentElement: { getAttribute: () => null },
    getElementById: id => byId.get(id) || null,
    querySelector: sel => resolveAll(sel)[0] || null,
    querySelectorAll: sel => resolveAll(sel),
    createElement: tag => makeEl(tag)
  };

  return { root, document, byId, backdrop, card, body, wrapper, container, daysSlider, ivSlider, resetBtn, btnBtc, btnUsd };
}

// ---------------------------------------------------------------------------
// VM world: real PnLEngine + real DataHealthUI + real PV controller
// ---------------------------------------------------------------------------

function deferred() {
  let res, rej;
  const promise = new Promise((r, j) => { res = r; rej = j; });
  return { promise, resolve: res, reject: rej };
}

function makeWorld() {
  const dom = buildPnlDom();
  let nowMs = NOW;
  class FakeDate extends Date { static now() { return nowMs; } }

  const instances = [];
  const echartsSpy = {
    instances,
    init(domEl, theme) {
      const inst = {
        dom: domEl,
        theme,
        initWidth: domEl.clientWidth,
        initHeight: domEl.clientHeight,
        ops: [],
        setOption(opt, arg) {
          inst.ops.push({
            op: 'setOption', w: domEl.clientWidth, h: domEl.clientHeight, arg,
            seriesLens: (opt && opt.series || []).map(s => (s.data || []).length)
          });
        },
        resize() { inst.ops.push({ op: 'resize', w: domEl.clientWidth, h: domEl.clientHeight }); },
        dispose() { inst.ops.push({ op: 'dispose' }); },
        getWidth() { return domEl.clientWidth; },
        getHeight() { return domEl.clientHeight; }
      };
      instances.push(inst);
      return inst;
    }
  };

  const fetchCalls = [];
  const rafQueue = [];
  const winListeners = {};
  const window = {
    echarts: echartsSpy,
    addEventListener: (t, fn) => { (winListeners[t] = winListeners[t] || []).push(fn); },
    _listeners: winListeners
  };

  const sandbox = {
    document: dom.document,
    window,
    console,
    fetch: url => { const d = deferred(); fetchCalls.push({ url, deferred: d }); return d.promise; },
    requestAnimationFrame: cb => { rafQueue.push(cb); return rafQueue.length; },
    setTimeout,
    setInterval: () => 0,
    Date: FakeDate,
    echarts: echartsSpy
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);

  vm.runInContext(PRELUDE, sandbox, { filename: 'app.prelude.js' });
  vm.runInContext(ENGINE_SRC, sandbox, { filename: 'pnl_engine.js' });
  window.PnLEngine = sandbox.PnLEngine;
  vm.runInContext(DH_SRC, sandbox, { filename: 'data_health_ui.js' });
  vm.runInContext(PV_BLOCK, sandbox, { filename: 'app.pv.js' });

  const okResp = payload => ({ ok: true, status: 200, json: async () => payload });

  const world = {
    ...dom,
    window,
    UI: window.DataHealthUI,
    instances,
    fetchCalls,
    okResp,
    openPnLViewModal: (...a) => window.openPnLViewModal(...a),
    setMarketData: vm.runInContext('v => { currentMarketData = v; }', sandbox),
    getView: vm.runInContext('() => pnlViewState', sandbox),
    flushRaf: () => { const q = rafQueue.splice(0); q.forEach(cb => cb()); },
    setNow: ms => { nowMs = ms; },
    now: () => nowMs
  };
  return world;
}

const flushAsync = () => new Promise(r => setTimeout(r, 0));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WHALE_A = {
  blockId: 'BLK-A-0001', strategyNameZh: '看涨价差',
  dateTimeUTC8: '2026-12-01 10:00:00', timestamp: NOW,
  notionalUSDM: 1.25, indexPrice: 84000,
  legs: [
    { instrument: 'BTC-26DEC26-80000-C', direction: 'buy', amount: 10, price: 0.05, iv: 55 },
    { instrument: 'BTC-26DEC26-90000-C', direction: 'sell', amount: 10, price: 0.02, iv: 52 }
  ]
};
const WHALE_B = {
  blockId: 'BLK-B-0002', strategyNameZh: '熊市看跌',
  dateTimeUTC8: '2026-12-01 11:00:00', timestamp: NOW,
  notionalUSDM: 0.8, indexPrice: 84100,
  legs: [
    { instrument: 'BTC-26DEC26-85000-P', direction: 'buy', amount: 5, price: 0.06, iv: 58 },
    { instrument: 'BTC-26DEC26-75000-P', direction: 'sell', amount: 5, price: 0.015, iv: 60 }
  ]
};

function marketData() {
  return {
    indexPrice: 85000,
    atmIv: { iv1m: 50 },
    blockTrades: { whaleBlocks: [WHALE_A, WHALE_B], icebergClusters: [] }
  };
}

function healthyHealth(nowMs) {
  const iso = new Date(nowMs).toISOString();
  return {
    state: 'OK', analysisAllowed: true,
    sources: {
      option_marks: {
        id: 'option_marks', state: 'OK', usable: true, available: true,
        lastSuccessAt: iso, dataAsOf: iso,
        policy: { fetchWarnMs: 30000, fetchBlockMs: 600000, dataWarnMs: 60000, dataBlockMs: 600000 }
      }
    }
  };
}

function marksPayload(nowMs, instruments, over = {}) {
  const marks = {};
  for (const name of instruments) {
    marks[name] = { markIv: 45.5, markPrice: 0.021, underlyingPrice: 85200 };
  }
  return {
    code: 0, indexPrice: 85100, timestamp: new Date(nowMs).toISOString(),
    marks, dataHealth: healthyHealth(nowMs), ...over
  };
}

function unusableHealth(nowMs) {
  const h = healthyHealth(nowMs);
  h.state = 'UNAVAILABLE';
  h.analysisAllowed = false;
  h.sources.option_marks.usable = false;
  h.sources.option_marks.available = false;
  h.sources.option_marks.lastError = 'HTTP 503';
  return h;
}

const setOptionOps = inst => inst.ops.filter(o => o.op === 'setOption');

// ---------------------------------------------------------------------------

describe('PV modal first-open chart vs option_marks health gate', () => {

  it('cold UNKNOWN health: first open must not init a zero-size chart; deferred (>60ms) healthy marks draw it', async () => {
    const w = makeWorld();
    w.setMarketData(marketData());

    // Real DataHealthUI registers option_marks at load with no health → the
    // chart wrapper is locked before the first open.
    assert.ok(w.wrapper.hasAttribute('data-health-blocked'), 'precondition: wrapper health-blocked at UNKNOWN');
    assert.strictEqual(w.container.clientWidth, 0, 'hidden wrapper → zero-size chart container');

    w.openPnLViewModal('whale', 0);
    assert.strictEqual(w.instances.length, 0, 'must not echarts.init in a zero-size container');
    assert.strictEqual(w.fetchCalls.length, 1, 'live marks requested on open');

    // Response lands well after the old 60ms resize window would have elapsed.
    await sleep(120);
    w.fetchCalls[0].deferred.resolve(w.okResp(marksPayload(w.now(), WHALE_A.legs.map(l => l.instrument))));
    await flushAsync();

    assert.ok(!w.wrapper.hasAttribute('data-health-blocked'), 'healthy marks unlock the wrapper');
    assert.strictEqual(w.instances.length, 1, 'first usable render creates the chart');
    assert.ok(w.instances[0].initWidth > 0 && w.instances[0].initHeight > 0,
      `chart initialized at positive size (got ${w.instances[0].initWidth}x${w.instances[0].initHeight})`);
    const sopts = setOptionOps(w.instances[0]);
    assert.ok(sopts.length >= 1 && sopts[0].seriesLens.every(n => n > 0), 'series drawn with data — no second card needed');
  });

  it('unusable marks response keeps the gate locked (no zero-size init); reopen with healthy response draws', async () => {
    const w = makeWorld();
    w.setMarketData(marketData());

    w.openPnLViewModal('whale', 0);
    w.fetchCalls[0].deferred.resolve(w.okResp(marksPayload(w.now(), WHALE_A.legs.map(l => l.instrument), { dataHealth: unusableHealth(w.now()) })));
    await flushAsync();

    assert.ok(w.wrapper.hasAttribute('data-health-blocked'), 'unusable health keeps wrapper locked');
    assert.strictEqual(w.instances.length, 0, 'still no zero-size init');

    // Reopen the same card; still locked until the healthy response arrives.
    w.openPnLViewModal('whale', 0);
    assert.strictEqual(w.instances.length, 0);
    w.fetchCalls[1].deferred.resolve(w.okResp(marksPayload(w.now(), WHALE_A.legs.map(l => l.instrument))));
    await flushAsync();

    assert.ok(!w.wrapper.hasAttribute('data-health-blocked'));
    assert.strictEqual(w.instances.length, 1, 'reopen + healthy marks draws the chart without another-card workaround');
    assert.ok(w.instances[0].initWidth > 0);
    assert.ok(setOptionOps(w.instances[0])[0].seriesLens.every(n => n > 0));
  });

  it('existing chart re-measures synchronously before setOption when container geometry changed', async () => {
    const w = makeWorld();
    w.setMarketData(marketData());
    w.openPnLViewModal('whale', 0);
    w.fetchCalls[0].deferred.resolve(w.okResp(marksPayload(w.now(), WHALE_A.legs.map(l => l.instrument))));
    await flushAsync();
    const inst = w.instances[0];
    assert.strictEqual(inst.initWidth, 900);

    // Container resized (e.g. viewport change while modal closed) → reopen card B.
    w.container._w = 500;
    w.openPnLViewModal('whale', 1);
    const tail = inst.ops.slice(-2);
    assert.deepStrictEqual(tail.map(o => o.op), ['resize', 'setOption'],
      'resize must run synchronously before setOption on an existing instance');
    assert.strictEqual(tail[0].w, 500, 'resize saw the new container width');
  });

  it('day/IV/unit control renders keep replaceMerge series updates (zoom preserved), never a full reset', async () => {
    const w = makeWorld();
    w.setMarketData(marketData());
    w.openPnLViewModal('whale', 0);
    w.fetchCalls[0].deferred.resolve(w.okResp(marksPayload(w.now(), WHALE_A.legs.map(l => l.instrument))));
    await flushAsync();
    const inst = w.instances[0];
    const fullResets = () => setOptionOps(inst).filter(o => o.arg === true).length;
    assert.strictEqual(fullResets(), 1, 'only the open render does setOption(option, true)');

    w.daysSlider.value = '7';
    w.daysSlider._fire('input');
    w.flushRaf();
    w.ivSlider.value = '20';
    w.ivSlider._fire('input');
    w.flushRaf();
    w.btnUsd._fire('click');

    const after = setOptionOps(inst).slice(1);
    assert.strictEqual(after.length, 3, 'each control change re-rendered');
    for (const op of after) {
      assert.notStrictEqual(op.arg, true, 'control renders must not fully reset the chart');
      assert.ok(op.arg && typeof op.arg === 'object', 'merge-style setOption arg expected');
      assert.deepStrictEqual([...(op.arg.replaceMerge || [])], ['series'], 'control renders merge series, preserving zoom window');
    }
    assert.strictEqual(fullResets(), 1, 'no control render triggered a full reset');
    assert.strictEqual(w.instances.length, 1, 'same chart instance reused');
  });

  it('A → B while A’s marks request is unresolved: stale A response cannot overwrite B; returning to A shows A', async () => {
    const w = makeWorld();
    w.setMarketData(marketData());

    w.openPnLViewModal('whale', 0);          // A opens, request pending
    const title = w.document.getElementById('pnl-modal-title');
    assert.match(title.textContent, /BLK-A-0001/);

    w.openPnLViewModal('whale', 1);          // user moves to B before A resolves
    assert.strictEqual(w.fetchCalls.length, 2);
    w.fetchCalls[1].deferred.resolve(w.okResp(marksPayload(w.now(), WHALE_B.legs.map(l => l.instrument))));
    await flushAsync();
    assert.match(title.textContent, /BLK-B-0002/);
    const viewInstruments = () => [...w.getView().legs.map(l => l.instrument)];
    assert.deepStrictEqual(viewInstruments(), WHALE_B.legs.map(l => l.instrument),
      'active view legs are B’s instruments');
    const inst = w.instances[0];
    const optCount = setOptionOps(inst).length;

    w.fetchCalls[0].deferred.resolve(w.okResp(marksPayload(w.now(), WHALE_A.legs.map(l => l.instrument))));
    await flushAsync();
    assert.match(title.textContent, /BLK-B-0002/, 'stale A response must not rewrite the active B view');
    assert.deepStrictEqual(viewInstruments(), WHALE_B.legs.map(l => l.instrument),
      'stale A response must not swap the active legs');
    assert.strictEqual(setOptionOps(inst).length, optCount, 'stale A response must not re-render the chart');

    w.openPnLViewModal('whale', 0);          // back to A
    assert.match(title.textContent, /BLK-A-0001/, 'returning to A renders A, not stale B');
    assert.deepStrictEqual(viewInstruments(), WHALE_A.legs.map(l => l.instrument),
      'returning to A restores A’s legs, not stale B');
    w.fetchCalls[2].deferred.resolve(w.okResp(marksPayload(w.now(), WHALE_A.legs.map(l => l.instrument))));
    await flushAsync();
    assert.match(title.textContent, /BLK-A-0001/);
  });

  it('already-healthy option_marks at first open initializes immediately at positive size', async () => {
    const w = makeWorld();
    w.setMarketData(marketData());
    w.UI.update('option_marks', healthyHealth(w.now()));
    assert.ok(!w.wrapper.hasAttribute('data-health-blocked'));

    w.openPnLViewModal('whale', 0);
    assert.strictEqual(w.instances.length, 1, 'healthy gate → chart draws on the first render');
    assert.ok(w.instances[0].initWidth > 0 && w.instances[0].initHeight > 0);
    w.fetchCalls[0].deferred.resolve(w.okResp(marksPayload(w.now(), WHALE_A.legs.map(l => l.instrument))));
    await flushAsync();
  });
});
