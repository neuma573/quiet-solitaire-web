// Actual compiled Godot runtime, real HTTP/audio loading, no guest API writes.
// --url also allows reproducing the regression against a deployed build.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { resolve, extname, sep, join } from 'node:path';
import { chromium, webkit } from 'playwright';

const argv = process.argv.slice(2);
const option = name => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
const screenshots = resolve(option('--screenshots') || 'artifacts/profile-input');
await mkdir(screenshots, { recursive: true });
const prefix = '/quiet-solitaire-web/';
const mime = { '.wasm': 'application/wasm', '.pck': 'application/octet-stream',
  '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
let server, browser, page;
let address = option('--url');
const errors = [];
try {
  if (option('--directory')) {
    const root = resolve(option('--directory'));
    server = createServer(async (req, res) => {
      try {
        const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        const file = resolve(root, path.slice(prefix.length) || 'index.html');
        if (!path.startsWith(prefix) || !file.startsWith(root + sep) || !(await stat(file)).isFile()) {
          res.writeHead(404).end(); return;
        }
        res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' });
        res.end(await readFile(file));
      } catch { res.writeHead(404).end(); }
    });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    address = `http://127.0.0.1:${server.address().port}${prefix}`;
  }
  assert.ok(address, '--directory or --url is required');
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const engine = option('--browser') || 'chromium';
  assert.ok(['chromium', 'webkit'].includes(engine), '--browser must be chromium or webkit');
  browser = engine === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.launch({ headless: true,
    executablePath: process.env.CHROME_BIN || (existsSync(chrome) ? chrome : undefined),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  for (const [name, viewport, touch, density] of [
    ['touch-retina', { width: 390, height: 760 }, true, 2],
    ['touch-scaled', { width: 320, height: 568 }, true, 1],
    ['touch-wide', { width: 430, height: 932 }, true, 2],
    ['mouse-desktop', { width: 1440, height: 1000 }, false, 1],
  ]) {
    page = await browser.newPage({ viewport, deviceScaleFactor: density, hasTouch: touch,
      isMobile: touch, locale: 'ko-KR' });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' || /SCRIPT ERROR:|\bERROR:/.test(message.text())) errors.push(message.text());
    });
    page.on('response', response => {
      if (response.status() >= 400 && /\.(wasm|pck|m?js|css|png)(\?|$)/.test(response.url())) errors.push(response.url());
    });
    await page.goto(address, { waitUntil: 'load', timeout: 120_000 });
    await page.waitForFunction(() => !document.getElementById('status'), null, { timeout: 120_000 });
    await page.waitForTimeout(3500); // Engine readiness precedes the native menu's startup transition.
    const canvas = page.locator('#canvas');
    const input = async (x, y) => {
      const box = await canvas.boundingBox();
      const point = [box.x + x * box.width / 390, box.y + y * box.height / 760];
      if (touch) await page.touchscreen.tap(...point); else await page.mouse.click(...point);
      await page.waitForTimeout(300); // Source transitions/selection tweens last <= 240 ms.
    };
    const crop = async (x, y, width, height) => {
      const box = await canvas.boundingBox();
      return page.screenshot({ clip: { x: box.x + x * box.width / 390, y: box.y + y * box.height / 760,
        width: width * box.width / 390, height: height * box.height / 760 } });
    };
    const save = label => page.screenshot({ path: join(screenshots, `${name}-${label}.png`) });
    async function stableBoard() {
      let previous = await crop(0, 64, 390, 400);
      for (let attempt = 0; attempt < 12; attempt++) {
        await page.waitForTimeout(300);
        const current = await crop(0, 64, 390, 400);
        if (current.equals(previous)) return current;
        previous = current;
      }
      assert.fail(`${name}: card animation must settle before checking board input`);
    }
    await input(102, 704);
    await save('page');
    // Exercise HTML dialog focus restoration before opening the native popup.
    await input(195, 238);
    await page.locator('.ql-dialog').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: '닫기', exact: true }).click();
    await page.locator('.ql-dialog').waitFor({ state: 'hidden' });
    const all = await crop(28, 405, 260, 32);
    let previous = all;
    for (const index of [1, 2, 3, 4, 0]) {
      await input(195, 421);
      await input(100, 460 + index * 24);
      const current = await crop(28, 405, 260, 32);
      await save(`selected-${index}`);
      assert.ok(!previous.equals(current), `${name}: difficulty ${index} must select and release popup input`);
      if (index === 0) assert.ok(all.equals(current), `${name}: all five options must return to All`);
      previous = current;
    }
    const controls = await crop(28, 455, 300, 130);
    await input(195, 421);
    assert.ok(!controls.equals(await crop(28, 455, 300, 130)), `${name}: popup must actually open`);
    await input(360, 320); // Neutral area outside the popup, away from navigation controls.
    assert.ok(controls.equals(await crop(28, 455, 300, 130)), `${name}: outside tap dismisses and leaves the page usable`);
    await input(195, 421);
    await input(100, 508);
    assert.ok(!all.equals(await crop(28, 405, 260, 32)), `${name}: a new popup still selects after outside dismissal`);
    const profileFooter = await crop(28, 600, 300, 140);
    await input(47, 24);
    assert.ok(!profileFooter.equals(await crop(28, 600, 300, 140)), `${name}: Back works after popup dismissal`);
    await input(102, 704);
    const selectedDraw = await crop(36, 475, 12, 12);
    await input(282, 489);
    assert.ok(!selectedDraw.equals(await crop(36, 475, 12, 12)), `${name}: reopened page accepts exactly the new draw selection`);
    await input(47, 24);
    // The game/mode previews finish their entrance before accepting the next
    // navigation action (same readiness interval as the ordinary runtime smoke).
    await input(195, 620); await page.waitForTimeout(500);
    await input(195, 700); await page.waitForTimeout(500);
    await input(195, 700);
    await page.waitForTimeout(2000);
    const board = await stableBoard();
    await save('game-before-stock');
    await input(35, 105);
    assert.ok(!board.equals(await stableBoard()), `${name}: board still accepts stock input`);
    await save('game-after-stock');
    await input(154, 724);
    assert.ok(board.equals(await stableBoard()), `${name}: one Undo reverses one stock tap after popup closes`);
    await save('game-after-undo');
    await page.close(); page = null;
    console.log(`Profile input passed: ${engine}/${name}; five difficulty options, HTML focus return, outside dismissal, Back, page recreation, single stock action/Undo`);
  }
  assert.deepEqual(errors, [], 'All JavaScript, Godot, audio and asset errors fail this real-server test');
} catch (error) {
  if (page) await page.screenshot({ path: join(screenshots, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  if (server) await new Promise(done => server.close(done));
}
