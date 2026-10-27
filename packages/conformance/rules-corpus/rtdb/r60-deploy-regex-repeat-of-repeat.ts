/**
 * ─── r60-deploy-regex-repeat-of-repeat ────────────────────────────────
 * A dry-run deploy probe (`PUT /.settings/rules.json?dryRun=true`) for one
 * of pyric's regex size limits: `(a{1000}){1000}`, a million states, past
 * pyric's 200,000-state limit.
 *
 * One pattern per scenario, run alone and spaced out: the first r57 draft
 * sent all four limit patterns at once and the oracle answered HTTP 429.
 * Drafted 2026-10-27 for #1247 (S1, review of #1261). Captured 2026-10-27
 * on pyric-oracle-rtdb-2 in
 * observations/rtdb-rules/rules-rtdb-r60-deploy-regex-repeat-of-repeat.json: production
 * refuses it, "Illegal regular expression, could not determinize efficiently".
 */
import type { RtdbDeployScenarioRecord } from './types.ts';

const subtree = (rules: Record<string, unknown>): string => JSON.stringify(rules);
const matching = (regex: string): string => subtree({ a: { '.write': `newData.val().matches(${regex})` } });
const construct = 'rtdb.semantic.regex-literal';


export const scenario: RtdbDeployScenarioRecord = {
  fm: 'rtdb#71',
  rationale: 'pyric refuses a pattern expanding past 200,000 matcher states; production has no recorded verdict for it.',
  provenance:
    'Drafted from the review of #1261 (#1247, S1). Captured by dry-run deploy against pyric-oracle-rtdb-2 on 2026-10-27 in observations/rtdb-rules/rules-rtdb-r60-deploy-regex-repeat-of-repeat.json.',
  deployCases: [
    { description: 'a repeat of a repeat, (a{1000}){1000}', construct, rules: matching('/^(a{1000}){1000}$/'), expectation: { verdict: 'REJECTED', error: 'Illegal regular expression, could not determinize efficiently' } },
  ],
};
