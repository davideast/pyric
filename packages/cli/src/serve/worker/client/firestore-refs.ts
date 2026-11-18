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
import { normalizeQueryOrders } from 'pyric/firestore/internal/implicit-order';
import {
  fieldPathArgumentSegments,
  fieldPathKey,
  fieldPathKeySegments,
} from 'pyric/firestore/internal/update-fields';
import { generateAutoId } from 'pyric/sandbox/internal';
import type { DocumentData, FieldPath, FirestoreDataConverter, QueryConstraintType } from 'pyric/firestore';
import { validateResolvedQueryConstraint } from './firestore-query-validation.js';
import { rawClientSnapshotForCursor, type RawCursorSnapshot } from './snapshots.js';

// ─── Path factories (client-side only — no RPC) ──────────────────────────

function parseClientPathSegments(fnName: 'doc' | 'collection', rawSegments: readonly string[]): string[] {
  const segments: string[] = [];
  for (const raw of rawSegments) {
    if (typeof raw !== 'string') {
      throw new FirebaseError('invalid-argument', `Function ${fnName}() called with non-string path.`);
    }
    if (raw.includes('//')) {
      throw new FirebaseError('invalid-argument', `Invalid path (${raw}). Paths must not contain '//' in them.`);
    }
    const trimmed = raw.replace(/^\/+|\/+$/g, '');
    if (trimmed.length === 0) {
      throw new FirebaseError('invalid-argument', `Invalid path (${raw}). Paths must not be empty.`);
    }
    segments.push(...trimmed.split('/'));
  }
  return segments;
}

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
    const segments = parseClientPathSegments('doc', pathSegments);
    if (segments.length % 2 !== 0) {
      throw new FirebaseError(
        'invalid-argument',
        `Invalid document reference. Document references must have an even number of segments, but ${segments.join('/')} has ${segments.length}.`,
      );
    }
    path = segments.join('/');
  } else {
    // parent is a CollRefHandle
    const collPath = parent.descriptor.path;
    converter = parent.converter;
    // No segment means Firebase mints a client-side id for a document that
    // does not exist yet; the collection path itself is not a document.
    if (hasPath) {
      const relSegments = parseClientPathSegments('doc', pathSegments);
      const allSegments = [...collPath.split('/'), ...relSegments];
      if (allSegments.length % 2 !== 0) {
        throw new FirebaseError(
          'invalid-argument',
          `Invalid document reference. Document references must have an even number of segments, but ${allSegments.join('/')} has ${allSegments.length}.`,
        );
      }
      path = allSegments.join('/');
    } else {
      path = `${collPath}/${generateAutoId()}`;
    }
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

  const relSegments = parseClientPathSegments('collection', pathSegments);
  const baseSegments = parent.__kind === 'client-db'
    ? []
    : (parent as DocRefHandle).descriptor.path.split('/');
  const allSegments = [...baseSegments, ...relSegments];
  if (allSegments.length % 2 !== 1) {
    throw new FirebaseError(
      'invalid-argument',
      `Invalid collection reference. Collection references must have an odd number of segments, but ${allSegments.join('/')} has ${allSegments.length}.`,
    );
  }
  const path = allSegments.join('/');

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
  items?: readonly RawConstraintItem[],
): QueryHandle<T> {
  function withConverter<A, D extends DocumentData = DocumentData>(next: FirestoreDataConverter<A, D>): QueryHandle<A>;
  function withConverter(next: null): QueryHandle;
  function withConverter(next: FirestoreDataConverter<unknown> | null): QueryHandle<unknown> {
    return createQueryHandle(port, descriptor, next, rawQueryItems.get(handle));
  }
  const handle: QueryHandle<T> = { __kind: 'query', descriptor, port, converter, withConverter };
  if (items !== undefined) rawQueryItems.set(handle, items);
  return handle;
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

function encodeConstraintField(field: string | FieldPath): {
  field: string;
  fieldSegments?: readonly string[];
} {
  if (typeof field === 'string') return { field };
  const segments = fieldPathArgumentSegments(field) ?? field._internalPath.segments;
  return { field: fieldPathKey(segments), fieldSegments: [...segments] };
}

function canonicalConstraintFieldKey(item: {
  field: string;
  fieldSegments?: readonly string[];
}): string {
  if (item.fieldSegments !== undefined) {
    return fieldPathKey(item.fieldSegments);
  }
  return fieldPathKey(item.field.split('.'));
}

function readSnapshotField(data: Record<string, unknown>, fieldPath: string): unknown {
  let current: unknown = data;
  for (const segment of fieldPathKeySegments(fieldPath)) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function collectInequalityFields(filter: FilterConstraintDescriptor, out: string[]): void {
  if (filter.kind === 'where') {
    if (INEQUALITY_OPERATORS.has(filter.op)) out.push(canonicalConstraintFieldKey(filter));
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
  const explicitOrders: Array<{ field: string; direction: 'asc' | 'desc' }> = [];
  const inequalityFields: string[] = [];
  for (const item of items) {
    if (isSnapshotCursor(item)) continue;
    if (item.kind === 'orderBy') {
      explicitOrders.push({
        field: canonicalConstraintFieldKey(item),
        direction: item.direction ?? 'asc',
      });
    } else if (item.kind === 'where' || item.kind === 'and' || item.kind === 'or') {
      collectInequalityFields(item, inequalityFields);
    }
  }

  let normalizedOrders: ReturnType<typeof normalizeQueryOrders> = [];
  if (items.some(isSnapshotCursor)) {
    normalizedOrders = normalizeQueryOrders(explicitOrders, inequalityFields);
  }

  const resolved: QueryConstraintDescriptor[] = [];
  const ordersSeenSoFar: string[] = [];
  const allExplicitOrderFields = explicitOrders.map((entry) => entry.field);

  for (const item of items) {
    if (isSnapshotCursor(item)) {
      const { snapshot } = item;
      if (!snapshot.exists || snapshot.data === undefined) {
        throw new FirebaseError(
          'not-found',
          `Snapshot-based cursors require an existing document — got an empty snapshot for ${snapshot.id || '<unknown>'}.`,
        );
      }
      const snapData = snapshot.data;
      const values = normalizedOrders.map((order) => {
        if (order.field === KEY_FIELD) {
          return { __type: 'reference', path: snapshot.path };
        }
        return encodeDocValue(readSnapshotField(snapData, order.field));
      });
      const builtCursor: QueryConstraintDescriptor = {
        kind: item.kind,
        values,
        fromSnapshot: true,
        valueEncoding: DOC_VALUE_ENCODING,
      };
      validateResolvedQueryConstraint(builtCursor, ordersSeenSoFar);
      resolved.push(builtCursor);
      continue;
    }
    if (item.kind === 'orderBy') {
      ordersSeenSoFar.push(canonicalConstraintFieldKey(item));
    }
    validateResolvedQueryConstraint(item, allExplicitOrderFields);
    resolved.push(item);
  }
  return resolved;
}

export function where(field: string | FieldPath, op: string, value: unknown): QueryConstraintHandle {
  const encoded = encodeDocValue(value);
  const encodedField = encodeConstraintField(field);
  const descriptor: Extract<QueryConstraintDescriptor, { kind: 'where' }> = {
    kind: 'where',
    field: encodedField.field,
    op,
    value: encoded,
    valueEncoding: DOC_VALUE_ENCODING,
  };
  if (encodedField.fieldSegments !== undefined) {
    descriptor.fieldSegments = encodedField.fieldSegments;
  }
  return {
    type: 'where',
    _descriptor: descriptor,
  };
}

const TOP_LEVEL_COMPOSITE_MIXING_MESSAGE =
  'InvalidQuery. When using composite filters, you cannot use more than one filter at the top level. ' +
  'Consider nesting the multiple filters within an `and(...)` statement. For example: ' +
  'change `query(query, where(...), or(...))` to `query(query, and(where(...), or(...)))`.';

function assertWorkerTopLevelCompositeFilterMixing(
  constraints: readonly QueryConstraintHandle[],
): void {
  let compositeFilterCount = 0;
  let fieldFilterCount = 0;
  for (const constraint of constraints) {
    if (constraint.type === 'or' || constraint.type === 'and') {
      compositeFilterCount += 1;
    } else if (constraint.type === 'where') {
      fieldFilterCount += 1;
    }
  }
  if (compositeFilterCount > 1 || (compositeFilterCount > 0 && fieldFilterCount > 0)) {
    throw new FirebaseError('invalid-argument', TOP_LEVEL_COMPOSITE_MIXING_MESSAGE);
  }
}

function assertPositiveWorkerLimit(
  methodName: 'limit' | 'limitToLast',
  n: number,
): void {
  if (n <= 0) {
    throw new FirebaseError(
      'invalid-argument',
      `Function ${methodName}() requires a positive number, but it was: ${n}.`,
    );
  }
}

function toFilterDescriptor(
  kind: 'and' | 'or',
  c: QueryConstraintHandle,
): FilterConstraintDescriptor {
  if (!c || typeof c !== 'object' || !('_descriptor' in c)) {
    throw new FirebaseError(
      'invalid-argument',
      `Function ${kind}() requires AppliableConstraints created with a call to 'where(...)', 'or(...)', or 'and(...)'.`,
    );
  }
  const d = c._descriptor;
  if (!d || (d.kind !== 'where' && d.kind !== 'and' && d.kind !== 'or')) {
    throw new FirebaseError(
      'invalid-argument',
      `Function ${kind}() requires AppliableConstraints created with a call to 'where(...)', 'or(...)', or 'and(...)'.`,
    );
  }
  return d;
}

function composite(kind: 'and' | 'or', filters: QueryConstraintHandle[]): QueryConstraintHandle {
  const subs: FilterConstraintDescriptor[] = [];
  for (const filter of filters) {
    const sub = toFilterDescriptor(kind, filter);
    if (sub.kind !== 'where' && sub.filters.length === 0) {
      continue;
    }
    subs.push(sub);
  }
  return { type: kind, _descriptor: { kind, filters: subs } };
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
  const encodedField = encodeConstraintField(field);
  const descriptor: Extract<QueryConstraintDescriptor, { kind: 'orderBy' }> = {
    kind: 'orderBy',
    field: encodedField.field,
    direction,
  };
  if (encodedField.fieldSegments !== undefined) {
    descriptor.fieldSegments = encodedField.fieldSegments;
  }
  return {
    type: 'orderBy',
    _descriptor: descriptor,
  };
}

export function limit(n: number): QueryConstraintHandle {
  assertPositiveWorkerLimit('limit', n);
  return { type: 'limit', _descriptor: { kind: 'limit', n } };
}

export function limitToLast(n: number): QueryConstraintHandle {
  assertPositiveWorkerLimit('limitToLast', n);
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
  assertWorkerTopLevelCompositeFilterMixing(constraints);
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
  return createQueryHandle(source.port, descriptor, source.converter, allItems);
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
