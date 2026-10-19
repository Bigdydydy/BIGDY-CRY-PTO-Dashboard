/**
 * Sandboxed test runner — `npm test` entry point.
 *
 * Copies the repo code+data into a unique temp sandbox and runs `node --test`
 * there with test/helpers/offline_guard.cjs preloaded. Every `__dirname`-based
 * path inside tests resolves under the sandbox, so nothing the suite does can
 * write to (or read secrets from) the real worktree. The sandbox is kept for
 * review; its path is printed.
 *
 * Usage:
 *   node scripts/run_tests.js                 → all test/*.test.js
 *   node scripts/run_tests.js test/foo.test.js [more.test.js]   → focused files
 *   node scripts/run_tests.js --test-name-pattern=REGEX [files] → name filter
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const COPY_DIRS = ['server', 'public', 'test', 'data', 'analyst_agent', 'scripts'];
const COPY_FILES = ['package.json'];
const EXCLUDE_NAMES = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.claude', '.env']);
const EXCLUDE_RE = [/^\.env(\.|$)/i, /secret|credential|\.pem$|\.key$/i];

function shouldExclude(rel, name) {
  if (EXCLUDE_NAMES.has(name)) return true;
  return EXCLUDE_RE.some(re => re.test(name));
}

function copyInto(src, dst) {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (shouldExclude(e.name, e.name)) continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      copyInto(s, d);
    } else if (e.isFile()) {
      fs.mkdirSync(dst, { recursive: true });
      fs.copyFileSync(s, d);
    }
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `be-test-sandbox-${stamp}-`));

for (const dir of COPY_DIRS) {
  const abs = path.join(REPO, dir);
  if (fs.existsSync(abs)) copyInto(abs, path.join(sandbox, dir));
}
for (const f of COPY_FILES) {
  const abs = path.join(REPO, f);
  if (fs.existsSync(abs)) fs.copyFileSync(abs, path.join(sandbox, f));
}

// --- resolve test targets ---------------------------------------------------
// Explicit targets are validated strictly: they must resolve inside repo/test,
// must exist, and must match at least one file. A typo that resolves to
// nothing must fail here — never silently fall back to running everything.
const passthrough = [];   // forwarded verbatim to node --test (e.g. --test-name-pattern=...)
const files = [];
const TEST_DIR = path.join(REPO, 'test');
const invalid = [];
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('-')) { passthrough.push(arg); continue; }
  const abs = path.resolve(REPO, arg);
  const rel = path.relative(TEST_DIR, abs);
  const insideTest = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  if (!insideTest || !fs.existsSync(abs)) { invalid.push(arg); continue; }
  if (fs.statSync(abs).isDirectory()) {
    const matched = fs.readdirSync(abs).filter(f => f.endsWith('.test.js'));
    if (!matched.length) { invalid.push(arg); continue; }
    for (const f of matched) files.push(path.join(arg, f));
  } else {
    files.push(arg);
  }
}
const hadExplicitArgs = files.length > 0 || invalid.length > 0;
if (invalid.length) {
  console.error(`[run_tests] invalid target(s) outside repo/test or not found: ${invalid.join(', ')}`);
  process.exit(2);
}
if (!files.length && !hadExplicitArgs) {
  const testDir = path.join(sandbox, 'test');
  for (const f of fs.readdirSync(testDir)) if (f.endsWith('.test.js')) files.push(path.join('test', f));
}
if (!files.length) {
  console.error('[run_tests] no test files resolved; refusing to run node --test bare');
  process.exit(2);
}
// Normalize repo-relative test paths to sandbox-relative.
const targets = files.map(f => {
  const rel = path.isAbsolute(f) ? path.relative(REPO, f) : f;
  return rel.split(path.sep).join('/');
}).filter(f => fs.existsSync(path.join(sandbox, f)));
if (!targets.length) {
  console.error('[run_tests] targets did not survive the sandbox copy; refusing bare run');
  process.exit(2);
}

// NODE_OPTIONS backslash-escapes are unreliable on Windows — always pass a
// forward-slash path inside plain double quotes.
const guard = path.join(sandbox, 'test', 'helpers', 'offline_guard.cjs').split(path.sep).join('/');
const env = {
  ...process.env,
  NODE_OPTIONS: `--require "${guard}"`,
  BE_SANDBOX_ROOT: sandbox,
  BE_REPO_ROOT: REPO
};

console.log(`[run_tests] sandbox: ${sandbox}`);
console.log(`[run_tests] files: ${targets.join(', ') || '(none matched)'}`);

const res = spawnSync(
  process.execPath,
  ['--test', ...passthrough, ...targets],
  { cwd: sandbox, env, stdio: 'inherit' }
);
process.exit(res.status === null ? 1 : res.status);
