import { $, esc, fmtDateTime, mountFooter } from '../common.js';
import { t, mountLangSwitch } from '../i18n/index.js';
import { createBackend } from '../backend.js';
import { mountSignIn } from '../signin.js';
import { mountToolsEditor } from './tools-editor.js';
import { ADMIN_CONTACT } from '../version.js';

const be = createBackend();
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
  tools.resetFavorites();
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
      tools.watchFavorites();
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
const tools = mountToolsEditor($('#tools-editor'), be);

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

  const { tools: list, error } = tools.read();
  if (error) return fail(error);

  const btn = e.submitter; btn.disabled = true;
  try {
    const exam = await be.createExam({
      name, durationMin, tools: list,
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
