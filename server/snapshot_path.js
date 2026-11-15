'use strict';
const fs = require('fs');
const path = require('path');

// Collectors own committed archives; HTTP processes own ignored sidecars.
// Seed the sidecar once so readers retain the shipped last-good snapshot.
//
// producerOwned: the committed file is rebuilt by a scheduled collector (CI),
// so a committed copy that is newer than the sidecar (typically after a
// `git pull`) supersedes it. Without this the sidecar seeded on first run
// would shadow every later archive update for good. Files that only the HTTP
// process refreshes must NOT set it: a checkout bumps their mtime without
// making their content newer.
function snapshotPath(file, { producerOwned = false } = {}) {
  const main = require.main?.filename || '';
  const collector = path.dirname(main) === path.resolve(__dirname, '../scripts') && path.basename(main) !== 'run_tests.js';
  if (process.env.SNAPSHOT_MODE === 'producer' || process.env.BE_SANDBOX_ROOT || collector) return file;
  const local = file.replace(/\.json$/, '.local.json');
  if (!fs.existsSync(file)) return local;
  if (!fs.existsSync(local)) {
    // Exclusive copy: concurrent processes never overwrite another sidecar.
    try { fs.copyFileSync(file, local, fs.constants.COPYFILE_EXCL); }
    catch (err) { if (err.code !== 'EEXIST') throw err; }
  } else if (producerOwned && fs.statSync(file).mtimeMs > fs.statSync(local).mtimeMs) {
    // Copy to a temp name first so a reader never sees a half-written sidecar.
    const tmp = `${local}.${process.pid}.reseed.tmp`;
    fs.copyFileSync(file, tmp);
    fs.renameSync(tmp, local);
  }
  return local;
}
module.exports = { snapshotPath };
