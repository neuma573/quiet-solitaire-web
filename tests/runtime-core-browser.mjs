// Two real compiled-runtime journeys. Only local assets, disabled guest API,
// real pointer/touch input, condition-based waits, screenshots on failure only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { resolve, extname, sep, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';
import imageTools from 'playwright-core/lib/utilsBundle';
const { PNG } = imageTools;
const argv = process.argv.slice(2);
const option = name => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
assert.ok(option('--directory'), '--directory is required; never target a deployed site');
const root = resolve(option('--directory'));
const screenshots = resolve(option('--screenshots') || 'artifacts/runtime-core');
const prefix = '/quiet-solitaire-web/';
const mime = { '.wasm':'application/wasm', '.pck':'application/octet-stream', '.html':'text/html',
  '.js':'application/javascript', '.mjs':'application/javascript', '.css':'text/css',
  '.png':'image/png', '.json':'application/json' };
let configResponses = 0, captures = 0, browser, page, caseName;
const errors = [];
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (path === prefix + 'leaderboard-config.json') {
      configResponses++;
      res.writeHead(200, { 'Content-Type':'application/json', 'Cache-Control':'no-store' });
      return res.end('{"apiBase":""}');
    }
    const file = resolve(root, path.slice(prefix.length) || 'index.html');
    if (!path.startsWith(prefix) || !file.startsWith(root + sep) || !(await stat(file)).isFile()) {
      res.writeHead(404).end(); return;
    }
    res.writeHead(200, { 'Content-Type':mime[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
try {
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const address = `http://127.0.0.1:${server.address().port}${prefix}`;
  const origin = new URL(address).origin;
  const deployment = await (await fetch(address + 'deployment.json')).json();
  assert.equal(deployment.threads, false, 'Release is single threaded');
  const wasm = await fetch(address + 'index.wasm');
  assert.equal(wasm.status, 200);
  assert.ok(wasm.headers.get('content-type')?.includes('application/wasm'));
  assert.deepEqual([...new Uint8Array(await wasm.arrayBuffer()).slice(0, 4)], [0,97,115,109]);
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ headless:true,
    executablePath:process.env.CHROME_BIN || (existsSync(chrome) ? chrome : undefined),
    args:['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  for (const [name, viewport, touch, density] of [
    ['mobile', { width:390, height:760 }, true, 2],
    ['desktop', { width:1440, height:1000 }, false, 1],
  ]) {
    const started = performance.now(), beforeConfig = configResponses, beforeCaptures = captures;
    caseName = name;
    page = await browser.newPage({ viewport, hasTouch:touch, isMobile:touch,
      deviceScaleFactor:density, locale:'ko-KR', colorScheme:'light', serviceWorkers:'block' });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' || /SCRIPT ERROR:|\bERROR:/.test(message.text())) errors.push(message.text());
    });
    page.on('response', response => {
      if (response.status() >= 400 && /\.(wasm|pck|m?js|css|png)(\?|$)/.test(response.url())) errors.push('Runtime asset failed');
    });
    await page.context().route('**/*', route => {
      if (new URL(route.request().url()).origin !== origin) {
        errors.push('Unexpected external request in isolated runtime');
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    await page.goto(address, { waitUntil:'load', timeout:120_000 });
    await page.waitForFunction(() => !document.getElementById('status'), null, { timeout:120_000 });
    const canvas = page.locator('#canvas');
    const geometry = async () => {
      const v = page.viewportSize();
      await page.waitForFunction(({ width, height }) => {
        const c = document.getElementById('canvas'), r = c.getBoundingClientRect();
        const portrait = width <= 600 && height > width;
        return r.width > 0 && r.height > 0 && Math.abs(c.width / c.height - r.width / r.height) < 0.0001
          && c.width >= r.width * devicePixelRatio - 0.1 && c.height >= r.height * devicePixelRatio - 0.1
          && r.x >= -0.1 && r.y >= -0.1 && r.right <= width + 0.1 && r.bottom <= height + 0.1
          && (!portrait || (Math.abs(r.width - width) < 0.1 && Math.abs(r.x) < 0.1));
      }, v, { timeout:15_000 });
      const box = await canvas.boundingBox();
      assert.ok(box.x >= -0.1 && box.y >= -0.1 && box.x + box.width <= v.width + 0.1
        && box.y + box.height <= v.height + 0.1, `${name}: entire canvas fits visible viewport`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
      assert.ok(Math.abs(await page.evaluate(() => window.visualViewport?.scale ?? 1) - 1) < 0.001);
      if (v.width <= 600 && v.height > v.width) assert.ok(Math.abs(box.width - v.width) < 0.1 && Math.abs(box.x) < 0.1);
      else assert.ok(Math.abs(box.width / box.height - 390 / 760) < 0.0001);
      return box;
    };
    await geometry();
    const capture = async (x, y, width, height) => {
      const b = await canvas.boundingBox(), scale = Math.min(b.width / 390, b.height / 760);
      captures++;
      return page.screenshot({ clip:{ x:b.x+x*scale, y:b.y+y*scale, width:width*scale, height:height*scale } });
    };
    // Only poll static regions (exclude title drift, preview cards and HUD timer).
    // A changed result must remain equal across frames for >=160ms. The generous
    // deadline is a failure ceiling, never an unconditional delay or action retry.
    async function until(read, accept, label, timeout = 15_000) {
      const deadline = performance.now() + timeout;
      do {
        const value = await read();
        if (accept(value)) return value;
        await page.evaluate(() => new Promise(requestAnimationFrame));
      } while (performance.now() < deadline);
      assert.fail(`${name}: timed out waiting for ${label}`);
    }
    async function settled(read, accept = () => true, label = 'static rendered controls') {
      let last, since = 0;
      return until(read, current => {
        if (!accept(current)) { last = undefined; return false; }
        if (!last?.equals(current)) { last = current; since = performance.now(); return false; }
        return performance.now() - since >= 160;
      }, label);
    }
    const input = async (x, y) => {
      const b = await canvas.boundingBox(), s = Math.min(b.width/390,b.height/760);
      if (touch) await page.touchscreen.tap(b.x+x*s,b.y+y*s);
      else await page.mouse.click(b.x+x*s,b.y+y*s);
    };
    const footer = () => capture(28,600,334,140);
    // The splash has no footer buttons. Require dark button pixels as well as
    // stability so an empty/loading canvas cannot pass the readiness condition.
    const hasControls = bytes => {
      const png = PNG.sync.read(bytes); let ink = 0;
      for (let i=0;i<png.data.length;i+=4) if (png.data[i]<160 && png.data[i+1]<160 && png.data[i+2]<160) ink++;
      return ink > 150;
    };
    const menuFooter = await settled(footer, hasControls, 'interactive menu footer');
    await input(102,704);
    await settled(footer, bytes => !menuFooter.equals(bytes), 'My Page');
    await input(195,238);
    await page.locator('.ql-dialog').waitFor({ state:'visible', timeout:15_000 });
    await page.getByText('공유 리더보드 서버가 아직 연결되지 않았습니다. 연결 후 이용할 수 있습니다.', { exact:true }).waitFor();
    await page.getByRole('button', { name:'닫기', exact:true }).click();
    await page.locator('.ql-dialog').waitFor({ state:'hidden' });
    // Detect the native popup's actual five-row rectangle; don't assume font metrics.
    async function popupRows() {
      const b = await canvas.boundingBox(), v = page.viewportSize();
      captures++;
      const png = PNG.sync.read(await page.screenshot()), ratio = png.width/v.width;
      const x = Math.floor((b.x+b.width*0.55)*ratio), runs = []; let start = null;
      for (let y=Math.floor((b.y+b.height*0.3)*ratio);y<Math.min(png.height,(b.y+b.height)*ratio);y++) {
        const at=(y*png.width+x)*4, [r,g,blue]=png.data.subarray(at,at+3);
        const match=r>=48 && r<=130 && Math.abs(r-g)<3 && Math.abs(r-blue)<3;
        if (match && start===null) start=y;
        if (!match && start!==null) { runs.push([start,y]); start=null; }
      }
      const run=runs.sort((a,b)=>(b[1]-b[0])-(a[1]-a[0]))[0];
      return run && (run[1]-run[0])/ratio>60 ? { top:run[0]/ratio, height:(run[1]-run[0])/ratio } : null;
    }
    await input(195,421);
    const popup = await until(popupRows, Boolean, 'visible native difficulty popup');
    const b = await canvas.boundingBox(), s = b.width/390;
    const filter = () => capture(28,405,260,32);
    const all = await filter();
    const x=b.x+100*s, y=popup.top+popup.height*1.5/5;
    if (touch) await page.touchscreen.tap(x,y); else await page.mouse.click(x,y);
    await until(popupRows, value => value===null, 'popup selection releasing pointer input');
    await settled(filter, value => !all.equals(value), 'selected difficulty label');
    const profileFooter = await settled(footer);
    await input(47,24);
    await settled(footer, value => !profileFooter.equals(value) && hasControls(value), 'Back after popup selection');
    // Reopening and dismissing exercises the other popup input-release path.
    await input(102,704);
    await settled(footer, value => !menuFooter.equals(value), 'recreated My Page');
    await input(195,421);
    await until(popupRows, Boolean, 'reopened popup');
    await input(360,320);
    await until(popupRows, value => value===null, 'outside dismissal');
    await input(47,24);
    await settled(footer, value => menuFooter.equals(value), 'menu after outside dismissal');
    // Observe each transition before sending the next action; no blind sleeps.
    let before = await footer();
    await input(195,620);
    await settled(footer, value => !before.equals(value) && hasControls(value), 'game selection');
    before = await footer();
    await input(195,700);
    await settled(footer, value => !before.equals(value) && hasControls(value), 'scoring selection');
    before = await footer();
    await input(195,700);
    await settled(footer, value => !before.equals(value) && hasControls(value), 'game controls');
    const board = () => capture(0,64,390,400);
    const initial = await settled(board);
    await input(35,105);
    const drawn = await settled(board, value => !initial.equals(value), 'stock action changes cards');
    await input(154,724);
    await settled(board, value => initial.equals(value), 'one Undo restores exact board');
    assert.ok(!initial.equals(drawn));
    if (touch) {
      // Sample short and tall reflow boundaries once, without repeating journeys.
      for (const size of [{width:320,height:568},{width:390,height:664},{width:430,height:932},viewport]) {
        await page.setViewportSize(size);
        await geometry();
      }
      await settled(board, value => initial.equals(value), 'reflow preserves cards on return');
    }
    assert.ok(configResponses>beforeConfig, 'Every journey loads disabled API config');
    assert.deepEqual(errors, [], 'No external API, JavaScript, Godot, audio or asset errors');
    console.log(JSON.stringify({case:name, seconds:Math.round(performance.now()-started)/1000,
      captures:captures-beforeCaptures, savedPNGs:0, source:deployment.source_sha}));
    await page.close(); page=undefined;
  }
} catch (error) {
  if (page) {
    await mkdir(screenshots,{recursive:true});
    await page.screenshot({path:join(screenshots,`${caseName}-failure.png`)}).catch(()=>{});
  }
  throw error;
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
}
