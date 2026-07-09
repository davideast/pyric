/**
 * Regression: the Sandbox card's live counts must stay a pure recompute of the
 * LATEST index build, never an accumulator that climbs on every worker tick.
 *
 * The live bug: `sand-seal  80007 users · 160014 files` "randomly counting up
 * rapidly" — each worker event re-derives the data-source identity, re-fires
 * the card's `ensure()` effect, and a chained rebuild stacked a whole fresh
 * inventory on top of the previous build's entries (hence the exact 1:2
 * users:files ratio: one full inventory added per cycle). The fix makes the
 * first batch of each build REPLACE (`foldIndexBatch`), so counts are stable
 * across repeated ticks/re-renders.
 */

import { describe, expect, it } from 'bun:test';
import type { ResourceEntry } from '../home/typeahead.js';
import { foldIndexBatch } from '../home/resource-index-state.js';
import { countInventory } from './sandbox-inventory.js';

const user = (uid: string): ResourceEntry => ({
  kind: 'user',
  label: uid,
  target: { tab: 'auth', rest: [uid] },
});
const file = (path: string): ResourceEntry => ({
  kind: 'object',
  label: path,
  target: { tab: 'storage', rest: [path] },
});

// One fixed sandbox inventory, delivered as two progressive batches (as a real
// build does: Firestore/users first, storage second).
const INVENTORY: ResourceEntry[][] = [
  [user('alice'), user('bob'), user('carol')],
  [file('a.png'), file('b.png')],
];

/** Model one full build: fold each batch, first batch replacing the last
 *  build's entries. Mirrors the hook's per-build `firstOfBuild` flag. */
function runBuild(prev: ResourceEntry[] | null, batches: ResourceEntry[][]): ResourceEntry[] {
  let entries = prev;
  let first = true;
  for (const batch of batches) {
    entries = foldIndexBatch(entries, batch, first);
    first = false;
  }
  return entries ?? [];
}

describe('sandbox card counts (regression: runaway accumulation)', () => {
  it('counts a single build to the real inventory', () => {
    const counts = countInventory(runBuild(null, INVENTORY));
    expect(counts).toMatchObject({ users: 3, objects: 2 });
  });

  it('stays constant across many rebuilds/ticks (no runaway)', () => {
    let entries: ResourceEntry[] | null = null;
    for (let tick = 0; tick < 40; tick++) {
      entries = runBuild(entries, INVENTORY);
      const counts = countInventory(entries);
      expect(counts).toMatchObject({ users: 3, objects: 2 });
    }
  });

  it('preserves the 1:2 users:files shape without inflating it', () => {
    // 40 ticks the OLD way (pure append, no first-batch replace) would reach
    // 3*41 users / 2*41 files — the runaway. The fix pins it at 3/2.
    let entries: ResourceEntry[] | null = null;
    for (let tick = 0; tick < 40; tick++) entries = runBuild(entries, INVENTORY);
    const counts = countInventory(entries)!;
    expect(counts.users).toBe(3);
    expect(counts.objects).toBe(2);
    expect(counts.objects).toBe(counts.users - 1);
  });
});
