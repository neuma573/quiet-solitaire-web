// Optional compiled Godot Web / real guest API integration:
// node tests/leaderboard-export-browser.mjs --directory <export> [--screenshots <directory>]
// Every URL is intercepted in process. The export and its disabled config remain unchanged.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { handle } from '../leaderboard/index.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const argv = process.argv.slice(2);
const option = name => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
assert.ok(option('--directory'), '--directory must identify an existing Godot Web export');
const directory = resolve(option('--directory'));
const screenshotDirectory = resolve(option('--screenshots') || join(tmpdir(), `quiet-leaderboard-export-${Date.now()}`));
await mkdir(screenshotDirectory, { recursive: true });
assert.ok((await stat(join(directory, 'index.html'))).isFile(), 'Actual exported index.html is required');
const configBefore = await readFile(join(directory, 'leaderboard-config.json'));
assert.equal(JSON.parse(configBefore).apiBase, '', 'Export must keep its public API config disabled on disk');

const origin = 'https://quiet-leaderboard.test';
const apiOrigin = 'https://api.quiet-leaderboard.test';
const prefix = '/quiet-solitaire-web/';
const mime = { '.wasm': 'application/wasm', '.pck': 'application/octet-stream', '.html': 'text/html',
  '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css',
  '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(readFileSync(new URL('../leaderboard/migrations/0001_guest_xp.sql', import.meta.url), 'utf8'));
const statement = (sql, args = []) => ({
  sql, args,
  bind(...values) { return statement(sql, values); },
  async first() { return sqlite.prepare(sql).get(...args) || null; },
  async all() { return { results: sqlite.prepare(sql).all(...args) }; },
  async run() { const result = sqlite.prepare(sql).run(...args); return { meta: { changes: result.changes } }; },
});
const DB = { prepare: statement, async batch(statements) {
  sqlite.exec('BEGIN');
  try {
    const results = statements.map(s => ({ results: sqlite.prepare(s.sql).all(...s.args) }));
    sqlite.exec('COMMIT'); return results;
  } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
} };
const env = { DB, ALLOWED_ORIGIN: origin, API_PREFIX: '/api', RATE_LIMIT_SALT: 'export-test-only-never-a-production-secret' };
const failures = [];
const diagnostics = [];
// Chromium's AudioWorklet module fetch bypasses Playwright's .test routing.
// Exclude only these exact fixture transport failures, never other script errors.
// Audio loading must be checked separately by the ordinary real-server game smoke.
const workletTransportErrors = new Set(['index.audio.worklet.js', 'index.audio.position.worklet.js'].map(name =>
  `Failed to load worklet module script: ${origin}${prefix}${name} (Network error)`));
const ignoredWorkletErrors = [];
const apiRequests = [];
const files = new Map();
async function routeAll(route) {
  const request = route.request();
  try {
    const url = new URL(request.url());
    assert.ok([origin, apiOrigin].includes(url.origin), 'All requests must stay on intercepted test origins');
    if (url.origin === apiOrigin) {
      const headers = await request.allHeaders();
      apiRequests.push({ method: request.method(), path: url.pathname, hasCookie: !!headers.cookie });
      headers['cf-connecting-ip'] = '192.0.2.20';
      const init = { method: request.method(), headers };
      if (!['GET', 'HEAD'].includes(init.method) && request.postData() !== null) init.body = request.postData();
      const response = await handle(new Request(request.url(), init), env);
      return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    }
    if (!url.pathname.startsWith(prefix)) return route.fulfill({ status: 404, body: '' });
    if (url.pathname === prefix + 'leaderboard-config.json') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ apiBase: apiOrigin + '/api' }) });
    }
    const file = resolve(directory, decodeURIComponent(url.pathname.slice(prefix.length)) || 'index.html');
    assert.ok(file.startsWith(directory + sep), 'Asset path must stay inside the export');
    if (!files.has(file)) files.set(file, await readFile(file));
    return route.fulfill({ contentType: mime[extname(file)] || 'application/octet-stream', body: files.get(file) });
  } catch (error) {
    failures.push(error.code === 'ENOENT' ? 'Missing exported asset' : error.message);
    return route.fulfill({ status: 500, body: 'Test fixture failed' });
  }
}
const installed = process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_BIN || (existsSync(installed) ? installed : undefined),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let page;
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 760 }, deviceScaleFactor: 1, locale: 'ko-KR' });
  await context.route('**/*', routeAll);
  page = await context.newPage();
  page.on('pageerror', error => {
    const knownWorkletTransport = workletTransportErrors.has(error.message);
    if (knownWorkletTransport) ignoredWorkletErrors.push(error.message); else failures.push('JavaScript exception');
    diagnostics.push({ type: 'pageerror', fixtureTransportExclusion: knownWorkletTransport, message: error.message, stack: error.stack });
  });
  page.on('console', message => { if (/SCRIPT ERROR:|\bERROR:/.test(message.text())) failures.push('Godot runtime error'); });
  page.on('response', response => {
    if (response.status() >= 400 && /\.(wasm|pck|m?js|css|png)(\?|$)/.test(response.url())) failures.push('Exported asset error');
  });
  await page.goto(origin + prefix, { waitUntil: 'load', timeout: 120_000 });
  await page.waitForFunction(() => !document.getElementById('status') && !!window.QuietLeaderboardBridge, null, { timeout: 120_000 });
  // Match the game's existing browser smoke: engine readiness precedes native menu input readiness.
  await page.waitForTimeout(2500);
  const canvas = page.locator('#canvas');
  assert.ok(await canvas.isVisible(), 'Compiled game canvas must be visible');
  assert.equal(await page.locator('.ql-launcher').isVisible(), false, 'Actual game must not have a floating launcher covering native counters');
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  async function click(x, y) {
    const box = await canvas.boundingBox();
    await page.mouse.click(box.x + x * box.width / 390, box.y + y * box.height / 760);
    await frames();
  }
  async function nameCrop(label) {
    await frames();
    const box = await canvas.boundingBox();
    return page.screenshot({ path: join(screenshotDirectory, label + '.png'), clip: {
      x: box.x + 88 * box.width / 390, y: box.y + 65 * box.height / 760,
      width: 286 * box.width / 390, height: 30 * box.height / 760,
    } });
  }
  async function nativeCrop(label, x, y, width, height) {
    await frames();
    const box = await canvas.boundingBox();
    return page.screenshot({ path: join(screenshotDirectory, label + '.png'), clip: {
      x: box.x + x * box.width / 390, y: box.y + y * box.height / 760,
      width: width * box.width / 390, height: height * box.height / 760,
    } });
  }
  async function settleControls() {
    await page.mouse.move(385, 745);
    await page.waitForTimeout(300); // Source selection tween is 0.18 seconds.
    await frames();
  }
  // Use actual canvas pointer input and the compiled web-owned autoload, not a JS-generated My Page event.
  await click(102, 704);
  await page.waitForTimeout(350); await frames();
  const fallback = await nameCrop('01-native-fallback');
  await click(195, 238);
  await page.locator('.ql-dialog').waitFor({ state: 'visible', timeout: 10_000 });
  await page.getByRole('button', { name: '동의하고 참여', exact: true }).click();
  await page.waitForFunction(() => !!window.QuietLeaderboardBridge.profile()?.id);
  const initial = await page.evaluate(() => window.QuietLeaderboardBridge.profile());
  const nickname = '웹검증 여우';
  await page.getByRole('textbox', { name: '닉네임', exact: true }).fill(nickname);
  await page.getByRole('button', { name: '닉네임 저장', exact: true }).click();
  await page.waitForFunction(nickname => window.QuietLeaderboardBridge.profile()?.nickname === nickname, nickname);
  const renamed = await page.evaluate(() => window.QuietLeaderboardBridge.profile());
  assert.deepEqual(renamed, { id: initial.id, nickname, xp: initial.xp }, 'Rename must preserve server guest ID and XP');
  assert.equal(sqlite.prepare('SELECT nickname FROM guests').get().nickname, nickname);
  await page.screenshot({ path: join(screenshotDirectory, '02-native-opened-html-profile.png') });
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await page.locator('.ql-dialog').waitFor({ state: 'hidden' });
  const renamedCrop = await nameCrop('03-native-renamed');
  await page.screenshot({ path: join(screenshotDirectory, '03-native-renamed-full.png') });
  assert.ok(!fallback.equals(renamedCrop), 'Native profile pixels must change after browser nickname update');
  // Coordinates verified against this reviewed 390x760 source export. Assert
  // the controls really change, so stale coordinates cannot silently pass a
  // nickname-only test. Crop inside the selected pill to exclude hover/focus borders.
  for (const [field, y] of [['draw', 489], ['scoring', 561]]) {
    await settleControls();
    const selected = await nativeCrop(`${field}-initial`, 36, y - 14, 12, 12);
    await click(282, y); await settleControls();
    const deselected = await nativeCrop(`${field}-second`, 36, y - 14, 12, 12);
    assert.ok(!selected.equals(deselected), `${field} must switch to its second option`);
    assert.ok(renamedCrop.equals(await nameCrop(`${field}-second-name`)), `Native nickname must survive ${field} refresh`);
    await click(108, y); await settleControls();
    assert.ok(selected.equals(await nativeCrop(`${field}-restored`, 36, y - 14, 12, 12)), `${field} must return to its first option`);
    assert.ok(renamedCrop.equals(await nameCrop(`${field}-first-name`)), `Native nickname must survive ${field} reset`);
  }
  const allDifficulties = await nativeCrop('difficulty-initial', 28, 405, 260, 32);
  let previousDifficulty = allDifficulties;
  for (const index of [1, 2, 3, 4, 0]) {
    await click(195, 421);
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(screenshotDirectory, `difficulty-${index}-popup.png`) });
    // Select the real popup row with pointer input. Its reviewed export has
    // five 24-pixel rows centered at y=460..556. Browser keyboard events do
    // not select this embedded popup reliably; selection pixels below must
    // still change and all five options must return to the original state.
    await click(100, 460 + index * 24);
    await settleControls();
    const current = await nativeCrop(`difficulty-${index}`, 28, 405, 260, 32);
    assert.ok(!previousDifficulty.equals(current), `Difficulty option ${index} must change the displayed selection`);
    if (index === 0) assert.ok(allDifficulties.equals(current), 'Difficulty selection must return to All');
    previousDifficulty = current;
    assert.ok(renamedCrop.equals(await nameCrop(`difficulty-${index}-name`)), `Native nickname must survive difficulty option ${index}`);
  }
  // Navigate away and back using actual native controls to exercise a fresh My Page instance.
  await click(47, 24); await page.waitForTimeout(350);
  await click(102, 704); await page.waitForTimeout(350);
  assert.ok(renamedCrop.equals(await nameCrop('08-native-reopened')), 'Native nickname must survive returning to My Page');
  await click(195, 238);
  await page.locator('.ql-dialog').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '게스트와 순위 기록 삭제', exact: true }).click();
  await page.getByRole('button', { name: '삭제하기', exact: true }).click();
  await page.waitForFunction(() => window.QuietLeaderboardBridge.profile() === null);
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await page.locator('.ql-dialog').waitFor({ state: 'hidden' });
  assert.ok(fallback.equals(await nameCrop('09-native-deleted-fallback')), 'Deleting the guest must restore the original native fallback');
  await page.screenshot({ path: join(screenshotDirectory, '10-native-page-after-delete.png') });
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM guests').get().n, 0);
  assert.ok(apiRequests.some(request => request.method === 'PATCH' && request.path === '/api/v1/me' && request.hasCookie));
  assert.equal(apiRequests.some(request => request.path.includes('/runs')), false, 'Profile test must not invent or submit game runs/results');
  assert.deepEqual(await readFile(join(directory, 'leaderboard-config.json')), configBefore, 'Exported disabled config must remain unchanged');
  assert.deepEqual(failures, []);
  await writeFile(join(screenshotDirectory, 'diagnostics.json'), JSON.stringify(diagnostics, null, 2));
  console.log('Compiled Godot Web profile passed: native My Page button opens HTML dialog; real guest API rename preserves ID/XP; verified draw/scoring selection and all five difficulty filters preserve native nickname; page recreation and guest deletion preserve/restore identity. No synthetic game result or gameplay proof.');
  console.log(`Fixture exclusions: ${ignoredWorkletErrors.length} exact AudioWorklet Network errors. Audio transport is not covered by this intercepted test; every other runtime error fails.`);
  console.log('Screenshots: ' + screenshotDirectory);
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: join(screenshotDirectory, 'failure.png') }).catch(() => {});
  await writeFile(join(screenshotDirectory, 'diagnostics.json'), JSON.stringify(diagnostics, null, 2));
  console.error('Failure screenshots: ' + screenshotDirectory);
  throw error;
} finally { await browser.close(); sqlite.close(); }
