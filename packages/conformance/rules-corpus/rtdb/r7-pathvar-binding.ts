/**
 * ─── r7-pathvar-binding ───────────────────────────────────────────────────
 * A nested `$sessionId` path variable referenced in the rule expression
 * (`auth != null && $sessionId === auth.uid`). The matching-session path
 * allows read and write; a mismatching session and an anonymous request deny.
 * Decomposed from ruleset `r7-pathvar-binding`; expectations are the recorded
 * production verdicts. The anonymous case denied in production with no matching
 * rule — the simulator likewise returns NO_MATCHING_RULE (treated as deny).
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale: 'nested $sessionId bound against auth.uid — production allows the matching session and denies mismatched/anonymous access; the simulator must bind the nested variable identically.',
  provenance: 'Decomposed from the rtdb-simulator-vs-prod-agreement observation, ruleset r7-pathvar-binding. Expectations are the recorded production allow/deny verdicts.',
  rules: JSON.stringify({
    sessions: {
      $sessionId: {
        '.read': 'auth != null && $sessionId === auth.uid',
        '.write': 'auth != null && $sessionId === auth.uid',
      },
    },
  }),
  cases: [
    { description: 'matching pathvar allows', expectation: 'ALLOW', operation: 'read', opPath: '/sessions/<UID>', authPresent: true },
    { description: 'matching pathvar allows write', expectation: 'ALLOW', operation: 'write', opPath: '/sessions/<UID>', authPresent: true, newData: { v: 1 } },
    { description: 'mismatching pathvar denies read', expectation: 'DENY', operation: 'read', opPath: '/sessions/other-uid', authPresent: true },
    { description: 'anon denied (no auth.uid)', expectation: 'DENY', operation: 'read', opPath: '/sessions/<UID>', authPresent: false },
  ],
};
