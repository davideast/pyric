import { expect, it } from 'bun:test';
import { BackendState } from '../../../src/database/sandbox/backend-state.js';
import { ChildListeners } from '../../../src/database/sandbox/child-listeners.js';

it('replays direct children in order and detaches cleanly', () => {
  const state = new BackendState();
  state.rules.setDefaultPolicy('allow');
  const listeners = new ChildListeners(state);
  state.tree.write('/items', { a: 1, b: 2 });
  const seen: Array<[string, string | null]> = [];
  const unsubscribe = listeners.onChild(null, 'child_added', '/items', (snap) => {
    seen.push([snap.key, snap.previousChildName]);
  });
  expect(seen).toEqual([['a', null], ['b', 'a']]);
  expect(listeners.count()).toBe(1);
  unsubscribe();
  expect(listeners.count()).toBe(0);
});

it('adminOnChild attaches without evaluating read rules (#1014)', () => {
  const state = new BackendState();
  state.rules.setRules({ rules: { items: { '.read': false } } });
  const listeners = new ChildListeners(state);
  state.tree.write('/items', { a: 1 });
  const seen: string[] = [];
  const unsubscribe = listeners.adminOnChild('child_added', '/items', (snap) => {
    seen.push(snap.key);
  });
  expect(seen).toEqual(['a']);
  unsubscribe();
  expect(listeners.count()).toBe(0);
});
