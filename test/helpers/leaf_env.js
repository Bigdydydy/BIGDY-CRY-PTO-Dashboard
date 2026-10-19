/**
 * Offline test harness for leaf data-source modules.
 *
 * installModuleMocks(t, map) — patches Module._load for the duration of a
 * node:test test so that:
 *   - 'fs' resolves to a passthrough Proxy that redirects every path under
 *     <repo>/data into a fresh temp dir (real user data is never touched);
 *   - explicitly mapped specifiers/resolved paths (http_client, spot_daily,
 *     liquidity_history, https, child_process, ...) return the given stubs.
 *
 * freshRequire(absPath) — drops a module (and only it) from require.cache so
 * module-level caches/inflight state reset between scenarios. The shared
 * data_health registry is reset via resetHealthForTests().
 */

const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resetHealthForTests } = require('../../server/data_health');

const REPO_ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = path.join(REPO_ROOT, 'data');
const DATA_DIR_NORM = path.normalize(DATA_DIR);
const DATA_PREFIX = DATA_DIR_NORM + path.sep;

function installModuleMocks(t, stubs = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'be-data-'));

  // Proxy fs: every string arg sitting under <repo>/data is rewritten to tmp.
  const realFs = require('fs');
  const mapPath = (p) => {
    if (typeof p !== 'string') return p;
    const n = path.normalize(p);
    if (n === DATA_DIR_NORM || n.startsWith(DATA_PREFIX)) {
      return path.join(tmpDir, path.relative(DATA_DIR_NORM, n));
    }
    return p;
  };
  const fakeFs = new Proxy(realFs, {
    get(target, prop) {
      const v = target[prop];
      if (typeof v !== 'function') return v;
      return (...args) => v.apply(target, args.map(mapPath));
    }
  });

  const origLoad = Module._load;
  const origResolve = Module._resolveFilename;
  Module._load = function (request, parent, isMain) {
    let resolved = request;
    try { resolved = origResolve.call(this, request, parent, isMain); } catch (e) { /* keep raw */ }
    if (Object.prototype.hasOwnProperty.call(stubs, resolved)) return stubs[resolved];
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    if (resolved === 'fs') return fakeFs;
    return origLoad.apply(this, arguments);
  };
  t.after(() => { Module._load = origLoad; });
  return { tmpDir, fakeFs };
}

/** Resolve a repo-relative server path for use as a stubs key. */
function srv(rel) {
  return require.resolve(path.join(REPO_ROOT, 'server', rel));
}

function freshRequire(relFromServer) {
  const p = srv(relFromServer);
  delete require.cache[p];
  // data_health_cache binds `fs` at load time — drop it too so it captures
  // the CURRENT test's redirected fs (the shared data_health singleton is
  // intentionally kept: one registry per test process).
  delete require.cache[srv('data_health_cache.js')];
  return require(p);
}

function resetHealth() {
  resetHealthForTests();
}

/** Minimal fetchWithTimeout-style response. */
function fakeResp(body, { ok = true, status = 200, headers = {} } = {}) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'ERR',
    headers: { get: (k) => headers[k.toLowerCase()] ?? headers[k] ?? null },
    json: async () => (typeof body === 'function' ? body() : body),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  };
}

module.exports = { installModuleMocks, srv, freshRequire, resetHealth, fakeResp, REPO_ROOT, DATA_DIR };
