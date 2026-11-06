import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = path => readFile(new URL(`../web/${path}`, import.meta.url), 'utf8');

test('support and privacy are readable static pages with the approved contact', async () => {
  for (const name of ['support', 'privacy']) {
    const html = await source(`${name}/index.html`);
    assert.match(html, /<html lang="ko">/);
    assert.match(html, /<meta name="viewport"/);
    assert.match(html, /href="\s*\.\.\/information\.css"/);
    assert.match(html, /href="mailto:neuma573@gmail\.com"/);
    assert.match(html, /id="ko" lang="ko"/);
    assert.match(html, /id="en" lang="en"/);
    assert.match(html, /href="#main"/);
    assert.doesNotMatch(html, /<(script|iframe|form|canvas)\b/i);
    assert.doesNotMatch(html, /\bon\w+\s*=/i);
    assert.doesNotMatch(html, /(?:src|href)="(?:https?:)?\/\/[^\"]+\.(?:css|js|mjs|woff2?)/i);
  }
});

test('published privacy policy keeps iOS scope, approved operator and retention explicit', async () => {
  const html = await source('privacy/index.html');
  assert.match(html, /<time datetime="2026-11-06">/);
  assert.match(html, /Effective and last updated: November 6, 2026/);
  assert.doesNotMatch(html, /초안|Draft for review|data-policy-effective-date="pending"|noindex|review-note/);
  assert.match(html, /<strong lang="ko">나호진<\/strong>/);
  assert.match(html, /문의 처리 완료일부터 1년간 보관한 뒤 삭제합니다/);
  assert.match(html, /one year after the inquiry is resolved, then deleted/);

  assert.match(html, /experimental web game and shared leaderboard/);
  assert.match(html, /does not submit scores, XP or achievements to Game Center/);
  assert.match(html, /https:\/\/www\.apple\.com\/legal\/privacy\/data\/en\/game-center\//);
  assert.doesNotMatch(html, /we (?:do not|never) collect any data/i);
  assert.doesNotMatch(html, /github\.com\/neuma573\/quiet-solitaire\//);
});

test('support distinguishes web server deletion from cookie clearing and device data', async () => {
  const html = await source('support/index.html');
  assert.doesNotMatch(html, /초안|Draft support|not yet an effective policy|noindex/);
  assert.match(html, /Clearing cookies alone can leave the server records in place/);
  assert.match(html, /It does not erase device game data or local statistics/);
  assert.match(html, /Restoring an in-progress board and undo history after restarting the app is not currently supported/);
  assert.match(html, /href="\.\.\/privacy\/#en"/);
});
