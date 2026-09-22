import type { FirebaseApp } from 'pyric/app';
import { registerAppCleanup } from 'pyric/app/internal';
import { getFirestore, type ClientDb } from '../worker/client.js';
import { getHostedFirestore } from '../worker/client/websocket-connection.js';
import { getServiceWorkerFirestore } from '../worker/client/service-worker-connection.js';
import { ownClientUntilPagehide } from '../worker/client/pagehide.js';
import { disconnectClient } from '../worker/client/disconnect.js';
import { isServiceWorkerRealm } from '../worker/service-worker-channel.js';
import { PYRIC_WORKER_URL } from '../runtime/manifest.js';
import { workerNameForEpoch } from '../runtime/worker-generation.js';
import { getPyricRuntimeStatus } from '../runtime/status.js';
import { initPayloadRequest } from './init-payload.js';
import { toPageOriginWsUrl } from './bridge-url.js';

/** Service Workers reject top-level await; defer connection setup behind the SDK handle. */
export async function messagingSwClient(app: FirebaseApp): Promise<ClientDb | null> {
  let deleted = false;
  const release = registerAppCleanup(app, () => { deleted = true; });
  try {
    const payload = await initPayloadRequest;
    if (deleted) throw new Error('Firebase App was deleted before Messaging connected.');
    let client: ClientDb;
    if (payload.hosted) {
      const bridgeUrl = payload.bridgeUrl;
      const projectKey = payload.projectKey;
      const hasEndpoint = typeof bridgeUrl === 'string' && typeof projectKey === 'string';
      if (!hasEndpoint) throw new Error('The hosted sandbox has no Messaging endpoint or project identity.');
      client = getHostedFirestore({
        url: toPageOriginWsUrl(bridgeUrl, location, 'page-origin'),
        projectKey,
        retryInitialConnection: isServiceWorkerRealm(),
      });
    } else if (isServiceWorkerRealm()) {
      client = getServiceWorkerFirestore(app.name);
    } else if (typeof SharedWorker !== 'undefined') {
      const status = getPyricRuntimeStatus();
      const name = workerNameForEpoch(status.getSnapshot().servedEpoch, localStorage);
      client = getFirestore(PYRIC_WORKER_URL, name);
    } else {
      return null;
    }
    if (isServiceWorkerRealm()) {
      registerAppCleanup(app, async () => {
        await disconnectClient(client);
      });
    } else {
      const lifecycle = ownClientUntilPagehide(client);
      registerAppCleanup(app, async () => {
        lifecycle.dispose();
        await lifecycle.disconnect();
      });
    }
    client.port.postMessage({ t: 'appConfig', options: { ...app.options } });
    return client;
  } finally { release(); }
}

/** Keep initial attachment alive without making an outage invalidate the worker installation. */
export function holdMessagingWorkerStartup(ready: Promise<void>): void {
  if (!isServiceWorkerRealm()) return;
  const worker = globalThis as typeof globalThis & {
    addEventListener(type: 'install' | 'activate', listener: (event: { waitUntil(work: Promise<void>): void }) => void, options: { once: boolean }): void;
  };
  // The observer reports startup failures; the transport owns reconnect attempts.
  const attempted = ready.catch(() => {});
  const wait = (event: { waitUntil(work: Promise<void>): void }): void => event.waitUntil(attempted);
  worker.addEventListener('install', wait, { once: true });
  worker.addEventListener('activate', wait, { once: true });
}
