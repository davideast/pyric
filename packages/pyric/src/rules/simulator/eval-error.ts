import type { Expression } from '../grammar/FirestoreAST.js';

export class EvalError extends Error {
  constructor(message: string, public expr?: Expression) {
    super(message);
    this.name = 'EvalError';
  }
}

export { EvalError as RuleEvalError };

