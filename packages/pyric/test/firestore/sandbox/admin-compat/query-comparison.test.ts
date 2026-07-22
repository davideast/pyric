import { describe, expect, it } from 'bun:test';
import {
  executionFilter,
  queryExecutionEqual,
  snapshotCursor,
  snapshotFilter,
  type ComparableExecutionSpec,
} from '../../../../src/firestore/sandbox/admin-compat/query-comparison.js';

function spec(overrides: Partial<ComparableExecutionSpec> = {}): ComparableExecutionSpec {
  return {
    filters: [],
    orders: [],
    limitFromEnd: false,
    ...overrides,
  };
}

describe('query comparison', () => {
  it('captures executable operands without retaining caller mutation', () => {
    const operand = { score: 1 };
    const filter = snapshotFilter({ kind: 'where', field: 'value', op: '==', value: operand });

    operand.score = 2;

    expect(executionFilter(filter)).toEqual({
      kind: 'where',
      field: 'value',
      op: '==',
      value: { score: 1 },
    });
  });

  it('compares filter, order, limit, and cursor structure', () => {
    const filter = snapshotFilter({ kind: 'where', field: 'value', op: '==', value: { score: 1 } });
    const equalFilter = snapshotFilter({
      kind: 'where',
      field: 'value',
      op: '==',
      value: { score: 1 },
    });
    const cursor = snapshotCursor([1, 'a'], true, false);
    const left = spec({
      filters: [filter],
      orders: [{ field: 'rank', direction: 'asc' }],
      limitCount: 1,
      start: cursor,
    });
    const right = spec({
      filters: [equalFilter],
      orders: [{ field: 'rank', direction: 'asc' }],
      limitCount: 1,
      start: snapshotCursor([1, 'a'], true, false),
    });

    expect(queryExecutionEqual(left, right)).toBe(true);
    expect(queryExecutionEqual(left, { ...right, limitCount: 2 })).toBe(false);
    expect(queryExecutionEqual(left, {
      ...right,
      orders: [{ field: 'rank', direction: 'desc' }],
    })).toBe(false);
    expect(queryExecutionEqual(left, {
      ...right,
      start: snapshotCursor([1, 'a'], false, false),
    })).toBe(false);
  });
});
