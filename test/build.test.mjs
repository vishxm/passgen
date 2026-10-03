import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, copyFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distFile = join(root, 'dist', 'index.html');
const checksumFile = join(root, 'dist', 'index.html.sha256');

// `stdio` has to be explicit. Left to itself, execFileSync pipes the child's
// stderr through to our stderr, so the two tests below that deliberately break
// dist/ on purpose printed "build failed: dist/index.html is stale" into the
// middle of an otherwise clean run. It reads like a real failure and trains you
// to ignore red text.
const PIPED = { stdio: ['ignore', 'pipe', 'pipe'] };

function run(script, args = []) {
  return execFileSync(process.execPath, [join(root, 'tools', script), ...args], {
    cwd: root,
    encoding: 'utf8',
    ...PIPED,
  });
}

/**
 * Run a tool expecting it to fail, and hand back what it printed.
 *
 * Also the regression test for the stdio above: both callers match on words that
 * only ever appear on the child's stderr ("stale", "FAIL"), so if the capture were
 * dropped these would fail rather than quietly pass on an empty string.
 */
function runExpectingFailure(script, args = []) {
  try {
    run(script, args);
  } catch (err) {
    return String(err.stdout || '') + String(err.stderr || '');
  }
  assert.fail(script + ' was expected to fail but succeeded');
}

test('the build is reproducible: same input, byte-identical output', () => {
  const before = readFileSync(distFile);
  run('build.mjs');
  const after = readFileSync(distFile);
  assert.ok(before.equals(after), 'rebuilding changed the output; something non-deterministic leaked in');
});

test('the verifier passes on a fresh build', () => {
  run('build.mjs');
  const output = run('verify.mjs');
  assert.match(output, /all \d+ checks passed/);
  assert.doesNotMatch(output, /FAIL/);
});

test('the build refuses to run from a stale dist', () => {
  const backup = distFile + '.bak';
  copyFileSync(distFile, backup);
  try {
    writeFileSync(distFile, readFileSync(distFile, 'utf8') + '\n<!-- tampered -->\n');
    const output = runExpectingFailure('build.mjs', ['--check']);
    assert.match(output, /stale/);
  } finally {
    copyFileSync(backup, distFile);
    unlinkSync(backup);
  }
});

test('the checksum file matches the built file', () => {
  assert.ok(existsSync(checksumFile), 'dist/index.html.sha256 should be committed');
  const recorded = readFileSync(checksumFile, 'utf8').trim().split(/\s+/)[0];
  const actual = createHash('sha256').update(readFileSync(distFile)).digest('hex');
  assert.equal(recorded, actual);
});

test('the verifier notices a tampered script', () => {
  const backup = distFile + '.bak';
  copyFileSync(distFile, backup);
  try {
    const tampered = readFileSync(distFile, 'utf8').replace('PG.BUILD', 'PG.BUILDX');
    writeFileSync(distFile, tampered);
    const output = runExpectingFailure('verify.mjs');
    assert.match(output, /FAIL/);
    assert.match(output, /script hash matches the policy/);
  } finally {
    copyFileSync(backup, distFile);
    unlinkSync(backup);
  }
});

test('the built page is self-contained: one file, no fetches', () => {
  const html = readFileSync(distFile, 'utf8');
  assert.equal((html.match(/<script/g) || []).length, 1);
  assert.equal((html.match(/<style/g) || []).length, 1);
  assert.ok(!/<script[^>]+\ssrc=/.test(html), 'no external scripts');
  assert.ok(!/<link[^>]+stylesheet/.test(html), 'no external stylesheets');
  assert.ok(!/<img/.test(html), 'no images at all');
  assert.ok(!/@font-face/.test(html), 'no web fonts');
  assert.ok(!/<iframe/.test(html), 'no frames');
  assert.ok(!/Math\.random/.test(html.replace(/\/\*[\s\S]*?\*\//g, '')), 'no Math.random in code');
});

test('the policy in the built page denies every network directive', () => {
  const html = readFileSync(distFile, 'utf8');
  const policy = html.match(/content="(default-src[^"]+)"/)[1];
  const directives = Object.fromEntries(
    policy.split(';').map((part) => {
      const pieces = part.trim().split(/\s+/);
      return [pieces[0], pieces.slice(1)];
    })
  );

  assert.deepEqual(directives['default-src'], ["'none'"]);
  assert.deepEqual(directives['connect-src'], ["'none'"]);
  assert.deepEqual(directives['form-action'], ["'none'"]);
  assert.deepEqual(directives['base-uri'], ["'none'"]);
  // img-src says `data:` positively rather than mixing 'none' with a source,
  // which per spec would void the directive and re-allow remote images.
  assert.deepEqual(directives['img-src'], ['data:']);
  for (const directive of ['font-src', 'media-src', 'object-src', 'frame-src', 'worker-src', 'manifest-src']) {
    assert.deepEqual(directives[directive], ["'none'"], directive);
  }
  // 'none' must never appear beside another source expression.
  for (const [name, values] of Object.entries(directives)) {
    assert.ok(!(values.includes("'none'") && values.length > 1), name + ' mixes none with ' + values.join(' '));
  }
  assert.equal(directives['script-src'].length, 1, 'exactly one script hash and nothing else');
  assert.equal(directives['style-src'].length, 1, 'exactly one style hash and nothing else');
  assert.ok(!policy.includes('unsafe-inline'));
  assert.ok(!policy.includes('unsafe-eval'));
});

test('every element id the script reaches for exists in the page', () => {
  const html = readFileSync(distFile, 'utf8');
  const markup = html.slice(0, html.indexOf('<script>'));
  const ids = new Set([...markup.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

  const script = html.slice(html.indexOf('<script>'));
  const wanted = new Set([...script.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]));
  // $('id') is the same lookup written differently.
  for (const match of script.matchAll(/\$\('([^']+)'\)/g)) wanted.add(match[1]);

  const missing = [...wanted].filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], 'the script looks up element ids that are not in the markup');
  assert.ok(wanted.size > 30, 'expected the script to reference many controls, saw ' + wanted.size);
});

test('every id in the markup is filled by the script', () => {
  // The other direction, and the one that has bitten: an id the script never
  // mentions renders as a permanently blank box under a heading that promises
  // something. That is how "Policy in force" shipped empty.
  //
  // The exceptions are ids that exist to be read by a label or to carry static
  // prose, so there is nothing for the script to do with them.
  const NEVER_FILLED = new Set([
    'secret-heading', 'settings-heading', 'trust-heading', // aria-labelledby targets
    'exclude-hint', 'custom-hint', // static explanatory prose
  ]);

  const html = readFileSync(distFile, 'utf8');
  const markup = html.slice(0, html.indexOf('<script>'));
  const script = html.slice(html.indexOf('<script>'));

  const ids = [...markup.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const orphans = ids.filter((id) => !NEVER_FILLED.has(id) && !script.includes("'" + id + "'"));

  assert.deepEqual(orphans, [], 'these ids are in the markup but nothing in the script touches them');
});

test('the word list is embedded whole', () => {
  const html = readFileSync(distFile, 'utf8');
  const raw = html.match(/var RAW =\s*'([a-z\s-]*)';/);
  assert.ok(raw, 'the word list should be embedded as a string');
  const words = raw[1].trim().split(/\s+/);
  assert.equal(words.length, 7776);
  assert.equal(new Set(words).size, 7776);
});

test('the page does not reference any server', () => {
  const html = readFileSync(distFile, 'utf8');
  const markup = html.slice(0, html.indexOf('<script>'));
  assert.deepEqual(markup.match(/https?:\/\/\S+/g) || [], [], 'the markup should name no URL');
});

test('package.json declares no dependencies', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies, {});
  assert.deepEqual(pkg.devDependencies, {});
});
