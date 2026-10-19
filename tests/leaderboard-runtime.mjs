// Optional actual workerd/D1 check after local migration + `wrangler dev --local`.
// Requests only loopback. Use an isolated temporary --persist-to directory.
import assert from 'node:assert/strict';

const base = process.env.LEADERBOARD_LOCAL_URL || 'http://127.0.0.1:8787';
const origin = process.env.LEADERBOARD_LOCAL_ORIGIN || 'http://localhost:8787';
const url = new URL(base);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Local runtime checks must never target a deployed API');
assert.equal(url.protocol, 'http:');
const guests = [];
async function call(path, { method = 'GET', body, guest, key, headers = {} } = {}) {
  const requestHeaders = { Origin: origin, ...headers };
  if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
  if (guest) { requestHeaders.Cookie = guest.cookie; requestHeaders['X-CSRF-Token'] = guest.csrfToken; }
  if (key) requestHeaders['Idempotency-Key'] = key;
  return fetch(base + path, { method, headers: requestHeaders, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
async function join() {
  const response = await call('/v1/session', { method: 'POST', body: {} });
  assert.equal(response.status, 201);
  const value = await response.json();
  const setCookie = response.headers.get('Set-Cookie');
  assert.match(setCookie, /; Secure; HttpOnly; SameSite=Strict/);
  const guest = { ...value, cookie: setCookie.split(';')[0] };
  guests.push(guest); return guest;
}
try {
  const a = await join(), b = await join();
  assert.notEqual(a.user.id, b.user.id);
  assert.equal((await call('/v1/me', { guest: a })).status, 200);
  assert.equal((await call('/v1/me', { method: 'PATCH', body: { nickname: '차단된 이름' }, guest: a,
    headers: { Origin: 'https://foreign.invalid' } })).status, 403);
  const noCsrf = await fetch(base + '/v1/me', { method: 'PATCH', headers: {
    Origin: origin, Cookie: a.cookie, 'Content-Type': 'application/json'
  }, body: '{"nickname":"거절될 이름"}' });
  assert.equal(noCsrf.status, 403);

  const mode = { difficulty: 'normal', draw: 1, scoring: 'standard' };
  const start = await call('/v1/runs', { method: 'POST', body: { mode }, guest: a });
  assert.equal(start.status, 201);
  const { run } = await start.json();
  const key = crypto.randomUUID();
  const outcome = { score: 450, elapsedMs: 1000, moves: 90, won: true };
  const options = { method: 'POST', body: outcome, guest: a, key };
  const attempts = await Promise.all([call(`/v1/runs/${run.id}/result`, options), call(`/v1/runs/${run.id}/result`, options)]);
  assert.deepEqual(attempts.map(response => response.status).sort(), [200, 201]);
  for (const response of attempts) {
    const result = await response.json();
    assert.equal(result.user.xp, 208); assert.equal(result.result.xpAwarded, 208);
  }
  assert.equal((await call(`/v1/runs/${run.id}/result`, { ...options, body: { ...outcome, score: 800 } })).status, 409);
  assert.equal((await call(`/v1/runs/${run.id}/result`, { ...options, body: { ...outcome, xp: 100000 } })).status, 400);
  const rename = await call('/v1/me', { method: 'PATCH', body: { nickname: '로컬 검증 수달' }, guest: a });
  assert.equal(rename.status, 200);
  assert.deepEqual((await rename.json()).user, { id: a.user.id, nickname: '로컬 검증 수달', xp: 208 });
  const restored = await call('/v1/session', { method: 'POST', body: {}, guest: a });
  assert.equal(restored.status, 200); assert.equal((await restored.json()).user.id, a.user.id);

  const next = await call('/v1/runs', { method: 'POST', guest: b,
    body: { mode: { difficulty: 'casual', draw: 1, scoring: 'vegas' } } });
  const runB = (await next.json()).run;
  const wonB = await call(`/v1/runs/${runB.id}/result`, { method: 'POST', guest: b, key: crypto.randomUUID(),
    body: { ...outcome, score: 208 } });
  assert.equal(wonB.status, 201); assert.equal((await wonB.json()).user.xp, 300);
  const board = await call('/v1/leaderboard', { guest: b });
  assert.equal(board.status, 200);
  const rows = (await board.json()).entries;
  assert.deepEqual(rows.slice(0, 2).map(row => [row.rank, row.xp, row.isMe]), [[1, 300, true], [2, 208, false]]);
  const removed = await call('/v1/me', { method: 'DELETE', guest: a });
  assert.equal(removed.status, 204); assert.match(removed.headers.get('Set-Cookie'), /Max-Age=0/);
  assert.equal((await call('/v1/me', { guest: a })).status, 401);
  const remaining = await (await call('/v1/leaderboard', { guest: b })).json();
  assert.deepEqual(remaining.entries.map(row => [row.xp, row.isMe]), [[300, true]]);
  const scheduled = await fetch(base + '/__scheduled?cron=23+4+*+*+*');
  assert.equal(scheduled.status, 200, 'Actual workerd scheduled cleanup must complete');
  console.log('Local workerd + D1 passed: migration-backed guest auth/CSRF, concurrent replay-safe XP, strict fields, stable nickname/ID/XP, two guests/shared ordered board, deletion, scheduled cleanup.');
} finally {
  for (const guest of guests) await call('/v1/me', { method: 'DELETE', guest }).catch(() => {});
}
