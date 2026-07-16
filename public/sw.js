// sw.js - Service worker for Trade Track
// Handles push notifications and basic offline caching.

var CACHE_NAME = 'tradetrack-v1';
var OFFLINE_URLS = ['/', '/watchlist.html', '/articles.html', '/sectors.html', '/settings.html', '/auth.js', '/chat.js', '/logo.svg', '/logo-192.png'];

// Cache key pages on install so the app shell loads even offline
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(OFFLINE_URLS);
    })
  );
  self.skipWaiting();
});

// Clean up old caches on activate
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names.filter(function (n) { return n !== CACHE_NAME; })
          .map(function (n) { return caches.delete(n); })
      );
    })
  );
  self.clients.claim();
});

// Network-first strategy: try the network, fall back to cache.
// API calls are never cached (they need live data).
self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);

  // Skip caching for API calls and non-GET requests
  if (url.pathname.startsWith('/api/') || event.request.method !== 'GET') {
    return;
  }

  event.respondWith(
    fetch(event.request).then(function (response) {
      // Cache the fresh response for next time
      var copy = response.clone();
      caches.open(CACHE_NAME).then(function (cache) {
        cache.put(event.request, copy);
      });
      return response;
    }).catch(function () {
      // Network failed, try cache
      return caches.match(event.request);
    })
  );
});

// Push notification handler
self.addEventListener('push', function (event) {
  var data = { title: 'Trade Track', body: 'You have a new alert.' };
  try {
    data = event.data.json();
  } catch (e) {}

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/logo-192.png',
      badge: '/logo-192.png',
      tag: 'trade-track-alert',
      renotify: true,
      data: { url: '/watchlist.html' },
    })
  );
});

// Open app when notification is clicked
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = event.notification.data && event.notification.data.url
    ? event.notification.data.url
    : '/watchlist.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (windowClients) {
      for (var i = 0; i < windowClients.length; i++) {
        var client = windowClients[i];
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
