# Plan de desarrollo hasta la v1.0

Objetivo: una primera versión **operativa** que se distribuya desde GitHub Pages, sin servidor
propio que mantener.

**Definición de "operativa"**: un profesor entra con su cuenta de Google en la URL de Pages, crea
un examen con fProperties y pSolver, proyecta el código, 30–60 alumnos se unen desde la wifi del
aula (eduroam), se supervisa un examen de 2 h, las incidencias aparecen en el panel en menos de
2 s, se exporta el CSV y los datos del examen se pueden borrar. Todo ello comprobado en una
prueba piloto real.

## Decisiones tomadas

| Tema | Decisión | Motivo |
|---|---|---|
| Alojamiento del frontend | GitHub Pages, repo público `jfCoronel/exam-monitor` | Gratis, sin mantenimiento, HTTPS incluido (PWA instalable). |
| Tiempo real y datos | **Firebase Realtime Database**, región `europe-west1` | Pages no ejecuta Node. RTDB tiene plan gratuito sin pausas, `onDisconnect()` resuelve la presencia y las reglas de seguridad sustituyen la validación del servidor. |
| Autenticación | Alumno: Firebase Anonymous Auth. Profesor: Google Sign-In | El token anónimo persiste en IndexedDB igual que hoy en localStorage. Resuelve el pendiente de cuentas de profesor. |
| Sin build | SDK de Firebase como módulos ES desde `www.gstatic.com/firebasejs/<versión>/…` | Se mantiene HTML + JS vanilla sin empaquetador. |
| Servidor Node | Se conserva en la etiqueta `v0.1.0-node` y se elimina de `main` al terminar la fase 2 | Un solo camino de despliegue. |
| Dominio | Recomendado: `examen.jfcoronel.org` (CNAME a Pages) | Mismo *site* que `fproperties.jfcoronel.org` y `psolver.jfcoronel.org`: los iframes no son de terceros y no sufren el particionado de almacenamiento de Safari/Chrome. |

### Hechos ya comprobados (27/09/2026)

- `fproperties.jfcoronel.org` y `psolver.jfcoronel.org` se sirven desde GitHub Pages **sin**
  `X-Frame-Options` ni `Content-Security-Policy`: se pueden incrustar en iframe. (Pendiente nº 1
  de CLAUDE.md, resuelto para estas dos herramientas.)
- El smoke test del servidor Node pasa 17/17.

### Límites de Firebase a tener en cuenta

- **Plan Spark (gratis): 100 conexiones simultáneas por base de datos.** Suficiente para un aula
  (alumnos + profesor), no para varios exámenes grandes a la vez. Si se supera, pasar a Blaze
  (pago por uso; para este volumen el coste es de céntimos) o una base de datos por asignatura.
- Sin Cloud Functions en Spark: todo lo "de servidor" se hace con reglas de seguridad o en el
  cliente del profesor (que es de confianza).

## Modelo de datos en RTDB

```
/codes/{code}                      { examId, ownerUid }            solo exámenes no finalizados
/exams/{examId}/meta               { name, durationMin, mode, tools, toleranceMs, alertText,
                                     status, code, ownerUid, createdAt, startedAt, endedAt }
/exams/{examId}/students/{uid}     { name, joinedAt }
/exams/{examId}/presence/{uid}     { online, changedAt }            con onDisconnect()
/exams/{examId}/events/{uid}/{clientId}
                                   { type, ts: SERVER_TIMESTAMP, clientTs, durationMs?, reason? }
/teachers/{uid}/exams/{examId}     { name, code, createdAt }
```

Equivalencias con el protocolo actual:

| Hoy (Node) | Con RTDB |
|---|---|
| `UNIQUE(student_id, client_id)` | `clientId` es la clave del evento; regla `!data.exists()` (escritura única). |
| `ts` hora del servidor | `ServerValue.TIMESTAMP`, validado con `newData.child('ts').val() === now`. |
| `serverNow` para el reloj | `.info/serverTimeOffset`. |
| Solo eventos con examen `active` | Regla que lee `meta/status`. |
| `infraction` calculado en el servidor | Se calcula en el panel del profesor a partir de los datos guardados. Mejor aún: la duración se obtiene de los `ts` de servidor de `away_start`/`away_end`, no del `durationMs` que manda el alumno. |
| `disconnected` / `reconnected` | `onDisconnect()` escribe presencia y un evento `disconnected` con clave preasignada; al reconectar, el alumno escribe `reconnected`. |
| `page_leave` por `sendBeacon` | `onDisconnect()` cubre el cierre. Probar además `sendBeacon` a la API REST de RTDB (`POST …/events/{uid}.json?auth=<idToken>`). |
| Unicidad del código | Transacción sobre `/codes/{code}`. |
| CSV en el servidor | Se genera en el navegador del profesor (Blob + descarga). |

## Fases

### Fase 0 — Repositorio (hecha)

- [x] Repo público `jfCoronel/exam-monitor`, rama `main`, etiqueta `v0.1.0-node`.
- [x] Verificado que las herramientas se pueden incrustar.

### Fase 1 — Proyecto Firebase y reglas de seguridad

Cuenta de Firebase: **jfcoroneltoro@gmail.com**. Requisitos locales que faltan: Firebase CLI
(`npm i -g firebase-tools`, luego `firebase login` con esa cuenta, que es interactivo) y Java ≥ 11
para el emulador (`brew install openjdk`).

Trabajo manual en la consola de Firebase (15 min):
crear proyecto, RTDB en `europe-west1`, activar Anonymous y Google en Authentication, añadir el
dominio de Pages a los dominios autorizados.

- [ ] `firebase.json`, `database.rules.json` y `public/firebase-config.js` (la config web es
      pública; la seguridad está en las reglas).
- [ ] Reglas: el alumno solo escribe en sus propios nodos; tipos de evento válidos; `ts` = hora del
      servidor; eventos solo con el examen `active`; solo el propietario cambia `status`;
      `/codes` se lee por clave pero no se puede listar.
- [ ] Opcional: restringir la creación de exámenes a correos `@us.es` desde las reglas.
- [ ] Tests de reglas con el emulador (`@firebase/rules-unit-testing`, requiere Java) que cubran
      los mismos casos que hoy el smoke test. `npm test`.

**Hecho cuando**: los tests de reglas pasan y cubren cada regla de la sección "Reglas" de
CLAUDE.md.

### Fase 2 — Migrar el frontend y publicar en Pages

- [ ] `public/backend.js`: única capa que habla con Firebase (crear examen, unirse, sesión,
      suscripciones, enviar evento, iniciar/finalizar). El resto del código no importa Firebase.
- [ ] Alumno: unirse, sala de espera, examen y monitor de foco sobre `backend.js`. Mantener la cola
      en localStorage solo para sobrevivir a recargas (RTDB ya encola escrituras sin conexión en
      memoria).
- [ ] Profesor: inicio de sesión con Google, lista "mis exámenes" desde `/teachers/{uid}`, panel en
      vivo, CSV en el cliente.
- [ ] **Rutas relativas** en todo: hoy hay rutas absolutas (`/common.js`, `/profesor/…`, `sw.js`,
      `start_url` y `scope` del manifest) que se rompen bajo `jfcoronel.github.io/exam-monitor/`.
- [ ] Service worker: versión de caché ligada a la versión de la app; no cachear peticiones a
      Firebase.
- [ ] Workflow de GitHub Actions que publica `public/` en Pages (y, si se quiere, despliega reglas
      con `firebase deploy --only database`).
- [ ] Reescribir `scripts/smoke-test.js` contra el emulador. Eliminar `server/` y las dependencias
      de Node del runtime.
- [ ] Actualizar README y CLAUDE.md (stack, protocolo, despliegue).

**Hecho cuando**: el flujo completo (crear → unirse → iniciar → salir y volver → finalizar →
CSV) funciona en la URL de Pages con dos navegadores reales.

### Fase 3 — Robustez durante el examen

- [ ] **Fin automático** al agotarse el tiempo: el alumno deja de supervisar en local al llegar a
      `startedAt + duración`; el panel del profesor marca el examen como `finished`.
- [ ] **Iframe bloqueado**: si una herramienta no carga (tiempo de espera o `X-Frame-Options`),
      mostrar al alumno qué pasa y ofrecer abrirla en ventana. Útil para URLs que no sean las tuyas.
- [ ] Recarga durante el examen: volver directamente a la vista de examen (hoy hay que pulsar
      "Entrar" otra vez y hay un hueco sin supervisión).
- [ ] Alumno que se une dos veces (otro navegador, almacenamiento borrado): avisar en el panel de
      nombres duplicados.
- [ ] Panel: actualizaciones por nodo en lugar de re-renderizar cada segundo (accesibilidad,
      pendiente nº 7).

### Fase 4 — Verificación en navegadores y piloto

- [ ] Comprobar en **Firefox y Safari** (macOS e iPadOS) que `document.hasFocus()` sigue siendo
      `true` con el foco dentro del iframe. Si falla en alguno, documentarlo y decidir si se admite.
- [ ] Tests de navegador con Playwright contra el emulador (sobrescribir `document.hasFocus`, que
      Chromium headless emula siempre como `true`).
- [ ] Prueba de carga: 60 clientes simulados conectados a la vez durante 2 h.
- [ ] **Piloto** con 5–10 personas en un aula real con eduroam, con fProperties y pSolver.
      Anotar falsos positivos (notificaciones del sistema, cambio de wifi, suspensión del portátil).

### Fase 5 — Publicación v1.0

- [ ] Texto informativo RGPD en la pantalla de unión y en el README, revisado con el DPD de la US.
      Firebase (Google) actúa como encargado del tratamiento, datos en la UE.
- [ ] Borrado de datos: botón "Borrar examen" en el panel y borrado automático de exámenes de más
      de N días al abrir el panel (no hay tareas programadas en el plan Spark).
- [ ] Guía de despliegue para otro profesor o centro (crear su propio proyecto Firebase y pegar la
      config).
- [ ] Etiqueta `v1.0.0` y release en GitHub.

## Después de la v1.0

- Extensión de navegador (Manifest V3) para que el modo ventana sepa en qué pestaña está el alumno
  (pendiente nº 3).
- Varios profesores supervisando el mismo examen.
- Firebase App Check para limitar abusos de `/codes` y de la unión a exámenes (pendiente nº 8).
- Modo oscuro (pendiente nº 9).
