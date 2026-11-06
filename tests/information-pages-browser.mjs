// Read only the copied public assets. Every HTTP request is served locally;
// no real support email, Apple request, game session or leaderboard write occurs.
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, join, extname, sep } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = await mkdtemp(join(tmpdir(), 'quiet-info-pages-'));
const screenshots = resolve(process.env.SCREENSHOT_DIR || 'artifacts/information-pages');
await mkdir(screenshots, { recursive: true });
const copy = spawnSync('python3', ['-c', 'import sys; from pathlib import Path; sys.path.insert(0,"scripts"); from build import copy_public_web_assets; copy_public_web_assets(Path(sys.argv[1]))', output], { encoding: 'utf8' });
assert.equal(copy.status, 0, copy.stderr);
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN
  || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined) });
const origin = 'https://quiet-information.test';
const prefix = '/quiet-solitaire-web/';
const errors = [], requests = [];
try {
  for (const javaScriptEnabled of [true, false]) {
    const context = await browser.newContext({ javaScriptEnabled, locale: 'ko-KR' });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      requests.push(url.pathname);
      try {
        assert.equal(url.origin, origin, 'No external services are requested');
        assert.equal(request.method(), 'GET');
        assert.ok(url.pathname.startsWith(prefix));
        let relative = decodeURIComponent(url.pathname.slice(prefix.length));
        if (relative.endsWith('/')) relative += 'index.html';
        assert.ok(['support/index.html', 'privacy/index.html', 'information.css'].includes(relative),
          'Information pages request only their own HTML and shared CSS');
        const file = resolve(output, relative);
        assert.ok(file.startsWith(output + sep));
        return route.fulfill({ contentType: extname(file) === '.css' ? 'text/css' : 'text/html', body: await readFile(file) });
      } catch (error) { errors.push(error.message); return route.fulfill({ status: 500, body: 'fixture failure' }); }
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    for (const name of ['support', 'privacy']) {
      for (const [width, height] of [[1440, 1000], [768, 1024], [390, 844], [320, 568]]) {
        await page.setViewportSize({ width, height });
        await page.goto(origin + prefix + name + '/');
        assert.equal(await page.locator('h1').count(), 1);
        assert.equal(await page.locator('#ko, #en').count(), 2);
        assert.ok(await page.locator('#en').isVisible());
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'No horizontal overflow');
        assert.equal(await page.locator('script, iframe, form, canvas').count(), 0);
        for (const link of await page.locator('.language-nav a, .back-link, .contact, .footer-nav a').all()) {
          const box = await link.boundingBox();
          assert.ok(box && box.height >= 44 && box.width >= 44, 'Navigation and contact touch targets are at least 44 by 44px');
        }
        // Verify stylesheet and body remain readable with 200% text zoom.
        // addStyleTag waits on an event that can hang with JavaScript disabled.
        // Synchronous DOM insertion keeps the same CSS check in both contexts.
        await page.evaluate(() => {
          const style = document.createElement('style');
          style.textContent = 'body, .document { font-size: 32px; }';
          document.head.appendChild(style);
        });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'No horizontal overflow at 200% body text');
        await page.reload();
        if (javaScriptEnabled && [1440, 390].includes(width)) {
          await page.screenshot({ path: join(screenshots, `${name}-${width}.png`), fullPage: false });
        }
        assert.equal(await page.locator('meta[name="robots"][content="noindex"], .review-note').count(), 0);
        if (name === 'privacy') assert.ok(await page.locator('time[datetime="2026-11-06"]').isVisible());
      }
      await page.goto(origin + prefix + name + '/');
      await page.keyboard.press('Tab');
      assert.equal(await page.locator('.skip-link').evaluate(el => el === document.activeElement), true);
      await page.keyboard.press('Enter');
      assert.ok(page.url().endsWith('#main'));
      await page.locator('.language-nav a[lang="en"]').click();
      assert.ok(page.url().endsWith('#en'));
      assert.equal(await page.locator('a[href="mailto:neuma573@gmail.com"]').first().getAttribute('href'), 'mailto:neuma573@gmail.com');
    }
    await page.goto(origin + prefix + 'support/');
    await page.locator('#en a[href="../privacy/#en"]').click();
    assert.equal(page.url(), origin + prefix + 'privacy/#en');
    await page.locator('.back-link').click();
    assert.equal(page.url(), origin + prefix + 'support/');
    assert.deepEqual(await context.cookies(), [], 'Pages do not create cookies');
    assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(`Information pages passed: 16 viewport/JavaScript combinations, 200% body text, keyboard and subpath links; ${requests.length} local requests, no external requests or storage writes.`);
} finally {
  await browser.close();
  await rm(output, { recursive: true, force: true });
}
