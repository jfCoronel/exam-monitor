// Test de extremo a extremo sin navegador: profesor y alumnos simulados con el mismo backend.js que usa
// la app, contra los emuladores de Auth y RTDB. Ejecutar con `npm run smoke`.
import { createBackend } from '../public/backend.js';
import { isInfraction } from '../public/common.js';

let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'OK  ' : 'FALLA'} ${msg}`); if (!cond) failed++; };
const rejects = async (p, code) => { try { await p; return false; } catch (err) { return !code || err.code === code; } };
async function waitFor(pred, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (pred()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
}
let n = 0;
const id = () => `c${Date.now()}${n++}`;

// ---------- Profesor ----------
const prof = createBackend({ emulator: true, name: 'prof' });
await prof.signInTeacher(prof.googleCredential(JSON.stringify({ sub: 'prof-1', email: 'prof@us.es', email_verified: true })));
ok(prof.isTeacher(), 'el profesor entra con Google');

ok(await rejects(prof.createExam({ name: 'X', durationMin: 60, mode: 'pestana', toleranceMs: 0, alertText: 'a',
  tools: [{ name: 'x', url: 'javascript:alert(1)' }] })), 'rechaza URLs no http(s)');

const exam = await prof.createExam({
  name: 'Termodinámica', durationMin: 90, mode: 'pestana', toleranceMs: 3000, alertText: 'Registrado.',
  tools: [{ name: 'fProperties', url: 'https://fproperties.jfcoronel.org/' }],
});
ok(/^\d{6}$/.test(exam.code), `crea examen con código de 6 cifras (${exam.code})`);
ok((await prof.listMyExams()).some((e) => e.id === exam.id), 'aparece en "mis exámenes"');

const seen = { meta: null, students: new Map(), online: new Map(), events: [] };
prof.watchExam(exam.id, {
  meta: (m) => { seen.meta = m; },
  student: (s) => seen.students.set(s.id, s),
  presence: (sid, on) => seen.online.set(sid, on),
  event: (e) => seen.events.push(e),
});
ok(await waitFor(() => seen.meta?.status === 'waiting'), 'el panel recibe el examen en espera');

// ---------- Alumno ----------
const al = createBackend({ emulator: true, name: 'al1' });
const wrong = exam.code === '000000' ? '000001' : '000000';
ok(await rejects(al.joinExam(wrong, 'Ana'), 'code_not_found'), 'código incorrecto: no hay examen');
const joined = await al.joinExam(exam.code, 'Ana López');
ok(joined.examId === exam.id, 'el alumno se une');
const alUid = al.currentUser().uid;
ok(await waitFor(() => seen.students.get(alUid)?.name === 'Ana López'), 'el panel ve al alumno unirse');
ok((await al.joinExam(exam.code, 'Otro nombre')).name === 'Ana López', 'unirse otra vez desde el mismo navegador no duplica');

let alMeta = null;
al.watchMeta(exam.id, (m) => { alMeta = m; });
const pres = al.presence(exam.id, { newId: id });
ok(await waitFor(() => seen.online.get(alUid) === true), 'presencia online en el panel');
ok(await waitFor(() => alMeta?.tools?.[0]?.name === 'fProperties'), 'el alumno lee la configuración y las herramientas');

ok(await rejects(al.sendEvent(exam.id, { clientId: id(), type: 'exam_enter' }), 'permission'), 'no registra eventos antes de iniciar');

// ---------- Examen en curso ----------
await prof.startExam(exam.id);
ok(await waitFor(() => alMeta?.status === 'active' && alMeta.startedAt > 0), 'el alumno recibe el inicio del examen');
pres.setActive(true);

const now = Date.now();
const dup = id();
await al.sendEvent(exam.id, { clientId: id(), type: 'exam_enter', clientTs: now });
await al.sendEvent(exam.id, { clientId: dup, type: 'away_start', reason: 'hidden', clientTs: now + 1 });
await al.sendEvent(exam.id, { clientId: id(), type: 'away_end', reason: 'hidden', durationMs: 1000, clientTs: now + 2 });
await al.sendEvent(exam.id, { clientId: id(), type: 'away_start', reason: 'blur', clientTs: now + 3 });
await al.sendEvent(exam.id, { clientId: id(), type: 'away_end', reason: 'blur', durationMs: 8000, clientTs: now + 4 });
ok(await rejects(al.sendEvent(exam.id, { clientId: dup, type: 'away_start' })), 'un reenvío con el mismo clientId no duplica');
ok(await rejects(al.sendEvent(exam.id, { clientId: id(), type: 'hack' })), 'rechaza tipos de evento no válidos');
ok(await waitFor(() => seen.events.length === 5), `el panel recibe 5 eventos (recibió ${seen.events.length})`);

const ends = seen.events.filter((e) => e.type === 'away_end');
ok(!isInfraction(ends.find((e) => e.durationMs === 1000), seen.meta), '1 s fuera con tolerancia 3 s: no es incidencia');
ok(isInfraction(ends.find((e) => e.durationMs === 8000), seen.meta), '8 s fuera: sí es incidencia');
ok(seen.events.every((e) => e.ts > 0 && e.studentId === alUid), 'cada evento lleva hora del servidor y alumno');

// Cierre de página: sendBeacon a la API REST (aquí con fetch, que es lo que hace el navegador por debajo).
ok(await waitFor(() => !!al.eventRestUrl(exam.id)), 'hay token para la API REST');
const r = await fetch(al.eventRestUrl(exam.id), { method: 'POST', body: al.restEventBody({ type: 'page_leave', clientTs: Date.now() }) });
ok(r.ok, `la API REST acepta page_leave (HTTP ${r.status})`);
ok(await waitFor(() => seen.events.some((e) => e.type === 'page_leave' && isInfraction(e, seen.meta))), 'page_leave llega al panel como incidencia');

// Pérdida de conexión: el servidor marca offline y registra 'disconnected'; al volver, 'reconnected'.
al.debug.goOffline();
ok(await waitFor(() => seen.online.get(alUid) === false), 'desconexión: presencia offline');
ok(await waitFor(() => seen.events.some((e) => e.type === 'disconnected')), 'desconexión registrada por el servidor');
al.debug.goOnline();
ok(await waitFor(() => seen.online.get(alUid) === true), 'reconexión: presencia online');
ok(await waitFor(() => seen.events.some((e) => e.type === 'reconnected')), 'reconexión registrada');

// ---------- Otro profesor ----------
const intruso = createBackend({ emulator: true, name: 'otro' });
await intruso.signInTeacher(intruso.googleCredential(JSON.stringify({ sub: 'prof-2', email: 'otro@us.es', email_verified: true })));
let denied = false;
intruso.watchExam(exam.id, { error: () => { denied = true; } });
ok(await waitFor(() => denied), 'otro profesor no puede ver el panel');
ok(await rejects(intruso.finishExam(exam.id, exam.code)), 'otro profesor no puede finalizar el examen');

// ---------- Fin ----------
await prof.finishExam(exam.id, exam.code);
ok(await waitFor(() => alMeta?.status === 'finished'), 'el alumno recibe el fin del examen');
ok(await rejects(al.sendEvent(exam.id, { clientId: id(), type: 'away_start' })), 'no registra eventos con el examen finalizado');
const al2 = createBackend({ emulator: true, name: 'al2' });
ok(await rejects(al2.joinExam(exam.code, 'Luis')), 'no se puede unir a un examen finalizado');

await prof.deleteExam({ ...seen.meta });
ok(await waitFor(() => seen.meta === null), 'el profesor borra el examen');
ok(!(await prof.listMyExams()).some((e) => e.id === exam.id), 'desaparece de "mis exámenes"');

console.log(failed ? `\n${failed} fallo(s)` : '\nTodo correcto');
process.exit(failed ? 1 : 0);
