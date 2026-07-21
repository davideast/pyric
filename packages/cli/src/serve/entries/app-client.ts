/** Per-app SharedWorker ports: distinct Firebase service containers, one worker backend. */
import type { FirebaseApp } from 'pyric/app';
import { registerAppCleanup } from 'pyric/app/internal';
import type { ClientDb } from '../worker/client.js';
import type { InboundMessage } from '../worker/protocol.js';
import { disconnectClient } from '../worker/client/disconnect.js';
import { openWorkerDb } from './worker-runtime.js';

const clients = new WeakMap<FirebaseApp, ClientDb>();

export function workerClientForApp(app: FirebaseApp): ClientDb {
  const existing = clients.get(app);
  if (existing) return existing;
  let client: ClientDb | undefined;
  let disconnecting: Promise<void> | undefined;
  const disconnectOnce = (): Promise<void> => {
    if (!client) return Promise.resolve();
    return disconnecting ??= disconnectClient(client);
  };
  const onPageHide = (event: Event): void => {
    // A persisted pagehide enters the back-forward cache; its live JS objects
    // and MessagePort are restored on pageshow, so disconnecting would poison
    // both the app and database handle caches with a permanently closed port.
    if ((event as PageTransitionEvent).persisted) return;
    void disconnectOnce().catch(() => undefined);
  };
  globalThis.addEventListener?.('pagehide', onPageHide);
  registerAppCleanup(app, async () => {
    clients.delete(app);
    globalThis.removeEventListener?.('pagehide', onPageHide);
    await disconnectOnce();
  });
  client = openWorkerDb(app.name);
  client.port.postMessage({
    t: 'appConfig',
    options: app.options as Record<string, unknown>,
  } satisfies InboundMessage);
  clients.set(app, client);
  return client;
}
