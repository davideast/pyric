/**
 * ─── r37-runtime-comparison-and-length-types ──────────────────────────────
 * Runtime type checking for `+`, relational comparisons (`<`, `>`, `>=`), and
 * the `.length` property when operands come from `newData.val()` at evaluation
 * time.
 *
 *   - `+`: production accepts `auth.uid + 1` at deploy time (`r29`) and allows
 *     string + number concatenation at evaluation time (`"5" + 1 == "51"`),
 *     while rejecting boolean or object operands at runtime.
 *   - `<`, `>`, `>=`: production rejects boolean-to-number, string-to-number,
 *     and object-to-number ordering comparisons at runtime rather than
 *     coercing through JavaScript `<` / `>` / `>=`.
 *   - `.length`: in RTDB rules, `.length` is a string property only. Accessing
 *     `.length` on a number or object (including an object with a child key
 *     `"length": 10`) is a runtime error, even under `|| true`.
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'addition, relational comparisons (<, >, >=), and .length on runtime values of the wrong type must match production rather than coercing booleans/strings/objects or reading a child key named "length".',
  provenance:
    'Authored from 2026-10-15 bug hunt (FUZ-3 / MET-2) to pin runtime non-number/non-string operands of +, <, >, >=, and .length against production. Captured by deploy-observe-restore on 2026-10-15 in observations/rtdb-rules/rules-rtdb-r37-runtime-comparison-and-length-types.json.',
  rules: JSON.stringify({
    add: {
      boolNum: { '.write': 'newData.val() + 1 == 2' },
      boolNumOrTrue: { '.write': 'newData.val() + 1 == 0 || true' },
      strNumConcat: { '.write': "newData.val() + 1 == '51'" },
      strNumOrTrue: { '.write': "newData.val() + 1 == 'none' || true" },
      objStr: { '.write': "newData.val() + '!' == '[object Object]!'" },
      objNumOrTrue: { '.write': 'newData.val() + 1 == 0 || true' },
    },
    lt: {
      boolNum: { '.write': 'newData.val() < 1' },
      strNum: { '.write': 'newData.val() < 2' },
      strNumOrTrue: { '.write': 'newData.val() < 0 || true' },
      objNumOrTrue: { '.write': 'newData.val() < 0 || true' },
    },
    gt: {
      boolNum: { '.write': 'newData.val() > 0' },
      strNum: { '.write': 'newData.val() > 1' },
      objNumOrTrue: { '.write': 'newData.val() > 0 || true' },
    },
    gte: {
      boolNum: { '.write': 'newData.val() >= 1' },
      strNum: { '.write': 'newData.val() >= 2' },
      objNumOrTrue: { '.write': 'newData.val() >= 0 || true' },
    },
    len: {
      numOrTrue: { '.write': 'newData.val().length == 0 || true' },
      numNotEq: { '.write': '!(newData.val().length == 0)' },
      objWithLengthKey: { '.write': 'newData.val().length > 2' },
      objWithoutLengthKeyOrTrue: { '.write': 'newData.val().length == 0 || true' },
    },
  }),
  cases: [
    // Addition (+)
    {
      description: 'FUZ-3: boolean plus number (true + 1 == 2)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/add/boolNum',
      authPresent: true,
      newData: true,
    },
    {
      description: 'FUZ-3: boolean plus number under || true (false + 1 == 0 || true)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/add/boolNumOrTrue',
      authPresent: true,
      newData: false,
    },
    {
      description: 'FUZ-3: string plus number concatenation ("5" + 1 == "51")',
      expectation: 'ALLOW',
      operation: 'write',
      opPath: '/add/strNumConcat',
      authPresent: true,
      newData: '5',
    },
    {
      description: 'FUZ-3: string plus number under || true ("5" + 1 == "none" || true)',
      expectation: 'ALLOW',
      operation: 'write',
      opPath: '/add/strNumOrTrue',
      authPresent: true,
      newData: '5',
    },
    {
      description: 'FUZ-3: object plus string ({a:1} + "!" == "[object Object]!")',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/add/objStr',
      authPresent: true,
      newData: { a: 1 },
    },
    {
      description: 'FUZ-3: object plus number under || true ({a:1} + 1 == 0 || true)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/add/objNumOrTrue',
      authPresent: true,
      newData: { a: 1 },
    },

    // Less-than (<)
    {
      description: 'FUZ-3: boolean less than number (false < 1)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/lt/boolNum',
      authPresent: true,
      newData: false,
    },
    {
      description: 'FUZ-3: string less than number ("1" < 2)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/lt/strNum',
      authPresent: true,
      newData: '1',
    },
    {
      description: 'FUZ-3: string less than number under || true ("1" < 0 || true)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/lt/strNumOrTrue',
      authPresent: true,
      newData: '1',
    },
    {
      description: 'FUZ-3: object less than number under || true ({a:1} < 0 || true)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/lt/objNumOrTrue',
      authPresent: true,
      newData: { a: 1 },
    },

    // Greater-than (>)
    {
      description: 'FUZ-3: boolean greater than number (true > 0)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/gt/boolNum',
      authPresent: true,
      newData: true,
    },
    {
      description: 'FUZ-3: string greater than number ("2" > 1)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/gt/strNum',
      authPresent: true,
      newData: '2',
    },
    {
      description: 'FUZ-3: object greater than number under || true ({a:1} > 0 || true)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/gt/objNumOrTrue',
      authPresent: true,
      newData: { a: 1 },
    },

    // Greater-than-or-equal (>=)
    {
      description: 'FUZ-3: boolean greater than or equal to number (true >= 1)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/gte/boolNum',
      authPresent: true,
      newData: true,
    },
    {
      description: 'FUZ-3: string greater than or equal to number ("2" >= 2)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/gte/strNum',
      authPresent: true,
      newData: '2',
    },
    {
      description: 'FUZ-3: object greater than or equal to number under || true ({a:1} >= 0 || true)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/gte/objNumOrTrue',
      authPresent: true,
      newData: { a: 1 },
    },

    // .length on non-strings (MET-2)
    {
      description: 'MET-2: .length on a number under == 0 || true',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/len/numOrTrue',
      authPresent: true,
      newData: 123,
    },
    {
      description: 'MET-2: .length on a number under !(X == 0)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/len/numNotEq',
      authPresent: true,
      newData: 123,
    },
    {
      description: 'MET-2: .length on an object with a length child ({length: 10}.length > 2)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/len/objWithLengthKey',
      authPresent: true,
      newData: { length: 10 },
    },
    {
      description: 'MET-2: .length on an object without a length child under == 0 || true',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/len/objWithoutLengthKeyOrTrue',
      authPresent: true,
      newData: { a: 1 },
    },
  ],
};
