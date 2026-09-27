/**
 * ─── Scenario 2: string-literals-and-regex ────────────────────────────────────
 * Targets Class B (matches-string-escape) — surfaced 2026-05-02 by
 * email_domain_validation × gemma4:26b. Models writing `.matches('...\\.com')`
 * expect production semantics: `\\` escapes to `\`, then `\.` is a literal-dot
 * regex pattern. Pre-fix the simulator did not process string escapes, so
 * `\\.` reached `new RegExp()` as `\\.` (literal backslash + any char) and
 * silently denied every email-domain check.
 * The matches() cases use only escape forms production accepts (`\\` and no
 * escape). The lone-backslash forms `\.` and `@acme\.com` are syntax errors
 * in production — those are tracked separately as Bug 2 in REBUILD_PLAN.md
 * (sim accepts unknown escapes that prod rejects); they cannot be exercised
 * here without making the entire scenario throw at the prod call boundary.
 *
 * The stringEscape cases cover the escapes production accepts in a string
 * literal, one `allow get` condition per path. A backslash escapes a
 * backslash, either quote, `n`, `r`, `t`, `b`, or `f`. `\x` takes exactly two
 * hexadecimal digits of either case and `\` takes three octal digits up to
 * `\377`; each is the code point of that value, not a byte, so `'\xe9'`
 * equals `'é'` and `'\xc3\xa9'` is two characters. `\u` takes exactly four
 * hexadecimal digits of either case and is one UTF-16 code unit: two `\u`
 * escapes form a surrogate pair, and `size()` counts code units. A raw tab is
 * a plain character.
 *
 * Production rejects these forms when the ruleset is submitted, so they
 * cannot appear in a scenario: `'\/'` ("Missing 'match' keyword before
 * path"), `'\a'`, `'\v'`, `'\?'`, `'\d'`, `'\.'`, a backslash before a
 * backtick, `'\0'`, `'\12'`, `'\400'`, `'\x4'`, `'\x4g'`, `'\X41'`, `\u` with
 * fewer than four hexadecimal digits or none, `'\u{41}'`, `'\U0001F600'`, and
 * a raw line feed or carriage return inside the quotes. The shared grammar
 * rejects the same forms, pinned by
 * packages/pyric/test/rules/grammar/string-escape-strict.test.ts.
 */
import type { ScenarioRecord } from './types.ts';

interface StringEscapeCase {
  key: string;
  condition: string;
  expectation: 'ALLOW' | 'DENY';
}

const stringEscapes: StringEscapeCase[] = [
  { key: 'hexEscape', condition: "'\\x41' == 'A' && '\\x4a' == 'J' && '\\x4A' == 'J'", expectation: 'ALLOW' },
  { key: 'hexEscapeTwoDigits', condition: "'\\x411' == 'A1' && '\\x41'.size() == 1", expectation: 'ALLOW' },
  { key: 'hexEscapeCodePoint', condition: "'\\xe9' == 'é' && '\\xe9'.toUtf8() == b'\\xc3\\xa9'", expectation: 'ALLOW' },
  { key: 'hexEscapeNotUtf8', condition: "'\\xc3\\xa9' == 'é'", expectation: 'DENY' },
  { key: 'hexEscapeSize', condition: "'\\xc3\\xa9'.size() == 2", expectation: 'ALLOW' },
  { key: 'unicodeEscape', condition: "'\\u0041' == 'A' && \"\\u0041\" == 'A' && '\\u00411' == 'A1'", expectation: 'ALLOW' },
  { key: 'unicodeEscapeNonAscii', condition: "'\\u00e9' == 'é' && '\\u00E9' == 'é' && '\\u00e9'.size() == 1", expectation: 'ALLOW' },
  { key: 'unicodeEscapeUtf8', condition: "'\\u00e9'.toUtf8().toHexString() == 'C3A9'", expectation: 'ALLOW' },
  { key: 'unicodeEscapeOneUnit', condition: "'\\u00e9'.size() == 2", expectation: 'DENY' },
  { key: 'unicodeEscapeCjk', condition: "'\\u65e5\\u672c' == '日本'", expectation: 'ALLOW' },
  { key: 'unicodeSurrogatePair', condition: "'\\ud83d\\ude00' == '😀' && '\\ud83d\\ude00'.size() == 2", expectation: 'ALLOW' },
  { key: 'octalEscape', condition: "'\\101' == 'A' && '\\101'.size() == 1 && '\\012' == '\\n'", expectation: 'ALLOW' },
  { key: 'octalEscapeMax', condition: "'\\377' == '\\u00ff' && '\\377' == '\\xff' && '\\377'.toUtf8().toHexString() == 'C3BF'", expectation: 'ALLOW' },
  { key: 'octalEscapeZero', condition: "'\\000'.size() == 1 && '\\000' == '\\u0000'", expectation: 'ALLOW' },
  { key: 'backspaceFormFeed', condition: "'\\b' == '\\u0008' && '\\f' == '\\u000c' && '\\b\\f'.toUtf8().toHexString() == '080C'", expectation: 'ALLOW' },
  { key: 'simpleEscapes', condition: "'\\\\\\'\\\"\\n\\r\\t'.toUtf8().toHexString() == '5C27220A0D09'", expectation: 'ALLOW' },
  { key: 'doubleQuotedMix', condition: "\"\\x41\\u0041\\101\" == 'AAA'", expectation: 'ALLOW' },
  { key: 'rawTab', condition: "'a\tb'.size() == 3 && 'a\tb' == 'a\\tb'", expectation: 'ALLOW' },
];

const stringEscapeBlocks = stringEscapes
  .map(({ key, condition }) => `    match /stringEscape/${key}/{id} {
      allow get: if ${condition};
    }`)
  .join('\n');

export const scenario: ScenarioRecord = {
  fm: 'Class B',
  rationale: 'Pre-fix the simulator forwarded raw `\\\\.` to RegExp without unescaping; production-style `.matches(\'...\\\\.com\')` denied silently. String literals decode the escapes production accepts: \\x and octal as code points, \\u as one UTF-16 code unit, and \\b and \\f.',
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /escapedAllow/{id} {
      allow read: if request.auth.token.email.matches('.*@acme\\\\.com');
    }
    match /escapedDeny/{id} {
      allow read: if request.auth.token.email.matches('.*@acme\\\\.com');
    }
    match /unescapedAllow/{id} {
      allow read: if request.auth.token.email.matches('.*@acme.com');
    }
    match /tabReject/{id} {
      allow read: if !request.auth.token.name.matches('.*\\t.*');
    }
${stringEscapeBlocks}
  }
}`,
  cases: [
    {
      description: "matches('.*@acme\\\\.com') vs alice@acme.com → ALLOW",
      expectation: 'ALLOW',
      method: 'get',
      path: 'escapedAllow/d1',
      auth: { uid: 'alice', token: { email: 'alice@acme.com' } },
    },
    {
      description: "matches('.*@acme\\\\.com') vs bob@other.com → DENY",
      expectation: 'DENY',
      method: 'get',
      path: 'escapedDeny/d2',
      auth: { uid: 'bob', token: { email: 'bob@other.com' } },
    },
    {
      description: "matches('.*@acme.com') vs alice@acme.com → ALLOW (no-escape control)",
      expectation: 'ALLOW',
      method: 'get',
      path: 'unescapedAllow/d3',
      auth: { uid: 'alice', token: { email: 'alice@acme.com' } },
    },
    {
      description: "!matches('.*\\t.*') vs name without tab → ALLOW (tab escape literal)",
      expectation: 'ALLOW',
      method: 'get',
      path: 'tabReject/d4',
      auth: { uid: 'alice', token: { name: 'Alice Smith' } },
    },
    ...stringEscapes.map(({ key, condition, expectation }) => ({
      description: `${condition} → ${expectation}`,
      expectation,
      method: 'get' as const,
      path: `stringEscape/${key}/d`,
      auth: { uid: 'alice' },
    })),
  ],
  group: 'stress',
};
