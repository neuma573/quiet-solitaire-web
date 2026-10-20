import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readEntries } from '../web/leaderboard/page.mjs';
import { createLeaderboardClient } from '../web/leaderboard-api.mjs';
const payload = entries => ({ metric: 'cumulative-xp', verification: 'client-reported', entries });
const row = { rank: 1, nickname: '고요한 여우', xp: 1200 };

test('standalone page preserves descending XP, server tie order, and public fields only', () => {
  assert.deepEqual(readEntries(payload([])), []);
  assert.deepEqual(readEntries(payload([{ ...row, id: 'private', isMe: true },
    { ...row, rank: 2, nickname: '바람', xp: 1200 }, { ...row, rank: 3, xp: 20 }])), [
    { ...row, isMe: true }, { ...row, rank: 2, nickname: '바람', isMe: false }, { ...row, rank: 3, xp: 20, isMe: false },
  ]);
});

test('incompatible, incomplete, invalid or unsorted ranking responses fail closed', () => {
  for (const data of [null, {}, { ...payload([]), metric: 'score' }, { ...payload([]), verification: 'verified' },
    payload([null]), payload([{ ...row, rank: 2 }]), payload([{ ...row, rank: '1' }]),
    payload([{ ...row, xp: -1 }]), payload([{ ...row, xp: 0 }]), payload([{ ...row, xp: 1.5 }]),
    payload([{ ...row, xp: Number.MAX_SAFE_INTEGER + 1 }]), payload([{ ...row, nickname: '' }]),
    payload([{ ...row, nickname: ' '.repeat(2) }]), payload([{ ...row, nickname: 'a'.repeat(201) }]),
    payload([row, { ...row, rank: 2, xp: 1500 }]), payload(Array.from({ length: 26 }, (_, i) => ({ ...row, rank: i + 1 })))]) {
    assert.throws(() => readEntries(data));
  }
});

test('nickname text is passed as data and no extra response fields are used', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  assert.equal(readEntries(payload([{ ...row, nickname: hostile, isMe: 'yes' }]))[0].nickname, hostile);
  assert.equal(readEntries(payload([{ ...row, isMe: 'yes' }]))[0].isMe, false);
});

test('read-only board request shares existing API contract and supports cancellation', async () => {
  const controller = new AbortController(); const calls = [];
  const client = createLeaderboardClient({ apiBase: 'https://api.example/game', fetchImpl: async (url, options) => {
    calls.push({ url, options }); return Response.json(payload([row]));
  } });
  await client.board({ signal: controller.signal });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.example/game/v1/leaderboard?limit=25');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls[0].options.credentials, 'include');
  assert.equal(calls[0].options.body, undefined);
});

test('standalone imports cannot start game overlay and share the reviewed API address', async () => {
  const source = await readFile(new URL('../web/leaderboard/page.mjs', import.meta.url), 'utf8');
  assert.ok(!source.includes("from '../leaderboard.mjs'"));
  assert.ok(!/\.(session|rename|remove|startRun|finishRun)\(/.test(source));
  const config = JSON.parse(await readFile(new URL('../web/leaderboard-config.json', import.meta.url), 'utf8'));
  assert.equal(config.apiBase, 'https://solitaire-api.neuma573.com');
});

