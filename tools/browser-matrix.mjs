/*
 * browser-matrix.mjs -- re-measure the table in README.md.
 *
 *   node tools/browser-matrix.mjs dist/index.html
 *
 * Playwright is not a project dependency and must not become one: the page has
 * no dependencies, and `npm run check` has to keep working on a bare Node
 * install. tools/browser-matrix.sh installs Playwright into a temporary
 * directory, copies this file there, and runs it, so the repository stays clean.
 *
 * Every suite runs against the exact bytes of dist/index.html named on the
 * command line. It checks the rows the README publishes, plus the positive
 * controls that make a zero worth believing. The tamper page is a copy with one
 * newline added inside the inline script: the CSP hash changes, so the browser
 * must refuse to run it while the stylesheet still applies.
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';

const indexPath = resolve(process.argv[2] || 'dist/index.html');
const html = readFileSync(indexPath, 'utf8');
const fileHash = createHash('sha256').update(html).digest('hex');

const tampered = html.replace(
  /(<script>)([\s\S]*?)(<\/script>)/,
  function (match, open, code, close) {
    return open + '\n' + code + close;
  }
);

if (tampered === html) {
  throw new Error('could not find the inline script to tamper with');
}

const scratch = mkdtempSync(join(tmpdir(), 'passgen-matrix-'));
const originalFile = join(scratch, 'index.html');
const tamperedFile = join(scratch, 'tampered.html');
writeFileSync(originalFile, html);
writeFileSync(tamperedFile, tampered);

const PORT = 8080;

const server = createServer(function (request, response) {
  const path = new URL(request.url || '/', 'http://localhost').pathname;
  let body = null;

  if (path === '/' || path === '/index.html') body = html;
  else if (path === '/tampered.html') body = tampered;

  if (body === null) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found');
    return;
  }

  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(body);
});

await new Promise(function (resolveListen, rejectListen) {
  server.once('error', rejectListen);
  server.listen(PORT, resolveListen);
});

const origins = {
  file: pathToFileURL(originalFile).href,
  http: 'http://localhost:' + PORT + '/index.html',
};

const tamperedOrigins = {
  file: pathToFileURL(tamperedFile).href,
  http: 'http://localhost:' + PORT + '/tampered.html',
};

const engines = [
  ['Chromium', chromium],
  ['Firefox', firefox],
  ['WebKit', webkit],
];

function sleep(ms) {
  return new Promise(function (resolveSleep) { setTimeout(resolveSleep, ms); });
}

function counterText(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function readCounters(page) {
  return page.evaluate(function () {
    const read = function (id) {
      const node = document.getElementById(id);
      return node ? node.textContent.trim() : null;
    };
    return {
      network: read('net-total'),
      blocked: read('net-blocked'),
      selfTest: read('net-selftest'),
      storage: read('store-total'),
      clipboard: read('clip-writes'),
      origin: read('counter-origin'),
    };
  });
}

async function readStoreState(page) {
  return page.evaluate(function () {
    const safe = function (fn) {
      try {
        return fn();
      } catch (err) {
        return 'error: ' + (err && err.message ? err.message : String(err));
      }
    };
    return {
      local: safe(function () { return window.localStorage.length; }),
      session: safe(function () { return window.sessionStorage.length; }),
      cookie: safe(function () { return document.cookie.length; }),
    };
  });
}

async function contrastOnBar(page) {
  return page.evaluate(function () {
    const luminance = function (rgb) {
      const parts = rgb.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
      const linear = parts.map(function (value) {
        const channel = value / 255;
        return channel <= 0.03928
          ? channel / 12.92
          : Math.pow((channel + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    };
    const ratio = function (foreground, background) {
      const values = [luminance(foreground), luminance(background)].sort(function (a, b) {
        return b - a;
      });
      return Number(((values[0] + 0.05) / (values[1] + 0.05)).toFixed(2));
    };
    const bar = getComputedStyle(document.querySelector('.term-bar')).backgroundColor;
    const title = getComputedStyle(document.querySelector('.term-title')).color;
    const hint = getComputedStyle(document.querySelector('.term-hint')).color;
    return {
      title: ratio(title, bar),
      hint: ratio(hint, bar),
    };
  });
}

async function checkHashLock(browser, url) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [];

  page.on('console', function (message) {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', function (error) {
    errors.push('pageerror: ' + error.message);
  });

  await page.goto(url, { waitUntil: 'load' });
  await sleep(900);

  const state = await page.evaluate(function () {
    return {
      secret: document.getElementById('secret').textContent,
      origin: document.getElementById('counter-origin').textContent.trim(),
      background: getComputedStyle(document.body).backgroundColor,
    };
  });

  const held = state.secret === '' && state.origin === '\u2014';
  await context.close();

  return { held: held, state: state, consoleErrors: errors };
}

function countErrors(errors, stages) {
  return errors.filter(function (entry) {
    return stages.indexOf(entry.stage) !== -1;
  });
}

async function runSuite(browser, engineName, originName) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    colorScheme: 'light',
  });

  let permissionsGranted = false;
  let permissionsError = null;
  if (originName === 'http' && engineName === 'Chromium') {
    // Only Chromium implements these names. Firefox and WebKit reject the
    // request, and a failed grant leaves WebKit's context unable to open a
    // page, so they run as a real visitor does: clipboard access on the click
    // gesture, with the execCommand fallback if the API refuses.
    try {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      permissionsGranted = true;
    } catch (err) {
      permissionsError = err && err.message ? err.message : String(err);
    }
  }

  const page = await context.newPage();
  page.setDefaultTimeout(60000);

  const errors = [];
  let stage = 'load';

  page.on('console', function (message) {
    if (message.type() === 'error') errors.push({ stage: stage, text: message.text() });
  });
  page.on('pageerror', function (error) {
    errors.push({ stage: stage, text: 'pageerror: ' + error.message });
  });

  const result = {
    engine: engineName,
    version: browser.version(),
    origin: originName,
    hash: fileHash,
    permissionsGranted: permissionsGranted,
    permissionsError: permissionsError,
    loads: false,
    secretLength: 0,
    counters: null,
    storage: {},
    modes: {},
    copy: null,
    selfTest: null,
    positive: null,
    overflow: {},
    contrast: {},
    errors: errors,
    hashLock: null,
    failures: [],
  };

  await page.goto(origins[originName], { waitUntil: 'load' });
  await page.waitForFunction(function () {
    return document.getElementById('secret').textContent.length > 0;
  });
  await sleep(1200);

  result.loads = true;
  result.secretLength = await page.evaluate(function () {
    return document.getElementById('secret').textContent.length;
  });
  result.counters = await readCounters(page);
  result.storage.load = result.counters.storage;

  // Twenty regenerates.
  stage = 'regenerate';
  for (let i = 0; i < 20; i++) await page.click('#btn-regenerate');
  await sleep(1200);
  result.storage.afterRegenerates = (await readCounters(page)).storage;

  // All four modes.
  stage = 'modes';
  for (const mode of ['password', 'passphrase', 'pin', 'custom']) {
    await page.click('.mode[data-mode="' + mode + '"]');
    if (mode === 'custom') {
      // The custom alphabet lives inside the closed Adjust disclosure, so set it
      // the way a paste would: write the value and raise the input event app.js
      // already listens for. Opening the disclosure would scroll the page and
      // change the responsive state for no benefit.
      await page.evaluate(function () {
        const field = document.getElementById('custom-alphabet');
        field.value = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    await page.waitForFunction(function (expected) {
      const active = document.querySelector('.mode[aria-checked="true"]');
      return active && active.dataset.mode === expected &&
        document.getElementById('secret').textContent.length > 0;
    }, mode);
    result.modes[mode] = await page.evaluate(function () {
      return {
        length: document.getElementById('secret').textContent.length,
        status: document.getElementById('secret-status').textContent,
      };
    });
  }
  await sleep(1200);
  result.storage.afterModes = (await readCounters(page)).storage;

  // Four Copy presses. Storage is the question; the clipboard count is context.
  stage = 'copy';
  for (let i = 0; i < 4; i++) {
    await page.click('#btn-copy');
    await sleep(120);
  }
  await sleep(1200);
  const afterCopy = await readCounters(page);
  result.copy = {
    presses: 4,
    clipboard: afterCopy.clipboard,
    storage: afterCopy.storage,
    store: await readStoreState(page),
    button: await page.evaluate(function () {
      return document.getElementById('btn-copy').textContent;
    }),
  };
  result.storage.afterCopy = afterCopy.storage;

  // The self-test, from inside the open receipt.
  stage = 'selftest';
  await page.evaluate(function () {
    document.querySelector('#btn-selftest').closest('details').open = true;
  });
  await page.click('#btn-selftest');
  await page.waitForFunction(function () {
    const button = document.getElementById('btn-selftest');
    return button && button.textContent === 'Run again';
  });
  await sleep(1200);

  const selfTest = await page.evaluate(function () {
    const rows = Array.from(document.querySelectorAll('#selftest-results .test-row'));
    return {
      rows: rows.length,
      failures: rows.filter(function (row) { return row.classList.contains('test-fail'); }).length,
      summary: (document.querySelector('#selftest-results .notice') || {}).textContent || '',
      counters: {
        network: document.getElementById('net-total').textContent,
        blocked: document.getElementById('net-blocked').textContent,
        selfTest: document.getElementById('net-selftest').textContent,
        storage: document.getElementById('store-total').textContent,
        clipboard: document.getElementById('clip-writes').textContent,
      },
    };
  });
  result.selfTest = selfTest;
  result.storage.afterSelfTest = selfTest.counters.storage;

  // Positive controls. A counter that reads zero because it is dead would look
  // exactly like this page, so make each bucket move on purpose.
  stage = 'positive';
  const positiveErrors = await page.evaluate(function () {
    const errors = [];
    const attempt = function (fn) {
      try {
        fn();
      } catch (err) {
        errors.push(err && err.message ? err.message : String(err));
      }
    };
    attempt(function () {
      localStorage.setItem('passgen-probe', '1');
      localStorage.removeItem('passgen-probe');
    });
    attempt(function () {
      sessionStorage.setItem('passgen-probe', '1');
      sessionStorage.removeItem('passgen-probe');
    });
    attempt(function () {
      document.cookie = 'passgen-probe=1; path=/';
      document.cookie = 'passgen-probe=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
    });
    return errors;
  });
  await sleep(1200);
  const afterStorageProbe = await readCounters(page);

  await page.evaluate(function () {
    return fetch('https://probe.invalid/', { cache: 'no-store' }).catch(function () {});
  });
  await sleep(1200);
  const afterNetworkProbe = await readCounters(page);

  result.positive = {
    storageWrites: afterStorageProbe.storage,
    storageExpected: 6,
    storageErrors: positiveErrors,
    networkCalls: afterNetworkProbe.network,
    networkExpected: 1,
    blockedAfterNetwork: afterNetworkProbe.blocked,
  };

  // Responsive widths. The widest state includes the conditional Clear clip
  // button, which appears after Copy and is still on screen here.
  stage = 'responsive';
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width: width, height: 900 });
    await sleep(180);
    const metrics = await page.evaluate(function () {
      return {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      };
    });
    result.overflow[width] = metrics.scrollWidth <= metrics.clientWidth;
    result.overflow[width + 'px'] = metrics;
  }

  // The window's own width, and proof the stylesheet is actually applied even
  // when WebKit logs its known hash refusal.
  await page.setViewportSize({ width: 1280, height: 900 });
  await sleep(180);
  result.layout = await page.evaluate(function () {
    const term = document.querySelector('.term').getBoundingClientRect();
    return {
      termWidth: term.width,
      bodyFont: getComputedStyle(document.body).fontFamily,
      termBorder: getComputedStyle(document.querySelector('.term')).borderTopWidth,
    };
  });

  // Both colour schemes, measured on the title bar's own background.
  await page.emulateMedia({ colorScheme: 'light' });
  await sleep(180);
  result.contrast.light = await contrastOnBar(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await sleep(180);
  result.contrast.dark = await contrastOnBar(page);

  // The tamper page is the one check that needs a new page and a clean script
  // execution, so it runs after the suite rather than inside it.
  stage = 'hash-lock';
  result.hashLock = await checkHashLock(browser, tamperedOrigins[originName]);

  result.errors = errors;

  const ownStages = ['load', 'regenerate', 'modes', 'copy'];
  const ownErrors = countErrors(errors, ownStages);
  result.ownConsoleErrors = ownErrors;

  // WebKit has one known, documented stylesheet message. It is reported but
  // not treated as a suite failure; the sheet is applied and the page works.
  result.knownWebKitStylesheetMessage = ownErrors.filter(function (entry) {
    return /Refused to apply a stylesheet/i.test(entry.text);
  }).length;

  if (!result.loads) result.failures.push('did not load or generate');
  if (result.storage.load !== '0') result.failures.push('storage at load: ' + result.storage.load);
  if (result.storage.afterRegenerates !== '0') result.failures.push('storage after 20 regenerates: ' + result.storage.afterRegenerates);
  if (result.storage.afterModes !== '0') result.failures.push('storage after four modes: ' + result.storage.afterModes);
  if (result.storage.afterCopy !== '0') result.failures.push('storage after four Copy presses: ' + result.storage.afterCopy);
  if (result.storage.afterSelfTest !== '0') result.failures.push('storage after self-test: ' + result.storage.afterSelfTest);
  if (result.copy.store.local !== 0 || result.copy.store.session !== 0 || result.copy.store.cookie !== 0) {
    result.failures.push('Copy left storage behind: ' + JSON.stringify(result.copy.store));
  }
  if (result.selfTest.rows !== 9) result.failures.push('self-test rows: ' + result.selfTest.rows);
  if (result.selfTest.failures !== 0) result.failures.push('self-test failures: ' + result.selfTest.failures);
  // Six network probes, not nine rows: selfTestAttempts is one per escape
  // route, while the table's "9 / 9" is every row the self-test prints.
  if (result.selfTest.counters.selfTest !== '6') result.failures.push('self-test attempts: ' + result.selfTest.counters.selfTest);
  if (result.positive.storageWrites !== '6') result.failures.push('positive storage control: ' + result.positive.storageWrites);
  if (result.positive.networkCalls !== '1') result.failures.push('positive network control: ' + result.positive.networkCalls);
  if (!result.overflow[1280]) result.failures.push('overflow at 1280px');
  if (!result.overflow[390]) result.failures.push('overflow at 390px');
  if (!result.overflow[320]) result.failures.push('overflow at 320px');
  if (result.contrast.light.title < 4.5 || result.contrast.light.hint < 4.5) {
    result.failures.push('light title bar contrast: ' + JSON.stringify(result.contrast.light));
  }
  if (result.contrast.dark.title < 4.5 || result.contrast.dark.hint < 4.5) {
    result.failures.push('dark title bar contrast: ' + JSON.stringify(result.contrast.dark));
  }
  if (!result.hashLock.held) result.failures.push('hash lock did not hold');
  if (ownErrors.length > 0 && !(engineName === 'WebKit' && ownErrors.length === result.knownWebKitStylesheetMessage)) {
    result.failures.push('console errors: ' + ownErrors.length);
  }

  await context.close();
  return result;
}

const results = [];

for (const [engineName, engine] of engines) {
  const browser = await engine.launch();
  try {
    for (const originName of ['file', 'http']) {
      process.stderr.write('running ' + engineName + ' / ' + originName + ' ...\n');
      try {
        results.push(await runSuite(browser, engineName, originName));
      } catch (err) {
        // One suite failing should not throw away the five that worked.
        results.push({
          engine: engineName,
          version: browser.version(),
          origin: originName,
          hash: fileHash,
          failures: ['suite crashed: ' + (err && err.message ? err.message : String(err))],
          crash: err && err.stack ? err.stack : String(err),
        });
      }
    }
  } finally {
    await browser.close();
  }
}

server.close();
rmSync(scratch, { recursive: true, force: true });

console.log(JSON.stringify({ hash: fileHash, results: results }, null, 2));

const failed = results.filter(function (result) { return result.failures.length > 0; });

console.error('\nsummary');
for (const result of results) {
  console.error(
    result.engine + ' ' + result.version + ' / ' + result.origin + ': ' +
    (result.failures.length === 0 ? 'PASS' : 'FAIL — ' + result.failures.join('; '))
  );
}

if (failed.length > 0) process.exitCode = 1;
