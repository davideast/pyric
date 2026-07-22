import type { Expression } from '../grammar/FirestoreAST.js';

export class EvalError extends Error {
  constructor(message: string, public expr?: Expression) {
    super(message);
    this.name = 'EvalError';
  }
}

/** A simulator capability gap, distinct from a production-style eval error. */
export class UnsupportedError extends EvalError {
  constructor(message: string, expr?: Expression) {
    super(message, expr);
    this.name = 'UnsupportedError';
  }
}
