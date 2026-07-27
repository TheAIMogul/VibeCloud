// VibeCloud service worker.
//
// Two jobs:
//   1. Make the app installable + usable offline (app-shell caching).
//   2. Own the notifications the page asks for. Android Chrome refuses
//      `new Notification()` from a page; notifications MUST come from a
//      ServiceWorkerRegistration, so the page posts here instead.
//
// Never caches API traffic: /proxy, /api/*, and /health carry auth and
// short-lived signed URLs, and a stale hit would be worse than a miss.

const VERSION = 'v1';
const SHELL_CACHE = `vibecloud-shell-${VERSION}`;
const ASSET_CACHE = `vibecloud-assets-${VERSION}`;

const SHELL_URLS = [
  '/',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// Paths the worker must never touch.
const BYPASS = [/^\/proxy/, /^\/api\//, /^\/health/];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // Individual failures shouldn't abort the whole install.
      .then((cache) => Promise.allSettled(SHELL_URLS.map((u) => cache.add(u))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith('vibecloud-') && k !== SHELL_CACHE && k !== ASSET_CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // SoundCloud CDN etc.
  if (BYPASS.some((re) => re.test(url.pathname))) return;

  // Navigations: network-first so a fresh deploy lands immediately instead of
  // being pinned to a stale shell; fall back to cache when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/').then((hit) => hit || Response.error())),
    );
    return;
  }

  // Hashed build output is immutable — cache-first is safe and fast.
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(ASSET_CACHE).then((c) => c.put(request, copy));
            }
            return res;
          }),
      ),
    );
  }
});

// The page asks for notifications through here (see notifyIfHidden in index.tsx).
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (data.type !== 'NOTIFY') return;

  event.waitUntil(
    self.registration.showNotification(data.title || 'VibeCloud', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      tag: data.tag || 'vibecloud-download',
      renotify: Boolean(data.tag),
      silent: false,
      data: { url: '/' },
    }),
  );
});

// Focus the existing window instead of opening a duplicate.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow ? self.clients.openWindow('/') : undefined;
    }),
  );
});
