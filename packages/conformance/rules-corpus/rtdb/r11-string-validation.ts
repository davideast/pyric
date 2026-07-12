/**
 * ─── r11-string-validation ────────────────────────────────────────────────
 * The String methods RTDB rules expose on a snapshot value: prefix/substring/suffix
 * tests, a regex literal through `matches`, the `.length` property, case folding,
 * and `replace`.
 *
 * `replace` is the sharp edge. Production's String.replace substitutes EVERY
 * occurrence of the substring, where JavaScript's `String.prototype.replace` called
 * with a string pattern substitutes only the FIRST. The `/dashed` node is written
 * twice on purpose: once with a single `_` (where first-only and replace-all agree,
 * so it is a control) and once with two (where they disagree, so it isolates the
 * semantics). If the simulator ever regresses to first-only substitution, the
 * two-underscore case is the one that catches it.
 *
 * Covers: beginsWith, contains, endsWith, matches, replace, toLowerCase,
 * toUpperCase, length, and the regex literal.
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'string validation rules gate handles, slugs and filenames in real rulesets, and `replace` is replace-ALL in production but first-only under a naive JavaScript implementation — the simulator must match production on every method, and on that substitution in particular.',
  provenance:
    'Authored to close the rules-language construct gaps left by r1-r8, which exercised no String method and no regex literal. Expectations are the production allow/deny verdicts recorded by the deploy-observe-restore capture in observations/rtdb-rules/rules-rtdb-r11-string-validation.json.',
  rules: JSON.stringify({
    '.read': 'auth != null',
    handle: {
      '.write': 'auth != null',
      '.validate': "newData.isString() && newData.val().beginsWith('user_')",
    },
    tag: {
      '.write': 'auth != null',
      '.validate': "newData.val().contains('-')",
    },
    file: {
      '.write': 'auth != null',
      '.validate': "newData.val().endsWith('.json')",
    },
    slug: {
      '.write': 'auth != null',
      '.validate': 'newData.val().matches(/^[a-z0-9-]+$/)',
    },
    bounded: {
      '.write': 'auth != null',
      '.validate': 'newData.val().length >= 3 && newData.val().length <= 8',
    },
    normalized: {
      '.write': 'auth != null',
      '.validate': "newData.val().toLowerCase() === 'abc'",
    },
    shouted: {
      '.write': 'auth != null',
      '.validate': "newData.val().toUpperCase() === 'ABC'",
    },
    dashed: {
      '.write': 'auth != null',
      '.validate': "newData.val().replace('_', '-') === 'a-b-c'",
    },
  }),
  cases: [
    { description: 'handle with required prefix allowed', expectation: 'ALLOW', operation: 'write', opPath: '/handle', authPresent: true, newData: 'user_ada' },
    { description: 'handle without required prefix denied', expectation: 'DENY', operation: 'write', opPath: '/handle', authPresent: true, newData: 'admin_ada' },
    { description: 'tag containing the separator allowed', expectation: 'ALLOW', operation: 'write', opPath: '/tag', authPresent: true, newData: 'red-hot' },
    { description: 'tag without the separator denied', expectation: 'DENY', operation: 'write', opPath: '/tag', authPresent: true, newData: 'redhot' },
    { description: 'filename with required suffix allowed', expectation: 'ALLOW', operation: 'write', opPath: '/file', authPresent: true, newData: 'data.json' },
    { description: 'filename without required suffix denied', expectation: 'DENY', operation: 'write', opPath: '/file', authPresent: true, newData: 'data.txt' },
    { description: 'slug matching the regex literal allowed', expectation: 'ALLOW', operation: 'write', opPath: '/slug', authPresent: true, newData: 'my-slug-1' },
    { description: 'slug violating the regex literal denied', expectation: 'DENY', operation: 'write', opPath: '/slug', authPresent: true, newData: 'My Slug' },
    { description: 'length inside bounds allowed', expectation: 'ALLOW', operation: 'write', opPath: '/bounded', authPresent: true, newData: 'abcd' },
    { description: 'length below lower bound denied', expectation: 'DENY', operation: 'write', opPath: '/bounded', authPresent: true, newData: 'ab' },
    { description: 'length above upper bound denied', expectation: 'DENY', operation: 'write', opPath: '/bounded', authPresent: true, newData: 'abcdefghi' },
    { description: 'uppercase input folds to the expected lowercase', expectation: 'ALLOW', operation: 'write', opPath: '/normalized', authPresent: true, newData: 'ABC' },
    { description: 'different input does not fold to the expected lowercase', expectation: 'DENY', operation: 'write', opPath: '/normalized', authPresent: true, newData: 'ABD' },
    { description: 'lowercase input folds to the expected uppercase', expectation: 'ALLOW', operation: 'write', opPath: '/shouted', authPresent: true, newData: 'abc' },
    { description: 'different input does not fold to the expected uppercase', expectation: 'DENY', operation: 'write', opPath: '/shouted', authPresent: true, newData: 'abd' },
    { description: 'single-occurrence replace reaches the target', expectation: 'ALLOW', operation: 'write', opPath: '/dashed', authPresent: true, newData: 'a_b-c' },
    { description: 'replace substitutes every occurrence not just the first', expectation: 'ALLOW', operation: 'write', opPath: '/dashed', authPresent: true, newData: 'a_b_c' },
    { description: 'auth-gated read allowed', expectation: 'ALLOW', operation: 'read', opPath: '/handle', authPresent: true },
  ],
};
