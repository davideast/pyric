/**
 * RTDB modular SDK — increment() sentinel (T4-6 / DB-GAP).
 *
 * `increment(delta)` atomically adds `delta` to the current field value,
 * starting from 0 when absent. COMPAT + oracle already CLAIM increment
 * works; the export was missing. Aligns to oracle
 * `packages/conformance/observations/rtdb-modular/rtdb-modular-increment-from-missing.json`
 * (`startsFromZero: true`, `accumulates: true`, afterFirst:5, second:8,
 * negative:6) + upstream `api/ServerValue.ts:38-44`.
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getDatabase,
  ref,
  set,
  update,
  get,
  increment,
} from '../../../src/database/index.js';
import { setup } from './oracle-conformance.support.js';

describe('DB-GAP — increment()', () => {
  it('increment against a missing field starts from 0', async () => {
    const { db } = setup();
    await set(ref(db, 'counter'), increment(5));
    const snap = await get(ref(db, 'counter'));
    expect(snap.val()).toBe(5);
  });

  it('subsequent increments accumulate (positive then negative)', async () => {
    const { db } = setup();
    await set(ref(db, 'counter'), increment(5)); // 0 + 5 = 5
    await set(ref(db, 'counter'), increment(3)); // 5 + 3 = 8
    await set(ref(db, 'counter'), increment(-2)); // 8 - 2 = 6
    const snap = await get(ref(db, 'counter'));
    expect(snap.val()).toBe(6);
  });

  it('increment nested inside an update patch resolves per-field', async () => {
    const { db } = setup();
    await set(ref(db, 'stats'), { hits: 10 });
    await update(ref(db, 'stats'), { hits: increment(1), misses: increment(1) });
    const snap = await get(ref(db, 'stats'));
    expect(snap.val()).toEqual({ hits: 11, misses: 1 });
  });
});
