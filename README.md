# Exam Monitor

PWA para exámenes presenciales en los que los alumnos pueden usar herramientas web concretas
(por ejemplo fProperties o pSolver). El profesor crea el examen, los alumnos se unen con un
código de 6 cifras, y cada vez que un alumno saca el foco de la página del examen se le avisa
y queda registrado en un panel que el profesor ve en directo. Interfaz en español e inglés.

*A PWA for in-person exams where students may only use specific web tools. It detects and logs
when a student leaves the exam page and shows it live on the teacher's dashboard. Spanish and English UI.*

**https://exam-monitor.jfcoronel.org**

## Cómo se usa en clase

1. El profesor entra en `/profesor/` con su cuenta de Google o con su correo y una contraseña (hay que
   verificar el correo con el enlace que llega al crear la cuenta). La primera vez pulsa **Solicitar acceso**
   y espera a que el administrador lo apruebe en `/admin/` (solo una vez). Después crea el examen:
   nombre, duración y herramientas permitidas.
2. Pulsa **Proyectar código**. Los alumnos abren `/alumno/` (o escanean el QR), escriben su nombre y el código.
3. Cuando están todos en la sala de espera, pulsa **Iniciar examen**.
4. Cada alumno pulsa **Entrar al examen** (pasa a pantalla completa y empieza la supervisión).
5. El panel muestra en directo quién está fuera, desde cuándo y el historial de cada alumno.
6. Al terminar, **Finalizar examen** y **Exportar CSV** para guardar el registro. **Borrar examen**
   elimina todos sus datos.

## Arquitectura

- Frontend estático (HTML, CSS y JS sin build) publicado en GitHub Pages.
- Firebase Realtime Database para el tiempo real y Firebase Auth (Google o correo y contraseña para profesores,
  acceso anónimo para alumnos). Las reglas de seguridad (`database.rules.json`) validan todo lo
  que antes hacía un servidor.

## Desarrollo

Requisitos: Node.js 22 o superior y Java 11 o superior (para los emuladores de Firebase).

```bash
npm install
npm run dev          # http://localhost:8080 contra emuladores locales (no toca datos reales)
npm test             # reglas de seguridad e i18n
npm run smoke        # prueba de extremo a extremo (profesor + alumnos simulados)
```

En `npm run dev`, el acceso con Google abre la pantalla del emulador: pulsa *Add new account* y usa
`admin@example.com` (administrador) o `profesor@example.com` (profesor autorizado). También se puede
crear una cuenta con correo y contraseña: el emulador no envía correos; el enlace de verificación
sale en la terminal.

Publicar: cada push a `main` pasa los tests y despliega `public/` en Pages. Las reglas se publican
aparte con `npm run deploy:rules` (requiere `npx firebase login`).

## Usar tu propio proyecto de Firebase

1. Crea un proyecto en Firebase, una Realtime Database (región UE) y activa en Authentication los
   métodos **Google**, **Correo electrónico/contraseña** y **Anónimo**. Añade tu dominio en *Authentication → Configuración → Dominios autorizados*.
2. Sustituye `firebaseConfig` en `public/firebase-config.js` y el proyecto en `.firebaserc`.
3. Hazte administrador: `npx firebase database:set "/admins/<tu correo con , en vez de .>" --data true`.
4. `npm run deploy:rules` y publica `public/` en cualquier hosting estático con HTTPS.

## Protección de datos

La app guarda nombres de alumnos y un registro de su comportamiento durante el examen, en
Firebase (Google, región europe-west1). Antes de usarla con alumnos reales, consulta con el
delegado de protección de datos del centro (RGPD): hay que informar a los alumnos, definir cuánto
tiempo se conservan los registros y quién puede verlos. La pantalla de unión ya avisa de que la
página registra las salidas, y el profesor puede borrar cada examen con todos sus datos.
