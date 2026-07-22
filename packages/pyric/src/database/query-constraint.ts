import { CONSTRAINT_SYMBOL } from './brands.js';
import type { Constraint } from './sandbox/query.js';

export type QueryConstraintType =
  | 'orderByChild'
  | 'orderByKey'
  | 'orderByPriority'
  | 'orderByValue'
  | 'startAt'
  | 'startAfter'
  | 'endAt'
  | 'endBefore'
  | 'equalTo'
  | 'limitToFirst'
  | 'limitToLast';

/** Opaque constraint produced by the order/filter/limit query functions. */
export class QueryConstraint {
  declare readonly type: QueryConstraintType;
  declare readonly [CONSTRAINT_SYMBOL]: Constraint;

  constructor(type?: QueryConstraint['type'], internal?: Constraint) {
    if (type !== undefined) this.type = type;
    if (internal) this[CONSTRAINT_SYMBOL] = internal;
  }
}
