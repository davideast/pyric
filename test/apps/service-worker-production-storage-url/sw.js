import { sandboxStorageFetch } from "pyric/storage/sw";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  if (import.meta.env.DEV && sandboxStorageFetch(event)) return;
});
