/**
 * ─── r2-own-uid ───────────────────────────────────────────────────────────
 * Path-variable ownership: a `$uid` wildcard whose rule is `$uid === auth.uid`.
 * The matching-uid path allows; a foreign uid path and an anonymous request
 * deny. Decomposed from ruleset `r2-own-uid` of the frozen agreement
 * observation; expectations are the recorded production verdicts. The `<UID>`
 * token in a path is substituted with the signed-in uid at capture/replay
 * time, so the matching case genuinely exercises `$uid === auth.uid`.
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale: '$uid path variable bound against auth.uid — production allows the owner path and denies foreign/anonymous access; the simulator binds the same variable and must agree.',
  provenance: 'Decomposed from the rtdb-simulator-vs-prod-agreement observation, ruleset r2-own-uid. Expectations are the recorded production allow/deny verdicts.',
  rules: JSON.stringify({
    $uid: {
      '.read': '$uid === auth.uid',
      '.write': '$uid === auth.uid',
    },
  }),
  cases: [
    { description: 'matching uid read allowed', expectation: 'ALLOW', operation: 'read', opPath: '/<UID>/value', authPresent: true },
    { description: 'matching uid write allowed', expectation: 'ALLOW', operation: 'write', opPath: '/<UID>/value', authPresent: true, newData: { x: 1 } },
    { description: 'foreign uid read denied', expectation: 'DENY', operation: 'read', opPath: '/some-other-uid/value', authPresent: true },
    { description: 'foreign uid write denied', expectation: 'DENY', operation: 'write', opPath: '/some-other-uid/value', authPresent: true, newData: { x: 1 } },
    { description: 'anon read denied (no auth.uid)', expectation: 'DENY', operation: 'read', opPath: '/<UID>/value', authPresent: false },
  ],
};
