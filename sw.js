// Subway Duo — service worker.
// Page et code : réseau d'abord (toujours la dernière version), le cache sert hors ligne.
// Gros fichiers qui ne changent pas (modèle de pose ~6 Mo, moteur wasm ~9 Mo, modèles 3D, Three.js) :
// cache d'abord, pour que l'appli démarre vite sur le téléphone après la première fois.
const VERSION = 'subway-duo-17';
const LOURD = 'subway-duo-lourd-1'; // à changer seulement si un fichier de vendor/ ou assets/ change

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== VERSION && k !== LOURD).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  if (/\/(vendor|assets|icones|fonts)\//.test(u.pathname)) {
    e.respondWith(
      caches.open(LOURD).then((c) =>
        c.match(e.request).then(
          (r) => r || fetch(e.request).then((n) => (n.ok && c.put(e.request, n.clone()), n)),
        ),
      ),
    );
    return;
  }
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((r) => {
        if (r.ok) {
          const copy = r.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return r;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: false }).then((r) => r || caches.match('./'))),
  );
});
