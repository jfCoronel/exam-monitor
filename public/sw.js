// Service worker mínimo: hace la PWA instalable y permite abrirla aunque la red falle un momento.
// Estrategia: red primero, caché como respaldo. Firebase (otro origen) nunca pasa por aquí.
// Rutas relativas a este fichero, para funcionar igual en un dominio propio o en un subdirectorio.
const CACHE = 'exam-monitor-v0.4.0'; // cambia con cada versión (public/version.js)
const SHELL = [
  './alumno/', './alumno/alumno.js', './alumno/alumno.css',
  './common.js', './version.js', './backend.js', './firebase-config.js', './styles.css', './manifest.webmanifest',
  './i18n/index.js', './i18n/es.js', './i18n/en.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
