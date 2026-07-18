/**
 * Unit tests for the engine's EventBus internal seam (ADR-0009, PR B1).
 * These test the module directly — the engine-level behavior stays pinned
 * by the characterization suite through the public interface.
 */
import { describe, test, expect } from 'bun:test';
import { EventChannel, FirestoreEventBus } from '../../../src/firestore/sandbox/event-bus.js';

describe('EventChannel', () => {
  test('dispatches to subscribers in insertion order', () => {
    const ch = new EventChannel<[number]>();
    const order: string[] = [];
    ch.subscribe((n) => order.push(`a${n}`));
    ch.subscribe((n) => order.push(`b${n}`));
    ch.emit(1);
    expect(order).toEqual(['a1', 'b1']);
  });

  test('unsubscribe is idempotent and stops delivery', () => {
    const ch = new EventChannel<[number]>();
    const seen: number[] = [];
    const unsub = ch.subscribe((n) => seen.push(n));
    ch.emit(1);
    unsub();
    unsub();
    ch.emit(2);
    expect(seen).toEqual([1]);
    expect(ch.hasSubscribers).toBe(false);
  });

  test('hasSubscribers reflects the registry', () => {
    const ch = new EventChannel<[]>();
    expect(ch.hasSubscribers).toBe(false);
    const unsub = ch.subscribe(() => {});
    expect(ch.hasSubscribers).toBe(true);
    unsub();
    expect(ch.hasSubscribers).toBe(false);
  });

  test('a subscriber removed mid-dispatch before its turn is skipped', () => {
    // Live Set iteration — pins the engine's historical dispatch semantics.
    const ch = new EventChannel<[]>();
    const order: string[] = [];
    let unsubB: () => void = () => {};
    ch.subscribe(() => { order.push('a'); unsubB(); });
    unsubB = ch.subscribe(() => order.push('b'));
    ch.emit();
    expect(order).toEqual(['a']);
  });

  test('a subscriber added mid-dispatch is visited in the same pass', () => {
    // Live Set iteration — additions during dispatch ARE visited.
    const ch = new EventChannel<[]>();
    const order: string[] = [];
    ch.subscribe(() => {
      order.push('a');
      if (!order.includes('late')) ch.subscribe(() => order.push('late'));
    });
    ch.emit();
    expect(order).toEqual(['a', 'late']);
  });

  test('synchronous subscriber throws are swallowed and do not block later subscribers', () => {
    const ch = new EventChannel<[]>();
    const order: string[] = [];
    ch.subscribe(() => { throw new Error('boom'); });
    ch.subscribe(() => order.push('after'));
    expect(() => ch.emit()).not.toThrow();
    expect(order).toEqual(['after']);
  });

  test('async subscriber rejections are swallowed when configured', async () => {
    const ch = new EventChannel<[]>(true);
    let settled = false;
    // Assert the .catch attachment directly: a temporary unhandledRejection
    // listener must never fire. (Merely awaiting a microtask can pass even
    // without the attachment — bun reports unhandled rejections between
    // tests rather than failing the assertion.)
    const rejections: unknown[] = [];
    const onRejection = (err: unknown) => { rejections.push(err); };
    process.on('unhandledRejection', onRejection);
    try {
      ch.subscribe(async () => {
        settled = true;
        throw new Error('async boom');
      });
      expect(() => ch.emit()).not.toThrow();
      // Two turns: one for the subscriber's rejection, one for the noop catch.
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(true);
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  test('clear drops every subscriber', () => {
    const ch = new EventChannel<[number]>();
    const seen: number[] = [];
    ch.subscribe((n) => seen.push(n));
    ch.clear();
    ch.emit(1);
    expect(seen).toEqual([]);
    expect(ch.hasSubscribers).toBe(false);
  });
});

describe('FirestoreEventBus', () => {
  test('exposes the seven engine channels', () => {
    const bus = new FirestoreEventBus();
    for (const ch of [
      bus.denial, bus.request, bus.write, bus.delivery,
      bus.suppressed, bus.lifecycle, bus.snapshotError,
    ]) {
      expect(ch).toBeInstanceOf(EventChannel);
      expect(ch.hasSubscribers).toBe(false);
    }
  });

  test('clear drops subscribers on every channel', () => {
    const bus = new FirestoreEventBus();
    bus.denial.subscribe(() => {});
    bus.request.subscribe(() => {});
    bus.write.subscribe(() => {});
    bus.delivery.subscribe(() => {});
    bus.suppressed.subscribe(() => {});
    bus.lifecycle.subscribe(() => {});
    bus.snapshotError.subscribe(() => {});
    bus.clear();
    expect(bus.denial.hasSubscribers).toBe(false);
    expect(bus.snapshotError.hasSubscribers).toBe(false);
    expect(bus.request.hasSubscribers).toBe(false);
  });
});
