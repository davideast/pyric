/**
 * RTDB modular SDK — write-boundary normalization probes (T4-1).
 *
 * Locks DB-B1 (validation), DB-B2 (array ↔ integer-keyed-object
 * coercion), DB-B3 (null/empty pruning) — the three collapsed by the
 * `nodeFromJSON`-equivalent at the write boundary
 * (`src/database/sandbox/normalize.ts`).
 *
 * Each test reproduces the MASKED scenario the prior oracle suite hid:
 * an array write, an invalid key, an `undefined` payload, an empty-object
 * write. Confirmed against the upstream clone:
 *   - `core/util/validation.ts:45,58,96-199` (key + undefined + NaN)
 *   - `core/snap/nodeFromJSON.ts:40-132` (null/empty pruning)
 *   - `core/snap/ChildrenNode.ts:194-230` (val array coercion)
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getDatabase,
  ref,
  child,
  get,
  set,
} from '../../../src/database/index.js';

function setup() {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  return { sandbox, db };
}

describe('DB-B2 — array ↔ integer-keyed-object coercion', () => {
  it('an array write is addressable by integer-string child key', async () => {
    const { db } = setup();
    await set(ref(db, 'list'), ['a', 'b', 'c']);
    // Pre-fix: arrays stored verbatim → child(ref,'1') walked into an
    // array via the object branch and returned null.
    const snap = await get(child(ref(db, 'list'), '1'));
    expect(snap.val()).toBe('b');
    expect(snap.exists()).toBe(true);
  });

  it('forEach over an array iterates its elements as children', async () => {
    const { db } = setup();
    await set(ref(db, 'list'), ['x', 'y', 'z']);
    // The stored shape is integer-keyed; forEach over the parent walks
    // children 0,1,2.
    const snap = await get(ref(db, 'list'));
    const seen: Array<{ key: string | null; val: unknown }> = [];
    snap.forEach((c) => {
      seen.push({ key: c.key, val: c.val() });
    });
    expect(seen).toEqual([
      { key: '0', val: 'x' },
      { key: '1', val: 'y' },
      { key: '2', val: 'z' },
    ]);
  });

  it('a dense integer-keyed object reads back as an array', async () => {
    const { db } = setup();
    await set(ref(db, 'list'), ['a', 'b']);
    const snap = await get(ref(db, 'list'));
    expect(Array.isArray(snap.val())).toBe(true);
    expect(snap.val()).toEqual(['a', 'b']);
  });
});

describe('DB-B3 — null / empty pruning', () => {
  it('set(ref, {}) is equivalent to remove (empty node does not exist)', async () => {
    const { db } = setup();
    await set(ref(db, 'a/b'), { keep: 1 });
    await set(ref(db, 'a/b'), {});
    const snap = await get(ref(db, 'a/b'));
    expect(snap.exists()).toBe(false);
    expect(snap.val()).toBeNull();
  });

  it('null children are pruned, not stored as keys', async () => {
    const { db } = setup();
    await set(ref(db, 'doc'), { a: 1, b: null, c: { d: null } });
    const snap = await get(ref(db, 'doc'));
    // b dropped; c.d dropped → c empty → c dropped.
    expect(snap.val()).toEqual({ a: 1 });
  });
});

describe('DB-B1 — write validation', () => {
  it('rejects an undefined payload', async () => {
    const { db } = setup();
    await expect(set(ref(db, 'x'), undefined as unknown)).rejects.toThrow(
      /undefined/,
    );
  });

  it('rejects an invalid key (contains a forbidden char)', async () => {
    const { db } = setup();
    await expect(
      set(ref(db, 'x'), { 'bad.key': 1 } as unknown),
    ).rejects.toThrow(/invalid key/);
  });

  it('rejects a non-finite number (NaN)', async () => {
    const { db } = setup();
    await expect(set(ref(db, 'x'), { n: NaN } as unknown)).rejects.toThrow(
      /NaN/,
    );
  });
});
