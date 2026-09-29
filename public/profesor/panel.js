import { $, esc, fmtClock, fmtDur, fmtTime, eventTime, isInfraction, isNotable, eventText, reasonText, mountFooter } from '../common.js';
import { t, getLang, locale, mountLangSwitch } from '../i18n/index.js';
import { createBackend } from '../backend.js';

const be = createBackend();
const examId = new URLSearchParams(location.search).get('exam');

// ---------- Estado ----------
let exam = null;
let clockOffset = 0;
let selectedId = null;
let stopWatch = null;
/** id -> { id, name, joinedAt, online, entered, away: {since, reason}|null, events: [] (orden cronológico) } */
const students = new Map();

function showState(state) {
  $('#loading').hidden = state !== 'loading';
  $('#no-access').hidden = state !== 'no-access';
  $('#panel').hidden = state !== 'panel';
}

function upsertStudent(s) {
  if (!students.has(s.id)) students.set(s.id, { ...s, online: false, entered: false, away: null, events: [] });
  return students.get(s.id);
}

/** Inserta en orden cronológico y recalcula el estado: los eventos pueden llegar desordenados tras una reconexión. */
function applyEvent(ev) {
  const s = students.get(ev.studentId);
  if (!s || s.events.some((e) => e.id === ev.id)) return;
  const i = s.events.findIndex((e) => eventTime(e) > eventTime(ev));
  s.events.splice(i < 0 ? s.events.length : i, 0, ev);
  s.entered = s.events.some((e) => e.type === 'exam_enter');
  s.away = null;
  for (const e of s.events) {
    if (e.type === 'away_start') s.away = { since: eventTime(e), reason: e.reason };
    if (e.type === 'away_end' || e.type === 'page_leave') s.away = null;
  }
}

/** Incidencias recientes de toda la clase, las más nuevas primero. */
const feed = () => [...students.values()].flatMap((s) => s.events.filter((e) => isNotable(e, exam)))
  .sort((a, b) => eventTime(b) - eventTime(a)).slice(0, 30);

// ---------- Acceso y suscripción ----------
if (!examId) showState('no-access');

be.onUser((user) => {
  if (!examId) return;
  if (!be.isTeacher(user)) { stopWatch?.(); stopWatch = null; return showState('no-access'); }
  if (stopWatch) return;
  students.clear();
  stopWatch = be.watchExam(examId, {
    meta(m) {
      if (!m) { showState('no-access'); return; }
      exam = m;
      showState('panel');
      renderHeader();
      renderAll();
    },
    student(s) { upsertStudent(s); renderAll(); },
    presence(id, online) { const s = students.get(id); if (s) { s.online = online; renderAll(); } },
    event(ev) { applyEvent(ev); renderAll(); },
    error() { stopWatch?.(); stopWatch = null; showState('no-access'); },
  });
});

$('#btn-signin').addEventListener('click', async (e) => {
  const errEl = $('#signin-error');
  errEl.hidden = true;
  try { await be.signInTeacher(); } catch (err) {
    errEl.textContent = t(`err.${err.code || 'network'}`);
    errEl.hidden = false;
  }
});

be.onServerOffset((ms) => { clockOffset = ms; });
be.onConnected((online) => { $('#p-conn').hidden = online; });

// ---------- Cabecera y acciones ----------
const joinUrl = () => new URL(`../alumno/?code=${exam.code}`, location.href).href;
const joinUrlShort = () => new URL('../alumno/', location.href).href.replace(/^https?:\/\//, '').replace(/\/$/, '');
const codeBoxes = (code) => [...code].map((d) => `<span>${d}</span>`).join('');

function renderHeader() {
  if (!exam) return;
  document.title = `${exam.name} | ${t('app.name')}`;
  $('#p-name').textContent = exam.name;
  const st = { waiting: ['status.waiting', 'pen'], active: ['status.active', 'ok'], finished: ['status.finished', ''] }[exam.status];
  $('#p-status').textContent = t(st[0]);
  $('#p-status').className = `pill ${st[1]}`;
  $('#p-meta').textContent = [
    t('panel.metaDuration', { min: exam.durationMin }),
    t('panel.metaTools', { count: exam.tools.length }),
    t(exam.mode === 'pestana' ? 'panel.metaTab' : 'panel.metaWindow'),
    exam.toleranceMs ? t('panel.metaTolerance', { dur: fmtDur(exam.toleranceMs) }) : null,
  ].filter(Boolean).join(', ');

  $('#btn-start').hidden = exam.status !== 'waiting';
  $('#btn-end').hidden = exam.status !== 'active';
  $('#p-clock').hidden = exam.status !== 'active';
  $('#btn-project').hidden = exam.status === 'finished';
  document.querySelector('.join-strip').hidden = exam.status === 'finished';

  $('#p-code').innerHTML = codeBoxes(exam.code);
  $('#pr-code').innerHTML = codeBoxes(exam.code);
  $('#p-url').textContent = joinUrlShort();
  $('#pr-url').textContent = joinUrlShort();
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

async function run(action) {
  try { await action(); } catch (err) { alert(t(`err.${err.code || 'network'}`)); }
}
$('#btn-start').addEventListener('click', () => run(() => be.startExam(exam.id)));
$('#btn-end').addEventListener('click', () => {
  if (confirm(t('panel.confirmEnd'))) run(() => be.finishExam(exam.id, exam.code));
});
$('#btn-delete').addEventListener('click', () => {
  if (!confirm(t('panel.confirmDelete'))) return;
  run(async () => {
    stopWatch?.(); stopWatch = null;
    await be.deleteExam(exam);
    location.href = './';
  });
});

$('#btn-project').addEventListener('click', () => {
  $('#projector').hidden = false;
  document.documentElement.requestFullscreen?.().catch(() => {});
});
const closeProjector = () => { $('#projector').hidden = true; if (document.fullscreenElement) document.exitFullscreen(); };
$('#pr-close').addEventListener('click', closeProjector);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#projector').hidden) closeProjector(); });

// ---------- CSV (se genera en el navegador) ----------
$('#btn-csv').addEventListener('click', () => {
  const sep = getLang() === 'es' ? ';' : ','; // Excel en español espera ';'
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const fmt = (ms) => new Date(ms).toLocaleString(locale());
  const rows = [[t('csv.student'), t('csv.event'), t('csv.type'), t('csv.time'), t('csv.duration'), t('csv.reason'), t('csv.infraction')]];
  const all = [...students.values()].flatMap((s) => s.events.map((e) => ({ s, e })))
    .sort((a, b) => eventTime(a.e) - eventTime(b.e));
  for (const { s, e } of all) {
    rows.push([s.name, eventText(e), e.type, fmt(eventTime(e)),
      e.durationMs != null ? (e.durationMs / 1000).toFixed(1) : '',
      e.type.startsWith('away') ? reasonText(e.reason) : '', isInfraction(e, exam) ? t('csv.yes') : '']);
  }
  const csv = '﻿' + rows.map((r) => r.map(cell).join(sep)).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `${t('csv.file')}-${exam.code}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// ---------- Estado derivado de cada alumno ----------
function summarize(s) {
  const now = Date.now() + clockOffset;
  const infractions = s.events.filter((e) => isInfraction(e, exam)).length;
  let awayMs = s.events.filter((e) => e.type === 'away_end').reduce((a, e) => a + (e.durationMs || 0), 0);
  const awayNow = s.away ? Math.max(0, now - s.away.since) : 0;
  awayMs += awayNow;

  let cls = '', label = t('st.waiting'), pill = 'pen';
  if (exam?.status === 'finished') { label = t('st.finished'); pill = ''; }
  else if (!s.online) { cls = 'st-off'; label = t('st.offline'); pill = 'warn'; }
  else if (s.away) {
    const long = awayNow >= (exam?.toleranceMs || 0);
    cls = long ? 'st-away' : 'st-away-short';
    label = t('st.away', { dur: fmtDur(awayNow) }); pill = long ? 'bad pulse' : 'warn';
  } else if (s.entered && exam?.status === 'active') { cls = 'st-ok'; label = t('st.in'); pill = 'ok'; }
  else if (exam?.status === 'active') { label = t('st.notEntered'); pill = 'warn'; }
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
  const rank = ({ s }) => (s.away ? 0 : !s.online ? 1 : 2);
  list.sort((a, b) => rank(a) - rank(b) || b.sum.infractions - a.sum.infractions ||
    a.s.name.localeCompare(b.s.name, locale(), { sensitivity: 'base' }));

  const shown = onlyFlagged ? list.filter(({ sum }) => sum.infractions) : list;
  $('#grid-empty').hidden = list.length > 0;
  $('#grid').innerHTML = shown.map(({ s, sum }) => `
    <button class="card ${sum.cls}" data-id="${esc(s.id)}" aria-pressed="${s.id === selectedId}">
      <span class="c-name">${esc(s.name)}</span>
      <span class="c-line"><span class="pill ${sum.pill}">${esc(sum.label)}</span>
        ${sum.infractions ? `<span class="flags">${esc(t('panel.infractionsShort', { count: sum.infractions }))}</span>` : ''}</span>
      ${sum.awayMs ? `<span class="c-line"><span>${esc(t('panel.awayTotal'))}</span><span>${fmtDur(sum.awayMs)}</span></span>` : ''}
    </button>`).join('');

  const items = feed();
  $('#feed-empty').hidden = items.length > 0;
  $('#feed').innerHTML = items.map((e) => `
    <li><time>${fmtTime(eventTime(e))}</time>
      <span><button data-id="${esc(e.studentId)}">${esc(students.get(e.studentId)?.name || '?')}</button>
      <span class="${isInfraction(e, exam) ? 'inf' : 'soft'}">${esc(eventText(e))}</span></span></li>`).join('');

  renderStudent();
}

function renderStudent() {
  const s = selectedId && students.get(selectedId);
  $('#side-student').hidden = !s;
  $('#side-feed').hidden = !!s;
  if (!s) return;
  const sum = summarize(s);
  $('#s-name').textContent = s.name;
  $('#s-summary').textContent = t('panel.studentSummary', {
    time: fmtTime(s.joinedAt), count: sum.infractions, dur: fmtDur(sum.awayMs), state: sum.label.toLowerCase(),
  });
  $('#s-log').innerHTML = [...s.events].reverse().map((e) => `
    <li><time>${fmtTime(eventTime(e))}</time>
      <span class="${isInfraction(e, exam) ? 'inf' : isNotable(e, exam) ? 'soft' : ''}">${esc(eventText(e))}</span></li>`).join('')
    || `<li><span></span><span class="muted">${esc(t('panel.noEvents'))}</span></li>`;
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
    $('#p-clock').textContent = left > 0 ? fmtClock(left) : t('panel.timeUp');
  }
  if ([...students.values()].some((s) => s.away)) renderAll();
}, 1000);

// ---------- Idioma ----------
mountLangSwitch();
mountFooter();
document.addEventListener('langchange', () => { renderHeader(); renderAll(); });
