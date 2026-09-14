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
import { getHostedFirestore } from '../worker/client/websocket-connection.js';
import { initPayload } from './init-payload.js';
import { toPageOriginWsUrl } from './bridge-url.js';
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
const payload = await initPayload;
export const useHosted = payload?.hosted === true;

function hostedTarget(): { url: string; projectKey: string } {
  const bridgeUrl = payload?.bridgeUrl;
  const isEndpointMissing = typeof bridgeUrl !== 'string';
  if (isEndpointMissing) throw new Error('The hosted sandbox has no bridge endpoint.');
  const projectKey = payload?.projectKey;
  const isProjectMissing = typeof projectKey !== 'string' || projectKey.length === 0;
  if (isProjectMissing) throw new Error('The hosted sandbox has no project identity.');
  return { url: toPageOriginWsUrl(bridgeUrl, location), projectKey };
}

const hasServiceWorkerRelay = isServiceWorkerRealm() && typeof BroadcastChannel !== 'undefined';
const hasLocalWorker = hasSharedWorker || hasServiceWorkerRelay;
const forceInPage = (globalThis as { __PYRIC_FORCE_INPAGE__?: boolean }).__PYRIC_FORCE_INPAGE__ === true;
const workerRequested = !useHosted && hasLocalWorker && !forceInPage;

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
export const workerDb: ClientDb | null = createControlClient();

function createControlClient(): ClientDb | null {
  if (useHosted) return getHostedFirestore(hostedTarget());
  const usesSharedWorker = workerRequested && hasSharedWorker;
  if (usesSharedWorker) {
    return connectRuntimeWorker(
        () => getFirestore(WORKER_URL, WORKER_NAME, {
          onError: (error) => runtimeStatus.reportError(error, 'worker'),
        }),
        (error) => runtimeStatus.reportError(error, 'worker'),
      );
  }
  return null;
}

export const useWorker = useHosted || (workerRequested && (!hasSharedWorker || workerDb !== null));

export function openWorkerDb(appName: string): ClientDb {
  if (useHosted) return getHostedFirestore(hostedTarget());
  if (hasSharedWorker) return getFirestore(WORKER_URL, WORKER_NAME);
  const usesServiceWorker = isServiceWorkerRealm();
  if (usesServiceWorker) return getServiceWorkerFirestore(appName);
  throw new Error('No Pyric worker transport is available in this browser context.');
}

export const presenceSession = useWorker && workerDb
  ? startPresence({ db: workerDb, kind: 'app' })
  : null;

let runtimeMode: 'hosted' | 'shared-worker' | 'in-page' = 'in-page';
if (useWorker) runtimeMode = 'shared-worker';
if (useHosted) runtimeMode = 'hosted';
runtimeStatus.setWorker({
  mode: runtimeMode,
  runningEpoch: null,
});

const controlDb = workerDb;
const hasLocalControlPort = !useHosted && useWorker && controlDb !== null;
const hasWindow = typeof window !== 'undefined';
const canReplaceWorker = hasLocalControlPort && hasWindow;
let workerReplacement: ReturnType<typeof createWorkerReplacement> | null = null;
if (canReplaceWorker) {
  workerReplacement = createWorkerReplacement({
    retire: async () => {
      const targetEpoch = runtimeStatus.getSnapshot().servedEpoch;
      const isTargetMissing = targetEpoch === null;
      if (isTargetMissing) throw new Error('No Pyric worker update target is available.');
      await retireWorkerRuntime(controlDb, targetEpoch);
    },
    subscribeReload: onWorkerRuntimeReload,
    preflight: () => preflightWorkerEpochStorage(epochStorage),
    commitGeneration: (epoch) => rememberWorkerEpoch(epoch, epochStorage),
    onPreparationError: (error) => runtimeStatus.reportError(error, 'worker'),
    reload: () => window.location.reload(),
  });
}
const replacement = workerReplacement;
const hasReplacement = replacement !== null;
let updateWorker: (() => Promise<void>) | null = null;
if (hasReplacement) updateWorker = () => replacement.request();
runtimeStatus.setWorkerUpdater(updateWorker);

if (useWorker && workerDb) {
  subscribeEvents(workerDb, (events) => runtimeStatus.recordSandboxEvents(events));
}

const isPage = typeof document !== 'undefined';
const canInspectWorkerVersion = hasLocalControlPort && isPage;
if (canInspectWorkerVersion) {
  const servedVersion = runtimeStatus.getSnapshot().servedEpoch;
  void getWorkerVersion(controlDb)
    .then(async (runningVersion) => {
      runtimeStatus.setWorker({ mode: 'shared-worker', runningEpoch: runningVersion });
      const hasUnknownVersion = !servedVersion || !runningVersion;
      const runsDevelopmentBuild = runningVersion === 'dev';
      const versionsMatch = servedVersion === runningVersion;
      const skipVersionWarning = hasUnknownVersion || runsDevelopmentBuild || versionsMatch;
      if (skipVersionWarning) return;
      const otherPages = await new Promise<number>((resolve) => {
        const unsubscribe = subscribePresence(controlDb, (snapshot) => {
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
      let othersHint = '';
      const hasOtherPages = otherPages > 0;
      const isOnlyPage = otherPages === 0;
      if (hasOtherPages) {
        const hasOneOtherPage = otherPages === 1;
        const pageSuffix = hasOneOtherPage ? '' : 's';
        othersHint = ` ${otherPages} other page${pageSuffix} must disconnect before the worker can restart.`;
      } else if (isOnlyPage) {
        othersHint = ' This is the only connected page — reload it to pick up the new worker.';
      }
      console.warn(
        `[pyric sandbox] the SharedWorker is running older code (build ${runningVersion}) than what is now `
          + `served (build ${servedVersion}). A SharedWorker can't hot-update — CLOSE ALL TABS of this origin `
          + 'and reopen to load the new worker. (All tabs share one worker, so a partial reload leaves '
          + `the old code running for everyone.)${othersHint}`,
      );
    })
    .catch((error) => runtimeStatus.reportError(error, 'worker'));
}
