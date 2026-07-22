/**
 * Public types for the Admin-SDK-compat Firestore wrapper.
 *
 * Mirrors the firebase-admin Firestore surface, scoped to what an agent
 * running code under `LocalEnvironment` actually exercises. Listener
 * semantics, offline persistence, bundles, and named queries are
 * deliberately omitted — methods that touch them throw
 * `FirestoreCompatError { code: 'unimplemented' }` rather than return
 * silent no-ops (see design rationale, the
 * "deliberately incomplete" agreement).
 *
 * Public-API `unknown` policy: every `unknown` here sits at a real
 * Firestore "stores arbitrary data" boundary (`DocumentData` values,
 * where-clause values, FieldValue construction) — matching the Admin
 * SDK's own type-shape decisions. Zero `: any`.
 */

export { FirestoreCompatError } from '../firestore-compat-error.js';
import {
  boundedActivityIdentity,
  registerActivityValue,
} from '../../../firestore/sandbox/activity-value-registry.js';
import { registerQueryValue } from '../../../firestore/sandbox/query-value-registry.js';
import type {
  QueryOrderDirection,
  QueryWhereFilterOp,
} from '../query-execution.js';
import type { SnapshotFieldPath } from './field-path.js';

// ─────────────────────────────────────────────────────────────────────────
// Public surface — what agent code calls.
// ─────────────────────────────────────────────────────────────────────────

export type DocumentData = Record<string, unknown>;

export type AuthContext = { uid: string; token?: Record<string, unknown> } | null;

/**
 * Per-operation options. The optional `auth` field overrides the
 * constructor-default auth for a single call — same agent code can
 * issue ops on behalf of different users without re-constructing the
 * Firestore handle. Backward-compatible: omitting `opts` (or the
 * `auth` field within) falls back to the constructor default.
 *
 * Within a transaction, per-op overrides on `tx.get/set/update/delete`
 * are intentionally absent — a transaction is a single coordinated
 * commit and runs under one auth context. To run a transaction as a
 * different user, pass `{ auth }` to `runTransaction(fn, opts)`.
 */
export interface OperationOptions {
  auth?: AuthContext;
  /** Firestore transaction retry bound; ignored by non-transaction operations. */
  maxAttempts?: number;
}

/**
 * Options for `DocumentReference.set`. Mirrors the modular Web-SDK's
 * `SetOptions` shape with pyric's `auth` per-op override layered on.
 *
 *   - default (neither flag set) → REPLACE the existing document
 *     entirely. Firestore default for `set()`.
 *   - `{ merge: true }` → shallow-merge every top-level field in
 *     `data` into the existing document. Fields not in `data` are
 *     preserved. Rule eval still runs the `update` clause when the
 *     doc exists.
 *   - `{ mergeFields: [...] }` → project `data` down to just the
 *     listed top-level fields, then merge. Other fields in `data` are
 *     ignored; other fields in the existing doc are preserved.
 *
 * `merge` and `mergeFields` are mutually exclusive at the JS-SDK
 * level. We don't currently enforce the constraint — if both are
 * provided, `mergeFields` wins (matches the JS SDK's effective
 * behavior).
 */
export interface SetOptions extends OperationOptions {
  merge?: boolean;
  mergeFields?: readonly string[];
}

export interface DocumentSnapshot {
  readonly id: string;
  readonly ref: DocumentReference;
  readonly exists: boolean;
  data(): DocumentData | undefined;
  get(fieldPath: SnapshotFieldPath): unknown;
}

export interface QueryDocumentSnapshot extends DocumentSnapshot {
  data(): DocumentData;
}

export interface QuerySnapshot {
  readonly size: number;
  readonly empty: boolean;
  readonly docs: QueryDocumentSnapshot[];
  forEach(callback: (snap: QueryDocumentSnapshot) => void): void;
}

export interface DocumentReference {
  readonly id: string;
  readonly path: string;
  readonly parent: CollectionReference;
  collection(name: string): CollectionReference;
  get(opts?: OperationOptions): Promise<DocumentSnapshot>;
  set(data: DocumentData, options?: SetOptions): Promise<void>;
  update(data: DocumentData, opts?: OperationOptions): Promise<void>;
  delete(opts?: OperationOptions): Promise<void>;
}

export type WhereFilterOp = QueryWhereFilterOp;

export type OrderDirection = QueryOrderDirection;

/**
 * Composite filter tree for `Query.applyFilter`. Recursive — `and` /
 * `or` carry their own `filters` array of nested `Filter`s; the
 * leaves are field/op/value triples (`kind: 'where'`).
 *
 * Mirrors `firebase/firestore`'s `QueryFilterConstraint` shape, just
 * as a tagged-union value type (the SDK's classes carry an `_op`
 * field; ours is the `kind` discriminant).
 */
export type Filter =
  | { kind: 'where'; field: string; op: WhereFilterOp; value: unknown }
  | { kind: 'and'; filters: Filter[] }
  | { kind: 'or'; filters: Filter[] };

export interface Query {
  where(field: string, op: WhereFilterOp, value: unknown): Query;
  /**
   * Add a composite filter (leaf, AND, or OR) to the query's filter
   * stack. Each `applyFilter` call AND-s with whatever filters are
   * already on the query — same implicit-AND semantics as multiple
   * `where()` calls. To OR multiple predicates, wrap them with
   * `{ kind: 'or', filters: [...] }` before calling. Backs the
   * modular `or()` / `and()` constraints in `pyric/firestore`.
   */
  applyFilter(filter: Filter): Query;
  orderBy(field: string, direction?: OrderDirection): Query;
  limit(n: number): Query;
  /**
   * Limit from the END of the ordered result. Equivalent to reversing
   * the orderBy, taking `n`, then re-reversing — the simulator
   * implements it that way. Requires at least one `orderBy` clause on
   * the query (matches the JS SDK's runtime contract).
   */
  limitToLast(n: number): Query;
  /**
   * Set the start position of the query relative to the orderBy
   * fields. `values` corresponds 1:1 with the orderBy clauses on the
   * query (one value per clause); `inclusive` controls `startAt` (true)
   * vs `startAfter` (false). Repeated calls replace the previous
   * cursor — matches production.
   */
  startCursor(values: unknown[], inclusive: boolean): Query;
  /**
   * Set the end position of the query relative to the orderBy fields.
   * `inclusive` controls `endAt` (true) vs `endBefore` (false).
   */
  endCursor(values: unknown[], inclusive: boolean): Query;
  /**
   * Variant of {@link startCursor} that takes a `DocumentSnapshot`
   * and extracts the cursor values from the snapshot's data at each
   * orderBy field. Mirrors the JS SDK's `startAt(snapshot)` overload
   * and shines for cursor-based pagination ("hand me the next page
   * after this one"). Requires at least one `orderBy` clause —
   * thrown at call time, not at get-time, so the failure surfaces
   * close to the bug.
   */
  startCursorFromSnapshot(snapshot: DocumentSnapshot, inclusive: boolean): Query;
  /** Snapshot-based variant of {@link endCursor}. */
  endCursorFromSnapshot(snapshot: DocumentSnapshot, inclusive: boolean): Query;
  get(opts?: OperationOptions): Promise<QuerySnapshot>;
  /**
   * Compute one or more aggregates over the documents matching this
   * query. Mirrors the Admin SDK's `query.aggregate({ … }).get()`
   * pattern, collapsed into one call for the simulator (no need to
   * build an `AggregateQuery` reference type when there's no remote
   * dispatch).
   *
   * Each entry in `spec` is keyed by a caller-chosen alias and
   * resolves to an `AggregateField`. The returned snapshot exposes
   * the computed numbers under the same aliases via `.data()`.
   *
   * Where / orderBy clauses ARE applied before aggregation (they
   * narrow the candidate doc set). `limit` is honored — the aggregate
   * computes against the limited set, matching production semantics.
   */
  aggregate(spec: AggregateSpec): Promise<AggregateQuerySnapshot>;
}

/**
 * Single aggregate definition. Field is required for sum / average,
 * forbidden for count (no field has any meaning when you're
 * counting rows). Encoded as discriminated union so type errors
 * surface at the call site, not at runtime.
 */
export type AggregateField =
  | { kind: 'count' }
  | { kind: 'sum'; field: string }
  | { kind: 'average'; field: string };

/** Spec passed to `Query.aggregate(...)`. Aliases become the keys in
 *  the returned snapshot's `.data()` object. */
export type AggregateSpec = Record<string, AggregateField>;

/**
 * Result of `Query.aggregate(spec).get()`. `.data()` returns the
 * computed numbers under the spec's aliases. Empty-input averages
 * resolve to `null` to mirror Firestore production behavior
 * (averaging over zero documents has no meaningful number).
 */
export interface AggregateQuerySnapshot {
  data(): Record<string, number | null>;
}

export interface CollectionReference extends Query {
  readonly id: string;
  readonly path: string;
  doc(id?: string): DocumentReference;
  add(data: DocumentData, opts?: OperationOptions): Promise<DocumentReference>;
}

export interface WriteBatch {
  set(ref: DocumentReference, data: DocumentData): WriteBatch;
  update(ref: DocumentReference, data: DocumentData): WriteBatch;
  delete(ref: DocumentReference): WriteBatch;
  commit(opts?: OperationOptions): Promise<void>;
}

export interface Transaction {
  // Two overloads, mirroring Admin SDK shape. Runtime dispatch uses a
  // structural `isQuery` test (the .where method present on Query and
  // CollectionReference but not DocumentReference). Behavior locked by
  // the bench's PR #7 fix — see admin-compat/transaction.ts when slice 4
  // lands.
  get(ref: DocumentReference): Promise<DocumentSnapshot>;
  get(query: Query): Promise<QuerySnapshot>;
  set(ref: DocumentReference, data: DocumentData): Transaction;
  update(ref: DocumentReference, data: DocumentData): Transaction;
  delete(ref: DocumentReference): Transaction;
}

export interface Firestore {
  collection(path: string): CollectionReference;
  doc(path: string): DocumentReference;
  /**
   * Cross-collection query — returns a `Query` that scans every
   * document under every collection whose final segment matches
   * `collectionId`, regardless of position in the path. Matches the
   * Admin SDK's `Firestore.collectionGroup(id)` shape.
   *
   * The returned `Query` accepts `where` / `orderBy` / `limit` like
   * any other; the simulator gathers all candidate docs first, then
   * applies the constraints in-memory.
   */
  collectionGroup(collectionId: string): Query;
  batch(): WriteBatch;
  runTransaction<R>(
    fn: (tx: Transaction) => Promise<R> | R,
    opts?: OperationOptions,
  ): Promise<R>;
}

// ─────────────────────────────────────────────────────────────────────────
// FieldValue — the user-facing static-method shape over the SDK's
// already-shipped sentinel constructors in
// `simulator/converters/fieldvalue.ts`.
// ─────────────────────────────────────────────────────────────────────────
//
// Every method below produces a sentinel object with the exact `__type`
// discriminator the simulator's converters detect. The SDK's
// `INCREMENT()`/`ARRAY_UNION()`/`ARRAY_REMOVE()`/`DELETE_FIELD` are the
// canonical producers; this class is a thin compat-shape facade. Single
// source of truth for sentinel grammar — no duplicate detection logic.

export type FieldValueSentinel =
  | { __type: 'serverTimestamp' }
  | { __type: 'increment'; value: number }
  | { __type: 'arrayUnion'; values: unknown[] }
  | { __type: 'arrayRemove'; values: unknown[] }
  | { __type: 'deleteField' };

export class FieldValue {
  static serverTimestamp(): FieldValueSentinel {
    return { __type: 'serverTimestamp' };
  }
  static increment(n: number): FieldValueSentinel {
    return { __type: 'increment', value: n };
  }
  static arrayUnion(...values: unknown[]): FieldValueSentinel {
    return { __type: 'arrayUnion', values };
  }
  static arrayRemove(...values: unknown[]): FieldValueSentinel {
    return { __type: 'arrayRemove', values };
  }
  static delete(): FieldValueSentinel {
    return { __type: 'deleteField' };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Timestamp — Admin SDK shape (`seconds` + `nanoseconds`). Distinct from
// the rules-internal Timestamp at `simulator/wrappers/timestamp.ts` which
// uses `nanos` and carries evaluator hooks (binaryOp/callMethod). Both
// round-trip through the same `__type:'timestamp'` discriminator on the
// wire; the compat class is the user-facing surface.
// ─────────────────────────────────────────────────────────────────────────

export class Timestamp {
  constructor(
    public readonly seconds: number,
    public readonly nanoseconds: number,
  ) {
    registerActivityValue(
      this,
      boundedActivityIdentity('timestamp', String(seconds), '\0', String(nanoseconds)),
    );
    registerQueryValue(this, Object.freeze({
      type: 'timestamp',
      seconds,
      nanoseconds,
    }), () => new Timestamp(seconds, nanoseconds));
  }
  static now(): Timestamp {
    return Timestamp.fromMillis(Date.now());
  }
  static fromDate(d: Date): Timestamp {
    return Timestamp.fromMillis(d.getTime());
  }
  static fromMillis(ms: number): Timestamp {
    // FS-B12 — derive nanoseconds as `floor((ms - seconds*1000) * 1e6)` so
    // the value is ALWAYS non-negative (matching `fb.Timestamp.fromMillis`).
    // The old `(ms % 1000) * 1e6` produced negative nanos for negative
    // millis, so `fromMillis(-500)` round-tripped to -1500 via toMillis().
    const seconds = Math.floor(ms / 1000);
    const nanoseconds = Math.floor((ms - seconds * 1000) * 1_000_000);
    return new Timestamp(seconds, nanoseconds);
  }
  toDate(): Date {
    return new Date(this.toMillis());
  }
  toMillis(): number {
    // FS-B12 — `nanoseconds / 1e6` (matching `fb.Timestamp.toMillis`), not
    // `floor(nanoseconds / 1e6)`; the floor dropped sub-millisecond nanos
    // and broke the negative-millis round-trip.
    return this.seconds * 1000 + this.nanoseconds / 1_000_000;
  }
  /** FS-B12 — value equality, mirroring `fb.Timestamp.isEqual`. */
  isEqual(other: Timestamp): boolean {
    return other.seconds === this.seconds && other.nanoseconds === this.nanoseconds;
  }
  /** FS-B12 — textual form, mirroring `fb.Timestamp.toString`. */
  toString(): string {
    return `Timestamp(seconds=${this.seconds}, nanoseconds=${this.nanoseconds})`;
  }
  /** FS-B12 — JSON form, mirroring `fb.Timestamp.toJSON`. */
  toJSON(): { type: string; seconds: number; nanoseconds: number } {
    return {
      type: 'firestore/timestamp/1.0',
      seconds: this.seconds,
      nanoseconds: this.nanoseconds,
    };
  }
  /**
   * FS-B12 — primitive coercion for `<`/`<=`/`>=`/`>` comparisons, mirroring
   * `fb.Timestamp.valueOf`: a zero-padded `<seconds>.<nanoseconds>` string
   * (seconds offset by MIN_SECONDS so it stays non-negative and lexically
   * ordered).
   */
  valueOf(): string {
    const MIN_SECONDS = -62_135_596_800;
    const adjustedSeconds = this.seconds - MIN_SECONDS;
    const formattedSeconds = String(adjustedSeconds).padStart(12, '0');
    const formattedNanoseconds = String(this.nanoseconds).padStart(9, '0');
    return `${formattedSeconds}.${formattedNanoseconds}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Simulator error types re-exported for the admin-compatible surface.
// ─────────────────────────────────────────────────────────────────────────

// Consumers reaching for typed errors need not import the engine module.
export type {
  FirestoreErrorCode,
  FirestoreSimError,
  FirestoreEvalRequest,
  FirestoreEvalResource,
} from 'pyric/sandbox/internal';
