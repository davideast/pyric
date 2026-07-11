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
import { nextId, nextSubId, dataRpc, _snapSubs, _defaultLens, stampIssuer } from './core.js';
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
  return makeDocSnapshot(result);
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
  return makeQuerySnapshot(result);
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

/**
 * Subscribe to a document or query. Mirrors `pyric/firestore`'s `onSnapshot`.
 *
 * Returns an `unsub` function. Sends `{ t:'unsub', subId }` to the worker
 * to deregister the listener on the worker side.
 */
export function onSnapshot(
  target: DocRefHandle | CollRefHandle | QueryHandle,
  callback: (snap: ClientDocSnapshot | ClientQuerySnapshot) => void,
  errorCallback?: (err: unknown) => void,
): Unsubscribe {
  const subId = nextSubId();
  const port = target.port;

  _snapSubs.set(subId, {
    next: (raw) => {
      const r = raw as Record<string, unknown>;
      if ('docs' in r) {
        callback(makeQuerySnapshot(r as unknown as RawQueryResult));
      } else {
        callback(makeDocSnapshot(r as unknown as RawDocResult));
      }
    },
    error: errorCallback,
  });

  const descriptor: TargetDescriptor =
    target.__kind === 'doc-ref'
      ? (target as DocRefHandle).descriptor
      : target.__kind === 'coll-ref'
        ? (target as CollRefHandle).descriptor
        : (target as QueryHandle).descriptor;

  // Stamp the active default lens onto the sub (Pyric Studio "watch as user")
  // exactly as `dataRpc` does for ops, so a `setLens({mode:'as',uid})` choice
  // makes listeners impersonate too. Omitted when no lens is set → byte-identical
  // wire message, preserving the additive contract. The declared op source
  // rides along the same way (client-constructed subs only — the relay's
  // subs post verbatim).
  port.postMessage(
    stampIssuer(
      (_defaultLens
        ? { t: 'sub', subId, target: descriptor, actAs: _defaultLens }
        : { t: 'sub', subId, target: descriptor }) satisfies InboundMessage,
    ),
  );

  return () => {
    _snapSubs.delete(subId);
    port.postMessage({ t: 'unsub', subId } satisfies InboundMessage);
  };
}
