// Service worker: офлайн-кэш + приём push-уведомлений (Firebase Cloud Messaging)
importScripts('firebase-config.js');
importScripts(
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js'
);

const CACHE = 'sklad-v1';
const ASSETS = [
  './', 'index.html', 'styles.css', 'app.js', 'firebase-config.js', 'manifest.json',
  'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Свои файлы: сначала сеть (чтобы обновления приходили сразу), без сети — из кэша
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
    );
    return;
  }

  // Библиотеки Firebase с gstatic: из кэша, чтобы приложение открывалось офлайн
  if (url.hostname === 'www.gstatic.com') {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }))
    );
  }
});

// ---- Push ----
try {
  const cfg = self.FIREBASE_CONFIG || {};
  if (cfg.apiKey && !cfg.apiKey.startsWith('ВСТАВЬТЕ')) {
    firebase.initializeApp(cfg);
    firebase.messaging().onBackgroundMessage((payload) => {
      const d = payload.data || {};
      return self.registration.showNotification(d.title || 'Склад', {
        body: d.body || '',
        icon: 'icons/icon-192.png',
        badge: 'icons/icon-192.png',
        tag: d.tag || undefined,
        data: { url: './' },
      });
    });
  }
} catch (err) {
  console.warn('FCM', err);
}

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) if ('focus' in c) return c.focus();
      return self.clients.openWindow(e.notification.data?.url || './');
    })
  );
});
