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
  set,
  setWithPriority,
} from '../../src/database/index.js';
import type { OnDisconnect } from '../../src/database/index.js';
import { DisconnectOperationQueue } from '../../src/database/disconnect-operation-queue.js';

type HandleFactory = (child: string) => OnDisconnect;

interface FoldingCase {
  readonly name: string;
  readonly seed: unknown;
  readonly steps: (handle: HandleFactory) => ReadonlyArray<() => Promise<void>>;
  readonly expected: unknown;
  readonly useExportVal?: boolean;
}

const LEAF_NESTED_PRIORITY_CASES: readonly FoldingCase[] = [
  {
    name: 'set scalar then nested .priority update leaves scalar unchanged',
    seed: { keep: true },
    steps: (od) => [() => od('').set('scalar'), () => od('').update({ 'a/.priority': 5 })],
    expected: 'scalar',
    useExportVal: true,
  },
  {
    name: 'setWithPriority scalar then nested .priority update preserves scalar and priority',
    seed: { keep: true },
    steps: (od) => [
      () => od('').setWithPriority('scalar', 9),
      () => od('').update({ 'a/.priority': 5 }),
    ],
    expected: { '.priority': 9, '.value': 'scalar' },
    useExportVal: true,
  },
  {
    name: 'update scalar child then nested .priority update leaves scalar unchanged',
    seed: { keep: true },
    steps: (od) => [
      () => od('').update({ a: 'scalar' }),
      () => od('').update({ 'a/b/.priority': 5 }),
    ],
    expected: { a: 'scalar', keep: true },
    useExportVal: true,
  },
  {
    name: 'update prioritized scalar child then nested .priority update preserves value and priority',
    seed: { keep: true },
    steps: (od) => [
      () => od('').update({ a: { '.value': 'scalar', '.priority': 9 } }),
      () => od('').update({ 'a/b/.priority': 5 }),
    ],
    expected: { a: { '.priority': 9, '.value': 'scalar' }, keep: true },
    useExportVal: true,
  },
];

const ATOMIC_PRIORITY_CASES: readonly FoldingCase[] = [
  {
    name: 'set with inline priority preserves priority when atomic update deletes before adding',
    seed: { keep: true },
    steps: (od) => [
      () => od('').set({ a: 1, '.priority': 9 }),
      () => od('').update({ a: null, b: 2 }),
    ],
    expected: { '.priority': 9, b: 2 },
    useExportVal: true,
  },
  {
    name: 'set with inline priority preserves priority when atomic update adds before deleting',
    seed: { keep: true },
    steps: (od) => [
      () => od('').set({ a: 1, '.priority': 9 }),
      () => od('').update({ b: 2, a: null }),
    ],
    expected: { '.priority': 9, b: 2 },
    useExportVal: true,
  },
  {
    name: 'set nested object with inline priority preserves priority across delete-before-add update',
    seed: { keep: true },
    steps: (od) => [
      () => od('').set({ sub: { a: 1, '.priority': 9 } }),
      () => od('').update({ 'sub/a': null, 'sub/b': 2 }),
    ],
    expected: { sub: { '.priority': 9, b: 2 } },
    useExportVal: true,
  },
  {
    name: 'update nested object with inline priority preserves priority across delete-before-add update',
    seed: { keep: true },
    steps: (od) => [
      () => od('').update({ sub: { a: 1, '.priority': 9 } }),
      () => od('').update({ 'sub/a': null, 'sub/b': 2 }),
    ],
    expected: { keep: true, sub: { '.priority': 9, b: 2 } },
    useExportVal: true,
  },
  {
    name: 'child setWithPriority preserves priority when parent update deletes and adds atomically',
    seed: { keep: true },
    steps: (od) => [
      () => od('a').setWithPriority({ x: 1 }, 9),
      () => od('').update({ 'a/x': null, 'a/y': 2 }),
    ],
    expected: { a: { '.priority': 9, y: 2 }, keep: true },
    useExportVal: true,
  },
  {
    name: 'child setWithPriority applies new priority when parent update updates priority, deletes, and adds',
    seed: { keep: true },
    steps: (od) => [
      () => od('a').setWithPriority({ x: 1 }, 9),
      () => od('').update({ 'a/.priority': 5, 'a/x': null, 'a/y': 2 }),
    ],
    expected: { a: { '.priority': 5, y: 2 }, keep: true },
    useExportVal: true,
  },
];

const FOLDING_AND_CANCEL_CASES: readonly FoldingCase[] = [
  {
    name: 'parent set leaf promoted by child set then nulled by parent update does not resurrect leaf',
    seed: { keep: true },
    steps: (od) => [
      () => od('').set({ a: 1 }),
      () => od('a/b').set(2),
      () => od('').update({ 'a/b': null }),
    ],
    expected: null,
  },
  {
    name: 'parent update leaf promoted by child set then nulled by parent update does not resurrect leaf',
    seed: { keep: true },
    steps: (od) => [
      () => od('').update({ a: 1 }),
      () => od('a/b').set(2),
      () => od('').update({ 'a/b': null }),
    ],
    expected: { keep: true },
  },
  {
    name: 'parent set leaf replaced by child set then parent deep update then child cancel preserves siblings',
    seed: { keep: true, a: { old: 1 } },
    steps: (od) => [
      () => od('').set({ a: 1 }),
      () => od('a').set({ b: 2 }),
      () => od('').update({ 'a/c': 3 }),
      () => od('a/c').cancel(),
    ],
    expected: { a: { b: 2, old: 1 }, keep: true },
  },
  {
    name: 'parent set leaf replaced by child set then child key cancel unfolds parent and keeps siblings',
    seed: { keep: true, a: { old: 1 } },
    steps: (od) => [
      () => od('').set({ a: 1 }),
      () => od('a').set({ b: 2, c: 3 }),
      () => od('a/c').cancel(),
    ],
    expected: { a: { b: 2, old: 1 }, keep: true },
  },
  {
    name: 'parent set object replaced by child set then child key cancel does not resurrect overwritten key',
    seed: { keep: true, a: { x: 0, keepA: true } },
    steps: (od) => [
      () => od('').set({ a: { x: 1 } }),
      () => od('a').set({ y: 2, z: 3 }),
      () => od('a/z').cancel(),
    ],
    expected: { a: { keepA: true, x: 0, y: 2 }, keep: true },
  },
  {
    name: 'parent update object extended by child update then child key cancel preserves existing branch siblings',
    seed: { keep: true, a: { x: 0, y: 0, keepA: true } },
    steps: (od) => [
      () => od('').update({ a: { x: 1 } }),
      () => od('a').update({ y: 2 }),
      () => od('a/y').cancel(),
    ],
    expected: { a: { keepA: true, x: 1, y: 0 }, keep: true },
  },
  {
    name: 'parent set followed by child remove of sole key deletes entire node',
    seed: { keep: true, a: 0 },
    steps: (od) => [() => od('').set({ a: 1 }), () => od('a').remove()],
    expected: null,
  },
  {
    name: 'parent remove followed by child set replaces node with child only',
    seed: { keep: true, a: 0 },
    steps: (od) => [() => od('').remove(), () => od('a').set(2)],
    expected: { a: 2 },
  },
  {
    name: 'parent remove followed by child update replaces node with updated child only',
    seed: { keep: true, a: { old: 1 } },
    steps: (od) => [() => od('').remove(), () => od('a').update({ x: 1 })],
    expected: { a: { x: 1 } },
  },
  {
    name: 'parent set followed by child setWithPriority preserves child inline priority',
    seed: { keep: true },
    steps: (od) => [() => od('').set({ a: 1 }), () => od('b').setWithPriority(2, 5)],
    expected: { a: 1, b: { '.priority': 5, '.value': 2 } },
    useExportVal: true,
  },
  {
    name: 'parent deep update overwritten by child set then cancelled does not resurrect deep key',
    seed: { keep: true, a: { x: 0, y: 0, keepA: true } },
    steps: (od) => [
      () => od('').update({ 'a/x': 1 }),
      () => od('a').set({ y: 2, z: 3 }),
      () => od('a/z').cancel(),
    ],
    expected: { a: { keepA: true, x: 0, y: 2 }, keep: true },
  },
  {
    name: 'parent deep grandchild update overwritten by child update then cancelled does not resurrect grandchild',
    seed: { keep: true, a: { b: { c: 0, d: 0, keepB: true } } },
    steps: (od) => [
      () => od('').update({ 'a/b/c': 1 }),
      () => od('a').update({ b: { d: 2 } }),
      () => od('a/b/d').cancel(),
    ],
    expected: { a: { b: { c: 0, d: 0, keepB: true } }, keep: true },
  },
  {
    name: 'parent set followed by child setWithPriority then child key cancel preserves child priority',
    seed: { keep: true, a: { x: 0, keepA: true } },
    steps: (od) => [
      () => od('').set({ a: 1 }),
      () => od('a').setWithPriority({ x: 1, y: 2 }, 5),
      () => od('a/x').cancel(),
    ],
    expected: { a: { '.priority': 5, keepA: true, x: 0, y: 2 }, keep: true },
    useExportVal: true,
  },
  {
    name: 'parent set scalar child then child update null leaves scalar unchanged',
    seed: { keep: true },
    steps: (od) => [() => od('').set({ a: 'scalar' }), () => od('a').update({ x: null })],
    expected: { a: 'scalar' },
  },
];

const ALL_FOLDING_CASES: readonly FoldingCase[] = [
  ...LEAF_NESTED_PRIORITY_CASES,
  ...ATOMIC_PRIORITY_CASES,
  ...FOLDING_AND_CANCEL_CASES,
];

describe('onDisconnect tree folding, leaf priority, and atomic multi-key parity', () => {
  for (const spec of ALL_FOLDING_CASES) {
    test(spec.name, async () => {
      const box = initializeSandbox();
      const db = getDatabase(box.withAuth({ uid: 'u1' }));
      rtdbSandbox.setRules(db, { rules: { '.read': true, '.write': true } });
      const base = 'cases/target';
      await set(ref(db, base), spec.seed);
      const handle: HandleFactory = (child) => {
        let path = base;
        if (child !== '') {
          path = `${base}/${child}`;
        }
        return onDisconnect(ref(db, path));
      };
      for (const step of spec.steps(handle)) {
        await step();
      }
      goOffline(db);
      const snapshot = await get(ref(db, base));
      let actual: unknown;
      if (spec.useExportVal) {
        actual = snapshot.exportVal();
      } else {
        actual = snapshot.val();
      }
      expect(actual).toEqual(spec.expected);
    });
  }

  test('parent deep update overwritten by child atomic update preserves pre-existing db node priority', async () => {
    const box = initializeSandbox();
    const db = getDatabase(box.withAuth({ uid: 'u1' }));
    rtdbSandbox.setRules(db, { rules: { '.read': true, '.write': true } });
    await set(ref(db, 'cases/target'), { keep: true });
    await setWithPriority(ref(db, 'cases/target/a'), { x: 0 }, 9);
    await onDisconnect(ref(db, 'cases/target')).update({ 'a/x': 1 });
    await onDisconnect(ref(db, 'cases/target/a')).update({ x: null, y: 2 });
    goOffline(db);
    expect((await get(ref(db, 'cases/target'))).exportVal()).toEqual({
      a: { '.priority': 9, y: 2 },
      keep: true,
    });
  });

  test('parent set followed by child set folds into the parent set under tightened parent write rules', async () => {
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
    await set(ref(admin, 'items/doc'), { a: 0, b: 0, keep: true });
    await onDisconnect(ref(db, 'items/doc')).set({ a: 1, b: 2 });
    await onDisconnect(ref(db, 'items/doc/a')).set(10);
    await set(ref(admin, 'flags/locked'), true);
    goOffline(db);
    expect((await get(ref(admin, 'items/doc'))).val()).toEqual({ a: 0, b: 0, keep: true });
  });

  test('DisconnectOperationQueue keeps parent and child writes folded into one non-overlapping entry', () => {
    const queue = new DisconnectOperationQueue<{ actor: string }>();
    queue.set({ kind: 'set', path: '/items/doc', value: { a: 1 }, actor: 'u1' });
    queue.set({ kind: 'set', path: '/items/doc/a', value: { b: 2 }, actor: 'u1' });
    queue.set({ kind: 'update', path: '/items/doc', values: { 'a/c': 3 }, actor: 'u1' });
    expect(queue.takeAll()).toEqual([
      { kind: 'set', path: '/items/doc', value: { a: { b: 2, c: 3 } }, actor: 'u1' },
    ]);
  });
});
