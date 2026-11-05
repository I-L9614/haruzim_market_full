// Minimal service worker so the manager page is installable as a home-screen app.
// It caches nothing: every request still goes straight to the network.
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', () => {});
