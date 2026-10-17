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

it('prunes priorities on auto-trimmed ancestors when hasNode reports them absent (#1014)', () => {
  const priorities = new PriorityState();
  priorities.set('/parent', 9);
  priorities.replace('/parent/only', null, (path) => path !== '/parent' && path !== '/');
  expect(priorities.get('/parent')).toBeNull();
});

it('applyUpdate clears a directly overwritten node priority while keeping sibling and ancestor priorities (#1014)', () => {
  const priorities = new PriorityState();
  priorities.set('/parent/child', 7);
  priorities.set('/parent/sib', 4);
  priorities.applyUpdate([{ path: '/parent/child', value: 'v2' }]);
  expect(priorities.get('/parent/child')).toBeNull();
  expect(priorities.get('/parent/sib')).toBe(4);

  priorities.set('/parent2/child', 7);
  priorities.applyUpdate([{ path: '/parent2/child/x', value: 2 }]);
  expect(priorities.get('/parent2/child')).toBe(7);
});
