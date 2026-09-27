import { $, esc, uid, api, connect, fmtClock, fmtDur } from '/common.js';

const SESSION_KEY = 'focoExamen.alumno';
const POLL_MS = 500;

// ---------- Estado ----------
let session = readJSON(localStorage, SESSION_KEY); // { token, studentId, name, examId }
let exam = null;
let conn = null;
let clockOffset = 0;      // serverNow - Date.now()
let entered = false;      // el alumno ha pulsado "Entrar al examen" en esta carga de página
let away = null;          // { since, reason, clientId } mientras está fuera
let lastToolOpen = null;  // modo ventana: { name, at }
let queue = [];           // eventos pendientes de confirmar por el servidor

function readJSON(store, key) { try { return JSON.parse(store.getItem(key)); } catch { return null; } }
const queueKey = () => `focoExamen.cola.${session?.studentId}`;
const saveQueue = () => { if (session) localStorage.setItem(queueKey(), JSON.stringify(queue)); };

// ---------- Vistas ----------
const views = ['join', 'wait', 'exam', 'done'];
function show(name) {
  for (const v of views) $(`#view-${v}`).hidden = v !== name;
}

function render() {
  if (!session || !exam) return show('join');
  if (exam.status === 'finished') { stopMonitoring(); return show('done'); }
  if (exam.status === 'active' && entered) return show('exam');

  show('wait');
  $('#wait-hello').textContent = `Hola, ${session.name}`;
  $('#wait-exam-name').textContent = exam.name;
  $('#wait-waiting').hidden = exam.status !== 'waiting';
  $('#wait-ready').hidden = exam.status !== 'active';
  $('#wait-tools').innerHTML = exam.tools.length
    ? exam.tools.map((t) => `<li><strong>${esc(t.name)}</strong> <span class="muted">${esc(new URL(t.url).hostname)}</span></li>`).join('')
    : '<li class="muted">Ninguna. El examen se hace sin herramientas externas.</li>';
  const rules = [
    'Mantén esta página abierta y en primer plano durante todo el examen.',
    exam.mode === 'pestana'
      ? 'Las herramientas se abren dentro de esta misma página, en pestañas propias. No abras otras pestañas ni programas.'
      : 'Las herramientas se abren en su propia ventana. Cada vez que la ventana del examen pierde el foco, queda registrado.',
    `Si sales${exam.toleranceMs ? ` más de ${fmtDur(exam.toleranceMs)}` : ''}, el profesor verá una incidencia con la hora y la duración.`,
  ];
  $('#wait-rules-list').innerHTML = rules.map((r) => `<li>${esc(r)}</li>`).join('');
}

// ---------- Unirse ----------
const params = new URLSearchParams(location.search);
if (params.get('code')) $('#join-code').value = params.get('code').replace(/\D/g, '').slice(0, 6);
$('#join-name').value = localStorage.getItem('focoExamen.ultimoNombre') || '';

$('#join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('#join-error');
  errEl.hidden = true;
  const name = $('#join-name').value.trim();
  const code = $('#join-code').value.replace(/\D/g, '');
  if (!name) return showError('Escribe tu nombre y apellidos.');
  if (code.length !== 6) return showError('El código tiene 6 cifras.');
  const btn = e.submitter; btn.disabled = true;
  try {
    const r = await api('/api/join', { method: 'POST', body: { name, code } });
    localStorage.setItem('focoExamen.ultimoNombre', name);
    session = { token: r.token, studentId: r.studentId, name: r.name, examId: r.exam.id };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    exam = r.exam;
    queue = [];
    history.replaceState(null, '', location.pathname);
    startConnection();
    render();
  } catch (err) {
    showError(err.message);
  } finally { btn.disabled = false; }

  function showError(msg) { errEl.textContent = msg; errEl.hidden = false; }
});

// ---------- Conexión ----------
function startConnection() {
  conn?.close();
  queue = readJSON(localStorage, queueKey()) || [];
  conn = connect({
    hello: () => ({ t: 'hello', role: 'student', token: session.token }),
    onStatus(status) {
      const pill = $('#bar-conn');
      if (status === 'online') {
        pill.textContent = 'Conectado'; pill.className = 'pill ok';
        flushQueue();
      } else if (status === 'unauthorized') {
        resetSession();
      } else {
        pill.textContent = 'Sin conexión'; pill.className = 'pill warn';
        pill.title = 'Tus registros se enviarán cuando vuelva la conexión';
      }
    },
    onMessage(m) {
      if (m.t === 'exam') {
        const wasActive = exam?.status === 'active';
        exam = m.exam;
        clockOffset = m.serverNow - Date.now();
        if (exam.status === 'active' && !wasActive) buildToolArea();
        render();
      } else if (m.t === 'ack') {
        queue = queue.filter((e) => e.clientId !== m.clientId);
        saveQueue();
      }
    },
  });
}

function sendEvent(type, extra = {}) {
  const ev = { t: 'event', type, clientId: uid(), ts: Date.now() + clockOffset, ...extra };
  queue.push(ev);
  saveQueue();
  conn?.send(ev);
  return ev;
}
function flushQueue() { for (const ev of queue) conn.send(ev); }

function resetSession() {
  conn?.close(); conn = null;
  localStorage.removeItem(SESSION_KEY);
  session = null; exam = null; entered = false;
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

// ---------- Herramientas ----------
function buildToolArea() {
  if (!exam) return;
  $('#bar-exam').textContent = exam.name;
  $('#bar-student').textContent = session.name;
  const tabs = $('#tool-tabs'), area = $('#tool-area');
  tabs.innerHTML = ''; area.innerHTML = '';

  if (!exam.tools.length) {
    area.innerHTML = `<div class="tool-empty"><h2>Examen sin herramientas</h2>
      <p>Deja esta página abierta en primer plano hasta que termine el examen.</p></div>`;
    return;
  }

  if (exam.mode === 'ventana') {
    area.innerHTML = `<div class="tool-empty"><h2>Herramientas del examen</h2>
      <p>Cada herramienta se abre en su propia ventana. Mantén esta ventana visible (por ejemplo, a un lado de la pantalla):
      el tiempo que pases fuera de ella queda registrado.</p><div class="tool-launchers"></div></div>`;
    const box = area.querySelector('.tool-launchers');
    exam.tools.forEach((t, i) => {
      const b = document.createElement('button');
      b.className = 'btn-primary';
      b.textContent = `Abrir ${t.name}`;
      b.addEventListener('click', () => {
        lastToolOpen = { name: t.name, at: Date.now() };
        window.open(t.url, `herramienta-${i}`, 'popup,width=1100,height=800');
      });
      box.append(b);
    });
    return;
  }

  // Modo pestaña: cada herramienta en un iframe dentro de esta página. Se crean al abrir la pestaña
  // por primera vez y luego sólo se ocultan, para no perder lo que el alumno haya hecho.
  const frames = new Map();
  const select = (i) => {
    [...tabs.children].forEach((b, j) => b.setAttribute('aria-selected', String(i === j)));
    if (!frames.has(i)) {
      const f = document.createElement('iframe');
      f.src = exam.tools[i].url;
      f.title = exam.tools[i].name;
      f.allow = 'clipboard-read; clipboard-write; fullscreen';
      area.append(f);
      frames.set(i, f);
    }
    frames.forEach((f, j) => { f.hidden = j !== i; });
  };
  exam.tools.forEach((t, i) => {
    const b = document.createElement('button');
    b.setAttribute('role', 'tab');
    b.textContent = t.name;
    b.addEventListener('click', () => select(i));
    tabs.append(b);
  });
  select(0);
}

// ---------- Monitor de foco ----------
// Fuente de verdad: document.hasFocus() + visibilityState, comprobados cada 500 ms.
// hasFocus() sigue siendo true cuando el foco está dentro de un iframe de esta página,
// así que usar la herramienta incrustada NO cuenta como salir. Los eventos blur/visibilitychange
// sólo adelantan la comprobación para que sea inmediata.
let pollTimer = null;
const monitoring = () => entered && exam?.status === 'active';

function startMonitoring() {
  if (pollTimer) return;
  pollTimer = setInterval(check, POLL_MS);
}
function stopMonitoring() {
  clearInterval(pollTimer); pollTimer = null;
  if (away) endAway(false);
  setAwayTitle(false);
}

function check() {
  if (!monitoring()) return;
  const visible = document.visibilityState === 'visible';
  const focused = visible && document.hasFocus();
  if (!focused && !away) startAway(visible ? 'La ventana del examen perdió el foco' : 'Página oculta (otra pestaña, ventana minimizada…)');
  else if (focused && away) endAway(true);
}

function startAway(reason) {
  if (exam.mode === 'ventana' && lastToolOpen && Date.now() - lastToolOpen.at < 3000) {
    reason = `Abrió la herramienta ${lastToolOpen.name}`;
  } else if (exam.mode === 'ventana') {
    reason += ' (modo ventana: no se puede saber a qué ventana fue)';
  }
  away = { since: Date.now(), reason };
  sendEvent('away_start', { reason });
  setAwayTitle(true);
}

function endAway(showAlert) {
  const durationMs = Date.now() - away.since;
  sendEvent('away_end', { reason: away.reason, durationMs });
  away = null;
  setAwayTitle(false);
  if (showAlert && durationMs >= exam.toleranceMs) {
    $('#alert-text').textContent = exam.alertText;
    $('#alert-dur').textContent = `Tiempo fuera: ${fmtDur(durationMs)}`;
    $('#alert').hidden = false;
    $('#btn-alert-ok').focus();
  }
}

// El título cambia mientras está fuera: se ve en la barra de tareas y en la pestaña.
const baseTitle = document.title;
function setAwayTitle(on) { document.title = on ? '⚠ Vuelve al examen' : baseTitle; }

document.addEventListener('visibilitychange', check);
window.addEventListener('blur', () => setTimeout(check, 50));
window.addEventListener('focus', check);

document.addEventListener('fullscreenchange', () => {
  const out = !document.fullscreenElement;
  $('#fs-banner').hidden = !(out && monitoring());
  if (out && monitoring()) sendEvent('fullscreen_exit');
});
$('#btn-fs').addEventListener('click', goFullscreen);

$('#btn-alert-ok').addEventListener('click', () => {
  $('#alert').hidden = true;
  if (exam?.mode === 'pestana') goFullscreen();
});

// Cerrar o recargar la página: último aviso con sendBeacon (fetch normal no llega a salir).
window.addEventListener('pagehide', () => {
  if (!monitoring()) return;
  const body = JSON.stringify({ token: session.token, clientId: uid(), ts: Date.now() + clockOffset });
  navigator.sendBeacon('/api/beacon', new Blob([body], { type: 'text/plain' }));
});

// ---------- Reloj ----------
setInterval(() => {
  if (!exam?.startedAt || exam.status !== 'active') return;
  const left = exam.startedAt + exam.durationMin * 60_000 - (Date.now() + clockOffset);
  const el = $('#bar-clock');
  el.textContent = left > 0 ? fmtClock(left) : 'Tiempo';
  el.classList.toggle('low', left < 5 * 60_000);
}, 250);

$('#btn-leave').addEventListener('click', resetSession);

// ---------- Arranque ----------
(async function boot() {
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  if (!session) return render();
  try {
    const r = await api('/api/session', { token: session.token });
    exam = r.exam;
    startConnection();
  } catch (err) {
    if (err.status === 401) session = null;
    else { // sin red: mantenemos la sesión y reintentamos por WebSocket
      startConnection();
      return show('wait');
    }
  }
  render();
})();
