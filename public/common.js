// Utilidades compartidas por la PWA del alumno y el panel del profesor.

export const $ = (sel, root = document) => root.querySelector(sel);

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

/** 83 s -> "1 min 23 s" */
export function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
}

/** Cuenta atrás: 5025 s -> "1:23:45" */
export function fmtClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export const fmtTime = (ms) => new Date(ms).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export async function api(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error('No hay conexión con el servidor. Comprueba la red e inténtalo de nuevo.');
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error || `Error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * WebSocket con reconexión automática (backoff exponencial, máx. 10 s).
 * hello() se llama en cada conexión para autenticarse.
 */
export function connect({ hello, onMessage, onStatus }) {
  let ws, retry = 0, stopped = false;
  function open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => { retry = 0; ws.send(JSON.stringify(hello())); onStatus?.('online'); };
    ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch (err) { console.error(err); } };
    ws.onclose = (ev) => {
      onStatus?.(ev.code === 4003 ? 'unauthorized' : 'offline');
      if (stopped || ev.code === 4003) return;
      setTimeout(open, Math.min(10_000, 500 * 2 ** retry++));
    };
  }
  open();
  return {
    send(msg) { if (ws?.readyState === 1) { ws.send(JSON.stringify(msg)); return true; } return false; },
    close() { stopped = true; ws?.close(); },
    get isOpen() { return ws?.readyState === 1; },
  };
}
