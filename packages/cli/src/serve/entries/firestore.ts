/**
 * The bundle the import map serves for `firebase/firestore`.
 *
 * DUAL-PATH (Phase 3c): when a SharedWorker is available, the data ops route
 * to the ONE worker-hosted sandbox (multi-tab sync + IDB/`--persist`
 * durability); otherwise they run against the in-page sandbox — the unchanged
 * fallback. The branch is picked ONCE at module load (`useWorker`).
 *
 * The COMPLETE modular surface is exported on BOTH paths: a missing named
 * export fails the page at import time (the firebase/app failure class), so the
 * worker path fills the functions the thin worker-client lacks (`or`/`and`,
 * `Timestamp`, the client-cache config no-ops) right here.
 *
 * Browser-bundled by `../bundler.ts`; never imported by node-side code.
 */
import './init.js';
import * as ip from 'pyric/firestore';
import { getFirestore as pyricGetFirestore } from 'pyric/firestore';
import * as wcRaw from '../worker/client.js';
import { useWorker } from './worker-runtime.js';
import { getApp, type FirebaseApp } from 'pyric/app';
import { workerClientForApp } from './app-client.js';

// The worker client mirrors pyric/firestore's DATA surface (same names + arg
// shapes); cast so the picked bindings type-check against the canonical module.
// Members the worker client genuinely lacks (or/and/Timestamp/cache config) are
// handled explicitly below — NOT taken from this cast.
const wc = wcRaw as unknown as typeof ip;

/** The data-path implementation chosen at load. */
const D = useWorker ? wc : ip;

// ── Data ops — route to the worker-hosted or in-page sandbox ──────────────
export const onSnapshot = D.onSnapshot;
export const collection = D.collection;
export const collectionGroup = D.collectionGroup;
export const doc = D.doc;
export const getDoc = D.getDoc;
export const getDocs = D.getDocs;
export const setDoc = D.setDoc;
export const addDoc = D.addDoc;
export const updateDoc = D.updateDoc;
export const deleteDoc = D.deleteDoc;
export const query = D.query;
export const where = D.where;
export const orderBy = D.orderBy;
export const limit = D.limit;
export const limitToLast = D.limitToLast;
export const startAt = D.startAt;
export const startAfter = D.startAfter;
export const endAt = D.endAt;
export const endBefore = D.endBefore;
export const runTransaction = D.runTransaction;
export const writeBatch = D.writeBatch;
export const serverTimestamp = D.serverTimestamp;
export const increment = D.increment;
export const arrayUnion = D.arrayUnion;
export const arrayRemove = D.arrayRemove;
export const deleteField = D.deleteField;

// ── Value class — path-independent (builds data; the worker serializes it via
//    the shared codec) ──────────────────────────────────────────────────────
export const Timestamp = ip.Timestamp;

// ── Composite filters — path-independent (issue #144). The worker query
//    protocol carries the composite filter tree end-to-end: the client `or`/
//    `and` factories emit nested `FilterConstraintDescriptor`s, `query()`
//    embeds them in the query descriptor, and the host rebuilds them through
//    the REAL `pyric/firestore` `and`/`or` factories (see
//    `worker/host.ts` resolveConstraint + `worker/protocol.ts`
//    FilterConstraintDescriptor). So on BOTH paths `or`/`and` come from the
//    chosen data impl `D` — the worker client on the worker path, in-page
//    otherwise. Nested `and`/`or`/`where` composites and composition with
//    orderBy/limit all cross intact; malformed composites (empty / non-filter
//    operand) still raise the same modular-SDK TypeError. ────────────────────
export const or = D.or;
export const and = D.and;

// ── getFirestore — the canonical bare call returns the page's shared backend:
//    the worker ClientDb on the worker path, the in-page sandbox otherwise. ──
const workerFirestoreByApp = new WeakMap<FirebaseApp, ReturnType<typeof pyricGetFirestore>>();

export const getFirestore = ((app?: FirebaseApp) => {
  const resolved = app ?? getApp();
  if (!useWorker) return pyricGetFirestore(resolved);
  const existing = workerFirestoreByApp.get(resolved);
  if (existing) return existing;
  const client = workerClientForApp(resolved);
  const handle = Object.assign(client, { app: resolved }) as unknown as ReturnType<typeof pyricGetFirestore>;
  workerFirestoreByApp.set(resolved, handle);
  return handle;
}) as typeof pyricGetFirestore;

// ── section 3c tier 2: ACCEPTED, sandbox-managed (no-op + one-time notice). ──────
// Apps configure client caching unconditionally; a missing named export
// fails the page at IMPORT time (the firebase/app failure class). None of
// these are emulated — the sandbox (in-page OR worker) IS the source of
// truth, so the client cache layer these configure has no role. Durable data
// is the worker's IDB (default) + `pyric dev --persist`. Path-independent.

let cacheNoticeShown = false;
function acceptedNoOp(name: string): void {
  if (cacheNoticeShown) return;
  cacheNoticeShown = true;
  console.info(
    `[pyric sandbox] ${name}(): client cache and persistence settings are accepted but unused. ` +
      'The Pyric sandbox is the source of truth. Durable state is the worker store or `pyric sandbox --persist`.',
  );
}

/** firebase's sentinel value, re-exported for settings parity. */
export const CACHE_SIZE_UNLIMITED = -1;

export function initializeFirestore(
  app?: Parameters<typeof pyricGetFirestore>[0],
  settings?: unknown,
): ReturnType<typeof getFirestore> {
  if (settings && Object.keys(settings as object).length > 0) acceptedNoOp('initializeFirestore');
  return getFirestore(app as never);
}

export function persistentLocalCache(_settings?: unknown): { kind: string } {
  acceptedNoOp('persistentLocalCache');
  return { kind: 'persistent' };
}

export function memoryLocalCache(_settings?: unknown): { kind: string } {
  return { kind: 'memory' };
}

export function persistentSingleTabManager(_settings?: unknown): { kind: string } {
  return { kind: 'persistentSingleTab' };
}

export function persistentMultipleTabManager(): { kind: string } {
  return { kind: 'persistentMultipleTab' };
}

export async function enableIndexedDbPersistence(_db?: unknown): Promise<void> {
  acceptedNoOp('enableIndexedDbPersistence');
}

/** No-op success, same rationale as `enableIndexedDbPersistence` — the
 *  SharedWorker path already IS the one store every tab reads/writes, so
 *  there's no separate multi-tab mode to opt into over the worker; the
 *  in-page fallback has no multi-tab story to begin with. */
export async function enableMultiTabIndexedDbPersistence(_db?: unknown): Promise<void> {
  acceptedNoOp('enableMultiTabIndexedDbPersistence');
}

export async function clearIndexedDbPersistence(_db?: unknown): Promise<void> {
  acceptedNoOp('clearIndexedDbPersistence');
}

/** Resolves immediately — sandbox writes apply synchronously in-page; over the
 *  worker the RPC ack already settled (judgment zone 4, recorded). */
export async function waitForPendingWrites(_db?: unknown): Promise<void> {}

// ── network toggles — no-op (accepted, unused). No network exists in the
//    sandbox (in-page OR worker): every op is a local call, never a request
//    that could be offline. Writes issued after `disableNetwork()` still
//    commit immediately — no offline queue is simulated, because the sandbox
//    cannot honestly deliver "queued until reconnected" with no connection to
//    lose in the first place. ───────────────────────────────────────────────
export async function disableNetwork(_db?: unknown): Promise<void> {
  acceptedNoOp('disableNetwork');
}

export async function enableNetwork(_db?: unknown): Promise<void> {
  acceptedNoOp('enableNetwork');
}

/**
 * In-page fallback: forwards to `pyric/firestore`'s `terminate`, which
 * genuinely tears the sandbox down via `Sandbox.dispose()`.
 *
 * Worker path: accepted no-op. The SharedWorker-hosted sandbox is
 * shared across every tab on the page's origin — disposing it here
 * would tear down listener registries out from under other open tabs,
 * which the real `terminate()` contract (single-instance teardown)
 * never implies. Documented divergence: over the worker, `terminate`
 * settles without tearing anything down.
 */
export async function terminate(db?: unknown): Promise<void> {
  if (useWorker) {
    console.info(
      '[pyric sandbox] terminate(): the SharedWorker-hosted sandbox is shared across every tab; ' +
        'it is not torn down by a single tab calling terminate().',
    );
    return;
  }
  return ip.terminate(db as Parameters<typeof ip.terminate>[0]);
}

// ── tier-1 cache-init + get-from-* + log-level + snapshot-sync (issue #144,
//    tier-1 pass). Aliases and honest no-op config tokens — see
//    `packages/pyric/src/firestore/index.ts`'s tier-1 section for the full
//    rationale. `memoryEagerGarbageCollector`/`memoryLruGarbageCollector` and
//    `setLogLevel` are path-independent (no data routing), so they delegate
//    straight to `pyric/firestore`. `getDocFromServer`/`getDocFromCache` and
//    their plural forms MUST route through `D` (the worker-vs-in-page pick)
//    like `getDoc`/`getDocs` above, not straight to `ip`, so they read from
//    whichever backend this page actually uses. ─────────────────────────────

export const memoryEagerGarbageCollector = ip.memoryEagerGarbageCollector;
export const memoryLruGarbageCollector = ip.memoryLruGarbageCollector;
export const setLogLevel = ip.setLogLevel;

export const getDocFromServer = D.getDoc;
export const getDocsFromServer = D.getDocs;
export const getDocFromCache = D.getDoc;
export const getDocsFromCache = D.getDocs;

/**
 * Local no-op reimplementation rather than delegating to `ip.onSnapshotsInSync`:
 * on the worker path `db` is a `ClientDb`, not a `pyric/firestore` `Firestore`
 * handle, so it doesn't carry the `TARGET_SYMBOL` brand `ip.onSnapshotsInSync`
 * dispatches on. Fires the callback once the current microtask queue settles —
 * same honest approximation as the in-page implementation — on both paths.
 */
export function onSnapshotsInSync(
  _db: unknown,
  observerOrCallback: (() => void) | { next?: () => void },
): () => void {
  const cb = typeof observerOrCallback === 'function' ? observerOrCallback : observerOrCallback.next;
  let cancelled = false;
  queueMicrotask(() => {
    if (!cancelled && cb) cb();
  });
  return () => {
    cancelled = true;
  };
}
