/**
 * SharedWorker protocol — Firestore reference descriptors, sentinels,
 * aggregate descriptors, write descriptors, and document data serialization.
 */
import { rehydrateDocValue } from 'pyric/firestore/internal/value-codec';
import type { AuthLens, ListenerOwner } from 'pyric/sandbox';

// ─── Ref descriptors (client-side, never cross the port directly) ──────────

/**
 * A serializable reference to a Firestore document path. Produced by
 * `doc()` on the client; embedded in op/sub messages for the worker to
 * resolve against the real sandbox.
 */
export interface DocRef {
  readonly __ref: 'doc';
  readonly path: string;
}

/**
 * A serializable reference to a collection path. Produced by `collection()`.
 */
export interface CollRef {
  readonly __ref: 'collection';
  readonly path: string;
}

/**
 * A serializable collectionGroup descriptor. Produced by `collectionGroup()`.
 */
export interface GroupRef {
  readonly __ref: 'group';
  readonly collectionId: string;
}

/**
 * A serializable query descriptor. Wraps a source ref with a constraint list.
 * Constraints encode `where`/`orderBy`/`limit`/`limitToLast`/`startAt`/
 * `startAfter`/`endAt`/`endBefore` as plain data so they can be rebuilt on
 * the worker side by calling the pyric/firestore constraint factories.
 */
export interface QueryDescriptor {
  readonly __ref: 'query';
  readonly source: DocRef | CollRef | GroupRef;
  readonly constraints: readonly QueryConstraintDescriptor[];
}

/**
 * Plain data representation of a FILTER constraint — the subset of
 * constraints valid at a query's top level AND inside composite `and`/`or`
 * filters (orderBy/limit/cursors are not filters). Mirrors the modular SDK's
 * `where()` / `and(...)` / `or(...)` composition: composites nest arbitrarily,
 * and the worker rebuilds them with the pyric/firestore `and`/`or` factories.
 */
export type FilterConstraintDescriptor =
  | { kind: 'where'; field: string; op: string; value: unknown }
  | { kind: 'and'; filters: readonly FilterConstraintDescriptor[] }
  | { kind: 'or'; filters: readonly FilterConstraintDescriptor[] };

/** Plain data representation of a query constraint. */
export type QueryConstraintDescriptor =
  | FilterConstraintDescriptor
  | { kind: 'orderBy'; field: string; direction?: 'asc' | 'desc' }
  | { kind: 'limit'; n: number }
  | { kind: 'limitToLast'; n: number }
  | { kind: 'startAt'; values: unknown[]; isSnapshot?: false }
  | { kind: 'startAfter'; values: unknown[]; isSnapshot?: false }
  | { kind: 'endAt'; values: unknown[]; isSnapshot?: false }
  | { kind: 'endBefore'; values: unknown[]; isSnapshot?: false };

export type TargetDescriptor = DocRef | CollRef | GroupRef | QueryDescriptor;

// ─── Sentinel markers (cross the port embedded in write data) ─────────────

/**
 * Wire representation of a FieldValue sentinel. The worker's sandbox
 * resolves these via FieldValue factories before writing — the sentinel
 * objects themselves are structurally identical to what `pyric/sandbox/
 * admin-compat`'s FieldValue class produces, so they round-trip naturally.
 *
 * We use a `__sentinel` discriminator instead of relying on class identity
 * (class instances aren't reliably transferred across message ports as class
 * instances — the structured clone algorithm produces plain objects).
 */
export type SentinelMarker =
  | { readonly __sentinel: 'serverTimestamp' }
  | { readonly __sentinel: 'increment'; readonly n: number }
  | { readonly __sentinel: 'arrayUnion'; readonly values: unknown[] }
  | { readonly __sentinel: 'arrayRemove'; readonly values: unknown[] }
  | { readonly __sentinel: 'deleteField' };

export function isSentinelMarker(v: unknown): v is SentinelMarker {
  return (
    v !== null &&
    typeof v === 'object' &&
    '__sentinel' in (v as object) &&
    typeof (v as { __sentinel: unknown }).__sentinel === 'string'
  );
}

// ─── Aggregate descriptors ─────────────────────────────────────────────────

/**
 * Aggregate-field descriptor for the `aggregate` op. Structurally identical
 * to `pyric/firestore`'s `AggregateField` (and to admin-compat's — the
 * `pyric-admin` remote arm's `Query.aggregate({ count/sum/average })`
 * surface), so specs cross the wire verbatim: plain JSON, no translation.
 * The host rebuilds the query and runs `getAggregateFromServer`; the reply
 * is `{ data: Record<alias, number | null> }` (empty-input `average` is
 * `null`, matching the SDKs).
 */
export type AggregateFieldDescriptor =
  | { kind: 'count' }
  | { kind: 'sum'; field: string }
  | { kind: 'average'; field: string };

/** Spec passed on the `aggregate` op — aliases become the result's keys. */
export type AggregateSpecDescriptor = Record<string, AggregateFieldDescriptor>;

// ─── Write descriptors for batch + transaction ────────────────────────────

export type WriteDescriptor =
  | { method: 'set'; path: string; data: unknown; options?: { merge?: boolean; mergeFields?: string[] } }
  | { method: 'update'; path: string; data: unknown }
  | { method: 'delete'; path: string };

/**
 * One entry in the read-set sent by the client on `txnCommit`.
 *
 * The client records every doc it read during `updateFn` (via `txn.get`)
 * along with the serialized data it saw at read time (`data` is the
 * `SerializedDocData` the worker returned, or `null` if the doc didn't
 * exist). The worker re-reads each path inside a real sandbox transaction
 * and deep-compares by re-serializing the current state to the same JSON
 * form — any mismatch means another tab wrote the doc between our read and
 * commit, so we abort and let the client retry `updateFn`.
 */
export interface TxnReadEntry {
  /** Firestore path of the document that was read. */
  path: string;
  /**
   * The serialized doc data seen by the client at read time.
   * `null` means the document did not exist when the client read it.
   */
  data: SerializedDocData | null;
}

/** Register a Firestore snapshot listener for a doc or query. The worker
 *  fires `{ t:'snap', subId, value }` immediately (initial) and on each
 *  update. */
export interface FirestoreSubMessage {
  t: 'sub';
  subId: string;
  target: TargetDescriptor;
  /**
   * Per-subscription auth lens (Pyric Studio F4 — "watch as user"). Mirrors
   * the per-op `actAs` on OpMessage: `{ mode: 'as', uid }` registers the
   * listener through the impersonation data handle so the snapshot's initial
   * fire AND every re-eval evaluate security rules AS that uid; `{ mode: 'admin' }`
   * watches through the rule-bypass handle; `{ mode: 'anon' }` watches genuinely
   * unauthenticated (`withAuth(null)`); absent / `{ mode: 'app-session' }`
   * watches as the app's own session (the unchanged default).
   */
  actAs?: AuthLens;
  /**
   * The listener's owners, derived on the page that opened it. The sandbox
   * attaches inside the worker, where the calling frame belongs to the worker
   * bundle, the caller's `owner` option never arrived, and there is no DOM, so
   * the page derives them and the host records these instead.
   */
  owners?: ListenerOwner[];
  /** Mechanical op provenance. */
  issuer?: 'studio';
  /** Marks traffic relayed from a remote Node/agent consumer, never page app activity. */
  relaySource?: 'remote';
}

// ─── Serialized document data ─────────────────────────────────────────────

/**
 * Document data as it crosses the port: Timestamp/Bytes/LatLng/etc. are
 * serialized to their JSON marker shapes so they survive structured clone,
 * then rehydrated back to REAL class instances on the receiving side.
 */
export interface SerializedDocData {
  /** JSON string of the document data (Timestamp/Bytes/LatLng serialized via toJSON). */
  json: string;
}

/**
 * Serialize document data to cross-port form.
 */
export function serializeDocData(data: Record<string, unknown>): SerializedDocData {
  return { json: JSON.stringify(data) };
}

/**
 * Deserialize document data from cross-port form.
 */
export function deserializeDocData(serialized: SerializedDocData): unknown {
  return rehydrateDocValue(JSON.parse(serialized.json));
}
