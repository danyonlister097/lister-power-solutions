// Minimal service worker — network-first, no offline caching.
// Required for PWA installability on Android Chrome.
self.addEventListener('fetch', function (event) {
  event.respondWith(fetch(event.request));
});
