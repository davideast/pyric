/**
 * `pyric/firestore` — offline / persistence / network + cache-init family.
 *
 * The honest-mirror surface a real app's init sequence touches: persistence
 * toggles, network enable/disable, the inert cache/tab-manager/GC config
 * tokens, `initializeFirestore`, the get-from-server / get-from-cache read
 * variants, `setLogLevel`, and `onSnapshotsInSync`. Read the section note
 * below before touching any function.
 */
import type { FirebaseApp } from '../app/types.js';
import type { Sandbox, SandboxContext } from 'pyric/sandbox';
import type { DocumentData } from 'pyric/sandbox/admin-firestore';

import { tag, targetForTermination, targetOf } from './state.js';
import type {
  Firestore,
  DocumentReference,
  DocumentSnapshot,
  Query,
  QuerySnapshot,
  Unsubscribe,
} from './types.js';
import { getFirestore } from './instances.js';
import { getDoc, getDocs } from './reads.js';
import { clientStateFor } from './client-state.js';

// ─── Tier: offline / persistence / network family (issue #144) ────────
//
// HONEST-MIRROR NOTE — read this before touching any function below.
//
// `firebase/firestore`'s persistence and network toggles exist because
// the real SDK juggles THREE tiers: an in-memory cache, an optional
// IndexedDB cache, and a server. These functions negotiate which tiers
// are active and whether the client is reachable.
//
// The sandbox store remains the local source of truth, while a per-client
// lifecycle layer models observable SDK state: network availability,
// pending acknowledgements, warmed cache entries, and snapshot metadata.
// When the host (`@pyric/cli
// serve`, or a bare `initializeSandbox()` call with persistence
// enabled) turns on IndexedDB persistence, EVERY sandbox write already
// flushes to IndexedDB by default — an app never has to ask for it.
//
// The layer deliberately models externally visible behavior rather than a
// second backend: offline writes mutate local state immediately but their
// promises remain pending until reconnect, matching application-facing SDK
// semantics without pretending the sandbox store is a remote server.
//
// Production never enters this module; package resolution leaves
// `firebase/firestore` unchanged when the sandbox is inactive.

export interface PersistenceSettings {
  forceOwnership?: boolean;
}

/**
 * Enables the persistence lifecycle before first use. As in the browser SDK,
 * initialization after another Firestore operation rejects with
 * `failed-precondition`.
 *
 */
export function enableIndexedDbPersistence(
  db: Firestore,
  persistenceSettings?: PersistenceSettings,
): Promise<void> {
  const target = targetOf(db);
  void persistenceSettings;
  try {
    clientStateFor(target).enablePersistence('single');
    return Promise.resolve();
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * Sandbox: no-op success, same rationale as {@link enableIndexedDbPersistence}.
 * Multi-tab coordination is meaningless here too: the sandbox's
 * SharedWorker path already IS the single shared store every tab talks
 * to, so there's no separate "multi-tab" mode to opt into.
 *
 */
export function enableMultiTabIndexedDbPersistence(db: Firestore): Promise<void> {
  const target = targetOf(db);
  try {
    clientStateFor(target).enablePersistence('multiple');
    return Promise.resolve();
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * Sandbox: actually clears the sandbox's persisted store via
 * `Sandbox.clearPersistence()` — the honest mapping, not a no-op. This
 * wipes the persisted blob (IndexedDB, or whatever backend
 * `enablePersistence` was configured with) while leaving in-memory
 * state untouched, matching `clearPersistence`'s own contract. It is
 * ALREADY a no-op when persistence was never enabled, so callers that
 * invoke this defensively at startup are safe either way.
 *
 * `getFirestore(ctx)` (frozen `SandboxContext`) targets don't carry a
 * live `Sandbox` handle with a `clearPersistence` method reachable the
 * same way as a `sandbox`/`sandbox-live` target's `.sandbox` field —
 * both variants do, in fact, so this always has a sandbox to call into.
 *
 * The real SDK requires this before Firestore starts; the sandbox's mapped
 * `clearPersistence()` has no such restriction.
 */
export function clearIndexedDbPersistence(db: Firestore): Promise<void> {
  const target = targetOf(db);
  return target.sandbox.clearPersistence();
}

/**
 * Sandbox: no-op success. There is no network in the sandbox — every
 * op is a local call into the in-memory/IndexedDB-backed store — so
 * there is nothing to disable. This deliberately does NOT simulate an
 * offline mode: queued writes still commit immediately rather than
 * queuing, because the sandbox cannot honestly deliver "queued until
 * reconnected" when there is no connection to lose in the first place.
 * App code that calls this to prep for flaky connectivity will not
 * crash, but it also will not observe write-queuing behavior.
 *
 */
export function disableNetwork(db: Firestore): Promise<void> {
  clientStateFor(targetOf(db)).disableNetwork();
  return Promise.resolve();
}

/**
 * Sandbox: no-op success, symmetric with {@link disableNetwork} — since
 * network was never disabled locally, there is nothing to re-enable.
 *
 */
export function enableNetwork(db: Firestore): Promise<void> {
  return clientStateFor(targetOf(db)).enableNetwork();
}

/**
 * Resolves after writes that were issued while offline receive their modeled
 * acknowledgement on reconnect.
 *
 */
export function waitForPendingWrites(db: Firestore): Promise<void> {
  return clientStateFor(targetOf(db)).waitForPendingWrites();
}

/**
 * Terminates this Firestore service target only. Held references become
 * unusable and owned listeners stop, while sibling Firestore handles and
 * other services on the same Sandbox remain alive.
 *
 */
export function terminate(db: Firestore): Promise<void> {
  const target = targetForTermination(db);
  target.terminate?.();
  return Promise.resolve();
}

// ─── Tier-1 cache-init + get-from-* + log-level + snapshot-sync ───────
// (issue #144, tier-1 pass). These extend the honest-mirror rationale
// above: a real app's explicit-init pattern —
//
//   initializeFirestore(app, {
//     localCache: persistentLocalCache(persistentMultipleTabManager()),
//   })
//
// — crashed at IMPORT (a missing named export) before this pass, before
// the app ever ran a read or write. `initializeFirestore` and the six
// cache-factory tokens below are aliases and honest no-op config
// tokens, not new feature work: the sandbox is local-first with
// persistence on by default, so there is no separate cache tier to
// configure into existence. `getDocFromServer`/`getDocFromCache` and
// their plural forms delegate to the same read path as `getDoc`/
// `getDocs` (the sandbox store IS the authoritative, always-fresh source —
// there's no cache/server split to honor). `setLogLevel` and
// `onSnapshotsInSync` round out the surface a real app's init sequence
// commonly touches alongside the persistence family.

/** Hidden brand on {@link LocalCache} tokens returned by
 *  {@link persistentLocalCache} / {@link memoryLocalCache}. Never
 *  inspected by consumer code — `initializeFirestore` accepts the
 *  token but the cache/network settings it carries are no-ops. */
const LOCAL_CACHE_SYMBOL: unique symbol = Symbol('pyric/firestore/localCache');
/** Hidden brand on tab-manager tokens returned by
 *  {@link persistentSingleTabManager} / {@link persistentMultipleTabManager}. */
const TAB_MANAGER_SYMBOL: unique symbol = Symbol('pyric/firestore/tabManager');
/** Hidden brand on garbage-collector tokens returned by
 *  {@link memoryEagerGarbageCollector} / {@link memoryLruGarbageCollector}. */
const GC_SYMBOL: unique symbol = Symbol('pyric/firestore/gc');

/** Opaque tab-manager config token. Inert — persistence is always on,
 *  and the SharedWorker/`pyric dev` path already is the one shared
 *  store every tab talks to, so there is no separate multi-tab mode
 *  to opt into. Carries the requested kind only for debugging. */
export interface PersistentTabManager {
  readonly [TAB_MANAGER_SYMBOL]: 'single' | 'multiple';
}

/** Opaque garbage-collector config token. Inert for the same reason —
 *  there is no memory cache tier with GC pressure to tune. */
export interface MemoryGarbageCollector {
  readonly [GC_SYMBOL]: 'eager' | 'lru';
}

/** Opaque local-cache config token accepted by {@link initializeFirestore}'s
 *  `settings.localCache`. Inert — see the tier-1 section rationale above. */
export interface LocalCache {
  readonly [LOCAL_CACHE_SYMBOL]: 'persistent' | 'memory';
  readonly tabManager?: PersistentTabManager;
  readonly garbageCollector?: MemoryGarbageCollector;
}

/**
 * Inert config token. Real Firebase uses this to select an on-disk,
 * persistent IndexedDB cache tier; the sandbox has no separate cache
 * tier — persistence is already the default — so this just returns a
 * tagged token `initializeFirestore` can accept without crashing.
 */
export function persistentLocalCache(settings?: {
  tabManager?: PersistentTabManager;
  cacheSizeBytes?: number;
}): LocalCache {
  return { [LOCAL_CACHE_SYMBOL]: 'persistent', tabManager: settings?.tabManager };
}

/** Inert config token — the memory-cache counterpart of {@link persistentLocalCache}. */
export function memoryLocalCache(settings?: {
  garbageCollector?: MemoryGarbageCollector;
}): LocalCache {
  return { [LOCAL_CACHE_SYMBOL]: 'memory', garbageCollector: settings?.garbageCollector };
}

/** Inert config token accepted by {@link persistentLocalCache}'s `tabManager`. */
export function persistentSingleTabManager(
  _settings?: { forceOwnership?: boolean },
): PersistentTabManager {
  return { [TAB_MANAGER_SYMBOL]: 'single' };
}

/** Inert config token accepted by {@link persistentLocalCache}'s `tabManager`. */
export function persistentMultipleTabManager(): PersistentTabManager {
  return { [TAB_MANAGER_SYMBOL]: 'multiple' };
}

/** Inert config token accepted by {@link memoryLocalCache}'s `garbageCollector`. */
export function memoryEagerGarbageCollector(): MemoryGarbageCollector {
  return { [GC_SYMBOL]: 'eager' };
}

/** Inert config token accepted by {@link memoryLocalCache}'s `garbageCollector`. */
export function memoryLruGarbageCollector(
  _settings?: { cacheSizeBytes?: number },
): MemoryGarbageCollector {
  return { [GC_SYMBOL]: 'lru' };
}

export type FirestoreLocalCache = LocalCache;
export type PersistentLocalCache = LocalCache & { readonly [LOCAL_CACHE_SYMBOL]: 'persistent' };
export type MemoryLocalCache = LocalCache & { readonly [LOCAL_CACHE_SYMBOL]: 'memory' };
export type PersistentMultipleTabManager = PersistentTabManager & { readonly [TAB_MANAGER_SYMBOL]: 'multiple' };
export type PersistentSingleTabManager = PersistentTabManager & { readonly [TAB_MANAGER_SYMBOL]: 'single' };
export interface PersistentSingleTabManagerSettings { forceOwnership?: boolean; }
export interface PersistentCacheSettings { tabManager?: PersistentTabManager; cacheSizeBytes?: number; }
export interface MemoryCacheSettings { garbageCollector?: MemoryGarbageCollector; }
export type MemoryEagerGarbageCollector = MemoryGarbageCollector & { readonly [GC_SYMBOL]: 'eager' };
export type MemoryLruGarbageCollector = MemoryGarbageCollector & { readonly [GC_SYMBOL]: 'lru' };
export interface IndexField { fieldPath: string; order?: 'ascending' | 'descending'; arrayConfig?: 'contains'; }
export interface Index { collectionGroup: string; fields?: IndexField[]; }
export interface IndexConfiguration { indexes?: Index[]; fieldOverrides?: unknown[]; }

export class PersistentCacheIndexManager {
  constructor(private readonly _db: Firestore) {}
  async enableIndexAutoCreation(): Promise<void> {}
  async disableIndexAutoCreation(): Promise<void> {}
  async deleteAllIndexes(): Promise<void> {}
}

export function getPersistentCacheIndexManager(db: Firestore): PersistentCacheIndexManager | null {
  return new PersistentCacheIndexManager(db);
}

export async function enablePersistentCacheIndexAutoCreation(indexManager: PersistentCacheIndexManager): Promise<void> {
  return indexManager.enableIndexAutoCreation();
}

export async function disablePersistentCacheIndexAutoCreation(indexManager: PersistentCacheIndexManager): Promise<void> {
  return indexManager.disableIndexAutoCreation();
}

export async function deleteAllPersistentCacheIndexes(indexManager: PersistentCacheIndexManager): Promise<void> {
  return indexManager.deleteAllIndexes();
}

export async function setIndexConfiguration(db: Firestore, configuration: IndexConfiguration | string): Promise<void> {
  void db; void configuration;
}


/** Client-cache/network settings `initializeFirestore` accepts but no-ops
 *  on sandbox targets — see the tier-1 section rationale above. */
export interface FirestoreSettings {
  localCache?: LocalCache;
  cacheSizeBytes?: number;
  ignoreUndefinedProperties?: boolean;
  experimentalForceLongPolling?: boolean;
  experimentalAutoDetectLongPolling?: boolean;
  host?: string;
  ssl?: boolean;
}

/**
 * Delegates to {@link getFirestore} and returns the same handle. Accepts
 * the `settings` argument (so the explicit-init pattern app code commonly
 * writes — `initializeFirestore(app, { localCache: persistentLocalCache(...) } )`
 * — no longer crashes at import) but no-ops the cache/network settings:
 * persistence is already the sandbox default, so there is nothing left to
 * configure into existence.
 *
 */
export function initializeFirestore(
  app: SandboxContext | Sandbox | FirebaseApp,
  _settings?: FirestoreSettings,
  _databaseId?: string,
): Firestore {
  return getFirestore(app);
}

/**
 * Sandbox: delegates to {@link getDoc}. The sandbox store IS the
 * authoritative, always-fresh source — there is no separate server
 * round-trip to force, so "from server" and the default read are the
 * same honest thing.
 *
 */
export function getDocFromServer<T = DocumentData>(
  ref: DocumentReference<T>,
): Promise<DocumentSnapshot<T>> {
  return getDoc(ref);
}

/** Query-plural form of {@link getDocFromServer}. */
export function getDocsFromServer<T = DocumentData>(
  query: Query<T>,
): Promise<QuerySnapshot<T>> {
  return getDocs(query);
}

/**
 * Sandbox: delegates to {@link getDoc}. Real Firebase THROWS
 * `'unavailable'` here on a cache miss (nothing local matches the
 * ref); pyric never misses — the local store always has whatever is
 * there — so this never throws for that reason. Documented divergence,
 * not a claim of parity.
 *
 */
export function getDocFromCache<T = DocumentData>(
  ref: DocumentReference<T>,
): Promise<DocumentSnapshot<T>> {
  const target = targetOf(ref);
  const client = clientStateFor(target);
  try {
    client.assertPathCached(ref.path);
  } catch (error) {
    return Promise.reject(error);
  }
  return getDoc(ref).then((snapshot) => {
    Object.defineProperty(snapshot, 'metadata', {
      value: Object.freeze({
        fromCache: true,
        hasPendingWrites: client.snapshotMetadata(ref.path).hasPendingWrites,
      }),
      configurable: true,
    });
    return snapshot;
  });
}

/** Query-plural form of {@link getDocFromCache} — same cache-miss divergence. */
export function getDocsFromCache<T = DocumentData>(
  query: Query<T>,
): Promise<QuerySnapshot<T>> {
  const target = targetOf(query);
  const client = clientStateFor(target);
  if (!client.hasCachedQuery(query as object)) {
    return Promise.resolve(tag({
      size: 0,
      empty: true,
      docs: [],
      metadata: Object.freeze({ fromCache: true, hasPendingWrites: false }),
    }, target));
  }
  return getDocs(query).then((snapshot) => {
    Object.defineProperty(snapshot, 'metadata', {
      value: Object.freeze({
        fromCache: true,
        hasPendingWrites: client.querySnapshotMetadata().hasPendingWrites,
      }),
      configurable: true,
    });
    return snapshot;
  });
}

/** Mirrors `firebase/firestore`'s `LogLevel` union. */
export type LogLevel = 'debug' | 'verbose' | 'info' | 'warn' | 'error' | 'silent';

/**
 * Accepted no-op: the sandbox has no modular-SDK-style logger to wire
 * a level into (it uses host-level `console` logging directly, gated
 * by `pyric dev`'s own flags, not this call). Exists purely so app
 * code that calls this defensively at startup doesn't crash on a
 * missing export.
 */
export function setLogLevel(logLevel: LogLevel): void {
  void logLevel;
}

/**
 * Registers a service-scoped synchronization observer. It receives an
 * initial signal and a batched signal after snapshot listeners deliver their
 * latest local state, matching the production-observed callback ordering.
 *
 */
export function onSnapshotsInSync(
  db: Firestore,
  observerOrCallback: (() => void) | { next?: () => void; complete?: () => void; error?: (error: unknown) => void },
): Unsubscribe {
  const target = targetOf(db);
  const state = clientStateFor(target);
  state.markStarted();
  const cb = typeof observerOrCallback === 'function' ? observerOrCallback : observerOrCallback.next;
  if (!cb) return () => undefined;
  const unsubscribe = state.addSnapshotsInSyncObserver(cb);
  if (!target.own) return unsubscribe;
  const release = target.own(unsubscribe);
  return () => {
    release();
    unsubscribe();
  };
}
