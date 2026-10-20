// Actual compiled Godot runtime, real HTTP/audio loading, no guest API writes.
// --url also allows reproducing the regression against a deployed build.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep, join } from 'node:path';
import { chromium, webkit } from 'playwright';
import imageTools from 'playwright-core/lib/utilsBundle';
const { PNG } = imageTools;

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
const directory = option('--directory');
let configResponses = 0;
try {
  if (directory) {
    const root = resolve(directory);
    server = createServer(async (req, res) => {
      try {
        const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        // Exercise input/focus against the real export without contacting the
        // API configured for production. Never rewrite the export on disk.
        if (path === prefix + 'leaderboard-config.json') {
          configResponses++;
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ apiBase: '' })); return;
        }
        const file = resolve(root, path.slice(prefix.length) || 'index.html');
        if (!path.startsWith(prefix) || !file.startsWith(root + sep) || !(await stat(file)).isFile()) {
          res.writeHead(404).end(); return;
        }
        const bytes = await readFile(file);
        res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' });
        res.end(bytes);
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
  for (const [name, viewport, touch, density, colorScheme] of [
    ['touch-retina', { width: 390, height: 760 }, true, 2, 'light'],
    ['touch-retina-dark', { width: 390, height: 760 }, true, 2, 'dark'],
    ['touch-scaled', { width: 320, height: 568 }, true, 1, 'light'],
    ['touch-short-dark', { width: 390, height: 664 }, true, 2, 'dark'],
    ['touch-wide', { width: 430, height: 932 }, true, 2, 'light'],
    ['touch-square-dark', { width: 600, height: 601 }, true, 1, 'dark'],
    ['mouse-desktop', { width: 1440, height: 1000 }, false, 1, 'light'],
  ]) {
    page = await browser.newPage({ viewport: { width:390, height:760 }, deviceScaleFactor: density, hasTouch: touch,
      isMobile: touch, locale: 'ko-KR', colorScheme });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' || /SCRIPT ERROR:|\bERROR:/.test(message.text())) errors.push(message.text());
    });
    page.on('response', response => {
      if (response.status() >= 400 && /\.(wasm|pck|m?js|css|png)(\?|$)/.test(response.url())) errors.push(response.url());
    });
    if (directory) {
      const localOrigin = new URL(address).origin;
      await page.route('**/*', route => {
        if (new URL(route.request().url()).origin !== localOrigin) {
          errors.push('Unexpected external request in directory fixture');
          return route.abort('blockedbyclient');
        }
        return route.continue();
      });
    }
    await page.goto(address, { waitUntil: 'load', timeout: 120_000 });
    await page.waitForFunction(() => !document.getElementById('status'), null, { timeout: 120_000 });
    await page.waitForTimeout(3500); // Engine readiness precedes the native menu's startup transition.
    const canvas = page.locator('#canvas');
    // Select the game's own appearance setting. Browser color preference alone
    // does not activate Godot's fallback dark theme on every Web build.
    const setupInput = async (x, y) => {
      const box = await canvas.boundingBox();
      if (touch) await page.touchscreen.tap(box.x+x, box.y+y);
      else await page.mouse.click(box.x+x, box.y+y);
      await page.waitForTimeout(300);
    };
    await setupInput(288,704);
    await setupInput(195,164);
    await setupInput(195,colorScheme==='dark' ? 190 : 141);
    await setupInput(47,24);
    await setupInput(47,24);
    await page.setViewportSize(viewport);
    await page.waitForTimeout(300);
    const frame = await canvas.boundingBox();
    const scale = Math.min(frame.width / 390, frame.height / 760);
    const logicalWidth = frame.width / scale, logicalHeight = frame.height / scale;
    if (touch) {
      assert.ok(Math.abs(frame.x) < 0.1 && Math.abs(frame.width - viewport.width) < 0.1,
        `${name}: actual canvas fills the available width`);
      assert.ok(frame.y >= 0 && frame.y + frame.height <= viewport.height + 0.1,
        `${name}: the complete game stays inside the visible viewport`);
    }
    const bitmap = await canvas.evaluate(el => ({ width: el.width, height: el.height }));
    assert.ok(Math.abs(bitmap.width / bitmap.height - frame.width / frame.height) < 0.0001,
      `${name}: CSS and rendering aspect ratios match without stretch`);
    assert.ok(bitmap.width >= frame.width * density - 0.1 && bitmap.height >= frame.height * density - 0.1,
      `${name}: native rendering covers the device pixel density`);
    const initial = PNG.sync.read(await page.screenshot());
    const pixel = (Math.floor((frame.y + 2) * density) * initial.width + Math.floor((frame.x + 2) * density)) * 4;
    const background = colorScheme === 'dark' ? 25 : 245;
    assert.ok(initial.data.subarray(pixel, pixel + 3).every(value => Math.abs(value - background) <= 1),
      `${name}: the actual Godot ${colorScheme} background fills the canvas`);
    const input = async (x, y) => {
      const box = await canvas.boundingBox();
      const point = [box.x + x * scale, box.y + y * scale];
      if (touch) await page.touchscreen.tap(...point); else await page.mouse.click(...point);
      await page.waitForTimeout(300); // Source transitions/selection tweens last <= 240 ms.
    };
    const point = async (x, y) => {
      if (touch) await page.touchscreen.tap(x, y); else await page.mouse.click(x, y);
      await page.waitForTimeout(300);
    };
    const crop = async (x, y, width, height) => {
      const box = await canvas.boundingBox();
      return page.screenshot({ clip: { x: box.x + x * scale, y: box.y + y * scale,
        width: width * scale, height: height * scale } });
    };
    // Locate the rendered five-row PopupMenu, whose position and item height
    // follow native font/touch metrics. Selection still uses real pointer input.
    async function popupRows() {
      const png = PNG.sync.read(await page.screenshot());
      const ratio = png.width / viewport.width;
      const x = Math.floor((frame.x + frame.width * 0.55) * ratio);
      const runs = []; let start = null;
      for (let y = Math.floor((frame.y + frame.height * 0.3) * ratio); y < Math.min(png.height, (frame.y + frame.height) * ratio); y++) {
        const at = (y * png.width + x) * 4;
        const [r, g, b] = png.data.subarray(at, at + 3);
        const menu = r >= 48 && r <= 130 && Math.abs(r - g) < 3 && Math.abs(r - b) < 3;
        if (menu && start === null) start = y;
        if (!menu && start !== null) { runs.push([start, y]); start = null; }
      }
      const run = runs.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))[0];
      assert.ok(run && (run[1] - run[0]) / ratio > 60, `${name}: a visible five-row native popup opens`);
      return { top: run[0] / ratio, height: (run[1] - run[0]) / ratio };
    }
    const open = async () => {
      await input(logicalWidth / 2, 421);
      return popupRows();
    };
    const select = async (index, menu) => point(frame.x + 100 * scale, menu.top + menu.height * (index + 0.5) / 5);
    const save = label => page.screenshot({ path: join(screenshots, `${name}-${label}.png`) });
    async function stableBoard() {
      let previous = await crop(0, 64, logicalWidth, 400);
      for (let attempt = 0; attempt < 12; attempt++) {
        await page.waitForTimeout(300);
        const current = await crop(0, 64, logicalWidth, 400);
        if (current.equals(previous)) return current;
        previous = current;
      }
      assert.fail(`${name}: card animation must settle before checking board input`);
    }
    await input(logicalWidth / 4 + 4, logicalHeight - 56);
    await save('page');
    // Exercise HTML dialog focus restoration before opening the native popup.
    await input(logicalWidth / 2, 238);
    await page.locator('.ql-dialog').waitFor({ state: 'visible' });
    if (directory) await page.getByText('공유 리더보드 서버가 아직 연결되지 않았습니다. 연결 후 이용할 수 있습니다.', { exact: true }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: '닫기', exact: true }).click();
    await page.locator('.ql-dialog').waitFor({ state: 'hidden' });
    const menu = await open();
    await select(0, menu);
    const filterClip = { x: frame.x + 28 * scale, y: menu.top - 48, width: 260 * scale, height: 48 };
    const filter = () => page.screenshot({ clip: filterClip });
    const all = await filter();
    let previous = all;
    for (const index of [1, 2, 3, 4, 0]) {
      await select(index, await open());
      const current = await filter();
      await save(`selected-${index}`);
      assert.ok(!previous.equals(current), `${name}: difficulty ${index} must select and release popup input`);
      if (index === 0) assert.ok(all.equals(current), `${name}: all five options must return to All`);
      previous = current;
    }
    const controlsClip = { x: frame.x + 28 * scale, y: menu.top, width: (logicalWidth - 56) * scale,
      height: Math.min(130 * scale, frame.y + frame.height - menu.top) };
    const controls = await page.screenshot({ clip: controlsClip });
    await open();
    assert.ok(!controls.equals(await page.screenshot({ clip: controlsClip })), `${name}: popup must actually open`);
    await input(logicalWidth - 30, 320); // Neutral area outside the popup, away from navigation controls.
    assert.ok(controls.equals(await page.screenshot({ clip: controlsClip })), `${name}: outside tap dismisses and leaves the page usable`);
    await select(2, await open());
    assert.ok(!all.equals(await filter()), `${name}: a new popup still selects after outside dismissal`);
    const profileFooter = await crop(28, 600, 300, 140);
    await input(47, 24);
    assert.ok(!profileFooter.equals(await crop(28, 600, 300, 140)), `${name}: Back works after popup dismissal`);
    await input(logicalWidth / 4 + 4, logicalHeight - 56);
    const drawY = menu.top + 20 * scale + 24;
    const drawClip = { x: frame.x + 36 * scale, y: drawY - 14 * scale, width: 12 * scale, height: 12 * scale };
    const selectedDraw = await page.screenshot({ clip: drawClip });
    await point(frame.x + frame.width * 0.75, drawY);
    assert.ok(!selectedDraw.equals(await page.screenshot({ clip: drawClip })), `${name}: reopened page accepts exactly the new draw selection`);
    await input(47, 24);
    // The game/mode previews finish their entrance before accepting the next
    // navigation action (same readiness interval as the ordinary runtime smoke).
    await input(logicalWidth / 2, logicalHeight - 140); await page.waitForTimeout(500);
    await input(logicalWidth / 2, logicalHeight - 60); await page.waitForTimeout(500);
    await input(logicalWidth / 2, logicalHeight - 60);
    await page.waitForTimeout(2000);
    const board = await stableBoard();
    await save('game-before-stock');
    const stockX = name === 'touch-square-dark' ? 120 / scale : 8 + (logicalWidth - 28) / 14;
    await input(stockX, 105);
    assert.ok(!board.equals(await stableBoard()), `${name}: board still accepts stock input`);
    await save('game-after-stock');
    await point(frame.x + frame.width / 2 - 24 - 16 * scale, frame.y + frame.height - 36 * scale);
    assert.ok(board.equals(await stableBoard()), `${name}: one Undo reverses one stock tap after popup closes`);
    await save('game-after-undo');
    if (name === 'touch-retina' || name === 'touch-retina-dark') {
      const measurements = [];
      for (const appearance of [colorScheme]) {
        for (const [width, height] of [[320,460],[320,504],[360,500],[320,568],[320,640],[360,640],[360,720],[375,667],[375,812],
          [390,664],[390,700],[390,760],[390,844],[393,719],[412,730],[430,780],[430,932],
          [480,800],[540,960],[600,601],[600,960],[600,1200]]) {
          await page.setViewportSize({ width, height });
          await page.waitForTimeout(300);
          const geometry = await canvas.evaluate(el => {
            const r = el.getBoundingClientRect();
            return { x:r.x, y:r.y, width:r.width, height:r.height, bitmapWidth:el.width, bitmapHeight:el.height,
              clientWidth:document.documentElement.clientWidth, scrollWidth:document.documentElement.scrollWidth,
              visualScale:window.visualViewport?.scale ?? 1 };
          });
          assert.ok(Math.abs(geometry.x) < 0.1 && Math.abs(geometry.width - width) < 0.1,
            `${appearance}/${width}x${height}: full rendering canvas fills the viewport width`);
          assert.ok(geometry.y >= 0 && geometry.y + geometry.height <= height + 0.1,
            `${appearance}/${width}x${height}: whole game fits vertically`);
          assert.equal(geometry.scrollWidth, geometry.clientWidth, 'Responsive canvas must not create horizontal overflow');
          assert.ok(Math.abs(geometry.visualScale - 1) < 0.001, 'Resizing must not trigger browser auto zoom');
          assert.ok(Math.abs(geometry.bitmapWidth / geometry.bitmapHeight - geometry.width / geometry.height) < 0.0001,
            'Responsive rendering retains equal horizontal and vertical scale');
          const screenshot = await page.screenshot();
          const png = PNG.sync.read(screenshot), ratio = png.width / width;
          const y = Math.ceil((geometry.y + 2) * ratio);
          const expected = appearance === 'dark' ? 25 : 245;
          for (const x of [0, 1, png.width - 2, png.width - 1]) {
            const at = (y * png.width + x) * 4;
            assert.ok(png.data.subarray(at, at + 3).every(value => Math.abs(value - expected) <= 1),
              `${appearance}/${width}x${height}: actual Godot background reaches both viewport edges`);
          }
          await writeFile(join(screenshots, `responsive-${appearance}-${width}x${height}.png`), screenshot);
          measurements.push({ appearance, viewport:{width,height}, ...geometry });
        }
      }
      await page.setViewportSize(viewport);
      await page.waitForTimeout(300);
      assert.ok(board.equals(await stableBoard()), 'Width caps, theme changes and responsive reflow preserve the board on return');
      await writeFile(join(screenshots, `responsive-canvas-${colorScheme}.json`), JSON.stringify(measurements, null, 2));
      console.log(`Responsive canvas passed: ${engine}; 22 viewports at 320–600px in ${colorScheme} game mode; no gutters, overflow, auto zoom or aspect distortion`);
    }
    await page.close(); page = null;
    console.log(`Profile input passed: ${engine}/${name}; five difficulty options, HTML focus return, outside dismissal, Back, page recreation, single stock action/Undo`);
  }
  if (directory) assert.ok(configResponses >= 4, 'Each input case must load the isolated disabled config');
  assert.deepEqual(errors, [], 'All JavaScript, Godot, audio and asset errors fail this real-server test');
} catch (error) {
  if (page) await page.screenshot({ path: join(screenshots, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  if (server) await new Promise(done => server.close(done));
}

