// Minimal service worker — network-first, no offline caching.
// Required for PWA installability on Android Chrome.
self.addEventListener('fetch', function (event) {
  event.respondWith(fetch(event.request));
});

// Web Push: the server sends a JSON payload ({ title, body, url, tag }) -
// see src/lib/push.js. `tag` lets a second push for the same thing (e.g.
// the same chat channel) replace the earlier notification instead of
// stacking a new one.
self.addEventListener('push', function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Lister Power Solutions', body: event.data ? event.data.text() : '' };
  }

  var title = data.title || 'Lister Power Solutions';
  var options = {
    body: data.body || '',
    icon: '/img/icon-192.png',
    badge: '/img/icon-192.png',
    tag: data.tag,
    data: { url: data.url || '/' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Focus an already-open tab on this app if one exists, otherwise open a new
// one - either way, land on whatever page the notification is about.
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (windowClients) {
      for (var i = 0; i < windowClients.length; i++) {
        var client = windowClients[i];
        if (client.url.indexOf(url) !== -1 && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
