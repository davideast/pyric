import { describe, expect, it } from 'bun:test';
import { deleteApp, initializeApp } from 'firebase/app';
import { getDatabase as getFirebaseDatabase } from 'firebase/database';
import { initializeSandbox } from 'pyric/sandbox';
import {
  equalTo,
  get,
  getDatabase,
  increment,
  limitToFirst,
  onChildAdded,
  onChildChanged,
  onChildMoved,
  onChildRemoved,
  onValue,
  orderByChild,
  orderByPriority,
  query,
  ref,
  remove,
  runTransaction,
  sandbox as rtdbSandbox,
  set,
  setPriority,
  setWithPriority,
  startAt,
  TARGET_SYMBOL,
  update,
  type DataSnapshot,
} from '../../../src/database/index.js';

// Replays: rtdb-modular-child-previous-name,
// rtdb-modular-priority-contract, rtdb-modular-concurrent-transforms,
// rtdb-modular-listener-cancellation.

function setup() {
  const sandbox = initializeSandbox();
  return {
    sandbox,
    first: getDatabase(sandbox.withAuth({ uid: 'first' })),
    second: getDatabase(sandbox.withAuth({ uid: 'second' })),
  };
}

function keys(snapshot: DataSnapshot): string[] {
  const result: string[] = [];
  snapshot.forEach((child) => { if (child.key) result.push(child.key); });
  return result;
}

describe('RTDB CDD climb', () => {
  it('rtdb-modular#94 returns a tagged frozen-context database', () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox.withAuth({ uid: 'frozen' }));
    expect(TARGET_SYMBOL in db).toBe(true);
    expect(db[TARGET_SYMBOL].kind).toBe('sandbox');
  });

  it('rtdb-modular#95 returns a tagged sandbox-live database', () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox);
    expect(TARGET_SYMBOL in db).toBe(true);
    expect(db[TARGET_SYMBOL].kind).toBe('sandbox-live');
  });

  it('rtdb-modular#98 shares one backend across handles for a sandbox', async () => {
    const sandbox = initializeSandbox();
    const first = getDatabase(sandbox.withAuth({ uid: 'first' }));
    const second = getDatabase(sandbox.withAuth({ uid: 'second' }));
    await set(ref(first, 'shared'), { ok: true });
    expect((await get(ref(second, 'shared'))).val()).toEqual({ ok: true });
  });

  it('rtdb-modular#99 routes each reference to its owning target', async () => {
    const first = getDatabase(initializeSandbox().withAuth({ uid: 'first' }));
    const second = getDatabase(initializeSandbox().withAuth({ uid: 'second' }));
    await set(ref(first, 'owned'), 1);
    await set(ref(second, 'owned'), 2);
    expect((await get(ref(first, 'owned'))).val()).toBe(1);
    expect((await get(ref(second, 'owned'))).val()).toBe(2);
  });

  it('rtdb-modular#M75a delivers cancellation errors for denied and revoked listeners', async () => {
    const { first } = setup();
    const target = ref(first, 'cancel');
    rtdbSandbox.setRules(first, { rules: { '.read': 'false', '.write': 'true' } });
    const initial: Error[] = [];
    const unsubscribe = onValue(target, () => undefined, (error) => { initial.push(error); });
    expect(typeof unsubscribe).toBe('function');
    expect(initial).toEqual([]);
    await Promise.resolve();
    expect(initial).toHaveLength(1);
    expect((initial[0] as Error & { code?: string }).code).toBe('PERMISSION_DENIED');
    expect(initial[0]!.message).toContain('permission_denied at /cancel');

    rtdbSandbox.setRules(first, { rules: { '.read': 'true', '.write': 'true' } });
    const revoked: Error[] = [];
    const registrars = [onValue, onChildAdded, onChildChanged, onChildRemoved, onChildMoved] as const;
    for (const register of registrars) {
      register(target, () => undefined, (error) => { revoked.push(error); });
    }
    rtdbSandbox.setRules(first, { rules: { '.read': 'false', '.write': 'true' } });
    expect(revoked).toHaveLength(5);
    expect(revoked.every((error) =>
      (error as Error & { code?: string }).code === 'PERMISSION_DENIED')).toBe(true);
  });

  it('rtdb-modular#96 leaves inactive canonical Firebase databases untagged', async () => {
    const app = initializeApp({
      projectId: 'inactive-canonical',
      databaseURL: 'https://inactive-canonical.firebaseio.com',
    }, `inactive-${Date.now()}`);
    try {
      const production = getFirebaseDatabase(app);
      expect(TARGET_SYMBOL in production).toBe(false);
      expect(() => getDatabase(app as never)).toThrow(/package resolution/i);
    } finally {
      await deleteApp(app);
    }
  });

  it('rtdb-modular#132 returns an unsubscribe function that stops delivery', async () => {
    const { first } = setup();
    const target = ref(first, 'unsubscribe');
    const values: unknown[] = [];
    const unsubscribe = onValue(target, (snapshot) => { values.push(snapshot.val()); });
    expect(typeof unsubscribe).toBe('function');
    await set(target, 1);
    unsubscribe();
    await set(target, 2);
    expect(values).toEqual([null, 1]);
  });

  it('rtdb-modular#M75 supplies captured previousChildName values', async () => {
    const { first } = setup();
    const target = ref(first, 'previous');
    await set(target, {
      a: { rank: 1, stable: false },
      b: { rank: 2, stable: false },
      c: { rank: 3, stable: false },
    });
    const added: Array<[string | null, string | null]> = [];
    const changed: Array<[string | null, string | null]> = [];
    const removed: Array<[string | null, string | null]> = [];
    const moved: Array<[string | null, string | null]> = [];
    onChildAdded(query(target, orderByChild('rank')), (snap, previous) => {
      added.push([snap.key, previous]);
    });
    onChildChanged(query(target, orderByChild('rank')), (snap, previous) => {
      changed.push([snap.key, previous]);
    });
    onChildRemoved(query(target, orderByChild('rank')), (snap, previous) => {
      removed.push([snap.key, previous]);
    });
    onChildMoved(query(target, orderByChild('rank')), (snap, previous) => {
      moved.push([snap.key, previous]);
    });
    expect(added).toEqual([['a', null], ['b', 'a'], ['c', 'b']]);
    await update(ref(first, 'previous/b'), { stable: true });
    await remove(ref(first, 'previous/a'));
    await update(ref(first, 'previous/c'), { rank: 0 });
    expect(changed).toEqual([['b', 'a'], ['c', null]]);
    expect(removed).toEqual([['a', null]]);
    expect(moved).toEqual([['c', null]]);
  });

  it('rtdb-modular#M75b keeps child events inside the query window', async () => {
    const { first } = setup();
    const target = ref(first, 'window');
    await set(target, { a: { rank: 1 }, b: { rank: 2 }, c: { rank: 3 } });
    const ordered = query(target, orderByChild('rank'), limitToFirst(2));
    const added: string[] = [];
    const removed: string[] = [];
    onChildAdded(ordered, (snap) => { added.push(snap.key!); });
    onChildRemoved(ordered, (snap) => { removed.push(snap.key!); });
    await set(ref(first, 'window/d'), { rank: 0 });
    expect(added).toEqual(['a', 'b', 'd']);
    expect(removed).toEqual(['b']);
  });

  it('rtdb-modular#M89 round-trips, preserves, replaces, and clears priority', async () => {
    const { first } = setup();
    const target = ref(first, 'priority/value');
    await setWithPriority(target, { value: 1 }, 10);
    expect((await get(target)).priority).toBe(10);
    expect((await get(target)).exportVal()).toEqual({ value: 1, '.priority': 10 });
    await update(target, { value: 2 });
    expect((await get(target)).priority).toBe(10);
    await runTransaction(target, (current) => ({
      value: ((current as { value: number }).value ?? 0) + 1,
    }));
    expect((await get(target)).priority).toBe(10);
    await set(target, { value: 4 });
    expect((await get(target)).priority).toBeNull();
    await setPriority(target, 'later');
    expect((await get(target)).priority).toBe('later');
    await setPriority(target, null);
    expect((await get(target)).exportVal()).toEqual({ value: 4 });
    await expect(setWithPriority(target, 1, Number.NaN)).rejects.toThrow(/priority/);
  });

  it('rtdb-modular#M90 orders, bounds, ties, and limits by priority', async () => {
    const { first } = setup();
    const target = ref(first, 'priority-order');
    await setWithPriority(ref(first, 'priority-order/a'), 1, 10);
    await setWithPriority(ref(first, 'priority-order/b'), 2, 5);
    await setWithPriority(ref(first, 'priority-order/c'), 3, 5);
    expect(keys(await get(query(target, orderByPriority())))).toEqual(['b', 'c', 'a']);
    expect(keys(await get(query(target, orderByPriority(), startAt(5), limitToFirst(2))))).toEqual(['b', 'c']);
    expect(keys(await get(query(target, orderByPriority(), equalTo(5))))).toEqual(['b', 'c']);
  });

  it('rtdb-modular#M91 moves on priority change and preserves metadata through lifecycle writes', async () => {
    const { first } = setup();
    const target = ref(first, 'priority-move');
    await setWithPriority(ref(first, 'priority-move/a'), { value: 1 }, 10);
    await setWithPriority(ref(first, 'priority-move/b'), { value: 2 }, 5);
    const moved: Array<[string | null, string | null]> = [];
    onChildMoved(query(target, orderByPriority()), (snap, previous) => {
      moved.push([snap.key, previous]);
    });
    await setPriority(ref(first, 'priority-move/a'), 0);
    expect(moved).toEqual([['a', null]]);
    await update(target, { 'a/value': 3 });
    expect((await get(ref(first, 'priority-move/a'))).priority).toBe(0);
    await runTransaction(ref(first, 'priority-move/a'), (current) => current);
    expect((await get(ref(first, 'priority-move/a'))).priority).toBe(0);
  });

  it('rtdb-modular#157 accumulates concurrent increment sentinels', async () => {
    const { first, second } = setup();
    const target = ref(first, 'contention/increment');
    await set(target, 0);
    await Promise.all([
      set(target, increment(2)),
      set(ref(second, 'contention/increment'), increment(3)),
    ]);
    expect((await get(target)).val()).toBe(5);
  });

  it('rtdb-modular#161 retries a transaction after a competing client write', async () => {
    const { first, second } = setup();
    const target = ref(first, 'contention/transaction');
    await set(target, 0);
    const seen: unknown[] = [];
    let injected = false;
    const result = await runTransaction(target, (current) => {
      seen.push(current);
      if (!injected) {
        injected = true;
        void set(ref(second, 'contention/transaction'), 10);
      }
      return ((current as number | null) ?? 0) + 1;
    });
    expect(seen).toEqual([0, 10]);
    expect(result.committed).toBe(true);
    expect(result.snapshot?.val()).toBe(11);
  });
});
