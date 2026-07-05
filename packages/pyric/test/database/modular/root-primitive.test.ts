/**
 * RTDB modular SDK — root primitive write (T4-7 / DB-B13).
 *
 * `set(ref(db), 'hello')` (a primitive at the root) is legal in prod —
 * the sandbox previously threw "Root write must be an object". A
 * subsequent child write replaces the primitive root ("writes win").
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getDatabase,
  ref,
  set,
  get,
} from '../../../src/database/index.js';

function setup() {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  return { sandbox, db };
}

describe('DB-B13 — root primitive write', () => {
  it('set(ref(db), primitive) stores the primitive at the root', async () => {
    const { db } = setup();
    await set(ref(db), 'hello');
    const snap = await get(ref(db));
    expect(snap.val()).toBe('hello');
    expect(snap.exists()).toBe(true);
  });

  it('a child write replaces a primitive root (writes win)', async () => {
    const { db } = setup();
    await set(ref(db), 'hello');
    await set(ref(db, 'a'), 1);
    const snap = await get(ref(db));
    expect(snap.val()).toEqual({ a: 1 });
  });
});
