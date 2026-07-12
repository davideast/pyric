/**
 * ─── r14-root-lookup ──────────────────────────────────────────────────────
 * The `root` binding, verified within the one claim the capture rig can honestly
 * support.
 *
 * `root` resolves to the DATABASE root, and the two sides of the chain mount this
 * subtree at different depths: the capture runner deploys it under a run-scoped,
 * randomly-named namespace (`/pyric_oracle_rulesrtdb_<runId>/r14-root-lookup`),
 * while the replay suite mounts it directly at `/r14-root-lookup`. A rule naming any
 * PRESENT path through `root` would therefore address a different node in each and
 * diverge for reasons that belong to the harness, not to the simulator. The run-scoped
 * name is generated per run and cannot be written into a frozen ruleset in any case.
 *
 * What IS mount-invariant is absence: a path that exists under neither root. Both
 * nodes below pivot on the same sentinel key, which is absent from the oracle
 * database root and from the replay mock root, so `root.child(...).exists()` is false
 * on both sides and the two verdicts are stable. This verifies that `root` resolves
 * and that `exists()` on an absent child is false — a narrow claim, and the honest
 * ceiling for `root` under a run-scoped namespace. Verifying a populated `root`
 * lookup needs a rig that can seed outside the scenario subtree and mount both sides
 * at the same depth.
 *
 * Covers: the root binding.
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'cross-path `root` lookups are a staple of RTDB rules, and the simulator must resolve the root binding and report a missing child as absent exactly as production does; the sentinel keeps the claim mount-invariant across a run-scoped capture namespace and a replay mount at the root.',
  provenance:
    'Authored to close the rules-language construct gaps left by r1-r8, which never bound `root`. The sentinel-absence shape was chosen because the capture runner mounts the subtree under a per-run random namespace while the replay suite mounts it at the root, so only a path absent under both roots yields a mount-invariant verdict. Expectations are the production allow/deny verdicts recorded by the deploy-observe-restore capture in observations/rtdb-rules/rules-rtdb-r14-root-lookup.json.',
  rules: JSON.stringify({
    '.read': 'auth != null',
    rootabsent: {
      '.write': 'auth != null',
      '.validate': "root.child('pyric_absent_sentinel').exists() === false",
    },
    rootpresent: {
      '.write': 'auth != null',
      '.validate': "root.child('pyric_absent_sentinel').exists() === true",
    },
  }),
  cases: [
    { description: 'sentinel absent from the database root', expectation: 'ALLOW', operation: 'write', opPath: '/rootabsent', authPresent: true, newData: 1 },
    { description: 'sentinel cannot be found present at the database root', expectation: 'DENY', operation: 'write', opPath: '/rootpresent', authPresent: true, newData: 1 },
    { description: 'auth-gated read allowed', expectation: 'ALLOW', operation: 'read', opPath: '/rootabsent', authPresent: true },
  ],
};
