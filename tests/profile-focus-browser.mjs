// Focus + keyboard geometry regression against the real HTML shell and overlay.
// Godot is stubbed here; every request is fulfilled in memory, including a fixed
// guest fixture. This never contacts or modifies a production guest/API.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
const engine = process.argv.includes('--webkit') ? 'webkit' : 'chromium';
const { [engine]: browserType } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const screenshots = process.env.PROFILE_FOCUS_SCREENSHOTS && resolve(process.env.PROFILE_FOCUS_SCREENSHOTS);
const origin = 'https://quiet-profile-focus.test';
const profile = { id: 'focus-fixture-only', nickname: '고요한 여우042', xp: 50 };
const html = (await readFile(new URL('../web/shell.html', import.meta.url), 'utf8'))
  .replaceAll('$GODOT_PROJECT_NAME', 'Profile focus fixture').replaceAll('$GODOT_HEAD_INCLUDE', '')
  .replaceAll('$GODOT_URL', 'engine-fixture.js').replaceAll('$GODOT_CONFIG', '{}').replaceAll('$GODOT_THREADS_ENABLED', 'false');
const errors = [], requests = [];
const installed = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await browserType.launch({ headless: true, ...(engine === 'chromium'
  && existsSync(process.env.CHROME_BIN || installed) ? { executablePath: process.env.CHROME_BIN || installed } : {}) });
let page;
const geometry = () => page.evaluate(() => {
  const phone = document.querySelector('#phone'), canvas = document.querySelector('#canvas');
  return { width: canvas.width, height: canvas.height, css: phone.getAttribute('style') };
});
try {
  page = await browser.newPage({ viewport: { width: 390, height: 664 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true, locale: 'ko-KR' });
  await page.addInitScript(() => {
    window.nativeViewport = window.visualViewport;
    window.fixtureViewport = Object.assign(new EventTarget(), { width: 390, height: 664,
      scale: 1, offsetLeft: 0, offsetTop: 0 });
    Object.defineProperty(window, 'visualViewport', { get: () => window.fixtureViewport });
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    requests.push({ origin: url.origin, method: request.method(), path: url.pathname });
    assert.equal(url.origin, origin, 'All traffic stays inside the fixture');
    const json = value => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    if (url.pathname === '/engine-fixture.js') return route.fulfill({ contentType: 'application/javascript',
      body: 'window.Engine=class { static getMissingFeatures(){return []} startGame(){return Promise.resolve()} };' });
    if (url.pathname === '/leaderboard-config.json') return json({ apiBase: origin + '/api' });
    if (url.pathname === '/api/v1/session' || url.pathname === '/api/v1/me') {
      assert.ok(request.method() === 'GET' || (url.pathname.endsWith('/session') && request.method() === 'POST'));
      return json({ user: profile, csrfToken: 'fixture-only' });
    }
    if (url.pathname === '/api/v1/leaderboard') return json({ metric: 'cumulative-xp', verification: 'client-reported',
      entries: [{ ...profile, rank: 1, isMe: true }] });
    assert.equal(request.method(), 'GET', 'No rename, delete, or result writes');
    assert.ok(['/leaderboard.mjs', '/leaderboard-api.mjs', '/leaderboard.css'].includes(url.pathname));
    return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript',
      body: await readFile(new URL('../web' + url.pathname, import.meta.url), 'utf8') });
  });
  await page.goto(origin);
  await page.waitForFunction(() => window.QuietLeaderboardBridge?.profile()?.id === 'focus-fixture-only');
  await page.locator('#canvas').evaluate(canvas => { canvas.tabIndex = 0; canvas.focus(); });
  const initial = await geometry();
  await page.evaluate(() => window.QuietLeaderboardBridge.emit({ type: 'my-page' }));
  const dialog = page.locator('.ql-dialog'), input = page.locator('#ql-nickname'), close = page.locator('.ql-close');
  await dialog.waitFor({ state: 'visible' });
  assert.equal(await input.evaluate(el => el === document.activeElement), false, 'My Page must not start editing or open the keyboard');
  assert.equal(await close.evaluate(el => el === document.activeElement), true, 'Opening retains a non-editing keyboard focus target');
  assert.equal(await input.evaluate(el => getComputedStyle(el).fontSize), '16px', 'Explicit edit avoids the small-input iOS zoom trigger');
  assert.deepEqual(await geometry(), initial);
  for (let tabs = 0; tabs < 8 && !await input.evaluate(el => el === document.activeElement); tabs++) await page.keyboard.press('Tab');
  assert.equal(await input.evaluate(el => el === document.activeElement), true, 'Keyboard users can still reach the input');
  await close.focus(); await input.tap();
  assert.equal(await input.evaluate(el => el === document.activeElement), true, 'Only an intentional tap begins pointer editing');
  await input.fill('직접 입력');
  await page.evaluate(() => {
    Object.assign(window.fixtureViewport, { height: 310, offsetTop: 140 });
    window.fixtureViewport.dispatchEvent(new Event('resize')); window.dispatchEvent(new Event('resize'));
  });
  assert.deepEqual(await geometry(), initial, 'Keyboard metrics must not resize the Godot backing buffer');
  await close.tap(); await dialog.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#canvas').evaluate(el => el === document.activeElement), true, 'Close returns focus to the game');
  await page.evaluate(() => {
    Object.assign(window.fixtureViewport, { height: 664 }); window.fixtureViewport.dispatchEvent(new Event('resize'));
    Object.assign(window.fixtureViewport, { offsetTop: 0 }); window.fixtureViewport.dispatchEvent(new Event('scroll'));
  });
  assert.deepEqual(await geometry(), initial, 'Delayed keyboard pan recovery leaves no stale offset');
  await page.evaluate(() => window.QuietLeaderboardBridge.emit({ type: 'my-page' }));
  assert.equal(await input.inputValue(), profile.nickname, 'Reopen renders the saved name without an unsolicited edit');
  assert.equal(await input.evaluate(el => el === document.activeElement), false);
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#canvas').evaluate(el => el === document.activeElement), true, 'Escape restores keyboard focus');
  const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
  assert.ok(!/user-scalable\s*=\s*(no|0)|maximum-scale/i.test(viewport), 'Browser zoom remains unrestricted');
  if (engine === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1.5 });
    assert.ok(await page.evaluate(() => window.nativeViewport.scale > 1.4));
    assert.deepEqual(await geometry(), initial, 'Browser zoom cannot be baked into the rendering buffer');
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
    assert.deepEqual(await geometry(), initial, 'Browser unzoom returns the same game geometry');
  }
  assert.deepEqual(errors, []);
  if (screenshots) { await mkdir(screenshots, { recursive: true }); await page.screenshot({ path: join(screenshots, engine + '-restored.png') }); }
  console.log('Profile focus passed (' + engine + ' mobile emulation): explicit editing, keyboard/Escape focus, keyboard-pan recovery, stable canvas; no production API traffic');
} catch (error) {
  if (page && screenshots) {
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, engine + '-failure.png') });
    await writeFile(join(screenshots, engine + '-failure.json'), JSON.stringify(await page.evaluate(() => ({
      active: document.activeElement?.id, inputFont: getComputedStyle(document.querySelector('#ql-nickname')).fontSize,
      phone: document.querySelector('#phone').getAttribute('style') })), null, 2));
  }
  throw error;
} finally { await browser.close(); }
