---
title: "Receive Firebase Cloud Messaging locally"
navLabel: "Cloud Messaging"
group: "Build"
section: ""
order: 50
description: "Keep Firebase Cloud Messaging receive code unchanged while tokens and deliveries stay in the local sandbox."
---

# Receive Firebase Cloud Messaging locally

Keep using the Firebase Cloud Messaging Web API:
```ts
import { getMessaging, getToken, onMessage } from 'firebase/messaging';

const messaging = getMessaging(app);
const token = await getToken(messaging);

onMessage(messaging, payload => {
  console.log(payload.data);
});
```
During development, the token and message broker belong to the local sandbox. No registration reaches Firebase Cloud Messaging. A production build runs the same application code through Firebase.

## Deliver a local message

Tests and development harnesses can inject a message through Pyric's sandbox-only driver:
```ts
import { getMessaging, onMessage, sandbox as messagingSandbox } from 'pyric/messaging';

const messaging = getMessaging(app);
onMessage(messaging, payload => {
  console.log(payload.data);
});

await messagingSandbox.deliver(messaging, {
  visibilityState: 'visible',
  data: { event: 'report-ready' },
});
```
Keep this driver outside application code that ships. A visible client routes the delivery to `onMessage`; a hidden client routes it to the service-worker `onBackgroundMessage` path. The local broker does not request notification permission or contact FCM.

## Show an OS notification in the background

Run `onBackgroundMessage` in a real service worker when it needs to display a
native notification. Registering the callback in page code can model hidden-tab
routing while that page remains open, but it has no service-worker display or
closed-page lifetime.

For a Vite app, keep the worker in the source graph so the `pyric()` plugin can
swap its unchanged Firebase imports during development. Vite's worker URL import
also bundles the same source against the real Firebase SDK for production:

```ts
// src/firebase-messaging-sw.ts
import { initializeApp } from 'firebase/app';
import { getMessaging, onBackgroundMessage } from 'firebase/messaging/sw';
import { firebaseConfig } from './firebase-config';

const app = initializeApp(firebaseConfig);

onBackgroundMessage(getMessaging(app), async (payload) => {
  if (!payload.notification) return;
  await self.registration.showNotification(
    payload.notification.title ?? 'New notification',
    {
      body: payload.notification.body,
      tag: payload.messageId,
    },
  );
});
```

Register that worker from the page and pass the registration to `getToken`:

```ts
import messagingWorkerUrl from './firebase-messaging-sw.ts?worker&url';
import { getMessaging, getToken } from 'firebase/messaging';

const registration = await navigator.serviceWorker.register(
  messagingWorkerUrl,
  { type: 'module' },
);

const token = await getToken(getMessaging(app), {
  serviceWorkerRegistration: registration,
});
```

Request notification permission from a user gesture before registering for a
token. Firebase suppresses automatic display when `onBackgroundMessage` is
registered, so the handler owns `showNotification`. Data-only messages have no
notification to display unless the application deliberately creates one.

Pyric's local broker can deliver to this real worker while a page keeps the
sandbox alive. Delivery after every page closes is not currently modeled.

## Check the supported boundary

Per-feature support is tracked on the [Cloud Messaging conformance page](messaging-compat.md).
