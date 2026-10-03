/*
 * controls.js -- what the controls decide, with no DOM in sight.
 *
 * src/app.js is wiring: it reads elements, calls the generators, writes results.
 * Between those two halves sits a layer that is neither -- the rules about how
 * long a password may be given the alphabet currently selected, what a named
 * preset is made of, and which panel a mode shows. All of it is arithmetic over
 * an options object. None of it needs a document, so all of it lives here and
 * all of it is tested without one.
 *
 * What stays in app.js is the part that genuinely cannot be separated: reading a
 * checkbox, writing a range input's max attribute, and the painting of results.
 * Those are mechanical, and a fake document elaborate enough to satisfy them is
 * a second implementation of the browser, which is not worth maintaining.
 */
(function (PG) {
  'use strict';

  var LIMITS = PG.generators.LIMITS;

  /** The four ways this page makes a secret, in the order the tabs appear. */
  var MODES = ['password', 'passphrase', 'pin', 'custom'];

  /**
   * Every length control, paired with the number box beside it and the library
   * limits it belongs to. One list, because forgetting a pair is exactly how a
   * preset ends up inheriting the previous preset's ceiling.
   */
  var RANGE_PAIRS = [
    { range: 'length', number: 'length-number', limits: LIMITS.password },
    { range: 'pin-length', number: 'pin-length-number', limits: LIMITS.pin },
    { range: 'custom-length', number: 'custom-length-number', limits: LIMITS.custom },
  ];

  /** What the interface prints above the secret, per mode. */
  function kindLabel(mode) {
    return mode === 'custom' ? 'custom password' : String(mode);
  }

  /**
   * Everything the mode switch has to do for one mode.
   *
   * Two different contracts that are easy to conflate: `.mode` buttons carry
   * aria-checked, `.mode-panel` elements carry visibility, and both compare a
   * data attribute against the active mode. Naming the two predicates keeps them
   * from being collapsed into one.
   */
  function modeState(mode) {
    return {
      mode: mode,
      kind: kindLabel(mode),
      isSelected: function (buttonMode) { return buttonMode === mode; },
      showsPanel: function (panelMode) { return panelMode === mode; },
    };
  }

  /**
   * The ceiling a length control should carry right now, or null when there is
   * nothing to enforce.
   *
   * With "no repeats" available, a length past the size of the alphabet is
   * unsatisfiable, and the generator would refuse with an explanation. It is
   * better to shorten the slider so the ceiling is visible before the user asks,
   * which is why this is capped at the alphabet size regardless of whether
   * no-repeat is currently ticked: the toggle is one click away and the ceiling
   * does not need to move when it is.
   *
   * Custom mode returns null for an empty alphabet, which means "nothing typed
   * yet" rather than "length zero". Leaving the slider alone is right there.
   */
  function lengthCeiling(mode, options) {
    var opts = options || {};

    if (mode === 'password') {
      var built = PG.generators.buildAlphabet(opts);
      return {
        range: 'length',
        number: 'length-number',
        max: Math.max(4, Math.min(LIMITS.password.max, built.size)),
      };
    }

    if (mode === 'custom') {
      var size = PG.generators.uniqueChars(opts.alphabet).length;
      if (size === 0) return null;
      return {
        range: 'custom-length',
        number: 'custom-length-number',
        max: Math.max(1, Math.min(LIMITS.custom.max, size)),
      };
    }

    return null;
  }

  /**
   * The value a control should be pulled down to, or null when it already fits.
   *
   * A range input clamps its own value the instant its max shrinks, and does it
   * silently. Returning "no change needed" as null lets the caller skip the DOM
   * write entirely, which matters for a control that fires on input: writing an
   * unchanged value back would queue another event.
   */
  function clampToCeiling(current, ceiling) {
    var value = parseInt(current, 10);
    if (!Number.isFinite(value)) return null;
    return value > ceiling ? ceiling : null;
  }

  /**
   * Every length control, put back to the widest range its library allows.
   *
   * A preset must call this before writing new values. A range input whose max
   * was narrowed to 6 by the previous settings will clamp a requested 64 down to
   * 6 the instant it is assigned, so the preset would silently produce a much
   * shorter password than the one it names.
   */
  function relaxedCeilings() {
    return RANGE_PAIRS.map(function (pair) {
      return {
        range: pair.range,
        number: pair.number,
        max: pair.limits.max,
        to: function (current) { return clampToCeiling(current, pair.limits.max); },
      };
    });
  }

  /**
   * The named presets. Values are written by control id; a value that belongs to
   * a checkbox is a boolean and everything else is a number or string.
   *
   * These are the numbers the interface promises by name, so they are tested
   * against this table rather than against whatever the sliders happen to be
   * set to when a test runs.
   */
  var PRESETS = {
    strong: {
      mode: 'password',
      values: {
        'length-number': 20, 'use-lower': true, 'use-upper': true, 'use-digits': true,
        'use-symbols': true, 'require-each': true, 'no-repeat': false,
        'exclude-ambiguous': false, exclude: '',
      },
    },
    memorable: {
      mode: 'password',
      values: {
        'length-number': 28, 'use-lower': true, 'use-upper': false, 'use-digits': true,
        'use-symbols': true, 'require-each': true, 'no-repeat': false,
        'exclude-ambiguous': true, exclude: '',
      },
    },
    maximum: {
      mode: 'password',
      values: {
        'length-number': 64, 'use-lower': true, 'use-upper': true, 'use-digits': true,
        'use-symbols': true, 'require-each': true, 'no-repeat': false,
        'exclude-ambiguous': false, exclude: '',
      },
    },
    pin8: {
      mode: 'pin',
      values: { 'pin-length-number': 8 },
    },
  };

  /**
   * A preset, resolved into the ordered steps that apply it.
   *
   * The order is the whole point: relax every ceiling, write the values, resync
   * the sliders, switch mode, then let the new settings tighten the ceilings
   * again. Steps out of order reintroduce the bug this file exists to make
   * impossible to test for.
   */
  function presetFor(name) {
    var preset = PRESETS[name];
    if (!preset) return null;

    var values = preset.values;
    var checkboxes = [];
    var text = {};
    Object.keys(values).forEach(function (id) {
      if (typeof values[id] === 'boolean') checkboxes.push(id);
      else text[id] = values[id];
    });

    return {
      name: name,
      mode: preset.mode,
      kind: kindLabel(preset.mode),
      modeState: modeState(preset.mode),
      values: values,
      checkboxes: checkboxes,
      text: text,
      relax: relaxedCeilings(),
      sync: RANGE_PAIRS.map(function (pair) {
        return { range: pair.range, number: pair.number };
      }),
    };
  }

  /** Every preset name, for a test that checks the table has not lost one. */
  function presetNames() {
    return Object.keys(PRESETS);
  }

  /**
   * Strip the decoration a digest arrives with: a `sha256-` prefix from
   * `shasum -a 256`, or a stray space from a copy out of a terminal.
   */
  function normaliseDigest(raw) {
    return String(raw === null || raw === undefined ? '' : raw)
      .trim()
      .toLowerCase()
      .replace(/^sha-?256-/, '')
      .replace(/\s+/g, '');
  }

  /**
   * Whether a pasted digest is this build's, and what to say about it.
   *
   * `state` is one of 'empty', 'match', 'mismatch'. The caller decides how to
   * paint it; the wording lives here so it can be asserted rather than eyeballed,
   * and so a mismatch always names the digest this build was actually made from.
   */
  function digestVerdict(raw, target) {
    var input = normaliseDigest(raw);
    var expected = String(target === null || target === undefined ? '' : target).toLowerCase();

    if (!input) {
      return { state: 'empty', error: false, text: 'Paste a 64-character digest to compare.' };
    }
    if (input === expected) {
      return { state: 'match', error: false, text: 'Match. That is the source this build was made from.' };
    }
    return {
      state: 'mismatch',
      error: true,
      text: 'No match. This build came from source digest ' + expected + '.',
    };
  }

  PG.controls = {
    MODES: MODES,
    RANGE_PAIRS: RANGE_PAIRS,
    PRESETS: PRESETS,
    kindLabel: kindLabel,
    modeState: modeState,
    lengthCeiling: lengthCeiling,
    clampToCeiling: clampToCeiling,
    relaxedCeilings: relaxedCeilings,
    presetFor: presetFor,
    presetNames: presetNames,
    normaliseDigest: normaliseDigest,
    digestVerdict: digestVerdict,
  };
})(window.PG = window.PG || {});