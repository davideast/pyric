import { describe, expect, it } from 'bun:test';
import {
  equalTo,
  get,
  limitToFirst,
  onChildMoved,
  onValue,
  orderByPriority,
  query,
  ref,
  runTransaction,
  set,
  setPriority,
  setWithPriority,
  startAt,
  update,
} from '../../../src/database/index.js';
import { keys, loadObservation as load, setup } from './cdd-replay-helpers.js';

const priorityObservation = load('rtdb-modular-priority-contract');

describe('RTDB CDD priority metadata cases', () => {
  it('rtdb-modular#M89 round-trips, preserves, replaces, and clears priority', async () => {
    const { first } = setup();
    const target = ref(first, 'priority/value');
    await setWithPriority(target, { value: 1 }, 10);
    expect((await get(target)).priority).toBe(priorityObservation.before[0].priority);
    expect((await get(target)).exportVal()).toEqual(priorityObservation.before[0].exportVal);
    await update(target, { value: 2 });
    expect((await get(target)).priority).toBe(priorityObservation.before[0].priority);
    await runTransaction(target, (current) => ({
      value: ((current as { value: number }).value ?? 0) + 1,
    }));
    expect((await get(target)).priority).toBe(priorityObservation.before[0].priority);
    await set(target, { value: 4 });
    expect((await get(target)).priority).toBeNull();
    await setPriority(target, 'later');
    expect((await get(target)).priority).toBe('later');
    await setPriority(target, null);
    expect((await get(target)).exportVal()).toEqual({ value: 4 });
    await expect(setWithPriority(target, 1, Number.NaN)).rejects.toThrow(/priority/);

    const descendant = ref(first, 'priority/replaced/child/grandchild');
    await setWithPriority(descendant, 1, 9);
    await update(ref(first, 'priority/replaced'), { child: { replacement: true } });
    await set(descendant, 2);
    expect((await get(descendant)).priority).toBeNull();
  });

  it('rtdb-modular#M90 orders, bounds, ties, and limits by priority', async () => {
    const { first } = setup();
    const target = ref(first, 'priority-order');
    await setWithPriority(ref(first, 'priority-order/a'), { value: 1 }, 10);
    await setWithPriority(ref(first, 'priority-order/b'), { value: 2 }, 5);
    await setWithPriority(ref(first, 'priority-order/c'), { value: 3 }, 5);
    expect(keys(await get(target))).toEqual(priorityObservation.plainForEachKeys);
    expect(keys(await get(query(target, limitToFirst(2))))).toEqual(
      priorityObservation.defaultLimitedKeys,
    );
    expect((await get(target)).exportVal()).toEqual(priorityObservation.parentExportVal);
    expect((await get(target)).toJSON()).toEqual(priorityObservation.parentToJSON);
    expect(keys(await get(query(target, orderByPriority())))).toEqual(priorityObservation.orderedKeys);
    expect(keys(await get(query(target, orderByPriority(), startAt(5), limitToFirst(2))))).toEqual(priorityObservation.boundedKeys);
    expect(keys(await get(query(target, orderByPriority(), equalTo(5))))).toEqual(priorityObservation.equalKeys);
    for (const invalid of [false, { invalid: true }]) {
      expect(() => query(
        target,
        orderByPriority(),
        startAt(invalid as never),
      )).toThrow(priorityObservation.invalidPriorityBounds.boolean.message);
      expect(() => query(
        target,
        startAt(invalid as never),
      )).toThrow(priorityObservation.invalidPriorityBounds.defaultBoolean.message);
    }
  });

  it('rtdb-modular#M91 moves on priority change and preserves metadata through lifecycle writes', async () => {
    const { first } = setup();
    const target = ref(first, 'priority-move');
    await setWithPriority(ref(first, 'priority-move/a'), { value: 1 }, 10);
    await setWithPriority(ref(first, 'priority-move/b'), { value: 2 }, 5);
    await setWithPriority(ref(first, 'priority-move/c'), { value: 3 }, 5);
    const moved: Array<[string | null, string | null]> = [];
    const plainMoved: Array<[string | null, string | null]> = [];
    let orderedValueDeliveries = 0;
    onChildMoved(query(target, orderByPriority()), (snap, previous) => {
      moved.push([snap.key, previous]);
    });
    onChildMoved(target, (snap, previous) => {
      plainMoved.push([snap.key, previous]);
    });
    onValue(query(target, orderByPriority()), () => { orderedValueDeliveries++; });
    await setPriority(ref(first, 'priority-move/a'), 0);
    expect(moved).toEqual(priorityObservation.moved);
    expect(plainMoved).toEqual(priorityObservation.plainMoved);
    expect(orderedValueDeliveries).toBe(priorityObservation.orderedValueDeliveriesAfterMove);
    await setPriority(ref(first, 'priority-move/c'), 6);
    expect(orderedValueDeliveries).toBe(
      priorityObservation.orderedValueDeliveriesAfterSamePositionChange,
    );
    expect(moved.slice(priorityObservation.moved.length)).toEqual(
      priorityObservation.samePositionMoved,
    );
    expect(plainMoved.slice(priorityObservation.plainMoved.length)).toEqual(
      priorityObservation.samePositionPlainMoved,
    );
    const beforeNoopPriority = {
      moved: moved.length,
      plainMoved: plainMoved.length,
      orderedValueDeliveries,
    };
    await setPriority(ref(first, 'priority-move/c'), 6);
    expect({
      moved: moved.length,
      plainMoved: plainMoved.length,
      orderedValueDeliveries,
    }).toEqual(beforeNoopPriority);
    expect((await get(ref(first, 'priority-move/a'))).exportVal()).toEqual(
      priorityObservation.afterMove.exportVal,
    );
    await update(target, { 'a/value': 4 });
    expect((await get(ref(first, 'priority-move/a'))).priority).toBe(priorityObservation.afterUpdate);
    await runTransaction(ref(first, 'priority-move/a'), (current) => ({
      value: ((current as { value: number }).value ?? 0) + 1,
    }));
    expect((await get(ref(first, 'priority-move/a'))).priority).toBe(priorityObservation.afterTransaction);
    await set(ref(first, 'priority-move/b'), { value: 20 });
    await setPriority(ref(first, 'priority-move/c'), null);
    expect(moved).toEqual(priorityObservation.allMoved);
    expect(plainMoved).toEqual(priorityObservation.allPlainMoved);
    expect(orderedValueDeliveries).toBe(priorityObservation.totalOrderedValueDeliveries);
  });
});
