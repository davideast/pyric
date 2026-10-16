/**
 * ─── r41-error-and-false-short-circuit ────────────────────────────────────
 * Short-circuit behavior of `&&` and `||` when the left-hand side of `X && false`
 * raises a runtime evaluation error and the whole `X && false` sits inside `!`
 * or `|| true`.
 *
 * In RTDB rules, `&&` is left-to-right: `false && X` short-circuits before
 * evaluating `X`, whereas `X && false` evaluates `X` first. When `X` raises a
 * runtime error (such as `.toUpperCase()` on a number), `X && false` errors
 * rather than returning `false`, so `!(X && false)` and `(X && false) || true`
 * fail the rule and deny access.
 *
 * This scenario pins production's behavior for `LNT-1` (where the security
 * linter's boolean simplifier folded `X && false` to `false` regardless of
 * whether `X` could error, falsely reporting `!(X && false)` as an
 * unconditional `always-true` grant).
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'an expression of the form !(X && false) or (X && false) || true where X errors at runtime must match production so the security linter and simulator agree on whether the rule can grant.',
  provenance:
    'Authored from 2026-10-15 bug hunt (LNT-1) to pin runtime error evaluation inside !(X && false), (X && false) || true, and (X && false) ? false : true against production. Captured by deploy-observe-restore on 2026-10-15 in observations/rtdb-rules/rules-rtdb-r41-error-and-false-short-circuit.json.',
  rules: JSON.stringify({
    notAndFalse: {
      '.read': "!(data.child('n').val().toUpperCase() == 'A' && false)",
    },
    andFalseOrTrue: {
      '.read': "(data.child('n').val().toUpperCase() == 'A' && false) || true",
    },
    andFalseTernary: {
      '.read': "(data.child('n').val().toUpperCase() == 'A' && false) ? false : true",
    },
    writeNotAndFalse: {
      '.write': "!(newData.val().toUpperCase() == 'A' && false)",
    },
    writeAndFalseOrTrue: {
      '.write': "(newData.val().toUpperCase() == 'A' && false) || true",
    },
  }),
  cases: [
    {
      description: 'LNT-1: read !(X && false) when X calls toUpperCase() on a number',
      expectation: 'DENY',
      operation: 'read',
      opPath: '/notAndFalse',
      authPresent: false,
      seed: { '/notAndFalse/n': 5 },
    },
    {
      description: 'LNT-1: control read !(X && false) when X calls toUpperCase() on a string',
      expectation: 'ALLOW',
      operation: 'read',
      opPath: '/notAndFalse',
      authPresent: false,
      seed: { '/notAndFalse/n': 'hello' },
    },
    {
      description: 'LNT-1: read (X && false) || true when X calls toUpperCase() on a number',
      expectation: 'DENY',
      operation: 'read',
      opPath: '/andFalseOrTrue',
      authPresent: false,
      seed: { '/andFalseOrTrue/n': 5 },
    },
    {
      description: 'LNT-1: control read (X && false) || true when X calls toUpperCase() on a string',
      expectation: 'ALLOW',
      operation: 'read',
      opPath: '/andFalseOrTrue',
      authPresent: false,
      seed: { '/andFalseOrTrue/n': 'hello' },
    },
    {
      description: 'LNT-1: read (X && false) ? false : true when X calls toUpperCase() on a number',
      expectation: 'DENY',
      operation: 'read',
      opPath: '/andFalseTernary',
      authPresent: false,
      seed: { '/andFalseTernary/n': 5 },
    },
    {
      description: 'LNT-1: write !(X && false) when X calls toUpperCase() on a number',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/writeNotAndFalse',
      authPresent: false,
      newData: 5,
    },
    {
      description: 'LNT-1: write (X && false) || true when X calls toUpperCase() on a number',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/writeAndFalseOrTrue',
      authPresent: false,
      newData: 5,
    },
    {
      description: 'LNT-1: control write !(X && false) when X calls toUpperCase() on a string',
      expectation: 'ALLOW',
      operation: 'write',
      opPath: '/writeNotAndFalse',
      authPresent: false,
      newData: 'hello',
    },
  ],
};
