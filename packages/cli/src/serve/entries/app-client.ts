/** Per-app SharedWorker ports: distinct Firebase service containers, one worker backend. */
import type { FirebaseApp } from 'pyric/app';
import { registerAppCleanup } from 'pyric/app/internal';
import type { ClientDb } from '../worker/client.js';
import type { InboundMessage } from '../worker/protocol.js';
import { ownClientUntilPagehide } from '../worker/client/pagehide.js';
import { openWorkerDb } from './worker-runtime.js';

const clients = new WeakMap<FirebaseApp, ClientDb>();

export function workerClientForApp(app: FirebaseApp): ClientDb {
  const existing = clients.get(app);
  if (existing) return existing;
  const client = openWorkerDb(app.name);
  const lifecycle = ownClientUntilPagehide(client);
  registerAppCleanup(app, async () => {
    clients.delete(app);
    lifecycle.dispose();
    await lifecycle.disconnect();
  });
  client.port.postMessage({
    t: 'appConfig',
    options: app.options as Record<string, unknown>,
  } satisfies InboundMessage);
  clients.set(app, client);
  return client;
}
