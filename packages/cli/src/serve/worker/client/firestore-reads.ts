/**
 * Firestore read execution -- document/collection reads, keyspace enumeration,
 * count/aggregate reads, and the `onSnapshot` listener. Each RPCs the worker and
 * rehydrates the reply into the modular SDK's snapshot shapes.
 */

import {
  decodeAggregateData,
  type TargetDescriptor,
  type AggregateFieldDescriptor,
  type AggregateSpecDescriptor,
  type InboundMessage,
} from '../protocol.js';
import { closeSubscription, nextId, nextSubId, _defaultLens, subscribeLens, stampIssuer } from './core.js';
import {
  clientDatabaseIdOf,
  firestoreDataRpc,
  openFirestoreSnapshotSubscription,
} from './firestore-database.js';
import type { ClientDb, DocRefHandle, CollRefHandle, QueryHandle, Unsubscribe } from './handles.js';
import { assertExecutableQueryDescriptor } from './firestore-query-validation.js';
import { pageListenerOwners } from './listener-owners.js';
import { deliverWithRegions } from './listener-delivery.js';
import { makeDocSnapshot, makeQuerySnapshot, makeSnapshot } from './snapshots.js';
import {
  buildWorkerOfflineWire,
  isWorkerFirestoreOffline,
  isWorkerTargetWarm,
  readWorkerOfflineDoc,
  recordWorkerOnlineDoc,
  registerWorkerManagedListener,
} from './firestore-network.js';
import {
  assertWorkerFirestoreActive,
  markWorkerHandleStarted,
  registerWorkerOwnedListener,
} from './firestore-lifecycle.js';
import { readWorkerDocFromCache, readWorkerQueryFromCache } from './firestore-cache-reads.js';
import { beginWorkerFirestoreActivity } from './sdk-activity.js';
import { finishSdkRead, type UsageEvidence } from 'pyric/sandbox/internal';
import type { RawDocResult, RawQueryResult, ClientDocSnapshot, ClientQuerySnapshot, QueryChangeBaseline } from './snapshots.js';
import type { DocumentData, FieldPath } from 'pyric/firestore';

// --- Execution functions (RPC) --------------------------------------------

export function getDoc<T = DocumentData>(ref: DocRefHandle<T>): Promise<ClientDocSnapshot<T>> {
  return readDocumentAs(ref, 'getDoc');
}

export async function readDocumentAs<T = DocumentData>(ref: DocRefHandle<T>, method: string): Promise<ClientDocSnapshot<T>> {
  if (method === 'getDocFromCache') {
    return readWorkerDocFromCache(ref);
  }
  assertWorkerFirestoreActive(ref);
  markWorkerHandleStarted(ref);
  const activity = beginWorkerFirestoreActivity(ref, method, 'operation');
  try {
    const dbId = clientDatabaseIdOf(ref);
    const offlineDoc = readWorkerOfflineDoc(ref.port, ref.descriptor.path, dbId);
    if (offlineDoc !== undefined) {
      const offlineMeta = Object.freeze({
        fromCache: true,
        hasPendingWrites: offlineDoc.hasPendingWrites === true,
      });
      return finishSdkRead(activity, makeDocSnapshot(offlineDoc, ref.port, ref, offlineMeta));
    }
    const result = await firestoreDataRpc(ref, {
      t: 'op',
      id: nextId(),
      method: 'getDoc',
      path: ref.descriptor.path,
    }) as RawDocResult;
    recordWorkerOnlineDoc(ref.port, ref.descriptor.path, result.exists, result.data, dbId);
    return finishSdkRead(activity, makeDocSnapshot(result, ref.port, ref));
  } catch (error) { activity.fail(); throw error; }
}

export function getDocs(source: CollRefHandle | QueryHandle): Promise<ClientQuerySnapshot> {
  return readQueryAs(source, 'getDocs');
}

function assertExecutableTarget(target: DocRefHandle | CollRefHandle | QueryHandle): void {
  if (target.__kind === 'query') {
    assertExecutableQueryDescriptor(target.descriptor.constraints);
  }
}

export async function readQueryAs(source: CollRefHandle | QueryHandle, method: string): Promise<ClientQuerySnapshot> {
  if (method === 'getDocsFromCache') {
    return readWorkerQueryFromCache(source);
  }
  assertWorkerFirestoreActive(source);
  markWorkerHandleStarted(source);
  const activity = beginWorkerFirestoreActivity(source, method, 'operation');
  try {
    assertExecutableTarget(source);
    let sourceDescriptor: TargetDescriptor = (source as QueryHandle).descriptor;
    if (source.__kind === 'coll-ref') {
      sourceDescriptor = (source as CollRefHandle).descriptor;
    }
    const dbId = clientDatabaseIdOf(source);
    const result = await firestoreDataRpc(source, {
      t: 'op',
      id: nextId(),
      method: 'getDocs',
      source: sourceDescriptor,
    }) as RawQueryResult;
    for (const d of result.docs) {
      if (d.path !== undefined) {
        recordWorkerOnlineDoc(source.port, d.path, d.exists, d.data, dbId);
      }
    }
    return finishSdkRead(
      activity,
      makeQuerySnapshot(result, source.port, source.converter, undefined, sourceDescriptor),
    );
  } catch (error) { activity.fail(); throw error; }
}

/**
 * Enumerate root collection ids (Pyric Studio data browse). The modular SDK has
 * no client `listCollections`, so the host scans the sandbox keyspace and
 * returns the ids. Lens is attached (via dataRpc) but the host enumeration is
 * lens-independent.
 */
export async function listRootCollections(db: ClientDb): Promise<string[]> {
  const r = (await firestoreDataRpc(db, {
    t: 'op',
    id: nextId(),
    method: 'listRootCollections',
  })) as { ids: string[] };
  return r.ids;
}

/** Enumerate subcollection ids under a document path (Pyric Studio data browse). */
export async function listSubcollections(db: ClientDb, docPath: string): Promise<string[]> {
  const r = (await firestoreDataRpc(db, {
    t: 'op',
    id: nextId(),
    method: 'listSubcollections',
    docPath,
  })) as { ids: string[] };
  return r.ids;
}

export async function getCountFromServer(
  source: CollRefHandle | QueryHandle,
): Promise<{ readonly type: 'AggregateQuerySnapshot'; readonly query: CollRefHandle | QueryHandle; data(): { count: number } }> {
  assertWorkerFirestoreActive(source);
  markWorkerHandleStarted(source);
  const activity = beginWorkerFirestoreActivity(source, 'getCountFromServer', 'operation');
  try {
    assertExecutableTarget(source);
    const result = await firestoreDataRpc(source, {
      t: 'op',
      id: nextId(),
      method: 'count',
      source: source.__kind === 'coll-ref'
        ? (source as CollRefHandle).descriptor
        : (source as QueryHandle).descriptor,
    }) as { count: number };
    return finishSdkRead(activity, {
      type: 'AggregateQuerySnapshot',
      query: source,
      data: () => ({ count: result.count }),
    });
  } catch (error) { activity.fail(); throw error; }
}

// --- Multi-field aggregates (count / sum / average) -----------------------

function normalizeAggregateField(field: string | FieldPath): { field: string; path?: readonly string[] } {
  if (typeof field === 'string') return { field };
  const segments = field._internalPath.segments;
  const joined = segments.join('.');
  if (segments.some((s) => s.includes('.'))) {
    return { field: joined, path: segments };
  }
  return { field: joined };
}

/** Factory: count() aggregate field. Mirrors `pyric/firestore`'s `count()`. */
export function count(): AggregateFieldDescriptor {
  return { type: 'AggregateField', aggregateType: 'count', kind: 'count' };
}

/** Factory: sum-of-`field` aggregate. Mirrors `pyric/firestore`'s `sum()`. */
export function sum(field: string | FieldPath): AggregateFieldDescriptor {
  const normalized = normalizeAggregateField(field);
  return { type: 'AggregateField', aggregateType: 'sum', kind: 'sum', ...normalized };
}

/** Factory: average-of-`field` aggregate. Empty input yields `null`. */
export function average(field: string | FieldPath): AggregateFieldDescriptor {
  const normalized = normalizeAggregateField(field);
  return { type: 'AggregateField', aggregateType: 'avg', kind: 'average', ...normalized };
}

/**
 * Run a multi-field aggregate on the worker. Mirrors `pyric/firestore`'s
 * `getAggregateFromServer(query, spec)`: spec entries are keyed by
 * caller-chosen aliases; `.data()` returns the numbers under the same keys
 * (`average` over no rows is `null`).
 */
export async function getAggregateFromServer<S extends AggregateSpecDescriptor>(
  source: CollRefHandle | QueryHandle,
  spec: S,
): Promise<{ readonly type: 'AggregateQuerySnapshot'; readonly query: CollRefHandle | QueryHandle; data(): { [K in keyof S]: number | null } }> {
  assertWorkerFirestoreActive(source);
  markWorkerHandleStarted(source);
  const activity = beginWorkerFirestoreActivity(source, 'getAggregateFromServer', 'operation');
  try {
    assertExecutableTarget(source);
    let targetDescriptor: TargetDescriptor;
    if (source.__kind === 'coll-ref') {
      targetDescriptor = (source as CollRefHandle).descriptor;
    } else {
      targetDescriptor = (source as QueryHandle).descriptor;
    }
    const result = await firestoreDataRpc(source, {
      t: 'op',
      id: nextId(),
      method: 'aggregate',
      source: targetDescriptor,
      spec,
    }) as { data: { [K in keyof S]: number | null }; encodedData?: Record<string, unknown> };
    const decoded = decodeAggregateData(result.data, result.encodedData);
    return finishSdkRead(activity, {
      type: 'AggregateQuerySnapshot',
      query: source,
      data: () => decoded,
    });
  } catch (error) { activity.fail(); throw error; }
}

// --- onSnapshot ----------------------------------------------------------

type SnapshotCallback = (snap: ClientDocSnapshot | ClientQuerySnapshot) => void;
type SnapshotErrorCallback = (err: unknown) => void;

/** Production's `PartialObserver`: any of `next`, `error` and `complete`. */
interface SnapshotObserver {
  next?: SnapshotCallback;
  error?: SnapshotErrorCallback;
  complete?: () => void;
}

type ObserverOrNext = SnapshotObserver | SnapshotCallback;

interface ListenerArguments {
  readonly options: object | undefined;
  readonly next: SnapshotCallback | undefined;
  readonly error: SnapshotErrorCallback | undefined;
}

/**
 * An observer is an object with at least one of `next`, `error` or
 * `complete` as a function, as the SDK's `isPartialObserver` decides; any
 * other object in the second slot is listen options.
 */
function isPartialObserver(value: unknown): value is SnapshotObserver {
  const isObject = typeof value === 'object' && value !== null;
  if (!isObject) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.next === 'function'
    || typeof candidate.error === 'function'
    || typeof candidate.complete === 'function';
}

/**
 * Read the four call forms: `(next, error?)`, `(observer)`, `(options, next,
 * error?)` and `(options, observer)`. `complete` is never called: production
 * does not end an `onSnapshot` stream, and `unsubscribe` is not an end
 * (observation `firestore-row-84-observer-object-form`).
 */
function listenerArguments(second: unknown, third: unknown, fourth: unknown): ListenerArguments {
  const isOptions = typeof second === 'object' && second !== null && !isPartialObserver(second);
  const options = isOptions ? second : undefined;
  const handler = isOptions ? third : second;
  const trailingError = isOptions ? fourth : third;
  if (isPartialObserver(handler)) {
    return { options, next: handler.next?.bind(handler), error: handler.error?.bind(handler) };
  }
  return {
    options,
    next: handler as SnapshotCallback | undefined,
    error: trailingError as SnapshotErrorCallback | undefined,
  };
}

/** The SDK logs a listen error nobody observes instead of throwing it. */
function reportUncaughtListenError(error: unknown): void {
  console.error('pyric/firestore: Uncaught Error in snapshot listener:', error);
}

/**
 * Subscribe to a document or query. Mirrors `pyric/firestore`'s `onSnapshot`
 * in all four call forms, with a callback or an observer, with or without
 * options first: `@pyric/ui`'s hooks pass `{ owner }` there for listener
 * attribution, and a caller injecting this client as the hooks' backend must
 * not lose its callback to that slot. The owners are derived here, on the page
 * whose stack and DOM they describe, and travel with the subscribe message.
 *
 * Returns an `unsub` function. Sends `{ t:'unsub', subId }` to the worker
 * to deregister the listener on the worker side.
 */
export function onSnapshot(
  target: DocRefHandle | CollRefHandle | QueryHandle,
  observerOrNext: ObserverOrNext,
  errorCallback?: SnapshotErrorCallback,
): Unsubscribe;
export function onSnapshot(
  target: DocRefHandle | CollRefHandle | QueryHandle,
  options: object,
  observerOrNext: ObserverOrNext,
  errorCallback?: SnapshotErrorCallback,
): Unsubscribe;
export function onSnapshot(
  target: DocRefHandle | CollRefHandle | QueryHandle,
  second: object | ObserverOrNext,
  third?: ObserverOrNext | SnapshotErrorCallback,
  fourth?: SnapshotErrorCallback,
): Unsubscribe {
  assertWorkerFirestoreActive(target);
  assertExecutableTarget(target);
  const { options: listenOptions, next: callback, error: errorCallback } = listenerArguments(second, third, fourth);
  const reportError = errorCallback ?? reportUncaughtListenError;
  // Derived before the message is built: `captureCreationFrame` reads the
  // stack this call is still on.
  const owners = pageListenerOwners(listenOptions);
  const includeMetadataChanges = (listenOptions as { includeMetadataChanges?: unknown } | undefined)
    ?.includeMetadataChanges === true;
  // Kept across lens resubscriptions: the host's fresh snapshot after a
  // resubscribe is diffed against what this listener last delivered.
  const baseline: QueryChangeBaseline = { excludesMetadataChanges: !includeMetadataChanges };
  let currentSubId = nextSubId();
  const port = target.port;
  markWorkerHandleStarted(target);
  const activity = beginWorkerFirestoreActivity(target, 'onSnapshot', 'subscription', owners);
  activity.transport(currentSubId);

  let unsubscribed = false;
  let unsubLens: () => void = () => {};
  let unregisterNetwork: () => void = () => {};
  let deliveredCount = 0;
  let isOpenOnHost = false;
  const targetDbId = clientDatabaseIdOf(target);
  const descriptor = target.descriptor;
  const hasWarmCacheAtSubscribe = !isWorkerFirestoreOffline(port)
    && isWorkerTargetWarm(port, descriptor, targetDbId);
  const wasWarmAtSubscribe = includeMetadataChanges && hasWarmCacheAtSubscribe;

  const deliverRawFrame = (raw: unknown): void => {
    let decoded: ClientDocSnapshot | ClientQuerySnapshot | null;
    try {
      decoded = makeSnapshot(raw, port, target.converter, baseline);
    } catch (error) {
      stop();
      reportError(error);
      return;
    }
    if (decoded === null) return;
    const rawRec = raw as { fromCache?: boolean; docs?: RawDocResult[]; path?: string; exists?: boolean; data?: RawDocResult['data'] };
    if (rawRec.fromCache !== true) {
      if (Array.isArray(rawRec.docs)) {
        for (const d of rawRec.docs) {
          if (d.path !== undefined) recordWorkerOnlineDoc(port, d.path, d.exists, d.data, targetDbId);
        }
      } else if (typeof rawRec.path === 'string' && typeof rawRec.exists === 'boolean') {
        recordWorkerOnlineDoc(port, rawRec.path, rawRec.exists, rawRec.data, targetDbId);
      }
    }
    const snapshot = decoded;
    const result = raw as { usage?: UsageEvidence };
    activity.delivered(snapshot, result.usage);
    const deliver = callback;
    const hasNext = deliver !== undefined;
    if (hasNext) deliverWithRegions(activity.id, () => deliver(snapshot));
    notifyWorkerSnapshotDelivered(port);
  };

  const subscription = {
    port,
    service: 'firestore' as const,
    next: (raw: unknown) => {
      if (unsubscribed || isWorkerFirestoreOffline(port)) return;
      if (deliveredCount === 0 && wasWarmAtSubscribe && raw !== null && typeof raw === 'object') {
        const frame = raw as { hasPendingWrites?: boolean; docs?: unknown[]; exists?: boolean };
        const hasCachedContent = (Array.isArray(frame.docs) && frame.docs.length > 0) || frame.exists === true;
        if (hasCachedContent && frame.hasPendingWrites !== true) {
          const baseFrame = raw as Record<string, unknown>;
          deliveredCount += 1;
          deliverRawFrame({ ...baseFrame, fromCache: true });
          queueMicrotask(() => {
            if (unsubscribed || isWorkerFirestoreOffline(port)) return;
            deliveredCount += 1;
            deliverRawFrame({ ...baseFrame, fromCache: false });
          });
          return;
        }
      }
      deliveredCount += 1;
      deliverRawFrame(raw);
    },
    error: (error: unknown) => {
      if (unsubscribed || isWorkerFirestoreOffline(port)) return;
      if (deliveredCount === 0 && hasWarmCacheAtSubscribe) {
        const cachedWire = buildWorkerOfflineWire(port, descriptor, targetDbId);
        const cachedRec = cachedWire as { docs?: RawDocResult[]; exists?: boolean };
        const hasCachedDocs = (Array.isArray(cachedRec.docs) && cachedRec.docs.length > 0)
          || cachedRec.exists === true;
        if (hasCachedDocs) {
          deliveredCount += 1;
          deliverRawFrame(cachedWire);
          if (unsubscribed) return;
        }
      }
      unsubscribed = true;
      releaseLifecycle();
      unregisterNetwork();
      unsubLens();
      activity.fail();
      reportError(error);
    },
    close: () => activity.close(),
  };

  function subscribe(): boolean {
    const message: InboundMessage = { t: 'sub', subId: currentSubId, target: descriptor };
    const hasLens = _defaultLens !== undefined;
    if (hasLens) message.actAs = _defaultLens;
    const hasOwners = owners !== undefined;
    if (hasOwners) message.owners = owners;
    if (includeMetadataChanges) message.includeMetadataChanges = true;
    const opened = openFirestoreSnapshotSubscription(
      target,
      port,
      currentSubId,
      subscription,
      stampIssuer(message),
    );
    isOpenOnHost = opened;
    const failedToOpen = !opened;
    if (failedToOpen) activity.fail();
    const reportsDeletedApp = !opened && errorCallback !== undefined;
    if (reportsDeletedApp) queueMicrotask(() => errorCallback(new Error('Firebase App was deleted')));
    return opened;
  }

  unregisterNetwork = registerWorkerManagedListener(port, {
    target: descriptor,
    databaseId: targetDbId,
    hasDelivered: () => deliveredCount > 0,
    suspendFromHost: () => {
      if (!isOpenOnHost) return;
      isOpenOnHost = false;
      closeSubscription(port, currentSubId);
    },
    resumeOnHost: () => {
      if (unsubscribed || isOpenOnHost) return;
      currentSubId = nextSubId();
      activity.transport(currentSubId);
      subscribe();
    },
    deliverOfflineWire: (wire) => {
      if (unsubscribed || !isWorkerFirestoreOffline(port)) return;
      deliveredCount += 1;
      deliverRawFrame(wire);
    },
  });

  if (!isWorkerFirestoreOffline(port)) {
    subscribe();
  } else {
    queueMicrotask(() => {
      if (!unsubscribed && isWorkerFirestoreOffline(port)) {
        deliveredCount += 1;
        deliverRawFrame(buildWorkerOfflineWire(port, descriptor, targetDbId));
      }
    });
  }

  if (!unsubscribed) {
    unsubLens = subscribeLens(() => {
      if (unsubscribed || isWorkerFirestoreOffline(port)) return;
      if (isOpenOnHost) {
        isOpenOnHost = false;
        closeSubscription(port, currentSubId);
      }
      currentSubId = nextSubId();
      activity.transport(currentSubId);
      subscribe();
    });
  }

  const releaseLifecycle = registerWorkerOwnedListener(target, stop);

  function stop(): void {
    unsubscribed = true;
    releaseLifecycle();
    unregisterNetwork();
    activity.close();
    unsubLens();
    if (isOpenOnHost) {
      isOpenOnHost = false;
      closeSubscription(port, currentSubId);
    }
  }
  return stop;
}

const syncObserversByPort = new WeakMap<object, Set<() => void>>();
const syncScheduledByPort = new WeakSet<object>();

function notifyWorkerSnapshotDelivered(port: object): void {
  const observers = syncObserversByPort.get(port);
  if (!observers || observers.size === 0 || syncScheduledByPort.has(port)) return;
  syncScheduledByPort.add(port);
  queueMicrotask(() => {
    syncScheduledByPort.delete(port);
    for (const observer of [...observers]) observer();
  });
}

export function onSnapshotsInSync(
  db: ClientDb,
  observerOrCallback: (() => void) | { next?: () => void; complete?: () => void; error?: (error: unknown) => void },
): Unsubscribe {
  assertWorkerFirestoreActive(db);
  let cb: (() => void) | undefined;
  if (typeof observerOrCallback === 'function') {
    cb = observerOrCallback;
  } else if (typeof observerOrCallback.next === 'function') {
    cb = observerOrCallback.next.bind(observerOrCallback);
  }
  const port = db.port as object;
  markWorkerHandleStarted(db);
  if (!cb) return () => undefined;
  const boundCb = cb;
  let observers = syncObserversByPort.get(port);
  if (!observers) {
    observers = new Set();
    syncObserversByPort.set(port, observers);
  }
  const observerSet = observers;
  observerSet.add(boundCb);
  const releaseLifecycle = registerWorkerOwnedListener(db, () => {
    observerSet.delete(boundCb);
  });
  try {
    boundCb();
  } catch (error) {
    releaseLifecycle();
    observerSet.delete(boundCb);
    throw error;
  }
  return () => {
    releaseLifecycle();
    observerSet.delete(boundCb);
  };
}
