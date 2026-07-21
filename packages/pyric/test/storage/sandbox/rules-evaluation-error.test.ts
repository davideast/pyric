import { expect, test } from 'bun:test';
import { RuleEvalError } from '../../../src/storage/sandbox/rules-evaluation-error.js';

test('RuleEvalError is distinguishable at the allow boundary', () => {
  const error = new RuleEvalError('denied');
  expect(error).toBeInstanceOf(Error);
  expect(error).toBeInstanceOf(RuleEvalError);
  expect(error.message).toBe('denied');
});
