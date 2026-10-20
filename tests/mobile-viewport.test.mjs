import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Run the real shell's sizing code, without starting or rebuilding Godot.
const shell = readFileSync(new URL('../web/shell.html', import.meta.url), 'utf8');
const sizing = shell.slice(shell.indexOf("    const canvas ="), shell.indexOf('    const config ='));
function fixture() {
  const canvas = { width: 390, height: 760 }, phone = { style: {} };
  const viewport = Object.assign(new EventTarget(), { width: 390, height: 664, scale: 1, offsetLeft: 0, offsetTop: 0 });
  const layout = { clientWidth: 390, clientHeight: 664 };
  const window = Object.assign(new EventTarget(), { visualViewport: viewport, devicePixelRatio: 2,
    innerWidth: 390, innerHeight: 664 });
  runInNewContext(sizing, { window, document: { documentElement: layout,
    getElementById: id => id === 'canvas' ? canvas : phone } });
  const geometry = () => ({ pixelsWide: canvas.width, pixelsHigh: canvas.height, ...phone.style });
  const visual = (values, event = 'resize') => {
    Object.assign(viewport, values); viewport.dispatchEvent(new Event(event));
  };
  return { window, layout, visual, geometry };
}

test('keyboard resize does not turn the game into a short landscape canvas', () => {
  const page = fixture(), initial = page.geometry();
  page.visual({ height: 310, offsetTop: 140 });
  page.window.dispatchEvent(new Event('resize'));
  assert.deepEqual(page.geometry(), initial);
});

test('late keyboard pan recovery cannot leave a stale canvas offset', () => {
  const page = fixture(), initial = page.geometry();
  page.visual({ height: 664, offsetTop: 140 });
  page.visual({ offsetTop: 0 }, 'scroll');
  assert.deepEqual(page.geometry(), initial);
});

test('zoom and unzoom preserve geometry; actual layout resize still fits', () => {
  const page = fixture(), initial = page.geometry();
  page.visual({ scale: 1.5, width: 260, height: 442, offsetLeft: 65, offsetTop: 110 });
  page.window.dispatchEvent(new Event('resize'));
  page.visual({ scale: 1, width: 390, height: 664, offsetLeft: 0, offsetTop: 0 });
  assert.deepEqual(page.geometry(), initial);
  Object.assign(page.layout, { clientWidth: 320, clientHeight: 568 });
  page.window.dispatchEvent(new Event('resize'));
  assert.equal(page.geometry().pixelsWide, 640);
  assert.equal(page.geometry().left, '0px');
  assert.equal(page.geometry().pixelsHigh, 1136);
  assert.equal(page.geometry().top, '0px');
});
