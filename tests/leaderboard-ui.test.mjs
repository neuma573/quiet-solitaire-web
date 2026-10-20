import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeaderboardClient, LeaderboardService, LeaderboardError, normalizeApiBase,
  normalizeNickname } from '../web/leaderboard.mjs';

const mode = { difficulty: 'normal', draw: 3, scoring: 'standard' };
const attemptId = 'a'.repeat(32);
const user = { id: 'stable-server-id', nickname: '고요한여우123', xp: 123 };
const started = (id = attemptId, rules = mode) => ({ type: 'started', attemptId: id, mode: rules });
const completed = (id = attemptId, overrides = {}) => ({ type: 'completed', attemptId: id, mode,
  elapsedMs: 125_000, moves: 110, won: true, score: 1020, ...overrides });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(overrides = {}) {
  const calls = { starts: [], finishes: [], renames: [], removals: 0 };
  const client = { enabled: true, session: async () => ({ user }),
    rename: async nickname => { calls.renames.push(nickname); return { user: { ...user, nickname } }; },
    remove: async () => { calls.removals++; },
    startRun: async rules => { calls.starts.push(rules); return { run: { id: 'server-run-id', mode: rules } }; },
    finishRun: async (...args) => { calls.finishes.push(args); return { user: { ...user, xp: 200 }, result: { xpAwarded: 77 } }; },
    board: async () => ({ metric: 'cumulative-xp', verification: 'client-reported', entries: [] }), ...overrides };
  const service = new LeaderboardService(client, { randomUUID: () => '12345678-1234-4234-8234-123456789abc' });
  return { service, client, calls };
}

test('public API configuration is disabled by default and allows only HTTPS or local development', () => {
  assert.equal(normalizeApiBase(''), '');
  assert.equal(normalizeApiBase('/api/leaderboard/', { href: 'https://game.example/index.html' }), 'https://game.example/api/leaderboard');
  assert.equal(normalizeApiBase('/api/leaderboard///', { href: 'https://game.example/index.html' }), 'https://game.example/api/leaderboard');
  assert.equal(normalizeApiBase('https://game.example///'), 'https://game.example');
  assert.equal(normalizeApiBase('http://localhost:8787'), 'http://localhost:8787');
  for (const value of ['http://api.example', 'javascript:alert(1)', 'https://user:pass@api.example', 'https://api.example?token=secret']) {
    assert.throws(() => normalizeApiBase(value));
  }
});

test('API uses server cookie and in-memory CSRF, never sends profile IDs or local XP', async () => {
  const requests = [];
  const client = createLeaderboardClient({ apiBase: 'https://game.example/api/leaderboard',
    locks: { request: async (_name, _options, action) => action() }, fetchImpl: async (url, options) => {
    requests.push({ url, ...options });
    return new Response(JSON.stringify({ user, csrfToken: 'server-csrf' }), { status: 200 });
  } });
  await client.session(); await client.rename('새 이름'); await client.startRun(mode);
  await client.finishRun('server/run', { score: 20, elapsedMs: 5000, moves: 10, won: true }, 'key');
  assert.equal(requests[0].headers['X-CSRF-Token'], undefined);
  for (const request of requests) {
    assert.equal(request.credentials, 'include'); assert.equal(request.cache, 'no-store');
    assert.equal(request.headers.Authorization, undefined);
    if (request.body !== undefined) {
      assert.equal(JSON.parse(request.body).userId, undefined); assert.equal(JSON.parse(request.body).xp, undefined);
    }
  }
  assert.equal(requests[1].method, 'GET');
  assert.equal(requests[1].headers['X-CSRF-Token'], undefined);
  assert.equal(requests[2].headers['X-CSRF-Token'], 'server-csrf');
  assert.deepEqual(JSON.parse(requests[2].body), { nickname: '새 이름' });
  assert.equal(requests[4].url, 'https://game.example/api/leaderboard/v1/runs/server%2Frun/result');
  assert.equal(requests[4].headers['Idempotency-Key'], 'key');
});

test('API errors are bounded user messages, never reflected backend content', async () => {
  const client = createLeaderboardClient({ apiBase: 'https://game.example', fetchImpl: async () => new Response('<script>private-error</script>', { status: 503 }) });
  await assert.rejects(client.board(), error => error.status === 503 && !error.message.includes('private-error'));
  const offline = createLeaderboardClient({ apiBase: 'https://game.example', fetchImpl: async () => { throw new Error('private'); } });
  await assert.rejects(offline.board(), error => error.status === 0 && !error.message.includes('private'));
});

test('concurrent connections share one session request and verify the cookie before accepting identity', async () => {
  const response = deferred(); const calls = [];
  const client = createLeaderboardClient({ apiBase: 'https://api.example',
    locks: { request: async (_name, options, action) => { assert.equal(options.mode, 'exclusive'); return action(); } },
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      if (url.endsWith('/session')) return response.promise;
      return Response.json({ user, csrfToken: 'cookie-owned-csrf' });
    } });
  const first = client.session(), second = client.session();
  assert.equal(calls.length, 1);
  response.resolve(Response.json({ user, csrfToken: 'cookie-owned-csrf' }, { status: 201 }));
  assert.deepEqual(await first, await second);
  assert.deepEqual(calls.map(call => call.method), ['POST', 'GET']);
  assert.ok(calls.every(call => call.credentials === 'include' && call.signal instanceof AbortSignal));
  await client.rename('새 이름');
  assert.equal(calls[2].headers['X-CSRF-Token'], 'cookie-owned-csrf');
});

test('blocked cookies and unavailable locks fail without accepting identity or silently repeating creates', async () => {
  let calls = 0;
  const client = createLeaderboardClient({ apiBase: 'https://api.example',
    locks: { request: async (_name, _options, action) => action() },
    fetchImpl: async (_url, options) => {
      calls++;
      return options.method === 'POST' ? Response.json({ user, csrfToken: 'unpersisted-csrf' }, { status: 201 })
        : Response.json({ error: 'session_required' }, { status: 401 });
    } });
  await assert.rejects(client.session(), error => error.status === 401);
  await new Promise(done => setImmediate(done));
  assert.equal(calls, 2, 'One create followed by one cookie check; no retry loop');
  const unavailable = createLeaderboardClient({ apiBase: 'https://api.example', locks: null,
    fetchImpl: async () => { throw new Error('must not send a request'); } });
  await assert.rejects(unavailable.session(), error => error instanceof LeaderboardError && /브라우저/.test(error.message));
});

test('automatic connection failure keeps game events local and can recover only for a new attempt', async () => {
  let connects = 0; const pending = deferred();
  const { service, client, calls } = fixture({ session: () => { connects++; return pending.promise; } });
  const first = service.join(), repeated = service.join();
  assert.equal(connects, 1);
  await service.event(started()); await service.event(completed());
  pending.reject(new LeaderboardError('연결할 수 없습니다.'));
  await Promise.all([first, repeated]);
  assert.equal(service.state.busy, false); assert.equal(service.profile, null);
  await service.refreshBoard();
  assert.equal(service.state.connectionError, '연결할 수 없습니다.', 'A successful public board read must not hide connection failure');
  assert.equal(calls.starts.length, 0); assert.equal(calls.finishes.length, 0);
  client.session = async () => ({ user });
  await service.join(); await service.event(completed());
  assert.equal(calls.finishes.length, 0, 'A later connection cannot upload an old completion');
  await service.event(started('b'.repeat(32))); await service.event(completed('b'.repeat(32)));
  assert.equal(calls.finishes.length, 1);
  await service.remove(); await service.join();
  assert.equal(service.profile, null, 'Confirmed deletion remains deleted until a new page lifecycle');
  assert.equal(service.deleted, true);
});

test('nickname normalizes before sending and rejects markup, controls, emoji, invalid lengths', () => {
  assert.equal(normalizeNickname('  ＡＡ   여우  '), 'AA 여우');
  for (const value of ['a', '<img src=x>', 'x\ny', '친구😀', 'ab\u202ecd', '가'.repeat(21), '___', '--', '\u0300\u0301', null, {}]) {
    assert.throws(() => normalizeNickname(value));
  }
});

test('cookie connection must complete before new runs; historical and resumed completions stay excluded', async () => {
  const { service, calls } = fixture();
  await service.event(started()); await service.event(completed());
  assert.equal(calls.starts.length, 0); assert.equal(calls.finishes.length, 0);
  await service.join(); await service.event(completed());
  assert.equal(calls.finishes.length, 0);
  await service.event(started()); await service.event(completed());
  assert.equal(calls.finishes.length, 1); assert.equal(service.profile.xp, 200);
  await service.event(started()); await service.event(completed());
  assert.equal(calls.starts.length, 1); assert.equal(calls.finishes.length, 1);
  const reloaded = fixture(); await reloaded.service.join(); await reloaded.service.event(completed());
  assert.equal(reloaded.calls.finishes.length, 0);
});

test('late start response, cancellation, mismatched modes and unsupported modes fail closed', async () => {
  const start = deferred(); const { service, calls } = fixture({ startRun: () => start.promise });
  await service.join(); const pendingStart = service.event(started());
  await service.event(completed()); start.resolve({ run: { id: 'late-run', mode } }); await pendingStart;
  assert.equal(calls.finishes.length, 0); assert.match(service.state.error, /시작 연결/);
  await service.event(completed()); assert.equal(calls.finishes.length, 0);
  const normal = fixture(); await normal.service.join();
  await normal.service.event(started('b'.repeat(32), { ...mode, difficulty: 'unknown' }));
  assert.equal(normal.calls.starts.length, 0);
  await normal.service.event(started());
  await normal.service.event(completed(attemptId, { mode: { ...mode, draw: 1 } }));
  assert.equal(normal.calls.finishes.length, 0);
  await normal.service.event({ type: 'cancelled', attemptId }); await normal.service.event(completed());
  assert.equal(normal.calls.finishes.length, 0);
});

test('suspending while session or run creation is in flight never reconnects a stale lifecycle or run', async () => {
  const session = deferred(); const first = fixture({ session: () => session.promise });
  const joining = first.service.join(); first.service.leave(); session.resolve({ user }); await joining;
  assert.equal(first.service.participating, false); assert.equal(first.service.profile, null);
  const run = deferred(); const second = fixture({ startRun: () => run.promise }); await second.service.join();
  const starting = second.service.event(started()); second.service.leave(); run.resolve({ run: { id: 'late', mode } }); await starting;
  await second.service.event(completed()); assert.equal(second.calls.finishes.length, 0);
});

test('completion retries use the same server run, immutable result and idempotency key', async () => {
  const requests = []; let fail = true;
  const { service } = fixture({ finishRun: async (...args) => {
    requests.push(structuredClone(args)); if (fail) throw new LeaderboardError('offline'); return { user: { ...user, xp: 200 } };
  } });
  await service.join(); await service.event(started()); await service.event(completed());
  assert.equal(service.state.pendingCount, 1);
  fail = false; await service.event(completed(attemptId, { score: 999999, moves: 1 }));
  assert.equal(requests.length, 2); assert.deepEqual(requests[1], requests[0]);
  assert.deepEqual(requests[0][1], { score: 1020, elapsedMs: 125_000, moves: 110, won: true });
  assert.equal(service.state.pendingCount, 0);
  await service.event(completed()); assert.equal(requests.length, 2);
});

test('concurrent duplicate completion shares one network request', async () => {
  const finish = deferred(); let count = 0;
  const { service } = fixture({ finishRun: () => { count++; return finish.promise; } });
  await service.join(); await service.event(started());
  const one = service.event(completed()); const two = service.event(completed());
  assert.equal(count, 1); finish.resolve({ user: { ...user, xp: 200 } }); await Promise.all([one, two]);
  assert.equal(service.state.pendingCount, 0);
});

test('terminal result rejection does not retry; temporary throttling can retry', async () => {
  for (const [status, expected] of [[409, 0], [429, 1], [503, 1]]) {
    const { service } = fixture({ finishRun: async () => { throw new LeaderboardError('rejected', status); } });
    await service.join(); await service.event(started()); await service.event(completed());
    assert.equal(service.state.pendingCount, expected);
  }
});

test('nickname edits preserve identity and XP, and deletion cancels participation', async () => {
  const { service, calls } = fixture(); await service.join(); await service.rename('새 이름');
  assert.deepEqual(service.profile, { ...user, nickname: '새 이름' }); assert.deepEqual(calls.renames, ['새 이름']);
  await service.event(started()); await service.remove(); await service.event(completed());
  assert.equal(service.profile, null); assert.equal(service.participating, false); assert.equal(calls.removals, 1);
  assert.equal(calls.finishes.length, 0);
});

test('only compatible cumulative XP rows are accepted and no public ID is required', async () => {
  const { service } = fixture({ board: async () => ({ metric: 'cumulative-xp', verification: 'client-reported', entries: [
    { rank: 1, nickname: '<img src=x onerror=alert(1)>', xp: 10, isMe: true, userId: 'not-public' },
    { rank: 2, nickname: 'invalid', xp: -1 },
  ] }) });
  await service.refreshBoard();
  assert.deepEqual(service.state.entries, [{ rank: 1, nickname: '<img src=x onerror=alert(1)>', xp: 10, isMe: true }]);
  const bad = fixture({ board: async () => ({ metric: 'time', verification: 'verified', entries: [] }) });
  await bad.service.refreshBoard(); assert.match(bad.service.state.error, /호환/);
});
