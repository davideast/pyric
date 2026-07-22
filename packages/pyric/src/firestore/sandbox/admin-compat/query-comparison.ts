/** Immutable query operands and structural comparison for `queryEqual`. */

import {
  captureQueryOperand,
  capturedQueryOperandsEqual,
  type CapturedQueryOperand,
} from '../query-operand-equality.js';
import type {
  QueryCursor,
  QueryExecutionSpec,
  QueryFilter,
  QueryScope,
} from '../query-execution.js';
import type { Filter } from './types.js';

export type ComparableQueryFilter =
  | (Extract<QueryFilter, { kind: 'where' }> & {
    readonly comparisonValue: CapturedQueryOperand;
  })
  | { readonly kind: 'and' | 'or'; readonly filters: readonly ComparableQueryFilter[] };

export type ComparableCursor = QueryCursor & {
  readonly comparisonValues: readonly CapturedQueryOperand[];
};

export type ComparableExecutionSpec = Omit<QueryExecutionSpec, 'filters' | 'start' | 'end'> & {
  readonly filters: readonly ComparableQueryFilter[];
  readonly start?: ComparableCursor;
  readonly end?: ComparableCursor;
};

export function snapshotFilter(
  filter: Filter | QueryFilter | ComparableQueryFilter,
  owner?: object,
): ComparableQueryFilter {
  if (filter.kind === 'where') {
    const comparisonValue = 'comparisonValue' in filter
      ? filter.comparisonValue
      : captureQueryOperand(
        filter.value,
        owner,
        filter.op === 'in' || filter.op === 'not-in',
      );
    return Object.freeze({
      kind: 'where',
      field: filter.field,
      op: filter.op,
      value: comparisonValue.executionValue,
      comparisonValue,
    });
  }
  return Object.freeze({
    kind: filter.kind,
    filters: Object.freeze(filter.filters.map((nested) => snapshotFilter(nested, owner))),
  }) as ComparableQueryFilter;
}

export function snapshotCursor(
  values: readonly unknown[],
  inclusive: boolean,
  fromSnapshot: boolean,
  owner?: object,
): ComparableCursor {
  const comparisonValues = values.map((value) => captureQueryOperand(value, owner));
  return Object.freeze({
    values: Object.freeze(comparisonValues.map((value) => value.executionValue)),
    comparisonValues: Object.freeze(comparisonValues),
    inclusive,
    fromSnapshot,
  });
}

function queryFiltersEqual(
  left: readonly ComparableQueryFilter[],
  right: readonly ComparableQueryFilter[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((filter, index) => {
    const other = right[index]!;
    if (filter.kind !== other.kind) return false;
    if (filter.kind === 'where' && other.kind === 'where') {
      return filter.field === other.field
        && filter.op === other.op
        && capturedQueryOperandsEqual(filter.comparisonValue, other.comparisonValue);
    }
    return filter.kind !== 'where'
      && other.kind !== 'where'
      && queryFiltersEqual(filter.filters, other.filters);
  });
}

function queryCursorsEqual(left?: ComparableCursor, right?: ComparableCursor): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.inclusive === right.inclusive
    && left.comparisonValues.length === right.comparisonValues.length
    && left.comparisonValues.every((value, index) =>
      capturedQueryOperandsEqual(value, right.comparisonValues[index]!));
}

export function queryScopesEqual(left: QueryScope, right: QueryScope): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === 'collection' && right.kind === 'collection'
    ? left.path === right.path
    : left.kind === 'collection-group' && right.kind === 'collection-group'
      && left.collectionId === right.collectionId;
}

export function executionFilter(filter: ComparableQueryFilter): QueryFilter {
  if (filter.kind === 'where') {
    return Object.freeze({
      kind: filter.kind,
      field: filter.field,
      op: filter.op,
      value: filter.value,
    });
  }
  return Object.freeze({
    kind: filter.kind,
    filters: Object.freeze(filter.filters.map(executionFilter)),
  });
}

export function executionCursor(cursor: ComparableCursor | undefined): QueryCursor | undefined {
  if (cursor === undefined) return undefined;
  return Object.freeze({
    values: cursor.values,
    inclusive: cursor.inclusive,
    fromSnapshot: cursor.fromSnapshot,
  });
}

export function queryExecutionEqual(
  left: ComparableExecutionSpec,
  right: ComparableExecutionSpec,
): boolean {
  return queryFiltersEqual(left.filters, right.filters)
    && left.orders.length === right.orders.length
    && left.orders.every((order, index) => {
      const other = right.orders[index]!;
      return order.field === other.field && order.direction === other.direction;
    })
    && left.limitCount === right.limitCount
    && left.limitFromEnd === right.limitFromEnd
    && queryCursorsEqual(left.start, right.start)
    && queryCursorsEqual(left.end, right.end);
}
