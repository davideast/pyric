import { expect, it } from 'bun:test';
import { CONSTRAINT_SYMBOL, QUERY_SYMBOL } from '../../src/database/brands.js';

it('uses distinct stable symbols for query runtime brands', () => {
  expect(typeof QUERY_SYMBOL).toBe('symbol');
  expect(typeof CONSTRAINT_SYMBOL).toBe('symbol');
  expect(QUERY_SYMBOL).not.toBe(CONSTRAINT_SYMBOL);
});
