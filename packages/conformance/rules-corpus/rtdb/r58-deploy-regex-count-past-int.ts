/**
 * ─── r58-deploy-regex-count-past-int ──────────────────────────────────
 * A dry-run deploy probe (`PUT /.settings/rules.json?dryRun=true`) for one
 * of pyric's regex size limits: a repeat count of 2^31, one past what Java
 * `Integer.parseInt` reads.
 *
 * One pattern per scenario, run alone and spaced out: the first r57 draft
 * sent all four limit patterns at once and the oracle answered HTTP 429.
 * Drafted 2026-10-27 for #1247 (S1, review of #1261). The expectation is
 * pyric's verdict, a placeholder until the capture replaces it in
 * observations/rtdb-rules/rules-rtdb-r58-deploy-regex-count-past-int.json.
 */
import type { RtdbDeployScenarioRecord } from './types.ts';

const subtree = (rules: Record<string, unknown>): string => JSON.stringify(rules);
const matching = (regex: string): string => subtree({ a: { '.write': `newData.val().matches(${regex})` } });
const construct = 'rtdb.semantic.regex-literal';

export const scenario: RtdbDeployScenarioRecord = {
  fm: 'rtdb#71',
  rationale: 'pyric refuses a repeat count past 2^31-1; production has no recorded verdict for it.',
  provenance:
    'Drafted from the review of #1261 (#1247, S1). Awaiting a dry-run deploy capture against pyric-oracle-rtdb into observations/rtdb-rules/rules-rtdb-r58-deploy-regex-count-past-int.json.',
  deployCases: [
    { description: 'a repeat count of 2^31', construct, rules: matching('/^a{2147483648}$/'), expectation: { verdict: 'REJECTED', error: 'Regular expression repeat count 2147483648 is larger than 2147483647, the largest count pyric reads.' } },
  ],
};
