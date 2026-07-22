import { expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import * as api from '../../../src/database/index.js';
import { loadObservation } from '../modular/cdd-replay-helpers.js';

type ErrorShape = { name: string; code: string | null; message: string };

function setup() {
  const sandbox = initializeSandbox();
  const db = api.getDatabase(sandbox.withAuth({ uid: 'alice' }));
  return { sandbox, db };
}

function snapshotKeys(snapshot: api.DataSnapshot): string[] {
  const result: string[] = [];
  snapshot.forEach(child => { if (child.key) result.push(child.key); return false; });
  return result;
}

function cancellationShape(error: Error, path: string): ErrorShape {
  return {
    name: error.name,
    code: (error as Error & { code?: string }).code ?? null,
    message: error.message.replace(path, '<path>'),
  };
}

const childPrevious = loadObservation('rtdb-modular-child-previous-name');
const childOnlyOnce = loadObservation('rtdb-modular-child-listener-only-once');
const listenerCancellation = loadObservation('rtdb-modular-listener-cancellation');
const childCofire = loadObservation('rtdb-modular-childchanged-cofire-with-childmoved');
const childMoveSequence = loadObservation('rtdb-modular-onchildmoved-previouschildname-sequencing');
const snapshotObservation = loadObservation('rtdb-modular-get-snapshot-shape');

export async function assertM50NameOrdering(): Promise<void> {
  const { db } = setup();
  const target = api.ref(db, 'rows');
  await api.set(target, {
    z: { score: 1 },
    '2147483648': { score: 1 },
    '10': { score: 1 },
    '2': { score: 1 },
    '1': { score: 1 },
  });
  expect(snapshotKeys(await api.get(api.query(target, api.orderByKey())))).toEqual([
    '1', '2', '10', '2147483648', 'z',
  ]);
  expect(snapshotKeys(await api.get(api.query(target, api.orderByKey(), api.startAt('2'), api.endAt('2147483648'))))).toEqual([
    '2', '10', '2147483648',
  ]);
  expect(snapshotKeys(await api.get(api.query(target, api.orderByChild('score'), api.startAt(1, '2'))))).toEqual([
    '2', '10', '2147483648', 'z',
  ]);
}

export async function assertM66ArrayCoercionThresholds(): Promise<void> {
  const { db } = setup();
  for (const [path, value, expected] of [
    ['dense', { 0: 'a', 1: 'b' }, ['a', 'b']],
    ['sparse-below-threshold', { 0: 'a', 2: 'c' }, ['a', null, 'c']],
    ['at-threshold', { 0: 'a', 4: 'e' }, { 0: 'a', 4: 'e' }],
    ['non-integer', { 0: 'a', x: 'x' }, { 0: 'a', x: 'x' }],
  ] as const) {
    await api.set(api.ref(db, path), value);
    expect((await api.get(api.ref(db, path))).val()).toEqual(expected);
  }
}

export async function assertM68WriteValidationMatrix(): Promise<void> {
  const invalidValues = [undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  const invalidKeys = ['bad.key', 'bad#key', 'bad$key', 'bad/key', 'bad[key', 'bad]key', 'bad\u0000key'];
  const operations = (value: unknown) => {
    const { db } = setup();
    const target = api.ref(db, 'target');
    return {
      synchronous: [
        () => api.set(target, value),
        () => api.update(target, { child: value }),
      ],
      asynchronous: [
        ...(value === undefined ? [] : [
          () => Promise.resolve(api.push(target, value)),
          () => api.runTransaction(target, () => value),
        ]),
      ],
    };
  };
  for (const value of invalidValues) {
    const matrix = operations(value);
    for (const operation of matrix.synchronous) expect(operation).toThrow(Error);
    for (const operation of matrix.asynchronous) await expect(operation()).rejects.toBeInstanceOf(Error);
  }
  for (const key of invalidKeys) {
    const matrix = operations({ [key]: 1 });
    for (const operation of matrix.synchronous) expect(operation).toThrow(Error);
    for (const operation of matrix.asynchronous) await expect(operation()).rejects.toBeInstanceOf(Error);
  }
}

export function assertM69ConstraintConflicts(): void {
  const { db } = setup();
  const target = api.ref(db, 'rows');
  const conflicts: api.QueryConstraint[][] = [
    [api.orderByKey(), api.orderByValue()],
    [api.orderByChild('a'), api.orderByChild('b')],
    [api.limitToFirst(1), api.limitToFirst(2)],
    [api.limitToLast(1), api.limitToLast(2)],
    [api.limitToFirst(1), api.limitToLast(1)],
    [api.startAt(1), api.startAt(2)],
    [api.startAt(1), api.startAfter(2)],
    [api.startAfter(1), api.equalTo(2)],
    [api.endAt(2), api.endBefore(1)],
    [api.endBefore(2), api.equalTo(1)],
    [api.equalTo(1), api.startAt(1)],
    [api.equalTo(1), api.endAt(1)],
  ];
  for (const constraints of conflicts) expect(() => api.query(target, ...constraints)).toThrow(Error);
}

export async function assertM70PushThenable(): Promise<void> {
  const { db } = setup();
  const target = api.ref(db, 'items');
  api.sandbox.setRules(db, { rules: { '.read': true, '.write': false } });
  const denied = api.push(target, { denied: true });
  expect(denied.key).toMatch(/^-.{19}$/);
  expect(denied.parent?.isEqual(target)).toBe(true);
  expect(typeof denied.then).toBe('function');
  expect(typeof denied.catch).toBe('function');
  const caught = await denied.catch(error => error as Error & { code?: string });
  expect(caught).toMatchObject({ name: 'Error', code: 'PERMISSION_DENIED' });
  await expect(Promise.resolve(denied)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

  api.sandbox.setRules(db, { rules: { '.read': true, '.write': true } });
  const allowed = api.push(target, { allowed: true });
  const resolved = await allowed;
  expect(resolved.isEqual(allowed)).toBe(true);
  expect((await api.get(allowed)).val()).toEqual({ allowed: true });
}

export async function assertM71SnapshotContract(): Promise<void> {
  const { db } = setup();
  const target = api.ref(db, 'parent');
  await api.set(target, { a: 1, b: 2, c: 3 });
  const snapshot = await api.get(target);
  const methods = ['val', 'exists', 'child', 'hasChild', 'hasChildren', 'forEach', 'exportVal', 'toJSON'];
  for (const method of methods) expect(typeof (snapshot as unknown as Record<string, unknown>)[method]).toBe('function');
  expect({
    hasVal: typeof snapshot.val === 'function',
    hasExists: typeof snapshot.exists === 'function',
    hasKey: 'key' in snapshot,
    hasRef: 'ref' in snapshot,
    hasSize: 'size' in snapshot,
    hasHasChildren: typeof snapshot.hasChildren === 'function',
    hasHasChild: typeof snapshot.hasChild === 'function',
    hasForEach: typeof snapshot.forEach === 'function',
    hasNumChildren: 'numChildren' in snapshot,
    size: snapshot.size,
    hasChildrenResult: snapshot.hasChildren(),
    existsResult: snapshot.exists(),
    val: snapshot.val(),
    forEachKeys: snapshotKeys(snapshot),
    key: snapshot.key,
  }).toEqual({
    hasVal: snapshotObservation.hasVal,
    hasExists: snapshotObservation.hasExists,
    hasKey: snapshotObservation.hasKey,
    hasRef: snapshotObservation.hasRef,
    hasSize: snapshotObservation.hasSize,
    hasHasChildren: snapshotObservation.hasHasChildren,
    hasHasChild: snapshotObservation.hasHasChild,
    hasForEach: snapshotObservation.hasForEach,
    hasNumChildren: snapshotObservation.hasNumChildren,
    size: snapshotObservation.size,
    hasChildrenResult: snapshotObservation.hasChildrenResult,
    existsResult: snapshotObservation.existsResult,
    val: snapshotObservation.val,
    forEachKeys: snapshotObservation.forEachKeys,
    key: snapshotObservation.key,
  });
  expect(snapshot.priority).toBeNull();
  expect(snapshot.ref.isEqual(target)).toBe(true);
  expect(snapshot.hasChild('a')).toBe(true);
  expect(snapshot.child('a').val()).toBe(1);
  expect(snapshot.exportVal()).toEqual(snapshotObservation.val);
  expect(snapshot.toJSON()).toEqual(snapshotObservation.val);
}

export async function assertM72ObjectOrderEquality(): Promise<void> {
  const { db } = setup();
  const target = api.ref(db, 'rows');
  await api.set(target, { a: { z: 1, a: 2 }, b: { a: 1 } });
  const ordered = api.query(target, api.orderByValue());
  expect(snapshotKeys(await api.get(ordered))).toEqual(['a', 'b']);
  const fires: unknown[] = [];
  const unsubscribe = api.onValue(ordered, snapshot => fires.push(snapshot.val()));
  await api.set(api.child(target, 'a'), { a: 2, z: 1 });
  expect(fires).toEqual([{ a: { a: 2, z: 1 }, b: { a: 1 } }]);
  unsubscribe();
}

export async function assertM75PreviousNames(): Promise<void> {
  expect(childPrevious.repeatCount).toBe(2);
  const { db } = setup();
  const target = api.ref(db, 'previous');
  await api.set(target, {
    a: { rank: 1, stable: false }, b: { rank: 2, stable: false }, c: { rank: 3, stable: false },
  });
  const added: Array<[string | null, string | null]> = [];
  const changed: Array<[string | null, string | null]> = [];
  const removed: Array<[string | null, string | null]> = [];
  const moved: Array<[string | null, string | null]> = [];
  api.onChildAdded(api.query(target, api.orderByKey()), (snap, previous) => added.push([snap.key, previous]));
  api.onChildChanged(api.query(target, api.orderByKey()), (snap, previous) => changed.push([snap.key, previous]));
  api.onChildRemoved(api.query(target, api.orderByKey()), (snap, previous) => removed.push([snap.key, previous]));
  api.onChildMoved(api.query(target, api.orderByChild('rank')), (snap, previous) => moved.push([snap.key, previous]));
  expect(added).toEqual(childPrevious.initialAdded);
  await api.set(api.child(target, 'd'), { rank: 4, stable: false });
  await api.update(api.child(target, 'b'), { stable: true });
  await api.remove(api.child(target, 'a'));
  await api.update(api.child(target, 'c'), { rank: 0 });
  expect({
    postMutationAdded: added.slice(3), changed, removed, moved,
    terminal: (await api.get(target)).val(),
  }).toEqual({
    postMutationAdded: childPrevious.postMutationAdded,
    changed: childPrevious.changed,
    removed: childPrevious.removed,
    moved: childPrevious.moved,
    terminal: childPrevious.terminal,
  });
  const priorityTarget = api.ref(db, 'plain-priority');
  await api.setWithPriority(api.child(priorityTarget, 'z'), { value: 2 }, 2);
  await api.setWithPriority(api.child(priorityTarget, 'a'), { value: 1 }, 1);
  const priorityAdded: Array<[string | null, string | null]> = [];
  api.onChildAdded(priorityTarget, (snap, previous) => priorityAdded.push([snap.key, previous]));
  expect(priorityAdded).toEqual(childPrevious.plainPriorityAdded);
}

export async function assertM75aCancellation(): Promise<void> {
  expect(listenerCancellation.repeatCount).toBe(2);
  const { db } = setup();
  const registrars = [api.onValue, api.onChildAdded, api.onChildChanged, api.onChildRemoved, api.onChildMoved] as const;
  const names = ['value', 'child_added', 'child_changed', 'child_removed', 'child_moved'] as const;
  const rules = (allowRevoked: boolean) => ({ rules: { '.write': true, cancel: {
    control: { '.read': true }, denied: { '.read': false }, revoked: { '.read': allowRevoked },
  } } });
  api.sandbox.setRules(db, rules(true));
  await api.set(api.ref(db, 'cancel/control'), { ok: true });
  await api.set(api.ref(db, 'cancel/denied'), { child: 1 });
  await api.set(api.ref(db, 'cancel/revoked'), { child: 1 });
  expect((await api.get(api.ref(db, 'cancel/control'))).val()).toEqual(listenerCancellation.allowedControl);

  const denied: Record<string, unknown> = {};
  for (let index = 0; index < registrars.length; index++) {
    const cancellations: ErrorShape[] = [];
    let synchronous: ErrorShape | null = null;
    try {
      registrars[index]!(api.ref(db, 'cancel/denied'), () => undefined, error => cancellations.push(cancellationShape(error, '/cancel/denied')));
    } catch (error) { synchronous = cancellationShape(error as Error, '/cancel/denied'); }
    expect(cancellations).toEqual([]);
    await Promise.resolve();
    denied[names[index]!] = { synchronous, cancellations };
  }
  expect(denied).toEqual(listenerCancellation.denied);

  const deliveryCounts: Record<string, number> = {};
  const cancellations: Record<string, ErrorShape[]> = {};
  for (let index = 0; index < registrars.length; index++) {
    const name = names[index]!;
    deliveryCounts[name] = 0; cancellations[name] = [];
    registrars[index]!(api.ref(db, 'cancel/revoked'), () => { deliveryCounts[name]++; }, error => {
      cancellations[name]!.push(cancellationShape(error, '/cancel/revoked'));
    });
  }
  api.sandbox.setRules(db, rules(false));
  expect({ deliveryCounts, cancellations }).toEqual(listenerCancellation.revoked);
  expect((await api.get(api.ref(db, 'cancel/control'))).val()).toEqual(listenerCancellation.controlAfterRevocation);
  const terminalCounts = { ...deliveryCounts };
  api.sandbox.setRules(db, rules(true));
  await api.set(api.ref(db, 'cancel/revoked/child'), 2);
  expect(deliveryCounts).toEqual(terminalCounts);

  const callbacklessSandbox = initializeSandbox();
  callbacklessSandbox.currentUser = { uid: 'initial-user' };
  const callbacklessDb = api.getDatabase(callbacklessSandbox);
  const writer = api.getDatabase(callbacklessSandbox.withAuth({ uid: 'writer' }));
  api.sandbox.setRules(callbacklessDb, { rules: { '.read': 'auth != null', '.write': true } });
  await api.set(api.ref(writer, 'callbackless-auth'), { value: 0 });
  const deliveries: unknown[] = [];
  api.onValue(api.ref(callbacklessDb, 'callbackless-auth'), snapshot => deliveries.push(snapshot.val()));
  callbacklessSandbox.currentUser = null;
  callbacklessSandbox.currentUser = { uid: 'later-user' };
  const freshControlDeliveries: unknown[] = [];
  api.onValue(api.ref(callbacklessDb, 'callbackless-auth'), snapshot => freshControlDeliveries.push(snapshot.val()));
  await api.set(api.ref(writer, 'callbackless-auth'), { value: 1 });
  expect(deliveries).toEqual(listenerCancellation.callbacklessAuth.deliveries);
  expect(freshControlDeliveries.at(-1)).toEqual(listenerCancellation.callbacklessAuth.freshControlDeliveries.at(-1));
}

export async function assertM75bQueryWindows(): Promise<void> {
  const { db } = setup();
  const target = api.ref(db, 'window');
  await api.set(target, { a: { rank: 1, label: 'a' }, b: { rank: 2, label: 'b' }, c: { rank: 3, label: 'c' } });
  const ordered = api.query(target, api.orderByChild('rank'), api.limitToFirst(2));
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  const moved: Array<[string, string | null]> = [];
  api.onChildAdded(ordered, snap => added.push(snap.key!));
  api.onChildChanged(ordered, snap => changed.push(snap.key!));
  api.onChildRemoved(ordered, snap => removed.push(snap.key!));
  api.onChildMoved(ordered, (snap, previous) => moved.push([snap.key!, previous]));
  await api.set(api.child(target, 'd'), { rank: 0, label: 'd' });
  await api.update(api.child(target, 'a'), { label: 'A' });
  await api.update(api.child(target, 'd'), { rank: 1.5 });
  expect({ added, changed, removed, moved }).toEqual({
    added: ['a', 'b', 'd'],
    changed: ['a', 'd'],
    removed: ['b'],
    moved: [['d', 'a']],
  });
}

export async function assertM75cMovementCofire(): Promise<void> {
  expect(childCofire.threw).toBe(false);
  expect(childMoveSequence.threw).toBe(false);
  const { db } = setup();
  const target = api.ref(db, 'cofire');
  await api.set(target, { a: { label: 'a0', score: 10 }, b: { label: 'b0', score: 20 }, c: { label: 'c0', score: 30 } });
  const ordered = api.query(target, api.orderByChild('score'));
  let changed = 0; let moved = 0;
  let lastChanged: unknown; let lastMoved: unknown;
  api.onChildChanged(ordered, snap => { changed++; lastChanged = { key: snap.key, val: snap.val() }; });
  api.onChildMoved(ordered, (snap, previousChildName) => { moved++; lastMoved = { key: snap.key, previousChildName }; });
  const deltas: number[] = [];
  let beforeChanged = changed; let beforeMoved = moved;
  await api.set(api.child(target, 'b/score'), 40); deltas.push(changed - beforeChanged, moved - beforeMoved);
  beforeChanged = changed; beforeMoved = moved;
  await api.set(api.child(target, 'a/label'), 'A!'); deltas.push(changed - beforeChanged, moved - beforeMoved);
  beforeChanged = changed; beforeMoved = moved;
  await api.set(api.child(target, 'c/score'), 35); deltas.push(changed - beforeChanged, moved - beforeMoved);
  expect(deltas).toEqual([
    childCofire.reorderChanged, childCofire.reorderMoved,
    childCofire.nonOrderChanged, childCofire.nonOrderMoved,
    childCofire.sameRankChanged, childCofire.sameRankMoved,
  ]);
  expect(lastChanged).toEqual(childCofire.lastChanged);
  expect(lastMoved).toEqual(childCofire.lastMoved);

  const sequenceTarget = api.ref(db, 'sequence');
  await api.set(sequenceTarget, { k1: { priority: 1 }, k2: { priority: 2 }, k3: { priority: 3 } });
  const moves: Array<{ key: string | null; prev: string | null }> = [];
  api.onChildMoved(api.query(sequenceTarget, api.orderByChild('priority')), (snap, prev) => moves.push({ key: snap.key, prev }));
  expect(moves).toHaveLength(childMoveSequence.firedOnInitial);
  await api.set(api.child(sequenceTarget, 'k1/priority'), 10);
  await api.set(api.child(sequenceTarget, 'k1/priority'), 2.5);
  await api.set(api.child(sequenceTarget, 'k1/priority'), 0);
  expect(moves.map(move => move.key)).toEqual(childMoveSequence.movedKeySequence);
  expect(moves.map(move => move.prev)).toEqual(childMoveSequence.prevNameSequence);
  expect(moves).toHaveLength(childMoveSequence.totalMoves);
}

export async function assertM75dOnlyOnceOverloads(): Promise<void> {
  expect(childOnlyOnce.repeatCount).toBe(2);
  const { db } = setup();
  const target = api.ref(db, 'only-once');
  await api.set(target, { a: { rank: 1, value: 1 }, b: { rank: 2, value: 2 }, c: { rank: 3, value: 3 } });
  const added: Array<[string | null, string | null]> = [];
  const changed: Array<[string | null, string | null]> = [];
  const removed: Array<[string | null, string | null]> = [];
  const moved: Array<[string | null, string | null]> = [];
  const cancellations: ErrorShape[] = [];
  api.onChildAdded(target, (snap, previous) => added.push([snap.key, previous]), { onlyOnce: true });
  api.onChildChanged(target, (snap, previous) => changed.push([snap.key, previous]), error => cancellations.push(cancellationShape(error, '/only-once')), { onlyOnce: true });
  api.onChildRemoved(target, (snap, previous) => removed.push([snap.key, previous]), { onlyOnce: true });
  api.onChildMoved(api.query(target, api.orderByChild('rank')), (snap, previous) => moved.push([snap.key, previous]), { onlyOnce: true });
  await api.update(api.child(target, 'a'), { value: 10, rank: 4 });
  await api.update(api.child(target, 'a'), { value: 11, rank: 0 });
  await api.remove(api.child(target, 'b'));
  await api.remove(api.child(target, 'c'));
  await api.set(api.child(target, 'd'), { rank: 5, value: 4 });
  expect({ added, changed, removed, moved, cancellations }).toEqual({
    added: childOnlyOnce.added,
    changed: childOnlyOnce.changed,
    removed: childOnlyOnce.removed,
    moved: childOnlyOnce.moved,
    cancellations: childOnlyOnce.cancellations,
  });
}

export async function assertM76ValidateAtomicity(): Promise<void> {
  for (const operation of ['set', 'update', 'transaction'] as const) {
    const { db } = setup();
    api.sandbox.setRules(db, { rules: { '.read': true, '.write': true, item: { '.validate': "newData.hasChildren(['required'])" } } });
    await api.set(api.ref(db, 'stable'), { untouched: true });
    const before = (await api.get(api.ref(db))).val();
    if (operation === 'set') {
      await expect(api.set(api.ref(db, 'item'), { optional: true })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    } else if (operation === 'update') {
      await expect(api.update(api.ref(db), { 'item/optional': true, 'other/wouldCommit': true })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    } else {
      await expect(api.runTransaction(api.ref(db, 'item'), () => ({ optional: true }))).rejects.toThrow('permission_denied');
    }
    expect((await api.get(api.ref(db))).val()).toEqual(before);
  }
}
