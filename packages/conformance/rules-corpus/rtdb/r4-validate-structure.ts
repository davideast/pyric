/**
 * ─── r4-validate-structure ────────────────────────────────────────────────
 * A `.validate` constraint (`newData.hasChildren(['title', 'body'])`) on a
 * child, under an ancestor `.write: auth != null`. A structurally valid write
 * allows; a write missing a required child is DENIED in production because a
 * failing `.validate` VETOES a write the `.write` rule would otherwise permit.
 *
 * HISTORICAL DIVERGENCE (now resolved): at capture (2026-05-18) the in-process
 * simulator ALLOWED the missing-body case — it did not veto on the child
 * `.validate` — the sole simulator-vs-prod disagreement the agreement
 * observation recorded. The current simulator DENIES it, matching production;
 * the replay suite confirms full agreement with no pin. Expectations here are
 * the recorded PRODUCTION verdicts (DENY for missing-body), which the current
 * simulator now satisfies. Decomposed from ruleset `r4-validate-structure`.
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale: 'a failing child .validate must VETO an otherwise-permitted write — production denies the missing-body write; the simulator allows it, the one recorded divergence.',
  provenance: 'Decomposed from the rtdb-simulator-vs-prod-agreement observation, ruleset r4-validate-structure. Expectations are the recorded production allow/deny verdicts; the missing-body case is the observation\'s sole simulator-vs-prod divergence.',
  rules: JSON.stringify({
    '.read': 'auth != null',
    '.write': 'auth != null',
    entry: {
      '.validate': "newData.hasChildren(['title', 'body'])",
    },
  }),
  cases: [
    { description: 'valid structure allowed', expectation: 'ALLOW', operation: 'write', opPath: '/entry', authPresent: true, newData: { title: 't', body: 'b' } },
    { description: 'missing body denied (validate fails)', expectation: 'DENY', operation: 'write', opPath: '/entry', authPresent: true, newData: { title: 't' } },
  ],
};
