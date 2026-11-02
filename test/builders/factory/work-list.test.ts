import { describe, expect, test } from 'bun:test';
import { hasWorkFor, type WorkItem } from './work-list.ts';

const open: WorkItem = { id: 'search-query', title: 'Query the index', status: 'todo' };

describe('hasWorkFor', () => {
  test('counts an open todo item, and an item the seat already took', () => {
    expect(hasWorkFor([open], 'builder-1')).toBe(true);
    expect(hasWorkFor([{ ...open, owner: 'builder-1', status: 'in-progress' }], 'builder-1')).toBe(true);
    expect(hasWorkFor([{ ...open, owner: 'builder-2', status: 'in-progress' }], 'builder-1')).toBe(false);
  });

  test('a blocked item is no builder\'s work, open or owned', () => {
    expect(hasWorkFor([{ ...open, blocked: 'where-index.md' }], 'builder-1')).toBe(false);
    expect(hasWorkFor([{ ...open, owner: 'builder-1', status: 'in-progress', blocked: true }], 'builder-1')).toBe(false);
    expect(hasWorkFor([{ ...open, blocked: 'where-index.md' }, { ...open, id: 'player' }], 'builder-1')).toBe(true);
  });

  test('a cleared block is not a block', () => {
    for (const blocked of [false, '', null]) expect(hasWorkFor([{ ...open, blocked }], 'builder-1')).toBe(true);
  });
});
