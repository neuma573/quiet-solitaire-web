import { readFileSync, readdirSync } from 'node:fs';

export function applyMigrations(sqlite) {
  const directory = new URL('../leaderboard/migrations/', import.meta.url);
  for (const file of readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
    sqlite.exec(readFileSync(new URL(file, directory), 'utf8'));
  }
}
