/*
 * serve.test.mjs -- the preview command must not publish the repository.
 *
 * `python3 -m http.server 8080` serves the package root on every interface,
 * which puts .git/, src/, test/ and any ignored file on the network. The
 * documented preview is the built page only, on loopback. This is a static
 * assertion so the suite does not need Python; `npm run serve` plus the
 * lsof/curl checks in the pull request are the manual acceptance.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('the preview serves only dist/ on loopback', () => {
  assert.match(pkg.scripts.serve, /--directory\s+dist\b/);
  assert.match(pkg.scripts.serve, /--bind\s+127\.0\.0\.1\b/);
  assert.doesNotMatch(pkg.scripts.serve, /0\.0\.0\.0/, 'the default must not listen on every interface');
});
