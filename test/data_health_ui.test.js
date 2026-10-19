/**
 * Phase 3C/E — public/data_health_ui.js VM tests on a light fake DOM.
 *
 * Covers: partial/degraded gating, fallback, unknown, local clock expiry via
 * the 10s tick (no network), fetch failure preserving last-good, recovery,
 * XSS-safe banner text, and one bad card never hiding a healthy sibling.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'data_health_ui.js'), 'utf8');

function makeEl(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    parentNode: null,
    _connected: true,
    textContent: '',
    className: '',
    dataset: {},
    _attrs: {},
    get isConnected() { return el._connected; },
    get firstChild() { return el.children[0] || null; },
    setAttribute(k, v) { el._attrs[k] = String(v); },
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
    querySelector() { return null; },   // no .card-header in the fake card → banner becomes firstChild
    querySelectorAll() { return []; }
  };
  return el;
}

function allText(el) {
  let out = el.textContent || '';
  el.children.forEach(c => { out += '|' + allText(c); });
  return out;
}
function allTags(el, acc = []) {
  acc.push(el.tagName);
  el.children.forEach(c => allTags(c, acc));
  return acc;
}

function makeWorld() {
  let nowMs = 1_800_000_000_000;
  class FakeDate extends Date { static now() { return nowMs; } }
  const selectorMap = new Map();
  const document = {
    querySelector: sel => (selectorMap.get(sel) || [])[0] || null,
    querySelectorAll: sel => selectorMap.get(sel) || [],
    createElement: tag => makeEl(tag)
  };
  const sandbox = {
    document, console,
    setInterval: () => 0,
    Date: FakeDate,
    window: {}
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  const UI = sandbox.window.DataHealthUI;
  return { UI, selectorMap, advance: ms => { nowMs += ms; }, now: () => nowMs };
}

function okSource(now, extra = {}) {
  return {
    state: 'OK', usable: true, available: true,
    lastSuccessAt: new Date(now).toISOString(),
    dataAsOf: new Date(now).toISOString(),
    policy: { fetchWarnMs: 60000, fetchBlockMs: 600000, dataWarnMs: 120000, dataBlockMs: 600000 },
    ...extra
  };
}

function mountModule(UI, selectorMap, id) {
  const card = makeEl();
  const live = makeEl();
  selectorMap.set(`#card-${id}`, [card]);
  selectorMap.set(`#live-${id}`, [live]);
  UI.register(id, { card: `#card-${id}`, live: [`#live-${id}`] });
  return { card, live };
}

describe('DataHealthUI', () => {
  it('partial health: one unusable required source blocks conclusions with a pause note', () => {
    const { UI, selectorMap, now } = makeWorld();
    const { card, live } = mountModule(UI, selectorMap, 'm1');
    UI.update('m1', {
      state: 'DEGRADED', analysisAllowed: false,
      sources: {
        good: okSource(now()),
        bad: { state: 'UNAVAILABLE', usable: false, available: false, lastError: 'HTTP 503' }
      }
    });
    assert.ok(live.hasAttribute('data-health-blocked'), 'live conclusions locked');
    assert.strictEqual(card.dataset.healthState, 'blocked');
    assert.ok(card.hasAttribute('data-historical-only'));
    const note = card.children.find(c => c.className === 'dh-pause-note');
    assert.ok(note, 'pause note inserted');
    assert.match(note.textContent, /暂停当前研判/);
    const banner = card.children.find(c => (c.className || '').includes('dh-banner'));
    assert.ok(banner, 'banner inserted');
    assert.match(allText(banner), /HTTP 503/);
  });

  it('fallback summary keeps conclusions live and shows 备用源', () => {
    const { UI, selectorMap, now } = makeWorld();
    const { live } = mountModule(UI, selectorMap, 'm1');
    UI.update('m1', {
      state: 'FALLBACK', analysisAllowed: true,
      sources: { a: okSource(now(), { source: 'disk', issues: ['served from disk'] }) }
    });
    assert.ok(!live.hasAttribute('data-health-blocked'));
    const mod = UI._modules.get('m1');
    assert.match(allText(mod.banner), /备用源/);
  });

  it('unknown health labels 未核验 AND locks live conclusions (fail closed)', () => {
    const { UI, selectorMap } = makeWorld();
    const { card, live } = mountModule(UI, selectorMap, 'm1');
    UI.update('m1', { state: 'UNKNOWN', analysisAllowed: false, sources: {} });
    const mod = UI._modules.get('m1');
    assert.match(allText(mod.banner), /未核验/);
    // Unverified data can never underwrite a live conclusion: the label stays
    // 未核验 but the lock is the same as an expired/unusable block.
    assert.ok(live.hasAttribute('data-health-blocked'));
    assert.strictEqual(card.dataset.healthState, 'blocked');
    assert.ok(card.hasAttribute('data-historical-only'));
  });

  it('naked aggregate OK with zero sources is never trusted indefinitely', () => {
    const { UI, selectorMap } = makeWorld();
    const { live } = mountModule(UI, selectorMap, 'm1');
    UI.update('m1', { state: 'OK', analysisAllowed: true, sources: {} });
    assert.ok(live.hasAttribute('data-health-blocked'), 'no per-source clocks/policy → fail closed');
  });

  it('missing policy or missing clocks fail closed even under an OK aggregate', () => {
    const { UI, selectorMap, now } = makeWorld();
    const { live } = mountModule(UI, selectorMap, 'm1');
    UI.update('m1', {
      state: 'OK', analysisAllowed: true,
      sources: { a: okSource(now(), { policy: null }) }
    });
    assert.ok(live.hasAttribute('data-health-blocked'), 'missing policy → blocked');
    UI.update('m1', {
      state: 'OK', analysisAllowed: true,
      sources: { a: okSource(now(), { lastSuccessAt: null }) }
    });
    assert.ok(live.hasAttribute('data-health-blocked'), 'missing receipt clock → blocked');
  });

  it('warn threshold reached locally renders STALE, never green', () => {
    const { UI, selectorMap, advance, now } = makeWorld();
    const { card, live } = mountModule(UI, selectorMap, 'm1');
    UI.update('m1', { state: 'OK', analysisAllowed: true, sources: { a: okSource(now()) } });
    advance(120_001); // past fetchWarnMs 60000, within fetchBlockMs 600000
    UI._tick();
    assert.ok(!live.hasAttribute('data-health-blocked'), 'still within block windows → conclusions live');
    assert.strictEqual(card.dataset.healthState, 'stale');
    const mod = UI._modules.get('m1');
    assert.match(allText(mod.banner), /旧缓存/);
  });

  it('pause note is created once — repeated ticks never duplicate it', () => {
    const { UI, selectorMap, advance, now } = makeWorld();
    const { card, live } = mountModule(UI, selectorMap, 'm1');
    UI.update('m1', {
      state: 'DEGRADED', analysisAllowed: false,
      sources: { bad: { state: 'UNAVAILABLE', usable: false, available: false, lastError: 'HTTP 503' } }
    });
    assert.ok(live.hasAttribute('data-health-blocked'));
    const count = () => card.children.filter(c => c.className === 'dh-pause-note').length;
    assert.strictEqual(count(), 1);
    for (let i = 0; i < 5; i++) { advance(10_000); UI._tick(); }
    assert.strictEqual(count(), 1, 'ticks must reuse the same pause note');
  });

  it('lastGoodAt comes from the real source receipt, never Date.now()', () => {
    const { UI, selectorMap, now } = makeWorld();
    mountModule(UI, selectorMap, 'm1');
    const receipt = now() - 42_000;
    UI.update('m1', {
      state: 'OK', analysisAllowed: true,
      sources: { a: okSource(now(), { lastSuccessAt: new Date(receipt).toISOString() }) }
    });
    const mod = UI._modules.get('m1');
    assert.strictEqual(mod.lastGoodAt, receipt, 'lastGoodAt must equal the source lastSuccessAt');
  });

  it('normal banner also shows real data date and last success', () => {
    const { UI, selectorMap, now } = makeWorld();
    mountModule(UI, selectorMap, 'm1');
    UI.update('m1', { state: 'OK', analysisAllowed: true, sources: { a: okSource(now()) } });
    const mod = UI._modules.get('m1');
    assert.match(allText(mod.banner), /数据 /);
    assert.match(allText(mod.banner), /最后成功 /);
  });

  it('local clock expiry: a 10s tick ages data out without any new fetch', () => {
    const { UI, selectorMap, advance, now } = makeWorld();
    const { live } = mountModule(UI, selectorMap, 'm1');
    UI.update('m1', { state: 'OK', analysisAllowed: true, sources: { a: okSource(now()) } });
    assert.ok(!live.hasAttribute('data-health-blocked'));
    advance(700_000); // past fetchBlockMs 600000 — no new update() call
    UI._tick();
    assert.ok(live.hasAttribute('data-health-blocked'), 'tick expired the module locally');
  });

  it('fetch failure preserves last-good (FALLBACK banner), then expiry still blocks', () => {
    const { UI, selectorMap, advance, now } = makeWorld();
    const { live } = mountModule(UI, selectorMap, 'm1');
    UI.update('m1', { state: 'OK', analysisAllowed: true, sources: { a: okSource(now()) } });
    UI.fail('m1', new Error('network unreachable'));
    const mod = UI._modules.get('m1');
    assert.ok(!live.hasAttribute('data-health-blocked'), 'last-good still within windows → not blocked');
    assert.match(allText(mod.banner), /备用源/, 'error + usable last-good renders fallback');
    assert.match(allText(mod.banner), /network unreachable/);
    advance(700_000);
    UI._tick();
    assert.ok(live.hasAttribute('data-health-blocked'), 'last-good clock ages out');
  });

  it('recovery: a fresh usable update unblocks conclusions and clears the pause note', () => {
    const { UI, selectorMap, advance, now } = makeWorld();
    const { card, live } = mountModule(UI, selectorMap, 'm1');
    UI.update('m1', { state: 'OK', analysisAllowed: true, sources: { a: okSource(now()) } });
    advance(700_000);
    UI._tick();
    assert.ok(live.hasAttribute('data-health-blocked'));
    UI.update('m1', { state: 'OK', analysisAllowed: true, sources: { a: okSource(now()) } });
    assert.ok(!live.hasAttribute('data-health-blocked'));
    assert.ok(!card.hasAttribute('data-historical-only'));
    assert.ok(!card.children.some(c => c.className === 'dh-pause-note'), 'pause note removed');
  });

  it('banner text is XSS-safe: markup renders as literal text, never as elements', () => {
    const { UI, selectorMap } = makeWorld();
    const { card } = mountModule(UI, selectorMap, 'm1');
    const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    UI.update('m1', {
      state: 'DEGRADED', analysisAllowed: false,
      sources: { bad: { state: 'UNAVAILABLE', usable: false, lastError: evil, dataAsOf: new Date().toISOString(), lastSuccessAt: new Date().toISOString() } }
    });
    const banner = card.children.find(c => (c.className || '').includes('dh-banner'));
    assert.ok(banner);
    const tags = allTags(banner);
    assert.ok(!tags.includes('IMG') && !tags.includes('SCRIPT'), 'no markup became elements');
    assert.ok(allText(banner).includes('<img src=x'), 'payload shown as literal text');
  });

  it('one blocked card never hides a healthy sibling card', () => {
    const { UI, selectorMap, now } = makeWorld();
    const a = mountModule(UI, selectorMap, 'mA');
    const b = mountModule(UI, selectorMap, 'mB');
    UI.update('mA', { state: 'UNAVAILABLE', analysisAllowed: false, sources: { x: { state: 'UNAVAILABLE', usable: false } } });
    UI.update('mB', { state: 'OK', analysisAllowed: true, sources: { y: okSource(now()) } });
    assert.ok(a.live.hasAttribute('data-health-blocked'));
    assert.ok(!b.live.hasAttribute('data-health-blocked'), 'healthy module untouched');
    assert.strictEqual(b.card.dataset.healthState, 'ok');
  });

  it('every registered card and live selector resolves against the real index.html', () => {
    const { UI } = makeWorld();
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
    const classes = new Set();
    for (const m of html.matchAll(/class="([^"]+)"/g)) m[1].split(/\s+/).forEach(c => classes.add(c));
    const failures = [];
    for (const [id, mod] of UI._modules) {
      if (!mod.cardSel) { failures.push(`${id}: no card selector`); continue; }
      for (const sel of [mod.cardSel, ...mod.liveSels]) {
        for (const tok of sel.match(/#([A-Za-z0-9_-]+)/g) || []) {
          if (!ids.has(tok.slice(1))) failures.push(`${id}: ${sel} → missing id ${tok}`);
        }
        for (const tok of sel.match(/\.([A-Za-z0-9_-]+)/g) || []) {
          if (!classes.has(tok.slice(1))) failures.push(`${id}: ${sel} → missing class ${tok}`);
        }
      }
    }
    assert.deepStrictEqual(failures, [], 'selectors must match real DOM');
  });

  it('registered modules cover every module id the loaders report (incl. liquidity_history)', () => {
    const { UI } = makeWorld();
    const required = [
      'options.atmIv', 'options.ivSmile', 'options.delta25Skew', 'options.gex',
      'options.blockTrades', 'term_premium', 'etf', 'macro', 'preferreds',
      'cdri', 'ssro', 'flow', 'coinbase', 'liquidity_history', 'gold',
      'block_insight', 'option_marks', 'mcclellan', 'wave'
    ];
    for (const id of required) {
      const mod = UI._modules.get(id);
      assert.ok(mod, `module ${id} must be registered`);
      assert.ok(mod.cardSel, `module ${id} must map to a card`);
    }
    // ETF must lock its green check list, not only the summary.
    const etf = UI._modules.get('etf');
    assert.ok(etf.liveSels.includes('#el-check-list'), 'etf live selectors must include #el-check-list');
    // Option cards must not hide their entire card body (history + pause note
    // live inside it). Live selectors may descend THROUGH .card-body but must
    // never target the body itself — check the final (rightmost) compound.
    for (const id of ['options.atmIv', 'options.ivSmile', 'options.delta25Skew', 'options.gex', 'options.blockTrades']) {
      const mod = UI._modules.get(id);
      assert.ok(!mod.liveSels.some(s => /\.card-body\b[^.#:\s]*$/.test(s.trim())),
        `${id} must not lock the whole .card-body (got ${mod.liveSels.join(', ')})`);
    }
  });
});
