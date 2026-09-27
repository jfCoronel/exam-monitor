import { $, esc, connect, fmtClock, fmtDur, fmtTime } from '/common.js';
import { findMyExam } from '/profesor/store.js';

const examId = new URLSearchParams(location.search).get('exam');
const mine = examId && findMyExam(examId);
if (!mine) {
  $('#no-access').hidden = false;
  throw new Error('Sin token de profesor para este examen');
}
$('#panel').hidden = false;

// ---------- Estado ----------
let exam = null;
let clockOffset = 0;
let selectedId = null;
/** id -> { id, name, joinedAt, online, entered, away: {since, reason}|null, events: [] } */
const students = new Map();
const feed = []; // incidencias recientes de toda la clase

const EVENT_LABEL = {
  exam_enter: () => 'Entró al examen',
  away_start: (e) => `Salió: ${e.reason || 'perdió el foco'}`,
  away_end: (e) => `Volvió tras ${fmtDur(e.duration_ms)}`,
  fullscreen_exit: () => 'Salió de pantalla completa',
  page_leave: () => 'Cerró o recargó la página',
  disconnected: () => 'Se desconectó',
  reconnected: () => 'Se volvió a conectar',
};
const eventTime = (e) => e.client_ts ?? e.ts;
const isNotable = (e) => e.infraction || ['page_leave', 'disconnected', 'fullscreen_exit'].includes(e.type);

function upsertStudent(s) {
  if (!students.has(s.id)) students.set(s.id, { ...s, online: false, entered: false, away: null, events: [] });
  return students.get(s.id);
}

function applyEvent(ev) {
  const s = students.get(ev.student_id);
  if (!s) return;
  s.events.push(ev);
  if (ev.type === 'exam_enter') s.entered = true;
  if (ev.type === 'away_start') s.away = { since: eventTime(ev), reason: ev.reason };
  if (ev.type === 'away_end' || ev.type === 'page_leave') s.away = null;
  if (isNotable(ev)) { feed.unshift(ev); feed.length = Math.min(feed.length, 50); }
}

// ---------- Conexión ----------
const conn = connect({
  hello: () => ({ t: 'hello', role: 'teacher', examId, token: mine.token }),
  onStatus(st) {
    $('#p-conn').hidden = st === 'online';
    if (st === 'unauthorized') { $('#panel').hidden = true; $('#no-access').hidden = false; }
  },
  onMessage(m) {
    if (m.t === 'snapshot') {
      students.clear(); feed.length = 0;
      exam = m.exam; clockOffset = m.serverNow - Date.now();
      m.students.forEach(upsertStudent);
      m.events.forEach(applyEvent);
      m.online.forEach((id) => { const s = students.get(id); if (s) s.online = true; });
      renderHeader();
    } else if (m.t === 'exam') {
      exam = m.exam; clockOffset = m.serverNow - Date.now();
      renderHeader();
    } else if (m.t === 'student_joined') {
      upsertStudent(m.student);
    } else if (m.t === 'presence') {
      const s = students.get(m.studentId); if (s) s.online = m.online;
    } else if (m.t === 'event') {
      applyEvent(m.event);
    }
    renderAll();
  },
});

// ---------- Cabecera y acciones ----------
const joinUrl = () => `${location.origin}/alumno/?code=${exam.code}`;
const codeBoxes = (code) => [...code].map((d) => `<span>${d}</span>`).join('');

function renderHeader() {
  document.title = `${exam.name} | Foco Examen`;
  $('#p-name').textContent = exam.name;
  const st = { waiting: ['En espera', 'pen'], active: ['En curso', 'ok'], finished: ['Finalizado', ''] }[exam.status];
  $('#p-status').textContent = st[0];
  $('#p-status').className = `pill ${st[1]}`;
  $('#p-meta').textContent = `${exam.durationMin} min, ${exam.tools.length} herramienta${exam.tools.length === 1 ? '' : 's'}, ` +
    (exam.mode === 'pestana' ? 'dentro de la página' : 'en ventana propia') +
    (exam.toleranceMs ? `, tolerancia ${fmtDur(exam.toleranceMs)}` : '');

  $('#btn-start').hidden = exam.status !== 'waiting';
  $('#btn-end').hidden = exam.status !== 'active';
  $('#p-clock').hidden = exam.status !== 'active';
  $('#btn-csv').href = `/api/exams/${encodeURIComponent(exam.id)}/export.csv?token=${encodeURIComponent(mine.token)}`;

  $('#p-code').innerHTML = codeBoxes(exam.code);
  $('#pr-code').innerHTML = codeBoxes(exam.code);
  $('#p-url').textContent = `${location.host}/alumno`;
  $('#pr-url').textContent = `${location.host}/alumno`;
  drawQr('#p-qr', 96); drawQr('#pr-qr', 320);
}

function drawQr(sel, size) {
  const el = $(sel);
  if (el.dataset.code === exam.code) return;
  if (!window.QRCode) { setTimeout(() => drawQr(sel, size), 300); return; } // la librería carga con defer
  el.innerHTML = '';
  new window.QRCode(el, { text: joinUrl(), width: size, height: size, correctLevel: window.QRCode.CorrectLevel.M });
  el.dataset.code = exam.code;
}

$('#btn-start').addEventListener('click', () => sendCmd('start'));
$('#btn-end').addEventListener('click', () => {
  if (confirm('¿Finalizar el examen? Los alumnos dejarán de estar supervisados.')) sendCmd('end');
});
function sendCmd(t) {
  if (!conn.send({ t })) alert('El panel no está conectado. Espera a que se reconecte y vuelve a intentarlo.');
}

$('#btn-project').addEventListener('click', () => {
  $('#projector').hidden = false;
  document.documentElement.requestFullscreen?.().catch(() => {});
});
const closeProjector = () => { $('#projector').hidden = true; if (document.fullscreenElement) document.exitFullscreen(); };
$('#pr-close').addEventListener('click', closeProjector);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#projector').hidden) closeProjector(); });

// ---------- Estado derivado de cada alumno ----------
function summarize(s) {
  const now = Date.now() + clockOffset;
  const infractions = s.events.filter((e) => e.infraction).length;
  let awayMs = s.events.filter((e) => e.type === 'away_end').reduce((a, e) => a + (e.duration_ms || 0), 0);
  const awayNow = s.away ? now - s.away.since : 0;
  awayMs += awayNow;

  let cls = '', label = 'En espera', pill = 'pen';
  if (exam?.status === 'finished') { label = 'Finalizado'; pill = ''; }
  else if (!s.online) { cls = 'st-off'; label = 'Sin conexión'; pill = 'warn'; }
  else if (s.away) {
    const long = awayNow >= (exam?.toleranceMs || 0);
    cls = long ? 'st-away' : 'st-away-short';
    label = `Fuera ${fmtDur(awayNow)}`; pill = long ? 'bad pulse' : 'warn';
  } else if (s.entered && exam?.status === 'active') { cls = 'st-ok'; label = 'En el examen'; pill = 'ok'; }
  else if (exam?.status === 'active') { label = 'Aún no ha entrado'; pill = 'warn'; }
  return { infractions, awayMs, cls, label, pill };
}

// ---------- Render ----------
function renderAll() {
  if (!exam) return;
  const onlyFlagged = $('#only-flagged').checked;
  const list = [...students.values()].map((s) => ({ s, sum: summarize(s) }));

  $('#c-joined').textContent = list.length;
  $('#c-in').textContent = list.filter(({ s }) => s.entered && s.online && !s.away).length;
  $('#c-away').textContent = list.filter(({ s }) => s.away).length;
  $('#c-off').textContent = list.filter(({ s }) => !s.online).length;
  $('#c-flag').textContent = list.filter(({ sum }) => sum.infractions).length;

  // Orden: primero quien está fuera ahora, luego sin conexión, luego por nº de incidencias, luego nombre.
  const rank = ({ s, sum }) => (s.away ? 0 : !s.online ? 1 : 2);
  list.sort((a, b) => rank(a) - rank(b) || b.sum.infractions - a.sum.infractions ||
    a.s.name.localeCompare(b.s.name, 'es', { sensitivity: 'base' }));

  const shown = onlyFlagged ? list.filter(({ sum }) => sum.infractions) : list;
  $('#grid-empty').hidden = list.length > 0;
  $('#grid').innerHTML = shown.map(({ s, sum }) => `
    <button class="card ${sum.cls}" data-id="${esc(s.id)}" aria-pressed="${s.id === selectedId}">
      <span class="c-name">${esc(s.name)}</span>
      <span class="c-line"><span class="pill ${sum.pill}">${esc(sum.label)}</span>
        ${sum.infractions ? `<span class="flags">${sum.infractions} incid.</span>` : ''}</span>
      ${sum.awayMs ? `<span class="c-line"><span>Tiempo fuera total</span><span>${fmtDur(sum.awayMs)}</span></span>` : ''}
    </button>`).join('');

  $('#feed-empty').hidden = feed.length > 0;
  $('#feed').innerHTML = feed.slice(0, 30).map((e) => `
    <li><time>${fmtTime(eventTime(e))}</time>
      <span><button data-id="${esc(e.student_id)}">${esc(students.get(e.student_id)?.name || '?')}</button>
      <span class="${e.infraction ? 'inf' : 'soft'}">${esc(EVENT_LABEL[e.type]?.(e) || e.type)}</span></span></li>`).join('');

  renderStudent();
}

function renderStudent() {
  const s = selectedId && students.get(selectedId);
  $('#side-student').hidden = !s;
  $('#side-feed').hidden = !!s;
  if (!s) return;
  const sum = summarize(s);
  $('#s-name').textContent = s.name;
  $('#s-summary').textContent = `Unido a las ${fmtTime(s.joinedAt)}. ${sum.infractions} incidencia${sum.infractions === 1 ? '' : 's'}, ` +
    `${fmtDur(sum.awayMs)} fuera en total. Estado: ${sum.label.toLowerCase()}.`;
  $('#s-log').innerHTML = [...s.events].reverse().map((e) => `
    <li><time>${fmtTime(eventTime(e))}</time>
      <span class="${e.infraction ? 'inf' : isNotable(e) ? 'soft' : ''}">${esc(EVENT_LABEL[e.type]?.(e) || e.type)}</span></li>`).join('')
    || '<li><span></span><span class="muted">Sin eventos todavía.</span></li>';
}

document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-id]');
  if (!target) return;
  selectedId = target.dataset.id === selectedId ? null : target.dataset.id;
  renderAll();
});
$('#s-close').addEventListener('click', () => { selectedId = null; renderAll(); });
$('#only-flagged').addEventListener('change', renderAll);

// Reloj y contadores de "fuera ahora" en vivo.
setInterval(() => {
  if (!exam) return;
  if (exam.status === 'active' && exam.startedAt) {
    const left = exam.startedAt + exam.durationMin * 60_000 - (Date.now() + clockOffset);
    $('#p-clock').textContent = left > 0 ? fmtClock(left) : 'Tiempo agotado';
  }
  if ([...students.values()].some((s) => s.away)) renderAll();
}, 1000);
