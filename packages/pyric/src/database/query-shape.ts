import type { Constraint } from './sandbox/query.js';
import {
  CONSTRAINT_SYMBOL,
  QUERY_SYMBOL,
  type Query,
  type QueryConstraint,
} from './types.js';

export function buildConstraint(
  type: QueryConstraint['type'],
  internal: Constraint,
): QueryConstraint {
  return Object.freeze({ type, [CONSTRAINT_SYMBOL]: internal });
}

export function isQuery(value: object): value is Query {
  return QUERY_SYMBOL in value;
}
