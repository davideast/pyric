// The canary's service worker. On a message it fetches the URL it was sent,
// from the worker, and answers with the outcome. A request a service worker
// makes never reaches `context.route`; the harness NetLog must still see it.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("message", (event) => {
  const reply = (outcome) => event.source.postMessage({ url: event.data.url, outcome });
  event.waitUntil(
    fetch(event.data.url).then(
      () => reply("succeeded"),
      (error) => reply(`failed: ${error.message}`),
    ),
  );
});
