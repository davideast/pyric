import { expect, it } from 'bun:test';
import { BackendState } from '../../../src/database/sandbox/backend-state.js';
import { ValueListeners } from '../../../src/database/sandbox/value-listeners.js';

it('delivers initial admin state, fans out changes, and suppresses no-ops', () => {
  const state = new BackendState();
  const listeners = new ValueListeners(state);
  state.tree.write('/value', 1);
  const seen: unknown[] = [];
  const unsubscribe = listeners.adminOnValue('/value', (snapshot) => seen.push(snapshot.val));
  state.tree.write('/value', 2);
  listeners.fanOut(['/value']);
  listeners.fanOut(['/value']);
  expect(seen).toEqual([1, 2]);
  unsubscribe();
  expect(listeners.count()).toBe(0);
});

it('notifies unfiltered query value listeners on root priority change and suppresses filtered ones', () => {
  const state = new BackendState();
  const listeners = new ValueListeners(state);
  state.tree.write('/items', { a: 1, b: 2 });

  const unfilteredSeen: Array<string | number | null> = [];
  const filteredSeen: Array<string | number | null> = [];

  const unsubUnfiltered = listeners.adminOnValue(
    '/items',
    () => {
      unfilteredSeen.push(state.priorities.get('/items'));
    },
    { orderBy: { kind: 'key' }, bounds: [], limit: null },
  );
  const unsubFiltered = listeners.adminOnValue(
    '/items',
    () => {
      filteredSeen.push(state.priorities.get('/items'));
    },
    { orderBy: { kind: 'key' }, bounds: [], limit: { kind: 'limitToFirst', n: 5 } },
  );

  expect(unfilteredSeen).toEqual([null]);
  expect(filteredSeen).toEqual([null]);

  state.priorities.set('/items', 42);
  listeners.fanOut(['/items']);

  expect(unfilteredSeen).toEqual([null, 42]);
  expect(filteredSeen).toEqual([null]);

  // Repeating the same root priority is a no-op.
  listeners.fanOut(['/items']);
  expect(unfilteredSeen).toEqual([null, 42]);

  // Clearing root priority back to null notifies the unfiltered query listener.
  state.priorities.set('/items', null);
  listeners.fanOut(['/items']);
  expect(unfilteredSeen).toEqual([null, 42, null]);
  expect(filteredSeen).toEqual([null]);

  unsubUnfiltered();
  unsubFiltered();
});
