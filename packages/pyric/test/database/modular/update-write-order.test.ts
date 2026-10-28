/**
 * RTDB modular SDK: `update()` applies in call order, as `set()` does (RT-1, #1359).
 *
 * The upstream SDK (firebase 12.13.0, run offline) applies each write to its
 * local view when the call is made, so writes from one client land in the
 * order they were issued. The docs' Event Guarantees say the same: "Writes
 * from a single client will always be written to the server and broadcast out
 * to other users in-order." The in-page sandbox used to defer `update()` by a
 * microtask, so a `set()` issued right after it landed first and was then
 * overwritten.
 */
import { describe, expect, it } from 'bun:test';
import { get, onValue, ref, remove, set, update, child } from '../../../src/database/index.js';
import { setup } from './oracle-conformance.support.js';

describe('RT-1: update() applies in call order', () => {
  it('update then set of the same child stores the set value', async () => {
    const { db } = setup();
    const r = ref(db, 't');
    await set(r, { x: 1 });
    const writes = [update(r, { x: 2 }), set(child(r, 'x'), 3)];
    await Promise.all(writes);
    expect((await get(child(r, 'x'))).val()).toBe(3);
  });

  it('update then remove of the same child leaves the path empty', async () => {
    const { db } = setup();
    const r = ref(db, 't');
    await set(r, { x: 1 });
    const writes = [update(r, { x: 2 }), remove(child(r, 'x'))];
    await Promise.all(writes);
    expect((await get(child(r, 'x'))).exists()).toBe(false);
  });

  it('listeners see the writes in call order, the update before update() returns', async () => {
    const { db } = setup();
    const r = ref(db, 't');
    await set(r, { x: 1 });
    const seen: unknown[] = [];
    const unsubscribe = onValue(child(r, 'x'), (snap) => seen.push(snap.val()));
    await get(r);
    const pending = update(r, { x: 2 });
    const valueRightAfterUpdate = seen.at(-1);
    const writes = [pending, set(child(r, 'x'), 3)];
    await Promise.all(writes);
    unsubscribe();
    expect(valueRightAfterUpdate).toBe(2);
    expect(seen).toEqual([1, 2, 3]);
  });
});
