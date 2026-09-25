/**
 * ─── r20-priority-values ──────────────────────────────────────────────────
 * Non-null priorities, which r13 left unverified. A node seeded with a number
 * or string priority, and a write that carries one, pin what `getPriority()`
 * reports and that `val()` reads the node's value rather than its
 * `{ .value, .priority }` form.
 *
 * Covers: getPriority and val() on prioritized nodes.
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'rules that read a node\'s priority, or compare the value of a prioritized node, must evaluate the same in the simulator as in production.',
  provenance:
    'Authored to verify non-null priorities, which r13 could not reach with plain writes. Expectations are the production allow/deny verdicts recorded by the deploy-observe-restore capture in observations/rtdb-rules/rules-rtdb-r20-priority-values.json.',
  rules: JSON.stringify({
    numberpriority: { '.read': 'data.getPriority() == 5' },
    numbervalue: { '.read': "data.val() == 'v'" },
    stringpriority: { '.read': "data.getPriority() == 'abc'" },
    anypriority: { '.read': 'data.getPriority() != null' },
    plain: { '.read': 'data.getPriority() == null' },
    leafvalue: { '.read': "data.child('leaf').val() == 'x'" },
    leafpriority: { '.read': 'data.child(\'leaf\').getPriority() == 2' },
    written: {
      '.write': 'true',
      '.validate': "newData.getPriority() == 7 && newData.val() == 'w'",
    },
  }),
  cases: [
    { description: 'a seeded number priority', expectation: 'ALLOW', operation: 'read', opPath: '/numberpriority', authPresent: true, seed: { '/numberpriority': { '.value': 'v', '.priority': 5 } } },
    { description: 'the value of a node seeded with a priority', expectation: 'ALLOW', operation: 'read', opPath: '/numbervalue', authPresent: true, seed: { '/numbervalue': { '.value': 'v', '.priority': 5 } } },
    { description: 'a seeded string priority', expectation: 'ALLOW', operation: 'read', opPath: '/stringpriority', authPresent: true, seed: { '/stringpriority': { '.value': 1, '.priority': 'abc' } } },
    { description: 'a seeded priority is non-null', expectation: 'ALLOW', operation: 'read', opPath: '/anypriority', authPresent: true, seed: { '/anypriority': { '.value': 1, '.priority': 3 } } },
    { description: 'a node without a priority', expectation: 'ALLOW', operation: 'read', opPath: '/plain', authPresent: true, seed: { '/plain': 'p' } },
    { description: 'the value of a prioritized child', expectation: 'ALLOW', operation: 'read', opPath: '/leafvalue', authPresent: true, seed: { '/leafvalue': { leaf: { '.value': 'x', '.priority': 2 } } } },
    { description: 'the priority of a prioritized child', expectation: 'ALLOW', operation: 'read', opPath: '/leafpriority', authPresent: true, seed: { '/leafpriority': { leaf: { '.value': 'x', '.priority': 2 } } } },
    { description: 'a write that carries a priority', expectation: 'ALLOW', operation: 'write', opPath: '/written', authPresent: true, newData: { '.value': 'w', '.priority': 7 } },
  ],
};
