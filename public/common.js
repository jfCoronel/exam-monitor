// Utilidades compartidas por la PWA del alumno y el panel del profesor. Sin DOM salvo $.
import { t, locale } from './i18n/index.js';
import { VERSION } from './version.js';

export const $ = (sel, root = document) => root.querySelector(sel);

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Id aleatorio válido como clave de RTDB ([A-Za-z0-9_-]). */
export const uid = () => (globalThis.crypto?.randomUUID
  ? crypto.randomUUID()
  : String(Date.now()) + Math.random().toString(16).slice(2));

/** 83 s -> "1 min 23 s" */
export function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return t('dur.s', { s });
  const m = Math.floor(s / 60);
  return s % 60 ? t('dur.ms', { m, s: s % 60 }) : t('dur.m', { m });
}

/** Cuenta atrás: 5025 s -> "1:23:45" */
export function fmtClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export const fmtHM = (ms) => new Date(ms).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
export const fmtTime = (ms) => new Date(ms).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const fmtDateTime = (ms) => new Date(ms).toLocaleString(locale(), { dateStyle: 'short', timeStyle: 'short' });

// ---------- Tiempo del examen ----------
// Al agotarse la duración hay un margen de cortesía; después el examen se cierra solo.
// Las reglas de eventos usan el mismo margen (120000 en database.rules.json).
export const GRACE_MS = 2 * 60_000;

/** Hora (del servidor) a la que se agota el tiempo, o null si el examen no ha empezado. */
export const examEndsAt = (exam) => (exam?.startedAt ? exam.startedAt + exam.durationMin * 60_000 : null);

/** Hora a la que termina la cortesía y el examen queda cerrado. */
export const examClosesAt = (exam) => (exam?.startedAt ? examEndsAt(exam) + GRACE_MS : null);

/** "Nº 7 · Ana López"; sin número en exámenes anteriores a la v0.5.0. */
export const studentLabel = (s) => (s.num ? t('common.studentNum', { num: s.num, name: s.name }) : s.name);

// ---------- Eventos ----------
// Los datos guardados no dependen del idioma: type y reason son códigos que se traducen al mostrarlos.
// reason: 'hidden' | 'blur' | 'extension' (foco en algo que no es del examen). 'window' y 'tool:<nombre>' solo aparecen en exámenes del antiguo modo
// ventana (quitado en la v0.5.1); se siguen traduciendo para poder ver esos registros.
export const CLIENT_EVENTS = ['exam_enter', 'away_start', 'away_end', 'fullscreen_exit', 'page_leave', 'disconnected', 'reconnected', 'exam_submit'];

/** Hora real del hecho: la del cliente (corregida con el offset) si la hay; si no, la del servidor. */
export const eventTime = (e) => e.clientTs ?? e.ts;

/** Es incidencia un away_end que llega a la tolerancia, o cerrar/recargar la página. */
export const isInfraction = (e, exam) =>
  (e.type === 'away_end' && (e.durationMs ?? 0) >= (exam?.toleranceMs ?? 0)) || e.type === 'page_leave';

export const isNotable = (e, exam) =>
  isInfraction(e, exam) || ['page_leave', 'disconnected', 'fullscreen_exit'].includes(e.type);

export function reasonText(reason) {
  if (!reason) return t('reason.blur');
  if (reason.startsWith('tool:')) return t('reason.tool', { name: reason.slice(5) });
  return t(`reason.${reason}`);
}

export function eventText(e) {
  switch (e.type) {
    case 'away_start': return t('ev.away_start', { reason: reasonText(e.reason) });
    case 'away_end': return t('ev.away_end', { dur: fmtDur(e.durationMs ?? 0) });
    default: return t(`ev.${e.type}`);
  }
}

/** Pie común: copyright, versión y enlace a jfcoronel.org. No se traduce. */
export function mountFooter(root = document) {
  for (const el of root.querySelectorAll('.site-footer')) {
    el.innerHTML = `© 2026 Juan F. Coronel · Exam Monitor v${VERSION} · <a href="https://jfcoronel.org" target="_blank" rel="noopener">jfcoronel.org</a>`;
  }
}
