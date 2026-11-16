/**
 * 先回旧数据、后台刷新 (server/swr.js) —— 全离线。
 *
 * 覆盖：raceStale 的四种结局；CDRI 在缓存过期时不再让请求等上游、旧数据如实标注、
 * 并发请求共用一轮取数、刷新完成后下一次请求拿到新数据；没有旧数据时照旧等上游；
 * 强制刷新照旧等上游。
 */
process.env.SWR_BUDGET_MS = '40'; // 必须在加载 server/swr.js 之前

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { installModuleMocks, srv, freshRequire, resetHealth, fakeResp } = require('./helpers/leaf_env');
const { raceStale, DEFAULT_BUDGET_MS } = require('../server/swr');

const HTTP = srv('http_client.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ===========================================================================
// raceStale
// ===========================================================================

test('SWR_BUDGET_MS 环境变量生效', () => {
  assert.equal(DEFAULT_BUDGET_MS, 40);
});

test('raceStale: 刷新在上限内完成 → 返回刷新结果，不带 revalidating', async () => {
  const out = await raceStale(Promise.resolve({ v: 'fresh' }), () => ({ v: 'stale' }), { budgetMs: 50 });
  assert.deepEqual(out, { v: 'fresh' });
});

test('raceStale: 刷新在上限内失败 → 返回旧数据；rethrow 时抛出原错误', async () => {
  const out = await raceStale(Promise.reject(new Error('boom')), () => ({ v: 'stale' }), { budgetMs: 50 });
  assert.deepEqual(out, { v: 'stale' });
  await assert.rejects(
    raceStale(Promise.reject(new Error('boom')), () => ({ v: 'stale' }), { budgetMs: 50, rethrow: true }),
    /boom/
  );
});

test('raceStale: 超过上限 → 旧数据 + revalidating，旧对象本身不被改动，迟到的失败不外泄', async () => {
  const gate = deferred();
  const stale = { v: 'stale' };
  const started = Date.now();
  const out = await raceStale(gate.promise, () => stale, { budgetMs: 30 });
  assert.ok(Date.now() - started < 500, '不等刷新');
  assert.deepEqual(out, { v: 'stale', revalidating: true });
  assert.equal(stale.revalidating, undefined);

  let unhandled = null;
  const onUnhandled = (err) => { unhandled = err; };
  process.once('unhandledRejection', onUnhandled);
  gate.reject(new Error('late failure'));
  await sleep(20);
  process.removeListener('unhandledRejection', onUnhandled);
  assert.equal(unhandled, null);
});

// ===========================================================================
// CDRI
// ===========================================================================

const cdriState = price => ({
  perf: { price, yesterday: 40, week: 50, month: 60, yearHigh: 90, yearLow: 10 },
  hist: {
    timeList: [nowSec() - 2 * 86400, nowSec() - 86400, nowSec()],
    valueList: [30, 20, 50],
    priceList: [50000, 51000, 52000]
  }
});

/** 可挂起的上游：holder.gate 存在时，所有请求等它放行；holder.calls 计 performance 接口次数。 */
function cdriHttp(holder) {
  return async (url) => {
    if (url.includes('/api/index/cgri/performance')) holder.calls++;
    if (holder.gate) await holder.gate.promise;
    const s = holder.state;
    if (s.fail) return fakeResp({}, { ok: false, status: 503 });
    if (url.includes('/api/index/cgri/performance')) return fakeResp({ code: 0, data: s.perf });
    if (url.includes('/api/index/cgri')) return fakeResp({ code: 0, data: s.hist });
    throw new Error('unexpected url ' + url);
  };
}

/** 先成功取一次落盘，再把磁盘副本改成 20 分钟前取的 (超过 10 分钟缓存期)，换一个冷的模块实例。 */
async function cdriWithExpiredDisk(t, holder) {
  resetHealth();
  const { tmpDir } = installModuleMocks(t, { [HTTP]: { fetchWithTimeout: cdriHttp(holder) } });
  const warm = freshRequire('cdri_fetcher.js');
  await warm.fetchCdriData(true);
  const cacheFile = path.join(tmpDir, 'cdri_data.json');
  const disk = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  disk.timestamp = Date.now() - 20 * 60 * 1000;
  fs.writeFileSync(cacheFile, JSON.stringify(disk));
  holder.calls = 0;
  return freshRequire('cdri_fetcher.js');
}

test('CDRI: 缓存过期且上游很慢 → 立刻回旧数据并标 revalidating，刷新完成后拿到新数据', async (t) => {
  const holder = { state: cdriState(11), calls: 0, gate: null };
  const mod = await cdriWithExpiredDisk(t, holder);

  holder.gate = deferred();        // 上游挂起
  holder.state = cdriState(77);    // 放行后会返回的新数据

  const started = Date.now();
  const [a, b] = await Promise.all([mod.fetchCdriData(), mod.fetchCdriData()]);
  assert.ok(Date.now() - started < 1000, '请求不再等上游');
  assert.equal(a.performance.price, 11, '回的是旧数据');
  assert.equal(a.revalidating, true);
  assert.equal(b.revalidating, true);
  assert.ok(a.dataHealth && a.dataHealth.sources.cdri, '旧数据带实时重算的 dataHealth');

  const again = await mod.fetchCdriData();
  assert.equal(again.revalidating, true, '刷新仍在途');
  assert.equal(holder.calls, 1, '三次请求共用同一轮上游取数');

  holder.gate.resolve();
  holder.gate = null;
  for (let i = 0; i < 50; i++) {
    const r = await mod.fetchCdriData();
    if (!r.revalidating) {
      assert.equal(r.performance.price, 77, '后台刷新写入了缓存');
      assert.equal(r.dataHealth.state, 'OK');
      assert.equal(holder.calls, 1, '命中刷新后的缓存，不再打上游');
      return;
    }
    await sleep(10);
  }
  assert.fail('后台刷新完成后仍在返回 revalidating');
});

test('CDRI: 缓存过期但上游很快 → 直接拿到新数据，没有 revalidating', async (t) => {
  const holder = { state: cdriState(11), calls: 0, gate: null };
  const mod = await cdriWithExpiredDisk(t, holder);
  holder.state = cdriState(77);
  const r = await mod.fetchCdriData();
  assert.equal(r.performance.price, 77);
  assert.equal(r.revalidating, undefined);
});

test('CDRI: 缓存过期、后台刷新失败 → 继续回旧数据，健康状态如实反映失败', async (t) => {
  const holder = { state: cdriState(11), calls: 0, gate: null };
  const mod = await cdriWithExpiredDisk(t, holder);
  holder.state = { fail: true };
  const r = await mod.fetchCdriData();
  assert.equal(r.performance.price, 11);
  assert.notEqual(r.dataHealth.state, 'OK');
  assert.ok(r.dataHealth.sources.cdri.lastError, '失败被记入数据健康');
});

test('CDRI: 强制刷新照旧等上游；完全没有旧数据时也等上游', async (t) => {
  const holder = { state: cdriState(11), calls: 0, gate: null };
  const mod = await cdriWithExpiredDisk(t, holder);

  holder.gate = deferred();
  holder.state = cdriState(77);
  let forcedDone = false;
  const forced = mod.fetchCdriData(true).then((r) => { forcedDone = true; return r; });
  await sleep(120); // 远超 40ms 上限
  assert.equal(forcedDone, false, '强制刷新不走旧数据');
  holder.gate.resolve();
  holder.gate = null;
  assert.equal((await forced).performance.price, 77);

  // 全新环境：没有磁盘副本
  resetHealth();
  const holder2 = { state: cdriState(5), calls: 0, gate: deferred() };
  installModuleMocks(t, { [HTTP]: { fetchWithTimeout: cdriHttp(holder2) } });
  const cold = freshRequire('cdri_fetcher.js');
  let coldDone = false;
  const first = cold.fetchCdriData().then((r) => { coldDone = true; return r; });
  await sleep(120);
  assert.equal(coldDone, false, '没有旧数据可回，只能等');
  holder2.gate.resolve();
  holder2.gate = null;
  const r = await first;
  assert.equal(r.performance.price, 5);
  assert.equal(r.revalidating, undefined);
});
