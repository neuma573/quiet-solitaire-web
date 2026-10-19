import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handle, normalizeNickname } from '../leaderboard/index.mjs';

const ORIGIN = 'https://neuma573.com';
const MODE = { difficulty: 'normal', draw: 1, scoring: 'standard' };
const RESULT = { score: 1000, elapsedMs: 1000, moves: 100, won: true };

// Execute actual migration SQL and statements, including SQLite transactions,
// uniqueness constraints, foreign keys and the XP credit trigger.
function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../leaderboard/migrations/0001_guest_xp.sql', import.meta.url), 'utf8'));
  const prepare = sql => {
    let bindings = [];
    return {
      bind(...values) { bindings = values; return this; },
      async first() { return sqlite.prepare(sql).get(...bindings) || null; },
      async all() { return { results: sqlite.prepare(sql).all(...bindings) }; },
      async run() { return { success: true, meta: sqlite.prepare(sql).run(...bindings) }; }
    };
  };
  const env = {
    DB: { prepare, async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    } },
    ALLOWED_ORIGIN: ORIGIN,
    RATE_LIMIT_SALT: 'local-test-only-32-byte-hmac-value'
  };
  let now = 1800000000000;
  async function request(path, { method = 'GET', identity, body, headers = {}, origin = ORIGIN, ip = '203.0.113.8' } = {}) {
    const requestHeaders = { 'CF-Connecting-IP': ip, ...headers };
    if (origin !== null) requestHeaders.Origin = origin;
    if (identity) {
      requestHeaders.Cookie = identity.cookie;
      requestHeaders['X-CSRF-Token'] = identity.csrfToken;
    }
    if (body !== undefined && !Object.hasOwn(requestHeaders, 'Content-Type')) requestHeaders['Content-Type'] = 'application/json';
    const response = await handle(new Request(`https://api.neuma573.com${path}`, {
      method, headers: requestHeaders, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    }), env, () => now);
    const data = response.status === 204 ? null : await response.json();
    return { response, data };
  }
  async function guest(ip) {
    const result = await request('/v1/session', { method: 'POST', body: {}, ip });
    assert.equal(result.response.status, 201);
    return { ...result.data, cookie: result.response.headers.get('Set-Cookie').split(';')[0], response: result.response };
  }
  async function start(identity) {
    const result = await request('/v1/runs', { method: 'POST', body: { mode: MODE }, identity });
    assert.equal(result.response.status, 201);
    return result.data.run;
  }
  async function finish(identity, run, key, result = RESULT) {
    return request(`/v1/runs/${run.id}/result`, { method: 'POST', identity, body: result, headers: { 'Idempotency-Key': key } });
  }
  return { sqlite, env, request, guest, start, finish, advance(ms) { now += ms; } };
}

test('guest write credentials are server-issued, hashed, HttpOnly and origin/CSRF bound', async t => {
  const f = fixture(); t.after(() => f.sqlite.close());
  const guest = await f.guest();
  const setCookie = guest.response.headers.get('Set-Cookie');
  assert.match(setCookie, /^__Host-quiet_guest=[a-f0-9]{64};/);
  assert.match(setCookie, /; Path=\/; Secure; HttpOnly; SameSite=Strict$/);
  assert(!setCookie.includes('Domain='));
  const session = f.sqlite.prepare('SELECT * FROM sessions').get();
  assert.notEqual(session.token_hash, guest.cookie.split('=')[1]);
  assert.deepEqual(Object.keys(guest.user).sort(), ['id', 'nickname', 'xp']);
  for (const origin of [null, 'https://attacker.example']) {
    const result = await f.request('/v1/session', { method: 'POST', body: {}, origin });
    assert.equal(result.response.status, 403);
    assert.equal(result.response.headers.get('Access-Control-Allow-Origin'), null);
  }
  const forged = await f.request('/v1/me', { method: 'PATCH', identity: { cookie: guest.cookie, csrfToken: 'wrong' }, body: { nickname: 'New Name' } });
  assert.equal(forged.response.status, 403);
  const clientIdentity = await f.request('/v1/me', { method: 'PATCH', identity: guest, body: { nickname: 'New Name', id: 'another-user' } });
  assert.equal(clientIdentity.response.status, 400);
  const me = await f.request('/v1/me', { identity: guest, origin: 'https://attacker.example' });
  assert.equal(me.response.status, 403);
});

test('result ownership, concurrent retries and conflicting idempotency keys cannot add XP twice', async t => {
  const f = fixture(); t.after(() => f.sqlite.close());
  const alice = await f.guest(), bob = await f.guest();
  const run = await f.start(alice);
  f.advance(2000);
  const stolen = await f.finish(bob, run, crypto.randomUUID());
  assert.equal(stolen.response.status, 404);
  const key = crypto.randomUUID();
  const results = await Promise.all(Array.from({ length: 8 }, () => f.finish(alice, run, key)));
  assert(results.every(result => [200, 201].includes(result.response.status)));
  assert.equal(results.filter(result => result.response.status === 201).length, 1);
  const row = f.sqlite.prepare('SELECT xp FROM guests WHERE id = ?').get(alice.user.id);
  assert.equal(row.xp, results[0].data.result.xpAwarded);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM results').get().count, 1);
  assert.equal((await f.finish(alice, run, crypto.randomUUID())).response.status, 409);
  assert.equal((await f.finish(alice, run, key, { ...RESULT, score: 1100 })).response.status, 409);
  const next = await f.start(alice);
  f.advance(2000);
  assert.equal((await f.finish(alice, next, key)).response.status, 409);
  assert.equal(f.sqlite.prepare('SELECT xp FROM guests WHERE id = ?').get(alice.user.id).xp, row.xp);
  const leaderboard = await f.request('/v1/leaderboard', { identity: alice });
  assert.deepEqual(Object.keys(leaderboard.data.entries[0]).sort(), ['isMe', 'nickname', 'rank', 'xp']);
  assert.equal(leaderboard.data.entries[0].isMe, true);
  assert(!JSON.stringify(leaderboard.data).includes(alice.user.id));
});

test('failed XP update rolls back the contribution so a safe retry can credit once', async t => {
  const f = fixture(); t.after(() => f.sqlite.close());
  const guest = await f.guest(), run = await f.start(guest), key = crypto.randomUUID();
  f.advance(2000);
  f.sqlite.exec("CREATE TRIGGER fail_credit BEFORE UPDATE OF xp ON guests WHEN NEW.xp > 0 BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;");
  const failed = await f.finish(guest, run, key);
  assert.equal(failed.response.status, 500);
  assert.deepEqual(failed.data, { error: 'internal_error' });
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM results').get().count, 0);
  assert.equal(f.sqlite.prepare('SELECT xp FROM guests').get().xp, 0);
  f.sqlite.exec('DROP TRIGGER fail_credit');
  const retried = await f.finish(guest, run, key);
  assert.equal(retried.response.status, 201);
  assert.equal(f.sqlite.prepare('SELECT xp FROM guests').get().xp, retried.data.result.xpAwarded);
});

test('nickname normalization rejects markup and invisible controls while preserving identity and XP', async t => {
  const f = fixture(); t.after(() => f.sqlite.close());
  for (const nickname of ['<img src=x onerror=alert(1)>', 'Name\u202eRLO', 'A\u200bB', 'A\nB', 'a', '___', '\u0301\u0301']) {
    assert.throws(() => normalizeNickname(nickname));
  }
  assert.equal(normalizeNickname('  ＡＢ   Player  '), 'AB Player');
  const guest = await f.guest(), run = await f.start(guest);
  f.advance(2000);
  const credited = await f.finish(guest, run, crypto.randomUUID());
  const changed = await f.request('/v1/me', { method: 'PATCH', identity: guest, body: { nickname: '새로운 이름' } });
  assert.equal(changed.response.status, 200);
  assert.equal(changed.data.user.id, guest.user.id);
  assert.equal(changed.data.user.xp, credited.data.user.xp);
  assert.equal(changed.data.user.nickname, '새로운 이름');
});

test('IP guest creation and identity nickname limits cannot be bypassed with client identity fields', async t => {
  const f = fixture(); t.after(() => f.sqlite.close());
  const guest = await f.guest();
  for (let i = 0; i < 9; i++) await f.guest();
  const blocked = await f.request('/v1/session', { method: 'POST', body: {} });
  assert.equal(blocked.response.status, 429);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM guests').get().count, 10);
  for (let i = 0; i < 5; i++) {
    assert.equal((await f.request('/v1/me', { method: 'PATCH', identity: guest, body: { nickname: `Name ${i}` } })).response.status, 200);
  }
  assert.equal((await f.request('/v1/me', { method: 'PATCH', identity: guest, body: { nickname: 'Too Many' } })).response.status, 429);
  assert.equal((await f.request('/v1/me', { method: 'PATCH', identity: guest, body: { nickname: 'Too Many', userId: crypto.randomUUID() } })).response.status, 400);
});

test('session renewal shares the IP write quota and rejection never extends the session', async t => {
  const f = fixture(); t.after(() => f.sqlite.close());
  const guest = await f.guest();
  await f.start(guest); // One write in the shared IP bucket.
  const rename = await f.request('/v1/me', { method: 'PATCH', identity: guest, body: { nickname: 'Renewed Guest' } });
  assert.equal(rename.response.status, 200); // A second write in the same bucket.
  const originalExpiry = f.sqlite.prepare('SELECT expires_at FROM sessions').get().expires_at;
  f.advance(1000);
  for (let i = 0; i < 118; i++) {
    const renewal = await f.request('/v1/session', { method: 'POST', identity: guest, body: {} });
    assert.equal(renewal.response.status, 200);
    assert.deepEqual(renewal.data, { user: rename.data.user, csrfToken: guest.csrfToken });
    assert.equal(renewal.response.headers.get('Set-Cookie').split(';')[0], guest.cookie);
  }
  const renewedExpiry = f.sqlite.prepare('SELECT expires_at FROM sessions').get().expires_at;
  assert.equal(renewedExpiry, originalExpiry + 1000);
  f.advance(1000);
  const blocked = await f.request('/v1/session', { method: 'POST', identity: guest, body: {} });
  assert.equal(blocked.response.status, 429);
  assert.deepEqual(blocked.data, { error: 'rate_limited' });
  assert.equal(blocked.response.headers.get('Retry-After'), '3600');
  assert.equal(blocked.response.headers.get('Set-Cookie'), null);
  assert.equal(f.sqlite.prepare('SELECT expires_at FROM sessions').get().expires_at, renewedExpiry);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM guests').get().n, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
  assert.equal((await f.request('/v1/me', { identity: guest })).response.status, 200, 'Throttling must not log the guest out');
  f.advance(3600000);
  const nextWindow = await f.request('/v1/session', { method: 'POST', identity: guest, body: {} });
  assert.equal(nextWindow.response.status, 200);
  assert.equal(nextWindow.data.user.id, guest.user.id);
});

test('concurrent renewal cannot exceed the shared write budget and requires network identity', async t => {
  const f = fixture(); t.after(() => f.sqlite.close());
  const guest = await f.guest();
  const expiry = f.sqlite.prepare('SELECT expires_at FROM sessions').get().expires_at;
  f.advance(1000);
  const missingIp = await f.request('/v1/session', { method: 'POST', identity: guest, body: {}, ip: '' });
  assert.equal(missingIp.response.status, 503);
  assert.deepEqual(missingIp.data, { error: 'network_identity_unavailable' });
  assert.equal(f.sqlite.prepare('SELECT expires_at FROM sessions').get().expires_at, expiry);
  const results = await Promise.all(Array.from({ length: 130 }, () =>
    f.request('/v1/session', { method: 'POST', identity: guest, body: {} })));
  assert.equal(results.filter(result => result.response.status === 200).length, 120);
  assert.equal(results.filter(result => result.response.status === 429).length, 10);
  assert.equal((await f.request('/v1/runs', { method: 'POST', identity: guest, body: { mode: MODE } })).response.status, 429);
  const differentIp = await f.request('/v1/session', { method: 'POST', identity: guest, body: {}, ip: '203.0.113.9' });
  assert.equal(differentIp.response.status, 200);
  assert.equal(differentIp.data.user.id, guest.user.id);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM guests').get().n, 1);
});

test('deletion between session lookup and renewal cannot reissue the deleted identity', async t => {
  const f = fixture(); t.after(() => f.sqlite.close());
  const guest = await f.guest();
  const originalPrepare = f.env.DB.prepare;
  let intercepted = false;
  f.env.DB.prepare = sql => {
    const statement = originalPrepare(sql);
    if (sql.startsWith('UPDATE sessions SET expires_at')) {
      // Model the other tab committing deletion after the authenticated read
      // but immediately before the renewal statement reaches D1.
      for (const method of ['first', 'run']) {
        const execute = statement[method];
        statement[method] = async () => {
          intercepted = true;
          f.sqlite.prepare('DELETE FROM guests WHERE id = ?').run(guest.user.id);
          return execute();
        };
      }
    }
    return statement;
  };
  const renewal = await f.request('/v1/session', { method: 'POST', identity: guest, body: {} });
  assert.equal(intercepted, true);
  assert.equal(renewal.response.status, 401);
  assert.deepEqual(renewal.data, { error: 'session_required' });
  assert.equal(renewal.response.headers.get('Set-Cookie'), null);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM guests').get().n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  assert.equal((await f.request('/v1/me', { identity: guest })).response.status, 401);
});

test('deletion removes guest results and credentials, clears cookie, and preserves others', async t => {
  const f = fixture(); t.after(() => f.sqlite.close());
  const guest = await f.guest(), other = await f.guest(), run = await f.start(guest);
  f.advance(2000);
  await f.finish(guest, run, crypto.randomUUID());
  const removed = await f.request('/v1/me', { method: 'DELETE', identity: guest });
  assert.equal(removed.response.status, 204);
  assert.match(removed.response.headers.get('Set-Cookie'), /Max-Age=0;/);
  for (const table of ['guests', 'sessions', 'runs', 'results']) {
    const column = table === 'guests' ? 'id' : 'user_id';
    assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get(guest.user.id).count, 0);
  }
  assert.equal((await f.request('/v1/me', { identity: guest })).response.status, 401);
  assert.equal((await f.request('/v1/me', { identity: other })).response.status, 200);
});

test('body limits and strict schema prevent bulk/legacy XP uploads', async t => {
  const f = fixture(); t.after(() => f.sqlite.close());
  const guest = await f.guest();
  assert.equal((await f.request('/v1/session', { method: 'POST', body: { xp: 999999 } })).response.status, 400);
  assert.equal((await f.request('/v1/me', { method: 'PATCH', identity: guest, body: { nickname: 'Name', xp: 999999 } })).response.status, 400);
  assert.equal((await f.request('/v1/me', { method: 'PATCH', identity: guest, body: '{"nickname":"' + 'x'.repeat(3000) + '"}' })).response.status, 413);
  assert.equal((await f.request('/v1/session', { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain' } })).response.status, 415);
  assert.equal(f.sqlite.prepare('SELECT xp FROM guests').get().xp, 0);
});
