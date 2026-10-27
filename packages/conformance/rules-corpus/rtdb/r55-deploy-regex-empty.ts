/**
 * ─── r55-deploy-regex-empty ───────────────────────────────────────────────
 * Dry-run deploy probes (`PUT /.settings/rules.json?dryRun=true`) for
 * patterns the anchor rewrite leaves empty or nearly empty. `/^$/` strips to
 * an empty pattern, the usual "the empty string" check; `/^/` and `/$/` strip
 * to `.*`. r53 shows `/^a|$/` fails "unexpected end-of-string" once its `$`
 * is stripped, so these ask whether an empty pattern fails the same way.
 *
 * Drafted 2026-10-27 for #1247 (S1). Expectations are pyric's verdicts,
 * placeholders until the capture replaces them in
 * observations/rtdb-rules/rules-rtdb-r55-deploy-regex-empty.json.
 */
import type { RtdbDeployScenarioRecord } from './types.ts';

const subtree = (rules: Record<string, unknown>): string => JSON.stringify(rules);
const matching = (regex: string): string => subtree({ a: { '.write': `newData.val().matches(${regex})` } });
const construct = 'rtdb.semantic.regex-literal';

export const scenario: RtdbDeployScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'a pattern the anchor rewrite leaves empty (/^$/) may load or fail like the empty alternative r53 recorded; pyric loads it as the empty string.',
  provenance:
    'Drafted from the 2026-10-26 RTDB hunt fix campaign (#1247, S1). Awaiting a dry-run deploy capture against pyric-oracle-rtdb into observations/rtdb-rules/rules-rtdb-r55-deploy-regex-empty.json.',
  deployCases: [
    { description: 'empty pattern between anchors (/^$/)', construct, rules: matching('/^$/'), expectation: { verdict: 'ACCEPTED' } },
    { description: 'a lone ^ (/^/)', construct, rules: matching('/^/'), expectation: { verdict: 'ACCEPTED' } },
    { description: 'a lone $ (/$/)', construct, rules: matching('/$/'), expectation: { verdict: 'ACCEPTED' } },
    { description: 'empty group between anchors (/^()$/)', construct, rules: matching('/^()$/'), expectation: { verdict: 'ACCEPTED' } },
  ],
};
