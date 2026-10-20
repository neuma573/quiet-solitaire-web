// Local synthetic data only: no network calls, Cloudflare credentials, or remote DB.
import { cleanup } from '../leaderboard/index.mjs';
import { readFileSync } from 'node:fs';
import { cleanupFixture, seedCleanup, NOW } from './leaderboard-cleanup-fixture.mjs';

for (const completed of [1000, 10000, 50000, 100000]) {
  const f = cleanupFixture({ legacy: true });
  try {
    seedCleanup(f, { completed, temporary: 1000, future: 1000 });
    const migrationCpu = process.cpuUsage(), migrationStart = performance.now();
    f.sqlite.exec(readFileSync(new URL('../leaderboard/migrations/0002_bounded_cleanup.sql', import.meta.url), 'utf8'));
    const migrationWallMs = performance.now() - migrationStart, migrationUsed = process.cpuUsage(migrationCpu);
    if (f.sqlite.prepare('SELECT COUNT(*) AS n FROM runs WHERE cleanup_pending = 0').get().n !== completed) {
      throw new Error('Legacy completed-run backfill mismatch');
    }
    const samples = [];
    for (let i = 0; i < 20; i++) {
      const cpu = process.cpuUsage(), start = performance.now();
      const result = await cleanup({ DB: f.DB }, NOW);
      const wallMs = performance.now() - start, used = process.cpuUsage(cpu);
      samples.push({ wallMs, cpuMs: (used.user + used.system) / 1000 });
      if (result.totalDeleted !== 75) throw new Error('Expected three full bounded batches');
      if (Object.values(result.usage).some(v => v !== null)) throw new Error('Local SQLite must not fabricate D1 metrics');
    }
    if (f.count('results') !== completed || f.count('guests') !== 3 ||
        f.sqlite.prepare('SELECT SUM(xp) AS xp FROM guests').get().xp !== completed * 7) {
      throw new Error('Cleanup changed preserved guest/XP/result history');
    }
    const median = key => samples.map(s => s[key]).sort((a, b) => a - b)[Math.floor(samples.length / 2)];
    console.log(JSON.stringify({ completed, temporaryPerTable: 1000, iterations: samples.length,
      deletedPerIteration: 75, medianWallMs: median('wallMs'), medianLocalProcessCpuMs: median('cpuMs'),
      migrationLocalWallMs: migrationWallMs, migrationLocalProcessCpuMs: (migrationUsed.user + migrationUsed.system) / 1000,
      d1RowsRead: null, d1RowsWritten: null, cloudflareWorkerCpuMs: null,
      plans: f.queries.slice(0, 3).map(q => q.plan.map(row => row.detail)) }));
  } finally { f.sqlite.close(); }
}
