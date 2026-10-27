/**
 * ─── r57-deploy-regex-operators ───────────────────────────────────────────
 * Dry-run deploy probes (`PUT /.settings/rules.json?dryRun=true`) for `"` and
 * `<`, which dk.brics reads as operators (a quoted string, and a numeric
 * interval or named automaton) under its full syntax, so an unclosed one
 * could fail at deploy; r56 shows `& ~ # @ >` are plain characters. Also `^`
 * and `$` inside a character set, which pyric's anchor check skips.
 *
 * Split from the first r57 draft, whose limit patterns hit the oracle's rate
 * limit; the limits are r58 to r61, one pattern each. Drafted 2026-10-27 for
 * #1247 (S1, review of #1261). Expectations are pyric's verdicts,
 * placeholders until the capture replaces them in
 * observations/rtdb-rules/rules-rtdb-r57-deploy-regex-operators.json.
 */
import type { RtdbDeployScenarioRecord } from './types.ts';

const subtree = (rules: Record<string, unknown>): string => JSON.stringify(rules);
const matching = (regex: string): string => subtree({ a: { '.write': `newData.val().matches(${regex})` } });
const construct = 'rtdb.semantic.regex-literal';

export const scenario: RtdbDeployScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'pyric reads " and < and an in-set ^ or $ as plain characters; production has no recorded verdict for any of them.',
  provenance:
    'Drafted from the review of #1261 (#1247, S1). Awaiting a dry-run deploy capture against pyric-oracle-rtdb into observations/rtdb-rules/rules-rtdb-r57-deploy-regex-operators.json.',
  deployCases: [
    { description: 'a double quote (/^a"b$/)', construct, rules: matching('/^a"b$/'), expectation: { verdict: 'ACCEPTED' } },
    { description: 'a less-than sign (/^a<b$/)', construct, rules: matching('/^a<b$/'), expectation: { verdict: 'ACCEPTED' } },
    { description: 'a ^ inside a set, not first (/^[a^]$/)', construct, rules: matching('/^[a^]$/'), expectation: { verdict: 'ACCEPTED' } },
    { description: 'a $ alone in a set (/^[$]$/)', construct, rules: matching('/^[$]$/'), expectation: { verdict: 'ACCEPTED' } },
  ],
};
