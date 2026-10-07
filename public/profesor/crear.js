import { $, esc, fmtDateTime, mountFooter } from '../common.js';
import { t, mountLangSwitch, applyI18n } from '../i18n/index.js';
import { createBackend } from '../backend.js';
import { ADMIN_CONTACT } from '../version.js';

const be = createBackend();
const toolsBox = $('#tools');
const tpl = $('#tool-row');
let myExams = [];
let access = null;     // { admin, approved, request }
let stopAccess = null;

// ---------- Acceso ----------
// Para crear exámenes hace falta que el administrador apruebe la cuenta (lo exigen las reglas).
function showState(state) {
  for (const s of ['loading', 'signin', 'pending', 'teacher']) $(`#${s}`).hidden = s !== state;
}

be.onUser((user) => {
  stopAccess?.(); stopAccess = null; access = null;
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

$('#btn-signin').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const errEl = $('#signin-error');
  errEl.hidden = true;
  btn.disabled = true;
  try {
    await be.signInTeacher();
  } catch (err) {
    errEl.textContent = t(`err.${err.code || 'network'}`);
    errEl.hidden = false;
  } finally { btn.disabled = false; }
});
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
  row.querySelector('.t-del').addEventListener('click', () => row.remove());
  toolsBox.append(row);
  applyI18n(row);
  return row;
}
$('#add-tool').addEventListener('click', () => addTool().querySelector('.t-name').focus());
addTool();

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
  if (access && !access.approved) renderPending();
  document.title = `${t('create.title')} | ${t('app.name')}`;
});
