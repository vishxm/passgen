/*
 * verify.mjs -- audit dist/index.html without trusting tools/build.mjs.
 *
 *   node tools/verify.mjs
 *
 * Everything here is re-derived from the files on disk: the policy is parsed out
 * of the built HTML, the inline script and stylesheet are sliced back out of it,
 * and their SHA-256 hashes are recomputed and compared. If any of it disagrees
 * with what the page claims, the page is lying and this exits non-zero.
 *
 * It also re-checks the claims the page makes about itself: no Math.random, no
 * network calls outside the self-test, no absolute URLs, no inline handlers. And
 * it re-derives the page from src/ to catch the failure mode where the source is
 * fixed and the built file is not: every check below would still pass, because
 * they audit the file that is actually there.
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const results = [];

function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, pass: true, detail: detail || '' });
  } catch (err) {
    results.push({ name, pass: false, detail: err.message });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest();
}

/** Slice the single inline <script> body out of the built page. */
function sliceTag(html, tag) {
  const open = '<' + tag + '>';
  const close = '</' + tag + '>';
  const start = html.indexOf(open);
  assert(start !== -1, 'no <' + tag + '> element found');
  const end = html.indexOf(close, start);
  assert(end !== -1, 'no ' + close + ' found');
  assert(html.indexOf(open, start + open.length) === -1, 'more than one <' + tag + '> element');
  return html.slice(start + open.length, end);
}

function parsePolicy(html) {
  const match = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  assert(match, 'no Content-Security-Policy meta tag');
  const directives = new Map();
  for (const part of match[1].split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const pieces = trimmed.split(/\s+/);
    directives.set(pieces[0], pieces.slice(1));
  }
  return { raw: match[1], directives };
}

// ------------------------------------------------------------------- run

/**
 * The whole audit, run against the built page. Kept as a function rather than
 * inlined so that the early return below is readable: if dist/ is missing there
 * is nothing left to audit, and the report says so rather than throwing.
 */
function audit() {
const distFile = join(root, 'dist', 'index.html');
const checksumFile = distFile + '.sha256';
const label = 'dist/index.html';

check(label + ' exists', () => {
  assert(existsSync(distFile), 'run: npm run build');
  return 'found';
});

if (!existsSync(distFile)) {
  return report();
}

/**
 * The staleness gate. Everything else in this file audits the bytes on disk, so
 * a dist/ left behind by an earlier build would sail through all of it while the
 * page you are looking at is not the page the source describes. This rebuilds
 * into memory and compares.
 */
check(label + ' matches the current source', () => {
  try {
    execFileSync(process.execPath, [join(root, 'tools', 'build.mjs'), '--check'], {
      cwd: root,
      encoding: 'utf8',
    });
  } catch (err) {
    throw new Error(label + ' is stale -- run: npm run build');
  }
  return 'rebuilt from src/ and byte-identical';
});

const html = readFileSync(distFile, 'utf8');
const scriptText = sliceTag(html, 'script');
const styleText = sliceTag(html, 'style');
const policy = parsePolicy(html);

check('policy denies the network', () => {
  assert(policy.directives.has('connect-src'), 'connect-src is missing');
  assert(policy.directives.get('connect-src').includes("'none'"), "connect-src is not 'none'");
  for (const directive of ['font-src', 'media-src', 'object-src', 'frame-src', 'worker-src', 'manifest-src']) {
    assert(policy.directives.get(directive)?.includes("'none'"), directive + " is not 'none'");
  }
  // img-src says `data:` rather than `'none' data:`: only inline images, nothing
  // fetchable. See the note in build.mjs.
  const img = policy.directives.get('img-src') || [];
  assert(img.length === 1 && img[0] === 'data:', 'img-src should be exactly data:, found ' + JSON.stringify(img));
  return 'connect-src, font-src, img-src and the rest are denied';
});

check("no directive mixes 'none' with other sources", () => {
  // Per CSP, 'none' alongside any other source expression voids the whole
  // directive, so img-src 'none' data: would silently allow remote images.
  const offenders = [];
  for (const [name, values] of policy.directives) {
    if (values.includes("'none'") && values.length > 1) {
      offenders.push(name + ' = ' + values.join(' '));
    }
  }
  assert(offenders.length === 0, 'these directives would be ignored: ' + offenders.join('; '));
  return policy.directives.size + ' directives, each internally consistent';
});

check('policy defaults to nothing', () => {
  assert(policy.directives.get('default-src')?.includes("'none'"), "default-src is not 'none'");
  return "default-src 'none'";
});

check('policy forbids inline and eval', () => {
  for (const [name, values] of policy.directives) {
    assert(!values.includes("'unsafe-inline'"), name + " allows 'unsafe-inline'");
    assert(!values.includes("'unsafe-eval'"), name + " allows 'unsafe-eval'");
  }
  return 'no unsafe sources anywhere';
});

function declaredHash(directive) {
  const values = policy.directives.get(directive) || [];
  return values
    .map((value) => value.replace(/^'|'$/g, ''))
    .filter((value) => value.startsWith('sha256-'));
}

check('script hash matches the policy', () => {
  const hashes = declaredHash('script-src');
  assert(hashes.length === 1, 'expected exactly one script hash, found ' + hashes.length);
  const actual = 'sha256-' + sha256(Buffer.from(scriptText, 'utf8')).toString('base64');
  assert(hashes[0] === actual, 'script was modified after the policy was written');
  return actual.slice(0, 26) + '...';
});

check('stylesheet hash matches the policy', () => {
  const hashes = declaredHash('style-src');
  assert(hashes.length === 1, 'expected exactly one style hash, found ' + hashes.length);
  const actual = 'sha256-' + sha256(Buffer.from(styleText, 'utf8')).toString('base64');
  assert(hashes[0] === actual, 'stylesheet was modified after the policy was written');
  return actual.slice(0, 26) + '...';
});

check('checksum file matches the file', () => {
  assert(existsSync(checksumFile), label + '.sha256 is missing');
  const recorded = readFileSync(checksumFile, 'utf8').trim().split(/\s+/)[0];
  const actual = sha256(Buffer.from(html, 'utf8')).toString('hex');
  assert(recorded === actual, label + ' has changed since it was built');
  return actual.slice(0, 32) + '...';
});

check('source digest is consistent', () => {
  const inHtml = html.match(/<meta name="generator" content="passgen ([^ ]+) · source ([a-f0-9]{64})">/);
  assert(inHtml, 'generator meta tag is missing or malformed');
  const inScript = scriptText.match(/sourceDigest: "([a-f0-9]{64})"/);
  assert(inScript, 'the script does not declare a source digest');
  assert(inHtml[2] === inScript[1], 'the page and the script disagree about the source digest');
  return inScript[1].slice(0, 32) + '... (passgen ' + inHtml[1] + ')';
});

check('no external references', () => {
  const offenders = [];
  if (/<script[^>]+\ssrc\s*=/i.test(html)) offenders.push('external <script src>');
  if (/<link[^>]+stylesheet/i.test(html)) offenders.push('external stylesheet');
  if (/<img[^>]+\ssrc\s*=\s*["'](?!data:)/i.test(html)) offenders.push('remote <img>');
  if (/@import/i.test(styleText)) offenders.push('@import in the stylesheet');
  if (/url\(\s*["']?(?!data:)[a-z]+:/i.test(styleText)) offenders.push('url() in the stylesheet');
  assert(offenders.length === 0, 'found: ' + offenders.join(', '));
  return 'no scripts, styles, images or fonts are fetched';
});

check('no inline handlers or style attributes', () => {
  const body = html.replace(/<script>[\s\S]*?<\/script>/, '').replace(/<style>[\s\S]*?<\/style>/, '');
  assert(!/\son[a-z]+\s*=\s*["']/i.test(body), 'found an inline event handler');
  assert(!/\sstyle\s*=\s*["']/i.test(body), 'found a style attribute');
  return 'the policy would block both anyway';
});

check('randomness comes from the CSPRNG', () => {
  const code = scriptText
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed && !trimmed.startsWith('*') && !trimmed.startsWith('//');
    })
    .join('\n');
  assert(!code.includes('Math.random'), 'Math.random is called somewhere');
  assert(code.includes('crypto.getRandomValues'), 'crypto.getRandomValues is never called');
  return 'crypto.getRandomValues only';
});

check('network calls are confined to the self-test', () => {
  const selfTest = scriptText.slice(scriptText.indexOf('lib/integrity.js ---- */'));
  const elsewhere = scriptText.slice(0, scriptText.indexOf('lib/integrity.js ---- */'));
  const calls = ['fetch(', 'new XMLHttpRequest', 'new WebSocket', '.sendBeacon(', 'new Image(', 'import('];
  const found = calls.filter((call) => elsewhere.includes(call));
  assert(found.length === 0, 'outside the self-test: ' + found.join(', '));
  return 'only lib/integrity.js can reach the network, and only to attempt a blocked probe';
});

check('no dynamic code evaluation', () => {
  const code = scriptText
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed && !trimmed.startsWith('*') && !trimmed.startsWith('//');
    })
    .join('\n');
  for (const needle of ['eval(', 'new Function(', 'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
    assert(!code.includes(needle), 'found ' + needle);
  }
  return 'no eval, no Function, no HTML string building';
});

check('word list is intact', () => {
  const match = scriptText.match(/var RAW =\s*'([a-z\s-]*)';/);
  assert(match, 'the embedded word list is missing');
  const words = match[1].trim().split(/\s+/);
  assert(words.length === 7776, 'expected 7776 words, found ' + words.length);
  assert(new Set(words).size === 7776, 'the word list contains duplicates');
  assert(/^abacus$/.test(words[0]) && /^zoom$/.test(words[words.length - 1]), 'the list is not the EFF long list');
  return '7776 unique words, abacus ... zoom';
});

check('no absolute URLs in the page', () => {
  const body = html.replace(/<script>[\s\S]*?<\/script>/, '');
  const urls = body.match(/https?:\/\/[^\s"'<>)]+/g) || [];
  assert(urls.length === 0, 'found: ' + urls.join(', '));
  return 'the markup names no server';
});

check('the stylesheet fetches nothing', () => {
  // Stricter than the build guard on purpose: the build fails on the source, and
  // this fails on the bytes that shipped. A stray url() would degrade into a
  // refused request and a console line nobody reads, rather than into a build
  // failure anyone sees.
  const offenders = [];
  if (/@font-face/i.test(styleText)) offenders.push('@font-face, but font-src is \'none\'');
  if (/@import/i.test(styleText)) offenders.push('@import');
  if (/url\(/i.test(styleText)) offenders.push('url()');
  assert(offenders.length === 0, 'found: ' + offenders.join(', '));
  return 'no faces, no imports, no url() of any kind';
});

return report();
}

// ---------------------------------------------------------------- report

function report() {
  const failed = results.filter((r) => !r.pass);
  const pad = Math.max(...results.map((r) => r.name.length));

  console.log('\n  verifying dist/index.html\n');
  for (const result of results) {
    const mark = result.pass ? '[32mPASS[0m' : '[31mFAIL[0m';
    console.log('  ' + mark + '  ' + result.name.padEnd(pad) + (result.detail ? '  ' + result.detail : ''));
  }
  console.log('');
  if (failed.length) {
    console.log('  ' + failed.length + ' of ' + results.length + ' checks failed.\n');
  } else {
    console.log('  all ' + results.length + ' checks passed.\n');
  }
  return failed.length === 0;
}

// ------------------------------------------------------------------ drive

process.exit(audit() ? 0 : 1);
