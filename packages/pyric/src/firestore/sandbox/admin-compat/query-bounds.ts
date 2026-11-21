import {
  FieldPath,
  fieldPathSegments,
  getSnapshotField,
  type SnapshotFieldPath,
} from './field-path.js';
import {
  fieldPathKey,
  fieldPathKeySegments,
} from '../update-fields.js';
import type { QueryFilter, QueryOrderClause } from '../query-execution.js';
import {
  FirestoreCompatError,
  type DocumentReference,
  type DocumentSnapshot,
  type Filter,
} from './types.js';

export const KEY_FIELD = '__name__';

type DocumentRefFactory = (path: string) => DocumentReference;

/**
 * Pull the cursor values out of a `DocumentSnapshot` at the query's
 * orderBy fields. Backs the `startCursorFromSnapshot` /
 * `endCursorFromSnapshot` overload that mirrors the JS SDK's
 * `startAt(snapshot)` / `startAfter(snapshot)` / `endAt(snapshot)` /
 * `endBefore(snapshot)`.
 */
export function cursorValuesFromSnapshot(
  snapshot: DocumentSnapshot,
  orders: readonly QueryOrderClause[],
  documentRef: DocumentRefFactory,
): unknown[] {
  const data = snapshot.data();
  if (data === undefined) {
    const snapId = snapshot.id ?? '<unknown>';
    throw new FirestoreCompatError({
      code: 'not-found',
      message:
        'Snapshot-based cursors require an existing document -- got an empty '
        + `snapshot for ${snapId}.`,
    });
  }
  return orders.map((order) => {
    if (order.field === KEY_FIELD) {
      const refPath = snapshot.ref?.path;
      if (typeof refPath === 'string') return documentRef(refPath);
      return snapshot.ref;
    }
    const lookupField = new FieldPath(...fieldPathKeySegments(order.field));
    return getSnapshotField(data, lookupField);
  });
}

export function normalizeQueryField(field: SnapshotFieldPath): string {
  try {
    return fieldPathKey(fieldPathSegments(field));
  } catch (error) {
    let message = String(error);
    if (error instanceof Error) message = error.message;
    throw new FirestoreCompatError({
      code: 'invalid-argument',
      message,
    });
  }
}

export function normalizeFilterFields(filter: Filter): QueryFilter {
  if (filter.kind === 'where') {
    return {
      kind: 'where',
      field: normalizeQueryField(filter.field),
      op: filter.op,
      value: filter.value,
    };
  }
  return {
    kind: filter.kind,
    filters: filter.filters.map(normalizeFilterFields),
  };
}

export function assertFiniteLimit(n: number): void {
  if (!Number.isFinite(n)) {
    throw new FirestoreCompatError({
      code: 'invalid-argument',
      message: 'Query limit must be a finite number.',
    });
  }
}
