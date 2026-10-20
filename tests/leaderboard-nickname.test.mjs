import test from 'node:test';
import assert from 'node:assert/strict';
import { NICKNAME_PARTS, randomNickname, normalizeNickname } from '../leaderboard/index.mjs';
import { normalizeNickname as normalizeClientNickname } from '../web/leaderboard-api.mjs';

test('1,024 distinct Korean word pairs and 1,000 padded suffixes form 1,024,000 valid names', t => {
  const pools = Object.values(NICKNAME_PARTS);
  assert.deepEqual(pools.map(words => words.length), [32, 32]);
  for (const words of pools) {
    assert.equal(new Set(words).size, words.length, 'Duplicate pool entries reduce the actual name space');
    assert.ok(Object.isFrozen(words));
    for (const word of words) assert.match(word, /^[가-힣]+$/u);
  }
  const indices = [0, 0, 0];
  t.mock.method(crypto, 'getRandomValues', array => {
    assert.ok(array instanceof Uint32Array);
    assert.equal(array.length, 3);
    array.set(indices); return array;
  });
  const pairs = new Set(), suffixes = new Set();
  let shortest = Infinity, longest = 0;
  const check = () => {
    const nickname = randomNickname();
    assert.match(nickname, /^[가-힣]+ [가-힣]+[0-9]{3}$/u);
    assert.equal(normalizeNickname(nickname), nickname);
    assert.equal(normalizeClientNickname(nickname), nickname);
    const length = [...nickname].length;
    shortest = Math.min(shortest, length); longest = Math.max(longest, length);
    return nickname;
  };
  for (let a = 0; a < pools[0].length; a++) {
    for (let b = 0; b < pools[1].length; b++) {
      indices[0] = a; indices[1] = b; indices[2] = 0;
      pairs.add(check().slice(0, -3));
      indices[2] = 999; assert.ok(check().endsWith('999'));
    }
  }
  indices[0] = 0; indices[1] = 0;
  for (let number = 0; number < 1000; number++) {
    indices[2] = number;
    const suffix = check().slice(-3); suffixes.add(suffix);
    assert.equal(Number(suffix), number);
  }
  assert.equal(pairs.size, 32 * 32);
  assert.equal(suffixes.size, 1000);
  assert.equal(pairs.size * suffixes.size, 1_024_000);
  assert.deepEqual([shortest, longest], [7, 13], 'Lengths include the space and all three digits, within the existing 20-character limit');
  indices[0] = 3; indices[1] = 0; indices[2] = 42;
  assert.equal(check(), '포근한 고양이042');
  assert.ok(suffixes.has('000')); assert.ok(suffixes.has('999'));
  indices.fill(0xffffffff);
  assert.equal(check(), '느긋한 아기물범295', 'Full Uint32 values still select valid names and a three-digit suffix');
});
