/**
 * The real-database probe for row firestore-rules#190: a batch that updates
 * one field of a companion document beside a create whose rule reads both that
 * field and an untouched one through getAfter().
 *
 * The browser probe in `run-firestore-real.ts` and the local replay test both
 * run this plan, so the local verdicts are compared against production for the
 * same seed, writes and rules (`injectFirestoreProbeRules`).
 */

export type ProbeData = Record<string, unknown>;

export interface ProbeWrite {
  method: 'set' | 'update';
  path: string;
  data: ProbeData;
}

export interface SiblingMergeProbePlan {
  /** Documents the admin SDK writes before the browser signs in. */
  seed: Record<string, ProbeData>;
  /** The create alone, before the batch: the DENY control. */
  soloPrimary: ProbeWrite;
  /** Updates only `modified`; `role` must survive into getAfter(). */
  batch: ProbeWrite[];
  /** Updates both fields: the ALLOW control for the batch rule wiring. */
  fullBatch: ProbeWrite[];
}

export type ProbeVerdict = 'ALLOW' | 'DENY';

export interface SiblingMergeVerdicts {
  soloPrimary: ProbeVerdict;
  batch: ProbeVerdict;
  fullBatch: ProbeVerdict;
}

const PRIMARY_DATA: ProbeData = { action: 'update_config' };

/** Case ids under `rules_get_after/` that this probe writes. */
export const SIBLING_MERGE_CASE_IDS = [
  'sibling_merge_companion',
  'sibling_merge_primary',
  'sibling_merge_solo',
  'sibling_merge_full_companion',
  'sibling_merge_full_primary',
] as const;

export function siblingMergeProbePlan(runId: string): SiblingMergeProbePlan {
  const base = `__pyric_firestore_cdd/${runId}/rules_get_after`;
  return {
    seed: {
      [`${base}/sibling_merge_companion`]: { role: 'admin', modified: false },
      [`${base}/sibling_merge_full_companion`]: { role: 'viewer', modified: false },
    },
    soloPrimary: { method: 'set', path: `${base}/sibling_merge_solo`, data: PRIMARY_DATA },
    batch: [
      { method: 'update', path: `${base}/sibling_merge_companion`, data: { modified: true } },
      { method: 'set', path: `${base}/sibling_merge_primary`, data: PRIMARY_DATA },
    ],
    fullBatch: [
      {
        method: 'update',
        path: `${base}/sibling_merge_full_companion`,
        data: { role: 'admin', modified: true },
      },
      { method: 'set', path: `${base}/sibling_merge_full_primary`, data: PRIMARY_DATA },
    ],
  };
}

function requireVerdict(name: string, actual: unknown, expected: ProbeVerdict): void {
  if (actual === expected) return;
  throw new Error(
    `${name} control answered ${JSON.stringify(actual)}, expected ${expected}; refusing to record the capture`,
  );
}

/**
 * Refuse a capture whose controls did not discriminate. A broad allow in the
 * project's base rules, or a wrong injected rule, would otherwise record an
 * ALLOW that proves nothing.
 */
export function assertGetAfterProbeControls(browserBehavior: Record<string, unknown>): void {
  requireVerdict('rulesGetAfterSoloPrimary', browserBehavior.rulesGetAfterSoloPrimary, 'DENY');
  requireVerdict(
    'rulesGetAfterSiblingMergeSoloPrimary',
    browserBehavior.rulesGetAfterSiblingMergeSoloPrimary,
    'DENY',
  );
  requireVerdict(
    'rulesGetAfterSiblingMergeFullBatch',
    browserBehavior.rulesGetAfterSiblingMergeFullBatch,
    'ALLOW',
  );
}
