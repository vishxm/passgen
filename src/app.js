/*
 * app.js -- wiring. Reads the controls, calls the generators, paints the result,
 * and keeps the receipts panel honest.
 *
 * Two rules hold throughout this file:
 *   - Generated text only ever reaches the DOM through textContent. A password
 *     is attacker-adjacent data; it never becomes markup.
 *   - Styling happens through classes and CSSOM custom properties, never through
 *     style attributes, which the page's own policy forbids.
 */
(function (PG) {
  'use strict';

  var generators = PG.generators;
  var entropy = PG.entropy;
  var integrity = PG.integrity;
  var controls = PG.controls;

  var BUILD = PG.BUILD || { sourceDigest: 'unbuilt', version: 'dev' };

  var state = {
    mode: 'password',
    result: null,
    bits: 0,
  };

  // ------------------------------------------------------------------ dom

  function $(id) {
    return document.getElementById(id);
  }

  function setText(node, text) {
    if (node) node.textContent = text;
  }

  function show(node, visible) {
    if (!node) return;
    if (visible) node.removeAttribute('hidden');
    else node.setAttribute('hidden', '');
  }

  function checked(id) {
    var node = $(id);
    return !!(node && node.checked);
  }

  function valueOf(id, fallback) {
    var node = $(id);
    if (!node) return fallback;
    var raw = node.value;
    return raw === '' ? fallback : raw;
  }

  // ------------------------------------------------------------------- flash

  var FLASH_MS = 2500;
  var FLASH_FADE_MS = 260;
  var flashTimer = null;

  function cancelFlashTimer() {
    if (flashTimer === null) return;
    clearTimeout(flashTimer);
    flashTimer = null;
  }

  /**
   * A transient message: copied, refused, cleared.
   *
   * The hinge used to do this job, and paid for it -- copySecret() overwrote the
   * spec line with "On your clipboard" and it did not come back until you
   * regenerated, so the one line that answers "what did my slider just do?"
   * was gone exactly when you were deciding whether to press Copy again.
   *
   * The node is emptied rather than removed, because a live region that is taken
   * out of the document stops being announced, and opacity carries the fade so
   * nothing reflows mid-transition.
   */
  function flash(message) {
    var node = $('secret-flash');
    if (!node) return;
    cancelFlashTimer();

    setText(node, message);
    node.classList.add('is-on');
    flashTimer = setTimeout(function () {
      flashTimer = null;
      hideFlash();
    }, FLASH_MS);
  }

  /** Fade first, empty once the transition is over, so nothing jumps. */
  function hideFlash() {
    var node = $('secret-flash');
    if (!node) return;
    node.classList.remove('is-on');
    flashTimer = setTimeout(function () {
      flashTimer = null;
      setText(node, '');
    }, FLASH_FADE_MS);
  }

  /**
   * Take a pending message down at once rather than letting it linger. Used when
   * a new secret makes it stale: the clipboard note describes the last value, and
   * the plate no longer holds it.
   */
  function clearFlash() {
    var node = $('secret-flash');
    if (!node) return;
    cancelFlashTimer();
    setText(node, '');
    node.classList.remove('is-on');
  }

  // ------------------------------------------------------------------ options

  function readOptions() {
    if (state.mode === 'password') {
      return {
        length: parseInt(valueOf('length', 20), 10),
        useLower: checked('use-lower'),
        useUpper: checked('use-upper'),
        useDigits: checked('use-digits'),
        useSymbols: checked('use-symbols'),
        symbolsOverride: valueOf('symbols-override', ''),
        exclude: valueOf('exclude', ''),
        excludeAmbiguous: checked('exclude-ambiguous'),
        noRepeat: checked('no-repeat'),
        requireEach: checked('require-each'),
      };
    }
    if (state.mode === 'passphrase') {
      return {
        words: parseInt(valueOf('words', 6), 10),
        separator: valueOf('separator', 'dash'),
        capitalize: checked('capitalize'),
        appendDigit: checked('append-digit'),
      };
    }
    if (state.mode === 'pin') {
      return {
        length: parseInt(valueOf('pin-length', 6), 10),
        noRepeat: checked('pin-no-repeat'),
      };
    }
    return {
      alphabet: valueOf('custom-alphabet', ''),
      length: parseInt(valueOf('custom-length', 20), 10),
      noRepeat: checked('custom-no-repeat'),
    };
  }

  // ------------------------------------------------------------------ colouring

  var CLASS_OF_KEY = { lower: '', upper: 'up', digits: 'dg', symbols: 'sy' };

  /** char -> css class suffix, using the resolved alphabet so it stays accurate. */
  function colouringFor(result) {
    var map = Object.create(null);
    var alphabet = result.alphabet;

    if (alphabet && alphabet.classes) {
      alphabet.classes.forEach(function (cls) {
        var suffix = CLASS_OF_KEY[cls.key] || 'ot';
        cls.chars.forEach(function (ch) {
          map[ch] = suffix;
        });
      });
      return map;
    }

    if (result.kind === 'pin') {
      for (var d = 0; d <= 9; d++) map[String(d)] = 'dg';
      return map;
    }

    if (result.kind === 'passphrase') {
      return null; // handled structurally: word spans plus separator spans
    }

    return null;
  }

  function classForCharacter(ch, map) {
    if (ch === ' ' || ch === '\t') return 'sp';
    var suffix = map ? map[ch] : undefined;
    if (suffix === undefined) return 'ot';
    return suffix;
  }

  function appendSpan(parent, text, suffix) {
    if (!suffix) {
      parent.appendChild(document.createTextNode(text));
      return;
    }
    var span = document.createElement('span');
    span.className = suffix;
    span.textContent = text;
    parent.appendChild(span);
  }

  function paintSecret(result) {
    var host = $('secret');
    var fragment = document.createDocumentFragment();
    var value = result.value;

    if (result.kind === 'passphrase' && result.segments) {
      result.segments.forEach(function (segment) {
        if (segment.type === 'word') appendSpan(fragment, segment.text, 'wd');
        else if (segment.type === 'digit') appendSpan(fragment, segment.text, 'dg');
        else if (segment.text === '') appendSpan(fragment, '', '');
        else appendSpan(fragment, segment.text, segment.text === ' ' ? 'sp' : 'sy');
      });
    } else {
      var map = colouringFor(result);
      for (var i = 0; i < value.length; i++) {
        appendSpan(fragment, value[i], classForCharacter(value[i], map));
      }
    }

    host.textContent = '';
    host.appendChild(fragment);
    host.style.setProperty('--secret-size', secretSize(value.length) + 'px');
    // Re-trigger the settle animation. Reading offsetWidth forces the layout the
    // class change needs; without it a second regenerate in the same tick would
    // just re-apply a class that is already there and nothing would move.
    host.classList.remove('is-fresh');
    void host.offsetWidth;
    host.classList.add('is-fresh');
    return host;
  }

  /*
   * Six buckets, stepped for the single-column card. The plate grew a step when
   * the two panels became one, and with it the type: at 720px wide the longest
   * bucket still leaves a line to spare at two rows for a 128-character secret.
   */
  function secretSize(length) {
    if (length <= 16) return 36;
    if (length <= 24) return 32;
    if (length <= 32) return 28;
    if (length <= 48) return 24;
    if (length <= 72) return 20;
    return 18;
  }

  // ------------------------------------------------------------------ entropy

  function bitsFor(result) {
    if (result.kind === 'passphrase') {
      return entropy.bitsForPassphrase(result.spec.words, result.spec.wordlistSize) + result.spec.extraBits;
    }
    return entropy.bitsForClasses(result.spec);
  }

  function paintMeter(result) {
    var bits = bitsFor(result);
    state.bits = bits;

    var verdict = entropy.tier(bits);

    var verdictNode = $('strength-label');
    verdictNode.textContent = verdict.label;
    verdictNode.className = 'meter-verdict tier-' + verdict.level;

    setText($('bits-label'), bits.toFixed(1) + ' bits');

    var fill = $('meter-fill');
    fill.style.setProperty('--fill', Math.max(2, Math.min(100, (bits / 128) * 100)) + '%');
    fill.className = 'meter-fill tier-' + verdict.level;
  }

  /**
   * The crack table, which no longer sits under the meter but has not gone
   * anywhere either: it is inside the Verify this page disclosure, and it is
   * still entropy.crackTimeRows() doing the arithmetic. Kept in its own function
   * so that moving it out of view did not also mean painting it somewhere else.
   */
  function paintCrackRows(bits) {
    var rows = entropy.crackTimeRows(bits);
    var body = $('crack-rows');
    body.textContent = '';
    show(document.querySelector('.crack'), true);
    rows.forEach(function (row) {
      var tr = document.createElement('tr');

      var label = document.createElement('td');
      label.className = 'c-label';
      label.textContent = row.label;

      var detail = document.createElement('td');
      detail.className = 'c-detail';
      detail.textContent = row.detail;

      var time = document.createElement('td');
      time.className = 'c-time';
      time.textContent = row.seconds;

      tr.appendChild(label);
      tr.appendChild(detail);
      tr.appendChild(time);
      body.appendChild(tr);
    });
  }

  // ------------------------------------------------------------------ generate

  function generate() {
    var options = readOptions();
    var result;

    try {
      if (state.mode === 'password') result = generators.generatePassword(options);
      else if (state.mode === 'passphrase') result = generators.generatePassphrase(options, PG.WORDLIST);
      else if (state.mode === 'pin') result = generators.generatePin(options);
      else result = generators.generateCustom(options);
    } catch (err) {
      state.result = null;
      var host = $('secret');
      host.textContent = '';
      var errorNode = $('secret-error');
      errorNode.textContent = err && err.message ? err.message : 'Could not generate a value.';
      show(errorNode, true);
      setText($('secret-status'), '');
      setText($('strength-label'), '—');
      $('strength-label').className = 'meter-verdict';
      setText($('bits-label'), '—');
      $('meter-fill').style.setProperty('--fill', '0%');
      $('crack-rows').textContent = '';
      // The caption promises a table. With no rows under it the promise is
      // broken, so the whole table goes rather than leaving the heading
      // stranded above an empty box.
      show(document.querySelector('.crack'), false);
      return;
    }

    show($('secret-error'), false);
    state.result = result;
    show($('btn-clear-clip'), false);
    $('btn-copy').textContent = 'Copy';
    clearFlash();

    paintSecret(result);
    paintMeter(result);
    paintCrackRows(state.bits);

    setText($('secret-status'), controls.specText(result, PG.WORDLIST ? PG.WORDLIST.length : 0));

    // A screen reader announces the plate, so it has to be told what kind of
    // thing is on it: without this every mode was announced as a password.
    $('secret').setAttribute('aria-label', 'Generated ' + controls.kindLabel(state.mode));
  }

  // ------------------------------------------------------------------ clipboard

  function legacyCopy(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.setProperty('position', 'fixed');
    area.style.setProperty('top', '-1000px');
    area.style.setProperty('opacity', '0');
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (err) {
      ok = false;
    }
    document.body.removeChild(area);
    return ok;
  }

  function copySecret() {
    if (!state.result) return Promise.resolve(false);
    var text = state.result.value;

    var viaClipboard = navigator.clipboard && navigator.clipboard.writeText
      ? navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); })
      : Promise.resolve(legacyCopy(text));

    return viaClipboard.then(function (ok) {
      if (ok) {
        $('btn-copy').textContent = 'Copied';
        show($('btn-clear-clip'), true);
        flash('On your clipboard. This page has no memory of it beyond this tab.');
      } else {
        flash('The browser refused clipboard access. Select the text and copy it by hand.');
      }
      renderIntegrity();
      return ok;
    });
  }

  function clearClipboard() {
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      flash('This browser does not allow the page to clear the clipboard.');
      return Promise.resolve(false);
    }
    return navigator.clipboard.writeText('').then(
      function () {
        $('btn-copy').textContent = 'Copy';
        show($('btn-clear-clip'), false);
        flash('Clipboard cleared. Some clipboard managers keep their own history.');
        renderIntegrity();
        return true;
      },
      function () {
        flash('The browser would not let the page clear the clipboard.');
        return false;
      }
    );
  }

  // ------------------------------------------------------------------ receipts

  var WATCHED_CHANNELS = [
    'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker',
    'RTCPeerConnection (WebRTC)', 'navigator.sendBeacon', 'serviceWorker.register',
  ];

  var WATCHED_STORAGE = [
    'storage.setItem', 'storage.removeItem', 'storage.clear',
    'document.cookie', 'indexedDB.open', 'indexedDB.deleteDatabase',
    'caches.open', 'caches.match', 'caches.delete',
  ];

  var WATCHED_CLIPBOARD = ['clipboard'];

  /**
   * Every figure on screen comes from integrity.receipts(). Nothing here does
   * arithmetic on the counters, which is how a press of Copy once came to be
   * reported to the user as a saved password.
   */
  function renderIntegrity() {
    var snap = integrity.snapshot();
    var figures = integrity.receipts();

    setText($('net-total'), String(figures.networkTotal));
    setText($('net-blocked'), String(figures.blockedTotal));
    setText($('net-selftest'), String(figures.selfTestAttempts));
    setText($('store-total'), String(figures.storageWrites));
    setText($('clip-writes'), String(figures.clipboardWrites));
    setText($('counter-origin'), originLabel(snap));

    paintCounter($('strip-network'), figures.networkTotal, 'network call');
    paintCounter($('strip-storage'), figures.storageWrites, 'storage write');

    $('net-total').classList.toggle('counter-alarm', figures.networkTotal > 0);
    $('store-total').classList.toggle('counter-alarm', figures.storageWrites > 0);

    paintChannels(snap);
    paintClock(snap);
  }

  /**
   * One item of the footer strip. Rebuilt rather than written into, because the
   * label is singular for exactly one call and the figure is the part that has to
   * stay tabular.
   */
  function paintCounter(node, count, noun) {
    if (!node) return;
    node.textContent = '';

    var value = document.createElement('span');
    value.className = 'strip-value';
    value.textContent = String(count);
    node.appendChild(value);
    node.appendChild(document.createTextNode(' ' + (count === 1 ? noun : noun + 's')));

    node.classList.toggle('strip-alarm', count > 0);
  }

  /**
   * A receipt, not a label: this is the origin the page is running on, which is
   * how you see there is no server behind it. Opened as a file there is no origin
   * to name, and saying so is more honest than printing "null".
   */
  function originLabel(snap) {
    if (snap.protocol === 'file:') return 'none — a local file';
    return snap.origin;
  }

  function paintChannels(snap) {
    var host = $('channel-list');
    host.textContent = '';

    var rows = [];
    WATCHED_CHANNELS.forEach(function (name) {
      rows.push({ name: name, count: snap.network.rows.filter(function (r) {
        return r.channel === name;
      })[0] });
    });
    WATCHED_STORAGE.forEach(function (name) {
      var match = snap.storage.rows.filter(function (r) { return r.channel === name; })[0];
      rows.push({ name: name, count: match });
    });
    WATCHED_CLIPBOARD.forEach(function (name) {
      var match = snap.clipboard.rows.filter(function (r) { return r.channel === name; })[0];
      rows.push({ name: name, count: match });
    });

    var idle = document.createElement('p');
    idle.className = 'channel-idle';
    idle.textContent = 'These wrappers go on the APIs as the page loads, before anything else runs. A count of zero means nothing called them. The network channels stay at zero even after a self-test, because those attempts are counted on the row above instead — that way "network calls, by the generator" keeps meaning the generator, and nothing else.';
    host.appendChild(idle);

    rows.forEach(function (row) {
      var line = document.createElement('div');
      line.className = 'channel-row' + (row.count ? ' is-hit' : '');

      var name = document.createElement('span');
      name.className = 'channel-name';
      name.textContent = row.name;

      var count = document.createElement('span');
      count.className = 'channel-count';
      count.textContent = row.count ? String(row.count.count) : '0';

      line.appendChild(name);
      line.appendChild(count);
      host.appendChild(line);
    });

    var existing = snap.storage.localStorageKeys + snap.storage.sessionStorageKeys;
    var line = document.createElement('p');
    line.className = 'channel-idle';
    line.textContent = 'Already present for this origin: ' + existing + ' storage keys, ' +
      snap.storage.cookieLength + ' bytes of cookies. This page added none of them.';
    host.appendChild(line);
  }

  function paintClock(snap) {
    var seconds = Math.floor(snap.elapsedMs / 1000);
    var note = $('counter-note');
    if (!note) return;
    var figures = integrity.receipts();
    var base = 'The generator itself has made no network calls.';
    if (figures.selfTestAttempts > 0) {
      base += ' The ' + figures.selfTestAttempts + ' self-test attempts were made on purpose and every one was refused.';
      // A refused WebSocket connection raises no securitypolicyviolation event,
      // so "blocked" can legitimately sit below "attempts". Say so, rather than
      // leaving two numbers on screen that appear to disagree.
      if (figures.blockedTotal < figures.selfTestAttempts) {
        base += ' ' + figures.blockedTotal + ' of them raised a policy violation; the rest were refused before a request left.';
      }
    } else {
      base += ' Self-test attempts appear here after you run the test below.';
    }
    base += ' Clipboard writes happen only when you press Copy, and are counted apart from storage writes.';
    if (seconds >= 5) base += ' Page open ' + seconds + 's.';
    setText(note, base);
  }

  // ------------------------------------------------------------------ self-test

  function runSelfTest() {
    var button = $('btn-selftest');
    var host = $('selftest-results');
    button.disabled = true;
    button.textContent = 'Running…';
    host.textContent = '';

    return integrity.runSelfTest().then(function (results) {
      var groups = { runtime: [], network: [], storage: [] };
      results.forEach(function (row) {
        (groups[row.group] || (groups[row.group] = [])).push(row);
      });

      var titles = {
        runtime: 'Runtime',
        network: 'Attempts to leave (all should be refused)',
        storage: 'Storage',
      };

      Object.keys(groups).forEach(function (key) {
        var rows = groups[key];
        if (!rows || rows.length === 0) return;

        var section = document.createElement('div');
        section.className = 'test-group';

        var heading = document.createElement('h3');
        heading.textContent = titles[key] || key;
        section.appendChild(heading);

        rows.forEach(function (row) {
          var line = document.createElement('div');
          line.className = 'test-row ' + (row.pass ? 'test-pass' : 'test-fail');

          var mark = document.createElement('span');
          mark.className = 'test-mark';
          mark.textContent = row.pass ? '✓' : '✗';

          var body = document.createElement('div');

          var label = document.createElement('div');
          label.className = 'test-label';
          label.textContent = row.label;

          var detail = document.createElement('div');
          detail.className = 'test-detail';
          detail.textContent = row.detail;

          var observed = document.createElement('div');
          observed.className = 'test-observed';
          observed.textContent = row.observed;

          body.appendChild(label);
          body.appendChild(detail);
          body.appendChild(observed);
          line.appendChild(mark);
          line.appendChild(body);
          section.appendChild(line);
        });

        host.appendChild(section);
      });

      var failed = results.filter(function (row) { return !row.pass; }).length;
      var summary = document.createElement('p');
      summary.className = 'notice' + (failed ? ' notice-error' : '');
      summary.textContent = failed
        ? failed + ' of ' + results.length + ' checks failed. Treat this page as untrustworthy until you know why.'
        : 'All ' + results.length + ' checks passed. Every escape route was tried and refused.';
      host.appendChild(summary);

      button.disabled = false;
      button.textContent = 'Run again';
      renderIntegrity();
    }, function (err) {
      var summary = document.createElement('p');
      summary.className = 'notice notice-error';
      summary.textContent = 'The self-test could not finish: ' + (err && err.message ? err.message : 'unknown error');
      host.appendChild(summary);
      button.disabled = false;
      button.textContent = 'Run self-test';
    });
  }

  /**
   * Compare a pasted source digest with the one this build was made from.
   *
   * The wording and the match / no-match decision live in
   * controls.digestVerdict(); what is left here is reading the field and putting
   * the answer on screen.
   */
  function compareDigest() {
    var verdict = controls.digestVerdict($('digest-input').value, BUILD.sourceDigest);
    var out = $('digest-result');
    out.className = verdict.error ? 'notice notice-error' : 'notice';
    setText(out, verdict.text);
  }

  // ------------------------------------------------------------------ controls

  /**
   * Keep a range slider and the number box beside it showing the same thing.
   *
   * The slider is the source of truth -- readOptions() reads it, and the presets
   * and ceiling logic write it -- so the box is a mirror of the slider and never
   * the other way round. Which means the one rule this function exists to hold
   * is: never write to the box while the user is editing it. A clamp written back
   * mid-keystroke refills a cleared field and turns a value the user is still
   * typing into something they did not ask for, and no number that starts with a
   * digit at or below min-1 is ever reachable again. A mirror does not get
   * corrected mid-edit; it gets corrected when the edit ends.
   *
   * Both halves are arithmetic over the raw field value, so both live in
   * controls.js and are tested without a browser: typedLength() for "is there a
   * number here yet", settledLength() for "what should the box say now that the
   * user has stopped".
   */
  function linkRange(rangeId, numberId, onChange) {
    var range = $(rangeId);
    var number = $(numberId);

    function bounds() {
      return { min: parseInt(range.min, 10), max: parseInt(range.max, 10) };
    }

    function toSlider(value) {
      range.value = String(value);
      if (onChange) onChange(value);
    }

    // The slider is never mid-word, so mirroring into the box is safe.
    range.addEventListener('input', function () {
      var next = parseInt(range.value, 10);
      if (!isFinite(next)) next = bounds().min;
      number.value = String(next);
      toSlider(next);
    });

    // The box is. Write nothing back to it; an unfinished or out-of-range
    // value moves nothing at all, and a finished one is settled on blur.
    number.addEventListener('input', function () {
      var b = bounds();
      var typed = controls.typedLength(number.value);
      if (typed === null || typed < b.min || typed > b.max) return;
      toSlider(typed);
    });

    function settle() {
      var b = bounds();
      var result = controls.settledLength(number.value, b.min, b.max, range.value);
      if (number.value !== String(result.value)) number.value = String(result.value);
      if (result.changed) toSlider(result.value);
    }

    number.addEventListener('change', settle);
    number.addEventListener('blur', settle);
    number.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') number.blur();
    });
  }

  /**
   * Switch mode.
   *
   * `.mode-panel` is the whole contract: the buttons carry aria-checked and the
   * panels carry visibility, and both compare a data attribute against the active
   * mode. The always-on length slot reuses the class on purpose, so the four
   * length pairs switch with the same loop and need no second rule.
   */
  function setMode(mode) {
    state.mode = mode;
    var next = controls.modeState(mode);

    Array.from(document.querySelectorAll('.mode')).forEach(function (button) {
      button.setAttribute('aria-checked', next.isSelected(button.dataset.mode) ? 'true' : 'false');
    });
    Array.from(document.querySelectorAll('.mode-panel')).forEach(function (panel) {
      show(panel, next.showsPanel(panel.dataset.for));
    });

    applyLengthCeiling();
    generate();
  }

  /**
   * With "no repeats" on, the length cannot exceed the alphabet. Rather than
   * letting the generator refuse, shorten the slider so the ceiling is obvious.
   *
   * The ceiling itself is arithmetic over the current options and lives in
   * controls.lengthCeiling(), where it is tested without a browser. Here it only
   * reads two max attributes and, if the current value no longer fits, writes
   * the corrected one back to both the slider and its number box.
   */
  function applyLengthCeiling() {
    var ceiling = controls.lengthCeiling(state.mode, readOptions());
    if (!ceiling) return;

    var range = $(ceiling.range);
    var number = $(ceiling.number);
    range.max = String(ceiling.max);
    number.max = String(ceiling.max);

    var clamped = controls.clampToCeiling(range.value, ceiling.max);
    if (clamped === null) return;
    range.value = String(clamped);
    number.value = String(clamped);
  }

  /**
   * Put every length control back to its widest range. A preset has to do this
   * before writing new values: a range input clamps its value the moment the
   * max shrinks, so a preset would otherwise inherit the previous preset's
   * ceiling and quietly come out shorter than it asked for.
   *
   * The list of controls and the ceiling each one relaxes to come from
   * controls.relaxedCeilings(); only the DOM writes are left here.
   */
  function relaxLengthCeilings() {
    controls.relaxedCeilings().forEach(function (pair) {
      var range = $(pair.range);
      var number = $(pair.number);
      range.max = String(pair.max);
      number.max = String(pair.max);
      var clamped = pair.to(range.value);
      if (clamped === null) return;
      range.value = String(clamped);
      number.value = String(clamped);
    });
  }

  /**
   * Write one preset.
   *
   * The sequence is decided in controls.presetFor() and is load-bearing:
   * relax, then write, then resync. Doing it in any other order lets a narrowed
   * slider clamp the value the preset asked for, which is how "maximum" once
   * produced a 6-character password with no visible sign of it.
   */
  function applyPreset(name) {
    var preset = controls.presetFor(name);
    if (!preset) return;

    relaxLengthCeilings();

    Object.keys(preset.values).forEach(function (id) {
      var node = $(id);
      if (!node) return;
      var next = preset.values[id];
      if (node.type === 'checkbox') node.checked = !!next;
      else node.value = String(next);
    });

    // Keep each range slider in step with the number input we just wrote.
    preset.sync.forEach(function (pair) {
      var range = $(pair.range);
      var number = $(pair.number);
      if (number && range) range.value = number.value;
    });

    setMode(preset.mode);
  }

  /**
   * The policy the browser actually parsed, read back out of the document.
   *
   * This used to be left blank: describePolicy() was called on every snapshot
   * and the result was thrown away, so the disclosure showed an empty box under a
   * heading that promised the reader the policy. Showing what is in force is the
   * whole point of a receipt, so the absence case is stated rather than left
   * looking like an empty document.
   */
  function paintPolicy() {
    var host = $('policy-text');
    if (!host) return;

    var policy = integrity.describePolicy();
    if (!policy) {
      setText(host, 'No Content-Security-Policy meta tag was found in this document.');
      return;
    }

    var width = policy.directives.reduce(function (widest, directive) {
      return Math.max(widest, directive.name.length);
    }, 0);

    host.textContent = policy.directives.map(function (directive) {
      return directive.name.padEnd(width + 2) + directive.value;
    }).join('\n');
  }

  function populateStatics() {
    var select = $('separator');
    Object.keys(generators.SEPARATORS).forEach(function (key) {
      var option = document.createElement('option');
      option.value = key;
      option.textContent = generators.SEPARATORS[key].label;
      select.appendChild(option);
    });
    select.value = 'dash';

    setText($('ambiguous-list'), 'removes ' + Array.from(generators.AMBIGUOUS).join(' '));
    setText($('wordlist-credit'), 'the EFF Long Wordlist by Joseph Bonneau, CC BY 3.0 (eff.org/dice)');
    setText($('source-digest'), BUILD.sourceDigest);

    paintPolicy();
  }

  // ------------------------------------------------------------------ boot

  function bind() {
    linkRange('length', 'length-number', function () { generate(); });
    linkRange('words', 'words-number', function () { generate(); });
    linkRange('pin-length', 'pin-length-number', function () { generate(); });
    linkRange('custom-length', 'custom-length-number', function () { generate(); });

    ['use-lower', 'use-upper', 'use-digits', 'use-symbols', 'require-each', 'no-repeat',
      'exclude-ambiguous', 'capitalize', 'append-digit', 'pin-no-repeat', 'custom-no-repeat']
      .forEach(function (id) {
        $(id).addEventListener('change', function () {
          applyLengthCeiling();
          generate();
        });
      });

    ['exclude', 'symbols-override', 'separator', 'custom-alphabet'].forEach(function (id) {
      var node = $(id);
      node.addEventListener('input', function () {
        applyLengthCeiling();
        generate();
      });
      if (node.tagName === 'SELECT') node.addEventListener('change', generate);
    });

    Array.from(document.querySelectorAll('.mode')).forEach(function (button) {
      button.addEventListener('click', function () { setMode(button.dataset.mode); });
    });

    Array.from(document.querySelectorAll('.chip')).forEach(function (chip) {
      chip.addEventListener('click', function () { applyPreset(chip.dataset.preset); });
    });

    $('btn-regenerate').addEventListener('click', generate);
    $('btn-copy').addEventListener('click', copySecret);
    $('btn-clear-clip').addEventListener('click', clearClipboard);
    $('btn-selftest').addEventListener('click', runSelfTest);
    $('btn-digest').addEventListener('click', compareDigest);
    $('digest-input').addEventListener('keydown', function (event) {
      if (event.key === 'Enter') compareDigest();
    });

    document.addEventListener('keydown', function (event) {
      var tag = event.target && event.target.tagName;
      var typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'g' || event.key === 'G') {
        event.preventDefault();
        generate();
      }
    });

    bindDisclosures();

    window.addEventListener('focus', renderIntegrity);
    document.addEventListener('visibilitychange', renderIntegrity);
  }

  /**
   * Closing a <details> whose contents had focus drops focus to <body>, and a
   * keyboard user's next Tab starts again from the top of the document. So when
   * a panel closes around the focus, the focus goes to its summary instead --
   * which is where they just were pressing Enter on.
   */
  function bindDisclosures() {
    Array.from(document.querySelectorAll('details')).forEach(function (panel) {
      panel.addEventListener('toggle', function () {
        if (panel.open) return;
        var summary = panel.querySelector('summary');
        var active = document.activeElement;
        if (!summary || !active) return;
        if (active === summary || panel.contains(active)) summary.focus();
      });
    });
  }

  function init() {
    integrity.init();
    populateStatics();
    bind();
    generate();
    renderIntegrity();
    /*
     * One second, not 750ms. Every tick tears down and rebuilds ~19 channel rows
     * plus 6 counter nodes, and the only figure that changes is paintClock's
     * "Page open Ns." -- which is Math.floor(elapsedMs / 1000), so it has exactly
     * one-second granularity anyway. 750ms bought nothing and did a quarter more
     * DOM churn than it needed to, forever, on a page whose entire claim is that
     * nothing happens here.
     */
    setInterval(renderIntegrity, 1000);

    // A short word list means every passphrase here is weaker than the page
    // claims. That is not a message with an expiry, so it goes in the assertive
    // error line rather than the flash, which is for things that have just
    // happened and are over in a couple of seconds.
    if (PG.WORDLIST && PG.WORDLIST.length !== 7776) {
      setText($('secret-error'),
        'Warning: the embedded word list has ' + PG.WORDLIST.length + ' words, not 7776.');
      show($('secret-error'), true);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window.PG);
