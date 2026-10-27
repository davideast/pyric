/**
 * ─── r59-deploy-regex-count-100000 ────────────────────────────────────
 * A dry-run deploy probe (`PUT /.settings/rules.json?dryRun=true`) for one
 * of pyric's regex size limits: a repeat count of 100,000, inside pyric's
 * 200,000-state limit.
 *
 * One pattern per scenario, run alone and spaced out: the first r57 draft
 * sent all four limit patterns at once and the oracle answered HTTP 429.
 * Drafted 2026-10-27 for #1247 (S1, review of #1261). The expectation is
 * pyric's verdict, a placeholder until the capture replaces it in
 * observations/rtdb-rules/rules-rtdb-r59-deploy-regex-count-100000.json.
 */
import type { RtdbDeployScenarioRecord } from './types.ts';

const subtree = (rules: Record<string, unknown>): string => JSON.stringify(rules);
const matching = (regex: string): string => subtree({ a: { '.write': `newData.val().matches(${regex})` } });
const construct = 'rtdb.semantic.regex-literal';

export const scenario: RtdbDeployScenarioRecord = {
  fm: 'rtdb#71',
  rationale: 'pyric loads a repeat count of 100,000; production has no recorded verdict for it.',
  provenance:
    'Drafted from the review of #1261 (#1247, S1). Awaiting a dry-run deploy capture against pyric-oracle-rtdb into observations/rtdb-rules/rules-rtdb-r59-deploy-regex-count-100000.json.',
  deployCases: [
    { description: 'a repeat count of 100000', construct, rules: matching('/^a{100000}$/'), expectation: { verdict: 'ACCEPTED' } },
  ],
};
