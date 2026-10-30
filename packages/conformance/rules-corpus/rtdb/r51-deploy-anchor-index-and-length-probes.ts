/**
 * ─── r51-deploy-anchor-index-and-length-probes ─────────────────────────────
 * Dry-run deploy probes (`PUT /.settings/rules.json?dryRun=true`) left open by
 * the 2026-10-26 hunt:
 *
 *   - SP-1 follow-up: r46 shows production refuses a `^` that is not the first
 *     character. Does it also refuse a `$` that is not the last?
 *   - CS lead: `.indexOn` naming a dotted child or an empty string. pyric's
 *     lint says nothing about either.
 *   - LD-7: a long `||` chain. pyric's parser turns a stack overflow into
 *     PARSE_ERROR, so under Node (which overflows near 500 terms; bun reads
 *     2,000) lint refuses the chain; this asks whether production deploys
 *     500, 501 and 2,000 terms.
 *
 * Captured 2026-10-26: production refuses a $ that is not last (with the
 * same error text as for ^) and an .indexOn naming a dotted child, accepts an
 * empty .indexOn entry, and deploys 501- and 2,000-term chains.
 */
import type { RtdbDeployScenarioRecord } from './types.ts';

const subtree = (rules: Record<string, unknown>): string => JSON.stringify(rules);
const matching = (regex: string): string => subtree({ a: { '.write': `newData.val().matches(${regex})` } });
const chain = (terms: number): string =>
  Array.from({ length: terms }, (_, i) => `auth.uid == 'u${i}'`).join(' || ');

export const scenario: RtdbDeployScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'mid-pattern $, dotted or empty .indexOn entries, and long || chains are accepted or refused by pyric without a production verdict to compare.',
  provenance:
    'Drafted from the 2026-10-26 RTDB hunt (SP-1 follow-up, contract-sweep .indexOn lead, LD-7). Captured by dry-run deploy against pyric-oracle-rtdb on 2026-10-26 in observations/rtdb-rules/rules-rtdb-r51-deploy-anchor-index-and-length-probes.json.',
  // Production takes long enough on the 2,000-term chain that the rig runs this
  // scenario after the others, with an explicit limit per dry run.
  largeRuleset: { timeoutMs: 120_000 },
  deployCases: [
    { description: 'SP-1: $ before an alternation (/a$|b/)', construct: 'rtdb.semantic.regex-literal', rules: matching('/a$|b/'), expectation: { verdict: 'REJECTED', error: 'Illegal regular expression, unescaped ^, ^ can only appear at the end of regular expressions' } },
    { description: 'SP-1: $ inside a group (/(a$)/)', construct: 'rtdb.semantic.regex-literal', rules: matching('/(a$)/'), expectation: { verdict: 'REJECTED', error: 'Illegal regular expression, unescaped ^, ^ can only appear at the end of regular expressions' } },
    { description: 'SP-1 control: escaped $ in the middle (/a\\$b/)', construct: 'rtdb.semantic.regex-literal', rules: matching('/a\\$b/'), expectation: { verdict: 'ACCEPTED' } },
    { description: 'CS lead: .indexOn naming a dotted child', construct: 'rtdb.rule-kind.indexOn', rules: subtree({ a: { '.indexOn': ['x.y'] } }), expectation: { verdict: 'REJECTED', error: 'Invalid key: x.y. Index must be either .value or declared on a valid path' } },
    { description: 'CS lead: .indexOn naming an empty string', construct: 'rtdb.rule-kind.indexOn', rules: subtree({ a: { '.indexOn': [''] } }), expectation: { verdict: 'ACCEPTED' } },
    { description: 'CS lead control: .indexOn naming a nested child path', construct: 'rtdb.rule-kind.indexOn', rules: subtree({ a: { '.indexOn': ['x/y'] } }), expectation: { verdict: 'ACCEPTED' } },
    { description: 'LD-7: a 501-term || chain', construct: 'rtdb.operator.or', rules: subtree({ a: { '.read': chain(501) } }), expectation: { verdict: 'ACCEPTED' } },
    { description: 'LD-7: a 2000-term || chain', construct: 'rtdb.operator.or', rules: subtree({ a: { '.read': chain(2000) } }), expectation: { verdict: 'ACCEPTED' } },
    { description: 'LD-7 control: a 500-term || chain', construct: 'rtdb.operator.or', rules: subtree({ a: { '.read': chain(500) } }), expectation: { verdict: 'ACCEPTED' } },
  ],
};
