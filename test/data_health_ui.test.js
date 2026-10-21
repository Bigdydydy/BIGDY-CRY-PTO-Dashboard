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

// ===========================================================================
// MstrDisclosuresUI — disclosure ledger truthfulness
// ===========================================================================
const MD_UI_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'mstr_disclosures_ui.js'), 'utf8');
const MD_SELS = ['#mstr-disclosures', '#mstr-disclosure-status', '#mstr-disclosure-summary',
  '#mstr-disclosure-events', '#mstr-disclosure-refresh', '#mstr-disclosure-filings-list',
  '#mstr-disclosure-announcements'];

function mdPayload(nowMs, overrides = {}) {
  const iso = new Date(nowMs).toISOString();
  const srcOk = () => ({ state: 'OK', lastAttemptAt: iso, lastSuccessAt: iso, lastError: null,
    policy: { fetchWarnMs: 600000, fetchBlockMs: 3600000 } });
  return {
    schemaVersion: 1, lastAttemptAt: iso, lastCompletedAt: iso,
    latest: { id: 'strategy-ledger:blt2', reportedOn: '2026-10-02', holdingsBtc: 1100,
      averageCostUsd: 50000, aggregateCostUsd: 55000000 },
    shares: { asOf: '2026-10-01', basicShares: 100000, assumedDilutedShares: 120000,
      fullyDilutedShares: null },
    capital: { id: 'strategy-capital:2026-10-02', asOf: '2026-10-02',
      cashUsd: 4833000000, debtUsd: 6714000000, prefUsd: 13556668500,
      annualDividendsUsd: 806.613, btcHoldings: 1100, basicShares: 100000 },
    instruments: [{ id: 'strategy-debt:bltc1', name: 'Convert 2028', notionalUsd: 1010000000,
      couponPct: 0.625, strikeUsd: 183.19, maturityDate: '2028-09-16' }],
    preferreds: [
      { id: 'strategy-pref:STRC', ticker: 'STRC', dividendPct: 12,
        nextPayoutDate: '2026-11-15', nextRecordDate: '2026-10-31', sharesOutstanding: 85982656 },
      { id: 'strategy-pref:STRF', ticker: 'STRF', dividendPct: 10,
        nextPayoutDate: '2026-12-31', nextRecordDate: '2026-12-15', sharesOutstanding: 12839689 }
    ],
    announcements: [
      { id: 'strategy-press:bltp1', uid: 'bltp1',
        title: 'Strategy Acquires 250 BTC and Repurchases $192 Million of STRC',
        publishedOn: '2026-10-02', type: 'Press Release',
        url: 'https://www.strategy.com/press/strategy-acquires-250-btc_10-02-2026',
        kinds: ['BTC_PURCHASE', 'STRC_REPURCHASE'], issues: [] },
      { id: 'strategy-press:bltp2', uid: 'bltp2',
        title: 'Strive Adds $50 Million of STRC to its Corporate Treasury',
        publishedOn: '2026-10-01', type: 'Press Release',
        url: 'https://www.strategy.com/press/strive-adds-50m-strc_10-01-2026',
        kinds: ['OTHER_MENTION'], issues: [] }
    ],
    events: [
      { id: 'strategy-ledger:blt2', reportedOn: '2026-10-02', type: 'BTC_PURCHASE', deltaBtc: 100,
        transactionAverageUsd: 50000, transactionCashUsd: 5000000, holdingsBtc: 1100,
        averageCostUsd: 50000, issues: [],
        sourceUrl: 'https://strategy.com/ledger', documentUrl: 'https://strategy.com/pdfs/x.pdf' },
      { id: 'strategy-ledger:blt1', reportedOn: '2026-10-01', type: 'BTC_PURCHASE', deltaBtc: 1000,
        transactionAverageUsd: 50000, transactionCashUsd: 50000000, holdingsBtc: 1000,
        averageCostUsd: 50000, issues: [],
        sourceUrl: 'https://strategy.com/ledger',
        documentUrl: 'https://www.sec.gov/Archives/edgar/data/1050446/x.htm' }
    ],
    revisionCount: 0,
    filings: [{ accession: 'x', form: '8-K', filedOn: '2026-10-02',
      documentUrl: 'https://www.sec.gov/Archives/edgar/data/1050446/000119312526000001/mstr.htm',
      status: 'contents_not_verified' }],
    officialMnav: null,
    reconciliationIssues: [],
    coverage: { btc: 'issuer_reported', shares: 'issuer_reported', sec: 'index_only',
      strc: 'announcements_only', capitalStructure: 'issuer_reported', officialMnav: 'not_computed' },
    dataHealth: { state: 'OK', summary: '', sources: {
      mstr_official_ledger: srcOk(), mstr_official_shares: srcOk(),
      mstr_official_capital: srcOk(), mstr_official_press: srcOk(), mstr_sec_index: srcOk(),
      mstr_mnav_inputs: srcOk() } },
    ...overrides
  };
}

// Self-contained fake DOM: no elements mounted at eval time, so the module's
// init() is a no-op and tests drive applyPayload/load explicitly.
function mdUiWorld(extra = {}) {
  let nowMs = Date.parse('2026-10-03T12:00:00Z');
  class FakeDate extends Date { static now() { return nowMs; } }
  const selectorMap = new Map();
  const document = {
    querySelector: sel => (selectorMap.get(sel) || [])[0] || null,
    querySelectorAll: sel => selectorMap.get(sel) || [],
    createElement: tag => makeEl(tag)
  };
  const sandbox = {
    document, console, URL, Date: FakeDate, window: {},
    setInterval: () => 0, clearInterval: () => {},
    fetch: extra.fetch || (async () => ({ ok: true, json: async () => mdPayload(nowMs) }))
  };
  vm.createContext(sandbox);
  vm.runInContext(MD_UI_SRC, sandbox);
  const mount = () => { for (const sel of MD_SELS) selectorMap.set(sel, [makeEl('div')]); };
  mount();
  return { sandbox, selectorMap, UI: sandbox.window.MstrDisclosuresUI,
    now: () => nowMs, advance: ms => { nowMs += ms; } };
}
const mdEl = (world, sel) => world.selectorMap.get(sel)[0];

describe('MstrDisclosuresUI', () => {
  it('renders latest facts, newest events, filings links and coverage captions', () => {
    const world = mdUiWorld();
    world.UI.applyPayload(mdPayload(world.now()));
    const eventsEl = mdEl(world, '#mstr-disclosure-events');
    assert.equal(eventsEl.children.length, 2);
    const summary = allText(mdEl(world, '#mstr-disclosure-summary'));
    assert.ok(summary.includes('1,100'));
    assert.ok(summary.includes('55,000,000'));
    assert.ok(summary.includes('披露日 2026-10-02'));
    assert.ok(summary.includes('asOf 2026-10-01'));
    assert.ok(summary.includes('120,000'));
    assert.ok(!/· FDSO/.test(summary), 'null FDSO stays absent, never shown as ADSO');
    assert.ok(summary.includes('ADSO 不是 FDSO'));
    assert.ok(summary.includes('SEC 当前仅发现申报'));
    // Milestone 2: capital snapshot line + preferred terms + coverage caption
    assert.ok(summary.includes('资本结构 (asOf 2026-10-02)'));
    assert.ok(summary.includes('债务 $6.71B'));
    assert.ok(summary.includes('优先股 $13.56B'));
    assert.ok(summary.includes('美元资产 $4.83B'));
    assert.ok(summary.includes('年化优先股股息 $807M'));
    assert.ok(summary.includes('STRC 12.0%'));
    assert.ok(summary.includes('下次派息 2026-11-15'));
    assert.ok(summary.includes('85,982,656 股'));
    assert.ok(summary.includes('资本结构 已接入官方快照'));
    assert.ok(summary.includes('STRC 仅公告发现'));
    const announcements = mdEl(world, '#mstr-disclosure-announcements').children;
    assert.equal(announcements.length, 2);
    const chips = el => el.children.filter(c => (c.className || '').includes('md-kind')).map(c => c.textContent);
    assert.deepEqual(chips(announcements[0]), ['BTC买入', 'STRC回购']);
    assert.deepEqual(chips(announcements[1]), ['提及']);
    assert.ok(allText(announcements[0]).includes('2026-10-02'));
    const annLink = announcements[0].children.find(c => c.tagName === 'A');
    assert.ok(annLink._attrs.href.startsWith('https://www.strategy.com/press/'));
    const filings = mdEl(world, '#mstr-disclosure-filings-list').children;
    assert.equal(filings.length, 1);
    assert.ok(allText(filings[0]).includes('申报已发现 · 正文待核验'));
    const link = filings[0].children.find(c => c.tagName === 'A');
    assert.ok(link._attrs.href.includes('sec.gov/Archives'));
    const status = allText(mdEl(world, '#mstr-disclosure-status'));
    assert.ok(status.includes('已检查'));
  });

  it('fetch failure keeps rows and says reading failed with old dates', async () => {
    const world = mdUiWorld({ fetch: async () => { throw new Error('boom'); } });
    world.UI.applyPayload(mdPayload(world.now()));
    await world.UI.load();
    const eventsEl = mdEl(world, '#mstr-disclosure-events');
    assert.equal(eventsEl.children.length, 2, 'rows survive a failed fetch');
    const status = allText(mdEl(world, '#mstr-disclosure-status'));
    assert.ok(status.includes('读取失败'));
    assert.ok(status.includes('保留上次披露'));
    assert.ok(status.includes(new Date(world.now()).toISOString().slice(0, 10)),
      'original receipt date retained, never fresh now');
  });

  it('aging receipt changes status to stale without a refetch', () => {
    const world = mdUiWorld();
    world.UI.applyPayload(mdPayload(world.now()));
    world.advance(700000); // past fetchWarnMs (600s)
    world.UI.renderStatus();
    const status = allText(mdEl(world, '#mstr-disclosure-status'));
    assert.ok(status.includes('STALE'), 'aged success receipt demotes status to STALE');
    assert.ok(!status.startsWith('已检查'));
  });

  it('unsafe evidence links are never rendered as anchors', () => {
    const world = mdUiWorld();
    const p = mdPayload(world.now());
    p.events[0].documentUrl = 'javascript:alert(1)';
    p.events[0].sourceUrl = 'javascript:alert(1)';
    world.UI.applyPayload(p);
    const rows = mdEl(world, '#mstr-disclosure-events').children;
    const td = rows[0].children[5];
    assert.ok(allText(td).includes('证据链接不可用'));
    assert.ok(!td.children.some(c => c.tagName === 'A'), 'no anchor emitted for unsafe URLs');
  });

  it('historical cost conflicts flag the affected row and warn in status', () => {
    const world = mdUiWorld();
    const p = mdPayload(world.now());
    p.events[1].issues = ['reported_cost_does_not_reconcile'];
    world.UI.applyPayload(p);
    const rows = mdEl(world, '#mstr-disclosure-events').children;
    assert.ok(rows[1].className.includes('md-row-flagged'));
    const status = allText(mdEl(world, '#mstr-disclosure-status'));
    assert.ok(status.includes('历史成本对账差异'));
  });

  it('announcement links follow the same HTTPS allowlist; unsafe URLs never render as anchors', () => {
    const world = mdUiWorld();
    const p = mdPayload(world.now());
    p.announcements[0].url = 'javascript:alert(1)';
    world.UI.applyPayload(p);
    const li = mdEl(world, '#mstr-disclosure-announcements').children[0];
    assert.ok(allText(li).includes('证据链接不可用'));
    assert.ok(!li.children.some(c => c.tagName === 'A'), 'no anchor emitted for unsafe URLs');
  });

  it('missing capital or empty announcements render honest fallbacks, never fabricated lines', () => {
    const world = mdUiWorld();
    const p = mdPayload(world.now(), { capital: null, preferreds: [], announcements: [] });
    world.UI.applyPayload(p);
    const summary = allText(mdEl(world, '#mstr-disclosure-summary'));
    assert.ok(!summary.includes('资本结构 (asOf'), 'no capital snapshot line when capital absent');
    assert.ok(summary.includes('资本结构 官方快照不可用'), 'absence is labelled, never hidden');
    const list = mdEl(world, '#mstr-disclosure-announcements');
    assert.equal(list.children.length, 1);
    assert.ok(allText(list).includes('尚无官方公告发现记录'));
  });

  it('renders the official mNAV line with methodology version, inputs and estimate label', () => {
    const world = mdUiWorld();
    const p = mdPayload(world.now(), {
      officialMnav: {
        computedAt: '2026-10-03T12:00:00.000Z',
        priceAsOf: '2026-10-03T11:58:00.000Z',
        mstrPriceUsd: 300, btcPriceUsd: 100000,
        btcSource: 'coinbase', mstrSource: 'yahoo',
        issues: [],
        result: {
          mnav: 1.8354, netBtcUsd: 72521464156, netBtcBtc: 725214.6416,
          netBpsUsd: 163.45, fdso: 443686678, usdAssetsUsd: 4833000000,
          claimsUsd: 17163235844, methodologyVersion: '2026-07-23',
          itmConverts: ['Convert 2028', 'Convert 2030 A', 'Convert 2031', 'Convert 2032'],
          otmConverts: ['Convert 2029', 'Convert 2030 B'], strkItm: false,
          strkConversionPrice: 1000.0531,
          fdsoBreakdown: { basic: 422353257, options: 3106115, rsu: 862703, converts: 17364603, strk: 0 },
          inputs: { mstrPriceUsd: 300, btcPriceUsd: 100000, capitalAsOf: '2026-10-19' },
          issues: []
        }
      },
      coverage: { ...mdPayload(world.now()).coverage, officialMnav: 'computed' }
    });
    world.UI.applyPayload(p);
    const summary = allText(mdEl(world, '#mstr-disclosure-summary'));
    assert.ok(summary.includes('官方口径 mNAV (2026-07-23 方法)'), 'methodology version shown');
    assert.ok(summary.includes('1.84×'));
    assert.ok(summary.includes('Net BPS $163.45'));
    assert.ok(summary.includes('FDSO 443.7M'));
    assert.ok(summary.includes('MSTR $300.00'), 'share price input shown');
    assert.ok(summary.includes('BTC $100,000.00'), 'BTC price input shown');
    assert.ok(summary.includes('coinbase'), 'price source labelled');
    assert.ok(summary.includes('11:58 UTC'), 'price receipt time shown');
    assert.ok(summary.includes('披露输入推算估计值'), 'values labelled as derived estimates');
    assert.ok(summary.includes('新旧口径不可比'), 'new/old methodology incomparability flagged');
  });

  it('absent or uncomputed official mNAV renders the honest 未计算 line with reasons', () => {
    const world = mdUiWorld();
    world.UI.applyPayload(mdPayload(world.now())); // officialMnav: null
    let summary = allText(mdEl(world, '#mstr-disclosure-summary'));
    assert.ok(summary.includes('官方口径 mNAV：输入不足，未计算'));
    assert.ok(!summary.includes('Net BPS $'), 'no fabricated value line');

    const p2 = mdPayload(world.now(), {
      officialMnav: {
        computedAt: '2026-10-03T12:00:00.000Z', priceAsOf: null,
        mstrPriceUsd: null, btcPriceUsd: 100000,
        btcSource: 'coinbase', mstrSource: 'yahoo',
        issues: ['invalid_mstr_price'], result: null
      }
    });
    world.UI.applyPayload(p2);
    summary = allText(mdEl(world, '#mstr-disclosure-summary'));
    assert.ok(summary.includes('官方口径 mNAV：输入不足，未计算'));
    assert.ok(summary.includes('invalid_mstr_price'), 'reason surfaces from the record');
  });
});
