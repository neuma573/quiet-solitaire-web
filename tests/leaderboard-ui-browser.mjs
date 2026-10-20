// Optional real-browser overlay check: node tests/leaderboard-ui-browser.mjs
// Uses the project's Playwright dependency and installed browser (CHROME_BIN may override).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
let profile = { id: 'server-stable-id', nickname: '고요한여우123', xp: 50 };
const requests = [];
const hostile = '<img src=x onerror=window.__nicknameXss=true>';
const address = 'https://quiet-leaderboard.test/';
let sessionStatus = 200;
let denyCookie = false;
async function fixtureRoute(route) {
  const req = route.request();
  const url = new URL(req.url());
  const send = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  try {
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="leaderboard.css"><title>Overlay test</title><body style="margin:0"><div id="phone" style="position:relative;width:min(100vw,390px);height:100vh;background:#f5f5f5"><canvas aria-label="game" width="390" height="760"></canvas></div><script type="module" src="leaderboard.mjs"></script></body></html>' });
    }
    if (url.pathname === '/leaderboard-config.json') return send({ apiBase: address + 'api' });
    if (['/leaderboard.mjs', '/leaderboard-api.mjs', '/leaderboard.css'].includes(url.pathname)) {
      return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript',
        body: await readFile(new URL('../web' + url.pathname, import.meta.url), 'utf8') });
    }
    if (!url.pathname.startsWith('/api/')) return route.fulfill({ status: 404, body: '' });
    const body = req.postData() ? req.postDataJSON() : null;
    const headers = await req.allHeaders();
    requests.push({ path: url.pathname, method: req.method(), headers, body });
    if (req.method() !== 'GET') {
      assert.equal(headers.origin, address.replace(/\/$/, ''));
      if (url.pathname !== '/api/v1/session') assert.equal(headers['x-csrf-token'], 'csrf-test');
    }
    if (url.pathname === '/api/v1/session') return sessionStatus === 200
      ? send({ user: profile, csrfToken: 'csrf-test' }) : send({ private: 'must not render server details' }, sessionStatus);
    if (url.pathname === '/api/v1/me' && req.method() === 'GET') return denyCookie
      ? send({ error: 'session_required' }, 401) : send({ user: profile, csrfToken: 'csrf-test' });
    if (url.pathname === '/api/v1/me' && req.method() === 'PATCH') { profile = { ...profile, nickname: body.nickname }; return send({ user: profile }); }
    if (url.pathname === '/api/v1/me' && req.method() === 'DELETE') { profile = null; return route.fulfill({ status: 204, body: '' }); }
    if (url.pathname === '/api/v1/runs') return send({ run: { id: 'server-run', mode: body.mode } });
    if (url.pathname === '/api/v1/runs/server-run/result') {
      assert.equal(body.xp, undefined); assert.equal(body.userId, undefined);
      profile = { ...profile, xp: 100 }; return send({ user: profile, result: { xpAwarded: 50, verification: 'client-reported' } });
    }
    if (url.pathname === '/api/v1/leaderboard') {
      return send({ metric: 'cumulative-xp', verification: 'client-reported', rankedAvailable: false, entries: [
        { rank: 1, nickname: hostile, xp: 1000 }, ...(profile ? [{ rank: 2, nickname: profile.nickname, xp: profile.xp, isMe: true }] : []) ] });
    }
    return route.fulfill({ status: 404, body: '' });
  } catch { return route.fulfill({ status: 500, body: '' }); }
}
const installed = process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_BIN || (existsSync(installed) ? installed : undefined) });
try {
  const context = await browser.newContext({ viewport: { width: 320, height: 568 }, locale: 'ko-KR' });
  const page = await context.newPage();
  // Every browser request is fulfilled in process: no external or local-network access is needed.
  await page.route('**/*', fixtureRoute);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(address);
  await page.waitForFunction(() => window.QuietLeaderboardBridge.profile()?.id === 'server-stable-id');
  assert.equal(requests.filter(req => req.path === '/api/v1/session').length, 1, 'Initial page load automatically connects once');
  await page.evaluate(async () => {
    const { bootLeaderboard } = await import('/leaderboard.mjs');
    await Promise.all([bootLeaderboard(), bootLeaderboard()]);
  });
  assert.equal(await page.locator('.ql-root').count(), 1, 'Repeated boot calls cannot mount duplicate UIs');
  assert.equal(requests.filter(req => req.path === '/api/v1/session').length, 1);
  await page.getByRole('button', { name: '순위 · 마이페이지' }).click();
  assert.equal(await page.getByRole('button', { name: '동의하고 참여', exact: true }).count(), 0);
  assert.equal(await page.getByText('누적 XP 순위 · 클라이언트 신고 기록으로, 검증된 경쟁 순위는 아닙니다.', { exact: true }).count(), 0);
  await page.getByRole('cell', { name: hostile, exact: true }).waitFor();
  assert.equal(await page.locator('.ql-dialog').evaluate(el => el.scrollTop), 0, 'Launcher must open at the ranking table');
  assert.equal(await page.locator('.ql-board').evaluate(el => el.offsetTop < document.querySelector('.ql-profile').offsetTop), true);
  assert.equal(await page.locator('.ql-dialog img').count(), 0);
  assert.equal(await page.evaluate(() => window.__nicknameXss), undefined);
  assert.equal(await page.locator('.ql-dialog').evaluate(el => el.scrollWidth <= el.clientWidth), true, 'Dialog must not overflow horizontally on a 320px viewport');
  const invalidCompletion = { type: 'completed', attemptId: 'a'.repeat(32), mode: { difficulty: 'normal', draw: 3, scoring: 'standard' }, score: 1000, elapsedMs: 120000, moves: 120, won: true };
  await page.evaluate(event => window.QuietLeaderboardBridge.emit(JSON.stringify(event)), invalidCompletion);
  assert.equal(requests.some(req => req.path.endsWith('/result')), false);
  const name = page.getByRole('textbox', { name: '닉네임', exact: true });
  await name.fill('새로운 닉네임'); await page.getByRole('button', { name: '닉네임 저장' }).click();
  await page.waitForFunction(() => window.QuietLeaderboardBridge.profile()?.nickname === '새로운 닉네임');
  assert.equal(await page.evaluate(() => window.QuietLeaderboardBridge.profile().id), 'server-stable-id');
  assert.equal(await page.evaluate(() => window.QuietLeaderboardBridge.profile().xp), 50);
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/v1/runs')),
    page.evaluate(event => window.QuietLeaderboardBridge.emit(JSON.stringify({ ...event, type: 'started' })), invalidCompletion),
  ]);
  await page.evaluate(event => window.QuietLeaderboardBridge.emit(JSON.stringify(event)), invalidCompletion);
  await page.waitForFunction(() => window.QuietLeaderboardBridge.profile()?.xp === 100);
  await page.evaluate(event => window.QuietLeaderboardBridge.emit(JSON.stringify(event)), invalidCompletion);
  assert.equal(requests.filter(req => req.path.endsWith('/result')).length, 1);
  if (process.env.LEADERBOARD_SCREENSHOT) {
    await page.locator('.ql-dialog').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: process.env.LEADERBOARD_SCREENSHOT });
  }
  await page.keyboard.press('Escape'); await page.locator('.ql-dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('button', { name: '순위 · 마이페이지' }).evaluate(el => el === document.activeElement), true);
  await page.evaluate(() => window.QuietLeaderboardBridge.emit('{"type":"my-page"}'));
  await page.locator('.ql-dialog').waitFor({ state: 'visible' });
  assert.equal(await name.evaluate(element => element === document.activeElement), true, 'Native My Page event must focus nickname');
  if (process.env.LEADERBOARD_SCREENSHOT) await page.screenshot({ path: process.env.LEADERBOARD_SCREENSHOT.replace(/\.png$/, '-my-page.png') });
  const cachedPeer = await page.context().newPage();
  await cachedPeer.addInitScript(() => {
    // A frozen bfcache page need not receive another tab's storage event.
    const add = window.addEventListener.bind(window);
    window.addEventListener = (type, listener, options) => { if (type !== 'storage') add(type, listener, options); };
  });
  await cachedPeer.route('**/*', fixtureRoute);
  await cachedPeer.goto(address);
  await cachedPeer.waitForFunction(() => !!window.QuietLeaderboardBridge.profile());
  await cachedPeer.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  const connectionsBeforeDelete = requests.filter(req => req.path === '/api/v1/session').length;
  await page.getByRole('button', { name: '나의 모든 기록 삭제', exact: true }).click();
  assert.equal(requests.some(req => req.method === 'DELETE'), false, 'Opening the confirmation does not delete');
  await page.getByRole('button', { name: '취소', exact: true }).click();
  await page.getByRole('button', { name: '나의 모든 기록 삭제', exact: true }).click();
  await page.getByRole('button', { name: '삭제하기', exact: true }).click();
  await page.waitForFunction(() => window.QuietLeaderboardBridge.profile() === null);
  await page.getByRole('button', { name: '새로고침', exact: true }).click();
  assert.equal(requests.filter(req => req.path === '/api/v1/session').length, connectionsBeforeDelete, 'Deletion must not immediately recreate a guest');
  await cachedPeer.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await cachedPeer.waitForFunction(() => window.QuietLeaderboardBridge.profile() === null);
  assert.equal(requests.filter(req => req.path === '/api/v1/session').length, connectionsBeforeDelete,
    'A bfcache restore must read the cross-tab deletion marker before any session POST');
  assert.deepEqual(errors, []);
  sessionStatus = 503;
  const failedPage = await browser.newPage({ viewport: { width: 320, height: 568 } });
  await failedPage.route('**/*', fixtureRoute);
  await failedPage.goto(address);
  await failedPage.getByRole('button', { name: '순위 · 마이페이지' }).click();
  await failedPage.locator('.ql-error').waitFor({ state: 'visible' });
  assert.ok(!(await failedPage.locator('.ql-error').textContent()).includes('private'));
  const failedCreates = requests.filter(req => req.path === '/api/v1/session').length;
  for (let i = 0; i < 3; i++) await failedPage.getByRole('button', { name: '새로고침', exact: true }).click();
  assert.equal(requests.filter(req => req.path === '/api/v1/session').length, failedCreates,
    'A potentially committed 503 cannot create another guest on board refresh');
  assert.equal(await failedPage.locator('canvas').count(), 1, 'Connection failure never replaces the game canvas');
  await failedPage.getByRole('button', { name: '닫기', exact: true }).click();
  await failedPage.locator('canvas').click({ position: { x: 10, y: 10 } });
  assert.equal(await failedPage.evaluate(() => window.QuietLeaderboardBridge.profile()), null);
  const departing = await browser.newPage();
  await departing.addInitScript(({ apiBase }) => {
    const original = window.fetch.bind(window);
    window.fetch = (url, options) => {
      if (String(url).endsWith('/leaderboard-config.json') && !window.fixtureConfigResolved) {
        return new Promise(resolve => {
          window.fixtureResolveConfig = () => {
            window.fixtureConfigResolved = true;
            resolve(new Response(JSON.stringify({ apiBase }), { headers: { 'Content-Type': 'application/json' } }));
          };
        });
      }
      return original(url, options);
    };
  }, { apiBase: address + 'api' });
  await departing.route('**/*', fixtureRoute);
  await departing.goto(address);
  await departing.waitForFunction(() => !!window.fixtureResolveConfig);
  const beforeDeparture = requests.filter(req => req.path === '/api/v1/session').length;
  await departing.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.fixtureResolveConfig(); // Deliberately ignores AbortSignal to test the late-result guard.
  });
  await departing.waitForTimeout(50);
  assert.equal(await departing.locator('.ql-root').count(), 0, 'A late config cannot mount after pagehide');
  assert.equal(requests.filter(req => req.path === '/api/v1/session').length, beforeDeparture);
  await departing.evaluate(() => {
    localStorage.setItem('quiet-leaderboard:deletion-generation', 'fixture-deleted-while-suspended');
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await departing.locator('.ql-root').waitFor();
  assert.equal(await departing.evaluate(() => window.QuietLeaderboardBridge.profile()), null);
  assert.equal(requests.filter(req => req.path === '/api/v1/session').length, beforeDeparture,
    'Restarted boot retains its original deletion generation instead of treating bfcache as a fresh visit');
  sessionStatus = 200; denyCookie = true;
  profile = { id: 'cookie-blocked-id', nickname: '포근한 고양이042', xp: 0 };
  const cookieBlocked = await browser.newPage();
  await cookieBlocked.route('**/*', fixtureRoute);
  await cookieBlocked.goto(address);
  await cookieBlocked.getByRole('button', { name: '순위 · 마이페이지' }).click();
  await cookieBlocked.getByText('게스트 쿠키를 확인할 수 없습니다. 쿠키 설정을 확인한 뒤 페이지를 새로고침해 주세요.', { exact: true }).waitFor();
  const beforeRefresh = requests.filter(req => req.path === '/api/v1/session').length;
  for (let i = 0; i < 3; i++) await cookieBlocked.getByRole('button', { name: '새로고침', exact: true }).click();
  assert.equal(requests.filter(req => req.path === '/api/v1/session').length, beforeRefresh,
    'Board refresh cannot create more unreachable guests when the cookie was rejected');
  console.log('Browser overlay passed: automatic connection, single boot, 320px layout, keyboard focus, nickname XSS text, stable identity, single result and confirmed deletion without immediate recreation.');
} finally { await browser.close(); }
