/**
 * RTDB modular SDK — no-change value-listener suppression (T4-5 / DB-B8).
 *
 * RTDB's SyncTree dedups: a write that leaves the value at the
 * listener's exact path byte-identical does NOT re-fire the listener.
 * The sandbox previously fired on every subtree-touching write.
 *
 * Upstream: `core/SyncTree.ts` applies an operation and only emits
 * change events when the cached node actually changed.
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getDatabase,
  ref,
  set,
  onValue,
} from '../../../src/database/index.js';

function setup() {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  return { sandbox, db };
}

describe('DB-B8 — no-change value-listener fire suppression', () => {
  it('re-writing the same value does NOT re-fire the listener', async () => {
    const { db } = setup();
    await set(ref(db, 'v'), { n: 1 });
    const fires: unknown[] = [];
    const off = onValue(ref(db, 'v'), (snap) => fires.push(snap.val()));
    // Initial fire = 1.
    expect(fires.length).toBe(1);
    // Re-write the identical value — no change → no fire.
    await set(ref(db, 'v'), { n: 1 });
    expect(fires.length).toBe(1);
    // A real change → fires.
    await set(ref(db, 'v'), { n: 2 });
    expect(fires.length).toBe(2);
    off();
  });

  it('an ancestor write that leaves the watched subtree unchanged does NOT fire', async () => {
    const { db } = setup();
    await set(ref(db, 'root'), { a: 1, b: 0 });
    const fires: unknown[] = [];
    const off = onValue(ref(db, 'root/a'), (snap) => fires.push(snap.val()));
    expect(fires.length).toBe(1); // initial, val = 1
    // Rewrite the ANCESTOR `/root`, keeping `/root/a` === 1 but changing
    // a sibling. Pre-fix: the ancestor fan-out re-fired the `/root/a`
    // listener even though its value (1) didn't change. Post-fix:
    // suppressed.
    await set(ref(db, 'root'), { a: 1, b: 99 });
    expect(fires.length).toBe(1);
    // Now actually change `/root/a` via the ancestor → fires.
    await set(ref(db, 'root'), { a: 2, b: 99 });
    expect(fires.length).toBe(2);
    off();
  });
});
