/* ============================================================
   Recruit Pro — Service Worker
   Handles web push notifications
   ============================================================ */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

self.addEventListener('push', function (event) {
  if (!event.data) return;
  let data = {};
  try { data = event.data.json(); } catch (_) { data = { title: 'Recruit Pro', body: event.data.text() }; }

  const options = {
    body: data.body || '',
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    tag: data.tag || 'recruit-pro',
    renotify: true,
    data: { url: data.url || '/dashboard' }
  };

  event.waitUntil(self.registration.showNotification(data.title || 'Recruit Pro', options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/dashboard';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (const c of list) {
        if (c.url.includes('/dashboard') && 'focus' in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
