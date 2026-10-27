/**
 * ─── r46-deploy-regex-constructs ──────────────────────────────────────
 * Dry-run deploy probes for regular expression constructs the Firebase docs do
 * not list (https://firebase.google.com/docs/reference/security/database/regex):
 * lookahead, negative lookahead, backreference, word boundary, lazy quantifier,
 * a Unicode property class, and ^ / $ in the middle of a pattern ("^ and $
 * anchors only work if we're using them to match the first or last character in
 * the pattern."). pyric's load-time check accepts every one of them today.
 *
 * Expectations record the production dry-run verdicts and error texts captured
 * on 2026-10-26 in observations/rtdb-rules/rules-rtdb-r46-deploy-regex-constructs.json.
 * Production accepts lookahead, negative lookahead, backreference, \\b and lazy
 * quantifiers, and rejects \\p{..} and any ^ that is not the first character.
 */
import type { RtdbDeployScenarioRecord } from './types.ts';

const subtree = (rules: Record<string, unknown>): string => JSON.stringify(rules);
const matching = (regex: string): string => subtree({ a: { '.write': `newData.val().matches(${regex})` } });

export const scenario: RtdbDeployScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'regex constructs outside the documented set (lookahead, backreference, \\b, lazy quantifiers, \\p{..}, mid-pattern anchors) load in pyric and are evaluated with JavaScript RegExp semantics; production may refuse them at deploy.',
  provenance:
    'Drafted from the 2026-10-26 RTDB simulator-vs-production hunt (SP-1, SP-2). Captured by dry-run deploy against pyric-oracle-rtdb on 2026-10-26 in observations/rtdb-rules/rules-rtdb-r46-deploy-regex-constructs.json.',
  deployCases: [
    { description: 'SP-2: lookahead (?=...)', construct: 'rtdb.semantic.regex-literal', rules: matching('/^(?=.*[0-9]).+$/'), expectation: { verdict: 'ACCEPTED' } },
    { description: 'SP-2: negative lookahead (?!...)', construct: 'rtdb.semantic.regex-literal', rules: matching('/^(?!admin).*$/'), expectation: { verdict: 'ACCEPTED' } },
    { description: 'SP-2: backreference \\1', construct: 'rtdb.semantic.regex-literal', rules: matching('/^(a)\\1$/'), expectation: { verdict: 'ACCEPTED' } },
    { description: 'SP-2: word boundary \\b', construct: 'rtdb.semantic.regex-literal', rules: matching('/\\bcat\\b/'), expectation: { verdict: 'ACCEPTED' } },
    { description: 'SP-2: lazy quantifier +?', construct: 'rtdb.semantic.regex-literal', rules: matching('/^a+?$/'), expectation: { verdict: 'ACCEPTED' } },
    { description: 'SP-2: Unicode property class \\p{L}', construct: 'rtdb.semantic.regex-literal', rules: matching('/^\\p{L}+$/'), expectation: { verdict: 'REJECTED', error: 'Illegal regular expression, integer expected at position 3' } },
    { description: 'SP-1: ^ and $ inside an alternation (/^red$|^blue$/)', construct: 'rtdb.semantic.regex-literal', rules: matching('/^red$|^blue$/'), expectation: { verdict: 'REJECTED', error: 'Illegal regular expression, unescaped ^, ^ can only appear at the end of regular expressions' } },
    { description: 'SP-1: ^ inside a group (/(^a)/)', construct: 'rtdb.semantic.regex-literal', rules: matching('/(^a)/'), expectation: { verdict: 'REJECTED', error: 'Illegal regular expression, unescaped ^, ^ can only appear at the end of regular expressions' } },
    { description: 'control: documented anchored class (/^[a-z0-9-]+$/)', construct: 'rtdb.semantic.regex-literal', rules: matching('/^[a-z0-9-]+$/'), expectation: { verdict: 'ACCEPTED' } },
  ],
};
