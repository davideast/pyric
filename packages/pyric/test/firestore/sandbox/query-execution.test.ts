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

test('nested paths share filter, ordering, cursor, and existence semantics', () => {
  const rows = [
    { path: 'items/a', data: { time: { startsAt: 2 } } },
    { path: 'items/b', data: { time: { startsAt: 1 } } },
    { path: 'items/c', data: { time: { startsAt: 3 } } },
    { path: 'items/missing', data: { time: {} } },
    { path: 'items/literal', data: { 'time.startsAt': 0 } },
    { path: 'items/array', data: { time: [0] } },
  ];
  const orders = [{ field: 'time.startsAt', direction: 'asc' as const }];
  expect(executeQuery(rows, { filters: [], orders, limitCount: 2, limitFromEnd: false }).map(row => row.path))
    .toEqual(['items/b', 'items/a']);
  expect(executeQuery(rows, { filters: [{ kind: 'where', field: 'time.startsAt', op: '>=', value: 2 }],
    orders, start: { values: [2], inclusive: false }, limitFromEnd: false }).map(row => row.path))
    .toEqual(['items/c']);
  expect(executeQuery(rows, { filters: [], orders: [{field: 'time.toString', direction: 'asc'}], limitFromEnd: false }))
    .toEqual([]);
});
