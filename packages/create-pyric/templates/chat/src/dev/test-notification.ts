// Dev-only helper to prove the Cloud Messaging path end to end without a
// backend. Cloud Messaging is a server-to-client push; with no server calling
// the FCM Send API, pyric's sandbox.deliver is the "a push arrived" stand-in.
//
// getMessaging comes from firebase/messaging (the worker-backed handle the app
// actually uses); the sandbox driver comes from pyric/messaging. On the default
// SharedWorker path this now routes through the worker (pyric#397), so no
// ?inpage is needed. Fire one from DevTools:  await __pyricSendTestNotification()
import { getMessaging } from 'firebase/messaging';
import { sandbox as messagingSandbox } from 'pyric/messaging';
import { firebaseApp } from '../firebase/app';

declare global {
  interface Window {
    // visibility 'hidden' forces the onBackgroundMessage route (OS notification);
    // 'visible' forces the onMessage route (in-app toast). Defaults to hidden so
    // `await __pyricSendTestNotification()` tests the background path directly.
    __pyricSendTestNotification?: (body?: string, visibility?: 'hidden' | 'visible') => Promise<unknown>;
  }
}

if (import.meta.env.DEV) {
  window.__pyricSendTestNotification = (body = 'A test notification arrived.', visibility: 'hidden' | 'visible' = 'hidden') =>
    messagingSandbox.deliver(getMessaging(firebaseApp), {
      visibilityState: visibility,
      notification: { title: 'PyChat', body },
    });
}
