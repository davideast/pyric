/**
 * Sends an observed call (`ObservedCall` in `pyric/sandbox`) from a page to
 * the Node host, as the `observe` frame, on the page's own control
 * connection. The host stamps the page's caller from that connection, so the
 * row shows as this page's.
 *
 * Only a module served through supplied rows imports this
 * (`../vite-supplied-rows.ts`); no `pyric()` entry does. It is served from
 * this folder so it shares the page runtime's one connection and request ids.
 *
 * A service worker never runs the page runtime, so it has no control
 * connection. There the sender opens one hosted connection of its own, from
 * `init.json`, at the first observed call, and sends every call on it, as
 * the Node process's sender does (`../../register/observed-call-sender.ts`).
 *
 * It also hands the rows' observer `journalLiveListener`, which journals
 * their Firestore listeners in the page's SDK activity
 * (`live-listener-journal.ts`).
 */
import type { ObservedCall } from 'pyric/sandbox';
import { nextId, rpc } from '../worker/client/core.js';
import type { ClientDb } from '../worker/client/handles.js';
import { isServiceWorkerRealm } from '../worker/service-worker-channel.js';
import { initPayload } from './init-payload.js';
import { openWorkerDb, useHosted, workerDb } from './worker-runtime.js';

export { journalLiveListener } from './live-listener-journal.js';

const NO_HOST_CONNECTION = 'pyric: this page has no Node host connection to report observed calls on.';

/** The service worker connection's name on the host; no app uses it. */
const SERVICE_WORKER_CONNECTION_NAME = '[pyric-live]';

let serviceWorkerConnection: ClientDb | undefined;

/** A service worker's own hosted connection, opened once. Rejects when `init.json` names no Node host. */
async function serviceWorkerHostConnection(): Promise<ClientDb> {
  const payload = await initPayload;
  const isHosted = payload?.hosted === true;
  if (!isHosted) throw new Error(NO_HOST_CONNECTION);
  serviceWorkerConnection ??= openWorkerDb(SERVICE_WORKER_CONNECTION_NAME);
  return serviceWorkerConnection;
}

/** The connection this realm reports on: the page's control connection, or a service worker's own. */
async function hostConnection(): Promise<ClientDb> {
  if (isServiceWorkerRealm()) return serviceWorkerHostConnection();
  const db = workerDb;
  const hasHostConnection = useHosted && db !== null;
  if (!hasHostConnection) throw new Error(NO_HOST_CONNECTION);
  return db;
}

/** Sends one observed call. Rejects when the page or service worker has no Node host connection. */
export async function sendObservedCall(call: ObservedCall): Promise<void> {
  const db = await hostConnection();
  await rpc(db.port, { t: 'observe', id: nextId(), call });
}
