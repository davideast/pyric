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

it('a multi-path update that a rule denies records no allow for the paths it checked first', () => {
  const state = new BackendState();
  state.rules.setRules({ rules: { allowed: { '.write': true }, denied: { '.write': false } } });
  const writes = new WritePlane(state, new ValueListeners(state), new ChildListeners(state));
  const recorded: Array<{ path: string; result: string }> = [];
  const operation = state.events.operation.bind(state.events);
  state.events.operation = (auth, method, path, result, evaluation, fields) => {
    recorded.push({ path, result });
    operation(auth, method, path, result, evaluation, fields);
  };

  expect(() => writes.update({ uid: 'u1' }, '/', { allowed: 'ok', denied: 'no' })).toThrow('PERMISSION_DENIED');
  expect(recorded).toEqual([{ path: '/denied', result: 'deny' }]);

  recorded.length = 0;
  writes.update({ uid: 'u1' }, '/', { allowed: 'ok' });
  expect(recorded).toEqual([{ path: '/allowed', result: 'allow' }]);
});
