import { describe, expect, test } from 'bun:test';
import {
  projectValueCreates,
  type RtdbSnapshotCommit,
} from '../../src/functions-rtdb/projection.js';

describe('projectValueCreates', () => {
  test('projects one exact absent-to-present transition at the matched ref', () => {
    const commit: RtdbSnapshotCommit = {
      path: '/messages/id/original',
      before: null,
      after: 'hello',
    };

    expect(projectValueCreates('/messages/id/original', commit)).toEqual([
      {
        ref: 'messages/id/original',
        params: {},
        value: 'hello',
      },
    ]);
  });

  test('expands named single-segment wildcards and captures their params', () => {
    const commit: RtdbSnapshotCommit = {
      path: '/cases/single/items',
      before: null,
      after: {
        itemA: { marker: 'single' },
      },
    };

    expect(projectValueCreates('/cases/{caseId}/items/{itemId}', commit)).toEqual([
      {
        ref: 'cases/single/items/itemA',
        params: { caseId: 'single', itemId: 'itemA' },
        value: { marker: 'single' },
      },
    ]);
  });

  test('projects every newly present matched descendant from ancestor and multi-path snapshots', () => {
    expect(
      projectValueCreates('/cases/{caseId}/items/{itemId}', {
        path: '/cases',
        before: {
          multi: { items: { existing: { marker: 'keep' } } },
        },
        after: {
          multi: {
            items: {
              existing: { marker: 'updated but not created' },
              delta: { marker: 'multi-a' },
              gamma: { marker: 'multi-b' },
            },
          },
        },
      }),
    ).toEqual([
      {
        ref: 'cases/multi/items/delta',
        params: { caseId: 'multi', itemId: 'delta' },
        value: { marker: 'multi-a' },
      },
      {
        ref: 'cases/multi/items/gamma',
        params: { caseId: 'multi', itemId: 'gamma' },
        value: { marker: 'multi-b' },
      },
    ]);
  });

  test('fans out an ancestor create and projects each snapshot to its matched descendant', () => {
    expect(
      projectValueCreates('/batches/{batchId}/items/{itemId}', {
        path: '/batches',
        before: null,
        after: {
          fanout: {
            items: {
              alpha: { marker: 'fanout-a' },
              beta: { marker: 'fanout-b' },
            },
            sibling: { excluded: true },
          },
        },
      }),
    ).toEqual([
      {
        ref: 'batches/fanout/items/alpha',
        params: { batchId: 'fanout', itemId: 'alpha' },
        value: { marker: 'fanout-a' },
      },
      {
        ref: 'batches/fanout/items/beta',
        params: { batchId: 'fanout', itemId: 'beta' },
        value: { marker: 'fanout-b' },
      },
    ]);
  });
});
