/**
 * A rules-bypassing admin handle meets the same index requirement a client
 * does (capture rtdb-modular-admin-query-index): `get()` of an unindexed
 * `orderByChild` query rejects, limited or not, and a listener on it delivers
 * the filtered window and logs the unspecified-index warning.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  get,
  getAdminDatabase,
  getDatabase,
  limitToFirst,
  onValue,
  orderByChild,
  query,
  ref,
  sandbox,
  set,
} from '../../../src/database/index.js';
import { load } from './oracle-conformance.support.js';

const behavior = load('rtdb-modular-admin-query-index.json') as {
  getLimited: { resolved: boolean; code: null; message: string };
  getUnlimited: { resolved: boolean; code: null; message: string };
  onceLimited: { resolved: boolean; keys: string[] };
  logs: string[];
};

const originalWarn = console.warn;
afterEach(() => { console.warn = originalWarn; });

async function setup() {
  const box = initializeSandbox();
  // The rules declare no `.indexOn` for the queried location.
  sandbox.setRules(getDatabase(box.withAuth({ uid: 'u' })), { rules: { '.read': false, '.write': false } });
  const admin = getAdminDatabase(box);
  await set(ref(admin, 'items'), { a: { pos: 3 }, b: { pos: 1 }, c: { pos: 2 } });
  return admin;
}

const shape = (error: unknown) => ({
  resolved: false,
  code: (error as { code?: unknown }).code ?? null,
  message: (error as Error).message.replace('"/items"', '"/<base>"'),
});

describe('admin queries without a matching .indexOn', () => {
  test('get() rejects, limited or not', async () => {
    const admin = await setup();
    const items = ref(admin, 'items');
    expect(await get(query(items, orderByChild('pos'), limitToFirst(2))).then(() => null, shape)).toEqual(behavior.getLimited);
    expect(await get(query(items, orderByChild('pos'))).then(() => null, shape)).toEqual(behavior.getUnlimited);
  });

  test('a listener delivers the filtered window and logs the warning', async () => {
    const admin = await setup();
    const logs: string[] = [];
    console.warn = (...args: unknown[]) => {
      logs.push(`warn: ${args.map(String).join(' ').replace(/^\[[^\]]*\]\s*/, '').replace('at /items', 'at /<base>')}`);
    };
    const keys: Array<string | null> = [];
    const off = onValue(query(ref(admin, 'items'), orderByChild('pos'), limitToFirst(2)), (snap) => {
      snap.forEach((child) => { keys.push(child.key); });
    });
    off();
    expect(keys).toEqual(behavior.onceLimited.keys);
    expect(logs).toEqual(behavior.logs);
  });
});
