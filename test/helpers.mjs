/*
 * helpers.mjs -- load the browser-shaped source files into Node.
 *
 * src/lib/*.js attach themselves to a `window.PG` namespace so the build can
 * concatenate them into one classic <script>. There is no window in Node, so we
 * compile them in this realm with `window` bound to a plain object and hand back
 * the namespace. Compiling in-realm (rather than in a vm context) keeps
 * prototypes identical to the test's own, so deepStrictEqual behaves.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'src');

/**
 * @param {string[]} files   paths under src/, in load order
 * @param {object}  [fake]   stands in for crypto, for tests that need the
 *                           generator's randomness to be predictable
 */
export function loadPG(files, fake) {
  const code = files
    .map((rel) => readFileSync(join(srcDir, rel), 'utf8'))
    .join('\n');

  const compile = new Function('window', 'crypto', code + '\n;return window.PG;');
  return compile({}, fake || globalThis.crypto);
}

/**
 * A crypto whose every draw is the same value.
 *
 * rejection sampling rejects a draw that falls in the ragged tail of the range,
 * so a constant draw can spin forever if it lands there. The byte below is 0,
 * which is inside the limit for every alphabet size this app produces, so it
 * resolves on the first try and `randomInt(n)` always answers 0.
 */
export function constantCrypto(byte = 0) {
  return {
    getRandomValues(buffer) {
      buffer.fill(byte);
      return buffer;
    },
  };
}

export function loadRandom() {
  return loadPG(['lib/random.js']);
}

export function loadEntropy() {
  return loadPG(['lib/entropy.js']);
}

export function loadGenerators() {
  return loadPG(['lib/random.js', 'lib/entropy.js', 'lib/generators.js']);
}

export function loadControls() {
  return loadPG(['lib/random.js', 'lib/entropy.js', 'lib/generators.js', 'lib/wordlist.js', 'lib/controls.js']);
}

/**
 * The pure half of the page: randomness, entropy, the generators, the word list,
 * and the control rules.
 *
 * src/lib/integrity.js needs a DOM and is loaded against the stub in
 * test/dom-stub.mjs instead; src/app.js is thin wiring over these two and is
 * covered by the build tests, which check the ids it reaches for exist.
 */
export function loadCore() {
  return loadPG([
    'lib/random.js',
    'lib/entropy.js',
    'lib/generators.js',
    'lib/wordlist.js',
    'lib/controls.js',
  ]);
}
