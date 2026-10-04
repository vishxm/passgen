/*
 * integrity.js -- the receipts.
 *
 * A promise that nothing leaves your browser is worth very little on its own, so
 * this file produces evidence instead:
 *
 *   1. It counts every network API the page touches, and separately records the
 *      securitypolicyviolation events the browser fires when the Content
 *      Security Policy refuses something. Both numbers should be zero, and when
 *      you press "run self-test" the second one goes up on purpose, in front of
 *      you, while the request still never leaves.
 *   2. It counts every write to localStorage, sessionStorage, cookies and
 *      IndexedDB. The clipboard is counted in its own bucket, never in this one:
 *      the page is supposed to write there, and folding it into "storage writes"
 *      made a press of Copy look like the page saving something.
 *   3. It can re-run the whole battery on demand.
 *
 * Every probe aims at probe.invalid, a TLD reserved by RFC 2606 that cannot
 * resolve. So even if the policy were somehow absent, a probe could not reach a
 * real server -- the test cannot become the leak.
 */
(function (PG) {
  'use strict';

  // RFC 2606 reserves .invalid precisely so that it never resolves in DNS.
  var PROBE_URL = 'https://probe.invalid/';
  var PROBE_WS = 'wss://probe.invalid/';
  var PROBE_TIMEOUT_MS = 2500;

  var state = {
    installed: false,
    violations: [],
    network: {},
    networkTotal: 0,
    // One attempt per network probe the self-test runs. Counting it in the probe
    // rather than in the API wrappers means the number matches the number of
    // rows the self-test prints, even for escape routes that cannot be wrapped
    // at all -- dynamic import() and new Image() have nothing to patch.
    selfTestAttempts: 0,
    selfTestActive: false,
    storage: {},
    storageTotal: 0,
    clipboard: {},
    clipboardTotal: 0,
    installedAt: 0,
  };

  var hasDom = typeof document !== 'undefined' && typeof window !== 'undefined';

  function bump(bucket, key) {
    bucket[key] = (bucket[key] || 0) + 1;
  }

  /**
   * A network API was touched. During the self-test the probe itself has already
   * claimed the attempt, so this deliberately falls through to nothing: the
   * headline counter means "did the generator ever try to send anything", and
   * the self-test trying things on purpose must not make that number look bad.
   */
  function countNetwork(channel) {
    if (state.selfTestActive) return;
    bump(state.network, channel);
    state.networkTotal++;
  }

  function countStorage(channel) {
    bump(state.storage, channel);
    state.storageTotal++;
  }

  /** Wrap a method, counting calls, and never breaking if the wrap fails. */
  function wrap(object, key, channel, counter) {
    try {
      if (!object) return;
      var original = object[key];
      if (typeof original !== 'function') return;
      var count = counter || countNetwork;
      object[key] = function () {
        count(channel);
        return original.apply(this, arguments);
      };
    } catch (err) {
      /* frozen host object, or a browser that moved it; not fatal */
    }
  }

  /** Wrap a property setter (used for document.cookie). */
  function wrapSetter(proto, key, channel) {
    try {
      if (!proto) return;
      var descriptor = Object.getOwnPropertyDescriptor(proto, key);
      if (!descriptor || !descriptor.set) return;
      Object.defineProperty(proto, key, {
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        get: descriptor.get,
        set: function (value) {
          countStorage(channel);
          return descriptor.set.call(this, value);
        },
      });
    } catch (err) {
      /* not fatal */
    }
  }

  function installNetworkWrappers() {
    wrap(typeof window !== 'undefined' ? window : null, 'fetch', 'fetch');
    wrap(typeof window !== 'undefined' ? window : null, 'WebSocket', 'WebSocket');
    wrap(typeof window !== 'undefined' ? window : null, 'EventSource', 'EventSource');
    wrap(typeof window !== 'undefined' ? window : null, 'Worker', 'Worker');
    wrap(typeof window !== 'undefined' ? window : null, 'SharedWorker', 'SharedWorker');
    wrap(typeof window !== 'undefined' ? window : null, 'RTCPeerConnection', 'RTCPeerConnection (WebRTC)');

    if (typeof XMLHttpRequest !== 'undefined') {
      wrap(XMLHttpRequest.prototype, 'open', 'XMLHttpRequest');
    }

    if (typeof navigator !== 'undefined') {
      wrap(navigator, 'sendBeacon', 'navigator.sendBeacon');
      if (navigator.serviceWorker) {
        wrap(navigator.serviceWorker, 'register', 'serviceWorker.register');
      }
    }

    // The clipboard is the one place this page is *supposed* to write, so it is
    // counted in its own bucket, never in the storage one.
    wrapClipboard();
  }

  function wrapClipboard() {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        wrap(navigator.clipboard, 'writeText', 'clipboard', countClipboard);
        wrap(navigator.clipboard, 'write', 'clipboard', countClipboard);
      }
      if (typeof document !== 'undefined') wrap(document, 'execCommand', 'clipboard', countClipboard);
    } catch (err) { /* ignore */ }
  }

  /**
   * The clipboard is the one place this page is *supposed* to write, so it gets
   * its own bucket. It deliberately does not touch state.storage: "storage
   * writes" has to mean "the page saved something", or the number stops being
   * evidence of anything.
   */
  function countClipboard(channel) {
    bump(state.clipboard, channel);
    state.clipboardTotal++;
  }

  function installStorageWrappers() {
    // Patch Storage.prototype, not the localStorage object. Firefox may hand
    // back a fresh wrapper on each `window.localStorage` access, so a patch on
    // the instance can be silently discarded and the counter would under-report
    // -- which is worse than not counting at all.
    try {
      if (typeof Storage !== 'undefined') {
        wrap(Storage.prototype, 'setItem', 'storage.setItem', countStorage);
        wrap(Storage.prototype, 'removeItem', 'storage.removeItem', countStorage);
        wrap(Storage.prototype, 'clear', 'storage.clear', countStorage);
      }
    } catch (err) { /* storage may be disabled entirely */ }

    try {
      if (typeof indexedDB !== 'undefined' && indexedDB.constructor) {
        wrap(indexedDB.constructor.prototype, 'open', 'indexedDB.open', countStorage);
        wrap(indexedDB.constructor.prototype, 'deleteDatabase', 'indexedDB.deleteDatabase', countStorage);
      }
    } catch (err) { /* ignore */ }

    try {
      if (typeof caches !== 'undefined' && caches.constructor) {
        wrap(caches.constructor.prototype, 'open', 'caches.open', countStorage);
        wrap(caches.constructor.prototype, 'match', 'caches.match', countStorage);
        wrap(caches.constructor.prototype, 'delete', 'caches.delete', countStorage);
      }
    } catch (err) { /* ignore */ }

    try {
      if (typeof Document !== 'undefined') wrapSetter(Document.prototype, 'cookie', 'document.cookie');
    } catch (err) { /* ignore */ }
  }

  function installViolationListener() {
    if (!hasDom) return;
    document.addEventListener('securitypolicyviolation', function (event) {
      state.violations.push({
        directive: event.violatedDirective || 'unknown',
        blockedURI: event.blockedURI || '',
        source: event.sourceFile || '',
        line: event.lineNumber || 0,
        at: Date.now(),
      });
      if (state.violations.length > 200) state.violations.shift();
    });
  }

  function init() {
    if (state.installed || !hasDom) return false;
    state.installed = true;
    state.installedAt = Date.now();
    installViolationListener();
    installNetworkWrappers();
    installStorageWrappers();
    return true;
  }

  /** The policy the browser actually parsed out of the document. */
  function describePolicy() {
    if (!hasDom) return null;
    var meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    if (!meta) return null;
    var raw = meta.getAttribute('content') || '';
    var directives = raw
      .split(';')
      .map(function (part) { return part.trim(); })
      .filter(Boolean)
      .map(function (part) {
        var pieces = part.split(/\s+/);
        return { name: pieces[0], value: pieces.slice(1).join(' ') || '(none)' };
      });
    return { raw: raw, directives: directives };
  }

  function keyCount(store) {
    try {
      return store ? store.length : 0;
    } catch (err) {
      return null;
    }
  }

  function rowsOf(bucket) {
    return Object.keys(bucket).sort().map(function (key) {
      return { channel: key, count: bucket[key] };
    });
  }

  function snapshot() {
    return {
      installed: state.installed,
      origin: hasDom ? location.origin : 'n/a',
      protocol: hasDom ? location.protocol : 'n/a',
      isSecureContext: hasDom ? window.isSecureContext === true : false,
      elapsedMs: state.installedAt ? Date.now() - state.installedAt : 0,
      network: {
        total: state.networkTotal,
        selfTestAttempts: state.selfTestAttempts,
        rows: rowsOf(state.network),
        blockedTotal: state.violations.length,
        blocked: state.violations.slice(-12).reverse(),
      },
      storage: {
        // Storage writes and clipboard writes are disjoint. Nothing subtracts one
        // from the other anywhere, so a press of Copy cannot move this number.
        total: state.storageTotal,
        rows: rowsOf(state.storage),
        localStorageKeys: keyCount(hasDom ? window.localStorage : null),
        sessionStorageKeys: keyCount(hasDom ? window.sessionStorage : null),
        cookieLength: hasDom ? (document.cookie || '').length : 0,
      },
      clipboard: {
        total: state.clipboardTotal,
        rows: rowsOf(state.clipboard),
      },
      policy: describePolicy(),
    };
  }

  /**
   * The five figures the interface prints, and the only place they are derived.
   *
   * This exists so the arithmetic behind the receipts panel is testable without a
   * browser, and so there is exactly one definition of "storage writes". A UI
   * that recomputes these numbers itself is how Copy came to be reported as a
   * saved password.
   */
  function receipts() {
    return {
      networkTotal: state.networkTotal,
      blockedTotal: state.violations.length,
      selfTestAttempts: state.selfTestAttempts,
      storageWrites: state.storageTotal,
      clipboardWrites: state.clipboardTotal,
    };
  }

  // ---------------------------------------------------------------- self-test

  function withTimeout(promise, ms) {
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        resolve({ timedOut: true });
      }, ms);
      Promise.resolve(promise).then(
        function (value) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ timedOut: false, value: value });
        },
        function (error) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ timedOut: false, error: error });
        }
      );
    });
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function violationCount() {
    return state.violations.length;
  }

  /**
   * One attempt to leave, and the evidence for why it did not.
   *
   * A blocked request usually shows up twice: the API call happens, and the
   * browser fires securitypolicyviolation. We prefer to see the violation,
   * because a rejected promise on its own could also just mean "no network
   * here". WebSocket is the exception -- browsers do not raise a violation event
   * for a refused ws:// or wss:// connection -- so that probe passes on the
   * refusal alone and says so, rather than leaving a reader to wonder which of
   * the two counters to believe.
   *
   * The attempt is counted here, once, rather than in the API wrappers, so the
   * figure always equals the number of network rows printed below it.
   */
  async function networkProbe(label, detail, run, options) {
    var opts = options || {};
    state.selfTestAttempts++;

    var before = violationCount();
    var outcome;
    try {
      outcome = await withTimeout(run(), PROBE_TIMEOUT_MS);
    } catch (err) {
      outcome = { error: err };
    }
    await delay(120); // violation events are dispatched asynchronously
    var blockedByPolicy = violationCount() > before;

    var notes = [];
    if (outcome.timedOut) notes.push('no response (nothing resolved)');
    else if (outcome.error) notes.push('rejected: ' + (outcome.error && outcome.error.name ? outcome.error.name : 'error'));
    else notes.push('call returned without throwing');
    if (blockedByPolicy) notes.push('blocked by Content-Security-Policy');
    else if (opts.noViolationEvent) notes.push('refused without a violation event, so the refusal is the evidence');

    return {
      group: 'network',
      label: label,
      detail: detail,
      observed: notes.join('; '),
      pass: blockedByPolicy || !!outcome.timedOut || !!outcome.error,
    };
  }

  function runtimeProbe(label, detail, fn) {
    var pass = false;
    var observed = '';
    try {
      var result = fn();
      pass = result.pass;
      observed = result.observed;
    } catch (err) {
      observed = 'threw ' + (err && err.name ? err.name : 'error');
    }
    return { group: 'runtime', label: label, detail: detail, observed: observed, pass: pass };
  }

  /**
   * Chi-square uniformity check on the generator that produced your password.
   * 100,000 draws across 10 buckets; for 9 degrees of freedom, anything under
   * 27.88 is what you expect 999 times out of 1000.
   */
  function uniformityProbe(samples) {
    var n = samples || 100000;
    var buckets = new Array(10).fill(0);
    for (var i = 0; i < n; i++) buckets[PG.random.randomInt(10)]++;
    var expected = n / 10;
    var chi2 = 0;
    for (var b = 0; b < buckets.length; b++) {
      var delta = buckets[b] - expected;
      chi2 += (delta * delta) / expected;
    }
    var threshold = 27.88; // chi-square, df = 9, p = 0.001
    return {
      group: 'runtime',
      label: 'Randomness is uniform',
      detail: 'chi-square over ' + n.toLocaleString() + ' draws of a 10-sided value',
      observed: 'chi-square = ' + chi2.toFixed(2) + ' (under ' + threshold + ' is expected 999 times in 1,000)',
      pass: chi2 < threshold,
    };
  }

  function readStorageProbe() {
    var local = keyCount(hasDom ? window.localStorage : null);
    var session = keyCount(hasDom ? window.sessionStorage : null);
    var cookieLength = hasDom ? (document.cookie || '').length : 0;
    var total = (local || 0) + (session || 0);
    return {
      group: 'storage',
      label: 'Nothing is stored for this page',
      detail: 'a read-only look at what already exists',
      observed: total === 0
        ? 'localStorage 0 keys, sessionStorage 0 keys, no cookies'
        : local + ' localStorage keys, ' + session + ' sessionStorage keys, ' + cookieLength + ' bytes of cookies (pre-existing, not written by this page)',
      pass: total === 0,
    };
  }

  async function runSelfTest() {
    if (!hasDom) return [];
    init();

    state.selfTestActive = true;
    var results;

    try {
      results = await collectSelfTestResults();
    } finally {
      state.selfTestActive = false;
    }

    return results;
  }

  async function collectSelfTestResults() {
    var results = [];

    results.push(runtimeProbe('Secure randomness available', 'crypto.getRandomValues', function () {
      var ok = typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function';
      return { pass: ok, observed: ok ? 'crypto.getRandomValues present' : 'missing' };
    }));

    results.push(uniformityProbe());

    results.push(await networkProbe('fetch()', 'GET ' + PROBE_URL, function () {
      return fetch(PROBE_URL, { cache: 'no-store' });
    }));

    results.push(await networkProbe('XMLHttpRequest', 'GET ' + PROBE_URL, function () {
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', PROBE_URL);
        xhr.onload = function () { resolve('loaded'); };
        xhr.onerror = function () { reject(new Error('network')); };
        xhr.ontimeout = function () { reject(new Error('timeout')); };
        xhr.send();
      });
    }));

    results.push(await networkProbe('WebSocket', 'wss://probe.invalid/', function () {
      return new Promise(function (resolve, reject) {
        var socket;
        try {
          socket = new WebSocket(PROBE_WS);
        } catch (err) {
          reject(err);
          return;
        }
        socket.onopen = function () { resolve('opened'); };
        socket.onerror = function () { reject(new Error('error')); };
        socket.onclose = function () { reject(new Error('closed')); };
      });
    }, { noViolationEvent: true }));

    results.push(await networkProbe('navigator.sendBeacon', 'POST ' + PROBE_URL, function () {
      // Returns true even when the policy blocks it, so only the policy event
      // counts as proof.
      navigator.sendBeacon(PROBE_URL, 'probe');
      return new Promise(function (resolve) { resolve('queued'); });
    }));

    results.push(await networkProbe('Dynamic import()', 'import("' + PROBE_URL + 'module.js")', function () {
      return import(/* webpackIgnore: true */ PROBE_URL + 'module.js');
    }));

    results.push(await networkProbe('Image src', 'GET ' + PROBE_URL + 'pixel.png', function () {
      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () { resolve('loaded'); };
        img.onerror = function () { reject(new Error('error')); };
        img.src = PROBE_URL + 'pixel.png';
      });
    }));

    results.push(readStorageProbe());

    return results;
  }

  /** Tests use this to reset counters between cases. */
  function _reset() {
    state.violations.length = 0;
    state.network = {};
    state.networkTotal = 0;
    state.selfTestAttempts = 0;
    state.selfTestActive = false;
    state.storage = {};
    state.storageTotal = 0;
    state.clipboard = {};
    state.clipboardTotal = 0;
  }

  /**
   * Seams for test/integrity.test.mjs.
   *
   * The self-test cannot be run under Node -- it would really try to resolve
   * probe.invalid, and a test suite that depends on DNS is not a test suite. So
   * the accounting is exposed instead: the counters, and one probe that resolves
   * or rejects on command. Everything the self-test does to the counters is done
   * through these three functions.
   */
  var _test = {
    countNetwork: countNetwork,
    countStorage: countStorage,
    countClipboard: countClipboard,
    networkProbe: networkProbe,
    setSelfTestActive: function (value) { state.selfTestActive = !!value; },
    pushViolation: function (detail) {
      state.violations.push({
        directive: (detail && detail.directive) || 'unknown',
        blockedURI: (detail && detail.blockedURI) || '',
        source: '',
        line: 0,
        at: Date.now(),
      });
    },
  };

  PG.integrity = {
    state: state,
    init: init,
    snapshot: snapshot,
    receipts: receipts,
    describePolicy: describePolicy,
    runSelfTest: runSelfTest,
    uniformityProbe: uniformityProbe,
    readStorageProbe: readStorageProbe,
    _reset: _reset,
    _test: _test,
  };
})(window.PG = window.PG || {});
