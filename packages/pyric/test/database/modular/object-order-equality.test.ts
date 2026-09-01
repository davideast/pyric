/**
 * RTDB modular SDK — object-order equality (T4-7 / DB-B11).
 *
 * RTDB treats two object-valued children as ORDER-EQUAL; the tie is
 * broken by key (nameCompare), NOT by an invented `JSON.stringify`
 * ordering. Confirmed against upstream `core/snap/ChildrenNode.ts:386-400`
 * (ChildrenNodes compare equal; PriorityIndex breaks the tie by name).
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getDatabase,
  ref,
  set,
  get,
  query,
  orderByValue,
} from '../../../src/database/index.js';
import { setup } from './oracle-conformance.support.js';

describe('DB-B11 — object-valued children are order-equal (key tie-break)', () => {
  it('orderByValue on object-valued children sorts by key, not JSON string', async () => {
    const { db } = setup();
    // Object values whose JSON-string order would DISAGREE with key
    // order: child "a" has a value whose JSON sorts AFTER child "b"'s.
    await set(ref(db, 'col'), {
      a: { z: 1 }, // JSON: {"z":1}
      b: { a: 1 }, // JSON: {"a":1}  (sorts before {"z":1})
    });
    const snap = await get(query(ref(db, 'col'), orderByValue()));
    const keys: Array<string | null> = [];
    snap.forEach((c) => {
      keys.push(c.key);
    });
    // Objects are order-equal → tie broken by key → ['a','b'].
    // Pre-fix (JSON.stringify compare): 'b' ({"a":1}) sorted before 'a'.
    expect(keys).toEqual(['a', 'b']);
  });
});
