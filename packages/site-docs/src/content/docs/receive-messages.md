---
title: "Receive Firebase Cloud Messaging locally"
navLabel: "Receive messages"
group: "Build"
section: ""
order: 2005
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

<<<<<<< HEAD
During development, the token and message broker belong to the local sandbox. No registration reaches Firebase Cloud Messaging. A production build runs the same application code through Firebase.

## Deliver a local message
=======
During development, the token and message broker belong to the local sandbox. No registration reaches Firebase Cloud Messaging. A production build runs the same application code through Firebase. Use the [Firebase Cloud Messaging Web documentation](https://firebase.google.com/docs/cloud-messaging/web/get-started) for normal registration and the [message handling guide](https://firebase.google.com/docs/cloud-messaging/web/receive-messages) for foreground and background behavior.

## Deliver a message during local development
>>>>>>> origin/main

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

<<<<<<< HEAD
Keep this driver outside application code that ships. A visible client routes the delivery to `onMessage`; a hidden client routes it to the service-worker `onBackgroundMessage` path. The local broker does not request notification permission or contact FCM.

Use the generated Messaging conformance page to check the currently supported public API before depending on a receive path.
=======
Keep this driver outside application code that ships. A visible client routes the delivery to `onMessage`. A hidden client routes it to the service-worker `onBackgroundMessage` path. The local broker also models token stability and deletion, but it does not request browser notification permission or contact the FCM transport.

## Check the supported boundary

Read the generated [Messaging conformance matrix](../pyric-messaging-compat/) for the current client, service-worker, and Admin send surfaces, including verified behavior and tracked limitations.

Continue with [Inspect and correct](../see-whats-happening/) or [verify the production boundary](../pyric-cli-how-to-verify-against-a-captured-session/).
>>>>>>> origin/main
