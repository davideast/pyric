/**
 * ─── r25-loose-equality-types ─────────────────────────────────────────────
 * `==` and `!=` against operands of different types. Each value node carries
 * ONE predicate and the ops write directly AT that node, so the operator
 * decides the verdict.
 *
 * The mixed-type cases separate a comparison that converts types from one that
 * does not: JavaScript `==` treats `5 == '5'`, `1 == true`, `0 == false`,
 * `'' == false`, and `true == '1'` as true. The null cases compare `data.val()`
 * with `null` for a missing node and for a stored value, and the `1.0` case
 * compares a number written as `1` with the literal `1.0`. The same-type cases
 * are controls.
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    '`==` and `!=` must compare a number with a string, a number with a boolean, and a string with a boolean without converting either operand, so a rule that expects one type rejects a value of another type as production does.',
  provenance:
    'Authored to pin the equality operators against production directly with mixed-type operands. Expectations are the production allow/deny verdicts recorded by the deploy-observe-restore capture in observations/rtdb-rules/rules-rtdb-r25-loose-equality-types.json.',
  rules: JSON.stringify({
    eqstring: {
      '.write': 'auth != null',
      '.validate': "newData.val() == '5'",
    },
    neqstring: {
      '.write': 'auth != null',
      '.validate': "newData.val() != '5'",
    },
    eqtrue: {
      '.write': 'auth != null',
      '.validate': 'newData.val() == true',
    },
    neqtrue: {
      '.write': 'auth != null',
      '.validate': 'newData.val() != true',
    },
    eqzero: {
      '.write': 'auth != null',
      '.validate': 'newData.val() == 0',
    },
    eqempty: {
      '.write': 'auth != null',
      '.validate': "newData.val() == ''",
    },
    eqstringone: {
      '.write': 'auth != null',
      '.validate': "newData.val() == '1'",
    },
    neqstringone: {
      '.write': 'auth != null',
      '.validate': "newData.val() != '1'",
    },
    eqfloat: {
      '.write': 'auth != null',
      '.validate': 'newData.val() == 1.0',
    },
    datanull: {
      '.write': 'auth != null && data.val() == null',
    },
    datanotnull: {
      '.write': 'auth != null && data.val() != null',
    },
  }),
  cases: [
    { description: "number 5 does not equal string 5 under ==", expectation: 'DENY', operation: 'write', opPath: '/eqstring', authPresent: true, newData: 5 },
    { description: "string 5 equals string 5 under ==", expectation: 'ALLOW', operation: 'write', opPath: '/eqstring', authPresent: true, newData: '5' },
    { description: "number 5 differs from string 5 under !=", expectation: 'ALLOW', operation: 'write', opPath: '/neqstring', authPresent: true, newData: 5 },
    { description: "string 5 does not differ from string 5 under !=", expectation: 'DENY', operation: 'write', opPath: '/neqstring', authPresent: true, newData: '5' },
    { description: 'number 1 does not equal true under ==', expectation: 'DENY', operation: 'write', opPath: '/eqtrue', authPresent: true, newData: 1 },
    { description: 'true equals true under ==', expectation: 'ALLOW', operation: 'write', opPath: '/eqtrue', authPresent: true, newData: true },
    { description: 'number 1 differs from true under !=', expectation: 'ALLOW', operation: 'write', opPath: '/neqtrue', authPresent: true, newData: 1 },
    { description: 'true does not differ from true under !=', expectation: 'DENY', operation: 'write', opPath: '/neqtrue', authPresent: true, newData: true },
    { description: 'false does not equal number 0 under ==', expectation: 'DENY', operation: 'write', opPath: '/eqzero', authPresent: true, newData: false },
    { description: 'number 0 equals number 0 under ==', expectation: 'ALLOW', operation: 'write', opPath: '/eqzero', authPresent: true, newData: 0 },
    { description: 'false does not equal the empty string under ==', expectation: 'DENY', operation: 'write', opPath: '/eqempty', authPresent: true, newData: false },
    { description: 'true does not equal string 1 under ==', expectation: 'DENY', operation: 'write', opPath: '/eqstringone', authPresent: true, newData: true },
    { description: 'string 1 equals string 1 under ==', expectation: 'ALLOW', operation: 'write', opPath: '/eqstringone', authPresent: true, newData: '1' },
    { description: 'true differs from string 1 under !=', expectation: 'ALLOW', operation: 'write', opPath: '/neqstringone', authPresent: true, newData: true },
    { description: 'number 1 equals 1.0 under ==', expectation: 'ALLOW', operation: 'write', opPath: '/eqfloat', authPresent: true, newData: 1 },
    { description: 'missing data equals null under ==', expectation: 'ALLOW', operation: 'write', opPath: '/datanull', authPresent: true, newData: 'x' },
    { description: 'stored value does not equal null under ==', expectation: 'DENY', operation: 'write', opPath: '/datanull', authPresent: true, newData: 'x', mockData: 'stored' },
    { description: 'missing data does not differ from null under !=', expectation: 'DENY', operation: 'write', opPath: '/datanotnull', authPresent: true, newData: 'x' },
    { description: 'stored value differs from null under !=', expectation: 'ALLOW', operation: 'write', opPath: '/datanotnull', authPresent: true, newData: 'x', mockData: 'stored' },
  ],
};
