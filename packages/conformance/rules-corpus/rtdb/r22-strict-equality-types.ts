/**
 * ─── r22-strict-equality-types ────────────────────────────────────────────
 * `===` and `!==` in the per-user ownership form the Firebase guides use, and
 * against operands of different types. Each value node carries ONE predicate
 * and the ops write directly AT that node, so the operator decides the verdict.
 *
 * The number-versus-string cases separate strict comparison from a comparison
 * that converts types: `5 === '5'` is false and `5 !== '5'` is true under
 * strict semantics.
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'per-user rules written as `$uid === auth.uid` must allow the owner, and `===`/`!==` must compare a number with a string without converting either, so the simulator must parse both operators and evaluate them as production does.',
  provenance:
    'Authored to pin the strict comparison operators against production directly, including mixed-type operands. Expectations are the production allow/deny verdicts recorded by the deploy-observe-restore capture in observations/rtdb-rules/rules-rtdb-r22-strict-equality-types.json.',
  rules: JSON.stringify({
    owner: {
      $uid: {
        '.read': '$uid === auth.uid',
        '.write': '$uid === auth.uid',
      },
    },
    named: {
      $name: {
        '.write': "$name !== 'nobody' && auth != null",
      },
    },
    strictnumber: {
      '.write': 'auth != null',
      '.validate': 'newData.val() === 5',
    },
    strictnotstring: {
      '.write': 'auth != null',
      '.validate': "newData.val() !== '5'",
    },
  }),
  cases: [
    { description: 'owner read allowed by ===', expectation: 'ALLOW', operation: 'read', opPath: '/owner/<UID>', authPresent: true },
    { description: 'owner write allowed by ===', expectation: 'ALLOW', operation: 'write', opPath: '/owner/<UID>', authPresent: true, newData: { name: 'Alice' } },
    { description: 'foreign write denied by ===', expectation: 'DENY', operation: 'write', opPath: '/owner/some-other-uid', authPresent: true, newData: { name: 'Bob' } },
    { description: 'anonymous read denied by ===', expectation: 'DENY', operation: 'read', opPath: '/owner/<UID>', authPresent: false },
    { description: 'non-sentinel key allowed by !==', expectation: 'ALLOW', operation: 'write', opPath: '/named/alice', authPresent: true, newData: 1 },
    { description: 'sentinel key denied by !==', expectation: 'DENY', operation: 'write', opPath: '/named/nobody', authPresent: true, newData: 1 },
    { description: 'number 5 equals 5 under ===', expectation: 'ALLOW', operation: 'write', opPath: '/strictnumber', authPresent: true, newData: 5 },
    { description: 'string 5 does not equal number 5 under ===', expectation: 'DENY', operation: 'write', opPath: '/strictnumber', authPresent: true, newData: '5' },
    { description: 'number 6 does not equal 5 under ===', expectation: 'DENY', operation: 'write', opPath: '/strictnumber', authPresent: true, newData: 6 },
    { description: 'number 5 differs from string 5 under !==', expectation: 'ALLOW', operation: 'write', opPath: '/strictnotstring', authPresent: true, newData: 5 },
    { description: 'string 5 does not differ from string 5 under !==', expectation: 'DENY', operation: 'write', opPath: '/strictnotstring', authPresent: true, newData: '5' },
  ],
};
