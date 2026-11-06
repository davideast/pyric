// The alerts app's module service worker. In the browser it hands each
// background message to the app's handler, which keeps the last one in the
// Cache API for the page to show. The same file runs in Node under
// `node --import @pyric/live/register sw.js`, as a shared init module would:
// there Messaging is not supported, so it only loads both Messaging entries.
import { initializeApp } from "firebase/app";
import { getMessaging, onBackgroundMessage } from "firebase/messaging/sw";

const PROJECT = "demo-live-messaging";
const SENDER_ID = "1234567890";
const config = { apiKey: "replay-api-key", projectId: PROJECT, messagingSenderId: SENDER_ID, appId: `1:${SENDER_ID}:web:alerts` };
const isServiceWorker = typeof ServiceWorkerGlobalScope === "function" && self instanceof ServiceWorkerGlobalScope;

if (isServiceWorker) {
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
  const messaging = getMessaging(initializeApp(config));
  onBackgroundMessage(messaging, async (payload) => {
    const cache = await caches.open("alerts");
    await cache.put("/last-background-message", new Response(JSON.stringify(payload)));
  });
} else {
  // A service worker may not import dynamically; Node may, and loads the page's entry too.
  import("firebase/messaging").then(
    () => console.log("LOADED firebase/messaging and firebase/messaging/sw"),
    (error) => {
      console.log(`FAILED ${error.code ?? ""} ${error.message}`);
      process.exitCode = 1;
    },
  );
}
