import { afterEach, describe, expect, test } from 'bun:test';
import { deleteApp, getApps, type PyricAdminApp } from '../../src/app/index.js';
import { getDatabase, type Reference } from '../../src/database/index.js';
import { inProcessApp, sharedWorkerApp } from './arms.js';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

const ARMS: Array<[string, () => PyricAdminApp]> = [
  ['in-process', inProcessApp],
  ['remote', sharedWorkerApp],
];

const fn = () => 1;
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
        if (typeof refused.message === 'string') expect(error!.message).toBe(refused.message);
        else expect(error!.message).toMatch(refused.message);
        expect((await db.ref('/').get()).val()).toStrictEqual({ node: 'before' });
      });
    }
  }

  test('an array hole is not refused', async () => {
    for (const [arm, makeApp] of ARMS) {
      const db = getDatabase(makeApp());
      // eslint-disable-next-line no-sparse-arrays
      await db.ref('node').set(['a', , 'c']);
      const val = (await db.ref('node').get()).val();
      expect({ arm, val }).toStrictEqual({ arm, val: Object.assign(new Array<string>(3), { 0: 'a', 2: 'c' }) });
    }
  });
});
