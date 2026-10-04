import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEntropy } from './helpers.mjs';

const PG = loadEntropy();
const E = PG.entropy;

/** Count distinct strings by brute force, for checking the closed form. */
function bruteForce(alphabetSize, length, classSizes, distinct) {
  const classOf = [];
  for (let i = 0; i < alphabetSize; i++) {
    let offset = 0;
    let found = 0;
    for (let c = 0; c < classSizes.length; c++) {
      offset += classSizes[c];
      if (i < offset) { found = 1 << c; break; }
    }
    classOf.push(found);
  }

  const fullMask = (1 << classSizes.length) - 1;
  const used = new Set();
  let good = 0;

  const walk = (position, classMask) => {
    if (position === length) {
      if (classMask === fullMask) good++;
      return;
    }
    for (let i = 0; i < alphabetSize; i++) {
      if (distinct && used.has(i)) continue;
      used.add(i);
      walk(position + 1, classMask | classOf[i]);
      used.delete(i);
    }
  };

  walk(0, 0);
  return good;
}

test('no constraints: bits are length * log2(alphabet)', () => {
  assert.equal(E.bitsForClasses({ alphabetSize: 94, classSizes: [], length: 20 }).toFixed(6), (20 * Math.log2(94)).toFixed(6));
  // A PIN is the k === 0 case: ten digits, no classes to require.
  assert.equal(E.bitsForClasses({ alphabetSize: 10, classSizes: [], length: 6 }).toFixed(6), (6 * Math.log2(10)).toFixed(6));
});

test('no repeats: bits are the falling factorial', () => {
  const bits = E.bitsForClasses({ alphabetSize: 10, classSizes: [], length: 4, distinct: true });
  const expected = Math.log2(10 * 9 * 8 * 7);
  assert.equal(bits.toFixed(9), expected.toFixed(9));

  // Asking for more distinct characters than exist is impossible, not infinite.
  const impossible = E.bitsForClasses({ alphabetSize: 4, classSizes: [], length: 9, distinct: true });
  assert.equal(impossible, 0);
});

test('required classes reduce the entropy, and match brute force', () => {
  const cases = [
    { alphabetSize: 4, classSizes: [2, 2], length: 2 },
    { alphabetSize: 4, classSizes: [2, 2], length: 3 },
    { alphabetSize: 5, classSizes: [2, 3], length: 3 },
    { alphabetSize: 6, classSizes: [2, 2, 2], length: 4 },
    { alphabetSize: 6, classSizes: [3, 3], length: 2 },
    { alphabetSize: 4, classSizes: [1, 3], length: 3 },
  ];

  for (const spec of cases) {
    const exact = bruteForce(spec.alphabetSize, spec.length, spec.classSizes, false);
    const bits = E.bitsForClasses(spec);
    assert.equal(bits.toFixed(9), Math.log2(exact).toFixed(9), JSON.stringify(spec) + ' -> ' + exact);
    assert.ok(bits < spec.length * Math.log2(spec.alphabetSize), 'a constraint cannot add entropy');
  }
});

test('required classes with no repeats match brute force', () => {
  const cases = [
    { alphabetSize: 4, classSizes: [2, 2], length: 2 },
    { alphabetSize: 4, classSizes: [2, 2], length: 3 },
    { alphabetSize: 5, classSizes: [2, 3], length: 4 },
  ];

  for (const spec of cases) {
    const exact = bruteForce(spec.alphabetSize, spec.length, spec.classSizes, true);
    const bits = E.bitsForClasses({ ...spec, distinct: true });
    assert.equal(bits.toFixed(9), Math.log2(exact).toFixed(9), JSON.stringify(spec) + ' -> ' + exact);
  }
});

test('a single required class costs nothing', () => {
  const free = E.bitsForClasses({ alphabetSize: 20, classSizes: [], length: 8 });
  const oneClass = E.bitsForClasses({ alphabetSize: 20, classSizes: [20], length: 8 });
  assert.equal(free.toFixed(9), oneClass.toFixed(9));
});

test('the constraint gets cheaper as the password gets longer', () => {
  const shortLength = E.bitsForClasses({ alphabetSize: 90, classSizes: [26, 26, 10, 28], length: 8 });
  const longLength = E.bitsForClasses({ alphabetSize: 90, classSizes: [26, 26, 10, 28], length: 40 });
  const naiveShort = 8 * Math.log2(90);
  const naiveLong = 40 * Math.log2(90);
  assert.ok(naiveShort - shortLength > naiveLong - longLength, 'the penalty should shrink with length');
});

test('a realistic maximum password is stable and finite', () => {
  const bits = E.bitsForClasses({ alphabetSize: 90, classSizes: [26, 26, 10, 28], length: 128 });
  assert.ok(Number.isFinite(bits), 'bits must not be NaN or Infinity');
  assert.ok(bits > 120 && bits < 128 * Math.log2(90), 'unexpected range: ' + bits);
});

test('passphrase entropy is words * log2(wordlist)', () => {
  assert.equal(E.bitsForPassphrase(6, 7776).toFixed(6), (6 * Math.log2(7776)).toFixed(6));
  assert.ok(Math.abs(E.bitsForPassphrase(6, 7776) - 77.5) < 0.5);
});

test('crack times grow with the bit count and are ordered', () => {
  const rows = E.crackTimeRows(80);
  assert.equal(rows.length, 3);
  const logSeconds = rows.map((row) => E.log10SecondsToCrack(80, row.guessesPerSecond));
  assert.ok(logSeconds[0] > logSeconds[1], 'online should outlast offline slow-hash');
  assert.ok(logSeconds[1] > logSeconds[2], 'offline fast-hash should be the fastest to crack');
  assert.ok(rows.every((row) => typeof row.seconds === 'string' && row.seconds.length > 0));
});

test('a weak password reads as weak in every unit', () => {
  assert.match(E.formatDurationFromLog10(E.log10SecondsToCrack(20, 1e11)), /^(instantly|under)/);
  assert.match(E.formatDurationFromLog10(E.log10SecondsToCrack(40, 1e11)), /second|minute|hour/);
  assert.equal(E.formatDurationFromLog10(-5), 'instantly');
  assert.equal(E.formatDurationFromLog10(Infinity), 'forever');
});

test('durations are readable at every scale', () => {
  // From a number of seconds, which is what a caller has; the crack-time rows go
  // straight to the log form because their input is already log10.
  const fromSeconds = (seconds) => E.formatDurationFromLog10(Math.log10(seconds));

  assert.equal(fromSeconds(30), '30 seconds');
  assert.equal(fromSeconds(60), '1 minute');
  assert.equal(fromSeconds(3600), '1 hour');
  assert.equal(fromSeconds(86400), '1 day');
  assert.equal(fromSeconds(31557600), '1 year');
  assert.match(fromSeconds(1e17 * 50), /age of the universe/);
  assert.match(fromSeconds(1e40), /10\^/);
});

test('strength tiers are monotonic', () => {
  const levels = [0, 20, 30, 45, 70, 80, 128].map((bits) => E.tier(bits).level);
  for (let i = 1; i < levels.length; i++) {
    assert.ok(levels[i] >= levels[i - 1], 'tier went down at index ' + i);
  }
  assert.equal(E.tier(10).level, 0);
  assert.equal(E.tier(128).level, 5);
});

test('degenerate inputs do not produce NaN', () => {
  assert.equal(E.bitsForClasses({ alphabetSize: 0, classSizes: [], length: 5 }), 0);
  assert.equal(E.bitsForClasses({ alphabetSize: 10, classSizes: [], length: 0 }), 0);
  assert.ok(Number.isFinite(E.bitsForClasses({ alphabetSize: 2, classSizes: [1, 1], length: 1 })));
  assert.throws(() => E.bitsForClasses({ alphabetSize: 10, classSizes: new Array(13).fill(1), length: 4 }), RangeError);
});
