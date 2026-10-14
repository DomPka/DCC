// Service worker: offline app shell, cached model/runtime files, and the
// cross-origin isolation headers (COOP/COEP) that GitHub Pages cannot send itself.
// Isolation unlocks SharedArrayBuffer, so the CPU (WASM) detector can use several threads.
// On the first visit the page reloads itself once so these headers take effect.
// Bump VERSION whenever app files change, so installed copies update.

const VERSION = '2.3.0';
const SHELL_CACHE = `cc-shell-${VERSION}`;
const ASSET_CACHE = 'cc-assets-v1'; // models + ONNX Runtime; large, kept across app versions

const SHELL = [
  './',
  'index.html',
  'analytics.html',
  'station.html',
  'manifest.webmanifest',
  'css/app.css',
  'css/analytics.css',
  'js/app.js',
  'js/analytics.js',
  'js/analytics-view.js',
  'js/charts.js',
  'js/sessions.js',
  'js/station-page.js',
  'js/core/countdata.js',
  'js/detector.js',
  'js/detector.worker.js',
  'js/overlay.js',
  'js/runner.js',
  'js/core/counter.js',
  'js/core/csv.js',
  'js/core/hungarian.js',
  'js/core/kalman.js',
  'js/core/mp4time.js',
  'js/core/onnxmeta.js',
  'js/core/postprocess.js',
  'js/core/tracker.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'fonts/overpass-latin-400-normal.woff2',
  'fonts/overpass-latin-700-normal.woff2',
  'fonts/overpass-latin-800-normal.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // bypass the browser's HTTP cache, or an update could store the previous files again
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('cc-shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

  const path = url.pathname;
  if (/\/(api|data)\//.test(path)) return; // live station data: always from the network
  if (/\/(models|vendor)\//.test(path)) {
    event.respondWith(cacheFirst(req, ASSET_CACHE));
  } else if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req));
  } else {
    event.respondWith(staleWhileRevalidate(req));
  }
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return isolate(hit);
  const res = await fetch(req);
  if (res.ok && res.status === 200) cache.put(req, res.clone()).catch(() => {});
  return isolate(res);
}

async function networkFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone()).catch(() => {});
    return isolate(res);
  } catch {
    const hit = (await cache.match(req, { ignoreSearch: true })) || (await cache.match('./'));
    if (hit) return isolate(hit);
    return new Response('Offline and this page is not cached yet.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  const network = fetch(req)
    .then((res) => {
      if (res.ok && res.status === 200) cache.put(req, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => null);
  if (hit) {
    network.catch(() => {});
    return isolate(hit);
  }
  const res = await network;
  return res ? isolate(res) : new Response('', { status: 504 });
}

function isolate(res) {
  if (!res || res.status === 0 || res.type === 'opaque') return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
