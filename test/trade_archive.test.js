const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const archive = require('../server/trade_archive');

const D = 86400000;
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trade-archive-'));

test('mergeIntoArchive splits by UTC month, sorts, is idempotent and only adds', () => {
  const dir = tmpDir();
  const sep = Date.UTC(2026, 8, 30, 23, 0);
  const oct = Date.UTC(2026, 9, 1, 1, 0);
  const r1 = archive.mergeIntoArchive('BTC', [
    { trade_id: 'b', timestamp: oct, amount: 1 },
    { trade_id: 'a', timestamp: sep, amount: 2 },
    { trade_id: 'c', timestamp: oct - 1000, amount: 3 }
  ], { dir });
  assert.equal(r1.added, 3);
  assert.deepEqual(r1.months, ['2026-09', '2026-10']);
  assert.deepEqual(archive.readMonth(archive.monthFile('BTC', '2026-10', dir)).map(t => t.trade_id), ['c', 'b']);

  // Same trades again: nothing written
  const r2 = archive.mergeIntoArchive('BTC', [{ trade_id: 'a', timestamp: sep, amount: 2 }], { dir });
  assert.deepEqual([r2.added, r2.updated, r2.months.length], [0, 0, 0]);

  // A richer duplicate fills fields in; an incoming batch without a trade never deletes it
  const r3 = archive.mergeIntoArchive('BTC', [{ trade_id: 'b', timestamp: oct, iv: 44 }], { dir });
  assert.equal(r3.updated, 1);
  const octTrades = archive.readMonth(archive.monthFile('BTC', '2026-10', dir));
  assert.equal(octTrades.length, 2);
  assert.deepEqual(octTrades.find(t => t.trade_id === 'b'), { trade_id: 'b', timestamp: oct, amount: 1, iv: 44 });

  assert.equal(archive.readArchive('BTC', { dir }).length, 3);
  assert.deepEqual(archive.readArchive('BTC', { dir, fromTs: oct - 5000 }).map(t => t.trade_id), ['c', 'b']);
  const s = archive.archiveSummary('BTC', { dir });
  assert.deepEqual(s, { totalTrades: 3, earliestTs: sep, latestTs: oct, months: 2 });
});

test('a corrupt month file is reported, never overwritten', () => {
  const dir = tmpDir();
  const file = archive.monthFile('BTC', '2026-10', dir);
  fs.writeFileSync(file, '{"trade_id":"x","timestamp":1}\n{broken\n');
  assert.throws(() => archive.mergeIntoArchive('BTC', [{ trade_id: 'y', timestamp: Date.UTC(2026, 9, 2) }], { dir }), /第 2 行/);
  assert.ok(fs.readFileSync(file, 'utf8').includes('{broken'));
});

test('trade_store (collector) archives every trade before pruning the 60-day hot file', (t) => {
  const prevMode = process.env.SNAPSHOT_MODE;
  process.env.SNAPSHOT_MODE = 'producer';
  const store = require('../server/trade_store');
  const cur = 'ARCHTEST';
  const hot = path.join(__dirname, '..', 'data', `block_trades_${cur}.json`);
  const now = Date.now();
  const old = now - 61 * D;
  t.after(() => {
    process.env.SNAPSHOT_MODE = prevMode;
    if (prevMode === undefined) delete process.env.SNAPSHOT_MODE;
    for (const f of [hot, ...archive.listMonths(cur).map(m => archive.monthFile(cur, m))]) {
      try { fs.unlinkSync(f); } catch (e) { /* already gone */ }
    }
  });
  fs.writeFileSync(hot, JSON.stringify({ trades: [{ trade_id: 'old', timestamp: old }, { trade_id: 'keep', timestamp: now - 10 * D }] }));
  const r = store.recordAndMergeTrades(cur, [{ trade_id: 'new', timestamp: now }]);
  assert.deepEqual(r.trades.map(x => x.trade_id).sort(), ['keep', 'new']);
  assert.deepEqual(archive.readArchive(cur).map(x => x.trade_id).sort(), ['keep', 'new', 'old']);
});

test('trade_store skips the prune when the archive cannot be written', (t) => {
  const prevMode = process.env.SNAPSHOT_MODE;
  process.env.SNAPSHOT_MODE = 'producer';
  const store = require('../server/trade_store');
  const cur = 'ARCHFAIL';
  const hot = path.join(__dirname, '..', 'data', `block_trades_${cur}.json`);
  const now = Date.now();
  const old = now - 61 * D;
  const corrupt = archive.monthFile(cur, archive.monthOf(old));
  t.after(() => {
    process.env.SNAPSHOT_MODE = prevMode;
    if (prevMode === undefined) delete process.env.SNAPSHOT_MODE;
    for (const f of [hot, ...archive.listMonths(cur).map(m => archive.monthFile(cur, m))]) {
      try { fs.unlinkSync(f); } catch (e) { /* already gone */ }
    }
  });
  fs.mkdirSync(path.dirname(corrupt), { recursive: true });
  fs.writeFileSync(corrupt, '{broken\n');
  fs.writeFileSync(hot, JSON.stringify({ trades: [{ trade_id: 'old', timestamp: old }] }));
  const r = store.recordAndMergeTrades(cur, []);
  assert.deepEqual(r.trades.map(x => x.trade_id), ['old']); // kept until it is safely archived
});
