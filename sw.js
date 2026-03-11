/**
 * sw.js — Service Worker para Labdisc Bridge PWA
 * 
 * ¿Por qué necesitamos un Service Worker?
 * 
 * Chrome en Android solo muestra el banner "Agregar a pantalla de inicio"
 * si se cumplen TODAS estas condiciones:
 *   1. Hay un manifest.json válido con name, icons 192+512, start_url, display
 *   2. La página se sirve por HTTPS (o localhost)
 *   3. Hay un Service Worker registrado con un evento fetch
 * 
 * El SW también permite que la app cargue offline (aunque Web Serial y
 * Web Bluetooth requieren conexión física, al menos la interfaz se muestra).
 * 
 * Estrategia de cache:
 *   - INSTALL: precachea todos los archivos del app shell
 *   - FETCH: cache-first para archivos locales, network-first para externos
 *   - ACTIVATE: limpia caches viejas al actualizar la versión
 */

// Cambiá este string cada vez que actualices archivos para forzar
// que el SW baje las versiones nuevas.
const CACHE_VERSION = 'microbit-labdisc-link-v2.0';

// Archivos que forman el "app shell" — todo lo necesario para que
// la interfaz cargue sin red. Estos se descargan en el evento install.
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './src/ui/app.js',
  './src/ui/logger.js',
  './src/bridge/bridge.js',
  './src/bridge/formatter.js',
  './src/labdisc/connection.js',
  './src/labdisc/parser.js',
  './src/labdisc/protocol.js',
  './src/labdisc/sensors.js',
  './src/labdisc/poll-worker.js',
  './src/microbit/ble-uart.js',
];

// ─── INSTALL ───
// Se ejecuta cuando el browser descarga el SW por primera vez
// (o cuando cambia CACHE_VERSION).
// Precachea todos los archivos del app shell.

self.addEventListener('install', (event) => {
  console.log('[SW] Install:', CACHE_VERSION);

  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => {
        console.log('[SW] Caching app shell:', APP_SHELL.length, 'files');
        return cache.addAll(APP_SHELL);
      })
      .then(() => {
        // skipWaiting() hace que el nuevo SW tome control inmediatamente,
        // sin esperar a que el usuario cierre todas las pestañas.
        return self.skipWaiting();
      })
  );
});

// ─── ACTIVATE ───
// Se ejecuta cuando el SW toma control.
// Limpia caches de versiones anteriores.

self.addEventListener('activate', (event) => {
  console.log('[SW] Activate:', CACHE_VERSION);

  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => name !== CACHE_VERSION)
            .map((name) => {
              console.log('[SW] Deleting old cache:', name);
              return caches.delete(name);
            })
        );
      })
      .then(() => {
        // clients.claim() hace que el SW controle las páginas abiertas
        // inmediatamente, sin necesidad de recargar.
        return self.clients.claim();
      })
  );
});

// ─── FETCH ───
// Intercepta todas las requests de la página.
// 
// Estrategia:
//   - Archivos locales: cache-first (busca en cache, si no hay va a red)
//   - Google Fonts/CDN: network-first (intenta red, fallback a cache)
//   - Todo lo demás: network-only (no cachear requests de terceros)

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Solo manejar GET requests
  if (event.request.method !== 'GET') return;

  // Archivos locales (mismo origin): cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request)
        .then((cached) => {
          if (cached) return cached;

          // No está en cache — ir a la red y cachear para la próxima
          return fetch(event.request)
            .then((response) => {
              // Solo cachear respuestas válidas
              if (!response || response.status !== 200) return response;

              const clone = response.clone();
              caches.open(CACHE_VERSION)
                .then((cache) => cache.put(event.request, clone));

              return response;
            });
        })
    );
    return;
  }

  // Google Fonts y CDN: network-first con fallback a cache
  if (url.hostname.includes('googleapis.com') ||
      url.hostname.includes('gstatic.com') ||
      url.hostname.includes('cdnjs.cloudflare.com')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_VERSION)
            .then((cache) => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Todo lo demás: no intervenir, dejar que el browser maneje
});