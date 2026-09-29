# CLAUDE.md

Contexto para continuar este proyecto con Claude Code. Léelo antes de tocar código.
El plan hasta la v1.0 está en [docs/PLAN.md](docs/PLAN.md).

## Qué es

PWA para exámenes **presenciales**. Los alumnos solo pueden usar ciertas herramientas web
(p. ej. fProperties, pSolver). La app detecta cuándo el alumno saca el foco de la página del
examen, le avisa al volver y lo registra; el profesor lo ve en tiempo real.

No es un "lockdown browser": no bloquea nada, **detecta y registra**. El profesor está en el aula.

## Stack y despliegue

- Frontend estático en **GitHub Pages** (`https://exam-monitor.jfcoronel.org`, CNAME en Cloudflare,
  solo DNS). El workflow `.github/workflows/ci.yml` pasa los tests y publica `public/` en cada push a `main`.
- **Firebase** (proyecto `exam-monitor-jfc`, cuenta jfcoroneltoro@gmail.com, región `europe-west1`):
  Realtime Database + Auth (Google para profesores, anónimo para alumnos). No hay servidor propio.
  La versión anterior con servidor Node está en la etiqueta `v0.1.0-node`.
- HTML + CSS + JS vanilla con módulos ES. **Sin build, sin framework.** El SDK de Firebase llega
  por un import map en cada HTML (`firebase/app` → gstatic). En Node, el mismo import resuelve al
  paquete npm, así que `public/backend.js` funciona en los dos sitios. La versión del import map
  debe coincidir con la de `firebase` en package.json (lo comprueba un test).
- Node ≥ 22 solo para herramientas: `firebase-tools` (dependencia de desarrollo, `npx firebase`),
  emuladores (necesitan Java) y tests.

```bash
npm run dev          # emuladores + servidor estático en http://localhost:8080 (usa los emuladores)
npm test             # reglas de seguridad + i18n (emulador de RTDB)
npm run smoke        # E2E sin navegador: profesor y alumnos simulados contra los emuladores
npm run deploy:rules # publica database.rules.json en el proyecto real
```

En `localhost` la app usa los emuladores (proyecto `demo-foco`); con `?prod` en la URL usa el real.

## Estructura

```
database.rules.json     Reglas de seguridad de RTDB: toda la validación "de servidor" está aquí
public/backend.js       Única capa que habla con Firebase (sin DOM)
public/firebase-config.js  Config web (pública) y de emuladores
public/common.js        Utilidades: esc(), formatos, isInfraction(), textos de eventos
public/i18n/            index.js (t, applyI18n, selector), es.js, en.js
public/alumno/          PWA del alumno (unirse, sala de espera, examen, monitor de foco)
public/profesor/        Acceso con Google + crear examen (index.html, crear.js), panel en vivo (panel.*)
public/sw.js            Service worker (red primero, caché de respaldo); rutas relativas
public/admin/           Administración: solicitudes y profesores autorizados
public/version.js       Versión de la app (única fuente; se muestra en el pie)
scripts/smoke-test.js   E2E con backend.js en Node
scripts/seed-emulator.js  Datos de partida en el emulador (admin y profesor de prueba)
scripts/dev-server.js   Servidor estático de desarrollo
test/                   rules.test.js (emulador), i18n.test.js, version.test.js
```

Todas las rutas son **relativas** (la app funciona en un dominio propio, en un subdirectorio y en local).

## Modelo de datos (RTDB)

```
/codes/{code}                      { examId, ownerUid }        solo exámenes no finalizados
/exams/{examId}/meta               { name, durationMin, mode, tools[], toleranceMs, alertText,
                                     status, code, ownerUid, createdAt, startedAt?, endedAt? }
/exams/{examId}/students/{uid}     { name, code, joinedAt }
/exams/{examId}/presence/{uid}     { online, changedAt }       onDisconnect() lo pone a false
/exams/{examId}/events/{uid}/{clientId}  { type, ts, clientTs?, durationMs?, reason? }
/teachers/{uid}/exams/{examId}     { name, code, createdAt }
/admins/{emailKey}                 true                        solo se edita desde consola o CLI
/allowedTeachers/{emailKey}        { email, addedAt, addedBy }  profesores autorizados (los gestiona el admin)
/accessRequests/{uid}              { email, name?, requestedAt } solicitudes pendientes
```

`emailKey` = correo en minúsculas con `.` → `,` (`emailKey()` en backend.js; las reglas hacen lo mismo con
`auth.token.email.toLowerCase().replace('.', ',')`).

- `status`: `waiting → active → finished` (o `waiting → finished`). Nunca vuelve atrás.
- La configuración del examen es inmutable una vez creado.
- `clientId` es la clave del evento y la regla exige `!data.exists()`: los reenvíos no duplican.
- `ts` = hora del servidor (`ServerValue.TIMESTAMP`, la regla exige `=== now`); `clientTs` = hora
  real del hecho corregida con `.info/serverTimeOffset` (puede llegar tarde si no había red).
- **La incidencia no se guarda**: se calcula al mostrar con `isInfraction()` (common.js): un
  `away_end` con `durationMs >= toleranceMs`, o un `page_leave`.
- `type` y `reason` son códigos independientes del idioma. `reason`: `hidden`, `blur`, `window`,
  `tool:<nombre>`. Se traducen al mostrarlos.

## Permisos de profesor

- Crear exámenes exige estar en `/allowedTeachers` o en `/admins` (reglas de `codes`, `meta` y
  `teachers`). La aprobación es por cuenta y permanente: una sola solicitud, exámenes ilimitados,
  hasta que el admin la retire. Sin permiso se pueden seguir finalizando y borrando los exámenes propios.
- Flujo: el profesor sin permiso pulsa «Solicitar acceso» → el admin aprueba en `/admin/` → la página
  del profesor se desbloquea sola (`watchAccess`).
- Administrador en producción: jfcoroneltoro@gmail.com. Añadir otro:
  `npx firebase database:set "/admins/<correo con , en vez de .>" --data true`.
- En los emuladores, `scripts/seed-emulator.js` crea `admin@example.com` (admin) y
  `profesor@example.com` (autorizado); en la ventana de Google del emulador, «Add new account» y ese correo.

## Eventos

Tipos: `exam_enter`, `away_start`, `away_end`, `fullscreen_exit`, `page_leave`, `disconnected`,
`reconnected`. Solo se aceptan con el examen `active` y del propio alumno.

- `disconnected`: lo escribe el **servidor** con `onDisconnect()`, armado por el alumno al empezar
  el examen y en cada reconexión. `reconnected` lo escribe el alumno al recuperar la conexión.
- `page_leave`: en `pagehide`, `sendBeacon` a la API REST de RTDB (`POST …/events/{uid}.json?auth=<idToken>`).
  El token se guarda en caché porque `sendBeacon` no puede esperar a `getIdToken()`.
- El alumno guarda en localStorage los eventos sin confirmar y los reenvía al recargar.

## Cómo funciona la detección (public/alumno/alumno.js)

Fuente de verdad: sondeo cada 500 ms de `document.visibilityState === 'visible' && document.hasFocus()`.
`blur`, `focus` y `visibilitychange` solo adelantan la comprobación.

Clave: `document.hasFocus()` sigue siendo `true` cuando el foco está dentro de un iframe de la
página, así que **usar la herramienta incrustada no cuenta como salir**. Esto se ha verificado en
Chromium; hay que verificarlo en Firefox y Safari.

Al volver, el alumno **siempre** ve cuánto ha estado fuera: aviso breve que se cierra solo si no
llega a la tolerancia; diálogo rojo si es incidencia. Salir de pantalla completa (modo pestaña)
abre un diálogo ámbar cuyo botón la vuelve a pedir (necesita el clic del alumno). Si coinciden,
se muestra un solo diálogo con las dos cosas.

Modos:
- `pestana` (recomendado): las herramientas se cargan en iframes dentro de la página del examen,
  con pestañas internas. Cualquier salida es detectable.
- `ventana`: las herramientas se abren con `window.open`. La página del examen pierde el foco al
  usarlas y **no hay forma de saber a qué ventana fue el alumno**. Se registra igualmente, con un
  motivo que lo indica. Es una limitación conocida, no un bug.

fproperties.jfcoronel.org y psolver.jfcoronel.org se pueden incrustar (sin `X-Frame-Options` ni
CSP, comprobado el 27/09/2026). Para otras URLs, comprobar con `curl -I <url>`.

## Internacionalización

- El nombre de la app es **Exam Monitor** en todos los idiomas (`app.name`): no se traduce.
- Español (España, tú) e inglés. Cada texto visible pasa por `t('clave', params)` o por atributos
  `data-i18n` / `data-i18n-attr="placeholder:clave;aria-label:clave"` en el HTML.
- Plurales: valor `{ one, other }` y `params.count`. Interpolación con `{nombre}`.
- Al añadir una clave, añadirla en `es.js` **y** `en.js`; `npm test` falla si falta en alguno o si
  el código usa una clave inexistente.
- Al cambiar de idioma se emite `langchange` en `document`; cada página vuelve a pintar lo dinámico.
- Comentarios del código en español.

## Convenciones

- **Versión**: al publicar algo que se vaya a probar, subir la versión en `public/version.js`,
  `package.json` y la `CACHE` de `public/sw.js` (lo comprueba `test/version.test.js`). Semver: 0.x
  hasta la v1.0.
- Pie en todas las páginas (`mountFooter()`): © 2026 Juan F. Coronel · versión · jfcoronel.org. Se
  oculta durante el examen. Icono: `public/icons/icon.svg` (círculos concéntricos, elegido por el autor); los PNG se
  generan a partir del SVG.

- El cliente no es de confianza: toda validación que importe va en `database.rules.json`, con su
  test en `test/rules.test.js`. El cliente valida antes solo para dar mensajes claros.
- Toda cadena que venga del usuario se escapa con `esc()` antes de ir a `innerHTML`.
- Mensajes de error: dicen qué ha pasado y cómo arreglarlo, sin disculpas. `backend.js` lanza
  `BackendError` con un código; la interfaz muestra `t('err.<código>')`.
- Tras cambiar reglas, eventos o `backend.js`: `npm test` y `npm run smoke`, y ampliarlos.
- Chromium headless emula el foco en todas las páginas: en tests de navegador, sobrescribir
  `document.hasFocus`.

## Dirección visual

Hoja de examen cuadriculada: fondo con cuadrícula, tinta azul marino (`--ink`), azul bolígrafo
(`--pen`) como acento. Tipografía Atkinson Hyperlegible (legibilidad bajo presión).
El elemento memorable es el código en casillas, como en una hoja de respuestas.
Rojo solo para incidencias, ámbar para situaciones dudosas (sin conexión, fuera menos de la tolerancia).
