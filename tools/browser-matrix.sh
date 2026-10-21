#!/bin/sh
#
# browser-matrix.sh -- run tools/browser-matrix.mjs without adding a dependency.
#
#   tools/browser-matrix.sh
#
# Playwright and its browsers are installed into a temporary directory and
# removed on exit. Nothing is written to package.json, package-lock.json or
# node_modules in the repository. This needs a network connection the first
# time, because the browser binaries are large and are not vendored.
#
# Pin the Playwright version with PLAYWRIGHT_VERSION=... if a matrix needs to be
# reproducible against a specific browser build.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
version=${PLAYWRIGHT_VERSION:-1.64.1}
scratch=$(mktemp -d "${TMPDIR:-/tmp}/passgen-playwright.XXXXXX")

cleanup() {
  rm -rf "$scratch"
}
trap cleanup EXIT INT TERM

cd "$scratch"
npm init -y >/dev/null 2>&1
npm install --no-audit --no-fund --silent "playwright@$version"
# Progress bars on stdout would corrupt the JSON the harness prints there.
./node_modules/.bin/playwright install chromium firefox webkit >&2

cp "$root/tools/browser-matrix.mjs" "$scratch/browser-matrix.mjs"
node "$scratch/browser-matrix.mjs" "$root/dist/index.html"
