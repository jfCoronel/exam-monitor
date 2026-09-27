// Comprueba que los diccionarios están completos y que todo lo que usa el código existe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import es from '../public/i18n/es.js';
import en from '../public/i18n/en.js';
import { CLIENT_EVENTS } from '../public/common.js';

const PUBLIC = new URL('../public/', import.meta.url).pathname;
const files = (dir, ext) => readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
  d.isDirectory() ? files(join(dir, d.name), ext) : d.name.endsWith(ext) ? [join(dir, d.name)] : []);
const placeholders = (v) => [...JSON.stringify(v).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('es y en tienen las mismas claves', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(es).sort());
});

test('mismos plurales y mismos {parámetros} en los dos idiomas', () => {
  for (const k of Object.keys(es)) {
    assert.equal(typeof en[k], typeof es[k], `${k}: uno es plural y el otro no`);
    assert.equal(placeholders(en[k]), placeholders(es[k]), `${k}: parámetros distintos`);
  }
});

test('todas las claves que usa el código existen', () => {
  const used = new Set();
  for (const f of files(PUBLIC, '.js')) {
    for (const m of readFileSync(f, 'utf8').matchAll(/\bt\(\s*'([a-zA-Z]+\.[a-zA-Z_]+)'/g)) used.add(m[1]);
  }
  for (const f of files(PUBLIC, '.html')) {
    const html = readFileSync(f, 'utf8');
    for (const m of html.matchAll(/data-i18n="([^"]+)"/g)) used.add(m[1]);
    for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
      for (const pair of m[1].split(';')) used.add(pair.split(':')[1].trim());
    }
  }
  // Claves que se construyen en tiempo de ejecución.
  for (const e of CLIENT_EVENTS) used.add(`ev.${e}`);
  for (const r of ['blur', 'hidden', 'window', 'tool']) used.add(`reason.${r}`);
  for (const s of ['waiting', 'active', 'finished']) used.add(`status.${s}`);
  for (const k of ['conn.online', 'conn.offline', 'panel.metaTab', 'panel.metaWindow']) used.add(k);
  const backend = readFileSync(join(PUBLIC, 'backend.js'), 'utf8');
  for (const m of backend.matchAll(/BackendError\('([a-z_]+)'/g)) used.add(`err.${m[1]}`);
  for (const m of backend.matchAll(/'(permission|network)'/g)) used.add(`err.${m[1]}`);

  const missing = [...used].filter((k) => !(k in es));
  assert.deepEqual(missing, [], `faltan en los diccionarios: ${missing.join(', ')}`);
});

test('el import map usa la misma versión del SDK que package.json', () => {
  const { version } = JSON.parse(readFileSync(new URL('../node_modules/firebase/package.json', import.meta.url)));
  for (const f of files(PUBLIC, '.html')) {
    for (const m of readFileSync(f, 'utf8').matchAll(/firebasejs\/([\d.]+)\//g)) {
      assert.equal(m[1], version, `${f} usa firebasejs ${m[1]}`);
    }
  }
});
