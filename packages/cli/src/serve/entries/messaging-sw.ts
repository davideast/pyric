/** The canonical `firebase/messaging/sw` served mirror. */
import * as inPage from 'pyric/messaging/sw';
import type {
  MessagePayload,
  Messaging,
  NextFn,
  Observer,
  Unsubscribe,
} from 'pyric/messaging/sw';
import { getApp, type FirebaseApp } from 'pyric/app';
import { registerSandboxDelivery } from 'pyric/messaging/internal';
import {
  messagingDeliver,
  messagingGetMessaging,
  messagingSubscribe,
  messagingSetVisibility,
  type ClientMessaging,
} from '../worker/client/messaging.js';
import { messagingSwClient, holdMessagingWorkerStartup } from './messaging-sw-client.js';
import { messagingRegistration } from './messaging-registration.js';

export type {
  FcmOptions,
  GetTokenOptions,
  MessagePayload,
  Messaging,
  NextFn,
  NotificationPayload,
  Observer,
  Unsubscribe,
} from 'pyric/messaging/sw';

const workerMessagingByApp = new WeakMap<FirebaseApp, Messaging>();
const clients = new WeakMap<Messaging, Promise<ClientMessaging | null>>();
const bigQueryExport = new WeakMap<Messaging, boolean>();

export function getMessaging(app?: FirebaseApp): Messaging {
  const resolved = app ?? getApp();
  const existing = workerMessagingByApp.get(resolved);
  if (existing) return existing;
  const handle: Messaging = { app: resolved };
  const client = messagingSwClient(resolved).then(db => db
    ? messagingGetMessaging(db, messagingRegistration(resolved))
    : null);
  // A handle can be created without an observer; observers and delivery calls report startup errors.
  void client.catch(() => {});
  clients.set(handle, client);
  workerMessagingByApp.set(resolved, handle);
  registerSandboxDelivery(handle, async spec => {
    const messaging = await client;
    if (messaging) return messagingDeliver(messaging, spec);
    return inPage.sandbox.deliver(inPage.getMessaging(resolved), spec);
  });
  return handle;
}

export function onBackgroundMessage(
  messaging: Messaging,
  nextOrObserver: NextFn<MessagePayload> | Observer<MessagePayload>,
): Unsubscribe {
  const client = clients.get(messaging);
  if (!client) throw new Error('firebase/messaging/sw: unrecognized Messaging instance');
  let stopped = false;
  let unsubscribe: Unsubscribe | undefined;
  const ready = client.then(async worker => {
    if (stopped) return;
    unsubscribe = worker
      ? messagingSubscribe(worker, 'messaging.background', nextOrObserver)
      : inPage.onBackgroundMessage(inPage.getMessaging(messaging.app), nextOrObserver);
    if (worker) {
      await worker.registrationId;
      // A worker is never a visible window. Its acknowledgment also confirms the observer is attached.
      await messagingSetVisibility(worker, 'hidden');
    }
  });
  holdMessagingWorkerStartup(ready);
  void ready.catch(error => {
    if (stopped) return;
    const hasObserver = typeof nextOrObserver !== 'function';
    if (hasObserver) nextOrObserver.error(error instanceof Error ? error : new Error(String(error)));
    else console.error('Messaging background subscription failed:', error);
  });
  return () => { stopped = true; unsubscribe?.(); };
}

export function experimentalSetDeliveryMetricsExportedToBigQueryEnabled(
  messaging: Messaging,
  enable: boolean,
): void {
  if (!clients.has(messaging)) {
    throw new Error('firebase/messaging/sw: unrecognized Messaging instance');
  }
  bigQueryExport.set(messaging, enable);
}

export const isSupported = inPage.isSupported;
