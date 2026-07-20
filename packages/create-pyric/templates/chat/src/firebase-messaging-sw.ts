/// <reference lib="webworker" />

import { initializeApp } from 'firebase/app';
import { getMessaging, onBackgroundMessage } from 'firebase/messaging/sw';
import { firebaseConfig } from './firebase/config';

const worker = globalThis as unknown as ServiceWorkerGlobalScope;
const messaging = getMessaging(initializeApp(firebaseConfig));

onBackgroundMessage(messaging, async (payload) => {
  if (!payload.notification) return;
  await worker.registration.showNotification(
    payload.notification.title ?? 'PyChat',
    {
      body: payload.notification.body,
      icon: payload.notification.icon,
      tag: payload.messageId,
      data: { link: payload.fcmOptions?.link ?? '/' },
    },
  );
});

worker.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await worker.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });
    const existing = windows[0];
    if (existing) return existing.focus();
    const link = (event.notification.data as { link?: string } | undefined)?.link ?? '/';
    return worker.clients.openWindow(link);
  })());
});
