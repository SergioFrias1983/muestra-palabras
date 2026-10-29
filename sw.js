const CACHE = 'muestra-palabras-v2';
const ARCHIVOS = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Responde desde la caché (funciona sin internet) y actualiza en segundo plano.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async c => {
      const guardado = await c.match(e.request, { ignoreSearch: true });
      const red = fetch(e.request)
        .then(r => { if (r && r.ok) c.put(e.request, r.clone()); return r; })
        .catch(() => guardado);
      return guardado || red;
    })
  );
});
