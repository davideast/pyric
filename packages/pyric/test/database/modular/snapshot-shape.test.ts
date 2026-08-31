/**
 * RTDB modular SDK — DataSnapshot surface shape (T4-7 / DB-B10).
 *
 * The modular SDK's DataSnapshot exposes `size` (getter), `priority`,
 * and `exportVal()`; it does NOT expose the legacy namespaced
 * `numChildren()` method. This is a DISPUTED-semantics fix: the prior
 * sandbox shipped `numChildren()` and lacked `size`, contradicting its
 * own oracle. Aligned to prod truth per
 * `packages/conformance/observations/rtdb-modular/rtdb-modular-get-snapshot-shape.json`
 * (`hasSize: true, hasNumChildren: false, hasForEach: true`) + upstream
 * `api/Reference_impl.ts:288-447`.
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getDatabase,
  ref,
  set,
  get,
} from '../../../src/database/index.js';
import { setup } from './oracle-conformance.support.js';

describe('DB-B10 — DataSnapshot shape matches the modular oracle', () => {
  it('exposes size (getter), priority, exportVal; NOT numChildren()', async () => {
    const { db } = setup();
    await set(ref(db, 'parent'), { a: 1, b: 2, c: 3 });
    const snap = await get(ref(db, 'parent'));
    // size getter (oracle hasSize: true, size: 3).
    expect(snap.size).toBe(3);
    // legacy numChildren() is gone (oracle hasNumChildren: false).
    expect('numChildren' in snap).toBe(false);
    // priority present (null because this node has no priority metadata).
    expect(snap.priority).toBeNull();
    // exportVal present, equals val() when no priority is set.
    expect(typeof snap.exportVal).toBe('function');
    expect(snap.exportVal()).toEqual({ a: 1, b: 2, c: 3 });
    // forEach still present and ordered.
    const keys: Array<string | null> = [];
    snap.forEach((c) => {
      keys.push(c.key);
    });
    expect(keys).toEqual(['a', 'b', 'c']);
  });
});
