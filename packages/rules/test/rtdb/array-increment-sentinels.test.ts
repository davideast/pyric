import { describe, expect, test } from 'bun:test';
import { rtdbRules } from '../../src/index.js';
import { resolveSentinels } from '../../src/rtdb/data/sentinels.js';

const INC_5 = { '.sv': { increment: 5 } };
const INC_3 = { '.sv': { increment: 3 } };
const INC_2 = { '.sv': { increment: 2 } };
const INC_1 = { '.sv': { increment: 1 } };
const SERVER_TS = { '.sv': 'timestamp' };

const CAPPED_COUNTER_RULES = {
  rules: {
    items: {
      counters: {
        '.read': true,
        '.write': true,
        $index: {
          '.validate': 'newData.isNumber() && newData.val() <= 10',
        },
      },
    },
  },
};

describe('RTDB array and integer-keyed DataTree increment sentinel resolution', () => {
  test('resolveSentinels resolves array increments against canonical integer-keyed objects and JS arrays', () => {
    const now = 1_700_000_000_000;

    // Canonical DataTree shape: arrays are stored as integer-keyed objects.
    expect(resolveSentinels([INC_5, INC_3], now, { '0': 10, '1': 20 })).toEqual([15, 23]);

    // Raw JS array current state.
    expect(resolveSentinels([INC_5, INC_3], now, [10, 20])).toEqual([15, 23]);

    // Prioritized element wrappers inside canonical integer-keyed object.
    expect(
      resolveSentinels([INC_5, INC_3], now, {
        '.priority': 'container',
        '0': { '.value': 10, '.priority': 1 },
        '1': { '.value': 20, '.priority': 2 },
      }),
    ).toEqual([15, 23]);

    // Nested arrays and mixed serverTimestamp + increment.
    expect(
      resolveSentinels([[INC_2], [SERVER_TS, INC_1]], now, {
        '0': { '0': 8 },
        '1': { '0': 99, '1': 4 },
      }),
    ).toEqual([[10], [now, 5]]);

    // Sparse array keeps holes while resolving present indices by String(i).
    const sparse: unknown[] = [];
    sparse[1] = INC_5;
    const resolvedSparse = resolveSentinels(sparse, now, { '0': 10, '1': 20 }) as unknown[];
    expect(0 in resolvedSparse).toBe(false);
    expect(resolvedSparse[1]).toBe(25);
  });

  test('resolveSentinels resolves integer-keyed object increments against JS array current without leaking non-index array properties', () => {
    const now = 1_700_000_000_000;

    expect(
      resolveSentinels(
        { '0': INC_5, '1': INC_3, length: INC_1, '01': INC_1 },
        now,
        [10, 20],
      ),
    ).toEqual({
      '0': 15,
      '1': 23,
      length: 1,
      '01': 1,
    });

    // Sparse JS array current must treat holes as missing (base 0).
    const sparseCurrent: number[] = [];
    sparseCurrent[1] = 20;
    expect(resolveSentinels({ '0': INC_5, '1': INC_3 }, now, sparseCurrent)).toEqual({
      '0': 5,
      '1': 23,
    });
  });

  test('rtdbRules().simulate enforces .validate bounds on array and integer-keyed increments across canonical and array data shapes', () => {
    const ruleset = rtdbRules(CAPPED_COUNTER_RULES);
    const summary = ruleset.simulate([
      {
        description: 'array increment over canonical integer-keyed DataTree exceeds cap and is denied',
        operation: 'write',
        path: '/items/counters',
        data: { items: { counters: { '0': 10, '1': 10 } } },
        newData: [INC_5, INC_5],
        expectation: 'DENY',
      },
      {
        description: 'array increment over canonical integer-keyed DataTree within cap is allowed',
        operation: 'write',
        path: '/items/counters',
        data: { items: { counters: { '0': 5, '1': 4 } } },
        newData: [INC_2, INC_3],
        expectation: 'ALLOW',
      },
      {
        description: 'integer-keyed object increment over JS array data exceeds cap and is denied',
        operation: 'write',
        path: '/items/counters',
        data: { items: { counters: [10, 10] } },
        newData: { '0': INC_5, '1': INC_5 },
        expectation: 'DENY',
      },
      {
        description: 'integer-keyed object increment over JS array data within cap is allowed',
        operation: 'write',
        path: '/items/counters',
        data: { items: { counters: [5, 4] } },
        newData: { '0': INC_2, '1': INC_3 },
        expectation: 'ALLOW',
      },
    ]);

    expect(summary.unsupported).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.passed).toBe(4);
  });
});
