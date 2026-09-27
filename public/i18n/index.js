// Internacionalización sin build: diccionarios como módulos ES y una función t().
// Idioma: el elegido por el usuario (localStorage) → el del navegador → español.
import es from './es.js';
import en from './en.js';

const DICTS = { es, en };
export const LANGS = Object.keys(DICTS);
const LOCALES = { es: 'es-ES', en: 'en-GB' };
const KEY = 'examMonitor.lang';

let storage;
try { storage = globalThis.localStorage; } catch { /* Node o almacenamiento bloqueado */ }
let lang = pickLang();

function pickLang() {
  try {
    const saved = storage?.getItem(KEY);
    if (DICTS[saved]) return saved;
  } catch { /* almacenamiento bloqueado */ }
  for (const l of globalThis.navigator?.languages || []) {
    const base = String(l).slice(0, 2).toLowerCase();
    if (DICTS[base]) return base;
  }
  return 'es';
}

export const getLang = () => lang;
export const locale = () => LOCALES[lang];

export function setLang(l) {
  if (!DICTS[l] || l === lang) return;
  lang = l;
  try { storage?.setItem(KEY, l); } catch { /* sin persistencia */ }
  if (globalThis.document) {
    applyI18n();
    document.dispatchEvent(new CustomEvent('langchange', { detail: l }));
  }
}

/**
 * t('panel.metaTools', { count: 3 }). Si el valor es un objeto {one, other}, se elige la forma plural
 * con Intl.PluralRules según params.count. {nombre} se sustituye por params.nombre.
 */
export function t(key, params = {}) {
  let v = DICTS[lang][key] ?? DICTS.es[key];
  if (v == null) return key;
  if (typeof v === 'object') v = v[new Intl.PluralRules(locale()).select(params.count ?? 0)] ?? v.other;
  return v.replace(/\{(\w+)\}/g, (m, k) => (params[k] ?? m));
}

/**
 * Traduce el DOM: data-i18n="clave" pone el texto; data-i18n-attr="placeholder:clave;title:clave"
 * pone atributos. Se vuelve a llamar al cambiar de idioma.
 */
export function applyI18n(root = document) {
  document.documentElement.lang = lang;
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of el.dataset.i18nAttr.split(';')) {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    }
  }
  for (const el of root.querySelectorAll('.lang-switch button')) {
    el.setAttribute('aria-pressed', String(el.dataset.lang === lang));
  }
}

/** Rellena los contenedores .lang-switch con un botón por idioma. */
export function mountLangSwitch(root = document) {
  for (const box of root.querySelectorAll('.lang-switch')) {
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Idioma / Language');
    box.innerHTML = LANGS.map((l) => `<button type="button" data-lang="${l}" lang="${l}">${l.toUpperCase()}</button>`).join('');
    box.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-lang]');
      if (b) setLang(b.dataset.lang);
    });
  }
  applyI18n(root);
}

export const dictionaries = DICTS; // para el test de claves
