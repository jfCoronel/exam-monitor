// Datos de partida en el emulador de RTDB (nunca en producción): administradores y profesores
// autorizados. En el emulador, el token "owner" salta las reglas.
import { emulatorConfig } from '../public/firebase-config.js';
import { emailKey } from '../public/backend.js';

export async function seedEmulator({ admins = [], teachers = [] }) {
  const url = new URL(emulatorConfig.databaseURL);
  url.pathname = '/.json';
  const body = {};
  for (const e of admins) body[`admins/${emailKey(e)}`] = true;
  for (const e of teachers) body[`allowedTeachers/${emailKey(e)}`] = { email: e, addedAt: Date.now(), addedBy: 'seed' };
  const res = await fetch(url, { method: 'PATCH', headers: { Authorization: 'Bearer owner' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`No se pudo preparar el emulador: HTTP ${res.status} ${await res.text()}`);
}
