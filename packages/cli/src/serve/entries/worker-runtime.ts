/** SharedWorker availability, control-port ownership, presence, and staleness. */
import {
  getFirestore,
  getWorkerVersion,
  startPresence,
  subscribeEvents,
  subscribePresence,
  type ClientDb,
} from '../worker/client.js';
import { getServiceWorkerFirestore } from '../worker/client/service-worker-connection.js';
import { isServiceWorkerRealm } from '../worker/service-worker-channel.js';
import {
  PYRIC_WORKER_NAME,
  PYRIC_WORKER_URL,
} from '../runtime/manifest.js';
import { getPyricRuntimeStatus } from '../runtime/status.js';
import { connectRuntimeWorker } from '../runtime/worker-connection.js';
import { createWorkerReplacement } from '../runtime/worker-replacement.js';
import {
  preflightWorkerEpochStorage,
  rememberWorkerEpoch,
  workerNameForEpoch,
} from '../runtime/worker-generation.js';
import {
  onWorkerRuntimeReload,
  retireWorkerRuntime,
} from '../worker/client/runtime-control.js';

const hasSharedWorker = typeof SharedWorker !== 'undefined';
const runtimeStatus = getPyricRuntimeStatus();

const workerRequested =
  (hasSharedWorker || (isServiceWorkerRealm() && typeof BroadcastChannel !== 'undefined'))
  && !(globalThis as { __PYRIC_FORCE_INPAGE__?: boolean }).__PYRIC_FORCE_INPAGE__;

export const WORKER_URL = PYRIC_WORKER_URL;
let epochStorage: Storage | undefined;
try {
  epochStorage = typeof localStorage === 'undefined' ? undefined : localStorage;
} catch {
  epochStorage = undefined;
}
export const WORKER_NAME = workerNameForEpoch(
  runtimeStatus.getSnapshot().servedEpoch,
  epochStorage,
);

/** Control traffic only; Firebase apps receive independent app-owned ports. */
export const workerDb: ClientDb | null = workerRequested
  ? hasSharedWorker
    ? connectRuntimeWorker(
        () => getFirestore(WORKER_URL, WORKER_NAME, {
          onError: (error) => runtimeStatus.reportError(error, 'worker'),
        }),
        (error) => runtimeStatus.reportError(error, 'worker'),
      )
    : null
  : null;

export const useWorker = workerRequested && (!hasSharedWorker || workerDb !== null);

export function openWorkerDb(appName: string): ClientDb {
  if (hasSharedWorker) return getFirestore(WORKER_URL, WORKER_NAME);
  if (isServiceWorkerRealm()) return getServiceWorkerFirestore(appName);
  throw new Error('No Pyric worker transport is available in this browser context.');
}

export const presenceSession = useWorker && workerDb
  ? startPresence({ db: workerDb, kind: 'app' })
  : null;

runtimeStatus.setWorker({
  mode: useWorker ? 'shared-worker' : 'in-page',
  runningEpoch: null,
});

const workerReplacement = useWorker && workerDb && typeof window !== 'undefined'
  ? createWorkerReplacement({
      targetEpoch: runtimeStatus.getSnapshot().servedEpoch!,
      retire: () => retireWorkerRuntime(
        workerDb,
        runtimeStatus.getSnapshot().servedEpoch!,
      ),
      subscribeReload: onWorkerRuntimeReload,
      preflight: () => preflightWorkerEpochStorage(epochStorage),
      commitGeneration: (epoch) => rememberWorkerEpoch(epoch, epochStorage),
      onPreparationError: (error) => runtimeStatus.reportError(error, 'worker'),
      reload: () => window.location.reload(),
    })
  : null;
runtimeStatus.setWorkerUpdater(
  workerReplacement ? () => workerReplacement.request() : null,
);

if (useWorker && workerDb) {
  subscribeEvents(workerDb, (events) => runtimeStatus.recordSandboxEvents(events));
}

if (useWorker && typeof document !== 'undefined') {
  const servedVersion = runtimeStatus.getSnapshot().servedEpoch;
  void getWorkerVersion(workerDb!)
    .then(async (runningVersion) => {
      runtimeStatus.setWorker({ mode: 'shared-worker', runningEpoch: runningVersion });
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
        `[pyric sandbox] the SharedWorker is running older code (build ${runningVersion}) than what is now `
          + `served (build ${servedVersion}). A SharedWorker can't hot-update — CLOSE ALL TABS of this origin `
          + 'and reopen to load the new worker. (All tabs share one worker, so a partial reload leaves '
          + `the old code running for everyone.)${othersHint}`,
      );
    })
    .catch((error) => runtimeStatus.reportError(error, 'worker'));
}
