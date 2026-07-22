import { expect, it } from 'bun:test';
import { PriorityState, validatePriority } from '../../../src/database/sandbox/priority-state.js';

it('tracks canonical priority metadata and removes descendant state', () => {
  const priorities = new PriorityState();
  priorities.set('items/a', 1);
  priorities.set('/items/a/child', 'nested');
  expect(priorities.get('/items/a')).toBe(1);
  priorities.clearAtOrBelow('/items/a');
  expect(priorities.get('/items/a')).toBeNull();
  expect(priorities.get('/items/a/child')).toBeNull();
  expect(() => validatePriority(Number.NaN)).toThrow('valid Firebase priority');
});
