/*
 * random.js -- cryptographically secure randomness, without modulo bias.
 *
 * Every value produced here comes from crypto.getRandomValues(). Math.random()
 * is never used, and `% n` is never applied to an unbounded random draw: a raw
 * byte mod n is biased whenever n does not divide 256, which quietly weakens
 * every character position. We use rejection sampling instead.
 */
(function (PG) {
  'use strict';

  var MAX_UINT32 = 0x100000000; // 2^32, one past the largest usable value

  /**
   * Uniform integer in [0, n) for 1 <= n <= 2^32.
   *
   * Draws the smallest whole number of bytes that can express n, then throws
   * away any draw that falls in the ragged tail [limit, 2^bits) where the
   * modulo mapping would be uneven. Expected retries: < 1 in 65,536 for every
   * alphabet size this app can produce.
   */
  function randomInt(n) {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n >= MAX_UINT32) {
      throw new RangeError('randomInt: n must be an integer in [1, 2^32), got ' + n);
    }
    if (n === 1) return 0;

    var bits = 32 - Math.clz32(n - 1); // smallest k such that n <= 2^k
    var width = (bits + 7) >>> 3; // bytes per draw: 1..4
    var range = width === 4 ? MAX_UINT32 : Math.pow(2, width * 8);
    var limit = range - (range % n); // largest multiple of n that fits

    var buf = new Uint8Array(width);
    var view = new DataView(buf.buffer);

    for (;;) {
      crypto.getRandomValues(buf);
      var draw;
      if (width === 4) draw = view.getUint32(0);
      else if (width === 3) draw = buf[0] * 0x10000 + buf[1] * 0x100 + buf[2];
      else if (width === 2) draw = view.getUint16(0);
      else draw = buf[0];

      if (draw < limit) return draw % n;
    }
  }

  /**
   * `length` distinct elements, uniformly chosen and uniformly ordered.
   * Partial Fisher-Yates over a copy: O(length) entropy, O(n) time.
   */
  function sampleDistinct(items, length) {
    if (length > items.length) {
      throw new RangeError('sampleDistinct: cannot take ' + length + ' of ' + items.length);
    }
    var pool = items.slice();
    for (var i = 0; i < length; i++) {
      var j = i + randomInt(pool.length - i);
      var tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
    }
    return pool.slice(0, length);
  }

  /** `length` elements drawn uniformly with replacement. */
  function sampleWithReplacement(items, length) {
    var out = new Array(length);
    var n = items.length;
    for (var i = 0; i < length; i++) out[i] = items[randomInt(n)];
    return out;
  }

  /** One uniformly random element. */
  function pick(items) {
    return items[randomInt(items.length)];
  }

  PG.random = {
    randomInt: randomInt,
    sampleDistinct: sampleDistinct,
    sampleWithReplacement: sampleWithReplacement,
    pick: pick,
  };
})(window.PG = window.PG || {});
