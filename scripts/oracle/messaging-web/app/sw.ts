/**
 * Background capture + demo service worker. Real firebase/messaging/sw:
 * onBackgroundMessage payloads are reported to the harness over
 * POST /capture, shown as a real OS notification (registering an
 * onBackgroundMessage handler disables the SDK's automatic display, so
 * showNotification is on us), and forwarded to any open page for its log.
 * __CONFIG__ is injected at build time.
 */
import { initializeApp } from 'firebase/app';
import { getMessaging, onBackgroundMessage } from 'firebase/messaging/sw';

declare const __CONFIG__: Record<string, string>;
declare const __BUILD__: string;
declare const self: ServiceWorkerGlobalScope;

// __BUILD__ is a per-run id injected by the harness: it forces the SW bytes
// to differ every run, so the browser installs+activates a FRESH worker each
// time and the activate handler below actually fires (clearing any stale OS
// notifications so the data-only auto-display probe starts from zero).
const BUILD_ID = __BUILD__;

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      const existing = await self.registration.getNotifications();
      for (const n of existing) n.close();
    })(),
  );
});

const app = initializeApp(__CONFIG__);

onBackgroundMessage(getMessaging(app), (payload) => {
  const hasNotification = !!payload.notification;

  // Report AFTER settling display, carrying meta the driver needs:
  //   hasNotification          did the message carry a notification field
  //   notificationsAfterHandler count of notifications live on THIS
  //                            registration once the handler settles — for a
  //                            DATA-ONLY message we deliberately display
  //                            nothing, so a non-zero count would mean the
  //                            SDK auto-displayed (it does not).
  const report = (notificationsAfterHandler: number, tags: (string | undefined)[]) => {
    void fetch('/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'onBackgroundMessage',
        data: { payload, meta: { hasNotification, notificationsAfterHandler, notificationTags: tags, buildId: BUILD_ID } },
      }),
    });
    void self.clients.matchAll({ type: 'window' }).then((clients) => {
      for (const c of clients) c.postMessage({ kind: 'bg-delivered', payload });
    });
  };

  const settled = hasNotification
    ? self.registration
        .showNotification(payload.notification?.title ?? 'pyric oracle', {
          body: payload.notification?.body ?? 'background message',
          tag: 'pyric-messaging-demo',
        })
        .then(() => self.registration.getNotifications())
    : // DATA-ONLY: show nothing so any auto-display would be the SDK/browser.
      self.registration.getNotifications();

  void settled.then((ns) => report(ns.length, ns.map((n) => n.tag)));
});
