/**
 * ─── Candidate scenario (hunt H1, ST-H1-3): h1-regex-re2-classes ─────────────
 * string.matches() on RE2 constructs the shared Thompson-NFA matcher
 * (rules/simulator/rules-type.ts re2FullMatch) reads with JavaScript RegExp
 * semantics: POSIX bracket classes, one-letter Unicode classes, \Q...\E,
 * ASCII-only \s, `.` against \r, and Unicode case folding under (?i).
 *
 * Conditions are plain JS strings with doubled backslashes (Bun rewrites
 * non-ASCII and \u escapes inside String.raw), so "'\\\\s'" is the rules string
 * literal '\\s' whose value is the regex \s, and "'\\u00a0'" is the rules
 * literal ' ' (NBSP). `expectation` is RE2's documented answer; pyric's
 * decision is the fourth column.
 */
import type { StorageScenarioRecord } from './types.ts';

const cases: ReadonlyArray<readonly [key: string, condition: string, re2: 'ALLOW' | 'DENY', pyric: 'ALLOW' | 'DENY']> = [
  ['posix-alpha-letter', "'x'.matches('[[:alpha:]]')", 'ALLOW', 'DENY'],
  ['posix-alpha-two-chars', "'a]'.matches('[[:alpha:]]')", 'DENY', 'ALLOW'],
  ['posix-alpha-colon', "':]'.matches('[[:alpha:]]')", 'DENY', 'ALLOW'],
  ['unicode-class-one-letter', "'x'.matches('\\\\pL')", 'ALLOW', 'DENY'],
  ['unicode-class-one-letter-literal', "'pL'.matches('\\\\pL')", 'DENY', 'ALLOW'],
  ['space-class-nbsp', "'\\u00a0'.matches('\\\\s')", 'DENY', 'ALLOW'],
  ['space-class-em-space', "'\\u2003'.matches('\\\\s')", 'DENY', 'ALLOW'],
  ['space-class-vertical-tab', "'\\013'.matches('\\\\s')", 'DENY', 'ALLOW'],
  ['nonspace-class-nbsp', "'a\\u00a0b'.matches('\\\\S+')", 'ALLOW', 'DENY'],
  ['dot-carriage-return', "'a\\rb'.matches('a.b')", 'ALLOW', 'DENY'],
  ['quote-literal-match', "'a.b'.matches('\\\\Qa.b\\\\E')", 'ALLOW', 'DENY'],
  ['quote-literal-no-wildcard', "'QaxbE'.matches('\\\\Qa.b\\\\E')", 'DENY', 'ALLOW'],
  ['ignore-case-kelvin', "'\\u212a'.matches('(?i)k')", 'ALLOW', 'DENY'],
  ['control-word-ascii', "'\\u00e9'.matches('\\\\w')", 'DENY', 'DENY'],
  ['control-dot-newline', "'a\\nb'.matches('a.b')", 'DENY', 'DENY'],
  ['control-space', "' '.matches('\\\\s')", 'ALLOW', 'ALLOW'],
];

export const scenario: StorageScenarioRecord = {
  fm: 'STORAGE-H1-REGEX-RE2',
  rationale:
    'matches() is documented as Google RE2 syntax; these constructs separate RE2 from the JavaScript RegExp semantics the shared matcher borrows for classes and escapes.',
  rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
${cases.map(([key, condition]) => `    match /re/${key}.bin { allow create: if ${condition}; }`).join('\n')}
  }
}`,
  cases: cases.map(([key, condition, re2, pyric]) => ({
    description: `${key}: ${condition} (pyric ${pyric})`,
    expectation: re2,
    method: 'create' as const,
    path: `re/${key}.bin`,
    resource: { size: 1 },
  })),
};
