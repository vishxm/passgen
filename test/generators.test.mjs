import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCore, loadPG } from './helpers.mjs';

const PG = loadCore();
const G = PG.generators;
const E = PG.entropy;

const DEFAULTS = {
  length: 20,
  useLower: true,
  useUpper: true,
  useDigits: true,
  useSymbols: true,
  requireEach: true,
};

const opts = (overrides) => ({ ...DEFAULTS, ...overrides });

// ------------------------------------------------------------------ alphabet

test('the default alphabet is 26 + 26 + 10 + 28', () => {
  const built = G.buildAlphabet(opts());
  assert.equal(built.size, 90);
  assert.deepEqual(built.classes.map((c) => c.key), ['lower', 'upper', 'digits', 'symbols']);
  assert.deepEqual(built.classes.map((c) => c.chars.length), [26, 26, 10, 28]);
});

test('the symbol set has no quotes, backslashes, whitespace or duplicates', () => {
  const symbols = G.CHARSETS.symbols;
  for (const forbidden of ['"', "'", '`', '\\', ' ', '\n', '\t', '\r']) {
    assert.ok(!symbols.includes(forbidden), 'symbols should not contain ' + JSON.stringify(forbidden));
  }
  assert.equal(new Set(symbols).size, symbols.length, 'symbols must be unique');
  assert.equal(symbols.length, 28);
});

test('dropping look-alikes removes exactly those characters', () => {
  const built = G.buildAlphabet(opts({ excludeAmbiguous: true }));
  assert.equal(built.size, 90 - '0OoIl1|'.length - 0);
  for (const ch of G.AMBIGUOUS) {
    assert.ok(!built.flat.includes(ch), ch + ' should have been removed');
  }
  assert.deepEqual(built.removed.sort(), Array.from(G.AMBIGUOUS).sort());
});

test('the exclude field removes characters from every class', () => {
  const built = G.buildAlphabet(opts({ exclude: 'aeiouAEIOU' }));
  assert.equal(built.size, 90 - 10);
  assert.ok(!built.flat.some((c) => 'aeiouAEIOU'.includes(c)));
});

test('excluding everything useful produces an empty alphabet and a clear error', () => {
  const built = G.buildAlphabet(opts({ exclude: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' + G.CHARSETS.symbols }));
  assert.equal(built.size, 0);
  assert.throws(() => G.generatePassword(opts({
    exclude: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' + G.CHARSETS.symbols,
  })), /character type came out empty/);
});

test('an empty selection is refused rather than producing nothing', () => {
  assert.throws(() => G.generatePassword(opts({ useLower: false, useUpper: false, useDigits: false, useSymbols: false })), /came out empty/);
});

test('a class can be emptied by the exclude field without breaking the rest', () => {
  const built = G.buildAlphabet(opts({ exclude: '0123456789' }));
  assert.deepEqual(built.classes.map((c) => c.key), ['lower', 'upper', 'symbols']);
  const result = G.generatePassword(opts({ exclude: '0123456789' }));
  assert.ok(!/[0-9]/.test(result.value));
});

test('a custom symbol set replaces the built-in one', () => {
  const built = G.buildAlphabet(opts({ symbolsOverride: '-_.' }));
  const symbols = built.classes.find((c) => c.key === 'symbols');
  assert.equal(symbols.chars.length, 3);
  assert.deepEqual(symbols.chars, ['-', '_', '.']);
  assert.equal(built.size, 65);
});

// ------------------------------------------------------------------ password

test('a password has the requested length and alphabet', () => {
  for (let i = 0; i < 300; i++) {
    const result = G.generatePassword(opts({ length: 24 }));
    assert.equal(result.value.length, 24);
    assert.equal(result.kind, 'password');
    for (const ch of result.value) {
      assert.ok(G.buildAlphabet(opts()).flat.includes(ch), 'unexpected character ' + ch);
    }
  }
});

test('length is clamped to the documented bounds', () => {
  const letters = opts({ useUpper: false, useDigits: false, useSymbols: false });
  assert.equal(G.generatePassword({ ...letters, length: 1 }).value.length, 1);
  assert.equal(G.generatePassword({ ...letters, length: 9999 }).value.length, G.LIMITS.password.max);
  assert.equal(G.generatePassword({ ...letters, length: 'nonsense' }).value.length, G.LIMITS.password.default);
  assert.equal(G.generatePassword({ ...letters, length: 20.6 }).value.length, 21);
});

test('"one of each type" always holds, over many draws', () => {
  const built = G.buildAlphabet(opts());
  for (let i = 0; i < 2000; i++) {
    const result = G.generatePassword(opts({ length: 8 }));
    for (const cls of built.classes) {
      assert.ok(
        result.value.split('').some((ch) => cls.chars.includes(ch)),
        'no ' + cls.key + ' in ' + result.value
      );
    }
  }
});

test('characters are drawn uniformly from the whole alphabet', () => {
  // Chi-square over the first character of 40,000 real passwords, exercising the
  // same code path the page uses rather than the RNG in isolation. The one-of-
  // each guarantee is off here: with it on and length 4 the first character is
  // *supposed* to favour the larger classes.
  const draws = 40000;
  const built = G.buildAlphabet(opts());
  const counts = new Map(built.flat.map((ch) => [ch, 0]));

  for (let i = 0; i < draws; i++) {
    const value = G.generatePassword(opts({ length: 4, requireEach: false })).value;
    counts.set(value[0], counts.get(value[0]) + 1);
  }

  const expected = draws / built.size;
  let chi2 = 0;
  for (const observed of counts.values()) {
    chi2 += (observed - expected) ** 2 / expected;
  }
  // 89 degrees of freedom; anything under 148 is unremarkable at p=0.001.
  assert.ok(chi2 < 148, 'chi-square ' + chi2.toFixed(1) + ' suggests a skewed alphabet');
  assert.ok(built.flat.every((ch) => counts.get(ch) > 0), 'some characters never appeared');
});

test('with one-of-each on, every class appears exactly once per password', () => {
  // At length 4 with four types required, every valid password holds precisely
  // one character from each class. That is a far smaller space than 90^4, and
  // the entropy readout has to reflect it.
  const draws = 20000;
  const built = G.buildAlphabet(opts());
  const perChar = new Map(built.flat.map((ch) => [ch, 0]));
  const firstChar = new Map(built.flat.map((ch) => [ch, 0]));

  for (let i = 0; i < draws; i++) {
    const value = G.generatePassword(opts({ length: 4 })).value;
    for (const ch of value) perChar.set(ch, perChar.get(ch) + 1);
    firstChar.set(value[0], firstChar.get(value[0]) + 1);
  }

  for (const cls of built.classes) {
    const occurrences = cls.chars.reduce((sum, ch) => sum + perChar.get(ch), 0);
    assert.equal(occurrences, draws, cls.key + ' should appear once in every password');
  }

  // Within a class the characters are still uniform. Checked as one chi-square
  // over all 90 characters rather than 90 separate tolerances, which would trip
  // on ordinary sampling noise roughly three times per run.
  let chi2 = 0;
  for (const cls of built.classes) {
    const perCharExpected = draws / cls.chars.length;
    for (const ch of cls.chars) {
      chi2 += (perChar.get(ch) - perCharExpected) ** 2 / perCharExpected;
    }
  }
  assert.ok(chi2 < 148, 'chi-square ' + chi2.toFixed(1) + ' over 89 degrees of freedom suggests a skewed class');

  // The valid set is closed under permuting positions, so no position is
  // special: each class leads exactly a quarter of the time, even though the
  // classes are very different sizes.
  for (const cls of built.classes) {
    const observed = cls.chars.reduce((sum, ch) => sum + firstChar.get(ch), 0) / draws;
    assert.ok(Math.abs(observed - 0.25) < 0.01, cls.key + ' led ' + observed + ' of the time, expected 0.25');
  }

  // With room to spare the constraint costs progressively less.
  const tight = E.bitsForClasses({ alphabetSize: 90, classSizes: [26, 26, 10, 28], length: 4 });
  const loose = E.bitsForClasses({ alphabetSize: 90, classSizes: [26, 26, 10, 28], length: 40 });
  assert.ok(tight < 4 * Math.log2(90), 'the constraint must cost entropy');
  assert.ok(tight > 20, 'but there are still plenty of valid passwords: ' + tight);
  assert.ok(40 * Math.log2(90) - loose < 4 * Math.log2(90) - tight, 'the penalty should shrink with length');
});

test('every character type shows up without the guarantee', () => {
  const built = G.buildAlphabet(opts());
  for (const cls of built.classes) {
    let seen = false;
    for (let i = 0; i < 200 && !seen; i++) {
      const value = G.generatePassword(opts({ length: 20, requireEach: false })).value;
      seen = cls.chars.some((ch) => value.includes(ch));
    }
    assert.ok(seen, 'never saw a ' + cls.key + ' character in 200 draws');
  }
});

test('too few characters for the guarantee is refused with an explanation', () => {
  // Four types are enabled, so three characters cannot hold one of each.
  assert.throws(() => G.generatePassword(opts({ length: 3 })), /needs a length of at least 4/);
  assert.throws(() => G.generatePassword(opts({ length: 2, useSymbols: false })), /needs a length of at least 3/);
});

test('the tightest workable configuration still generates', () => {
  const result = G.generatePassword(opts({ length: 4 }));
  assert.equal(result.value.length, 4);
  assert.match(result.value, /[a-z]/);
  assert.match(result.value, /[A-Z]/);
  assert.match(result.value, /[0-9]/);
});

test('no repeats gives distinct characters only', () => {
  for (let i = 0; i < 200; i++) {
    const result = G.generatePassword(opts({ length: 20, noRepeat: true }));
    assert.equal(new Set(result.value.split('')).size, 20);
  }
});

test('no repeats beyond the alphabet size is refused', () => {
  assert.throws(() => G.generatePassword(opts({ length: 100, noRepeat: true })), /at most 90 characters/);
  assert.throws(() => G.generatePassword(opts({ length: 100, noRepeat: true, excludeAmbiguous: true })), /at most 83 characters/);
});

test('no repeats together with one-of-each still satisfies both', () => {
  for (let i = 0; i < 300; i++) {
    const result = G.generatePassword(opts({ length: 10, noRepeat: true, requireEach: true }));
    assert.equal(new Set(result.value.split('')).size, 10);
    assert.match(result.value, /[a-z]/);
    assert.match(result.value, /[A-Z]/);
    assert.match(result.value, /[0-9]/);
    assert.match(result.value, /[^a-zA-Z0-9]/);
  }
});

test('passwords differ from one another', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(G.generatePassword(opts({ length: 16 })).value);
  assert.equal(seen.size, 500, 'repeated passwords in 500 draws');
});

test('the reported alphabet size matches the characters actually produced', () => {
  const result = G.generatePassword(opts({ length: 30 }));
  const used = new Set(result.value.split(''));
  for (const ch of used) {
    assert.ok(result.alphabet.flat.includes(ch), ch + ' is not in the alphabet');
  }
  assert.equal(result.spec.alphabetSize, result.alphabet.size);
});

// ------------------------------------------------------------------ pin

test('a PIN is digits only', () => {
  for (let i = 0; i < 200; i++) {
    const result = G.generatePin({ length: 6 });
    assert.match(result.value, /^[0-9]{6}$/);
    assert.equal(result.spec.alphabetSize, 10);
  }
});

test('PIN length is clamped to 4..12', () => {
  assert.equal(G.generatePin({ length: 1 }).value.length, 4);
  assert.equal(G.generatePin({ length: 50 }).value.length, 12);
});

test('a no-repeat PIN has no repeated digits', () => {
  for (let i = 0; i < 200; i++) {
    const value = G.generatePin({ length: 10, noRepeat: true }).value;
    assert.equal(new Set(value.split('')).size, 10);
  }
  assert.throws(() => G.generatePin({ length: 11, noRepeat: true }), /at most 10 digits/);
});

test('PIN entropy matches 10^length', () => {
  // Routed the way app.js routes it: the generator's own spec handed to
  // bitsForClasses, not a separate convenience function that nothing called.
  const result = G.generatePin({ length: 6, noRepeat: false });
  assert.equal(result.spec.classSizes.length, 0, 'a PIN has no classes to require');
  assert.equal(E.bitsForClasses(result.spec).toFixed(6), (6 * Math.log2(10)).toFixed(6));
  assert.ok(E.bitsForClasses(result.spec) < 20);
});

// ------------------------------------------------------------------ custom

test('a custom alphabet is de-duplicated', () => {
  const result = G.generateCustom({ alphabet: 'aabbccdd', length: 8 });
  assert.equal(result.spec.alphabetSize, 4);
  assert.match(result.value, /^[abcd]{8}$/);
});

test('a custom alphabet can be non-ASCII', () => {
  const result = G.generateCustom({ alphabet: 'αβγ漢字🙂', length: 6 });
  assert.equal(Array.from(result.value).length, 6);
  for (const ch of result.value) assert.ok(Array.from('αβγ漢字🙂').includes(ch));
});

test('an empty or whitespace-only custom alphabet is refused', () => {
  assert.throws(() => G.generateCustom({ alphabet: '', length: 10 }), /at least one character/);
  assert.throws(() => G.generateCustom({ alphabet: '   ', length: 10 }), /nothing but whitespace/);
  assert.throws(() => G.generateCustom({ alphabet: '\t\n ', length: 10 }), /nothing but whitespace/);
  // A space is fine as long as something else is in there too.
  assert.ok(G.generateCustom({ alphabet: 'ab c', length: 6 }).value.length === 6);
});

test('custom mode honours the exclude field and no-repeat', () => {
  const filtered = G.generateCustom({ alphabet: 'abcdefg', exclude: 'a', length: 5 });
  assert.ok(!filtered.value.includes('a'));

  const distinct = G.generateCustom({ alphabet: 'abcd', length: 4, noRepeat: true });
  assert.equal(new Set(distinct.value.split('')).size, 4);
  assert.throws(() => G.generateCustom({ alphabet: 'abc', length: 4, noRepeat: true }), /at most 3/);
});

// ------------------------------------------------------------------ passphrase

test('a passphrase has the requested number of words', () => {
  const result = G.generatePassphrase({ words: 6 }, PG.WORDLIST);
  assert.equal(result.words.length, 6);
  assert.equal(result.value.split('-').length, 6);
  assert.equal(result.kind, 'passphrase');
});

test('every word comes from the list', () => {
  const result = G.generatePassphrase({ words: 12 }, PG.WORDLIST);
  for (const word of result.words) {
    assert.ok(PG.WORDLIST.includes(word.toLowerCase()), word + ' is not in the word list');
  }
});

test('separators are honoured', () => {
  assert.equal(G.generatePassphrase({ words: 4, separator: 'dot' }, PG.WORDLIST).value.split('.').length, 4);
  assert.equal(G.generatePassphrase({ words: 4, separator: 'space' }, PG.WORDLIST).value.split(' ').length, 4);
  assert.equal(G.generatePassphrase({ words: 4, separator: 'none' }, PG.WORDLIST).words.length, 4);
  assert.ok(!G.generatePassphrase({ words: 4, separator: 'none' }, PG.WORDLIST).value.includes('-'));
});

test('words are joined exactly as the segments describe', () => {
  const result = G.generatePassphrase({ words: 5, separator: 'underscore', appendDigit: true }, PG.WORDLIST);
  const rebuilt = result.segments.map((s) => s.text).join('');
  assert.equal(rebuilt, result.value);
  assert.match(result.value, /[0-9]$/);
  assert.equal(result.spec.extraBits, Math.log2(10));
});

test('random capitalisation flips some words and adds one bit each', () => {
  const result = G.generatePassphrase({ words: 12, capitalize: true }, PG.WORDLIST);
  const capitalised = result.words.filter((w) => /^[A-Z]/.test(w)).length;
  assert.ok(capitalised > 0, 'no words were capitalised in 12 tries');
  assert.ok(capitalised < 12, 'every word was capitalised, which is not a fair coin');
});

test('passphrase entropy is words * log2(7776)', () => {
  const result = G.generatePassphrase({ words: 6 }, PG.WORDLIST);
  assert.equal(result.spec.wordlistSize, 7776);
  const expected = 6 * Math.log2(7776);
  assert.ok(Math.abs(E.bitsForPassphrase(result.spec.words, result.spec.wordlistSize) - expected) < 1e-9);
});

test('a missing word list is refused rather than silently producing nothing', () => {
  assert.throws(() => G.generatePassphrase({ words: 6 }, []), /word list failed to load/);
  assert.throws(() => G.generatePassphrase({ words: 6 }, null), /word list failed to load/);
});

test('passphrase word count is clamped to 3..12', () => {
  assert.equal(G.generatePassphrase({ words: 1 }, PG.WORDLIST).words.length, 3);
  assert.equal(G.generatePassphrase({ words: 99 }, PG.WORDLIST).words.length, 12);
});

// ------------------------------------------------------------------ wordlist

test('the embedded word list is the EFF long list', () => {
  assert.equal(PG.WORDLIST.length, 7776);
  assert.equal(new Set(PG.WORDLIST).size, 7776);
  assert.equal(PG.WORDLIST[0], 'abacus');
  assert.equal(PG.WORDLIST[PG.WORDLIST.length - 1], 'zoom');
  assert.equal(PG.WORDLIST_SOURCE.license, 'CC BY 3.0');
});

test('word list entries are plain lowercase ASCII', () => {
  for (const word of PG.WORDLIST) {
    assert.match(word, /^[a-z][a-z-]*$/, word + ' is not a plain word');
  }
});

// ------------------------------------------------------------------ errors

/**
 * The generators loaded against a pinned draw, so every choice comes back index
 * 0. Used only for the one error whose reachability is a matter of probability.
 */
function stubbed() {
  return loadPG(
    ['lib/random.js', 'lib/entropy.js', 'lib/generators.js'],
    { getRandomValues: (buffer) => buffer.fill(0) },
  ).generators;
}

/**
 * Every sentence a generator can put on screen, paired with the input that
 * produces it.
 *
 * The point is reachability from the controls. An error message no combination
 * of tickboxes and text fields can produce is dead prose; a message that is
 * produced by the wrong input reads as a wrong diagnosis. The page shows these
 * strings verbatim in #secret-error, so the set here and the throw sites in
 * src/lib/generators.js are meant to be checked against each other by eye when
 * either changes.
 */
const REACHABLE_ERRORS = [
  [
    'Every character type came out empty',
    () => G.generatePassword({ ...DEFAULTS, useLower: false, useUpper: false, useDigits: false, useSymbols: false }),
  ],
  [
    'Every character type came out empty',
    // Every type ticked but every character excluded: same refusal, reached
    // through the exclude field rather than by unticking the boxes.
    () => G.generatePassword({ ...DEFAULTS, exclude: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_{|}~' }),
  ],
  [
    'No repeats needs at most',
    // 40 fits inside the 90-character alphabet, so this has to be past it.
    () => G.generatePassword({ ...DEFAULTS, length: 100, noRepeat: true, requireEach: false }),
  ],
  [
    'Requiring one of each',
    () => G.generatePassword({ ...DEFAULTS, length: 2, requireEach: true }),
  ],
  [
    'These settings leave too few valid passwords',
    // The sampler draws uniformly over the whole alphabet and rejects anything
    // that misses a required class. With one character in three of the four
    // classes and a long fourth, that is almost always a rejection -- but only
    // *almost*, so this one is driven with a pinned draw below rather than left
    // to chance.
    () => stubbed().generatePassword({
      length: 4,
      useLower: true, useUpper: true, useDigits: true, useSymbols: true,
      symbolsOverride: '0123456789abcdefghijklmnopqrstuv',
      exclude: 'bcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
      excludeAmbiguous: false, noRepeat: false, requireEach: true,
    }),
  ],
  [
    'word list failed to load',
    () => G.generatePassphrase({ words: 6 }, []),
  ],
  [
    'at most 10 digits',
    () => G.generatePin({ length: 11, noRepeat: true }),
  ],
  [
    'Type at least one character',
    () => G.generateCustom({ alphabet: '', length: 8 }),
  ],
  [
    'nothing but whitespace',
    () => G.generateCustom({ alphabet: ' \t\n ', length: 8 }),
  ],
  [
    'unique characters; keep it under',
    () => G.generateCustom({ alphabet: Array.from({ length: 4097 }, (_, i) => String.fromCodePoint(0x400 + i)).join(''), length: 8 }),
  ],
  [
    'No repeats needs at most',
    () => G.generateCustom({ alphabet: 'abc', length: 5, noRepeat: true }),
  ],
];

test('every error message is reachable from some input', () => {
  for (const [fragment, run] of REACHABLE_ERRORS) {
    assert.throws(run, (err) => {
      assert.equal(err.userFacing, true, fragment + ' should be marked user-facing');
      assert.match(err.message, new RegExp(fragment), 'wrong message for: ' + fragment);
      return true;
    });
  }
});

test('every error message is a sentence a person can act on', () => {
  for (const [fragment, run] of REACHABLE_ERRORS) {
    let message = '';
    try {
      run();
    } catch (err) {
      message = err.message;
    }
    assert.notEqual(message, '', fragment + ' did not throw');
    assert.match(message, /[.?]$/, fragment + ' should end in punctuation');
    assert.ok(message.length > 20, fragment + ' is too terse to act on: ' + message);
  }
});
