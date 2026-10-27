/**
 * ─── r54-regex-alternation-runtime ─────────────────────────────────────────
 * How production applies its anchor rewrite to a top-level alternation.
 *
 * r44, r46 and r53 positions show production parses a pattern with a leading
 * `^` and a trailing `$` stripped and `.*` in place of each one missing, with
 * no group around the rest: `/a(b/` fails at position 7, the length of
 * `.*a(b.*`. Read that way, `/cat|dog/` is `.*cat|dog.*`, which matches a
 * string ending in cat or starting with dog but not `a cat here`, and
 * `/^a|b$/` is `a|b`, which matches only `a` or `b`. JavaScript reads both
 * as "contains either side". These cases ask which reading production uses.
 *
 * Captured 2026-10-27 in
 * observations/rtdb-rules/rules-rtdb-r54-regex-alternation-runtime.json:
 * production uses the ungrouped reading. `/cat|dog/` denies `a cat here` and
 * `hotdog` and allows `bobcat`, `dogs` and `cat`; `/^a|b$/` allows only `a`
 * of `ax`, `xb` and `a`.
 */
import type { RtdbScenarioRecord } from './types.ts';

const validated = (regex: string): Record<string, string> => ({
  '.write': 'auth != null',
  '.validate': `newData.isString() && newData.val().matches(${regex})`,
});

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'the anchor rewrite production applies has no group around the pattern, so an unanchored or half-anchored top-level alternation may not mean "contains either side" as it does in JavaScript; no runtime case has observed it.',
  provenance:
    'Drafted from the 2026-10-26 RTDB hunt fix campaign (#1247, S1: SP-2b follow-up). Captured by deploy-observe-restore against pyric-oracle-rtdb on 2026-10-27 in observations/rtdb-rules/rules-rtdb-r54-regex-alternation-runtime.json.',
  rules: JSON.stringify({
    either: validated('/cat|dog/'),
    halves: validated('/^a|b$/'),
    grouped: validated('/(cat|dog)/'),
  }),
  cases: [
    { description: 'unanchored alternation, first word mid-string', expectation: 'DENY', operation: 'write', opPath: '/either', authPresent: true, newData: 'a cat here' },
    { description: 'unanchored alternation, first word at the end', expectation: 'ALLOW', operation: 'write', opPath: '/either', authPresent: true, newData: 'bobcat' },
    { description: 'unanchored alternation, second word at the start', expectation: 'ALLOW', operation: 'write', opPath: '/either', authPresent: true, newData: 'dogs' },
    { description: 'unanchored alternation, second word at the end', expectation: 'DENY', operation: 'write', opPath: '/either', authPresent: true, newData: 'hotdog' },
    { description: 'unanchored alternation, first word alone', expectation: 'ALLOW', operation: 'write', opPath: '/either', authPresent: true, newData: 'cat' },
    { description: 'half-anchored alternation, first side as a prefix', expectation: 'DENY', operation: 'write', opPath: '/halves', authPresent: true, newData: 'ax' },
    { description: 'half-anchored alternation, second side as a suffix', expectation: 'DENY', operation: 'write', opPath: '/halves', authPresent: true, newData: 'xb' },
    { description: 'half-anchored alternation, first side alone', expectation: 'ALLOW', operation: 'write', opPath: '/halves', authPresent: true, newData: 'a' },
    { description: 'control: grouped alternation, first word mid-string', expectation: 'ALLOW', operation: 'write', opPath: '/grouped', authPresent: true, newData: 'a cat here' },
    { description: 'control: grouped alternation, no word', expectation: 'DENY', operation: 'write', opPath: '/grouped', authPresent: true, newData: 'a cow here' },
  ],
};
