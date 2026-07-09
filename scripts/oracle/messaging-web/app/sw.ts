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
declare const self: ServiceWorkerGlobalScope;

const app = initializeApp(__CONFIG__);

onBackgroundMessage(getMessaging(app), (payload) => {
  void fetch('/capture', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'onBackgroundMessage', data: payload }),
  });
  void self.registration.showNotification(payload.notification?.title ?? 'pyric oracle', {
    body: payload.notification?.body ?? 'background message',
    tag: 'pyric-messaging-demo',
  });
  void self.clients.matchAll({ type: 'window' }).then((clients) => {
    for (const c of clients) c.postMessage({ kind: 'bg-delivered', payload });
  });
});
