// v1: el token del profesor se guarda sólo en este navegador (no hay cuentas todavía).
// Si se borra el almacenamiento del navegador, se pierde el acceso al panel de ese examen.
const KEY = 'focoExamen.profesor';

export function loadMyExams() {
  try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; }
}
export function saveMyExam(entry) {
  const list = loadMyExams().filter((e) => e.id !== entry.id);
  list.unshift(entry);
  localStorage.setItem(KEY, JSON.stringify(list.slice(0, 50)));
}
export const findMyExam = (id) => loadMyExams().find((e) => e.id === id) || null;
