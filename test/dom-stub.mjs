/*
 * dom-stub.mjs -- just enough browser for src/lib/integrity.js to run in Node.
 *
 * integrity.js is the file that produces the page's evidence, and until now it
 * was the one module with no tests at all -- which is how a press of Copy came
 * to be counted as a stored password. Testing it needs a DOM, but not a real
 * one: the module only touches a short list of APIs, and every one of them is
 * here.
 *
 * What the module reaches for, and what stands in for it:
 *
 *   window.fetch, WebSocket, EventSource, Worker, SharedWorker,
 *   RTCPeerConnection   -> plain functions on the stub window, so wrap() finds
 *                           something to replace
 *   XMLHttpRequest.prototype.open, navigator.sendBeacon
 *   navigator.serviceWorker.register
 *   Storage.prototype.{setItem,removeItem,clear}, window.{local,session}Storage
 *   IDBFactory.prototype.{open,deleteDatabase}
 *   CacheStorage.prototype.{open,match,delete}
 *   Document.prototype.cookie (a setter, or wrapSetter declines to patch it)
 *   document.addEventListener, document.querySelector, document.cookie
 *   location.origin, location.protocol, window.isSecureContext
 *
 * The real global names are installed and removed around each test, because the
 * module reads them as globals rather than off `window`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every global this stub owns, so uninstall() can put the old one back. */
const OWNED = [
  'document', 'Document', 'location', 'navigator', 'Storage',
  'indexedDB', 'IDBFactory', 'caches', 'CacheStorage', 'XMLHttpRequest',
  // In a browser these are properties of window and bare references resolve to
  // them. Node has its own fetch and WebSocket, so the stub takes them over and
  // gives them back: otherwise a test calling fetch() would quietly attempt a
  // real request, and one calling window.fetch() would not be counted at all.
  'fetch', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker', 'RTCPeerConnection',
];

function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
}

/**
 * A Storage whose writes really land in a Map, so `length` and `key()` behave
 * and a test can prove the counters saw a write that a reader would also see.
 */
function makeStorage() {
  const map = new Map();

  function Storage() {}
  Storage.prototype.getItem = function (key) {
    return map.has(String(key)) ? map.get(String(key)) : null;
  };
  Storage.prototype.setItem = function (key, value) {
    map.set(String(key), String(value));
  };
  Storage.prototype.removeItem = function (key) {
    map.delete(String(key));
  };
  Storage.prototype.clear = function () {
    map.clear();
  };
  Object.defineProperty(Storage.prototype, 'length', {
    get: function () { return map.size; },
  });
  Storage.prototype.key = function (index) {
    return Array.from(map.keys())[index] ?? null;
  };

  function makeInstance() {
    const store = Object.create(Storage.prototype);
    // Browsers hand back an object whose prototype is Storage.prototype; the
    // module patches the prototype precisely because the instance may differ.
    Object.setPrototypeOf(store, Storage.prototype);
    return store;
  }

  return { Storage, makeInstance, map };
}

/**
 * Install the stub, load integrity.js against it, and return the namespace.
 *
 * lib/random.js comes along because integrity.js's uniformity probe draws from
 * it, and loading it in that order matches tools/build.mjs.
 *
 * @param {object} [options]
 * @param {string} [options.policy]      value for the CSP meta's content attribute
 * @param {string} [options.origin]
 * @param {string} [options.protocol]
 * @param {boolean} [options.secureContext]
 */
export function loadIntegrity(options = {}) {
  const saved = new Map();
  for (const name of OWNED) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }

  const { Storage, makeInstance, map } = makeStorage();
  const localStorage = makeInstance();
  const sessionStorage = makeInstance();

  function IDBFactory() {}
  IDBFactory.prototype.open = function () {};
  IDBFactory.prototype.deleteDatabase = function () {};

  function CacheStorage() {}
  CacheStorage.prototype.open = function () {};
  CacheStorage.prototype.match = function () {};
  CacheStorage.prototype.delete = function () {};

  function XMLHttpRequest() {}
  XMLHttpRequest.prototype.open = function () {};
  XMLHttpRequest.prototype.send = function () {};

  function Document() {}
  // A getter/setter pair, because wrapSetter ignores anything else and the
  // cookie counter would silently never exist.
  Object.defineProperty(Document.prototype, 'cookie', {
    configurable: true,
    enumerable: true,
    get: function () { return this._cookie || ''; },
    set: function (value) {
      this._cookie = String(value);
      const pair = String(value).split(';')[0];
      const eq = pair.indexOf('=');
      if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      else cookies.delete(pair.trim());
    },
  });

  const cookies = new Map();
  const listeners = new Map();

  const documentStub = {
    _cookie: '',
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    removeEventListener() {},
    querySelector(selector) {
      if (selector === 'meta[http-equiv="Content-Security-Policy"]' && options.policy) {
        return {
          getAttribute(name) {
            return name === 'content' ? options.policy : null;
          },
        };
      }
      return null;
    },
    execCommand() { return true; },
  };
  Object.setPrototypeOf(documentStub, Document.prototype);

  const win = {
    fetch: function () { return Promise.reject(new Error('blocked')); },
    WebSocket: function () {},
    EventSource: function () {},
    Worker: function () {},
    SharedWorker: function () {},
    RTCPeerConnection: function () {},
    localStorage,
    sessionStorage,
    isSecureContext: options.secureContext !== false,
  };

  const navigatorStub = {
    sendBeacon() { return true; },
    clipboard: {
      writeText() { return Promise.resolve(); },
      write() { return Promise.resolve(); },
    },
    // Deliberately absent: serviceWorker is a getter on the real navigator and
    // the module guards on it, so leaving it undefined exercises that guard.
  };

  const documentInstance = new Document();
  Object.assign(documentInstance, documentStub);
  documentInstance.cookie = '';

  defineGlobal('Document', Document);
  defineGlobal('Storage', Storage);
  defineGlobal('IDBFactory', IDBFactory);
  defineGlobal('CacheStorage', CacheStorage);
  defineGlobal('XMLHttpRequest', XMLHttpRequest);
  defineGlobal('document', documentInstance);
  defineGlobal('location', {
    origin: options.origin || 'https://generator.test',
    protocol: options.protocol || 'https:',
  });
  defineGlobal('navigator', navigatorStub);
  defineGlobal('indexedDB', new IDBFactory());
  defineGlobal('caches', new CacheStorage());

  // These must be accessors, not copies: init() replaces window.fetch with a
  // counting wrapper, and a bare fetch() in a test has to reach that wrapper
  // rather than the function object that was current before init() ran.
  for (const name of ['fetch', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker', 'RTCPeerConnection']) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() { return win[name]; },
      set(value) { win[name] = value; },
    });
  }

  const code = ['lib/random.js', 'lib/integrity.js']
    .map((rel) => readFileSync(join(root, 'src', rel), 'utf8'))
    .join('\n');
  const compile = new Function('window', 'crypto', code + '\n;return window.PG;');
  const PG = compile(win, globalThis.crypto);

  function uninstall() {
    for (const name of OWNED) {
      const previous = saved.get(name);
      if (previous) Object.defineProperty(globalThis, name, previous);
      else delete globalThis[name];
    }
  }

  return {
    PG,
    integrity: PG.integrity,
    window: win,
    localStorage,
    sessionStorage,
    cookies,
    /** Fire a securitypolicyviolation the way the browser would. */
    fireViolation(detail) {
      for (const handler of listeners.get('securitypolicyviolation') || []) {
        handler({
          violatedDirective: (detail && detail.directive) || 'connect-src',
          blockedURI: (detail && detail.blockedURI) || 'https://probe.invalid/',
          sourceFile: '',
          lineNumber: 0,
        });
      }
    },
    uninstall,
  };
}
