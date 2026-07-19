/** The canonical `firebase/messaging` served mirror. */
import * as inPage from 'pyric/messaging';
import type {
  GetTokenOptions,
  MessagePayload,
  Messaging,
  NextFn,
  Observer,
  Unsubscribe,
} from 'pyric/messaging';
import { getApp, type FirebaseApp } from 'pyric/app';
import { registerAppCleanup } from 'pyric/app/internal';
import { registerSandboxDelivery } from 'pyric/messaging/internal';
import {
  messagingDeleteToken,
  messagingDeliver,
  messagingGetMessaging,
  messagingGetToken,
  messagingSetVisibility,
  messagingSubscribe,
  type ClientMessaging,
} from '../worker/client/messaging.js';
import { workerClientForApp } from './app-client.js';
import { useWorker } from './worker-runtime.js';

export type {
  FcmOptions,
  GetTokenOptions,
  MessagePayload,
  Messaging,
  NextFn,
  NotificationPayload,
  Observer,
  Unsubscribe,
} from 'pyric/messaging';

type WorkerMessaging = Messaging & ClientMessaging;
const workerMessagingByApp = new WeakMap<FirebaseApp, WorkerMessaging>();
const visibilityWired = new WeakSet<FirebaseApp>();

function wireVisibility(app: FirebaseApp, messaging: WorkerMessaging): void {
  if (visibilityWired.has(app) || typeof document === 'undefined') return;
  visibilityWired.add(app);
  const sync = (): void => {
    const state = document.visibilityState === 'visible' ? 'visible' : 'hidden';
    void messagingSetVisibility(messaging, state).catch(() => {});
  };
  document.addEventListener('visibilitychange', sync);
  registerAppCleanup(app, () => {
    visibilityWired.delete(app);
    document.removeEventListener('visibilitychange', sync);
  });
  sync();
}

export function getMessaging(app?: FirebaseApp): Messaging {
  const resolved = app ?? getApp();
  if (!useWorker) return inPage.getMessaging(resolved);
  const existing = workerMessagingByApp.get(resolved);
  if (existing) return existing;
  const handle = Object.assign(
    messagingGetMessaging(workerClientForApp(resolved)),
    { app: resolved },
  ) as WorkerMessaging;
  workerMessagingByApp.set(resolved, handle);
  wireVisibility(resolved, handle);
  // The worker-backed handle isn't in pyric's in-page instance registry, so
  // teach `pyric/messaging`'s `sandbox.deliver` to drive it over the transport
  // (visibility+routing resolved host-side). Keeps `firebase/messaging` itself
  // free of any `sandbox` surface — production parity is untouched.
  registerSandboxDelivery(handle, (spec) => messagingDeliver(handle, spec));
  return handle;
}

export function getToken(messaging: Messaging, options?: GetTokenOptions): Promise<string> {
  return useWorker
    ? messagingGetToken(messaging as WorkerMessaging, options)
    : inPage.getToken(messaging, options);
}

export function deleteToken(messaging: Messaging): Promise<boolean> {
  return useWorker
    ? messagingDeleteToken(messaging as WorkerMessaging)
    : inPage.deleteToken(messaging);
}

export function onMessage(
  messaging: Messaging,
  nextOrObserver: NextFn<MessagePayload> | Observer<MessagePayload>,
): Unsubscribe {
  return useWorker
    ? messagingSubscribe(messaging as WorkerMessaging, 'messaging.foreground', nextOrObserver)
    : inPage.onMessage(messaging, nextOrObserver);
}

export const isSupported = inPage.isSupported;
