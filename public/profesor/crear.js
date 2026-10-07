import { $, esc, fmtDateTime, mountFooter } from '../common.js';
import { t, mountLangSwitch, applyI18n } from '../i18n/index.js';
import { createBackend, MAX_FAVORITES } from '../backend.js';
import { mountSignIn } from '../signin.js';
import { ADMIN_CONTACT } from '../version.js';

const be = createBackend();
const toolsBox = $('#tools');
const tpl = $('#tool-row');
let myExams = [];
let access = null;     // { admin, approved, request }
let stopAccess = null;
let stopFavs = null;

// ---------- Acceso ----------
// Para crear exámenes hace falta que el administrador apruebe la cuenta (lo exigen las reglas).
function showState(state) {
  for (const s of ['loading', 'signin', 'pending', 'teacher']) $(`#${s}`).hidden = s !== state;
}

be.onUser((user) => {
  stopAccess?.(); stopAccess = null; access = null;
  stopFavs?.(); stopFavs = null; favorites = DEFAULT_FAVORITES;
  const teacher = be.isTeacher(user);
  $('#user-email').hidden = $('#btn-signout').hidden = !teacher;
  $('#admin-link').hidden = true;
  if (!teacher) return showState('signin');
  $('#user-email').textContent = user.email || '';
  showState('loading');
  stopAccess = be.watchAccess(async (st) => {
    const wasApproved = access?.approved;
    access = st;
    $('#admin-link').hidden = !st.admin;
    if (!st.approved) { renderPending(); return showState('pending'); }
    showState('teacher');
    if (!wasApproved) {
      stopFavs ??= be.watchFavorites((list) => { favorites = list ?? DEFAULT_FAVORITES; renderFavorites(); });
      try { myExams = await be.listMyExams(); } catch { myExams = []; }
      renderMyExams();
    }
  });
});

function renderPending() {
  const req = access?.request;
  $('#pending-text').textContent = req
    ? t('access.requested', { email: req.email, date: fmtDateTime(req.requestedAt), admin: ADMIN_CONTACT })
    : t('access.needed', { email: be.currentUser()?.email || '', admin: ADMIN_CONTACT });
  $('#btn-request').hidden = !!req;
}

$('#btn-request').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const errEl = $('#pending-error');
  errEl.hidden = true;
  btn.disabled = true;
  try { await be.requestAccess(); } catch (err) {
    errEl.textContent = t(`err.${err.code || 'network'}`);
    errEl.hidden = false;
  } finally { btn.disabled = false; }
});

mountSignIn($('#signin-box'), be);
$('#btn-signout').addEventListener('click', () => be.signOut());

// ---------- Mis exámenes ----------
function renderMyExams() {
  $('#my-exams').hidden = !myExams.length;
  $('#my-exams-list').innerHTML = myExams
    .map((e) => `<li><a href="panel.html?exam=${encodeURIComponent(e.id)}">${esc(e.name)}</a>
      <span class="muted small">${esc(t('create.examLine', { code: e.code, date: fmtDateTime(e.createdAt) }))}</span></li>`)
    .join('');
}

// ---------- Formulario ----------
function addTool(name = '', url = '') {
  const row = tpl.content.firstElementChild.cloneNode(true);
  row.querySelector('.t-name').value = name;
  row.querySelector('.t-url').value = url;
  row.querySelector('.t-del').addEventListener('click', () => { row.remove(); renderFavorites(); });
  row.querySelector('.t-fav').addEventListener('click', () => toggleFavorite(row));
  toolsBox.append(row);
  applyI18n(row);
  renderStar(row);
  return row;
}
$('#add-tool').addEventListener('click', () => addTool().querySelector('.t-name').focus());
toolsBox.addEventListener('input', () => renderFavorites());

// ---------- Herramientas favoritas ----------
// Se guardan en la cuenta del profesor (/teachers/{uid}/favorites), así que le siguen en cualquier
// navegador. Mientras no toque la lista, se ofrecen las de por defecto.
const DEFAULT_FAVORITES = [
  { name: 'fProperties', url: 'https://fproperties.jfcoronel.org/' },
  { name: 'pSolver', url: 'https://psolver.jfcoronel.org/' },
];
let favorites = DEFAULT_FAVORITES;

/** URL normalizada (para comparar) o null si no es una dirección http(s) válida. */
function normUrl(raw) {
  try {
    const u = new URL(String(raw).trim());
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch { return null; }
}
const isFavorite = (url) => favorites.some((f) => f.url === normUrl(url));

function renderFavorites() {
  const used = new Set([...toolsBox.querySelectorAll('.t-url')].map((i) => normUrl(i.value)).filter(Boolean));
  $('#fav-list').innerHTML = favorites.map((f, i) => `
    <span class="fav-chip">
      <button type="button" class="fav-add" data-i="${i}" title="${esc(f.url)}" ${used.has(f.url) ? 'disabled' : ''}>${esc(t(used.has(f.url) ? 'create.favAdded' : 'create.favAdd', { name: f.name }))}</button>
      <button type="button" class="fav-del" data-i="${i}" title="${esc(t('create.favRemove', { name: f.name }))}" aria-label="${esc(t('create.favRemove', { name: f.name }))}">×</button>
    </span>`).join('') || `<span class="small muted">${esc(t('create.favEmpty'))}</span>`;
  toolsBox.querySelectorAll('.tool-row').forEach(renderStar);
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
}

async function saveFavorites(list) {
  const errEl = $('#fav-error');
  errEl.hidden = true;
  const prev = favorites;
  favorites = list;
  renderFavorites();
  try { await be.setFavorites(list); } catch (err) {
    favorites = prev;
    renderFavorites();
    errEl.textContent = t(`err.${err.code || 'network'}`);
    errEl.hidden = false;
  }
}

function toggleFavorite(row) {
  const url = normUrl(row.querySelector('.t-url').value);
  if (!url) return;
  if (isFavorite(url)) return saveFavorites(favorites.filter((f) => f.url !== url));
  if (favorites.length >= MAX_FAVORITES) {
    $('#fav-error').textContent = t('err.too_many_favorites', { n: MAX_FAVORITES });
    $('#fav-error').hidden = false;
    return;
  }
  const name = row.querySelector('.t-name').value.trim().slice(0, 60) || new URL(url).hostname;
  saveFavorites([...favorites, { name, url }]);
}

$('#fav-list').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const fav = favorites[Number(b.dataset.i)];
  if (!fav) return;
  if (b.classList.contains('fav-del')) return saveFavorites(favorites.filter((f) => f !== fav));
  // Se usa la primera fila vacía; si no hay, se añade otra.
  const empty = [...toolsBox.querySelectorAll('.tool-row')]
    .find((r) => !r.querySelector('.t-name').value.trim() && !r.querySelector('.t-url').value.trim());
  if (empty) {
    empty.querySelector('.t-name').value = fav.name;
    empty.querySelector('.t-url').value = fav.url;
  } else addTool(fav.name, fav.url);
  renderFavorites();
});

addTool();
renderFavorites();

// El texto de aviso por defecto sigue al idioma mientras el profesor no lo edite.
const alertEl = $('#f-alert');
let alertEdited = false;
alertEl.addEventListener('input', () => { alertEdited = true; });
const setDefaultAlert = () => { if (!alertEdited) alertEl.value = t('create.alertDefault'); };

$('#create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('#create-error');
  errEl.hidden = true;
  const fail = (msg) => { errEl.textContent = msg; errEl.hidden = false; };

  const name = $('#f-name').value.trim().slice(0, 120);
  if (!name) return fail(t('err.exam_name_required'));
  const durationMin = Number($('#f-duration').value);
  if (!Number.isInteger(durationMin) || durationMin < 1 || durationMin > 600) return fail(t('err.duration_range'));

  const tools = [];
  for (const r of toolsBox.querySelectorAll('.tool-row')) {
    const raw = r.querySelector('.t-url').value.trim();
    if (!raw) continue;
    let u;
    try { u = new URL(raw); } catch { return fail(t('err.url_invalid', { url: raw })); }
    if (!/^https?:$/.test(u.protocol)) return fail(t('err.url_protocol', { url: raw }));
    tools.push({ name: r.querySelector('.t-name').value.trim().slice(0, 60) || u.hostname, url: u.href });
  }
  if (tools.length > 10) return fail(t('err.too_many_tools'));

  const btn = e.submitter; btn.disabled = true;
  try {
    const exam = await be.createExam({
      name, durationMin, tools,
      toleranceMs: Number($('#f-tolerance').value) * 1000,
      alertText: alertEl.value.trim().slice(0, 300) || t('create.alertDefault'),
    });
    location.href = `panel.html?exam=${encodeURIComponent(exam.id)}`;
  } catch (err) {
    fail(t(`err.${err.code || 'network'}`));
  } finally { btn.disabled = false; }
});

// ---------- Idioma ----------
mountLangSwitch();
mountFooter();
setDefaultAlert();
document.title = `${t('create.title')} | ${t('app.name')}`;
document.addEventListener('langchange', () => {
  setDefaultAlert();
  renderMyExams();
  renderFavorites();
  if (access && !access.approved) renderPending();
  document.title = `${t('create.title')} | ${t('app.name')}`;
});
