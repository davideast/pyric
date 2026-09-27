/**
 * ─── r26-rule-runtime-error ───────────────────────────────────────────────
 * `.read`, `.write`, and `.validate` expressions that fail at evaluation time
 * because a string method is called on a value that is not a string. r17 pins
 * this for `.validate` alone; this scenario extends it to the other rule kinds
 * and to how an error combines with the rest of the rules.
 *
 *   - `.read` and `.write` rules that error deny, and the same rules allow a
 *     string they can evaluate.
 *   - An ancestor `.read` or `.write` that errors does not stop a descendant
 *     rule from granting: the erroring rule counts as not granting.
 *   - An error on the left of `||` and under `!` fails the whole expression.
 *   - A string method on a missing value (null) errors as well.
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'a .read, .write, or .validate rule that errors at evaluation fails as that rule, so the simulator must deny where production denies and keep evaluating the other rules on the path, never report the request as beyond the simulator.',
  provenance:
    'Authored to pin evaluation errors in every rule kind against production directly. Expectations are the production allow/deny verdicts recorded by the deploy-observe-restore capture in observations/rtdb-rules/rules-rtdb-r26-rule-runtime-error.json.',
  rules: JSON.stringify({
    readrule: {
      '.read': "data.val().toUpperCase() == 'OK'",
    },
    readcascade: {
      '.read': "data.child('v').val().toUpperCase() == 'OK'",
      open: { '.read': 'auth != null' },
    },
    writerule: {
      '.write': "newData.val().toUpperCase() == 'OK'",
    },
    writecascade: {
      '.write': "newData.val().toUpperCase() == 'OK'",
      open: { '.write': 'auth != null' },
    },
    orright: {
      '.write': 'auth != null',
      '.validate': "newData.val().toUpperCase() == 'OK' || newData.isNumber()",
    },
    negated: {
      '.write': 'auth != null',
      '.validate': "!(newData.val().toUpperCase() == 'OK')",
    },
    missing: {
      '.write': 'auth != null',
      '.validate': "newData.child('absent').val().toUpperCase() == 'OK'",
    },
  }),
  cases: [
    { description: 'read rule calling a string method on a number', expectation: 'DENY', operation: 'read', opPath: '/readrule', authPresent: true, mockData: 5 },
    { description: 'read rule calling a string method on a string', expectation: 'ALLOW', operation: 'read', opPath: '/readrule', authPresent: true, mockData: 'ok' },
    { description: 'erroring ancestor read rule, read of the ancestor', expectation: 'DENY', operation: 'read', opPath: '/readcascade', authPresent: true, seed: { '/readcascade/v': 5 } },
    { description: 'erroring ancestor read rule, descendant read rule grants', expectation: 'ALLOW', operation: 'read', opPath: '/readcascade/open', authPresent: true, seed: { '/readcascade/v': 5 } },
    { description: 'write rule calling a string method on a number', expectation: 'DENY', operation: 'write', opPath: '/writerule', authPresent: true, newData: 5 },
    { description: 'write rule calling a string method on a string', expectation: 'ALLOW', operation: 'write', opPath: '/writerule', authPresent: true, newData: 'ok' },
    { description: 'erroring ancestor write rule, write of the ancestor', expectation: 'DENY', operation: 'write', opPath: '/writecascade', authPresent: true, newData: 5 },
    { description: 'erroring ancestor write rule, descendant write rule grants', expectation: 'ALLOW', operation: 'write', opPath: '/writecascade/open', authPresent: true, newData: 5 },
    { description: 'error on the left of || with a true right side', expectation: 'DENY', operation: 'write', opPath: '/orright', authPresent: true, newData: 5 },
    { description: 'left of || true for a string', expectation: 'ALLOW', operation: 'write', opPath: '/orright', authPresent: true, newData: 'ok' },
    { description: 'error under !', expectation: 'DENY', operation: 'write', opPath: '/negated', authPresent: true, newData: 5 },
    { description: 'negation of a false comparison on a string', expectation: 'ALLOW', operation: 'write', opPath: '/negated', authPresent: true, newData: 'no' },
    { description: 'string method on a missing child value', expectation: 'DENY', operation: 'write', opPath: '/missing', authPresent: true, newData: 'x' },
  ],
};
