import test from 'node:test';
import assert from 'node:assert/strict';
import { LeaderboardService } from '../web/leaderboard.mjs';

const mode = { difficulty: 'normal', draw: 1, scoring: 'standard' };
const user = { id: 'stable-server-id', nickname: 'Original Name', xp: 100 };
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const board = entries => ({ metric: 'cumulative-xp', verification: 'client-reported', entries });
function service(overrides = {}) {
  return new LeaderboardService({ enabled: true,
    session: async () => ({ user }),
    startRun: async mode => ({ run: { id: crypto.randomUUID(), mode } }),
    board: async () => board([]),
    remove: async () => {},
    ...overrides
  });
}
async function complete(service, attemptId) {
  await service.event({ type: 'started', attemptId, mode });
  return service.event({ type: 'completed', attemptId, mode, score: 10000, elapsedMs: 2000, moves: 100, won: true });
}

test('a late result profile does not revert a saved nickname', async () => {
  const result = deferred();
  const s = service({ finishRun: () => result.promise,
    rename: async nickname => ({ user: { ...user, nickname } }) });
  await s.join();
  const finishing = complete(s, 'a'.repeat(32));
  // Let complete() reach its result request before changing the nickname.
  await new Promise(done => setImmediate(done));
  await s.rename('New Name');
  result.resolve({ user: { ...user, xp: 200 } });
  await finishing;
  assert.deepEqual(s.profile, { ...user, nickname: 'New Name', xp: 200 });
});

test('out-of-order result responses never reduce displayed cumulative XP', async () => {
  const first = deferred(), second = deferred(); let calls = 0;
  const s = service({ finishRun: () => ++calls === 1 ? first.promise : second.promise });
  await s.join();
  const old = complete(s, 'a'.repeat(32));
  await new Promise(done => setImmediate(done));
  const newer = complete(s, 'b'.repeat(32));
  await new Promise(done => setImmediate(done));
  second.resolve({ user: { ...user, xp: 300 } }); await newer;
  first.resolve({ user: { ...user, xp: 200 } }); await old;
  assert.equal(s.profile.xp, 300);
});

test('deletion refresh supersedes an earlier in-flight leaderboard response', async () => {
  const stale = deferred(); let boardCalls = 0;
  const s = service({ board: () => ++boardCalls === 1 ? stale.promise : Promise.resolve(board([])) });
  await s.join();
  const old = s.refreshBoard();
  await s.remove();
  stale.resolve(board([{ rank: 1, nickname: user.nickname, xp: 100, isMe: true }]));
  await old;
  assert.equal(boardCalls, 2);
  assert.deepEqual(s.state.entries, []);
  assert.equal(s.profile, null);
});
