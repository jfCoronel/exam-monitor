// Test de extremo a extremo sin navegador: profesor y alumnos simulados con el mismo backend.js que usa
// la app, contra los emuladores de Auth y RTDB. Ejecutar con `npm run smoke`.
import { createBackend } from '../public/backend.js';
import { isInfraction } from '../public/common.js';
import { seedEmulator } from './seed-emulator.js';

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

const signIn = async (be, sub, email) => be.signInTeacher(be.googleCredential(JSON.stringify({ sub, email, email_verified: true })));
const EXAM_INPUT = { name: 'Termodinámica', durationMin: 90, toleranceMs: 3000, alertText: 'Registrado.',
  tools: [{ name: 'fProperties', url: 'https://fproperties.jfcoronel.org/' }] };
await seedEmulator({ admins: ['admin@us.es'], teachers: ['maria.pw@us.es'] });

// ---------- Permisos: solicitar y aprobar ----------
const prof = createBackend({ emulator: true, name: 'prof' });
await signIn(prof, 'prof-1', 'jose.prof@us.es');
ok(prof.isTeacher(), 'el profesor entra con Google');
let access = null;
prof.watchAccess((st) => { access = st; });
ok(await waitFor(() => access && !access.approved && !access.admin && access.request === null), 'sin autorizar y sin solicitud');
ok(await rejects(prof.createExam(EXAM_INPUT), 'create_failed'), 'sin autorizar no puede crear exámenes');
await prof.requestAccess();
ok(await waitFor(() => access?.request?.email === 'jose.prof@us.es'), 'solicita acceso');

const admin = createBackend({ emulator: true, name: 'admin' });
await signIn(admin, 'admin-1', 'admin@us.es');
let adminAccess = null, pending = [], allowed = [];
admin.watchAccess((st) => { adminAccess = st; });
ok(await waitFor(() => adminAccess?.admin === true), 'la administradora se reconoce como tal');
admin.watchAdmin({ requests: (l) => { pending = l; }, teachers: (l) => { allowed = l; } });
ok(await waitFor(() => pending.some((r) => r.email === 'jose.prof@us.es')), 'la administradora ve la solicitud');
await admin.approveTeacher('jose.prof@us.es', pending.find((r) => r.email === 'jose.prof@us.es').id);
ok(await waitFor(() => access?.approved === true && access.request === null), 'aprobado: el profesor lo ve en vivo');
ok(await waitFor(() => pending.length === 0 && allowed.some((p) => p.email === 'jose.prof@us.es')), 'la solicitud pasa a la lista de autorizados');

// ---------- Profesor ----------

ok(await rejects(prof.createExam({ name: 'X', durationMin: 60, toleranceMs: 0, alertText: 'a',
  tools: [{ name: 'x', url: 'javascript:alert(1)' }] })), 'rechaza URLs no http(s)');

const exam = await prof.createExam(EXAM_INPUT);
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
ok(joined.num === 1, `el primero en unirse recibe el número 1 (recibió ${joined.num})`);
const alUid = al.currentUser().uid;
ok(await waitFor(() => seen.students.get(alUid)?.name === 'Ana López'), 'el panel ve al alumno unirse');
const again = await al.joinExam(exam.code, 'Otro nombre');
ok(again.name === 'Ana López' && again.num === 1, 'unirse otra vez desde el mismo navegador no duplica ni cambia el número');
ok(await waitFor(() => seen.students.get(alUid)?.num === 1), 'el panel ve el número del alumno');

// Varios alumnos a la vez: números distintos y consecutivos, sin huecos.
const crowd = Array.from({ length: 8 }, (_, i) => createBackend({ emulator: true, name: `crowd${i}` }));
const nums = (await Promise.all(crowd.map((b, i) => b.joinExam(exam.code, `Alumno ${i}`)))).map((r) => r.num).sort((a, b) => a - b);
ok(nums.join() === '2,3,4,5,6,7,8,9', `8 alumnos a la vez reciben los números 2 a 9 (${nums.join(', ')})`);

let alMeta = null;
al.watchMeta(exam.id, (m) => { alMeta = m; });
const pres = al.presence(exam.id, { newId: id });
ok(await waitFor(() => seen.online.get(alUid) === true), 'presencia online en el panel');
ok(await waitFor(() => alMeta?.tools?.[0]?.name === 'fProperties'), 'el alumno lee la configuración y las herramientas');

ok(await rejects(al.sendEvent(exam.id, { clientId: id(), type: 'exam_enter' }), 'permission'), 'no registra eventos antes de iniciar');

// ---------- Duración ----------
await prof.setDuration(exam.id, 120);
ok(await waitFor(() => alMeta?.durationMin === 120), 'el profesor cambia la duración y el alumno la recibe');

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

// ---------- El alumno termina su examen ----------
pres.setActive(false);
await al.submitExam(exam.id, { clientId: id(), clientTs: Date.now() });
ok(await waitFor(() => seen.events.some((e) => e.type === 'exam_submit' && e.studentId === alUid)), 'el panel recibe que el alumno ha terminado');
ok((await al.getMySubmission(exam.id)) > 0, 'la entrega queda guardada (sobrevive a una recarga)');
ok(await rejects(al.sendEvent(exam.id, { clientId: id(), type: 'away_start' }), 'permission'), 'tras terminar no registra más eventos');
ok(await rejects(al.submitExam(exam.id, { clientId: id(), clientTs: Date.now() })), 'no puede terminar dos veces');

// ---------- Otro profesor ----------
const intruso = createBackend({ emulator: true, name: 'otro' });
await signIn(intruso, 'prof-2', 'otro@us.es');
let denied = false;
intruso.watchExam(exam.id, { error: () => { denied = true; } });
ok(await waitFor(() => denied), 'otro profesor no puede ver el panel');
ok(await rejects(intruso.finishExam(exam.id, exam.code)), 'otro profesor no puede finalizar el examen');

// ---------- Fin ----------
await prof.finishExam(exam.id, exam.code);
ok(await waitFor(() => alMeta?.status === 'finished'), 'el alumno recibe el fin del examen');
ok(await rejects(prof.setDuration(exam.id, 30)), 'con el examen finalizado no se cambia la duración');
ok(await rejects(al.sendEvent(exam.id, { clientId: id(), type: 'away_start' })), 'no registra eventos con el examen finalizado');
const al2 = createBackend({ emulator: true, name: 'al2' });
ok(await rejects(al2.joinExam(exam.code, 'Luis')), 'no se puede unir a un examen finalizado');

await prof.deleteExam({ ...seen.meta });
ok(await waitFor(() => seen.meta === null), 'el profesor borra el examen');
ok(!(await prof.listMyExams()).some((e) => e.id === exam.id), 'desaparece de "mis exámenes"');

// ---------- Retirar el permiso ----------
await admin.revokeTeacher('jose.prof@us.es');
ok(await waitFor(() => access?.approved === false), 'retirado: el profesor lo ve en vivo');
ok(await rejects(prof.createExam(EXAM_INPUT), 'create_failed'), 'sin permiso ya no crea exámenes');

// ---------- Profesor con correo y contraseña ----------
const pw = createBackend({ emulator: true, name: 'pw' });
ok(await rejects(pw.signUpWithPassword('maria.pw@us.es', '1234567'), 'weak_password'), 'contraseña corta: weak_password');
await pw.signUpWithPassword('maria.pw@us.es', 'contraseña-larga');
ok(pw.needsVerification() && !pw.isTeacher(), 'cuenta creada: falta verificar el correo');
ok(await rejects(pw.createExam(EXAM_INPUT), 'create_failed'), 'sin verificar no crea exámenes aunque esté autorizada');
// El emulador de Auth guarda los correos de verificación: se abre el enlace como haría la profesora.
const { oobCodes } = await (await fetch('http://127.0.0.1:9099/emulator/v1/projects/demo-foco/oobCodes')).json();
const link = oobCodes.filter((c) => c.email === 'maria.pw@us.es' && c.requestType === 'VERIFY_EMAIL').at(-1)?.oobLink;
ok(!!link, 'se ha enviado el correo de verificación');
await fetch(link);
let notified = null;
pw.onUser((u) => { notified = u; });
await pw.refreshUser();
ok(pw.isTeacher() && !pw.needsVerification(), 'tras abrir el enlace ya es profesora');
ok(await waitFor(() => notified?.emailVerified === true), 'refreshUser avisa a las páginas abiertas');
let favs;
const stopFavs = pw.watchFavorites((l) => { favs = l; });
ok(await waitFor(() => favs === null), 'favoritas: sin tocar, null (la interfaz muestra las de por defecto)');
await pw.setFavorites([{ name: 'pSolver', url: 'https://psolver.jfcoronel.org/' }, { name: 'fProperties', url: 'https://fproperties.jfcoronel.org/' }]);
ok(await waitFor(() => favs?.length === 2 && favs[0].name === 'pSolver'), 'favoritas: se guardan en orden');
await pw.setFavorites([]);
ok(await waitFor(() => Array.isArray(favs) && favs.length === 0), 'favoritas: la lista vacía se queda vacía');
stopFavs();
const pwExam = await pw.createExam(EXAM_INPUT);
ok(!!pwExam.code, 'verificada y autorizada: crea el examen');
await pw.deleteExam({ id: pwExam.id, code: pwExam.code, status: 'waiting' });
await pw.signOut();
ok(await rejects(pw.signInWithPassword('maria.pw@us.es', 'otra-cosa'), 'bad_credentials'), 'contraseña incorrecta: bad_credentials');
ok(await rejects(pw.signUpWithPassword('maria.pw@us.es', 'contraseña-larga'), 'email_in_use'), 'el correo ya tiene cuenta: email_in_use');
await pw.signInWithPassword('maria.pw@us.es', 'contraseña-larga');
ok(pw.isTeacher(), 'vuelve a entrar con su contraseña');
ok(!(await rejects(pw.resetPassword('nadie@us.es'))), 'restablecer un correo sin cuenta no lo revela');

console.log(failed ? `\n${failed} fallo(s)` : '\nTodo correcto');
process.exit(failed ? 1 : 0);
