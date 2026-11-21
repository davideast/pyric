/**
 * `pyric dev` in-page runtime -- the shared chunk every served SDK bundle
 * closes over. One sandbox per page; init payload (rules, future bridge URL)
 * fetched from `/__pyric/init.json` at module init.
 *
 * TOP-LEVEL AWAIT IS LOAD-BEARING: every importer (the auth/firestore bundles,
 * and therefore the user's app module) is deferred until this module resolves,
 * so by the time app code runs the rules are deployed -- no
 * "first write raced the ruleset" class of bugs.
 *
 * This file is BUNDLED FOR THE BROWSER by `../bundler.ts` (esbuild) -- it is
 * never imported by node-side @pyric/cli code. Bundle splitting must keep it
 * a single shared chunk: two copies would mean two sandboxes (P0 validation
 * constraint, design rationale section 9).
 */
import {
  recordBackendOverBlob,
  serializeToBuckets,
  bundleRecords,
} from 'pyric/sandbox';
import { getApps } from 'pyric/app';
import { seedDocuments, setRules, snapshotDocuments } from 'pyric/sandbox/firestore';
import { rulesSourceRejection } from 'pyric/rules/internal';
import { getDatabase } from 'pyric/database';
import { installServedStorageRules } from '../storage-rules-install.js';
import { getAuth, sandbox as authOps, type SeedUser } from 'pyric/auth';
import type { ConnectedBridge } from '../../bridge/client/bridge.js';
import {
  callTool as workerCallTool,
  relayWorkerOp,
  relayWorkerSub,
  relayWorkerDisconnect,
} from '../worker/client.js';
import { useWorker, workerDb, useHosted } from './worker-runtime.js';
import { initPayload, initPayloadRequest, logInitPayloadFailure } from './init-payload.js';
export { initPayload } from './init-payload.js';
import { keepaliveSafe } from './keepalive.js';
import { onServiceUsed } from './service-use.js';
import { setupInPagePersistence } from './in-page-persistence.js';
import { setupInPageRulesEvents } from './in-page-rules-events.js';
import { toPageOriginWsUrl } from './bridge-url.js';
import { buildLiveSessionCaptureFixture } from '../session-capture-fixture.js';
import { avatarMintForPayload } from '../assets/avatar-url.js';
import { setupFirebaseActivityGuard } from '../activity-guard.js';
import { getPyricRuntimeStatus } from '../runtime/status.js';
export { sandbox } from './app-backend.js';
import { sandbox } from './app-backend.js';
import { databaseRules } from './page-database-rules.js';

export { databaseRules };

/**
 * The DEFAULT-ON worker path (Phase 3c): when SharedWorker is available the
 * `firebase/*` entry adapters route to the worker-hosted sandbox instead of
 * the in-page one. The worker owns rules/seed/persist/capture/session (it
 * fetches the SAME `/__pyric/init.json`), so on this path the page MUST NOT
 * re-run that backend init below -- doing so would double-POST captures and
 * fight the worker over `/__pyric/state`. Unsupported browsers fall back to
 * the in-page sandbox + the shipped BroadcastChannel sync (strict enhancement).
 *
 * `globalThis.__PYRIC_FORCE_INPAGE__` is an explicit opt-out: a host that does
 * NOT serve the worker bundle (`/__pyric/sdk/worker.js`) sets it before this
 * module evaluates so the page takes the in-page path instead of trying to load
 * a worker that 404s. `pyric dev` always serves the worker and never sets it;
 * the `@pyric/cli/vite` plugin sets it until it serves the worker (M2).
 *
 * The in-page sandbox. On the worker path it is NOT the data backend -- it
 * stays mounted as the FALLBACK primitive. Worker-mode provider UI reads the
 * worker user directory directly and never constructs a page-local Auth
 * backend.
 */

interface ServeDiagnostics {
  sandboxReady: boolean;
  rulesDeployed: boolean;
  databaseRulesDeployed: boolean;
  storageRulesDeployed: boolean;
  rulesHash: string | null;
  databaseRulesHash: string | null;
  storageRulesHash: string | null;
  initError: string | null;
  bridgeConnected: boolean;
  seededDocs: number;
  persistEnabled: boolean;
  /** Epoch ms of the last successful state flush to the server. */
  lastFlushAt: number | null;
  /** True when another tab holds the writer lock -- this tab won't persist. */
  persistReadOnly: boolean;
  /** True when a `--seed` fixture was withheld because the sandbox already
   *  held restored/lived data (see the seed-docs block below). */
  seedSkipped: boolean;
}

declare global {
  // eslint-disable-next-line no-var
  var __pyricServe: ServeDiagnostics;
}

const diagnostics: ServeDiagnostics = {
  sandboxReady: true,
  rulesDeployed: false,
  databaseRulesDeployed: false,
  storageRulesDeployed: false,
  rulesHash: null,
  databaseRulesHash: null,
  storageRulesHash: null,
  initError: null,
  bridgeConnected: false,
  seededDocs: 0,
  persistEnabled: false,
  lastFlushAt: null,
  persistReadOnly: false,
  seedSkipped: false,
};
globalThis.__pyricServe = diagnostics;
const runtimeStatus = getPyricRuntimeStatus();

if (!useWorker) {
  sandbox.onEvent((event) => runtimeStatus.recordSandboxEvents([event]));
}

let bridgeUrlFromPayload: string | null = null;
let persistFromPayload = false;
let activityTokenFromPayload: string | null = null;
let activeBridge: ConnectedBridge | null = null;
let bridgeConnecting = false;
let bridgeDesired = false;

async function connectBridgePeer(rawUrl: string): Promise<ConnectedBridge | null> {
  if (useHosted) return null;
  const url = toPageOriginWsUrl(rawUrl, window.location);
  const { connectBridge } = await import('../../bridge/client/bridge.js');
  const wdb = workerDb;
  const hasWorkerBridge = useWorker && wdb !== null;
  let connected: ConnectedBridge;
  if (hasWorkerBridge) {
    connected = connectBridge(sandbox, {
      url,
      dispatcher: (_sandbox, name, args, actAs, callerId) => workerCallTool(wdb, name, args, actAs, callerId),
      workerRelay: {
        op: (op, clientSessionId) => relayWorkerOp(wdb, op, clientSessionId),
        subscribe: (sub, onValue, clientSessionId) => relayWorkerSub(wdb, sub, onValue, clientSessionId),
        disconnect: (clientSessionId) => relayWorkerDisconnect(wdb, clientSessionId),
      },
    });
  } else {
    connected = connectBridge(sandbox, { url });
  }
  console.info('[pyric sandbox] sandbox registered with the MCP bridge at', url);
  return connected;
}

function activateInPageBridge(rawUrl: string): void {
  bridgeDesired = true;
  if (activeBridge !== null || bridgeConnecting) return;
  bridgeConnecting = true;
  void connectBridgePeer(rawUrl)
    .then((connected) => {
      bridgeConnecting = false;
      if (connected === null) return;
      if (!bridgeDesired) {
        connected.disconnect();
        return;
      }
      activeBridge = connected;
      diagnostics.bridgeConnected = true;
    })
    .catch((e: unknown) => {
      bridgeConnecting = false;
      runtimeStatus.reportError(e, 'runtime');
      const detail = e instanceof Error ? e.message : String(e);
      console.error('[pyric sandbox] bridge connect failed:', detail);
    });
}

function deactivateInPageBridge(): void {
  bridgeDesired = false;
  if (activeBridge !== null) {
    activeBridge.disconnect();
    activeBridge = null;
  }
  diagnostics.bridgeConnected = false;
}

// -- init payload: fetch + apply (top-level await -- see header) --
// WORKER PATH: skipped -- the worker fetches the same init.json and owns
// rules/seed/persist/capture/session. Running it here too would double-POST
// captures and fight the worker over the /__pyric/state writer lock.
if (!useWorker) try {
  const payload = await initPayloadRequest;
  bridgeUrlFromPayload = payload.bridgeUrl;
  persistFromPayload = Boolean(payload.persist);
  activityTokenFromPayload = payload.activityToken ?? null;
  const avatarMint = avatarMintForPayload(payload.avatars);
  if (avatarMint) {
    authOps.setAvatarMint(getAuth(sandbox), avatarMint);
  }
  getDatabase(sandbox);
  if (payload.rules) {
    const rejection = rulesSourceRejection(payload.rules);
    if (rejection !== null) {
      throw new Error(`firestore.rules not loaded in the sandbox: Firestore ${rejection.message}`);
    }
    setRules(sandbox, payload.rules);
    diagnostics.rulesDeployed = true;
    diagnostics.rulesHash = payload.rulesHash;
  }
  const databaseInstances = payload.databaseInstances ?? null;
  const defaultDbPolicy = payload.permissive ? 'allow' : 'deny';
  databaseRules.deploy(databaseInstances, defaultDbPolicy);
  diagnostics.databaseRulesDeployed = Boolean(payload.databaseRules);
  diagnostics.databaseRulesHash = payload.databaseRulesHash ?? null;
  for (const notice of installServedStorageRules(sandbox, payload)) {
    console.info(`[pyric sandbox] ${notice}`);
  }
  const deploysBucketRules = Object.keys(payload.storageBucketRules ?? {}).length > 0;
  if (payload.storageRules || deploysBucketRules) {
    diagnostics.storageRulesDeployed = true;
  }
  if (payload.storageRules) {
    diagnostics.storageRulesHash = payload.storageRulesHash;
  }
  if (payload.authUsers && payload.authUsers.length > 0) {
    authOps.seedUsers(getAuth(sandbox), payload.authUsers as unknown as SeedUser[]);
  }
  if (!payload.persist && payload.seedState) {
    const seedSnap = payload.seedState as {
      firestore?: Record<string, Record<string, unknown>>;
      services?: Record<string, unknown>;
    };
    const fixtureBundle = bundleRecords(
      serializeToBuckets(seedSnap.firestore ?? {}, seedSnap.services ?? {}, 0),
    );
    await sandbox.enablePersistence({
      key: 'pyric-serve-fixture',
      injectedBackend: recordBackendOverBlob({
        read: async () => fixtureBundle,
        write: async () => {},
        clear: async () => {},
      }),
    });
    const docs = (payload.seedState as { firestore?: Record<string, unknown> }).firestore;
    diagnostics.seededDocs = docs ? Object.keys(docs).length : 0;
  }
  if (payload.persist) {
    const rawBridgeUrl = payload.bridgeUrl;
    await setupInPagePersistence(sandbox, payload, diagnostics, {
      onWriterClaimed: () => {
        if (rawBridgeUrl) activateInPageBridge(rawBridgeUrl);
      },
      onWriterLost: () => {
        deactivateInPageBridge();
      },
    });
  }
  if (payload.capture) {
    const flushCapture = (): void => {
      const auth = getAuth(sandbox);
      const apps = getApps();
      const defaultApp = apps.find((app) => app.name === '[DEFAULT]') ?? apps[0];
      const bucket = defaultApp?.options.storageBucket;
      let defaultStorageBucket: string | undefined;
      if (typeof bucket === 'string' && bucket.length > 0) {
        defaultStorageBucket = bucket;
      }
      const captureInput: Parameters<typeof buildLiveSessionCaptureFixture>[0] = {
        sandbox,
        defaultInstance: databaseRules.defaultName(),
        authState: {
          users: authOps.exportUsers(auth),
          currentUser: auth.currentUser,
        },
      };
      if (defaultStorageBucket !== undefined) {
        captureInput.defaultStorageBucket = defaultStorageBucket;
      }
      const body = JSON.stringify(buildLiveSessionCaptureFixture(captureInput));
      const captureHeaders: Record<string, string> = {
        'content-type': 'application/json',
      };
      if (payload.sessionToken) {
        captureHeaders['x-pyric-session-token'] = payload.sessionToken;
      }
      fetch('/__pyric/capture', {
        method: 'POST',
        headers: captureHeaders,
        body,
        keepalive: keepaliveSafe(body),
      }).catch(() => {});
    };

    let captureTimer: ReturnType<typeof setTimeout> | null = null;
    sandbox.onEvent(() => {
      if (captureTimer !== null) clearTimeout(captureTimer);
      captureTimer = setTimeout(flushCapture, 400);
    });

    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => {
        flushCapture();
      });
    }
  }
  if (payload.seed && Object.keys(payload.seed).length > 0) {
    const existing = Object.keys(snapshotDocuments(sandbox)).length > 0;
    if (existing) {
      diagnostics.seedSkipped = true;
      console.info(
        '[pyric sandbox] --seed skipped because the sandbox already has restored data. The fixture would ' +
          'have overwritten it. Use `--persist --fresh` to discard existing state and re-seed.',
      );
    } else {
      seedDocuments(sandbox, payload.seed);
      diagnostics.seededDocs = Object.keys(payload.seed).length;
    }
  }
} catch (e) {
  diagnostics.initError = e instanceof Error ? e.message : String(e);
  runtimeStatus.reportError(e, 'runtime');
  console.error(
    '[pyric sandbox] init failed. The sandbox is running without your project rules:',
    diagnostics.initError,
  );
}

if (!useWorker && activityTokenFromPayload) {
  setupFirebaseActivityGuard(
    {
      history: () => sandbox.history(),
      subscribe: (listener) => sandbox.onEvent(listener),
    },
    fetch,
    activityTokenFromPayload,
  );
}

function provenanceModeLabel(): string {
  if (useHosted) {
    return ' on the dev server (one backend for all tabs and server processes; rules/seed/persist owned by the dev server)';
  }
  if (useWorker) {
    return ' in a SharedWorker (one backend for all tabs; rules/seed/persist owned by the worker)';
  }
  const hasAnyRules =
    diagnostics.rulesDeployed || diagnostics.databaseRulesDeployed || diagnostics.storageRulesDeployed;
  if (hasAnyRules) return ' (project rules loaded)';
  return ' (no project rules)';
}
console.info(
  `[pyric sandbox] firebase/* on this page is served by the Pyric sandbox${provenanceModeLabel()} -- diagnostics: globalThis.__pyricServe`,
);

let provenanceHintShown = false;
function explainSandboxFrame(stackOrUrl: string | undefined): boolean {
  if (!stackOrUrl || !stackOrUrl.includes('/__pyric/sdk/')) return false;
  if (!provenanceHintShown) {
    provenanceHintShown = true;
    console.info(
      '[pyric sandbox] the error above originates in the Pyric sandbox shim serving firebase/*, ' +
        'not the real Firebase SDK -- behavior can differ where COMPAT coverage is incomplete.',
    );
  }
  return true;
}
if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) => {
    const frame = e.error instanceof Error ? (e.error.stack ?? e.filename) : e.filename;
    return explainSandboxFrame(frame);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const stack = e.reason instanceof Error ? e.reason.stack : undefined;
    return explainSandboxFrame(stack);
  });
}

// -- bridge peer --
// On the in-page path (`page.ts` loads `runtime.ts` on every served page, even
// pages with no Firebase imports), only a page that uses a service (and, under
// `--persist`, holds the writer lock) registers as the MCP bridge peer (#2053).
if (!useWorker && bridgeUrlFromPayload && !persistFromPayload) {
  const ephemeralBridgeUrl = bridgeUrlFromPayload;
  onServiceUsed(() => activateInPageBridge(ephemeralBridgeUrl));
  const stopBridgeOnEvent = sandbox.onEvent(() => {
    stopBridgeOnEvent();
    activateInPageBridge(ephemeralBridgeUrl);
  });
} else if (useWorker) {
  void (async () => {
    let payload: Awaited<typeof initPayload>;
    try {
      payload = await initPayload;
    } catch (e) {
      logInitPayloadFailure(e);
      return;
    }
    try {
      const url = payload?.bridgeUrl ?? null;
      if (url) {
        const connected = await connectBridgePeer(url);
        if (connected !== null) diagnostics.bridgeConnected = true;
      }
    } catch (e) {
      runtimeStatus.reportError(e, 'runtime');
      const detail = e instanceof Error ? e.message : String(e);
      console.error('[pyric sandbox] bridge connect failed:', detail);
    }
  })();
}

// -- cross-tab realtime sync -- wire AFTER sandbox + auth are fully set up --
const enablesFallbackTabSync = !useWorker && typeof BroadcastChannel !== 'undefined';
if (enablesFallbackTabSync) {
  sandbox.enableTabSync({
    channel: new BroadcastChannel('pyric:serve:tabsync'),
  });

  void import('./tab-sync-wiring.js').then(({ wireAuthTabSync }) => {
    wireAuthTabSync(
      getAuth(sandbox),
      authOps,
    );
  }, (e: unknown) => {
    runtimeStatus.reportError(e, 'runtime');
    const detail = e instanceof Error ? e.message : String(e);
    console.error('[pyric sandbox] auth tab sync failed:', detail);
  });
}

if (!useWorker) {
  setupInPageRulesEvents(sandbox, databaseRules, diagnostics, (err) => {
    runtimeStatus.reportError(err, 'runtime');
  });
}

// Last top-level statement: the in-page backend has loaded, so the auth entry
// runs its restore and calls inline from here on (./page-backend-wait.ts).
globalThis.__PYRIC_PAGE_BACKEND_LOADED__ = true;
