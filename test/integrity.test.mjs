/*
 * integrity.test.mjs -- the receipts, checked.
 *
 * This module is the page's evidence, so "trust me" is not good enough for any
 * of it: every figure below is asserted against the counters the interface
 * actually prints. The clipboard/storage split is the important one. It used to
 * be arithmetic done in app.js -- total minus clipboard -- and when that
 * subtraction went missing, four presses of Copy were reported to the user as
 * four stored passwords.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadIntegrity } from './dom-stub.mjs';

/** Load the module, install the wrappers, and hand back everything. */
function open(options) {
  const env = loadIntegrity(options);
  env.integrity.init();
  return env;
}

test('the counters are wired up', () => {
  const env = open();
  try {
    assert.equal(env.integrity.state.installed, true, 'init() should install the wrappers');
    assert.equal(typeof Storage.prototype.setItem, 'function');
  } finally {
    env.uninstall();
  }
});

test('a fresh page reports nothing', () => {
  const env = open();
  try {
    assert.deepEqual(env.integrity.receipts(), {
      networkTotal: 0,
      blockedTotal: 0,
      selfTestAttempts: 0,
      storageWrites: 0,
      clipboardWrites: 0,
    });
  } finally {
    env.uninstall();
  }
});

test('writing to storage is counted', () => {
  const env = open();
  try {
    env.localStorage.setItem('theme', 'dark');
    assert.equal(env.integrity.receipts().storageWrites, 1);
    assert.equal(env.integrity.snapshot().storage.total, 1);

    env.localStorage.removeItem('theme');
    env.sessionStorage.setItem('x', '1');
    assert.equal(env.integrity.receipts().storageWrites, 3);
    assert.deepEqual(env.integrity.snapshot().storage.rows, [
      { channel: 'storage.removeItem', count: 1 },
      { channel: 'storage.setItem', count: 2 },
    ]);
  } finally {
    env.uninstall();
  }
});

test('writing a cookie is counted as storage, not as a read', () => {
  const env = open();
  try {
    // Reading the cookie jar is what the receipts panel does constantly; only
    // the setter is a write.
    void env.integrity.snapshot().storage.cookieLength;
    void env.integrity.snapshot().storage.cookieLength;
    assert.equal(env.integrity.receipts().storageWrites, 0, 'reading document.cookie is not a write');

    document.cookie = 'a=1';
    assert.equal(env.integrity.receipts().storageWrites, 1);
    assert.equal(env.cookies.get('a'), '1');
    assert.equal(env.integrity.snapshot().storage.cookieLength, 3);
  } finally {
    env.uninstall();
  }
});

test('IndexedDB and the Cache API are counted', () => {
  const env = open();
  try {
    indexedDB.open('db');
    indexedDB.deleteDatabase('db');
    caches.open('cache');
    assert.equal(env.integrity.receipts().storageWrites, 3);
    assert.deepEqual(env.integrity.snapshot().storage.rows.map((r) => r.channel), [
      'caches.open',
      'indexedDB.deleteDatabase',
      'indexedDB.open',
    ]);
  } finally {
    env.uninstall();
  }
});

// ---------------------------------------------------------------------------
// The regression this file exists for.
// ---------------------------------------------------------------------------

test('the clipboard is counted apart from storage, never inside it', () => {
  const env = open();
  try {
    for (let i = 0; i < 4; i++) navigator.clipboard.writeText('secret');

    const figures = env.integrity.receipts();
    assert.equal(figures.clipboardWrites, 4, 'four Copy presses');
    assert.equal(figures.storageWrites, 0, 'and not one of them is a stored password');

    const snap = env.integrity.snapshot();
    assert.equal(snap.storage.total, 0);
    assert.equal(snap.clipboard.total, 4);
    assert.deepEqual(snap.clipboard.rows, [{ channel: 'clipboard', count: 4 }]);
    assert.deepEqual(snap.storage.rows, [], 'clipboard must not appear among the storage channels');
  } finally {
    env.uninstall();
  }
});

test('the execCommand fallback is a clipboard write too, not a storage one', () => {
  const env = open();
  try {
    document.execCommand('copy');
    assert.equal(env.integrity.receipts().clipboardWrites, 1);
    assert.equal(env.integrity.receipts().storageWrites, 0);
  } finally {
    env.uninstall();
  }
});

test('storage and clipboard move independently', () => {
  const env = open();
  try {
    navigator.clipboard.writeText('one');
    env.localStorage.setItem('a', '1');
    navigator.clipboard.writeText('two');
    env.localStorage.setItem('b', '2');

    assert.deepEqual(env.integrity.receipts(), {
      networkTotal: 0,
      blockedTotal: 0,
      selfTestAttempts: 0,
      storageWrites: 2,
      clipboardWrites: 2,
    });
  } finally {
    env.uninstall();
  }
});

// ---------------------------------------------------------------------------
// The self-test counters.
// ---------------------------------------------------------------------------

test('the generator\'s own network calls are counted against it', () => {
  const env = open();
  try {
    // The stubbed fetch rejects, as a blocked request does, so the rejection is
    // handled here for the same reason page code has to handle it.
    fetch('https://probe.invalid/').catch(() => {});
    new XMLHttpRequest().open('GET', 'https://probe.invalid/');
    navigator.sendBeacon('https://probe.invalid/', 'x');
    WebSocket('wss://probe.invalid/');

    assert.equal(env.integrity.receipts().networkTotal, 4);
    assert.deepEqual(env.integrity.snapshot().network.rows.map((r) => r.channel), [
      'WebSocket',
      'XMLHttpRequest',
      'fetch',
      'navigator.sendBeacon',
    ]);
  } finally {
    env.uninstall();
  }
});

test('a blocked request shows up as both a call and a policy violation', () => {
  const env = open();
  try {
    fetch('https://probe.invalid/').catch(() => {});
    env.fireViolation({ directive: 'connect-src', blockedURI: 'https://probe.invalid/' });

    assert.equal(env.integrity.receipts().networkTotal, 1);
    assert.equal(env.integrity.receipts().blockedTotal, 1);
    assert.equal(env.integrity.snapshot().network.blocked[0].directive, 'connect-src');
  } finally {
    env.uninstall();
  }
});

test('each self-test probe counts one attempt, whatever APIs it touches', async () => {
  const env = open();
  const { _test, receipts } = env.integrity;
  try {
    _test.setSelfTestActive(true);

    // A probe whose body calls a wrapped API must still add exactly one attempt,
    // and must not add a network call against the generator.
    const withApiCall = await _test.networkProbe('fetch()', 'GET x', () => {
      fetch('https://probe.invalid/').catch(() => {});
      return Promise.reject(new Error('refused'));
    });
    // ...and one with no wrappable API at all, like new Image() or import().
    const unobservable = await _test.networkProbe('Image src', 'GET y', () => Promise.reject(new Error('refused')), {
      noViolationEvent: true,
    });
    const socket = await _test.networkProbe('WebSocket', 'wss://x', () => Promise.reject(new Error('refused')), {
      noViolationEvent: true,
    });

    assert.equal(receipts().selfTestAttempts, 3, 'three probes, three attempts');
    assert.equal(receipts().networkTotal, 0, 'the generator is not charged for the self-test');
    assert.equal(receipts().blockedTotal, 0);
    assert.equal(withApiCall.pass, true);
    assert.equal(unobservable.pass, true);
    assert.match(socket.observed, /refused without a violation event/);
  } finally {
    env.uninstall();
  }
});

test('an attempt blocked by the policy is reported as blocked', async () => {
  const env = open();
  try {
    env.integrity._test.setSelfTestActive(true);
    const probe = env.integrity._test.networkProbe('fetch()', 'GET x', () => {
      env.fireViolation({ directive: 'connect-src' });
      return Promise.reject(new TypeError('refused by policy'));
    });
    const result = await probe;

    assert.equal(result.pass, true);
    assert.match(result.observed, /blocked by Content-Security-Policy/);
    assert.equal(env.integrity.receipts().blockedTotal, 1);
    assert.equal(env.integrity.receipts().selfTestAttempts, 1);
  } finally {
    env.uninstall();
  }
});

test('a probe that returns without throwing and raises no violation fails', async () => {
  const env = open();
  try {
    env.integrity._test.setSelfTestActive(true);
    const result = await env.integrity._test.networkProbe('quiet()', 'nothing', () => Promise.resolve('fine'));

    assert.equal(result.pass, false, 'nothing was refused, so nothing was proved');
    assert.match(result.observed, /call returned without throwing/);
  } finally {
    env.uninstall();
  }
});

// ---------------------------------------------------------------------------
// Policy, storage readings, and the reset seam.
// ---------------------------------------------------------------------------

test('the policy is read back out of the document', () => {
  const env = loadIntegrity({
    policy: "default-src 'none'; script-src 'sha256-abc'; connect-src 'none'",
  });
  try {
    const policy = env.integrity.describePolicy();
    assert.equal(policy.raw.includes('connect-src'), true);
    assert.deepEqual(policy.directives, [
      { name: 'default-src', value: "'none'" },
      { name: 'script-src', value: "'sha256-abc'" },
      { name: 'connect-src', value: "'none'" },
    ]);
  } finally {
    env.uninstall();
  }
});

test('a page with no policy tag reports no policy rather than inventing one', () => {
  const env = open();
  try {
    assert.equal(env.integrity.describePolicy(), null);
  } finally {
    env.uninstall();
  }
});

test('the storage probe passes on an empty origin and names what is there', () => {
  const env = open();
  try {
    const clean = env.integrity.readStorageProbe();
    assert.equal(clean.group, 'storage');
    assert.equal(clean.pass, true);
    assert.match(clean.observed, /localStorage 0 keys/);
    assert.equal(env.integrity.receipts().storageWrites, 0, 'inspecting storage does not write to it');

    env.localStorage.setItem('left', 'over');
    const dirty = env.integrity.readStorageProbe();
    assert.equal(dirty.pass, false);
    assert.match(dirty.observed, /pre-existing, not written by this page/);
  } finally {
    env.uninstall();
  }
});

test('the origin receipt distinguishes a local file from a served page', () => {
  const served = open();
  try {
    const snap = served.integrity.snapshot();
    assert.equal(snap.origin, 'https://generator.test');
    assert.equal(snap.protocol, 'https:');
    assert.equal(snap.isSecureContext, true);
  } finally {
    served.uninstall();
  }

  const asFile = loadIntegrity({ origin: 'file://', protocol: 'file:' });
  try {
    const snap = asFile.integrity.snapshot();
    assert.equal(snap.protocol, 'file:');
    assert.equal(snap.origin, 'file://');
  } finally {
    asFile.uninstall();
  }
});

test('the uniformity probe passes on real draws', () => {
  const env = open();
  try {
    // A small sample, because this is the only test here that touches entropy:
    // the point is that the wiring works, not that chi-square is small.
    const result = env.integrity.uniformityProbe(20000);
    assert.equal(result.group, 'runtime');
    assert.equal(result.pass, true, result.observed);
    assert.match(result.observed, /chi-square = \d/);
  } finally {
    env.uninstall();
  }
});

test('the counters can be reset between cases', () => {
  const env = open();
  try {
    env.localStorage.setItem('a', '1');
    navigator.clipboard.writeText('x');
    env.fireViolation({});

    env.integrity._reset();
    assert.deepEqual(env.integrity.receipts(), {
      networkTotal: 0,
      blockedTotal: 0,
      selfTestAttempts: 0,
      storageWrites: 0,
      clipboardWrites: 0,
    });
    // Resetting the counters does not unpatch the APIs: a later write is still
    // seen, which is what stops a reset from looking like a clean slate.
    env.localStorage.setItem('b', '2');
    assert.equal(env.integrity.receipts().storageWrites, 1);
  } finally {
    env.uninstall();
  }
});
