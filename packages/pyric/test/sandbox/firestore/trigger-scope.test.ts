/**
 * TriggerScope unit tests (ADR-0009 decision 3, PR B2).
 *
 * Pins the baton's save/restore semantics directly, without the engine:
 * nesting restores the outer value, an exception still restores, and the
 * capture-at-schedule composition the delivery scheduler relies on.
 */
import { describe, expect, test } from 'bun:test';
import { TriggerScope, type TriggerInfo } from '../../../src/firestore/sandbox/trigger-scope.js';

describe('TriggerScope', () => {
  test('current() is undefined outside any run()', () => {
    const scope = new TriggerScope();
    expect(scope.current()).toBeUndefined();
  });

  test('run() sets current for the duration of fn and returns its value', () => {
    const scope = new TriggerScope();
    const trigger: TriggerInfo = { method: 'set', path: 'games/g1' };
    const result = scope.run(trigger, () => {
      expect(scope.current()).toEqual({ method: 'set', path: 'games/g1' });
      return 42;
    });
    expect(result).toBe(42);
    expect(scope.current()).toBeUndefined();
  });

  test('nested run() restores the OUTER value, not undefined', () => {
    const scope = new TriggerScope();
    const outer: TriggerInfo = { method: 'batch', path: 'a/1' };
    const inner: TriggerInfo = { method: 'set', path: 'b/2' };
    scope.run(outer, () => {
      scope.run(inner, () => {
        expect(scope.current()).toBe(inner);
      });
      // The save/restore stack: after the nested call the outer trigger
      // must be back so remaining listeners in the outer fan-out still
      // attribute correctly.
      expect(scope.current()).toBe(outer);
    });
    expect(scope.current()).toBeUndefined();
  });

  test('run(undefined, fn) masks an outer trigger and restores it', () => {
    const scope = new TriggerScope();
    const outer: TriggerInfo = { method: 'update', path: 'c/3' };
    scope.run(outer, () => {
      scope.run(undefined, () => {
        expect(scope.current()).toBeUndefined();
      });
      expect(scope.current()).toBe(outer);
    });
  });

  test('exception in fn still restores the previous value', () => {
    const scope = new TriggerScope();
    const outer: TriggerInfo = { method: 'set', path: 'x/1' };
    scope.run(outer, () => {
      expect(() =>
        scope.run({ method: 'delete', path: 'y/2' }, () => {
          throw new Error('boom');
        }),
      ).toThrow('boom');
      expect(scope.current()).toBe(outer);
    });
    expect(scope.current()).toBeUndefined();
  });

  test('capture-at-schedule: a value captured while run() is active survives run() exiting', () => {
    const scope = new TriggerScope();
    const queue: Array<() => void> = [];
    const seen: Array<TriggerInfo | undefined> = [];

    scope.run({ method: 'set', path: 'games/g1' }, () => {
      // Mirror scheduleTriggeredDelivery: capture current() at SCHEDULE
      // time and replay it via run() at drain time.
      const captured = scope.current();
      queue.push(() => scope.run(captured, () => seen.push(scope.current())));
    });

    // The writing stack has unwound; current() is back to undefined.
    expect(scope.current()).toBeUndefined();
    // Drain — the delivery still attributes to the captured trigger.
    for (const deliver of queue) deliver();
    expect(seen).toEqual([{ method: 'set', path: 'games/g1' }]);
    expect(scope.current()).toBeUndefined();
  });
});
