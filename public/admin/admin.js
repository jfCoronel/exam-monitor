// Administración: quién puede crear exámenes. Las reglas de RTDB solo dejan leer y escribir estas
// listas a los correos de /admins, que se editan desde la consola de Firebase o el CLI.
import { $, esc, fmtDateTime, mountFooter } from '../common.js';
import { t, mountLangSwitch } from '../i18n/index.js';
import { createBackend } from '../backend.js';

const be = createBackend();
let requests = [];
let teachers = [];
let stopAccess = null;
let stopAdmin = null;

function showState(state) {
  for (const s of ['loading', 'no-admin', 'admin']) $(`#${s}`).hidden = s !== state;
}

const showError = (err) => {
  const el = $('#admin-error');
  el.textContent = err ? t(`err.${err.code || 'network'}`) : '';
  el.hidden = !err;
};

be.onUser((user) => {
  stopAccess?.(); stopAdmin?.(); stopAccess = stopAdmin = null;
  const teacher = be.isTeacher(user);
  $('#user-email').hidden = $('#btn-signout').hidden = !teacher;
  if (!teacher) return showState('no-admin');
  $('#user-email').textContent = user.email || '';
  stopAccess = be.watchAccess((st) => {
    if (!st.admin) { stopAdmin?.(); stopAdmin = null; return showState('no-admin'); }
    showState('admin');
    if (stopAdmin) return;
    stopAdmin = be.watchAdmin({
      requests(list) { requests = list; render(); },
      teachers(list) { teachers = list; render(); },
      error: showError,
    });
  });
});

$('#btn-signin').addEventListener('click', async () => {
  const errEl = $('#signin-error');
  errEl.hidden = true;
  try { await be.signInTeacher(); } catch (err) {
    errEl.textContent = t(`err.${err.code || 'network'}`);
    errEl.hidden = false;
  }
});
$('#btn-signout').addEventListener('click', () => be.signOut());

function render() {
  $('#req-count').textContent = requests.length ? `(${requests.length})` : '';
  $('#requests-empty').hidden = requests.length > 0;
  $('#requests').innerHTML = requests.map((r) => `
    <li>
      <span class="who"><strong>${esc(r.name || r.email)}</strong>
        <span class="small muted">${esc(r.name ? `${r.email} · ` : '')}${esc(t('admin.requestedOn', { date: fmtDateTime(r.requestedAt) }))}</span></span>
      <span class="row">
        <button class="btn-primary" data-approve="${esc(r.id)}">${esc(t('admin.approve'))}</button>
        <button class="btn-quiet" data-reject="${esc(r.id)}">${esc(t('admin.reject'))}</button>
      </span>
    </li>`).join('');

  $('#teach-count').textContent = teachers.length ? `(${teachers.length})` : '';
  $('#teachers-empty').hidden = teachers.length > 0;
  $('#teachers').innerHTML = teachers.map((p) => `
    <li>
      <span class="who"><strong>${esc(p.email)}</strong>
        <span class="small muted">${esc(t('admin.addedOn', { date: fmtDateTime(p.addedAt) }))}</span></span>
      <button class="btn-danger" data-revoke="${esc(p.email)}">${esc(t('admin.revoke'))}</button>
    </li>`).join('');
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-approve], [data-reject], [data-revoke]');
  if (!b) return;
  showError(null);
  b.disabled = true;
  try {
    if (b.dataset.approve) {
      const r = requests.find((x) => x.id === b.dataset.approve);
      if (r) await be.approveTeacher(r.email, r.id);
    } else if (b.dataset.reject) {
      if (confirm(t('admin.confirmReject'))) await be.rejectRequest(b.dataset.reject);
    } else if (b.dataset.revoke) {
      if (confirm(t('admin.confirmRevoke', { email: b.dataset.revoke }))) await be.revokeTeacher(b.dataset.revoke);
    }
  } catch (err) { showError(err); } finally { b.disabled = false; }
});

$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError(null);
  const email = $('#add-email').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showError({ code: 'email_invalid' });
  const req = requests.find((r) => r.email.toLowerCase() === email.toLowerCase());
  try {
    await be.approveTeacher(email, req?.id);
    $('#add-email').value = '';
  } catch (err) { showError(err); }
});

mountLangSwitch();
mountFooter();
const title = () => { document.title = `${t('admin.title')} | ${t('app.name')}`; };
title();
document.addEventListener('langchange', () => { title(); render(); });
