import type { Expression } from '../grammar/FirestoreAST.js';
import { EvalError } from './eval-error.js';

/** A simulator capability gap, distinct from a production-style eval error. */
export class UnsupportedError extends EvalError {
  constructor(message: string, expr?: Expression) {
    super(message, expr);
    this.name = 'UnsupportedError';
  }
}
