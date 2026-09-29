// La versión vive en public/version.js y debe coincidir con package.json y con la caché del service worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VERSION } from '../public/version.js';

test('versión coherente en package.json, version.js y sw.js', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(VERSION, pkg.version, 'public/version.js y package.json no coinciden');
  const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  assert.match(sw, new RegExp(`const CACHE = 'exam-monitor-v${VERSION.replaceAll('.', '\\.')}'`), 'actualiza CACHE en public/sw.js');
});
