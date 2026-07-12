/**
 * RTDB modular SDK — push() thenable + sync key under denial (T4-4 / DB-B7).
 *
 * `push()` mints its key CLIENT-SIDE; the key + ref are available
 * synchronously even when the optional value write is denied by rules.
 * The return is a ThenableReference whose promise covers the write — a
 * denial REJECTS the promise rather than throwing synchronously and
 * discarding the key.
 *
 * Confirmed against oracle `packages/conformance/observations/rtdb/rtdb-push-autoid-format.json`
 * ("push.key is minted client-side ... available immediately even when
 * the subsequent server write is denied by rules") + upstream
 * `api/Reference_impl.ts:599-630` (ThenableReference shape).
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getDatabase,
  ref,
  push,
  get,
  sandbox as rtdbSandbox,
} from '../../../src/database/index.js';

function setup() {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  return { sandbox, db };
}

describe('DB-B7 — push() returns a thenable; key minted sync under denial', () => {
  it('push() returns a thenable (then/catch present)', () => {
    const { db } = setup();
    const r = push(ref(db, 'items'), { v: 1 });
    expect(typeof r.then).toBe('function');
    expect(typeof r.catch).toBe('function');
  });

  it('mints the key + ref synchronously even when rules deny the write', () => {
    const { db } = setup();
    // Deny ALL writes.
    rtdbSandbox.setRules(db, { rules: { '.read': 'true', '.write': 'false' } });
    // Pre-fix: this threw synchronously (set() denial) and the caller
    // never got the ref / key. Now the ref + key are returned sync.
    const r = push(ref(db, 'items'), { v: 1 });
    // Swallow the (expected) write rejection — this probe asserts only
    // that the key is available synchronously despite the denial.
    r.catch(() => {});
    expect(r.key).toBeDefined();
    expect(r.key!.length).toBe(20);
    expect(r.key!.startsWith('-')).toBe(true);
  });

  it('awaiting a denied push rejects (the write is on the promise)', async () => {
    const { db } = setup();
    rtdbSandbox.setRules(db, { rules: { '.read': 'true', '.write': 'false' } });
    const r = push(ref(db, 'items'), { v: 1 });
    await expect(Promise.resolve(r)).rejects.toThrow(/PERMISSION_DENIED/);
  });

  it('awaiting a push resolves to the pushed ref', async () => {
    const { db } = setup();
    const r = push(ref(db, 'items'), { v: 1 });
    const resolved = await r;
    expect(resolved.key).toBe(r.key);
    const snap = await get(r);
    expect(snap.val()).toEqual({ v: 1 });
  });
});
