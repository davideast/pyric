/// <reference lib="webworker" />
import { initializeApp } from 'firebase/app';
import { getMessaging, onBackgroundMessage } from 'firebase/messaging/sw';
import { firebaseConfig } from './firebase-config';

const worker = globalThis as unknown as ServiceWorkerGlobalScope;
const messaging = getMessaging(initializeApp(firebaseConfig));
onBackgroundMessage(messaging, async payload => {
  const data = payload.data;
  if (!data) return;
  const windows = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of windows) client.postMessage({ type: 'orbit-mention', data });
  if (Notification.permission !== 'granted') return;
  await worker.registration.showNotification(data.title, {
    body: data.body,
    tag: payload.messageId,
    data: { channel: data.channel },
  });
});
worker.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const channel = event.notification.data?.channel ?? 'design';
    const link = `/?channel=${encodeURIComponent(channel)}`;
    const existing = windows[0];
    if (!existing) return worker.clients.openWindow(link);
    await existing.navigate(link);
    return existing.focus();
  })());
});
