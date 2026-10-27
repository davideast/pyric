/**
 * ─── r57-deploy-regex-limits-and-operators ────────────────────────────────
 * Dry-run deploy probes (`PUT /.settings/rules.json?dryRun=true`) for:
 *
 *   - the size limits pyric puts on a regex literal: a 100,000 repeat count
 *     (inside pyric's 200,000-state limit), a count of 2^31 (past Java's
 *     `Integer.parseInt`), `(a{1000}){1000}` (past the state limit) and 3,000
 *     nested groups (past pyric's 1,000-level nesting limit);
 *   - `"` and `<`, which dk.brics reads as operators (a quoted string and a
 *     numeric interval or named automaton) under its full syntax, so an
 *     unclosed one could fail at deploy. r56 keeps them out of its runtime
 *     ruleset for that reason;
 *   - `^` and `$` inside a character set, which pyric's anchor check skips.
 *
 * Drafted 2026-10-27 for #1247 (S1, review of #1261). Expectations are
 * pyric's verdicts and texts, placeholders until the capture replaces them in
 * observations/rtdb-rules/rules-rtdb-r57-deploy-regex-limits-and-operators.json.
 */
import type { RtdbDeployScenarioRecord } from './types.ts';

const subtree = (rules: Record<string, unknown>): string => JSON.stringify(rules);
const matching = (regex: string): string => subtree({ a: { '.write': `newData.val().matches(${regex})` } });
const construct = 'rtdb.semantic.regex-literal';
const nested = (depth: number): string => `${'('.repeat(depth)}a${')'.repeat(depth)}`;

const STATES =
  'Regular expression expands to more than 200000 matcher states: pyric matches at most 200000, a limit of pyric, not of production.';
const NESTING =
  'Regular expression groups and quantifiers nest more than 1000 levels deep: pyric reads at most 1000, a limit of pyric, not of production.';

export const scenario: RtdbDeployScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'pyric refuses regex literals past its own size limits and reads " < and an in-set ^ or $ as plain characters; production has no recorded verdict for any of them.',
  provenance:
    'Drafted from the review of #1261 (#1247, S1). Awaiting a dry-run deploy capture against pyric-oracle-rtdb into observations/rtdb-rules/rules-rtdb-r57-deploy-regex-limits-and-operators.json.',
  deployCases: [
    { description: 'a repeat count of 100000 (/^a{100000}$/)', construct, rules: matching('/^a{100000}$/'), expectation: { verdict: 'ACCEPTED' } },
    { description: 'a repeat count of 2^31 (/^a{2147483648}$/)', construct, rules: matching('/^a{2147483648}$/'), expectation: { verdict: 'REJECTED', error: 'Regular expression repeat count 2147483648 is larger than 2147483647, the largest count pyric reads.' } },
    { description: 'a repeat of a repeat, (a{1000}){1000}', construct, rules: matching('/^(a{1000}){1000}$/'), expectation: { verdict: 'REJECTED', error: STATES } },
    { description: '3000 nested groups', construct, rules: matching(`/^${nested(3000)}$/`), expectation: { verdict: 'REJECTED', error: NESTING } },
    { description: 'control: 1000 nested groups', construct, rules: matching(`/^${nested(1000)}$/`), expectation: { verdict: 'ACCEPTED' } },
    { description: 'a double quote (/^a"b$/)', construct, rules: matching('/^a"b$/'), expectation: { verdict: 'ACCEPTED' } },
    { description: 'a less-than sign (/^a<b$/)', construct, rules: matching('/^a<b$/'), expectation: { verdict: 'ACCEPTED' } },
    { description: 'a ^ inside a set, not first (/^[a^]$/)', construct, rules: matching('/^[a^]$/'), expectation: { verdict: 'ACCEPTED' } },
    { description: 'a $ alone in a set (/^[$]$/)', construct, rules: matching('/^[$]$/'), expectation: { verdict: 'ACCEPTED' } },
  ],
};
