# Agent rules

passgen is one static page. `src/` is built into a single, hash-locked
`dist/index.html` that must work from `file://`, offline, with no server. Three
constraints decide most of the answers here:

- **No dependencies.** `dependencies` and `devDependencies` are empty, and CI
  fails if `package-lock.json` appears. Do not add a package to solve a problem
  the standard library already solves.
- **No network, no storage.** The built page's CSP allows only the hashes of its
  own inlined script and stylesheet; `connect-src 'none'`. Generated text never
  becomes markup, and randomness never comes from `Math.random`.
- **No dark mode, no settings, no memory.** A theme toggle that remembered itself
  would write to `localStorage` and turn the page's own "nothing is stored"
  self-test red.

## Commands

```sh
npm run build     # src/** -> dist/index.html + dist/index.html.sha256
npm test          # pretest runs build --check, so a stale dist/ fails first
npm run verify    # audits the built file against its own claims
npm run check     # build + test + verify -- the gate CI runs
npm run serve     # preview dist/ on 127.0.0.1:8080, loopback only
```

- `npm run wordlist` regenerates `src/lib/wordlist.js`, and only after replacing
  `src/data/eff_large_wordlist.txt`.
- `tools/browser-matrix.sh` runs the optional Playwright matrix against `dist/`.
  It installs Playwright into a temporary directory (network on first run) and
  writes nothing into the repository.
- Node 22 is the floor for the tooling; `engines` pins 24.x for hosts. See
  *Tests* for why the floor is not a preference.

## The built file is the artifact

`dist/index.html` and `dist/index.html.sha256` are committed. Never edit them by
hand. `npm run build` rewrites both, and CI runs `git diff --exit-code -- dist/`,
so a source change committed without a rebuild fails.

Any edit to `src/**` or `tools/**` that changes output needs, in the same commit:

1. `npm run build`
2. `npm run check`
3. the rebuilt `dist/` files

Both `npm test` (via `pretest`) and `npm run verify` refuse to run against a
stale `dist/`. That is the gate working, not a bug: every other check audits the
bytes on disk, so a stale artifact would pass them while no longer describing
the source.

The build must stay deterministic: no timestamps, no random ids. A test rebuilds
and requires byte-identical output.

To add, remove, or rename a source file, edit `SCRIPTS`/`STYLES` in
`tools/source-digest.mjs`. Load order is load-bearing: every file attaches to the
shared `PG` namespace, `controls.js` reads `generators.js` at load time, and
`app.js` reads everything. The source digest covers `VERSION`, `src/index.html`,
and every script and stylesheet in that order; `tools/verify.mjs` recomputes it
from `src/`, so a file the build forgot would let two artifacts advertise the
same source. Bump `VERSION` there, too.

## What the build refuses

`tools/build.mjs` fails on:

- `Math.random`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`,
  `document.write`, `eval(`, `new Function(`, `unsafe-inline`, `unsafe-eval` in
  code (comment lines are skipped for this scan).
- Any network API — `fetch(`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`,
  `import(`, `Image(`, `Worker(`, `EventSource`, `RTCPeerConnection`, service
  worker — outside `lib/integrity.js`. **This scan is literal and does include
  comments**, so do not write `fetch(` in a comment in another file.
- `@font-face`, `@import`, or `url(` in CSS.
- In the markup: inline `on*=` handlers, `style=` attributes, external scripts or
  stylesheets, and any absolute `http(s)://` URL.
- Any leftover `{{...}}` placeholder.

Generated text reaches the DOM through `textContent` only (`setText` in
`app.js`), with one exception: the clipboard fallback writes the secret to a
detached `<textarea>`'s `value`. Neither path can become markup. Styling is
classes plus CSSOM custom properties (`--secret-size`, `--fill`); the markup
carries no style attributes.

## Source conventions

Each `src/lib/*.js` and `src/app.js` is a classic script wrapped in an IIFE that
receives `window.PG`, with **no `import`/`export`** — the build concatenates them
into one `<script>`, and `test/helpers.mjs` loads them the same way against a
fake `window`. Match the ES5 style (`var`, `function`), UPPER_SNAKE constants,
and exports on `PG.<module>`.

Split rules from wiring:

- `lib/controls.js` — decisions that are arithmetic over an options object:
  length ceilings, presets, mode state, `specText()`. No DOM, so tests reach it
  directly.
- `lib/generators.js` — the four modes and the sample-and-reject rule that makes
  the output uniform over the valid strings.
- `lib/entropy.js` — `log2` of the support size, by inclusion–exclusion in log
  space.
- `lib/integrity.js` — the monitors, the self-test, and the only network-shaped
  code the build allows.
- `app.js` — reading elements, writing the DOM, painting. A rule that needs no
  document belongs in `lib/`, not here.
- `lib/wordlist.js` — generated; do not edit.

Randomness comes only from `lib/random.js`: `crypto.getRandomValues` with
rejection sampling. Never apply `% n` to a raw draw — modulo bias is the bug that
file exists to prevent.

Refusals a user can cause (an override that repeats another class's character,
constraints with no valid string, a tiny alphabet) throw `GeneratorError`, which
sets `userFacing = true`. `app.js` prints `err.message` under the plate and shows
no secret. Test both the throw and the message.

## Tests

`node:test` and `node:assert/strict`, no framework. `npm test` is
`node --test "test/**/*.test.mjs"` — that glob needs Node 22+. Node 18 and 20
report `Could not find 'test/**/*.test.mjs'`, run zero tests, and exit 0, which
is why the floor is 22 and CI runs 22 and 24.

- Load browser-shaped modules with `loadPG([...])` from `test/helpers.mjs`;
  `constantCrypto()` makes draws predictable.
- `lib/integrity.js` needs a document: use `test/dom-stub.mjs`, which also
  shadows Node's `fetch` and `WebSocket` so probes reach the page's wrappers.
- Add a regression test with every fix. Pure modules get behavioural tests; build
  tests assert properties of the artifact.
- Tests that deliberately tamper with `dist/` copy it to `.bak` and restore it in
  `finally`.
- Don't hard-code suite or verifier totals in docs or assertions; the runners
  print them.
- The integrity counters repaint on a 1 Hz interval in `app.js`. A browser probe
  that reads one immediately after an action sees the previous tick; wait for a
  repaint before asserting.

## Design rules

Tested rules are marked; the rest are conventions with a stated reason.

- One light design. No `@media (prefers-color-scheme: dark)` block may reappear,
  and `<meta name="color-scheme" content="light">` must stay in the markup.
  *(tested)*
- Colour literals live only in the `:root` stock block. A test slices from the
  sheet's `stock` section marker onward and fails on any hex or `rgba()` below it
  — add a token instead of a value. *(tested)*
- `styles.css` is two halves in this order: structural first, design second.
  Moving them re-breaks `[hidden]` and equal-specificity overrides.
- `--peri` (periwinkle) is for borders and rings only — at 3.93:1 on the paper
  it never goes under text.
- Length controls are `controls.RANGE_PAIRS` (slider, number box, limits). Build
  tests read each slider's markup `min`/`max` and require the library limits to be
  at least as wide; a slider without a pair is a number box that never syncs.
  *(tested)*
- Every `getElementById` id must exist in the markup, and every id in the markup
  must be referenced by the script (exceptions: `custom-hint`, `digest-input`). A
  new static id needs a reason or a mention. *(tested)*
- The hinge (`specText()`) is permanent. The copy and refusal messages are a
  separate line that fades after about 2.5 seconds.
- `prefers-reduced-motion` must stay honoured. *(tested)*

## Word list and licence

`src/lib/wordlist.js` is generated from the EFF Long Wordlist. `npm run
wordlist` fails unless the source list holds exactly 7776 unique words, because
Diceware indices depend on the count. The list is CC BY 3.0 (Joseph Bonneau /
EFF) and its attribution must travel with any redistribution, whichever licence
covers the code around it. The project's own code is MIT.

## Docs, deploy, leftovers

- `README.md` is the long-form source of truth. Update it when behaviour or a
  claim changes, and refresh the published SHA-256 in the browser-matrix section
  after a rebuild. Re-run the matrix before changing its table; do not
  extrapolate cells. Known engine quirks (WebKit's stylesheet console message,
  Chromium's `file://` clipboard count) are documented there and are not bugs to
  "fix".
- `vercel.json` builds on the host (`npm run build`, `outputDirectory: dist`) and
  sends `frame-ancestors 'none'` as a real header, the one directive a `<meta>`
  policy cannot carry.
- Check a deployment against the production alias
  `https://passgen-ecru.vercel.app`. Per-deployment and git-branch URLs sit behind
  Vercel Authentication and answer `curl` with an auth wall.
- `PLAN.md` is gitignored on purpose: it is a finished work log, not a
  deliverable. Keep other working plans out of commits unless asked.
