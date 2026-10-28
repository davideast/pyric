/**
 * ─── r44-deploy-string-and-regex-probes ───────────────────────────────────
 * Dry-run deploy validation probes (`PUT /.settings/rules.json?dryRun=true`)
 * for string escape sequences and regular expression literals in RTDB rule
 * strings:
 *
 *   - `FUZ-1`: escaped single quote (`\'`), hex escape (`\x41`), raw newline,
 *     and raw tab inside a double-quoted rule expression string.
 *   - `FUZ-2`: regex literals passed to `.matches(...)` with an unclosed group
 *     (`/(`), bare quantifier (`/+/`), reversed character class range
 *     (`/[z-a]/`), or out-of-order quantifier (`/a{2,1}/`).
 *   - `FUZ-8`: regex literal containing an unescaped `/` inside a character
 *     class (`/^[^/]+$/`).
 *
 * Expectations record the production dry-run deploy verdicts and error texts
 * captured on 2026-10-15 in
 * `observations/rtdb-rules/rules-rtdb-r44-deploy-string-and-regex-probes.json`.
 */
import type { RtdbDeployScenarioRecord } from './types.ts';

const subtree = (rules: Record<string, unknown>): string => JSON.stringify(rules);

export const scenario: RtdbDeployScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'string escape sequences and regular expression literals in rule strings must be accepted or rejected by rtdbRulesSourceRejection in agreement with production dry-run deploy validation.',
  provenance:
    'Authored from 2026-10-15 bug hunt (FUZ-1, FUZ-2, FUZ-8) to pin dry-run deploy verdicts and error messages for string escape and regex literal edge cases against production. Captured by deploy-observe-restore (dry-run deploy) on 2026-10-15 in observations/rtdb-rules/rules-rtdb-r44-deploy-string-and-regex-probes.json.',
  deployCases: [
    {
      description: 'FUZ-1: double-quoted string containing escaped single quote ("\\\'")',
      construct: 'rtdb.operator.looseEq',
      rules: subtree({ a: { '.read': 'auth.uid == "\\\'"' } }),
      expectation: { verdict: 'ACCEPTED' },
    },
    {
      description: 'FUZ-1: double-quoted string containing hex escape ("\\x41")',
      construct: 'rtdb.operator.looseEq',
      rules: subtree({ a: { '.read': 'auth.uid == "\\x41"' } }),
      expectation: { verdict: 'ACCEPTED' },
    },
    {
      description: 'FUZ-1: double-quoted string containing a raw newline',
      construct: 'rtdb.operator.looseEq',
      rules: subtree({ a: { '.read': 'auth.uid == "line1\nline2"' } }),
      expectation: {
        verdict: 'REJECTED',
        error: 'unterminated string literal',
      },
    },
    {
      description: 'FUZ-1: double-quoted string containing a raw tab',
      construct: 'rtdb.operator.looseEq',
      rules: subtree({ a: { '.read': 'auth.uid == "col1\tcol2"' } }),
      expectation: { verdict: 'ACCEPTED' },
    },
    {
      description: 'FUZ-2: matches() with unclosed group regex /(/)',
      construct: 'rtdb.semantic.regex-literal',
      rules: subtree({ a: { '.write': 'newData.val().matches(/(/)' } }),
      expectation: {
        verdict: 'REJECTED',
        error: "Illegal regular expression, expected ')' at position 5",
      },
    },
    {
      description: 'FUZ-2: matches() with bare quantifier regex /+/',
      construct: 'rtdb.semantic.regex-literal',
      rules: subtree({ a: { '.write': 'newData.val().matches(/+/)' } }),
      expectation: { verdict: 'ACCEPTED' },
    },
    {
      description: 'FUZ-2: matches() with reversed character class range /[z-a]/',
      construct: 'rtdb.semantic.regex-literal',
      rules: subtree({ a: { '.write': 'newData.val().matches(/[z-a]/)' } }),
      expectation: { verdict: 'ACCEPTED' },
    },
    {
      description: 'FUZ-2: matches() with out-of-order quantifier /a{2,1}/',
      construct: 'rtdb.semantic.regex-literal',
      rules: subtree({ a: { '.write': 'newData.val().matches(/a{2,1}/)' } }),
      expectation: { verdict: 'ACCEPTED' },
    },
    {
      description: 'FUZ-8: matches() with unescaped / inside character class /^[^/]+$/',
      construct: 'rtdb.semantic.regex-literal',
      rules: subtree({ a: { '.write': 'newData.val().matches(/^[^/]+$/)' } }),
      expectation: { verdict: 'ACCEPTED' },
    },
  ],
};
