import type { Constraint } from './sandbox/query.js';
import {
  CONSTRAINT_SYMBOL,
  QUERY_SYMBOL,
  QueryConstraint,
  type Query,
} from './types.js';

class QueryEndAtConstraint extends QueryConstraint {}
class QueryEndBeforeConstraint extends QueryConstraint {}
class QueryStartAtConstraint extends QueryConstraint {}
class QueryStartAfterConstraint extends QueryConstraint {}
class QueryLimitToFirstConstraint extends QueryConstraint {}
class QueryLimitToLastConstraint extends QueryConstraint {}
class QueryOrderByChildConstraint extends QueryConstraint {}
class QueryOrderByKeyConstraint extends QueryConstraint {}
class QueryOrderByPriorityConstraint extends QueryConstraint {}
class QueryOrderByValueConstraint extends QueryConstraint {}
class QueryEqualToValueConstraint extends QueryConstraint {}

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
  return QUERY_SYMBOL in value;
}
