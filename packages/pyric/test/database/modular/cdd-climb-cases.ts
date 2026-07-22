import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  orderByKey,
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

const OBS_DIR = join(import.meta.dir, '..', '..', '..', '..', '..', 'packages', 'conformance', 'observations', 'rtdb-modular');

function loadObservation(name: string): Record<string, any> {
  return (JSON.parse(readFileSync(join(OBS_DIR, `${name}.json`), 'utf8')) as {
    behavior: Record<string, any>;
  }).behavior;
}

export const CDD_REPLAYED_OBSERVATIONS = new Set([
  'rtdb-modular-child-previous-name',
  'rtdb-modular-child-listener-only-once',
  'rtdb-modular-priority-contract',
  'rtdb-modular-concurrent-transforms',
  'rtdb-modular-listener-cancellation',
]);

const childPreviousObservation = loadObservation('rtdb-modular-child-previous-name');
const childOnlyOnceObservation = loadObservation('rtdb-modular-child-listener-only-once');
const priorityObservation = loadObservation('rtdb-modular-priority-contract');
const concurrentObservation = loadObservation('rtdb-modular-concurrent-transforms');
const cancellationObservation = loadObservation('rtdb-modular-listener-cancellation');

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

function cancellationShape(error: Error, path: string): Record<string, unknown> {
  return {
    name: error.name,
    code: (error as Error & { code?: string }).code ?? null,
    message: error.message.replace(path, '<path>'),
  };
}

describe('RTDB CDD climb row cases', () => {
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
    const registrars = [onValue, onChildAdded, onChildChanged, onChildRemoved, onChildMoved] as const;
    const names = ['value', 'child_added', 'child_changed', 'child_removed', 'child_moved'] as const;
    const rules = (revokedRead: boolean) => ({
      rules: {
        '.write': 'true',
        cancel: {
          control: { '.read': 'true' },
          denied: { '.read': 'false' },
          revoked: { '.read': revokedRead ? 'true' : 'false' },
        },
      },
    });
    rtdbSandbox.setRules(first, rules(true));
    await set(ref(first, 'cancel/control'), { ok: true });
    await set(ref(first, 'cancel/denied'), { child: 1 });
    await set(ref(first, 'cancel/revoked'), { child: 1 });
    expect((await get(ref(first, 'cancel/control'))).val()).toEqual(
      cancellationObservation.allowedControl,
    );

    const denied: Record<string, unknown> = {};
    for (let index = 0; index < registrars.length; index++) {
      const cancellations: Record<string, unknown>[] = [];
      let synchronous: Record<string, unknown> | null = null;
      try {
        registrars[index]!(
          ref(first, 'cancel/denied'),
          () => undefined,
          (error) => { cancellations.push(cancellationShape(error, '/cancel/denied')); },
        );
      } catch (error) {
        synchronous = cancellationShape(error as Error, '/cancel/denied');
      }
      expect(cancellations).toEqual([]);
      await Promise.resolve();
      denied[names[index]!] = { synchronous, cancellations };
    }
    expect(denied).toEqual(cancellationObservation.denied);

    const deliveryCounts: Record<string, number> = {};
    const revokedCancellations: Record<string, Record<string, unknown>[]> = {};
    for (let index = 0; index < registrars.length; index++) {
      const name = names[index]!;
      deliveryCounts[name] = 0;
      revokedCancellations[name] = [];
      registrars[index]!(
        ref(first, 'cancel/revoked'),
        () => { deliveryCounts[name] = (deliveryCounts[name] ?? 0) + 1; },
        (error) => {
          revokedCancellations[name]!.push(cancellationShape(error, '/cancel/revoked'));
        },
      );
    }
    rtdbSandbox.setRules(first, rules(false));
    expect({ deliveryCounts, cancellations: revokedCancellations }).toEqual(
      cancellationObservation.revoked,
    );
    expect((await get(ref(first, 'cancel/control'))).val()).toEqual(
      cancellationObservation.controlAfterRevocation,
    );
    expect(cancellationObservation.repeatCount).toBe(2);

    // A cancellation is terminal for the registration. Later Auth changes
    // must not silently recreate a listener that Firebase has canceled.
    const initiallyDeniedSandbox = initializeSandbox();
    const initiallyDeniedDb = getDatabase(initiallyDeniedSandbox);
    const initiallyDeniedWriter = getDatabase(
      initiallyDeniedSandbox.withAuth({ uid: 'writer' }),
    );
    rtdbSandbox.setRules(initiallyDeniedDb, {
      rules: { '.read': 'auth != null', '.write': 'true' },
    });
    const deniedValues: unknown[] = [];
    const deniedErrors: Error[] = [];
    onValue(
      ref(initiallyDeniedDb, 'terminal-denial'),
      (snapshot) => deniedValues.push(snapshot.val()),
      (error) => deniedErrors.push(error),
    );
    await Promise.resolve();
    initiallyDeniedSandbox.currentUser = { uid: 'later-user' };
    await set(ref(initiallyDeniedWriter, 'terminal-denial'), 1);
    expect({ deliveries: deniedValues, cancellations: deniedErrors.length }).toEqual({
      deliveries: [],
      cancellations: 1,
    });

    const revokedSandbox = initializeSandbox();
    revokedSandbox.currentUser = { uid: 'initial-user' };
    const revokedDb = getDatabase(revokedSandbox);
    const revokedWriter = getDatabase(revokedSandbox.withAuth({ uid: 'writer' }));
    rtdbSandbox.setRules(revokedDb, {
      rules: { '.read': 'auth != null', '.write': 'true' },
    });
    const revokedValues: unknown[] = [];
    const revokedErrors: Error[] = [];
    onValue(
      ref(revokedDb, 'terminal-revocation'),
      (snapshot) => revokedValues.push(snapshot.val()),
      (error) => revokedErrors.push(error),
    );
    rtdbSandbox.setRules(revokedDb, {
      rules: { '.read': 'false', '.write': 'true' },
    });
    rtdbSandbox.setRules(revokedDb, {
      rules: { '.read': 'auth != null', '.write': 'true' },
    });
    revokedSandbox.currentUser = { uid: 'later-user' };
    await set(ref(revokedWriter, 'terminal-revocation'), 1);
    expect({ deliveries: revokedValues, cancellations: revokedErrors.length }).toEqual({
      deliveries: [null],
      cancellations: 1,
    });

    const callbacklessSandbox = initializeSandbox();
    callbacklessSandbox.currentUser = { uid: 'initial-user' };
    const callbacklessDb = getDatabase(callbacklessSandbox);
    const callbacklessWriter = getDatabase(callbacklessSandbox.withAuth({ uid: 'writer' }));
    rtdbSandbox.setRules(callbacklessDb, {
      rules: { '.read': 'auth != null', '.write': 'true' },
    });
    const callbacklessValues: unknown[] = [];
    onValue(ref(callbacklessDb, 'callbackless-denial'), (snapshot) => {
      callbacklessValues.push(snapshot.val());
    });
    callbacklessSandbox.currentUser = null;
    callbacklessSandbox.currentUser = { uid: 'later-user' };
    await set(ref(callbacklessWriter, 'callbackless-denial'), 1);
    expect(callbacklessValues).toEqual([null]);
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
    const keyOrdered = query(target, orderByKey());
    onChildAdded(keyOrdered, (snap, previous) => {
      added.push([snap.key, previous]);
    });
    onChildChanged(keyOrdered, (snap, previous) => {
      changed.push([snap.key, previous]);
    });
    onChildRemoved(keyOrdered, (snap, previous) => {
      removed.push([snap.key, previous]);
    });
    onChildMoved(query(target, orderByChild('rank')), (snap, previous) => {
      moved.push([snap.key, previous]);
    });
    expect(added).toEqual(childPreviousObservation.initialAdded);
    await set(ref(first, 'previous/d'), { rank: 4, stable: false });
    await update(ref(first, 'previous/b'), { stable: true });
    await remove(ref(first, 'previous/a'));
    await update(ref(first, 'previous/c'), { rank: 0 });
    expect(added.slice(3)).toEqual(childPreviousObservation.postMutationAdded);
    expect(changed).toEqual(childPreviousObservation.changed);
    expect(removed).toEqual(childPreviousObservation.removed);
    expect(moved).toEqual(childPreviousObservation.moved);
    expect((await get(target)).val()).toEqual(childPreviousObservation.terminal);
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
    expect(() => onChildAdded(target, (snapshot) => {
      delivered.push(snapshot.key);
      throw new Error('listener failure');
    }, { onlyOnce: true })).not.toThrow();
    expect(delivered).toEqual(['c', 'b', 'a']);
  });

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
    await setWithPriority(ref(first, 'priority-order/a'), 1, 10);
    await setWithPriority(ref(first, 'priority-order/b'), 2, 5);
    await setWithPriority(ref(first, 'priority-order/c'), 3, 5);
    expect(keys(await get(query(target, orderByPriority())))).toEqual(priorityObservation.orderedKeys);
    expect(keys(await get(query(target, orderByPriority(), startAt(5), limitToFirst(2))))).toEqual(priorityObservation.boundedKeys);
    expect(keys(await get(query(target, orderByPriority(), equalTo(5))))).toEqual(priorityObservation.equalKeys);
  });

  it('rtdb-modular#M91 moves on priority change and preserves metadata through lifecycle writes', async () => {
    const { first } = setup();
    const target = ref(first, 'priority-move');
    await setWithPriority(ref(first, 'priority-move/a'), { value: 1 }, 10);
    await setWithPriority(ref(first, 'priority-move/b'), { value: 2 }, 5);
    await setWithPriority(ref(first, 'priority-move/c'), { value: 3 }, 5);
    const moved: Array<[string | null, string | null]> = [];
    onChildMoved(query(target, orderByPriority()), (snap, previous) => {
      moved.push([snap.key, previous]);
    });
    await setPriority(ref(first, 'priority-move/a'), 0);
    expect(moved).toEqual(priorityObservation.moved);
    expect((await get(ref(first, 'priority-move/a'))).exportVal()).toEqual(
      priorityObservation.afterMove.exportVal,
    );
    await update(target, { 'a/value': 4 });
    expect((await get(ref(first, 'priority-move/a'))).priority).toBe(priorityObservation.afterUpdate);
    await runTransaction(ref(first, 'priority-move/a'), (current) => ({
      value: ((current as { value: number }).value ?? 0) + 1,
    }));
    expect((await get(ref(first, 'priority-move/a'))).priority).toBe(priorityObservation.afterTransaction);
  });

  it('rtdb-modular#157 accumulates concurrent increment sentinels', async () => {
    const { first, second } = setup();
    const target = ref(first, 'contention/increment');
    await set(target, 0);
    await Promise.all([
      set(target, increment(2)),
      set(ref(second, 'contention/increment'), increment(3)),
    ]);
    expect((await get(target)).val()).toBe(concurrentObservation.incrementTerminal);
  });

  it('rtdb-modular#161 documents ordinary concurrent transaction serialization', async () => {
    const { first, second } = setup();
    const target = ref(first, 'contention/transaction');
    await set(target, 0);
    const calls = [0, 0];
    const results = await Promise.all([
      runTransaction(target, (current) => {
        calls[0] += 1;
        return ((current as number | null) ?? 0) + 1;
      }),
      runTransaction(ref(second, 'contention/transaction'), (current) => {
        calls[1] += 1;
        return ((current as number | null) ?? 0) + 1;
      }),
    ]);
    expect(calls).toEqual([1, 1]);
    expect(calls).not.toEqual(concurrentObservation.invocationCountsSorted);
    expect(results.map((result) => result.committed)).toEqual(concurrentObservation.committed);
    expect(results.map((result) => result.snapshot.val()).sort()).toEqual(
      concurrentObservation.finalSnapshotsSorted,
    );
    expect((await get(target)).val()).toBe(concurrentObservation.transactionTerminal);
  });

  it('retries a transaction after a synchronous re-entrant conflicting write', async () => {
    const { first, second } = setup();
    const target = ref(first, 'contention/reentrant-transaction');
    await set(target, 0);
    const seen: unknown[] = [];
    let injected = false;
    const result = await runTransaction(target, (current) => {
      seen.push(current);
      if (!injected) {
        injected = true;
        void set(ref(second, 'contention/reentrant-transaction'), 10);
      }
      return ((current as number | null) ?? 0) + 1;
    });
    expect(seen).toEqual([0, 10]);
    expect(seen.length > 1).toBe(concurrentObservation.retryObserved);
    expect(result.committed).toBe(true);
    expect(result.snapshot?.val()).toBe(11);

    const unrelated = ref(first, 'contention/unrelated-transaction');
    await set(unrelated, 0);
    let unrelatedCalls = 0;
    const unrelatedResult = await runTransaction(unrelated, (current) => {
      unrelatedCalls += 1;
      void set(ref(second, 'contention/other-path'), unrelatedCalls);
      return ((current as number | null) ?? 0) + 1;
    });
    expect(unrelatedCalls).toBe(1);
    expect(unrelatedResult.committed).toBe(true);
    expect(unrelatedResult.snapshot?.val()).toBe(1);
  });

  it('releases path-version history after transaction conflict checks', async () => {
    const { first } = setup();
    const backend = first[TARGET_SYMBOL].backend as unknown as {
      transactionMutationHistory: unknown[];
    };
    for (let index = 0; index < 100; index++) {
      await set(ref(first, `history/${index}`), index);
    }
    await runTransaction(ref(first, 'history/transaction'), (current) =>
      ((current as number | null) ?? 0) + 1);
    expect(backend.transactionMutationHistory).toHaveLength(0);
  });
});
