/**
 * ─── r53-deploy-regex-paren ───────────────────────────────────────────────
 * Dry-run deploy probes (`PUT /.settings/rules.json?dryRun=true`) for the
 * deploy error texts of malformed regex literals, which r44 observed only for
 * an unclosed group in an unanchored pattern (`/(/`: "expected ')' at position
 * 5").
 *
 * The r44 and r46 positions fit a parser that strips a leading `^` and a
 * trailing `$`, puts `.*` in place of each that is missing, and reports
 * dk.brics.automaton's errors over the result (`/(/` is parsed as `.*(.*`).
 * These cases test that reading: unmatched `)` and `(` with and without
 * anchors, an unclosed repeat count, an empty alternative left by the anchor
 * strip, and an empty character set.
 *
 * Captured 2026-10-27 in
 * observations/rtdb-rules/rules-rtdb-r53-deploy-regex-paren.json. Every
 * position fits that reading: `/^(/` fails at 3 (`(.*`), `/^(a$/` at 2
 * (`(a`), `/a(b/` at 7 (`.*a(b.*`), `/a{2/` at 5 and `/^[]$/` at 2. A stray
 * `)` fails "end-of-string expected" with no position, and after a leading
 * `^` it is a literal, so `/^)/` deploys.
 */
import type { RtdbDeployScenarioRecord } from './types.ts';

const subtree = (rules: Record<string, unknown>): string => JSON.stringify(rules);
const matching = (regex: string): string => subtree({ a: { '.write': `newData.val().matches(${regex})` } });
const construct = 'rtdb.semantic.regex-literal';

export const scenario: RtdbDeployScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'pyric reports unmatched parentheses in regex literals with positions only one production observation supports; anchored and stray-parenthesis positions, unclosed repeat counts, empty alternatives and empty character sets have no production text.',
  provenance:
    'Drafted from the 2026-10-26 RTDB hunt fix campaign (#1247, S1: SP-1, SP-2a). Captured by dry-run deploy against pyric-oracle-rtdb on 2026-10-27 in observations/rtdb-rules/rules-rtdb-r53-deploy-regex-paren.json.',
  deployCases: [
    { description: 'unmatched ) in an unanchored pattern (/)/)', construct, rules: matching('/)/'), expectation: { verdict: 'REJECTED', error: 'Illegal regular expression, end-of-string expected' } },
    { description: 'unmatched ) mid-pattern (/a)b/)', construct, rules: matching('/a)b/'), expectation: { verdict: 'REJECTED', error: 'Illegal regular expression, end-of-string expected' } },
    { description: 'unmatched ) after a leading ^ (/^)/)', construct, rules: matching('/^)/'), expectation: { verdict: 'ACCEPTED' } },
    { description: 'unclosed ( after a leading ^ (/^(/)', construct, rules: matching('/^(/'), expectation: { verdict: 'REJECTED', error: "Illegal regular expression, expected ')' at position 3" } },
    { description: 'unclosed ( between anchors (/^(a$/)', construct, rules: matching('/^(a$/'), expectation: { verdict: 'REJECTED', error: "Illegal regular expression, expected ')' at position 2" } },
    { description: 'unclosed ( mid-pattern (/a(b/)', construct, rules: matching('/a(b/'), expectation: { verdict: 'REJECTED', error: "Illegal regular expression, expected ')' at position 7" } },
    { description: 'unclosed repeat count (/a{2/)', construct, rules: matching('/a{2/'), expectation: { verdict: 'REJECTED', error: "Illegal regular expression, expected '}' at position 5" } },
    { description: 'empty alternative left by the anchor strip (/^a|$/)', construct, rules: matching('/^a|$/'), expectation: { verdict: 'REJECTED', error: 'Illegal regular expression, unexpected end-of-string' } },
    { description: 'empty character set (/^[]$/)', construct, rules: matching('/^[]$/'), expectation: { verdict: 'REJECTED', error: "Illegal regular expression, expected ']' at position 2" } },
    { description: 'control: anchored group (/^(a)$/)', construct, rules: matching('/^(a)$/'), expectation: { verdict: 'ACCEPTED' } },
  ],
};
