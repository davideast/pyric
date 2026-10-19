/**
 * Firestore reference, query, and sentinel factories — the synchronous,
 * client-side descriptor builders. No RPC fires here: each returns a handle or
 * marker carrying a serializable descriptor the execution functions send later.
 */

import type {
  DocRef,
  CollRef,
  GroupRef,
  QueryDescriptor,
  QueryConstraintDescriptor,
  FilterConstraintDescriptor,
  TargetDescriptor,
  SentinelMarker,
} from '../protocol.js';
import { lastSegment } from './handles.js';
import type { ClientDb, DocRefHandle, CollRefHandle, QueryHandle } from './handles.js';
import { createDocumentReference } from './firestore-reference.js';
import { FirebaseError } from 'pyric/app';
import { encodeDocValue, DOC_VALUE_ENCODING } from 'pyric/firestore/internal/value-codec';
import { generateAutoId } from 'pyric/sandbox/internal';
import type { DocumentData, FieldPath, FirestoreDataConverter, QueryConstraintType } from 'pyric/firestore';
import { rawClientSnapshotForCursor, type RawCursorSnapshot } from './snapshots.js';

// ─── Path factories (client-side only — no RPC) ──────────────────────────

/**
 * Build a document reference. Mirrors `pyric/firestore`'s `doc(db, path)`.
 *
 * WHY CLIENT-SIDE: Firebase's `doc()` is synchronous and path-only — it
 * needs no data from the sandbox. We build a descriptor object here and
 * include the port so execution calls can route to the worker.
 */
export function doc(
  parent: ClientDb | CollRefHandle,
  ...pathSegments: string[]
): DocRefHandle {
  const port = parent.port;
  let path: string;
  let converter: FirestoreDataConverter<unknown> | null = null;

  const isDatabase = parent.__kind === 'client-db';
  const hasPath = pathSegments.length > 0;
  if (isDatabase) {
    const isPathMissing = !hasPath;
    if (isPathMissing) throw new TypeError('doc(db, path) requires a path segment.');
    path = pathSegments.join('/');
  } else {
    // parent is a CollRefHandle
    const collPath = parent.descriptor.path;
    converter = parent.converter;
    // No segment means Firebase mints a client-side id for a document that
    // does not exist yet; the collection path itself is not a document.
    if (hasPath) path = `${collPath}/${pathSegments.join('/')}`;
    else path = `${collPath}/${generateAutoId()}`;
  }

  return createDocumentReference(port, path, converter);
}

/**
 * Build a collection reference. Mirrors `pyric/firestore`'s `collection(db, path)`.
 */
export function collection(
  parent: ClientDb | DocRefHandle,
  ...pathSegments: string[]
): CollRefHandle {
  const port = parent.port;
  if (pathSegments.length === 0) throw new TypeError('collection() requires a path segment.');

  let path: string;
  if (parent.__kind === 'client-db') {
    path = pathSegments.join('/');
  } else {
    const docPath = (parent as DocRefHandle).descriptor.path;
    path = `${docPath}/${pathSegments.join('/')}`;
  }

  // A parent document's converter describes that document, not the documents
  // of a subcollection under it, so it is not inherited here.
  return createCollectionReference(port, path, null);
}

/** Collection handles are rebuilt per view so each carries its own converter. */
function createCollectionReference<T = DocumentData>(
  port: ClientDb['port'],
  path: string,
  converter: FirestoreDataConverter<unknown> | null,
): CollRefHandle<T> {
  function withConverter<A, D extends DocumentData = DocumentData>(next: FirestoreDataConverter<A, D>): CollRefHandle<A>;
  function withConverter(next: null): CollRefHandle;
  function withConverter(next: FirestoreDataConverter<unknown> | null): CollRefHandle<unknown> {
    return createCollectionReference(port, path, next);
  }
  const descriptor: CollRef = { __ref: 'collection', path };
  return {
    __kind: 'coll-ref',
    descriptor,
    port,
    id: lastSegment(path),
    path,
    converter,
    withConverter,
  };
}

/** Query handles are rebuilt per view so each carries its own converter. */
function createQueryHandle<T = DocumentData>(
  port: ClientDb['port'],
  descriptor: QueryDescriptor,
  converter: FirestoreDataConverter<unknown> | null,
): QueryHandle<T> {
  function withConverter<A, D extends DocumentData = DocumentData>(next: FirestoreDataConverter<A, D>): QueryHandle<A>;
  function withConverter(next: null): QueryHandle;
  function withConverter(next: FirestoreDataConverter<unknown> | null): QueryHandle<unknown> {
    return createQueryHandle(port, descriptor, next);
  }
  return { __kind: 'query', descriptor, port, converter, withConverter };
}

/**
 * Build a collection-group query. Mirrors `pyric/firestore`'s `collectionGroup(db, id)`.
 */
export function collectionGroup(db: ClientDb, collectionId: string): QueryHandle {
  const descriptor: QueryDescriptor = {
    __ref: 'query',
    source: { __ref: 'group', collectionId },
    constraints: [],
  };
  return createQueryHandle(db.port, descriptor, null);
}

// ─── Query constraint factories (client-side) ─────────────────────────────

/** Opaque query constraint — carries its descriptor for embedding in queries. */
export interface QueryConstraintHandle {
  readonly type: QueryConstraintType;
  readonly _descriptor: QueryConstraintDescriptor;
}

type CursorConstraintKind = 'startAt' | 'startAfter' | 'endAt' | 'endBefore';

interface PendingSnapshotCursor {
  readonly __snapshotCursor: true;
  readonly kind: CursorConstraintKind;
  readonly snapshot: RawCursorSnapshot;
}

type RawConstraintItem = QueryConstraintDescriptor | PendingSnapshotCursor;

const KEY_FIELD = '__name__';
const INEQUALITY_OPERATORS = new Set(['<', '<=', '>', '>=', '!=', 'not-in']);
const snapshotCursors = new WeakMap<QueryConstraintHandle, PendingSnapshotCursor>();
const rawQueryItems = new WeakMap<QueryHandle, readonly RawConstraintItem[]>();

function fieldPathString(field: string | FieldPath): string {
  return typeof field === 'string' ? field : field._internalPath.segments.join('.');
}

function readSnapshotField(data: Record<string, unknown>, fieldPath: string): unknown {
  if (!fieldPath.includes('.')) return data[fieldPath];
  let current: unknown = data;
  for (const segment of fieldPath.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function collectInequalityFields(filter: FilterConstraintDescriptor, out: string[]): void {
  if (filter.kind === 'where') {
    if (INEQUALITY_OPERATORS.has(filter.op)) out.push(filter.field);
    return;
  }
  for (const nested of filter.filters) collectInequalityFields(nested, out);
}

function isDocumentSnapshotArg(args: readonly unknown[]): args is [object & { data: () => Record<string, unknown> | undefined }] {
  return args.length === 1
    && args[0] !== null
    && typeof args[0] === 'object'
    && 'data' in args[0]
    && typeof (args[0] as { data?: unknown }).data === 'function';
}

function makeCursorConstraint(kind: CursorConstraintKind, args: readonly unknown[]): QueryConstraintHandle {
  if (!isDocumentSnapshotArg(args)) {
    return {
      type: kind,
      _descriptor: { kind, values: args.map(encodeDocValue), valueEncoding: DOC_VALUE_ENCODING },
    };
  }
  const candidate = args[0] as {
    id?: unknown;
    path?: unknown;
    ref?: { path?: string };
    exists?: unknown;
    data: () => Record<string, unknown> | undefined;
  };
  const captured: RawCursorSnapshot = rawClientSnapshotForCursor(candidate) ?? (() => {
    const data = candidate.data();
    const id = typeof candidate.id === 'string' ? candidate.id : '';
    const path = typeof candidate.path === 'string'
      ? candidate.path
      : (typeof candidate.ref?.path === 'string' ? candidate.ref.path : id);
    const exists = typeof candidate.exists === 'function'
      ? Boolean((candidate.exists as () => boolean)())
      : data !== undefined;
    return { id, path, exists, data };
  })();
  const handle: QueryConstraintHandle = {
    type: kind,
    _descriptor: { kind, values: [], valueEncoding: DOC_VALUE_ENCODING },
  };
  snapshotCursors.set(handle, { __snapshotCursor: true, kind, snapshot: captured });
  return handle;
}

function isSnapshotCursor(item: RawConstraintItem): item is PendingSnapshotCursor {
  return '__snapshotCursor' in item;
}

function resolveQueryConstraints(items: readonly RawConstraintItem[]): QueryConstraintDescriptor[] {
  const hasSnapshotCursor = items.some(isSnapshotCursor);
  if (!hasSnapshotCursor) return items as QueryConstraintDescriptor[];

  const explicitOrders: Array<{ field: string; direction: 'asc' | 'desc' }> = [];
  const inequalityFields: string[] = [];
  for (const item of items) {
    if (isSnapshotCursor(item)) continue;
    if (item.kind === 'orderBy') {
      explicitOrders.push({ field: item.field, direction: item.direction ?? 'asc' });
    } else if (item.kind === 'where' || item.kind === 'and' || item.kind === 'or') {
      collectInequalityFields(item, inequalityFields);
    }
  }

  const normalizedOrders = [...explicitOrders];
  const seen = new Set(normalizedOrders.map((order) => order.field));
  const lastDirection: 'asc' | 'desc' = explicitOrders.length > 0
    ? explicitOrders[explicitOrders.length - 1]!.direction
    : 'asc';
  for (const field of inequalityFields) {
    if (field !== KEY_FIELD && !seen.has(field)) {
      seen.add(field);
      normalizedOrders.push({ field, direction: lastDirection });
    }
  }
  if (!seen.has(KEY_FIELD)) {
    normalizedOrders.push({ field: KEY_FIELD, direction: lastDirection });
  }

  // Place normalized `orderBy` clauses before resolved snapshot cursors so host
  // positional cursor normalization sees every sort slot including `__name__`.
  const resolved: QueryConstraintDescriptor[] = normalizedOrders.map((order) => ({
    kind: 'orderBy',
    field: order.field,
    direction: order.direction,
  }));

  for (const item of items) {
    if (isSnapshotCursor(item)) {
      const { snapshot } = item;
      if (!snapshot.exists || snapshot.data === undefined) {
        throw new FirebaseError(
          'not-found',
          `Snapshot-based cursors require an existing document — got an empty snapshot for ${snapshot.id || '<unknown>'}.`,
        );
      }
      const values = normalizedOrders.map((order) =>
        order.field === KEY_FIELD
          ? encodeDocValue(snapshot.path)
          : encodeDocValue(readSnapshotField(snapshot.data!, order.field)),
      );
      resolved.push({ kind: item.kind, values, valueEncoding: DOC_VALUE_ENCODING });
      continue;
    }
    if (item.kind === 'orderBy') continue;
    resolved.push(item);
  }
  return resolved;
}

export function where(field: string | FieldPath, op: string, value: unknown): QueryConstraintHandle {
  const encoded = encodeDocValue(value);
  return {
    type: 'where',
    _descriptor: { kind: 'where', field: fieldPathString(field), op, value: encoded, valueEncoding: DOC_VALUE_ENCODING },
  };
}

/**
 * Extract a constraint's FILTER descriptor for composite embedding — throws
 * the same TypeError `pyric/firestore`'s `and()`/`or()` raise when handed a
 * non-filter (`orderBy` / `limit` / cursors are not valid inside composites).
 */
function toFilterDescriptor(
  kind: 'and' | 'or',
  c: QueryConstraintHandle,
): FilterConstraintDescriptor {
  const d = c._descriptor;
  if (d.kind !== 'where' && d.kind !== 'and' && d.kind !== 'or') {
    throw new TypeError(
      `pyric worker client: ${kind}() received a non-filter constraint (orderBy / limit are not valid here).`,
    );
  }
  return d;
}

function composite(kind: 'and' | 'or', filters: QueryConstraintHandle[]): QueryConstraintHandle {
  if (filters.length === 0) {
    throw new TypeError(`pyric worker client: ${kind}() requires at least one filter argument.`);
  }
  return { type: kind, _descriptor: { kind, filters: filters.map((f) => toFilterDescriptor(kind, f)) } };
}

/**
 * OR composite filter — at least one operand must match. Operands must be
 * filters (`where()`, or nested `or()`/`and()`). Mirrors `pyric/firestore`'s
 * `or(...)`; the worker rebuilds it with the real modular factory.
 */
export function or(...filters: QueryConstraintHandle[]): QueryConstraintHandle {
  return composite('or', filters);
}

/** AND composite filter — every operand must match. See {@link or}. */
export function and(...filters: QueryConstraintHandle[]): QueryConstraintHandle {
  return composite('and', filters);
}

export function orderBy(field: string | FieldPath, direction?: 'asc' | 'desc'): QueryConstraintHandle {
  return { type: 'orderBy', _descriptor: { kind: 'orderBy', field: fieldPathString(field), direction } };
}

export function limit(n: number): QueryConstraintHandle {
  return { type: 'limit', _descriptor: { kind: 'limit', n } };
}

export function limitToLast(n: number): QueryConstraintHandle {
  return { type: 'limitToLast', _descriptor: { kind: 'limitToLast', n } };
}

export function startAt(...values: unknown[]): QueryConstraintHandle {
  return makeCursorConstraint('startAt', values);
}

export function startAfter(...values: unknown[]): QueryConstraintHandle {
  return makeCursorConstraint('startAfter', values);
}

export function endAt(...values: unknown[]): QueryConstraintHandle {
  return makeCursorConstraint('endAt', values);
}

export function endBefore(...values: unknown[]): QueryConstraintHandle {
  return makeCursorConstraint('endBefore', values);
}

/**
 * Apply query constraints to a source ref or query.
 * Mirrors `pyric/firestore`'s `query(source, ...constraints)`.
 */
export function query(
  source: CollRefHandle | QueryHandle,
  ...constraints: QueryConstraintHandle[]
): QueryHandle {
  const sourceDescriptor: TargetDescriptor =
    source.__kind === 'coll-ref'
      ? (source as CollRefHandle).descriptor
      : (source as QueryHandle).descriptor;

  const existingItems: readonly RawConstraintItem[] =
    source.__kind === 'query'
      ? (rawQueryItems.get(source as QueryHandle) ?? (source as QueryHandle).descriptor.constraints)
      : [];

  const allItems: RawConstraintItem[] = [
    ...existingItems,
    ...constraints.map((c) => snapshotCursors.get(c) ?? c._descriptor),
  ];

  const descriptor: QueryDescriptor = {
    __ref: 'query',
    source: sourceDescriptor.__ref === 'query'
      ? (sourceDescriptor as QueryDescriptor).source
      : (sourceDescriptor as DocRef | CollRef | GroupRef),
    constraints: resolveQueryConstraints(allItems),
  };
  const handle = createQueryHandle(source.port, descriptor, source.converter);
  rawQueryItems.set(handle, allItems);
  return handle;
}

// ─── Sentinel factories (client-side markers) ────────────────────────────

export function serverTimestamp(): SentinelMarker {
  return { __sentinel: 'serverTimestamp' };
}

export function increment(n: number): SentinelMarker {
  return { __sentinel: 'increment', n };
}

export function arrayUnion(...values: unknown[]): SentinelMarker {
  return { __sentinel: 'arrayUnion', values };
}

export function arrayRemove(...values: unknown[]): SentinelMarker {
  return { __sentinel: 'arrayRemove', values };
}

export function deleteField(): SentinelMarker {
  return { __sentinel: 'deleteField' };
}
