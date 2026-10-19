// Editor de herramientas permitidas: filas nombre + URL, favoritas, «Probar» (vista previa) y validación.
// Lo usan crear examen (crear.js) y «Cambiar herramientas» del panel (panel.js).
import { esc } from '../common.js';
import { t, applyI18n } from '../i18n/index.js';
import { MAX_FAVORITES } from '../backend.js';

export const MAX_TOOLS = 10; // las reglas admiten las claves 0 a 9

// Favoritas: se guardan en la cuenta del profesor (/teachers/{uid}/favorites), así que le siguen en
// cualquier navegador. Mientras no toque la lista, se ofrecen las de por defecto.
const DEFAULT_FAVORITES = [
  { name: 'fProperties', url: 'https://fproperties.jfcoronel.org/' },
  { name: 'pSolver', url: 'https://psolver.jfcoronel.org/' },
];

/** URL normalizada (para comparar) o null si no es una dirección http(s) válida. */
function normUrl(raw) {
  try {
    const u = new URL(String(raw).trim());
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch { return null; }
}

const EDITOR_HTML = `
  <div class="fav-bar">
    <span class="small muted" data-i18n="create.favorites">Favoritas</span>
    <div class="row fav-list"></div>
  </div>
  <p class="hint" data-i18n="create.favHint"></p>
  <p class="error small fav-error" role="alert" hidden></p>
  <div class="tools"></div>
  <p style="margin-top: 8px"><button type="button" class="btn-quiet add-tool" data-i18n="create.addTool"></button></p>`;

const ROW_HTML = `
  <div class="tool-row">
    <input type="text" class="t-name" maxlength="60" data-i18n-attr="placeholder:create.toolName;aria-label:create.toolNameLabel">
    <input type="url" class="t-url" placeholder="https://…" data-i18n-attr="aria-label:create.toolUrlLabel">
    <button type="button" class="btn-quiet t-test" data-i18n="create.testTool" data-i18n-attr="title:create.testToolTitle"></button>
    <button type="button" class="btn-quiet t-fav" aria-pressed="false">☆</button>
    <button type="button" class="btn-quiet t-del" data-i18n="create.removeTool"></button>
  </div>`;

const PREVIEW_HTML = `
  <dialog class="preview" aria-labelledby="preview-title">
    <div class="preview-head">
      <div>
        <h2 id="preview-title"></h2>
        <p class="small muted preview-url"></p>
      </div>
      <button type="button" class="preview-close" data-i18n="create.previewClose"></button>
    </div>
    <p class="small" data-i18n="create.previewText"></p>
    <div class="preview-frame"></div>
  </dialog>`;

// ---------- Vista previa ----------
// Desde el navegador no se puede saber si otra web prohíbe que la incrusten (X-Frame-Options,
// frame-ancestors): el iframe bloqueado dispara `load` igual que uno que funciona y sus cabeceras
// no se pueden leer. Así que el profesor la ve tal como la verá el alumno y decide.
let preview = null;
function openPreview(name, url) {
  if (!preview) {
    document.body.insertAdjacentHTML('beforeend', PREVIEW_HTML);
    preview = document.body.lastElementChild;
    applyI18n(preview);
    document.addEventListener('langchange', () => applyI18n(preview));
    preview.querySelector('.preview-close').addEventListener('click', () => preview.close());
    // Al cerrar se quita el iframe para que la web deje de ejecutarse.
    preview.addEventListener('close', () => preview.querySelector('.preview-frame').replaceChildren());
  }
  preview.querySelector('h2').textContent = t('create.previewTitle', { name });
  preview.querySelector('.preview-url').textContent = url;
  const f = document.createElement('iframe');
  f.src = url;
  f.title = name;
  f.allow = 'clipboard-read; clipboard-write; fullscreen';
  preview.querySelector('.preview-frame').replaceChildren(f);
  preview.showModal();
}

/**
 * Monta el editor dentro de `root`. Devuelve:
 * - setTools(list): sustituye las filas (con una vacía si la lista está vacía).
 * - read(): { tools } o { error } con el mensaje ya traducido.
 * - watchFavorites() / resetFavorites(): empieza o deja de seguir las favoritas de la cuenta.
 */
export function mountToolsEditor(root, be) {
  root.innerHTML = EDITOR_HTML;
  applyI18n(root);
  const box = root.querySelector('.tools');
  const favList = root.querySelector('.fav-list');
  const favError = root.querySelector('.fav-error');
  let favorites = DEFAULT_FAVORITES;
  let stopFavs = null;

  const rows = () => [...box.querySelectorAll('.tool-row')];
  const isFavorite = (url) => favorites.some((f) => f.url === normUrl(url));

  function addTool(name = '', url = '') {
    const tpl = document.createElement('template');
    tpl.innerHTML = ROW_HTML.trim();
    const row = tpl.content.firstElementChild;
    row.querySelector('.t-name').value = name;
    row.querySelector('.t-url').value = url;
    row.querySelector('.t-del').addEventListener('click', () => { row.remove(); renderFavorites(); });
    row.querySelector('.t-fav').addEventListener('click', () => toggleFavorite(row));
    row.querySelector('.t-test').addEventListener('click', () => {
      const u = normUrl(row.querySelector('.t-url').value);
      if (u) openPreview(row.querySelector('.t-name').value.trim() || new URL(u).hostname, u);
    });
    box.append(row);
    applyI18n(row);
    renderStar(row);
    return row;
  }
  root.querySelector('.add-tool').addEventListener('click', () => addTool().querySelector('.t-name').focus());
  box.addEventListener('input', () => renderFavorites());

  function renderFavorites() {
    const used = new Set(rows().map((r) => normUrl(r.querySelector('.t-url').value)).filter(Boolean));
    favList.innerHTML = favorites.map((f, i) => `
      <span class="fav-chip">
        <button type="button" class="fav-add" data-i="${i}" title="${esc(f.url)}" ${used.has(f.url) ? 'disabled' : ''}>${esc(t(used.has(f.url) ? 'create.favAdded' : 'create.favAdd', { name: f.name }))}</button>
        <button type="button" class="fav-del" data-i="${i}" title="${esc(t('create.favRemove', { name: f.name }))}" aria-label="${esc(t('create.favRemove', { name: f.name }))}">×</button>
      </span>`).join('') || `<span class="small muted">${esc(t('create.favEmpty'))}</span>`;
    rows().forEach(renderStar);
  }

  function renderStar(row) {
    const url = row.querySelector('.t-url').value;
    const on = isFavorite(url);
    const b = row.querySelector('.t-fav');
    b.textContent = on ? '★' : '☆';
    b.setAttribute('aria-pressed', String(on));
    b.title = t(on ? 'create.favUnstar' : 'create.favStar');
    b.setAttribute('aria-label', b.title);
    b.disabled = !normUrl(url);
    row.querySelector('.t-test').disabled = !normUrl(url);
  }

  async function saveFavorites(list) {
    favError.hidden = true;
    const prev = favorites;
    favorites = list;
    renderFavorites();
    try { await be.setFavorites(list); } catch (err) {
      favorites = prev;
      renderFavorites();
      favError.textContent = t(`err.${err.code || 'network'}`);
      favError.hidden = false;
    }
  }

  function toggleFavorite(row) {
    const url = normUrl(row.querySelector('.t-url').value);
    if (!url) return;
    if (isFavorite(url)) return saveFavorites(favorites.filter((f) => f.url !== url));
    if (favorites.length >= MAX_FAVORITES) {
      favError.textContent = t('err.too_many_favorites', { n: MAX_FAVORITES });
      favError.hidden = false;
      return;
    }
    const name = row.querySelector('.t-name').value.trim().slice(0, 60) || new URL(url).hostname;
    saveFavorites([...favorites, { name, url }]);
  }

  favList.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const fav = favorites[Number(b.dataset.i)];
    if (!fav) return;
    if (b.classList.contains('fav-del')) return saveFavorites(favorites.filter((f) => f !== fav));
    // Se usa la primera fila vacía; si no hay, se añade otra.
    const empty = rows().find((r) => !r.querySelector('.t-name').value.trim() && !r.querySelector('.t-url').value.trim());
    if (empty) {
      empty.querySelector('.t-name').value = fav.name;
      empty.querySelector('.t-url').value = fav.url;
    } else addTool(fav.name, fav.url);
    renderFavorites();
  });

  document.addEventListener('langchange', () => renderFavorites());

  const editor = {
    setTools(list) {
      box.innerHTML = '';
      list.forEach((tool) => addTool(tool.name, tool.url));
      if (!list.length) addTool();
      renderFavorites();
    },
    read() {
      const tools = [];
      for (const r of rows()) {
        const raw = r.querySelector('.t-url').value.trim();
        if (!raw) continue;
        let u;
        try { u = new URL(raw); } catch { return { error: t('err.url_invalid', { url: raw }) }; }
        if (!/^https?:$/.test(u.protocol)) return { error: t('err.url_protocol', { url: raw }) };
        tools.push({ name: r.querySelector('.t-name').value.trim().slice(0, 60) || u.hostname, url: u.href });
      }
      if (tools.length > MAX_TOOLS) return { error: t('err.too_many_tools') };
      return { tools };
    },
    watchFavorites() {
      stopFavs ??= be.watchFavorites((list) => { favorites = list ?? DEFAULT_FAVORITES; renderFavorites(); });
    },
    resetFavorites() {
      stopFavs?.(); stopFavs = null;
      favorites = DEFAULT_FAVORITES;
      renderFavorites();
    },
  };
  editor.setTools([]);
  return editor;
}
