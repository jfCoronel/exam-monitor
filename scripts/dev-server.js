// Servidor estático mínimo para desarrollo: sirve public/ como lo haría GitHub Pages.
// `npm run dev` lo arranca junto a los emuladores; en localhost la app usa los emuladores.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('../public/', import.meta.url).pathname;
const PORT = Number(process.env.PORT) || 8080;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(ROOT, path);
  try {
    if ((await stat(file)).isDirectory()) {
      if (!req.url.split('?')[0].endsWith('/')) { res.writeHead(301, { Location: `${path}/` }).end(); return; }
      file = join(file, 'index.html');
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('No encontrado');
  }
}).listen(PORT, () => {
  console.log(`\nFoco Examen en desarrollo (emuladores): http://localhost:${PORT}/`);
  console.log(`  Alumnos:  http://localhost:${PORT}/alumno/`);
  console.log(`  Profesor: http://localhost:${PORT}/profesor/\n`);
});
