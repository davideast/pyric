import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  get,
  getAdminDatabase,
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
  runTransaction,
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

  it('rtdb-modular#M75a keeps auth-revoked and initially-denied listeners with cancelCallback terminal across same-tick re-auth', async () => {
    const sandbox = initializeSandbox();
    sandbox.currentUser = { uid: 'initial-user' };
    const db = getDatabase(sandbox);
    const writer = getDatabase(sandbox.withAuth({ uid: 'writer' }));
    rtdbSandbox.setRules(db, {
      rules: { '.read': 'auth != null', '.write': 'true' },
    });
    await set(ref(writer, 'same-tick-auth'), { a: 0 });

    const valueDeliveries: unknown[] = [];
    const valueCancellations: Record<string, unknown>[] = [];
    onValue(
      ref(db, 'same-tick-auth'),
      (snapshot) => valueDeliveries.push(snapshot.val()),
      (error) => valueCancellations.push(cancellationShape(error, '/same-tick-auth')),
    );

    const queryDeliveries: unknown[] = [];
    const queryCancellations: Record<string, unknown>[] = [];
    onValue(
      query(ref(db, 'same-tick-auth'), orderByKey(), limitToFirst(5)),
      (snapshot) => queryDeliveries.push(snapshot.val()),
      (error) => queryCancellations.push(cancellationShape(error, '/same-tick-auth')),
    );

    const childDeliveries: Array<[string | null, unknown]> = [];
    const childCancellations: Record<string, unknown>[] = [];
    onChildAdded(
      ref(db, 'same-tick-auth'),
      (snapshot) => childDeliveries.push([snapshot.key, snapshot.val()]),
      (error) => childCancellations.push(cancellationShape(error, '/same-tick-auth')),
    );

    // Revoke by signing out and immediately sign back in within the same tick.
    sandbox.currentUser = null;
    sandbox.currentUser = { uid: 'later-user' };

    // Also attach an initially-denied listener while signed out and sign in within the same tick.
    const deniedSandbox = initializeSandbox();
    const deniedDb = getDatabase(deniedSandbox);
    const deniedWriter = getDatabase(deniedSandbox.withAuth({ uid: 'writer' }));
    rtdbSandbox.setRules(deniedDb, {
      rules: { '.read': 'auth != null', '.write': 'true' },
    });
    const deniedDeliveries: unknown[] = [];
    const deniedCancellations: Record<string, unknown>[] = [];
    onValue(
      ref(deniedDb, 'same-tick-initial-denial'),
      (snapshot) => deniedDeliveries.push(snapshot.val()),
      (error) => deniedCancellations.push(cancellationShape(error, '/same-tick-initial-denial')),
    );
    deniedSandbox.currentUser = { uid: 'later-user' };

    await set(ref(writer, 'same-tick-auth'), { a: 0, b: 1 });
    await set(ref(deniedWriter, 'same-tick-initial-denial'), { ok: true });
    await Promise.resolve();

    expect(valueDeliveries).toEqual([{ a: 0 }]);
    expect(queryDeliveries).toEqual([{ a: 0 }]);
    expect(childDeliveries).toEqual([['a', 0]]);
    expect(valueCancellations).toEqual(cancellationObservation.callbacklessAuth.signedOutCancellations);
    expect(queryCancellations).toEqual(cancellationObservation.callbacklessAuth.signedOutCancellations);
    expect(childCancellations).toEqual(cancellationObservation.callbacklessAuth.signedOutCancellations);
    expect(deniedDeliveries).toEqual([]);
    expect(deniedCancellations).toEqual(cancellationObservation.callbacklessAuth.signedOutCancellations);
  });

  it('rtdb-modular#M75a revokes active value and child listeners when a data write falsifies a data-dependent .read rule', async () => {
    const sandbox = initializeSandbox();
    const uid = 'alice';
    const keepUid = 'bob';
    sandbox.currentUser = { uid };
    const clientDb = getDatabase(sandbox);
    const bobDb = getDatabase(sandbox.withAuth({ uid: keepUid }));
    const adminDb = getAdminDatabase(sandbox);

    rtdbSandbox.setRules(clientDb, {
      rules: {
        rooms: {
          $room: {
            '.read': "data.child('members').child(auth.uid).val() == true",
          },
        },
        globalGate: {
          '.read': "root.child('allowlist').child(auth.uid).val() == true",
        },
      },
    });

    await set(ref(adminDb, 'rooms/room1'), {
      members: { [uid]: true, [keepUid]: true },
      message: 'initial-msg',
    });
    await set(ref(adminDb, 'rooms/room2'), {
      members: { [uid]: true },
      message: 'initial-msg',
    });
    await set(ref(adminDb, 'allowlist'), { [uid]: true });
    await set(ref(adminDb, 'globalGate'), 'secret-gate');

    const roomDeliveries: unknown[] = [];
    const roomCancellations: Record<string, unknown>[] = [];
    onValue(
      ref(clientDb, 'rooms/room1'),
      (snap) => roomDeliveries.push(snap.val()),
      (err) => roomCancellations.push(cancellationShape(err, '/rooms/room1')),
    );

    const childMsgDeliveries: unknown[] = [];
    const childMsgCancellations: Record<string, unknown>[] = [];
    onValue(
      ref(clientDb, 'rooms/room2/message'),
      (snap) => childMsgDeliveries.push(snap.val()),
      (err) => childMsgCancellations.push(cancellationShape(err, '/rooms/room2/message')),
    );

    const childAddedDeliveries: unknown[] = [];
    const childAddedCancellations: Record<string, unknown>[] = [];
    onChildAdded(
      ref(clientDb, 'rooms/room1/messages'),
      (snap) => childAddedDeliveries.push(snap.val()),
      (err) => childAddedCancellations.push(cancellationShape(err, '/rooms/room1/messages')),
    );

    const gateDeliveries: unknown[] = [];
    const gateCancellations: Record<string, unknown>[] = [];
    onValue(
      ref(clientDb, 'globalGate'),
      (snap) => gateDeliveries.push(snap.val()),
      (err) => gateCancellations.push(cancellationShape(err, '/globalGate')),
    );

    const bobDeliveries: unknown[] = [];
    const bobCancellations: Record<string, unknown>[] = [];
    onValue(
      ref(bobDb, 'rooms/room1/message'),
      (snap) => bobDeliveries.push(snap.val()),
      (err) => bobCancellations.push(cancellationShape(err, '/rooms/room1/message')),
    );

    expect(roomDeliveries).toEqual([{
      members: { [uid]: true, [keepUid]: true },
      message: 'initial-msg',
    }]);
    expect(childMsgDeliveries).toEqual(['initial-msg']);
    expect(childAddedDeliveries).toEqual([]);
    expect(gateDeliveries).toEqual(['secret-gate']);
    expect(bobDeliveries).toEqual(['initial-msg']);

    // Removing the member flag falsifies `.read` on `/rooms/$room` and `/globalGate`.
    await remove(ref(adminDb, `rooms/room1/members/${uid}`));
    await remove(ref(adminDb, `rooms/room2/members/${uid}`));
    await update(ref(adminDb, 'allowlist'), { [uid]: null });

    // Subsequent writes must not be delivered to the revoked listeners.
    await set(ref(adminDb, 'rooms/room1/message'), 'post-removal-msg');
    await set(ref(adminDb, 'rooms/room2/message'), 'post-removal-msg');
    await set(ref(adminDb, 'rooms/room1/messages/m1'), 'post-removal-child');
    await set(ref(adminDb, 'globalGate'), 'post-removal-gate');

    expect(roomDeliveries).toEqual([{
      members: { [uid]: true, [keepUid]: true },
      message: 'initial-msg',
    }]);
    expect(childMsgDeliveries).toEqual(['initial-msg']);
    expect(childAddedDeliveries).toEqual([]);
    expect(gateDeliveries).toEqual(['secret-gate']);

    expect(roomCancellations).toEqual(cancellationObservation.revoked.cancellations.value);
    expect(childMsgCancellations).toEqual(cancellationObservation.revoked.cancellations.value);
    expect(childAddedCancellations).toEqual(cancellationObservation.revoked.cancellations.child_added);
    expect(gateCancellations).toEqual(cancellationObservation.revoked.cancellations.value);

    // Bob remains a member of room1 and receives the post-removal message.
    expect(bobDeliveries).toEqual(['initial-msg', 'post-removal-msg']);
    expect(bobCancellations).toEqual([]);

    // Fresh get() after member removal is also denied.
    await expect(get(ref(clientDb, 'rooms/room1'))).rejects.toThrow(/PERMISSION_DENIED/);
  });

  // DF-1 (#1247): a committed transaction is a data write like set and update,
  // so it must revoke the listeners whose data-dependent `.read` it falsifies.
  const transactionRevokers = [
    { name: 'a client transaction', admin: false, applyLocally: true },
    { name: 'a client transaction with applyLocally false', admin: false, applyLocally: false },
    { name: 'an admin transaction', admin: true, applyLocally: true },
    { name: 'an admin transaction with applyLocally false', admin: true, applyLocally: false },
  ] as const;
  for (const revoker of transactionRevokers) {
    it(`rtdb-modular#M75a revokes active value and child listeners when ${revoker.name} falsifies a data-dependent .read rule`, async () => {
      const sandbox = initializeSandbox();
      const clientDb = getDatabase(sandbox.withAuth({ uid: 'alice' }));
      const bobDb = getDatabase(sandbox.withAuth({ uid: 'bob' }));
      const adminDb = getAdminDatabase(sandbox);
      const writerDb = revoker.admin ? adminDb : clientDb;
      rtdbSandbox.setRules(clientDb, {
        rules: {
          rooms: { $room: { '.read': "data.child('members').child(auth.uid).val() == true", '.write': 'true' } },
          gate: { '.read': "root.child('open').val() == true" },
          open: { '.read': 'true', '.write': 'true' },
        },
      });
      await set(ref(adminDb, 'rooms/r1'), { members: { alice: true, bob: true }, message: 'initial-msg' });
      await set(ref(adminDb, 'open'), true);
      await set(ref(adminDb, 'gate'), 'initial-gate');

      const room: unknown[] = [];
      const roomCancellations: Record<string, unknown>[] = [];
      onValue(ref(clientDb, 'rooms/r1'), (snap) => room.push(snap.val()),
        (err) => roomCancellations.push(cancellationShape(err, '/rooms/r1')));
      const added: unknown[] = [];
      const addedCancellations: Record<string, unknown>[] = [];
      onChildAdded(ref(clientDb, 'rooms/r1/messages'), (snap) => added.push(snap.val()),
        (err) => addedCancellations.push(cancellationShape(err, '/rooms/r1/messages')));
      const gate: unknown[] = [];
      const gateCancellations: Record<string, unknown>[] = [];
      onValue(ref(clientDb, 'gate'), (snap) => gate.push(snap.val()),
        (err) => gateCancellations.push(cancellationShape(err, '/gate')));
      const bob: unknown[] = [];
      const bobCancellations: Record<string, unknown>[] = [];
      onValue(ref(bobDb, 'rooms/r1/message'), (snap) => bob.push(snap.val()),
        (err) => bobCancellations.push(cancellationShape(err, '/rooms/r1/message')));

      const options = { applyLocally: revoker.applyLocally };
      await runTransaction(ref(writerDb, 'rooms/r1/members/alice'), () => false, options);
      await runTransaction(ref(writerDb, 'open'), () => false, options);

      // Later data must not reach the revoked listeners.
      await runTransaction(ref(adminDb, 'rooms/r1/message'), () => 'post-revocation-msg');
      await set(ref(adminDb, 'rooms/r1/messages/m1'), 'post-revocation-child');
      await set(ref(adminDb, 'gate'), 'post-revocation-gate');

      expect(room).toEqual([{ members: { alice: true, bob: true }, message: 'initial-msg' }]);
      expect(added).toEqual([]);
      expect(gate).toEqual(['initial-gate']);
      expect(roomCancellations).toEqual(cancellationObservation.revoked.cancellations.value);
      expect(addedCancellations).toEqual(cancellationObservation.revoked.cancellations.child_added);
      expect(gateCancellations).toEqual(cancellationObservation.revoked.cancellations.value);
      // Bob is still a member, so his listener survives and keeps receiving.
      expect(bob).toEqual(['initial-msg', 'post-revocation-msg']);
      expect(bobCancellations).toEqual([]);
      await expect(get(ref(clientDb, 'rooms/r1'))).rejects.toThrow(/PERMISSION_DENIED/);
    });
  }

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
