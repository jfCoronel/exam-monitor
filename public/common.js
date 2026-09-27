// Utilidades compartidas por la PWA del alumno y el panel del profesor. Sin DOM salvo $.
import { t, locale } from './i18n/index.js';

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

export const fmtTime = (ms) => new Date(ms).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const fmtDateTime = (ms) => new Date(ms).toLocaleString(locale(), { dateStyle: 'short', timeStyle: 'short' });

// ---------- Eventos ----------
// Los datos guardados no dependen del idioma: type y reason son códigos que se traducen al mostrarlos.
// reason: 'hidden' | 'blur' | 'window' | 'tool:<nombre de la herramienta>'
export const CLIENT_EVENTS = ['exam_enter', 'away_start', 'away_end', 'fullscreen_exit', 'page_leave', 'disconnected', 'reconnected'];

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
