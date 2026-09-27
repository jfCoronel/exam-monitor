// Tests de las reglas de seguridad de RTDB. Se ejecutan contra el emulador: `npm run test:rules`.
import { test, before, after } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';

const TS = { '.sv': 'timestamp' };
const EXAM = 'exam1';
const CODE = '123456';

let env;
const google = (uid) => env.authenticatedContext(uid, { firebase: { sign_in_provider: 'google.com' } }).database();
const anon = (uid) => env.authenticatedContext(uid, { firebase: { sign_in_provider: 'anonymous' } }).database();

const meta = (overrides = {}) => ({
  name: 'Termodinámica, parcial 1', durationMin: 90, mode: 'pestana', toleranceMs: 3000,
  alertText: 'Queda registrado.', status: 'waiting', code: CODE, ownerUid: 'prof', createdAt: TS,
  tools: [{ name: 'fProperties', url: 'https://fproperties.jfcoronel.org/' }],
  ...overrides,
});
const createExam = (db, { examId = EXAM, code = CODE, owner = 'prof', m = {} } = {}) => db.ref().update({
  [`codes/${code}`]: { examId, ownerUid: owner },
  [`exams/${examId}/meta`]: meta({ code, ownerUid: owner, ...m }),
  [`teachers/${owner}/exams/${examId}`]: { name: 'Termodinámica', code, createdAt: Date.now() },
});
const join = (uid, code = CODE, examId = EXAM) =>
  anon(uid).ref(`exams/${examId}/students/${uid}`).set({ name: 'Ana López', code, joinedAt: TS });
const event = (uid, clientId, data, examId = EXAM) =>
  anon(uid).ref(`exams/${examId}/events/${uid}/${clientId}`).set({ ts: TS, clientTs: Date.now(), ...data });
const setStatus = (db, status, extra = {}, examId = EXAM) =>
  db.ref(`exams/${examId}/meta`).update({ status, ...extra });

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-foco',
    database: { rules: readFileSync(new URL('../database.rules.json', import.meta.url), 'utf8'), host: '127.0.0.1', port: 9000 },
  });
});
after(() => env?.cleanup());

test('crear examen', async (t) => {
  await env.clearDatabase();
  await t.test('un alumno anónimo no puede crear exámenes', () => assertFails(createExam(anon('prof'))));
  await t.test('rechaza URLs de herramienta que no son http(s)', () =>
    assertFails(createExam(google('prof'), { m: { tools: [{ name: 'x', url: 'javascript:alert(1)' }] } })));
  await t.test('rechaza duración fuera de rango', () => assertFails(createExam(google('prof'), { m: { durationMin: 0 } })));
  await t.test('rechaza un examen que no empieza en espera', () => assertFails(createExam(google('prof'), { m: { status: 'active' } })));
  await t.test('no se puede crear a nombre de otro profesor', () =>
    assertFails(google('prof').ref(`exams/${EXAM}/meta`).set(meta({ ownerUid: 'otro' }))));
  await t.test('el profesor crea el examen', () => assertSucceeds(createExam(google('prof'))));
  await t.test('otro profesor no puede reutilizar un código abierto', () =>
    assertFails(createExam(google('otro'), { examId: 'exam2', owner: 'otro' })));
  await t.test('otro profesor no puede sobrescribir el examen', () =>
    assertFails(google('otro').ref(`exams/${EXAM}/meta`).set(meta({ ownerUid: 'otro' }))));
  await t.test('la configuración no se puede cambiar después', () =>
    assertFails(google('prof').ref(`exams/${EXAM}/meta/toleranceMs`).set(60000)));
});

test('unirse y leer', async (t) => {
  await env.clearDatabase();
  await createExam(google('prof'));
  await t.test('el alumno resuelve el código', () => assertSucceeds(anon('al1').ref(`codes/${CODE}`).get()));
  await t.test('no se pueden listar los códigos', () => assertFails(anon('al1').ref('codes').get()));
  await t.test('no puede leer el examen antes de unirse', () => assertFails(anon('al1').ref(`exams/${EXAM}/meta`).get()));
  await t.test('código incorrecto: no se une', () => assertFails(join('al1', '999999')));
  await t.test('no puede unirse en nombre de otro', () =>
    assertFails(anon('al1').ref(`exams/${EXAM}/students/al2`).set({ name: 'X', code: CODE, joinedAt: TS })));
  await t.test('se une con el código correcto', () => assertSucceeds(join('al1')));
  await t.test('no puede volver a escribir su ficha', () => assertFails(join('al1')));
  await t.test('ya lee la configuración del examen', () => assertSucceeds(anon('al1').ref(`exams/${EXAM}/meta`).get()));
  await t.test('no lee la lista de alumnos ni los eventos', async () => {
    await assertFails(anon('al1').ref(`exams/${EXAM}/students`).get());
    await assertFails(anon('al1').ref(`exams/${EXAM}/events`).get());
    await assertFails(anon('al1').ref(`exams/${EXAM}`).get());
  });
  await t.test('el profesor lo lee todo', () => assertSucceeds(google('prof').ref(`exams/${EXAM}`).get()));
  await t.test('otro profesor no lee nada', () => assertFails(google('otro').ref(`exams/${EXAM}`).get()));
  await t.test('presencia propia sí, ajena no', async () => {
    await assertSucceeds(anon('al1').ref(`exams/${EXAM}/presence/al1`).set({ online: true, changedAt: TS }));
    await assertFails(anon('al1').ref(`exams/${EXAM}/presence/al2`).set({ online: true, changedAt: TS }));
  });
});

test('eventos y ciclo de vida', async (t) => {
  await env.clearDatabase();
  await createExam(google('prof'));
  await join('al1');
  await t.test('no registra eventos antes de iniciar', () => assertFails(event('al1', 'c0', { type: 'exam_enter' })));
  await t.test('el alumno no puede iniciar el examen', () =>
    assertFails(setStatus(anon('al1'), 'active', { startedAt: TS })));
  await t.test('startedAt debe ser la hora del servidor', () =>
    assertFails(setStatus(google('prof'), 'active', { startedAt: 1 })));
  await t.test('el profesor inicia el examen', () => assertSucceeds(setStatus(google('prof'), 'active', { startedAt: TS })));
  await t.test('evento válido', () => assertSucceeds(event('al1', 'c1', { type: 'away_start', reason: 'Página oculta' })));
  await t.test('away_end con duración', () => assertSucceeds(event('al1', 'c2', { type: 'away_end', durationMs: 8000 })));
  await t.test('un reenvío con el mismo clientId no duplica', () => assertFails(event('al1', 'c1', { type: 'away_start' })));
  await t.test('tipo de evento no válido', () => assertFails(event('al1', 'c3', { type: 'hack' })));
  await t.test('durationMs solo en away_end', () => assertFails(event('al1', 'c4', { type: 'away_start', durationMs: 5 })));
  await t.test('durationMs fuera de rango', () => assertFails(event('al1', 'c5', { type: 'away_end', durationMs: -1 })));
  await t.test('ts lo pone el servidor, no el cliente', () =>
    assertFails(anon('al1').ref(`exams/${EXAM}/events/al1/c6`).set({ type: 'exam_enter', ts: 1 })));
  await t.test('no escribe eventos de otro alumno', () =>
    assertFails(anon('al1').ref(`exams/${EXAM}/events/al2/c7`).set({ type: 'exam_enter', ts: TS })));
  await t.test('quien no se ha unido no escribe eventos', () => assertFails(event('intruso', 'c8', { type: 'exam_enter' })));

  await t.test('el profesor finaliza y libera el código', () => assertSucceeds(google('prof').ref().update({
    [`exams/${EXAM}/meta/status`]: 'finished', [`exams/${EXAM}/meta/endedAt`]: TS, [`codes/${CODE}`]: null,
  })));
  await t.test('no registra eventos con el examen finalizado', () => assertFails(event('al1', 'c9', { type: 'away_start' })));
  await t.test('no se puede unir a un examen finalizado', () => assertFails(join('al2')));
  await t.test('un examen finalizado no se reabre', () => assertFails(setStatus(google('prof'), 'active')));
  await t.test('el código se puede reutilizar', () =>
    assertSucceeds(createExam(google('otro'), { examId: 'exam2', owner: 'otro' })));
});

test('código de un examen finalizado sin liberar', async () => {
  await env.clearDatabase();
  await createExam(google('prof'));
  await setStatus(google('prof'), 'finished', { endedAt: TS });
  await assertSucceeds(createExam(google('otro'), { examId: 'exam2', owner: 'otro' }));
});

test('borrar examen', async (t) => {
  await env.clearDatabase();
  await createExam(google('prof'));
  await t.test('otro profesor no puede', () => assertFails(google('otro').ref(`exams/${EXAM}`).remove()));
  await t.test('el propietario sí', () => assertSucceeds(google('prof').ref(`exams/${EXAM}`).remove()));
});
