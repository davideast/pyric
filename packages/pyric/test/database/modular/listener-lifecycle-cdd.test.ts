import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  get,
  getDatabase,
  limitToFirst,
  onChildAdded,
  onChildChanged,
  onChildMoved,
  onChildRemoved,
  onValue,
  orderByChild,
  orderByKey,
  query,
  ref,
  remove,
  sandbox as rtdbSandbox,
  set,
  setWithPriority,
  update,
} from '../../../src/database/index.js';
import { cancellationShape, loadObservation as load, setup } from './cdd-replay-helpers.js';

const childPreviousObservation = load('rtdb-modular-child-previous-name');
const childOnlyOnceObservation = load('rtdb-modular-child-listener-only-once');
const cancellationObservation = load('rtdb-modular-listener-cancellation');

describe('RTDB CDD listener lifecycle cases', () => {
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

    const callbacklessSandbox = initializeSandbox();
    callbacklessSandbox.currentUser = { uid: 'initial-user' };
    const callbacklessDb = getDatabase(callbacklessSandbox);
    const callbacklessWriter = getDatabase(callbacklessSandbox.withAuth({ uid: 'writer' }));
    rtdbSandbox.setRules(callbacklessDb, {
      rules: { '.read': 'auth != null', '.write': 'true' },
    });
    await set(ref(callbacklessWriter, 'callbackless-auth'), { value: 0 });
    const callbacklessDeliveries: unknown[] = [];
    onValue(ref(callbacklessDb, 'callbackless-auth'), (snapshot) => {
      callbacklessDeliveries.push(snapshot.val());
    });
    callbacklessSandbox.currentUser = null;
    callbacklessSandbox.currentUser = { uid: 'later-user' };
    const freshControlDeliveries: unknown[] = [];
    onValue(ref(callbacklessDb, 'callbackless-auth'), (snapshot) => {
      freshControlDeliveries.push(snapshot.val());
    });
    await set(ref(callbacklessWriter, 'callbackless-auth'), { value: 1 });
    expect(callbacklessDeliveries).toEqual(
      cancellationObservation.callbacklessAuth.deliveries,
    );
    expect(freshControlDeliveries.at(-1)).toEqual(
      cancellationObservation.callbacklessAuth.freshControlDeliveries.at(-1),
    );

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

    const throwingSandbox = initializeSandbox();
    const throwingDb = getDatabase(throwingSandbox.withAuth({ uid: 'reader' }));
    rtdbSandbox.setRules(throwingDb, { rules: { '.read': 'true', '.write': 'true' } });
    await set(ref(throwingDb, 'throwing-cancel/child'), 1);
    const deliveries = { firstValue: 0, secondValue: 0, firstChild: 0, secondChild: 0 };
    const survivingCancellations = { value: 0, child: 0 };
    onValue(
      ref(throwingDb, 'throwing-cancel'),
      () => { deliveries.firstValue += 1; },
      () => { throw new Error('value cancellation failure'); },
    );
    onValue(
      ref(throwingDb, 'throwing-cancel'),
      () => { deliveries.secondValue += 1; },
      () => { survivingCancellations.value += 1; },
    );
    onChildChanged(
      ref(throwingDb, 'throwing-cancel'),
      () => { deliveries.firstChild += 1; },
      () => { throw new Error('child cancellation failure'); },
    );
    onChildChanged(
      ref(throwingDb, 'throwing-cancel'),
      () => { deliveries.secondChild += 1; },
      () => { survivingCancellations.child += 1; },
    );
    expect(() => rtdbSandbox.setRules(throwingDb, {
      rules: { '.read': 'false', '.write': 'true' },
    })).not.toThrow();
    await set(ref(throwingDb, 'throwing-cancel/child'), 2);
    expect({ deliveries, survivingCancellations }).toEqual({
      deliveries: { firstValue: 1, secondValue: 1, firstChild: 0, secondChild: 0 },
      survivingCancellations: { value: 1, child: 1 },
    });

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
    const plainPriorityTarget = ref(first, 'plain-priority-previous');
    await setWithPriority(ref(first, 'plain-priority-previous/z'), { value: 2 }, 2);
    await setWithPriority(ref(first, 'plain-priority-previous/a'), { value: 1 }, 1);
    const plainPriorityAdded: Array<[string | null, string | null]> = [];
    onChildAdded(plainPriorityTarget, (snap, previous) => {
      plainPriorityAdded.push([snap.key, previous]);
    });
    expect(plainPriorityAdded).toEqual(childPreviousObservation.plainPriorityAdded);
    expect((await get(target)).val()).toEqual(childPreviousObservation.terminal);
    await remove(ref(first, 'previous/d'));
    expect(removed.at(-1)).toEqual(['d', null]);
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

});
