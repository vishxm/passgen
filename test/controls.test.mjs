/*
 * controls.test.mjs -- the rules src/app.js applies to its own controls.
 *
 * These are the decisions that used to live inline in app.js, where nothing
 * could reach them: the build tests could confirm the element ids exist, but
 * not that a preset writes the length it advertises or that a narrowed slider
 * cannot silently eat the next one. They are pure functions over an options
 * object, so they need no document.
 *
 * The painting half of app.js -- paintSecret, paintMeter, paintChannels,
 * paintPolicy -- is deliberately not here. It is mechanical, and a fake DOM
 * elaborate enough to satisfy it would be a second implementation of the
 * browser, which is not worth maintaining in a project with no dependencies.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadControls } from './helpers.mjs';

const PG = loadControls();
const C = PG.controls;
const G = PG.generators;
const LIMITS = G.LIMITS;

/** The options the page would read for password mode, with everything on. */
function allClasses(overrides = {}) {
  return {
    length: 20,
    useLower: true,
    useUpper: true,
    useDigits: true,
    useSymbols: true,
    symbolsOverride: '',
    exclude: '',
    excludeAmbiguous: false,
    noRepeat: false,
    requireEach: true,
    ...overrides,
  };
}

/** `count` characters that appear in none of the built-in classes. */
function exoticAlphabet(count) {
  return Array.from({ length: count }, (_, i) => String.fromCodePoint(0x400 + i)).join('');
}

// ------------------------------------------------------------------ ceilings

test('the length ceiling is the alphabet, so "no repeats" is always reachable', () => {
  // Every class on: 26 lower + 26 upper + 10 digits + 28 symbols = 90.
  const expected = G.CHARSETS.lower.length + G.CHARSETS.upper.length +
    G.CHARSETS.digits.length + G.CHARSETS.symbols.length;
  assert.equal(expected, 90);
  assert.equal(C.lengthCeiling('password', allClasses()).max, expected);
  assert.equal(C.lengthCeiling('password', allClasses()).range, 'length');
  assert.equal(C.lengthCeiling('password', allClasses()).number, 'length-number');
});

test('unticking a type shrinks the ceiling to what is left', () => {
  const digitsOnly = allClasses({ useLower: false, useUpper: false, useSymbols: false });
  assert.equal(C.lengthCeiling('password', digitsOnly).max, 10);
});

test('the ceiling never exceeds the library limit, whatever the alphabet', () => {
  // A 200-character custom symbol set takes the alphabet to 290, past the 128
  // the slider will allow. The ceiling has to stop there, or the control offers a
  // length the generator will clamp behind its back.
  const huge = allClasses({ symbolsOverride: exoticAlphabet(200) });
  assert.equal(C.lengthCeiling('password', huge).max, LIMITS.password.max);
});

test('the ceiling never drops below the slider minimum of 4', () => {
  // One class, and one character of it after exclusions: the slider still offers
  // 4, and the generator is what refuses. Lowering the slider to 1 would let the
  // control offer a length its own limits call invalid.
  const almostEmpty = allClasses({
    useUpper: false,
    useDigits: false,
    useSymbols: false,
    exclude: 'abcdefghijklmnopqrstuvwxy',
  });
  const ceiling = C.lengthCeiling('password', almostEmpty);
  assert.equal(ceiling.max, 4);
});

test('the ceiling applies whether or not "no repeats" is ticked', () => {
  assert.equal(
    C.lengthCeiling('password', allClasses({ noRepeat: false })).max,
    C.lengthCeiling('password', allClasses({ noRepeat: true })).max,
  );
});

test('custom mode has no ceiling until something is typed', () => {
  assert.equal(C.lengthCeiling('custom', { alphabet: '', length: 20 }), null);
  assert.equal(C.lengthCeiling('custom', { alphabet: null, length: 20 }), null);
  assert.equal(C.lengthCeiling('custom', undefined), null);
});

test('whitespace is a real custom character, so typing it sets a ceiling of 1', () => {
  // Not a special case: three spaces de-duplicate to one distinct character. The
  // "nothing but whitespace" refusal belongs to generateCustom, which has the
  // whole word rather than the count of distinct characters in it.
  assert.equal(C.lengthCeiling('custom', { alphabet: '   ', length: 20 }).max, 1);
});

test('the custom ceiling counts unique characters, not keystrokes', () => {
  assert.equal(C.lengthCeiling('custom', { alphabet: 'aabbcc', length: 20 }).max, 3);
  assert.equal(C.lengthCeiling('custom', { alphabet: 'abc', length: 20 }).max, 3);
  assert.equal(C.lengthCeiling('custom', { alphabet: 'ab🙂é', length: 20 }).max, 4);
  assert.equal(C.lengthCeiling('custom', { alphabet: 'abc', length: 20 }).number, 'custom-length-number');
});

test('a custom alphabet larger than the limit is capped, not rejected', () => {
  assert.equal(C.lengthCeiling('custom', { alphabet: exoticAlphabet(500), length: 20 }).max, LIMITS.custom.max);
});

test('passphrase and pin have no alphabet-derived ceiling', () => {
  assert.equal(C.lengthCeiling('passphrase', { words: 6 }), null);
  assert.equal(C.lengthCeiling('pin', { length: 6 }), null);
  assert.equal(C.lengthCeiling('pin', { length: 6, noRepeat: true }), null);
});

// ------------------------------------------------------------------ clamping

test('a value over the ceiling is pulled down to it', () => {
  assert.equal(C.clampToCeiling('20', 10), 10);
  assert.equal(C.clampToCeiling(20, 10), 10);
  assert.equal(C.clampToCeiling('128', 92), 92);
});

test('a value that already fits is left alone, and nothing is written back', () => {
  // Returning null rather than the same number matters: these controls fire on
  // input, so writing an unchanged value back would queue another event.
  assert.equal(C.clampToCeiling('8', 10), null);
  assert.equal(C.clampToCeiling('10', 10), null);
  assert.equal(C.clampToCeiling('', 10), null);
  assert.equal(C.clampToCeiling('abc', 10), null);
});

// ------------------------------------------------------------------ presets

test('presets produce exactly the values they are named for', () => {
  assert.deepEqual(C.presetFor('strong').values, {
    'length-number': 20,
    'use-lower': true,
    'use-upper': true,
    'use-digits': true,
    'use-symbols': true,
    'require-each': true,
    'no-repeat': false,
    'exclude-ambiguous': false,
    exclude: '',
  });

  assert.deepEqual(C.presetFor('memorable').values, {
    'length-number': 28,
    'use-lower': true,
    'use-upper': false,
    'use-digits': true,
    'use-symbols': true,
    'require-each': true,
    'no-repeat': false,
    'exclude-ambiguous': true,
    exclude: '',
  });

  assert.deepEqual(C.presetFor('maximum').values, {
    'length-number': 64,
    'use-lower': true,
    'use-upper': true,
    'use-digits': true,
    'use-symbols': true,
    'require-each': true,
    'no-repeat': false,
    'exclude-ambiguous': false,
    exclude: '',
  });

  assert.deepEqual(C.presetFor('pin8').values, { 'pin-length-number': 8 });
  assert.equal(C.presetFor('pin8').mode, 'pin');
});

test('an unknown preset name is null, not a crash', () => {
  assert.equal(C.presetFor('nope'), null);
  assert.equal(C.presetFor(''), null);
  assert.equal(C.presetFor('stronger'), null);
});

test('every preset length is inside the limits it claims', () => {
  for (const name of C.presetNames()) {
    const preset = C.presetFor(name);
    const pair = C.RANGE_PAIRS.find((p) => p.number in preset.values);
    if (!pair) continue;
    assert.ok(preset.values[pair.number] >= pair.limits.min, name + ' is below its own minimum');
    assert.ok(preset.values[pair.number] <= pair.limits.max, name + ' is above its own maximum');
  }
});

test('booleans and text values are told apart, so a checkbox is not set to "true"', () => {
  const preset = C.presetFor('strong');
  assert.ok(preset.checkboxes.includes('use-lower'));
  assert.ok(preset.checkboxes.includes('no-repeat'));
  assert.deepEqual(preset.checkboxes.sort(), [
    'exclude-ambiguous', 'no-repeat', 'require-each', 'use-digits', 'use-lower', 'use-symbols', 'use-upper',
  ]);
  assert.deepEqual(preset.text, { 'length-number': 20, exclude: '' });
  assert.equal(preset.checkboxes.length + Object.keys(preset.text).length, Object.keys(preset.values).length);
});

// -------------------------------------------- a stale ceiling cannot survive

test('relaxing puts every length control back to its own maximum', () => {
  const relaxed = C.relaxedCeilings();
  assert.equal(relaxed.length, 3);
  assert.deepEqual(
    relaxed.map((p) => [p.range, p.number, p.max]),
    [
      ['length', 'length-number', LIMITS.password.max],
      ['pin-length', 'pin-length-number', LIMITS.pin.max],
      ['custom-length', 'custom-length-number', LIMITS.custom.max],
    ],
  );
});

test('a preset relaxes before it writes, so a stale ceiling cannot eat it', () => {
  // This is the bug the ordering exists to prevent. A user ticks "digits only",
  // which narrows the length slider's max to 10; the range input then clamps any
  // larger value the moment it is assigned. If "maximum" wrote 64 without
  // relaxing first, the control would hold 10 and the page would quietly issue a
  // 10-character password labelled 64.
  const preset = C.presetFor('maximum');
  const asked = preset.values['length-number'];

  const before = { max: 10, value: '10' };
  assert.equal(before.value.length > 10, false, 'a range input would have clamped this already');

  const relax = preset.relax.find((p) => p.range === 'length');
  assert.equal(relax.max, LIMITS.password.max, 'the ceiling must be widened first');

  // Relax, then write, in that order: the value survives.
  const afterRelax = { max: relax.max, value: before.value };
  afterRelax.value = String(asked);
  assert.equal(afterRelax.value, '64');

  // Write first, then relax: the value is already lost.
  const wrongOrder = { max: 10, value: '10' };
  wrongOrder.value = String(Math.min(wrongOrder.value, asked));
  assert.equal(wrongOrder.value, '10');
});

test('relaxing still corrects a value that is over the library limit', () => {
  const relax = C.relaxedCeilings().find((p) => p.range === 'pin-length');
  assert.equal(relax.to('12'), null, '12 is within the PIN limit already');
  assert.equal(relax.to('99'), LIMITS.pin.max);
});

test('a preset that switches mode still relaxes all three ranges', () => {
  // pin8 writes only the PIN length, but the password and custom sliders must be
  // widened too, or switching back would inherit a ceiling from two presets ago.
  const preset = C.presetFor('pin8');
  assert.deepEqual(preset.relax.map((p) => p.range), ['length', 'pin-length', 'custom-length']);
  assert.deepEqual(preset.sync.map((p) => [p.range, p.number]), [
    ['length', 'length-number'],
    ['pin-length', 'pin-length-number'],
    ['custom-length', 'custom-length-number'],
  ]);
});

test('a preset carries its own mode, so it does not need one set separately', () => {
  assert.equal(C.presetFor('pin8').mode, 'pin');
  assert.equal(C.presetFor('pin8').kind, 'pin');
  assert.equal(C.presetFor('strong').modeState.isSelected('password'), true);
  assert.equal(C.presetFor('strong').modeState.showsPanel('passphrase'), false);
});

// ------------------------------------------------------------------ modes

test('the four modes are the ones the page offers', () => {
  assert.deepEqual(C.MODES, ['password', 'passphrase', 'pin', 'custom']);
});

test('a mode selects exactly one button and shows exactly one panel', () => {
  const next = C.modeState('pin');
  assert.deepEqual(C.MODES.filter(next.isSelected), ['pin']);
  assert.deepEqual(C.MODES.filter(next.showsPanel), ['pin']);
  assert.deepEqual(C.MODES.filter((m) => !next.isSelected(m)).length, 3);
  assert.deepEqual(C.MODES.filter((m) => !next.showsPanel(m)).length, 3);
});

test('custom mode is labelled the way the page labels it', () => {
  assert.equal(C.modeState('custom').kind, 'custom password');
  assert.equal(C.modeState('passphrase').kind, 'passphrase');
  assert.equal(C.kindLabel('custom'), 'custom password');
});

test('an unrecognised mode still produces a usable answer', () => {
  // A mode with no panel should not throw: it should simply match nothing.
  const next = C.modeState('nonsense');
  assert.deepEqual(C.MODES.filter(next.isSelected), []);
  assert.deepEqual(C.MODES.filter(next.showsPanel), []);
});

// ------------------------------------------------------------------ digest

test('a digest is recognised through the decoration it arrives with', () => {
  const digest = 'a'.repeat(64);
  assert.equal(C.normaliseDigest(digest), digest);
  assert.equal(C.normaliseDigest('sha256-' + digest), digest);
  assert.equal(C.normaliseDigest('sha-256-' + digest), digest);
  assert.equal(C.normaliseDigest('SHA256-' + digest.toUpperCase()), digest);
  assert.equal(C.normaliseDigest('  ' + digest.slice(0, 32) + ' ' + digest.slice(32) + '  '), digest);
  assert.equal(C.normaliseDigest('\n' + digest + '\n'), digest);
});

test('the digest verdict has three states and says which digest this is', () => {
  const digest = 'b'.repeat(64);

  const empty = C.digestVerdict('', digest);
  assert.equal(empty.state, 'empty');
  assert.equal(empty.error, false);
  assert.match(empty.text, /Paste a 64-character digest/);

  const match = C.digestVerdict('sha256-' + digest, digest);
  assert.equal(match.state, 'match');
  assert.equal(match.error, false);
  assert.match(match.text, /Match\./);

  const mismatch = C.digestVerdict('c'.repeat(64), digest);
  assert.equal(mismatch.state, 'mismatch');
  assert.equal(mismatch.error, true);
  assert.ok(mismatch.text.includes(digest), 'a mismatch must name the digest this build was made from');
});

test('the digest verdict tolerates a missing build stamp', () => {
  // PG.BUILD is absent when app.js runs unbundled in a test harness; the page
  // must not throw on a fresh build rather than read as a match.
  const unbuilt = C.digestVerdict('anything', undefined);
  assert.equal(unbuilt.state, 'mismatch');
  assert.equal(unbuilt.error, true);
});

test('an empty field is never a match', () => {
  assert.equal(C.digestVerdict('   ', 'd'.repeat(64)).state, 'empty');
  assert.equal(C.digestVerdict(null, 'd'.repeat(64)).state, 'empty');
  assert.equal(C.digestVerdict(undefined, undefined).state, 'empty');
});