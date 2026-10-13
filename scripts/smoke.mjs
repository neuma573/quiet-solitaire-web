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
  '.html': 'text/html', '.js': 'application/javascript', '.png': 'image/png', '.json': 'application/json' };
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
  const page = await browser.newPage({ viewport: { width: 390, height: 760 }, locale: 'ko-KR' });
  const errors = [];
  page.on('pageerror', () => errors.push('JavaScript exception'));
  page.on('console', (message) => {
    if (message.type() === 'error' || /SCRIPT ERROR:|\bERROR:/.test(message.text())) errors.push('Runtime error');
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && /\.(wasm|pck|js|png)(\?|$)/.test(response.url())) errors.push('Runtime asset error');
  });
  await page.goto(address, { waitUntil: 'load', timeout: 120_000 });
  await page.waitForFunction(() => {
    const status = document.querySelector('#status');
    return !status || getComputedStyle(status).display === 'none';
  }, null, { timeout: 120_000 });
  await page.waitForTimeout(2500);
  const canvas = page.locator('#canvas');
  assert(await canvas.isVisible(), 'Game canvas must be visible');
  const start = await canvas.screenshot();
  if (option('--screenshot')) await page.screenshot({ path: option('--screenshot') });
  // Actual mouse events exercise the same menu-to-game path as a browser player.
  // Coordinates are relative to the source's 390x760 portrait viewport.
  await page.mouse.click(195, 620);
  await page.waitForTimeout(800);
  const after = await canvas.screenshot();
  assert(!start.equals(after), 'A menu interaction must change the rendered game');
  await page.mouse.click(195, 700);
  await page.waitForTimeout(800);
  const scoring = await canvas.screenshot();
  assert(!scoring.equals(after), 'Choosing a game must open scoring selection');
  await page.mouse.click(195, 700);
  await page.waitForTimeout(2000);
  const game = await canvas.screenshot();
  assert(!game.equals(scoring), 'Starting a game must render the card board');
  const boardClip = { x: 0, y: 64, width: 390, height: 400 };
  const beforeDraw = await page.screenshot({ clip: boardClip });
  await page.mouse.click(35, 105);
  await page.waitForTimeout(600);
  const drawn = await page.screenshot({ clip: boardClip });
  assert(!beforeDraw.equals(drawn), 'Drawing from stock must change the card board');
  await page.mouse.click(154, 724);
  await page.waitForTimeout(600);
  const undone = await page.screenshot({ clip: boardClip });
  assert(beforeDraw.equals(undone), 'Undo must restore the exact rendered card board');
  if (option('--screenshot')) await page.screenshot({ path: option('--screenshot').replace(/\.png$/, '-game.png') });
  assert.equal(errors.length, 0, 'Runtime must start and respond without console/asset errors');
  console.log(`Browser runtime passed: project subpath, WebAssembly MIME, Korean menu, play, stock draw and undo; source ${deployment.source_sha}`);
} finally {
  await browser.close();
  if (server) await new Promise((done) => server.close(done));
}
