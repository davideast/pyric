/**
 * ─── r36-runtime-arithmetic-types ─────────────────────────────────────────
 * Runtime type checking for RTDB arithmetic operators (`-`, `*`, `/`, `%`,
 * and unary `-`) when operands come from `data.val()`, `newData.val()`, or
 * `auth.token` rather than compile-time literals.
 *
 * Production's rule compiler rejects literal type mismatches at deploy time
 * (e.g. `'a' - 1`, `r29`), but expressions over dynamic values (`newData.val() - 1`)
 * compile and are type-checked at evaluation time. Production requires numeric
 * operands for `-`, `*`, `/`, `%`, and unary `-` at runtime: a boolean, numeric
 * string, non-numeric string, or object operand raises an evaluation error that
 * fails the rule expression (even under `|| true` or `!(... == 0)`).
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'arithmetic operators (-, *, /, %, unary -) given a boolean, string, or object at evaluation time must match production rather than silently coercing through JavaScript arithmetic or rescuing NaN via || true.',
  provenance:
    'Authored from 2026-10-15 bug hunt (FUZ-3 / MET-2) to pin runtime non-number operands of -, *, /, %, and unary - against production. Captured by deploy-observe-restore on 2026-10-15 in observations/rtdb-rules/rules-rtdb-r36-runtime-arithmetic-types.json.',
  rules: JSON.stringify({
    sub: {
      bool: { '.write': 'newData.val() - 1 == 0' },
      numstr: { '.write': 'newData.val() - 1 == 4' },
      badstrOrTrue: { '.write': 'newData.val() - 1 == 0 || true' },
      badstrNotEq: { '.write': '!(newData.val() - 1 == 0)' },
      objOrTrue: { '.write': 'newData.val() - 1 == 0 || true' },
    },
    mul: {
      bool: { '.write': 'newData.val() * 2 == 2' },
      numstr: { '.write': 'newData.val() * 2 == 6' },
      badstrOrTrue: { '.write': 'newData.val() * 2 == 0 || true' },
      objNotEq: { '.write': '!(newData.val() * 2 == 0)' },
    },
    div: {
      bool: { '.write': 'newData.val() / 2 == 0.5' },
      numstr: { '.write': 'newData.val() / 2 == 3' },
      objOrTrue: { '.write': 'newData.val() / 2 == 0 || true' },
    },
    mod: {
      bool: { '.write': 'newData.val() % 2 == 1' },
      numstr: { '.write': 'newData.val() % 4 == 3' },
      objNotEq: { '.write': '!(newData.val() % 2 == 0)' },
    },
    neg: {
      bool: { '.write': '-newData.val() == -1' },
      numstr: { '.write': '-newData.val() == -5' },
      badstrOrTrue: { '.write': '-newData.val() == 0 || true' },
      objNotEq: { '.write': '!(-newData.val() == 0)' },
    },
    control: {
      numSub: { '.write': 'newData.val() - 1 == 4' },
    },
  }),
  cases: [
    // Subtraction (-)
    {
      description: 'FUZ-3: boolean minus number (true - 1 == 0)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/sub/bool',
      authPresent: true,
      newData: true,
    },
    {
      description: 'FUZ-3: numeric string minus number ("5" - 1 == 4)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/sub/numstr',
      authPresent: true,
      newData: '5',
    },
    {
      description: 'FUZ-3: non-numeric string minus number under || true ("abc" - 1 == 0 || true)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/sub/badstrOrTrue',
      authPresent: true,
      newData: 'abc',
    },
    {
      description: 'FUZ-3: non-numeric string minus number under !(X == 0)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/sub/badstrNotEq',
      authPresent: true,
      newData: 'abc',
    },
    {
      description: 'FUZ-3: object minus number under || true ({a:1} - 1 == 0 || true)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/sub/objOrTrue',
      authPresent: true,
      newData: { a: 1 },
    },

    // Multiplication (*)
    {
      description: 'FUZ-3: boolean times number (true * 2 == 2)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/mul/bool',
      authPresent: true,
      newData: true,
    },
    {
      description: 'FUZ-3: numeric string times number ("3" * 2 == 6)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/mul/numstr',
      authPresent: true,
      newData: '3',
    },
    {
      description: 'FUZ-3: non-numeric string times number under || true ("abc" * 2 == 0 || true)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/mul/badstrOrTrue',
      authPresent: true,
      newData: 'abc',
    },
    {
      description: 'FUZ-3: object times number under !(X == 0) (!({a:1} * 2 == 0))',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/mul/objNotEq',
      authPresent: true,
      newData: { a: 1 },
    },

    // Division (/)
    {
      description: 'FUZ-3: boolean divided by number (true / 2 == 0.5)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/div/bool',
      authPresent: true,
      newData: true,
    },
    {
      description: 'FUZ-3: numeric string divided by number ("6" / 2 == 3)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/div/numstr',
      authPresent: true,
      newData: '6',
    },
    {
      description: 'FUZ-3: object divided by number under || true ({a:1} / 2 == 0 || true)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/div/objOrTrue',
      authPresent: true,
      newData: { a: 1 },
    },

    // Modulo (%)
    {
      description: 'FUZ-3: boolean modulo number (true % 2 == 1)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/mod/bool',
      authPresent: true,
      newData: true,
    },
    {
      description: 'FUZ-3: numeric string modulo number ("7" % 4 == 3)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/mod/numstr',
      authPresent: true,
      newData: '7',
    },
    {
      description: 'FUZ-3: object modulo number under !(X == 0) (!({a:1} % 2 == 0))',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/mod/objNotEq',
      authPresent: true,
      newData: { a: 1 },
    },

    // Unary minus (-)
    {
      description: 'FUZ-3 / MET-2: unary minus on boolean (-true == -1)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/neg/bool',
      authPresent: true,
      newData: true,
    },
    {
      description: 'FUZ-3 / MET-2: unary minus on numeric string (-"5" == -5)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/neg/numstr',
      authPresent: true,
      newData: '5',
    },
    {
      description: 'FUZ-3 / MET-2: unary minus on non-numeric string under || true (-"abc" == 0 || true)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/neg/badstrOrTrue',
      authPresent: true,
      newData: 'abc',
    },
    {
      description: 'FUZ-3 / MET-2: unary minus on object under !(X == 0) (!(-{a:1} == 0))',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/neg/objNotEq',
      authPresent: true,
      newData: { a: 1 },
    },

    // Positive control
    {
      description: 'FUZ-3: control number minus number (5 - 1 == 4)',
      expectation: 'ALLOW',
      operation: 'write',
      opPath: '/control/numSub',
      authPresent: true,
      newData: 5,
    },
  ],
};
