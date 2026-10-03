/*
 * generators.js -- the four ways this app makes a secret.
 *
 * Sampling rule for passwords: draw a candidate uniformly from the whole
 * alphabet, then reject it unless it satisfies every active constraint. That
 * makes the output distribution exactly uniform over the valid strings, which
 * is what lets entropy.js quote a true number instead of an approximation.
 * Where the constraints are tight (short length, many required types) we simply
 * redraw -- acceptance is still comfortable in that regime, and we bail out with
 * an explanation rather than loop forever.
 */
(function (PG) {
  'use strict';

  var random = PG.random;

  var LIMITS = {
    // The floor here is 1, not the 4 the slider enforces: this is a library
    // limit, and the constraint check below stays reachable for library callers.
    password: { min: 1, max: 128, default: 20 },
    passphrase: { min: 3, max: 12, default: 6 },
    pin: { min: 4, max: 12, default: 6 },
    custom: { min: 1, max: 128, default: 20 },
  };

  var CHARSETS = {
    lower: 'abcdefghijklmnopqrstuvwxyz',
    upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    digits: '0123456789',
    // Deliberately excludes quotes, backtick, backslash, space and the
    // combining characters that make a password awkward to paste into a shell,
    // a CSV cell or a form that trims whitespace.
    symbols: '!#$%&()*+,-./:;<=>?@[]^_{|}~',
  };

  // Characters that get mistaken for one another in most fonts.
  var AMBIGUOUS = '0OoIl1|';

  var CLASS_DEFS = [
    { key: 'lower', label: 'Lowercase', flag: 'useLower', chars: CHARSETS.lower },
    { key: 'upper', label: 'Uppercase', flag: 'useUpper', chars: CHARSETS.upper },
    { key: 'digits', label: 'Digits', flag: 'useDigits', chars: CHARSETS.digits },
    { key: 'symbols', label: 'Symbols', flag: 'useSymbols', chars: CHARSETS.symbols },
  ];

  var MAX_ATTEMPTS = 5000;
  var MAX_CUSTOM_ALPHABET = 4096;

  function GeneratorError(message) {
    var err = new Error(message);
    err.name = 'GeneratorError';
    err.userFacing = true;
    return err;
  }

  function clamp(value, min, max, fallback) {
    var n = Number(value);
    if (!Number.isFinite(n)) n = fallback;
    n = Math.round(n);
    if (n < min) n = min;
    if (n > max) n = max;
    return n;
  }

  /** Code points, de-duplicated, order preserved. Handles emoji and accents. */
  function uniqueChars(text) {
    var seen = Object.create(null);
    var out = [];
    var chars = Array.from(String(text == null ? '' : text));
    for (var i = 0; i < chars.length; i++) {
      var ch = chars[i];
      if (!seen[ch]) {
        seen[ch] = true;
        out.push(ch);
      }
    }
    return out;
  }

  function filterChars(chars, excluded) {
    var drop = Object.create(null);
    var removed = [];
    var charsToDrop = Array.from(excluded || '');
    for (var i = 0; i < charsToDrop.length; i++) {
      var ch = charsToDrop[i];
      if (!drop[ch]) {
        drop[ch] = true;
        removed.push(ch);
      }
    }
    return {
      chars: chars.filter(function (c) { return !drop[c]; }),
      removed: removed,
    };
  }

  /**
   * Turn the option object into the concrete alphabet, split into the classes
   * that a "one of each" guarantee would refer to.
   */
  function buildAlphabet(options) {
    var opts = options || {};
    var excluded = (opts.excludeAmbiguous ? AMBIGUOUS : '') + (opts.exclude || '');

    var classes = [];
    var flat = [];
    var charClass = Object.create(null);
    var removed = [];

    for (var i = 0; i < CLASS_DEFS.length; i++) {
      var def = CLASS_DEFS[i];
      if (!opts[def.flag]) continue;

      var source = def.chars;
      if (def.key === 'symbols' && opts.symbolsOverride) source = opts.symbolsOverride;

      var filtered = filterChars(uniqueChars(source), excluded);
      for (var r = 0; r < filtered.removed.length; r++) {
        if (removed.indexOf(filtered.removed[r]) === -1) removed.push(filtered.removed[r]);
      }
      if (filtered.chars.length === 0) continue;

      var classIndex = classes.length;
      for (var c = 0; c < filtered.chars.length; c++) {
        flat.push(filtered.chars[c]);
        charClass[filtered.chars[c]] = classIndex;
      }
      classes.push({
        key: def.key,
        label: def.label,
        chars: filtered.chars,
      });
    }

    return {
      classes: classes,
      flat: flat,
      charClass: charClass,
      size: flat.length,
      removed: removed,
    };
  }

  /** Does this candidate contain at least one character from every class? */
  function hasEveryClass(sequence, charClass, classCount) {
    var seen = 0;
    for (var i = 0; i < sequence.length; i++) {
      var index = charClass[sequence[i]];
      if (index === undefined) return false;
      seen |= 1 << index;
    }
    return seen === (1 << classCount) - 1;
  }

  function drawCandidate(chars, length, distinct) {
    return distinct ? random.sampleDistinct(chars, length) : random.sampleWithReplacement(chars, length);
  }

  /**
   * Character-based password. Returns the value plus the exact spec that
   * entropy.js needs to describe it.
   */
  function generatePassword(options) {
    var opts = options || {};
    var limits = LIMITS.password;
    var built = buildAlphabet(opts);

    if (built.size === 0) {
      throw GeneratorError('Every character type came out empty. Untick a type or clear the exclude field.');
    }

    var length = clamp(opts.length, limits.min, limits.max, limits.default);
    var distinct = !!opts.noRepeat;

    if (distinct && length > built.size) {
      throw GeneratorError(
        'No repeats needs at most ' + built.size + ' characters (that is the whole alphabet), but you asked for ' + length + '.'
      );
    }

    var requireEach = !!opts.requireEach && built.classes.length > 0;
    if (requireEach && built.classes.length > length) {
      throw GeneratorError(
        'Requiring one of each of the ' + built.classes.length + ' selected types needs a length of at least ' + built.classes.length + '.'
      );
    }

    var chars = built.flat;
    var charClass = built.charClass;
    var classCount = built.classes.length;

    for (var attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      var candidate = drawCandidate(chars, length, distinct);
      if (!requireEach || hasEveryClass(candidate, charClass, classCount)) {
        return {
          kind: 'password',
          value: candidate.join(''),
          spec: {
            alphabetSize: built.size,
            classSizes: built.classes.map(function (c) { return c.chars.length; }),
            length: length,
            distinct: distinct,
          },
          alphabet: built,
        };
      }
    }

    throw GeneratorError(
      'These settings leave too few valid passwords to draw reliably. Make it longer, or turn off a requirement.'
    );
  }

  var SEPARATORS = {
    dash: { label: 'hyphen  -', value: '-' },
    dot: { label: 'dot  .', value: '.' },
    underscore: { label: 'underscore  _', value: '_' },
    space: { label: 'space', value: ' ' },
    digit: { label: 'digit  7', value: '7' },
    none: { label: 'nothing', value: '' },
  };

  /**
   * Diceware-style passphrase. Words repeat, because forcing distinctness would
   * mean sampling from a shrinking set on every word and would quietly cost
   * entropy for no real gain.
   */
  function generatePassphrase(options, wordlist) {
    var opts = options || {};
    var limits = LIMITS.passphrase;
    var words = clamp(opts.words, limits.min, limits.max, limits.default);

    if (!wordlist || wordlist.length < 2) {
      throw GeneratorError('The word list failed to load.');
    }

    var separator = SEPARATORS[opts.separator] ? SEPARATORS[opts.separator].value : '-';
    var chosen = [];
    var segments = [];

    for (var i = 0; i < words; i++) {
      var word = random.pick(wordlist);
      // Capitalising on a fair coin flip adds exactly one bit per word.
      if (opts.capitalize && random.randomInt(2) === 1) {
        word = word.charAt(0).toUpperCase() + word.slice(1);
      }
      if (i > 0) segments.push({ type: 'separator', text: separator });
      segments.push({ type: 'word', text: word });
      chosen.push(word);
    }

    var value = chosen.join(separator);

    var extraBits = 0;
    if (opts.appendDigit) {
      var digit = String(random.randomInt(10));
      segments.push({ type: 'separator', text: separator });
      segments.push({ type: 'digit', text: digit });
      value += separator === '' ? digit : separator + digit;
      extraBits += Math.log2(10);
    }

    return {
      kind: 'passphrase',
      value: value,
      words: chosen,
      segments: segments,
      spec: {
        words: words,
        wordlistSize: wordlist.length,
        capitalize: !!opts.capitalize,
        appendDigit: !!opts.appendDigit,
        extraBits: extraBits,
      },
    };
  }

  /** Numeric PIN, with the option to forbid repeats. */
  function generatePin(options) {
    var opts = options || {};
    var limits = LIMITS.pin;
    var length = clamp(opts.length, limits.min, limits.max, limits.default);
    var distinct = !!opts.noRepeat;
    var digits = uniqueChars(CHARSETS.digits);

    if (distinct && length > digits.length) {
      throw GeneratorError('A no-repeat PIN can be at most 10 digits long.');
    }

    var sequence = distinct
      ? random.sampleDistinct(digits, length)
      : random.sampleWithReplacement(digits, length);

    return {
      kind: 'pin',
      value: sequence.join(''),
      spec: {
        alphabetSize: digits.length,
        classSizes: [],
        length: length,
        distinct: distinct,
      },
    };
  }

  /** User-supplied alphabet. De-duplicated, filtered, then sampled uniformly. */
  function generateCustom(options) {
    var opts = options || {};
    var limits = LIMITS.custom;
    var filtered = filterChars(uniqueChars(opts.alphabet), opts.exclude);
    var chars = filtered.chars;

    if (chars.length === 0) {
      throw GeneratorError('Type at least one character to build an alphabet from.');
    }
    if (!chars.some(function (ch) { return !/\s/.test(ch); })) {
      throw GeneratorError('That alphabet is nothing but whitespace, which would not make a password.');
    }
    if (chars.length > MAX_CUSTOM_ALPHABET) {
      throw GeneratorError('That alphabet has ' + chars.length + ' unique characters; keep it under ' + MAX_CUSTOM_ALPHABET + '.');
    }

    var length = clamp(opts.length, limits.min, limits.max, limits.default);
    var distinct = !!opts.noRepeat;

    if (distinct && length > chars.length) {
      throw GeneratorError('No repeats needs at most ' + chars.length + ' characters, but you asked for ' + length + '.');
    }

    var sequence = distinct
      ? random.sampleDistinct(chars, length)
      : random.sampleWithReplacement(chars, length);

    return {
      kind: 'custom',
      value: sequence.join(''),
      spec: {
        alphabetSize: chars.length,
        classSizes: [],
        length: length,
        distinct: distinct,
      },
      alphabet: { size: chars.length, chars: chars, removed: filtered.removed, classes: [], flat: chars },
    };
  }

  PG.generators = {
    LIMITS: LIMITS,
    CHARSETS: CHARSETS,
    AMBIGUOUS: AMBIGUOUS,
    SEPARATORS: SEPARATORS,
    MAX_CUSTOM_ALPHABET: MAX_CUSTOM_ALPHABET,
    GeneratorError: GeneratorError,
    uniqueChars: uniqueChars,
    filterChars: filterChars,
    buildAlphabet: buildAlphabet,
    generatePassword: generatePassword,
    generatePassphrase: generatePassphrase,
    generatePin: generatePin,
    generateCustom: generateCustom,
  };
})(window.PG = window.PG || {});
