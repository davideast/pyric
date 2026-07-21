import { describe, expect, test } from 'bun:test';
import { LocalState } from '../../../src/firestore/sandbox/local-state.js';
import {
  executeQuery,
  gatherQueryRows,
  queryConstraintsForProof,
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

  test('derives rules proof from the same executable plan', () => {
    const execution = {
      filters: [
        { kind: 'where' as const, field: 'owner', op: '==' as const, value: 'alice' },
        {
          kind: 'or' as const,
          filters: [
            { kind: 'where' as const, field: 'status', op: '==' as const, value: 'open' },
            { kind: 'where' as const, field: 'status', op: '==' as const, value: 'closed' },
          ],
        },
      ],
      orders: [{ field: 'createdAt', direction: 'desc' as const }],
      limitCount: 25,
      limitFromEnd: false,
    };

    expect(queryConstraintsForProof(execution)).toEqual({
      where: [{ field: 'owner', op: '==', value: 'alice' }],
      limit: 25,
      offset: null,
      orderBy: 'createdAt',
    });
  });

  test('does not project the document-key sentinel as a data-field equality', () => {
    const execution = {
      filters: [
        { kind: 'where' as const, field: '__name__', op: '==' as const, value: 'allowed' },
        { kind: 'where' as const, field: 'owner', op: '==' as const, value: 'alice' },
      ],
      orders: [],
      limitFromEnd: false,
    };

    expect(queryConstraintsForProof(execution).where).toEqual([
      { field: 'owner', op: '==', value: 'alice' },
    ]);
  });
});
