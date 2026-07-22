import { describe, expect, test } from 'bun:test';
import { EvalError } from '../../../src/rules/simulator/eval-error.js';

describe('EvalError', () => {
  test('retains the failing expression', () => {
    const expression = { type: 'identifier' as const, name: 'missing' };
    const error = new EvalError('Undefined variable', expression);
    expect(error.name).toBe('EvalError');
    expect(error.expr).toBe(expression);
  });
});
