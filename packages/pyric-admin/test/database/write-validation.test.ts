import { afterEach, describe, expect, test } from 'bun:test';
import {
  deleteApp as deleteProdApp,
  getApps as getProdApps,
  initializeApp as initializeProdApp,
} from 'firebase-admin/app';
import {
  getDatabase as getProdDatabase,
  type Reference as ProdReference,
} from 'firebase-admin/database';
import { deleteApp, getApps, type PyricAdminApp } from '../../src/app/index.js';
import { getDatabase, type Database, type Reference } from '../../src/database/index.js';
import * as modular from 'pyric/database';
import { inProcessApp, sharedWorkerApp, sharedWorkerArm } from './arms.js';

let prodSeq = 0;

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
  await Promise.all(getProdApps().map((app) => deleteProdApp(app)));
});

const ARMS: Array<[string, () => PyricAdminApp]> = [
  ['in-process', inProcessApp],
  ['remote', sharedWorkerApp],
];

const fn = () => 1;
const PRIORITY_RULE = 'Firebase priority (a string, finite number, server value, or null).';
const KEYS_RULE = 'Keys must be non-empty strings and can\'t contain ".", "#", "$", "/", "[", or "]"';

interface RefusedWrite {
  name: string;
  write(node: Reference): unknown;
  /** The error firebase-admin 13.10.0 throws, synchronously, for the same
   *  call on `ref('node')`, read from the SDK run offline. */
  message: string | RegExp;
}

const REFUSED: RefusedWrite[] = [
  { name: 'set(undefined)', write: (node) => node.set(undefined), message: "set failed: value argument contains undefined in property 'node'" },
  { name: 'set(NaN)', write: (node) => node.set(NaN), message: "set failed: value argument contains NaN in property 'node'" },
  { name: 'set(Infinity)', write: (node) => node.set(Infinity), message: "set failed: value argument contains Infinity in property 'node'" },
  { name: 'set(function)', write: (node) => node.set(fn), message: "set failed: value argument contains a function in property 'node' with contents = () => 1" },
  { name: 'a NaN child', write: (node) => node.set({ a: NaN, b: 2 }), message: "set failed: value argument contains NaN in property 'node.a'" },
  { name: 'a function child', write: (node) => node.set({ a: fn, b: 2 }), message: "set failed: value argument contains a function in property 'node.a' with contents = () => 1" },
  { name: 'an undefined child', write: (node) => node.set({ a: undefined, b: 2 }), message: "set failed: value argument contains undefined in property 'node.a'" },
  { name: 'a nested undefined child', write: (node) => node.set({ a: { c: undefined } }), message: "set failed: value argument contains undefined in property 'node.a.c'" },
  { name: 'a NaN child under a nested reference', write: (node) => node.root.child('rooms/r1').set({ a: NaN }), message: "set failed: value argument contains NaN in property 'rooms.r1.a'" },
  { name: 'undefined at the root', write: (node) => node.root.set(undefined), message: 'set failed: value argument contains undefined ' },
  { name: 'a key with a dot', write: (node) => node.set({ 'a.b': 1 }), message: `set failed: value argument  contains an invalid key (a.b) in property 'node'.  ${KEYS_RULE}` },
  { name: 'a key with a slash', write: (node) => node.set({ 'a/b': 1 }), message: `set failed: value argument  contains an invalid key (a/b) in property 'node'.  ${KEYS_RULE}` },
  { name: 'a key with a dollar sign', write: (node) => node.set({ $x: 1 }), message: `set failed: value argument  contains an invalid key ($x) in property 'node'.  ${KEYS_RULE}` },
  { name: 'an empty key', write: (node) => node.set({ '': 1 }), message: `set failed: value argument  contains an invalid key () in property 'node'.  ${KEYS_RULE}` },
  { name: 'an undefined array element', write: (node) => node.set(['a', undefined, 'c']), message: "set failed: value argument contains undefined in property 'node.1'" },
  { name: 'a NaN array element', write: (node) => node.set(['a', NaN]), message: "set failed: value argument contains NaN in property 'node.1'" },
  { name: '.value beside children', write: (node) => node.set({ '.value': 1, a: 2 }), message: `set failed: value argument  contains ".value" child in property 'node' in addition to actual children.` },
  // firebase-admin prints its version placeholder unreplaced here
  // ("Firebase Database (${JSCORE_VERSION}) ..."); pyric prints its version.
  { name: 'a boolean .priority', write: (node) => node.set({ a: 1, '.priority': true }), message: /^Firebase Database \(.+\) INTERNAL ASSERT FAILED: Invalid priority type found: boolean$/ },
  { name: 'update() of a string', write: (node) => node.update('x' as unknown as object), message: 'update failed: values argument  must be an object containing the children to replace.' },
  { name: 'update() of null', write: (node) => node.update(null as unknown as object), message: 'update failed: values argument  must be an object containing the children to replace.' },
  { name: 'update() with a NaN value', write: (node) => node.update({ a: NaN }), message: "update failed: values argument contains NaN in property 'node.a'" },
  { name: 'update() with an undefined value', write: (node) => node.update({ a: undefined }), message: "update failed: values argument contains undefined in property 'node.a'" },
  { name: 'update() with a function value', write: (node) => node.update({ a: fn }), message: "update failed: values argument contains a function in property 'node.a' with contents = () => 1" },
  { name: 'update() with a nested NaN', write: (node) => node.update({ a: { b: NaN } }), message: "update failed: values argument contains NaN in property 'node.a.b'" },
  { name: 'update() with a NaN at a slash path', write: (node) => node.update({ 'a/b': NaN }), message: "update failed: values argument contains NaN in property 'node.a.b'" },
  { name: 'update() with an invalid key', write: (node) => node.update({ 'a.b': 1 }), message: `update failed: values argument contains an invalid key (a.b) in path /a.b. ${KEYS_RULE}` },
  { name: 'update() with a nested invalid key', write: (node) => node.update({ a: { 'b.c': 1 } }), message: `update failed: values argument  contains an invalid key (b.c) in property 'node.a'.  ${KEYS_RULE}` },
  { name: 'update() with overlapping paths', write: (node) => node.update({ a: 1, 'a/b': 2 }), message: 'update failed: values argument contains a path /a that is ancestor of another path /a/b' },
  { name: 'update() of a boolean .priority', write: (node) => node.update({ '.priority': true }), message: `update failed: values argument contains an invalid value for '/.priority', which must be a valid ${PRIORITY_RULE}` },
  { name: "update() of a child's object .priority", write: (node) => node.update({ a: 1, 'b/.priority': { x: 1 } }), message: `update failed: values argument contains an invalid value for '/b/.priority', which must be a valid ${PRIORITY_RULE}` },
  { name: 'update() with .value beside children', write: (node) => node.update({ a: { '.value': 1, b: 2 } }), message: `update failed: values argument  contains ".value" child in property 'node.a' in addition to actual children.` },
  { name: 'push(NaN)', write: (node) => node.push(NaN), message: "push failed: value argument contains NaN in property 'node'" },
  { name: 'push() of an undefined child', write: (node) => node.push({ a: undefined }), message: "push failed: value argument contains undefined in property 'node.a'" },
  { name: 'push(function)', write: (node) => node.push(fn), message: "push failed: value argument contains a function in property 'node' with contents = () => 1" },
  { name: 'push() with an invalid key', write: (node) => node.push({ 'a.b': 1 }), message: `push failed: value argument  contains an invalid key (a.b) in property 'node'.  ${KEYS_RULE}` },
];

/** The error `write` throws synchronously, or null when it does not throw. */
function syncError(write: () => unknown): Error | null {
  try {
    const result = write() as { then?: unknown; catch?: (handler: () => void) => void } | undefined;
    result?.catch?.(() => {});
    return null;
  } catch (error) {
    return error as Error;
  }
}

describe('both pyric-admin arms refuse the writes firebase-admin refuses (#1121)', () => {
  for (const [arm, makeApp] of ARMS) {
    for (const refused of REFUSED) {
      test(`${arm}: ${refused.name} throws synchronously and writes nothing`, async () => {
        const db = getDatabase(makeApp());
        await db.ref('node').set('before');

        const error = syncError(() => refused.write(db.ref('node')));

        expect(error).toBeInstanceOf(Error);
        const errMessage = error ? error.message : '';
        if (typeof refused.message === 'string') {
          expect(errMessage).toBe(refused.message);
        } else {
          expect(errMessage).toMatch(refused.message);
        }
        expect((await db.ref('/').get()).val()).toStrictEqual({ node: 'before' });
      });
    }
  }

  test('a valid priority in update() or set() is preserved in exportVal() while hidden from val() and numChildren()', async () => {
    for (const [arm, makeApp] of ARMS) {
      const db = getDatabase(makeApp());
      await db.ref('node').set({ a: 1, '.priority': 3, b: { c: 2, '.priority': 'p' } });
      await db.ref('node').update({ '.priority': 1, 'b/.priority': 2, d: 4 });
      const snap = await db.ref('node').get();
      const read = { arm, val: snap.val(), exportVal: snap.exportVal(), numChildren: snap.numChildren() };
      expect(read).toStrictEqual({
        arm,
        val: { a: 1, b: { c: 2 }, d: 4 },
        exportVal: { a: 1, b: { c: 2, '.priority': 2 }, d: 4, '.priority': 1 },
        numChildren: 3,
      });
    }
  });

  // firebase-admin builds the node with `nodeFromJSON`, which reads only own
  // enumerable keys, so a Date (none) is an empty node and is dropped.
  test('a Date value is dropped on both arms', async () => {
    for (const [arm, makeApp] of ARMS) {
      const db = getDatabase(makeApp());
      await db.ref('node').set({ when: new Date(0), b: 1 });
      await db.ref('node').update({ at: new Date(0) });
      expect({ arm, val: (await db.ref('node').get()).val() }).toStrictEqual({ arm, val: { b: 1 } });
    }
  });

  test("the remote arm's exportVal() carries a priority another plane set", async () => {
    const { app, host } = sharedWorkerArm();
    const hostDb = modular.getAdminDatabase(host);
    await modular.setWithPriority(modular.ref(hostDb, 'node'), { 0: 'a', 1: 'b' }, 5);
    await modular.setWithPriority(modular.ref(hostDb, 'node/1'), 'b', 'p');

    const snap = await getDatabase(app).ref('node').get();

    expect(snap.val()).toStrictEqual(['a', 'b']);
    expect(snap.exportVal()).toStrictEqual({ 0: 'a', 1: { '.value': 'b', '.priority': 'p' }, '.priority': 5 });
    expect(snap.toJSON()).toStrictEqual(snap.exportVal());
    expect(snap.child('1').exportVal()).toStrictEqual({ '.value': 'b', '.priority': 'p' });
    const exported: unknown[] = [];
    snap.forEach((child) => {
      exported.push(child.exportVal());
    });
    expect(exported).toStrictEqual(['a', { '.value': 'b', '.priority': 'p' }]);
  });

  test('an array hole is not refused', async () => {
    for (const [arm, makeApp] of ARMS) {
      const db = getDatabase(makeApp());
      // eslint-disable-next-line no-sparse-arrays
      await db.ref('node').set(['a', , 'c']);
      const val = (await db.ref('node').get()).val();
      expect({ arm, val }).toStrictEqual({ arm, val: Object.assign(new Array<string>(3), { 0: 'a', 2: 'c' }) });
    }
  });

  test('#1224 & #1211: .info writes, invalid .sv sentinels, and undefined writes throw synchronously matching firebase-admin across both arms', async () => {
    const prodApp = initializeProdApp(
      { projectId: 'demo-refused-1224', databaseURL: 'https://demo-refused-1224-default-rtdb.firebaseio.com' },
      `prod-refused-${++prodSeq}`,
    );
    const prodDb = getProdDatabase(prodApp);
    prodDb.goOffline();

    type AnyDb = { ref: (path?: string) => Reference | ProdReference };
    const cases: ReadonlyArray<{ name: string; invoke: (db: AnyDb) => unknown }> = [
      { name: 'info.set', invoke: (db) => db.ref('.info/connected').set(true) },
      { name: 'info.rootSet', invoke: (db) => db.ref('.info').set({ x: 1 }) },
      { name: 'info.update', invoke: (db) => db.ref('.info/x').update({ a: 1 }) },
      { name: 'info.updateBadCbOrder', invoke: (db) => db.ref('.info/x').update({ a: 1 }, 'bad' as never) },
      { name: 'info.remove', invoke: (db) => db.ref('.info/x').remove() },
      { name: 'info.pushEmpty', invoke: (db) => db.ref('.info/x').push() },
      { name: 'info.pushVal', invoke: (db) => db.ref('.info/x').push(1) },
      { name: 'info.setPriority', invoke: (db) => db.ref('.info/x').setPriority(1, () => undefined) },
      { name: 'info.setPriorityBadCbOrder', invoke: (db) => db.ref('.info/x').setPriority(Number.NaN, 'bad' as never) },
      { name: 'info.setWithPriority', invoke: (db) => db.ref('.info/x').setWithPriority(1, 2) },
      { name: 'info.setWithPriorityBadCbOrder', invoke: (db) => db.ref('.info/x').setWithPriority(undefined, Number.NaN, 'bad' as never) },
      { name: 'info.transaction', invoke: (db) => db.ref('.info/x').transaction((cur) => cur) },
      { name: 'info.onDisconnect', invoke: (db) => db.ref('.info/x').onDisconnect() },
      { name: 'sv.bogusString', invoke: (db) => db.ref('node').set({ '.sv': 'bogus' }) },
      { name: 'sv.emptyString', invoke: (db) => db.ref('node').set({ '.sv': '' }) },
      { name: 'sv.number', invoke: (db) => db.ref('node').set({ '.sv': 123 }) },
      { name: 'sv.boolean', invoke: (db) => db.ref('node').set({ '.sv': true }) },
      { name: 'sv.null', invoke: (db) => db.ref('node').set({ '.sv': null }) },
      { name: 'sv.undefined', invoke: (db) => db.ref('node').set({ '.sv': undefined }) },
      { name: 'sv.emptyObj', invoke: (db) => db.ref('node').set({ '.sv': {} }) },
      { name: 'sv.array', invoke: (db) => db.ref('node').set({ '.sv': [] }) },
      { name: 'sv.unknownOpObj', invoke: (db) => db.ref('node').set({ '.sv': { foo: 1 } }) },
      { name: 'sv.incrementString', invoke: (db) => db.ref('node').set({ '.sv': { increment: 'x' } }) },
      { name: 'sv.incrementNull', invoke: (db) => db.ref('node').set({ '.sv': { increment: null } }) },
      { name: 'sv.incrementNaN', invoke: (db) => db.ref('node').set({ '.sv': { increment: Number.NaN } }) },
      { name: 'sv.nestedBogus', invoke: (db) => db.ref('node').set({ child: { '.sv': 'bogus' } }) },
      { name: 'sv.inlinePriorityBogus', invoke: (db) => db.ref('node').set({ a: 1, '.priority': { '.sv': 'bogus' } }) },
      { name: 'sv.updateValueBogus', invoke: (db) => db.ref('node').update({ a: { '.sv': 'bogus' } }) },
      { name: 'sv.updatePriorityBogus', invoke: (db) => db.ref('node').update({ '.priority': { '.sv': 'bogus' } }) },
      { name: 'sv.pushBogus', invoke: (db) => db.ref('node').push({ '.sv': 'bogus' }) },
      { name: 'sv.setPriorityBogus', invoke: (db) => db.ref('node').setPriority({ '.sv': 'bogus' } as never, () => undefined) },
      { name: 'sv.setWithPriorityBogus', invoke: (db) => db.ref('node').setWithPriority('v', { '.sv': 'bogus' } as never) },
      { name: 'sv.transactionBogus', invoke: (db) => db.ref('node').transaction(() => ({ '.sv': 'bogus' })) },
      { name: 'undef.setWithPriority', invoke: (db) => db.ref('node').setWithPriority(undefined, 1) },
      { name: 'undef.setPriority', invoke: (db) => db.ref('node').setPriority(undefined as never, () => undefined) },
    ];

    const normalizeAssertMessage = (err: Error): string => {
      if (err instanceof TypeError) {
        return 'TypeError';
      }
      return err.message.replace(/^Firebase Database \([^)]+\) /, 'Firebase Database (<ver>) ');
    };

    for (const entry of cases) {
      const prodErr = syncError(() => entry.invoke(prodDb as unknown as AnyDb));
      expect(prodErr).toBeInstanceOf(Error);
      let expectedNormalized = '';
      if (prodErr !== null) {
        expectedNormalized = normalizeAssertMessage(prodErr);
      }

      for (const [arm, makeApp] of ARMS) {
        const db: Database = getDatabase(makeApp());
        await db.ref('node').set({ intact: 1 });
        const armErr = syncError(() => entry.invoke(db as unknown as AnyDb));
        expect(armErr).toBeInstanceOf(Error);
        let actualNormalized = '';
        if (armErr !== null) {
          actualNormalized = normalizeAssertMessage(armErr);
        }
        expect({ arm, case: entry.name, err: actualNormalized }).toEqual({
          arm,
          case: entry.name,
          err: expectedNormalized,
        });
        expect((await db.ref('node').get()).val()).toEqual({ intact: 1 });
      }
    }
  });
});
