import { expect, it } from 'bun:test';
import { CONSTRAINT_SYMBOL } from '../../src/database/brands.js';
import { QueryConstraint } from '../../src/database/query-constraint.js';

it('preserves the public constraint kind and hidden internal constraint', () => {
  const internal = { kind: 'limit', direction: 'first', count: 2 } as const;
  const constraint = new QueryConstraint('limitToFirst', internal);
  expect(constraint.type).toBe('limitToFirst');
  expect(constraint[CONSTRAINT_SYMBOL]).toBe(internal);
});
