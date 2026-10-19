// Optional HTTPS browser/API integration: node tests/leaderboard-api-browser.mjs
// All browser URLs are fulfilled in process; no server or network request is used.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handle } from '../leaderboard/index.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = 'https://quiet-leaderboard.test';
const apiOrigin = 'https://api.quiet-leaderboard.test';
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(readFileSync(new URL('../leaderboard/migrations/0001_guest_xp.sql', import.meta.url), 'utf8'));
const statement = (sql, args = []) => ({
  sql, args,
  bind(...values) { return statement(sql, values); },
  async first() { return sqlite.prepare(sql).get(...args) || null; },
  async all() { return { results: sqlite.prepare(sql).all(...args) }; },
  async run() { const result = sqlite.prepare(sql).run(...args); return { meta: { changes: result.changes } }; }
});
const DB = {
  prepare: statement,
  async batch(statements) {
    sqlite.exec('BEGIN');
    try {
      const results = statements.map(s => ({ results: sqlite.prepare(s.sql).all(...s.args) }));
      sqlite.exec('COMMIT'); return results;
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  }
};
const env = { DB, ALLOWED_ORIGIN: origin, API_PREFIX: '/api', RATE_LIMIT_SALT: 'browser-test-only-never-a-production-secret' };
let time = Date.now();
const failures = [];
const apiRequests = [];
async function routeAll(route) {
  const request = route.request();
  try {
    const url = new URL(request.url());
    assert.ok([origin, apiOrigin].includes(url.origin), 'Every test request must stay on intercepted test origins');
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body:
      `<!doctype html><meta charset="utf-8"><title>Real guest API test</title><body><script type="module">import {createLeaderboardClient} from "/leaderboard.mjs";window.client=createLeaderboardClient({apiBase:"${apiOrigin}/api"});window.ready=true;</script>` });
    if (url.pathname === '/leaderboard.mjs') return route.fulfill({ contentType: 'application/javascript',
      body: readFileSync(new URL('../web/leaderboard.mjs', import.meta.url), 'utf8') });
    if (url.pathname === '/leaderboard-config.json') return route.fulfill({ contentType: 'application/json', body: '{"apiBase":""}' });
    if (!url.pathname.startsWith('/api/')) return route.fulfill({ status: 404, body: '' });
    const headers = await request.allHeaders();
    apiRequests.push({ path: url.pathname, method: request.method(), hasCookie: !!headers.cookie });
    // Cloudflare supplies this ingress header in production; here it is a
    // fixed test value. Browser cookie/origin/fetch-metadata headers are real.
    headers['cf-connecting-ip'] = '192.0.2.10';
    const init = { method: request.method(), headers };
    if (!['GET', 'HEAD'].includes(init.method) && request.postData() !== null) init.body = request.postData();
    const response = await handle(new Request(request.url(), init), env, () => time);
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
  } catch (error) {
    failures.push(error.message);
    await route.fulfill({ status: 500, body: '{"error":"fixture_failure"}' });
  }
}
const installed = process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_BIN || (existsSync(installed) ? installed : undefined) });
try {
  const contextA = await browser.newContext(), contextB = await browser.newContext();
  for (const context of [contextA, contextB]) await context.route('**/*', routeAll);
  const pageA = await contextA.newPage(), pageB = await contextB.newPage();
  for (const page of [pageA, pageB]) {
    page.on('pageerror', error => failures.push(error.message));
    await page.goto(origin + '/'); await page.waitForFunction(() => window.ready);
  }
  const guestA = await pageA.evaluate(() => window.client.session());
  const cookies = await contextA.cookies(apiOrigin);
  const bearer = cookies.find(cookie => cookie.name === '__Host-quiet_guest');
  assert.ok(bearer, 'Browser must accept actual secure Set-Cookie from handler');
  assert.equal(bearer.secure, true); assert.equal(bearer.httpOnly, true); assert.equal(bearer.sameSite, 'Strict');
  assert.equal(await pageA.evaluate(() => document.cookie.includes('quiet_guest')), false, 'HttpOnly token must be invisible to UI JavaScript');
  assert.notEqual(sqlite.prepare('SELECT token_hash FROM sessions').get().token_hash, bearer.value);
  assert.equal((await pageA.evaluate(() => window.client.me())).user.id, guestA.user.id);
  const mode = { difficulty: 'normal', draw: 1, scoring: 'standard' };
  const startedA = await pageA.evaluate(mode => window.client.startRun(mode), mode);
  time += 65000;
  const completedA = await pageA.evaluate(({ id, key }) => window.client.finishRun(id,
    { score: 450, elapsedMs: 60000, moves: 90, won: true }, key), { id: startedA.run.id, key: crypto.randomUUID() });
  assert.equal(completedA.user.xp, 208);
  const renamedA = await pageA.evaluate(() => window.client.rename('고요한 수달'));
  assert.deepEqual(renamedA.user, { id: guestA.user.id, nickname: '고요한 수달', xp: 208 });
  await pageA.reload(); await pageA.waitForFunction(() => window.ready);
  const restoredA = await pageA.evaluate(() => window.client.session());
  assert.deepEqual(restoredA.user, renamedA.user, 'New client instance restores cookie-owned identity and XP');
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM guests').get().n, 1);

  const guestB = await pageB.evaluate(() => window.client.session());
  assert.notEqual(guestB.user.id, guestA.user.id, 'Isolated browser contexts have distinct guests');
  assert.notEqual((await contextB.cookies(apiOrigin)).find(cookie => cookie.name === '__Host-quiet_guest').value, bearer.value);
  const initialBoardB = await pageB.evaluate(() => window.client.board());
  assert.deepEqual(initialBoardB.entries, [{ rank: 1, nickname: '고요한 수달', xp: 208, isMe: false }]);
  const startedB = await pageB.evaluate(() => window.client.startRun({ difficulty: 'casual', draw: 1, scoring: 'vegas' }));
  time += 65000;
  const completedB = await pageB.evaluate(({ id, key }) => window.client.finishRun(id,
    { score: 208, elapsedMs: 60000, moves: 90, won: true }, key), { id: startedB.run.id, key: crypto.randomUUID() });
  assert.equal(completedB.user.xp, 300);
  const boardA = await pageA.evaluate(() => window.client.board());
  assert.deepEqual(boardA.entries.map(row => [row.rank, row.xp, row.isMe]), [[1, 300, false], [2, 208, true]]);
  await pageA.evaluate(() => window.client.remove());
  assert.equal((await contextA.cookies(apiOrigin)).some(cookie => cookie.name === '__Host-quiet_guest'), false);
  const deletedStatus = await pageA.evaluate(async () => { try { await window.client.me(); return 200; } catch (error) { return error.status; } });
  assert.equal(deletedStatus, 401);
  const afterDeleteB = await pageB.evaluate(() => window.client.board());
  assert.deepEqual(afterDeleteB.entries.map(row => [row.rank, row.xp, row.isMe]), [[1, 300, true]]);
  for (const table of ['guests', 'sessions', 'runs', 'results'])
    assert.equal(sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 1, `Delete must preserve only other guest's ${table}`);
  assert.ok(apiRequests.some(request => request.hasCookie && request.method === 'POST' && request.path === '/api/v1/runs'));
  assert.deepEqual(failures, []);
  console.log('Real API browser passed: HTTPS HttpOnly/Secure/Strict cookie accepted and sent; reload identity; server XP; two isolated guests share ordered board; nickname preserves ID/XP; deletion cascades and clears cookie. All requests intercepted; Cloudflare runtime not exercised.');
} finally { await browser.close(); sqlite.close(); }
