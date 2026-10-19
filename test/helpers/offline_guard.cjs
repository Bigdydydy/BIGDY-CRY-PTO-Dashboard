/**
 * Offline test guard — injected into every sandboxed test process via
 * `--require`. Refuses to let test code reach anything off the loopback
 * interface or spawn non-Node child processes. Blocked calls throw an
 * OFFLINE_TEST error (never a fabricated success) so fetchers exercise
 * their real fallback paths.
 *
 * Allowed: fetch/http(s) to localhost, 127.0.0.1, ::1 — local mock servers.
 * Redirects are followed manually: a loopback URL that 30x's off-host is
 * blocked. http(s).request(url, options) checks BOTH the URL and the options
 * host — an options override cannot sneak past the URL check. Child Node
 * processes (process.execPath) are allowed and are force-fed this same guard
 * through NODE_OPTIONS even when the caller overrides the child env.
 * Shell execution (exec/execSync) is always refused: a 'node && python'
 * command string cannot be trusted to stay Node — use spawn/execFile.
 */
'use strict';

const OFFLINE_TAG = 'OFFLINE_TEST';
const childProcess = require('node:child_process');
const http = require('node:http');
const https = require('node:https');

function offlineError(what) {
  const err = new Error(`${OFFLINE_TAG}: blocked external access — ${what} (offline sandbox; only loopback allowed)`);
  err.code = OFFLINE_TAG;
  return err;
}

function isLoopbackHost(h) {
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

function hostOfUrlish(target) {
  try {
    if (typeof target === 'string' || target instanceof URL) return new URL(target).hostname;
    if (target && typeof target === 'object' && target.url) return new URL(target.url).hostname; // Request-like
  } catch (e) { /* fall through to blocked */ }
  return null;
}

/** Every host name a request could resolve to, across URL + options args. */
function hostsInArgs(args) {
  const hosts = [];
  const [a0, a1] = args;
  const push = v => { if (v) hosts.push(String(v).split(':')[0]); };
  if (typeof a0 === 'string' || a0 instanceof URL) push(hostOfUrlish(a0));
  if (a0 && typeof a0 === 'object' && !(a0 instanceof URL)) {
    push(a0.hostname || a0.host);                       // request(options,...)
    if (a0.href) push(hostOfUrlish(a0.href));
  }
  if (a1 && typeof a1 === 'object' && typeof a1 !== 'function') {
    push(a1.hostname || a1.host);                       // request(url, options,...)
    if (a1.href) push(hostOfUrlish(a1.href));
  }
  return hosts.length ? hosts : ['localhost'];          // bare request()
}

// --- global.fetch -------------------------------------------------------------
const realFetch = global.fetch;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

global.fetch = async function guardedFetch(input, init = {}) {
  const first = hostOfUrlish(input);
  if (!isLoopbackHost(first)) return Promise.reject(offlineError(`fetch ${first || input}`));

  // Caller asked for manual redirect handling — a bare host check suffices.
  if (init && init.redirect === 'manual') {
    return realFetch.call(this, input, init);
  }

  // Follow redirects hop-by-hop so a loopback URL cannot bounce us off-site.
  let current = input;
  let method = init && init.method;
  let hops = 0;
  for (;;) {
    const host = hostOfUrlish(current);
    if (!isLoopbackHost(host)) throw offlineError(`fetch redirect → ${host || current}`);
    const resp = await realFetch.call(this, current, { ...init, redirect: 'manual' });
    if (!REDIRECT_STATUSES.has(resp.status)) return resp;
    const location = resp.headers && resp.headers.get && resp.headers.get('location');
    if (!location) return resp;
    if (++hops > MAX_REDIRECTS) throw offlineError('fetch redirect limit exceeded');
    let next;
    try { next = new URL(location, typeof current === 'string' ? current : current.url); }
    catch (e) { throw offlineError(`fetch redirect → unparseable ${location}`); }
    // 303 (and 301/302 for POST) downgrade to GET per fetch semantics.
    if (resp.status === 303 || ((resp.status === 301 || resp.status === 302) && method && method.toUpperCase() === 'POST')) {
      method = 'GET';
    }
    current = next.toString();
  }
};

// --- http/https request & get --------------------------------------------------
function wrapModule(mod, label) {
  const check = args => {
    const hosts = hostsInArgs(args);
    const bad = hosts.find(h => !isLoopbackHost(h));
    if (bad !== undefined) throw offlineError(`${label} ${bad}`);
  };
  const origRequest = mod.request;
  mod.request = function guardedRequest(...args) {
    check(args);
    return origRequest.apply(this, args);
  };
  const origGet = mod.get;
  mod.get = function guardedGet(...args) {
    check(args);
    return origGet.apply(this, args);
  };
}
wrapModule(http, 'http');
wrapModule(https, 'https');

// --- WebSocket -----------------------------------------------------------------
// TradingView-style fallback sources open raw sockets; non-loopback targets
// are refused at construction. Loopback mocks stay usable.
const RealWebSocket = typeof global.WebSocket === 'function' ? global.WebSocket : null;
function GuardedWebSocket(url, ...rest) {
  const host = hostOfUrlish(url);
  if (!isLoopbackHost(host)) throw offlineError(`WebSocket ${host || url}`);
  if (!RealWebSocket) throw offlineError('WebSocket unavailable in this runtime');
  return Reflect.construct(RealWebSocket, [url, ...rest]);
}
if (RealWebSocket) {
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) GuardedWebSocket[k] = RealWebSocket[k];
}
global.WebSocket = GuardedWebSocket;

// --- child_process --------------------------------------------------------------
const guardPath = __filename.replace(/\\/g, '/');
const GUARD_OPT = `--require "${guardPath}"`;
const NODE_BASENAMES = new Set(['node', 'node.exe', 'nodejs', 'nodejs.exe']);
function isNodeExec(cmd) {
  if (!cmd) return false;
  const base = String(cmd).split(/[\\/]/).pop().toLowerCase();
  return base === String(process.execPath).split(/[\\/]/).pop().toLowerCase() || NODE_BASENAMES.has(base);
}

/** Force the guard into a Node child's env even when the caller overrides it. */
function withGuardEnv(args) {
  // spawn/spawnSync/execFile/execFileSync: (cmd, argv?, options?)
  const idx = typeof args[1] === 'object' && !Array.isArray(args[1]) ? 1
    : (typeof args[2] === 'object' ? 2 : -1);
  if (idx === -1) return args;
  const options = { ...(args[idx] || {}) };
  if (options.env && typeof options.env === 'object') {
    const existing = options.env.NODE_OPTIONS || '';
    options.env = {
      ...options.env,
      NODE_OPTIONS: existing.includes(guardPath) ? existing
        : (existing ? `${existing} ${GUARD_OPT}` : GUARD_OPT)
    };
    args[idx] = options;
  }
  return args;
}

for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  if (typeof childProcess[fn] !== 'function') continue;
  const orig = childProcess[fn];
  childProcess[fn] = function guardedChild(...args) {
    // fork(): first arg is a module path run under Node — allow (inherits env guard).
    if (fn === 'fork') return orig.apply(this, args);
    // exec/execSync run a SHELL command — always refused. 'node … && python'
    // strings cannot be trusted; use spawn/execFile with process.execPath.
    if (fn === 'exec' || fn === 'execSync') {
      throw offlineError(`child_process.${fn} shell command`);
    }
    const cmd = args[0];
    if (isNodeExec(cmd)) return orig.apply(this, withGuardEnv(args));
    throw offlineError(`child_process.${fn} ${JSON.stringify(cmd)}`);
  };
}

// Spawned Node helpers inherit the same guard. NODE_OPTIONS backslash
// escapes are unreliable on Windows — use a forward-slash path.
process.env.NODE_OPTIONS = process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ${GUARD_OPT}` : GUARD_OPT;
process.env.BE_OFFLINE_GUARD = '1';
