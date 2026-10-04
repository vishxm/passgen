/*
 * build.mjs -- inline everything into one hash-locked HTML file.
 *
 *   node tools/build.mjs                    build dist/index.html
 *   node tools/build.mjs --check            build into memory and diff against dist
 *   node tools/build.mjs --out=/tmp/x.html  write somewhere else
 *
 * There are no dependencies here on purpose: the build must be as auditable as
 * the thing it produces. It reads src/, concatenates the scripts into a single
 * classic <script>, computes the SHA-256 of that script and of the stylesheet,
 * and writes the hashes into the page's Content-Security-Policy. Nothing in the
 * output can change without the page refusing to run.
 *
 * One stylesheet, one build path. There used to be a theme registry and a second
 * output directory; both existed only to let five designs be compared, and the
 * comparison is over.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, isAbsolute, resolve } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'src');
const outDir = join(root, 'dist');
const outFile = join(outDir, 'index.html');
const checksumFile = join(outDir, 'index.html.sha256');

const VERSION = '1.0.0';

// Load order matters: each file attaches itself to the shared PG namespace, and
// generators.js reads random.js at call time, controls.js reads generators.js at
// load time, app.js reads everything.
const SCRIPTS = [
  'lib/random.js',
  'lib/entropy.js',
  'lib/generators.js',
  'lib/wordlist.js',
  'lib/integrity.js',
  'lib/controls.js',
  'app.js',
];

// The stylesheets a build concatenates, in order. One, because there is one design.
const STYLES = ['styles.css'];

/** Substrings that must never appear in the output, with the reason. */
const FORBIDDEN = [
  ['Math.random', 'randomness must come from crypto.getRandomValues'],
  ['innerHTML', 'generated text must never become markup'],
  ['outerHTML', 'generated text must never become markup'],
  ['insertAdjacentHTML', 'generated text must never become markup'],
  ['document.write', 'the page has no reason to write markup'],
  ['eval(', 'no dynamic evaluation'],
  ['new Function(', 'no dynamic evaluation'],
  ['unsafe-inline', 'would defeat the policy this page is built on'],
  ['unsafe-eval', 'would defeat the policy this page is built on'],
];

/**
 * Substrings no stylesheet may contain. The policy says font-src 'none' and
 * img-src data:, and the page has to stay a single file -- so a webfont, an
 * imported sheet or any url() at all can only be a mistake, and each one would
 * degrade silently into a refused request rather than into an error.
 */
const CSS_FORBIDDEN = [
  ['@font-face', 'font-src is \'none\' in the policy; the page is system fonts only'],
  ['@import', 'the page has to stay one file'],
  ['url(', 'ornament must be gradients, borders and pseudo-elements; url() is a fetch the policy will refuse'],
];

/** Network calls are legitimate in exactly one file: the self-test. */
const NETWORK_CALLS = [
  'fetch(', 'new XMLHttpRequest', 'new WebSocket', '.sendBeacon(', 'import(',
  'new Image(', 'new Worker(', 'new SharedWorker(', 'new EventSource(',
  'new RTCPeerConnection(', 'navigator.serviceWorker.register',
];
const NETWORK_ALLOWED_IN = new Set(['lib/integrity.js']);

// ------------------------------------------------------------------ options

/**
 * Hand-parsed flags rather than node:util. There are two of them and one of
 * them takes a value, and an options parser would be more machinery than the
 * thing it parses.
 *
 *   --check          verify the file on disk instead of writing it
 *   --out=<path>     write somewhere else
 */
const argv = process.argv.slice(2);

function switchOn(name) {
  return argv.includes(name);
}

function valueOf(name) {
  const prefix = '--' + name + '=';
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found === undefined ? null : found.slice(prefix.length);
}

function unknownFlags() {
  return argv.filter((arg) => {
    if (!arg.startsWith('--')) return true;
    if (arg === '--check') return false;
    return !/^--out=.+$/.test(arg);
  });
}

const outArg = valueOf('out');

if (unknownFlags().length) {
  console.error('\n  build failed: unrecognised argument ' + unknownFlags().map((a) => '"' + a + '"').join(', '));
  console.error('  usage: build.mjs [--check] [--out=<path>]\n');
  process.exit(1);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest();
}

function read(relPath) {
  return readFileSync(join(srcDir, relPath), 'utf8');
}

function fail(message) {
  console.error('\n  build failed: ' + message + '\n');
  process.exit(1);
}

/**
 * Source lines with comment lines removed, so that prose like "we never call
 * Math.random" in a header comment does not trip the scan below.
 */
function codeOf(text) {
  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed && !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
    })
    .join('\n');
}

// ------------------------------------------------------------------ assemble

/**
 * Build the page and either write it or check it. Returns the figures the caller
 * prints.
 */
function build({ check }) {
  const target = outArg ? (isAbsolute(outArg) ? outArg : resolve(root, outArg)) : outFile;
  const checksum = outArg ? target + '.sha256' : checksumFile;
  const label = relative(root, target) || 'index.html';

  const template = read('index.html');
  const sources = new Map();

  for (const rel of SCRIPTS) {
    if (!existsSync(join(srcDir, rel))) fail('missing src/' + rel);
    sources.set(rel, read(rel));
  }
  for (const rel of STYLES) {
    if (!existsSync(join(srcDir, rel))) fail('missing src/' + rel);
    sources.set(rel, read(rel));
  }

  // ---------------------------------------------------------------- digest

  // The source digest covers every input file, path included, in load order. It
  // is what the page displays so you can tell which build you are looking at.
  const digestHash = createHash('sha256');
  for (const rel of [...SCRIPTS, ...STYLES]) {
    digestHash.update(rel, 'utf8');
    digestHash.update('\0', 'utf8');
    digestHash.update(sources.get(rel), 'utf8');
    digestHash.update('\0', 'utf8');
  }
  const sourceDigest = digestHash.digest('hex');

  // ---------------------------------------------------------------- banner

  const banner = [
    '/* passgen ' + VERSION + ' -- generated by tools/build.mjs, do not edit by hand.',
    ' * source digest: ' + sourceDigest,
    ' * Edit src/ and run: npm run build',
    ' */',
    'var PG = window.PG = window.PG || {};',
    'PG.BUILD = {',
    '  version: ' + JSON.stringify(VERSION) + ',',
    '  sourceDigest: ' + JSON.stringify(sourceDigest) + ',',
    '  builtFrom: ' + JSON.stringify(SCRIPTS.concat(STYLES)) + ',',
    '};',
  ].join('\n');

  const scriptBody = SCRIPTS.map((rel) => '/* ---- src/' + rel + ' ---- */\n' + sources.get(rel)).join('\n');
  // The leading and trailing newlines are part of the hashed text, which lets
  // verify.mjs recover the exact bytes by slicing between <script> and </script>.
  const scriptText = '\n(function () {\n\'use strict\';\n\n' + banner + '\n\n' + scriptBody + '\n})();\n';
  const styleText = '\n' + STYLES.map((rel) => sources.get(rel)).join('\n') + '\n';

  // ---------------------------------------------------------------- policy

  const policy = [
    "default-src 'none'",
    "script-src 'sha256-" + sha256(Buffer.from(scriptText, 'utf8')).toString('base64') + "'",
    "style-src 'sha256-" + sha256(Buffer.from(styleText, 'utf8')).toString('base64') + "'",
    "connect-src 'none'",
    // Not 'img-src none data:'. Per CSP, 'none' must be the only source
    // expression in a directive; add another and browsers ignore the whole thing,
    // which would quietly re-allow remote images. Saying `data:` positively means
    // the same thing correctly: images may only be inline bytes. It exists for the
    // empty <link rel="icon" href="data:,"> in the markup, because without it Gecko
    // asks the host for /favicon.ico and adds a request to every page load.
    "img-src data:",
    "font-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    // frame-ancestors is deliberately absent: browsers ignore it in a <meta> tag,
    // so including it would only produce a console warning. If this file is ever
    // served from a host, add `frame-ancestors 'none'` as a real header there.
  ].join('; ');

  let html = template
    .replace('{{CSP}}', policy)
    .replace(/\{\{VERSION\}\}/g, VERSION)
    .replace(/\{\{SOURCE_DIGEST\}\}/g, sourceDigest)
    .replace('<!--{{STYLE}}-->', '<style>' + styleText + '</style>')
    .replace('<!--{{SCRIPT}}-->', '<script>' + scriptText + '</script>');

  // ---------------------------------------------------------------- checks

  const templateProblems = [
    [/\son[a-z]+\s*=\s*["']/i, 'inline event handler'],
    [/\sstyle\s*=\s*["']/i, 'style attribute (blocked by our own policy)'],
    [/<script[^>]+\ssrc\s*=/i, 'external script'],
    [/<link[^>]+stylesheet/i, 'external stylesheet'],
    [/https?:\/\//i, 'absolute URL in the markup'],
  ];
  for (const [pattern, label2] of templateProblems) {
    if (pattern.test(template)) fail('template contains a ' + label2 + ', matched by ' + pattern);
  }

  for (const [needle, reason] of FORBIDDEN) {
    for (const rel of SCRIPTS) {
      if (codeOf(sources.get(rel)).includes(needle)) {
        fail('src/' + rel + ' contains "' + needle + '" -- ' + reason);
      }
    }
  }

  for (const rel of SCRIPTS) {
    if (!NETWORK_ALLOWED_IN.has(rel)) {
      for (const call of NETWORK_CALLS) {
        if (sources.get(rel).includes(call)) {
          fail('src/' + rel + ' contains a network call ("' + call.trim() + '"); only the self-test may do that');
        }
      }
    }
  }

  for (const rel of STYLES) {
    const code = codeOf(sources.get(rel));
    for (const [needle, reason] of CSS_FORBIDDEN) {
      if (code.includes(needle)) {
        fail('src/' + rel + ' contains "' + needle + '" -- ' + reason);
      }
    }
  }

  if (/\{\{/.test(html)) fail('a template placeholder was left unreplaced');
  if (!html.includes(policy)) fail('the policy did not survive substitution');

  // ---------------------------------------------------------------- write

  const output = Buffer.from(html, 'utf8');
  const fileHash = sha256(output).toString('hex');

  if (check) {
    if (!existsSync(target)) fail(label + ' does not exist');
    const current = readFileSync(target);
    if (!current.equals(output)) {
      fail(label + ' is stale. Run: npm run build');
    }
    return { label, check: true, fileHash, sourceDigest, scriptText, styleText, policy, size: output.length };
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, output);
  writeFileSync(checksum, fileHash + '  index.html\n');

  return { label, check: false, fileHash, sourceDigest, scriptText, styleText, policy, size: output.length };
}

function report(built) {
  const kb = (bytes) => (bytes / 1024).toFixed(1) + ' KB';

  if (built.check) {
    console.log(built.label + ' is up to date.');
    console.log('  sha256 ' + built.fileHash);
    return;
  }

  console.log('built ' + built.label);
  console.log('  source digest  ' + built.sourceDigest);
  console.log('  file sha256    ' + built.fileHash);
  console.log('  stylesheet     styles.css');
  console.log('  size           ' + kb(built.size) + ' (' + kb(built.scriptText.length) + ' script, ' + kb(built.styleText.length) + ' css)');
  console.log('  policy         ' + built.policy.length + ' chars, ' + built.policy.split(';').length + ' directives');
}

// ------------------------------------------------------------------- drive

report(build({ check: switchOn('--check') }));

if (!outArg) {
  console.log('');
  console.log('  open dist/index.html by double-clicking it, or serve it, or read it.');
}