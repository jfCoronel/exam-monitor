# Foco Examen

PWA para exámenes presenciales en los que los alumnos pueden usar herramientas web concretas
(por ejemplo fProperties o pSolver). El profesor crea el examen, los alumnos se unen con un
código de 6 cifras, y cada vez que un alumno saca el foco de la página del examen se le avisa
y queda registrado en un panel que el profesor ve en directo.

## Puesta en marcha

Requisitos: Node.js 20 o superior.

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # igual, reiniciando al cambiar el código
npm run smoke      # test de extremo a extremo (profesor + alumno simulados)
```

- Profesor: `http://localhost:3000/profesor/`
- Alumnos: `http://localhost:3000/alumno/` (o escaneando el QR del panel)

Variables de entorno: `PORT` (3000), `DB_FILE` (`data/exam-monitor.db`), `EXPORT_TZ` (`Europe/Madrid`).

## Cómo se usa en clase

1. El profesor crea el examen: nombre, duración, herramientas permitidas y modo.
2. Pulsa **Proyectar código**. Los alumnos abren `/alumno`, escriben su nombre y el código.
3. Cuando están todos en la sala de espera, pulsa **Iniciar examen**.
4. Cada alumno pulsa **Entrar al examen** (pasa a pantalla completa y empieza la supervisión).
5. El panel muestra en directo quién está fuera, desde cuándo y el historial de cada alumno.
6. Al terminar, **Finalizar examen** y **Exportar CSV** para guardar el registro.

## Despliegue: importante

Para que la PWA sea **instalable** y el service worker funcione, el servidor debe servirse por
**HTTPS** (o `localhost`). Si el profesor sirve la app desde su portátil por `http://192.168.x.x`,
la supervisión funciona igual, pero no se podrá instalar como app.

Opciones sencillas: un servicio con HTTPS incluido (Render, Railway, Fly.io…) o un túnel
(Cloudflare Tunnel, ngrok). Hace falta que el servicio soporte WebSockets y disco persistente
para el fichero SQLite.

## Protección de datos

La app guarda nombres de alumnos y un registro de su comportamiento durante el examen.
Antes de usarla con alumnos reales, consulta con el delegado de protección de datos del centro
(RGPD): hay que informar a los alumnos, definir cuánto tiempo se conservan los registros y
quién puede verlos. La pantalla de unión ya avisa de que la página registra las salidas.
