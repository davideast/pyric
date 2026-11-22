/**
 * Regression tests for #1935 (Web RTDB side): removing or writing null at a
 * sub-path beneath a primitive leaf must leave the primitive leaf intact,
 * matching Firebase RTDB's LeafNode.updateChild semantics.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from '../../src/sandbox/index.js';
import {
  get,
  getDatabase,
  goOffline,
  goOnline,
  onChildRemoved,
  onValue,
  ref,
  remove,
  sandbox as rtdbSandbox,
  set,
  setWithPriority,
  update,
} from '../../src/database/index.js';

function openDb() {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox);
  rtdbSandbox.setDefaultPolicy(db, 'allow');
  return db;
}

describe('primitive leaf preservation on sub-path removal (#1935)', () => {
  it('leaves a primitive leaf intact on remove(), set(null), set({}), shallow update, and multi-path update', async () => {
    const db = openDb();

    await set(ref(db, 'r1'), { n: 'keep', m: 1 });
    await remove(ref(db, 'r1/n/x'));
    expect((await get(ref(db, 'r1'))).val()).toEqual({ n: 'keep', m: 1 });

    await set(ref(db, 'r2'), { n: 'keep', m: 1 });
    await set(ref(db, 'r2/n/x'), null);
    expect((await get(ref(db, 'r2'))).val()).toEqual({ n: 'keep', m: 1 });

    await set(ref(db, 'r3'), { n: 'keep', m: 1 });
    await set(ref(db, 'r3/n/x'), {});
    expect((await get(ref(db, 'r3'))).val()).toEqual({ n: 'keep', m: 1 });

    await set(ref(db, 'r4'), { n: 'keep', m: 1 });
    await update(ref(db), { 'r4/n/x': null, 'r4/m': 2 });
    expect((await get(ref(db, 'r4'))).val()).toEqual({ n: 'keep', m: 2 });

    await set(ref(db, 'r5'), { n: 'keep', m: 1 });
    await update(ref(db, 'r5/n'), { x: null });
    expect((await get(ref(db, 'r5'))).val()).toEqual({ n: 'keep', m: 1 });

    await set(ref(db, 'r6'), { n: 'keep' });
    await remove(ref(db, 'r6/n/deep/sub/path'));
    expect((await get(ref(db, 'r6'))).val()).toEqual({ n: 'keep' });
  });

  it('preserves all primitive types (string, 0, false) and priority metadata without spurious listener fires', async () => {
    const db = openDb();
    await set(ref(db, 'types'), { str: '', zero: 0, flag: false });
    const valueDeliveries: unknown[] = [];
    const removedKeys: Array<string | null> = [];
    const stopValue = onValue(ref(db, 'types'), (snap) => {
      valueDeliveries.push(snap.val());
    });
    const stopRemoved = onChildRemoved(ref(db, 'types'), (snap) => {
      removedKeys.push(snap.key);
    });

    await remove(ref(db, 'types/str/a'));
    await remove(ref(db, 'types/zero/b'));
    await remove(ref(db, 'types/flag/c'));
    stopValue();
    stopRemoved();

    expect((await get(ref(db, 'types'))).val()).toEqual({ str: '', zero: 0, flag: false });
    expect(valueDeliveries).toEqual([{ str: '', zero: 0, flag: false }]);
    expect(removedKeys).toEqual([]);

    await setWithPriority(ref(db, 'prio/n'), 'keep', 5);
    await remove(ref(db, 'prio/n/x'));
    const prioSnap = await get(ref(db, 'prio/n'));
    expect(prioSnap.val()).toBe('keep');
    expect(prioSnap.priority).toBe(5);
  });

  it('preserves a root primitive on sub-path removal while still allowing direct leaf removal and non-null promotion', async () => {
    const db = openDb();
    await set(ref(db), 'root-leaf');
    await remove(ref(db, 'a/b'));
    expect((await get(ref(db))).val()).toBe('root-leaf');

    // Non-null write beneath a primitive still promotes the leaf to an object.
    await set(ref(db, 'a/b'), 42);
    expect((await get(ref(db))).val()).toEqual({ a: { b: 42 } });

    // Direct removal of the leaf itself still deletes it and trims empty ancestors.
    await remove(ref(db, 'a/b'));
    expect((await get(ref(db))).val()).toBeNull();
  });

  it('preserves primitive leaves across offline overlay removal and reconnect', async () => {
    const db = openDb();
    await set(ref(db, 'offline'), { n: 'keep', m: 1 });
    const stopKeepWarm = onValue(ref(db, 'offline'), () => {});

    goOffline(db);
    const pendingRemove = remove(ref(db, 'offline/n/x'));
    expect((await get(ref(db, 'offline'))).val()).toEqual({ n: 'keep', m: 1 });

    goOnline(db);
    await pendingRemove;
    expect((await get(ref(db, 'offline'))).val()).toEqual({ n: 'keep', m: 1 });
    stopKeepWarm();
  });
});
