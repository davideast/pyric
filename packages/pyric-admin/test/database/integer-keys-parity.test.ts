import { afterEach, describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import * as modular from 'pyric/database';
import { deleteApp, getApps } from '../../src/app/index.js';
import { getDatabase, type Database } from '../../src/database/index.js';
import { inProcessApp, sharedWorkerApp } from './arms.js';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

/** The snapshot surface both `pyric-admin` and `pyric/database` share. */
interface SnapshotLike {
  key: string | null;
  val(): unknown;
  exportVal(): unknown;
  toJSON(): unknown;
  child(path: string): SnapshotLike;
  forEach(action: (child: SnapshotLike) => boolean | void): boolean;
}

/** Everything a reader of one node can see. */
interface Observation {
  val: unknown;
  exportVal: unknown;
  toJSON: unknown;
  numChildren: number;
  children: Array<[string | null, unknown]>;
  childAt: Record<string, unknown>;
}

/** The write and read calls a scenario makes, on any plane. */
interface Plane {
  set(path: string, value: unknown): Promise<void>;
  update(path: string, values: object): Promise<void>;
  push(path: string, value: unknown): Promise<string>;
  read(path: string): Promise<Observation>;
}

function observe(snap: SnapshotLike, count: number, probes: readonly string[]): Observation {
  const children: Array<[string | null, unknown]> = [];
  snap.forEach((child) => {
    children.push([child.key, child.val()]);
  });
  const childAt = Object.fromEntries(probes.map((probe) => [probe, snap.child(probe).val()]));
  return { val: snap.val(), exportVal: snap.exportVal(), toJSON: snap.toJSON(), numChildren: count, children, childAt };
}

/** Child paths every read probes, present or not. */
const PROBES = ['0', '1', '2', '5', 'list/1', 'list/1/0'];

function adminPlane(db: Database): Plane {
  return {
    set: (path, value) => db.ref(path).set(value),
    update: (path, values) => db.ref(path).update(values),
    push: async (path, value) => (await db.ref(path).push(value)).key!,
    read: async (path) => {
      const snap = await db.ref(path).get();
      return observe(snap as SnapshotLike, snap.numChildren(), PROBES);
    },
  };
}

/** The in-page client sandbox, through the modular SDK surface. */
function clientPlane(): Plane {
  const db = modular.getAdminDatabase(initializeSandbox());
  return {
    set: (path, value) => modular.set(modular.ref(db, path), value),
    update: (path, values) => modular.update(modular.ref(db, path), values),
    push: async (path, value) => (await modular.push(modular.ref(db, path), value)).key!,
    read: async (path) => {
      const snap = await modular.get(modular.ref(db, path));
      return observe(snap as unknown as SnapshotLike, snap.size, PROBES);
    },
  };
}

const PLANES: Array<[string, () => Plane]> = [
  ['in-process pyric-admin', () => adminPlane(getDatabase(inProcessApp()))],
  ['remote pyric-admin', () => adminPlane(getDatabase(sharedWorkerApp()))],
  ['in-page client sandbox', clientPlane],
];

interface Scenario {
  name: string;
  run(plane: Plane): Promise<void>;
  /** What `val()` renders at `node`, as `ChildrenNode.val` renders it. */
  val: unknown;
  /** What `exportVal()` and `toJSON()` render, when it differs from `val`. */
  exported?: unknown;
}

const NODE = 'node';

/** An array of `length` with only `entries` set: the rest are holes. */
function sparse(length: number, entries: Record<number, unknown>): unknown[] {
  return Object.assign(new Array<unknown>(length), entries);
}

// `@firebase/database` stores children by key. `ChildrenNode.val` renders a
// node as an array when every key is an integer and the largest is below
// twice the key count, leaving missing indexes as holes; otherwise it
// renders an object. The export format (`exportVal()`, `toJSON()`) never
// builds an array. Writes drop null children and empty objects. Inline
// `.priority` keys are left out here: `pyric-admin` does not model
// priorities and drops them.
const SCENARIOS: Scenario[] = [
  {
    name: 'an object with dense integer keys',
    run: (plane) => plane.set(NODE, { 0: 'a', 1: 'b', 2: 'c' }),
    val: ['a', 'b', 'c'],
    exported: { 0: 'a', 1: 'b', 2: 'c' },
  },
  {
    name: 'an object with sparse integer keys under the array threshold',
    run: (plane) => plane.set(NODE, { 0: 'a', 2: 'c', 3: 'd' }),
    val: sparse(4, { 0: 'a', 2: 'c', 3: 'd' }),
    exported: { 0: 'a', 2: 'c', 3: 'd' },
  },
  {
    name: 'an object with sparse integer keys over the array threshold',
    run: (plane) => plane.set(NODE, { 0: 'a', 5: 'f' }),
    val: { 0: 'a', 5: 'f' },
  },
  {
    name: 'an array written directly',
    run: (plane) => plane.set(NODE, ['a', 'b']),
    val: ['a', 'b'],
    exported: { 0: 'a', 1: 'b' },
  },
  {
    name: 'an array with a null element',
    run: (plane) => plane.set(NODE, ['a', null, 'c']),
    val: sparse(3, { 0: 'a', 2: 'c' }),
    exported: { 0: 'a', 2: 'c' },
  },
  {
    name: 'an array whose nulls leave it over the threshold',
    run: (plane) => plane.set(NODE, ['a', null, null, null, null, 'f']),
    val: { 0: 'a', 5: 'f' },
  },
  {
    name: 'nested arrays and integer-keyed objects',
    run: (plane) => plane.set(NODE, { list: { 0: 'x', 1: { 0: 1, 1: 2 } }, flags: { a: [true] } }),
    val: { list: ['x', [1, 2]], flags: { a: [true] } },
    exported: { list: { 0: 'x', 1: { 0: 1, 1: 2 } }, flags: { a: { 0: true } } },
  },
  {
    name: 'null children',
    run: (plane) => plane.set(NODE, { a: 1, b: null, c: { d: null }, 1: null }),
    val: { a: 1 },
  },
  {
    name: 'empty objects',
    run: (plane) => plane.set(NODE, { a: {}, b: { c: {} }, 0: 'zero' }),
    val: ['zero'],
    exported: { 0: 'zero' },
  },
  {
    name: 'an empty object written over a value',
    run: async (plane) => {
      await plane.set(NODE, ['a']);
      await plane.set(NODE, {});
    },
    val: null,
  },
  {
    name: 'update() adding an index to an array node',
    run: async (plane) => {
      await plane.set(NODE, ['a', 'b']);
      await plane.update(NODE, { 2: 'c' });
    },
    val: ['a', 'b', 'c'],
    exported: { 0: 'a', 1: 'b', 2: 'c' },
  },
  {
    name: 'update() removing an index from an array node',
    run: async (plane) => {
      await plane.set(NODE, ['a', 'b', 'c']);
      await plane.update(NODE, { 0: null });
    },
    val: sparse(3, { 1: 'b', 2: 'c' }),
    exported: { 1: 'b', 2: 'c' },
  },
  {
    name: 'update() pushing an array node over the threshold',
    run: async (plane) => {
      await plane.set(NODE, ['a', 'b']);
      await plane.update(NODE, { 9: 'j' });
    },
    val: { 0: 'a', 1: 'b', 9: 'j' },
  },
  {
    name: 'update() writing an integer-keyed object as a child',
    run: (plane) => plane.update(NODE, { list: { 0: 'x', 1: 'y' }, empty: {} }),
    val: { list: ['x', 'y'] },
    exported: { list: { 0: 'x', 1: 'y' } },
  },
];

describe('integer-keyed RTDB values read back the same on every plane (#1121)', () => {
  for (const scenario of SCENARIOS) {
    test(scenario.name, async () => {
      const observations: Array<[string, Observation]> = [];
      for (const [name, makePlane] of PLANES) {
        const plane = makePlane();
        await scenario.run(plane);
        observations.push([name, await plane.read(NODE)]);
      }
      const [, reference] = observations[0]!;
      // Strict, so a hole and a null are not equal.
      expect(reference.val).toStrictEqual(scenario.val);
      expect(reference.exportVal).toStrictEqual(scenario.exported ?? scenario.val);
      expect(reference.toJSON).toStrictEqual(scenario.exported ?? scenario.val);
      for (const [name, observation] of observations) {
        expect({ name, ...observation }).toStrictEqual({ name, ...reference });
      }
    });
  }

  test('a pushed integer-keyed object reads back as an array under its key', async () => {
    for (const [name, makePlane] of PLANES) {
      const plane = makePlane();
      const key = await plane.push('log', { 0: 'a', 1: 'b' });
      const log = await plane.read('log');
      expect({ name, val: log.val, exportVal: log.exportVal, children: log.children }).toStrictEqual({
        name,
        val: { [key]: ['a', 'b'] },
        exportVal: { [key]: { 0: 'a', 1: 'b' } },
        children: [[key, ['a', 'b']]],
      });
    }
  });

  test('push() into an array node turns it into an object', async () => {
    for (const [name, makePlane] of PLANES) {
      const plane = makePlane();
      await plane.set(NODE, ['a']);
      const key = await plane.push(NODE, 'b');
      const node = await plane.read(NODE);
      expect({ name, val: node.val, keys: node.children.map(([childKey]) => childKey) }).toEqual({
        name,
        val: { 0: 'a', [key]: 'b' },
        keys: ['0', key],
      });
    }
  });

  test('transaction() is refused the same way on both pyric-admin arms', async () => {
    const refusals = [inProcessApp(), sharedWorkerApp()].map((app) => {
      try {
        getDatabase(app).ref(NODE).transaction(() => ({ 0: 'a' }));
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(refusals).toEqual([
      'pyric-admin/database sandbox: transaction not implemented',
      'pyric-admin/database sandbox: transaction not implemented',
    ]);
  });

  test('a client transaction on an integer-keyed node sees and stores an array', async () => {
    const db = modular.getAdminDatabase(initializeSandbox());
    await modular.set(modular.ref(db, NODE), { 0: 'a', 1: 'b' });
    const seen: unknown[] = [];
    const result = await modular.runTransaction(modular.ref(db, NODE), (current: unknown) => {
      seen.push(current);
      return Array.isArray(current) ? { ...current, 2: 'c' } : current;
    });
    expect(seen.at(-1)).toEqual(['a', 'b']);
    expect(result.snapshot.val()).toEqual(['a', 'b', 'c']);
    expect((await modular.get(modular.ref(db, NODE))).val()).toEqual(['a', 'b', 'c']);
  });
});
