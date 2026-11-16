/**
 * public/load_veil.js — 取数等待层的 VM 测试 (无 DOM)。
 *
 * 覆盖：请求路由识别、估算进度的边界、潮线定长、文案分档，以及包裹 fetch 之后
 * 的生命周期——响应体读完才算结束、多接口卡片要各成功一次才算取到数据、
 * 失败 / 非 0 code 不算成功、非 /api 请求原样放行。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'load_veil.js'), 'utf8');

function fakeResponse({ ok = true, body = { code: 0 } } = {}) {
  return {
    ok,
    status: ok ? 200 : 502,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body))
  };
}

/** 载入脚本：fetch 由测试手动兑现，定时器走真实时钟 (全部是短延时)。 */
function load() {
  const calls = [];
  const store = {};
  const win = {
    setTimeout, clearTimeout, setInterval, clearInterval, URL,
    location: { href: 'http://localhost:3000/' },
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); }
    },
    fetch(input, init) {
      return new Promise((resolve, reject) => calls.push({ input, init, resolve, reject }));
    }
  };
  win.window = win;
  vm.runInNewContext(SRC, win);
  return { win, calls, store, lv: win.LoadVeil };
}

const settle = () => new Promise(r => setTimeout(r, 140)); // > SETTLE_MS

describe('load_veil 纯函数', () => {
  const { lv } = load();
  const P = lv._pure;

  it('routeOf 只认同源 /api/*，并忽略自检接口', () => {
    const base = 'http://localhost:3000/';
    assert.strictEqual(P.routeOf('/api/market-data?threshold=1&timeRange=all', base), '/api/market-data');
    assert.strictEqual(P.routeOf('http://localhost:3000/api/cdri', base), '/api/cdri');
    assert.strictEqual(P.routeOf({ url: 'http://localhost:3000/api/ssro?x=1' }, base), '/api/ssro');
    assert.strictEqual(P.routeOf('https://api.binance.com/api/v3/klines', base), null);
    assert.strictEqual(P.routeOf('//evil.example/api/x', base), null);
    assert.strictEqual(P.routeOf('/style.css', base), null);
    assert.strictEqual(P.routeOf('/api/system/health', base), null);
    assert.strictEqual(P.routeOf('', base), null);
    assert.strictEqual(P.routeOf(null, base), null);
  });

  it('estimateProgress 单调递增、从 0 起步、永不到 1', () => {
    assert.strictEqual(P.estimateProgress(0, 4000), 0);
    let prev = -1;
    for (const t of [0, 500, 2000, 4000, 8000, 60000, 600000]) {
      const p = P.estimateProgress(t, 4000);
      assert.ok(p >= prev, `非单调 @${t}`);
      assert.ok(p < 1);
      prev = p;
    }
    assert.ok(Math.abs(P.estimateProgress(4000, 4000) - 0.798) < 0.01, '到通常耗时约 80%');
    assert.strictEqual(P.estimateProgress(600000, 4000), 0.97);
    assert.ok(Number.isFinite(P.estimateProgress(NaN, 0)), '坏输入不产生 NaN');
    assert.strictEqual(P.estimateProgress(-50, 4000), 0);
  });

  it('tideLine 两段拼起来恒为 n 个字符，已涨部分随进度变长', () => {
    for (const p of [0, 0.01, 0.33, 0.5, 0.97, 1, 5, -1, NaN]) {
      for (const t of [0, 1.7, 99.3]) {
        const line = P.tideLine(p, t, 28);
        assert.strictEqual((line.filled + line.rest).length, 28, `p=${p} t=${t}`);
        assert.ok(!/undefined/.test(line.filled + line.rest));
      }
    }
    assert.strictEqual(P.tideLine(0, 0, 28).filled.length, 0);
    assert.strictEqual(P.tideLine(1, 0, 28).rest.length, 0);
    assert.ok(P.tideLine(0.75, 0, 28).filled.length > P.tideLine(0.25, 0, 28).filled.length);
  });

  it('phaseText 先给参照耗时，再说慢，过 12 秒才提冷启动', () => {
    assert.strictEqual(P.phaseText(1000, 4000), '通常约 4.0s');
    assert.match(P.phaseText(7000, 4000), /比平时慢/);
    assert.match(P.phaseText(13000, 4000), /休眠/);
    assert.match(P.phaseText(13000, 60000), /休眠/);
  });

  it('fmtSeconds / blendTypical', () => {
    assert.strictEqual(P.fmtSeconds(3240), '3.2s');
    assert.strictEqual(P.fmtSeconds(14600), '15s');
    assert.strictEqual(P.blendTypical(0, 5000), 5000);
    assert.strictEqual(P.blendTypical(5000, 10000), 7000);
  });
});

describe('load_veil 包裹 fetch 后的生命周期', () => {
  it('非 /api 请求原样放行，不计入在途', async () => {
    const { win, calls, lv } = load();
    const p = win.fetch('https://api.binance.com/api/v3/klines');
    assert.strictEqual(lv.snapshot().pending.length, 0);
    const resp = fakeResponse();
    calls[0].resolve(resp);
    assert.strictEqual(await p, resp);
  });

  it('响应体读完才算结束，并把参数原样交给原生 fetch', async () => {
    const { win, calls, lv } = load();
    const init = { method: 'GET' };
    const p = win.fetch('/api/cdri?force=1', init);
    assert.strictEqual(calls[0].input, '/api/cdri?force=1');
    assert.strictEqual(calls[0].init, init);
    assert.strictEqual(lv.snapshot().pending.map(x => x.route).join(','), '/api/cdri');
    assert.strictEqual(lv.snapshot().loaded['#module-cdri'], false);

    calls[0].resolve(fakeResponse({ body: { code: 0, value: 42 } }));
    const resp = await p;
    assert.strictEqual(lv.snapshot().pending.length, 1, '只到响应头，渲染器还没拿到数据');

    const json = await resp.json();
    assert.strictEqual(json.value, 42, '响应内容不被改动');
    await settle();
    assert.strictEqual(lv.snapshot().pending.length, 0);
    assert.strictEqual(lv.snapshot().loaded['#module-cdri'], true);
    await new Promise(r => setTimeout(r, 300));
    assert.strictEqual(lv.snapshot().batch, null, '本轮结束后总进度线收尾');
  });

  it('挂在多个接口下的卡片，要各成功一次才算取到数据', async () => {
    const { win, calls, lv } = load();
    const a = win.fetch('/api/market-data?threshold=30000000&timeRange=all');
    calls[0].resolve(fakeResponse());
    await (await a).json();
    await settle();
    assert.strictEqual(lv.snapshot().loaded['#module-gex'], true);
    assert.strictEqual(lv.snapshot().loaded['#module-term-premium'], false, '还差 /api/term-premium');

    const b = win.fetch('/api/term-premium');
    calls[1].resolve(fakeResponse());
    await (await b).json();
    await settle();
    assert.strictEqual(lv.snapshot().loaded['#module-term-premium'], true);
  });

  it('HTTP 失败、网络错误、code≠0 都不算取到数据，且错误照常抛给调用方', async () => {
    const { win, calls, lv } = load();

    const a = win.fetch('/api/ssro');
    calls[0].resolve(fakeResponse({ ok: false }));
    assert.strictEqual((await a).status, 502);
    assert.strictEqual(lv.snapshot().pending.length, 0);
    assert.strictEqual(lv.snapshot().loaded['#module-ssro-chart'], false);

    const b = win.fetch('/api/ssro');
    calls[1].reject(new Error('network down'));
    await assert.rejects(b, /network down/);
    assert.strictEqual(lv.snapshot().pending.length, 0);

    const c = win.fetch('/api/ssro');
    calls[2].resolve(fakeResponse({ body: { code: 500, error: 'upstream' } }));
    await (await c).json();
    await settle();
    assert.strictEqual(lv.snapshot().pending.length, 0);
    assert.strictEqual(lv.snapshot().loaded['#module-ssro-chart'], false);
  });

  it('只把慢请求记入通常耗时', async () => {
    const { win, calls, store, lv } = load();
    let clock = 1000000;
    lv._setClock(() => clock);

    const fast = win.fetch('/api/cdri');
    calls[0].resolve(fakeResponse());
    await (await fast).json();
    await settle();
    assert.strictEqual(store.bigdy_lv_typical, undefined, '快请求不写入');

    const slow = win.fetch('/api/cdri');
    clock += 6000;
    calls[1].resolve(fakeResponse());
    await (await slow).json();
    await settle();
    assert.strictEqual(JSON.parse(store.bigdy_lv_typical)['/api/cdri'], 6000);
  });
});
