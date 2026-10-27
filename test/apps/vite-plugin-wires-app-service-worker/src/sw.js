// The app's own service worker. It has no Pyric import: in dev, the Pyric
// Vite plugin's serviceWorker option adds the sandbox Storage listener.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
