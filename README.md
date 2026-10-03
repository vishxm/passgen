# passgen

A password generator that runs in one browser tab and goes nowhere else.

It is not a password manager. It has no memory: no history, no favourites, no
saved settings, no cookies, no service worker, no analytics, no dependencies, no
network calls. Close the tab and the password is gone.

```
dist/index.html      the whole thing: open this file
```

---

## Getting it running

**Just open it.** Double-click `dist/index.html`. It works from a file:// URL,
offline, from a USB stick. There is no server, no install, no build step needed
to *use* it.

**Or serve it**, if you prefer an origin:

```sh
npm run serve          # python3 -m http.server 8080
```

**Or build it yourself** from source:

```sh
npm run build          # src/**  ->  dist/index.html
npm test               # runs the whole suite; the count is printed when it finishes
npm run verify         # audit the built file against its own claims
npm run check          # build + test + verify
```

Requires **Node 22+** for the tooling. The page itself needs nothing but a
browser.

The floor is 22 for a specific reason, not out of caution: `npm test` is
`node --test "test/**/*.test.mjs"`, which hands the runner a glob for it to
resolve. Node 18 and 20 answer `Could not find 'test/**/*.test.mjs'` and run
nothing, so an older Node would report a silent pass over zero tests. Passing the
directory instead is no better &mdash; Node 22 reads `test/` as a single file.
Verified on 18.20.8, 20.20.2, 22.23.3 and 24.14.1.

`npm test` and `npm run verify` both refuse to run against a stale `dist/`.
That is deliberate: every other check audits the bytes on disk, so a build left
behind by an earlier edit would pass all of them while the page you are looking
at is not the page the source describes. If either complains that `dist/` is
stale, run `npm run build`.

---

## Deploying

The output is one static file, so there is nothing to install and no server to
run. `vercel.json` says so in the four fields a host needs:

| field | value | why |
| --- | --- | --- |
| `framework` | `null` | there is no framework, and none should be guessed at |
| `installCommand` | `echo 'no dependencies'` | nothing to install; keeps a lockfile from appearing |
| `buildCommand` | `npm run build` | rebuilds `dist/` from `src/` on the host |
| `outputDirectory` | `dist` | the two files that get served |

The build runs on Vercel rather than shipping the committed `dist/`, so the bytes
that get deployed are provably built from the source in the same commit. CI
already proves the committed `dist/` matches `src/`; this proves the deployed one
does too.

`package.json` also pins `"engines": { "node": "24.x" }`, the version the CI
matrix treats as current. Without it the host picks a Node version by its own
defaults, and a default that moved below 22 would run the tooling on a floor it
does not support.

Push, then import the repository at **Add New &rarr; Project** in the Vercel
dashboard, and check that the four fields above came back filled in rather than
blank. From a terminal, `npx vercel` deploys a preview and `npx vercel --prod` a
production one.

Two things are worth knowing about what lands in public:

- `dist/index.html.sha256` is inside the output directory, so it is served
  alongside the page. That is deliberate &mdash; it is the same checksum
  `npm run verify` checks, and anyone can confirm which build is live.
- The page is served over HTTPS, which is a secure context. The clipboard buttons
  work there, as they do over `file://`.

To confirm a deployment is the build you meant:

```sh
curl -sI https://<your-domain>/                    # the headers below
curl -s https://<your-domain>/index.html.sha256    # must match your local file
```

### What the host sends, and why it is not more

`vercel.json` sets five headers. The load-bearing one is
`Content-Security-Policy: frame-ancestors 'none'` &mdash; and it is alone on
purpose. A browser enforces a `<meta>` policy and a header policy
independently, so the effective policy is their intersection: the hash-locked
policy from the build, plus framing denial. Copying the full policy into the
header would duplicate hashes that `tools/build.mjs` computes per build, which
would be stale the next time anyone edited `src/`, and a stale
`script-src` hash locks the page out of itself.

`X-Frame-Options: DENY` covers browsers too old for CSP. The other three
(`X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`) are
defence in depth for a page that already refuses to talk to anything.

One thing a host cannot add: the browser matrix below was run against
`file://` and `http://localhost:8080`. Run the self-test on the deployed URL
before trusting it, and treat a result there as a new data point rather than
another tick in that table.

---

## The four modes

| Mode | What it makes | Options |
| --- | --- | --- |
| **Password** | random characters | length 4&ndash;128, uppercase, lowercase, digits, symbols, one-of-each guarantee, no repeats, drop look-alikes, custom exclusions, custom symbol set |
| **Passphrase** | EFF Diceware words | 3&ndash;12 words, separator, random capitalisation, appended digit |
| **PIN** | digits only | 4&ndash;12 digits, optional no repeats |
| **Custom set** | your own alphabet | any characters you paste, including emoji and accents; length; no repeats |

Press <kbd>G</kbd> anywhere to regenerate. Copy puts it on your clipboard, which
is the only write this page ever performs.

---

## What "nothing leaves your device" actually means here

A privacy claim on a website is worth nothing on its own, so this one is
enforced by the browser and then audited.

### 1. The browser is not allowed to make a request

The built page ships this policy, and `tools/build.mjs` computes the two hashes
in it from the exact bytes of the script and stylesheet it just inlined:

```
default-src 'none';
script-src 'sha256-<hash of this page's own script>';
style-src  'sha256-<hash of this page's own stylesheet>';
connect-src 'none';   img-src data:;      font-src 'none';   media-src 'none';
object-src 'none';    frame-src 'none';  worker-src 'none'; manifest-src 'none';
form-action 'none';   base-uri 'none';
```

There is no `'unsafe-inline'` and no `'unsafe-eval'` anywhere. Every fetch, XHR,
WebSocket, beacon, service worker, remote `<img>`, remote font and dynamic
`import()` is refused by the browser itself, whatever the script asks for. The
`connect-src 'none'` is not a promise the code keeps; it is a wall the code
cannot climb.

`img-src` says `data:` rather than `'none'` because `'none'` must be the only
source expression in a directive; put anything beside it and browsers discard
the whole directive, which would quietly re-allow remote images. Saying `data:`
positively forbids them and permits the empty `<link rel="icon" href="data:,">`
in the markup &mdash; without which Gecko asks the host for `/favicon.ico` and
adds a request to every page load.

A hash source means the browser will only run these exact bytes. Edit the
script without rebuilding and the page stops working. That is the tamper check.

### 2. The page counts its own behaviour

The **Receipts** panel is not a marketing claim, it is instrumentation installed
on the APIs before anything else runs: `fetch`, `XMLHttpRequest`, `WebSocket`,
`EventSource`, `Worker`, `SharedWorker`, `RTCPeerConnection`, `sendBeacon`,
`localStorage`, `sessionStorage`, `document.cookie`, `indexedDB`, the Cache API
and the clipboard. Alongside it, the page listens for the browser's own
`securitypolicyviolation` events, which is how a *blocked* request gets counted.

Two figures sit in that panel and must never be confused with each other:

- **Storage writes** counts `localStorage`, `sessionStorage`, cookies, IndexedDB
  and the Cache API. It reads zero, and it is not supposed to move.
- **Clipboard writes** counts the clipboard, and nothing else. It is a separate
  bucket rather than a line subtracted out of the first one, so pressing **Copy**
  cannot make the page look like it saved something.

**Network calls, by the generator** also stays at zero after a self-test. The
deliberate attempts are counted on their own row, which is why *self-test
attempts* equals the number of network rows printed below it even for escape
routes that cannot be wrapped at all, like `import()` and `new Image()`.

### 3. You can make it prove itself

**Run self-test** tries every escape route &mdash; `fetch`, XHR, WebSocket,
`sendBeacon`, dynamic `import()`, a remote `<img>` &mdash; and shows you each one
being refused, live, along with a chi-square uniformity check on the generator
that produced your password. It aims at `probe.invalid`, a domain reserved by
RFC 2606 that cannot resolve, so even a page with no policy could not reach a
real server. The test cannot become the leak.

*Blocked by policy* counts the browser's own `securitypolicyviolation` events, so
it can sit one below *self-test attempts*: a refused `wss://` connection raises
no violation event, and the panel says so rather than leaving two numbers on
screen that look like they disagree.

### 4. You can check it without trusting us

```sh
npm run verify
```

A fixed set of checks that re-derive the claims from `dist/index.html` on disk:
it rebuilds from `src/` first and fails if the shipped file is stale, then slices
the inline script and stylesheet back out of the HTML, recomputes their SHA-256,
and compares those against the hashes the page claims in its own policy. It also
confirms the word list is intact, that `Math.random` appears nowhere, that no
network call exists outside the self-test, and that the page is one file with
nothing to fetch. The count is printed on the last line and asserted by the
build tests, so it cannot go stale here.

For the file as a whole:

```sh
shasum -a 256 -c dist/index.html.sha256
```

Or with the page open: DevTools &rarr; Network, reload, see nothing but the
document. DevTools &rarr; Application, see an empty storage pane.

---

## The entropy figure is exact, not decorative

Most generators claim `length × log2(alphabet)`. That is only true when every
string in the output space is equally likely, which stops being the moment you
ask for "at least one uppercase".

Here the generator samples uniformly from the set of strings that *satisfy your
constraints* &mdash; it draws a candidate and redraws if the candidate is
invalid, which makes the output distribution exactly uniform over the valid
strings. The number on screen is then `log2` of the size of that set, counted by
inclusion&ndash;exclusion over the character classes, evaluated in log space so a
128-character password does not overflow anything. The maths is checked against
brute-force enumeration in `test/entropy.test.mjs`.

The upshot is that the figure never overstates what you got. With four types
enabled at length 4, for instance, the only valid passwords are permutations of
one character from each class, and the panel says so.

Crack times are shown against three labelled attacker rates &mdash; a
rate-limited login form, bcrypt on one GPU, MD5 on a rig of eight &mdash; with
the assumptions printed rather than hidden.

---

## Layout

```
src/
  index.html          markup and the placeholders the build fills in
  styles.css          dark, monospace, system fonts only
  app.js              wiring: reads controls, paints results, keeps the receipts
  lib/random.js       crypto.getRandomValues with rejection sampling
  lib/entropy.js      exact entropy and crack-time estimates
  lib/generators.js   the four modes
  lib/controls.js     what the controls decide: length ceilings, presets, modes
  lib/wordlist.js     GENERATED - the EFF list, 7776 words
  lib/integrity.js    network and storage monitors, self-test
  data/               the raw EFF wordlist, kept for provenance
tools/
  build.mjs           inline everything, hash it, write dist/index.html
  verify.mjs          audit dist/index.html from scratch
  make-wordlist.mjs   regenerate src/lib/wordlist.js from src/data
test/
  random, entropy, generators   the pure modules, straight under node --test
  controls.test.mjs             length ceilings, presets, mode switching, digest
  integrity.test.mjs            the receipts, against the stub below
  dom-stub.mjs                  enough browser to load integrity.js in Node
  build.test.mjs                the built file: reproducible, self-contained
dist/                 the shippable file, plus its SHA-256
vercel.json           deploy settings and the headers a host must send
.github/workflows/    `npm run check` on Node 22 and 24, on every push
LICENSE               MIT, for this project's own code
```

`src/lib/controls.js` is the reason the control logic is tested at all.
`src/app.js` is wiring &mdash; it reads elements, calls the generators, writes
results &mdash; and the rules in between used to sit inline in it, where the only
tests that could reach them were the build tests checking that the element ids
exist. Those rules are arithmetic over an options object and none of them need a
document, so they moved out. What stayed in `app.js` is the part that cannot be
separated: reading a checkbox, writing a range input's `max`, and painting
results. A fake DOM elaborate enough to satisfy the painting code would be a
second implementation of the browser, which is not worth maintaining here.

`test/dom-stub.mjs` exists because `integrity.js` is the module that produces the
page's evidence and therefore cannot be left untested, but it needs a DOM. The
stub supplies the dozen APIs it touches and takes over the globals Node already
has (`fetch`, `navigator`, `WebSocket`), so a test calling `fetch()` reaches the
page's own counting wrapper instead of attempting a real request.

`src/lib/wordlist.js` is generated. To rebuild it after replacing
`src/data/eff_large_wordlist.txt`:

```sh
npm run wordlist
```

### Why the source is modular but the output is one file

A multi-file page cannot keep this policy and still work when double-clicked:
`script-src 'self'` does not reliably match a `file://` document, and a hash
source will not rescue an *external* script. Hashes do work for an inline one,
and matching is origin-independent. So the source stays split into readable
modules and `tools/build.mjs` inlines them into a single hash-locked file.
Editing `src/app.js` requires `npm run build`, and the build tells you so if you
forget.

The source files attach themselves to one `window.PG` namespace and use no
`import`/`export`, precisely so they can be concatenated and run as a classic
script. `node --test` loads them by lending them a `window`.

---

## Limits, stated plainly

- This cannot stop a browser extension with page access, a compromised
  operating system, a keylogger, a shoulder-surfer, a screen recording, or a
  clipboard manager that keeps its own history. Nothing rendered on a screen is
  private from the machine rendering it.
- `frame-ancestors` cannot be expressed in a `<meta>` policy; browsers ignore it
  there, so it is the one directive that can only arrive as a real header.
  `vercel.json` sends it. Hosting this file anywhere else means sending it
  yourself, or the page can be framed.
- The clipboard buttons need a secure context. `file://` counts as one, so they
  work; over plain `http://` on a remote host, browsers will refuse and the page
  says so instead of failing silently.
- Clearing the clipboard overwrites the system clipboard, not any clipboard
  manager's history.
- Entropy is a property of the string, not of what you do with it. One password
  reused across twelve sites is one weak password.
- The receipts are instrumentation, not a guarantee. A wrapper that failed to
  install would read zero forever, so a zero is only worth what the positive
  control below says it is worth.

### Which browsers this has actually been run in

Checked on 3 October 2026 against `dist/index.html` with SHA-256
`d4490aa0e306cb09b34121b2610007525cf9ffe047ad4c64ba333fd4f75956ce`, from **both**
`file://` and `http://localhost:8080`:

| | Chromium 153.0.8010.12 | Firefox 155.0 | WebKit 26.6 |
| --- | --- | --- | --- |
| Loads, generates, no console errors of its own | yes | yes | yes |
| *Storage writes* 0 at load, after 20 regenerates, after all four modes, after the self-test | yes | yes | yes |
| Four presses of Copy, *storage writes* still 0, no keys, no cookie | yes | yes | yes |
| Self-test | 9 / 9 | 9 / 9 | 9 / 9 |
| *Blocked by policy* | 5 of 6 attempts | 5 of 6 | 5 of 6 |
| Hash lock holds against a one-byte edit | yes | yes | yes |
| 390 px wide, no horizontal overflow | yes | yes | yes |

The build of WebKit above is the one Playwright ships, which is not the same
binary as Safari.app. Safari itself is untested here: it gates the clipboard on a
user gesture and has its own `file://` behaviour, and it cannot be driven
headlessly. Assume nothing about Safari that is not in the table.

**Positive controls.** "Storage writes stayed 0" would also be what a broken
counter reads. So from inside each page, deliberately writing to `localStorage`,
`sessionStorage`, `document.cookie` and back again moves *storage writes* from 0
to 6, split correctly across the four channels, in all three engines. A refused
`fetch` outside the self-test moves *network calls* from 0 to 1. The particular
worry in `src/lib/integrity.js` &mdash; that Firefox hands back a fresh
`window.localStorage` wrapper and silently discards a patch on the instance
&mdash; does not apply: the patch is on `Storage.prototype`, and re-reading
`window.localStorage` returns the same wrapped `setItem` in every engine tested.

**One number that reads unexpectedly.** On Chromium over `file://`,
`navigator.clipboard.writeText` is refused (`NotAllowedError`), so **Copy** falls
back to `document.execCommand`. Both are clipboard writes and both are counted,
so four presses read **8** there instead of 4. Nothing is misfiled: *storage
writes* stays 0. It is the count of calls made to a clipboard API, not the count
of successful pastes.

**Printing.** `@media print` was written but had never been rendered until now,
and it was wrong in two ways, both now fixed: the button row printed with its
on-screen fills, and the accent teal printed on white at roughly a 2:1 contrast
ratio. The masthead, settings, receipts, colophon, skip link, button row, strength
bar and crack-time table are all `display: none` on paper. What prints is the
password, its heading, the one-line description, the strength label and the stats
grid &mdash; black on white, legible at length 4, 20 and 128 (128 wraps to three
lines) and in passphrase mode.

---

## Credits

Passphrase mode uses [the EFF's Long Wordlist](https://www.eff.org/dice) &mdash;
7776 words by Joseph Bonneau, licensed
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). The raw list is
kept at `src/data/eff_large_wordlist.txt`; `npm run wordlist` regenerates the
embedded copy and fails loudly if the word count is not exactly 7776, because
Diceware indices depend on it.

This project's own code is MIT licensed; see `LICENSE`, which also states
plainly that the MIT terms do not extend to the word list. That attribution is
repeated in the page's own colophon and must stay with any redistribution of the
list, whichever licence covers the code around it.

Everything else is in this repository, and there are no dependencies to audit.
