import type { Constraint } from './sandbox/query.js';
import {
  CONSTRAINT_SYMBOL,
  QUERY_SYMBOL,
  QueryConstraint,
  type Query,
} from './types.js';

class SandboxQueryConstraint extends QueryConstraint {}
class QueryOrderByKeyConstraint extends QueryConstraint {}

export function buildConstraint(
  type: QueryConstraint['type'],
  internal: Constraint,
): QueryConstraint {
  const ConstraintConstructor = type === 'orderByKey'
    ? QueryOrderByKeyConstraint
    : SandboxQueryConstraint;
  return Object.freeze(new ConstraintConstructor(type, internal));
}

export function isQuery(value: object): value is Query {
  return QUERY_SYMBOL in value;
}
