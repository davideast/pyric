/**
 * ─── r15-validate-ancestor-scope ──────────────────────────────────────────
 * WHICH `.validate` rules does a deep write have to satisfy? Four writes,
 * differing only in where the `.validate` sits, isolate the answer:
 *
 *   p1  `.validate` on the PARENT (`hasChildren(['x'])`), write two levels
 *       below it at `/p1/sub/k1`. The parent's own rule is the only `.validate`
 *       in play.
 *   p2  identical shape with NO `.validate` anywhere — the control that proves
 *       the write itself is otherwise permitted.
 *   p1  written AT the validated node with the required child — the control
 *       that proves the rule passes when it is satisfied.
 *
 * PRODUCTION DENIES THE DEEP WRITE (p1) AND ALLOWS THE CONTROL (p2). So a
 * `.validate` on an ANCESTOR of the written path IS evaluated, against the
 * merged post-write value at that ancestor: writing `/p1/sub/k1` leaves `/p1`
 * as `{sub: {k1: ...}}`, which has no `x`, and the write is rejected. "Validate
 * does not cascade" means only that a `.validate` never GRANTS (unlike a truthy
 * ancestor `.read`/`.write`, which does) — it does not mean an ancestor's
 * `.validate` is skipped. Every applicable rule must pass.
 *
 * SIMULATOR DIVERGENCE (pinned, not weakened). pyric's `SimulateHandler`
 * collects `.validate` rules from the WRITE LOCATION DOWNWARD only
 * (`findWriteLocationNode` + `findFailingValidate`), so it never evaluates the
 * ancestor rule and ALLOWS the p1 deep write production denies — a false ALLOW.
 * The expectations below are production's; the divergence is pinned in
 * packages/pyric/test/database/rules-conformance.test.ts KNOWN_DIVERGENCES with
 * both sides asserted, so it fails loudly the moment either side moves. It is a
 * fidelity bug in the RTDB validate walk, reported for its own fix rather than
 * papered over here.
 *
 * Expectations are the PRODUCTION verdicts recorded by the deploy-observe-
 * restore capture
 * (observations/rtdb-rules/rules-rtdb-r15-validate-ancestor-scope.json).
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'isolates the scope of .validate: a rule on an ancestor of the written path is evaluated against the merged post-write value at that ancestor (production denies), while the same write under a rule-free ancestor is allowed — so .validate reaches upward, and the simulator, which walks only from the write location down, is wrong.',
  provenance:
    'Authored to settle the validate-scope semantic empirically after r14 showed production denying a write beneath a validated node, then captured against the live oracle database; expectations are the captured production verdicts.',
  rules: JSON.stringify({
    p1: {
      '.write': 'auth != null',
      '.validate': "newData.hasChildren(['x'])",
      sub: {
        $k: { '.write': 'auth != null' },
      },
    },
    p2: {
      '.write': 'auth != null',
      sub: {
        $k: { '.write': 'auth != null' },
      },
    },
  }),
  cases: [
    {
      description: 'deep write under a validated ancestor denied (ancestor .validate is evaluated)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/p1/sub/k1',
      authPresent: true,
      newData: 'v',
    },
    {
      description: 'same deep write with no ancestor .validate allowed (control)',
      expectation: 'ALLOW',
      operation: 'write',
      opPath: '/p2/sub/k1',
      authPresent: true,
      newData: 'v',
    },
    {
      description: 'write at the validated node satisfying its rule allowed (control)',
      expectation: 'ALLOW',
      operation: 'write',
      opPath: '/p1',
      authPresent: true,
      newData: { x: 1 },
    },
    {
      description: 'write at the validated node violating its rule denied (control)',
      expectation: 'DENY',
      operation: 'write',
      opPath: '/p1',
      authPresent: true,
      newData: { y: 1 },
    },
    {
      description: 'deep write allowed once the ancestor requirement is already satisfied',
      expectation: 'ALLOW',
      operation: 'write',
      opPath: '/p1/sub/k1',
      authPresent: true,
      seed: { '/p1/x': 1 },
      newData: 'v',
    },
  ],
};
