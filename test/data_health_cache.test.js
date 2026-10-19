/**
 * atomicWriteJson: the Windows transient-lock retry path (EPERM/EBUSY on
 * rename) — bounded retries succeed; exhausting them preserves original bytes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { atomicWriteJson } = require('../server/data_health_cache');

function codedErr(code) {
  const e = new Error(`simulated ${code}`);
  e.code = code;
  return e;
}

test('atomicWriteJson retries EPERM then EBUSY renames; new bytes land on third attempt', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dhc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'snap.json');
  const real = fs.renameSync;
  let calls = 0;
  fs.renameSync = (a, b) => {
    calls++;
    if (calls === 1) throw codedErr('EPERM');
    if (calls === 2) throw codedErr('EBUSY');
    return real(a, b);
  };
  try {
    atomicWriteJson(file, { ok: true, n: 42 });
    assert.equal(calls, 3, 'EPERM + EBUSY then real rename');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ok: true, n: 42 });
    assert.deepEqual(fs.readdirSync(dir), ['snap.json'], 'no temp file remains');
  } finally {
    fs.renameSync = real;
  }
});

test('atomicWriteJson exhausts 6 attempts on permanent EPERM; original bytes preserved, temp removed', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dhc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'snap.json');
  fs.writeFileSync(file, '{"keep":1}');
  const real = fs.renameSync;
  let calls = 0;
  fs.renameSync = () => { calls++; throw codedErr('EPERM'); };
  try {
    assert.throws(() => atomicWriteJson(file, { ok: false }), /EPERM/);
    assert.equal(calls, 6, 'initial attempt + 5 bounded retries, then surface the failure');
    assert.equal(fs.readFileSync(file, 'utf8'), '{"keep":1}', 'destination never truncated');
    assert.deepEqual(fs.readdirSync(dir), ['snap.json'], 'temp file cleaned up');
  } finally {
    fs.renameSync = real;
  }
});
