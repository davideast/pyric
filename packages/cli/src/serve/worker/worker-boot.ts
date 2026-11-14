import { getAuth } from 'pyric/auth';
import { getDatabase } from 'pyric/database';
import { getFirestore } from 'pyric/firestore';
import type { PersistenceBackend } from 'pyric/sandbox';
import { createSandboxRoot, EventHistory, primeEventHistory } from 'pyric/sandbox/internal';
import { primeStorageDeniedWrites } from 'pyric/storage/internal';
import type { PyricVerifyFixture } from '../../verify/fixture.js';
import { setupAiDiagnosticsRelay } from '../ai-diagnostics-relay.js';
import type { InitPayload } from '../namespace.js';
import { SERVE_HISTORY_LIMITS } from '../observation-limits.js';
import { setupFirebaseActivityGuard } from './activity-bootstrap.js';
import { createWorkerDurableBackend, setupServerAuthFlush } from './durable-persistence.js';
import { getOrCreateInstanceId, type HostCtx } from './host.js';
import {
  applyServeInit,
  setupWorkerHotReload,
  type EventSourceLike,
  type ServeInitEnv,
} from './serve-init.js';

/**
 * Cap on the number of events primed on boot. A long-lived session can
 * accumulate a large capture; a fresh worker only needs enough recent history
 * for Traffic / activity / metrics to feel continuous, so we prime the most
 * recent N and drop older events rather than balloon worker memory with the
 * whole log. The full log still lives on disk for `pyric verify`.
 */
export const MAX_PRIMED_EVENTS = 2000;

/**
 * Re-hydrate the worker's in-memory event history from the served capture
 * file on boot — the fix for "worker death zeroes Traffic / activity / metrics
 * even though the data restored from IDB".
 *
 * Returns the number of events primed (0 when skipped).
 */
export async function hydrateEventHistory(
  ctx: HostCtx,
  env: ServeInitEnv,
  sessionToken?: string,
): Promise<number> {
  let res: Response;
  try {
    const headers: Record<string, string> = {};
    if (sessionToken !== undefined) {
      headers['x-pyric-session-token'] = sessionToken;
    }
    res = await env.fetch('/__pyric/capture', { headers });
  } catch {
    return 0;
  }
  if (res.status !== 200) return 0;

  let fixture: PyricVerifyFixture;
  try {
    fixture = JSON.parse(await res.text()) as PyricVerifyFixture;
  } catch {
    return 0;
  }

  const events = fixture.events;
  if (!Array.isArray(events) || events.length === 0) return 0;

  const isOtherInstance = Boolean(fixture.capturedBy) && fixture.capturedBy !== ctx.instanceId;
  if (isOtherInstance) return 0;

  const retained = new EventHistory({ ...SERVE_HISTORY_LIMITS, maxEvents: MAX_PRIMED_EVENTS });
  for (const event of events) retained.append(event);
  const primed = primeEventHistory(ctx.sandbox, retained.snapshot());
  if (primed > 0) {
    primeStorageDeniedWrites(ctx.sandbox, fixture.storageDeniedWrites);
  }
  return primed;
}

/** Legacy shared persistence key — also the IndexedDB database name. */
export const WORKER_PERSISTENCE_KEY = 'pyric-shared-worker';

/**
 * Resolve the worker's persistence key (= IndexedDB database name) for a
 * project identity: `pyric-shared-worker:<projectKey>`, or the legacy shared
 * {@link WORKER_PERSISTENCE_KEY} when none is available.
 */
export function workerPersistenceKey(projectKey?: string | null): string {
  return projectKey ? `${WORKER_PERSISTENCE_KEY}:${projectKey}` : WORKER_PERSISTENCE_KEY;
}

const PERMISSIVE_RULES = `
  rules_version = '2';
  service cloud.firestore {
    match /databases/{database}/documents {
      match /{document=**} {
        allow read, write: if true;
      }
    }
  }
`;

/** Environment for {@link buildWorkerCtx}. */
export interface WorkerBootEnv extends ServeInitEnv {
  idb: PersistenceBackend;
  persistenceKey?: string;
  makeEventSource?: ((url: string) => EventSourceLike) | null;
  sessionToken?: string;
}

/**
 * Build the ONE shared sandbox + Firestore handle — the SharedWorker's boot
 * path, extracted from `entry.ts` so it is testable without a SharedWorker
 * runtime.
 */
export async function buildWorkerCtx(bootEnv: WorkerBootEnv): Promise<HostCtx> {
  const ambientFetch = bootEnv.fetch;
  const env: WorkerBootEnv = {
    ...bootEnv,
    fetch: ((...args: Parameters<typeof fetch>) => ambientFetch(...args)) as typeof fetch,
  };
  const sandbox = createSandboxRoot(SERVE_HISTORY_LIMITS);

  const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  const adminDb = getAdminFirestore(sandbox.withAuth(null));
  adminDb.setRules(PERMISSIVE_RULES);

  const payload = await fetchInitPayload(env.fetch, env.sessionToken);

  const hasPayload = payload !== null;
  let durable: PersistenceBackend = env.idb;
  if (hasPayload) {
    durable = createWorkerDurableBackend(env.idb, payload, env);
  }
  await sandbox.enablePersistence({
    key: env.persistenceKey ?? workerPersistenceKey(payload?.projectKey),
    injectedBackend: durable,
  });

  getAuth(sandbox);
  getDatabase(sandbox);

  const db = getFirestore(sandbox);
  const resolvedToken = payload?.sessionToken ?? env.sessionToken;
  const ctx: HostCtx = {
    db,
    sandbox,
    instanceId: await getOrCreateInstanceId(env.idb),
    subs: new Map(),
    sessionBackend: env.idb,
    sessionMode: 'LOCAL',
  };
  if (resolvedToken) {
    ctx.sessionToken = resolvedToken;
  }

  if (payload?.capture === true) {
    try {
      await hydrateEventHistory(ctx, env, resolvedToken);
    } catch {
      /* activity-log hydration is non-essential; never brick boot over it. */
    }
  }

  if (payload?.ai?.engine !== undefined) {
    ctx.aiEngine = payload.ai.engine;
  }

  setupFirebaseActivityGuard(ctx, env, payload?.activityToken);
  setupAiDiagnosticsRelay(
    { subscribe: (listener) => ctx.sandbox.onEvent(listener) },
    env.fetch,
    () => ctx.sessionToken,
  );

  if (hasPayload) {
    applyServeInit(ctx, payload, env);
    setupServerAuthFlush(ctx, payload, env);
  }

  const makeEventSource = env.makeEventSource;
  if (typeof makeEventSource === 'function') {
    setupWorkerHotReload(ctx, makeEventSource);
  }

  return ctx;
}

async function fetchInitPayload(fetchFn: typeof fetch, sessionToken?: string): Promise<InitPayload | null> {
  try {
    let res: Response;
    if (sessionToken) {
      res = await fetchFn('/__pyric/init.json', { headers: { 'x-pyric-session-token': sessionToken } });
    } else {
      res = await fetchFn('/__pyric/init.json');
    }
    if (!res.ok) return null;
    return (await res.json()) as InitPayload;
  } catch {
    return null;
  }
}
