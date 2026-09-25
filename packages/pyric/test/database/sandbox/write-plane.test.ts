import { describe, expect, it, test } from 'bun:test';
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

describe('03-rtdb-multipath-update-atomic-allow-events', () => {
  test('WritePlane.update does not emit partial allow events when a sibling path in the atomic batch is denied', () => {
    const state = new BackendState();
    state.rules.setRules({
      rules: {
        allowedPath: { '.write': true },
        deniedPath: { '.write': false },
      },
    });
    const writes = new WritePlane(state, new ValueListeners(state), new ChildListeners(state));

    const opEvents: Array<{ method: string; path: string; result: string }> = [];
    const origOperation = state.events.operation.bind(state.events);
    state.events.operation = (auth, method, path, result, evaluation, fields) => {
      opEvents.push({ method, path, result });
      origOperation(auth, method, path, result, evaluation, fields);
    };

    expect(() =>
      writes.update({ uid: 'user-1' }, '/', {
        allowedPath: 'ok',
        deniedPath: 'forbidden',
      }),
    ).toThrow(/PERMISSION_DENIED/);

    const allowEvents = opEvents.filter((e) => e.result === 'allow');
    const denyEvents = opEvents.filter((e) => e.result === 'deny');
    expect(allowEvents).toHaveLength(0);
    expect(denyEvents).toHaveLength(1);
    expect(denyEvents[0]?.path).toBe('/deniedPath');
  });
});

