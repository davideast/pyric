import type { Constraint, QuerySpec } from './sandbox/query.js';
import {
  CONSTRAINT_SYMBOL,
  QUERY_SYMBOL,
  QueryConstraint,
  type Query,
} from './types.js';

class QueryEndAtConstraint extends QueryConstraint { _apply(): void {} }
class QueryEndBeforeConstraint extends QueryConstraint { _apply(): void {} }
class QueryStartAtConstraint extends QueryConstraint { _apply(): void {} }
class QueryStartAfterConstraint extends QueryConstraint { _apply(): void {} }
class QueryLimitToFirstConstraint extends QueryConstraint { _apply(): void {} }
class QueryLimitToLastConstraint extends QueryConstraint { _apply(): void {} }
class QueryOrderByChildConstraint extends QueryConstraint { _apply(): void {} }
class QueryOrderByKeyConstraint extends QueryConstraint { _apply(): void {} }
class QueryOrderByPriorityConstraint extends QueryConstraint { _apply(): void {} }
class QueryOrderByValueConstraint extends QueryConstraint { _apply(): void {} }
class QueryEqualToValueConstraint extends QueryConstraint { _apply(): void {} }

const constraintConstructors = {
  endAt: QueryEndAtConstraint,
  endBefore: QueryEndBeforeConstraint,
  startAt: QueryStartAtConstraint,
  startAfter: QueryStartAfterConstraint,
  limitToFirst: QueryLimitToFirstConstraint,
  limitToLast: QueryLimitToLastConstraint,
  orderByChild: QueryOrderByChildConstraint,
  orderByKey: QueryOrderByKeyConstraint,
  orderByPriority: QueryOrderByPriorityConstraint,
  orderByValue: QueryOrderByValueConstraint,
  equalTo: QueryEqualToValueConstraint,
} satisfies Record<QueryConstraint['type'], typeof QueryConstraint>;

export function buildConstraint(
  type: QueryConstraint['type'],
  internal: Constraint,
): QueryConstraint {
  const ConstraintConstructor = constraintConstructors[type];
  return Object.freeze(new ConstraintConstructor(type, internal));
}

export function isQuery(value: object): value is Query {
  return QUERY_SYMBOL in value && (value as Query).ref !== value;
}

export function isDefaultQuerySpec(spec: QuerySpec): boolean {
  return spec.orderBy === null && spec.bounds.length === 0 && spec.limit === null;
}

type CanonicalBound = {
  kind: 'startAt' | 'startAfter' | 'endAt' | 'endBefore';
  value: QuerySpec['bounds'][number]['value'];
  key?: string;
};

function canonicalOrderBy(orderBy: QuerySpec['orderBy']): QuerySpec['orderBy'] {
  if (orderBy === null || orderBy.kind === 'priority') {
    return null;
  }
  if (orderBy.kind === 'child') {
    const canonicalPath = orderBy.path
      .split('/')
      .filter((segment) => segment.length > 0)
      .join('/');
    return { kind: 'child', path: canonicalPath };
  }
  return orderBy;
}

function makeCanonicalBound(
  kind: CanonicalBound['kind'],
  value: CanonicalBound['value'],
  key?: string,
): CanonicalBound {
  if (key === undefined) {
    return { kind, value };
  }
  return { kind, value, key };
}

function canonicalBounds(bounds: QuerySpec['bounds']): CanonicalBound[] {
  const expanded: CanonicalBound[] = [];
  for (const bound of bounds) {
    if (bound.kind === 'equalTo') {
      expanded.push(makeCanonicalBound('startAt', bound.value, bound.key));
      expanded.push(makeCanonicalBound('endAt', bound.value, bound.key));
    } else {
      expanded.push(makeCanonicalBound(bound.kind, bound.value, bound.key));
    }
  }
  const boundOrder: Record<CanonicalBound['kind'], number> = {
    startAt: 0,
    startAfter: 0,
    endAt: 1,
    endBefore: 1,
  };
  return expanded.sort((a, b) => boundOrder[a.kind] - boundOrder[b.kind]);
}

function canonicalLimit(
  limit: QuerySpec['limit'],
): { kind: NonNullable<QuerySpec['limit']>['kind']; n: number | 'Infinity' } | null {
  if (limit === null) return null;
  const count = Number.isFinite(limit.n) ? limit.n : 'Infinity';
  return { kind: limit.kind, n: count };
}

/** Stable identity for Firebase-equivalent query views, independent of
 * constraint application order, slash padding on `orderByChild`, or
 * `equalTo(v, k?)` vs `startAt(v, k?) + endAt(v, k?)` syntax. */
export function queryIdentifier(spec: QuerySpec): string {
  const orderBy = canonicalOrderBy(spec.orderBy);
  const bounds = canonicalBounds(spec.bounds);
  const limit = canonicalLimit(spec.limit);
  if (orderBy === null && bounds.length === 0 && limit === null) {
    return 'default';
  }
  return JSON.stringify({ orderBy, bounds, limit });
}
