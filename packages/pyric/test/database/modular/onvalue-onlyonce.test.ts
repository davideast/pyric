/**
 * RTDB modular SDK — onValue { onlyOnce } (T4-7 / DB-B12).
 *
 * `onValue(ref, cb, { onlyOnce: true })` fires once then auto-
 * unsubscribes. Mirrors `api/Reference_impl.ts:975-980`.
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getDatabase,
  ref,
  set,
  onValue,
} from '../../../src/database/index.js';
import { setup } from './oracle-conformance.support.js';

describe('DB-B12 — onValue { onlyOnce }', () => {
  it('fires exactly once then auto-unsubscribes', async () => {
    const { db } = setup();
    await set(ref(db, 'v'), 1);
    const fires: unknown[] = [];
    onValue(ref(db, 'v'), (snap) => fires.push(snap.val()), { onlyOnce: true });
    expect(fires).toEqual([1]); // initial fire
    // A subsequent write must NOT fire the once-listener.
    await set(ref(db, 'v'), 2);
    expect(fires).toEqual([1]);
  });
});
