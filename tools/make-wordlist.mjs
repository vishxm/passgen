/*
 * make-wordlist.mjs -- turn the raw EFF list into a source module.
 *
 * Run once (or after replacing src/data/eff_large_wordlist.txt):
 *   node tools/make-wordlist.mjs
 *
 * The output is committed, so building the app never needs a network.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'src', 'data', 'eff_large_wordlist.txt');
const target = join(root, 'src', 'lib', 'wordlist.js');

const EXPECTED_COUNT = 7776;

const raw = readFileSync(source, 'utf8');
const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);

const words = lines.map((line) => {
  const parts = line.split(/\s+/);
  const word = parts[parts.length - 1];
  if (!/^[a-z][a-z-]*$/.test(word)) {
    throw new Error(`Unexpected entry, expected a lowercase word: ${JSON.stringify(line)}`);
  }
  return word;
});

if (words.length !== EXPECTED_COUNT) {
  throw new Error(`Expected ${EXPECTED_COUNT} words, found ${words.length}. Diceware indices depend on the exact count.`);
}

const unique = new Set(words);
if (unique.size !== words.length) {
  throw new Error('The word list contains duplicates.');
}

const body = words.join(' ');

const output = `/*
 * wordlist.js -- GENERATED FILE, do not edit by hand.
 * Regenerate with: node tools/make-wordlist.mjs
 *
 * The EFF's Long Wordlist: ${EXPECTED_COUNT} words, ~12.9 bits of entropy per word.
 * "Passphrases" for Humans" / eff.org/dice -- word list by Joseph Bonneau.
 * Copyright (C) 2016 Electronic Frontier Foundation, licensed CC BY 3.0.
 * https://www.eff.org/dice  --  https://creativecommons.org/licenses/by/3.0/
 *
 * Entries are stored as one space-separated string and split at load time, which
 * is smaller than a JSON array and keeps the generated file readable.
 */
(function (PG) {
  'use strict';

  var RAW =
    '${body}';

  PG.WORDLIST = RAW.split(' ');
  PG.WORDLIST_SOURCE = {
    name: "EFF Long Wordlist",
    count: PG.WORDLIST.length,
    author: 'Joseph Bonneau',
    license: 'CC BY 3.0',
    url: 'https://www.eff.org/dice',
  };
})(window.PG = window.PG || {});
`;

writeFileSync(target, output);
console.log(`wrote ${target}`);
console.log(`  ${words.length} words, ${body.length} bytes of word data`);
console.log(`  ${unique.size} unique, ${words.filter((w) => w.includes('-')).length} hyphenated`);
