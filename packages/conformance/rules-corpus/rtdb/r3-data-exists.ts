/**
 * ─── r3-data-exists ───────────────────────────────────────────────────────
 * `data.exists()` in a `.write` rule, under an ancestor `.write: auth != null`.
 * RTDB write rules CASCADE: an ancestor `.write` that evaluates true grants the
 * write regardless of a deeper rule, so production allows BOTH the empty-path
 * and the populated-path write even though the child rule is `!data.exists()`.
 * Decomposed from ruleset `r3-data-exists` of the frozen agreement
 * observation; expectations are the recorded production verdicts (both ALLOW,
 * via the ancestor grant). `mockData` seeds the pre-existing value for the
 * populated case.
 */
import type { RtdbPackRecord } from './types.ts';

export const pack: RtdbPackRecord = {
  fm: 'rtdb#71',
  rationale: 'ancestor .write cascade dominates a deeper !data.exists() rule — production allows the populated-path write, and the simulator must model the same cascade grant.',
  provenance: 'Decomposed from the rtdb-simulator-vs-prod-agreement observation, ruleset r3-data-exists. Expectations are the recorded production allow/deny verdicts.',
  rules: JSON.stringify({
    '.read': 'auth != null',
    '.write': 'auth != null',
    value: {
      '.write': '!data.exists()',
    },
  }),
  cases: [
    { description: 'write to empty path allowed (!data.exists)', expectation: 'ALLOW', operation: 'write', opPath: '/value', authPresent: true, newData: { v: 1 } },
    { description: 'write to populated path denied (data.exists)', expectation: 'ALLOW', operation: 'write', opPath: '/value', authPresent: true, newData: { v: 2 }, mockData: { v: 'preexisting' } },
    { description: 'read inherits ancestor (auth != null)', expectation: 'ALLOW', operation: 'read', opPath: '/value', authPresent: true },
  ],
};
