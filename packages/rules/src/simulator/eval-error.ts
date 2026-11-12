import type { Expression } from '../grammar/FirestoreAST.js';
import type { ExpressionPosition } from '../grammar/expression-positions.js';

export class EvalError extends Error {
  constructor(message: string, public expr?: Expression) {
    super(message);
    this.name = 'EvalError';
  }
}

/**
 * A resource limit the whole request ran into: the per-request document
 * access budget today, and any future per-request cap. Production fails the
 * entire request closed on these instead of producing a CEL error value, so
 * they are never absorbed by a determining `&&`/`||` operand and never
 * confined to the allow rule that raised them.
 */
export class ResourceLimitError extends EvalError {
  constructor(message: string, expr?: Expression) {
    super(message, expr);
    this.name = 'ResourceLimitError';
  }
}

/**
 * The request reached production's limit of 1000 evaluated expressions
 * (see ExpressionBudget). A resource limit: the whole request denies.
 * `position` is where the budget ran out, when the parser recorded it.
 */
export class ExpressionLimitError extends ResourceLimitError {
  constructor(message: string, readonly position?: ExpressionPosition) {
    super(message);
    this.name = 'ExpressionLimitError';
  }
}

export { EvalError as RuleEvalError };

/**
 * Production's error for an int `/` or `%` by zero, in Firestore and Storage
 * rules alike. A float divisor of zero is no error: it yields an infinity or
 * NaN.
 */
export const DIVIDE_BY_ZERO_MESSAGE = 'Divide by zero error.';

/**
 * Production's error for a method the receiver's type does not define, such
 * as `'a'.concat('b')`, in Firestore and Storage rules alike.
 */
export function functionNotFoundMessage(name: string): string {
  return `Function not found error: Name: [${name}].`;
}
