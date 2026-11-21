/*
 * source-digest.mjs -- the one hash that names a build's inputs.
 *
 * The digest covers VERSION, the HTML template, and every script and stylesheet
 * in load order. It is deliberately a pure function so the build and the
 * verifier can call the same code against the same bytes: if either side omitted
 * an input (as the build once omitted the template and VERSION), a change to that
 * input would not move the digest and two different artifacts could advertise
 * the same source.
 *
 * NUL separators make the boundary between a path and its contents explicit, and
 * `files` is taken in order so swapping two files changes the digest.
 */
import { createHash } from 'node:crypto';

export const VERSION = '1.0.0';

// Load order matters: each file attaches itself to the shared PG namespace, and
// generators.js reads random.js at call time, controls.js reads generators.js at
// load time, app.js reads everything.
export const SCRIPTS = [
  'lib/random.js',
  'lib/entropy.js',
  'lib/generators.js',
  'lib/wordlist.js',
  'lib/integrity.js',
  'lib/controls.js',
  'app.js',
];

// The stylesheets a build concatenates, in order. One, because there is one design.
export const STYLES = ['styles.css'];

export function computeSourceDigest({ version, template, files }) {
  const hash = createHash('sha256');
  hash.update('VERSION\0' + version + '\0', 'utf8');
  hash.update('src/index.html\0' + template + '\0', 'utf8');
  for (const { rel, text } of files) {
    hash.update(rel, 'utf8');
    hash.update('\0', 'utf8');
    hash.update(text, 'utf8');
    hash.update('\0', 'utf8');
  }
  return hash.digest('hex');
}
