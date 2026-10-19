/** Independent gameplay API. Never import the repository-dispatch Worker here. */
const COOKIE = '__Host-quiet_guest';
const SESSION_MS = 180 * 86400000;
const RUN_MS = 86400000;
const RULESET = 'quiet-xp-v1';
const MAX_BODY = 2048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_TOKEN = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
const adjectives = ['고요한', '푸른', '느긋한', '반짝이는', '다정한', '용감한', '포근한', '즐거운'];
const animals = ['수달', '여우', '고래', '참새', '토끼', '다람쥐', '펭귄', '고양이'];

class ApiError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
function fail(status, code) { throw new ApiError(status, code); }
function hex(bytes) { return Array.from(bytes, x => x.toString(16).padStart(2, '0')).join(''); }
function token() { return hex(crypto.getRandomValues(new Uint8Array(32))); }
async function hash(value) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))); }
async function networkHash(salt, value) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))));
}
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra } });
}
function config(env) {
  if (!env.DB || typeof env.RATE_LIMIT_SALT !== 'string' || env.RATE_LIMIT_SALT.length < 32) fail(503, 'not_configured');
  let origin;
  try {
    const u = new URL(env.ALLOWED_ORIGIN);
    const local = env.LOCAL_DEVELOPMENT === 'true' && ['localhost', '127.0.0.1'].includes(u.hostname);
    if ((env.LOCAL_DEVELOPMENT === 'true' && !local) || (!local && u.protocol !== 'https:') || u.origin !== env.ALLOWED_ORIGIN) throw new Error();
    origin = u.origin;
  } catch { fail(503, 'not_configured'); }
  const configuredPrefix = env.API_PREFIX ?? '';
  if (typeof configuredPrefix !== 'string') fail(503, 'not_configured');
  const prefix = configuredPrefix.replace(/\/+$/, '');
  if (prefix && !/^\/[a-zA-Z0-9/_-]+$/.test(prefix)) fail(503, 'not_configured');
  return { origin, prefix };
}
function keys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) fail(400, 'invalid_fields');
}
async function body(request) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') fail(415, 'json_required');
  if (Number(request.headers.get('Content-Length')) > MAX_BODY) fail(413, 'body_too_large');
  const reader = request.body?.getReader();
  let bytes = 0;
  const chunks = [];
  if (reader) {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BODY) { await reader.cancel(); fail(413, 'body_too_large'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)); }
  catch { fail(400, 'invalid_json'); }
}
export function normalizeNickname(value) {
  if (typeof value !== 'string' || value.length > 100 || /[\p{Cc}\p{Cf}]/u.test(value)) fail(400, 'invalid_nickname');
  const nickname = value.normalize('NFKC').trim().replace(/ +/g, ' ');
  if ([...nickname].length < 2 || [...nickname].length > 20 || !/^[\p{L}\p{M}\p{N} _-]+$/u.test(nickname) ||
      !/[\p{L}\p{N}]/u.test(nickname)) fail(400, 'invalid_nickname');
  return nickname;
}
function randomNickname() {
  const numbers = crypto.getRandomValues(new Uint32Array(3));
  return `${adjectives[numbers[0] % adjectives.length]}${animals[numbers[1] % animals.length]}${1000 + numbers[2] % 9000}`;
}
export function validateMode(mode) {
  keys(mode, ['difficulty', 'draw', 'scoring']);
  if (!['casual', 'normal', 'challenge'].includes(mode.difficulty) || ![1, 3].includes(mode.draw) ||
      !['standard', 'vegas'].includes(mode.scoring)) fail(400, 'invalid_mode');
  return { difficulty: mode.difficulty, draw: mode.draw, scoring: mode.scoring };
}
export function calculateXp(mode, score) {
  validateMode(mode);
  if (!Number.isSafeInteger(score) || score < 0 || score > 1522580 || (mode.scoring === 'vegas' && score !== 208)) fail(400, 'invalid_score');
  const normalized = mode.scoring === 'vegas' ? Math.floor(score * 10000 / 208) : score;
  const base = 100 + Math.floor(normalized / 100);
  let units = { casual: 8, normal: 16, challenge: 32 }[mode.difficulty];
  if (mode.draw === 3) units = units * 7 / 4;
  if (mode.scoring === 'vegas') units = units * 3 / 2;
  return Math.floor(base * units / 8);
}
function cookieValue(request) {
  const matches = (request.headers.get('Cookie') || '').split(';').map(x => x.trim()).filter(x => x.startsWith(`${COOKIE}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(COOKIE.length + 1);
  return HEX_TOKEN.test(value) ? value : null;
}
function cookie(value, age = SESSION_MS / 1000) {
  return `${COOKIE}=${value}; Max-Age=${age}; Path=/; Secure; HttpOnly; SameSite=Strict`;
}
async function session(request, db, now, required = true) {
  const value = cookieValue(request);
  const row = value && await db.prepare(`SELECT s.token_hash, s.csrf_token, s.expires_at, g.id, g.nickname, g.xp
    FROM sessions s JOIN guests g ON g.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`).bind(await hash(value), now).first();
  if (!row && required) fail(401, 'session_required');
  return row || null;
}
function user(row) { return { id: row.id, nickname: row.nickname, xp: row.xp }; }
function privateProfile(row) { return { user: user(row), csrfToken: row.csrf_token }; }
async function limit(db, bucket, now, windowMs, maximum) {
  const start = Math.floor(now / windowMs) * windowMs;
  const row = await db.prepare(`INSERT INTO rate_limits (bucket, hits, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(bucket) DO UPDATE SET hits = hits + 1 RETURNING hits`).bind(`${bucket}:${start}`, start + windowMs).first();
  if (row.hits > maximum) fail(429, 'rate_limited');
}
async function networkLimit(request, env, now, scope, maximum, windowMs = 3600000) {
  const ip = request.headers.get('CF-Connecting-IP') || (env.LOCAL_DEVELOPMENT === 'true' ? 'local-development' : '');
  if (!ip) fail(503, 'network_identity_unavailable');
  // The day is included in the HMAC input, preventing long-term linkage of IP buckets.
  const digest = await networkHash(env.RATE_LIMIT_SALT, `${Math.floor(now / 86400000)}:${ip}`);
  await limit(env.DB, `network:${scope}:${digest}`, now, windowMs, maximum);
}
async function userLimit(env, row, now, scope, maximum, windowMs = 3600000) {
  const digest = await hash(row.id);
  await limit(env.DB, `user:${digest}:${scope}`, now, windowMs, maximum);
}
function csrf(request, row) {
  if (request.headers.get('X-CSRF-Token') !== row.csrf_token) fail(403, 'csrf_required');
}
function resultJson(row) { return { id: row.id, xpAwarded: row.xp_awarded, verification: 'client-reported' }; }

/** Injecting a clock is only a local test seam, never a request-controlled value. */
export async function handle(request, env, clock = Date.now) {
  let allowed = false;
  try {
    const cfg = config(env);
    const origin = request.headers.get('Origin');
    allowed = origin === cfg.origin;
    const url = new URL(request.url);
    const path = cfg.prefix ? (url.pathname.startsWith(`${cfg.prefix}/`) ? url.pathname.slice(cfg.prefix.length) : '') : url.pathname;
    if (origin && !allowed) fail(403, 'origin_not_allowed');
    if (request.method === 'OPTIONS') {
      if (!allowed) fail(403, 'origin_required');
      return decorate(new Response(null, { status: 204 }), true, cfg.origin);
    }
    const mutation = !['GET', 'HEAD'].includes(request.method);
    if (mutation && !allowed) fail(403, 'origin_required');
    const now = clock();
    let response;
    if (request.method === 'POST' && path === '/v1/session') {
      const data = await body(request); keys(data, []);
      const existing = await session(request, env.DB, now, false);
      if (existing) {
        // Renewal mutates session expiry and shares the same per-IP budget as
        // other authenticated writes; a valid bearer must not bypass it.
        await networkLimit(request, env, now, 'write', 120);
        // Explicitly returning to the feature renews this same identity and bearer.
        // No new account or XP history is created by renewal.
        const renewed = await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ? RETURNING token_hash')
          .bind(now + SESSION_MS, existing.token_hash).first();
        // Another tab can delete the guest (cascading its session) after the
        // lookup. Never reissue a bearer or stale profile for a missing row.
        if (!renewed) fail(401, 'session_required');
        response = json(privateProfile(existing), 200, { 'Set-Cookie': cookie(cookieValue(request)) });
      }
      else {
        await networkLimit(request, env, now, 'create', 10);
        const id = crypto.randomUUID(), bearer = token(), csrfToken = token();
        const nickname = randomNickname();
        await env.DB.batch([
          env.DB.prepare('INSERT INTO guests (id, nickname, created_at, updated_at) VALUES (?, ?, ?, ?)').bind(id, nickname, now, now),
          env.DB.prepare('INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)').bind(await hash(bearer), id, csrfToken, now + SESSION_MS)
        ]);
        response = json({ user: { id, nickname, xp: 0 }, csrfToken }, 201, { 'Set-Cookie': cookie(bearer) });
      }
    } else if (path === '/v1/me' && request.method === 'GET') {
      // Browsers may omit Origin on a same-origin GET. Fetch Metadata is a
      // browser-controlled header; accept it only when the API URL itself is
      // the one configured frontend origin. Cross-origin GETs still need CORS.
      const sameOriginGet = !origin && url.origin === cfg.origin && request.headers.get('Sec-Fetch-Site') === 'same-origin';
      if (!allowed && !sameOriginGet) fail(403, 'origin_required');
      response = json(privateProfile(await session(request, env.DB, now)));
    } else if (path === '/v1/me' && request.method === 'PATCH') {
      const row = await session(request, env.DB, now); csrf(request, row);
      const data = await body(request); keys(data, ['nickname']);
      const nickname = normalizeNickname(data.nickname);
      await networkLimit(request, env, now, 'write', 120);
      await userLimit(env, row, now, 'nickname', 5);
      const updated = await env.DB.prepare('UPDATE guests SET nickname = ?, updated_at = ? WHERE id = ? RETURNING id, nickname, xp').bind(nickname, now, row.id).first();
      if (!updated) fail(401, 'session_required');
      response = json({ user: user(updated) });
    } else if (path === '/v1/me' && request.method === 'DELETE') {
      const row = await session(request, env.DB, now); csrf(request, row);
      await networkLimit(request, env, now, 'write', 120);
      const quotaPrefix = `user:${await hash(row.id)}`;
      await env.DB.batch([
        env.DB.prepare('DELETE FROM guests WHERE id = ?').bind(row.id),
        // D1 limits LIKE/GLOB pattern length more strictly than stock SQLite.
        // All user bucket keys start with this fixed hex digest and colon;
        // the next ASCII delimiter is semicolon, so this indexed range covers
        // exactly that guest's buckets without a long wildcard pattern.
        env.DB.prepare('DELETE FROM rate_limits WHERE bucket >= ? AND bucket < ?').bind(`${quotaPrefix}:`, `${quotaPrefix};`)
      ]);
      response = new Response(null, { status: 204, headers: { 'Set-Cookie': cookie('', 0) } });
    } else if (path === '/v1/runs' && request.method === 'POST') {
      const row = await session(request, env.DB, now); csrf(request, row);
      const data = await body(request); keys(data, ['mode']);
      const mode = validateMode(data.mode);
      await networkLimit(request, env, now, 'write', 120);
      await userLimit(env, row, now, 'run', 60);
      const id = crypto.randomUUID();
      await env.DB.prepare(`INSERT INTO runs (id, user_id, difficulty, draw, scoring, ruleset, started_at, expires_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM guests WHERE id = ?)`)
        .bind(id, row.id, mode.difficulty, mode.draw, mode.scoring, RULESET, now, now + RUN_MS, row.id).run();
      const run = await env.DB.prepare('SELECT id FROM runs WHERE id = ?').bind(id).first();
      if (!run) fail(401, 'session_required');
      response = json({ run: { id, mode, startedAt: now, expiresAt: now + RUN_MS } }, 201);
    } else if (/^\/v1\/runs\/[^/]+\/result$/.test(path) && request.method === 'POST') {
      const row = await session(request, env.DB, now); csrf(request, row);
      const runId = path.split('/')[3];
      const key = request.headers.get('Idempotency-Key');
      if (!UUID.test(runId) || !UUID.test(key || '')) fail(400, 'invalid_receipt');
      const data = await body(request); keys(data, ['score', 'elapsedMs', 'moves', 'won']);
      if (data.won !== true || !Number.isSafeInteger(data.elapsedMs) || data.elapsedMs < 1000 || data.elapsedMs > RUN_MS || data.elapsedMs % 1000 !== 0 ||
          !Number.isSafeInteger(data.moves) || data.moves < 1 || data.moves > 100000) fail(400, 'invalid_result');
      const run = await env.DB.prepare('SELECT * FROM runs WHERE id = ? AND user_id = ?').bind(runId, row.id).first();
      if (!run) fail(404, 'run_not_found');
      if (run.ruleset !== RULESET) fail(409, 'ruleset_expired');
      const award = calculateXp({ difficulty: run.difficulty, draw: run.draw, scoring: run.scoring }, data.score);
      // Current rules award at most 15 points per committed move (including a
      // newly revealed tableau card), plus this completion bonus. This only
      // rejects impossible claims; it does not establish that a game was won.
      const seconds = data.elapsedMs / 1000;
      const bonus = seconds > 30 ? Math.floor(700000 / seconds) : 0;
      if (run.scoring === 'standard' && data.score > 15 * data.moves + bonus) fail(400, 'invalid_score');
      const payloadHash = await hash(JSON.stringify([runId, data.score, data.elapsedMs, data.moves, true, RULESET]));
      let result = await env.DB.prepare('SELECT * FROM results WHERE user_id = ? AND (run_id = ? OR idempotency_key = ?)').bind(row.id, runId, key).first();
      let replayed = !!result;
      if (!result) {
        if (now >= run.expires_at) fail(410, 'run_expired');
        if (data.elapsedMs > now - run.started_at + 5000) fail(400, 'invalid_elapsed');
        await networkLimit(request, env, now, 'write', 120);
        await userLimit(env, row, now, 'result', 60);
        const resultId = crypto.randomUUID();
        await env.DB.prepare(`INSERT OR IGNORE INTO results
          (id, run_id, user_id, idempotency_key, payload_hash, score, elapsed_ms, moves, xp_awarded, verification, created_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'client-reported', ? FROM runs
          WHERE id = ? AND user_id = ? AND expires_at > ?`)
          .bind(resultId, runId, row.id, key, payloadHash, data.score, data.elapsedMs, data.moves, award, now, runId, row.id, now).run();
        result = await env.DB.prepare('SELECT * FROM results WHERE user_id = ? AND (run_id = ? OR idempotency_key = ?)').bind(row.id, runId, key).first();
        replayed = result?.id !== resultId;
      }
      if (!result) fail(409, 'result_conflict');
      if (result.run_id !== runId || result.idempotency_key !== key || result.payload_hash !== payloadHash) fail(409, 'result_conflict');
      const updated = await env.DB.prepare('SELECT id, nickname, xp FROM guests WHERE id = ?').bind(row.id).first();
      if (!updated) fail(401, 'session_required');
      response = json({ result: resultJson(result), user: user(updated), replayed }, replayed ? 200 : 201);
    } else if (path === '/v1/leaderboard' && request.method === 'GET') {
      if ([...url.searchParams.keys()].some(key => key !== 'limit')) fail(400, 'invalid_query');
      const rawLimit = url.searchParams.get('limit') || '25';
      if (!/^\d{1,2}$/.test(rawLimit) || +rawLimit < 1 || +rawLimit > 50) fail(400, 'invalid_limit');
      await networkLimit(request, env, now, 'read', 240, 60000);
      const me = await session(request, env.DB, now, false);
      const rows = await env.DB.prepare(`SELECT id, nickname, xp FROM guests WHERE xp > 0
        ORDER BY xp DESC, created_at ASC, id ASC LIMIT ?`).bind(+rawLimit).all();
      response = json({ metric: 'cumulative-xp', verification: 'client-reported', rankedAvailable: false,
        entries: rows.results.map((entry, i) => ({ rank: i + 1, nickname: entry.nickname, xp: entry.xp, isMe: entry.id === me?.id })) });
    } else fail(404, 'not_found');
    return decorate(response, allowed, cfg.origin);
  } catch (error) {
    // Never expose DB errors, tokens, request payloads, or infrastructure internals.
    const response = json({ error: error instanceof ApiError ? error.code : 'internal_error' }, error instanceof ApiError ? error.status : 500,
      error instanceof ApiError && error.status === 429 ? { 'Retry-After': '3600' } : {});
    return decorate(response, allowed, env.ALLOWED_ORIGIN);
  }
}
function decorate(response, allowed, origin) {
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Vary', 'Origin');
  if (allowed) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Access-Control-Allow-Credentials', 'true');
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token, Idempotency-Key');
  }
  return response;
}

/** Schedule only after setup approval; completed guest results remain until deletion. */
export async function cleanup(env, now = Date.now()) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM rate_limits WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM runs WHERE expires_at < ? AND NOT EXISTS (SELECT 1 FROM results WHERE results.run_id = runs.id)').bind(now),
    // Expired, unrecoverable guest identities are removed after one year of inactivity.
    env.DB.prepare('DELETE FROM guests WHERE updated_at < ? AND NOT EXISTS (SELECT 1 FROM sessions WHERE sessions.user_id = guests.id AND sessions.expires_at > ?)').bind(now - 365 * 86400000, now)
  ]);
}
export default { fetch: (request, env) => handle(request, env), scheduled: (_event, env, ctx) => ctx.waitUntil(cleanup(env)) };
