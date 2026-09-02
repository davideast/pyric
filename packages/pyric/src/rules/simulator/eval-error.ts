import type { Expression } from '../grammar/FirestoreAST.js';

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

export { EvalError as RuleEvalError };
