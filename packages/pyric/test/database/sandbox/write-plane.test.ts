import { expect, it } from 'bun:test';
import { BackendState } from '../../../src/database/sandbox/backend-state.js';
import { ChildListeners } from '../../../src/database/sandbox/child-listeners.js';
import { ValueListeners } from '../../../src/database/sandbox/value-listeners.js';
import { WritePlane } from '../../../src/database/sandbox/write-plane.js';

it('normalizes admin writes, resolves increments, and publishes snapshots', () => {
  const state = new BackendState();
  const writes = new WritePlane(state, new ValueListeners(state), new ChildListeners(state));
  writes.adminSet('/count', 2);
  writes.adminSet('/count', { '.sv': { increment: 3 } });
  expect(writes.adminGet('/count')).toBe(5);
  writes.adminUpdate('/items', { a: 1, b: 2 });
  expect(writes.snapshotState()).toEqual({ count: 5, items: { a: 1, b: 2 } });
});
