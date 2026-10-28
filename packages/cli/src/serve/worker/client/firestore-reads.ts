/**
 * Firestore read execution — document/collection reads, keyspace enumeration,
 * count/aggregate reads, and the `onSnapshot` listener. Each RPCs the worker and
 * rehydrates the reply into the modular SDK's snapshot shapes.
 */

import type {
  TargetDescriptor,
  AggregateFieldDescriptor,
  AggregateSpecDescriptor,
  InboundMessage,
} from '../protocol.js';
import { closeSubscription, nextId, nextSubId, dataRpc, _defaultLens, subscribeLens, openSnapshotSubscription, stampIssuer } from './core.js';
import type { ClientDb, DocRefHandle, CollRefHandle, QueryHandle, Unsubscribe } from './handles.js';
import { pageListenerOwners } from './listener-owners.js';
import { deliverWithRegions } from './listener-delivery.js';
import { makeDocSnapshot, makeQuerySnapshot, makeSnapshot } from './snapshots.js';
import { beginWorkerFirestoreActivity } from './sdk-activity.js';
import { finishSdkRead, type UsageEvidence } from 'pyric/sandbox/internal';
import type { RawDocResult, RawQueryResult, ClientDocSnapshot, ClientQuerySnapshot, QueryChangeBaseline } from './snapshots.js';
import type { DocumentData } from 'pyric/firestore';

// ─── Execution functions (RPC) ────────────────────────────────────────────

export function getDoc<T = DocumentData>(ref: DocRefHandle<T>): Promise<ClientDocSnapshot<T>> {
  return readDocumentAs(ref, 'getDoc');
}

export async function readDocumentAs<T = DocumentData>(ref: DocRefHandle<T>, method: string): Promise<ClientDocSnapshot<T>> {
  const activity = beginWorkerFirestoreActivity(ref, method, 'operation');
  try {
    const result = await dataRpc(ref.port, {
      t: 'op',
      id: nextId(),
      method: 'getDoc',
      path: ref.descriptor.path,
    }) as RawDocResult;
    return finishSdkRead(activity, makeDocSnapshot(result, ref.port, ref));
  } catch (error) { activity.fail(); throw error; }
}

export function getDocs(source: CollRefHandle | QueryHandle): Promise<ClientQuerySnapshot> {
  return readQueryAs(source, 'getDocs');
}

export async function readQueryAs(source: CollRefHandle | QueryHandle, method: string): Promise<ClientQuerySnapshot> {
  const activity = beginWorkerFirestoreActivity(source, method, 'operation');
  try {
    const result = await dataRpc(source.port, {
      t: 'op',
      id: nextId(),
      method: 'getDocs',
      source: source.__kind === 'coll-ref'
        ? (source as CollRefHandle).descriptor
        : (source as QueryHandle).descriptor,
    }) as RawQueryResult;
    return finishSdkRead(activity, makeQuerySnapshot(result, source.port, source.converter));
  } catch (error) { activity.fail(); throw error; }
}

/**
 * Enumerate root collection ids (Pyric Studio data browse). The modular SDK has
 * no client `listCollections`, so the host scans the sandbox keyspace and
 * returns the ids. Lens is attached (via dataRpc) but the host enumeration is
 * lens-independent.
 */
export async function listRootCollections(db: ClientDb): Promise<string[]> {
  const r = (await dataRpc(db.port, {
    t: 'op',
    id: nextId(),
    method: 'listRootCollections',
  })) as { ids: string[] };
  return r.ids;
}

/** Enumerate subcollection ids under a document path (Pyric Studio data browse). */
export async function listSubcollections(db: ClientDb, docPath: string): Promise<string[]> {
  const r = (await dataRpc(db.port, {
    t: 'op',
    id: nextId(),
    method: 'listSubcollections',
    docPath,
  })) as { ids: string[] };
  return r.ids;
}

export async function getCountFromServer(
  source: CollRefHandle | QueryHandle,
): Promise<{ data(): { count: number } }> {
  const activity = beginWorkerFirestoreActivity(source, 'getCountFromServer', 'operation');
  try {
    const result = await dataRpc(source.port, {
      t: 'op',
      id: nextId(),
      method: 'count',
      source: source.__kind === 'coll-ref'
        ? (source as CollRefHandle).descriptor
        : (source as QueryHandle).descriptor,
    }) as { count: number };
    return finishSdkRead(activity, { data: () => ({ count: result.count }) });
  } catch (error) { activity.fail(); throw error; }
}

// ─── Multi-field aggregates (count / sum / average) ───────────────────────

/** Factory: count() aggregate field. Mirrors `pyric/firestore`'s `count()`. */
export function count(): AggregateFieldDescriptor {
  return { kind: 'count' };
}

/** Factory: sum-of-`field` aggregate. Mirrors `pyric/firestore`'s `sum()`. */
export function sum(field: string): AggregateFieldDescriptor {
  return { kind: 'sum', field };
}

/** Factory: average-of-`field` aggregate. Empty input yields `null`. */
export function average(field: string): AggregateFieldDescriptor {
  return { kind: 'average', field };
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
): Promise<{ data(): { [K in keyof S]: number | null } }> {
  const activity = beginWorkerFirestoreActivity(source, 'getAggregateFromServer', 'operation');
  try {
    const result = await dataRpc(source.port, {
      t: 'op',
      id: nextId(),
      method: 'aggregate',
      source: source.__kind === 'coll-ref'
        ? (source as CollRefHandle).descriptor
        : (source as QueryHandle).descriptor,
      spec,
    }) as { data: { [K in keyof S]: number | null } };
    return finishSdkRead(activity, { data: () => result.data });
  } catch (error) { activity.fail(); throw error; }
}

// ─── onSnapshot ──────────────────────────────────────────────────────────

type SnapshotCallback = (snap: ClientDocSnapshot | ClientQuerySnapshot) => void;
type SnapshotErrorCallback = (err: unknown) => void;

/** Production's `PartialObserver`: any of `next`, `error` and `complete`. */
export interface SnapshotObserver {
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
  const activity = beginWorkerFirestoreActivity(target, 'onSnapshot', 'subscription', owners);
  activity.transport(currentSubId);

  const subscription = {
    port,
    service: 'firestore' as const,
    next: (raw: unknown) => {
      let decoded: ClientDocSnapshot | ClientQuerySnapshot | null;
      try {
        decoded = makeSnapshot(raw, port, target.converter, baseline);
      } catch (error) {
        stop();
        reportError(error);
        return;
      }
      // An unchanged re-established listener delivers nothing.
      if (decoded === null) return;
      const snapshot = decoded;
      // Reported on the subscription id the sandbox also records as the
      // listener id, immediately before the application's callback runs.
      const result = raw as { usage?: UsageEvidence };
      activity.delivered(snapshot, result.usage);
      const deliver = callback;
      const hasNext = deliver !== undefined;
      if (hasNext) deliverWithRegions(activity.id, () => deliver(snapshot));
    },
    error: (error: unknown) => { activity.fail(); reportError(error); },
    close: () => activity.close(),
  };

  const descriptor = target.descriptor;
  function subscribe(): boolean {
    const message: InboundMessage = { t: 'sub', subId: currentSubId, target: descriptor };
    const hasLens = _defaultLens !== undefined;
    if (hasLens) message.actAs = _defaultLens;
    const hasOwners = owners !== undefined;
    if (hasOwners) message.owners = owners;
    if (includeMetadataChanges) message.includeMetadataChanges = true;
    const opened = openSnapshotSubscription(port, currentSubId, subscription, stampIssuer(message));
    const failedToOpen = !opened;
    if (failedToOpen) activity.fail();
    const reportsDeletedApp = !opened && errorCallback !== undefined;
    if (reportsDeletedApp) queueMicrotask(() => errorCallback(new Error('Firebase App was deleted')));
    return opened;
  }
  subscribe();

  let unsubscribed = false;
  const unsubLens = subscribeLens(() => {
    if (unsubscribed) return;
    closeSubscription(port, currentSubId);
    currentSubId = nextSubId();
    activity.transport(currentSubId);
    subscribe();
  });

  function stop(): void {
    unsubscribed = true;
    activity.close();
    unsubLens();
    closeSubscription(port, currentSubId);
  }
  return stop;
}
