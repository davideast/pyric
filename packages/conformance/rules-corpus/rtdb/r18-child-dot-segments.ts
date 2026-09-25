/**
 * ─── r18-child-dot-segments ───────────────────────────────────────────────
 * Whether a snapshot's `child()` path resolves `.` and `..` segments, or treats
 * them as keys. RTDB keys cannot contain `.`, so a `.` segment names no child a
 * write can create; the capture pins what `child('./x')` and `child('a/../x')`
 * report against data that holds `x`.
 *
 * Covers: child() path strings with dot segments.
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'the simulator must resolve child() paths as production does, so a rule that navigates with dot segments evaluates the same locally and in production.',
  provenance:
    'Authored to settle whether RTDB child() resolves `.` and `..`. Expectations are the production allow/deny verdicts recorded by the deploy-observe-restore capture in observations/rtdb-rules/rules-rtdb-r18-child-dot-segments.json.',
  rules: JSON.stringify({
    '.read': 'auth != null',
    plain: {
      '.write': 'auth != null',
      '.validate': "newData.child('x').exists()",
    },
    dot: {
      '.write': 'auth != null',
      '.validate': "newData.child('./x').exists()",
    },
    dotdot: {
      '.write': 'auth != null',
      '.validate': "newData.child('a/../x').exists()",
    },
  }),
  cases: [
    { description: 'plain child path finds x', expectation: 'ALLOW', operation: 'write', opPath: '/plain', authPresent: true, newData: { x: 1 } },
    { description: 'a leading dot segment', expectation: 'DENY', operation: 'write', opPath: '/dot', authPresent: true, newData: { x: 1 } },
    { description: 'a dot-dot segment', expectation: 'DENY', operation: 'write', opPath: '/dotdot', authPresent: true, newData: { x: 1, a: 1 } },
  ],
};
