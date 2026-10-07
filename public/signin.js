// Acceso del profesor: con Google o con correo y contraseña. Lo usan crear examen, el panel y la
// administración. Las cuentas de correo no valen hasta verificar el correo (lo exigen las reglas).
import { esc } from './common.js';
import { t, getLang } from './i18n/index.js';
import { MIN_PASSWORD } from './backend.js';

/** Pinta el acceso en `box` y lo mantiene al día con la sesión. */
export function mountSignIn(box, be) {
  let mode = 'signin'; // 'signin' | 'signup' | 'reset'
  let msg = null;      // { key, params, ok } mensaje bajo el formulario
  let email = '';
  let busy = false;

  const say = (key, params = {}, ok = false) => { msg = { key, params, ok }; render(); };
  const sayError = (err) => say(`err.${err?.code || 'network'}`, { n: MIN_PASSWORD });

  function render() {
    const user = be.currentUser();
    const msgHtml = msg ? `<p class="${msg.ok ? 'signin-ok' : 'error'}" role="alert">${esc(t(msg.key, msg.params))}</p>` : '';

    if (be.needsVerification(user)) {
      box.innerHTML = `
        <h2>${esc(t('auth.verifyTitle'))}</h2>
        <p>${esc(t('auth.verifyText', { email: user.email }))}</p>
        ${msgHtml}
        <div class="row">
          <button class="btn-primary" data-act="check">${esc(t('auth.verifyDone'))}</button>
          <button data-act="resend">${esc(t('auth.verifyResend'))}</button>
          <button class="btn-quiet" data-act="signout">${esc(t('auth.otherAccount'))}</button>
        </div>`;
      return;
    }

    if (be.isTeacher(user)) {
      box.innerHTML = `<div class="row"><span class="muted">${esc(t('auth.signedInAs', { email: user.email || '' }))}</span>
        <button class="btn-quiet" data-act="signout">${esc(t('auth.signOut'))}</button></div>`;
      return;
    }

    const pass = mode === 'reset' ? '' : `
      <div>
        <label for="si-pass">${esc(t('auth.password'))}
          ${mode === 'signup' ? `<span class="hint">${esc(t('auth.passwordHint', { n: MIN_PASSWORD }))}</span>` : ''}</label>
        <input type="password" id="si-pass" required autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}"
          ${mode === 'signup' ? `minlength="${MIN_PASSWORD}"` : ''}>
      </div>`;
    const links = {
      signin: [['reset', 'auth.forgot'], ['signup', 'auth.toSignup']],
      signup: [['signin', 'auth.toSignin']],
      reset: [['signin', 'auth.toSignin']],
    }[mode].map(([m, k]) => `<button type="button" class="btn-quiet small" data-mode="${m}">${esc(t(k))}</button>`).join('');

    box.innerHTML = `
      <div><button class="btn-primary btn-big" data-act="google">${esc(t('auth.google'))}</button></div>
      <p class="signin-or"><span>${esc(t('auth.orEmail'))}</span></p>
      <form class="stack" novalidate>
        ${mode === 'reset' ? `<p class="small">${esc(t('auth.resetText'))}</p>` : ''}
        <div>
          <label for="si-email">${esc(t('auth.email'))}</label>
          <input type="email" id="si-email" required autocomplete="email" value="${esc(email)}">
        </div>
        ${pass}
        ${msgHtml}
        <div class="row">
          <button type="submit" class="btn-primary">${esc(t({ signin: 'auth.signIn', signup: 'auth.signUp', reset: 'auth.resetSend' }[mode]))}</button>
          ${links}
        </div>
      </form>`;
  }

  async function run(fn) {
    if (busy) return;
    busy = true;
    box.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try { await fn(); } catch (err) { sayError(err); } finally {
      busy = false;
      box.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    }
  }

  box.addEventListener('input', (e) => { if (e.target.id === 'si-email') email = e.target.value; });

  box.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.mode) { mode = b.dataset.mode; msg = null; render(); box.querySelector('#si-email')?.focus(); return; }
    const act = b.dataset.act;
    if (act === 'google') run(async () => { msg = null; await be.signInTeacher(); });
    if (act === 'signout') { msg = null; mode = 'signin'; be.signOut(); }
    if (act === 'resend') run(async () => { be.setAuthLanguage(getLang()); await be.sendVerification(); say('auth.verifySent', { email: be.currentUser()?.email }, true); });
    if (act === 'check') {
      run(async () => {
        const u = await be.refreshUser();
        if (u && !u.emailVerified) say('auth.verifyNotYet');
      });
    }
  });

  box.addEventListener('submit', (e) => {
    e.preventDefault();
    email = box.querySelector('#si-email').value.trim();
    const password = box.querySelector('#si-pass')?.value || '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return say('err.email_invalid');
    if (mode !== 'reset' && !password) return say('err.password_required');
    if (mode === 'signup' && password.length < MIN_PASSWORD) return say('err.weak_password', { n: MIN_PASSWORD });
    be.setAuthLanguage(getLang());
    run(async () => {
      msg = null;
      if (mode === 'signin') await be.signInWithPassword(email, password);
      else if (mode === 'signup') { await be.signUpWithPassword(email, password); mode = 'signin'; }
      else { await be.resetPassword(email); mode = 'signin'; say('auth.resetSent', { email }, true); }
    });
  });

  // Al volver de abrir el enlace del correo en otra pestaña, se comprueba solo.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && be.needsVerification()) be.refreshUser().catch(() => {});
  });
  document.addEventListener('langchange', render);
  be.onUser(() => render());
  render();
}
