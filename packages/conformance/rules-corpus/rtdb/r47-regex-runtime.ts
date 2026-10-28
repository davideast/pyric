/**
 * ─── r47-regex-runtime ─────────────────────────────────────
 * How production evaluates matches() where JavaScript RegExp semantics may not
 * be production's:
 *
 *   - SP-1: ^ and $ in the middle of a pattern. Docs
 *     (https://firebase.google.com/docs/reference/security/database/regex):
 *     "^ and $ anchors only work if we're using them to match the first or last
 *     character in the pattern." pyric treats them as anchors anywhere, so an
 *     allow-list /^red$|^blue$/ grants 'red' and a deny-list
 *     !matches(/^admin$|^root$/) refuses 'admin'.
 *   - SP-7: $ before a trailing newline. JavaScript's $ (no m flag) matches only
 *     at the very end; java.util.regex's $ also matches before a final line
 *     terminator.
 *   - zero-observation coverage: the i flag at runtime, an unanchored pattern
 *     (docs: /^foo/ "checks whether the new data starts with the string foo"),
 *     and . against a newline.
 *
 * Production refuses mid-pattern anchors at deploy (r46), so SP-1 has no
 * runtime case here. r46 shows production accepts lookahead, negative
 * lookahead, backreference and \\b; the SP-2 cases ask how it evaluates them.
 * Captured 2026-10-26: production never grants on lookahead, negative
 * lookahead, backreference or \\b, its . matches a newline, and its $ does
 * not match before a trailing newline.
 */
import type { RtdbScenarioRecord } from './types.ts';

const validated = (regex: string, negate = false): Record<string, string> => ({
  '.write': 'auth != null',
  '.validate': `newData.isString() && ${negate ? '!' : ''}newData.val().matches(${regex})`,
});

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'matches() evaluates with JavaScript RegExp semantics; production documents that ^ and $ anchor only as the first or last character, and its $ / . newline handling is unobserved.',
  provenance:
    'Drafted from the 2026-10-26 RTDB simulator-vs-production hunt (SP-1, SP-7). Captured by deploy-observe-restore against pyric-oracle-rtdb on 2026-10-26 in observations/rtdb-rules/rules-rtdb-r47-regex-runtime.json.',
  rules: JSON.stringify({
    digit: validated('/^(?=.*[0-9]).+$/'),
    notadmin: validated('/^(?!admin).*$/'),
    twice: validated('/^(a)\\1$/'),
    word: validated('/\\bcat\\b/'),
    grouped: validated('/^(red|blue)$/'),
    slug: validated('/^[a-z]+$/'),
    dot: validated('/^a.b$/'),
    yes: validated('/^yes$/i'),
    prefix: validated('/foo/'),
  }),
  cases: [
    { description: 'SP-2: lookahead requiring a digit, no digit', expectation: 'DENY', operation: 'write', opPath: '/digit', authPresent: true, newData: 'abc' },
    { description: 'SP-2: lookahead requiring a digit, with a digit', expectation: 'DENY', operation: 'write', opPath: '/digit', authPresent: true, newData: 'ab1' },
    { description: 'SP-2: negative lookahead refusing admin, admin', expectation: 'DENY', operation: 'write', opPath: '/notadmin', authPresent: true, newData: 'admin' },
    { description: 'SP-2: negative lookahead refusing admin, guest', expectation: 'DENY', operation: 'write', opPath: '/notadmin', authPresent: true, newData: 'guest' },
    { description: 'SP-2: backreference, repeated group', expectation: 'DENY', operation: 'write', opPath: '/twice', authPresent: true, newData: 'aa' },
    { description: 'SP-2: backreference, single group', expectation: 'DENY', operation: 'write', opPath: '/twice', authPresent: true, newData: 'a' },
    { description: 'SP-2: word boundary, word inside a sentence', expectation: 'DENY', operation: 'write', opPath: '/word', authPresent: true, newData: 'a cat sat' },
    { description: 'SP-2: word boundary, word inside a longer word', expectation: 'DENY', operation: 'write', opPath: '/word', authPresent: true, newData: 'concatenate' },
    { description: 'SP-1 control: grouped alternation with outer anchors, listed word', expectation: 'ALLOW', operation: 'write', opPath: '/grouped', authPresent: true, newData: 'red' },
    { description: 'SP-1 control: grouped alternation with outer anchors, unlisted word', expectation: 'DENY', operation: 'write', opPath: '/grouped', authPresent: true, newData: 'green' },
    { description: 'SP-7: trailing newline under an anchored allow-list', expectation: 'DENY', operation: 'write', opPath: '/slug', authPresent: true, newData: 'abc\n' },
    { description: 'SP-7: embedded newline under an anchored allow-list', expectation: 'DENY', operation: 'write', opPath: '/slug', authPresent: true, newData: 'ab\nc' },
    { description: 'SP-7 control: lowercase word under an anchored allow-list', expectation: 'ALLOW', operation: 'write', opPath: '/slug', authPresent: true, newData: 'abc' },
    { description: 'dot does not match a newline', expectation: 'ALLOW', operation: 'write', opPath: '/dot', authPresent: true, newData: 'a\nb' },
    { description: 'i flag matches a different case at runtime', expectation: 'ALLOW', operation: 'write', opPath: '/yes', authPresent: true, newData: 'YES' },
    { description: 'an unanchored pattern matches inside the string', expectation: 'ALLOW', operation: 'write', opPath: '/prefix', authPresent: true, newData: 'xfoox' },
  ],
};
