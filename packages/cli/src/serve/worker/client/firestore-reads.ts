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
import { beginWorkerFirestoreActivity } from './sdk-activity.js';
import { finishSdkRead } from 'pyric/sandbox/internal';
import { makeDocSnapshot, makeQuerySnapshot } from './snapshots.js';
import type { RawDocResult, RawQueryResult, ClientDocSnapshot, ClientQuerySnapshot } from './snapshots.js';

// ─── Execution functions (RPC) ────────────────────────────────────────────

export function getDoc(ref: DocRefHandle): Promise<ClientDocSnapshot> {
  return readDocumentAs(ref, 'getDoc');
}

export async function readDocumentAs(ref: DocRefHandle, method: string): Promise<ClientDocSnapshot> {
  const activity = beginWorkerFirestoreActivity(ref, method, 'operation');
  try {
    const result = await dataRpc(ref.port, {
      t: 'op',
      id: nextId(),
      method: 'getDoc',
      path: ref.descriptor.path,
    }) as RawDocResult;
    return finishSdkRead(activity, makeDocSnapshot(result, ref.port));
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
    return finishSdkRead(activity, makeQuerySnapshot(result, source.port));
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

/**
 * Subscribe to a document or query. Mirrors `pyric/firestore`'s `onSnapshot`,
 * including its options-second form `onSnapshot(target, options, next,
 * error)`: `@pyric/ui`'s hooks pass `{ owner }` there for listener
 * attribution, and a caller injecting this client as the hooks' backend must
 * not lose its callback to that slot. The owners are derived here, on the page
 * whose stack and DOM they describe, and travel with the subscribe message.
 *
 * Returns an `unsub` function. Sends `{ t:'unsub', subId }` to the worker
 * to deregister the listener on the worker side.
 */
export function onSnapshot(
  target: DocRefHandle | CollRefHandle | QueryHandle,
  callback: SnapshotCallback,
  errorCallback?: SnapshotErrorCallback,
): Unsubscribe;
export function onSnapshot(
  target: DocRefHandle | CollRefHandle | QueryHandle,
  options: object,
  callback: SnapshotCallback,
  errorCallback?: SnapshotErrorCallback,
): Unsubscribe;
export function onSnapshot(
  target: DocRefHandle | CollRefHandle | QueryHandle,
  optionsOrCallback: object | SnapshotCallback,
  callbackOrError?: SnapshotCallback | SnapshotErrorCallback,
  maybeError?: SnapshotErrorCallback,
): Unsubscribe {
  const listenOptions = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
  // Derived before the message is built: `captureCreationFrame` reads the
  // stack this call is still on.
  const owners = pageListenerOwners(listenOptions);
  const callback = (typeof optionsOrCallback === 'function'
    ? optionsOrCallback
    : callbackOrError) as SnapshotCallback;
  const errorCallback = (typeof optionsOrCallback === 'function'
    ? callbackOrError
    : maybeError) as SnapshotErrorCallback | undefined;
  let currentSubId = nextSubId();
  const port = target.port;
  const activity = beginWorkerFirestoreActivity(target, 'onSnapshot', 'subscription', owners);
  activity.transport(currentSubId);

  const subscription = {
    port,
    service: 'firestore' as const,
    next: (raw: unknown) => {
      // Reported on the subscription id the sandbox also records as the
      // listener id, immediately before the application's callback runs.
      const r = raw as Record<string, unknown>;
      if ('docs' in r) {
        const snapshot = makeQuerySnapshot(r as unknown as RawQueryResult, port);
        activity.delivered(snapshot, (r as { usage?: import('pyric/sandbox/internal').UsageEvidence }).usage);
        callback(snapshot);
      } else {
        const snapshot = makeDocSnapshot(r as unknown as RawDocResult, port);
        activity.delivered(snapshot, (r as { usage?: import('pyric/sandbox/internal').UsageEvidence }).usage);
        callback(snapshot);
      }
    },
    error: (error: unknown) => { activity.fail(); errorCallback?.(error); },
    close: () => activity.close(),
  };

  const descriptor: TargetDescriptor =
    target.__kind === 'doc-ref'
      ? (target as DocRefHandle).descriptor
      : target.__kind === 'coll-ref'
        ? (target as CollRefHandle).descriptor
        : (target as QueryHandle).descriptor;

  const opened = openSnapshotSubscription(
    port,
    currentSubId,
    subscription,
    stampIssuer(
      (_defaultLens
        ? { t: 'sub', subId: currentSubId, target: descriptor, actAs: _defaultLens, ...(owners ? { owners } : {}) }
        : { t: 'sub', subId: currentSubId, target: descriptor, ...(owners ? { owners } : {}) }) satisfies InboundMessage,
    ),
  );
  if (!opened) activity.fail();
  if (!opened && errorCallback) queueMicrotask(() => errorCallback(new Error('Firebase App was deleted')));

  let unsubscribed = false;
  const unsubLens = subscribeLens((newLens) => {
    if (unsubscribed) return;
    closeSubscription(port, currentSubId);
    currentSubId = nextSubId();
    activity.transport(currentSubId);
    const reopened = openSnapshotSubscription(
      port,
      currentSubId,
      subscription,
      stampIssuer(
        (newLens
          ? { t: 'sub', subId: currentSubId, target: descriptor, actAs: newLens, ...(owners ? { owners } : {}) }
          : { t: 'sub', subId: currentSubId, target: descriptor, ...(owners ? { owners } : {}) }) satisfies InboundMessage,
      ),
    );
    if (!reopened && errorCallback) {
      queueMicrotask(() => errorCallback(new Error('Firebase App was deleted')));
    }
  });

  return () => {
    unsubscribed = true;
    activity.close();
    unsubLens();
    closeSubscription(port, currentSubId);
  };
}
