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

## Check the supported boundary

Per-feature support is tracked on the [Cloud Messaging conformance page](../_generated/messaging-compat.md).
