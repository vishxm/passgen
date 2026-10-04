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

// ------------------------------------------------------------------ the box

/*
 * controls.typedLength() and controls.settledLength() -- the length box.
 *
 * The bug these pin down: every keystroke used to go through a clamp that wrote
 * its result back into the field being typed in. A value below min was replaced
 * by min, so the *next* keystroke appended to the replacement -- which made every
 * two-digit number starting with a digit at or below min-1 unreachable. Typing
 * "20" in a box with min 4 produced 42 and then 128. The field could not even be
 * cleared: select-all and delete, and the handler refilled it with min.
 *
 * So the rule is the pair: while the box is being edited, read what is in it and
 * move the slider only if it is already a number in range; when the edit ends,
 * show the clamped answer.
 */

test('typedLength reports what is in the box, not what it is allowed to be', () => {
  assert.equal(C.typedLength('20'), 20);
  assert.equal(C.typedLength('2'), 2);      // below min, still 2 -- not clamped to 4
  assert.equal(C.typedLength(''), null);
  assert.equal(C.typedLength('-'), null);
  assert.equal(C.typedLength('abc'), null);
  assert.equal(C.typedLength('  8  '), 8);
  assert.equal(C.typedLength('1e3'), 1000);
});

test('a box with nothing usable in it is null, not a guess', () => {
  assert.equal(C.typedLength(null), null);
  assert.equal(C.typedLength(undefined), null);
  assert.equal(C.typedLength('   '), null);
  assert.equal(C.typedLength('Infinity'), null, 'an unbounded length is not a length');
  assert.equal(C.typedLength('-NaN'), null);
});

test('a partially typed box is truncated, not rounded away', () => {
  // 20.7 is a length the slider cannot hold, but which side of 20 it lands on is
  // the caller's decision to make, not something to refuse over.
  assert.equal(C.typedLength('20.7'), 20);
  assert.equal(C.typedLength('-8'), -8, 'a negative length is a number; the range check rejects it');
});

test('settledLength pulls a finished edit inside the range', () => {
  assert.deepEqual(C.settledLength('20', 4, 128, 20), { value: 20, changed: false });
  assert.deepEqual(C.settledLength('200', 4, 128, 20), { value: 128, changed: true });
  assert.deepEqual(C.settledLength('2', 4, 128, 20), { value: 4, changed: true });
  assert.deepEqual(C.settledLength('', 4, 128, 20), { value: 20, changed: false });
});

test('an unreadable box falls back to the slider without moving it', () => {
  // Select-all and delete, then tab away: the field has to show the length that
  // is actually in force, and the slider must not budge. Refilling it with min
  // was the first symptom of the bug.
  assert.deepEqual(C.settledLength('', 4, 128, '90'), { value: 90, changed: false });
  assert.deepEqual(C.settledLength('-', 4, 128, '90'), { value: 90, changed: false });
  assert.deepEqual(C.settledLength('12e', 4, 128, '90'), { value: 90, changed: false });
});

test('settling twice changes nothing the second time', () => {
  // change and blur both fire, so settle runs twice on every finished edit. The
  // second run has to be a no-op or the page regenerates twice per edit.
  const first = C.settledLength('200', 4, 128, 20);
  const second = C.settledLength(String(first.value), 4, 128, String(first.value));
  assert.deepEqual(second, { value: 128, changed: false });
});

test('a slider value that arrives as a string is not mistaken for a change', () => {
  // The caller has range.value, which is a string. 20 !== "20", so comparing
  // them raw reports every settled box as changed and regenerates every time.
  assert.deepEqual(C.settledLength('20', 4, 128, '20'), { value: 20, changed: false });
  assert.deepEqual(C.settledLength('200', 4, 128, '20'), { value: 128, changed: true });
});

test('every length control leaves a typed length alone, and none of them invents one', () => {
  // The regression, over all four controls rather than one hand-picked pair -- so
  // a fifth slider cannot quietly opt out of the rule.
  //
  // Each control is asked for its own default rather than a single number like
  // 20: the passphrase and PIN ceilings are 12, so 20 is not a length they can
  // offer and a test that pretended otherwise would be testing a fiction.
  //
  // Note these are the library limits, which is not the same as the slider's own
  // min attribute: LIMITS.password.min is 1 while the slider enforces 4. That
  // difference is exactly why this asserts behaviour rather than arithmetic. The
  // markup's own bounds are checked against RANGE_PAIRS in build.test.mjs, where
  // the markup is in reach.
  for (const pair of C.RANGE_PAIRS) {
    const { min, max, default: wanted } = pair.limits;
    const label = pair.number;
    const typed = String(wanted);

    assert.ok(min <= wanted && wanted <= max, label + ': its own default sits outside its own limits');
    assert.ok(1 < max, label);

    // A box holding a single digit reads as that digit -- never 1, never min,
    // never a clamp. This is the keystroke that used to be replaced by min, and
    // the next keystroke then appended to the replacement, so "20" became "128".
    assert.equal(C.typedLength('2'), 2, label);
    assert.ok(2 < max, label);

    // The finished value is reachable, and settling it is a no-op -- whether the
    // slider reports its value as a number or as the string a DOM hands back.
    assert.equal(C.typedLength(typed), wanted, label);
    assert.deepEqual(C.settledLength(typed, min, max, wanted), { value: wanted, changed: false }, label);
    assert.deepEqual(C.settledLength(typed, min, max, typed), { value: wanted, changed: false }, label);

    // A value typed past the ceiling is corrected when the edit ends, not during
    // it, and settling it does move the slider.
    assert.deepEqual(C.settledLength('999', min, max, wanted), { value: max, changed: true }, label);

    // And a cleared box falls back to the slider rather than to min.
    assert.deepEqual(C.settledLength('', min, max, wanted), { value: wanted, changed: false }, label);
    assert.deepEqual(C.settledLength('', min, max, max), { value: max, changed: false }, label);
  }
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

  // Every preset length is also inside the limits it claims. This used to be its
  // own test, driven by an exported list of preset names -- which meant the table
  // had to be exported only so a test could walk it. Naming each preset here is
  // the better trade: the check survives, and a new preset has to be written down
  // to be tested at all.
  for (const name of ['strong', 'memorable', 'maximum', 'pin8']) {
    const preset = C.presetFor(name);
    const pair = C.RANGE_PAIRS.find((p) => p.number in preset.values);
    if (!pair) continue;
    assert.ok(preset.values[pair.number] >= pair.limits.min, name + ' is below its own minimum');
    assert.ok(preset.values[pair.number] <= pair.limits.max, name + ' is above its own maximum');
  }
});

test('an unknown preset name is null, not a crash', () => {
  assert.equal(C.presetFor('nope'), null);
  assert.equal(C.presetFor(''), null);
  assert.equal(C.presetFor('stronger'), null);
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
  assert.equal(relaxed.length, 4);
  assert.deepEqual(
    relaxed.map((p) => [p.range, p.number, p.max]),
    [
      ['length', 'length-number', LIMITS.password.max],
      ['words', 'words-number', LIMITS.passphrase.max],
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

test('a preset that switches mode still relaxes all four ranges', () => {
  // pin8 writes only the PIN length, but the other three sliders must be widened
  // too, or switching back would inherit a ceiling from two presets ago. All four
  // pairs are listed because all four sliders now share the always-visible slot:
  // a narrowing rule applied to three of four would be the inconsistency.
  const preset = C.presetFor('pin8');
  assert.deepEqual(preset.relax.map((p) => p.range), ['length', 'words', 'pin-length', 'custom-length']);
  assert.deepEqual(preset.sync.map((p) => [p.range, p.number]), [
    ['length', 'length-number'],
    ['words', 'words-number'],
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

// ------------------------------------------------------------------ hinge

/*
 * controls.specText() -- the one line under the plate.
 *
 * This was describeResult() in app.js, which nothing could reach. It moved here
 * for a reason beyond testability: it now names the character classes, so it sits
 * directly under a plate whose glyphs are coloured by exactly those classes, and
 * the whole form behind Adjust collapsed into one disclosure. The hinge is the
 * only readout left above the fold, so it has to be right when the checkboxes
 * above it are what changed.
 */
const LIST_SIZE = PG.WORDLIST.length;

test('the hinge names the character classes it drew from', () => {
  const result = G.generatePassword(allClasses());
  assert.equal(
    C.specText(result, LIST_SIZE),
    '20 characters · lowercase + uppercase + digits + symbols · one of each type',
  );
});

test('unticking a type takes its name off the hinge', () => {
  const digitsOnly = G.generatePassword(allClasses({ useLower: false, useUpper: false, useSymbols: false }));
  const text = C.specText(digitsOnly, LIST_SIZE);
  assert.equal(text, '20 characters · digits');
  assert.ok(!/lowercase/.test(text), 'a class that is switched off must not be claimed');
  assert.ok(!/one of each type/.test(text), 'one class is not a guarantee across classes');
});

test('the guarantee is named only when there is more than one class to guarantee', () => {
  const two = G.generatePassword(allClasses({ useSymbols: false }));
  assert.match(C.specText(two, LIST_SIZE), /one of each type$/);
});

test('the hinge reports the rules that are actually on', () => {
  const distinct = C.specText(G.generatePassword(allClasses({ noRepeat: true, length: 12 })), LIST_SIZE);
  assert.match(distinct, /no repeats/);

  const ambiguous = C.specText(G.generatePassword(allClasses({ excludeAmbiguous: true })), LIST_SIZE);
  assert.ok(
    ambiguous.endsWith('removed ' + Array.from(G.AMBIGUOUS).join(' ')),
    'the hinge must name what the look-alike toggle actually removed, got: ' + ambiguous,
  );

  const excluded = C.specText(G.generatePassword(allClasses({ exclude: 'abc' })), LIST_SIZE);
  assert.match(excluded, /removed a b c/);
});

test('a one-unit result is named in the singular', () => {
  assert.match(C.specText(G.generatePassword(allClasses({ length: 1, requireEach: false })), LIST_SIZE), /^1 character ·/);
  assert.match(C.specText(G.generateCustom({ alphabet: 'ab', length: 1 }), LIST_SIZE), /^1 character ·/);
});

test('a passphrase names its words, its list, and only the rules that are on', () => {
  const plain = C.specText(G.generatePassphrase({ words: 6, separator: 'dash' }, PG.WORDLIST), LIST_SIZE);
  assert.equal(plain, '6 words · 7,776-word EFF list');

  const loud = C.specText(
    G.generatePassphrase({ words: 5, separator: 'dash', capitalize: true, appendDigit: true }, PG.WORDLIST),
    LIST_SIZE,
  );
  assert.equal(loud, '5 words · 7,776-word EFF list · capitalised at random · digit appended');
});

test('a passphrase says so when the word list is not there', () => {
  const text = C.specText(G.generatePassphrase({ words: 6, separator: 'dash' }, PG.WORDLIST), 0);
  assert.match(text, /word list unavailable/);
});

test('a PIN counts digits and says where they came from', () => {
  const text = C.specText(G.generatePin({ length: 6, noRepeat: false }), LIST_SIZE);
  assert.equal(text, '6 digits · alphabet of 10');
  assert.match(C.specText(G.generatePin({ length: 8, noRepeat: true }), LIST_SIZE), /no repeats/);
});

test('a custom secret names the alphabet, not a class', () => {
  // Custom alphabets have no classes at all, so naming one would be a lie.
  const text = C.specText(G.generateCustom({ alphabet: 'ab🙂é', length: 4 }), LIST_SIZE);
  assert.equal(text, '4 characters · alphabet of 4');
});

test('the hinge is built from arithmetic, not from counting the string', () => {
  // A generated value can hold repeated characters, so `result.value.length` is
  // not the length that was asked for. The count comes from the spec.
  const result = G.generatePassword(allClasses({ length: 40 }));
  assert.ok(result.value.length === 40);
  assert.match(C.specText(result, LIST_SIZE), /^40 characters ·/);
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