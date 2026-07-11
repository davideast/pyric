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
import * as ip from 'pyric/firestore';
import { getFirestore as pyricGetFirestore } from 'pyric/firestore';
import * as wcRaw from '../worker/client.js';
import { sandbox, workerDb, useWorker } from './runtime.js';

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

// ── Composite filters — in-page only. The worker query protocol has no
//    or/and yet; export a clear-error stub so the page still IMPORTS but a use
//    fails loudly (surface parity without silent wrong results). ─────────────
function unsupportedComposite(name: string): never {
  throw new Error(
    `firestore ${name}() is not supported over the pyric SharedWorker yet — ` +
      'compose separate where() constraints instead. (The in-page fallback path ' +
      'supports it on browsers without SharedWorker.)',
  );
}
export const or = (useWorker ? (() => unsupportedComposite('or')) : ip.or) as typeof ip.or;
export const and = (useWorker ? (() => unsupportedComposite('and')) : ip.and) as typeof ip.and;

// ── getFirestore — the canonical bare call returns the page's shared backend:
//    the worker ClientDb on the worker path, the in-page sandbox otherwise. ──
export const getFirestore = (
  useWorker
    ? (_app?: unknown) => workerDb!
    : (target?: Parameters<typeof pyricGetFirestore>[0]) =>
        pyricGetFirestore((target ?? sandbox) as never)
) as typeof pyricGetFirestore;

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
    `[pyric dev] ${name}(): client cache/persistence settings are accepted but unused — ` +
      'the pyric sandbox is the source of truth. Durable state is the worker store / `pyric dev --persist`.',
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
