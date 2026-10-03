# Plan

Remaining work on passgen, ordered by risk. Written 3 Oct 2026 against
`dist/index.html` sha256 `d7766705` / source digest `937cb964`.

`npm run check` is green: 94 tests, 17 verify checks. Nothing below is a known
bug — this is coverage and verification debt, plus housekeeping.

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

---

## Tier 1 — the only tier that could make a claim on screen untrue

### 1. Verify Firefox and Safari

Everything confirmed so far is headless Chromium. The page makes absolute claims
("no cookies, no storage, no requests"), and one code comment reasons explicitly
about a browser I have never run it in — `src/lib/integrity.js:153`, *"Firefox may
hand back a fresh wrapper on each `window.localStorage` access"*. If that patch
does not hold, the storage counter under-reports, which is worse than not
counting: the panel would be lying by omission.

Do this per engine, from **both** `file://` and `http://localhost:8080`:

- [ ] page loads and generates; no console errors
- [ ] **storage writes stays 0** at load, after 20 regenerates, after switching
      all four modes, after running the self-test
- [ ] press **Copy** 4× → *clipboard writes* = 4, *storage writes* still 0, and
      `localStorage.length === 0`, `sessionStorage.length === 0`,
      `document.cookie === ''`
- [ ] **Run self-test** → 9 of 9 pass
- [ ] note what *Blocked by policy* reads. Chromium gives 5 of 6, because a
      refused `wss://` raises no `securitypolicyviolation`. Firefox and Safari may
      differ; if they do, check the sentence under the counters still reads
      correctly rather than asserting an exact number
- [ ] clipboard actually works (Safari gates this on a user gesture and has its
      own `file://` behaviour)
- [ ] tamper test: change one byte of the inline script, reload, confirm the
      browser refuses to run it. This is the hash lock and it must hold per engine
- [ ] narrow viewport (390px) — no horizontal overflow, the new
      *Running on origin* row wraps rather than pushing the layout

**Done when** the results are written into README's *Limits, stated plainly*
section, including anything that turned out to be broken.

### 2. Tests for `src/app.js`

The DOM stub made `integrity.js` testable, but `app.js` has 12 functions with
real logic and nothing exercises them. The build tests only prove the ids it
reaches for *exist* — not that the logic is right.

| function | line | what breaks silently |
| --- | --- | --- |
| `applyLengthCeiling` | 679 | the "no repeats caps length at alphabet size" rule |
| `relaxLengthCeilings` | 711 | the workaround for a preset inheriting the previous preset's ceiling |
| `applyPreset` | 761 | mode switch plus 9 control values |
| `compareDigest` | 617 | the match / no-match message |
| `setMode` | 660 | panel visibility and `aria-checked` |
| `legacyCopy` | 328 | the `execCommand` clipboard fallback |

Recommended approach — **do not** hand-roll a DOM for all of this. The
length-ceiling and preset logic is really pure functions over a control-state
object; it only touches the DOM to read and write values.

- [ ] extract the pure part into a new `src/lib/controls.js`: the ceiling
      calculation, the preset table, and the mode→panel mapping, all as
      `(options) -> result` with no DOM
- [ ] add `src/lib/controls.js` to `SCRIPTS` in `tools/build.mjs` (before
      `app.js`) and to `loadCore()` in `test/helpers.mjs`
- [ ] test it there: presets produce their documented values; a stale ceiling
      cannot survive a preset switch; every error string in `generate()` has a
      reachable input
- [ ] leave the painting functions (`paintSecret`, `paintMeter`, `paintChannels`,
      `paintPolicy`) covered only by the build tests and by hand — they are
      mechanical, and a DOM stub that can satisfy them is not worth maintaining
      given the no-dependencies rule

### 3. Version control and CI

Nothing runs `npm run check` unless a human remembers. The staleness gate stops
a stale `dist/` from being *verified*; nothing stops a broken `dist/` reaching
someone who opens the file.

- [ ] `git init`, then commit. `.gitignore` already covers `node_modules/`,
      `.DS_Store`, `.playwright-mcp/`, `*.log`
- [ ] commit `dist/` — it is the shippable artifact, and the README tells people
      to verify its sha256, which is meaningless without history
- [ ] add `.github/workflows/check.yml`: `npm run check` on Node 20 and 24
- [ ] decide whether the repository is public (see Tier 2, item 4 — public needs
      a licence first)

---

## Tier 2 — quick wins

### 4. Add a LICENSE

There is no licence file. The EFF wordlist is CC BY 3.0 and is credited in-page
(`#wordlist-credit`) and in README's *Credits*; the code itself is unlicensed.
Pick one, write it, and keep the wordlist attribution where it is.

### 5. Delete the dead code

Verified by grep: defined and exported, called by nothing.

| symbol | file | note |
| --- | --- | --- |
| `describeAlphabet` | `src/lib/generators.js:348` | never called; `app.js` has its own `alphabetSummary` |
| `randomBytes` | `src/lib/random.js:15` | called by nothing, not even a test |
| `shuffle` | `src/lib/random.js:56` | tested, no src caller — `sampleDistinct` has its own partial Fisher-Yates |
| `bitsForPin` | `src/lib/entropy.js:132` | tested, but `app.js` routes PINs through `bitsForClasses` with no classes |
| `formatDuration` | `src/lib/entropy.js:190` | tested, but `crackTimeRows` calls `formatDurationFromLog10` directly |
| `PG.app` | `src/app.js:932` | nothing consumes it |

Note the three that are *tested*: deleting them means deleting the tests too. For
`bitsForPin` specifically, `test/generators.test.mjs:274` uses it to re-assert
`6 * log2(10)` — which `bitsForClasses` already covers via the `k === 0` branch,
so that assertion is redundant either way. This is an app, not a library; lean
towards deleting. Keep `PG.app` only if you intend to drive it from a future
browser test.

### 6. Exercise the print path

There is a thorough `@media print` block (`src/styles.css:1100` onward — hides
everything but the password, forces black on white) and a Print button that has
never been rendered.

- [ ] `page.emulateMedia({ media: 'print' })` and screenshot
- [ ] check the password is legible at length 4 and at length 128, and in
      passphrase mode
- [ ] check nothing else prints: no masthead, no settings, no receipts

---

## Tier 3 — documentation and noise

### 7. Two claims in README that will drift

- [ ] `npm test # 94 tests` — a hardcoded count that is wrong the moment a test
      is added. Either drop the number or make `npm test` print it where README
      cannot go stale.
- [ ] `Requires Node 18+ for the tooling` — unverified. This machine is on Node
      24, and `node --test "test/**/*.test.mjs"` relies on the runner resolving
      a glob argument, which is not guaranteed that old. Either test it on 18 or
      raise the floor to 20 and say why.

### 8. Silence the false alarm in `npm run check`

A clean `npm run check` prints `build failed: dist/index.html is stale` twice.
It is harmless — those are captured failures from the two tests that deliberately
break `dist/` on purpose — but it reads like a real failure and trains you to
ignore red text.

Cause: Node's `execFileSync` pipes a child's stderr to the parent's stderr unless
`stdio` is given explicitly, which is what `run()` in `test/build.test.mjs` omits.
Confirmed on this machine:

```
$ node -e "execFileSync(process.execPath,['-e','console.error(\"X\")'])"
X
```

- [ ] pass `stdio: ['ignore', 'pipe', 'pipe']` in `run()` and
      `runExpectingFailure()` in `test/build.test.mjs`
- [ ] confirm a clean `npm run check` prints no `build failed` line
- [ ] confirm `test/build.test.mjs` still fails when it should

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
