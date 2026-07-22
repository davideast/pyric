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

/** Stable identity for Firebase-equivalent query views, independent of
 * constraint application order. */
export function queryIdentifier(spec: QuerySpec): string {
  if (isDefaultQuerySpec(spec)) return 'default';
  const boundOrder: Record<QuerySpec['bounds'][number]['kind'], number> = {
    startAt: 0,
    startAfter: 0,
    equalTo: 1,
    endAt: 2,
    endBefore: 2,
  };
  return JSON.stringify({
    orderBy: spec.orderBy,
    bounds: [...spec.bounds].sort((a, b) => boundOrder[a.kind] - boundOrder[b.kind]),
    limit: spec.limit,
  });
}
