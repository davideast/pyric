import { expect, test } from 'bun:test';
import { failedComparisons } from '../../../src/serve/runtime/rule-comparisons.js';

test('compares the observed field with the required literal without duplicate rows', () => {
  expect(failedComparisons([
    { expression: 'request.resource.data.version >= 0', parent: null, state: 'value', value: false, operator: '>=' },
    { expression: 'request.resource.data.version', parent: 0, state: 'value', value: -1, kind: 'memberAccess' },
    { expression: '0', parent: 0, state: 'value', value: 0, kind: 'literal' },
  ])).toEqual([{ alternative: false, field: 'Submitted version', observed: '-1', requirement: 'At least', expected: '0', expectedField: null }]);
});

test('incomplete or short-circuited evidence does not invent a comparison', () => {
  expect(failedComparisons([
    { expression: 'left == right', parent: null, state: 'value', value: false, operator: '==' },
    { expression: 'left', parent: 0, state: 'skipped' },
    { expression: 'right', parent: 0, state: 'value', value: 0 },
  ])).toEqual([]);
});

test('a failed OR branch is identified as an alternative, not a mandatory check', () => {
  const comparisons = failedComparisons([
    { expression: 'owner || admin', parent: null, state: 'value', value: false, operator: '||' },
    { expression: 'role == "admin"', parent: 0, state: 'value', value: false, operator: '==' },
    { expression: 'request.auth.token.role', parent: 1, state: 'value', value: 'member' },
    { expression: '"admin"', parent: 1, state: 'value', value: 'admin', kind: 'literal' },
  ]);
  expect(comparisons[0]?.alternative).toBe(true);
});
