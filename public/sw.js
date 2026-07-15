// sw.js - Service worker for Trade Track push notifications.
// This file runs in the background even when the app isn't open.

self.addEventListener('push', function (event) {
  var data = { title: 'Trade Track', body: 'You have a new alert.' };
  try {
    data = event.data.json();
  } catch (e) {}

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/logo.svg',
      badge: '/logo.svg',
      tag: 'trade-track-alert',
      renotify: true,
      data: { url: '/watchlist.html' },
    })
  );
});

// When the user clicks the notification, open or focus the app.
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
