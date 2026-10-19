/**
 * Offline-sandbox safety tests. Run under scripts/run_tests.js (guard preloaded
 * + BE_SANDBOX_ROOT/BE_REPO_ROOT env). Children spawned with --require guard
 * inherit it via NODE_OPTIONS, so nested node processes stay offline too.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = process.env.BE_REPO_ROOT;
const SANDBOX = process.env.BE_SANDBOX_ROOT;
// Node's --require option parser backslash-escapes Windows paths; use slashes.
const GUARD = path.join(__dirname, 'helpers', 'offline_guard.cjs').replace(/\\/g, '/');

function runGuarded(src) {
  return spawnSync(process.execPath, ['--require', GUARD, '-e', src], { encoding: 'utf8', timeout: 20000 });
}

describe('offline sandbox guard', () => {
  test('non-loopback fetch is rejected with OFFLINE_TEST, never a fabricated success', () => {
    const r = runGuarded(
      `fetch('https://example.com/x').then(()=>console.log('UNREACHABLE')).catch(e=>console.log('code:'+e.code))`
    );
    assert.match(r.stdout, /code:OFFLINE_TEST/);
  });

  test('non-loopback https.get / http.request are rejected', () => {
    const r = runGuarded(`
      try { require('https').get('https://example.com') } catch(e){ console.log('httpsGet:'+e.code) }
      try { require('http').request('http://203.0.113.10/') } catch(e){ console.log('httpReq:'+e.code) }
    `);
    assert.match(r.stdout, /httpsGet:OFFLINE_TEST/);
    assert.match(r.stdout, /httpReq:OFFLINE_TEST/);
  });

  test('python / shell / non-node child_process are rejected', () => {
    const r = runGuarded(`
      const cp = require('child_process');
      try { cp.execFileSync('python', ['--version']) } catch(e){ console.log('execFile:'+e.code) }
      try { cp.spawnSync('cmd', ['/c','echo hi']) } catch(e){ console.log('spawn:'+e.code) }
      try { cp.execSync('python --version') } catch(e){ console.log('exec:'+e.code) }
      // Shell strings must never pass — 'node && python' could launder a real call.
      try { cp.execSync('node -e 1') } catch(e){ console.log('execNode:'+e.code) }
      try { cp.exec('node --version && python -V', ()=>{}) } catch(e){ console.log('execStr:'+e.code) }
    `);
    assert.match(r.stdout, /execFile:OFFLINE_TEST/);
    assert.match(r.stdout, /spawn:OFFLINE_TEST/);
    assert.match(r.stdout, /exec:OFFLINE_TEST/);
    assert.match(r.stdout, /execNode:OFFLINE_TEST/, 'exec() shells are refused even for node commands');
    assert.match(r.stdout, /execStr:OFFLINE_TEST/);
  });

  test('redirects off loopback and options host overrides cannot bypass the guard', () => {
    const r = runGuarded(`
      const http = require('http');
      const srv = http.createServer((q,s)=>{ s.writeHead(302,{Location:'https://example.com/x'}); s.end(); });
      srv.listen(0,'127.0.0.1', async () => {
        try {
          await fetch('http://127.0.0.1:'+srv.address().port); // follows 302 off-host -> must reject
          console.log('redirect:NOT_BLOCKED');
        } catch(e) { console.log('redirect:'+e.code); }
        try { http.get('http://127.0.0.1:1/x', { host: 'evil.example' }, ()=>{}) } catch(e){ console.log('optsHost:'+e.code) }
        try { http.request({ host: 'evil.example', href: 'http://127.0.0.1/' }) } catch(e){ console.log('optsObj:'+e.code) }
        try { http.get('http://0.0.0.0:1/') } catch(e){ console.log('zeroHost:'+e.code) }
        srv.close();
      });
    `);
    assert.match(r.stdout, /redirect:OFFLINE_TEST/, 'loopback 302 to external host must be rejected');
    assert.match(r.stdout, /optsHost:OFFLINE_TEST/, 'options host override must not bypass the URL check');
    assert.match(r.stdout, /optsObj:OFFLINE_TEST/);
    assert.match(r.stdout, /zeroHost:OFFLINE_TEST/, '0.0.0.0 is not a loopback allowance');
  });

  test('non-loopback WebSocket is refused at construction; loopback stays usable', () => {
    const r = runGuarded(`
      try { new WebSocket('wss://data.tradingview.com/socket.io/websocket') } catch(e){ console.log('wsExt:'+e.code) }
      try {
        // Loopback must reach the real constructor — no real socket is
        // established here (port 9 is closed); failure is async, not a guard throw.
        const ws = new WebSocket('ws://127.0.0.1:9/x');
        ws.onerror = () => {}; ws.onclose = () => {};
        try { ws.close(); } catch (e2) {}
        console.log('wsLocal:allowed');
      } catch (e) {
        console.log('wsLocal:' + (e.code || 'ERR:' + e.message));
      }
    `);
    assert.match(r.stdout, /wsExt:OFFLINE_TEST/, 'external WebSocket must be refused');
    assert.match(r.stdout, /wsLocal:allowed/, 'loopback WebSocket must pass the guard');
    assert.doesNotMatch(r.stdout, /wsLocal:OFFLINE_TEST/);
  });

  test('child Node processes spawned with a stripped env still inherit the guard', () => {
    const r = runGuarded(`
      const {spawnSync} = require('child_process');
      const r = spawnSync(process.execPath, ['-e',
        "fetch('https://example.com').catch(e=>console.log('nested:'+e.code))"],
        { encoding:'utf8', env:{ PATH: process.env.PATH } }); // env without NODE_OPTIONS
      console.log((r.stdout||'').trim());
      if (r.status !== 0) console.log('childFailed:' + (r.stderr||'').slice(0,200));
    `);
    assert.match(r.stdout, /nested:OFFLINE_TEST/, 'stripped-env node child must still be guarded');
  });

  test('loopback fetch works; spawned child node inherits the guard', () => {
    const r = runGuarded(`
      const http = require('http');
      const execFileSync = require('child_process').execFileSync;
      const srv = http.createServer((q,s)=>s.end('ok'));
      srv.listen(0,'127.0.0.1', async () => {
        try {
          const body = await (await fetch('http://127.0.0.1:'+srv.address().port)).text();
          console.log('loopback:'+body);
          try {
            const out = execFileSync(process.execPath, ['-e',
              "fetch('https://example.com').catch(e=>console.log('child:'+e.code))"], {encoding:'utf8'});
            console.log(out.trim());
          } catch (e2) {
            console.log('EXECFAIL status=' + e2.status + ' stderr=' + String(e2.stderr).slice(0, 400));
          }
        } finally { srv.close(); }
      });
    `);
    assert.match(r.stdout, /loopback:ok/);
    assert.match(r.stdout, /child:OFFLINE_TEST/, 'child node inherited NODE_OPTIONS guard');
  });

  test('module writes land in the sandbox copy; real data/ bytes unchanged (manifest consistent)', () => {
    assert.ok(SANDBOX && REPO, 'runner must set BE_SANDBOX_ROOT/BE_REPO_ROOT');
    const shaDir = dir => fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
      .filter(e => e.isFile())
      .map(e => crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, e.name))).digest('hex'));
    const realData = path.join(REPO, 'data');
    const before = shaDir(realData);

    // A real module write: vol_surface_history resolves under the sandbox, so
    // its __dirname-based HISTORY_FILE is the sandbox copy.
    const vh = require('../server/vol_surface_history');
    vh.recordSnapshot({ atm: { iv1m: 1 }, skew: { d30: -1 }, spot: 1 });

    const after = shaDir(realData);
    assert.deepEqual(after, before, 'real data/ manifest must be byte-identical');

    const sandboxFile = path.join(SANDBOX, 'data', 'vol_surface_history_BTC.local.json');
    assert.ok(fs.existsSync(sandboxFile), 'write landed in sandbox data copy');
    const recs = vh.readHistory(sandboxFile);
    assert.ok(recs.some(r => r.spot === 1 && r.rr30 === -1), 'sandbox copy carries the write');
  });
});
