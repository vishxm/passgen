/*
 * entropy.js -- exact entropy accounting for the strings this app produces.
 *
 * The usual "length x log2(alphabet)" figure is only right when every string in
 * the output space is equally likely. As soon as a guarantee like "at least one
 * uppercase" is switched on, the generator samples uniformly from a *subset* of
 * that space, so the honest number is smaller. We count that subset exactly,
 * with inclusion-exclusion, and work in log space so a 128-character password
 * over a 94-character alphabet does not overflow anything.
 */
(function (PG) {
  'use strict';

  var LOG10_2 = Math.log10(2);
  var YEAR_SECONDS = 31557600; // Julian year, 365.25 days
  var AGE_OF_UNIVERSE_SECONDS = 4.35e17;

  var SCALES = [
    [1e3, 'thousand'],
    [1e6, 'million'],
    [1e9, 'billion'],
    [1e12, 'trillion'],
    [1e15, 'quadrillion'],
    [1e18, 'quintillion'],
  ];

  /**
   * Attack models shown to the user. These are estimates about someone else's
   * hardware, so they are labelled on screen rather than buried.
   */
  var ATTACK_MODELS = [
    {
      id: 'online',
      label: 'Online, rate-limited',
      detail: 'guessing through a login form, which the site throttles',
      guessesPerSecond: 10,
    },
    {
      id: 'kdf',
      label: 'Offline, slow hash',
      detail: 'bcrypt / scrypt / Argon2 on one high-end GPU',
      guessesPerSecond: 1e4,
    },
    {
      id: 'fast',
      label: 'Offline, fast hash',
      detail: 'MD5 / SHA-1 on a rig of 8x RTX 4090',
      guessesPerSecond: 1e11,
    },
  ];

  /**
   * log2 of the number of ordered sequences of `length` characters drawn from an
   * alphabet of `n` characters: n^length, or the falling factorial
   * n*(n-1)*...*(n-length+1) when repeats are forbidden.
   * Returns -Infinity when the sequence is impossible.
   */
  function logSequenceCount(n, length, distinct) {
    if (length < 1) return 0;
    if (n < 1) return -Infinity;
    if (!distinct) return length * Math.log2(n);
    if (n < length) return -Infinity;

    var total = 0;
    for (var i = 0; i < length; i++) {
      if (n - i < 1) return -Infinity;
      total += Math.log2(n - i);
    }
    return total;
  }

  /**
   * Exact bits of entropy for a password sampled uniformly from the set of
   * length-`length` strings over an `alphabetSize` alphabet that contain at
   * least one character from each class in `classSizes`.
   *
   * Counting strings that hit every class is inclusion-exclusion over the
   * classes: sum over subsets S of (-1)^|S| * (a - sum of a_i over S)^length.
   * Signed terms are summed in a scaled exponent space to keep precision.
   */
  function bitsForClasses(spec) {
    var alphabetSize = spec.alphabetSize;
    var classSizes = spec.classSizes || [];
    var length = spec.length;
    var distinct = !!spec.distinct;
    var k = classSizes.length;

    if (k > 12) throw new RangeError('bitsForClasses: too many classes');
    if (length < 1) return 0;

    if (k === 0) {
      var plain = logSequenceCount(alphabetSize, length, distinct);
      // An impossible request (more distinct characters than the alphabet has)
      // scores zero rather than leaking -Infinity into the interface.
      return Number.isFinite(plain) ? plain : 0;
    }

    var subsets = 1 << k;
    var terms = [];
    var maxLog = -Infinity;

    for (var mask = 0; mask < subsets; mask++) {
      var remaining = alphabetSize;
      var excluded = 0;
      for (var i = 0; i < k; i++) {
        if (mask & (1 << i)) {
          remaining -= classSizes[i];
          excluded++;
        }
      }
      if (remaining < 0) remaining = 0;
      var logCount = logSequenceCount(remaining, length, distinct);
      if (logCount === -Infinity) continue;
      terms.push({ sign: excluded % 2 === 0 ? 1 : -1, log: logCount });
      if (logCount > maxLog) maxLog = logCount;
    }

    var sum = 0;
    for (var t = 0; t < terms.length; t++) {
      sum += terms[t].sign * Math.pow(2, terms[t].log - maxLog);
    }
    if (!(sum > 0)) return 0; // unreachable for valid input; guards NaN
    return maxLog + Math.log2(sum);
  }

  /** Convenience: a passphrase of `words` words from a list of `size` words. */
  function bitsForPassphrase(words, size) {
    return words * Math.log2(size);
  }

  /** log10 of the seconds an attacker needs, averaging over half the keyspace. */
  function log10SecondsToCrack(bits, guessesPerSecond) {
    var expectedBits = Math.max(bits - 1, 0); // an attacker gets a 50% chance on average
    return expectedBits * LOG10_2 - Math.log10(guessesPerSecond);
  }

  /** Two decimal places, trailing zeros dropped. */
  function round2(value) {
    return Number(value.toFixed(2));
  }

  function withCommas(value) {
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function plural(count, word) {
    return count === 1 ? '1 ' + word : withCommas(count) + ' ' + word + 's';
  }

  /** Human duration from a base-10 logarithm of seconds. */
  function formatDurationFromLog10(log10s) {
    if (!isFinite(log10s)) return 'forever';
    if (log10s < 0) return 'instantly';

    var seconds = Math.pow(10, log10s);
    // 10^log10(x) does not always land back exactly on x, and being one
    // nanosecond short of a day boundary should not cost you a day.
    seconds = Number(seconds.toPrecision(4));
    if (seconds < 1) return 'instantly';
    if (seconds < 60) return plural(Math.max(Math.round(seconds), 1), 'second');

    var units = [
      ['minute', 60],
      ['hour', 3600],
      ['day', 86400],
      ['year', YEAR_SECONDS],
    ];
    var chosen = null;
    for (var i = 0; i < units.length; i++) {
      if (seconds >= units[i][1]) chosen = units[i];
    }

    var scaled = seconds / chosen[1];
    if (scaled < 10) return plural(Math.round(scaled), chosen[0]);
    if (scaled < 1e6) return withCommas(round2(scaled)) + ' ' + chosen[0] + 's';

    var universes = seconds / AGE_OF_UNIVERSE_SECONDS;
    if (universes < 1e6) {
      return (universes < 10 ? round2(universes) : withCommas(Math.round(universes))) +
        '× the age of the universe';
    }
    return '10^' + Math.floor(log10s - Math.log10(YEAR_SECONDS)) + ' years';
  }

  /** "1,024", "1.05 million", "1.1 x 10^39" -- a readable size for 2^bits. */
  function formatCount(bits) {
    if (bits <= 0) return '1';
    var value = Math.pow(2, bits);
    if (!isFinite(value)) return '2^' + Math.round(bits);

    // Below a million, the exact integer is clearer than "1.02 thousand".
    if (value < 1e6) return withCommas(Math.round(value));

    var chosen = null;
    for (var i = 0; i < SCALES.length; i++) {
      if (value >= SCALES[i][0]) chosen = SCALES[i];
    }

    // Past a quintillion, naming the number helps nobody. The exact bit count is
    // on screen right next to this.
    if (!chosen || value >= 1e21) {
      var exponent = Math.floor(Math.log10(value));
      return String(round2(value / Math.pow(10, exponent))) + ' × 10^' + exponent;
    }

    var scaled = value / chosen[0];
    var text = scaled < 10 ? String(round2(scaled)) : withCommas(Math.round(scaled));
    return text + ' ' + chosen[1];
  }

  /** Coarse label for the strength meter. */
  function tier(bits) {
    if (bits < 28) return { level: 0, label: 'very weak' };
    if (bits < 36) return { level: 1, label: 'weak' };
    if (bits < 60) return { level: 2, label: 'fair' };
    if (bits < 75) return { level: 3, label: 'strong' };
    if (bits < 100) return { level: 4, label: 'very strong' };
    return { level: 5, label: 'overkill' };
  }

  /** One row per attack model, ready to render. */
  function crackTimeRows(bits) {
    return ATTACK_MODELS.map(function (model) {
      return {
        id: model.id,
        label: model.label,
        detail: model.detail,
        guessesPerSecond: model.guessesPerSecond,
        seconds: formatDurationFromLog10(log10SecondsToCrack(bits, model.guessesPerSecond)),
      };
    });
  }

  PG.entropy = {
    ATTACK_MODELS: ATTACK_MODELS,
    logSequenceCount: logSequenceCount,
    bitsForClasses: bitsForClasses,
    bitsForPassphrase: bitsForPassphrase,
    log10SecondsToCrack: log10SecondsToCrack,
    formatDurationFromLog10: formatDurationFromLog10,
    formatCount: formatCount,
    tier: tier,
    crackTimeRows: crackTimeRows,
  };
})(window.PG = window.PG || {});
