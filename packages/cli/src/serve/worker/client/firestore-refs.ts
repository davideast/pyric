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
import { encodeDocValue, DOC_VALUE_ENCODING } from 'pyric/firestore/internal/value-codec';

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

  const isDatabase = parent.__kind === 'client-db';
  const hasPath = pathSegments.length > 0;
  if (isDatabase) {
    const isPathMissing = !hasPath;
    if (isPathMissing) throw new TypeError('doc(db, path) requires a path segment.');
    path = pathSegments.join('/');
  } else {
    // parent is a CollRefHandle
    const collPath = parent.descriptor.path;
    path = collPath;
    if (hasPath) path = `${collPath}/${pathSegments.join('/')}`;
  }

  return createDocumentReference(port, path);
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

  const descriptor: CollRef = { __ref: 'collection', path };
  return {
    __kind: 'coll-ref',
    descriptor,
    port,
    id: lastSegment(path),
    path,
  };
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
  return { __kind: 'query', descriptor, port: db.port };
}

// ─── Query constraint factories (client-side) ─────────────────────────────

/** Opaque query constraint — carries its descriptor for embedding in queries. */
export interface QueryConstraintHandle {
  readonly _descriptor: QueryConstraintDescriptor;
}

export function where(field: string, op: string, value: unknown): QueryConstraintHandle {
  const encoded = encodeDocValue(value);
  return { _descriptor: { kind: 'where', field, op, value: encoded, valueEncoding: DOC_VALUE_ENCODING } };
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
  return { _descriptor: { kind, filters: filters.map((f) => toFilterDescriptor(kind, f)) } };
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

export function orderBy(field: string, direction?: 'asc' | 'desc'): QueryConstraintHandle {
  return { _descriptor: { kind: 'orderBy', field, direction } };
}

export function limit(n: number): QueryConstraintHandle {
  return { _descriptor: { kind: 'limit', n } };
}

export function limitToLast(n: number): QueryConstraintHandle {
  return { _descriptor: { kind: 'limitToLast', n } };
}

export function startAt(...values: unknown[]): QueryConstraintHandle {
  return { _descriptor: { kind: 'startAt', values: values.map(encodeDocValue), valueEncoding: DOC_VALUE_ENCODING } };
}

export function startAfter(...values: unknown[]): QueryConstraintHandle {
  return { _descriptor: { kind: 'startAfter', values: values.map(encodeDocValue), valueEncoding: DOC_VALUE_ENCODING } };
}

export function endAt(...values: unknown[]): QueryConstraintHandle {
  return { _descriptor: { kind: 'endAt', values: values.map(encodeDocValue), valueEncoding: DOC_VALUE_ENCODING } };
}

export function endBefore(...values: unknown[]): QueryConstraintHandle {
  return { _descriptor: { kind: 'endBefore', values: values.map(encodeDocValue), valueEncoding: DOC_VALUE_ENCODING } };
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

  const existingConstraints: readonly QueryConstraintDescriptor[] =
    source.__kind === 'query'
      ? (source as QueryHandle).descriptor.constraints
      : [];

  const descriptor: QueryDescriptor = {
    __ref: 'query',
    source: sourceDescriptor.__ref === 'query'
      ? (sourceDescriptor as QueryDescriptor).source
      : (sourceDescriptor as DocRef | CollRef | GroupRef),
    constraints: [
      ...existingConstraints,
      ...constraints.map((c) => c._descriptor),
    ],
  };
  return { __kind: 'query', descriptor, port: source.port };
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
