/**
 * ─── r13-priority-and-index-directive ─────────────────────────────────────
 * Two constructs that carry no allow/deny of their own and are therefore easy to
 * leave unverified: `getPriority()` and the `.indexOn` directive.
 *
 * `getPriority()` is verified through its VALUE, not through a priority write: the
 * corpus ops are plain `set` calls, which leave a node's priority unset, so
 * production reports a null priority. `/unprioritized` asserts that null (ALLOW) and
 * `/prioritized` demands a non-null one (DENY). Together they pin the value a plain
 * `set` produces. Writing an actual priority would need `setWithPriority`, which is
 * outside the corpus op vocabulary (read and set), so a non-null priority remains
 * unverified — this scenario deliberately does not claim otherwise.
 *
 * `.indexOn` is a query-planner directive: it never changes an allow/deny verdict,
 * and no read or write op can flip on it. What the observation twin proves is
 * narrower but real — production's rules compiler ACCEPTED and deployed a ruleset
 * carrying `.indexOn`, and its presence left every verdict in this scenario intact.
 * That is the whole of the claim; it is not evidence about query behavior.
 *
 * Covers: getPriority and the .indexOn rule kind.
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'a plain `set` leaves priority unset, so `getPriority()` must report null in the simulator exactly as it does in production, and a ruleset carrying `.indexOn` must deploy and evaluate without the directive disturbing any verdict.',
  provenance:
    'Authored to close the rules-language construct gaps left by r1-r8, which carried neither a priority read nor an index directive. Expectations are the production allow/deny verdicts recorded by the deploy-observe-restore capture in observations/rtdb-rules/rules-rtdb-r13-priority-and-index-directive.json.',
  rules: JSON.stringify({
    '.read': 'auth != null',
    scores: {
      '.indexOn': ['score'],
      '.write': 'auth != null',
      $entry: {
        '.validate': 'newData.getPriority() == null',
      },
    },
    unprioritized: {
      '.write': 'auth != null',
      '.validate': 'newData.getPriority() == null',
    },
    prioritized: {
      '.write': 'auth != null',
      '.validate': 'newData.getPriority() != null',
    },
  }),
  cases: [
    { description: 'plain set under an indexed node has a null priority', expectation: 'ALLOW', operation: 'write', opPath: '/scores/e1', authPresent: true, newData: { score: 10 } },
    { description: 'plain set has a null priority', expectation: 'ALLOW', operation: 'write', opPath: '/unprioritized', authPresent: true, newData: 5 },
    { description: 'plain set cannot satisfy a non-null priority demand', expectation: 'DENY', operation: 'write', opPath: '/prioritized', authPresent: true, newData: 5 },
    { description: 'auth-gated read of the indexed node allowed', expectation: 'ALLOW', operation: 'read', opPath: '/scores', authPresent: true },
  ],
};
