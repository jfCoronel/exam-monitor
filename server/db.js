// Capa de persistencia (SQLite vía better-sqlite3, síncrono).
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const file = process.env.DB_FILE || path.join('data', 'exam-monitor.db');
if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });

const db = new Database(file);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS exams (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL,
  name          TEXT NOT NULL,
  duration_min  INTEGER NOT NULL,
  mode          TEXT NOT NULL CHECK (mode IN ('pestana','ventana')),
  tools         TEXT NOT NULL,              -- JSON [{name,url}]
  tolerance_ms  INTEGER NOT NULL,
  alert_text    TEXT NOT NULL,
  teacher_token TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','active','finished')),
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  ended_at      INTEGER
);
CREATE INDEX IF NOT EXISTS exams_code_status ON exams(code, status);

CREATE TABLE IF NOT EXISTS students (
  id        TEXT PRIMARY KEY,
  exam_id   TEXT NOT NULL REFERENCES exams(id),
  name      TEXT NOT NULL,
  token     TEXT NOT NULL UNIQUE,
  joined_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS students_exam ON students(exam_id);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id     TEXT NOT NULL REFERENCES exams(id),
  student_id  TEXT NOT NULL REFERENCES students(id),
  client_id   TEXT,                 -- id generado en el cliente, para deduplicar reenvíos
  type        TEXT NOT NULL,
  ts          INTEGER NOT NULL,     -- hora del servidor al recibirlo
  client_ts   INTEGER,              -- hora del cliente al producirse (puede llegar tarde si estaba sin conexión)
  duration_ms INTEGER,
  reason      TEXT,
  infraction  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (student_id, client_id)
);
CREATE INDEX IF NOT EXISTS events_exam ON events(exam_id, ts);
`);

const rowToExam = (r) => (r ? { ...r, tools: JSON.parse(r.tools) } : null);

const q = {
  insertExam: db.prepare(`INSERT INTO exams
    (id, code, name, duration_min, mode, tools, tolerance_ms, alert_text, teacher_token, created_at)
    VALUES (@id, @code, @name, @duration_min, @mode, @tools, @tolerance_ms, @alert_text, @teacher_token, @created_at)`),
  getExam: db.prepare('SELECT * FROM exams WHERE id = ?'),
  openByCode: db.prepare(`SELECT * FROM exams WHERE code = ? AND status IN ('waiting','active')
    ORDER BY created_at DESC LIMIT 1`),
  start: db.prepare(`UPDATE exams SET status='active', started_at=? WHERE id=? AND status='waiting'`),
  finish: db.prepare(`UPDATE exams SET status='finished', ended_at=? WHERE id=? AND status!='finished'`),
  insertStudent: db.prepare(`INSERT INTO students (id, exam_id, name, token, joined_at)
    VALUES (@id, @exam_id, @name, @token, @joined_at)`),
  studentByToken: db.prepare('SELECT * FROM students WHERE token = ?'),
  studentsOf: db.prepare('SELECT id, exam_id, name, joined_at FROM students WHERE exam_id = ? ORDER BY name COLLATE NOCASE'),
  eventsOf: db.prepare('SELECT * FROM events WHERE exam_id = ? ORDER BY COALESCE(client_ts, ts), id'),
  insertEvent: db.prepare(`INSERT OR IGNORE INTO events
    (exam_id, student_id, client_id, type, ts, client_ts, duration_ms, reason, infraction)
    VALUES (@exam_id, @student_id, @client_id, @type, @ts, @client_ts, @duration_ms, @reason, @infraction)
    RETURNING *`),
};

export function createExam(exam) {
  q.insertExam.run({ ...exam, tools: JSON.stringify(exam.tools) });
  return getExam(exam.id);
}
export const getExam = (id) => rowToExam(q.getExam.get(id));
export const getOpenExamByCode = (code) => rowToExam(q.openByCode.get(code));
export const codeInUse = (code) => !!q.openByCode.get(code);
export const startExam = (id) => q.start.run(Date.now(), id).changes > 0;
export const finishExam = (id) => q.finish.run(Date.now(), id).changes > 0;

export const insertStudent = (s) => q.insertStudent.run(s);
export const getStudentByToken = (token) => q.studentByToken.get(token) || null;
export const listStudents = (examId) => q.studentsOf.all(examId);

export const listEvents = (examId) => q.eventsOf.all(examId);
/** Devuelve el evento insertado, o undefined si era un duplicado (mismo client_id). */
export const insertEvent = (ev) => q.insertEvent.get(ev);
