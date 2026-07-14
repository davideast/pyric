/** MessagePort-shaped client transport from ServiceWorkerGlobalScope to the SharedWorker. */
import { wirePort } from './core.js';
import type { ClientDb, ClientPort } from './handles.js';
import {
  SERVICE_WORKER_CHANNEL,
  type ServiceWorkerChannelMessage,
} from '../service-worker-channel.js';

function newSessionId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function getServiceWorkerFirestore(appName: string): ClientDb {
  if (typeof BroadcastChannel === 'undefined') {
    throw new Error('BroadcastChannel is required to connect firebase/messaging/sw to the Pyric backend.');
  }
  const channel = new BroadcastChannel(SERVICE_WORKER_CHANNEL);
  // Stable logical id + fresh realm id lets the host replace stale subscriptions
  // without accepting late frames from the superseded Service Worker realm.
  const clientId = `service-worker:${encodeURIComponent(appName)}`;
  const sessionId = newSessionId();
  channel.postMessage({
    direction: 'host',
    phase: 'attach',
    clientId,
    sessionId,
  } satisfies ServiceWorkerChannelMessage);
  const port: ClientPort = {
    onmessage: null,
    postMessage(message) {
      channel.postMessage({
        direction: 'host',
        phase: 'message',
        clientId,
        sessionId,
        message,
      } satisfies ServiceWorkerChannelMessage);
    },
    start() {},
    close() {
      channel.close();
      port.onmessage = null;
    },
  } satisfies ClientPort;
  channel.onmessage = (event: MessageEvent<ServiceWorkerChannelMessage>) => {
    const envelope = event.data;
    if (
      envelope.direction !== 'client'
      || envelope.clientId !== clientId
      || envelope.sessionId !== sessionId
    ) return;
    port.onmessage?.({ data: envelope.message } as MessageEvent);
  };
  const db = { __kind: 'client-db', port } satisfies ClientDb;
  wirePort(db.port);
  return db;
}
