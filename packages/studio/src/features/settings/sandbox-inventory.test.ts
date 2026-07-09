import { describe, expect, it } from 'bun:test';
import type { ResourceEntry } from '../home/typeahead.js';
import { countInventory, inventoryLine } from './sandbox-inventory.js';

const entry = (kind: ResourceEntry['kind'], label: string): ResourceEntry => ({
  kind,
  label,
  target: { tab: 'firestore' },
});

describe('countInventory', () => {
  it('is null before the index is built', () => {
    expect(countInventory(null)).toBeNull();
  });

  it('counts by kind, ignoring documents (capped fetch — would under-report)', () => {
    const counts = countInventory([
      entry('collection', 'users'),
      entry('collection', 'posts'),
      entry('document', 'users/alice'),
      entry('user', 'alice@example.com'),
      entry('object', 'uploads/a.png'),
      entry('rtdb-key', 'rooms'),
    ]);
    expect(counts).toEqual({ collections: 2, users: 1, objects: 1, rtdbKeys: 1 });
  });
});

describe('inventoryLine', () => {
  it('joins the present kinds, pluralized', () => {
    expect(
      inventoryLine({ collections: 2, users: 1, objects: 3, rtdbKeys: 0 }),
    ).toBe('2 collections · 1 user · 3 files');
  });

  it('says empty when nothing is held, and measuring before the index exists', () => {
    expect(inventoryLine({ collections: 0, users: 0, objects: 0, rtdbKeys: 0 })).toBe(
      'empty — no data yet',
    );
    expect(inventoryLine(null)).toBe('measuring…');
  });
});
