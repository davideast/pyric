/**
 * `pyric/firestore` — offline / persistence / network + cache-init family.
 *
 * The honest-mirror surface a real app's init sequence touches: persistence
 * toggles, network enable/disable, the inert cache/tab-manager/GC config
 * tokens, `initializeFirestore`, the get-from-server / get-from-cache read
 * variants, `setLogLevel`, and `onSnapshotsInSync`. Read the section note
 * below before touching any function.
 */
import { readDocument, readQuery } from './reads.js';
import { FirebaseError } from '../sandbox/internal/firebase-error.js';
import { beginFirestoreActivity } from './sdk-activity.js';
import { finishSdkRead } from '../sandbox/internal/sdk-activity.js';
import { resolveClientApp } from '../sandbox/internal/client-app.js';
import type { FirebaseApp } from '../app/types.js';
import type { Sandbox, SandboxContext } from 'pyric/sandbox';
import type { DocumentData } from 'pyric/sandbox/admin-firestore';

import { tag, targetForTermination, targetOf } from './state.js';
import {
  Firestore,
  type DocumentReference,
  type DocumentSnapshot,
  type Query,
  type QuerySnapshot,
  type Unsubscribe,
} from './types.js';
import { attachQuerySnapshotToJson } from './ssr-snapshots.js';
import { EVICT_APP_CACHE_SYMBOL } from './internal/app-cache-symbol.js';
import { getFirestore } from './instances.js';
import { clientStateFor } from './client-state.js';
import { forEachDocument } from './sandbox/for-each-document.js';
import { markHandlePersistentCache } from './cache-index-manager.js';
import {
  applySettingsCacheMode,
  assertAndRecordAppFirestoreSettings,
  type FirestoreSettings,
} from './init-settings.js';

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
    markHandlePersistentCache(db);
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
    markHandlePersistentCache(db);
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
const terminatedTargets = new WeakSet<object>();

export function clearIndexedDbPersistence(db: Firestore): Promise<void> {
  if (!(db instanceof Firestore)) {
    throw new FirebaseError(
      'invalid-argument',
      'Expected first argument to clearIndexedDbPersistence() to be a Firestore instance.',
    );
  }
  const target = targetForTermination(db);
  if (clientStateFor(target).isStarted() && !terminatedTargets.has(target as object)) {
    throw new FirebaseError(
      'failed-precondition',
      'Persistence can only be cleared before a Firestore instance is initialized or after it is terminated.',
    );
  }
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
  terminatedTargets.add(target as object);
  (target as unknown as Record<symbol, (() => void) | undefined>)[EVICT_APP_CACHE_SYMBOL]?.();
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

/**
 * Delegates to {@link getFirestore} and returns the initialized handle while
 * enforcing Firebase's synchronous `failed-precondition` guard when conflicting
 * settings are supplied after an app database slot has started.
 */
export function initializeFirestore(
  app: SandboxContext | Sandbox | FirebaseApp,
  settings?: FirestoreSettings,
  databaseId?: string,
): Firestore {
  const appRuntime = resolveClientApp(app);
  if (appRuntime) {
    assertAndRecordAppFirestoreSettings(app as object, settings, databaseId);
    const appHandle = getFirestore(app, databaseId);
    applySettingsCacheMode(appHandle, settings, databaseId, app as object);
    return appHandle;
  }
  const handle = getFirestore(app, databaseId);
  applySettingsCacheMode(handle, settings, databaseId);
  return handle;
}

/**
 * Sandbox: delegates to {@link getDoc}. The sandbox store IS the
 * authoritative, always-fresh source — there is no separate server
 * round-trip to force, so "from server" and the default read are the
 * same honest thing.
 *
 */
export async function getDocFromServer<T = DocumentData>(
  ref: DocumentReference<T>,
): Promise<DocumentSnapshot<T>> {
  return readDocument(ref, beginFirestoreActivity(targetOf(ref), ref, 'getDocFromServer', 'operation'));
}

/** Query-plural form of {@link getDocFromServer}. */
export async function getDocsFromServer<T = DocumentData>(
  query: Query<T>,
): Promise<QuerySnapshot<T>> {
  return readQuery(query, beginFirestoreActivity(targetOf(query), query, 'getDocsFromServer', 'operation'));
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
  const activity = beginFirestoreActivity(target, ref, 'getDocFromCache', 'operation');
  try {
    client.assertPathCached(ref.path);
  } catch (error) {
    activity.fail();
    return Promise.reject(error);
  }
  return readDocument(ref, activity).then((snapshot) => {
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
  const activity = beginFirestoreActivity(target, query, 'getDocsFromCache', 'operation');
  if (!client.hasCachedQuery(query as object)) {
    const emptySnap = tag({
      size: 0,
      empty: true,
      docs: [],
      forEach: forEachDocument([]),
      metadata: Object.freeze({ fromCache: true, hasPendingWrites: false }),
      toJSON: () => ({}),
    }, target) as QuerySnapshot<T>;
    attachQuerySnapshotToJson(emptySnap, target, query as object);
    return Promise.resolve(finishSdkRead(activity, emptySnap));
  }
  return readQuery(query, activity).then((snapshot) => {
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
 * by `pyric sandbox`'s own flags, not this call). Exists purely so app
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
  let cb: (() => void) | undefined;
  if (typeof observerOrCallback === 'function') {
    cb = observerOrCallback;
  } else if (typeof observerOrCallback.next === 'function') {
    cb = observerOrCallback.next.bind(observerOrCallback);
  }
  if (!cb) return () => undefined;
  const unsubscribe = state.addSnapshotsInSyncObserver(cb);
  if (!target.own) return unsubscribe;
  const release = target.own(unsubscribe);
  return () => {
    release();
    unsubscribe();
  };
}
