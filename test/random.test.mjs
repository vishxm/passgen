import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRandom } from './helpers.mjs';

const PG = loadRandom();
const { randomInt, sampleDistinct, sampleWithReplacement, pick } = PG.random;

test('randomInt stays inside [0, n)', () => {
  for (const n of [1, 2, 3, 7, 10, 26, 62, 90, 94, 255, 256, 257, 1000, 65536, 65537, 100000]) {
    for (let i = 0; i < 200; i++) {
      const value = randomInt(n);
      assert.ok(Number.isInteger(value), `randomInt(${n}) returned ${value}`);
      assert.ok(value >= 0 && value < n, `randomInt(${n}) returned ${value}`);
    }
  }
});

test('randomInt reaches every value of a non-power-of-two range', () => {
  // The classic failure of `byte % 7` is that 0..3 come up twice as often as
  // 4..6. Check the extremes are all still reachable.
  const seen = new Set();
  for (let i = 0; i < 5000; i++) seen.add(randomInt(7));
  assert.equal(seen.size, 7);
});

test('randomInt is uniform within a small tolerance', () => {
  const n = 7;
  const draws = 700000;
  const counts = new Array(n).fill(0);
  for (let i = 0; i < draws; i++) counts[randomInt(n)]++;

  const expected = draws / n;
  const chi2 = counts.reduce((total, observed) => total + (observed - expected) ** 2 / expected, 0);
  // chi-square with 6 degrees of freedom; 22.5 is the p=0.001 threshold.
  assert.ok(chi2 < 22.5, `chi-square ${chi2.toFixed(2)} suggests the distribution is skewed`);
});

test('randomInt handles the whole documented range', () => {
  assert.equal(randomInt(1), 0);
  assert.ok([0, 1].includes(randomInt(2)));
  assert.ok(randomInt(4294967295) >= 0);
  assert.throws(() => randomInt(0), RangeError);
  assert.throws(() => randomInt(-1), RangeError);
  assert.throws(() => randomInt(1.5), RangeError);
  assert.throws(() => randomInt(4294967296), RangeError);
  assert.throws(() => randomInt('7'), RangeError);
});

// sampleDistinct over the whole list *is* a Fisher-Yates shuffle -- partial
// Fisher-Yates degenerates to the full one at length n. random.js used to also
// export a shuffle() that nothing in src/ called; these are its tests, moved onto
// the function the page actually draws from.
test('a full-length sample preserves the multiset', () => {
  const input = Array.from({ length: 200 }, (_, i) => i % 17);
  const output = sampleDistinct(input, input.length);

  assert.notEqual(output.join(','), input.join(','), 'a shuffle that changes nothing is suspicious');
  assert.deepEqual(output.slice().sort((a, b) => a - b), input.slice().sort((a, b) => a - b));

  const tally = (items) => items.reduce((acc, item) => {
    acc[item] = (acc[item] || 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(tally(output), tally(input));
});

test('a full-length sample actually reorders', () => {
  const input = Array.from({ length: 50 }, (_, i) => i);
  const moved = sampleDistinct(input, input.length).filter((value, index) => value !== index).length;
  assert.ok(moved > 40, `only ${moved} of 50 elements moved`);
});

test('sampleDistinct returns distinct elements in range', () => {
  const alphabet = Array.from({ length: 30 }, (_, i) => String.fromCharCode(97 + i));
  for (let i = 0; i < 500; i++) {
    const picked = sampleDistinct(alphabet, 12);
    assert.equal(picked.length, 12);
    assert.equal(new Set(picked).size, 12);
    for (const value of picked) assert.ok(alphabet.includes(value));
  }
  assert.throws(() => sampleDistinct(alphabet, 31), RangeError);
});

test('sampleWithReplacement can repeat and hits the whole alphabet', () => {
  const alphabet = ['a', 'b', 'c'];
  const seen = new Set();
  let repeats = 0;
  for (let i = 0; i < 300; i++) {
    const picked = sampleWithReplacement(alphabet, 10);
    assert.equal(picked.length, 10);
    if (new Set(picked).size < 10) repeats++;
    picked.forEach((value) => seen.add(value));
  }
  assert.equal(seen.size, 3);
  assert.ok(repeats > 0, 'repeats should be possible when sampling with replacement');
});

test('sampleDistinct covers the alphabet over many draws', () => {
  const alphabet = ['a', 'b', 'c', 'd'];
  const seen = new Set();
  for (let i = 0; i < 200; i++) sampleDistinct(alphabet, 4).forEach((v) => seen.add(v));
  assert.equal(seen.size, 4);
});

test('pick returns a member of the list', () => {
  const list = ['x', 'y', 'z'];
  for (let i = 0; i < 100; i++) assert.ok(list.includes(pick(list)));
});
