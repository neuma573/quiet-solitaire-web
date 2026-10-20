import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker, { cleanup, CLEANUP_ROWS_PER_TABLE } from '../leaderboard/index.mjs';
import { cleanupFixture, seedCleanup, NOW } from './leaderboard-cleanup-fixture.mjs';

test('cleanup caps each table and preserves guests, XP, completed history and expiry boundary', async t => {
  const f = cleanupFixture(); t.after(() => f.sqlite.close());
  seedCleanup(f, { completed: 8, temporary: 80, future: 3 });
  const guests = f.sqlite.prepare('SELECT * FROM guests ORDER BY id').all();
  const results = f.sqlite.prepare('SELECT * FROM results ORDER BY id').all();
  const summary = await cleanup({ DB: f.DB }, NOW);
  assert.deepEqual(summary.deleted, { rate_limits: 25, sessions: 25, runs: 25 });
  assert.equal(summary.totalDeleted, 75);
  assert.deepEqual(summary.usage, { rowsRead: null, rowsWritten: null, databaseDurationMs: null });
  assert.equal(f.count('sessions'), 58);
  assert.equal(f.count('rate_limits'), 58);
  assert.equal(f.count('runs'), 66);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM guests ORDER BY id').all(), guests);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM results ORDER BY id').all(), results);
  for (const table of ['sessions', 'rate_limits', 'runs']) {
    assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE expires_at = ?`).get(NOW).n, 3);
  }
  for (let i = 0; i < 3; i++) assert.ok((await cleanup({ DB: f.DB }, NOW)).totalDeleted <= 75);
  assert.equal((await cleanup({ DB: f.DB }, NOW)).totalDeleted, 0);
  assert.equal(f.count('sessions'), 3);
  assert.equal(f.count('runs'), 11);
  assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
});

test('50,000 completed games do not force a full scan or prevent bounded backlog progress', async t => {
  const f = cleanupFixture(); t.after(() => f.sqlite.close());
  seedCleanup(f, { completed: 50000, temporary: 1000, future: 10 });
  const before = f.sqlite.prepare('SELECT SUM(xp) AS xp FROM guests').get().xp;
  for (let i = 0; i < 40; i++) {
    const result = await cleanup({ DB: f.DB }, NOW);
    assert.equal(result.totalDeleted, 75);
    assert.deepEqual(result.deleted, { rate_limits: 25, sessions: 25, runs: 25 });
  }
  assert.equal((await cleanup({ DB: f.DB }, NOW)).totalDeleted, 0);
  assert.equal(f.count('results'), 50000);
  assert.equal(f.count('runs'), 50010);
  assert.equal(f.count('guests'), 3);
  assert.equal(f.sqlite.prepare('SELECT SUM(xp) AS xp FROM guests').get().xp, before);
  const details = f.queries.slice(0, 3).map(q => q.plan.map(row => row.detail).join('\n'));
  assert.match(details[0], /COVERING INDEX rate_limits_expiry/);
  assert.match(details[1], /COVERING INDEX sessions_expiry/);
  assert.match(details[2], /COVERING INDEX runs_cleanup_pending_expiry/);
  for (const plan of details) assert.doesNotMatch(plan, /SCAN (?:guests|runs|results|sessions|rate_limits)|USE TEMP B-TREE/);
});

test('defensive result guard protects history even when a completion marker is stale', async t => {
  const f = cleanupFixture(); t.after(() => f.sqlite.close());
  seedCleanup(f, { completed: 50, temporary: 10 });
  f.sqlite.exec('UPDATE runs SET cleanup_pending = 1');
  const summary = await cleanup({ DB: f.DB }, NOW);
  assert.equal(summary.deleted.runs, 0, 'candidate cap is applied before result lookup');
  assert.equal(f.count('results'), 50);
  assert.equal(f.count('runs'), 60);
});

test('migration backfills completed games without changing profiles, XP or result payloads', t => {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  const migration = name => readFileSync(new URL('../leaderboard/migrations/' + name, import.meta.url), 'utf8');
  sqlite.exec(migration('0001_guest_xp.sql'));
  sqlite.exec(`INSERT INTO guests VALUES ('guest','기존 게스트',0,1,1);
    INSERT INTO runs VALUES ('done','guest','normal',1,'standard','quiet-xp-v1',1,2);
    INSERT INTO runs VALUES ('pending','guest','normal',1,'standard','quiet-xp-v1',1,2);
    INSERT INTO results VALUES ('result','done','guest','key','hash',100,1000,10,7,'client-reported',1);`);
  const guest = sqlite.prepare('SELECT * FROM guests').get();
  const result = sqlite.prepare('SELECT * FROM results').get();
  sqlite.exec(migration('0002_bounded_cleanup.sql'));
  assert.equal(sqlite.prepare('SELECT cleanup_pending FROM runs WHERE id = ?').get('done').cleanup_pending, 0);
  assert.equal(sqlite.prepare('SELECT cleanup_pending FROM runs WHERE id = ?').get('pending').cleanup_pending, 1);
  assert.deepEqual(sqlite.prepare('SELECT * FROM guests').get(), guest);
  assert.deepEqual(sqlite.prepare('SELECT * FROM results').get(), result);
  sqlite.exec("INSERT INTO results VALUES ('next','pending','guest','key2','hash2',100,1000,10,7,'client-reported',1)");
  assert.equal(sqlite.prepare('SELECT cleanup_pending FROM runs WHERE id = ?').get('pending').cleanup_pending, 0);
  assert.equal(sqlite.prepare('SELECT xp FROM guests').get().xp, 14);
});

test('cleanup batch failure rolls back temporary deletions and scheduled handler waits for completion', async t => {
  const f = cleanupFixture(); t.after(() => f.sqlite.close());
  seedCleanup(f, { temporary: 50 });
  f.sqlite.exec("CREATE TRIGGER fail_cleanup BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT,'test failure'); END");
  await assert.rejects(cleanup({ DB: f.DB }, NOW));
  assert.equal(f.count('rate_limits'), 50);
  assert.equal(f.count('sessions'), 50);
  assert.equal(f.count('runs'), 50);
  f.sqlite.exec('DROP TRIGGER fail_cleanup');
  for (const table of ['sessions', 'rate_limits', 'runs']) {
    f.sqlite.prepare(`UPDATE ${table} SET expires_at = ?`).run(Date.now() - 1);
  }
  let pending;
  worker.scheduled({}, { DB: f.DB }, { waitUntil(promise) { pending = promise; } });
  assert.equal((await pending).totalDeleted, 75);
  await assert.rejects(cleanup({ DB: f.DB }, NaN), /Invalid cleanup time/);
});

test('cleanup reports supplied D1 usage counters without treating local missing metrics as zero', async () => {
  const DB = { prepare() { return { bind() { return this; } }; }, async batch() {
    return [1, 2, 3].map(n => ({ results: Array(n).fill({ removed: 1 }),
      meta: { rows_read: n * 10, rows_written: n * 2, duration: n / 10 } }));
  } };
  const summary = await cleanup({ DB }, NOW);
  assert.deepEqual(summary.deleted, { rate_limits: 1, sessions: 2, runs: 3 });
  assert.equal(summary.totalDeleted, 6);
  assert.deepEqual(summary.usage, { rowsRead: 60, rowsWritten: 12, databaseDurationMs: 0.6000000000000001 });
  assert.equal(CLEANUP_ROWS_PER_TABLE, 25);
});
