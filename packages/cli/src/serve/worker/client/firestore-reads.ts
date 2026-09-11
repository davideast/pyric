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
import { makeDocSnapshot, makeQuerySnapshot } from './snapshots.js';
import type { RawDocResult, RawQueryResult, ClientDocSnapshot, ClientQuerySnapshot } from './snapshots.js';

// ─── Execution functions (RPC) ────────────────────────────────────────────

export async function getDoc(ref: DocRefHandle): Promise<ClientDocSnapshot> {
  const result = await dataRpc(ref.port, {
    t: 'op',
    id: nextId(),
    method: 'getDoc',
    path: ref.descriptor.path,
  }) as RawDocResult;
  return makeDocSnapshot(result, ref.port);
}

export async function getDocs(
  source: CollRefHandle | QueryHandle,
): Promise<ClientQuerySnapshot> {
  const result = await dataRpc(source.port, {
    t: 'op',
    id: nextId(),
    method: 'getDocs',
    source: source.__kind === 'coll-ref'
      ? (source as CollRefHandle).descriptor
      : (source as QueryHandle).descriptor,
  }) as RawQueryResult;
  return makeQuerySnapshot(result, source.port);
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
  const result = await dataRpc(source.port, {
    t: 'op',
    id: nextId(),
    method: 'count',
    source: source.__kind === 'coll-ref'
      ? (source as CollRefHandle).descriptor
      : (source as QueryHandle).descriptor,
  }) as { count: number };
  return { data: () => ({ count: result.count }) };
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
  const result = await dataRpc(source.port, {
    t: 'op',
    id: nextId(),
    method: 'aggregate',
    source: source.__kind === 'coll-ref'
      ? (source as CollRefHandle).descriptor
      : (source as QueryHandle).descriptor,
    spec,
  }) as { data: { [K in keyof S]: number | null } };
  return { data: () => result.data };
}

// ─── onSnapshot ──────────────────────────────────────────────────────────

type SnapshotCallback = (snap: ClientDocSnapshot | ClientQuerySnapshot) => void;
type SnapshotErrorCallback = (err: unknown) => void;

/**
 * Subscribe to a document or query. Mirrors `pyric/firestore`'s `onSnapshot`,
 * including its options-second form `onSnapshot(target, options, next,
 * error)`: `@pyric/ui`'s hooks pass `{ owner }` there for listener
 * attribution, and a caller injecting this client as the hooks' backend must
 * not lose its callback to that slot. The options are accepted and dropped;
 * the worker protocol carries no listener owner yet.
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
  const callback = (typeof optionsOrCallback === 'function'
    ? optionsOrCallback
    : callbackOrError) as SnapshotCallback;
  const errorCallback = (typeof optionsOrCallback === 'function'
    ? callbackOrError
    : maybeError) as SnapshotErrorCallback | undefined;
  let currentSubId = nextSubId();
  const port = target.port;

  const subscription = {
    port,
    service: 'firestore' as const,
    next: (raw: unknown) => {
      const r = raw as Record<string, unknown>;
      if ('docs' in r) {
        callback(makeQuerySnapshot(r as unknown as RawQueryResult, port));
      } else {
        callback(makeDocSnapshot(r as unknown as RawDocResult, port));
      }
    },
    error: errorCallback,
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
        ? { t: 'sub', subId: currentSubId, target: descriptor, actAs: _defaultLens }
        : { t: 'sub', subId: currentSubId, target: descriptor }) satisfies InboundMessage,
    ),
  );
  if (!opened && errorCallback) queueMicrotask(() => errorCallback(new Error('Firebase App was deleted')));

  let unsubscribed = false;
  const unsubLens = subscribeLens((newLens) => {
    if (unsubscribed) return;
    closeSubscription(port, currentSubId);
    currentSubId = nextSubId();
    const reopened = openSnapshotSubscription(
      port,
      currentSubId,
      subscription,
      stampIssuer(
        (newLens
          ? { t: 'sub', subId: currentSubId, target: descriptor, actAs: newLens }
          : { t: 'sub', subId: currentSubId, target: descriptor }) satisfies InboundMessage,
      ),
    );
    if (!reopened && errorCallback) {
      queueMicrotask(() => errorCallback(new Error('Firebase App was deleted')));
    }
  });

  return () => {
    unsubscribed = true;
    unsubLens();
    closeSubscription(port, currentSubId);
  };
}
