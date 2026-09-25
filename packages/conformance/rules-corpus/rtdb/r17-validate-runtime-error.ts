/**
 * ─── r17-validate-runtime-error ───────────────────────────────────────────
 * A `.validate` expression that fails at evaluation time, as a string method
 * called on a number does, rather than evaluating to false. Pins whether
 * production treats that error as a denial, and that the same rule allows a
 * value it can evaluate.
 *
 * Covers: runtime errors inside .validate.
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'a validate rule that errors at runtime must deny in the simulator as it does in production, never crash the simulation or allow the write.',
  provenance:
    'Authored to settle how RTDB treats an evaluation error inside `.validate`. Expectations are the production allow/deny verdicts recorded by the deploy-observe-restore capture in observations/rtdb-rules/rules-rtdb-r17-validate-runtime-error.json.',
  rules: JSON.stringify({
    '.read': 'auth != null',
    length: {
      '.write': 'auth != null',
      '.validate': 'newData.val().length > 2',
    },
    upper: {
      '.write': 'auth != null',
      '.validate': "newData.val().toUpperCase() == 'OK'",
    },
    guarded: {
      '.write': 'auth != null',
      '.validate': 'newData.isString() && newData.val().length > 2',
    },
  }),
  cases: [
    { description: 'length of a number errors in validate', expectation: 'DENY', operation: 'write', opPath: '/length', authPresent: true, newData: 5 },
    { description: 'length of a long string passes validate', expectation: 'ALLOW', operation: 'write', opPath: '/length', authPresent: true, newData: 'abcd' },
    { description: 'a string method on a number errors in validate', expectation: 'DENY', operation: 'write', opPath: '/upper', authPresent: true, newData: 5 },
    { description: 'a string method on a string passes validate', expectation: 'ALLOW', operation: 'write', opPath: '/upper', authPresent: true, newData: 'ok' },
    { description: 'a type guard short-circuits before the error', expectation: 'DENY', operation: 'write', opPath: '/guarded', authPresent: true, newData: 5 },
  ],
};
