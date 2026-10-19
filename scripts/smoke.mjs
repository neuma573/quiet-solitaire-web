import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import assert from 'node:assert/strict';

const argv = process.argv.slice(2);
const option = (name) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
const directory = option('--directory');
let address = option('--url');
let server;
const prefix = '/quiet-solitaire-web/';
const mime = { '.wasm': 'application/wasm', '.pck': 'application/octet-stream',
  '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
if (directory) {
  const root = resolve(directory);
  server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (!path.startsWith(prefix)) { res.writeHead(404).end(); return; }
      const file = resolve(root, path.slice(prefix.length) || 'index.html');
      if (!file.startsWith(root + sep) || !(await stat(file)).isFile()) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' });
      res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  address = `http://127.0.0.1:${server.address().port}${prefix}`;
}
assert(address, '--directory or --url is required');
const manifest = await fetch(address + 'deployment.json');
assert.equal(manifest.status, 200, 'Deployment metadata must be served');
const deployment = await manifest.json();
assert.equal(deployment.threads, false, 'Build must be single threaded');
const wasm = await fetch(address + 'index.wasm');
assert.equal(wasm.status, 200, 'WebAssembly must load under the project subpath');
assert(wasm.headers.get('content-type')?.includes('application/wasm'), 'WebAssembly MIME must be correct');
const wasmBytes = new Uint8Array(await wasm.arrayBuffer());
assert.deepEqual([...wasmBytes.slice(0, 4)], [0, 97, 115, 109], 'WebAssembly must be a valid binary');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_BIN || (process.platform === 'darwin' && existsSync(chrome) ? chrome : undefined),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const pixelDensity = Number(option('--density') || 2);
  const locale = option('--locale') || 'ko-KR';
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: pixelDensity, locale });
  const errors = [];
  page.on('pageerror', () => errors.push('JavaScript exception'));
  page.on('console', (message) => {
    if (message.type() === 'error' || /SCRIPT ERROR:|\bERROR:/.test(message.text())) errors.push('Runtime error');
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && /\.(wasm|pck|m?js|css|png)(\?|$)/.test(response.url())) errors.push('Runtime asset error');
  });
  await page.goto(address, { waitUntil: 'load', timeout: 120_000 });
  await page.waitForFunction(() => {
    const status = document.querySelector('#status');
    return !status || getComputedStyle(status).display === 'none';
  }, null, { timeout: 120_000 });
  await page.waitForTimeout(2500);
  const canvas = page.locator('#canvas');
  assert(await canvas.isVisible(), 'Game canvas must be visible');
  async function verifyPhone() {
    const bitmap = await canvas.evaluate((element) => ({ width: element.width, height: element.height }));
    const density = await page.evaluate(() => window.devicePixelRatio);
    assert.deepEqual(bitmap, { width: Math.round(390 * density), height: Math.round(760 * density) },
      'Game must keep a 390x760 logical resolution with matching high-density rendering at every browser size');
    const viewport = page.viewportSize();
    const scale = Math.min(1, viewport.width / 390, viewport.height / 760);
    const box = await canvas.boundingBox();
    for (const [name, expected] of Object.entries({ width: 390 * scale, height: 760 * scale,
      x: (viewport.width - 390 * scale) / 2, y: (viewport.height - 760 * scale) / 2 })) {
      assert(Math.abs(box[name] - expected) < 0.1, `Phone canvas must preserve its proportions and stay centered: ${name}`);
    }
    return box;
  }
  await verifyPhone();
  async function menuControls() {
    // The title card drift is intentionally animated. Its source clip ends
    // above the Start button; compare every pixel of the static footer while
    // the bitmap dimensions and full canvas geometry remain checked above.
    const box = await canvas.boundingBox();
    return page.screenshot({ clip: { x: box.x, y: box.y + 580 * box.height / 760,
      width: box.width, height: 180 * box.height / 760 } });
  }
  const start = await menuControls();
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.waitForTimeout(300);
  await verifyPhone();
  assert(start.equals(await menuControls()), 'Resizing a desktop window must preserve the exact static menu layout');
  if (option('--screenshot')) await page.screenshot({ path: option('--screenshot') });
  async function click(x, y) {
    const box = await canvas.boundingBox();
    await page.mouse.click(box.x + x * box.width / 390, box.y + y * box.height / 760);
  }
  // Actual mouse events exercise the same menu-to-game path as a browser player.
  // Coordinates are relative to the source's 390x760 portrait viewport.
  await click(195, 620);
  await page.waitForTimeout(800);
  const after = await menuControls();
  assert(!start.equals(after), 'A menu interaction must change the static navigation controls, independently of title animation');
  await click(195, 700);
  await page.waitForTimeout(800);
  const scoring = await menuControls();
  assert(!scoring.equals(after), 'Choosing a game must open scoring selection');
  if (option('--screenshot')) await canvas.screenshot({ path: option('--screenshot').replace(/\.png$/, '-mode.png') });
  await click(195, 700);
  await page.waitForTimeout(2000);
  const game = await menuControls();
  assert(!game.equals(scoring), 'Starting a game must render the card board');
  if (option('--screenshot')) await page.screenshot({ path: option('--screenshot').replace(/\.png$/, '-desktop-game.png') });
  const gameBox = await verifyPhone();
  const desktopBoard = await page.screenshot({ clip: { x: gameBox.x, y: gameBox.y + 64, width: 390, height: 400 } });
  await page.setViewportSize({ width: 390, height: 760 });
  await page.waitForTimeout(300);
  await verifyPhone();
  // Keep the header's running timer outside the comparison area.
  const phoneBoard = await page.screenshot({ clip: { x: 0, y: 64, width: 390, height: 400 } });
  assert(desktopBoard.equals(phoneBoard), 'Moving from desktop to phone must preserve card layout and game state');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(300);
  const desktopBox = await verifyPhone();
  const resizedBoard = await page.screenshot({ clip: { x: desktopBox.x, y: desktopBox.y + 64, width: 390, height: 400 } });
  assert(phoneBoard.equals(resizedBoard), 'Moving between phone and desktop browser sizes must preserve card layout and game state');
  await page.setViewportSize({ width: 800, height: 400 });
  await page.waitForTimeout(300);
  await verifyPhone();
  await page.setViewportSize({ width: 320, height: 568 });
  await page.waitForTimeout(300);
  const smallBox = await verifyPhone();
  const smallScale = smallBox.width / 390;
  const boardClip = { x: smallBox.x, y: smallBox.y + 64 * smallScale,
    width: smallBox.width, height: 400 * smallScale };
  const beforeDraw = await page.screenshot({ clip: boardClip });
  await click(35, 105);
  await page.waitForTimeout(600);
  const drawn = await page.screenshot({ clip: boardClip });
  assert(!beforeDraw.equals(drawn), 'Drawing from stock must change the card board');
  await click(154, 724);
  await page.waitForTimeout(600);
  const undone = await page.screenshot({ clip: boardClip });
  assert(beforeDraw.equals(undone), 'Undo must restore the exact rendered card board');
  if (option('--screenshot')) await page.screenshot({ path: option('--screenshot').replace(/\.png$/, '-game.png') });
  assert.equal(errors.length, 0, 'Runtime must start and respond without console/asset errors');
  console.log(`Browser runtime passed: fixed 390x760 phone on desktop, portrait and landscape at ${pixelDensity}x pixel density (${locale}); resize preserves state; scaled input, stock draw and undo; source ${deployment.source_sha}`);
} finally {
  await browser.close();
  if (server) await new Promise((done) => server.close(done));
}
