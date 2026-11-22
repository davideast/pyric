import { describe, expect, it, spyOn } from 'bun:test';
import {
  onChildAdded,
  onChildChanged,
  onChildMoved,
  onChildRemoved,
  orderByChild,
  query,
  ref,
  remove,
  set,
  update,
} from '../../../src/database/index.js';
import { cancellationShape, loadObservation as load, setup } from './cdd-replay-helpers.js';

const childOnlyOnceObservation = load('rtdb-modular-child-listener-only-once');

describe('RTDB CDD child listener onlyOnce cases', () => {
  it('rtdb-modular#M75d honors child listener onlyOnce overloads', async () => {
    const { first } = setup();
    const target = ref(first, 'child-only-once');
    await set(target, {
      a: { rank: 1, value: 1 },
      b: { rank: 2, value: 2 },
      c: { rank: 3, value: 3 },
    });
    const added: Array<[string | null, string | null]> = [];
    const changed: Array<[string | null, string | null]> = [];
    const removed: Array<[string | null, string | null]> = [];
    const moved: Array<[string | null, string | null]> = [];
    const cancellations: Record<string, unknown>[] = [];
    onChildAdded(target, (snap, previous) => added.push([snap.key, previous]), { onlyOnce: true });
    onChildChanged(
      target,
      (snap, previous) => changed.push([snap.key, previous]),
      (error) => cancellations.push(cancellationShape(error, '/child-only-once')),
      { onlyOnce: true },
    );
    onChildRemoved(target, (snap, previous) => removed.push([snap.key, previous]), { onlyOnce: true });
    onChildMoved(
      query(target, orderByChild('rank')),
      (snap, previous) => moved.push([snap.key, previous]),
      { onlyOnce: true },
    );
    await update(ref(first, 'child-only-once/a'), { value: 10, rank: 4 });
    await update(ref(first, 'child-only-once/a'), { value: 11, rank: 0 });
    await remove(ref(first, 'child-only-once/b'));
    await remove(ref(first, 'child-only-once/c'));
    await set(ref(first, 'child-only-once/d'), { rank: 5, value: 4 });
    expect({ added, changed, removed, moved, cancellations }).toEqual({
      added: childOnlyOnceObservation.added,
      changed: childOnlyOnceObservation.changed,
      removed: childOnlyOnceObservation.removed,
      moved: childOnlyOnceObservation.moved,
      cancellations: childOnlyOnceObservation.cancellations,
    });
  });

  it('rtdb-modular#M75d isolates thrown callbacks across the initial onlyOnce batch', async () => {
    const { first } = setup();
    const target = ref(first, 'child-only-once-errors');
    await set(target, { a: 1, b: 2, c: 3 });
    const delivered: Array<string | null> = [];
    const scheduled: Array<() => void> = [];
    const realSetTimeout = globalThis.setTimeout;
    const timeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      ((fn: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
        if (fn.name === 'rtdbExceptionGuardRethrow') {
          scheduled.push(() => fn(...args));
          return 0 as unknown as ReturnType<typeof setTimeout>;
        }
        return realSetTimeout(fn, delay, ...args);
      }) as typeof setTimeout,
    );
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() => onChildAdded(target, (snapshot) => {
        delivered.push(snapshot.key);
        throw new Error('listener failure');
      }, { onlyOnce: true })).not.toThrow();
      expect(delivered).toEqual(['c', 'b', 'a']);
      expect(scheduled).toHaveLength(3);
      for (const rethrow of scheduled) {
        expect(() => rethrow()).toThrow('listener failure');
      }
      expect(warnSpy).toHaveBeenCalledTimes(3);
    } finally {
      timeoutSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
