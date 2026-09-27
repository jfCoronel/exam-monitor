// Test de humo: arranca el servidor con BD en memoria y simula un profesor y un alumno.
// Uso: npm run smoke
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
const srv = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, PORT: String(PORT), DB_FILE: ':memory:' }, stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((r) => srv.stdout.once('data', r));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (path, body) => fetch(BASE + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
function ws(hello) {
  const sock = new WebSocket(`ws://localhost:${PORT}/ws`);
  sock.msgs = [];
  sock.on('message', (d) => sock.msgs.push(JSON.parse(d)));
  return new Promise((r) => sock.on('open', () => { sock.send(JSON.stringify(hello)); r(sock); }));
}
const waitFor = async (sock, pred, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const m = sock.msgs.find(pred); if (m) return m; await sleep(20); }
  throw new Error('Timeout esperando mensaje');
};
let failed = 0;
const check = (cond, msg) => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${msg}`); if (!cond) failed++; };

try {
  const bad = await post('/api/exams', { name: 'X', durationMin: 90, mode: 'pestana', tools: [{ url: 'ftp://x' }] });
  check(bad.status === 400, 'rechaza URLs no http(s)');

  const c = await post('/api/exams', {
    name: 'Parcial 1', durationMin: 60, mode: 'pestana', toleranceSec: 3,
    tools: [{ name: 'Herramienta A', url: 'https://example.com' }],
  });
  check(c.status === 201 && /^\d{6}$/.test(c.data.exam.code), 'crea examen con código de 6 cifras');
  const { exam, teacherToken } = c.data;

  const teacher = await ws({ t: 'hello', role: 'teacher', examId: exam.id, token: teacherToken });
  await waitFor(teacher, (m) => m.t === 'snapshot');
  check(true, 'profesor recibe snapshot');

  const wrong = await post('/api/join', { name: 'Ana', code: '000000' === exam.code ? '111111' : '000000' });
  check(wrong.status === 404, 'código incorrecto da 404');

  const j = await post('/api/join', { name: 'Ana García', code: exam.code });
  check(j.status === 201 && j.data.token, 'alumno se une');
  await waitFor(teacher, (m) => m.t === 'student_joined');
  check(true, 'profesor ve al alumno unirse');

  const student = await ws({ t: 'hello', role: 'student', token: j.data.token });
  await waitFor(student, (m) => m.t === 'exam' && m.exam.status === 'waiting');
  await waitFor(teacher, (m) => m.t === 'presence' && m.online);
  check(true, 'alumno en sala de espera y presencia online');

  // Evento antes de empezar: no se registra
  student.send(JSON.stringify({ t: 'event', type: 'away_start', clientId: 'pre', reason: 'x' }));
  await sleep(100);
  check(!teacher.msgs.some((m) => m.t === 'event'), 'no registra eventos antes de iniciar');

  teacher.send(JSON.stringify({ t: 'start' }));
  await waitFor(student, (m) => m.t === 'exam' && m.exam.status === 'active');
  check(true, 'alumno recibe inicio del examen');

  student.send(JSON.stringify({ t: 'event', type: 'exam_enter', clientId: 'e1', ts: Date.now() }));
  student.send(JSON.stringify({ t: 'event', type: 'away_start', clientId: 'e2', ts: Date.now(), reason: 'Página oculta' }));
  student.send(JSON.stringify({ t: 'event', type: 'away_end', clientId: 'e3', ts: Date.now(), durationMs: 1000 }));
  student.send(JSON.stringify({ t: 'event', type: 'away_start', clientId: 'e4', ts: Date.now(), reason: 'Foco' }));
  student.send(JSON.stringify({ t: 'event', type: 'away_end', clientId: 'e5', ts: Date.now(), durationMs: 8000 }));
  student.send(JSON.stringify({ t: 'event', type: 'away_end', clientId: 'e5', ts: Date.now(), durationMs: 8000 })); // duplicado
  student.send(JSON.stringify({ t: 'event', type: 'hack', clientId: 'e6' }));
  await waitFor(student, (m) => m.t === 'ack' && m.clientId === 'e5');
  await sleep(150);
  const evs = teacher.msgs.filter((m) => m.t === 'event').map((m) => m.event);
  check(evs.length === 5, `profesor recibe 5 eventos sin duplicados ni tipos inválidos (recibió ${evs.length})`);
  check(evs.find((e) => e.client_id === 'e3')?.infraction === 0, '1 s fuera con tolerancia 3 s: no es incidencia');
  check(evs.find((e) => e.client_id === 'e5')?.infraction === 1, '8 s fuera: sí es incidencia');

  student.close();
  await waitFor(teacher, (m) => m.t === 'event' && m.event.type === 'disconnected');
  check(true, 'desconexión registrada');

  await fetch(BASE + '/api/beacon', { method: 'POST', body: JSON.stringify({ token: j.data.token, clientId: 'b1' }) });
  await waitFor(teacher, (m) => m.t === 'event' && m.event.type === 'page_leave');
  check(true, 'sendBeacon registra cierre de página como incidencia');

  const csv = await fetch(`${BASE}/api/exams/${exam.id}/export.csv?token=${teacherToken}`).then((r) => r.text());
  check(csv.includes('Ana García') && csv.split('\r\n').length === 8, 'exporta CSV');
  const csvNo = await fetch(`${BASE}/api/exams/${exam.id}/export.csv?token=mal`);
  check(csvNo.status === 404, 'CSV sin token válido da 404');

  teacher.send(JSON.stringify({ t: 'end' }));
  await waitFor(teacher, (m) => m.t === 'exam' && m.exam.status === 'finished');
  const late = await post('/api/join', { name: 'Tarde', code: exam.code });
  check(late.status === 404, 'no se puede unir a un examen finalizado');
  teacher.close();
} catch (e) {
  console.error(e); failed++;
} finally {
  srv.kill();
  console.log(failed ? `\n${failed} comprobación(es) fallida(s)` : '\nTodo correcto');
  process.exit(failed ? 1 : 0);
}
