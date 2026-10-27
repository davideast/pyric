/**
 * ─── r50-regex-unsupported-semantics ───────────────────────────────────────
 * Follow-up to r47. Production deploys lookahead, negative lookahead,
 * backreference and \b (r46), then never grants on them (r47). These cases ask
 * which of three readings production uses:
 *
 *   - no match: matches() is false, so !matches() grants;
 *   - runtime error: the rule fails, so !matches() denies too;
 *   - literal characters: \b reads as "b" and \1 as "1".
 *
 * They also ask whether production's . matches a carriage return as well as
 * the newline r47 recorded.
 *
 * Captured 2026-10-26. matches() over these constructs is false, not an
 * error, so !matches() grants where pyric denies. \b reads as a literal b
 * (bcatb matches) and \1 as a literal 1 (a1 matches). Production's . matches a
 * carriage return as well as a newline.
 */
import type { RtdbScenarioRecord } from './types.ts';

const validated = (condition: string): Record<string, string> => ({
  '.write': 'auth != null',
  '.validate': `newData.isString() && ${condition}`,
});

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'production never grants on lookahead, backreference or \\b; whether matches() is false, errors, or reads the escapes literally decides whether !matches() over them is a hole pyric hides.',
  provenance:
    'Drafted from the 2026-10-26 RTDB simulator-vs-production hunt (SP-2b, SP-8) after r47. Captured by deploy-observe-restore against pyric-oracle-rtdb on 2026-10-26 in observations/rtdb-rules/rules-rtdb-r50-regex-unsupported-semantics.json.',
  rules: JSON.stringify({
    notlook: validated('!newData.val().matches(/^(?!admin).*$/)'),
    notahead: validated('!newData.val().matches(/^(?=.*[0-9]).+$/)'),
    notback: validated('!newData.val().matches(/^(a)\\1$/)'),
    notword: validated('!newData.val().matches(/\\bcat\\b/)'),
    word: validated('newData.val().matches(/\\bcat\\b/)'),
    back: validated('newData.val().matches(/^(a)\\1$/)'),
    lazy: validated('newData.val().matches(/^a+?$/)'),
    dot: validated('newData.val().matches(/^a.b$/)'),
    plain: validated('!newData.val().matches(/^admin$/)'),
  }),
  cases: [
    { description: 'SP-2b: !matches(negative lookahead) on guest', expectation: 'ALLOW', operation: 'write', opPath: '/notlook', authPresent: true, newData: 'guest' },
    { description: 'SP-2b: !matches(negative lookahead) on admin', expectation: 'ALLOW', operation: 'write', opPath: '/notlook', authPresent: true, newData: 'admin' },
    { description: 'SP-2b: !matches(lookahead) on a string with a digit', expectation: 'ALLOW', operation: 'write', opPath: '/notahead', authPresent: true, newData: 'ab1' },
    { description: 'SP-2b: !matches(backreference) on aa', expectation: 'ALLOW', operation: 'write', opPath: '/notback', authPresent: true, newData: 'aa' },
    { description: 'SP-2b: !matches(word boundary) on a cat sat', expectation: 'ALLOW', operation: 'write', opPath: '/notword', authPresent: true, newData: 'a cat sat' },
    { description: 'SP-2b: word boundary read as a literal b, on bcatb', expectation: 'ALLOW', operation: 'write', opPath: '/word', authPresent: true, newData: 'bcatb' },
    { description: 'SP-2b: backreference read as a literal 1, on a1', expectation: 'ALLOW', operation: 'write', opPath: '/back', authPresent: true, newData: 'a1' },
    { description: 'SP-2b: lazy quantifier on aaa', expectation: 'ALLOW', operation: 'write', opPath: '/lazy', authPresent: true, newData: 'aaa' },
    { description: 'SP-8: dot against a carriage return', expectation: 'ALLOW', operation: 'write', opPath: '/dot', authPresent: true, newData: 'a\rb' },
    { description: 'SP-8 control: dot against a letter', expectation: 'ALLOW', operation: 'write', opPath: '/dot', authPresent: true, newData: 'axb' },
    { description: 'control: !matches(plain anchored word) on guest', expectation: 'ALLOW', operation: 'write', opPath: '/plain', authPresent: true, newData: 'guest' },
    { description: 'control: !matches(plain anchored word) on admin', expectation: 'DENY', operation: 'write', opPath: '/plain', authPresent: true, newData: 'admin' },
  ],
};
