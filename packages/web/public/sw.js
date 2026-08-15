/**
 * Hive service worker.
 *
 * Its whole job is notification delivery and click routing. There is no fetch
 * handler and no cache on purpose: the dashboard is a live view of a running
 * fleet, and a cached shell showing yesterday's agents is worse than a page
 * that fails to load. Registering one is nonetheless required — it is the only
 * path notifications take on Android Chrome, and on iOS it is the only path
 * at all, and only once the app is installed to the home screen.
 */

self.addEventListener('install', () => {
  // Take over immediately rather than waiting for every tab to close; there is
  // no cached state for a new version to be inconsistent with.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/**
 * Focus the dashboard on click and tell it which channel the notification came
 * from, so tapping a mention lands in that conversation instead of wherever the
 * operator last was.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const channelId = event.notification.data && event.notification.data.channelId;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.postMessage({ type: 'hive:open-channel', channelId });
          return client.focus();
        }
      }
      return self.clients.openWindow(channelId ? `/?channel=${channelId}` : '/');
    }),
  );
});

/**
 * Web Push, for a deployment that wires it up server-side. Harmless when
 * nothing ever pushes; the payload shape matches what notify.ts sends locally.
 */
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'Hive', body: event.data.text() };
  }
  event.waitUntil(
    self.registration.showNotification(payload.title || 'Hive', {
      body: payload.body || '',
      tag: payload.tag || 'hive',
      data: { channelId: payload.channelId || null },
      icon: '/icon-192.png',
      badge: '/icon-192.png',
    }),
  );
});
