import { $, esc, uid, fmtClock, fmtDur, fmtTime, mountFooter, GRACE_MS, examEndsAt, examClosesAt, studentLabel } from '../common.js';
import { t, mountLangSwitch } from '../i18n/index.js';
import { createBackend } from '../backend.js';

const SESSION_KEY = 'examMonitor.alumno';
const NAME_KEY = 'examMonitor.ultimoNombre';
const POLL_MS = 500;

const be = createBackend();

// ---------- Estado ----------
let session = readJSON(SESSION_KEY); // { examId, name, num }
let exam = null;
let stopMeta = null;
let presence = null;
let clockOffset = 0;      // hora del servidor - Date.now()
let entered = false;      // el alumno ha pulsado "Entrar al examen" en esta carga de página
let submittedAt = null;   // hora a la que el alumno terminó su examen (no se puede deshacer)
let away = null;          // { since, reason } mientras está fuera
let queue = [];           // eventos pendientes de confirmar por el servidor (sobreviven a recargas)

function readJSON(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
const queueKey = () => `examMonitor.cola.${session?.examId}`;
const submitKey = () => `examMonitor.entregado.${session?.examId}`;
const saveQueue = () => { if (session) localStorage.setItem(queueKey(), JSON.stringify(queue)); };
const serverNow = () => Date.now() + clockOffset;
/** Se agotaron el tiempo y la cortesía: el examen está cerrado para este alumno aunque nadie lo haya finalizado. */
const timeOver = () => exam?.status === 'active' && serverNow() >= examClosesAt(exam);
const examOpen = () => exam?.status === 'active' && !submittedAt && !timeOver();

// ---------- Vistas ----------
const views = ['loading', 'join', 'wait', 'exam', 'done'];
function show(name) {
  for (const v of views) $(`#view-${v}`).hidden = v !== name;
}

function render() {
  if (!session || !exam) return show(session ? 'loading' : 'join');
  if (submittedAt || exam.status === 'finished' || timeOver()) { stopMonitoring(); renderDone(); return show('done'); }
  if (exam.status === 'active' && entered) { renderExamBar(); startMonitoring(); return show('exam'); }

  show('wait');
  $('#wait-hello').textContent = t('wait.hello', { name: session.name });
  $('#wait-num-box').hidden = !session.num;
  $('#wait-num').innerHTML = [...String(session.num ?? '')].map((d) => `<span>${d}</span>`).join('');
  $('#wait-exam-name').textContent = exam.name;
  $('#wait-waiting').hidden = exam.status !== 'waiting';
  $('#wait-ready').hidden = exam.status !== 'active';
  $('#wait-tools').innerHTML = exam.tools.length
    ? exam.tools.map((tool) => `<li><strong>${esc(tool.name)}</strong> <span class="muted">${esc(new URL(tool.url).hostname)}</span></li>`).join('')
    : `<li class="muted">${esc(t('wait.noTools'))}</li>`;
  const rules = [
    t('rules.keepOpen'),
    t('rules.tabMode'),
    exam.toleranceMs ? t('rules.awayTolerance', { dur: fmtDur(exam.toleranceMs) }) : t('rules.away'),
  ];
  $('#wait-rules-list').innerHTML = rules.map((r) => `<li>${esc(r)}</li>`).join('');
}

function renderDone() {
  $('#done-title').textContent = t(submittedAt ? 'done.submittedTitle' : 'done.title');
  $('#done-num').hidden = !session.num;
  $('#done-num').textContent = t('done.num', { num: session.num });
  $('#done-text').textContent = submittedAt ? t('done.submittedText', { time: fmtTime(submittedAt) }) : t('done.text');
}

function renderExamBar() {
  $('#bar-student').textContent = studentLabel(session);
}

// ---------- Unirse ----------
const params = new URLSearchParams(location.search);
if (params.get('code')) $('#join-code').value = params.get('code').replace(/\D/g, '').slice(0, 6);
$('#join-name').value = localStorage.getItem(NAME_KEY) || '';

$('#join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('#join-error');
  errEl.hidden = true;
  const showError = (msg) => { errEl.textContent = msg; errEl.hidden = false; };
  const name = $('#join-name').value.trim().replace(/\s+/g, ' ').slice(0, 80);
  const code = $('#join-code').value.replace(/\D/g, '');
  if (!name) return showError(t('err.name_required'));
  if (code.length !== 6) return showError(t('err.code_format'));
  const btn = e.submitter; btn.disabled = true;
  try {
    const r = await be.joinExam(code, name);
    localStorage.setItem(NAME_KEY, name);
    session = { examId: r.examId, name: r.name, num: r.num };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    history.replaceState(null, '', location.pathname);
    startSession();
    render();
  } catch (err) {
    showError(t(`err.${err.code || 'network'}`));
  } finally { btn.disabled = false; }
});

// ---------- Conexión ----------
function startSession() {
  stopSession();
  queue = readJSON(queueKey()) || [];
  presence = be.presence(session.examId, { clientTs: serverNow, newId: uid });
  stopMeta = be.watchMeta(session.examId, (m) => {
    if (!m) return resetSession(); // el profesor ha borrado el examen
    const wasActive = exam?.status === 'active';
    exam = m;
    presence.setActive(examOpen());
    if (exam.status === 'active' && !wasActive && entered) buildToolArea();
    render();
  }, (err) => { if (err.code === 'permission') resetSession(); });
  queue.forEach(deliver); // reenvío de lo que quedó pendiente antes de recargar
}

function stopSession() {
  stopMeta?.(); stopMeta = null;
  presence?.stop(); presence = null;
}

be.onServerOffset((ms) => { clockOffset = ms; });
be.onConnected((online) => {
  const pill = $('#bar-conn');
  pill.textContent = t(online ? 'conn.online' : 'conn.offline');
  pill.className = `pill ${online ? 'ok' : 'warn'}`;
  pill.title = online ? '' : t('conn.offlineHint');
  pill.dataset.online = String(online);
  pill.hidden = online; // en la barra solo se avisa cuando no hay conexión
});

function sendEvent(type, extra = {}) {
  const ev = { clientId: uid(), type, clientTs: serverNow(), ...extra };
  queue.push(ev);
  saveQueue();
  deliver(ev);
}

/** El evento sale de la cola cuando el servidor lo confirma, o cuando lo rechaza (duplicado, examen cerrado). */
function deliver(ev) {
  const examId = session.examId;
  be.sendEvent(examId, ev).then(ack, (err) => { if (err.code === 'permission') ack(); });
  function ack() {
    if (session?.examId !== examId) return;
    queue = queue.filter((q) => q.clientId !== ev.clientId);
    saveQueue();
  }
}

function resetSession() {
  stopSession();
  stopMonitoring();
  if (session) { localStorage.removeItem(queueKey()); localStorage.removeItem(submitKey()); }
  localStorage.removeItem(SESSION_KEY);
  session = null; exam = null; entered = false; submittedAt = null;
  render();
}

// ---------- Entrar al examen ----------
$('#btn-enter').addEventListener('click', async () => {
  await goFullscreen();
  entered = true;
  sendEvent('exam_enter');
  buildToolArea();
  render();
  startMonitoring();
});

async function goFullscreen() {
  try { if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); }
  catch { /* navegador sin soporte o bloqueado: seguimos igualmente */ }
}

// ---------- Terminar el examen ----------
// Confirmación dentro de la página: un confirm() del navegador podría sacarle de pantalla completa.
$('#btn-submit').addEventListener('click', () => {
  $('#submit-dialog').hidden = false;
  $('#btn-submit-no').focus();
});
$('#btn-submit-no').addEventListener('click', () => { $('#submit-dialog').hidden = true; });
$('#btn-submit-yes').addEventListener('click', () => {
  $('#submit-dialog').hidden = true;
  submittedAt = serverNow();
  localStorage.setItem(submitKey(), String(submittedAt));
  stopMonitoring();              // antes de salir de pantalla completa, para no registrarlo como salida
  presence?.setActive(false);    // ya no se registra 'disconnected' al cerrar
  be.submitExam(session.examId, { clientId: uid(), clientTs: submittedAt }).catch(() => {});
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  render();
});

// ---------- Herramientas ----------
function buildToolArea() {
  if (!exam) return;
  renderExamBar();
  const tabs = $('#tool-tabs'), area = $('#tool-area');
  tabs.innerHTML = ''; area.innerHTML = '';

  if (!exam.tools.length) {
    area.innerHTML = `<div class="tool-empty"><h2>${esc(t('exam.noToolsTitle'))}</h2><p>${esc(t('exam.noToolsText'))}</p></div>`;
    return;
  }

  // Cada herramienta en un iframe dentro de esta página. Se crean al abrir la pestaña
  // por primera vez y luego solo se ocultan, para no perder lo que el alumno haya hecho.
  const frames = new Map();
  ownFrames = new WeakSet();
  const select = (i) => {
    [...tabs.children].forEach((b, j) => b.setAttribute('aria-selected', String(i === j)));
    if (!frames.has(i)) {
      const f = document.createElement('iframe');
      f.src = exam.tools[i].url;
      f.title = exam.tools[i].name;
      f.allow = 'clipboard-read; clipboard-write; fullscreen';
      area.append(f);
      frames.set(i, f);
      ownFrames.add(f);
    }
    frames.forEach((f, j) => { f.hidden = j !== i; });
  };
  exam.tools.forEach((tool, i) => {
    const b = document.createElement('button');
    b.setAttribute('role', 'tab');
    b.textContent = tool.name;
    b.addEventListener('click', () => select(i));
    tabs.append(b);
  });
  select(0);
}

// ---------- Monitor de foco ----------
// Fuente de verdad: document.hasFocus() + visibilityState, comprobados cada 500 ms.
// hasFocus() sigue siendo true cuando el foco está dentro de un iframe de esta página,
// así que usar la herramienta incrustada NO cuenta como salir. Los eventos blur/visibilitychange
// solo adelantan la comprobación para que sea inmediata.
// Además, el foco tiene que estar en algo nuestro: muchas extensiones de IA meten su chat dentro de
// la página (content script, iframe o shadow DOM) y escribir ahí no hace perder el foco a la página.
let pollTimer = null;
let ownFrames = new WeakSet();                // iframes de las herramientas que hemos creado nosotros
const OWN_ROOTS = [...document.body.children]; // lo que trae el HTML; las extensiones añaden fuera

/** El foco está en un elemento o iframe que no es de la página del examen (una extensión). */
function foreignFocus() {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return false;
  if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') return !ownFrames.has(el);
  return !OWN_ROOTS.some((root) => root.contains(el));
}
const monitoring = () => entered && examOpen();

function startMonitoring() {
  if (pollTimer) return;
  pollTimer = setInterval(check, POLL_MS);
}
function stopMonitoring() {
  clearInterval(pollTimer); pollTimer = null;
  if (away) endAway(false);
  setAwayTitle(false);
  notice = null;
  if (exam) renderNotice();
  if (document.querySelector('#toast')) hideToast();
  $('#fs-banner').hidden = true;
}

function check() {
  if (!monitoring()) return;
  const visible = document.visibilityState === 'visible';
  const foreign = visible && document.hasFocus() && foreignFocus();
  const focused = visible && document.hasFocus() && !foreign;
  if (!focused && !away) startAway(!visible ? 'hidden' : foreign ? 'extension' : 'blur');
  else if (focused && away) endAway(true);
}

function startAway(reason) {
  away = { since: Date.now(), reason };
  sendEvent('away_start', { reason });
  setAwayTitle(true);
}

function endAway(showNotice) {
  const durationMs = Math.min(Date.now() - away.since, 86_400_000);
  sendEvent('away_end', { reason: away.reason, durationMs });
  away = null;
  setAwayTitle(false);
  if (showNotice) {
    const infraction = durationMs >= exam.toleranceMs;
    notice = { ...notice, awayMs: durationMs, infraction: infraction || !!notice?.infraction };
    renderNotice();
  }
}

// ---------- Aviso al volver ----------
// Siempre se le dice al alumno cuánto ha estado fuera. Si no llega a la tolerancia, basta un aviso
// discreto que se cierra solo; si es incidencia o ha salido de pantalla completa, un diálogo.
let notice = null; // { awayMs?, infraction?, fsExit? } hasta que el alumno lo cierra
let toastTimer = null;
const fsSupported = () => !!document.documentElement.requestFullscreen;

function renderNotice() {
  if (!notice) { $('#alert').hidden = true; return; }
  const { awayMs, infraction, fsExit } = notice;
  if (!infraction && !fsExit) { // fuera menos de la tolerancia
    notice = null;
    $('#alert').hidden = true;
    showToast(t('alert.short', { dur: fmtDur(awayMs), tol: fmtDur(exam.toleranceMs) }));
    return;
  }
  hideToast();
  const lines = [];
  if (awayMs != null) lines.push(`<p class="alert-dur">${esc(t('alert.dur', { dur: fmtDur(awayMs) }))}</p>`);
  if (infraction) lines.push(`<p>${esc(exam.alertText)}</p>`);
  else if (awayMs != null) lines.push(`<p>${esc(t('alert.noInfraction', { tol: fmtDur(exam.toleranceMs) }))}</p>`);
  if (fsExit) lines.push(`<p>${esc(t(infraction ? 'alert.fsAlso' : 'alert.fsText'))}</p>`);
  lines.push(`<p>${esc(t('alert.canContinue'))}</p>`);
  $('#alert').className = `alert-overlay ${infraction ? 'bad' : 'warn'}`;
  $('#alert-title').textContent = t(infraction ? 'alert.title' : 'alert.fsTitle');
  $('#alert-body').innerHTML = lines.join('');
  $('#btn-alert-ok').textContent = t(needsFullscreen() ? 'alert.continueFs' : 'alert.continue');
  const wasHidden = $('#alert').hidden;
  $('#alert').hidden = false;
  if (wasHidden) $('#btn-alert-ok').focus();
}

/** El examen se hace en pantalla completa. */
const needsFullscreen = () => !!exam && fsSupported() && !document.fullscreenElement;

function showToast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 6000);
}
function hideToast() { clearTimeout(toastTimer); $('#toast').hidden = true; }

// El título cambia mientras está fuera: se ve en la barra de tareas y en la pestaña.
function setAwayTitle(on) { document.title = on ? t('title.away') : t('app.name'); }

document.addEventListener('visibilitychange', check);
window.addEventListener('blur', () => setTimeout(check, 50));
window.addEventListener('focus', check);
document.addEventListener('focusin', check); // el foco pasa a otro elemento de la página

document.addEventListener('fullscreenchange', () => {
  const out = !document.fullscreenElement;
  $('#fs-banner').hidden = !(out && monitoring());
  if (!out || !monitoring()) return;
  sendEvent('fullscreen_exit');
  notice = { ...notice, fsExit: true };
  renderNotice(); // si ha salido con Alt+Tab, lo verá al volver, junto con el tiempo fuera
});
$('#btn-fs').addEventListener('click', goFullscreen);

$('#btn-alert-ok').addEventListener('click', () => {
  const fs = needsFullscreen();
  notice = null;
  renderNotice();
  if (fs) goFullscreen(); // el clic del alumno permite pedir pantalla completa
});

// Cerrar o recargar la página: último aviso con sendBeacon a la API REST (el SDK no llega a enviarlo).
// Si falla, queda igualmente el 'disconnected' que registra el servidor al perder la conexión.
window.addEventListener('pagehide', () => {
  if (!monitoring() || !navigator.sendBeacon) return;
  const url = be.eventRestUrl(session.examId);
  if (url) navigator.sendBeacon(url, new Blob([be.restEventBody({ type: 'page_leave', clientTs: serverNow() })], { type: 'text/plain' }));
});

// ---------- Reloj y fin automático ----------
// Al agotarse el tiempo empieza la cortesía (se avisa una vez); al terminar esta, deja de supervisar.
// El profesor puede cambiar la duración en cualquier momento: todo se recalcula con cada tic.
let timeUpNotified = false;
let wasOver = false;
setInterval(() => {
  if (!exam?.startedAt || exam.status !== 'active') return;
  const now = serverNow();
  const left = examEndsAt(exam) - now;
  const el = $('#bar-clock');
  el.textContent = left > 0 ? fmtClock(left) : t('exam.grace', { time: fmtClock(examClosesAt(exam) - now) });
  el.classList.toggle('low', left < 5 * 60_000);
  if (left > 0) timeUpNotified = false;
  else if (!timeUpNotified && monitoring()) {
    timeUpNotified = true;
    showToast(t('exam.timeUpToast', { dur: fmtDur(GRACE_MS) }));
  }
  const over = timeOver();
  if (over === wasOver) return;
  wasOver = over;
  presence?.setActive(examOpen());
  render(); // detiene la supervisión antes de salir de pantalla completa
  if (over && document.fullscreenElement) document.exitFullscreen().catch(() => {});
}, 250);

$('#btn-leave').addEventListener('click', resetSession);

// ---------- Idioma ----------
mountLangSwitch();
mountFooter();
document.addEventListener('langchange', () => {
  render();
  if (notice) renderNotice();
  if (monitoring()) buildToolAreaTextsOnly();
  setAwayTitle(!!away);
  const pill = $('#bar-conn');
  if (pill.dataset.online) pill.textContent = t(pill.dataset.online === 'true' ? 'conn.online' : 'conn.offline');
});
// Durante el examen no se reconstruyen los iframes (se perdería el trabajo): solo los textos.
function buildToolAreaTextsOnly() {
  if (!exam.tools.length) buildToolArea();
}

// ---------- Arranque ----------
(async function boot() {
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('../sw.js').catch(() => {});
  }
  setAwayTitle(false);
  render();
  if (!session) return;
  const user = await be.ready();
  const me = user && await be.getMyStudent(session.examId).catch(() => 'offline');
  if (!me) { resetSession(); return; }
  if (me !== 'offline' && me.num !== session.num) {
    session = { ...session, num: me.num };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }
  submittedAt = Number(localStorage.getItem(submitKey())) || await be.getMySubmission(session.examId);
  startSession();
})();
