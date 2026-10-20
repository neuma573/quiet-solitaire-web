// Real Chromium tests of the exact allowlisted output, including the Pages subpath.
// All requests are intercepted locally. API results below are test fixtures only.
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, join, extname, sep } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const option = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
const temporary = option('--directory') ? null : await mkdtemp(join(tmpdir(), 'quiet-page-test-'));
const directory = resolve(option('--directory') || temporary);
if (temporary) {
  const copy = spawnSync('python3', ['-c', 'import sys; from pathlib import Path; sys.path.insert(0,"scripts"); from build import copy_public_web_assets; copy_public_web_assets(Path(sys.argv[1]))', directory], { encoding: 'utf8' });
  assert.equal(copy.status, 0, copy.stderr);
}
const screenshotDirectory = resolve(option('--screenshots') || join(tmpdir(), 'quiet-leaderboard-page-screenshots'));
await mkdir(screenshotDirectory, { recursive: true });
const configBefore = await readFile(join(directory, 'leaderboard-config.json'));
assert.deepEqual(configBefore, await readFile(new URL('../web/leaderboard-config.json', import.meta.url)),
  'The export must preserve the reviewed public API config; fixture routing below remains isolated');
const origin = 'https://quiet-leaderboard.test';
const prefix = '/quiet-solitaire-web/';
const address = origin + prefix + 'leaderboard/';
const apiPath = prefix + 'api/v1/leaderboard';
const mime = { '.html': 'text/html', '.mjs': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
const board = entries => ({ metric: 'cumulative-xp', verification: 'client-reported', rankedAvailable: false, entries });
const entries = [
  { rank: 1, nickname: '고요한 여우', xp: 24580 },
  { rank: 2, nickname: '느긋한 나무', xp: 18240, isMe: true },
  { rank: 3, nickname: '바람의 산책', xp: 18240 },
  { rank: 4, nickname: '작은 구름', xp: 9120 },
  { rank: 5, nickname: '초록빛 오후', xp: 7640 },
];
let mode = 'disabled'; let configValue = ''; let pendingResolve, pendingArrivalResolve;
let release = Promise.resolve(); let fixture = board(entries);
const requests = [], failures = [];
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN
  || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined) });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ko-KR' });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()); requests.push({ path: url.pathname, method: request.method() });
    const send = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    try {
      assert.equal(url.origin, origin, 'No external request allowed');
      assert.equal(request.method(), 'GET', 'The page must never create or change guests/results');
      if (url.pathname === prefix + 'leaderboard-config.json') {
        if (mode === 'config-error') return send({}, 404);
        if (mode === 'invalid-config') return send({ apiBase: 'http://insecure.example/api' });
        return send({ apiBase: configValue });
      }
      if (url.pathname === apiPath) {
        assert.equal(url.search, '?limit=25');
        if (mode === 'pending') { pendingArrivalResolve?.(); await release; }
        if (mode === 'error') return send({ private: 'secret backend stack' }, 503);
        if (mode === 'invalid-json') return route.fulfill({ contentType: 'application/json', body: 'null' });
        return send(fixture);
      }
      if (url.pathname === prefix) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="ko"><title>Game navigation fixture</title><body>게임 경로 확인</body></html>' });
      assert.ok(url.pathname.startsWith(prefix), 'Every asset must stay within the Pages subpath');
      let relative = decodeURIComponent(url.pathname.slice(prefix.length));
      if (relative.endsWith('/')) relative += 'index.html';
      const file = resolve(directory, relative);
      assert.ok(file.startsWith(directory + sep));
      return route.fulfill({ contentType: mime[extname(file)], body: await readFile(file) });
    } catch (error) { failures.push(error.message); return route.fulfill({ status: 500, body: 'fixture failure' }); }
  });
  const page = await context.newPage();
  page.on('pageerror', error => failures.push(error.message));
  const state = async value => page.waitForFunction(value => document.querySelector('#board-content')?.dataset.state === value, value);
  const requestCount = () => requests.filter(request => request.path === apiPath).length;
  async function noOverflow() {
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'No horizontal overflow');
    const button = await page.locator('#refresh').boundingBox(); assert.ok(button.height >= 44, 'Touch target must be at least 44px high');
  }
  await page.goto(address); await state('disabled');
  assert.equal(requestCount(), 0);
  assert.equal(await page.locator('#refresh').isDisabled(), true);
  assert.equal(await page.locator('tbody tr').count(), 0);
  await page.screenshot({ path: join(screenshotDirectory, 'unconfigured-desktop.png'), fullPage: true });
  assert.equal(await page.locator('.back-link').getAttribute('href'), '../');
  assert.equal(await page.locator('canvas,.ql-root').count(), 0, 'Importing API must not boot the game overlay');
  await page.keyboard.press('Tab'); assert.equal(await page.locator('.skip-link').evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Enter'); assert.ok(page.url().endsWith('#main'));

  // Relative apiBase must resolve from the game root, not /leaderboard/.
  configValue = 'api'; mode = 'pending'; release = new Promise(resolve => { pendingResolve = resolve; });
  await page.goto(address); await state('loading');
  await page.waitForFunction(() => document.querySelector('#board-content').getAttribute('aria-busy') === 'true');
  assert.equal(await page.locator('#refresh').isDisabled(), true);
  await page.locator('#refresh').evaluate(button => { button.click(); button.click(); });
  await page.waitForTimeout(100); assert.equal(requestCount(), 1, 'Repeated clicks cannot duplicate a load');
  mode = 'ready'; pendingResolve(); await state('ready');
  assert.equal(await page.locator('tbody tr').count(), 5);
  assert.equal(await page.locator('tbody tr').nth(1).locator('td').last().textContent(), '18,240');
  assert.equal(await page.getByRole('columnheader').count(), 3);
  assert.equal(await page.locator('.me-label').textContent(), '나');
  assert.equal(await page.locator('tbody tr').nth(2).locator('td').nth(1).textContent(), '바람의 산책', 'Server tie ordering is preserved');
  for (const [width, height] of [[1440, 1000], [768, 1024], [390, 844], [320, 740]]) {
    await page.setViewportSize({ width, height }); await noOverflow();
    await page.screenshot({ path: join(screenshotDirectory, `mock-rankings-${width}.png`), fullPage: true });
  }
  fixture = board([{ rank: 1, nickname: '<img src=x onerror=window.__nicknameXss=true>', xp: Number.MAX_SAFE_INTEGER }]);
  await page.locator('#refresh').click(); await state('ready'); await noOverflow();
  assert.equal(await page.locator('tbody img').count(), 0); assert.equal(await page.evaluate(() => window.__nicknameXss), undefined);
  assert.equal(await page.locator('tbody td').nth(1).textContent(), fixture.entries[0].nickname);
  fixture = board([]); await page.locator('#refresh').click(); await state('empty');
  assert.equal(await page.locator('tbody tr').count(), 0); assert.equal(await page.locator('#rankings').isVisible(), false);
  mode = 'error'; await page.locator('#refresh').click(); await state('error');
  assert.equal(await page.getByRole('alert').isVisible(), true);
  assert.ok(!(await page.locator('body').textContent()).includes('secret backend stack'));
  for (const next of ['config-error', 'invalid-config', 'invalid-json']) {
    mode = next; await page.locator('#refresh').click(); await state('error');
    assert.equal(await page.locator('tbody tr').count(), 0);
  }
  mode = 'ready'; fixture = board([{ ...entries[0], rank: 2 }]);
  await page.locator('#refresh').click(); await state('error');
  fixture = board(entries); await page.locator('#refresh').click(); await state('ready');
  assert.equal(await page.locator('#refresh').evaluate(button => button === document.activeElement), true, 'Retry preserves keyboard focus');
  // A stalled fetch must become a recoverable error rather than spin forever.
  mode = 'pending'; release = new Promise(resolve => { pendingResolve = resolve; });
  // Loading begins before config fetch completes. Wait for the initial API
  // request to reach the route before counting subsequent keyboard requests.
  const pendingArrival = new Promise(resolve => { pendingArrivalResolve = resolve; });
  await page.clock.install(); await page.locator('#refresh').focus();
  await page.keyboard.press('Enter'); await state('loading');
  assert.equal(await page.locator('#refresh').evaluate(button => button === document.activeElement), true, 'Loading preserves keyboard focus');
  await pendingArrival; pendingArrivalResolve = undefined;
  const beforeRepeatedKeys = requestCount();
  await page.keyboard.press('Enter'); await page.keyboard.press('Space');
  assert.equal(requestCount(), beforeRepeatedKeys, 'Repeated keys cannot duplicate a load');
  await page.locator('.back-link').focus();
  await page.clock.runFor(10_100); await state('error');
  assert.equal(await page.locator('.back-link').evaluate(link => link === document.activeElement), true, 'Completion does not steal focus after navigation');
  assert.ok((await page.getByRole('alert').textContent()).includes('늦어지고'));
  mode = 'ready'; pendingResolve(); await page.clock.resume();
  await page.locator('#refresh').click(); await state('ready');
  const beforeRestore = requestCount();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await state('ready'); assert.equal(requestCount(), beforeRestore + 1);
  await page.locator('.back-link').click(); assert.equal(page.url(), origin + prefix);
  await page.goBack(); await state('ready');
  await page.goto(address + 'index.html'); await state('ready');
  assert.ok(requests.some(request => request.path === prefix + 'leaderboard-api.mjs'));
  assert.ok(!requests.some(request => /\.(wasm|pck)$/.test(request.path)));
  assert.deepEqual(await readFile(join(directory, 'leaderboard-config.json')), configBefore);
  assert.deepEqual(failures, []);
  const noJs = await browser.newContext({ javaScriptEnabled: false });
  await noJs.route('**/*', async route => {
    const url = new URL(route.request().url());
    const relative = url.pathname.endsWith('/') ? 'leaderboard/index.html' : url.pathname.slice(prefix.length);
    await route.fulfill({ contentType: mime[extname(relative)], body: await readFile(join(directory, relative)) });
  });
  const plain = await noJs.newPage(); await plain.goto(address);
  assert.equal(await plain.locator('.no-script').isVisible(), true);
  assert.equal(await plain.locator('#board-status').isVisible(), false);
  console.log('Standalone leaderboard passed: nested exported route, relative API config, read-only contract, disabled/loading/empty/error/retry/timeout states, literal nicknames, ties, keyboard navigation, back/forward restore, no-JS, and 320/390/768/1440px layouts.');
  console.log('Screenshots (mock ranking data only): ' + screenshotDirectory);
} finally {
  await browser.close();
  if (temporary) await rm(temporary, { recursive: true, force: true });
}

