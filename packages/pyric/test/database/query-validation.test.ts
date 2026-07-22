import { expect, it } from 'bun:test';
import {
  normalizeOptionalEndpointValue,
  validateCursorKey,
  validateLimit,
  validateOrderByChildPath,
} from '../../src/database/query-validation.js';

it('validates query factory arguments at construction time', () => {
  expect(() => validateLimit('limitToFirst', 0)).toThrow('positive integer');
  expect(() => validateLimit('limitToLast', Number.POSITIVE_INFINITY)).not.toThrow();
  expect(() => validateOrderByChildPath('$key')).toThrow('Use orderByKey()');
  expect(() => validateCursorKey('startAt', 'bad/key')).toThrow('invalid key');
  expect(normalizeOptionalEndpointValue('startAt', undefined)).toBeNull();
  expect(normalizeOptionalEndpointValue('startAfter', undefined)).toBeUndefined();
});
