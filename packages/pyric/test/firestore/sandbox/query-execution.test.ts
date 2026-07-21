import { describe, expect, test } from 'bun:test';
import { LocalState } from '../../../src/firestore/sandbox/local-state.js';
import {
  executeQuery,
  gatherQueryRows,
} from '../../../src/firestore/sandbox/query-execution.js';

describe('query execution', () => {
  test('gathers direct collection children without phantoms or descendants', () => {
    const state = new LocalState({
      'items/a': { score: 1 },
      'items/phantom/children/c1': { score: 2 },
      'other/b': { score: 3 },
    });

    expect(gatherQueryRows(state, { kind: 'collection', path: 'items' })).toEqual([
      { path: 'items/a', data: { score: 1 } },
    ]);
  });

  test('applies filters, normalized ordering, cursors, and limits', () => {
    const rows = [
      { path: 'items/a', data: { score: 2, visible: true } },
      { path: 'items/b', data: { score: 3, visible: false } },
      { path: 'items/c', data: { score: 1, visible: true } },
    ];

    expect(executeQuery(rows, {
      filters: [{ kind: 'where', field: 'visible', op: '==', value: true }],
      orders: [{ field: 'score', direction: 'desc' }],
      limitCount: 1,
      limitFromEnd: false,
    })).toEqual([{ path: 'items/a', data: { score: 2, visible: true } }]);
  });
});
