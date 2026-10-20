import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { applyMigrations } from './leaderboard-migrations.mjs';

export const NOW = 1800000000000;
export function cleanupFixture({ legacy = false } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  if (legacy) sqlite.exec(readFileSync(new URL('../leaderboard/migrations/0001_guest_xp.sql', import.meta.url), 'utf8'));
  else applyMigrations(sqlite);
  const queries = [];
  const prepare = (sql, args = []) => ({ sql, args, bind(...values) { return prepare(sql, values); } });
  const DB = { prepare, async batch(statements) {
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(({ sql, args }) => {
        queries.push({ sql, args, plan: sqlite.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args) });
        return { results: sqlite.prepare(sql).all(...args) };
      });
      sqlite.exec('COMMIT');
      return results;
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  return { sqlite, DB, queries, count(table) { return sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n; } };
}

export function seedCleanup(f, { completed = 0, temporary = 0, future = 0 } = {}) {
  const { sqlite } = f;
  const guest = sqlite.prepare('INSERT INTO guests VALUES (?, ?, 0, ?, ?)');
  const run = sqlite.prepare("INSERT INTO runs (id,user_id,difficulty,draw,scoring,ruleset,started_at,expires_at) VALUES (?,?,'normal',1,'standard','quiet-xp-v1',?,?)");
  const result = sqlite.prepare("INSERT INTO results VALUES (?,?,?, ?,?,100,1000,10,7,'client-reported',?)");
  const session = sqlite.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)');
  const quota = sqlite.prepare('INSERT INTO rate_limits VALUES (?,1,?)');
  sqlite.exec('BEGIN');
  try {
    guest.run('old-guest', '보존할 게스트', NOW - 900 * 86400000, NOW - 900 * 86400000);
    guest.run('active-guest', '활성 게스트', NOW, NOW);
    guest.run('orphan-guest', '복구 불가 게스트', NOW - 900 * 86400000, NOW - 900 * 86400000);
    for (let i = 0; i < completed; i++) {
      run.run(`completed-${i}`, 'old-guest', NOW - 2 * 86400000, NOW - 86400000);
      result.run(`result-${i}`, `completed-${i}`, 'old-guest', `key-${i}`, `hash-${i}`, NOW - 2 * 86400000);
    }
    // Also keep an old guest with no live session and no XP. Cleanup is not an
    // account-retention policy, regardless of whether a guest can be recovered.
    sqlite.prepare('UPDATE guests SET updated_at = ? WHERE id = ?').run(NOW - 900 * 86400000, 'old-guest');
    for (let i = 0; i < temporary + future; i++) {
      const expiry = i < temporary ? NOW - 1 : NOW;
      run.run(`pending-${i}`, 'active-guest', NOW - 86400001, expiry);
      session.run(`session-${i}`, 'active-guest', `csrf-${i}`, expiry);
      quota.run(`quota-${i}`, expiry);
    }
    sqlite.exec('COMMIT');
  } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
}
