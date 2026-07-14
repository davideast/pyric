/** SharedWorker availability, control-port ownership, presence, and staleness. */
import {
  getFirestore,
  getWorkerVersion,
  startPresence,
  subscribePresence,
  type ClientDb,
} from '../worker/client.js';
import { getServiceWorkerFirestore } from '../worker/client/service-worker-connection.js';
import { isServiceWorkerRealm } from '../worker/service-worker-channel.js';

const hasSharedWorker = typeof SharedWorker !== 'undefined';

export const useWorker =
  (hasSharedWorker || (isServiceWorkerRealm() && typeof BroadcastChannel !== 'undefined'))
  && !(globalThis as { __PYRIC_FORCE_INPAGE__?: boolean }).__PYRIC_FORCE_INPAGE__;

export const WORKER_URL = '/__pyric/sdk/worker.js';
export const WORKER_NAME = 'pyric-shared-worker';

/** Control traffic only; Firebase apps receive independent app-owned ports. */
export const workerDb: ClientDb | null = useWorker
  ? hasSharedWorker
    ? getFirestore(WORKER_URL, WORKER_NAME)
    : null
  : null;

export function openWorkerDb(appName: string): ClientDb {
  if (hasSharedWorker) return getFirestore(WORKER_URL, WORKER_NAME);
  if (isServiceWorkerRealm()) return getServiceWorkerFirestore(appName);
  throw new Error('No Pyric worker transport is available in this browser context.');
}

export const presenceSession = useWorker && workerDb
  ? startPresence({ db: workerDb, kind: 'app' })
  : null;

if (useWorker && typeof document !== 'undefined') {
  const servedVersion = document
    .querySelector('meta[name="pyric-worker-v"]')
    ?.getAttribute('content');
  void getWorkerVersion(workerDb!)
    .then(async (runningVersion) => {
      if (
        !servedVersion
        || !runningVersion
        || runningVersion === 'dev'
        || servedVersion === runningVersion
      ) return;
      const otherPages = await new Promise<number>((resolve) => {
        const unsubscribe = subscribePresence(workerDb!, (snapshot) => {
          unsubscribe();
          resolve(snapshot.clients.filter(
            (client) => client.clientId !== presenceSession?.clientId,
          ).length);
        });
        setTimeout(() => {
          unsubscribe();
          resolve(-1);
        }, 2_000);
      });
      const othersHint = otherPages > 0
        ? ` ${otherPages} other page${otherPages === 1 ? '' : 's'} must disconnect before the worker can restart.`
        : otherPages === 0
          ? ' This is the only connected page — reload it to pick up the new worker.'
          : '';
      console.warn(
        `[pyric dev] the SharedWorker is running OLDER code (build ${runningVersion}) than what is now `
          + `served (build ${servedVersion}). A SharedWorker can't hot-update — CLOSE ALL TABS of this origin `
          + 'and reopen to load the new worker. (All tabs share one worker, so a partial reload leaves '
          + `the old code running for everyone.)${othersHint}`,
      );
    })
    .catch(() => {});
}
