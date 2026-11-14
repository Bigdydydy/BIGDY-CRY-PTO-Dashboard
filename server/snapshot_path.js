'use strict';
const path = require('path');

// Collectors own committed archives; HTTP processes own ignored sidecars.
// Seed the sidecar once so readers retain the shipped last-good snapshot.
function snapshotPath(file) {
  const fs = require('fs');
  const main = require.main?.filename || '';
  const collector = path.dirname(main) === path.resolve(__dirname, '../scripts') && path.basename(main) !== 'run_tests.js';
  if (process.env.SNAPSHOT_MODE === 'producer' || process.env.BE_SANDBOX_ROOT || collector) return file;
  const local = file.replace(/\.json$/, '.local.json');
  if (!fs.existsSync(local) && fs.existsSync(file)) {
    // Exclusive copy: concurrent processes never overwrite another sidecar.
    try { fs.copyFileSync(file, local, fs.constants.COPYFILE_EXCL); }
    catch (err) { if (err.code !== 'EEXIST') throw err; }
  }
  return local;
}
module.exports = { snapshotPath };
