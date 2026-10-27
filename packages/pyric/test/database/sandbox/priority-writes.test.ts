import { expect, it } from 'bun:test';
import { BackendState } from '../../../src/database/sandbox/backend-state.js';
import { ChildListeners } from '../../../src/database/sandbox/child-listeners.js';
import { PriorityWrites } from '../../../src/database/sandbox/priority-writes.js';

it('updates priority metadata only for existing values and notifies writes', () => {
  const state = new BackendState();
  const published: string[][] = [];
  const writes = new PriorityWrites(state, new ChildListeners(state), (paths) => { published.push(paths); });
  let notifications = 0;
  state.writeSubscribers.add(() => { notifications += 1; });
  writes.adminSet('/missing', 1);
  expect(state.priorities.get('/missing')).toBeNull();
  state.tree.write('/item', { value: true });
  writes.adminSet('/item', 2);
  expect(state.priorities.get('/item')).toBe(2);
  expect(notifications).toBe(1);
  expect(published).toEqual([['/item']]);
});
