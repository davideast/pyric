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
