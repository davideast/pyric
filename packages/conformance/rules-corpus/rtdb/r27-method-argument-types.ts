/**
 * ─── r27-method-argument-types ────────────────────────────────────────────
 * Snapshot and string methods whose argument is not a string at evaluation
 * time. Production refuses to deploy a rule that passes a literal of the wrong
 * type, so these rules pass the argument through `val()` or `auth.uid`, which
 * production accepts at deploy and types only when the rule runs.
 *
 *   - `contains`, `beginsWith`, `hasChild` and `child` given null or a number.
 *   - `replace` given a number as the replacement.
 *   - `hasChildren([])`, which production accepts at deploy.
 *   - `replace` with a slash-delimited string pattern, which production reads
 *     as a plain substring rather than a regular expression.
 *
 * Each case that errors has a control case whose argument is a string.
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'a method argument that is not a string must fail the rule as production does, never be converted to a string, so null from a missing value or an unauthenticated auth.uid cannot match the text "null".',
  provenance:
    'Authored to pin method argument types at evaluation against production directly. Expectations are the production allow/deny verdicts recorded by the deploy-observe-restore capture in observations/rtdb-rules/rules-rtdb-r27-method-argument-types.json.',
  rules: JSON.stringify({
    contains: {
      '.write': 'auth != null',
      '.validate': "newData.child('s').val().contains(newData.child('p').val())",
    },
    begins: {
      '.write': 'auth != null',
      '.validate': "newData.child('s').val().beginsWith(newData.child('p').val())",
    },
    haschild: {
      '.write': 'auth != null',
      '.validate': "newData.hasChild(newData.child('k').val())",
    },
    childauth: {
      '.read': "data.child(auth.uid).exists()",
    },
    replacenumber: {
      '.write': 'auth != null',
      '.validate': "newData.child('s').val().replace('a', newData.child('r').val()) == 'x'",
    },
    emptyhaschildren: {
      '.write': 'auth != null',
      '.validate': 'newData.hasChildren([])',
    },
    replaceslash: {
      '.write': 'auth != null',
      '.validate': "newData.val().replace('/a/g', 'z') == 'z'",
    },
  }),
  cases: [
    { description: 'contains with a missing argument value', expectation: 'DENY', operation: 'write', opPath: '/contains', authPresent: true, newData: { s: 'xnullx' } },
    { description: 'contains with a number argument', expectation: 'DENY', operation: 'write', opPath: '/contains', authPresent: true, newData: { s: 'x12x', p: 12 } },
    { description: 'contains with a string argument', expectation: 'ALLOW', operation: 'write', opPath: '/contains', authPresent: true, newData: { s: 'x12x', p: '12' } },
    { description: 'beginsWith with a number argument', expectation: 'DENY', operation: 'write', opPath: '/begins', authPresent: true, newData: { s: '12ab', p: 12 } },
    { description: 'beginsWith with a string argument', expectation: 'ALLOW', operation: 'write', opPath: '/begins', authPresent: true, newData: { s: '12ab', p: '12' } },
    { description: 'hasChild with a missing argument value', expectation: 'DENY', operation: 'write', opPath: '/haschild', authPresent: true, newData: { null: 1 } },
    { description: 'hasChild with a number argument', expectation: 'DENY', operation: 'write', opPath: '/haschild', authPresent: true, newData: { k: 5, '5': 1 } },
    { description: 'hasChild with a string argument', expectation: 'ALLOW', operation: 'write', opPath: '/haschild', authPresent: true, newData: { k: 'a', a: 1 } },
    { description: 'child of auth.uid when signed out', expectation: 'DENY', operation: 'read', opPath: '/childauth', authPresent: false, seed: { '/childauth/null': true } },
    { description: 'child of auth.uid when signed in', expectation: 'ALLOW', operation: 'read', opPath: '/childauth', authPresent: true, seed: { '/childauth/<UID>': true } },
    { description: 'replace with a number replacement', expectation: 'DENY', operation: 'write', opPath: '/replacenumber', authPresent: true, newData: { s: 'a', r: 5 } },
    { description: 'replace with a string replacement', expectation: 'ALLOW', operation: 'write', opPath: '/replacenumber', authPresent: true, newData: { s: 'a', r: 'x' } },
    { description: 'hasChildren of an empty array on an object', expectation: 'ALLOW', operation: 'write', opPath: '/emptyhaschildren', authPresent: true, newData: { a: 1 } },
    { description: 'hasChildren of an empty array on a leaf', expectation: 'ALLOW', operation: 'write', opPath: '/emptyhaschildren', authPresent: true, newData: 5 },
    { description: 'replace with a slash-delimited pattern on its literal text', expectation: 'ALLOW', operation: 'write', opPath: '/replaceslash', authPresent: true, newData: '/a/g' },
    { description: 'replace with a slash-delimited pattern on a regex match', expectation: 'DENY', operation: 'write', opPath: '/replaceslash', authPresent: true, newData: 'a' },
  ],
};
