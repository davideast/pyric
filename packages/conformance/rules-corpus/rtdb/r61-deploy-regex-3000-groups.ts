/**
 * ─── r61-deploy-regex-3000-groups ─────────────────────────────────────
 * A dry-run deploy probe (`PUT /.settings/rules.json?dryRun=true`) for one
 * of pyric's regex size limits: 3,000 nested groups, past pyric's
 * 1,000-level nesting limit.
 *
 * One pattern per scenario, run alone and spaced out: the first r57 draft
 * sent all four limit patterns at once and the oracle answered HTTP 429.
 * Drafted 2026-10-27 for #1247 (S1, review of #1261). Not captured: the
 * dry run on pyric-oracle-rtdb-2 timed out after 300 s and rate-limited the
 * rules endpoint (HTTP 429), as the first r57 draft did. On digame-mas on
 * 2026-10-30 it timed out three times at 120 s (#1692). The expectation is
 * pyric's own nesting limit, unobserved.
 *
 * The rig sends this scenario after every other one, once, with a 300 s
 * limit, because a repeat sends the request that sets off the throttling.
 * When production does not answer in that time, this scenario produces no
 * observation: no file is written for it, the rig waits 10 minutes before
 * its next rules call, the run writes every other scenario's file, and it
 * exits non-zero. Whether "no answer within 300 s" should be recorded as
 * production's verdict is the corpus owner's decision, and no such verdict
 * kind exists today.
 */
import type { RtdbDeployScenarioRecord } from './types.ts';

const subtree = (rules: Record<string, unknown>): string => JSON.stringify(rules);
const matching = (regex: string): string => subtree({ a: { '.write': `newData.val().matches(${regex})` } });
const construct = 'rtdb.semantic.regex-literal';

const NESTING =
  'Regular expression groups and quantifiers nest more than 1000 levels deep: pyric reads at most 1000, a limit of pyric, not of production.';

export const scenario: RtdbDeployScenarioRecord = {
  fm: 'rtdb#71',
  rationale: 'pyric refuses groups nested past 1,000 levels; production has no recorded verdict for it.',
  provenance:
    'Drafted from the review of #1261 (#1247, S1). The dry run timed out after 300 s and rate-limited the rules endpoint; no observation exists. The rig sends it once, last, and writes no file when production does not answer (#1692).',
  largeRuleset: { timeoutMs: 300_000, attempts: 1, noAnswer: { cooldownMs: 600_000 } },
  deployCases: [
    { description: '3000 nested groups', construct, rules: matching(`/^${'('.repeat(3000)}a${')'.repeat(3000)}$/`), expectation: { verdict: 'REJECTED', error: NESTING } },
  ],
};
