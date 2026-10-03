# Plan

Every item below is done. Written 3 Oct 2026 against `dist/index.html` sha256
`d7766705` / source digest `937cb964`; the tree now sits at sha256
`d4490aa0`, source digest `52ce7aa5`.

`npm run check` is green: **125 tests, 17 verify checks**, on Node 22.23.3 and
24.14.1, and in CI on every push.

Where the plan's own guesses turned out to be wrong, the finding is recorded
rather than quietly dropped. There are four:

1. `npm test` does **not** work on Node 18 or 20 — see item 7.
2. `describeAlphabet` was already dead, but so was the idea that the remaining
   dead symbols were only untested — see item 5.
3. The print stylesheet had never been rendered and was **wrong**, not merely
   unverified — see item 6.
4. The Firefox `Storage.prototype` worry resolves, but only once you check that
   the counter *can* move — see item 1.

---

## Read this first

Two rules that keep biting, both learned the hard way in the last round.

1. **The receipts panel never does arithmetic.** `integrity.receipts()`
   (`src/lib/integrity.js:279`) is the only definition of the five figures on
   screen. If you add a sixth, add it there and test it in
   `test/integrity.test.mjs` — never in `renderIntegrity`. The clipboard/storage
   mix-up shipped because `app.js` recomputed a figure the library already knew.
2. **`dist/` is the product.** `npm test` and `npm run verify` both refuse to run
   against a stale build. If you touch `src/`, run `npm run build` *before* you
   open the page in a browser, or you will debug a build that no longer matches
   the source. This is exactly how a stale `dist/` reached you once already.

   CI now enforces the second rule as well: `.github/workflows/check.yml` runs
   `npm run check` and then `git diff --exit-code -- dist/`.

---

## Tier 1 — the only tier that could make a claim on screen untrue

### 1. Verify Firefox and Safari — done

Everything previously confirmed was headless Chromium. The page makes absolute
claims ("no cookies, no storage, no requests"), and one code comment reasons
explicitly about a browser that had never been run in it —
`src/lib/integrity.js:153`, *"Firefox may hand back a fresh wrapper on each
`window.localStorage` access"*.

Checked on 3 Oct 2026 with Playwright, from **both** `file://` and
`http://localhost:8080`, on Chromium 153.0.8010.12, Firefox 155.0 and WebKit
26.6. Results are in README's *Which browsers this has actually been run in*.

- [x] page loads and generates; no console errors of its own
- [x] **storage writes stays 0** at load, after 20 regenerates, after switching
      all four modes, after running the self-test
- [x] press **Copy** 4× → *clipboard writes* = 4, *storage writes* still 0, and
      `localStorage.length === 0`, `sessionStorage.length === 0`,
      `document.cookie === ''`
- [x] **Run self-test** → 9 of 9 on every engine
- [x] **Blocked by policy** reads 5 of 6 on all three engines. Identical across
      them, so the sentence under the counters is correct as written and needs no
      per-engine wording. (A refused `wss://` raises no `securitypolicyviolation`
      in any of them.)
- [x] clipboard actually works
- [x] tamper test: one byte added to the inline script, reload, all three engines
      refuse to execute it, each with its own wording
- [x] narrow viewport (390px) — no horizontal overflow, the *Running on origin*
      row wraps rather than pushing the layout

**The finding that mattered.** "Storage writes stayed 0" is also what a wrapper
that silently failed to install would read, so it proves nothing on its own.
Driving real writes from inside each page moves the counter 0 → 6, split across
the four channels, in all three engines; a refused `fetch` outside the self-test
moves *network calls* 0 → 1. The Firefox wrapper concern **does not apply** — the
patch is on `Storage.prototype` and re-reading `window.localStorage` returns the
same wrapped `setItem` everywhere.

**What is still not verified:** Safari itself. The WebKit build Playwright ships
is not `Safari.app`, and Safari gates the clipboard on a user gesture and has its
own `file://` behaviour. README says so rather than implying coverage.

### 2. Tests for `src/app.js` — done

The DOM stub made `integrity.js` testable, but `app.js` had 12 functions with real
logic and nothing exercised them.

- [x] extracted the pure part into `src/lib/controls.js`: the ceiling
      calculation, the preset table, the mode→panel mapping and the digest
      verdict, all `(options) -> result` with no DOM
- [x] added `src/lib/controls.js` to `SCRIPTS` in `tools/build.mjs` (before
      `app.js`) and to `loadCore()` / a new `loadControls()` in
      `test/helpers.mjs`
- [x] `test/controls.test.mjs`, 29 tests: presets produce their documented
      values; a stale ceiling cannot survive a preset switch; the three mode
      predicates; the digest verdict
- [x] `app.js` is now wiring only. `applyLengthCeiling`, `relaxLengthCeilings`,
      `applyPreset`, `setMode` and `compareDigest` all read from `controls.js`
- [x] `legacyCopy` is left alone. It is a DOM operation with no pure half: the
      interesting part is that it never throws, and that is a browser fact, not a
      unit-testable one. It is exercised for real in item 1's four-Copy run, where
      Chromium over `file://` is the case that actually takes this path
- [x] every error string in `generate()` has a reachable input —
      `REACHABLE_ERRORS` in `test/generators.test.mjs` pairs each message with the
      input that produces it. One of them needed help to reach: *"These settings
      leave too few valid passwords"* fires at well under 1% per attempt, so the
      test drives it with a pinned `crypto` (see `constantCrypto()` in
      `test/helpers.mjs`) rather than leaving a flaky test in the suite
- [x] the painting functions (`paintSecret`, `paintMeter`, `paintChannels`,
      `paintPolicy`) stay covered by the build tests and by hand, as planned

### 3. Version control and CI — done

- [x] `git init` and commit
- [x] `dist/` committed, plus `.gitignore` already covering `node_modules/`,
      `.DS_Store`, `.playwright-mcp/`, `*.log`
- [x] `.github/workflows/check.yml`: `npm run check` on Node 22 and 24, then
      `git diff --exit-code -- dist/`, and it fails if a `package-lock.json`
      ever appears
- [x] repository is public: <https://github.com/vishxm/passgen>, MIT (item 4).
      The first push is green on both Node versions.

---

## Tier 2 — quick wins

### 4. Add a LICENSE — done

MIT. `LICENSE` carries the word-list carve-out in plain words: the EFF list stays
CC BY 3.0, its attribution stays in `#wordlist-credit` and README's *Credits*, and
the MIT terms do not extend to it.

### 5. Delete the dead code — done

| symbol | file | action |
| --- | --- | --- |
| `describeAlphabet` | `src/lib/generators.js:348` | deleted, never called |
| `randomBytes` | `src/lib/random.js:15` | deleted, never called |
| `shuffle` | `src/lib/random.js:56` | deleted, and **so were its two tests** |
| `bitsForPin` | `src/lib/entropy.js:132` | deleted, and its two tests |
| `formatDuration` | `src/lib/entropy.js:190` | deleted, and its test |
| `PG.app` | `src/app.js:932` | deleted, nothing consumed it |

**The plan's note about `shuffle` was incomplete.** Deleting it does not leave
`sampleDistinct` untested — a full-length `sampleDistinct` *is* a Fisher-Yates
shuffle, since partial Fisher-Yates degenerates to the full one at `length === n`.
So the multiset-preservation and "it actually reorders" assertions moved onto
`sampleDistinct(input, input.length)` instead of being deleted, which keeps the
property covered against the function the page actually draws from.

`bitsForPin` and `formatDuration` were the same story. The redundant `6·log2(10)`
assertion is now made against `bitsForClasses(result.spec)` — the route `app.js`
actually takes — and the duration-scale test goes through
`formatDurationFromLog10(Math.log10(seconds))`, which is what
`crackTimeRows` calls. Both now test the real path.

`PG.app` went because item 1 drives the page through Playwright rather than
through a JavaScript entry point, so nothing wanted it.

### 6. Exercise the print path — done, and it was broken

- [x] `emulateMedia({ media: 'print' })` and screenshot, on all three engines,
      from `file://`
- [x] legible at length 4, 20 and 128 (128 wraps to three lines) and in
      passphrase mode
- [x] nothing else prints: masthead, settings, receipts, colophon, skip link,
      strength bar and crack-time table are all `display: none`

**Two real defects, both fixed in `@media print`:**

1. **The button row printed.** Regenerate / Copy / Hide / Print came out with
   their screen fills. Paper cannot be clicked, so this wasted toner and printed
   five labels that do nothing. `.panel-actions` is now hidden.
2. **The accent teal printed on white.** `#secret-status`, the strength label and
   the bits figure are roughly a 2:1 contrast ratio on paper — legible on a
   backlit screen, not on paper. All three are forced to `#000`.

Found only by rendering it. The stylesheet had looked correct for a year.

---

## Tier 3 — documentation and noise

### 7. Two claims in README that will drift — done

- [x] `npm test # 94 tests` — the number is gone. `node --test` prints the count
      when it finishes, which is where a count that cannot go stale belongs.
      *Seventeen checks* was cut for the same reason.
- [x] `Requires Node 18+` — **was wrong.** `npm test` is
      `node --test "test/**/*.test.mjs"`, which asks the runner to resolve a
      glob. Verified on four versions:

  | Node | `npm run check` |
  | --- | --- |
  | 18.20.8 | `Could not find 'test/**/*.test.mjs'` — runs nothing |
  | 20.20.2 | `Could not find 'test/**/*.test.mjs'` — runs nothing |
  | 22.23.3 | green |
  | 24.14.1 | green |

  Passing a directory is not a fix: Node 22 reads `test/` as a single file and
  fails, Node 20 reads it as a recursive search, Node 18 runs `dom-stub.mjs` and
  `helpers.mjs` as if they were suites. So the floor is raised to **22**, README
  says exactly why, and CI tests 22 and 24.

### 8. Silence the false alarm in `npm run check` — done

- [x] `stdio: ['ignore', 'pipe', 'pipe']` in `run()` in `test/build.test.mjs`,
      which `runExpectingFailure()` already went through
- [x] a clean `npm run check` prints no `build failed` line
- [x] `test/build.test.mjs` still fails when it should — confirmed by tampering
      with `dist/index.html` and watching it go red (11 pass, 1 fail), then
      restoring it

---

## Out of scope, deliberately

Not "later" — these contradict the premise:

- Any persistence. No history, no favourites, no remembered settings, no
  cookies, no service worker. A feature that needs to remember something belongs
  in a different program.
- `frame-ancestors` as a real HTTP header. Browsers ignore it in a `<meta>` tag,
  so it cannot be fixed here; README already says so.
- Beating clipboard managers, extensions, keyloggers, or screen recorders.
  README's *What it cannot stop* already covers it.

## Done recently, for context

- storage writes and clipboard writes split into disjoint buckets; `receipts()`
  is now the only definition of the figures on screen
- `npm test` and `npm run verify` both refuse to run against a stale `dist/`
- 19 tests for `integrity.js` via `test/dom-stub.mjs`
- self-test attempts now equal the number of probes (4 → 6), and the panel
  explains why *blocked* can sit below *attempts*
- origin receipt moved out of the masthead into the counters table
- *Policy in force* renders all 13 directives — it used to be an empty box