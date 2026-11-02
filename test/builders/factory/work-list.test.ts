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

  test('an item waits until every item it depends on is ready or done', () => {
    const screen: WorkItem = { ...open, id: 'search-screen', dependsOn: ['search-query'] };
    const withQuery = (status: WorkItem['status']): WorkItem[] => [{ ...open, status, owner: 'builder-2' }, screen];
    expect(hasWorkFor(withQuery('in-progress'), 'builder-1')).toBe(false);
    expect(hasWorkFor(withQuery('todo'), 'builder-1')).toBe(false);
    expect(hasWorkFor(withQuery('ready'), 'builder-1')).toBe(true);
    expect(hasWorkFor(withQuery('done'), 'builder-1')).toBe(true);
  });

  test('a dependency missing from the list keeps the item waiting', () => {
    expect(hasWorkFor([{ ...open, dependsOn: ['not-planned'] }], 'builder-1')).toBe(false);
    expect(hasWorkFor([{ ...open, dependsOn: [] }], 'builder-1')).toBe(true);
  });

  test('a cleared block is not a block', () => {
    for (const blocked of [false, '', null]) expect(hasWorkFor([{ ...open, blocked }], 'builder-1')).toBe(true);
  });
});
