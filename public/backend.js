// Única capa que habla con Firebase (Auth + Realtime Database). El resto de la app no importa Firebase.
// Sin DOM: el smoke test la usa desde Node con el paquete npm `firebase`; en el navegador,
// el import map de cada HTML resuelve 'firebase/*' al CDN de gstatic.
import { initializeApp } from 'firebase/app';
import {
  getAuth, connectAuthEmulator, onAuthStateChanged, onIdTokenChanged, signInAnonymously,
  signInWithPopup, signInWithCredential, GoogleAuthProvider, signOut,
} from 'firebase/auth';
import {
  getDatabase, connectDatabaseEmulator, ref, get, set, update, push, query, orderByChild,
  onValue, onChildAdded, onChildChanged, onDisconnect, serverTimestamp, goOffline, goOnline,
} from 'firebase/database';
import { firebaseConfig, emulatorConfig, EMULATOR_HOSTS, shouldUseEmulator } from './firebase-config.js';

/** Error con un código estable que la interfaz traduce (err.<code> en los diccionarios). */
export class BackendError extends Error {
  constructor(code, cause) {
    super(code);
    this.code = code;
    this.cause = cause;
  }
}

const isDenied = (err) => /permission.?denied/i.test(`${err?.code} ${err?.message}`);
const wrap = (err) => (err instanceof BackendError ? err
  : new BackendError(isDenied(err) ? 'permission' : 'network', err));

/** RTDB no admite undefined: se quitan las claves sin valor. */
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

function randomCode() {
  const n = globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return String(n).padStart(6, '0');
}

/** Clave de un correo en RTDB: sin mayúsculas y con ',' en lugar de '.' (las reglas hacen lo mismo). */
export const emailKey = (email) => String(email).trim().toLowerCase().replaceAll('.', ',');

const normMeta = (id, v) => (v ? { id, ...v, tools: v.tools ? Object.values(v.tools) : [] } : null);

export function createBackend({ emulator = shouldUseEmulator(), name } = {}) {
  const config = emulator ? emulatorConfig : firebaseConfig;
  const app = initializeApp(config, name);
  const auth = getAuth(app);
  const db = getDatabase(app);
  if (emulator) {
    connectAuthEmulator(auth, EMULATOR_HOSTS.auth, { disableWarnings: true });
    connectDatabaseEmulator(db, ...EMULATOR_HOSTS.db);
  }

  // Token de sesión en caché: sendBeacon es síncrono y no puede esperar a getIdToken().
  let idToken = null;
  onIdTokenChanged(auth, async (u) => { idToken = u ? await u.getIdToken() : null; });

  const authReady = new Promise((resolve) => {
    const stop = onAuthStateChanged(auth, (u) => { stop(); resolve(u); });
  });

  const uidOrThrow = () => {
    const u = auth.currentUser;
    if (!u) throw new BackendError('signed_out');
    return u.uid;
  };

  const be = {
    emulator,
    /** Solo para tests: simula perder y recuperar la conexión. */
    debug: { goOffline: () => goOffline(db), goOnline: () => goOnline(db) },

    // ---------- Sesión ----------
    ready: () => authReady,
    currentUser: () => auth.currentUser,
    onUser: (cb) => onAuthStateChanged(auth, cb),
    isTeacher: (u = auth.currentUser) => !!u && !u.isAnonymous && u.providerData.some((p) => p.providerId === 'google.com'),

    /** Profesor: ventana de Google. En tests se pasa una credencial (ver googleCredential). */
    async signInTeacher(credential) {
      try {
        const r = credential ? await signInWithCredential(auth, credential) : await signInWithPopup(auth, new GoogleAuthProvider());
        return r.user;
      } catch (err) {
        if (/popup-closed|cancelled-popup/.test(err?.code)) throw new BackendError('popup_closed', err);
        if (/popup-blocked/.test(err?.code)) throw new BackendError('popup_blocked', err);
        throw wrap(err);
      }
    },
    googleCredential: (idTokenJson) => GoogleAuthProvider.credential(idTokenJson),

    /** Alumno: sesión anónima. Persiste en IndexedDB, así que sobrevive a recargas. */
    async signInStudent() {
      await authReady;
      if (auth.currentUser) return auth.currentUser;
      try { return (await signInAnonymously(auth)).user; } catch (err) { throw wrap(err); }
    },

    signOut: () => signOut(auth),

    // ---------- Permisos de profesor ----------
    /**
     * Estado de acceso del profesor, en vivo: cb({ admin, approved, request }) cada vez que cambia.
     * request = { email, name, requestedAt } si tiene una solicitud pendiente.
     */
    watchAccess(cb) {
      const u = auth.currentUser;
      if (!u?.email) { cb({ admin: false, approved: false, request: null }); return () => {}; }
      const k = emailKey(u.email);
      const st = { admin: null, approved: null, request: undefined };
      const emit = () => { if (st.admin !== null && st.approved !== null && st.request !== undefined) cb({ ...st, approved: st.admin || st.approved }); };
      const denied = (field, value) => () => { st[field] = value; emit(); };
      const stops = [
        onValue(ref(db, `admins/${k}`), (s) => { st.admin = s.val() === true; emit(); }, denied('admin', false)),
        onValue(ref(db, `allowedTeachers/${k}`), (s) => { st.approved = s.exists(); emit(); }, denied('approved', false)),
        onValue(ref(db, `accessRequests/${u.uid}`), (s) => { st.request = s.val(); emit(); }, denied('request', null)),
      ];
      return () => stops.forEach((stop) => stop());
    },

    requestAccess() {
      const u = auth.currentUser;
      if (!u?.email) throw new BackendError('signed_out');
      return set(ref(db, `accessRequests/${u.uid}`), clean({
        email: u.email, name: (u.displayName || '').slice(0, 120) || undefined, requestedAt: serverTimestamp(),
      })).catch((err) => { throw wrap(err); });
    },

    // ---------- Administración ----------
    /** Solicitudes pendientes y profesores autorizados, en vivo. */
    watchAdmin({ requests, teachers, error }) {
      const fail = (err) => error?.(wrap(err));
      const list = (s) => Object.entries(s.val() || {}).map(([id, v]) => ({ id, ...v }));
      const stops = [
        onValue(ref(db, 'accessRequests'), (s) => requests(list(s).sort((a, b) => a.requestedAt - b.requestedAt)), fail),
        onValue(ref(db, 'allowedTeachers'), (s) => teachers(list(s).sort((a, b) => a.email.localeCompare(b.email))), fail),
      ];
      return () => stops.forEach((stop) => stop());
    },

    /** Autoriza un correo y, si venía de una solicitud, la borra en la misma escritura. */
    approveTeacher(email, requestUid) {
      const clean_ = String(email).trim();
      const paths = {
        [`allowedTeachers/${emailKey(clean_)}`]: { email: clean_, addedAt: serverTimestamp(), addedBy: auth.currentUser?.email || '' },
      };
      if (requestUid) paths[`accessRequests/${requestUid}`] = null;
      return update(ref(db), paths).catch((err) => { throw wrap(err); });
    },
    rejectRequest: (requestUid) => set(ref(db, `accessRequests/${requestUid}`), null).catch((err) => { throw wrap(err); }),
    revokeTeacher: (email) => set(ref(db, `allowedTeachers/${emailKey(email)}`), null).catch((err) => { throw wrap(err); }),

    onServerOffset: (cb) => onValue(ref(db, '.info/serverTimeOffset'), (s) => cb(s.val() || 0)),
    onConnected: (cb) => onValue(ref(db, '.info/connected'), (s) => cb(!!s.val())),

    // ---------- Profesor ----------
    /** Crea el examen con un código libre. Las reglas rechazan la escritura entera si el código está en uso. */
    async createExam({ name, durationMin, mode, tools = [], toleranceMs, alertText }) {
      const owner = uidOrThrow();
      const examId = push(ref(db, 'exams')).key;
      for (let attempt = 0; attempt < 8; attempt++) {
        const code = randomCode();
        const meta = clean({
          name, durationMin, mode, toleranceMs, alertText, code,
          status: 'waiting', ownerUid: owner, createdAt: serverTimestamp(),
          tools: tools.length ? tools : undefined,
        });
        try {
          await update(ref(db), {
            [`codes/${code}`]: { examId, ownerUid: owner },
            [`exams/${examId}/meta`]: meta,
            [`teachers/${owner}/exams/${examId}`]: { name, code, createdAt: serverTimestamp() },
          });
          return { id: examId, code };
        } catch (err) {
          if (!isDenied(err)) throw wrap(err);
        }
      }
      throw new BackendError('create_failed');
    },

    async listMyExams() {
      const s = await get(ref(db, `teachers/${uidOrThrow()}/exams`)).catch((err) => { throw wrap(err); });
      return Object.entries(s.val() || {}).map(([id, v]) => ({ id, ...v })).sort((a, b) => b.createdAt - a.createdAt);
    },

    /**
     * Suscripción del panel: handlers.meta(exam), student(s), presence(studentId, online), event(ev), error(err).
     * Devuelve una función para cancelarla.
     */
    watchExam(examId, h) {
      const base = `exams/${examId}`;
      const stops = [];
      const fail = (err) => h.error?.(wrap(err));
      stops.push(onValue(ref(db, `${base}/meta`), (s) => h.meta?.(normMeta(examId, s.val())), fail));
      stops.push(onChildAdded(ref(db, `${base}/students`), (s) => {
        h.student?.({ id: s.key, ...s.val() });
        const evRef = query(ref(db, `${base}/events/${s.key}`), orderByChild('ts'));
        stops.push(onChildAdded(evRef, (e) => h.event?.({ id: e.key, studentId: s.key, ...e.val() }), fail));
      }, fail));
      const pres = (s) => h.presence?.(s.key, !!s.val()?.online);
      stops.push(onChildAdded(ref(db, `${base}/presence`), pres, fail));
      stops.push(onChildChanged(ref(db, `${base}/presence`), pres, fail));
      return () => stops.forEach((stop) => stop());
    },

    startExam: (examId) => update(ref(db, `exams/${examId}/meta`), { status: 'active', startedAt: serverTimestamp() })
      .catch((err) => { throw wrap(err); }),

    finishExam: (examId, code) => update(ref(db), {
      [`exams/${examId}/meta/status`]: 'finished',
      [`exams/${examId}/meta/endedAt`]: serverTimestamp(),
      [`codes/${code}`]: null,
    }).catch((err) => { throw wrap(err); }),

    /** Borra el examen y todos sus registros. El código solo se libera si el examen no había terminado. */
    deleteExam(exam) {
      const owner = uidOrThrow();
      const paths = { [`exams/${exam.id}`]: null, [`teachers/${owner}/exams/${exam.id}`]: null };
      if (exam.status !== 'finished') paths[`codes/${exam.code}`] = null;
      return update(ref(db), paths).catch((err) => { throw wrap(err); });
    },

    // ---------- Alumno ----------
    async joinExam(code, name) {
      const u = await be.signInStudent();
      let examId;
      try {
        const c = await get(ref(db, `codes/${code}`));
        examId = c.exists() ? c.val().examId : null;
      } catch (err) { throw wrap(err); }
      if (!examId) throw new BackendError('code_not_found');

      const mineRef = ref(db, `exams/${examId}/students/${u.uid}`);
      const mine = await get(mineRef).catch(() => null);
      if (mine?.exists()) return { examId, name: mine.val().name }; // ya estaba unido desde este navegador
      try {
        await set(mineRef, { name, code, joinedAt: serverTimestamp() });
      } catch (err) {
        throw isDenied(err) ? new BackendError('exam_closed', err) : wrap(err);
      }
      return { examId, name };
    },

    /** Ficha del alumno en ese examen, o null si no se unió (o el examen ya no existe). */
    async getMyStudent(examId) {
      const u = auth.currentUser;
      if (!u) return null;
      try {
        const s = await get(ref(db, `exams/${examId}/students/${u.uid}`));
        return s.exists() ? s.val() : null;
      } catch (err) {
        if (isDenied(err)) return null;
        throw wrap(err);
      }
    },

    watchMeta: (examId, cb, onError) =>
      onValue(ref(db, `exams/${examId}/meta`), (s) => cb(normMeta(examId, s.val())), (err) => onError?.(wrap(err))),

    /** Escribe un evento. La promesa se resuelve cuando el servidor lo confirma (puede tardar si no hay red). */
    sendEvent(examId, { clientId, ...ev }) {
      return set(ref(db, `exams/${examId}/events/${uidOrThrow()}/${clientId}`), { ...clean(ev), ts: serverTimestamp() })
        .catch((err) => { throw wrap(err); });
    },

    /**
     * El alumno termina su examen: registra 'exam_submit' y la hora de entrega en una sola escritura.
     * A partir de ahí las reglas rechazan cualquier otro evento suyo.
     */
    submitExam(examId, { clientId, clientTs }) {
      const me = uidOrThrow();
      return update(ref(db), {
        [`exams/${examId}/events/${me}/${clientId}`]: clean({ type: 'exam_submit', clientTs, ts: serverTimestamp() }),
        [`exams/${examId}/submitted/${me}`]: serverTimestamp(),
      }).catch((err) => { throw wrap(err); });
    },

    /** Hora de entrega del alumno en ese examen, o null si no ha terminado. */
    async getMySubmission(examId) {
      const u = auth.currentUser;
      if (!u) return null;
      try { return (await get(ref(db, `exams/${examId}/submitted/${u.uid}`))).val(); } catch { return null; }
    },

    /** URL REST para registrar un evento sin el SDK (sendBeacon al cerrar la página). */
    eventRestUrl(examId) {
      const u = auth.currentUser;
      if (!u || !idToken) return null;
      const url = new URL(config.databaseURL);
      url.pathname = `/exams/${examId}/events/${u.uid}.json`;
      url.searchParams.set('auth', idToken);
      return url.href;
    },
    restEventBody: (ev) => JSON.stringify({ ...clean(ev), ts: { '.sv': 'timestamp' } }),

    /**
     * Presencia del alumno: online mientras haya conexión; al perderla, el servidor marca offline y,
     * con el examen en curso, registra 'disconnected'. Al recuperarla se registra 'reconnected'.
     */
    presence(examId, { clientTs = () => Date.now(), newId }) {
      const me = uidOrThrow();
      const presRef = ref(db, `exams/${examId}/presence/${me}`);
      let active = false;
      let connectedBefore = false;
      let armed = null;

      async function armDisconnect() {
        if (!active) return;
        armed = onDisconnect(ref(db, `exams/${examId}/events/${me}/${newId()}`));
        await armed.set({ type: 'disconnected', ts: serverTimestamp() }).catch(() => { armed = null; });
      }

      const stop = onValue(ref(db, '.info/connected'), async (s) => {
        if (!s.val()) return;
        try {
          await onDisconnect(presRef).set({ online: false, changedAt: serverTimestamp() });
          await set(presRef, { online: true, changedAt: serverTimestamp() });
        } catch { /* sin permiso: el examen ya no existe */ }
        if (connectedBefore && active) {
          be.sendEvent(examId, { clientId: newId(), type: 'reconnected', clientTs: clientTs() }).catch(() => {});
        }
        connectedBefore = true;
        armDisconnect();
      });

      return {
        setActive(on) {
          if (on === active) return;
          active = on;
          if (on && connectedBefore) armDisconnect();
          if (!on) { armed?.cancel().catch(() => {}); armed = null; }
        },
        stop() {
          stop();
          armed?.cancel().catch(() => {});
          onDisconnect(presRef).cancel().catch(() => {});
          set(presRef, { online: false, changedAt: serverTimestamp() }).catch(() => {});
        },
      };
    },
  };
  return be;
}
