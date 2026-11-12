import { describe, expect, test } from 'bun:test';
import { EvalError } from '../../src/simulator/eval-error.js';
import { UnsupportedError } from '../../src/simulator/unsupported-error.js';

describe('UnsupportedError', () => {
  test('is distinguishable from a production-style evaluation error', () => {
    const error = new UnsupportedError('Unknown function');
    expect(error).toBeInstanceOf(EvalError);
    expect(error.name).toBe('UnsupportedError');
  });
});
