import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  get,
  getAdminDatabase,
  getDatabase,
  goOffline,
  onDisconnect,
  ref,
  sandbox as rtdbSandbox,
  serverTimestamp,
  set,
} from '../../src/database/index.js';
import type { OnDisconnect } from '../../src/database/index.js';
import { DisconnectOperationQueue } from '../../src/database/disconnect-operation-queue.js';

type HandleFactory = (child: string) => OnDisconnect;

interface DisconnectCase {
  readonly name: string;
  readonly seed: unknown;
  readonly steps: (handle: HandleFactory) => ReadonlyArray<() => Promise<void>>;
  readonly expected: unknown;
  readonly useExportVal?: boolean;
}

const SAME_PATH_CASES: readonly DisconnectCase[] = [
  {
    name: 'update then update on another child merges both keys',
    seed: { keep: true },
    steps: (od) => [() => od('').update({ a: 1 }), () => od('').update({ b: 2 })],
    expected: { a: 1, b: 2, keep: true },
  },
  {
    name: 'update then update on the same child keeps the later value',
    seed: { keep: true },
    steps: (od) => [() => od('').update({ a: 1 }), () => od('').update({ a: 2 })],
    expected: { a: 2, keep: true },
  },
  {
    name: 'update then update with disjoint deep keys keeps both paths',
    seed: { keep: true },
    steps: (od) => [
      () => od('').update({ 'i1/state': 'gone' }),
      () => od('').update({ 'i2/state': 'gone' }),
    ],
    expected: { i1: { state: 'gone' }, i2: { state: 'gone' }, keep: true },
  },
  {
    name: 'update with deep key then child update merges siblings',
    seed: { keep: true },
    steps: (od) => [() => od('').update({ 'x/a': 1 }), () => od('x').update({ b: 2 })],
    expected: { keep: true, x: { a: 1, b: 2 } },
  },
  {
    name: 'update then set replaces the node with the set payload',
    seed: { keep: true },
    steps: (od) => [() => od('').update({ a: 1 }), () => od('').set({ b: 2 })],
    expected: { b: 2 },
  },
  {
    name: 'set then update overlays the update while preserving set replacement semantics',
    seed: { keep: true },
    steps: (od) => [() => od('').set({ a: 1 }), () => od('').update({ b: 2 })],
    expected: { a: 1, b: 2 },
  },
  {
    name: 'update then remove deletes the node',
    seed: { keep: true },
    steps: (od) => [() => od('').update({ a: 1 }), () => od('').remove()],
    expected: null,
  },
  {
    name: 'two updates then cancel at path drops both writes',
    seed: { keep: true },
    steps: (od) => [
      () => od('').update({ a: 1 }),
      () => od('').update({ b: 2 }),
      () => od('').cancel(),
    ],
    expected: { keep: true },
  },
  {
    name: 'two updates then cancel one child keeps the other child',
    seed: { keep: true },
    steps: (od) => [
      () => od('').update({ a: 1 }),
      () => od('').update({ b: 2 }),
      () => od('a').cancel(),
    ],
    expected: { b: 2, keep: true },
  },
];

const NESTED_UPDATE_CASES: readonly DisconnectCase[] = [
  {
    name: 'deep sibling keys under one parent preserve untouched existing siblings',
    seed: { keep: true, a: { x: 0, y: 0, keepA: true } },
    steps: (od) => [() => od('').update({ 'a/x': 1 }), () => od('').update({ 'a/y': 2 })],
    expected: { keep: true, a: { keepA: true, x: 1, y: 2 } },
  },
  {
    name: 'object child then deep child overlays onto the object and still drops untouched siblings',
    seed: { keep: true, a: { x: 0, y: 0, keepA: true } },
    steps: (od) => [() => od('').update({ a: { x: 1, y: 2 } }), () => od('').update({ 'a/y': 3 })],
    expected: { keep: true, a: { x: 1, y: 3 } },
  },
  {
    name: 'object child then deep null removes that nested child',
    seed: { keep: true, a: { x: 0, y: 0, keepA: true } },
    steps: (od) => [() => od('').update({ a: { x: 1, y: 2 } }), () => od('').update({ 'a/y': null })],
    expected: { keep: true, a: { x: 1 } },
  },
  {
    name: 'object child then nulling its last nested child deletes the branch',
    seed: { keep: true, a: { x: 0, y: 0, keepA: true } },
    steps: (od) => [() => od('').update({ a: { x: 1 } }), () => od('').update({ 'a/x': null })],
    expected: { keep: true },
  },
  {
    name: 'deep keys then shallower object replaces all earlier descendants',
    seed: { keep: true, a: { x: 0, y: 0, keepA: true } },
    steps: (od) => [() => od('').update({ 'a/x': 1, 'a/y': 2 }), () => od('').update({ a: { z: 3 } })],
    expected: { keep: true, a: { z: 3 } },
  },
  {
    name: 'deep key then null at the same deep key deletes only that leaf',
    seed: { keep: true, a: { x: 0, y: 0, keepA: true } },
    steps: (od) => [() => od('').update({ 'a/x': 1 }), () => od('').update({ 'a/x': null })],
    expected: { keep: true, a: { keepA: true, y: 0 } },
  },
  {
    name: 'primitive child then deep child turns the leaf into an object',
    seed: { keep: true, a: { x: 0, y: 0, keepA: true } },
    steps: (od) => [() => od('').update({ a: 1 }), () => od('').update({ 'a/y': 2 })],
    expected: { keep: true, a: { y: 2 } },
  },
  {
    name: 'primitive child then deep null keeps the primitive unchanged',
    seed: { keep: true, a: { x: 0, y: 0, keepA: true } },
    steps: (od) => [() => od('').update({ a: 1 }), () => od('').update({ 'a/y': null })],
    expected: { keep: true, a: 1 },
  },
  {
    name: 'deep key then primitive at parent replaces the subtree with the primitive',
    seed: { keep: true, a: { x: 0, y: 0, keepA: true } },
    steps: (od) => [() => od('').update({ 'a/x': 1 }), () => od('').update({ a: 5 })],
    expected: { keep: true, a: 5 },
  },
  {
    name: 'deep grandchild keys then mid-level object replaces grandchildren only',
    seed: { keep: true, a: { b: { c: 0, d: 0, keepB: true }, keepA: true } },
    steps: (od) => [
      () => od('').update({ 'a/b/c': 1, 'a/b/d': 2 }),
      () => od('').update({ 'a/b': { e: 3 } }),
    ],
    expected: { keep: true, a: { b: { e: 3 }, keepA: true } },
  },
  {
    name: 'nested object then grandchild update overlays deeply without keeping old siblings',
    seed: { keep: true, a: { b: { c: 0, d: 0, keepB: true }, keepA: true } },
    steps: (od) => [
      () => od('').update({ a: { b: { c: 1, d: 2 } } }),
      () => od('').update({ 'a/b/c': 9 }),
    ],
    expected: { keep: true, a: { b: { c: 9, d: 2 } } },
  },
  {
    name: 'server value child then deep child turns the leaf into an object',
    seed: { keep: true },
    steps: (od) => [() => od('').update({ a: serverTimestamp() }), () => od('').update({ 'a/b': 1 })],
    expected: { keep: true, a: { b: 1 } },
  },
];

const SET_AND_REMOVE_OVERLAY_CASES: readonly DisconnectCase[] = [
  {
    name: 'set nested object then deep update overlays inside the set payload',
    seed: { keep: true, a: { old: 1 } },
    steps: (od) => [() => od('').set({ a: { x: 1 } }), () => od('').update({ 'a/y': 2 })],
    expected: { a: { x: 1, y: 2 } },
  },
  {
    name: 'set then update nulling one child removes that child',
    seed: { keep: true },
    steps: (od) => [() => od('').set({ a: 1, b: 2 }), () => od('').update({ b: null })],
    expected: { a: 1 },
  },
  {
    name: 'set then update nulling the last child removes the whole node',
    seed: { keep: true },
    steps: (od) => [() => od('').set({ a: 1 }), () => od('').update({ a: null })],
    expected: null,
  },
  {
    name: 'set scalar then update replaces the scalar with the updated children',
    seed: { keep: true },
    steps: (od) => [() => od('').set('scalar'), () => od('').update({ b: 2 })],
    expected: { b: 2 },
  },
  {
    name: 'set scalar then update with null child keeps the scalar',
    seed: { keep: true },
    steps: (od) => [() => od('').set('scalar'), () => od('').update({ b: null })],
    expected: 'scalar',
  },
  {
    name: 'remove then update replaces the node with only the updated fields',
    seed: { keep: true },
    steps: (od) => [() => od('').remove(), () => od('').update({ b: 2 })],
    expected: { b: 2 },
  },
  {
    name: 'remove then update with null child still removes the node',
    seed: { keep: true },
    steps: (od) => [() => od('').remove(), () => od('').update({ a: null })],
    expected: null,
  },
  {
    name: 'set array then update overlays integer indexes',
    seed: { keep: true },
    steps: (od) => [() => od('').set([10, 20]), () => od('').update({ '1': 99, '2': 30 })],
    expected: [10, 99, 30],
  },
  {
    name: 'set server value then update replaces with updated object',
    seed: { keep: true },
    steps: (od) => [() => od('').set(serverTimestamp()), () => od('').update({ b: 2 })],
    expected: { b: 2 },
  },
  {
    name: 'set then update then cancel original child keeps added child and untouched db keys',
    seed: { keep: true },
    steps: (od) => [
      () => od('').set({ a: 1 }),
      () => od('').update({ b: 2 }),
      () => od('a').cancel(),
    ],
    expected: { b: 2, keep: true },
  },
  {
    name: 'set then update then cancel added child keeps original child and untouched db keys',
    seed: { keep: true },
    steps: (od) => [
      () => od('').set({ a: 1 }),
      () => od('').update({ b: 2 }),
      () => od('b').cancel(),
    ],
    expected: { a: 1, keep: true },
  },
  {
    name: 'setWithPriority then update preserves root priority',
    seed: { keep: true },
    steps: (od) => [() => od('').setWithPriority({ a: 1 }, 9), () => od('').update({ b: 2 })],
    expected: { '.priority': 9, a: 1, b: 2 },
    useExportVal: true,
  },
  {
    name: 'setWithPriority then update with .priority replaces root priority',
    seed: { keep: true },
    steps: (od) => [
      () => od('').setWithPriority({ a: 1 }, 9),
      () => od('').update({ b: 2, '.priority': 5 }),
    ],
    expected: { '.priority': 5, a: 1, b: 2 },
    useExportVal: true,
  },
  {
    name: 'setWithPriority then update with null .priority clears root priority',
    seed: { keep: true },
    steps: (od) => [
      () => od('').setWithPriority({ a: 1 }, 9),
      () => od('').update({ '.priority': null }),
    ],
    expected: { a: 1 },
    useExportVal: true,
  },
  {
    name: 'setWithPriority then update nulling last child drops priority and deletes node',
    seed: { keep: true },
    steps: (od) => [() => od('').setWithPriority({ a: 1 }, 9), () => od('').update({ a: null })],
    expected: null,
    useExportVal: true,
  },
  {
    name: 'update object with inline priority then deep child preserves child priority',
    seed: { keep: true },
    steps: (od) => [
      () => od('').update({ a: { x: 1, '.priority': 7 } }),
      () => od('').update({ 'a/y': 2 }),
    ],
    expected: { a: { '.priority': 7, x: 1, y: 2 }, keep: true },
    useExportVal: true,
  },
  {
    name: 'set leaf with inline priority then deep child preserves priority on new parent object',
    seed: { keep: true },
    steps: (od) => [
      () => od('').set({ a: { '.value': 1, '.priority': 5 } }),
      () => od('').update({ 'a/x': 2 }),
    ],
    expected: { a: { '.priority': 5, x: 2 } },
    useExportVal: true,
  },
  {
    name: 'update deep child then deep .priority merges both keys',
    seed: { keep: true, a: { x: 1 } },
    steps: (od) => [
      () => od('').update({ 'a/y': 2 }),
      () => od('').update({ 'a/.priority': 7 }),
    ],
    expected: { a: { '.priority': 7, x: 1, y: 2 }, keep: true },
    useExportVal: true,
  },
];

const CROSS_PATH_CASES: readonly DisconnectCase[] = [
  {
    name: 'parent set then child update overlays child fields',
    seed: { keep: true, sub: { old: 1, x: 0 } },
    steps: (od) => [
      () => od('').set({ a: 1, sub: { x: 1 } }),
      () => od('sub').update({ y: 2 }),
    ],
    expected: { a: 1, sub: { x: 1, y: 2 } },
  },
  {
    name: 'parent update then child set then parent update overwriting child wins over earlier child set',
    seed: { keep: true, sub: { old: 1, x: 0 } },
    steps: (od) => [
      () => od('').update({ other: 1 }),
      () => od('sub').set({ x: 1, y: 1 }),
      () => od('').update({ sub: { z: 9 } }),
    ],
    expected: { keep: true, other: 1, sub: { z: 9 } },
  },
  {
    name: 'parent update then child set then parent deep update into child overlays child set',
    seed: { keep: true, sub: { old: 1, x: 0 } },
    steps: (od) => [
      () => od('').update({ other: 1 }),
      () => od('sub').set({ x: 1, y: 1 }),
      () => od('').update({ 'sub/x': 9 }),
    ],
    expected: { keep: true, other: 1, sub: { x: 9, y: 1 } },
  },
  {
    name: 'child set then parent update overwriting child wins over earlier child set',
    seed: { keep: true, sub: { old: 1, x: 0 } },
    steps: (od) => [
      () => od('sub').set({ x: 1, y: 1 }),
      () => od('').update({ sub: { z: 9 } }),
    ],
    expected: { keep: true, sub: { z: 9 } },
  },
  {
    name: 'child set then parent deep update into child overlays child set',
    seed: { keep: true, sub: { old: 1, x: 0 } },
    steps: (od) => [
      () => od('sub').set({ x: 1, y: 1 }),
      () => od('').update({ 'sub/x': 9 }),
    ],
    expected: { keep: true, sub: { x: 9, y: 1 } },
  },
  {
    name: 'parent update then child set then child cancel cancels both writes at child',
    seed: { keep: true, a: 0, b: 0 },
    steps: (od) => [
      () => od('').update({ a: 1, b: 2 }),
      () => od('a').set(10),
      () => od('a').cancel(),
    ],
    expected: { a: 0, b: 2, keep: true },
  },
  {
    name: 'parent set then child set then parent update on sibling preserves child set',
    seed: { keep: true, sub: { old: 1, x: 0 } },
    steps: (od) => [
      () => od('').set({ a: 1, sub: { x: 1, y: 1 } }),
      () => od('sub/x').set(10),
      () => od('').update({ other: 3 }),
    ],
    expected: { a: 1, other: 3, sub: { x: 10, y: 1 } },
  },
  {
    name: 'parent set then child set then parent deep update on same child wins over earlier child set',
    seed: { keep: true, sub: { old: 1, x: 0 } },
    steps: (od) => [
      () => od('').set({ a: 1, sub: { x: 1, y: 1 } }),
      () => od('sub/x').set(10),
      () => od('').update({ 'sub/x': 20 }),
    ],
    expected: { a: 1, sub: { x: 20, y: 1 } },
  },
  {
    name: 'child update then parent update then child update on same key keeps latest write',
    seed: { keep: true, sub: { old: 1, x: 0 } },
    steps: (od) => [
      () => od('sub').update({ x: 1 }),
      () => od('').update({ 'sub/x': 2 }),
      () => od('sub').update({ x: 3 }),
    ],
    expected: { keep: true, sub: { old: 1, x: 3 } },
  },
  {
    name: 'child set then parent deep update then child set keeps latest child set',
    seed: { keep: true, sub: { old: 1, x: 0 } },
    steps: (od) => [
      () => od('sub').set({ x: 1 }),
      () => od('').update({ 'sub/x': 2 }),
      () => od('sub').set({ x: 3 }),
    ],
    expected: { keep: true, sub: { x: 3 } },
  },
];

const ALL_CASES: readonly DisconnectCase[] = [
  ...SAME_PATH_CASES,
  ...NESTED_UPDATE_CASES,
  ...SET_AND_REMOVE_OVERLAY_CASES,
  ...CROSS_PATH_CASES,
];

describe('onDisconnect registration merging across same-path and overlapping sequences', () => {
  for (const spec of ALL_CASES) {
    test(spec.name, async () => {
      const box = initializeSandbox();
      const db = getDatabase(box.withAuth({ uid: 'u1' }));
      rtdbSandbox.setRules(db, { rules: { '.read': true, '.write': true } });
      const base = 'cases/target';
      await set(ref(db, base), spec.seed);
      const handle: HandleFactory = (child) => {
        const path = child === '' ? base : `${base}/${child}`;
        return onDisconnect(ref(db, path));
      };
      for (const step of spec.steps(handle)) {
        await step();
      }
      goOffline(db);
      const snapshot = await get(ref(getAdminDatabase(box), base));
      let actual: unknown;
      if (spec.useExportVal) {
        actual = snapshot.exportVal();
      } else {
        actual = snapshot.val();
      }
      expect(actual).toEqual(spec.expected);
    });
  }

  test('set then update keeps set semantics under tightened parent write rules', async () => {
    const box = initializeSandbox();
    const db = getDatabase(box.withAuth({ uid: 'u1' }));
    const admin = getAdminDatabase(box);
    const openWhileUnlocked = "root.child('flags').child('locked').val() != true";
    rtdbSandbox.setRules(db, {
      rules: {
        '.read': true,
        items: {
          doc: { '.write': openWhileUnlocked, $k: { '.write': true } },
        },
      },
    });
    await set(ref(admin, 'flags/locked'), false);
    await set(ref(admin, 'items/doc'), { a: 0, keep: true });
    await onDisconnect(ref(db, 'items/doc')).set({ a: 1 });
    await onDisconnect(ref(db, 'items/doc')).update({ b: 2 });
    await set(ref(admin, 'flags/locked'), true);
    goOffline(db);
    expect((await get(ref(admin, 'items/doc'))).val()).toEqual({ a: 0, keep: true });
  });

  test('root path merges sequential multi-path updates', async () => {
    const box = initializeSandbox();
    const db = getDatabase(box.withAuth({ uid: 'u1' }));
    rtdbSandbox.setRules(db, { rules: { '.read': true, '.write': true } });
    await set(ref(db, '/'), {
      items: { i1: { state: 'live' }, i2: { state: 'live' } },
      keep: true,
    });
    await onDisconnect(ref(db, '/')).update({ 'items/i1/state': 'gone' });
    await onDisconnect(ref(db, '/')).update({ 'items/i2/state': 'gone' });
    goOffline(db);
    expect((await get(ref(getAdminDatabase(box), '/'))).val()).toEqual({
      items: { i1: { state: 'gone' }, i2: { state: 'gone' } },
      keep: true,
    });
  });
});

describe('DisconnectOperationQueue unit invariants', () => {
  test('merges same-path updates into one non-overlapping update operation and preserves metadata', () => {
    const queue = new DisconnectOperationQueue<{ actor: string }>();
    queue.set({ kind: 'update', path: '/items', values: { 'a/x': 1, 'a/y': 2, keepKey: 0 }, actor: 'u1' });
    queue.set({ kind: 'update', path: '/items', values: { a: { z: 3 }, b: 4 }, actor: 'u1' });
    expect(queue.takeAll()).toEqual([
      { kind: 'update', path: '/items', values: { a: { z: 3 }, b: 4, keepKey: 0 }, actor: 'u1' },
    ]);
  });

  test('overlays an update onto a queued set as one set operation', () => {
    const queue = new DisconnectOperationQueue<{ actor: string }>();
    queue.set({ kind: 'set', path: '/items/i1', value: { a: 1 }, priority: 9, actor: 'u1' });
    queue.set({ kind: 'update', path: '/items/i1', values: { b: 2 }, actor: 'u1' });
    expect(queue.takeAll()).toEqual([
      { kind: 'set', path: '/items/i1', value: { a: 1, b: 2 }, priority: 9, actor: 'u1' },
    ]);
  });

  test('ignores an empty update without clobbering earlier queued operations', () => {
    const queue = new DisconnectOperationQueue();
    queue.set({ kind: 'set', path: '/items/i1', value: { a: 1 } });
    queue.set({ kind: 'update', path: '/items/i1', values: {} });
    expect(queue.takeAll()).toEqual([
      { kind: 'set', path: '/items/i1', value: { a: 1 } },
    ]);
  });
});
