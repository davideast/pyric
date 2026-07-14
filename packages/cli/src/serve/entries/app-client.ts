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
  registerAppCleanup(app, async () => {
    clients.delete(app);
    if (client) await disconnectClient(client);
  });
  client = openWorkerDb(app.name);
  client.port.postMessage({
    t: 'appConfig',
    options: app.options as Record<string, unknown>,
  } satisfies InboundMessage);
  clients.set(app, client);
  return client;
}
