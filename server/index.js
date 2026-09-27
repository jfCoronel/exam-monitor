// Servidor: API REST + WebSocket + ficheros estáticos de /public.
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { randomUUID, randomBytes, randomInt } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const TZ = process.env.EXPORT_TZ || 'Europe/Madrid';

// Tipos de evento que puede mandar el cliente del alumno.
const CLIENT_EVENTS = new Set(['exam_enter', 'away_start', 'away_end', 'fullscreen_exit', 'page_leave']);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use('/api/beacon', express.text({ type: '*/*', limit: '10kb' })); // navigator.sendBeacon
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

const newToken = () => randomBytes(24).toString('base64url');
const bad = (res, msg, status = 400) => res.status(status).json({ error: msg });

// ---------- Vistas públicas de los datos ----------
const examForStudent = (e) => ({
  id: e.id, name: e.name, durationMin: e.duration_min, mode: e.mode, tools: e.tools,
  toleranceMs: e.tolerance_ms, alertText: e.alert_text, status: e.status,
  startedAt: e.started_at, endedAt: e.ended_at,
});
const examForTeacher = (e) => ({ ...examForStudent(e), code: e.code, createdAt: e.created_at });
const studentPublic = (s) => ({ id: s.id, name: s.name, joinedAt: s.joined_at });

// ---------- Auth ----------
function bearer(req) {
  return (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || String(req.query.token || '');
}
function teacherAuth(req, res, next) {
  const exam = db.getExam(req.params.id);
  if (!exam || exam.teacher_token !== bearer(req)) return bad(res, 'Examen no encontrado o sin permiso', 404);
  req.exam = exam;
  next();
}

// ---------- API ----------
app.post('/api/exams', (req, res) => {
  const { name, durationMin, mode, tools, toleranceSec, alertText } = req.body || {};
  const cleanName = String(name || '').trim().slice(0, 120);
  if (!cleanName) return bad(res, 'Falta el nombre del examen');

  const dur = Number(durationMin);
  if (!Number.isInteger(dur) || dur < 1 || dur > 600) return bad(res, 'La duración debe estar entre 1 y 600 minutos');
  if (!['pestana', 'ventana'].includes(mode)) return bad(res, 'Modo no válido');

  const cleanTools = [];
  for (const t of Array.isArray(tools) ? tools.slice(0, 10) : []) {
    const raw = String(t?.url || '').trim();
    if (!raw) continue;
    let u;
    try { u = new URL(raw); } catch { return bad(res, `URL no válida: ${raw}`); }
    if (!/^https?:$/.test(u.protocol)) return bad(res, `La URL debe empezar por http:// o https://: ${raw}`);
    cleanTools.push({ name: String(t.name || '').trim().slice(0, 60) || u.hostname, url: u.href });
  }

  let code;
  do { code = String(randomInt(0, 1_000_000)).padStart(6, '0'); } while (db.codeInUse(code));

  const teacherToken = newToken();
  const exam = db.createExam({
    id: randomUUID(), code, name: cleanName, duration_min: dur, mode, tools: cleanTools,
    tolerance_ms: Math.round(Math.min(60, Math.max(0, Number(toleranceSec) || 0)) * 1000),
    alert_text: String(alertText || '').trim().slice(0, 300) ||
      'Este aviso ha quedado registrado y el profesor puede verlo. Mantén esta página en primer plano hasta que termine el examen.',
    teacher_token: teacherToken, created_at: Date.now(),
  });
  res.status(201).json({ exam: examForTeacher(exam), teacherToken });
});

app.get('/api/exams/:id', teacherAuth, (req, res) => {
  res.json({
    exam: examForTeacher(req.exam),
    students: db.listStudents(req.exam.id).map(studentPublic),
    events: db.listEvents(req.exam.id),
  });
});

app.get('/api/exams/:id/export.csv', teacherAuth, (req, res) => {
  const names = new Map(db.listStudents(req.exam.id).map((s) => [s.id, s.name]));
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const fmt = (ms) => new Date(ms).toLocaleString('es-ES', { timeZone: TZ });
  const rows = [['Alumno', 'Evento', 'Hora', 'Duración (s)', 'Motivo', 'Incidencia']];
  for (const e of db.listEvents(req.exam.id)) {
    rows.push([names.get(e.student_id), e.type, fmt(e.client_ts ?? e.ts),
      e.duration_ms != null ? (e.duration_ms / 1000).toFixed(1) : '', e.reason, e.infraction ? 'sí' : '']);
  }
  const csv = '\uFEFF' + rows.map((r) => r.map(cell).join(';')).join('\r\n'); // BOM + ';' para Excel en español
  const file = `examen-${req.exam.code}-${new Date().toISOString().slice(0, 10)}.csv`;
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${file}"` }).send(csv);
});

app.post('/api/join', (req, res) => {
  const code = String(req.body?.code || '').replace(/\D/g, '');
  const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!name) return bad(res, 'Escribe tu nombre y apellidos');
  if (code.length !== 6) return bad(res, 'El código tiene 6 cifras');
  const exam = db.getOpenExamByCode(code);
  if (!exam) return bad(res, 'No hay ningún examen abierto con ese código', 404);

  const student = { id: randomUUID(), exam_id: exam.id, name, token: newToken(), joined_at: Date.now() };
  db.insertStudent(student);
  hub.toTeachers(exam.id, { t: 'student_joined', student: studentPublic(student) });
  res.status(201).json({ studentId: student.id, token: student.token, name, exam: examForStudent(exam) });
});

app.get('/api/session', (req, res) => {
  const s = db.getStudentByToken(bearer(req));
  if (!s) return bad(res, 'Sesión no válida', 401);
  res.json({ studentId: s.id, name: s.name, exam: examForStudent(db.getExam(s.exam_id)) });
});

// Último aviso al cerrar/recargar la página (sendBeacon no permite cabeceras: el token va en el cuerpo).
app.post('/api/beacon', (req, res) => {
  let body = {};
  try { body = JSON.parse(req.body || '{}'); } catch { /* ignorar */ }
  const s = body.token && db.getStudentByToken(String(body.token));
  if (s) recordEvent(s, { type: 'page_leave', clientId: body.clientId, ts: body.ts });
  res.status(204).end();
});

// ---------- Registro de eventos ----------
function recordEvent(student, e, { fromServer = false } = {}) {
  if (!fromServer && !CLIENT_EVENTS.has(e.type)) return;
  const exam = db.getExam(student.exam_id);
  if (!exam || exam.status !== 'active') return; // sólo se registra con el examen en curso

  const durationMs = e.type === 'away_end'
    ? Math.round(Math.min(Math.max(Number(e.durationMs) || 0, 0), 24 * 3600e3)) : null;
  const infraction = (e.type === 'away_end' && durationMs >= exam.tolerance_ms) || e.type === 'page_leave';

  const ev = db.insertEvent({
    exam_id: exam.id,
    student_id: student.id,
    client_id: e.clientId ? String(e.clientId).slice(0, 64) : null,
    type: e.type,
    ts: Date.now(),
    client_ts: Number.isFinite(Number(e.ts)) ? Number(e.ts) : null,
    duration_ms: durationMs,
    reason: e.reason ? String(e.reason).slice(0, 120) : null,
    infraction: infraction ? 1 : 0,
  });
  if (ev) hub.toTeachers(exam.id, { t: 'event', event: ev });
  return ev;
}

// ---------- WebSocket ----------
// rooms: examId -> { teachers: Set<ws>, students: Map<studentId, Set<ws>> }
const rooms = new Map();
const room = (id) => {
  if (!rooms.has(id)) rooms.set(id, { teachers: new Set(), students: new Map() });
  return rooms.get(id);
};
const send = (ws, msg) => { if (ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); };

const hub = {
  toTeachers(examId, msg) {
    const r = rooms.get(examId); if (!r) return;
    const s = JSON.stringify(msg);
    for (const ws of r.teachers) send(ws, s);
  },
  toStudents(examId, msg) {
    const r = rooms.get(examId); if (!r) return;
    const s = JSON.stringify(msg);
    for (const set of r.students.values()) for (const ws of set) send(ws, s);
  },
  onlineIds: (examId) => [...(rooms.get(examId)?.students.keys() || [])],
};

function broadcastExam(examId) {
  const exam = db.getExam(examId);
  const serverNow = Date.now();
  hub.toTeachers(examId, { t: 'exam', exam: examForTeacher(exam), serverNow });
  hub.toStudents(examId, { t: 'exam', exam: examForStudent(exam), serverNow });
}

function authenticate(m) {
  if (m.role === 'teacher') {
    const exam = db.getExam(String(m.examId || ''));
    if (exam && exam.teacher_token === m.token) return { role: 'teacher', examId: exam.id };
  } else if (m.role === 'student') {
    const s = db.getStudentByToken(String(m.token || ''));
    if (s) return { role: 'student', examId: s.exam_id, student: s };
  }
  return null;
}

function joinRoom(ws, ctx) {
  const r = room(ctx.examId);
  const serverNow = Date.now();
  if (ctx.role === 'teacher') {
    r.teachers.add(ws);
    const exam = db.getExam(ctx.examId);
    send(ws, {
      t: 'snapshot', serverNow, exam: examForTeacher(exam),
      students: db.listStudents(ctx.examId).map(studentPublic),
      events: db.listEvents(ctx.examId), online: hub.onlineIds(ctx.examId),
    });
    return;
  }
  const id = ctx.student.id;
  const first = !r.students.has(id);
  if (first) r.students.set(id, new Set());
  r.students.get(id).add(ws);
  if (first) {
    hub.toTeachers(ctx.examId, { t: 'presence', studentId: id, online: true });
    if (ctx.student.wasOffline) recordEvent(ctx.student, { type: 'reconnected' }, { fromServer: true });
  }
  send(ws, { t: 'exam', exam: examForStudent(db.getExam(ctx.examId)), serverNow });
}

function leaveRoom(ws, ctx) {
  const r = rooms.get(ctx.examId); if (!r) return;
  if (ctx.role === 'teacher') { r.teachers.delete(ws); return; }
  const set = r.students.get(ctx.student.id); if (!set) return;
  set.delete(ws);
  if (set.size === 0) {
    r.students.delete(ctx.student.id);
    hub.toTeachers(ctx.examId, { t: 'presence', studentId: ctx.student.id, online: false });
    recordEvent(ctx.student, { type: 'disconnected' }, { fromServer: true });
    offlineStudents.add(ctx.student.id);
  }
}
const offlineStudents = new Set(); // para marcar "reconectado" al volver

function handleMessage(ws, ctx, m) {
  if (ctx.role === 'teacher') {
    if (m.t === 'start' && db.startExam(ctx.examId)) broadcastExam(ctx.examId);
    if (m.t === 'end' && db.finishExam(ctx.examId)) broadcastExam(ctx.examId);
    return;
  }
  if (m.t === 'event') {
    recordEvent(ctx.student, m);
    if (m.clientId) send(ws, { t: 'ack', clientId: m.clientId }); // el cliente lo quita de su cola
  }
}

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  let ctx = null;
  const helloTimer = setTimeout(() => { if (!ctx) ws.close(4001, 'hello timeout'); }, 5000);

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!ctx) {
      if (m.t !== 'hello') return ws.close(4002, 'hello expected');
      ctx = authenticate(m);
      if (!ctx) return ws.close(4003, 'unauthorized');
      clearTimeout(helloTimer);
      if (ctx.role === 'student') {
        ctx.student.wasOffline = offlineStudents.delete(ctx.student.id);
      }
      return joinRoom(ws, ctx);
    }
    handleMessage(ws, ctx, m);
  });

  ws.on('close', () => { clearTimeout(helloTimer); if (ctx) leaveRoom(ws, ctx); });
  ws.on('error', () => {});
});

// Latido: detecta conexiones muertas (portátil cerrado, wifi caído...) en ~20 s.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 10_000).unref();

server.listen(PORT, () => {
  console.log(`Exam monitor escuchando en http://localhost:${PORT}`);
  console.log(`  Alumnos:   http://localhost:${PORT}/alumno/`);
  console.log(`  Profesor:  http://localhost:${PORT}/profesor/`);
});
