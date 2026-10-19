import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker, { handle, calculateXp, normalizeNickname, cleanup } from '../leaderboard/index.mjs';
import { createLeaderboardClient } from '../web/leaderboard.mjs';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../leaderboard/migrations/0001_guest_xp.sql', import.meta.url), 'utf8'));
  const wrap = (sql, args = []) => ({
    sql, args,
    bind(...values) { return wrap(sql, values); },
    async first() { return sqlite.prepare(sql).get(...args) || null; },
    async all() { return { results: sqlite.prepare(sql).all(...args) }; },
    async run() { const result = sqlite.prepare(sql).run(...args); return { meta: { changes: result.changes } }; }
  });
  return {
    sqlite,
    prepare: wrap,
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const rows = statements.map(s => ({ results: sqlite.prepare(s.sql).all(...s.args) }));
        sqlite.exec('COMMIT');
        return rows;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }
  };
}
function fixture() {
  const DB = database();
  const env = { DB, ALLOWED_ORIGIN: 'https://game.example', RATE_LIMIT_SALT: 'test-only-32-character-secret-value' };
  let time = 1800000000000, cookie = '', csrf = '';
  const call = async (path, options = {}) => {
    const headers = { Origin: env.ALLOWED_ORIGIN, 'CF-Connecting-IP': '192.0.2.1', Cookie: cookie, ...options.headers };
    if (csrf) headers['X-CSRF-Token'] ??= csrf;
    const init = { method: options.method || 'GET', headers };
    if (options.body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(options.body); }
    const response = await handle(new Request('https://api.example' + path, init), env, () => time);
    return response;
  };
  return { env, DB, call,
    advance(ms) { time += ms; },
    async join() {
      const response = await call('/v1/session', { method: 'POST', body: {} });
      assert.equal(response.status, 201);
      cookie = response.headers.get('Set-Cookie').split(';')[0];
      const data = await response.json(); csrf = data.csrfToken; return data;
    }
  };
}
const mode = { difficulty: 'normal', draw: 1, scoring: 'standard' };
const outcome = { score: 450, elapsedMs: 60000, moves: 90, won: true };

test('API prefix trailing slashes and root settings agree with every client endpoint', async t => {
  for (const prefix of [undefined, '', '/', '///', '/api/leaderboard', '/api/leaderboard/', '/api/leaderboard///']) {
    await t.test(`API_PREFIX=${JSON.stringify(prefix)}`, async t => {
      const f = fixture();
      t.after(() => f.DB.sqlite.close());
      f.env.API_PREFIX = prefix;
      let cookie = '';
      const client = createLeaderboardClient({ apiBase: 'https://api.example' + (prefix ?? ''),
        fetchImpl: async (url, options) => {
          const headers = new Headers(options.headers);
          headers.set('Origin', f.env.ALLOWED_ORIGIN);
          headers.set('CF-Connecting-IP', '192.0.2.1');
          if (cookie) headers.set('Cookie', cookie);
          const response = await handle(new Request(url, { ...options, headers }), f.env, () => 1800000060000);
          if (response.headers.has('Set-Cookie')) cookie = response.headers.get('Set-Cookie').split(';')[0];
          return response;
        }
      });
      const joined = await client.session();
      assert.equal((await client.me()).user.id, joined.user.id);
      assert.equal((await client.rename('Updated Name')).user.id, joined.user.id);
      const { run } = await client.startRun(mode);
      const key = crypto.randomUUID();
      const result = { ...outcome, elapsedMs: 1000 };
      assert.equal((await client.finishRun(run.id, result, key)).user.xp, 208);
      assert.equal((await client.finishRun(run.id, result, key)).replayed, true);
      assert.deepEqual((await client.board()).entries, [{ rank: 1, nickname: 'Updated Name', xp: 208, isMe: true }]);
      assert.equal(await client.remove(), null);
      if (prefix?.replace(/\/+$/, '')) {
        assert.equal((await f.call('/v1/leaderboard')).status, 404);
        assert.equal((await f.call('/api/leaderboard-extra/v1/leaderboard')).status, 404);
      }
    });
  }
});

test('malformed API prefixes fail configuration validation', async t => {
  const f = fixture();
  t.after(() => f.DB.sqlite.close());
  for (const prefix of ['api/', '/api?x/', '/api#x', '/api/%2f', '/api /', 42, false, {}]) {
    f.env.API_PREFIX = prefix;
    const response = await f.call('/v1/leaderboard');
    assert.equal(response.status, 503, JSON.stringify(prefix));
    assert.deepEqual(await response.json(), { error: 'not_configured' });
  }
});

test('upstream-compatible XP formula uses mode and score, with no direct client XP field', () => {
  assert.equal(calculateXp(mode, 450), 208);
  assert.equal(calculateXp({ difficulty: 'casual', draw: 3, scoring: 'standard' }, 450), 182);
  assert.equal(calculateXp({ difficulty: 'challenge', draw: 3, scoring: 'vegas' }, 208), 2100);
  assert.throws(() => calculateXp(mode, NaN));
  assert.throws(() => calculateXp(mode, 1522581));
  assert.throws(() => calculateXp({ ...mode, scoring: 'vegas' }, 207));
  assert.throws(() => calculateXp({ ...mode, draw: 2 }, 100));
});

test('nickname normalization accepts Korean and NFKC text, rejects markup and invisible controls', () => {
  assert.equal(normalizeNickname('  Ａlice   수달  '), 'Alice 수달');
  for (const value of ['', 'a', '<script>', 'A\u202eB', 'A\nB', '\nAlice\n', '🙂🙂', '_-', 'a'.repeat(21)])
    assert.throws(() => normalizeNickname(value));
});

test('guest UUID is stable, cookie is secure and only its hash is stored', async t => {
  const f = fixture(); t.after(() => f.DB.sqlite.close());
  const created = await f.join();
  assert.match(created.user.id, /^[0-9a-f-]{36}$/);
  assert.match(created.user.nickname, /\d{4}$/);
  assert.equal(created.user.xp, 0);
  assert.equal(created.csrfToken.length, 64);
  const repeated = await f.call('/v1/session', { method: 'POST', body: {} });
  assert.equal(repeated.status, 200);
  assert.deepEqual(await repeated.json(), created);
  const me = await f.call('/v1/me');
  assert.deepEqual(await me.json(), created);
  // A normal same-origin browser GET can omit Origin; only trusted fetch
  // metadata on the configured same origin is accepted in that case.
  const cookies = repeated.headers.get('Set-Cookie').split(';')[0];
  const sameOrigin = await handle(new Request('https://game.example/v1/me', { headers: {
    Cookie: cookies, 'Sec-Fetch-Site': 'same-origin'
  } }), f.env, () => 1800000000000);
  assert.equal(sameOrigin.status, 200);
  const crossOrigin = await handle(new Request('https://api.example/v1/me', { headers: {
    Cookie: cookies, 'Sec-Fetch-Site': 'same-origin'
  } }), f.env, () => 1800000000000);
  assert.equal(crossOrigin.status, 403);
  const rows = f.DB.sqlite.prepare('SELECT * FROM sessions').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token_hash.length, 64);
  assert.equal(rows[0].user_id, created.user.id);
  f.advance(179 * 86400000);
  const renewed = await f.call('/v1/session', { method: 'POST', body: {} });
  assert.equal(renewed.status, 200);
  assert.deepEqual(await renewed.json(), created);
  assert.match(renewed.headers.get('Set-Cookie'), /Max-Age=15552000/);
  f.advance(2 * 86400000);
  assert.equal((await f.call('/v1/me')).status, 200);
});

test('new opt-in run credits once, nickname preserves ID/XP, board publishes minimal fields', async t => {
  const f = fixture(); t.after(() => f.DB.sqlite.close());
  const initial = await f.join();
  const started = await f.call('/v1/runs', { method: 'POST', body: { mode } });
  assert.equal(started.status, 201);
  const { run } = await started.json();
  f.advance(65000);
  const key = crypto.randomUUID();
  const submit = () => f.call(`/v1/runs/${run.id}/result`, { method: 'POST', body: outcome, headers: { 'Idempotency-Key': key } });
  const first = await submit();
  assert.equal(first.status, 201);
  const data = await first.json();
  assert.equal(data.result.xpAwarded, 208);
  assert.equal(data.result.verification, 'client-reported');
  assert.equal(data.user.xp, 208);
  assert.equal(data.replayed, false);
  const duplicate = await submit();
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).replayed, true);
  const renamed = await f.call('/v1/me', { method: 'PATCH', body: { nickname: '나의 수달' } });
  assert.deepEqual((await renamed.json()).user, { id: initial.user.id, nickname: '나의 수달', xp: 208 });
  const board = await f.call('/v1/leaderboard');
  assert.deepEqual(await board.json(), { metric: 'cumulative-xp', verification: 'client-reported', rankedAvailable: false,
    entries: [{ rank: 1, nickname: '나의 수달', xp: 208, isMe: true }] });
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM results').get().n, 1);
  assert.equal(f.DB.sqlite.prepare('SELECT xp FROM guests').get().xp, 208);
});

test('retry after ticket expiry returns original contribution; changed replay never adds XP', async t => {
  const f = fixture(); t.after(() => f.DB.sqlite.close()); await f.join();
  const { run } = await (await f.call('/v1/runs', { method: 'POST', body: { mode } })).json();
  f.advance(65000);
  const key = crypto.randomUUID();
  const options = { method: 'POST', body: outcome, headers: { 'Idempotency-Key': key } };
  assert.equal((await f.call(`/v1/runs/${run.id}/result`, options)).status, 201);
  f.advance(86400000);
  assert.equal((await f.call(`/v1/runs/${run.id}/result`, options)).status, 200);
  assert.equal((await f.call(`/v1/runs/${run.id}/result`, { ...options, body: { ...outcome, score: 1000 } })).status, 409);
  assert.equal((await f.call(`/v1/runs/${run.id}/result`, { ...options, headers: { 'Idempotency-Key': crypto.randomUUID() } })).status, 409);
  assert.equal(f.DB.sqlite.prepare('SELECT xp FROM guests').get().xp, 208);
});

test('ticket bounds, unknown mode and arbitrary XP/identity fields are rejected', async t => {
  const f = fixture(); t.after(() => f.DB.sqlite.close()); await f.join();
  assert.equal((await f.call('/v1/runs', { method: 'POST', body: { mode: { ...mode, difficulty: 'invented' } } })).status, 400);
  const { run } = await (await f.call('/v1/runs', { method: 'POST', body: { mode } })).json();
  const send = body => f.call(`/v1/runs/${run.id}/result`, { method: 'POST', body, headers: { 'Idempotency-Key': crypto.randomUUID() } });
  assert.equal((await send(outcome)).status, 400); // Future active time compared with server start.
  f.advance(65000);
  for (const invalid of [{ ...outcome, xp: 90000 }, { ...outcome, userId: crypto.randomUUID() }, { ...outcome, won: false },
    { ...outcome, moves: -1 }, { ...outcome, score: 1522581 }, { ...outcome, score: 1000000 },
    { ...outcome, elapsedMs: 1.5 }, { ...outcome, elapsedMs: 60001 }])
    assert.equal((await send(invalid)).status, 400);
  f.advance(86400000);
  assert.equal((await send(outcome)).status, 410);
  assert.equal(f.DB.sqlite.prepare('SELECT xp FROM guests').get().xp, 0);
});

test('largest bounded Standard XP fits the contribution schema and compatible modes share one total', async t => {
  const f = fixture(); t.after(() => f.DB.sqlite.close()); await f.join();
  const maximumMode = { difficulty: 'challenge', draw: 3, scoring: 'standard' };
  const { run } = await (await f.call('/v1/runs', { method: 'POST', body: { mode: maximumMode } })).json();
  f.advance(31000);
  const maximum = await f.call(`/v1/runs/${run.id}/result`, { method: 'POST',
    body: { won: true, score: 1522580, elapsedMs: 31000, moves: 100000 }, headers: { 'Idempotency-Key': crypto.randomUUID() } });
  assert.equal(maximum.status, 201);
  assert.equal((await maximum.json()).result.xpAwarded, 107275);
  const vegasMode = { difficulty: 'casual', draw: 1, scoring: 'vegas' };
  const next = await (await f.call('/v1/runs', { method: 'POST', body: { mode: vegasMode } })).json();
  f.advance(65000);
  const vegas = await f.call(`/v1/runs/${next.run.id}/result`, { method: 'POST',
    body: { ...outcome, score: 208 }, headers: { 'Idempotency-Key': crypto.randomUUID() } });
  assert.equal(vegas.status, 201);
  const accepted = await vegas.json();
  assert.equal(accepted.result.xpAwarded, 300);
  assert.equal(accepted.user.xp, 107575);
  assert.equal((await (await f.call('/v1/leaderboard')).json()).entries[0].xp, 107575);
});

test('deletion cascades identity, cookie, runs and all contributions; cleanup purges transient buckets', async t => {
  const f = fixture(); t.after(() => f.DB.sqlite.close()); await f.join();
  const { run } = await (await f.call('/v1/runs', { method: 'POST', body: { mode } })).json();
  f.advance(65000);
  await f.call(`/v1/runs/${run.id}/result`, { method: 'POST', body: outcome, headers: { 'Idempotency-Key': crypto.randomUUID() } });
  const removed = await f.call('/v1/me', { method: 'DELETE' });
  assert.equal(removed.status, 204);
  assert.match(removed.headers.get('Set-Cookie'), /Max-Age=0; Path=\/; Secure; HttpOnly; SameSite=Strict/);
  for (const table of ['guests', 'sessions', 'runs', 'results']) assert.equal(f.DB.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
  assert.equal((await f.call('/v1/me')).status, 401);
  await cleanup(f.env, 1800000000000 + 2 * 86400000);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM rate_limits').get().n, 0);
});

test('Worker fetch adapter ignores ExecutionContext and fails closed when unconfigured', async t => {
  const f = fixture(); t.after(() => f.DB.sqlite.close());
  const live = await worker.fetch(new Request('https://api.example/v1/leaderboard', { headers: {
    Origin: f.env.ALLOWED_ORIGIN, 'CF-Connecting-IP': '192.0.2.1'
  } }), f.env, { waitUntil() {} });
  assert.equal(live.status, 200);
  assert.deepEqual((await live.json()).entries, []);
  const response = await worker.fetch(new Request('https://api.example/v1/leaderboard'), {}, { waitUntil() {} });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'not_configured' });
});
