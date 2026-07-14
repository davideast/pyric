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
import {
  messagingGetMessaging,
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
} from 'pyric/messaging/sw';

type WorkerMessaging = Messaging & ClientMessaging;
const workerMessagingByApp = new WeakMap<FirebaseApp, WorkerMessaging>();
const bigQueryExport = new WeakMap<Messaging, boolean>();

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
  return handle;
}

export function onBackgroundMessage(
  messaging: Messaging,
  nextOrObserver: NextFn<MessagePayload> | Observer<MessagePayload>,
): Unsubscribe {
  return useWorker
    ? messagingSubscribe(messaging as WorkerMessaging, 'messaging.background', nextOrObserver)
    : inPage.onBackgroundMessage(messaging, nextOrObserver);
}

export function experimentalSetDeliveryMetricsExportedToBigQueryEnabled(
  messaging: Messaging,
  enable: boolean,
): void {
  if (!useWorker) {
    inPage.experimentalSetDeliveryMetricsExportedToBigQueryEnabled(messaging, enable);
    return;
  }
  if ((messaging as Partial<ClientMessaging>).__kind !== 'client-messaging') {
    throw new Error('firebase/messaging/sw: unrecognized Messaging instance');
  }
  bigQueryExport.set(messaging, enable);
}

export const isSupported = inPage.isSupported;
