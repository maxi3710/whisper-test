// Service Worker: setzt die zwei Kopfzeilen, die der Browser für "mehrere Rechenkerne" (SharedArrayBuffer) verlangt.
// Warum: GitHub Pages kann diese Kopfzeilen nicht selbst senden. Dieser Worker fügt sie bei jeder Antwort hinzu.
// Ohne sie rechnet die Spracherkennung nur mit einem Kern und ist deutlich langsamer.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (ereignis) => ereignis.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (ereignis) => {
  const anfrage = ereignis.request;
  // Dieser Sonderfall führt sonst in manchen Browsern zu einem Fehler
  if (anfrage.cache === 'only-if-cached' && anfrage.mode !== 'same-origin') return;

  ereignis.respondWith(
    fetch(anfrage).then((antwort) => {
      if (antwort.status === 0) return antwort;   // "opaque" Antworten lassen sich nicht ändern
      const kopf = new Headers(antwort.headers);
      kopf.set('Cross-Origin-Embedder-Policy', 'require-corp');
      kopf.set('Cross-Origin-Opener-Policy', 'same-origin');
      return new Response(antwort.body, { status: antwort.status, statusText: antwort.statusText, headers: kopf });
    })
  );
});
