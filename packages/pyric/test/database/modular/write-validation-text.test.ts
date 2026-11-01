import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  get,
  getAdminDatabase,
  onDisconnect,
  push,
  ref,
  runTransaction,
  set,
  setWithPriority,
  update,
} from '../../../src/database/index.js';

function db() {
  return getAdminDatabase(initializeSandbox());
}

const fn = () => 1;
const KEYS_RULE = 'Keys must be non-empty strings and can\'t contain ".", "#", "$", "/", "[", or "]"';

/** The error a refused write rejects or throws with. */
async function refusal(write: () => unknown): Promise<string> {
  try {
    await write();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('the write was not refused');
}

// The text `@firebase/database` 1.1.3 gives each refusal
// (`validateFirebaseData`, `validateFirebaseDataArg`): the call and argument
// it names, and the written path's segments joined with `.`.
describe('the in-page sandbox refuses a write with the SDK text', () => {
  const cases: Array<[string, (database: ReturnType<typeof db>) => unknown, string]> = [
    ['set() of a NaN child', (d) => set(ref(d, 'node'), { a: NaN }), "set failed: value argument contains NaN in property 'node.a'"],
    ['set() of a function', (d) => set(ref(d, 'node'), fn), "set failed: value argument contains a function in property 'node' with contents = () => 1"],
    ['set() of an undefined array element', (d) => set(ref(d, 'node'), ['a', undefined, 'c']), "set failed: value argument contains undefined in property 'node.1'"],
    ['set() of .value beside children', (d) => set(ref(d, 'node'), { '.value': 1, a: 2 }), `set failed: value argument  contains ".value" child in property 'node' in addition to actual children.`],
    ['set() of an invalid key', (d) => set(ref(d, 'node'), { 'a.b': 1 }), `set failed: value argument  contains an invalid key (a.b) in property 'node'.  ${KEYS_RULE}`],
    ['push() of NaN names the parent', (d) => push(ref(d, 'x'), NaN), "push failed: value argument contains NaN in property 'x'"],
    ['setWithPriority() of NaN', (d) => setWithPriority(ref(d, 'node'), NaN, 1), "setWithPriority failed: value argument contains NaN in property 'node'"],
    ['update() of a NaN value', (d) => update(ref(d, 'node'), { a: NaN }), "update failed: values argument contains NaN in property 'node.a'"],
    ['a transaction returning NaN', (d) => runTransaction(ref(d, 'node'), () => NaN), "transaction failed: Data returned contains NaN in property 'node'"],
    ['onDisconnect().set() of NaN', (d) => onDisconnect(ref(d, 'node')).set(NaN), "OnDisconnect.set failed: value argument contains NaN in property 'node'"],
    ['onDisconnect().setWithPriority() of NaN', (d) => onDisconnect(ref(d, 'node')).setWithPriority(NaN, 1), "OnDisconnect.setWithPriority failed: value argument contains NaN in property 'node'"],
  ];
  for (const [name, write, message] of cases) {
    test(name, async () => {
      const database = db();
      expect(await refusal(() => write(database))).toBe(message);
      expect((await get(ref(database, 'node'))).val()).toBeNull();
    });
  }

  test('an array hole is not refused', async () => {
    const database = db();
    // eslint-disable-next-line no-sparse-arrays
    await set(ref(database, 'node'), ['a', , 'c']);
    expect((await get(ref(database, 'node'))).val()).toStrictEqual(Object.assign(new Array<string>(3), { 0: 'a', 2: 'c' }));
  });
});

// `ChildrenNode.val` builds an array only when not exporting: `exportVal()`
// and `toJSON()` call `val(true)`.
describe('the in-page sandbox renders integer keys as the SDK does', () => {
  test('val() renders an array; exportVal() and toJSON() keep the keys', async () => {
    const database = db();
    await set(ref(database, 'node'), { 0: 'a', 1: 'b', 3: 'd' });
    const snap = await get(ref(database, 'node'));
    expect(snap.val()).toStrictEqual(Object.assign(new Array<string>(4), { 0: 'a', 1: 'b', 3: 'd' }));
    expect(snap.exportVal()).toStrictEqual({ 0: 'a', 1: 'b', 3: 'd' });
    expect(snap.toJSON()).toStrictEqual({ 0: 'a', 1: 'b', 3: 'd' });
  });

  test('a priority stays in the keyed export', async () => {
    const database = db();
    await setWithPriority(ref(database, 'node'), ['a', 'b'], 7);
    const snap = await get(ref(database, 'node'));
    expect(snap.val()).toStrictEqual(['a', 'b']);
    expect(snap.exportVal()).toStrictEqual({ 0: 'a', 1: 'b', '.priority': 7 });
  });
});
