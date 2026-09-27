# CLAUDE.md

Contexto para continuar este proyecto con Claude Code. Léelo antes de tocar código.

## Qué es

PWA para exámenes **presenciales**. Los alumnos solo pueden usar ciertas herramientas web
(p. ej. fProperties, pSolver). La app detecta cuándo el alumno saca el foco de la página del
examen, le avisa al volver y lo registra; el profesor lo ve en tiempo real.

No es un "lockdown browser": no bloquea nada, **detecta y registra**. El profesor está en el aula.

## Stack

- Node.js ≥ 20, ESM (`"type": "module"`).
- `express` (API + estáticos), `ws` (WebSocket nativo, sin Socket.io), `better-sqlite3` (síncrono).
- Frontend: HTML + CSS + JS vanilla con módulos ES. Sin build, sin framework. Mantenerlo así
  salvo que haya una razón clara.
- Interfaz bilingüe español/inglés (en migración, ver docs/PLAN.md). El español es de España (tú,
  no vos). Comentarios del código en español.

## Estructura

```
server/index.js      API REST, WebSocket, lógica de eventos
server/db.js         Esquema SQLite y consultas preparadas
public/common.js     Utilidades compartidas (api(), connect() con reconexión, formatos)
public/styles.css    Tokens de diseño y componentes base
public/alumno/       PWA del alumno (unirse, sala de espera, examen, monitor de foco)
public/profesor/     Crear examen (index.html + crear.js) y panel en vivo (panel.*)
public/sw.js         Service worker (red primero, caché de respaldo)
scripts/smoke-test.js  Test E2E sin navegador: `npm run smoke`
```

## Modelo de datos

- `exams`: `status` pasa `waiting → active → finished`. `code` de 6 cifras, único entre exámenes
  no finalizados. `teacher_token` autentica al profesor (no hay cuentas en v1).
- `students`: se crean al unirse; `token` autentica al alumno (se guarda en su localStorage).
- `events`: `UNIQUE(student_id, client_id)` para que los reenvíos tras reconexión no dupliquen.
  `ts` = hora del servidor, `client_ts` = hora real del hecho (corregida con el offset del servidor).
  `infraction` se calcula en el servidor.

## Protocolo WebSocket (`/ws`)

Primer mensaje obligatorio (5 s de plazo):
`{t:'hello', role:'teacher', examId, token}` o `{t:'hello', role:'student', token}`.
Auth fallida → cierre con código 4003.

Alumno → servidor: `{t:'event', type, clientId, ts, reason?, durationMs?}`. El servidor responde
`{t:'ack', clientId}` y el cliente lo quita de su cola persistente.
Tipos válidos del cliente: `exam_enter`, `away_start`, `away_end`, `fullscreen_exit`, `page_leave`
(este último llega por `POST /api/beacon` con `sendBeacon`).
Tipos generados por el servidor: `disconnected`, `reconnected`.

Profesor → servidor: `{t:'start'}`, `{t:'end'}`.

Servidor → profesor: `snapshot` (al conectar), `exam`, `student_joined`, `presence`, `event`.
Servidor → alumno: `exam` (con `serverNow` para corregir el reloj), `ack`.

Reglas: solo se registran eventos con el examen en `active`. Es incidencia un `away_end` con
`duration_ms >= tolerance_ms`, o un `page_leave`.

## Cómo funciona la detección (public/alumno/alumno.js)

Fuente de verdad: sondeo cada 500 ms de `document.visibilityState === 'visible' && document.hasFocus()`.
`blur`, `focus` y `visibilitychange` solo adelantan la comprobación.

Clave: `document.hasFocus()` sigue siendo `true` cuando el foco está dentro de un iframe de la
página, así que **usar la herramienta incrustada no cuenta como salir**. Esto se ha verificado en
Chromium; hay que verificarlo en Firefox y Safari.

Modos:
- `pestana` (recomendado): las herramientas se cargan en iframes dentro de la página del examen,
  con pestañas internas. Cualquier salida es detectable.
- `ventana`: las herramientas se abren con `window.open`. La página del examen pierde el foco al
  usarlas y **no hay forma de saber a qué ventana fue el alumno**. Se registra igualmente, con un
  motivo que lo indica. Es una limitación conocida, no un bug.

## Hacia la v1.0

El plan vigente está en [docs/PLAN.md](docs/PLAN.md). Decisión clave: se distribuye desde GitHub
Pages y el servidor Node se sustituye por Firebase Realtime Database + Auth (proyecto
`exam-monitor-jfc`, cuenta jfcoroneltoro@gmail.com). Dominio: exam-monitor.jfcoronel.org.
Reglas en `database.rules.json`, tests con `npm run test:rules` (emulador, necesita Java). La versión con servidor Node queda en la etiqueta `v0.1.0-node`.
Hasta completar la fase 2 del plan, lo que sigue describe la versión Node.

## Limitaciones conocidas y pendientes (por prioridad)

1. ~~Verificar que las herramientas reales se pueden incrustar.~~ Hecho para
   fproperties.jfcoronel.org y psolver.jfcoronel.org (27/09/2026): sin cabeceras que lo impidan.
   Para otras URLs sigue valiendo: Si fProperties o pSolver envían
   `X-Frame-Options: DENY/SAMEORIGIN` o `Content-Security-Policy: frame-ancestors`, el iframe sale
   en blanco. Comprobar con `curl -I <url>`. Si no se pueden incrustar, opciones: modo ventana,
   pedir al autor que permita el dominio, o una extensión de navegador complementaria.
2. **Detectar iframe bloqueado** y mostrar un mensaje útil al alumno (hoy solo ve la página en blanco).
3. **Modo ventana verificable**: una extensión opcional (Chrome/Edge, Manifest V3) que informe de la
   URL de la pestaña/ventana activa permitiría distinguir "está en la herramienta" de "está en otra web".
4. **Cuentas de profesor.** Hoy el token vive en el localStorage del navegador que creó el examen.
5. **Fin automático** cuando se agota el tiempo (hoy el profesor pulsa Finalizar).
6. **Tests de navegador** (Playwright). Ojo: Chromium headless emula el foco en todas las páginas;
   para probar la pérdida de foco hay que sobrescribir `document.hasFocus` desde el test.
7. **Accesibilidad del panel**: se re-renderiza cada segundo cuando hay alumnos fuera, lo que puede
   robar el foco del teclado. Pasar a actualizaciones por nodo.
8. Límite de alumnos por examen y rate limiting de `/api/join`.
9. Dark mode.

## Convenciones

- Validar siempre en el servidor; el cliente del alumno no es de confianza.
- Toda cadena que venga del usuario se escapa con `esc()` antes de ir a `innerHTML`.
- Mensajes de error: dicen qué ha pasado y cómo arreglarlo, sin disculpas.
- Tras cambiar el protocolo o la lógica de eventos, ejecutar `npm run smoke` y ampliarlo.

## Dirección visual

Hoja de examen cuadriculada: fondo con cuadrícula, tinta azul marino (`--ink`), azul bolígrafo
(`--pen`) como acento. Tipografía Atkinson Hyperlegible (legibilidad bajo presión).
El elemento memorable es el código en casillas, como en una hoja de respuestas.
Rojo solo para incidencias, ámbar para situaciones dudosas (sin conexión, fuera menos de la tolerancia).
