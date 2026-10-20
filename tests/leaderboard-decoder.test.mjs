import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../leaderboard/index.mjs';

test('JSON decoding preserves BOM/Unicode handling and rejects malformed UTF-8', async () => {
  const env = { DB: {}, ALLOWED_ORIGIN: 'https://game.example', RATE_LIMIT_SALT: 'test-only-32-character-secret-value' };
  const valid = new TextEncoder().encode('{"extra":"고요한수달"}');
  for (const [bytes, error] of [
    [valid, 'invalid_fields'],
    [new Uint8Array([239, 187, 191, ...valid]), 'invalid_fields'],
    [new Uint8Array([255]), 'invalid_json'],
    [new Uint8Array([195, 40]), 'invalid_json']
  ]) {
    const response = await handle(new Request('https://api.example/v1/session', {
      method: 'POST', headers: { Origin: env.ALLOWED_ORIGIN, 'Content-Type': 'application/json' }, body: bytes
    }), env);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error });
  }
});
